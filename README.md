# DENIA Landing V4 — publicação rápida

Esta versão existe para colocar a landing pública no ar **agora**, sem depender de Next.js, Clerk, D1 ou da DENIA Engine.

## Cloudflare — campos

Build command:
npm run build

Deploy command:
npx wrangler deploy

Root directory:
/

Preview builds:
pode deixar desligado nesta primeira publicação.

## O que acontece
- `npm run build` usa apenas Node.js e copia `/site` para `/dist`.
- `wrangler deploy` publica `/dist` como assets estáticos do Worker.
- Não há framework para quebrar o build.
- Depois de a Home estar online, o app autenticado será criado separadamente.