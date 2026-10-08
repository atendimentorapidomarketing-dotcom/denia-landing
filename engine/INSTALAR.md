# DENIA Engine V30.2 — como instalar no Cloudflare

Arquivo para colar: `engine/worker.js` (um arquivo só, ~1.900 linhas).
Funciona no **plano gratuito** da Cloudflare. Usa o mesmo D1 (`DB`) e o mesmo KV
(`MEMORIA`) da versão atual. **O histórico das conversas é preservado**: a V30 lê as
tabelas `pessoas`, `mensagens`, `casos`, `atendentes`, `tecnicos` e `treinamento_ia`
que já existem, e só cria tabelas novas com prefixo `d30_` (não altera nem apaga nada).

---

## Passo 1 — Guardar a versão atual (2 min)

1. Cloudflare → **Workers & Pages** → abra o Worker do atendimento → **Edit code**.
2. Selecione todo o código (Ctrl+A), copie e salve no computador como `denia-v29-backup.js`.
3. A Cloudflare também guarda as versões anteriores em **Deployments**; o backup é uma garantia extra.

## Passo 2 — Configurar os secrets (5 min)

Worker → **Settings → Variables and Secrets**. Mantenha os que já existem
(`OPENAI_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `OPENAI_MODEL` etc.). Adicione:

| Nome | Obrigatório? | O que é |
|---|---|---|
| `PAINEL_SENHA` | Opcional | Sem ele, as páginas `/chat`, `/treinar` e `/api/saude` abrem direto, como na versão antiga. Se quiser proteger, crie com no mínimo 8 caracteres e entre por `/login`. (Isso não tem relação com o editor de código da Cloudflare.) |
| `META_APP_SECRET` | Recomendado | "Chave secreta do app" (Meta for Developers → seu app → Configurações → Básico). Impede que alguém forje mensagens no webhook. |
| `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` | Recomendado | Alertas para a equipe e o aviso de "SERVIÇO AGENDADO". Sem eles, os alertas só aparecem no log. |
| `WHATSAPP_TEMPLATE_CONSULTA_TECNICO` | Recomendado | Nome de um template aprovado pela Meta para falar com prestador que não escreveu nas últimas 24 h (ver Passo 7). |
| `PLATAFORMA_API_URL` e `PLATAFORMA_API_TOKEN` | Se usar a plataforma de cadastro | Os mesmos da versão anterior. A DENIA envia clientes e atendimentos (serviço, prestador, valores, etapa) e só considera enviado quando a plataforma responde `ok: true` com `cliente_id` (e `os_id` para atendimentos). |
| `CRM_CONSULTA_URL` e `CRM_TOKEN` | Opcional | Para a DENIA **ler** a ficha do cliente na plataforma (serviços feitos, valores). A DENIA chama `GET CRM_CONSULTA_URL?telefone=5521999999999` com `Authorization: Bearer CRM_TOKEN` e usa o JSON que voltar. Peça ao desenvolvedor da plataforma esse endereço. |
| `DENIA_PLATFORM_SERVICE_TOKEN` | Para usar a DENIA Platform | Uma senha longa (mínimo 16 caracteres; use 40 ou mais) que você inventa. Coloque a mesma na tela **Integrações** da empresa na DENIA Platform. Com ela, a plataforma treina a IA, aprova aprendizados, importa clientes e acompanha conversas. |
| `EQUIPE_TELEFONES` | Recomendado | Telefones da equipe, separados por vírgula (ex.: `5521999990000,5521988880000`). Se o D1 cair, esses números nunca recebem resposta automática. |
| `DENIA_PAUSADA` | Emergência | Coloque `true` para parar todos os envios automáticos. Apague para voltar. |
| `MARKUP_PERCENT` | Opcional | Acréscimo quando o prestador diz que o valor é "só a parte dele". Padrão: 50. |
| `JANELA_AGRUPAMENTO_MS` | Opcional | Quanto tempo a DENIA espera o cliente parar de escrever antes de responder (tudo numa resposta só). Padrão 15000 (15 s), máximo 20000. Se tiver este secret com 8000 da versão antiga, apague-o. |
| `RELATORIO_GMAIL_URL`, `RELATORIO_GMAIL_SEGREDO`, `RELATORIO_EMAIL_TO` | Opcional | Relatório diário por e-mail, usando o mesmo Google Apps Script da versão anterior. Sem eles, o relatório vai só para o Telegram. |

## Passo 3 — Conferir bindings e cron (1 min)

- **Settings → Bindings**: precisam existir `DB` (D1) e `MEMORIA` (KV). São os mesmos de hoje.
- **Settings → Triggers → Cron Triggers**: precisa haver `* * * * *` (a cada minuto).
  Se já existir, não mexa. Se não existir, adicione.

## Passo 3b — Garantir que só UM Worker atende o WhatsApp (importante)

Se o Worker antigo continuar ativo, os DOIS respondem cada mensagem — o cliente recebe mensagens
em dobro e o cron antigo continua consumindo a cota do D1.

- Em **Workers & Pages**, veja se existe mais de um Worker de atendimento.
- No painel da Meta (WhatsApp → Configuração → Webhook), a URL de retorno deve apontar para o
  Worker onde você colou a V30.1.
- No Worker antigo (se for outro), remova o **Cron Trigger** ou apague o Worker.

## Passo 4 — Trocar o código (2 min)

1. **Edit code** → apague todo o conteúdo → cole o conteúdo de `engine/worker.js`.
2. **Deploy**.

## Passo 5 — Conferir a saúde (1 min)

Abra `https://SEU-WORKER.workers.dev/api/saude` (se você criou `PAINEL_SENHA`, entre antes por `/login`).

Precisa aparecer `"ok": true` e `"d1": { "operacional": true }`. Os outros campos mostram
o que ainda falta configurar (Telegram, template, assinatura da Meta).

## Passo 6 — Testar no simulador, sem enviar nada de verdade

Abra `https://SEU-WORKER.workers.dev/chat`.

- Escolha **Cliente de teste** e escreva, por exemplo: "Preciso trocar a fechadura, é em Botafogo".
  O simulador mostra a mensagem que iria para o prestador (Anderson **chaveiro**) e a resposta ao cliente.
- Troque para **Prestador: Anderson (chaveiro)** e responda: "Faço amanhã às 10h, 150, só minha parte".
  O cliente de teste recebe a proposta já com o acréscimo (R$ 225,00).
- Volte para o cliente: "Pode ser" → ele pede o endereço → informe → o prestador recebe o pedido de confirmação.
- Prestador: "Confirmado" → o cliente recebe a confirmação e aparece o aviso de Telegram.
- **Limpar teste** apaga só os dados do simulador.

Depois, faça um teste real com o seu próprio celular.

## Passo 7 — Template para prestadores (recomendado)

A Meta não permite mandar texto livre para quem não escreveu ao número da empresa nas
últimas 24 h. Sem template, nesse caso a DENIA **não** diz ao cliente que enviou: responde
"Um momento, por favor." e avisa a equipe no Telegram.

Crie no WhatsApp Manager um template de categoria "Utilidade", com 5 variáveis, por exemplo:

> Olá! A Central de Atendimento tem uma solicitação para você. Cliente: {{1}}. Serviço: {{2}}. Detalhes: {{3}}. Local: {{4}}. Referência: {{5}}. Você realiza esse serviço? Se sim, responda com valor e disponibilidade.

Depois de aprovado, coloque o nome dele em `WHATSAPP_TEMPLATE_CONSULTA_TECNICO`.

## Emergência: parar a DENIA na hora

- Painel `/chat` → **PAUSAR DENIA** (e **Reativar DENIA** para voltar). As mensagens continuam
  chegando no app e sendo registradas; só os envios automáticos param.
- Sem acesso ao painel: crie a variável `DENIA_PAUSADA` = `true`.
- Último recurso: apague o secret `WHATSAPP_TOKEN`.

## Como voltar à versão anterior (rollback)

Worker → **Deployments** → escolha a versão anterior → **Rollback**. Ou cole o
`denia-v29-backup.js` em **Edit code** e faça **Deploy**. As tabelas `d30_` ficam no D1 sem atrapalhar a versão antiga.

---

## O que muda no dia a dia

- **A IA não age sozinha.** Ela interpreta e escreve. Consultar prestador, mandar proposta e
  confirmar agendamento são decisões do código, gravadas por etapa:
  `COLETANDO → AGUARDANDO_PRESTADOR → AGUARDANDO_CLIENTE → (AGUARDANDO_ENDERECO) → AGUARDANDO_CONFIRMACAO_PRESTADOR → AGENDADO`.
- **"Agendado" só depois que o prestador confirma.** O "sim" do cliente leva o caso para
  "aguardando confirmação do prestador".
- **"Enviamos ao profissional" só depois que a Meta confirma o envio.**
- **Cancelamento nunca é automático:** a equipe recebe um alerta.
- **Cada consulta vai com "Caso #N".** Se o prestador tiver dois casos abertos e não disser
  qual, a DENIA pergunta. Se ele responder citando a mensagem (responder/arrastar no WhatsApp),
  o caso é identificado automaticamente.
- **Valor só vale se o prestador escreveu o número.** Se ele não disser se é o valor final ou só a
  parte dele, a DENIA pergunta antes de passar ao cliente. O prestador nunca vê o valor com acréscimo.
- **Mensagens soltas do prestador** ("Eita, Niterói") não viram ação: vão como alerta para a equipe.
- **Atendente humano respondeu pelo app?** Aquela conversa fica 10 min em silêncio. Tudo é gravado,
  inclusive áudio do atendente transcrito, e a DENIA continua de onde o humano parou.
- **"ok", "obrigado", "entendi"** não geram resposta quando não há pergunta pendente.
- **Frases perigosas são removidas antes do envio:** valor que não veio do prestador nem do
  treinamento, CPF/telefone, "agendado"/"confirmado"/"cancelado" sem ter acontecido, promessa de
  consultar sem consulta real, cobertura de região não confirmada, bairro como requisito de orçamento,
  e perguntar de novo serviço, bairro, endereço ou nome já registrados.
- **À noite (21h–8h)** nenhuma mensagem vai para prestador; as consultas são enviadas às 8h,
  e o cliente é avisado disso.
- **Mensagens com mais de 15 min de atraso** (a Meta reenviando depois de uma falha) não são
  respondidas automaticamente; a equipe é avisada.
- **Se o D1 cair**: no máximo 1 resposta a cada 2 minutos por cliente, sem consultar prestadores;
  prestadores e equipe não recebem resposta automática; o Telegram recebe 1 aviso por hora.
  A cota gratuita do D1 volta todo dia às 21h (horário de Brasília). Veja o motivo exato em `/api/saude`.
- **Trava contra rajadas**: no máximo 4 mensagens em 2 min, 10 em 10 min e 25 por hora para o
  mesmo contato. Passou disso, os envios param e a equipe recebe um aviso.
- **Bairro**: a DENIA não pergunta por iniciativa própria e nunca repete uma pergunta já feita.
- **Treinamento** (`/treinar`): cada salvamento cria uma versão; dá para restaurar qualquer versão;
  apagar um campo preenchido exige confirmação.
- **Relatório diário** às 20h no Telegram (e e-mail, se configurado), com casos parados e uma
  autoavaliação dos erros do dia.

## Como ensinar quem atende o quê (roteamento)

A DENIA escolhe o profissional pela **categoria**, decidida pela IA lendo o seu treinamento.
Escreva no campo **SERVIÇOS** ou **REGRAS** do `/treinar` frases diretas, por exemplo:

- "Eletricista (William) só faz elétrica da casa: tomadas, disjuntores, fiação. Não conserta eletrodomésticos."
- "Aparelho que queimou por ligar no 220 V é conserto de aparelho, não é eletricista."
- "Micro-ondas, air fryer e TV: a equipe avalia."

Quando a IA não tiver certeza, ela **não** consulta ninguém: responde "Um momento, por favor."
e avisa a equipe no Telegram.

## Aprender com os últimos 6 meses

Pela DENIA Platform → **Treinar IA → Aprendizados**, clique em **Começar a aprender**. A DENIA lê
as conversas aos poucos (cerca de 220 mensagens por minuto) e mostra sugestões. Você aprova,
edita ou rejeita cada uma; só as aprovadas passam a valer. O custo é uma chamada à OpenAI por
minuto enquanto a leitura estiver em andamento.

## Onde editar

- **Prestadores**: lista `PRESTADORES` no início do `worker.js` (telefone + área). A ordem define quem é consultado primeiro.
- **Categorias e palavras-chave**: `CATEGORIAS` e `REGRAS_AREA`, logo abaixo. A categoria `BALCAO`
  (eletrônicos levados à loja) não consulta prestador: avisa a equipe e nunca pergunta bairro.
- **Tom, serviços, preços autorizados, regras**: painel `/treinar`, sem mexer no código.

## O que ficou de fora nesta versão (de propósito)

- Os comandos da equipe pelo WhatsApp ("mande para o Anderson...") foram removidos: eram a
  origem de vários envios indevidos. A equipe fala direto com o prestador pelo app; a DENIA
  pausa e registra essa conversa.
- Consultas abertas **na versão antiga** não são continuadas automaticamente. No dia da troca,
  acompanhe manualmente as conversas que estavam no meio de um orçamento.
- Google Agenda, Google Business, Instagram e cobrança não fazem parte deste Worker.

## Testes

`cd engine && npm test` roda 37 cenários: os do handoff e os erros relatados (repetição,
reabertura, promessa sem ação, prestador como cliente, Carlos/Anderson, mistura de casos,
"que cliente?", "Eita, Niterói", preço inventado, confirmação sem prestador, D1 fora do ar,
treinamento, assinatura da Meta etc.). Os testes usam um D1 real (SQLite) e simulam Meta,
OpenAI e Telegram. As respostas reais do modelo da OpenAI precisam ser acompanhadas nos
primeiros dias: os alertas no Telegram e a linha "Respostas corrigidas pela guarda", no
relatório diário, mostram onde a IA tentou errar.
