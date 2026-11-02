# LP WT — Water Turismo

Landing page da Water Turismo (cartão de visita virtual), em HTML estático.

## Páginas
- `index.html` — página principal: equipe, serviços, depoimentos
- `visto.html` — assessoria para visto americano
- `viagem-programada.html` — Water Viagem Programada, com formulário de adesão

## Pendências
- **Envio do formulário da Viagem Programada:** em `viagem-programada.html`, preencha `ENDPOINT_ADESAO` com a URL que recebe as adesões (webhook do Kommo/Make etc.). Enquanto estiver vazio, o formulário mostra a confirmação mas **não envia os dados**.
- Fotos da equipe (espaços marcados `[FOTO ...]`)
- Depoimentos e link das avaliações no Google
- Página de assessoria para passaporte brasileiro (R$ 120,00 por pessoa, com formulário)

## Publicação
Ainda não publicado. Para publicar no Netlify, basta apontar o site para este repositório (sem build; pasta raiz).
