# DENIA na Hostinger (plano Cloud Startup)

O DENIA agora roda em dois lugares com **o mesmo código**:

- **Cloudflare** (como hoje), pelo `wrangler.jsonc`;
- **qualquer hospedagem Node.js**, como a Hostinger, pelo `server.js`. É um servidor só, que roda a plataforma **e** a IA do WhatsApp, com banco SQLite em arquivo (sem limite diário de leituras).

Nada muda na Cloudflare até você trocar os endereços (passo 7). Dá para testar a Hostinger com calma antes.

---

## O que o servidor faz sozinho

| Na Cloudflare | Na Hostinger |
|---|---|
| Banco D1 (limite diário no plano grátis) | Arquivo `~/denia-dados/denia.db` (sem limite) |
| KV `MEMORIA` da IA do WhatsApp | Arquivo `~/denia-dados/memoria.db` |
| Cron a cada 1 e 5 minutos | Relógio interno + Cron Job do painel (garantia) |
| Worker `denia` (IA do WhatsApp) separado | Mesmo app, no endereço `/ia/` |
| — | Cópia de segurança diária em `~/denia-dados/copias/` (7 dias) |
| — | Na primeira vez, copia todos os dados da Cloudflare |

A pasta `denia-dados` fica **fora** da pasta do app, então publicar uma versão nova não apaga nada.

---

## Passo 1 — Token da Cloudflare, só para copiar os dados (5 min)

1. Entre em dash.cloudflare.com → seu ícone (canto superior direito) → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**.
2. Nome: `copiar-para-hostinger`. Permissões:
   - **Account** · **D1** · **Edit**. A exportação exige "Edit", mas o servidor só lê.
   - **Account** · **Workers KV Storage** · **Read**.
3. Crie o token e **não mande para ninguém**, nem para mim. Você vai colá-lo direto no painel da Hostinger (passo 3).
4. Anote também, porque não são secretos:
   - **Account ID**: em Workers & Pages, na coluna da direita.
   - **ID do banco D1**: Storage & Databases → D1 → `denia-saas` → "Database ID".
   - **ID do KV**: Storage & Databases → KV → o namespace ligado ao Worker `denia` como `MEMORIA`.
   - Confira em Workers & Pages → `denia` → Settings → Bindings qual banco D1 ele usa. Se **não** for o `denia-saas`, anote o ID dele também.

Depois que tudo estiver na Hostinger, você pode apagar esse token.

## Passo 2 — Criar o app Node.js na Hostinger (10 min)

hPanel → **Sites** → **Adicionar site** → **App Node.js**. Os nomes no painel podem variar um pouco.

- **Origem**: importar do GitHub → repositório `denia-landing`, ramo `main`. Toda publicação nova no `main` atualiza o app.
- **Versão do Node.js**: **22** ou **24**. Precisa ser 22.13 ou mais nova.
- **Arquivo de entrada**: `server.js`.
- **Comando de build**: `npm install --omit=dev`. Se não houver o campo, deixe o padrão.
- **Comando de início**: `npm start`.
- **Domínio**: um subdomínio do seu domínio, por exemplo `app.seudominio.com.br`. A Hostinger cria o certificado https sozinha.

## Passo 3 — Variáveis de ambiente (15 min)

No app Node.js → **Variáveis de ambiente**, cole cada uma. Os valores secretos **não aparecem** de novo na Cloudflare. Use os que você guardou ou pegue de novo na origem: OpenAI, Meta for Developers, Google Cloud, Asaas, Resend.

**Do servidor (novas):**

| Nome | Valor |
|---|---|
| `SITE_URL` | `https://app.seudominio.com.br` (o endereço novo, sem barra no fim) |
| `DENIA_CHAVE_SERVIDOR` | Uma senha longa que você inventa (40+ caracteres). Abre as páginas `/__denia/…`. |
| `DENIA_TAREFAS` | `desligadas` enquanto estiver testando. Apague no dia da troca. |
| `ENGINE_DENIA_PAUSADA` | `true` enquanto estiver testando (a IA da Hostinger não manda mensagens). Apague no dia da troca. |
| `CF_CONTA_ID` | Account ID (passo 1) |
| `CF_API_TOKEN` | O token do passo 1 |
| `CF_D1_ID` | ID do banco `denia-saas` |
| `CF_KV_ID` | ID do KV `MEMORIA` |
| `CF_D1_ID_ENGINE` | Só se o Worker `denia` usar **outro** banco D1 |

**Copiadas da Cloudflare.** São as mesmas do Worker `denia-landing` (Settings → Variables and Secrets) e do Worker `denia`. Coloque só as que existem lá:

- Plataforma: `SESSION_SECRET`, `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_REALTIME_MODEL`, `OPENAI_TRANSCRIPTION_MODEL`, `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`, `META_WA_CONFIG_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_PLACES_API_KEY`, `RESEND_API_KEY`, `EMAIL_REMETENTE`, `CONTATO_EMAIL`, `CONTATO_WHATSAPP`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`, `CHANNEX_API_KEY`, `TELEGRAM_BOT_TOKEN_PLATAFORMA`, `DENIA_PLATFORM_SERVICE_TOKEN`.
- IA do WhatsApp (Worker `denia`): `WHATSAPP_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_TEMPLATE_CONSULTA_TECNICO`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `EQUIPE_TELEFONES`, `PAINEL_SENHA`, `PLATAFORMA_API_URL`, `PLATAFORMA_API_TOKEN`, `CRM_CONSULTA_URL`, `CRM_TOKEN`, `RELATORIO_GMAIL_URL`, `RELATORIO_GMAIL_SEGREDO`, `RELATORIO_EMAIL_TO`, `MARKUP_PERCENT`.
- Algum nome existe nos **dois** Workers com valores **diferentes** (por exemplo, `OPENAI_MODEL`)? Coloque o da plataforma normalmente e o da IA com o prefixo `ENGINE_` (exemplo: `ENGINE_OPENAI_MODEL`).
- Alguma variável aponta para um endereço `…workers.dev`, como `PLATAFORMA_API_URL`? Troque pelo endereço novo.
- Não precisa de `LIMITE_CHAMADAS`: o servidor já usa 900, porque aqui não existe o limite do plano grátis.

> ⚠️ **`SESSION_SECRET` tem que ser exatamente a mesma da Cloudflare.** As conexões salvas (Facebook, Instagram, Google, WhatsApp, Telegram, chaves da OpenAI) são guardadas cifradas com ela. Se ela for diferente, todo mundo entra de novo normalmente, mas cada conexão precisa ser refeita uma vez. O servidor confere isso para você no passo 5.

Salve e reinicie o app. Na primeira vez, ele copia os dados da Cloudflare. Leva de alguns segundos a poucos minutos.

## Passo 4 — Cron Job de garantia (2 min)

hPanel → **Avançado** → **Cron Jobs** → **a cada minuto**, comando:

```
curl -s "https://app.seudominio.com.br/__denia/tique?chave=SUA_DENIA_CHAVE_SERVIDOR" > /dev/null
```

O servidor já tem relógio próprio. O Cron Job garante que as tarefas (posts agendados, campanhas, lembretes, avaliações, calendários) rodem mesmo se a Hostinger "adormecer" o app.

## Passo 5 — Conferir (5 min)

Abra `https://app.seudominio.com.br/__denia/estado?chave=SUA_DENIA_CHAVE_SERVIDOR` e veja:

- `importacao.status` = `concluida`;
- `chave_das_conexoes` = `confere`. Se disser **NÃO CONFERE**, a `SESSION_SECRET` está diferente: corrija e reinicie;
- `banco` com o tamanho parecido com o do D1.

Depois entre em `https://app.seudominio.com.br/entrar` com seu e-mail e senha de sempre e confira empresas, imóveis e conversas.

## Passo 6 — Dia da troca (30 min, num horário calmo)

1. **Cloudflare → Workers & Pages → `denia-landing` e `denia` → Settings → Triggers → apague os Cron Triggers.** Assim as tarefas não rodam em dobro.
2. Copie os dados mais recentes: abra `https://app.seudominio.com.br/__denia/importar?chave=SUA_DENIA_CHAVE_SERVIDOR&confirmar=sim`. Antes de substituir, o servidor guarda uma cópia do banco atual em `copias/`.
3. Na Hostinger, **apague** `DENIA_TAREFAS` e `ENGINE_DENIA_PAUSADA` e reinicie o app.
4. Troque os endereços (passo 7) logo em seguida.

## Passo 7 — Endereços para trocar

Troque `https://…workers.dev` por `https://app.seudominio.com.br`:

| Onde | Endereço novo |
|---|---|
| Meta for Developers → app → WhatsApp → Configuração → Webhook, onde hoje está o Worker **`denia`** (`…/webhook`) | `https://app.seudominio.com.br/ia/webhook` (mesmo token de verificação) |
| Meta → WhatsApp → Webhook, onde hoje está o Worker **`denia-landing`** (`…/webhook/whatsapp`) | `https://app.seudominio.com.br/webhook/whatsapp` |
| Meta → Login do Facebook → Configurações → URIs de redirecionamento OAuth válidos | adicione `https://app.seudominio.com.br/api/meta/retorno` |
| Meta → Configurações → Básico → Domínios do app | adicione `app.seudominio.com.br` |
| Google Cloud → APIs e serviços → Credenciais → cliente OAuth | origem `https://app.seudominio.com.br` e redirecionamento `https://app.seudominio.com.br/api/google/retorno` |
| Asaas → Integrações → Webhooks | `https://app.seudominio.com.br/webhook/asaas` |
| Telegram | Na plataforma, toque de novo em **Conectar Telegram** (ele registra o endereço novo sozinho) |
| Channex (se usar) | Desconecte e conecte de novo em Temporada → Conexões |

Pronto. Deixe a Cloudflare parada (sem Cron Triggers) por uma semana como reserva e depois apague os Workers.

---

## Se algo der errado

- **Voltar para a Cloudflare:** recoloque os Cron Triggers e os endereços antigos dos webhooks. O código continua publicado lá.
- **Ver erros:** `/__denia/estado?chave=…` mostra os 20 últimos em `erros_recentes`.
- **Cópias de segurança:** `~/denia-dados/copias/denia-AAAA-MM-DD.db`. Pelo Gerenciador de Arquivos, dá para baixar uma cópia ou colocá-la no lugar de `denia.db` (com o app parado).
- **Mudar a pasta dos dados:** variável `DENIA_DADOS` com o caminho completo.
- **Variáveis num arquivo:** em vez do painel, dá para colocar as variáveis em `~/denia-dados/.env`. Esse arquivo nunca vai para o GitHub.

## Para quem desenvolve

```
npm start                 # servidor Node (PORT, padrão 3000)
npm test                  # testes (incluem test/servidor.test.mjs)
npm run test:servidor     # os mesmos testes usando o banco do servidor Node no lugar do imitador do D1
```

O código está em `servidor/`:
- `banco.mjs`: D1 e KV sobre `node:sqlite`;
- `arquivos.mjs`: arquivos de `public/` com as regras do `wrangler.jsonc`;
- `importar.mjs`: exportação oficial do D1 e cópia do KV;
- `index.mjs`: HTTP, rotas `/ia/` e `/__denia/`, tarefas e cópias de segurança.
