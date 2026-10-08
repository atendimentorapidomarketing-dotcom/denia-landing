# DENIA Platform 2.0

O centro de comando da DENIA. É multiempresa: cada empresa tem o seu painel, a sua equipe, a sua IA e os seus dados.
A **Central de Atendimento** é criada automaticamente como a primeira empresa.

São três peças diferentes:

| Peça | Onde fica | Para que serve |
|---|---|---|
| **DENIA Engine** (`engine/worker.js`) | Worker da Cloudflare que já atende o WhatsApp | A IA em si: conversa, consulta profissionais, agenda e aprende |
| **DENIA Platform** (este repositório) | Outro Worker da Cloudflare, grátis | Site, login, painel de cada empresa e treinamento da IA |
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

## Publicar (grátis, sem abrir ao público)

### 1. Substituir os arquivos no GitHub
1. No repositório `denia-platform`, apague `DEPLOY_AGORA.txt`, `tsconfig.json` e `vite.config.ts`.
2. Envie todos os arquivos do pacote: **Add file → Upload files**, arrastando as pastas `public`, `src`, `scripts`, `test` e `engine`, mais os arquivos da raiz. Confirme com **Commit changes**.

### 2. Cloudflare (o projeto `denia-platform` já ligado ao GitHub)
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

A Cloudflare publica sozinha a cada commit. Na primeira publicação, ela também cria sozinha o banco D1 `denia-platform`.

### 3. Secrets do Worker `denia-platform`
Vá em **Settings → Variables and Secrets** e adicione, como **Secret**:

| Nome | Valor |
|---|---|
| `PLATFORM_ADMIN_EMAIL` | o seu e-mail (você é o administrador geral) |
| `PLATFORM_ADMIN_PASSWORD` | uma senha com pelo menos 12 caracteres |
| `SESSION_SECRET` | uma sequência aleatória de 40 caracteres ou mais (exemplo: digite qualquer frase longa com números) |

Opcionais: `CONTATO_WHATSAPP` (ex.: `5521999999999`) e `CONTATO_EMAIL`, para mostrar os botões de contato no site.

### 4. Ligar a Central de Atendimento à IA
1. No Worker da **DENIA (Engine)**, crie o secret `DENIA_PLATFORM_SERVICE_TOKEN` com uma senha longa (40 caracteres ou mais).
2. Troque o código do Engine pelo arquivo `engine/worker.js` (versão 30.3).
3. Entre na plataforma (`/entrar`) e vá em **Integrações**. Cole o endereço do Engine (`https://....workers.dev`) e o mesmo token. Clique em **Salvar** e depois em **Testar conexão**.
4. Vá em **Aprendizados** e clique em **Começar a aprender**.

### Site fora do Google
O `robots.txt` já bloqueia o painel. Enquanto for só teste, não divulgue o endereço. Se quiser bloquear também o site, ative o **Cloudflare Access** no Worker (grátis para até 50 pessoas).

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
