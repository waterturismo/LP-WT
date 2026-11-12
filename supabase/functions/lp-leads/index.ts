// Recebe os formulários da LP Water Turismo (visto, passaporte, Viagem Programada)
// e cria o lead no Kommo: funil VENDAS 1 — visto em PREPARAR PROPOSTA, os demais em RESERVA — com contato, etiquetas e nota.
// O token do Kommo fica no segredo KOMMO_TOKEN do Supabase — nunca no site.

const KOMMO_SUBDOMINIO = Deno.env.get("KOMMO_SUBDOMINIO") ?? "waterturismo";
const FUNIL = Deno.env.get("LP_KOMMO_FUNIL") ?? "VENDAS 1";
const ETAPA = Deno.env.get("LP_KOMMO_ETAPA") ?? "RESERVA";
const ETAPA_VISTO = Deno.env.get("LP_KOMMO_ETAPA_VISTO") ?? "PREPARAR PROPOSTA"; // análise/proposta de visto; se não existir, cai em RESERVA
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

async function etapaDestino(nomeEtapa = ETAPA) {
  const funis = await kommo<{ _embedded: { pipelines: Funil[] } }>("/leads/pipelines");
  const funil = funis?._embedded.pipelines.find((p) => normalizar(p.name) === normalizar(FUNIL));
  if (!funil) throw new Error(`Funil "${FUNIL}" não encontrado`);
  const preferida = funil._embedded.statuses.find((s) => normalizar(s.name) === normalizar(nomeEtapa));
  if (preferida) return { pipeline_id: funil.id, status_id: preferida.id };
  if (nomeEtapa !== ETAPA) console.error(`[lp-leads] etapa "${nomeEtapa}" não encontrada em "${FUNIL}"; usando "${ETAPA}"`);
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

// ---------- Asaas (Pix) ----------
// A chave fica no HUB (Integrações › Pagamentos), na tabela integracao_asaas deste mesmo banco — nunca no site.
// A cobrança é registrada em "cobrancas" (origem "site"): o aviso de Pix pago chega ao HUB, que confere no Asaas,
// cria a nota, preenche o grupo PAGAMENTO e move o lead para a etapa PAGO. Sem a chave, o site segue sem Pix.
const SB_URL = Deno.env.get("SUPABASE_URL")!, SB_CHAVE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function banco<T>(caminho: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${SB_URL}/rest/v1/${caminho}`, {
    ...init, signal: AbortSignal.timeout(8000),
    headers: { apikey: SB_CHAVE, Authorization: `Bearer ${SB_CHAVE}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`banco ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return (await r.json().catch(() => null)) as T;
}
type CfgAsaas = { chave: string; sandbox: boolean };
async function cfgAsaas(): Promise<CfgAsaas | null> {
  const l = await banco<{ chave: string | null; sandbox: boolean }[]>("integracao_asaas?id=eq.true&select=chave,sandbox").catch(() => []);
  return l?.[0]?.chave ? { chave: l[0].chave, sandbox: l[0].sandbox === true } : null;
}
async function asaas<T>(c: CfgAsaas, metodo: string, caminho: string, corpo?: unknown): Promise<T> {
  const r = await fetch(`${c.sandbox ? "https://api-sandbox.asaas.com/v3" : "https://api.asaas.com/v3"}${caminho}`, {
    method: metodo, signal: AbortSignal.timeout(10000),
    headers: { access_token: c.chave, "Content-Type": "application/json", "User-Agent": "WT-LP" },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (!r.ok) throw new Error(`Asaas ${r.status} em ${caminho}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
  return (await r.json()) as T;
}
// Grupo PAGAMENTO do lead no Kommo (o HUB usa os mesmos campos).
const CAMPO_STATUS_PAG = 1043859, STATUS_AGUARDANDO = 1013717, CAMPO_PIX = 1043867;

async function criarPix(leadId: number, valor: number, p: { nome: string; email: string; telefone: string; cpf: string; titulo: string }) {
  const c = await cfgAsaas();
  if (!c) return null;
  const cpf = digitos(p.cpf);
  const achado = await asaas<{ data?: { id: string; notificationDisabled?: boolean }[] }>(c, "GET", `/customers?cpfCnpj=${cpf}&limit=1`);
  const ja = achado.data?.[0];
  // Cliente já cadastrado: desliga as notificações do Asaas (e-mail/SMS têm custo por cobrança paga). Quem fala com o cliente é a Water.
  if (ja?.id && ja.notificationDisabled !== true) await asaas(c, "POST", `/customers/${ja.id}`, { notificationDisabled: true }).catch(() => null);
  const cliente = ja?.id ?? (await asaas<{ id: string }>(c, "POST", "/customers", {
    name: p.nome, cpfCnpj: cpf, email: p.email, mobilePhone: digitos(p.telefone).replace(/^55(?=\d{10,11}$)/, ""), notificationDisabled: true,
  })).id;
  const amanha = new Date(Date.now() - 3 * 3600 * 1000 + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const pag = await asaas<{ id: string }>(c, "POST", "/payments", {
    customer: cliente, billingType: "PIX", value: valor, dueDate: amanha,
    description: "Water Turismo · Assessoria Passaporte", externalReference: `Lead ${leadId} · ${p.titulo}`.slice(0, 100),
  });
  const qr = await asaas<{ payload?: string; encodedImage?: string }>(c, "GET", `/payments/${pag.id}/pixQrCode`);
  if (!qr.payload || !qr.encodedImage) throw new Error("Asaas não devolveu o QR Code");
  const expira = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  await banco("cobrancas", { method: "POST", body: JSON.stringify({
    kommo_lead_id: leadId, valor_centavos: Math.round(valor * 100), order_nsu: `SITE${leadId}-${Date.now().toString(36)}`, origem: "site",
    cliente_nome: p.nome, expira_em: expira, asaas_id: pag.id, pix_payload: qr.payload, pix_imagem: qr.encodedImage, servico: "Assessoria Passaporte",
  }) }).catch((e) => console.error("[lp-leads] registrar cobrança", leadId, String(e).slice(0, 200)));
  await kommo(`/leads/${leadId}`, { method: "PATCH", body: JSON.stringify({ custom_fields_values: [
    { field_id: CAMPO_STATUS_PAG, values: [{ enum_id: STATUS_AGUARDANDO }] }, { field_id: CAMPO_PIX, values: [{ value: qr.payload }] },
  ] }) }).catch((e) => console.error("[lp-leads] campos pagamento", leadId, String(e).slice(0, 200)));
  return { pedido: pag.id, qr: qr.payload, img: qr.encodedImage, valor: valor.toFixed(2) };
}

// A tela do Pix pergunta se já foi pago: primeiro no banco (o HUB marca ao receber o aviso), depois direto no Asaas.
async function pixPago(id: string): Promise<boolean> {
  if (!/^pay_[A-Za-z0-9]{4,40}$/.test(id)) return false;
  const l = await banco<{ situacao: string }[]>(`cobrancas?asaas_id=eq.${id}&select=situacao`).catch(() => []);
  if (l?.[0]?.situacao === "pago") return true;
  if (!l?.length) return false; // só responde por cobranças criadas pelo site
  const c = await cfgAsaas();
  if (!c) return false;
  const p = await asaas<{ status?: string }>(c, "GET", `/payments/${id}`);
  return p.status === "RECEIVED" || p.status === "CONFIRMED";
}

// Lead de visto ainda aberto (nem ganho 142 nem perdido 143) desse contato, para reaproveitar em vez de duplicar.
type LeadBusca = { id: number; name?: string; status_id: number; pipeline_id: number; updated_at?: number; _embedded?: { tags?: { name: string }[] } };
async function leadVistoAberto(contatoId: number): Promise<LeadBusca | null> {
  const c = await kommo<{ _embedded?: { leads?: { id: number }[] } }>(`/contacts/${contatoId}?with=leads`);
  const ids = (c?._embedded?.leads ?? []).map((l) => l.id).slice(-50);
  if (!ids.length) return null;
  const r = await kommo<{ _embedded: { leads: LeadBusca[] } }>(`/leads?${ids.map((id) => `filter[id][]=${id}`).join("&")}&limit=50`);
  const ehVisto = (l: LeadBusca) => normalizar(l.name ?? "").includes("visto") || (l._embedded?.tags ?? []).some((t) => normalizar(t.name).includes("visto"));
  const abertos = (r?._embedded.leads ?? []).filter((l) => l.status_id !== 142 && l.status_id !== 143 && ehVisto(l));
  abertos.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  return abertos[0] ?? null;
}

// Respostas da análise de perfil (opcional), vindas da página de visto, agrupadas em blocos na nota.
function analiseTexto(a: unknown): string[] {
  if (!a || typeof a !== "object") return [];
  const o = a as Record<string, unknown>;
  if (!Array.isArray(o.respostas)) return [];
  const out: string[] = ["", "RESPOSTAS DA ANÁLISE DE PERFIL (o cliente não viu resultado — analisar e retornar pelo WhatsApp)"];
  let grupoAtual = "";
  for (const r of o.respostas.slice(0, 50)) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    const grupo = txt(x.grupo, 30) || "Respostas";
    if (grupo !== grupoAtual) { out.push("", grupo.toUpperCase()); grupoAtual = grupo; }
    out.push(`• ${txt(x.pergunta, 40)}: ${txt(x.resposta, 200)}`);
  }
  return out.length > 2 ? out : [];
}

// ---------- formulários ----------
type Pedido = { tipo: string; titulo: string; etiqueta: string; nome: string; telefone: string; email: string; nota: string[]; preco: number | null; cpf?: string };

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
    return { tipo, nome, email, telefone: tel, cpf: digitos(cpf), etiqueta: "Passaporte", preco: total,
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

const consultas = new Map<string, number[]>();
function excedeuConsultas(ip: string) {
  const agora = Date.now(), lista = (consultas.get(ip) ?? []).filter((t) => agora - t < 10 * 60_000);
  lista.push(agora); consultas.set(ip, lista); return lista.length > 120;
}

// ---------- estatística do site (link da bio e análise) ----------
// Sem dados pessoais: só página, evento, origem e tipo de aparelho. Grava em public.site_eventos (painel do Indique e Ganhe).
const ROBOS = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp\/|telegrambot|preview|headless|lighthouse|curl|wget|python|axios|node-fetch|go-http|java\/|monitor|uptime|scan/i;
const ALVOS = ["lista_vip_black", "visto"];
const sistemaDe = (ua: string) => /android/i.test(ua) ? "Android" : /iphone|ipad|ipod/i.test(ua) ? "iOS (iPhone/iPad)" : /windows/i.test(ua) ? "Windows"
  : /mac os x|macintosh/i.test(ua) ? "macOS" : /cros/i.test(ua) ? "ChromeOS" : /linux/i.test(ua) ? "Linux" : "Outro";
const aparelhoDe = (ua: string) => (/ipad|tablet/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) ? "Tablet" : /mobi|iphone|ipod|android/i.test(ua) ? "Celular" : "Computador";
const navegadorDe = (ua: string) => /instagram/i.test(ua) ? "Instagram (navegador do app)" : /fban|fbav|fb_iab/i.test(ua) ? "Facebook (navegador do app)"
  : /edg\//i.test(ua) ? "Edge" : /samsungbrowser/i.test(ua) ? "Samsung Internet" : /opr\/|opera/i.test(ua) ? "Opera" : /firefox|fxios/i.test(ua) ? "Firefox"
  : /crios|chrome/i.test(ua) ? "Chrome" : /safari/i.test(ua) ? "Safari" : "Outro";
function origemDe(marcacao: string, referencia: string, ua: string) {
  const m = marcacao.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, "").slice(0, 40);
  const rot: Record<string, string> = { instagram: "Instagram", ig: "Instagram", facebook: "Facebook", fb: "Facebook", whatsapp: "WhatsApp", wpp: "WhatsApp", google: "Google", tiktok: "TikTok", bio: "Link da bio" };
  if (m) return rot[m] ?? m.charAt(0).toUpperCase() + m.slice(1);
  if (/instagram/i.test(ua)) return "Instagram";
  if (/fban|fbav|fb_iab/i.test(ua)) return "Facebook";
  let host = ""; try { host = referencia ? new URL(referencia).hostname.replace(/^www\./, "") : ""; } catch { host = ""; }
  if (!host) return "Direto";
  if (/waterturismo\.com\.br$/.test(host)) return "Site da Water Turismo";
  if (/instagram\.com$/.test(host)) return "Instagram";
  if (/facebook\.com$|fb\.me$/.test(host)) return "Facebook";
  if (/(^|\.)google\./.test(host)) return "Google";
  return host.slice(0, 60);
}
async function registrarEvento(pagina: string, evento: string, alvo: string | null, ua: string, marcacao = "", referencia = "") {
  const url = Deno.env.get("SUPABASE_URL"), chave = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !chave || ROBOS.test(ua) || !ua) return;
  const r = await fetch(`${url}/rest/v1/rpc/registrar_site_evento`, { method: "POST", signal: AbortSignal.timeout(5000),
    headers: { apikey: chave, Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_pagina: pagina, p_evento: evento, p_alvo: alvo, p_origem: origemDe(marcacao, referencia, ua),
      p_sistema: sistemaDe(ua), p_aparelho: aparelhoDe(ua), p_navegador: navegadorDe(ua) }) });
  if (!r.ok) console.error("[lp-leads] evento não gravado", r.status, (await r.text().catch(() => "")).slice(0, 200));
}
const veioDaBio = (a: unknown) => !!a && typeof a === "object" && Array.isArray((a as { respostas?: unknown[] }).respostas) &&
  ((a as { respostas: { pergunta?: string; resposta?: string }[] }).respostas).some((r) => r?.pergunta === "Origem" && /bio do instagram/i.test(String(r?.resposta ?? "")));

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

  // Aviso antigo do Mercado Pago (desativado: o Pix agora é pelo Asaas, com aviso para o HUB).
  if (new URL(req.url).searchParams.get("mp") === "1") return new Response("ok", { status: 200 });

  if (!origem || !ORIGENS_PERMITIDAS.includes(origem)) return json({ ok: false, erro: "origem" }, 403, h);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "?";
  const bruto = await req.text();
  if (bruto.length > 20000) return json({ ok: false, erro: "tamanho" }, 413, h);
  let b: Record<string, unknown>;
  try { b = JSON.parse(bruto); } catch { return json({ ok: false, erro: "json" }, 400, h); }

  // Estatística de visita/clique (link da bio e análise).
  if (b.acao === "evento") {
    const pagina = txt(b.pagina, 20), evento = txt(b.evento, 10), alvo = txt(b.alvo, 40) || null;
    const ok = ["/bio", "/analise"].includes(pagina) && (evento === "visita" || (evento === "clique" && pagina === "/bio" && alvo !== null && ALVOS.includes(alvo)));
    if (ok && !excedeuConsultas(ip)) await registrarEvento(pagina, evento, evento === "clique" ? alvo : null, req.headers.get("user-agent") ?? "", txt(b.marcacao, 60), txt(b.referencia, 300))
      .catch((e) => console.error("[lp-leads] evento", String(e).slice(0, 200)));
    return new Response(null, { status: 204, headers: h });
  }

  // A tela do Pix pergunta de tempos em tempos se o pagamento já caiu.
  if (b.acao === "status_pix") {
    if (excedeuConsultas(ip)) return json({ ok: false, erro: "limite" }, 429, h);
    try { return json({ ok: true, pago: await pixPago(txt(b.pedido, 64)) }, 200, h); }
    catch (e) { console.error("[lp-leads] status pix", String(e).slice(0, 200)); return json({ ok: true, pago: false }, 200, h); }
  }
  if (excedeuLimite(ip)) return json({ ok: false, erro: "limite" }, 429, h);
  if (txt(b.site_web)) return json({ ok: true }, 200, h); // campo anti-robô preenchido: ignora em silêncio

  const p = montarPedido(b);
  if (typeof p === "string") return json({ ok: false, erro: `campo inválido: ${p}` }, 422, h);

  try {
    const [destino, origemCampo, existente] = await Promise.all([etapaDestino(p.tipo === "visto" ? ETAPA_VISTO : ETAPA), campoOrigem(), contatoExistente(p.telefone)]);
    // Visto: se o contato já tem um lead de visto aberto, a nova análise entra nele como nota (sem criar outro lead).
    if (p.tipo === "visto" && existente) {
      const aberto = await leadVistoAberto(existente.id).catch((e) => { console.error("[lp-leads] busca lead aberto", String(e).slice(0, 200)); return null; });
      if (aberto) {
        await kommo("/leads", { method: "PATCH", body: JSON.stringify([{ id: aberto.id, tags_to_add: [{ name: ORIGEM }, { name: p.etiqueta }] }]) })
          .catch((e) => console.error("[lp-leads] etiquetas lead aberto", aberto.id, String(e).slice(0, 200)));
        const texto = ["NOVO ENVIO PELO SITE — este contato já tinha este lead de visto aberto, então as informações foram anotadas aqui (nenhum lead novo foi criado).", "",
          ...p.nota, "", `Enviado em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`].join("\n");
        await kommo("/leads/notes", { method: "POST", body: JSON.stringify([{ entity_id: aberto.id, note_type: "common", params: { text: texto } }]) });
        console.log("[lp-leads] lead reaproveitado", { tipo: p.tipo, leadId: aberto.id });
        if (veioDaBio(b.analise)) await registrarEvento("/analise", "envio", null, req.headers.get("user-agent") ?? "").catch(() => {});
        return json({ ok: true }, 200, h);
      }
    }
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
    if (p.tipo === "visto" && veioDaBio(b.analise)) await registrarEvento("/analise", "envio", null, req.headers.get("user-agent") ?? "").catch(() => {});

    let pix: Awaited<ReturnType<typeof criarPix>> | null = null;
    if (p.tipo === "passaporte" && p.preco && p.cpf) {
      try {
        pix = await criarPix(leadId, p.preco, { nome: p.nome, email: p.email, telefone: p.telefone, cpf: p.cpf, titulo: p.titulo });
        if (pix) await kommo("/leads/notes", { method: "POST", body: JSON.stringify([{ entity_id: leadId, note_type: "common", params: { text:
          `💳 Pix gerado no site · ${brl(p.preco)} · Assessoria Passaporte · válido por 24 h\nAguardando pagamento. Pix copia e cola no campo "Pix copia e cola".` } }]) }).catch(() => {});
      } catch (e) { console.error("[lp-leads] pix falhou", leadId, String(e).slice(0, 300)); }
    }
    return json({ ok: true, pix }, 200, h);
  } catch (e) {
    console.error("[lp-leads] falha", p.tipo, String(e).slice(0, 300));
    return json({ ok: false, erro: "kommo" }, 502, h);
  }
});
