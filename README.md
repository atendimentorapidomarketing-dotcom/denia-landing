# DENIA Platform V9 — Estrutura plana

Esta versão corrige o erro:
`The entry-point file at "src/worker.js" was not found.`

O `worker.js` agora fica na raiz do repositório. Não existe mais pasta `src`.

## Arquivos que devem aparecer na raiz do GitHub
- index.html
- styles.css
- script.js
- auth.css
- login.html
- cadastro.html
- app.css
- app.html
- app.js
- worker.js
- package.json
- build.mjs
- wrangler.jsonc
- schema.sql
- README.md
- .gitignore

## Cloudflare
Build command:
`npm run build`

Deploy command:
`npx wrangler deploy`

Root directory:
`/`

## D1
No `wrangler.jsonc`, troque:
`SUBSTITUA_PELO_DATABASE_ID`

pelo ID real do banco D1 `denia-saas`.

## Depois do deploy
Abra:
`/cadastro`

Crie o login compartilhado da equipe.

Depois:
`/login`
`/app`
