# DENIA Platform V10 Functional

Database D1 já configurado:
`denia-saas`
`01bd6b23-af41-461d-8b86-7ad1f4c9d4f9`

## Esta versão corrige
- cadastro com diagnóstico real
- PBKDF2 reduzido para 30.000 iterações para evitar excesso de CPU no Worker
- endpoint `/health`
- PT / EN / ES com páginas realmente traduzidas
- login e cadastro em cada idioma
- dashboard em cada idioma
- login real via D1
- menu completo acessível antes da integração com WhatsApp real

## Publicação
Substitua os arquivos atuais do repositório `denia-landing` por todos os arquivos desta V10.

Cloudflare:
Build: `npm run build`
Deploy: `npx wrangler deploy`
Root: `/`

## Teste em ordem
1. `/health`
   Deve exibir:
   `D1: OK`

2. `/cadastro`
   Crie o primeiro usuário.

3. `/login`

4. `/app`

Idiomas:
- Português `/`
- English `/en`
- Español `/es`

## Observação
Conversas, Meta e OpenAI ainda aparecem como áreas preparadas até conectarmos a DENIA Engine real.
O login, o D1, o treinamento local e as configurações funcionam nesta versão.
