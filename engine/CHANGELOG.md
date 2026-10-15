# Changelog — DENIA Engine

## 31.7.0 — 2026-10-15

### Novo
- `/platform/metrics?de&ate`: métricas do atendimento — contatos (novos e recorrentes), mensagens,
  tempo de resposta (mediana e 90%) da DENIA e da equipe, parte respondida pela DENIA, conversas sem
  resposta, mapa de horários (dia × hora, Brasília), atendimentos por etapa e serviço, funil
  (aberto → profissional → agendado → concluído), profissionais (consultas, respostas, confirmações,
  tempo de resposta, valor) e entregas.
- Resumo de entregas sabe quando o problema já foi resolvido (`falhas_pendentes`, `ultima_entrega_ms`):
  falhas antigas seguidas de entregas confirmadas não geram mais aviso.

## 31.6.0 — 2026-10-15

### Corrigido — a DENIA não sabia o que a equipe combinou por fora
- Mensagem da equipe pelo celular (ex.: "Serviço agendado… data… valor") agora é ligada ao
  atendimento certo e a IA relê o caso e atualiza a etapa (AGENDADO etc.) e a consulta ao profissional.
- Antes de responder um profissional, se a equipe mexeu no caso depois da consulta, a DENIA relê tudo e
  atualiza o caso primeiro — não pergunta mais "consegue pegar? qual o valor?" de algo já agendado.
- Serviço já agendado: a DENIA responde o profissional como alguém da equipe (curto, com os dados certos);
  só chama a equipe se ele quer remarcar, cancelar ou relata problema. "Ok"/"combinado" não geram resposta.

### Novo — estudo diário e pesquisa semanal
- Toda noite (depois das 21h) relê as conversas do dia, dá uma nota, lista os próprios erros e escreve
  lições que passam a valer no atendimento seguinte (campo `licoes_diarias` do treinamento, versionado,
  até 30 lições). Conhecimento novo (preço, serviço, regra) vai para Aprendizados e só vale aprovado.
- Uma vez por semana pesquisa na internet boas práticas de atendimento com empatia e transforma em lições.
- `/platform/study` (relatórios e lições) e `/platform/study/run` (estudar agora).
- Respostas mais curtas e humanas: 1 a 2 frases, no máximo 1 pergunta, no jeito da equipe.

## 31.5.0 — 2026-10-15

### Novo — memória completa do cliente
- Antes de responder, a DENIA lê o DOSSIÊ do contato: um resumo de TODA a relação desde o primeiro
  contato (meses atrás) — nome, endereços, serviços anteriores, profissional, valores, pendências,
  reclamações, comportamento — além das últimas 60 mensagens. Cliente antigo nunca é tratado como novo.
- O dossiê é gerado quando a pessoa tem mais mensagens do que cabem no histórico e é atualizado a
  cada ~80 mensagens novas (tabela `d30_dossie`). No plano gratuito ele é preparado em segundo plano
  (tick a cada 5 min / cron); enquanto não existe, a IA recebe as primeiras mensagens da relação.

### Corrigido — profissional com mais de um atendimento
- Quando o profissional responde a uma mensagem (inclusive as que a equipe manda pelo celular, como
  "Serviço agendado: nome, endereço, bairro…"), a DENIA descobre o atendimento pelo contexto: a
  mensagem citada, o nome do cliente, o bairro, o endereço e o serviço. Confirmações simples
  ("ok", "combinado") não geram pergunta. Se ainda houver dúvida, pergunta como gente: "é sobre o
  atendimento de Maria em Botafogo ou de João na Tijuca?" — nunca pede número de caso.
- Número de caso é interno: não aparece mais em nenhuma mensagem para profissionais ou clientes
  (vira "o atendimento de Maria (Botafogo)").

## 31.4.0 — 2026-10-15

### Corrigido (mensagens em massa quando o cron era ligado)
- A DENIA respondia sozinha mensagens de até 12 h atrás (com pedido de desculpas). Com o cron
  desligado por horas, ligar o cron fazia ela escrever para dezenas de clientes de uma vez —
  inclusive quem a equipe já tinha atendido. Agora:
  - só responde sozinha o que tem até 30 min (`ATRASO_MAXIMO_MIN` muda isso);
  - nunca responde se alguém da equipe já escreveu para a pessoa depois da mensagem;
  - no máximo 3 respostas atrasadas por execução; o resto só é registrado e a equipe recebe UM aviso;
  - a fila de envio descarta respostas com mais de 15 min (aparecem como não enviadas no painel);
  - mensagens programadas para profissionais não saem se a equipe já cuidou do caso.
- Novo `/platform/tick`: a plataforma chama a cada 5 min para enviar a fila e responder o que é
  recente, então o cron do motor pode ficar desligado.

## 31.3.0 — 2026-10-15

### Corrigido (respostas que não saíam: "Too many subrequests")
- No plano gratuito da Cloudflare cada execução pode fazer só 50 chamadas externas, e cada consulta
  ao banco conta. As versões novas faziam 35–90 por mensagem e o envio ao WhatsApp, no fim, era
  recusado. Agora cada execução conta as próprias chamadas: perto do limite, a resposta vai para a
  fila de envio (`d30_saida_fila`) e o cron envia no minuto seguinte — nada se perde. Se nem o
  banco estiver disponível, a fila usa o KV.
- Menos chamadas por mensagem: criação do esquema numa chamada só, travas de envio numa consulta
  (eram 4), pessoa e pausa lidas uma vez por execução, registro do envio em lote, contabilidade
  da IA e Telegram cedem a vez quando falta orçamento.
- Mensagens que estouram o limite voltam para a fila do cron (antes viravam erro e tentavam de
  novo na mesma execução, gastando o dobro).
- O cron envia primeiro a fila e só faz as tarefas pesadas (aprendizado, relatório, revisão de
  casos) se sobrar orçamento.
- O esquema não era atualizado em bancos existentes (versão do esquema parada em 30.3): as tabelas
  das versões 31.x agora são criadas.
- No plano pago, defina `LIMITE_CHAMADAS=900`.

## 31.2.0 — 2026-10-15

### Corrigido (WhatsApp "respondendo" sem chegar)
- A Meta aceitar a mensagem não quer dizer que ela foi entregue. O motor agora lê as confirmações
  de entrega do webhook (enviada → entregue → lida, ou falhou com o motivo) e guarda cada uma
  (tabela `d30_entregas`).
- Falha de entrega: o motivo em português (pagamento, número sem WhatsApp, 24 h, token, número
  bloqueado…), aviso à equipe no Telegram e evento no caso. Falhas passageiras da Meta são
  reenviadas uma vez sozinhas.
- Bloqueio da conta (pagamento, token, número): alerta crítico e `entrega_bloqueada` no
  `/platform/status`; some sozinho na próxima entrega confirmada.
- Vigia: mensagens aceitas sem nenhuma confirmação por horas geram aviso (webhook sem o campo
  "messages").
- Diagnóstico completo do número (status, plataforma, modo de teste, qualidade, nome) e, com
  `WHATSAPP_WABA_ID`, da conta (pagamento, saúde de envio).
- `/platform/conversations/:id` devolve a entrega de cada mensagem; `/platform/usage` traz
  mensagens por dia (IA e equipe, do histórico permanente), contatos, atendimentos abertos e
  concluídos e entregas.

## 31.1.0 — 2026-10-14

### Novo
- Consumo e custos: cada chamada à OpenAI (respostas do atendimento e transcrição de áudios)
  é somada por dia e modelo (tabela `d30_uso`).
- `/platform/usage?de&ate`: consumo da IA, mensagens recebidas e enviadas por dia e, com a
  variável opcional `WHATSAPP_WABA_ID`, o custo do WhatsApp cobrado pela Meta (pricing_analytics,
  por categoria: marketing, utilidade, serviço, autenticação). O painel mostra em Consumo e custos.

## 31.0.0 — 2026-10-14

### Novo
- Revisão da etapa pela IA: a DENIA lê tudo o que aconteceu no caso (cliente, profissional,
  mensagens da equipe, resumos de ligação e eventos) e descobre a etapa real — agendado, em
  andamento, concluído, cancelado… Com confiança ALTA move o caso sozinha; senão, deixa a
  sugestão. Roda sozinha a cada 30 min nos casos parados há mais de 6 h
  (`/platform/cases/:id/review` para revisar sob demanda).
- Nova etapa EM_ANDAMENTO (serviço sendo feito).
- `/platform/cases` devolve até 1.000 casos, com a última revisão da IA de cada um.

## 30.9.0 — 2026-10-14

### Novo
- Diagnóstico completo em `/platform/status` (o painel mostra em WhatsApp → Diagnóstico):
  última mensagem recebida, erros e falhas de entrega das últimas 24 h, respostas enviadas,
  webhooks recusados por assinatura (META_APP_SECRET diferente do app) e, com `?completo=1`,
  teste real do token do WhatsApp e da chave da OpenAI.

## 30.8.0 — 2026-10-14

### Novo
- Triagem de avaliações do Google (pela DENIA Platform): `/platform/clients/match` diz se quem
  avaliou está na base de clientes (contatos do WhatsApp e cadastro importado) — só sim, não ou
  talvez, sem devolver telefone nem outros dados.

## 30.7.0 — 2026-10-13

### Novo
- Resumo de ligação: a equipe registra pelo painel (Conversas → "Registrar ligação") o que foi
  combinado por telefone com cliente ou profissional; entra no histórico como informação
  confirmada e a DENIA passa a considerar (endpoint `/platform/conversations/:id/note`).
- Mensagens aos profissionais escritas como uma pessoa da equipe no WhatsApp (saudação pelo
  horário, nome, frase corrida), sem cara de formulário. O número do caso continua no fim.
- Atendimento ao cliente: "a arte de atender" — escuta, espelhar o tom do cliente, variar as
  frases, uma coisa por vez, cliente irritado, venda natural; só afirma o que tem certeza
  (na dúvida, confirma e chama a equipe); não fala de assuntos fora do atendimento; não se
  apresenta como robô, mas não nega ser assistente virtual se perguntarem com sinceridade.

### Corrigido
- Nenhuma conversa sem resposta: mensagens que chegam atrasadas (até 12 h) agora são
  respondidas com um pedido de desculpas pela demora (antes, com mais de 15 min, ficavam sem
  resposta); se alguém da equipe já respondeu depois, a DENIA não repete.
- Falha passageira (rede, banco, IA) ao processar: a DENIA tenta mais uma vez antes de
  desistir e avisar a equipe.

## 30.4.0 — 2026-10-08

### Novo
- Ponte contínua cliente ↔ profissional: depois do orçamento (ou já agendado), cada dúvida do
  cliente que só o profissional sabe responder (material, garantia, prazo, detalhes) vai ao
  profissional com o número do caso; a resposta dele volta ao cliente. Repete quantas vezes
  for preciso, até não haver mais dúvidas.

### Corrigido
- Uma resposta só, não importa quantas mensagens o cliente mande: a DENIA espera ele parar de
  escrever (15 s) e, se chegar mensagem nova enquanto ela pensa, descarta a resposta em
  preparo e responde tudo junto (espera máxima de 3 minutos).

## 30.3.0 — 2026-10-08

### Novo
- Aprendizado com o histórico (últimos 6 meses): a DENIA lê as conversas antigas aos poucos
  (um lote por minuto, no cron, para caber no plano gratuito), com telefones mascarados, e
  gera **sugestões**: respostas padrão, preços praticados, quem atende o quê, regras, frases
  típicas das atendentes e informações da empresa. Nada entra no treinamento sem aprovação.
  Aprovadas vão para o novo campo **APRENDIZADOS** (ou para EXEMPLOS, no caso de estilo).
- Importação do cadastro de clientes exportado do sistema das atendentes (planilha/CSV), até
  500 linhas por envio. A ficha importada entra no contexto da conversa como dado oficial.
- API para a DENIA Platform (token `DENIA_PLATFORM_SERVICE_TOKEN`): `/platform/learning`,
  `/platform/learning/start`, `/platform/learning/suggestions`, `/platform/import/clients` e
  `/platform/pause` (pausa geral pelo painel).
  Com isso, o treinamento passa a ser feito pela plataforma.

## 30.2.1 — 2026-10-08

- Senha do painel passa a ser opcional: sem o secret PAINEL_SENHA, `/chat`, `/treinar` e
  `/api/saude` abrem direto, como na versão antiga.

## 30.2.0 — 2026-10-08

### Corrigido
- Eletrodoméstico/aparelho com defeito (inclusive queimado ao ligar em 110/220 V) nunca vai
  para o eletricista. Ar, geladeira e lava e seca vão para a assistência técnica; outros
  aparelhos (micro-ondas, air fryer, TV…) vão para a equipe decidir.
- A categoria passa a ser decidida pela IA seguindo o TREINAMENTO; o código só confirma ou barra.
  Se a IA não tiver certeza (confiança ALTA) ou discordar das regras, nenhum prestador é
  consultado e a equipe é avisada.
- Cliente antigo: o contexto inclui "cliente desde", atendimentos anteriores (com valores) e as
  últimas 60 mensagens. A DENIA não trata cliente antigo como novo.
- Valor: se o prestador mandar mais de um valor ("400 ou 500"), a DENIA pergunta o total antes
  de passar ao cliente; se continuar ambíguo, nada vai ao cliente e a equipe é avisada.
- A consulta ao prestador inclui as palavras do próprio cliente, para não haver distorção.
- Painel: login por página com senha (PAINEL_SENHA, mínimo 8 caracteres) e sessão de 30 dias,
  no lugar da janela de usuário/senha do navegador.

### Novo
- A DENIA imita o jeito das atendentes: usa como exemplo as mensagens reais que a equipe envia pelo app.
- Integração com a plataforma de cadastro: envio de clientes e atendimentos para
  PLATAFORMA_API_URL (mesmo contrato da versão anterior) e leitura da ficha do cliente em
  CRM_CONSULTA_URL.

## 30.1.0 — 2026-10-07

### Corrigido (problemas relatados em produção)
- Rajadas de mensagens: trava de segurança em todo envio real — no máximo 4 mensagens em
  2 min, 10 em 10 min e 25 por hora para o mesmo contato, e 150 em 10 min no total. Ao
  atingir o limite, os envios param e a equipe recebe UM aviso.
- Contingência (D1 fora do ar) reescrita: agrupa mensagens seguidas; no máximo 1 resposta a
  cada 2 min por contato; nunca responde prestadores nem a equipe (lista do D1 guardada no KV
  e variável EQUIPE_TELEFONES); não responde mensagens atrasadas; não repete a última frase.
- Telegram: aviso de contingência no máximo 1 vez por hora (antes era 1 por mensagem); teto de
  12 alertas por hora no total.
- Bairro perguntado várias vezes: a DENIA não pergunta bairro por iniciativa própria e nunca
  repete uma pergunta (bairro, endereço, serviço, nome, modelo, foto, horário) já feita na
  conversa; resposta curta logo após uma pergunta é registrada como o dado perguntado.

### Novo
- Botão "PAUSAR DENIA" no painel /chat e variável DENIA_PAUSADA=true: param todos os envios
  automáticos reais.

## 30.0.0 — 2026-10-07

Substitui o Worker v29.x por um motor reescrito em torno de uma máquina de estados durável.
Compatível com as tabelas existentes do D1 (histórico preservado).

### Corrigido
- Perda de contexto e reabertura de casos: estado do caso (`d30_casos`) com etapas e fatos;
  importação automática de casos antigos; caso AGENDADO nunca volta para coleta.
- Perguntas repetidas: guarda determinística bloqueia perguntar de novo serviço, bairro,
  endereço e nome registrados; "ok/obrigado" sem pergunta pendente não geram resposta.
- Promessas sem ação: "enviamos/consultamos/agendado/confirmado/cancelado" só depois de a ação
  ter acontecido (message id da Meta).
- Envios sem mensagem nova: nada é enviado por cron, exceto consultas aceitas à noite e
  enviadas às 8h (até 16 h depois); mensagens atrasadas mais de 15 min não são respondidas.
- Prestador tratado como cliente: lista oficial por telefone (inclusive wa_id sem o nono dígito)
  tem precedência; técnicos do D1 também nunca entram no fluxo de cliente.
- Prestador errado / nomes duplicados: roteamento por telefone + área, palavras-chave
  determinísticas antes da sugestão da IA.
- Mistura de casos: consulta por caso (`d30_consultas`) com "Caso #N"; vínculo pela mensagem
  citada (context.id); pergunta qual caso quando houver mais de um.
- Valor inventado / markup: valor só conta se o prestador escreveu o número; pergunta se é
  final ou só a parte dele; acréscimo configurável (`MARKUP_PERCENT`).
- Confirmação indevida: AGENDADO só com confirmação do prestador depois do aceite do cliente.
- Cancelamento: nunca automático; vira alerta para a equipe.
- Cobertura de região, bairro como requisito de orçamento, bairro em serviço de balcão, CPF e
  telefones: frases bloqueadas antes do envio.
- Cota do D1: consultas indexadas, sem varreduras no cron, sem migrações repetidas; KV grava
  só quando a etapa muda.
- Treinamento: versionado, edição parcial, restauração, nunca esvazia campo sem confirmação.
- Segurança: painéis com senha (`PAINEL_SENHA`), verificação da assinatura da Meta
  (`META_APP_SECRET`), rota pública de envio removida, conversão automática de "Mirella" removida.

### Removido
- Comandos da equipe por WhatsApp (camadas v10–v15).
- Ponte KV por prestador (v29.1–v29.6) e fluxo de pendências legado.

### Rollback
Cloudflare → Worker → Deployments → versão anterior → Rollback. As tabelas `d30_` não interferem na v29.
