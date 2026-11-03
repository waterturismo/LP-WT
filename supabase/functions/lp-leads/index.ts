// Recebe os formulários da LP Water Turismo (visto, passaporte, Viagem Programada)
// e cria o lead no Kommo: funil VENDAS 1, etapa RESERVA, com contato, etiquetas e nota.
// O token do Kommo fica no segredo KOMMO_TOKEN do Supabase — nunca no site.

const KOMMO_SUBDOMINIO = Deno.env.get("KOMMO_SUBDOMINIO") ?? "waterturismo";
const FUNIL = Deno.env.get("LP_KOMMO_FUNIL") ?? "VENDAS 1";
const ETAPA = Deno.env.get("LP_KOMMO_ETAPA") ?? "RESERVA";
const ORIGEM = "Site Water Turismo";
const ORIGENS_PERMITIDAS = [
  "https://waterturismo.com.br",
  "https://www.waterturismo.com.br",
  "https://waterturismo.github.io",
];

const PRECO_PASSAPORTE = 120;
const TAXA_PF = 257.25;
const PLANOS: Record<string, number> = { Essencial: 250, Superior: 400, Luxo: 600 };

// ---------- utilidades ----------
const normalizar = (t: string) =>
  t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const digitos = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const txt = (s: unknown, max = 200) => String(s ?? "").trim().slice(0, max);
const brl = (v: number) => "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
const nomeOk = (s: string) => s.split(/\s+/).filter(Boolean).length >= 2 && s.length <= 120;
const emailOk = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 120;
const telOk = (s: string) => { const d = digitos(s); return d.length >= 10 && d.length <= 13; };
const telE164 = (s: string) => { let d = digitos(s); if (!d.startsWith("55") || d.length <= 11) d = "55" + d; return "+" + d; };
function cpfOk(s: string) {
  const d = digitos(s); if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  let t = 0; for (let i = 0; i < 9; i++) t += +d[i] * (10 - i); let r = (t * 10) % 11; if (r === 10) r = 0; if (r !== +d[9]) return false;
  t = 0; for (let i = 0; i < 10; i++) t += +d[i] * (11 - i); r = (t * 10) % 11; if (r === 10) r = 0; return r === +d[10];
}
const inteiro = (v: unknown, min: number, max: number) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };

// Limite simples por IP (melhor esforço, por instância): 6 envios a cada 10 minutos.
const tentativas = new Map<string, number[]>();
function excedeuLimite(ip: string) {
  const agora = Date.now(), janela = 10 * 60_000;
  const lista = (tentativas.get(ip) ?? []).filter((t) => agora - t < janela);
  lista.push(agora); tentativas.set(ip, lista);
  return lista.length > 6;
}

// ---------- Kommo ----------
async function kommo<T>(caminho: string, init?: RequestInit): Promise<T | null> {
  const token = Deno.env.get("KOMMO_TOKEN");
  if (!token) throw new Error("KOMMO_TOKEN não configurado");
  const r = await fetch(`https://${KOMMO_SUBDOMINIO}.kommo.com/api/v4${caminho}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`Kommo ${r.status} em ${caminho}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return (await r.json()) as T;
}
type Funil = { id: number; name: string; _embedded: { statuses: { id: number; name: string }[] } };
type Campo = { id: number; name: string; type: string; enums?: { id: number; value: string }[] | null };

async function etapaDestino() {
  const funis = await kommo<{ _embedded: { pipelines: Funil[] } }>("/leads/pipelines");
  const funil = funis?._embedded.pipelines.find((p) => normalizar(p.name) === normalizar(FUNIL));
  if (!funil) throw new Error(`Funil "${FUNIL}" não encontrado`);
  const etapa = funil._embedded.statuses.find((s) => normalizar(s.name) === normalizar(ETAPA));
  if (!etapa) throw new Error(`Etapa "${ETAPA}" não encontrada em "${FUNIL}"`);
  return { pipeline_id: funil.id, status_id: etapa.id };
}
async function campoOrigem() {
  const r = await kommo<{ _embedded: { custom_fields: Campo[] } }>("/leads/custom_fields?limit=250");
  const c = r?._embedded.custom_fields.find((x) => normalizar(x.name) === "origem");
  if (!c) return null;
  if (["text", "textarea"].includes(c.type)) return { field_id: c.id, values: [{ value: ORIGEM }] };
  const op = c.enums?.find((e) => normalizar(e.value) === normalizar(ORIGEM));
  return op ? { field_id: c.id, values: [{ enum_id: op.id }] } : null;
}
function chaveTel(t: string) {
  let d = digitos(t);
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length === 11 && d[2] === "9") d = d.slice(0, 2) + d.slice(3);
  return d.length === 10 ? d : null;
}
type ContatoBusca = { id: number; custom_fields_values?: { field_code?: string | null; values: { value: string }[] }[] | null };
async function contatoExistente(tel: string) {
  const alvo = chaveTel(tel); if (!alvo) return undefined;
  const r = await kommo<{ _embedded: { contacts: ContatoBusca[] } }>(`/contacts?query=${encodeURIComponent(alvo.slice(-8))}&limit=50`);
  return r?._embedded.contacts.find((c) => (c.custom_fields_values ?? []).some((f) =>
    f.field_code === "PHONE" && f.values.some((v) => chaveTel(String(v.value)) === alvo)));
}

// Respostas da análise de perfil (opcional), vindas da página de visto.
function analiseTexto(a: unknown): string[] {
  if (!a || typeof a !== "object") return [];
  const o = a as Record<string, unknown>, out: string[] = ["", "RESPOSTAS DA ANÁLISE DE PERFIL (o cliente não viu resultado — analisar e retornar pelo WhatsApp):"];
  if (Array.isArray(o.respostas)) for (const r of o.respostas.slice(0, 12)) {
    if (r && typeof r === "object") { const x = r as Record<string, unknown>; out.push(`• ${txt(x.pergunta, 40)}: ${txt(x.resposta, 80)}`); }
  }
  return out.length > 2 ? out : [];
}

// ---------- formulários ----------
type Pedido = { tipo: string; titulo: string; etiqueta: string; nome: string; telefone: string; email: string; nota: string[]; preco: number | null };

function montarPedido(b: Record<string, unknown>): Pedido | string {
  const tipo = txt(b.tipo, 20);
  const nome = txt(b.nome, 120), email = txt(b.email, 120).toLowerCase(), tel = txt(b.whatsapp, 20);
  if (!nomeOk(nome)) return "nome";
  if (!emailOk(email)) return "email";
  if (!telOk(tel)) return "whatsapp";
  if (b.consentimento_lgpd !== true) return "consentimento";

  if (tipo === "visto") {
    const qb = inteiro(b.qtd_b1b2, 0, 20), qn = inteiro(b.qtd_baba, 0, 20);
    if (qb === null || qn === null || qb + qn < 1) return "quantidade";
    const partes = [qb ? `${qb} B1/B2` : "", qn ? `${qn} babá` : ""].filter(Boolean).join(" + ");
    return { tipo, nome, email, telefone: tel, etiqueta: "Visto B1/B2", preco: null,
      titulo: `${b.analise ? "Análise visto" : "Proposta visto"} – ${nome} (${partes})`,
      nota: [b.analise ? `Análise de perfil para visto americano enviada pelo site.` : `Pedido de PROPOSTA de assessoria para visto americano, enviado pelo site.`,
        `Solicitantes: ${partes}.` + (Math.floor(qb / 5) ? ` Tem direito a ${Math.floor(qb / 5)} cortesia(s) (a cada 5 B1/B2, 1 cortesia).` : ""),
        `Contato: ${nome} · ${tel} · ${email}`, ...analiseTexto(b.analise)] };
  }

  const cpf = txt(b.cpf, 14), nasc = txt(b.nascimento, 10);
  if (!cpfOk(cpf)) return "cpf";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nasc)) return "nascimento";
  const e = (b.endereco && typeof b.endereco === "object" ? b.endereco : b) as Record<string, unknown>;
  const end = [txt(e.rua, 120) + (txt(e.numero, 15) ? ", " + txt(e.numero, 15) : ""), txt(e.complemento, 60), txt(e.bairro, 60),
    txt(e.cidade, 60) + (txt(e.uf, 2) ? "/" + txt(e.uf, 2) : ""), txt(e.cep, 9) ? "CEP " + txt(e.cep, 9) : ""].filter(Boolean).join(" · ");
  const dataBR = (s: string) => s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "";
  const dados = [`Nome: ${nome}`, `CPF: ${cpf}`, `Nascimento: ${dataBR(nasc)}`, `WhatsApp: ${tel}`, `E-mail: ${email}`, `Endereço: ${end}`];

  if (tipo === "passaporte") {
    const q = inteiro(b.quantidade, 1, 30); if (q === null) return "quantidade";
    if (b.ciente_taxa_pf !== true) return "ciente";
    const cort = Math.floor(q / 5), total = (q - cort) * PRECO_PASSAPORTE;
    return { tipo, nome, email, telefone: tel, etiqueta: "Passaporte", preco: total,
      titulo: `Passaporte – ${nome} (${q})`,
      nota: [`Contratação de ASSESSORIA DE PASSAPORTE pelo site.`,
        `Passaportes: ${q}${cort ? ` (${cort} cortesia${cort > 1 ? "s" : ""})` : ""} · Assessoria: ${brl(total)}`,
        `Taxa da Polícia Federal (paga à PF): ${brl(q * TAXA_PF)} no total.`,
        `Cliente declarou estar ciente da taxa da PF.`, "", ...dados,
        "", "Próximo passo: enviar orientações e forma de pagamento."] };
  }

  if (tipo === "programada") {
    const plano = txt(b.plano, 20), m = PLANOS[plano], n = inteiro(b.parcelas, 12, 36);
    if (!m) return "plano";
    if (n === null || ![12, 18, 24, 30, 36].includes(n)) return "parcelas";
    const venc = txt(b.vencimento_1o_boleto, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(venc)) return "vencimento";
    if (b.aceite_regras !== true) return "regras";
    return { tipo, nome, email, telefone: tel, etiqueta: "Viagem Programada", preco: m * n,
      titulo: `Viagem Programada ${plano} – ${nome}`,
      nota: [`Adesão à WATER VIAGEM PROGRAMADA pelo site.`,
        `Plano ${plano}: ${n}x de ${brl(m)} · Crédito total ${brl(m * n)}`,
        `1º vencimento escolhido: ${dataBR(venc)} (demais no mesmo dia dos meses seguintes).`,
        `Cliente aceitou as regras da Viagem Programada.`, "", ...dados,
        "", "Próximo passo: enviar contrato e boletos."] };
  }
  return "tipo";
}

// ---------- servidor ----------
function cors(origem: string | null) {
  const permitido = origem && ORIGENS_PERMITIDAS.includes(origem) ? origem : ORIGENS_PERMITIDAS[0];
  return { "Access-Control-Allow-Origin": permitido, "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
}
const json = (corpo: unknown, status: number, h: Record<string, string>) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...h, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const origem = req.headers.get("origin"), h = cors(origem);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ ok: false, erro: "método" }, 405, h);
  if (!origem || !ORIGENS_PERMITIDAS.includes(origem)) return json({ ok: false, erro: "origem" }, 403, h);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "?";
  if (excedeuLimite(ip)) return json({ ok: false, erro: "limite" }, 429, h);

  const bruto = await req.text();
  if (bruto.length > 12000) return json({ ok: false, erro: "tamanho" }, 413, h);
  let b: Record<string, unknown>;
  try { b = JSON.parse(bruto); } catch { return json({ ok: false, erro: "json" }, 400, h); }
  if (txt(b.site_web)) return json({ ok: true }, 200, h); // campo anti-robô preenchido: ignora em silêncio

  const p = montarPedido(b);
  if (typeof p === "string") return json({ ok: false, erro: `campo inválido: ${p}` }, 422, h);

  try {
    const [destino, origemCampo, existente] = await Promise.all([etapaDestino(), campoOrigem(), contatoExistente(p.telefone)]);
    const contato = existente ? { id: existente.id } : {
      name: p.nome,
      custom_fields_values: [
        { field_code: "PHONE", values: [{ value: telE164(p.telefone), enum_code: "MOB" }] },
        { field_code: "EMAIL", values: [{ value: p.email, enum_code: "WORK" }] },
      ],
    };
    const lead = {
      name: p.titulo, ...destino,
      ...(p.preco ? { price: Math.round(p.preco) } : {}),
      ...(origemCampo ? { custom_fields_values: [origemCampo] } : {}),
      _embedded: {
        tags: [{ name: ORIGEM }, { name: p.etiqueta }, ...(existente ? [{ name: "Contato já existia no Kommo" }] : [])],
        contacts: [contato],
      },
    };
    const criado = await kommo<{ id: number }[]>("/leads/complex", { method: "POST", body: JSON.stringify([lead]) });
    const leadId = criado?.[0]?.id;
    if (!leadId) throw new Error("Kommo não devolveu o lead");
    const texto = [...p.nota, ...(existente ? ["", "Atenção: este telefone já existia no Kommo. Confira se a pessoa já foi cliente."] : []),
      "", `Enviado em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`].join("\n");
    await kommo("/leads/notes", { method: "POST", body: JSON.stringify([{ entity_id: leadId, note_type: "common", params: { text: texto } }]) })
      .catch((e) => console.error("[lp-leads] nota falhou", leadId, String(e).slice(0, 200)));
    console.log("[lp-leads] lead criado", { tipo: p.tipo, leadId });
    return json({ ok: true }, 200, h);
  } catch (e) {
    console.error("[lp-leads] falha", p.tipo, String(e).slice(0, 300));
    return json({ ok: false, erro: "kommo" }, 502, h);
  }
});
