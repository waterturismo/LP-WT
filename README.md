# LP WT — Water Turismo

Landing page da Water Turismo (cartão de visita virtual), em HTML estático.

## Páginas
- `index.html` — página principal: equipe, serviços, depoimentos
- `visto.html` — assessoria para visto americano
- `viagem-programada.html` — Water Viagem Programada, com formulário de adesão e escolha do 1º vencimento
- `visto.html` — também traz o formulário de contratação B1/B2 (com babá e cortesia a cada 5)
- `passaporte.html` — assessoria de passaporte (R$ 120 cada; a cada 4, o 5º é cortesia)
- `equipe-links.html` — **uso interno**: gera links já preenchidos para enviar ao cliente (fora do Google via robots.txt)

## Links pré-preenchidos
- Viagem Programada: `viagem-programada.html?plano=Superior&parcelas=24#adesao`
- Visto: `visto.html?b1b2=4&baba=1#contratar`
- Passaporte: `passaporte.html?qtd=3#contratar`

## Envio dos formulários
Enquanto os `ENDPOINT_*` estiverem vazios, cada formulário abre o WhatsApp da agência com os dados preenchidos. Quando a integração com o Kommo (funil VENDAS 1, etapa RESERVA) estiver pronta, basta preencher a URL do webhook em cada página.

## Pendências
- **Envio do formulário do visto:** preencha `ENDPOINT_VISTO` em `visto.html`.
- **Envio do formulário da Viagem Programada:** em `viagem-programada.html`, preencha `ENDPOINT_ADESAO` com a URL que recebe as adesões (webhook do Kommo/Make etc.). Enquanto estiver vazio, o formulário mostra a confirmação mas **não envia os dados**.
- Fotos da equipe (espaços marcados `[FOTO ...]`)
- Depoimentos e link das avaliações no Google

## Publicação
Ainda não publicado. Para publicar no Netlify, basta apontar o site para este repositório (sem build; pasta raiz).
