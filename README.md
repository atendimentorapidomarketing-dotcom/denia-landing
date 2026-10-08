# DENIA Platform 2.0

O centro de comando da DENIA. É multiempresa: cada empresa tem o seu painel, a sua equipe, a sua IA e os seus dados.
A **Central de Atendimento** é criada automaticamente como a primeira empresa.

São três peças diferentes:

| Peça | Onde fica | Para que serve |
|---|---|---|
| **DENIA Engine** (`engine/worker.js`) | Worker da Cloudflare que já atende o WhatsApp | A IA em si: conversa, consulta profissionais, agenda e aprende |
| **DENIA Platform** (este repositório) | Worker `denia-landing` da Cloudflare | Site, login, painel de cada empresa e treinamento da IA |
| **Sistema das atendentes** | O sistema contratado que a equipe já usa | Cadastro de clientes: entra na IA por planilha (CSV) ou API |

## O que tem no painel

- **Painel**: saúde da IA, números do dia e botão de pausa geral.
- **Conversas**: todas as conversas do WhatsApp. É possível assumir a conversa, responder como equipe e devolver para a IA.
- **Atendimentos**: quadro com as etapas de cada caso.
- **Treinar IA**: o treinamento da IA é feito aqui, e não mais na Cloudflare. Cada salvamento gera uma versão.
- **Aprendizados**: a IA lê os últimos 6 meses de conversas e sugere o que aprender. Você aprova, edita ou rejeita cada sugestão.
- **Base de clientes**: importa o cadastro exportado do sistema das atendentes (CSV).
- **Integrações**: conecta o Engine da empresa (o token fica cifrado no banco).
- **Equipe**: perfis Proprietário, Administrador, Atendente e Somente leitura, com senha temporária no primeiro acesso.
- **Auditoria**: quem fez o quê e quando.
- **Empresas**: aparece só para o administrador geral, que pode criar e suspender empresas.

## Publicação

Este repositório publica o Worker **`denia-landing`** da Cloudflare. Cada commit na `main` é publicado sozinho
(build `npm run build`, deploy `npx wrangler deploy`). Não é preciso configurar nada novo:

- **Banco:** usa o mesmo banco `denia-saas`. As contas da versão anterior continuam entrando com o mesmo e-mail
  e a mesma senha, e as tabelas novas (prefixo `plt_`) não mexem nas antigas.
- **IA:** a ligação com a IA do WhatsApp usa as variáveis `DENIA_ENGINE_URL` e `DENIA_PLATFORM_SERVICE_TOKEN`,
  que já existem neste Worker. Elas valem para a primeira empresa (Central de Atendimento).
- **Sessões:** a chave é criada sozinha no banco. Se quiser, defina o secret `SESSION_SECRET`.
- **Administrador geral (opcional):** `PLATFORM_ADMIN_EMAIL` e `PLATFORM_ADMIN_PASSWORD`. A conta principal da
  versão anterior (perfil SUPER_ADMIN) já é administradora geral.

A IA do WhatsApp (`engine/worker.js`) fica em outro Worker, o **`denia`**: o código é colado direto no editor da
Cloudflare.

## Segurança

- **Senhas:** guardadas só como hash PBKDF2 com sal, nunca em texto.
- **Login:** bloqueio de 15 minutos depois de 5 tentativas erradas.
- **Sessão:** cookie assinado, `HttpOnly`, `Secure` e `SameSite=Strict`, válido por até 8 horas. Pode ser encerrada em todos os dispositivos.
- **Proteção da página:** CSP sem scripts embutidos, proteção contra requisições forjadas (Origin + cabeçalho `X-Denia`) e bloqueio de exibição em iframe.
- **Empresas separadas:** cada pessoa só enxerga as empresas das quais faz parte.
- **Token do Engine:** cifrado com AES-GCM e enviado ao Engine só pelo servidor.
- **O que a plataforma pode fazer no Engine:** só uma lista fixa de operações, cada uma com um perfil mínimo e registro na auditoria.

## Testar no computador (opcional)

```bash
npm install
cp .env.example .dev.vars   # preencha os valores
npm test                     # testes da plataforma e do Engine
npm run dev                  # http://localhost:8787
```
