# LP WT — Water Turismo

Landing page da Water Turismo (cartão de visita virtual), em HTML estático.

## Páginas
- `index.html` — página principal: equipe, serviços, depoimentos
- `visto.html` — assessoria para visto americano
- `viagem-programada.html` — Water Viagem Programada, com formulário de adesão e escolha do 1º vencimento
- `visto.html` — também traz o formulário de contratação B1/B2 (com babá e cortesia a cada 5)
- `equipe-links.html` — **uso interno**: gera links já preenchidos para enviar ao cliente (fora do Google via robots.txt)

## Links pré-preenchidos
- Viagem Programada: `viagem-programada.html?plano=Superior&parcelas=24#adesao`
- Visto: `visto.html?b1b2=4&baba=1#contratar`

## Pendências
- **Preços da assessoria de visto:** em `visto.html`, preencha `PRECO_B1B2` e `PRECO_BABA` (hoje aparecem como [VALOR]).
- **Envio do formulário do visto:** preencha `ENDPOINT_VISTO` em `visto.html`.
- **Envio do formulário da Viagem Programada:** em `viagem-programada.html`, preencha `ENDPOINT_ADESAO` com a URL que recebe as adesões (webhook do Kommo/Make etc.). Enquanto estiver vazio, o formulário mostra a confirmação mas **não envia os dados**.
- Fotos da equipe (espaços marcados `[FOTO ...]`)
- Depoimentos e link das avaliações no Google
- Página de assessoria para passaporte brasileiro (R$ 120,00 por pessoa, com formulário)

## Publicação
Ainda não publicado. Para publicar no Netlify, basta apontar o site para este repositório (sem build; pasta raiz).
