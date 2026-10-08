# Changelog — DENIA Engine

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
