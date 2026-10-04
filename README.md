# DENIA Platform V8 — Immersive Team

Substitui a V7 inteira.

## O que funciona agora
- landing imersiva
- idioma visível também no celular
- menu mobile
- Entrar / Criar conta
- luz que acompanha o dedo no celular
- partículas, cometas e efeitos preservados
- login real com e-mail/senha
- um único acesso pode ser compartilhado pela equipe
- D1 para usuário, sessão, treinamento e configurações
- `/app` protegido
- menus de Visão geral, Conversas, Treinar IA, Desempenho, WhatsApp, Profissionais, Relatórios, OpenAI, Meta e Configurações

## O que ainda precisa de integração
Conversas reais do WhatsApp, métricas reais de desempenho, OpenAI e Meta precisam ser conectadas à DENIA Engine.
A interface já está pronta; não são dados falsos.

## Publicação
1. Crie/tenha o D1 `denia-saas`
2. Copie o database_id
3. Em `wrangler.jsonc`, substitua `SUBSTITUA_PELO_DATABASE_ID`
4. Suba TODOS os arquivos desta V8 para o repositório, substituindo a V7
5. Cloudflare:
   Build: `npm run build`
   Deploy: `npx wrangler deploy`
   Root: `/`
6. Após deploy, abra `/cadastro`
7. Crie o único acesso da equipe
8. Depois entre por `/login`

## Segurança
Não coloque senha no código nem no GitHub. A senha é criada no primeiro cadastro e armazenada como hash PBKDF2 no D1.
