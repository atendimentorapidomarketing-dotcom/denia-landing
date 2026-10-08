# DENIA — Auditoria do Engine (código colado: "V29", internamente v29.7)

> **Atualização:** a seção 6 (patches sobre a v29.7) foi substituída pela **DENIA Engine V30** em `engine/` (ver `engine/INSTALAR.md`). Este documento fica como registro do diagnóstico.

Data: 2026-10-07
Escopo: o código do Worker colado na conversa (cabeçalho "DENIA V29 — CLIENTE NUNCA ESCOLHE
DESTINATÁRIO + DOMINGO SEGURO", `/api/saude` reporta `operacao-2026-10-07-v29.7-...`) e o
repositório `denia-platform`.

> Nada foi alterado em produção. Este documento é diagnóstico + plano. Os patches da seção 6
> ainda **não foram testados**: eles só devem ir ao ar depois que o arquivo real do Worker estiver
> versionado neste repositório e coberto pelos testes da seção 9.

---

## 0. O que recebi e o que está faltando

| Item | Situação |
|---|---|
| Código do Engine | Recebi a **v29.7**, não a V27. A V27 (linha de base declarada) não foi enviada. |
| Código do Engine no Git | **Não está no repositório.** Só existe no editor da Cloudflare / na conversa. |
| Código da Platform | O repositório tem só arquivos de configuração. `wrangler.jsonc` aponta para `./worker/index.ts`, que **não existe**; não há pasta `app/`. O build atual falha. |
| Dependências da Platform | Quase todas em `"latest"` → cada build pode instalar versões diferentes. Isso também é uma fonte de regressão. |

**Primeira ação necessária:** subir para este repositório (via "Add files via upload"):

- `engine/v27/worker.js` (a V27 que funcionava)
- `engine/v29.7/worker.js` (o que está em produção hoje)
- o `wrangler.toml/.jsonc` do Engine (bindings DB, MEMORIA, filas, cron)

Sem a V27 não dá para fazer a comparação V27 × atual que o handoff pede. Sem o arquivo no Git
não dá para aplicar mudanças cirúrgicas com diff, teste e rollback.

---

## 1. Resumo executivo

Os sintomas ("parou de responder", "memória resetada", "pergunta de novo qual serviço",
"ponte com prestador quebrada", "estourou a cota do D1") **não são um problema de modelo/prompt**.
São defeitos estruturais identificáveis no código. Os principais:

1. **Dois cérebros de estado que não conversam.** A partir da v29.5 a consulta ao prestador
   (lista canônica) grava o estado **só no KV** (`v291:cliente:*`, `v291:prof:*`). O fluxo normal
   do cliente lê **só o D1** (`casos`, `pendencias_operacionais`, `estado_atendimento`). O orçamento
   volta do prestador pelo caminho KV e é enviado ao cliente sem entrar no histórico que o fluxo
   D1 usa. Quando o cliente responde "sim", o fluxo D1 não encontra nada pendente → a confirmação
   nunca chega ao prestador e a IA trata a conversa como se não houvesse orçamento.
2. **Mensagens descartadas em silêncio.** Lotes da fila com a última mensagem há mais de
   **2 minutos** vão para `REVISAO_HUMANA` sem aviso a ninguém. Sem Cloudflare Queue configurada,
   o processamento roda no `waitUntil` do webhook (limite de ~30 s após a resposta). Com espera de
   6,5 s + várias chamadas OpenAI de até 20 s cada, o Worker é encerrado no meio, o lock fica preso
   por 10 min, e quando o lote é recuperado já passou de 2 min → descartado. **Depois disso, as
   mensagens seguintes do mesmo cliente também ficam presas atrás do lock.**
3. **Atalhos determinísticos que reiniciam o atendimento.** Pelo menos três trechos respondem
   "Qual serviço você precisa?" **sem olhar o caso ativo**: a saudação ("Bom dia" → "Bom dia! Qual
   serviço você precisa?"), o guardrail "cliente nunca escolhe destinatário" e a resposta para
   ação incompleta. Os dados estruturados (`estado_atendimento`) só são preenchidos quando a IA
   preenche `acao`; casos conduzidos por humano ou pelo caminho KV ficam vazios → o atalho dispara.
4. **Consulta ao prestador sem deduplicação.** O caminho canônico (v29.5) não verifica se já existe
   consulta em andamento. Qualquer mensagem do cliente com "preciso de", "valor", "orçamento" etc.
   (ou qualquer valor em R$ escrito pela IA) reenvia uma nova consulta ao prestador.
5. **A ponte KV é uma por prestador, não por caso.** `v291:prof:<telefone>` guarda um único cliente.
   Um segundo cliente da mesma categoria sobrescreve o primeiro → a resposta do prestador vai para
   o cliente errado. Depois de AGENDADO a ponte não é apagada (TTL de 30 dias): qualquer mensagem
   posterior do prestador gera "Deseja confirmar?" para o cliente antigo.
6. **Cota D1 esgotada por varreduras de manutenção a cada minuto**, não pelo atendimento em si
   (detalhes na seção 3).
7. **Falhas de segurança graves** (seção 2), incluindo uma rota pública que envia WhatsApp do número
   da empresa para qualquer número.

---

## 2. Segurança — P0 (corrigir antes de qualquer outra coisa)

| # | Problema | Onde | Risco |
|---|---|---|---|
| S1 | `GET /api/teste-prestador-v292?to=...&text=...` é **público** e envia texto livre do número da empresa para qualquer telefone. (Depois do envio ele quebra porque `respostaJSON` não existe, mas a mensagem já saiu.) | `rotearRequest` | Spam/phishing com o número da Central; banimento pela Meta. |
| S2 | `POST /webhook` **não verifica `X-Hub-Signature-256`**. | `handleWebhookPostFinal` | Qualquer pessoa forja mensagens de cliente, "ecos humanos" (pausa a IA) ou respostas de prestador (envia orçamento falso ao cliente). |
| S3 | `/treinar`, `GET/POST /api/treinamento`, `/chat`, `/api/limpar-teste`, `/api/saude` **sem autenticação**. | `rotearRequest` | Qualquer um apaga/reescreve o treinamento inteiro (o POST substitui tudo, sem versão), consome OpenAI pelo `/chat`. |
| S4 | Qualquer pessoa cujo nome no WhatsApp seja "Mirella"/"Mirela" é **convertida em TÉCNICO** e vinculada a serviços de limpeza. | `garantirMirellaComoPrestadora` (chamada em toda identificação) e `prepararMirellaParaServicosLimpeza` | Cliente real vira prestador e nunca mais é atendido como cliente. A Mirella já está na lista canônica por telefone; esse hack não é necessário. |
| S5 | Token da Platform comparado com `===` (não em tempo constante). | `platformAutorizadaV28` | Baixo, mas trivial de corrigir. |

---

## 3. Por que o D1 estourou a cota de leituras

O plano gratuito do D1 tem um teto diário de linhas lidas (5 milhões/dia na documentação atual;
confirmar no painel). Uma linha "lida" conta mesmo quando a consulta varre a tabela para achar
nada. Os maiores consumidores identificados:

| Origem | Por que é cara |
|---|---|
| **Cron a cada minuto** → `garantirFilaAtendimento` + `garantirControleV83` | Dois `UPDATE fila_atendimento_v3 ... WHERE status IN (...)` sem índice, em uma tabela que **nunca é limpa**. 10 mil linhas × 2 × 1.440 execuções/dia ≈ 29 milhões de linhas lidas/dia. |
| Cron → `isolarConsultasAnteriores` | `UPDATE pendencias_operacionais ... datetime(criado_em) < ...` varre a tabela inteira a cada minuto. É uma migração de uso único, roda para sempre. |
| Cron → `migrarNotificacoesV7` | Outra migração de uso único que varre `notificacoes_equipe_v4` todo minuto. |
| `garantirEstadoConversaD1` | Executa `PRAGMA` + `INSERT ... SELECT ... FROM estado_conversas GROUP BY` (varredura) **em toda checagem de pausa**, várias vezes por mensagem. |
| `iaEstaPausada` | `JOIN mensagens × pessoas` com `datetime(m.criado_em)` → índice não é usado. |
| Contexto do cliente | Por mensagem, o histórico é lido ~5 vezes: `montarConversaIntegralD1` (6 meses inteiros), `buscarHistoricoD1` (200), e `carregarHistorico` é chamado de novo dentro de cada `adicionarAoHistorico`. |
| `GET /platform/conversations` | Para até 250 conversas chama `iaEstaPausada` (com as varreduras acima) **por conversa**. Um painel fazendo polling consome a cota sozinho. |

Conclusão: o problema imediato é **desenho de consultas + plano gratuito**, não o D1 em si.
Correção em duas camadas: (a) índices + remover migrações do cron + memoizar os `garantir*` (seção 6);
(b) Workers Paid (US$ 5/mês, limites de D1 muito maiores e acesso a Queues) já elimina o risco
de corte diário enquanto a arquitetura definitiva é construída.

---

## 4. Mapa de dependências (fluxo real hoje)

```
POST /webhook  (sem verificação de assinatura)
 └─ processarPayloadWebhook
     ├─ ecos humanos (smb_message_echoes) → registrarPausaHumanaV83 (10 min) → fila "ECO"
     └─ mensagens → enfileirarRecebimento → D1 fila_atendimento_v3
          └─ se D1 falhar → processarFailoverD1V291 (cérebro KV, inline)
 └─ waitUntil: espera 6,5 s → processarFilaAtendimento(telefone)   [sem Queue]
       (cron a cada minuto também chama processarFilaAtendimento)

processarFilaAtendimento
 ├─ lock por telefone (10 min) em locks_atendimento_v3
 ├─ regra "lote > 2 min = REVISAO_HUMANA"  ← descarte silencioso
 ├─ interpretarMidiaWhatsApp (áudio→transcrição, imagem→visão, vídeo→processador externo)
 └─ processarMensagemRecebida
      ├─ prestador da lista canônica com ponte KV → processarFailoverD1V291 (DB:null)
      ├─ forward explícito de mídia (v25/v24)
      ├─ ATENDENTE → ponte direta v15 / tarefas v12 / v11 / v10 / legado (5 camadas sobrepostas)
      ├─ TECNICO → ponte v13 → processarMensagemTecnico → pendências D1 (legado)
      └─ CLIENTE → registrarEntradaCliente (D1) → processarConversa
            ├─ atalhos: caso encerrado, saudação, irritação, "ok"
            ├─ contexto: carregarHistorico(D1+KV) + montarContextoClienteD1(6 meses) + estado_atendimento
            ├─ OpenAI (JSON) → protegerEncaminhamento → salvarDadosAtendimento
            ├─ força CONSULTAR_TECNICO por regex → executarAcaoCliente
            │     └─ v29.5: lista canônica → enviarConsultaPrestadorV291 → estado SÓ no KV
            │        (fluxo D1 com pendências/confirmação/markup/Telegram ficou inalcançável)
            ├─ impedirPerguntaRepetida (2ª chamada OpenAI) → aplicarGuardrailsCliente
            └─ prepararRespostaCliente (às vezes 3ª chamada OpenAI) → enviarRespostaIA
```

Pontos importantes do mapa:

- O fluxo antigo baseado em `pendencias_operacionais` (confirmação do cliente, +50%, aviso Telegram
  de agendamento, mudança do caso para AGENDADO) **ainda existe, mas não é mais alcançado** para
  novas consultas; ficou depois de um `return` ("preservado apenas como referência inacessível").
- No caminho KV, o aviso Telegram de agendamento chama `enviarTelegram(...)`, **função que não
  existe** (a que existe é `enviarAvisoTelegram`). O erro é engolido por `try/catch` → o Telegram
  de "SERVIÇO AGENDADO" nunca sai por esse caminho.
- Há cinco camadas de "ponte/ordens da equipe" (v10, v11, v12, v13, v15) sobrepostas, cada uma
  com tabela própria. É o sintoma direto do processo de "adicionar camada nova em vez de corrigir".

---

## 5. Causas raiz por sintoma

| Sintoma relatado | Causa no código |
|---|---|
| IA parou de responder | Regra de 2 min em `processarFilaAtendimento`; fast-lane no `waitUntil` sem Queue; lock de 10 min preso após encerramento; `montarConversaIntegralD1` pode disparar várias chamadas de resumo OpenAI na primeira mensagem de um cliente com histórico longo e estourar o tempo. |
| "Qual serviço você precisa?" em caso maduro | Atalho de saudação usa `perguntaInicialPendente(estado_atendimento)` sem checar caso ativo; guardrail de destinatário substitui a resposta por "Qual serviço você precisa realizar?"; `incompleta` → pergunta fixa; `casoEncerradoSemNovoPedidoV294` zera os dados estruturados. |
| Memória parece resetada | Orçamento/disponibilidade enviados pelo caminho KV não entram no histórico que o prompt usa; histórico D1 e KV mesclados sem ordenação por horário e com duplicatas (cada mensagem aparece duas vezes, com formatos de data diferentes). |
| Repete perguntas | Instruções contraditórias no prompt ("UMA frase com NO MÁXIMO SEIS PALAVRAS" em `regrasFixasSistema` × "sem limite artificial de seis palavras" em `regrasRespostaJSON`); o mesmo histórico enviado duas vezes (contexto D1 + "conversa recente"); dados estruturados por telefone, não por caso. |
| Ponte com prestador falhou | Estado só no KV (seção 1, item 1); ponte única por prestador; nenhuma deduplicação; confirmação do cliente nunca volta ao prestador; Telegram com função inexistente. |
| Pausa humana "não solta" ao devolver para a DENIA | `reativarIA` limpa só a tabela de pausa, mas `iaEstaPausada` também considera qualquer mensagem humana dos últimos 10 min; com D1 disponível o KV nunca é limpo. |
| Escala para humano sem necessidade | `mensagemDeIrritacaoOuConfusao` inclui "não entendi", contradizendo a regra de que dúvida curta não é motivo de escalonamento. |
| Cota D1 | Seção 3. |

---

## 6. Hotfix proposto — V29.8 (cirúrgico, sem reescrever nada)

Ordem de aplicação = ordem de prioridade. Cada item é independente; aplicar e testar um por vez.
**Não testados ainda** — ver seção 9.

### 6.1 [S1] Remover a rota pública de envio

Em `rotearRequest`, apagar o bloco inteiro:

```js
  if (
    caminho === "/api/teste-prestador-v292" &&
    metodo === "GET"
  ) {
    ... (até o fechamento deste if)
  }
```

### 6.2 [S2] Verificar a assinatura do webhook da Meta

Adicionar a função (em qualquer lugar do arquivo, ex.: antes de `handleWebhookPostFinal`):

```js
async function assinaturaMetaValidaV298(bytes, request, env) {
  const segredo = String(env?.META_APP_SECRET || "").trim();
  if (!segredo) {
    console.warn("V29.8: META_APP_SECRET ausente — assinatura do webhook NÃO verificada.");
    return true; // temporário: configurar o secret e depois trocar para false
  }
  const recebida = String(request.headers.get("X-Hub-Signature-256") || "")
    .replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recebida)) return false;
  const chave = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const assinatura = new Uint8Array(await crypto.subtle.sign("HMAC", chave, bytes));
  const esperada = Array.from(assinatura, b => b.toString(16).padStart(2, "0")).join("");
  return crypto.subtle.timingSafeEqual(
    new TextEncoder().encode(esperada), new TextEncoder().encode(recebida)
  );
}
```

E trocar o início de `handleWebhookPostFinal`:

```js
async function handleWebhookPostFinal(request, env, ctx = null) {
  let payload;
  try { payload = await request.json(); } catch { return new Response("JSON_INVALIDO", {status:400}); }
```

por:

```js
async function handleWebhookPostFinal(request, env, ctx = null) {
  const bytesWebhook = await request.arrayBuffer();
  if (!(await assinaturaMetaValidaV298(bytesWebhook, request, env))) {
    return new Response("ASSINATURA_INVALIDA", { status: 401 });
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(bytesWebhook)); }
  catch { return new Response("JSON_INVALIDO", { status: 400 }); }
```

Secret: `META_APP_SECRET` = "Chave secreta do app" no painel do app Meta (Configurações → Básico).

### 6.3 [S3] Senha nos painéis internos

Adicionar:

```js
function painelAutorizadoV298(request, env) {
  const senha = String(env?.PAINEL_SENHA || "");
  if (senha.length < 12) return false;
  const h = String(request.headers.get("Authorization") || "");
  if (!h.startsWith("Basic ")) return false;
  let decod = "";
  try { decod = atob(h.slice(6)); } catch { return false; }
  const recebida = decod.slice(decod.indexOf(":") + 1);
  const a = new TextEncoder().encode(recebida), b = new TextEncoder().encode(senha);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}
```

Em `rotearRequest`, logo depois do bloco "NORMALIZAR BARRA FINAL":

```js
  const rotasPainelV298 = ["/", "/chat", "/treinar", "/api/treinamento", "/api/limpar-teste", "/api/saude"];
  if (rotasPainelV298.includes(caminho) && !painelAutorizadoV298(request, env)) {
    return new Response("Autenticação necessária.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="DENIA", charset="UTF-8"' }
    });
  }
```

Criar o secret `PAINEL_SENHA` (≥ 12 caracteres) **antes** de publicar; sem ele os painéis ficam
bloqueados (falha fechada, de propósito). O navegador pede usuário/senha; o usuário pode ser qualquer um.

### 6.4 [S4] Parar a conversão automática de "Mirella"

- Em `identificarPessoa`, apagar a linha `pessoa = await garantirMirellaComoPrestadora(pessoa, env);`
- Em `buscarTecnicosPorDescricaoSolicitacao` e `buscarTecnicosCompativeis`, apagar as chamadas
  `await prepararMirellaParaServicosLimpeza(env);`
- Conferir no D1 se algum cliente chamado Mirella/Mirela foi convertido:
  `SELECT id, nome, telefone, tipo FROM pessoas WHERE lower(nome) LIKE 'mirel%';`
  O cadastro correto da prestadora é o telefone 5521978791765.

### 6.5 Não descartar mensagens em silêncio

Em `processarFilaAtendimento`, trocar `maisRecenteMensagem < Date.now()-(2*60*1000)` por
`maisRecenteMensagem < Date.now()-(15*60*1000)` e, logo depois do `UPDATE ... 'V29.5: lote antigo
bloqueado...'`, avisar a equipe:

```js
        await enfileirarTextoEquipe(
          `sem-resposta:${grupo.telefone}:${maisRecenteMensagem}`,
          `ATENÇÃO: mensagens de ${grupo.telefone} ficaram sem resposta automática (lote atrasado). Verificar a conversa.`,
          { tipo: "ALERTA_OPERACIONAL" }, env, grupo.telefone
        ).catch(() => {});
```

E em `enfileirarTextoEquipe` trocar `['AGENDAMENTO','MIDIA_PENDENTE']` por
`['AGENDAMENTO','MIDIA_PENDENTE','ALERTA_OPERACIONAL']` (vai para o Telegram).

**Configuração (mais importante que o patch):** ligar a Cloudflare Queue no Engine para tirar o
processamento do `waitUntil`. O código já suporta (`env.ATENDIMENTO_QUEUE` e o handler `queue`):

```jsonc
"queues": {
  "producers": [{ "binding": "ATENDIMENTO_QUEUE", "queue": "denia-atendimento" }],
  "consumers": [{ "queue": "denia-atendimento", "max_batch_size": 5, "max_batch_timeout": 2 }]
}
```

Com a fila, o agrupamento passa a ser os 20 s do `delaySeconds` já presente em
`agendarFilaAtendimento` — dentro dos 15–30 s pedidos no handoff.

### 6.6 Saudação não reinicia caso ativo

Em `processarConversa`, trocar:

```js
  if (/^(oi|ol[aá]|bom dia|boa tarde|boa noite)[!.\s]*$/i.test(mensagem)) {
```

por:

```js
  if (/^(oi|ol[aá]|bom dia|boa tarde|boa noite)[!.\s]*$/i.test(mensagem) &&
      !casoAtivoV294 && historico.length === 0) {
```

Com caso ativo ou histórico, a saudação segue para a IA com o contexto completo.

### 6.7 Guardrail de destinatário não pergunta o serviço

Em `aplicarGuardrailsCliente`, trocar `atual.resposta = "Qual serviço você precisa realizar?";`
por `atual.resposta = "Um momento, por favor.";`

### 6.8 Não reenviar consulta ao prestador

Em `processarConversa`, logo depois de:

```js
  if (
    tentouPrecoNaoAutorizado ||
    deveConsultarProfissional(mensagem, decisao, dadosAtualizados)
  ) {
    decisao.acao.tipo = "CONSULTAR_TECNICO";
  }
```

inserir:

```js
  // V29.8: não reenviar consulta enquanto já há uma em andamento (ou recém-agendada)
  // para este cliente na mesma categoria.
  if (decisao.acao.tipo === "CONSULTAR_TECNICO") {
    const ponteAtualV298 = await lerJsonKVV291(chaveV291Cliente(numero), env);
    const statusPonteV298 = String(ponteAtualV298?.status || "").toUpperCase();
    const recenteV298 = Date.now() - (Date.parse(String(ponteAtualV298?.atualizadoEm || "")) || 0)
      < 7 * 24 * 3600 * 1000;
    const areaAgoraV298 = classificarAreaEstritaV295(
      [mensagem, decisao.acao.servico, decisao.acao.problema].filter(Boolean).join(" | ")
    ).area;
    const mesmaAreaV298 = !areaAgoraV298 || areaAgoraV298 === ponteAtualV298?.profissionalArea;
    if (recenteV298 && mesmaAreaV298 &&
        ["AGUARDANDO_PROFISSIONAL", "AGUARDANDO_COMPOSICAO_VALOR",
         "AGUARDANDO_CONFIRMACAO_CLIENTE", "AGENDADO"].includes(statusPonteV298)) {
      decisao.acao.tipo = "ATUALIZAR_CASO";
      if (tentouPrecoNaoAutorizado) decisao.resposta = "Um momento, por favor.";
    }
  }
```

### 6.9 Não misturar clientes no mesmo prestador

Em `executarAcaoCliente`, no bloco `CONSULTAR_TECNICO`, logo antes de
`const envioCanonicoV295=await enviarConsultaPrestadorV291(`:

```js
      const ponteProfV298 = await lerJsonKVV291(chaveV291Prof(profissionalCanonicoV295.telefone), env);
      const ponteProfRecenteV298 = Date.now() -
        (Date.parse(String(ponteProfV298?.atualizadoEm || "")) || 0) < 48 * 3600 * 1000;
      if (ponteProfRecenteV298 && ponteProfV298?.clienteTelefone &&
          limparTelefone(ponteProfV298.clienteTelefone) !== limparTelefone(pessoa.telefone) &&
          !["AGENDADO", "RECUSADO"].includes(String(ponteProfV298.status || "").toUpperCase())) {
        return { executada:false, tipo:acao.tipo, caso,
          erro:"Prestador já tem outra consulta ativa; a ponte atual não suporta duas ao mesmo tempo." };
      }
```

Resultado: o cliente recebe "Um momento, por favor." e a equipe é alertada, em vez de o orçamento
ir para o cliente errado. A solução definitiva (ponte por caso, com `Caso #N`) está no roadmap.

### 6.10 Orçamento entra na memória do cliente + confirmação volta ao prestador

(a) Em `processarFailoverD1V291`, no ramo do prestador, logo depois de
`const envio=await enviarMensagemWhatsApp(bridge.clienteTelefone,msgCliente.slice(0,700),env);`:

```js
    if (envio?.sucesso === true) {
      await adicionarAoHistorico(bridge.clienteTelefone, "ia", msgCliente.slice(0,700), env);
    }
```

Fazer o mesmo depois do envio de `pergunta` no ramo `perguntaCliente`.

(b) No mesmo arquivo, no bloco de confirmação do cliente (onde aparece `estado.status="AGENDADO";`),
trocar `await salvarJsonKVV291(chaveV291Prof(estado.profissionalTelefone),estado,env);` por:

```js
      // V29.8: agendamento encerra a ponte; mensagens futuras do prestador não podem
      // gerar "Deseja confirmar?" para este cliente.
      try { await env.MEMORIA?.delete(chaveV291Prof(estado.profissionalTelefone)); } catch {}
      try { await env.MEMORIA?.delete(chaveConsultaPrestadorV296(estado.profissionalTelefone)); } catch {}
```

(c) Em `processarConversa`, logo depois do bloco `if (pausada) { ... }`:

```js
  // V29.8: se o cliente está respondendo a um orçamento enviado pela ponte KV,
  // a confirmação volta para essa ponte, não para um atendimento novo.
  const ponteClienteV298 = await lerJsonKVV291(chaveV291Cliente(numero), env);
  if (
    String(ponteClienteV298?.status || "").toUpperCase() === "AGUARDANDO_CONFIRMACAO_CLIENTE" &&
    ponteClienteV298?.profissionalTelefone &&
    mensagem.length <= 80 && !/[?\d]/.test(mensagem) &&
    /\b(sim|pode ser|confirmo|confirmado|fechado|combinado|aceito|serve|perfeito)\b/
      .test(normalizarTexto(mensagem))
  ) {
    const r = await processarFailoverD1V291({ de: numero, texto: mensagem }, { ...env, DB: null });
    if (r?.agendado === true) {
      await adicionarAoHistorico(numero, "ia", "Serviço confirmado.", env);
      if (ponteClienteV298.casoId && env?.DB) {
        try {
          await env.DB.prepare(`UPDATE casos SET status='AGENDADO', atualizado_em=CURRENT_TIMESTAMP
            WHERE empresa_id=? AND id=?`).bind(EMPRESA_ID, ponteClienteV298.casoId).run();
        } catch (e) { console.error("V29.8: falha marcando caso AGENDADO:", e); }
      }
    }
    return { resposta: "", chamarHumano: false, pausarIA: false, pessoaId: pessoa.id };
  }
```

`processarFailoverD1V291` já envia as mensagens ao cliente e ao prestador por conta própria,
por isso a resposta aqui é vazia (evita envio duplicado).

### 6.11 Telegram de agendamento (função inexistente)

Adicionar:

```js
async function enviarTelegram(texto, env) {
  const r = await enviarAvisoTelegram({ texto: String(texto || "") }, env);
  if (!r?.sucesso) throw new Error(r?.erro || "Telegram não confirmou o envio.");
  return r;
}
```

### 6.12 Reduzir leituras do D1

1. Em `executarRotinasAgente`, remover (já cumpriram a função):
   `await executarEtapaAgente("isolamento",...)` e `await executarEtapaAgente("migracao_canais",...)`.
2. Memoizar `garantirEstadoConversaD1`: antes da função `let estadoConversaGarantidoV298 = false;`;
   na primeira linha útil `if (estadoConversaGarantidoV298) return;`; no fim
   `estadoConversaGarantidoV298 = true;`.
3. Rodar uma vez no console do D1:

```sql
CREATE INDEX IF NOT EXISTS idx_v298_msg_pessoa   ON mensagens(empresa_id, pessoa_id, id);
CREATE INDEX IF NOT EXISTS idx_v298_msg_wamid    ON mensagens(empresa_id, whatsapp_message_id);
CREATE INDEX IF NOT EXISTS idx_v298_msg_origem   ON mensagens(empresa_id, origem, criado_em);
CREATE INDEX IF NOT EXISTS idx_v298_pessoas_tel  ON pessoas(empresa_id, telefone);
CREATE INDEX IF NOT EXISTS idx_v298_fila_status  ON fila_atendimento_v3(empresa_id, status, telefone, recebido_ms);
CREATE INDEX IF NOT EXISTS idx_v298_pend_tec     ON pendencias_operacionais(empresa_id, tecnico_id, status);
CREATE INDEX IF NOT EXISTS idx_v298_pend_pessoa  ON pendencias_operacionais(empresa_id, pessoa_id, tipo, status);
CREATE INDEX IF NOT EXISTS idx_v298_casos_cli    ON casos(empresa_id, cliente_id, id);
CREATE INDEX IF NOT EXISTS idx_v298_eventos_tipo ON eventos(empresa_id, tipo, criado_em);
-- limpeza da fila (não apaga histórico de mensagens):
DELETE FROM fila_atendimento_v3
 WHERE status IN ('CONCLUIDO','REVISAO_HUMANA','ERRO')
   AND atualizado_ms < (strftime('%s','now') - 7*86400) * 1000;
```

4. Atualizar a string de versão em `obterDiagnosticoOperacional` para `...-v29.8-...`.

### Rollback

Antes de publicar, salvar a v29.7 em `engine/v29.7/worker.js`. Na Cloudflare: Workers →
(worker do Engine) → Deployments → selecionar a versão anterior → Rollback. Índices SQL são
aditivos e não precisam de rollback. Os patches 6.2 e 6.3 dependem de secrets; se algo
falhar, remover `PAINEL_SENHA`/`META_APP_SECRET` **não** reabre o painel (6.3 falha fechada) —
para isso, fazer rollback da versão.

---

## 7. O que preservar exatamente

- Identidade por telefone no D1 e a regra de que a IA nunca muda o papel de alguém.
- Recebimento durável: grava a mensagem antes de processar, `UNIQUE(mensagem_id)`, HTTP 503
  para a Meta reenviar quando a gravação falha.
- Pausa de 10 min por conversa a partir do eco humano (`smb_message_echoes`), com transcrição do
  áudio do atendente entrando no histórico.
- Mídia: download pela Graph API, transcrição de áudio, visão em imagem, vídeo só com processador
  configurado (não finge entender), encaminhamento do `media_id` real com novo upload e mensagem
  explícita de janela de 24 h (v27/v24/v25).
- "Só afirma sucesso com `messageId`": o padrão já aparece em vários pontos e deve virar regra única.
- Ocultação do telefone do cliente para o prestador; regra de +50% só quando o prestador diz que o
  valor é "só a parte dele", perguntando quando não está claro.
- Relatório diário por e-mail com auditoria qualitativa; Telegram para agendamento.
- API privada `/platform/*` (V28).

## 8. O que refatorar / tirar do Worker

| Hoje | Alvo |
|---|---|
| Dois cérebros (D1 pendências × KV ponte) | Um único modelo de caso com máquina de estados durável (tabela `cases` + `case_events`), KV só como cache/lock. |
| Ponte por prestador | Ponte por **caso** (`professional_requests` com `case_id`), mensagem ao prestador sempre com `Caso #N`. |
| Cinco camadas de ordens da equipe (v10–v15) | Um único executor de comandos da equipe. As outras saem depois de testes cobrirem os casos. |
| Atalhos regex que geram respostas fixas | Regras determinísticas só para *bloquear* (preço, telefone, promessa sem ação); a resposta vem da IA com o contexto. |
| Histórico mesclado D1+KV sem ordem | Uma função `montarContexto(caso)` com camadas: fatos estruturados do caso → resumo persistido → últimas N mensagens ordenadas por horário. |
| Prompt com regras contraditórias | Um prompt revisado, versionado e testado; treinamento da empresa separado das regras do sistema. |
| Migrações rodando no cron | Migrações versionadas (`migrations/0001_*.sql`) aplicadas uma vez com `wrangler d1 migrations apply`. |
| Arquivo único de ~11 mil linhas | Módulos: `webhook/`, `identidade/`, `memoria/`, `casos/`, `prestadores/`, `midia/`, `whatsapp/`, `notificacoes/`, `platform-api/`, `paineis/`. Feito **por extração**, sem mudar comportamento, um módulo por vez com teste. |
| Relatórios, auditoria diária, sync da Platform no cron do Engine | Worker separado (ou Queue própria). O Worker de atendimento só atende. |

---

## 9. Testes — como impedir regressões

Sem testes, qualquer patch pode quebrar outra coisa (foi o que aconteceu entre V27 e V29).
Plano:

1. **Harness local:** Vitest + `@cloudflare/vitest-pool-workers` (D1/KV reais em memória) e mocks
   de `fetch` para Meta, OpenAI e Telegram. O mock da OpenAI devolve respostas fixas por cenário —
   testamos a *orquestração*, não o humor do modelo.
2. **Cenários do handoff (seção 60) como testes automatizados**, mais os bugs desta auditoria:

| Teste | Verifica |
|---|---|
| T1 normal | "Preciso de um chaveiro" → "Botafogo" não volta a perguntar serviço. |
| T2 agrupamento | 3 mensagens em < 20 s → 1 chamada OpenAI, 1 resposta. |
| T3 memória | serviço+bairro no histórico → resposta não pergunta nenhum dos dois. |
| T4 pausa | eco humano → 10 min sem envio para aquele número; outro número segue normal; após 10 min volta. |
| T5 áudio humano | eco de áudio → transcrição gravada com `origem=HUMANO` e presente no contexto. |
| T6 caso maduro | caso AGENDADO + "Bom dia" / "Tem como chegar meia hora mais tarde?" → nunca "qual serviço". |
| T7 prestador | consulta → resposta com valor e horário → cliente recebe valor correto (com/sem +50%) → "sim" → prestador recebe confirmação → caso AGENDADO → Telegram. |
| T8 nomes duplicados | "ar-condicionado" → Carlos 5511992197178; "estofador" → Carlos 5521983838318; chaveiro → Anderson 5521964545279. |
| T9 D1 fora | D1 lançando erro de cota → cliente recebe resposta pelo caminho KV. |
| T10 mídia | imagem + "manda para +55…" → envio do `media_id` real; sem ordem → só interpretação. |
| T11 template | Meta recusa texto livre (131047) → template configurado é usado; sem template → não afirma envio. |
| T12 veracidade | Meta/Telegram com erro → nenhuma mensagem diz "enviado"/"confirmado". |
| R1 regressões desta auditoria | 2º cliente para o mesmo prestador não sobrescreve o 1º; "orçamento?" repetido não reenvia consulta; cliente "Mirella" continua CLIENTE; `/api/teste-prestador-v292` não existe; webhook sem assinatura válida → 401. |

3. **Regra de merge:** nenhuma mudança vai para `main` sem a suíte passando. Cada versão publicada
   ganha tag (`engine-v29.7-producao`, `engine-v29.8`, ...).

---

## 10. Banco de dados — recomendação

**Curto prazo (agora):** continuar no D1, com os índices e a limpeza da seção 6.12, e mudar a conta
para **Workers Paid**. Trocar de banco no meio da crise acrescenta risco sem atacar a causa
(consultas que varrem tabelas). Medir no painel do D1 (Insights → consultas por linhas lidas) antes
e depois.

**Médio prazo (SaaS multi-empresa): Postgres gerenciado (Supabase) acessado pelo Worker via
Hyperdrive**, com:

- `organization_id` em todas as tabelas + Row Level Security como segunda barreira de isolamento;
- transações reais para a máquina de estados do caso;
- backups/point-in-time recovery;
- o mesmo banco servindo Engine e Platform (auth da Platform pode ser Supabase Auth ou Clerk).

KV fica para cache, locks curtos e o modo de contingência. Queue para mídia, relatórios, sync e
reenvios. Migração D1 → Postgres com exportação, contagens/checksums por tabela e um período de
escrita dupla (seção 70 do handoff) — só depois do Engine estar em módulos com testes.

## 11. Modelo de dados alvo (resumo)

`organizations`, `users`, `organization_users(role)`, `contacts(organization_id, phone_e164, type)`,
`conversations(channel, contact_id, ai_paused_until)`, `messages(conversation_id, case_id,
external_message_id UNIQUE, direction, sender_type CUSTOMER|AI|HUMAN_AGENT|PROFESSIONAL|SYSTEM,
content_type, text, media_id, transcription, interpretation, created_at)`, `cases(status, service_id,
facts_json, summary, version)`, `case_events`, `services`, `professionals`, `professional_services`,
`professional_requests(case_id, professional_id, status, outbound_message_id)`, `quotes(case_id,
professional_amount, customer_amount, includes_central_fee, markup_rule)`, `appointments`,
`training_versions(organization_id, version, content_json, created_by)`, `media`, `integrations`,
`approval_items`, `audit_logs`, `outbound_messages(idempotency_key UNIQUE, provider_response)`.

Treinamento sempre por versão: GET versão atual → edição parcial → servidor faz merge → nova
versão; restauração = criar nova versão com o conteúdo antigo.

## 12. Segurança e multi-tenant (resumo)

- Segredos só no servidor; navegador → backend da Platform → API privada do Engine com token
  de serviço (já iniciado na V28) e `organization_id` explícito em todo pedido.
- Permissões verificadas no servidor (papéis do handoff: SUPER_ADMIN, OWNER, ADMIN, AGENT,
  MARKETING, FINANCE, VIEWER).
- Assinatura do webhook, idempotência de entrada e de saída, log de auditoria de cada ação externa
  com a resposta do provedor.
- Um Engine para todas as empresas: hoje há `EMPRESA_ID = 1`, `WHATSAPP_PHONE_NUMBER_ID` e a lista
  de prestadores fixos no código; tudo isso passa a ser lido de `integrations`/`professionals` por
  organização (+50% vira configuração da organização).

## 13. APIs que exigem OAuth / aprovação

| Integração | Exige |
|---|---|
| WhatsApp Cloud API (Coexistence) | App Meta, número verificado, **templates aprovados** para iniciar conversa fora da janela de 24 h (hoje `templatePrestadorConfigurado: false`). |
| Instagram / Facebook / Messenger | App Meta com permissões avançadas e **App Review**; login OAuth por empresa. |
| Google Business Profile | Acesso à API concedido pelo Google (formulário de solicitação) + OAuth por conta. Posts, avaliações e métricas são APIs diferentes. |
| Google Calendar | OAuth (refresh token por organização) ou conta de serviço com agenda compartilhada. |
| Telegram | Só token do bot (sem revisão). |
| Billing | Provedor com tokenização (ex.: Stripe, Pagar.me, Mercado Pago). |

---

## 14. Roadmap

| Fase | Entrega | Critério para avançar |
|---|---|---|
| **0 — Baseline** (esta semana) | V27 e v29.7 no Git; wrangler do Engine no Git; tag `engine-v29.7-producao`. | Arquivos versionados. |
| **1 — Estancar** | V29.8 = seção 6 (segurança, descarte silencioso, atalhos, deduplicação, ponte, Telegram, índices) + Queue + Workers Paid. | Testes T1–T12 e R1 passando; 48 h sem `REVISAO_HUMANA` inesperada e com leituras do D1 estáveis. |
| **2 — V27 × atual** | Diff comportamental V27 → v29.8 dos módulos mensagem/mídia/memória; portar o que a V27 fazia melhor, item a item. | Cada item com teste. |
| **3 — Um cérebro só** | Máquina de estados do caso no D1; ponte por caso; KV só cache/contingência; contexto em camadas. Remover camadas v10–v13. | Cenário T7 completo sem caminho KV. |
| **4 — Modularizar** | Extrair módulos do arquivo único sem mudar comportamento; migrações versionadas. | Suíte verde a cada extração. |
| **5 — Platform ligada** | App da Platform real no repositório (o atual não tem código); login; Conversas/assumir/devolver via `/platform/*`; treinamento versionado. | Assumir/devolver testado ponta a ponta. |
| **6 — Postgres + multi-tenant** | Supabase/Hyperdrive, `organization_id`, RLS, migração com verificação. | Contagens/checksums batendo; período de escrita dupla. |
| **7+** | Calendar → Google Business (avaliações, posts com aprovação) → Instagram/Facebook/Messenger → billing → app. | Cada integração só "publicada" com confirmação da API. |

## 15. O que preciso de você

1. Subir `engine/v27/worker.js`, `engine/v29.7/worker.js` e o arquivo wrangler do Engine.
2. Confirmar se posso aplicar a V29.8 (seção 6) sobre a v29.7 já com a suíte de testes, ou se
   prefere que eu parta da V27 e porte item por item.
3. Confirmar se a Platform tem código em outro lugar (aqui só há configuração).
