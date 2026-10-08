// ============================================================================
// DENIA ENGINE V30 — Central de Atendimento
// ============================================================================
//
// Substitui integralmente o Worker anterior (v29.x). Reaproveita as tabelas
// existentes no D1 (pessoas, mensagens, casos, atendentes, tecnicos,
// treinamento_ia), portanto o histórico de conversas é preservado.
//
// PRINCÍPIO CENTRAL
//   A IA (OpenAI) apenas INTERPRETA mensagens e REDIGE respostas.
//   Quem DECIDE e EXECUTA ações (consultar prestador, enviar orçamento,
//   agendar) é este código, com uma máquina de estados gravada no D1, e só
//   depois de a Meta confirmar o envio (message id).
//
// ETAPAS DO CASO
//   COLETANDO -> AGUARDANDO_PRESTADOR -> AGUARDANDO_CLIENTE
//   -> (AGUARDANDO_ENDERECO) -> AGUARDANDO_CONFIRMACAO_PRESTADOR -> AGENDADO
//   CONCLUIDO / CANCELADO são definidos pela equipe (API da Platform).
//   EQUIPE = caso que depende da equipe interna (sem prestador, balcão etc.).
//
// BINDINGS (os mesmos da versão anterior)
//   DB       -> D1
//   MEMORIA  -> KV (só contingência; quase não escreve, para caber no plano grátis)
//
// SECRETS / VARIÁVEIS
//   Obrigatórios: OPENAI_API_KEY, WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN, PAINEL_SENHA
//   Recomendados: META_APP_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   Opcionais:   OPENAI_MODEL, OPENAI_TRANSCRIPTION_MODEL, WHATSAPP_PHONE_NUMBER_ID,
//                WHATSAPP_TEMPLATE_CONSULTA_TECNICO, WHATSAPP_TEMPLATE_IDIOMA,
//                MARKUP_PERCENT, JANELA_AGRUPAMENTO_MS, VIDEO_PROCESSOR_URL,
//                VIDEO_PROCESSOR_TOKEN, RELATORIO_GMAIL_URL, RELATORIO_GMAIL_SEGREDO,
//                RELATORIO_EMAIL_TO, DENIA_PLATFORM_SERVICE_TOKEN
//
// CRON: "* * * * *" (a cada minuto) — recuperação da fila, envios das 8h,
//       relatório diário. Nunca inicia conversa nova por conta própria.
// ============================================================================

const VERSAO = "30.5.0";
const SCHEMA_VERSAO = "30.3.0-a";
const EMPRESA_ID = 1;
const PHONE_ID_PADRAO = "473474732510163";
const GRAPH = "v25.0";
const MODELO_PADRAO = "gpt-5.6-luna";
const TZ = "America/Sao_Paulo";

const PAUSA_HUMANA_MS = 10 * 60 * 1000;
const PAUSA_TAKEOVER_MS = 12 * 60 * 60 * 1000;
const FILA_EXPIRA_MS = 15 * 60 * 1000;
const AGENDADO_EXPIRA_MS = 16 * 60 * 60 * 1000;
const HISTORICO_LIMITE = 60;
const HORA_INICIO_PRESTADOR = 8;
const HORA_FIM_PRESTADOR = 21;
const TEL_TESTE_CLIENTE = "0000000000000";

// Travas contra rajadas: nenhuma situação (bug, loop, falha de banco) pode
// fazer a DENIA mandar mensagens sem parar.
const LIMITES_ENVIO = { porTelefone2min: 4, porTelefone10min: 10, porTelefoneHora: 25, global10min: 150 };
const LIMITE_ALERTAS_HORA = 12;

// ----------------------------------------------------------------------------
// PRESTADORES — identificados por TELEFONE + ÁREA, nunca só pelo nome.
// A ordem dentro da área é a ordem de prioridade de consulta.
// ----------------------------------------------------------------------------
const PRESTADORES = [
  { id: "MARC-QEZIA", area: "MARCENARIA", nome: "Qézia/Marco", telefone: "5521998652205" },
  { id: "MARC-JOAO", area: "MARCENARIA", nome: "João", telefone: "5521993781381" },
  { id: "ASSIST-CARLOS", area: "ASSISTENCIA_TECNICA", nome: "Carlos (assistência técnica)", telefone: "5511992197178" },
  { id: "REF-ANDERSON", area: "REFORMA", nome: "Anderson (reforma)", telefone: "5521987506366" },
  { id: "REF-ADEMIR", area: "REFORMA", nome: "Ademir", telefone: "5521992729945" },
  { id: "ELET-WILLIAM", area: "ELETRICA", nome: "William", telefone: "5521966142206" },
  { id: "CHAV-ANDERSON", area: "CHAVEIRO", nome: "Anderson (chaveiro)", telefone: "5521964545279" },
  { id: "ESTOF-CARLOS", area: "ESTOFADOR", nome: "Carlos (estofador)", telefone: "5521983838318" },
  { id: "HIG-MIRELLA", area: "HIGIENIZACAO", nome: "Mirella", telefone: "5521978791765" },
  { id: "HIG-PAULO", area: "HIGIENIZACAO", nome: "Paulo", telefone: "5521980347727" }
];

const CATEGORIAS = {
  MARCENARIA: { rotulo: "Marcenaria (móveis planejados/sob medida, armários, portas de madeira)", modo: "DOMICILIO" },
  ASSISTENCIA_TECNICA: { rotulo: "Assistência técnica de ar-condicionado, geladeira/freezer e lava e seca (inclusive aparelho queimado por ligar em 110/220 V)", modo: "DOMICILIO" },
  ELETRODOMESTICO: { rotulo: "Conserto de outros eletrodomésticos e aparelhos (micro-ondas, air fryer, TV, forno, fogão, cafeteira, ventilador etc.) — sem prestador automático: a equipe avalia", modo: "EQUIPE" },
  REFORMA: { rotulo: "Reforma (pedreiro, pintura, hidráulica, pisos, revestimentos)", modo: "DOMICILIO" },
  ELETRICA: { rotulo: "Elétrica da casa (tomadas, disjuntores, fiação, quadro de luz, iluminação). NÃO conserta eletrodomésticos nem aparelhos queimados", modo: "DOMICILIO" },
  CHAVEIRO: { rotulo: "Chaveiro (fechaduras, cópias, abertura de portas)", modo: "DOMICILIO" },
  ESTOFADOR: { rotulo: "Estofador (reforma/troca de tecido de sofás e poltronas)", modo: "DOMICILIO" },
  HIGIENIZACAO: { rotulo: "Higienização (limpeza de sofás, colchões, tapetes, estofados)", modo: "DOMICILIO" },
  BALCAO: { rotulo: "Eletrônicos no balcão da loja (computador, notebook, Apple, celular, smartwatch) — o cliente leva o equipamento", modo: "BALCAO" }
};

const REGRAS_AREA = [
  ["CHAVEIRO", /\b(chaveiro|fechaduras?|cilindro|copias? de chave|porta trancada|trancad[oa] (pra|para) fora|perdi a chave)\b/],
  ["ELETRICA", /\b(eletricista|eletric[ao]s?|tomadas?|disjuntor(es)?|fiacao|curto[- ]?circuito|quadro de luz|luminarias?|chuveiro eletrico)\b/],
  ["ASSISTENCIA_TECNICA", /\b(ar[- ]?condicionado|split|geladeiras?|refrigerador|freezer|lava e seca|lava-e-seca|lavadora|maquina de lavar|secadora)\b/],
  ["ESTOFADOR", /\b(estofador|estofamento|reforma(r)? (de |do |da |o |a )?(sofa|poltrona)|troca(r)? (o |de )?tecido)\b/],
  ["HIGIENIZACAO", /\b(higieniza\w*|limpeza (de |do |da )?(sofa|colchao|estofados?|tapetes?|poltronas?|cadeiras?)|lava(r|gem) (de |do |o )?(sofa|colchao|tapete))\b/],
  ["MARCENARIA", /\b(marcenaria|marceneiro|moveis? planejad\w*|planejad[oa]s?|sob medida|armarios?|guarda[- ]roupas?|mdf|gabinete|prateleiras?|nichos?)\b/],
  ["BALCAO", /\b(notebook|computador|macbook|imac|iphone|ipad|celular|smartwatch|apple watch|relogio inteligente|placa mae|formatar|formatacao)\b/]
];
// Aparelho/eletrodoméstico: nunca vai para o eletricista, mesmo que fale em tomada, 110/220 V ou "queimou".
const REGRA_APARELHO = /\b(eletrodomestic\w*|aparelho|micro-?ondas|microondas|liquidificador|air ?fryer|fritadeira|forno|fogao|cooktop|cafeteira|torradeira|ventilador|aspirador|batedeira|panela eletrica|purificador|bebedouro|televis\w*|tv|smart ?tv|secador|chapinha|geladeira|freezer|refrigerador|lava e seca|lava-e-seca|lavadora|maquina de lavar|secadora|ar[- ]?condicionado|split|notebook|computador|celular|videogame)\b/;
const REGRA_DEFEITO = /\b(queim\w*|parou|para de|nao liga|nao funciona|nao gela|nao esquenta|nao centrifuga|defeito|quebr\w*|estrag\w*|conserto|consertar|reparo|reparar|pifou|deu problema|com problema|curto|fumaca|cheiro de queimado|(?:110|127|220) ?v?|voltagem)\b/;
const REGRA_ASSISTENCIA = /\b(ar[- ]?condicionado|split|geladeiras?|refrigerador|freezer|lava e seca|lava-e-seca|lavadora|maquina de lavar|secadora)\b/;
const REGRA_REFORMA = /\b(reforma|pedreiro|pintura|pintor|hidraulic\w*|encanador|vazamento|drywall|alvenaria|azulejo|piso|porcelanato|revestimento|obra|reboco|rejunte|infiltracao)\b/;

const ETAPAS_ENCERRADAS = new Set(["CONCLUIDO", "CANCELADO"]);
const STATUS_LEGADO_ENCERRADO = /^(FINALIZADO|SERVICO_CONCLUIDO|CONCLUIDO|CONCLUÍDO|CANCELADO|ENCERRADO|RESOLVIDO)$/i;

const CAMPOS_TREINAMENTO = ["instrucoes", "servicos", "regras", "precos", "procedimentos", "informacoes", "exemplos", "aprendizados"];
const ROTULOS_TREINAMENTO = {
  instrucoes: "INSTRUÇÕES DO ATENDIMENTO", servicos: "SERVIÇOS", regras: "REGRAS DA EMPRESA",
  precos: "PREÇOS E CONDIÇÕES AUTORIZADOS", procedimentos: "PROCEDIMENTOS",
  informacoes: "INFORMAÇÕES DA EMPRESA", exemplos: "EXEMPLOS DE ATENDIMENTO",
  aprendizados: "APRENDIZADOS APROVADOS (extraídos do histórico real e aprovados pela empresa)"
};

// ============================================================================
// UTILIDADES
// ============================================================================

const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
function digitos(v) { return String(v ?? "").replace(/\D/g, ""); }
function norm(v) { return String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(); }
function txt(v, max = 600) { return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max); }
function moeda(c) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(c || 0) / 100); }
function esc(v) { return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function json(dados, status = 200) {
  return new Response(JSON.stringify(dados, null, 2), { status, headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store" } });
}
function paginaHTML(corpo, status = 200, extras = {}) {
  return new Response(corpo, { status, headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store", "x-frame-options": "DENY", ...extras } });
}
function iguaisSeguro(a, b) {
  a = String(a ?? ""); b = String(b ?? "");
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0 && a.length > 0;
}
function lerJSON(texto) {
  const t = String(texto || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(t); } catch { }
  const i = t.indexOf("{"), f = t.lastIndexOf("}");
  if (i >= 0 && f > i) { try { return JSON.parse(t.slice(i, f + 1)); } catch { } }
  return null;
}
function horaSP(ms) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  return Number(p.find(x => x.type === "hour")?.value || 0);
}
function dataSP(ms) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const g = t => p.find(x => x.type === t)?.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
function dataHoraSP(ms) { return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }).format(new Date(ms)); }
function inicioDiaSP(ms) { return Date.parse(dataSP(ms) + "T00:00:00-03:00"); }
function primeiroNome(n) { return String(n || "").replace(/\(.*?\)/g, "").split(/[\s/]+/).filter(Boolean)[0] || ""; }
function base64(buffer) {
  const bytes = new Uint8Array(buffer); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Telefones BR: a Meta às vezes entrega o wa_id sem o nono dígito.
function variantesTel(tel) {
  const t = digitos(tel);
  const v = new Set([t]);
  const m = t.match(/^(000)?(55\d\d)(\d+)$/);
  if (m) {
    const pre = (m[1] || "") + m[2], r = m[3];
    if (r.length === 9 && r[0] === "9") v.add(pre + r.slice(1));
    if (r.length === 8) v.add(pre + "9" + r);
  }
  return [...v];
}
function prestadorPorTelefone(tel) {
  let t = digitos(tel);
  if (t.startsWith("000") && t.length > 13) t = t.slice(3); // telefone simulado do painel de teste
  const vs = variantesTel(t);
  return PRESTADORES.find(p => vs.includes(p.telefone) || variantesTel(p.telefone).includes(t)) || null;
}
function ocultarTelefones(texto) {
  return String(texto || "").replace(/(\+?55[\s-]?)?\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}\b/g, "[telefone omitido]");
}

function classificarArea(texto) {
  const t = norm(texto);
  const areas = REGRAS_AREA.filter(([, re]) => re.test(t)).map(([a]) => a);
  return { areas: [...new Set(areas)], generico: REGRA_REFORMA.test(t) };
}
// A IA escolhe a categoria lendo o TREINAMENTO; o código só confirma ou barra.
// Na dúvida, devolve "" e o caso vai para a equipe — nunca para o prestador errado.
function definirCategoria(fatos, sugestaoIA, confianca = "") {
  const base = [fatos.servico, fatos.problema, fatos.marca, fatos.modelo].filter(Boolean).join(" | ");
  const t = norm(base);
  const r = classificarArea(base);
  let areas = r.areas;
  let ia = CATEGORIAS[sugestaoIA] ? sugestaoIA : "";
  const certa = String(confianca || "").toUpperCase() === "ALTA";
  if (REGRA_APARELHO.test(t) && REGRA_DEFEITO.test(t)) {
    areas = areas.filter(a => a !== "ELETRICA");
    if (ia === "ELETRICA") ia = "";
    if (!areas.length && !REGRA_ASSISTENCIA.test(t)) areas = ["ELETRODOMESTICO"];
  }
  if (areas.length === 1) {
    if (ia && ia !== areas[0] && certa) return ""; // IA e regras discordam: equipe decide
    return areas[0];
  }
  if (areas.length > 1) return areas.includes(ia) && certa ? ia : "";
  if (r.generico) return ia && certa ? ia : (ia ? "" : "REFORMA");
  return certa ? ia : "";
}

// Valores em reais escritos no texto -> centavos.
function valoresNoTexto(texto) {
  const out = [];
  const re = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/g;
  let m;
  while ((m = re.exec(String(texto || "")))) {
    const reais = Number(m[1].replace(/\./g, ""));
    const cent = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
    if (Number.isFinite(reais)) out.push(reais * 100 + cent);
  }
  return out;
}
// Números que parecem dinheiro (exclui horários, datas e números de caso).
function valoresCandidatos(texto) {
  const out = [];
  const re = /(r\$\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(\s*(?:h\b|hs\b|horas?|:|min|º|°|\/|%))?/gi;
  let m;
  const s = String(texto || "");
  while ((m = re.exec(s))) {
    if (m[4]) continue;
    const antes = norm(s.slice(Math.max(0, m.index - 6), m.index));
    if (/(dia|caso|#|n|num)\s*$/.test(antes)) continue;
    const v = Number(m[2].replace(/\./g, "")) * 100 + (m[3] ? Number(m[3].padEnd(2, "0")) : 0);
    if (v >= 2000 && v <= 10000000) out.push(v);
  }
  return out;
}
function valoresMonetarios(texto) {
  const out = [];
  const re = /(?:r\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?)|(?:(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:reais|real)\b)/gi;
  let m;
  while ((m = re.exec(String(texto || "")))) {
    const r = m[1] || m[3], c = m[2] || m[4];
    out.push(Number(r.replace(/\./g, "")) * 100 + (c ? Number(c.padEnd(2, "0")) : 0));
  }
  return out;
}

function ehMensagemSocial(t) {
  return /^(ok+|okay|okey|blz|beleza|certo|ta|tá|ta bom|tá bom|entendi|perfeito|show|combinado|tranquilo|joia|jóia|valeu|obrigad[oa]|muito obrigad[oa]|agradeço|agradeco|👍|🙏|👌|😊|🙂)[.!\s]*$/i.test(String(t || "").trim());
}

// ============================================================================
// CONTEXTO DE EXECUÇÃO
// ============================================================================

function criarContexto(env, opcoes = {}) {
  const c = {
    env, db: env.DB, sim: !!opcoes.simulacao, ignorarHorario: !!opcoes.ignorarHorario,
    registro: [], agora: () => (typeof env.__agora === "function" ? env.__agora() : Date.now())
  };
  c.saida = criarSaida(c);
  return c;
}

// ============================================================================
// D1 — ESQUEMA (aditivo; não altera tabelas existentes)
// ============================================================================

const SQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS d30_meta (chave TEXT PRIMARY KEY, valor TEXT)`,
  `CREATE TABLE IF NOT EXISTS pessoas (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, nome TEXT, telefone TEXT, tipo TEXT DEFAULT 'CLIENTE', email TEXT, observacoes TEXT, ativo INTEGER DEFAULT 1, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT)`,
  `CREATE TABLE IF NOT EXISTS mensagens (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, caso_id INTEGER, pessoa_id INTEGER, whatsapp_message_id TEXT, direcao TEXT, origem TEXT, tipo_conteudo TEXT, conteudo TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS casos (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, cliente_id INTEGER, servico_id INTEGER, status TEXT, titulo TEXT, descricao TEXT, problema TEXT, marca TEXT, modelo TEXT, endereco TEXT, bairro TEXT, cidade TEXT, estado TEXT, prioridade TEXT, modo_atendimento TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, atualizado_em TEXT)`,
  `CREATE TABLE IF NOT EXISTS atendentes (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, pessoa_id INTEGER, telefone_alerta TEXT, recebe_whatsapp INTEGER DEFAULT 1, ativo INTEGER DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS tecnicos (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, pessoa_id INTEGER, especialidades TEXT, ativo INTEGER DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS treinamento_ia (empresa_id TEXT PRIMARY KEY, treinamento_json TEXT NOT NULL, atualizado_em TEXT)`,
  `CREATE TABLE IF NOT EXISTS d30_fila (wamid TEXT PRIMARY KEY, telefone TEXT NOT NULL, payload TEXT NOT NULL, recebido_ms INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDENTE', lote TEXT, erro TEXT, atualizado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_fila_tel ON d30_fila(telefone, status, recebido_ms)`,
  `CREATE INDEX IF NOT EXISTS d30_fila_status ON d30_fila(status, recebido_ms)`,
  `CREATE INDEX IF NOT EXISTS d30_fila_lote ON d30_fila(lote)`,
  `CREATE INDEX IF NOT EXISTS d30_fila_recebido ON d30_fila(recebido_ms)`,
  `CREATE TABLE IF NOT EXISTS d30_casos (caso_id INTEGER PRIMARY KEY, cliente_id INTEGER NOT NULL, telefone TEXT, etapa TEXT NOT NULL, fatos_json TEXT NOT NULL DEFAULT '{}', resumo TEXT, criado_ms INTEGER, atualizado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_casos_cliente ON d30_casos(cliente_id, atualizado_ms)`,
  `CREATE INDEX IF NOT EXISTS d30_casos_etapa ON d30_casos(etapa, atualizado_ms)`,
  `CREATE TABLE IF NOT EXISTS d30_consultas (id INTEGER PRIMARY KEY AUTOINCREMENT, caso_id INTEGER NOT NULL, cliente_id INTEGER, cliente_tel TEXT, prestador_id TEXT, prestador_tel TEXT NOT NULL, prestador_nome TEXT, area TEXT, status TEXT NOT NULL, message_id TEXT, valor_prestador INTEGER, valor_cliente INTEGER, valor_final TEXT, disponibilidade TEXT, pergunta_pendente TEXT, pedido_pendente TEXT, criado_ms INTEGER NOT NULL, atualizado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_consultas_prest ON d30_consultas(prestador_tel, status, atualizado_ms)`,
  `CREATE INDEX IF NOT EXISTS d30_consultas_caso ON d30_consultas(caso_id, id)`,
  `CREATE TABLE IF NOT EXISTS d30_pausas (telefone TEXT PRIMARY KEY, ate_ms INTEGER NOT NULL, motivo TEXT)`,
  `CREATE TABLE IF NOT EXISTS d30_envios (chave TEXT PRIMARY KEY, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_envios_ms ON d30_envios(criado_ms)`,
  `CREATE TABLE IF NOT EXISTS d30_midias (id INTEGER PRIMARY KEY AUTOINCREMENT, caso_id INTEGER, telefone TEXT, media_id TEXT NOT NULL, tipo TEXT, mime TEXT, legenda TEXT, comprovante INTEGER DEFAULT 0, enviado_para TEXT, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_midias_caso ON d30_midias(caso_id)`,
  `CREATE TABLE IF NOT EXISTS d30_agendados (id INTEGER PRIMARY KEY AUTOINCREMENT, consulta_id INTEGER, caso_id INTEGER, para TEXT NOT NULL, texto TEXT NOT NULL, inicial INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'PENDENTE', criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_agendados_status ON d30_agendados(status, criado_ms)`,
  `CREATE TABLE IF NOT EXISTS d30_treinamento (versao INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL, autor TEXT, criado_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS d30_eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, caso_id INTEGER, tipo TEXT NOT NULL, descricao TEXT, dados TEXT, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_eventos_ms ON d30_eventos(criado_ms)`,
  `CREATE TABLE IF NOT EXISTS d30_saidas (id INTEGER PRIMARY KEY AUTOINCREMENT, telefone TEXT NOT NULL, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_saidas_tel ON d30_saidas(telefone, criado_ms)`,
  `CREATE INDEX IF NOT EXISTS d30_saidas_ms ON d30_saidas(criado_ms)`,
  `CREATE TABLE IF NOT EXISTS d30_crm (telefone TEXT PRIMARY KEY, json TEXT NOT NULL, em_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS d30_sync (chave TEXT PRIMARY KEY, evento TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDENTE', tentativas INTEGER NOT NULL DEFAULT 0, proxima_ms INTEGER NOT NULL DEFAULT 0, erro TEXT, atualizado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_sync_status ON d30_sync(status, proxima_ms)`,
  `CREATE TABLE IF NOT EXISTS d30_aprendizado_job (id TEXT PRIMARY KEY, status TEXT NOT NULL, inicio_id INTEGER, cursor_id INTEGER, fim_id INTEGER, lotes INTEGER NOT NULL DEFAULT 0, erros INTEGER NOT NULL DEFAULT 0, iniciado_ms INTEGER, atualizado_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS d30_sugestoes (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, tipo TEXT NOT NULL, titulo TEXT NOT NULL, conteudo TEXT NOT NULL, evidencia TEXT, ocorrencias INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'PENDENTE', criado_ms INTEGER NOT NULL, decidido_ms INTEGER, decidido_por TEXT)`,
  `CREATE INDEX IF NOT EXISTS d30_sugestoes_status ON d30_sugestoes(status, ocorrencias)`,
  `CREATE TABLE IF NOT EXISTS d30_ficha (id INTEGER PRIMARY KEY AUTOINCREMENT, telefone TEXT NOT NULL, dados_json TEXT NOT NULL, origem TEXT, importado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_ficha_tel ON d30_ficha(telefone)`
];
const SQL_INDICES_LEGADO = [
  `CREATE INDEX IF NOT EXISTS d30_idx_msg_pessoa ON mensagens(empresa_id, pessoa_id, id)`,
  `CREATE INDEX IF NOT EXISTS d30_idx_msg_wamid ON mensagens(whatsapp_message_id)`,
  `CREATE INDEX IF NOT EXISTS d30_idx_pessoas_tel ON pessoas(empresa_id, telefone)`,
  `CREATE INDEX IF NOT EXISTS d30_idx_casos_cliente ON casos(empresa_id, cliente_id, id)`,
  `CREATE INDEX IF NOT EXISTS d30_idx_atend_pessoa ON atendentes(empresa_id, pessoa_id)`,
  `CREATE INDEX IF NOT EXISTS d30_idx_tec_pessoa ON tecnicos(empresa_id, pessoa_id)`,
  `CREATE INDEX IF NOT EXISTS d30_idx_msg_origem ON mensagens(origem, id)`,
  `CREATE INDEX IF NOT EXISTS d30_idx_msg_caso ON mensagens(caso_id, id)`
];

let schemaPronto = false;
async function garantirSchema(c) {
  if (schemaPronto) return;
  if (!c.db) throw new Error("Binding D1 'DB' ausente.");
  const r = await c.db.prepare("SELECT valor FROM d30_meta WHERE chave='schema'").first().catch(() => null);
  if (r?.valor !== SCHEMA_VERSAO) {
    for (const s of SQL_SCHEMA) await c.db.prepare(s).run();
    for (const s of SQL_INDICES_LEGADO) { try { await c.db.prepare(s).run(); } catch (e) { console.warn("Índice legado não criado:", e?.message); } }
    await c.db.prepare("INSERT OR REPLACE INTO d30_meta(chave,valor) VALUES('schema',?)").bind(SCHEMA_VERSAO).run();
  }
  schemaPronto = true;
}

async function evento(c, casoId, tipo, descricao = "", dados = null) {
  try {
    await c.db.prepare("INSERT INTO d30_eventos(caso_id,tipo,descricao,dados,criado_ms) VALUES(?,?,?,?,?)")
      .bind(casoId || null, tipo, txt(descricao, 1000), dados ? JSON.stringify(dados).slice(0, 4000) : null, c.agora()).run();
  } catch (e) { console.error("evento", tipo, e?.message); }
}

// Idempotência de envios/alertas: true = primeira vez.
async function reservarChave(c, chave) {
  const r = await c.db.prepare("INSERT OR IGNORE INTO d30_envios(chave,criado_ms) VALUES(?,?)").bind(chave, c.agora()).run();
  return Number(r?.meta?.changes || 0) > 0;
}
async function liberarChave(c, chave) {
  try { await c.db.prepare("DELETE FROM d30_envios WHERE chave=?").bind(chave).run(); } catch { }
}

// ============================================================================
// PESSOAS E PAPÉIS
// ============================================================================

async function buscarPessoa(c, tel) {
  const vs = variantesTel(tel);
  return await c.db.prepare(`SELECT id,nome,telefone,tipo,email,criado_em FROM pessoas WHERE empresa_id=? AND telefone IN (${vs.map(() => "?").join(",")}) AND COALESCE(ativo,1)=1 ORDER BY id LIMIT 1`)
    .bind(EMPRESA_ID, ...vs).first();
}
async function obterPessoa(c, tel, nome, tipo) {
  let p = await buscarPessoa(c, tel);
  if (!p) {
    try {
      await c.db.prepare("INSERT INTO pessoas(empresa_id,nome,telefone,tipo,ativo,atualizado_em) VALUES(?,?,?,?,1,CURRENT_TIMESTAMP)")
        .bind(EMPRESA_ID, txt(nome, 120) || null, digitos(tel), tipo).run();
    } catch (e) { console.warn("pessoa concorrente", e?.message); }
    p = await buscarPessoa(c, tel);
    if (p && tipo === "CLIENTE") await syncCliente(c, p);
  } else if (!p.nome && nome) {
    await c.db.prepare("UPDATE pessoas SET nome=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?").bind(txt(nome, 120), p.id).run();
    p.nome = txt(nome, 120);
  }
  return p;
}

// Perfil do cliente antigo: desde quando, quantos atendimentos, últimos serviços e valores.
async function perfilCliente(c, pessoa) {
  try {
    const casos = (await c.db.prepare("SELECT id,titulo,problema,bairro,status,criado_em FROM casos WHERE empresa_id=? AND cliente_id=? ORDER BY id DESC LIMIT 8").bind(EMPRESA_ID, pessoa.id).all())?.results || [];
    const total = Number((await c.db.prepare("SELECT COUNT(*) n FROM casos WHERE empresa_id=? AND cliente_id=?").bind(EMPRESA_ID, pessoa.id).first())?.n || 0);
    let valores = new Map();
    if (casos.length) {
      const ids = casos.map(k => k.id);
      const f = await c.db.prepare(`SELECT caso_id, valor_cliente_centavos FROM financeiro_casos WHERE caso_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all().catch(() => ({ results: [] }));
      for (const x of f?.results || []) if (x.valor_cliente_centavos) valores.set(x.caso_id, x.valor_cliente_centavos);
      const d = await c.db.prepare(`SELECT caso_id, valor_cliente FROM d30_consultas WHERE caso_id IN (${ids.map(() => "?").join(",")}) AND valor_cliente IS NOT NULL`).bind(...ids).all().catch(() => ({ results: [] }));
      for (const x of d?.results || []) valores.set(x.caso_id, x.valor_cliente);
    }
    const linhas = [];
    if (pessoa.criado_em) linhas.push(`Cliente desde ${String(pessoa.criado_em).slice(0, 10).split("-").reverse().join("/")}.`);
    linhas.push(total ? `${total} atendimento(s) registrado(s).` : "Nenhum atendimento anterior registrado.");
    for (const k of casos) linhas.push(`- #${k.id} ${String(k.criado_em || "").slice(0, 10)}: ${txt(k.titulo || k.problema, 80)}${k.bairro ? ", " + k.bairro : ""} — ${k.status || "-"}${valores.has(k.id) ? " — " + moeda(valores.get(k.id)) : ""}`);
    return linhas.join("\n");
  } catch (e) { console.warn("perfil", e?.message); return ""; }
}

// Exemplos reais de como as atendentes escrevem (para a DENIA falar igual).
let cacheEstilo = { em: 0, valor: "" };
async function estiloDaEquipe(c) {
  if (c.agora() - cacheEstilo.em < 30 * 60000) return cacheEstilo.valor;
  try {
    const r = (await c.db.prepare("SELECT conteudo FROM mensagens WHERE origem='HUMANO' AND direcao='SAIDA' ORDER BY id DESC LIMIT 40").all())?.results || [];
    const ex = r.map(x => ocultarTelefones(txt(x.conteudo, 220))).filter(t => t.length >= 8 && !/^\[/.test(t) && !/r\$|\d{3}\.\d{3}/i.test(t)).slice(0, 15);
    cacheEstilo = { em: c.agora(), valor: ex.map(t => "- " + t).join("\n") };
  } catch (e) { cacheEstilo = { em: c.agora(), valor: "" }; }
  return cacheEstilo.valor;
}

// Ficha do cliente no sistema de cadastro (CRM). Contrato: GET CRM_CONSULTA_URL?telefone=55DDDNUMERO
// com "Authorization: Bearer CRM_TOKEN", resposta JSON livre (serviços feitos, valores, observações).
// Ficha do cliente: registros importados do sistema das atendentes (planilha) + consulta online (opcional).
async function fichaCRM(c, tel) {
  const [importada, online] = await Promise.all([fichaImportada(c, tel), fichaOnline(c, tel)]);
  return [importada, online].filter(Boolean).join("\n");
}
async function fichaImportada(c, tel) {
  try {
    const vs = variantesTel(tel);
    const r = (await c.db.prepare(`SELECT dados_json FROM d30_ficha WHERE telefone IN (${vs.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 15`).bind(...vs).all())?.results || [];
    if (!r.length) return "";
    return "Registros do sistema das atendentes:\n" + r.map(x => "- " + txt(x.dados_json, 400)).join("\n");
  } catch (e) { return ""; }
}
async function fichaOnline(c, tel) {
  const url = String(c.env.CRM_CONSULTA_URL || "").trim();
  if (c.sim || !/^https:\/\//i.test(url)) return "";
  const t = digitos(tel);
  try {
    const cache = await c.db.prepare("SELECT json, em_ms FROM d30_crm WHERE telefone=?").bind(t).first();
    if (cache && c.agora() - cache.em_ms < 6 * 3600000) return cache.json;
    const u = new URL(url); u.searchParams.set("telefone", t);
    const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${c.env.CRM_TOKEN || c.env.PLATAFORMA_API_TOKEN || ""}`, Accept: "application/json" }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return cache?.json || "";
    const corpo = JSON.stringify(await r.json()).slice(0, 3500);
    await c.db.prepare("INSERT OR REPLACE INTO d30_crm(telefone,json,em_ms) VALUES(?,?,?)").bind(t, corpo, c.agora()).run();
    return corpo;
  } catch (e) { console.warn("CRM", e?.message); return ""; }
}

// ============================================================================
// APRENDIZADO COM O HISTÓRICO (6 meses) — sugestões que a empresa aprova
// ============================================================================
// Roda aos poucos no cron (um lote de mensagens por minuto) para caber no plano
// gratuito. Nada entra no treinamento sem aprovação.

const LOTE_APRENDIZADO = 220;
const TIPOS_SUGESTAO = ["RESPOSTA_PADRAO", "PRECO_PRATICADO", "QUEM_ATENDE", "REGRA", "ESTILO", "INFORMACAO"];

async function iniciarAprendizado(c) {
  const fim = Number((await c.db.prepare("SELECT COALESCE(MAX(id),0) n FROM mensagens").first())?.n || 0);
  const limite = new Date(c.agora() - 183 * 86400000).toISOString().slice(0, 19).replace("T", " ");
  const ini = await c.db.prepare("SELECT id FROM mensagens WHERE criado_em >= ? ORDER BY id LIMIT 1").bind(limite).first();
  const inicio = Number(ini?.id || fim);
  await c.db.prepare(`INSERT OR REPLACE INTO d30_aprendizado_job(id,status,inicio_id,cursor_id,fim_id,lotes,erros,iniciado_ms,atualizado_ms) VALUES('principal','RODANDO',?,?,?,0,0,?,?)`)
    .bind(inicio, inicio - 1, fim, c.agora(), c.agora()).run();
  return statusAprendizado(c);
}
async function statusAprendizado(c) {
  const j = await c.db.prepare("SELECT * FROM d30_aprendizado_job WHERE id='principal'").first();
  const cont = (await c.db.prepare("SELECT status, COUNT(*) n FROM d30_sugestoes GROUP BY status").all())?.results || [];
  const total = j ? Math.max(1, j.fim_id - j.inicio_id + 1) : 1;
  const feito = j ? Math.min(total, Math.max(0, j.cursor_id - j.inicio_id + 1)) : 0;
  return { status: j?.status || "NUNCA_EXECUTADO", progresso: j ? Math.round((feito / total) * 100) : 0, lotes: j?.lotes || 0, erros: j?.erros || 0, iniciado_ms: j?.iniciado_ms || null, atualizado_ms: j?.atualizado_ms || null, sugestoes: Object.fromEntries(cont.map(x => [x.status, x.n])) };
}
async function processarAprendizado(c) {
  const j = await c.db.prepare("SELECT * FROM d30_aprendizado_job WHERE id='principal' AND status='RODANDO'").first();
  if (!j || !c.env.OPENAI_API_KEY) return;
  const linhas = (await c.db.prepare(`SELECT m.id, m.pessoa_id, m.caso_id, m.direcao, m.origem, m.conteudo, p.tipo, p.telefone FROM mensagens m LEFT JOIN pessoas p ON p.id = m.pessoa_id
    WHERE m.id > ? AND m.id <= ? ORDER BY m.id LIMIT ?`).bind(j.cursor_id, j.fim_id, LOTE_APRENDIZADO).all())?.results || [];
  if (!linhas.length) { await c.db.prepare("UPDATE d30_aprendizado_job SET status='CONCLUIDO', atualizado_ms=? WHERE id='principal'").bind(c.agora()).run(); return; }
  const novoCursor = linhas[linhas.length - 1].id;
  const porPessoa = new Map();
  for (const m of linhas) {
    const prestador = prestadorPorTelefone(m.telefone);
    const quem = String(m.direcao).toUpperCase() === "SAIDA" ? (String(m.origem).toUpperCase() === "HUMANO" ? "ATENDENTE" : "DENIA") : (prestador || String(m.tipo).toUpperCase() === "TECNICO" ? `PROFISSIONAL${prestador ? " (" + prestador.area + ")" : ""}` : "CLIENTE");
    const k = m.pessoa_id || "x";
    if (!porPessoa.has(k)) porPessoa.set(k, []);
    porPessoa.get(k).push(`${quem}: ${ocultarTelefones(txt(m.conteudo, 300))}`);
  }
  const transcricao = [...porPessoa.values()].map((l, i) => `--- Conversa ${i + 1}\n${l.join("\n")}`).join("\n").slice(0, 28000);
  try {
    const treino = await carregarTreinamento(c);
    const o = await openaiJSON(c, `Você analisa conversas reais de uma central de atendimento para ensinar a assistente virtual DENIA. Extraia SOMENTE conhecimentos úteis, repetíveis e confirmados nas conversas — de preferência ditos pelas ATENDENTES ou confirmados por PROFISSIONAIS. Nunca extraia dados pessoais (nomes, telefones, endereços, CPF). Ignore erros da própria DENIA e não transforme casos isolados em regra. Não repita o que já está no TREINAMENTO ATUAL.
Tipos: RESPOSTA_PADRAO (como a equipe responde uma dúvida comum), PRECO_PRATICADO (faixa de valor realmente praticada para um serviço, com a condição), QUEM_ATENDE (qual área/profissional faz qual serviço — e o que NÃO faz), REGRA (procedimento ou política da empresa), ESTILO (frase curta típica das atendentes, para imitar o tom), INFORMACAO (horário, endereço da loja, formas de pagamento etc.).
Responda em JSON: {"itens":[{"tipo":"","titulo":"","conteudo":"","evidencia":""}]} com no máximo 8 itens; "conteudo" é o texto pronto para entrar no treinamento (1 a 3 frases); "evidencia" resume onde isso apareceu. Se não houver nada útil, {"itens":[]}.`,
      `TREINAMENTO ATUAL (resumo):\n${formatarTreinamento(treino.dados).slice(0, 6000)}\n\nCONVERSAS:\n${transcricao}\n\nResponda em JSON.`, [], 1600);
    for (const it of (Array.isArray(o?.itens) ? o.itens : []).slice(0, 8)) {
      const tipo = TIPOS_SUGESTAO.includes(String(it?.tipo).toUpperCase()) ? String(it.tipo).toUpperCase() : "";
      const titulo = ocultarTelefones(txt(it?.titulo, 140)), conteudo = ocultarTelefones(txt(it?.conteudo, 600));
      if (!tipo || !titulo || !conteudo || /\b(cpf|rg)\b/i.test(conteudo)) continue;
      const hash = await hmacHex("sugestao", tipo + "|" + norm(titulo));
      await c.db.prepare(`INSERT INTO d30_sugestoes(hash,tipo,titulo,conteudo,evidencia,ocorrencias,status,criado_ms) VALUES(?,?,?,?,?,1,'PENDENTE',?)
        ON CONFLICT(hash) DO UPDATE SET ocorrencias=d30_sugestoes.ocorrencias+1`).bind(hash, tipo, titulo, conteudo, ocultarTelefones(txt(it?.evidencia, 300)), c.agora()).run();
    }
    await c.db.prepare("UPDATE d30_aprendizado_job SET cursor_id=?, lotes=lotes+1, atualizado_ms=? WHERE id='principal'").bind(novoCursor, c.agora()).run();
  } catch (e) {
    console.error("aprendizado", e?.message);
    const erros = Number(j.erros) + 1;
    // Depois de 3 falhas seguidas no mesmo lote, pula o lote para não travar.
    await c.db.prepare("UPDATE d30_aprendizado_job SET erros=?, cursor_id=?, atualizado_ms=? WHERE id='principal'").bind(erros, erros % 3 === 0 ? novoCursor : j.cursor_id, c.agora()).run();
  }
}
async function decidirSugestao(c, id, acao, texto, autor) {
  const s = await c.db.prepare("SELECT * FROM d30_sugestoes WHERE id=?").bind(id).first();
  if (!s) return { ok: false, erro: "Sugestão não encontrada." };
  if (s.status !== "PENDENTE") return { ok: false, erro: "Esta sugestão já foi decidida." };
  if (acao === "rejeitar") {
    await c.db.prepare("UPDATE d30_sugestoes SET status='REJEITADA', decidido_ms=?, decidido_por=? WHERE id=?").bind(c.agora(), autor, id).run();
    return { ok: true };
  }
  const conteudo = txt(texto || s.conteudo, 800);
  const atual = await carregarTreinamento(c);
  const campo = s.tipo === "ESTILO" ? "exemplos" : "aprendizados";
  const linha = s.tipo === "ESTILO" ? `Atendente: ${conteudo}` : `- [${s.tipo.replace("_", " ").toLowerCase()}] ${s.titulo}: ${conteudo}`;
  const novo = [String(atual.dados?.[campo] || "").trim(), linha].filter(Boolean).join("\n");
  const r = await salvarTreinamento(c, { [campo]: novo }, `${autor} (aprendizado #${id})`, false);
  if (!r.ok) return { ok: false, erro: "Não foi possível salvar no treinamento." };
  await c.db.prepare("UPDATE d30_sugestoes SET status='APROVADA', conteudo=?, decidido_ms=?, decidido_por=? WHERE id=?").bind(conteudo, c.agora(), autor, id).run();
  return { ok: true, versao: r.versao };
}

// Importação do cadastro de clientes exportado do sistema das atendentes (planilha/CSV).
function telefoneBR(v) {
  let t = digitos(v);
  if (t.length === 10 || t.length === 11) t = "55" + t;
  return t.length >= 12 && t.length <= 13 ? t : "";
}
async function importarClientes(c, linhas, origem) {
  let importadas = 0, ignoradas = 0;
  const stmts = [];
  for (const l of (Array.isArray(linhas) ? linhas : []).slice(0, 500)) {
    const tel = telefoneBR(l?.telefone);
    if (!tel || typeof l !== "object") { ignoradas++; continue; }
    const dados = {};
    for (const [k, v] of Object.entries(l)) if (k !== "telefone" && String(v ?? "").trim()) dados[txt(k, 40)] = txt(v, 300);
    if (!Object.keys(dados).length) { ignoradas++; continue; }
    stmts.push(c.db.prepare("INSERT INTO d30_ficha(telefone,dados_json,origem,importado_ms) VALUES(?,?,?,?)").bind(tel, JSON.stringify(dados), txt(origem, 80) || "importação", c.agora()));
    importadas++;
  }
  for (let i = 0; i < stmts.length; i += 50) await c.db.batch(stmts.slice(i, i + 50));
  return { importadas, ignoradas };
}

// Sincronização com a plataforma de cadastro (mesmo contrato da versão anterior:
// PLATAFORMA_API_URL + PLATAFORMA_API_TOKEN; resposta precisa de ok/sucesso=true e cliente_id/os_id).
async function enfileirarSync(c, chave, evento, payload) {
  if (c.sim || !/^https:\/\//i.test(String(c.env.PLATAFORMA_API_URL || ""))) return;
  const corpo = JSON.stringify(payload);
  try {
    await c.db.prepare(`INSERT INTO d30_sync(chave,evento,payload,status,tentativas,proxima_ms,atualizado_ms) VALUES(?,?,?,'PENDENTE',0,0,?)
      ON CONFLICT(chave) DO UPDATE SET evento=excluded.evento, payload=excluded.payload, status='PENDENTE', tentativas=0, proxima_ms=0, erro=NULL, atualizado_ms=excluded.atualizado_ms
      WHERE d30_sync.payload<>excluded.payload`).bind(chave, evento, corpo, c.agora()).run();
  } catch (e) { console.warn("sync", e?.message); }
}
async function syncCliente(c, pessoa) {
  if (!pessoa?.id) return;
  await enfileirarSync(c, "cli:" + pessoa.id, "CLIENTE_ATUALIZADO", { versao: 1, evento: "CLIENTE_ATUALIZADO", empresa_id: String(EMPRESA_ID), cliente: { id: pessoa.id, nome: pessoa.nome || null, telefone: digitos(pessoa.telefone), email: pessoa.email || null } });
}
async function syncCaso(c, caso) {
  if (c.sim || !c.env.PLATAFORMA_API_URL) return;
  const p = await c.db.prepare("SELECT id,nome,telefone,email FROM pessoas WHERE id=?").bind(caso.clienteId).first().catch(() => null);
  const k = await c.db.prepare("SELECT * FROM d30_consultas WHERE caso_id=? ORDER BY id DESC LIMIT 1").bind(caso.casoId).first().catch(() => null);
  const f = caso.fatos || {};
  const ev = caso.etapa === "AGENDADO" ? "AGENDAMENTO_CONFIRMADO" : caso.etapa === "AGUARDANDO_CLIENTE" ? "ORCAMENTO_RECEBIDO_PROFISSIONAL" : "ATUALIZACAO";
  await enfileirarSync(c, "os:" + caso.casoId, ev, {
    versao: 1, evento: ev, empresa_id: String(EMPRESA_ID),
    cliente: { id: caso.clienteId, nome: p?.nome || null, telefone: digitos(p?.telefone || caso.telefone), email: p?.email || null },
    atendimento: { id: caso.casoId, status: statusLegado(caso.etapa), titulo: f.servico || null, descricao: f.problema || null, problema: f.problema || null, marca: f.marca || null, modelo: f.modelo || null, endereco: f.endereco || null, bairro: f.bairro || null, cidade: f.cidade || null, estado: null, resumo: caso.resumo || null },
    servico: { id: null, nome: CATEGORIAS[f.categoria]?.rotulo.split(" (")[0] || f.servico || null },
    profissional: k ? { id: k.prestador_id, nome: k.prestador_nome, telefone: prestadorPorTelefone(k.prestador_tel)?.telefone || null, status: k.status, disponibilidade: k.disponibilidade || null } : null,
    financeiro: { valor_profissional_centavos: k?.valor_prestador ?? null, valor_cliente_centavos: k?.valor_cliente ?? null, valor_inclui_atendimento: k?.valor_final || null, pagamento_cliente_status: "PENDENTE", repasse_profissional_status: "PENDENTE" }
  });
}
async function processarSync(c) {
  const url = String(c.env.PLATAFORMA_API_URL || "");
  if (!/^https:\/\//i.test(url)) return;
  const itens = (await c.db.prepare("SELECT * FROM d30_sync WHERE status='PENDENTE' AND proxima_ms <= ? ORDER BY proxima_ms LIMIT 10").bind(c.agora()).all())?.results || [];
  for (const it of itens) {
    let erro = "";
    try {
      const corpo = JSON.stringify({ ...JSON.parse(it.payload), gerado_em: new Date(c.agora()).toISOString() });
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.env.PLATAFORMA_API_TOKEN || ""}`, "X-Oficina-Event": it.evento, "Idempotency-Key": `${EMPRESA_ID}:${it.chave}:${(await hmacHex("sync", it.payload)).slice(0, 32)}` }, body: corpo, signal: AbortSignal.timeout(15000) });
      const a = await r.json().catch(() => null);
      const ok = r.ok && (a?.ok === true || a?.sucesso === true || a?.success === true) && (a?.cliente_id ?? a?.cliente?.id) != null && (it.chave.startsWith("cli:") || (a?.os_id ?? a?.ordem_servico?.id) != null);
      if (!ok) erro = `HTTP ${r.status}: a plataforma não confirmou (precisa ok=true, cliente_id${it.chave.startsWith("os:") ? " e os_id" : ""}).`;
    } catch (e) { erro = txt(e?.message, 200); }
    if (!erro) { await c.db.prepare("UPDATE d30_sync SET status='ENVIADO', erro=NULL, atualizado_ms=? WHERE chave=? AND payload=?").bind(c.agora(), it.chave, it.payload).run(); continue; }
    const n = Number(it.tentativas) + 1;
    await c.db.prepare("UPDATE d30_sync SET tentativas=?, status=?, erro=?, proxima_ms=?, atualizado_ms=? WHERE chave=? AND payload=?")
      .bind(n, n >= 10 ? "ERRO" : "PENDENTE", erro, c.agora() + Math.min(360, 5 * 2 ** Math.min(n, 6)) * 60000, c.agora(), it.chave, it.payload).run();
    if (n >= 10) await alertarEquipe(c, `Não consegui atualizar a plataforma de cadastro (${it.chave}): ${erro}`, "sync-erro:" + it.chave);
  }
}

// Ordem de precedência: lista oficial de prestadores > equipe (atendentes) > técnico do D1 > cliente.
async function identificar(c, tel) {
  const prestador = prestadorPorTelefone(tel);
  const pessoa = await buscarPessoa(c, tel);
  if (prestador) return { papel: "PRESTADOR", prestador, pessoa };
  if (pessoa) {
    const at = await c.db.prepare("SELECT 1 AS ok FROM atendentes WHERE empresa_id=? AND pessoa_id=? AND COALESCE(ativo,1)=1 LIMIT 1").bind(EMPRESA_ID, pessoa.id).first().catch(() => null);
    const tipo = String(pessoa.tipo || "").toUpperCase();
    if (at || tipo === "ATENDENTE") return { papel: "ATENDENTE", pessoa };
    if (tipo === "TECNICO") return { papel: "PRESTADOR", prestador: null, pessoa };
  }
  return { papel: "CLIENTE", pessoa };
}

// ============================================================================
// MENSAGENS (histórico persistente — tabela existente)
// ============================================================================

async function registrarMensagem(c, m) {
  try {
    await c.db.prepare(`INSERT INTO mensagens(empresa_id,caso_id,pessoa_id,whatsapp_message_id,direcao,origem,tipo_conteudo,conteudo,criado_em)
      VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .bind(EMPRESA_ID, m.casoId || null, m.pessoaId || null, m.wamid || null, m.direcao, m.origem, m.tipo || "TEXTO", String(m.conteudo || "").slice(0, 6000)).run();
  } catch (e) { console.error("registrarMensagem", e?.message); }
}
async function historico(c, pessoaId, limite = HISTORICO_LIMITE) {
  if (!pessoaId) return [];
  const r = await c.db.prepare(`SELECT id,caso_id,whatsapp_message_id,direcao,origem,tipo_conteudo,conteudo,criado_em FROM mensagens
    WHERE empresa_id=? AND pessoa_id=? ORDER BY id DESC LIMIT ?`).bind(EMPRESA_ID, pessoaId, limite).all();
  return (r?.results || []).reverse();
}
function autorMensagem(m, papelEntrada) {
  if (String(m.direcao).toUpperCase() === "ENTRADA") return papelEntrada;
  return String(m.origem).toUpperCase() === "HUMANO" ? "ATENDENTE HUMANO" : "DENIA";
}
function formatarHistorico(lista, papelEntrada, ignorarWamids = new Set()) {
  const linhas = lista.filter(m => !ignorarWamids.has(m.whatsapp_message_id)).map(m =>
    `[${String(m.criado_em || "").slice(0, 16)}]${m.caso_id ? ` (caso #${m.caso_id})` : ""} ${autorMensagem(m, papelEntrada)}: ${txt(m.conteudo, 1200)}`);
  return linhas.length ? linhas.join("\n") : "(sem mensagens anteriores)";
}

// ============================================================================
// CASOS (estado durável) — d30_casos + espelho na tabela casos existente
// ============================================================================

function statusLegado(etapa) { return etapa === "COLETANDO" ? "ABERTO" : etapa === "CONCLUIDO" ? "FINALIZADO" : etapa; }
function etapaDeStatusLegado(s) {
  const v = String(s || "").toUpperCase();
  if (STATUS_LEGADO_ENCERRADO.test(v)) return v.startsWith("CANCEL") ? "CANCELADO" : "CONCLUIDO";
  if (v === "AGENDADO") return "AGENDADO";
  return "COLETANDO";
}
function linhaParaCaso(r) {
  let fatos = {};
  try { fatos = JSON.parse(r.fatos_json || "{}") || {}; } catch { }
  return { casoId: r.caso_id, clienteId: r.cliente_id, telefone: r.telefone, etapa: r.etapa, fatos, resumo: r.resumo || "", atualizadoMs: r.atualizado_ms, criadoMs: r.criado_ms };
}
async function carregarCasoPorId(c, casoId) {
  const r = await c.db.prepare("SELECT * FROM d30_casos WHERE caso_id=?").bind(casoId).first();
  return r ? linhaParaCaso(r) : null;
}
async function carregarCasos(c, pessoa) {
  const agora = c.agora();
  const r = await c.db.prepare("SELECT * FROM d30_casos WHERE cliente_id=? ORDER BY atualizado_ms DESC LIMIT 6").bind(pessoa.id).all();
  let casos = (r?.results || []).map(linhaParaCaso);
  // Importa casos antigos (pré-V30) sem perder o que já estava registrado.
  if (casos.length < 6) {
    const conhecidos = new Set(casos.map(x => x.casoId));
    const leg = await c.db.prepare("SELECT * FROM casos WHERE empresa_id=? AND cliente_id=? ORDER BY id DESC LIMIT 3").bind(EMPRESA_ID, pessoa.id).all().catch(() => ({ results: [] }));
    for (const l of leg?.results || []) {
      if (conhecidos.has(l.id)) continue;
      const fatos = limparFatos({ servico: l.titulo, problema: l.problema || l.descricao, marca: l.marca, modelo: l.modelo, bairro: l.bairro, endereco: l.endereco, cidade: l.cidade });
      const atualizado = Date.parse(String(l.atualizado_em || l.criado_em || "").replace(" ", "T") + "Z") || agora;
      const caso = { casoId: l.id, clienteId: pessoa.id, telefone: pessoa.telefone, etapa: etapaDeStatusLegado(l.status), fatos, resumo: "", atualizadoMs: atualizado, criadoMs: atualizado };
      caso.fatos.categoria = definirCategoria(caso.fatos, "");
      await c.db.prepare("INSERT OR IGNORE INTO d30_casos(caso_id,cliente_id,telefone,etapa,fatos_json,resumo,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,?,?,?)")
        .bind(caso.casoId, pessoa.id, pessoa.telefone, caso.etapa, JSON.stringify(caso.fatos), "", caso.criadoMs, caso.atualizadoMs).run();
      casos.push(caso);
    }
    casos.sort((a, b) => b.atualizadoMs - a.atualizadoMs);
  }
  // Agendamento antigo (>30 dias) deixa de ser o caso ativo.
  for (const k of casos) {
    if (k.etapa === "AGENDADO" && agora - k.atualizadoMs > 30 * 86400000) {
      k.etapa = "CONCLUIDO";
      await c.db.prepare("UPDATE d30_casos SET etapa='CONCLUIDO' WHERE caso_id=?").bind(k.casoId).run();
    }
  }
  const ativo = casos.find(k => !ETAPAS_ENCERRADAS.has(k.etapa)) || null;
  return { ativo, recentes: casos.filter(k => k !== ativo).slice(0, 4) };
}
function limparFatos(f) {
  const o = {};
  for (const [k, v] of Object.entries(f || {})) { const s = txt(v, 400); if (s) o[k] = s; }
  return o;
}
async function criarCaso(c, pessoa, fatos) {
  const f = limparFatos(fatos);
  const r = await c.db.prepare(`INSERT INTO casos(empresa_id,cliente_id,status,titulo,descricao,problema,marca,modelo,endereco,bairro,criado_em,atualizado_em)
    VALUES(?,?,'ABERTO',?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`)
    .bind(EMPRESA_ID, pessoa.id, f.servico || "Solicitação de atendimento", f.problema || null, f.problema || null, f.marca || null, f.modelo || null, f.endereco || null, f.bairro || null).first();
  const caso = { casoId: r.id, clienteId: pessoa.id, telefone: pessoa.telefone, etapa: "COLETANDO", fatos: f, resumo: "", atualizadoMs: c.agora(), criadoMs: c.agora() };
  await c.db.prepare("INSERT INTO d30_casos(caso_id,cliente_id,telefone,etapa,fatos_json,resumo,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,?,?,?)")
    .bind(caso.casoId, pessoa.id, pessoa.telefone, caso.etapa, JSON.stringify(f), "", caso.criadoMs, caso.atualizadoMs).run();
  await evento(c, caso.casoId, "CASO_CRIADO", f.servico || "", f);
  await salvarSnapshotKV(c, caso);
  await syncCaso(c, caso);
  return caso;
}
async function salvarCaso(c, caso, etapaAnterior) {
  caso.atualizadoMs = c.agora();
  const f = caso.fatos || {};
  await c.db.prepare("UPDATE d30_casos SET etapa=?, fatos_json=?, resumo=?, atualizado_ms=? WHERE caso_id=?")
    .bind(caso.etapa, JSON.stringify(f), txt(caso.resumo, 600), caso.atualizadoMs, caso.casoId).run();
  try {
    await c.db.prepare(`UPDATE casos SET status=?, titulo=COALESCE(?,titulo), problema=COALESCE(?,problema), descricao=COALESCE(?,descricao),
      marca=COALESCE(?,marca), modelo=COALESCE(?,modelo), endereco=COALESCE(?,endereco), bairro=COALESCE(?,bairro), atualizado_em=CURRENT_TIMESTAMP
      WHERE empresa_id=? AND id=?`)
      .bind(statusLegado(caso.etapa), f.servico || null, f.problema || null, f.problema || null, f.marca || null, f.modelo || null, f.endereco || null, f.bairro || null, EMPRESA_ID, caso.casoId).run();
  } catch (e) { console.warn("espelho casos", e?.message); }
  if (etapaAnterior !== undefined && etapaAnterior !== caso.etapa) {
    await evento(c, caso.casoId, "ETAPA", `${etapaAnterior} -> ${caso.etapa}`);
    await salvarSnapshotKV(c, caso);
  }
  await syncCaso(c, caso);
}
async function mudarEtapa(c, caso, etapa) { const ant = caso.etapa; caso.etapa = etapa; await salvarCaso(c, caso, ant); }

// KV: só um retrato do caso quando a etapa muda (poucas gravações/dia),
// usado se o D1 ficar indisponível.
async function salvarSnapshotKV(c, caso) {
  if (c.sim || !c.env.MEMORIA || !caso?.telefone) return;
  try {
    await c.env.MEMORIA.put("d30:snap:" + digitos(caso.telefone), JSON.stringify({ casoId: caso.casoId, etapa: caso.etapa, fatos: caso.fatos, resumo: caso.resumo, em: c.agora() }), { expirationTtl: 60 * 60 * 24 * 90 });
  } catch (e) { console.warn("snapshot KV", e?.message); }
}

// ============================================================================
// CONSULTAS A PRESTADORES
// ============================================================================

const STATUS_CONSULTA_ABERTA = ["AGENDADA_ENVIO", "ENVIANDO", "ENVIADA", "AGUARDANDO_COMPOSICAO", "RESPONDIDA", "AGUARDANDO_CONFIRMACAO", "CONFIRMADA"];

async function consultaDoCaso(c, casoId) {
  return await c.db.prepare(`SELECT * FROM d30_consultas WHERE caso_id=? AND status IN (${STATUS_CONSULTA_ABERTA.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`)
    .bind(casoId, ...STATUS_CONSULTA_ABERTA).first();
}
async function consultasAbertasPrestador(c, tel) {
  const vs = variantesTel(tel), agora = c.agora();
  const r = await c.db.prepare(`SELECT * FROM d30_consultas WHERE prestador_tel IN (${vs.map(() => "?").join(",")})
    AND ((status IN ('ENVIADA','AGUARDANDO_COMPOSICAO','RESPONDIDA','AGUARDANDO_CONFIRMACAO') AND atualizado_ms > ?)
      OR (status='CONFIRMADA' AND atualizado_ms > ?)) ORDER BY atualizado_ms DESC LIMIT 10`)
    .bind(...vs, agora - 30 * 86400000, agora - 7 * 86400000).all();
  return r?.results || [];
}
async function atualizarConsulta(c, id, campos) {
  const chaves = Object.keys(campos);
  if (!chaves.length) return;
  await c.db.prepare(`UPDATE d30_consultas SET ${chaves.map(k => `${k}=?`).join(",")}, atualizado_ms=? WHERE id=?`)
    .bind(...chaves.map(k => campos[k] ?? null), c.agora(), id).run();
}
function telefoneDestinoPrestador(c, p) { return c.sim ? "000" + p.telefone : p.telefone; }
function dentroHorarioPrestador(c) {
  if (c.ignorarHorario) return true;
  const h = horaSP(c.agora());
  return h >= HORA_INICIO_PRESTADOR && h < HORA_FIM_PRESTADOR;
}

// ============================================================================
// PAUSA HUMANA (somente aquela conversa)
// ============================================================================

async function pausar(c, tel, ms, motivo) {
  const ate = c.agora() + ms;
  await c.db.prepare("INSERT INTO d30_pausas(telefone,ate_ms,motivo) VALUES(?,?,?) ON CONFLICT(telefone) DO UPDATE SET ate_ms=MAX(d30_pausas.ate_ms, excluded.ate_ms), motivo=excluded.motivo")
    .bind(digitos(tel), ate, motivo).run();
}
async function liberarPausa(c, tel) {
  for (const v of variantesTel(tel)) await c.db.prepare("DELETE FROM d30_pausas WHERE telefone=?").bind(v).run();
}
async function estaPausado(c, tel) {
  const vs = variantesTel(tel);
  const r = await c.db.prepare(`SELECT ate_ms FROM d30_pausas WHERE telefone IN (${vs.map(() => "?").join(",")}) AND ate_ms > ? LIMIT 1`).bind(...vs, c.agora()).first();
  return Boolean(r);
}

// ============================================================================
// META / WHATSAPP
// ============================================================================

function phoneId(env) { return String(env.WHATSAPP_PHONE_NUMBER_ID || PHONE_ID_PADRAO).trim(); }
async function metaPost(env, corpo) {
  if (!env.WHATSAPP_TOKEN) return { ok: false, erro: "WHATSAPP_TOKEN não configurado." };
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH}/${phoneId(env)}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpo), signal: AbortSignal.timeout(15000)
    });
    const bruto = await r.text();
    let d = {}; try { d = JSON.parse(bruto); } catch { }
    const id = d?.messages?.[0]?.id || null;
    if (r.ok && id) return { ok: true, id };
    return { ok: false, incerto: r.ok && !id, status: r.status, codigo: d?.error?.code || null, erro: d?.error?.message || bruto.slice(0, 300) || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, incerto: true, erro: "Falha de rede com a Meta: " + String(e?.message || e) };
  }
}
function metaTexto(env, to, texto) {
  return metaPost(env, { messaging_product: "whatsapp", recipient_type: "individual", to: digitos(to), type: "text", text: { preview_url: false, body: String(texto).slice(0, 4000) } });
}
function metaMidia(env, to, tipo, mediaId, legenda) {
  const t = ["image", "video", "audio", "document"].includes(tipo) ? tipo : "document";
  const obj = { id: mediaId };
  if (legenda && t !== "audio") obj.caption = String(legenda).slice(0, 900);
  return metaPost(env, { messaging_product: "whatsapp", recipient_type: "individual", to: digitos(to), type: t, [t]: obj });
}
function metaTemplate(env, to, nome, params) {
  return metaPost(env, {
    messaging_product: "whatsapp", recipient_type: "individual", to: digitos(to), type: "template",
    template: { name: nome, language: { code: String(env.WHATSAPP_TEMPLATE_IDIOMA || "pt_BR") }, components: [{ type: "body", parameters: params.map(p => ({ type: "text", text: txt(p, 900) || "-" })) }] }
  });
}
function foraDaJanela(r) { return Number(r?.codigo) === 131047 || /24.?hour|re-?engagement|janela/i.test(String(r?.erro || "")); }

async function metaBaixarMidia(env, mediaId) {
  const h = { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` };
  const meta = await fetch(`https://graph.facebook.com/${GRAPH}/${encodeURIComponent(mediaId)}`, { headers: h, signal: AbortSignal.timeout(15000) });
  const d = await meta.json().catch(() => ({}));
  if (!meta.ok || !d?.url) throw new Error(`Meta não liberou a mídia (${meta.status}).`);
  const arq = await fetch(d.url, { headers: h, signal: AbortSignal.timeout(20000) });
  if (!arq.ok) throw new Error(`Falha ao baixar mídia (${arq.status}).`);
  const buffer = await arq.arrayBuffer();
  if (buffer.byteLength > 15 * 1024 * 1024) throw new Error("Mídia maior que 15 MB.");
  return { buffer, mime: String(d.mime_type || arq.headers.get("content-type") || "application/octet-stream") };
}

async function telegramEnviar(env, texto) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(env.TELEGRAM_CHAT_ID), text: String(texto).slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000)
    });
    const d = await r.json().catch(() => ({}));
    return d?.ok === true ? { ok: true } : { ok: false, erro: d?.description || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, erro: String(e?.message || e) }; }
}

// Toda saída passa por aqui. No painel de teste (simulação) nada sai de verdade.
function criarSaida(c) {
  const env = c.env;
  const simular = (canal, para, conteudo, extra = {}) => { c.registro.push({ canal, para, texto: conteudo, ...extra }); return { ok: true, id: "sim." + crypto.randomUUID() }; };
  const controlado = async (to, envio) => {
    const bloqueio = await verificarLimites(c, to);
    if (bloqueio) { console.warn("Envio bloqueado:", bloqueio); return { ok: false, bloqueado: true, erro: bloqueio }; }
    const r = await envio();
    if (r.ok) await registrarSaidaTaxa(c, to);
    return r;
  };
  return {
    texto: (to, t, info = {}) => c.sim ? simular("whatsapp", to, t, info) : controlado(to, () => metaTexto(env, to, t)),
    midia: (to, m, info = {}) => c.sim ? simular("whatsapp-midia", to, `[${m.tipo}] ${m.legenda || ""}`, info) : controlado(to, () => metaMidia(env, to, m.tipo, m.mediaId, m.legenda)),
    template: (to, nome, params, info = {}) => c.sim ? simular("whatsapp-template", to, `${nome}: ${params.join(" | ")}`, info) : controlado(to, () => metaTemplate(env, to, nome, params)),
    telegram: async t => {
      if (c.sim) return simular("telegram", "equipe", t);
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) { console.warn("Telegram não configurado:", t.slice(0, 200)); return { ok: false, erro: "Telegram não configurado" }; }
      return telegramEnviar(env, t);
    }
  };
}

// Pausa geral (botão de emergência do painel ou variável DENIA_PAUSADA=true).
let cachePausaGeral = { em: 0, valor: false };
async function pausaGeralAtiva(c) {
  if (String(c.env.DENIA_PAUSADA || "").toLowerCase() === "true") return true;
  if (c.contingencia) return false;
  if (c.agora() - cachePausaGeral.em < 20000) return cachePausaGeral.valor;
  const r = await c.db.prepare("SELECT valor FROM d30_meta WHERE chave='pausa_geral'").first().catch(() => null);
  cachePausaGeral = { em: c.agora(), valor: r?.valor === "1" };
  return cachePausaGeral.valor;
}
async function verificarLimites(c, to) {
  if (await pausaGeralAtiva(c)) return "DENIA pausada (pausa geral ativa).";
  if (c.contingencia) return null; // a contingência tem trava própria no KV
  const tel = digitos(to), agora = c.agora();
  const conta = async (sql, ...b) => Number((await c.db.prepare(sql).bind(...b).first())?.n || 0);
  const desde = ms => agora - ms;
  const n2 = await conta("SELECT COUNT(*) n FROM d30_saidas WHERE telefone=? AND criado_ms > ?", tel, desde(120000));
  const n10 = await conta("SELECT COUNT(*) n FROM d30_saidas WHERE telefone=? AND criado_ms > ?", tel, desde(600000));
  const n60 = await conta("SELECT COUNT(*) n FROM d30_saidas WHERE telefone=? AND criado_ms > ?", tel, desde(3600000));
  const g10 = await conta("SELECT COUNT(*) n FROM d30_saidas WHERE criado_ms > ?", desde(600000));
  let motivo = "";
  if (g10 >= LIMITES_ENVIO.global10min) motivo = `limite geral: ${g10} mensagens em 10 min`;
  else if (n2 >= LIMITES_ENVIO.porTelefone2min || n10 >= LIMITES_ENVIO.porTelefone10min || n60 >= LIMITES_ENVIO.porTelefoneHora) motivo = `limite por contato (${tel}): ${n2} em 2 min, ${n10} em 10 min, ${n60} em 1 h`;
  if (!motivo) return null;
  await alertarEquipe(c, `TRAVA DE SEGURANÇA: envios automáticos bloqueados — ${motivo}. Verifique a conversa; nada mais será enviado a esse contato até a contagem baixar.`, "limite:" + (g10 >= LIMITES_ENVIO.global10min ? "geral" : tel) + ":" + Math.floor(agora / 3600000));
  return motivo;
}
async function registrarSaidaTaxa(c, to) {
  if (c.contingencia) return;
  try { await c.db.prepare("INSERT INTO d30_saidas(telefone,criado_ms) VALUES(?,?)").bind(digitos(to), c.agora()).run(); } catch (e) { console.warn("taxa", e?.message); }
}

async function alertarEquipe(c, texto, chave, casoId = null) {
  if (chave && !(await reservarChave(c, "alerta:" + chave))) return;
  // Teto de alertas por hora: o Telegram nunca vira uma enxurrada.
  const recentes = Number((await c.db.prepare("SELECT COUNT(*) n FROM d30_eventos WHERE tipo='ALERTA_EQUIPE' AND criado_ms > ?").bind(c.agora() - 3600000).first().catch(() => null))?.n || 0);
  await evento(c, casoId, "ALERTA_EQUIPE", texto);
  if (recentes >= LIMITE_ALERTAS_HORA) {
    if (await reservarChave(c, "alerta-teto:" + Math.floor(c.agora() / 3600000))) await c.saida.telegram(`DENIA — Muitos alertas nesta hora (${recentes}). Os próximos ficam só no registro; veja /api/saude.`);
    return;
  }
  const r = await c.saida.telegram("DENIA — " + texto);
  if (!r.ok) console.warn("Alerta não entregue:", r.erro);
}

// Envio ao cliente: respeita pausa humana, idempotência e grava no histórico.
async function enviarAoCliente(c, { tel, pessoaId, casoId, texto, chave, origem = "IA" }) {
  const t = String(texto || "").trim();
  if (!t) return { ok: false, vazio: true };
  if (await estaPausado(c, tel)) return { ok: false, pausado: true };
  if (chave && !(await reservarChave(c, "cli:" + chave))) return { ok: true, duplicado: true };
  const r = await c.saida.texto(tel, t, { papel: "cliente" });
  if (r.ok) await registrarMensagem(c, { pessoaId, casoId, wamid: r.id, direcao: "SAIDA", origem, conteudo: t });
  else {
    if (chave && !r.incerto) await liberarChave(c, "cli:" + chave);
    await evento(c, casoId, "FALHA_ENVIO_CLIENTE", r.erro, { tel: digitos(tel) });
  }
  return r;
}

// Envio ao prestador: horário 8h–21h, pausa humana, template fora da janela de 24h.
async function enviarAoPrestador(c, { consulta, caso, texto, chave, inicial = false }) {
  const to = consulta.prestador_tel;
  const t = ocultarTelefones(texto).trim();
  if (!dentroHorarioPrestador(c) || await estaPausado(c, to)) {
    await c.db.prepare("INSERT INTO d30_agendados(consulta_id,caso_id,para,texto,inicial,status,criado_ms) VALUES(?,?,?,?,?,'PENDENTE',?)")
      .bind(consulta.id, caso?.casoId || consulta.caso_id, to, t, inicial ? 1 : 0, c.agora()).run();
    return { ok: false, agendado: true };
  }
  return await enviarAgoraAoPrestador(c, { consulta, caso, texto: t, chave, inicial });
}
async function enviarAgoraAoPrestador(c, { consulta, caso, texto, chave, inicial }) {
  const to = consulta.prestador_tel;
  if (chave && !(await reservarChave(c, "pre:" + chave))) return { ok: true, duplicado: true };
  let r = await c.saida.texto(to, texto, { papel: "prestador", prestador: consulta.prestador_nome });
  const template = String(c.env.WHATSAPP_TEMPLATE_CONSULTA_TECNICO || "").trim();
  if (!r.ok && inicial && template && foraDaJanela(r)) {
    const k = caso || await carregarCasoPorId(c, consulta.caso_id);
    const f = k?.fatos || {};
    r = await c.saida.template(to, template, ["Cliente", f.servico || CATEGORIAS[consulta.area]?.rotulo || "Serviço", f.problema || f.servico || "-", f.bairro || "a confirmar", "#" + consulta.caso_id], { papel: "prestador" });
    if (r.ok) r.viaTemplate = true;
  }
  if (r.ok) {
    const p = await obterPessoa(c, to, consulta.prestador_nome, "TECNICO");
    await registrarMensagem(c, { pessoaId: p?.id, casoId: consulta.caso_id, wamid: r.id, direcao: "SAIDA", origem: "SISTEMA", conteudo: texto });
  } else {
    if (chave && !r.incerto) await liberarChave(c, "pre:" + chave);
    await evento(c, consulta.caso_id, "FALHA_ENVIO_PRESTADOR", r.erro, { para: to, codigo: r.codigo });
  }
  return r;
}

async function encaminharMidiasAoPrestador(c, consulta) {
  const r = await c.db.prepare("SELECT * FROM d30_midias WHERE caso_id=? AND comprovante=0 AND (enviado_para IS NULL OR enviado_para<>?) ORDER BY id LIMIT 5")
    .bind(consulta.caso_id, consulta.prestador_tel).all();
  for (const m of r?.results || []) {
    const e = await c.saida.midia(consulta.prestador_tel, { tipo: m.tipo, mediaId: m.media_id, legenda: `Enviado pelo cliente — caso #${consulta.caso_id}` }, { papel: "prestador" });
    if (e.ok) await c.db.prepare("UPDATE d30_midias SET enviado_para=? WHERE id=?").bind(consulta.prestador_tel, m.id).run();
    else await evento(c, consulta.caso_id, "FALHA_MIDIA_PRESTADOR", e.erro);
  }
}

// ============================================================================
// OPENAI
// ============================================================================

function modelo(env) { return String(env.OPENAI_MODEL || MODELO_PADRAO).trim(); }
async function openaiJSON(c, instrucoes, entrada, anexos = [], maxTokens = 1400) {
  const env = c.env;
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada.");
  const content = [{ type: "input_text", text: entrada }];
  for (const a of anexos.slice(0, 3)) {
    const url = `data:${a.mime};base64,${a.base64}`;
    if (a.mime.startsWith("image/")) content.push({ type: "input_image", image_url: url, detail: "auto" });
    else content.push({ type: "input_file", filename: a.nome || "documento.pdf", file_data: url });
  }
  const corpo = { model: modelo(env), instructions: instrucoes, input: [{ role: "user", content }], text: { format: { type: "json_object" } }, max_output_tokens: maxTokens, store: false };
  if (/^(gpt-5|o\d)/i.test(corpo.model)) corpo.reasoning = { effort: "low" };
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify(corpo), signal: AbortSignal.timeout(18000)
  });
  const bruto = await r.text();
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${bruto.slice(0, 300)}`);
  const d = JSON.parse(bruto);
  let saida = typeof d.output_text === "string" ? d.output_text : "";
  if (!saida) for (const item of d.output || []) for (const x of item.content || []) if (typeof x.text === "string") saida += x.text;
  const obj = lerJSON(saida);
  if (!obj || typeof obj !== "object") throw new Error("OpenAI não devolveu JSON válido.");
  return obj;
}
async function transcreverAudio(c, buffer, mime) {
  const f = new FormData();
  f.append("model", String(c.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe"));
  f.append("language", "pt");
  const ext = /mpeg|mp3/.test(mime) ? "mp3" : /wav/.test(mime) ? "wav" : /mp4|m4a|aac/.test(mime) ? "m4a" : "ogg";
  f.append("file", new Blob([buffer], { type: mime }), "audio." + ext);
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${c.env.OPENAI_API_KEY}` }, body: f, signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !String(d?.text || "").trim()) throw new Error(`Transcrição falhou (${r.status}).`);
  return String(d.text).trim();
}

// ============================================================================
// TREINAMENTO (versionado — nunca apaga sem confirmação)
// ============================================================================

let cacheTreinamento = null;
async function carregarTreinamento(c) {
  if (cacheTreinamento && c.agora() - cacheTreinamento.em < 60000) return cacheTreinamento.valor;
  let valor = null;
  try {
    const r = await c.db.prepare("SELECT versao,json,autor,criado_ms FROM d30_treinamento ORDER BY versao DESC LIMIT 1").first();
    if (r) valor = { versao: r.versao, dados: JSON.parse(r.json), autor: r.autor, criadoMs: r.criado_ms };
    else {
      let antigo = null;
      const leg = await c.db.prepare("SELECT treinamento_json FROM treinamento_ia WHERE empresa_id IN ('1',1) LIMIT 1").first().catch(() => null);
      if (leg?.treinamento_json) antigo = JSON.parse(leg.treinamento_json);
      if (!antigo && c.env.MEMORIA) { const kv = await c.env.MEMORIA.get("config:treinamento").catch(() => null); if (kv) antigo = JSON.parse(kv); }
      const dados = {};
      for (const k of CAMPOS_TREINAMENTO) dados[k] = String(antigo?.[k] ?? "");
      for (const [k, v] of Object.entries(antigo || {})) if (!(k in dados) && typeof v === "string") dados[k] = v;
      const ins = await c.db.prepare("INSERT INTO d30_treinamento(json,autor,criado_ms) VALUES(?,?,?) RETURNING versao").bind(JSON.stringify(dados), antigo ? "importado" : "inicial", c.agora()).first();
      valor = { versao: ins.versao, dados, autor: antigo ? "importado" : "inicial", criadoMs: c.agora() };
    }
  } catch (e) {
    console.error("treinamento D1:", e?.message);
    const kv = c.env.MEMORIA ? await c.env.MEMORIA.get("d30:treinamento").catch(() => null) : null;
    valor = kv ? JSON.parse(kv) : { versao: 0, dados: {}, autor: "", criadoMs: 0 };
  }
  cacheTreinamento = { em: c.agora(), valor };
  return valor;
}
async function salvarTreinamento(c, parcial, autor, confirmarVazio) {
  const atual = await carregarTreinamento(c);
  const novo = { ...atual.dados };
  for (const [k, v] of Object.entries(parcial || {})) {
    if (["__proto__", "constructor", "prototype", "confirmar_vazio"].includes(k)) continue;
    if (typeof v === "string") novo[k] = v.slice(0, 30000);
  }
  const esvaziados = Object.keys(atual.dados).filter(k => String(atual.dados[k] || "").trim() && !String(novo[k] || "").trim());
  if (esvaziados.length && !confirmarVazio) return { ok: false, codigo: "CONFIRMAR_VAZIO", campos: esvaziados };
  const ins = await c.db.prepare("INSERT INTO d30_treinamento(json,autor,criado_ms) VALUES(?,?,?) RETURNING versao").bind(JSON.stringify(novo), autor, c.agora()).first();
  const valor = { versao: ins.versao, dados: novo, autor, criadoMs: c.agora() };
  cacheTreinamento = { em: c.agora(), valor };
  if (c.env.MEMORIA) await c.env.MEMORIA.put("d30:treinamento", JSON.stringify(valor)).catch(() => { });
  await evento(c, null, "TREINAMENTO_VERSAO", `Versão ${ins.versao} por ${autor}`, { campos: Object.keys(parcial || {}) });
  return { ok: true, ...valor };
}
function formatarTreinamento(dados) {
  const blocos = [];
  for (const k of CAMPOS_TREINAMENTO) if (String(dados?.[k] || "").trim()) blocos.push(`${ROTULOS_TREINAMENTO[k]}:\n${String(dados[k]).trim()}`);
  for (const [k, v] of Object.entries(dados || {})) if (!CAMPOS_TREINAMENTO.includes(k) && String(v || "").trim()) blocos.push(`${k.toUpperCase()}:\n${String(v).trim()}`);
  return blocos.join("\n\n") || "(nenhum treinamento cadastrado)";
}

// ============================================================================
// MÍDIA RECEBIDA
// ============================================================================

async function prepararMidias(c, msgs) {
  const anexos = [], falhas = [];
  for (const m of msgs) {
    const legenda = txt(m.caption, 500);
    m.conteudo = txt(m.texto, 4000);
    if (!m.mediaId || c.sim) {
      if (m.tipo === "sticker") m.conteudo = "[Figurinha]";
      continue;
    }
    try {
      if (m.tipo === "audio") {
        const a = await metaBaixarMidia(c.env, m.mediaId);
        m.conteudo = "[Áudio transcrito] " + await transcreverAudio(c, a.buffer, a.mime);
      } else if (m.tipo === "image" || (m.tipo === "document" && /pdf|image/i.test(m.mime || ""))) {
        const a = await metaBaixarMidia(c.env, m.mediaId);
        anexos.push({ mime: a.mime, base64: base64(a.buffer), nome: m.filename || "arquivo", wamid: m.wamid });
        m.conteudo = (m.tipo === "image" ? "[Imagem]" : `[Documento ${m.filename || ""}]`) + (legenda ? " " + legenda : "");
      } else if (m.tipo === "video") {
        m.conteudo = await descreverVideo(c, m) || ("[Vídeo recebido — conteúdo não analisado automaticamente]" + (legenda ? " " + legenda : ""));
      } else if (m.tipo === "document") {
        m.conteudo = `[Documento ${m.filename || ""}]` + (legenda ? " " + legenda : "");
      } else if (m.tipo === "sticker") m.conteudo = "[Figurinha]";
    } catch (e) {
      falhas.push(`${m.tipo}: ${e?.message || e}`);
      m.conteudo = `[${m.tipo} recebido — não foi possível analisar]` + (legenda ? " " + legenda : "");
    }
  }
  return { anexos, falhas };
}
async function descreverVideo(c, m) {
  const url = String(c.env.VIDEO_PROCESSOR_URL || "").trim();
  if (!/^https:\/\//i.test(url) || !c.env.VIDEO_PROCESSOR_TOKEN) return "";
  const a = await metaBaixarMidia(c.env, m.mediaId);
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": a.mime, Authorization: `Bearer ${c.env.VIDEO_PROCESSOR_TOKEN}` }, body: a.buffer, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Processador de vídeo HTTP ${r.status}`);
  const v = await r.json();
  const quadros = (Array.isArray(v?.frames) ? v.frames : []).slice(0, 3).map(f => ({ mime: f.mimeType || "image/jpeg", base64: f.base64 }));
  if (!quadros.length) return "";
  const o = await openaiJSON(c, "Descreva objetivamente o que aparece nos quadros de um vídeo enviado para atendimento técnico. Não invente. Responda em JSON {\"descricao\":\"...\"}.", `Transcrição do áudio do vídeo: ${txt(v.transcricao, 3000)}`, quadros, 500);
  return "[Vídeo analisado] " + txt(o.descricao, 1500);
}

// ============================================================================
// GUARDA DAS RESPOSTAS AO CLIENTE (bloqueia invenções e promessas falsas)
// ============================================================================

const ETAPAS_COM_PRESTADOR = new Set(["AGUARDANDO_PRESTADOR", "AGUARDANDO_CLIENTE", "AGUARDANDO_ENDERECO", "AGUARDANDO_CONFIRMACAO_PRESTADOR", "AGENDADO"]);
const ETAPAS_COM_RESPOSTA_PRESTADOR = new Set(["AGUARDANDO_CLIENTE", "AGUARDANDO_ENDERECO", "AGUARDANDO_CONFIRMACAO_PRESTADOR", "AGENDADO"]);

// Assuntos de uma pergunta (para nunca perguntar a mesma coisa duas vezes).
function camposDaPergunta(frase) {
  const n = norm(frase);
  if (!/\?/.test(frase)) return [];
  const c = [];
  if (/\b(bairro|regiao|localizacao|em que local|qual local|onde (fica|sera|e o atendimento|voce mora))\b/.test(n)) c.push("bairro");
  if (/\bendereco\b/.test(n)) c.push("endereco");
  if (/(qual|que)\s+(e\s+o\s+)?(servico|tipo de servico)|o que (voce )?(precisa|deseja)\b/.test(n)) c.push("servico");
  if (/\b(seu nome|como (voce )?se chama)\b/.test(n)) c.push("nome");
  if (/\b(marca|modelo)\b/.test(n)) c.push("modelo");
  if (/\b(foto|fotos|video|imagem)\b/.test(n)) c.push("foto");
  if (/\b(dia|horario|data)\b/.test(n)) c.push("horario");
  return c;
}
function perguntasRecentes(hist, limite = 8) {
  const feitas = new Set();
  const saidas = hist.filter(m => String(m.direcao).toUpperCase() === "SAIDA" && String(m.origem).toUpperCase() !== "HUMANO").slice(-limite);
  for (const m of saidas) for (const f of String(m.conteudo || "").match(/[^.!?]+[.!?]*/g) || []) for (const k of camposDaPergunta(f)) feitas.add(k);
  // Bairro: no máximo uma vez em toda a conversa recente.
  for (const m of hist.filter(m => String(m.direcao).toUpperCase() === "SAIDA").slice(-30)) if (camposDaPergunta(m.conteudo || "").includes("bairro")) feitas.add("bairro");
  return feitas;
}

function fraseProibida(frase, g) {
  const n = norm(frase);
  for (const k of camposDaPergunta(frase)) if (g.perguntadas?.has(k)) return "pergunta já feita: " + k;
  for (const v of valoresMonetarios(frase)) if (!g.autorizados.has(v)) return "valor não autorizado";
  if (/\b(cpf|rg|cnpj)\b/.test(n) || /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(frase)) return "documento pessoal";
  if (/(\+?55[\s-]?)?\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}\b/.test(frase)) return "telefone";
  if (/\b(cancelad[oa]s?|cancelamos|cancelei)\b/.test(n) && g.etapa !== "CANCELADO" && !/\?/.test(frase)) return "cancelamento não confirmado";
  if (/\b(agendad[oa]|esta confirmad[oa]|ficou confirmad[oa]|confirmad[oa] para|confirmamos (o|a|seu|sua)|confirmei)\b/.test(n) && g.etapa !== "AGENDADO" && !/\?/.test(frase)) return "agendamento não confirmado";
  if (/\b(enviei|enviamos|encaminhei|encaminhamos|consultei|consultamos|repassei|repassamos|ja (falei|falamos|avisei|avisamos|contatei|contatamos))\b/.test(n) && !ETAPAS_COM_PRESTADOR.has(g.etapa)) return "ação não executada";
  if (/\b(vou|vamos|irei|iremos|ja vou)\b.{0,40}\b(consultar|verificar|falar|contatar|chamar|acionar|enviar|encaminhar|confirmar|perguntar)\b.{0,40}\b(profissional|tecnico|prestador)/.test(n) && !ETAPAS_COM_PRESTADOR.has(g.etapa)) return "promessa sem ação";
  if (/\b(o profissional|o tecnico|o prestador|ele|ela)\s+(faz|realiza|atende|aceitou|confirmou|pode ir|vai ate|consegue)\b/.test(n) && !ETAPAS_COM_RESPOSTA_PRESTADOR.has(g.etapa)) return "afirmação sobre prestador";
  if (/\b(atendemos|atende|cobrimos|vamos ate|vai ate|chegamos)\b.{0,40}\b(regiao|bairro|cidade|niteroi|sao goncalo|baixada|zona (sul|norte|oeste)|ai\b)/.test(n) && !g.regiaoConfirmada) return "cobertura não confirmada";
  if (/\bbairro\b/.test(n) && /\b(orcamento|valor|preco)\b/.test(n)) return "bairro como requisito de orçamento";
  if (g.modo === "BALCAO" && /\b(bairro|endereco)\b/.test(n) && /\?/.test(frase)) return "bairro em serviço de balcão";
  // Nunca perguntar de novo o que já está registrado no caso.
  if (/\?/.test(frase) && g.fatos) {
    if ((g.fatos.servico || g.fatos.problema) && /\b(qual|que)\s+(e\s+o\s+)?(servico|tipo de servico)|o que (voce )?(precisa|deseja)\b/.test(n)) return "pergunta repetida: serviço";
    if (g.fatos.bairro && /\bbairro\b/.test(n)) return "pergunta repetida: bairro";
    if (g.fatos.endereco && /\bendereco\b/.test(n)) return "pergunta repetida: endereço";
    if (g.nome && /\b(seu nome|como (voce )?se chama)\b/.test(n)) return "pergunta repetida: nome";
  }
  if (/\b(openai|gpt|cloudflare|worker|banco de dados|json|prompt|erro interno|d1|kv)\b/.test(n)) return "detalhe interno";
  return "";
}
function guardarResposta(texto, g) {
  const t = String(texto || "").replace(/\s+/g, " ").trim();
  if (!t) return { texto: "", removidas: [] };
  const frases = t.match(/[^.!?]+[.!?]*\s*/g) || [t];
  const removidas = [], mantidas = [];
  for (const f of frases) { const m = fraseProibida(f, g); if (m) removidas.push(`${m}: ${f.trim()}`); else mantidas.push(f.trim()); }
  let final = mantidas.join(" ").replace(/\s+/g, " ").trim();
  if (final.length > 480) final = (final.slice(0, 480).match(/^.*[.!?]/)?.[0] || final.slice(0, 477) + "...");
  return { texto: final, removidas };
}
function respostaPadraoEtapa(etapa) {
  if (etapa === "AGUARDANDO_PRESTADOR") return "Ainda aguardamos o retorno do profissional. Assim que ele responder, avisamos você.";
  if (etapa === "AGUARDANDO_CONFIRMACAO_PRESTADOR") return "Estamos aguardando a confirmação final do profissional e já retornamos.";
  return "Um momento, por favor.";
}

// ============================================================================
// PROMPTS
// ============================================================================

function descreverEtapa(caso, consulta) {
  if (!caso) return "Nenhum caso ativo. Se o cliente pedir um serviço, extraia os fatos.";
  const prop = consulta ? [consulta.disponibilidade ? `disponibilidade ${consulta.disponibilidade}` : "", consulta.valor_cliente ? `valor ${moeda(consulta.valor_cliente)}` : ""].filter(Boolean).join(", ") : "";
  switch (caso.etapa) {
    case "COLETANDO": return "Atendimento em andamento. O profissional AINDA NÃO foi consultado.";
    case "AGUARDANDO_PRESTADOR": return consulta?.status === "AGENDADA_ENVIO"
      ? "A consulta ao profissional será enviada no início do próximo expediente (a partir das 8h)."
      : "A solicitação JÁ foi enviada ao profissional e aguardamos o retorno dele. Se o cliente perguntar, diga que ainda aguardamos o retorno.";
    case "AGUARDANDO_CLIENTE": return `Enviamos ao cliente a proposta do profissional (${prop || "sem detalhes"}). Aguardamos o cliente aceitar, recusar ou pedir outro horário.`;
    case "AGUARDANDO_ENDERECO": return "O cliente aceitou a proposta. Falta o endereço completo para confirmarmos com o profissional.";
    case "AGUARDANDO_CONFIRMACAO_PRESTADOR": return `O cliente aceitou (${prop}). Aguardamos a confirmação FINAL do profissional. Não diga que está confirmado.`;
    case "AGENDADO": return `Atendimento CONFIRMADO pelo profissional (${prop}). Não recomece a coleta de dados.`;
    case "EQUIPE": return "A equipe interna está cuidando deste caso. Não prometa nada operacional; seja cordial.";
    default: return `Etapa ${caso.etapa}.`;
  }
}
function formatarFatos(f) {
  const r = { servico: "Serviço", categoria: "Categoria", problema: "Solicitação", marca: "Marca", modelo: "Modelo", bairro: "Bairro", cidade: "Cidade", endereco: "Endereço", preferencia_horario: "Preferência de horário", nome: "Nome" };
  const l = Object.entries(r).filter(([k]) => f?.[k]).map(([k, v]) => `${v}: ${f[k]}`);
  return l.length ? l.join("\n") : "(nenhum fato registrado)";
}

const INSTRUCOES_CLIENTE = `Você é a DENIA, assistente virtual responsável pelo atendimento digital da Central de Atendimento. Você conversa com CLIENTES pelo WhatsApp.

SEU PAPEL: você interpreta as mensagens e redige a resposta. Você NÃO executa ações. O sistema decide e executa (consultar profissional, enviar orçamento, agendar) com base nos fatos que você extrai. Portanto:
- Nunca diga que enviou, consultou, falou, avisou, repassou, agendou, confirmou ou cancelou algo, a menos que o ESTADO DO CASO diga que isso já aconteceu.
- Nunca invente preço, prazo, disponibilidade, diagnóstico, cobertura de região ou que um profissional faz certo serviço. Valores: somente os listados em VALORES AUTORIZADOS.
- Nunca peça ao cliente para escolher profissional. Nunca informe telefone, CPF ou dados de profissionais ou de outras pessoas. Não peça CPF.
- Bairro NÃO define preço: nunca diga que precisa do bairro para orçamento. Não pergunte bairro por iniciativa própria; o sistema e o profissional pedem quando for necessário. Nunca repita uma pergunta que você já fez nesta conversa, mesmo que o cliente não tenha respondido: siga em frente com o que ele disse.
- Serviços de BALCÃO: o cliente leva o equipamento à loja; nunca pergunte bairro ou endereço.
- Cancelamentos e reclamações: não decida; seja cordial e marque precisa_humano.
- Se não souber algo, não invente: diga "Um momento, por favor." e marque precisa_humano.

CLIENTE ANTIGO: veja o PERFIL DO CLIENTE e a FICHA NO SISTEMA. Se ele já foi atendido antes, trate-o como cliente conhecido: nunca como novo, não peça dados que já constam e lembre do que já foi feito quando for útil. Dados da FICHA são oficiais; nunca os contradiga e nunca os invente.

MEMÓRIA: o HISTÓRICO pode conter mensagens de outros casos do mesmo cliente (marcadas com #número); use as do caso ativo e só fale de outro caso se o cliente se referir a ele. Leia o ESTADO DO CASO, os FATOS e o HISTÓRICO antes de responder. Nunca pergunte algo que já está nos fatos ou no histórico. A informação mais recente vale mais. Uma resposta curta normalmente responde à última pergunta feita. Mensagens do ATENDENTE HUMANO fazem parte da conversa: continue de onde ele parou, sem repetir o que já foi combinado. Se o caso está AGENDADO ou concluído, não recomece a coleta; só é pedido novo quando o cliente pede claramente outro serviço.

ESTILO: escreva como as atendentes da equipe (veja COMO A EQUIPE FALA): humana, gentil e com empatia — se o cliente está com um problema, mostre que entende ("Poxa, imagino o transtorno") sem exagero; português do Brasil natural; responda primeiro ao que o cliente perguntou; mensagens CURTAS, 1 ou 2 frases; no máximo uma pergunta; retribua cumprimentos; não repita o nome do cliente, o bairro nem o que ele acabou de dizer; sem listas, sem markdown; nunca seco ou grosseiro; não mencione sistema, banco de dados ou modelo de IA. Se perguntarem quem é você: "Sou a assistente virtual responsável pelo atendimento digital."

COMO O SISTEMA AGE: quando o serviço está claro e o cliente quer orçamento, visita ou atendimento, o sistema consulta sozinho o profissional da categoria e avisa o cliente. Para isso basta preencher os fatos, quer_orcamento_ou_atendimento=true e pronto_para_profissional=true. Não é preciso bairro nem endereço para consultar.

Responda SOMENTE com um objeto JSON neste formato:
{"resposta":"","intencao":"CONVERSA","novo_pedido":false,"quer_orcamento_ou_atendimento":false,"pronto_para_profissional":false,"fatos":{"servico":"","categoria":"","problema":"","marca":"","modelo":"","bairro":"","cidade":"","endereco":"","preferencia_horario":"","nome":""},"categoria_confianca":"BAIXA","resposta_para_profissional":"","descricao_anexos":"","comprovante_pagamento":false,"precisa_humano":false,"motivo_humano":"","resumo_caso":""}

intencao: CONVERSA | NOVO_PEDIDO | ACEITA_PROPOSTA | RECUSA_PROPOSTA | PEDE_OUTRO_HORARIO | PEDE_ALTERACAO | PERGUNTA_PARA_PROFISSIONAL | PEDE_CANCELAMENTO | PERGUNTA_STATUS | AGRADECIMENTO | FALAR_COM_HUMANO.
- ACEITA_PROPOSTA/RECUSA_PROPOSTA/PEDE_OUTRO_HORARIO: só quando o cliente responde à proposta enviada (etapa AGUARDANDO_CLIENTE).
- PEDE_ALTERACAO: pedido de mudança em atendimento já combinado (ex.: chegar mais tarde, mudar o dia).
- PERGUNTA_PARA_PROFISSIONAL: o caso já tem PROFISSIONAL CONSULTADO e o cliente faz uma pergunta que só o profissional sabe responder (material incluso, garantia, tempo de serviço, como é feito, se faz algo a mais, valor de um item extra, detalhes técnicos) e a resposta NÃO está nos fatos, no histórico nem no treinamento. Junte TODAS as perguntas das mensagens novas em resposta_para_profissional, em uma frase objetiva. Na "resposta", diga só que vai confirmar com o profissional. A ponte cliente ↔ profissional continua enquanto o cliente tiver dúvidas.
- novo_pedido=true somente se o cliente pede um serviço DIFERENTE do caso ativo.
- fatos: apenas o que foi informado nas mensagens novas (ou correção); deixe "" o que não mudou.
- categoria: uma das CATEGORIAS, escolhida seguindo o TREINAMENTO DA EMPRESA (o treinamento manda). Aparelho ou eletrodoméstico com defeito (inclusive queimado por ligar em 110/220 V) NUNCA é ELETRICA. categoria_confianca: ALTA só quando não há nenhuma dúvida; senão MEDIA ou BAIXA (o caso vai para a equipe, sem errar o profissional).
- pronto_para_profissional: true quando já se sabe o que precisa ser feito e em qual item, o suficiente para um profissional dar valor e disponibilidade.
- resposta_para_profissional: preencha quando houver PERGUNTA DO PROFISSIONAL PENDENTE e as mensagens novas a respondem, ou quando a intencao for PEDE_ALTERACAO ou PERGUNTA_PARA_PROFISSIONAL; texto objetivo, sem dados pessoais.
- descricao_anexos: descrição objetiva das imagens/documentos anexados (leia textos visíveis). Se for comprovante de pagamento, comprovante_pagamento=true (isso não confirma o pagamento).
- resumo_caso: 1 ou 2 frases atualizadas sobre o caso ativo.`;

function montarEntradaCliente({ agora = Date.now(), treinamento, caso, consulta, autorizados, recentes, hist, novas, temAnexos, pessoa, perfil = "", estilo = "", ficha = "" }) {
  return `TREINAMENTO DA EMPRESA (siga sempre):
${formatarTreinamento(treinamento.dados)}

COMO A EQUIPE FALA (mensagens reais das atendentes; imite o tom e o tamanho, não o conteúdo):
${estilo || "(sem exemplos ainda)"}

PERFIL DO CLIENTE:
${perfil || "(cliente sem atendimentos anteriores registrados)"}

FICHA NO SISTEMA DE CADASTRO (dados oficiais):
${ficha || "(não disponível)"}

CATEGORIAS:
${Object.entries(CATEGORIAS).map(([k, v]) => `${k}: ${v.rotulo}`).join("\n")}

DATA E HORA ATUAL: ${dataHoraSP(agora)}
NOME DO CLIENTE NO CADASTRO: ${pessoa?.nome || "não informado"}

ESTADO DO CASO ATIVO${caso ? ` #${caso.casoId}` : ""}:
Etapa: ${caso?.etapa || "SEM CASO"} — ${descreverEtapa(caso, consulta)}
Modo: ${caso?.fatos?.categoria ? (CATEGORIAS[caso.fatos.categoria]?.modo || "") : "desconhecido"}
FATOS DO CASO:
${formatarFatos(caso?.fatos)}
Resumo: ${caso?.resumo || "-"}
${consulta?.pergunta_pendente ? `PERGUNTA DO PROFISSIONAL PENDENTE (já enviada ao cliente): ${consulta.pergunta_pendente}` : ""}

VALORES AUTORIZADOS: ${[...autorizados].map(moeda).join(", ") || "nenhum"}

OUTROS CASOS RECENTES DESTE CLIENTE:
${recentes.map(k => `#${k.casoId} (${k.etapa}): ${k.fatos?.servico || "-"} ${k.resumo ? "— " + k.resumo : ""}`).join("\n") || "(nenhum)"}

HISTÓRICO (mais antigo primeiro):
${hist}

MENSAGENS NOVAS DO CLIENTE:
${novas}
${temAnexos ? "\n(Há anexos de imagem/documento nesta mensagem; descreva-os em descricao_anexos.)" : ""}

Responda em JSON.`;
}

const INSTRUCOES_PRESTADOR = `Você trabalha na Central de Atendimento e está lendo a mensagem de um PROFISSIONAL PRESTADOR (não é cliente) sobre um caso específico. Sua tarefa é CLASSIFICAR a mensagem e extrair fatos. Não invente nada.

Responda SOMENTE com um objeto JSON:
{"tipo":"COMENTARIO","valor_centavos":0,"valor_e_final":"NAO_INFORMADO","disponibilidade":"","atende_regiao":"NAO_INFORMADO","pergunta_para_cliente":"","resposta_conhecida":"","mensagem_para_cliente":"","resumo":""}

tipo:
- ACEITA: pode fazer o serviço e informou valor e/ou disponibilidade (ou disse que faz).
- RECUSA: não pode, não faz ou não atende o local.
- PERGUNTA: precisa de uma informação do cliente (modelo, medidas, foto, bairro, endereço...). Escreva pergunta_para_cliente de forma educada e clara, como a central perguntaria ao cliente. Se a resposta estiver EXPLÍCITA nos FATOS DO CASO, escreva-a em resposta_conhecida.
- PEDE_CONTEXTO: não sabe de qual cliente/serviço se trata ("que cliente?", "verificar o quê?").
- CONFIRMA_AGENDAMENTO: confirma o atendimento/dia/horário combinado.
- RESPONDE: responde a um PEDIDO PENDENTE ou PERGUNTA DO CLIENTE (ex.: "sim, o material está incluso"), ou dá um aviso claro para o cliente sobre o atendimento (atraso, horário de chegada). Escreva mensagem_para_cliente em nome da central, educada, sem gírias, sem dados pessoais, sem inventar.
- COMENTARIO: qualquer outra coisa: comentário solto, exclamação, mensagem ambígua (ex.: "Eita, Niterói"). NA DÚVIDA, use COMENTARIO.
Campos:
- valor_centavos: SOMENTE se ele escreveu um valor em dinheiro NESTA mensagem (R$ 400 = 40000). Senão 0.
- valor_e_final: "SIM" se ele disse que o valor é o final para o cliente / já inclui a central; "NAO" se disse que é só a parte dele; senão "NAO_INFORMADO".
- disponibilidade: dia/horário exatamente como ele disse; senão "".
- atende_regiao: "SIM" ou "NAO" só se ele falou explicitamente sobre atender o local; senão "NAO_INFORMADO".`;

// ============================================================================
// FLUXO DO CLIENTE
// ============================================================================

function normalizarDecisaoCliente(o) {
  const intencoes = ["CONVERSA", "NOVO_PEDIDO", "ACEITA_PROPOSTA", "RECUSA_PROPOSTA", "PEDE_OUTRO_HORARIO", "PEDE_ALTERACAO", "PERGUNTA_PARA_PROFISSIONAL", "PEDE_CANCELAMENTO", "PERGUNTA_STATUS", "AGRADECIMENTO", "FALAR_COM_HUMANO"];
  const f = o?.fatos && typeof o.fatos === "object" ? o.fatos : {};
  const fatos = {};
  for (const k of ["servico", "categoria", "problema", "marca", "modelo", "bairro", "cidade", "endereco", "preferencia_horario", "nome"]) { const v = txt(f[k], 400); if (v) fatos[k] = v; }
  if (fatos.categoria && !CATEGORIAS[fatos.categoria]) delete fatos.categoria;
  const intencao = intencoes.includes(String(o?.intencao).toUpperCase()) ? String(o.intencao).toUpperCase() : "CONVERSA";
  return {
    resposta: txt(o?.resposta, 900), intencao, fatos, confianca: String(o?.categoria_confianca || "").toUpperCase(),
    novo_pedido: o?.novo_pedido === true, quer: o?.quer_orcamento_ou_atendimento === true, pronto: o?.pronto_para_profissional === true,
    resposta_para_profissional: txt(o?.resposta_para_profissional, 600), descricao_anexos: txt(o?.descricao_anexos, 1500),
    comprovante: o?.comprovante_pagamento === true, precisa_humano: o?.precisa_humano === true, motivo_humano: txt(o?.motivo_humano, 300),
    resumo: txt(o?.resumo_caso, 600)
  };
}

// "Botafogo" logo depois de "Qual o bairro?" é o bairro, mesmo que a IA não tenha anotado.
function capturarRespostaCurta(d, msgs, hist) {
  const ultima = [...hist].reverse().find(m => String(m.direcao).toUpperCase() === "SAIDA");
  if (!ultima) return;
  const texto = msgs.map(m => m.conteudo).join(" ").trim();
  if (!texto || texto.length > 160 || /\?/.test(texto) || ehMensagemSocial(texto) || msgs.some(m => m.mediaId)) return;
  const campos = camposDaPergunta(String(ultima.conteudo || "").split(/(?<=[.!?])\s+/).filter(f => /\?/.test(f)).pop() || "");
  const mapa = { bairro: "bairro", endereco: "endereco", nome: "nome", modelo: "modelo" };
  for (const k of campos) if (mapa[k] && !d.fatos[mapa[k]] && (k !== "bairro" || texto.length <= 60)) d.fatos[mapa[k]] = texto;
}

async function autorizadosParaCaso(c, consulta) {
  const treino = await carregarTreinamento(c);
  const s = new Set(valoresMonetarios(treino.dados?.precos || ""));
  if (consulta?.valor_cliente) s.add(Number(consulta.valor_cliente));
  return s;
}

async function processarCliente(c, tel, id, msgs, { apenasRegistrar, chaveLote }) {
  const nome = msgs.map(m => m.nome).filter(Boolean).pop() || "";
  const pessoa = id.pessoa || await obterPessoa(c, tel, nome, "CLIENTE");
  let { ativo: caso, recentes } = await carregarCasos(c, pessoa);
  const { anexos, falhas } = await prepararMidias(c, msgs);

  // 1) Tudo que chega é registrado, mesmo quando a DENIA não vai responder (uma vez só, mesmo se o lote for refeito).
  const jaRegistradas = new Set(((await c.db.prepare(`SELECT whatsapp_message_id w FROM mensagens WHERE whatsapp_message_id IN (${msgs.map(() => "?").join(",")})`).bind(...msgs.map(m => m.wamid)).all().catch(() => null))?.results || []).map(x => x.w));
  for (const m of msgs) if (!jaRegistradas.has(m.wamid)) await registrarMensagem(c, { pessoaId: pessoa.id, casoId: caso?.casoId, wamid: m.wamid, direcao: "ENTRADA", origem: "WHATSAPP", tipo: String(m.tipo || "text").toUpperCase(), conteudo: m.conteudo });

  if (apenasRegistrar) {
    await alertarEquipe(c, `Mensagens de ${pessoa.nome || tel} chegaram com mais de 15 min de atraso e NÃO foram respondidas automaticamente. Verifique a conversa.`, "atraso:" + chaveLote, caso?.casoId);
    return;
  }
  if (await estaPausado(c, tel)) return; // atendente humano na conversa

  const hist = await historico(c, pessoa.id);
  const novasIds = new Set(msgs.map(m => m.wamid));

  // 2) "ok", "obrigado" etc. não geram resposta quando não há pergunta pendente.
  const soSocial = msgs.every(m => !m.mediaId && ehMensagemSocial(m.conteudo));
  if (soSocial) {
    const ultimaSaida = [...hist].reverse().find(m => String(m.direcao).toUpperCase() === "SAIDA");
    const etapaPedeResposta = caso && ["AGUARDANDO_CLIENTE", "AGUARDANDO_ENDERECO"].includes(caso.etapa);
    if (!etapaPedeResposta && !/\?\s*$/.test(String(ultimaSaida?.conteudo || "").trim())) return;
  }

  let consulta = caso ? await consultaDoCaso(c, caso.casoId) : null;
  let autorizados = await autorizadosParaCaso(c, consulta);
  const treinamento = await carregarTreinamento(c);
  const novas = msgs.map(m => `- ${m.conteudo || "(vazio)"}`).join("\n");
  const [perfil, estilo, ficha] = await Promise.all([perfilCliente(c, pessoa), estiloDaEquipe(c), fichaCRM(c, tel)]);

  let d;
  try {
    const bruto = await openaiJSON(c, INSTRUCOES_CLIENTE, montarEntradaCliente({ agora: c.agora(), treinamento, caso, consulta, autorizados, recentes, hist: formatarHistorico(hist, "CLIENTE", novasIds), novas, temAnexos: anexos.length > 0, pessoa, perfil, estilo, ficha }), anexos);
    d = normalizarDecisaoCliente(bruto);
    capturarRespostaCurta(d, msgs, hist);
  } catch (e) {
    console.error("OpenAI cliente:", e?.message);
    await enviarAoCliente(c, { tel, pessoaId: pessoa.id, casoId: caso?.casoId, texto: "Um momento, por favor.", chave: chaveLote });
    await alertarEquipe(c, `Falha da IA ao responder ${pessoa.nome || tel}: ${txt(e?.message, 200)}. Cliente recebeu "Um momento, por favor."`, "ia:" + chaveLote, caso?.casoId);
    return;
  }
  // Chegou mensagem nova enquanto a IA pensava? Nada é feito agora: tudo será respondido junto.
  if (!c.sim && await chegouMensagemNova(c, tel, msgs.map(m => ({ recebido_ms: m.recebidoMs })))) throw new Adiar();
  if (falhas.length) await alertarEquipe(c, `Mídia de ${pessoa.nome || tel} não pôde ser analisada (${falhas.join("; ")}). Verifique a conversa.`, "midia:" + chaveLote, caso?.casoId);

  // 3) Caso: criar quando surge um pedido; mesclar fatos (o mais recente vale).
  const temFatos = Object.keys(d.fatos).some(k => k !== "nome");
  const temPedido = Boolean(d.fatos.servico || d.fatos.problema);
  if ((!caso && (temFatos || d.quer)) || (caso && d.novo_pedido && temPedido)) {
    caso = await criarCaso(c, pessoa, d.fatos);
    consulta = null; // um caso novo nunca herda a consulta de outro caso
    autorizados = await autorizadosParaCaso(c, null);
    for (const m of msgs) await c.db.prepare("UPDATE mensagens SET caso_id=? WHERE whatsapp_message_id=?").bind(caso.casoId, m.wamid).run();
  } else if (caso) {
    caso.fatos = { ...caso.fatos, ...d.fatos };
  }
  if (d.fatos.nome && !pessoa.nome) await c.db.prepare("UPDATE pessoas SET nome=? WHERE id=?").bind(d.fatos.nome, pessoa.id).run();
  if (caso) {
    if (!(consulta && caso.fatos.categoria)) caso.fatos.categoria = definirCategoria(caso.fatos, d.fatos.categoria, d.confianca);
    if (d.resumo) caso.resumo = d.resumo;
    await salvarCaso(c, caso);
  }
  if (d.descricao_anexos) {
    const alvo = msgs.find(m => anexos.some(a => a.wamid === m.wamid));
    if (alvo) await c.db.prepare("UPDATE mensagens SET conteudo=? WHERE whatsapp_message_id=?").bind(`${alvo.conteudo} — ${d.descricao_anexos}`, alvo.wamid).run();
  }
  for (const m of msgs) {
    if (m.mediaId && ["image", "video", "document"].includes(m.tipo)) {
      await c.db.prepare("INSERT INTO d30_midias(caso_id,telefone,media_id,tipo,mime,legenda,comprovante,criado_ms) VALUES(?,?,?,?,?,?,?,?)")
        .bind(caso?.casoId || null, tel, m.mediaId, m.tipo, m.mime || "", txt(m.caption, 300), d.comprovante ? 1 : 0, c.agora()).run();
    }
  }
  if (d.comprovante) await alertarEquipe(c, `Comprovante de pagamento recebido de ${pessoa.nome || tel}${caso ? ` (caso #${caso.casoId})` : ""}. Conferir.`, "comprovante:" + chaveLote, caso?.casoId);

  // 4) Decisão determinística.
  const acao = await decidirCliente(c, { tel, pessoa, caso, consulta, d, chaveLote });
  let texto = acao.texto;
  if (!acao.fixa) {
    const g = { etapa: caso?.etapa || "SEM_CASO", autorizados, modo: CATEGORIAS[caso?.fatos?.categoria]?.modo || "", regiaoConfirmada: caso?.fatos?.regiao_confirmada === "SIM", fatos: caso && !ETAPAS_ENCERRADAS.has(caso.etapa) ? caso.fatos : null, nome: pessoa.nome, perguntadas: perguntasRecentes(hist) };
    const r = guardarResposta(d.resposta, g);
    if (r.removidas.length) await evento(c, caso?.casoId, "RESPOSTA_CORRIGIDA", r.removidas.join(" | "));
    texto = r.texto || respostaPadraoEtapa(caso?.etapa);
  }
  if (!texto) return;
  const ultimaDenia = [...hist].reverse().find(m => String(m.direcao).toUpperCase() === "SAIDA" && String(m.origem).toUpperCase() !== "HUMANO");
  if (!acao.fixa && ultimaDenia && norm(ultimaDenia.conteudo) === norm(texto)) return; // não repetir a mesma frase
  await enviarAoCliente(c, { tel, pessoaId: pessoa.id, casoId: caso?.casoId, texto, chave: chaveLote });
}

async function decidirCliente(c, { tel, pessoa, caso, consulta, d, chaveLote }) {
  const nomeCli = pessoa.nome || tel;
  if (d.intencao === "PEDE_CANCELAMENTO") {
    await alertarEquipe(c, `${nomeCli} pediu CANCELAMENTO${caso ? ` do caso #${caso.casoId}` : ""}. Nada foi cancelado automaticamente.`, "cancel:" + chaveLote, caso?.casoId);
    return { texto: "Certo. Vamos verificar com a equipe e já retornamos.", fixa: true };
  }
  if (d.intencao === "FALAR_COM_HUMANO") {
    await alertarEquipe(c, `${nomeCli} pediu para falar com um atendente${caso ? ` (caso #${caso.casoId})` : ""}.`, "humano:" + chaveLote, caso?.casoId);
    return { texto: "Claro! Um atendente vai dar continuidade por aqui.", fixa: true };
  }
  if (d.precisa_humano) await alertarEquipe(c, `Atenção na conversa de ${nomeCli}${caso ? ` (caso #${caso.casoId})` : ""}: ${d.motivo_humano || "IA pediu apoio"}.`, "apoio:" + chaveLote, caso?.casoId);
  if (!caso) return { texto: d.resposta };

  // Resposta do cliente a uma pergunta do profissional.
  if (consulta?.pergunta_pendente && d.resposta_para_profissional) {
    const r = await enviarAoPrestador(c, { consulta, caso, texto: `Caso #${caso.casoId} — resposta do cliente: ${d.resposta_para_profissional}`, chave: "resp:" + chaveLote });
    if (r.ok || r.agendado) { await atualizarConsulta(c, consulta.id, { pergunta_pendente: null }); return { texto: "Obrigado! Vamos repassar ao profissional.", fixa: true }; }
    await alertarEquipe(c, `Não foi possível repassar ao profissional a resposta do cliente (caso #${caso.casoId}): ${r.erro}`, "falha-resp:" + chaveLote, caso.casoId);
    return { texto: "Um momento, por favor.", fixa: true };
  }

  // Ponte cliente → profissional: dúvida que só o profissional responde.
  if (d.intencao === "PERGUNTA_PARA_PROFISSIONAL" && consulta && d.resposta_para_profissional && ETAPAS_COM_PRESTADOR.has(caso.etapa)) {
    const pergunta = d.resposta_para_profissional;
    const r = await enviarAoPrestador(c, { consulta, caso, texto: `Caso #${caso.casoId} — o cliente perguntou: ${pergunta}`, chave: "pergcli:" + chaveLote });
    if (r.ok || r.agendado) {
      const anterior = String(consulta.pedido_pendente || "").startsWith("PERGUNTA DO CLIENTE:") ? consulta.pedido_pendente + " / " : "PERGUNTA DO CLIENTE: ";
      await atualizarConsulta(c, consulta.id, { pedido_pendente: txt(anterior + pergunta, 900) });
      return { texto: r.agendado ? "Boa pergunta! Vou confirmar com o profissional a partir das 8h e te respondo." : "Boa pergunta! Vou confirmar com o profissional e já te respondo.", fixa: true };
    }
    await alertarEquipe(c, `Não consegui levar ao profissional a pergunta do cliente (caso #${caso.casoId}): "${txt(pergunta, 200)}". ${r.erro || ""}`, "falha-pergcli:" + chaveLote, caso.casoId);
    return { texto: "Um momento, por favor.", fixa: true };
  }

  // Cliente respondendo à proposta.
  if (caso.etapa === "AGUARDANDO_CLIENTE" || caso.etapa === "AGUARDANDO_ENDERECO") {
    if (d.intencao === "ACEITA_PROPOSTA" || (caso.etapa === "AGUARDANDO_ENDERECO" && caso.fatos.endereco)) return await clienteAceitou(c, caso, consulta, chaveLote);
    if (d.intencao === "PEDE_OUTRO_HORARIO" && consulta) {
      const pref = d.fatos.preferencia_horario || d.resposta_para_profissional || "outro dia/horário";
      const r = await enviarAoPrestador(c, { consulta, caso, texto: `Caso #${caso.casoId}: o cliente pediu outra opção de horário (${pref}). Qual outra disponibilidade você tem?`, chave: "horario:" + chaveLote });
      if (r.ok || r.agendado) {
        await atualizarConsulta(c, consulta.id, { status: "ENVIADA", pedido_pendente: `outro horário: ${pref}` });
        await mudarEtapa(c, caso, "AGUARDANDO_PRESTADOR");
        return { texto: r.agendado ? "Certo! Verificamos outro horário com o profissional a partir das 8h e retornamos." : "Certo! Vamos verificar outro horário com o profissional e retornamos.", fixa: true };
      }
      return { texto: "Um momento, por favor.", fixa: true };
    }
    if (d.intencao === "RECUSA_PROPOSTA") await alertarEquipe(c, `${nomeCli} recusou a proposta do caso #${caso.casoId}. Avaliar.`, "recusa:" + chaveLote, caso.casoId);
    return { texto: d.resposta };
  }

  // Alteração de algo já combinado.
  if (d.intencao === "PEDE_ALTERACAO" && consulta && ["AGENDADO", "AGUARDANDO_CONFIRMACAO_PRESTADOR"].includes(caso.etapa)) {
    const pedido = d.resposta_para_profissional || "o cliente pediu uma alteração no atendimento";
    const r = await enviarAoPrestador(c, { consulta, caso, texto: `Caso #${caso.casoId}: ${pedido}. Consegue?`, chave: "alter:" + chaveLote });
    if (r.ok || r.agendado) { await atualizarConsulta(c, consulta.id, { pedido_pendente: pedido }); return { texto: "Vamos verificar com o profissional e já retornamos.", fixa: true }; }
    return { texto: "Um momento, por favor.", fixa: true };
  }

  // Mídia nova num caso que já está com o prestador.
  if (consulta && consulta.message_id && ETAPAS_COM_PRESTADOR.has(caso.etapa)) await encaminharMidiasAoPrestador(c, consulta);

  if (caso.etapa === "COLETANDO" && d.quer && d.pronto) {
    const r = await consultarPrestador(c, caso, pessoa, chaveLote);
    if (r) return r;
  }
  return { texto: d.resposta };
}

async function consultarPrestador(c, caso, pessoa, chaveLote) {
  const area = caso.fatos.categoria;
  const nomeCli = pessoa.nome || caso.telefone;
  if (!caso.fatos.servico && !caso.fatos.problema) return null;
  if (area === "BALCAO") {
    await alertarEquipe(c, `${nomeCli} quer orçamento de balcão (caso #${caso.casoId}): ${caso.fatos.servico || caso.fatos.problema}.`, "balcao:" + caso.casoId, caso.casoId);
    return null;
  }
  if (!area) {
    await alertarEquipe(c, `Caso #${caso.casoId} (${nomeCli}): não tenho certeza de qual profissional atende "${txt(caso.fatos.servico || caso.fatos.problema, 120)}". Nenhum prestador foi consultado — a equipe decide.`, "semcat:" + caso.casoId, caso.casoId);
    return null;
  }
  if (await consultaDoCaso(c, caso.casoId)) return null; // nunca duplicar consulta
  const tentados = new Set(((await c.db.prepare("SELECT prestador_id FROM d30_consultas WHERE caso_id=?").bind(caso.casoId).all())?.results || []).map(x => x.prestador_id));
  const p = PRESTADORES.find(x => x.area === area && !tentados.has(x.id));
  if (!p) {
    await mudarEtapa(c, caso, "EQUIPE");
    await alertarEquipe(c, `Sem prestador disponível para ${CATEGORIAS[area]?.rotulo} (caso #${caso.casoId}, cliente ${nomeCli}). A equipe precisa assumir.`, "semprest:" + caso.casoId, caso.casoId);
    return { texto: "Um momento, por favor.", fixa: true };
  }
  const agora = c.agora();
  const ins = await c.db.prepare(`INSERT INTO d30_consultas(caso_id,cliente_id,cliente_tel,prestador_id,prestador_tel,prestador_nome,area,status,criado_ms,atualizado_ms)
    VALUES(?,?,?,?,?,?,?,'ENVIANDO',?,?) RETURNING *`).bind(caso.casoId, pessoa.id, caso.telefone, p.id, telefoneDestinoPrestador(c, p), p.nome, area, agora, agora).first();
  const f = caso.fatos;
  const falas = ((await c.db.prepare("SELECT conteudo FROM mensagens WHERE caso_id=? AND direcao='ENTRADA' ORDER BY id DESC LIMIT 4").bind(caso.casoId).all())?.results || [])
    .map(x => ocultarTelefones(txt(x.conteudo, 200))).filter(t => t && !ehMensagemSocial(t)).reverse();
  const linhas = [
    `Olá, ${primeiroNome(p.nome)}! Aqui é a Central de Atendimento.`,
    `Caso #${caso.casoId} — ${CATEGORIAS[area].rotulo.split(" (")[0]}`,
    `Solicitação: ${f.problema || f.servico}`,
    falas.length ? `Nas palavras do cliente: "${falas.join(" / ")}"` : "",
    f.marca || f.modelo ? `Marca/modelo: ${[f.marca, f.modelo].filter(Boolean).join(" ")}` : "",
    f.bairro ? `Local: ${[f.bairro, f.cidade].filter(Boolean).join(", ")}` : "",
    `Você realiza esse serviço${f.bairro ? " e atende essa região" : ""}? Se sim, por favor informe o valor (e se é o valor final para o cliente ou só a sua parte) e sua disponibilidade.`
  ].filter(Boolean);
  const r = await enviarAoPrestador(c, { consulta: ins, caso, texto: linhas.join("\n"), chave: `consulta:${ins.id}`, inicial: true });
  if (r.ok) {
    await atualizarConsulta(c, ins.id, { status: "ENVIADA", message_id: r.id });
    await mudarEtapa(c, caso, "AGUARDANDO_PRESTADOR");
    if (!r.viaTemplate) await encaminharMidiasAoPrestador(c, { ...ins, message_id: r.id });
    await evento(c, caso.casoId, "CONSULTA_ENVIADA", `${p.nome} (${p.area})`, { messageId: r.id });
    return { texto: "Enviamos sua solicitação ao profissional. Assim que ele responder, retornamos com o valor e a disponibilidade.", fixa: true };
  }
  if (r.agendado) {
    await atualizarConsulta(c, ins.id, { status: "AGENDADA_ENVIO" });
    await mudarEtapa(c, caso, "AGUARDANDO_PRESTADOR");
    return { texto: "Vamos consultar o profissional no início do próximo expediente, a partir das 8h, e retornamos com o valor e a disponibilidade.", fixa: true };
  }
  await atualizarConsulta(c, ins.id, { status: "FALHA" });
  const semTemplate = foraDaJanela(r) && !c.env.WHATSAPP_TEMPLATE_CONSULTA_TECNICO;
  await alertarEquipe(c, `Não consegui enviar a consulta do caso #${caso.casoId} para ${p.nome}: ${r.erro}${semTemplate ? " — o prestador está fora da janela de 24h e não há template aprovado configurado (WHATSAPP_TEMPLATE_CONSULTA_TECNICO)." : ""}`, "falha-consulta:" + ins.id, caso.casoId);
  return { texto: "Um momento, por favor.", fixa: true };
}

async function clienteAceitou(c, caso, consulta, chaveLote) {
  if (!consulta) return { texto: "Um momento, por favor.", fixa: true };
  if (CATEGORIAS[consulta.area]?.modo === "DOMICILIO" && !caso.fatos.endereco) {
    await mudarEtapa(c, caso, "AGUARDANDO_ENDERECO");
    return { texto: "Ótimo! Para confirmarmos com o profissional, qual é o endereço completo do atendimento?", fixa: true };
  }
  const partes = [`Caso #${caso.casoId}: o cliente aprovou`];
  if (consulta.valor_prestador) partes.push(`o valor de ${moeda(consulta.valor_prestador)}`);
  if (consulta.disponibilidade) partes.push(`para ${consulta.disponibilidade}`);
  const texto = `${partes.join(" ")}.${caso.fatos.endereco ? `\nEndereço: ${caso.fatos.endereco}${caso.fatos.bairro ? ` — ${caso.fatos.bairro}` : ""}` : ""}\n${consulta.disponibilidade ? "Pode confirmar o atendimento?" : "Qual dia e horário você pode atender?"}`;
  const r = await enviarAoPrestador(c, { consulta, caso, texto, chave: "aceite:" + chaveLote });
  if (r.ok || r.agendado) {
    await atualizarConsulta(c, consulta.id, { status: "AGUARDANDO_CONFIRMACAO" });
    await mudarEtapa(c, caso, "AGUARDANDO_CONFIRMACAO_PRESTADOR");
    return { texto: r.agendado ? "Perfeito! Confirmamos com o profissional a partir das 8h e retornamos." : "Perfeito! Vamos confirmar com o profissional e já retornamos.", fixa: true };
  }
  await alertarEquipe(c, `Cliente aprovou o caso #${caso.casoId}, mas a confirmação não chegou ao profissional (${r.erro}). Fazer manualmente.`, "falha-aceite:" + chaveLote, caso.casoId);
  return { texto: "Um momento, por favor.", fixa: true };
}

// ============================================================================
// FLUXO DO PRESTADOR
// ============================================================================

function resumoParaPrestador(caso, consulta) {
  const f = caso.fatos || {};
  return [`Caso #${caso.casoId} — ${CATEGORIAS[consulta.area]?.rotulo.split(" (")[0] || f.servico || ""}`,
    `Solicitação: ${f.problema || f.servico || "-"}`,
    f.marca || f.modelo ? `Marca/modelo: ${[f.marca, f.modelo].filter(Boolean).join(" ")}` : "",
    f.bairro ? `Local: ${f.bairro}` : "",
    consulta.status === "ENVIADA" ? "Você realiza esse serviço? Se sim, informe o valor e sua disponibilidade." : ""].filter(Boolean).join("\n");
}

async function processarPrestador(c, tel, id, msgs, { apenasRegistrar, chaveLote }) {
  const prest = id.prestador;
  const pessoa = id.pessoa || await obterPessoa(c, tel, prest?.nome || msgs[0]?.nome, "TECNICO");
  const { anexos } = await prepararMidias(c, msgs);
  const textoTodo = msgs.map(m => m.conteudo).join("\n");

  // Vincular ao caso: 1) resposta a uma mensagem nossa  2) "#N"  3) única consulta aberta.
  const abertas = await consultasAbertasPrestador(c, tel);
  let consulta = null;
  for (const m of msgs) {
    if (!m.contextId) continue;
    const ref = await c.db.prepare("SELECT caso_id FROM mensagens WHERE whatsapp_message_id=? LIMIT 1").bind(m.contextId).first();
    consulta = abertas.find(x => x.caso_id === ref?.caso_id) || consulta;
  }
  const num = textoTodo.match(/(?:caso|#)\s*#?\s*(\d{1,9})\b/i);
  if (!consulta && num) consulta = abertas.find(x => String(x.caso_id) === num[1]) || null;
  if (!consulta && abertas.length === 1) consulta = abertas[0];

  for (const m of msgs) await registrarMensagem(c, { pessoaId: pessoa?.id, casoId: consulta?.caso_id, wamid: m.wamid, direcao: "ENTRADA", origem: "WHATSAPP", tipo: String(m.tipo || "text").toUpperCase(), conteudo: m.conteudo });
  if (apenasRegistrar || await estaPausado(c, tel)) return;
  if (!prest && !abertas.length) return;

  if (!consulta && abertas.length > 1) {
    const casos = await Promise.all(abertas.slice(0, 5).map(x => carregarCasoPorId(c, x.caso_id)));
    const lista = casos.filter(Boolean).map(k => `#${k.casoId} (${k.fatos.servico || k.fatos.problema || "-"}${k.fatos.bairro ? ", " + k.fatos.bairro : ""})`).join("; ");
    await enviarAgoraAoPrestador(c, { consulta: { ...abertas[0], caso_id: null }, texto: `Obrigado! Temos mais de um atendimento com você: ${lista}. Pode me dizer o número do caso a que se refere?`, chave: "qual:" + chaveLote });
    return;
  }
  if (!consulta) return; // mensagem solta de prestador: só registra (a equipe vê no app)

  const caso = await carregarCasoPorId(c, consulta.caso_id);
  if (!caso) return;
  const histCaso = (await historico(c, pessoa?.id, 30)).filter(m => m.caso_id === caso.casoId);
  const ultimaNossa = [...histCaso].reverse().find(m => String(m.direcao).toUpperCase() === "SAIDA" && !msgs.some(x => x.wamid === m.whatsapp_message_id));
  let d;
  try {
    d = await openaiJSON(c, INSTRUCOES_PRESTADOR, `CASO #${caso.casoId} — etapa ${caso.etapa}; consulta ${consulta.status}
FATOS DO CASO:
${formatarFatos(caso.fatos)}
${consulta.valor_prestador ? `Valor já informado por ele: ${moeda(consulta.valor_prestador)} (final para o cliente: ${consulta.valor_final || "não informado"})` : ""}
${consulta.disponibilidade ? `Disponibilidade já informada: ${consulta.disponibilidade}` : ""}
${consulta.pedido_pendente ? `PEDIDO PENDENTE DO CLIENTE (responda a ele com RESPONDE e mensagem_para_cliente): ${consulta.pedido_pendente}` : ""}
ÚLTIMA MENSAGEM QUE ENVIAMOS A ELE: ${ultimaNossa?.conteudo || "-"}

HISTÓRICO DESTE CASO COM O PROFISSIONAL:
${formatarHistorico(histCaso, "PROFISSIONAL", new Set(msgs.map(m => m.wamid)))}

MENSAGEM NOVA DO PROFISSIONAL:
${textoTodo}

Responda em JSON.`, anexos, 700);
  } catch (e) {
    await alertarEquipe(c, `Falha da IA ao ler a resposta de ${consulta.prestador_nome} (caso #${caso.casoId}): "${txt(textoTodo, 300)}". Tratar manualmente.`, "ia-prest:" + chaveLote, caso.casoId);
    return;
  }
  await tratarRespostaPrestador(c, { caso, consulta, d, textoTodo, chaveLote });
}

async function tratarRespostaPrestador(c, { caso, consulta, d, textoTodo, chaveLote }) {
  let tipo = String(d?.tipo || "COMENTARIO").toUpperCase();
  const cliente = await c.db.prepare("SELECT id,nome,telefone FROM pessoas WHERE id=?").bind(caso.clienteId).first();
  const telCliente = cliente?.telefone || caso.telefone;
  const responder = (texto, k) => enviarAgoraAoPrestador(c, { consulta, caso, texto, chave: k + ":" + chaveLote });
  const avisarCliente = async (texto, k) => {
    const r = await enviarAoCliente(c, { tel: telCliente, pessoaId: cliente?.id, casoId: caso.casoId, texto, chave: k + ":" + chaveLote, origem: "SISTEMA" });
    if (!r.ok && !r.duplicado) await alertarEquipe(c, `Retorno do profissional no caso #${caso.casoId} NÃO foi enviado ao cliente (${r.pausado ? "atendente está na conversa" : r.erro}). Mensagem que seria enviada: "${texto}"`, "falha-cli:" + k + ":" + chaveLote, caso.casoId);
    return r;
  };

  // Valor só conta se aparece literalmente na mensagem dele.
  let valor = Math.round(Number(d?.valor_centavos || 0));
  if (valor > 0 && !valoresNoTexto(textoTodo).includes(valor)) valor = 0;
  const finalInf = ["SIM", "NAO"].includes(String(d?.valor_e_final).toUpperCase()) ? String(d.valor_e_final).toUpperCase() : "";
  const disp = txt(d?.disponibilidade, 200);
  // Respostas curtas a perguntas nossas ("só minha parte", "confirmado") contam como continuação.
  if (consulta.status === "AGUARDANDO_COMPOSICAO" && finalInf && !["RECUSA", "PEDE_CONTEXTO"].includes(tipo)) tipo = "ACEITA";
  if (caso.etapa === "AGUARDANDO_CONFIRMACAO_PRESTADOR" && tipo === "COMENTARIO" && /\b(confirmad[oa]|confirmo|fechado|combinado|pode deixar|ok)\b/.test(norm(textoTodo))) tipo = "CONFIRMA_AGENDAMENTO";
  if (d?.atende_regiao === "SIM") { caso.fatos.regiao_confirmada = "SIM"; await salvarCaso(c, caso); }
  // Mais de um valor na mesma mensagem (ex.: "400 ou 500", "visita 80 e serviço 300"): confirmar antes de passar.
  const candidatos = [...new Set(valoresCandidatos(textoTodo))];
  if (candidatos.length > 1 && ["ACEITA", "CONFIRMA_AGENDAMENTO"].includes(tipo) && caso.etapa !== "AGUARDANDO_CONFIRMACAO_PRESTADOR") {
    if (!(await reservarChave(c, "multivalor:" + consulta.id))) {
      await alertarEquipe(c, `${consulta.prestador_nome} (caso #${caso.casoId}) informou valores que não consegui confirmar com certeza: "${txt(textoTodo, 250)}". Nada foi passado ao cliente — confirme manualmente.`, "valor-incerto:" + consulta.id, caso.casoId);
      return;
    }
    await atualizarConsulta(c, consulta.id, { status: "AGUARDANDO_COMPOSICAO", valor_prestador: null, disponibilidade: disp || consulta.disponibilidade });
    await responder(`Para eu passar ao cliente sem erro: qual é o valor TOTAL do serviço (${candidatos.map(moeda).join(" ou ")}…)? E ele é o valor final para o cliente ou só a sua parte?`, "multivalor");
    return;
  }

  if (tipo === "PEDE_CONTEXTO") { await responder(resumoParaPrestador(caso, consulta), "ctx"); return; }

  if (tipo === "RECUSA" || d?.atende_regiao === "NAO") {
    await atualizarConsulta(c, consulta.id, { status: "RECUSADA" });
    await responder("Tudo bem, obrigado pelo retorno!", "recusa");
    await evento(c, caso.casoId, "PRESTADOR_RECUSOU", consulta.prestador_nome);
    if (["AGENDADO", "AGUARDANDO_CONFIRMACAO_PRESTADOR"].includes(caso.etapa)) {
      await mudarEtapa(c, caso, "EQUIPE");
      await alertarEquipe(c, `${consulta.prestador_nome} desistiu/recusou o caso #${caso.casoId}, que já estava ${caso.etapa}. Cliente NÃO foi avisado. Assumir.`, "desist:" + consulta.id, caso.casoId);
      return;
    }
    caso.etapa = "COLETANDO";
    await salvarCaso(c, caso);
    const pessoa = cliente || { id: caso.clienteId, telefone: telCliente };
    await consultarPrestador(c, caso, pessoa, chaveLote);
    return;
  }

  if (tipo === "PERGUNTA") {
    const conhecida = txt(d?.resposta_conhecida, 400);
    if (conhecida) { await responder(`Caso #${caso.casoId}: ${conhecida}`, "conhecida"); return; }
    const pergunta = txt(d?.pergunta_para_cliente, 300);
    if (!pergunta) return;
    const r = await avisarCliente(pergunta, "pergunta");
    if (r.ok) { await atualizarConsulta(c, consulta.id, { pergunta_pendente: pergunta }); await responder("Vou confirmar com o cliente e já retorno.", "perg-ok"); }
    return;
  }

  if (tipo === "RESPONDE") {
    const g = { etapa: caso.etapa, autorizados: await autorizadosParaCaso(c, consulta), modo: "", regiaoConfirmada: true };
    const m = guardarResposta(d?.mensagem_para_cliente, g).texto;
    if (m) { const r = await avisarCliente(m, "responde"); if (r.ok) await atualizarConsulta(c, consulta.id, { pedido_pendente: null }); }
    return;
  }

  if (tipo === "CONFIRMA_AGENDAMENTO" || tipo === "ACEITA") {
    if (caso.etapa === "AGUARDANDO_CONFIRMACAO_PRESTADOR") {
      const novaData = disp && norm(disp) !== norm(consulta.disponibilidade || "");
      if (novaData && consulta.disponibilidade) {
        // Propôs outro horário: volta ao cliente.
        await atualizarConsulta(c, consulta.id, { disponibilidade: disp, status: "RESPONDIDA" });
        const r = await avisarCliente(`O profissional propôs ${disp}. Podemos confirmar?`, "novohorario");
        if (r.ok) await mudarEtapa(c, caso, "AGUARDANDO_CLIENTE");
        return;
      }
      const dataFinal = disp || consulta.disponibilidade;
      if (!dataFinal) { await responder(`Caso #${caso.casoId}: qual dia e horário ficou confirmado?`, "qualdata"); return; }
      if (!consulta.disponibilidade && disp && tipo === "ACEITA") {
        await atualizarConsulta(c, consulta.id, { disponibilidade: disp, status: "RESPONDIDA" });
        const r = await avisarCliente(`O profissional pode atender ${disp}. Podemos confirmar?`, "data");
        if (r.ok) await mudarEtapa(c, caso, "AGUARDANDO_CLIENTE");
        return;
      }
      await atualizarConsulta(c, consulta.id, { status: "CONFIRMADA", disponibilidade: dataFinal });
      const r = await avisarCliente(`Atendimento confirmado pelo profissional: ${dataFinal}.${consulta.valor_cliente ? ` Valor: ${moeda(consulta.valor_cliente)}.` : ""}`, "confirmado");
      await mudarEtapa(c, caso, "AGENDADO");
      await responder("Obrigado! Agendamento confirmado com o cliente.", "conf-ok");
      await alertarEquipe(c, [
        "SERVIÇO AGENDADO", `Caso: #${caso.casoId}`, `Cliente: ${cliente?.nome || "-"} (${digitos(telCliente)})`,
        `Serviço: ${caso.fatos.servico || caso.fatos.problema || "-"}`, `Bairro: ${caso.fatos.bairro || "-"}`, `Endereço: ${caso.fatos.endereco || "-"}`,
        `Profissional: ${consulta.prestador_nome}`, `Data/horário: ${dataFinal}`,
        `Valor cliente: ${consulta.valor_cliente ? moeda(consulta.valor_cliente) : "-"}`, `Valor profissional: ${consulta.valor_prestador ? moeda(consulta.valor_prestador) : "-"}`,
        `Observações: ${caso.resumo || "-"}`, r.ok ? "" : "ATENÇÃO: o cliente ainda não recebeu a confirmação."
      ].filter(Boolean).join("\n"), "agendado:" + consulta.id, caso.casoId);
      return;
    }
    if (caso.etapa === "AGENDADO") { await alertarEquipe(c, `${consulta.prestador_nome} escreveu sobre o caso #${caso.casoId} (já agendado): "${txt(textoTodo, 300)}". Sem ação automática.`, "pos:" + chaveLote, caso.casoId); return; }

    // Proposta (valor e/ou disponibilidade).
    const valorPrest = valor || (consulta.status === "AGUARDANDO_COMPOSICAO" ? Number(consulta.valor_prestador || 0) : 0);
    const composicao = finalInf || (valor ? "" : String(consulta.valor_final || ""));
    if (valorPrest && !composicao) {
      await atualizarConsulta(c, consulta.id, { valor_prestador: valorPrest, status: "AGUARDANDO_COMPOSICAO", disponibilidade: disp || consulta.disponibilidade });
      await responder(`Só para confirmar: ${moeda(valorPrest)} é o valor final para o cliente ou é somente a sua parte?`, "composicao");
      return;
    }
    const dispFinal = disp || consulta.disponibilidade || "";
    if (!valorPrest && !dispFinal) { await responder(`Obrigado! Caso #${caso.casoId}: pode me informar o valor e a sua disponibilidade?`, "pedevalor"); return; }
    const markup = Math.max(0, Number(c.env.MARKUP_PERCENT ?? 50));
    const valorCliente = valorPrest ? (composicao === "SIM" ? valorPrest : Math.round(valorPrest * (1 + markup / 100))) : 0;
    const partes = [];
    if (dispFinal) partes.push(`O profissional pode atender ${dispFinal}.`);
    if (valorCliente) partes.push(`O valor fica ${moeda(valorCliente)}.`);
    partes.push(dispFinal ? "Podemos confirmar?" : "Podemos seguir com esse valor?");
    await atualizarConsulta(c, consulta.id, { valor_prestador: valorPrest || null, valor_cliente: valorCliente || null, valor_final: composicao || null, disponibilidade: dispFinal || null, status: "RESPONDIDA" });
    const r = await avisarCliente(partes.join(" "), "proposta");
    if (r.ok) { await mudarEtapa(c, caso, "AGUARDANDO_CLIENTE"); await responder("Obrigado! Vou confirmar com o cliente e retorno.", "prop-ok"); }
    return;
  }

  // COMENTARIO: nenhuma ação automática.
  await alertarEquipe(c, `${consulta.prestador_nome} (caso #${caso.casoId}) escreveu: "${txt(textoTodo, 300)}". Nenhuma ação automática foi tomada.`, "coment:" + chaveLote, caso.casoId);
}

// ============================================================================
// ECO HUMANO (atendente respondeu pelo app WhatsApp Business)
// ============================================================================

async function processarEco(c, eco) {
  if (!(await reservarChave(c, "eco:" + eco.wamid))) return;
  const nosso = await c.db.prepare("SELECT id FROM mensagens WHERE whatsapp_message_id=? LIMIT 1").bind(eco.wamid).first();
  if (nosso) return;
  await pausar(c, eco.para, PAUSA_HUMANA_MS, "HUMANO");
  const msg = { ...eco, conteudo: txt(eco.texto, 4000) };
  if (eco.mediaId && eco.tipo === "audio") {
    try { const a = await metaBaixarMidia(c.env, eco.mediaId); msg.conteudo = "[Áudio do atendente transcrito] " + await transcreverAudio(c, a.buffer, a.mime); }
    catch { msg.conteudo = "[Áudio do atendente — não transcrito]"; }
  } else if (eco.mediaId) msg.conteudo = `[${eco.tipo} enviado pelo atendente]${eco.caption ? " " + eco.caption : ""}`;
  const id = await identificar(c, eco.para);
  const pessoa = id.pessoa || await obterPessoa(c, eco.para, "", id.papel === "PRESTADOR" ? "TECNICO" : "CLIENTE");
  let casoId = null;
  if (id.papel === "CLIENTE" && pessoa) casoId = (await carregarCasos(c, pessoa)).ativo?.casoId || null;
  if (id.papel === "PRESTADOR") { const ab = await consultasAbertasPrestador(c, eco.para); if (ab.length === 1) casoId = ab[0].caso_id; }
  await registrarMensagem(c, { pessoaId: pessoa?.id, casoId, wamid: eco.wamid, direcao: "SAIDA", origem: "HUMANO", tipo: String(eco.tipo || "text").toUpperCase(), conteudo: msg.conteudo });
}

// ============================================================================
// FILA, AGRUPAMENTO E LOTES
// ============================================================================

function janela(env) { const v = Number(env.JANELA_AGRUPAMENTO_MS ?? 15000); return Number.isFinite(v) ? Math.min(Math.max(v, 0), 20000) : 15000; }
// Enquanto o cliente continua escrevendo, a DENIA espera e responde tudo de uma vez.
// Só não espera para sempre: depois de 3 minutos do primeiro envio, responde.
const ESPERA_MAXIMA_LOTE_MS = 180000;
class Adiar extends Error { constructor() { super("ADIAR"); this.adiar = true; } }
async function chegouMensagemNova(c, tel, itens) {
  const primeira = Math.min(...itens.map(i => Number(i.recebido_ms) || c.agora()));
  if (c.agora() - primeira > ESPERA_MAXIMA_LOTE_MS) return false;
  const r = await c.db.prepare("SELECT 1 AS ok FROM d30_fila WHERE telefone=? AND status='PENDENTE' LIMIT 1").bind(tel).first().catch(() => null);
  return Boolean(r?.ok);
}

async function esperarSilencio(c, tel) {
  const ult = await c.db.prepare("SELECT MAX(recebido_ms) m FROM d30_fila WHERE telefone=? AND status='PENDENTE'").bind(tel).first().catch(() => null);
  const falta = Number(ult?.m || 0) + janela(c.env) - c.agora();
  if (falta > 0) await sleep(Math.min(falta, janela(c.env)));
}
async function agruparEProcessar(c, tel, wamid) {
  await sleep(janela(c.env));
  const ult = await c.db.prepare("SELECT wamid FROM d30_fila WHERE telefone=? AND status='PENDENTE' ORDER BY recebido_ms DESC, rowid DESC LIMIT 1").bind(tel).first();
  if (ult && ult.wamid !== wamid) return; // chegou mensagem mais nova; ela cuidará do lote
  await processarPendentes(c, tel);
}

async function processarPendentes(c, tel) {
  for (let volta = 0; volta < 3; volta++) {
    const lote = crypto.randomUUID(), agora = c.agora();
    const itens = (await c.db.prepare(`UPDATE d30_fila SET status='PROCESSANDO', lote=?, atualizado_ms=? WHERE telefone=? AND status='PENDENTE'
      AND NOT EXISTS (SELECT 1 FROM d30_fila f2 WHERE f2.telefone=? AND f2.status='PROCESSANDO' AND f2.atualizado_ms > ?) RETURNING wamid, payload, recebido_ms`)
      .bind(lote, agora, tel, tel, agora - 120000).all())?.results || [];
    if (!itens.length) return;
    itens.sort((a, b) => a.recebido_ms - b.recebido_ms);
    let status = "CONCLUIDO", erro = null;
    try { await processarLote(c, tel, itens); }
    catch (e) {
      if (e?.adiar) {
        // O cliente mandou mais mensagens enquanto a DENIA pensava: devolve tudo à fila e
        // responde uma vez só, depois que ele parar de escrever.
        await c.db.prepare("UPDATE d30_fila SET status='PENDENTE', lote=NULL, atualizado_ms=? WHERE lote=?").bind(c.agora(), lote).run();
        await esperarSilencio(c, tel);
        continue;
      }
      status = "ERRO"; erro = txt(e?.stack || e?.message || e, 500);
      console.error("lote", tel, erro);
      await alertarEquipe(c, `Erro ao processar mensagens de ${tel}: ${txt(e?.message, 200)}. Verifique a conversa.`, "erro-lote:" + lote).catch(() => { });
    }
    await c.db.prepare("UPDATE d30_fila SET status=?, erro=?, atualizado_ms=? WHERE lote=?").bind(status, erro, c.agora(), lote).run();
  }
}

async function processarLote(c, tel, itens) {
  const msgs = itens.map(i => JSON.parse(i.payload));
  const agora = c.agora();
  const frescas = msgs.filter(m => agora - (Number(m.ts) * 1000 || m.recebidoMs || agora) <= FILA_EXPIRA_MS);
  const opts = { apenasRegistrar: frescas.length === 0, chaveLote: msgs[msgs.length - 1].wamid };
  const id = await identificar(c, tel);
  if (id.papel === "PRESTADOR") return processarPrestador(c, tel, id, msgs, opts);
  if (id.papel === "ATENDENTE") {
    for (const m of msgs) await registrarMensagem(c, { pessoaId: id.pessoa?.id, wamid: m.wamid, direcao: "ENTRADA", origem: "WHATSAPP", tipo: String(m.tipo || "text").toUpperCase(), conteudo: txt(m.texto, 4000) || `[${m.tipo}]` });
    return;
  }
  return processarCliente(c, tel, id, msgs, opts);
}

// ============================================================================
// WEBHOOK DA META
// ============================================================================

function textoDaMensagem(m) {
  const t = String(m?.type || "text").toLowerCase();
  if (t === "text") return String(m.text?.body || "");
  if (t === "button") return String(m.button?.text || m.button?.payload || "");
  if (t === "interactive") return String(m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "");
  if (t === "location") return `[Localização] ${[m.location?.name, m.location?.address].filter(Boolean).join(" — ")} (${m.location?.latitude}, ${m.location?.longitude})`;
  if (t === "contacts") return "[Contato compartilhado]";
  const obj = m[t] || {};
  return obj.caption ? String(obj.caption) : "";
}
function normalizarMsg(m, nome, para) {
  const tipo = String(m?.type || "text").toLowerCase();
  const obj = m?.[tipo] || {};
  return {
    wamid: String(m?.id || ""), de: digitos(para ? "" : m?.from), para: para ? digitos(m?.to) : "", nome: txt(nome, 120), ts: String(m?.timestamp || ""),
    tipo, texto: textoDaMensagem(m), mediaId: String(obj?.id && tipo !== "text" ? obj.id : ""), mime: String(obj?.mime_type || ""),
    caption: String(obj?.caption || ""), filename: String(obj?.filename || ""), contextId: String(m?.context?.id || "")
  };
}
function extrairEventos(payload, env) {
  const mensagens = [], ecos = [];
  for (const entry of payload?.entry || []) for (const ch of entry?.changes || []) {
    const v = ch?.value || {};
    const pid = v?.metadata?.phone_number_id;
    if (pid && String(pid) !== phoneId(env)) continue;
    const nomes = new Map((v.contacts || []).map(x => [digitos(x.wa_id), x.profile?.name || ""]));
    for (const m of v.messages || []) {
      if (["reaction", "unsupported", "system", "ephemeral"].includes(String(m?.type))) continue;
      const n = normalizarMsg(m, nomes.get(digitos(m.from)), false);
      if (n.wamid && n.de) mensagens.push(n);
    }
    for (const e of v.message_echoes || []) {
      if (["edit", "revoke", "reaction"].includes(String(e?.type))) continue;
      const n = normalizarMsg(e, "", true);
      if (n.wamid && n.para) ecos.push(n);
    }
  }
  return { mensagens, ecos };
}

async function assinaturaValida(bytes, request, env) {
  const segredo = String(env.META_APP_SECRET || "").trim();
  if (!segredo) return true; // sem o secret configurado, não é possível verificar
  const recebida = String(request.headers.get("x-hub-signature-256") || "").replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recebida)) return false;
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const assin = new Uint8Array(await crypto.subtle.sign("HMAC", chave, bytes));
  return iguaisSeguro(Array.from(assin, b => b.toString(16).padStart(2, "0")).join(""), recebida);
}

async function webhookPost(request, env, ctx) {
  const bytes = await request.arrayBuffer();
  if (!(await assinaturaValida(bytes, request, env))) return new Response("assinatura inválida", { status: 401 });
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { return new Response("EVENT_RECEIVED", { status: 200 }); }
  const c = criarContexto(env);
  const { mensagens, ecos } = extrairEventos(payload, env);
  if (!mensagens.length && !ecos.length) return new Response("EVENT_RECEIVED", { status: 200 });
  try { await garantirSchema(c); }
  catch (e) {
    console.error("D1 indisponível:", e?.message);
    for (const m of mensagens) ctx.waitUntil(contingencia(c, m, e?.message).catch(x => console.error("contingência", x)));
    for (const e2 of ecos) ctx.waitUntil(pausaKV(env, e2.para));
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
  for (const eco of ecos) {
    try { await pausar(c, eco.para, PAUSA_HUMANA_MS, "HUMANO"); } catch { await pausaKV(env, eco.para); }
    ctx.waitUntil(processarEco(c, eco).catch(x => console.error("eco", x)));
  }
  const ultimos = new Map();
  const agora = c.agora();
  for (const m of mensagens) {
    try {
      const r = await c.db.prepare("INSERT OR IGNORE INTO d30_fila(wamid,telefone,payload,recebido_ms,status,atualizado_ms) VALUES(?,?,?,?,'PENDENTE',?)")
        .bind(m.wamid, m.de, JSON.stringify({ ...m, recebidoMs: agora }), agora, agora).run();
      if (Number(r?.meta?.changes || 0) > 0) ultimos.set(m.de, m.wamid);
    } catch (e) {
      console.error("fila D1:", e?.message);
      ctx.waitUntil(contingencia(criarContexto(env), m, e?.message).catch(x => console.error("contingência", x)));
    }
  }
  for (const [tel, wamid] of ultimos) ctx.waitUntil(agruparEProcessar(c, tel, wamid).catch(x => console.error("agrupar", x)));
  return new Response("EVENT_RECEIVED", { status: 200 });
}

// ============================================================================
// CONTINGÊNCIA (D1 fora do ar): responde com cautela, sem ações operacionais
// ============================================================================

async function pausaKV(env, tel) {
  if (!env.MEMORIA) return;
  try { await env.MEMORIA.put("d30:pausa:" + digitos(tel), "1", { expirationTtl: Math.ceil(PAUSA_HUMANA_MS / 1000) }); } catch { }
}
let ultimoAlertaContingencia = 0;
async function kvGet(env, k) { try { return await env.MEMORIA.get(k); } catch { return null; } }
async function kvPut(env, k, v, ttl) { try { await env.MEMORIA.put(k, v, ttl ? { expirationTtl: Math.max(60, ttl) } : undefined); return true; } catch { return false; } }

// Um único aviso por hora, e não um por mensagem.
async function avisarContingencia(c, motivo) {
  const hora = Math.floor(c.agora() / 3600000);
  if (ultimoAlertaContingencia === hora) return;
  ultimoAlertaContingencia = hora;
  if (c.env.MEMORIA) {
    if (await kvGet(c.env, "d30:alerta-d1:" + hora)) return;
    await kvPut(c.env, "d30:alerta-d1:" + hora, "1", 3700);
  }
  await c.saida.telegram(`DENIA — MODO DE CONTINGÊNCIA: o banco D1 não está respondendo (${txt(motivo, 160)}). A DENIA responde só o essencial aos clientes, no máximo 1 mensagem a cada 2 minutos por contato, sem consultar prestadores. Mensagens de prestadores e da equipe NÃO são respondidas — acompanhe pelo app. Este aviso se repete no máximo 1 vez por hora.`);
}

async function contingencia(c, m, motivo = "") {
  c.contingencia = true;
  const env = c.env, tel = digitos(m.de);
  await avisarContingencia(c, motivo);
  if (!env.MEMORIA) return;
  const ts = Number(m.ts) * 1000;
  if (ts && c.agora() - ts > FILA_EXPIRA_MS) return;                 // mensagem atrasada: não responder
  if (prestadorPorTelefone(tel)) return;                                // prestador: só a equipe responde
  const equipe = String(env.EQUIPE_TELEFONES || "").split(/[,;\s]+/).map(digitos).filter(Boolean);
  const equipeKV = JSON.parse(await kvGet(env, "d30:equipe") || "[]");
  if ([...equipe, ...equipeKV].some(t => variantesTel(t).includes(tel))) return; // equipe/técnico do D1
  if (await kvGet(env, "d30:pausa:" + tel)) return;                    // atendente humano na conversa

  // Agrupa mensagens seguidas: só a última da sequência responde.
  const chaveUlt = "d30:cont:ult:" + tel;
  const anterior = JSON.parse(await kvGet(env, chaveUlt) || "null");
  const textos = anterior && c.agora() - anterior.em < 120000 ? anterior.textos.slice(-6) : [];
  let conteudo = txt(m.texto, 3000);
  if (m.tipo === "audio" && m.mediaId) { try { const a = await metaBaixarMidia(env, m.mediaId); conteudo = "[Áudio transcrito] " + await transcreverAudio(c, a.buffer, a.mime); } catch { conteudo = "[Áudio recebido]"; } }
  if (!conteudo) conteudo = `[${m.tipo} recebido]`;
  textos.push(conteudo);
  if (!(await kvPut(env, chaveUlt, JSON.stringify({ wamid: m.wamid, textos, em: c.agora() }), 300))) return; // sem registro, sem resposta
  await sleep(janela(env));
  const ult = JSON.parse(await kvGet(env, chaveUlt) || "null");
  if (ult && ult.wamid !== m.wamid) return;

  // Trava: no máximo 1 resposta a cada 2 minutos por contato.
  const chaveTrava = "d30:cont:resp:" + tel;
  if (await kvGet(env, chaveTrava)) return;
  if (!(await kvPut(env, chaveTrava, "1", 120))) return;

  const histKey = "d30:hist:" + tel;
  const hist = JSON.parse(await kvGet(env, histKey) || "[]");
  for (const t of textos) hist.push({ a: "CLIENTE", t });
  const snap = JSON.parse(await kvGet(env, "d30:snap:" + tel) || "null");
  const histFormatoD1 = hist.map(x => ({ direcao: x.a === "DENIA" ? "SAIDA" : "ENTRADA", origem: "IA", conteudo: x.t }));
  const ultimaDenia = [...hist].reverse().find(x => x.a === "DENIA")?.t || "";
  let resposta = "";
  try {
    const treino = await carregarTreinamento(c);
    const caso = snap ? { casoId: snap.casoId, etapa: snap.etapa, fatos: snap.fatos || {}, resumo: snap.resumo } : null;
    const d = normalizarDecisaoCliente(await openaiJSON(c, INSTRUCOES_CLIENTE, montarEntradaCliente({ agora: c.agora(), treinamento: treino, caso, consulta: null, autorizados: new Set(), recentes: [], hist: hist.slice(-24, -textos.length).map(x => `${x.a}: ${x.t}`).join("\n") || "(sem histórico disponível)", novas: textos.map(t => "- " + t).join("\n"), temAnexos: false, pessoa: { nome: m.nome } })));
    const acaoNecessaria = ["ACEITA_PROPOSTA", "PEDE_CANCELAMENTO", "PEDE_ALTERACAO", "PERGUNTA_PARA_PROFISSIONAL", "FALAR_COM_HUMANO", "PEDE_OUTRO_HORARIO"].includes(d.intencao) || (d.quer && d.pronto) || d.precisa_humano;
    const g = guardarResposta(d.resposta, { etapa: caso?.etapa || "SEM_CASO", autorizados: new Set(), modo: "", regiaoConfirmada: false, fatos: caso?.fatos || null, perguntadas: perguntasRecentes(histFormatoD1, 12) });
    resposta = acaoNecessaria ? "Recebemos sua mensagem. Um atendente vai dar continuidade em instantes." : g.texto;
  } catch (e) {
    resposta = "Recebemos sua mensagem. Um atendente vai dar continuidade em instantes.";
  }
  if (!resposta || norm(resposta) === norm(ultimaDenia)) return; // nada útil ou repetido: silêncio
  const r = await c.saida.texto(tel, resposta);
  if (r.ok) hist.push({ a: "DENIA", t: resposta });
  await kvPut(env, histKey, JSON.stringify(hist.slice(-30)), 60 * 60 * 24 * 7);
}

// ============================================================================
// CRON — recuperação, envios das 8h, relatório diário, limpeza
// ============================================================================

async function cron(c) {
  await garantirSchema(c);
  const agora = c.agora();
  await c.db.prepare("UPDATE d30_fila SET status='PENDENTE', atualizado_ms=? WHERE status='PROCESSANDO' AND atualizado_ms < ? AND recebido_ms > ?")
    .bind(agora, agora - 180000, agora - FILA_EXPIRA_MS).run();
  const tels = (await c.db.prepare("SELECT DISTINCT telefone FROM d30_fila WHERE status='PENDENTE' AND recebido_ms < ? LIMIT 10").bind(agora - 40000).all())?.results || [];
  for (const t of tels) await processarPendentes(c, t.telefone);
  await processarAgendados(c);
  await processarSync(c).catch(e => console.error("sync", e));
  await processarAprendizado(c).catch(e => console.error("aprendizado", e));
  await relatorioDiario(c).catch(e => console.error("relatório", e));
  const dia = dataSP(agora);
  if (await reservarChave(c, "limpeza:" + dia)) {
    await c.db.prepare("DELETE FROM d30_fila WHERE recebido_ms < ?").bind(agora - 7 * 86400000).run();
    await c.db.prepare("DELETE FROM d30_saidas WHERE criado_ms < ?").bind(agora - 2 * 86400000).run();
    // Telefones da equipe e técnicos do D1, para a contingência nunca respondê-los.
    if (c.env.MEMORIA) {
      const eq = (await c.db.prepare(`SELECT DISTINCT p.telefone FROM pessoas p WHERE p.empresa_id=? AND (UPPER(COALESCE(p.tipo,'')) IN ('ATENDENTE','TECNICO')
        OR p.id IN (SELECT pessoa_id FROM atendentes WHERE COALESCE(ativo,1)=1) OR p.id IN (SELECT pessoa_id FROM tecnicos WHERE COALESCE(ativo,1)=1))`).bind(EMPRESA_ID).all().catch(() => ({ results: [] })))?.results || [];
      await kvPut(c.env, "d30:equipe", JSON.stringify(eq.map(x => digitos(x.telefone)).filter(Boolean)), 60 * 60 * 24 * 30);
    }
    await c.db.prepare("DELETE FROM d30_envios WHERE criado_ms < ? AND chave NOT LIKE 'limpeza:%' AND chave NOT LIKE 'relatorio:%'").bind(agora - 45 * 86400000).run();
  }
}

async function processarAgendados(c) {
  const agora = c.agora();
  const vencidos = (await c.db.prepare("SELECT * FROM d30_agendados WHERE status='PENDENTE' AND criado_ms < ? LIMIT 20").bind(agora - AGENDADO_EXPIRA_MS).all())?.results || [];
  for (const a of vencidos) {
    await c.db.prepare("UPDATE d30_agendados SET status='EXPIRADO' WHERE id=?").bind(a.id).run();
    await alertarEquipe(c, `Mensagem para prestador do caso #${a.caso_id} não foi enviada a tempo e expirou: "${txt(a.texto, 200)}"`, "exp-ag:" + a.id, a.caso_id);
  }
  if (!dentroHorarioPrestador(c)) return;
  const pend = (await c.db.prepare("SELECT * FROM d30_agendados WHERE status='PENDENTE' ORDER BY id LIMIT 20").all())?.results || [];
  for (const a of pend) {
    if (await estaPausado(c, a.para)) continue;
    const consulta = await c.db.prepare("SELECT * FROM d30_consultas WHERE id=?").bind(a.consulta_id).first();
    if (!consulta || ["RECUSADA", "ENCERRADA", "FALHA", "EXPIRADA"].includes(consulta.status)) { await c.db.prepare("UPDATE d30_agendados SET status='CANCELADO' WHERE id=?").bind(a.id).run(); continue; }
    const caso = await carregarCasoPorId(c, a.caso_id);
    if (!caso || ETAPAS_ENCERRADAS.has(caso.etapa)) { await c.db.prepare("UPDATE d30_agendados SET status='CANCELADO' WHERE id=?").bind(a.id).run(); continue; }
    const r = await enviarAgoraAoPrestador(c, { consulta, caso, texto: a.texto, chave: "agendado:" + a.id, inicial: a.inicial === 1 });
    await c.db.prepare("UPDATE d30_agendados SET status=? WHERE id=?").bind(r.ok ? "ENVIADO" : "FALHA", a.id).run();
    if (r.ok && a.inicial === 1) {
      await atualizarConsulta(c, consulta.id, { status: "ENVIADA", message_id: r.id });
      if (!r.viaTemplate) await encaminharMidiasAoPrestador(c, { ...consulta, message_id: r.id });
    }
    if (!r.ok) await alertarEquipe(c, `Falha no envio programado ao prestador (caso #${a.caso_id}): ${r.erro}`, "falha-ag:" + a.id, a.caso_id);
  }
}

async function relatorioDiario(c) {
  const agora = c.agora();
  if (horaSP(agora) < 20) return;
  const dia = dataSP(agora);
  if (!(await reservarChave(c, "relatorio:" + dia))) return;
  const ini = inicioDiaSP(agora);
  const q = async (sql, ...b) => Number((await c.db.prepare(sql).bind(...b).first())?.n || 0);
  const recebidas = await q("SELECT COUNT(*) n FROM d30_fila WHERE recebido_ms >= ?", ini);
  const novos = await q("SELECT COUNT(*) n FROM d30_casos WHERE criado_ms >= ?", ini);
  const consultas = await q("SELECT COUNT(*) n FROM d30_eventos WHERE tipo='CONSULTA_ENVIADA' AND criado_ms >= ?", ini);
  const agendados = await q("SELECT COUNT(*) n FROM d30_eventos WHERE tipo='ETAPA' AND descricao LIKE '%-> AGENDADO' AND criado_ms >= ?", ini);
  const alertas = await q("SELECT COUNT(*) n FROM d30_eventos WHERE tipo='ALERTA_EQUIPE' AND criado_ms >= ?", ini);
  const correcoes = await q("SELECT COUNT(*) n FROM d30_eventos WHERE tipo='RESPOSTA_CORRIGIDA' AND criado_ms >= ?", ini);
  const falhas = await q("SELECT COUNT(*) n FROM d30_eventos WHERE tipo LIKE 'FALHA_%' AND criado_ms >= ?", ini);
  const atencao = (await c.db.prepare(`SELECT caso_id, etapa, fatos_json, atualizado_ms FROM d30_casos WHERE etapa IN ('AGUARDANDO_PRESTADOR','AGUARDANDO_CONFIRMACAO_PRESTADOR','AGUARDANDO_CLIENTE','AGUARDANDO_ENDERECO','EQUIPE') AND atualizado_ms < ? ORDER BY atualizado_ms LIMIT 20`).bind(agora - 2 * 3600000).all())?.results || [];
  let analise = "";
  try {
    const amostra = (await c.db.prepare("SELECT direcao, origem, conteudo, caso_id FROM mensagens WHERE id > (SELECT COALESCE(MAX(id),0) FROM mensagens) - 300 ORDER BY id").all())?.results || [];
    if (amostra.length) {
      const o = await openaiJSON(c, "Você audita o atendimento de uma central. Analise as mensagens e aponte objetivamente erros da DENIA (perguntas repetidas, promessas sem ação, informação inventada, tom inadequado, confusão de casos) e até 3 recomendações. Não exponha telefones. Responda em JSON {\"analise\":\"...\"} com no máximo 1200 caracteres.",
        amostra.map(m => `${m.direcao === "ENTRADA" ? "PESSOA" : m.origem === "HUMANO" ? "ATENDENTE" : "DENIA"}${m.caso_id ? ` #${m.caso_id}` : ""}: ${txt(m.conteudo, 300)}`).join("\n").slice(-30000), [], 700);
      analise = txt(o.analise, 1400);
    }
  } catch (e) { analise = "Autoavaliação indisponível hoje."; }
  const texto = [`Relatório DENIA — ${dia.split("-").reverse().join("/")}`, `Mensagens recebidas: ${recebidas}`, `Casos novos: ${novos}`, `Consultas a prestadores: ${consultas}`, `Agendamentos: ${agendados}`, `Alertas à equipe: ${alertas}`, `Respostas corrigidas pela guarda: ${correcoes}`, `Falhas de envio: ${falhas}`,
    atencao.length ? "\nCasos parados há mais de 2h:\n" + atencao.map(a => { let f = {}; try { f = JSON.parse(a.fatos_json); } catch { } return `#${a.caso_id} ${a.etapa} — ${f.servico || f.problema || "-"} (desde ${dataHoraSP(a.atualizado_ms)})`; }).join("\n") : "",
    analise ? "\nAutoavaliação:\n" + analise : ""].filter(Boolean).join("\n");
  await c.saida.telegram(texto);
  await enviarEmailRelatorio(c, texto, dia);
}

// Mesmo contrato do Google Apps Script usado pela versão anterior.
async function enviarEmailRelatorio(c, texto, dia) {
  const env = c.env;
  const url = String(env.RELATORIO_GMAIL_URL || ""), seg = String(env.RELATORIO_GMAIL_SEGREDO || "");
  if (c.sim || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url) || seg.length < 32) return;
  const dest = String(env.RELATORIO_EMAIL_TO || "").split(/[;,\s]+/).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  for (const to of dest) {
    const payload = JSON.stringify({ id: `rel-${dia}-${to}`, to, subject: `Relatório de atendimento — ${dia}`, text: texto });
    const ts = String(Date.now());
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(seg), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const s = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(ts + "\n" + payload))), b => b.toString(16).padStart(2, "0")).join("");
    try { await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timestamp: ts, payload, assinatura: s }), redirect: "follow", signal: AbortSignal.timeout(20000) }); }
    catch (e) { console.error("e-mail relatório", e?.message); }
  }
}

// ============================================================================
// API PRIVADA PARA A DENIA PLATFORM (compatível com a V28)
// ============================================================================

function platformAutorizada(request, env) {
  const s = String(env.DENIA_PLATFORM_SERVICE_TOKEN || "");
  if (s.length < 16) return false;
  const a = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return iguaisSeguro(a, s) || iguaisSeguro(String(request.headers.get("x-denia-platform-token") || ""), s);
}
async function platformApi(request, env, caminho, metodo) {
  if (!platformAutorizada(request, env)) return json({ sucesso: false, erro: "Não autorizado." }, 401);
  const c = criarContexto(env);
  await garantirSchema(c);
  const corpo = metodo === "POST" ? await request.json().catch(() => ({})) : {};
  let m;
  if (caminho === "/platform/status") return json({ sucesso: true, versao: VERSAO, ...(await saude(c)) });
  if (caminho === "/platform/conversations" && metodo === "GET") {
    const lim = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")) || 100, 1), 250);
    const r = await c.db.prepare(`SELECT p.id pessoa_id, p.nome, p.telefone, p.tipo, m.conteudo ultima_mensagem, m.criado_em ultima_mensagem_em, m.direcao ultima_direcao, m.origem ultima_origem
      FROM (SELECT pessoa_id, MAX(id) mid FROM mensagens WHERE empresa_id=? AND id > (SELECT COALESCE(MAX(id),0) FROM mensagens) - 1500 GROUP BY pessoa_id) u
      JOIN mensagens m ON m.id=u.mid JOIN pessoas p ON p.id=u.pessoa_id ORDER BY u.mid DESC LIMIT ?`).bind(EMPRESA_ID, lim).all();
    // Uma consulta só para as pausas (antes era uma por conversa, o que deixava a lista lenta).
    const pausas = new Set(((await c.db.prepare("SELECT telefone FROM d30_pausas WHERE ate_ms > ?").bind(c.agora()).all())?.results || []).map(x => digitos(x.telefone)));
    const conversas = (r?.results || []).map(x => ({ ...x, ia_pausada: variantesTel(x.telefone).some(v => pausas.has(v)) }));
    return json({ sucesso: true, conversas });
  }
  if ((m = caminho.match(/^\/platform\/conversations\/(\d+)$/)) && metodo === "GET") {
    const p = await c.db.prepare("SELECT id,nome,telefone,tipo FROM pessoas WHERE id=?").bind(Number(m[1])).first();
    if (!p) return json({ sucesso: false, erro: "Conversa não encontrada." }, 404);
    const casos = await carregarCasos(c, p);
    return json({ sucesso: true, pessoa: p, ia_pausada: await estaPausado(c, p.telefone), caso_ativo: casos.ativo, casos_recentes: casos.recentes, mensagens: await historico(c, p.id, 500) });
  }
  if ((m = caminho.match(/^\/platform\/conversations\/(\d+)\/(send|takeover|release)$/)) && metodo === "POST") {
    const p = await c.db.prepare("SELECT id,nome,telefone FROM pessoas WHERE id=?").bind(Number(m[1])).first();
    if (!p) return json({ sucesso: false, erro: "Conversa não encontrada." }, 404);
    if (m[2] === "takeover") { await pausar(c, p.telefone, PAUSA_TAKEOVER_MS, "TAKEOVER"); return json({ sucesso: true, ia_pausada: true }); }
    if (m[2] === "release") { await liberarPausa(c, p.telefone); return json({ sucesso: true, ia_pausada: false }); }
    const texto = txt(corpo?.mensagem || corpo?.texto, 4000);
    if (!texto) return json({ sucesso: false, erro: "Mensagem vazia." }, 400);
    await pausar(c, p.telefone, PAUSA_HUMANA_MS, "HUMANO");
    const r = await c.saida.texto(p.telefone, texto);
    if (!r.ok) return json({ sucesso: false, erro: r.erro || "WhatsApp não confirmou o envio." }, 502);
    const caso = (await carregarCasos(c, p)).ativo;
    await registrarMensagem(c, { pessoaId: p.id, casoId: caso?.casoId, wamid: r.id, direcao: "SAIDA", origem: "HUMANO", conteudo: texto });
    return json({ sucesso: true, messageId: r.id, ia_pausada: true });
  }
  if ((m = caminho.match(/^\/platform\/cases\/(\d+)\/status$/)) && metodo === "POST") {
    const caso = await carregarCasoPorId(c, Number(m[1]));
    const etapa = String(corpo?.etapa || "").toUpperCase();
    if (!caso) return json({ sucesso: false, erro: "Caso não encontrado." }, 404);
    if (!["COLETANDO", "EQUIPE", "AGENDADO", "CONCLUIDO", "CANCELADO"].includes(etapa)) return json({ sucesso: false, erro: "Etapa inválida." }, 400);
    await mudarEtapa(c, caso, etapa);
    return json({ sucesso: true, caso });
  }
  if (caminho === "/platform/cases" && metodo === "GET") {
    const r = await c.db.prepare("SELECT * FROM d30_casos ORDER BY atualizado_ms DESC LIMIT 100").all();
    return json({ sucesso: true, casos: (r?.results || []).map(linhaParaCaso) });
  }
  if (caminho === "/platform/training" && metodo === "GET") return json({ sucesso: true, ...(await carregarTreinamento(c)) });
  if (caminho === "/platform/training" && metodo === "POST") {
    const r = await salvarTreinamento(c, corpo?.treinamento || corpo, String(corpo?.autor || "platform"), corpo?.confirmar_vazio === true);
    return json({ sucesso: r.ok, ...r }, r.ok ? 200 : 409);
  }
  if (caminho === "/platform/learning" && metodo === "GET") return json({ sucesso: true, ...(await statusAprendizado(c)) });
  if (caminho === "/platform/learning/start" && metodo === "POST") return json({ sucesso: true, ...(await iniciarAprendizado(c)) });
  if (caminho === "/platform/learning/suggestions" && metodo === "GET") {
    const st = String(new URL(request.url).searchParams.get("status") || "PENDENTE").toUpperCase();
    const r = await c.db.prepare("SELECT id,tipo,titulo,conteudo,evidencia,ocorrencias,status,criado_ms,decidido_ms,decidido_por FROM d30_sugestoes WHERE status=? ORDER BY ocorrencias DESC, id DESC LIMIT 200").bind(["PENDENTE", "APROVADA", "REJEITADA"].includes(st) ? st : "PENDENTE").all();
    return json({ sucesso: true, sugestoes: r?.results || [] });
  }
  if ((m = caminho.match(/^\/platform\/learning\/suggestions\/(\d+)$/)) && metodo === "POST") {
    const acao = String(corpo?.acao || "");
    if (!["aprovar", "rejeitar"].includes(acao)) return json({ sucesso: false, erro: "Ação inválida." }, 400);
    const r = await decidirSugestao(c, Number(m[1]), acao, corpo?.conteudo, txt(corpo?.autor, 120) || "platform");
    return json({ sucesso: r.ok, ...r }, r.ok ? 200 : 409);
  }
  if (caminho === "/platform/import/clients" && metodo === "POST") return json({ sucesso: true, ...(await importarClientes(c, corpo?.linhas, corpo?.origem)) });
  if (caminho === "/platform/import/clients" && metodo === "GET") {
    const n = await c.db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT telefone) t, MAX(importado_ms) u FROM d30_ficha").first();
    return json({ sucesso: true, registros: Number(n?.n || 0), clientes: Number(n?.t || 0), ultima_importacao_ms: n?.u || null });
  }
  if (caminho === "/platform/pause" && metodo === "POST") {
    const ativa = corpo?.ativa === true;
    await c.db.prepare("INSERT OR REPLACE INTO d30_meta(chave,valor) VALUES('pausa_geral',?)").bind(ativa ? "1" : "0").run();
    cachePausaGeral = { em: 0, valor: false };
    await evento(c, null, "PAUSA_GERAL", `${ativa ? "ativada" : "desativada"} por ${txt(corpo?.autor, 120) || "platform"}`);
    return json({ sucesso: true, pausa_geral: ativa });
  }
  if (caminho === "/platform/professionals") return json({ sucesso: true, profissionais: PRESTADORES.map(p => ({ ...p, area_rotulo: CATEGORIAS[p.area]?.rotulo })) });
  return json({ sucesso: false, erro: "Rota não encontrada." }, 404);
}

// ============================================================================
// SAÚDE (testa funcionamento real, não só se o binding existe)
// ============================================================================

async function saude(c) {
  const env = c.env;
  const r = {
    versao: VERSAO, modelo: modelo(env),
    openai_configurado: Boolean(env.OPENAI_API_KEY), whatsapp_configurado: Boolean(env.WHATSAPP_TOKEN),
    verify_token_configurado: Boolean(env.WHATSAPP_VERIFY_TOKEN), assinatura_meta_verificada: Boolean(env.META_APP_SECRET),
    telegram_configurado: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), template_prestador_configurado: Boolean(env.WHATSAPP_TEMPLATE_CONSULTA_TECNICO),
    painel_protegido: Boolean(senhaPainel(env)), plataforma_cadastro_envio: Boolean(env.PLATAFORMA_API_URL), plataforma_cadastro_consulta: Boolean(env.CRM_CONSULTA_URL), janela_agrupamento_ms: janela(env), markup_percent: Number(env.MARKUP_PERCENT ?? 50)
  };
  try { await c.db.prepare("SELECT 1 AS ok").first(); r.d1 = { configurado: true, operacional: true }; }
  catch (e) { r.d1 = { configurado: Boolean(env.DB), operacional: false, erro: txt(e?.message, 200) }; }
  try { if (env.MEMORIA) await env.MEMORIA.get("d30:saude"); r.kv = { configurado: Boolean(env.MEMORIA), operacional: Boolean(env.MEMORIA) }; }
  catch (e) { r.kv = { configurado: true, operacional: false, erro: txt(e?.message, 200) }; }
  if (r.d1.operacional) {
    try {
      await garantirSchema(c);
      r.fila_24h = (await c.db.prepare("SELECT status, COUNT(*) n FROM d30_fila WHERE recebido_ms > ? GROUP BY status").bind(c.agora() - 86400000).all())?.results || [];
      r.casos_por_etapa = (await c.db.prepare("SELECT etapa, COUNT(*) n FROM d30_casos WHERE atualizado_ms > ? GROUP BY etapa").bind(c.agora() - 30 * 86400000).all())?.results || [];
      r.agendados_8h = Number((await c.db.prepare("SELECT COUNT(*) n FROM d30_agendados WHERE status='PENDENTE'").first())?.n || 0);
    } catch (e) { r.erro_estatisticas = txt(e?.message, 200); }
  }
  r.pausa_geral = await pausaGeralAtiva(c).catch(() => null);
  r.limites_envio = LIMITES_ENVIO;
  r.ok = r.d1.operacional && r.openai_configurado && r.whatsapp_configurado;
  return r;
}

// ============================================================================
// PAINÉIS (protegidos por senha: secret PAINEL_SENHA)
// ============================================================================

// Login do painel: página com senha (secret PAINEL_SENHA) e cookie de sessão de 30 dias.
async function hmacHex(chave, texto) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(texto))), b => b.toString(16).padStart(2, "0")).join("");
}
function senhaPainel(env) { const s = String(env.PAINEL_SENHA || ""); return s.length >= 8 ? s : ""; }
async function painelAutorizado(request, env) {
  const senha = senhaPainel(env);
  if (!senha) return true; // sem PAINEL_SENHA o painel fica aberto (como na versão antiga)
  const h = String(request.headers.get("authorization") || "");
  if (h.startsWith("Basic ")) {
    let dec = ""; try { dec = atob(h.slice(6)); } catch { return false; }
    return iguaisSeguro(dec.slice(dec.indexOf(":") + 1), senha);
  }
  const m = String(request.headers.get("cookie") || "").match(/(?:^|;\s*)denia_sess=(\d+)\.([0-9a-f]{64})/);
  if (!m || Number(m[1]) < Date.now()) return false;
  return iguaisSeguro(m[2], await hmacHex(senha, "denia:" + m[1]));
}
function negarPainel(request) {
  const url = new URL(request.url);
  if (request.method === "GET" && !url.pathname.startsWith("/api/")) return new Response(null, { status: 302, headers: { location: "/login" } });
  return json({ erro: "Faça login em /login." }, 401);
}
function paginaLogin(env, erro = "") {
  const semSenha = !senhaPainel(env);
  return cabecalho("DENIA — Entrar") + `<div class="card" style="max-width:420px;margin:40px auto"><b>Entrar no painel da DENIA</b><br><br>
${semSenha ? `<small>O painel ainda não tem senha. Na Cloudflare: <b>Workers &amp; Pages → este Worker → Settings → Variables and Secrets → Add</b>, tipo <b>Secret</b>, nome <b>PAINEL_SENHA</b>, valor = a senha que você quiser (mínimo 8 caracteres). Salve, faça Deploy e volte aqui.</small>` :
`<form method="post" action="/login"><input type="password" name="senha" placeholder="Senha do painel (PAINEL_SENHA)" autofocus required><br><br><button type="submit">Entrar</button></form>${erro ? `<p style="color:#b91c1c">${esc(erro)}</p>` : ""}`}</div></main></body></html>`;
}
async function login(request, env) {
  if (!senhaPainel(env)) return new Response(null, { status: 302, headers: { location: "/chat" } });
  if (request.method !== "POST") return paginaHTML(paginaLogin(env));
  const senha = senhaPainel(env);
  const form = await request.formData().catch(() => null);
  if (!senha || !iguaisSeguro(String(form?.get("senha") || ""), senha)) return paginaHTML(paginaLogin(env, "Senha incorreta."), 401);
  const exp = Date.now() + 30 * 86400000;
  const cookie = `denia_sess=${exp}.${await hmacHex(senha, "denia:" + exp)}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Strict`;
  return new Response(null, { status: 302, headers: { location: "/chat", "set-cookie": cookie } });
}

const CSS = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,Arial,sans-serif;background:#f4f6f8;color:#111827}
header{background:#111827;color:#fff;padding:14px 18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}header a{color:#cbd5e1;text-decoration:none;font-size:14px}
main{max-width:1000px;margin:18px auto;padding:0 14px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin-bottom:14px}
textarea,select,input{width:100%;font:inherit;padding:9px;border:1px solid #d1d5db;border-radius:8px}textarea{min-height:110px}
button{background:#111827;color:#fff;border:0;border-radius:8px;padding:10px 14px;font-weight:600;cursor:pointer}button.sec{background:#fff;color:#111827;border:1px solid #d1d5db}
#log{height:460px;overflow:auto;background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:10px}.b{max-width:85%;padding:9px 11px;border-radius:10px;margin:7px 0;white-space:pre-wrap;font-size:14px}
.eu{margin-left:auto;background:#111827;color:#fff}.cli{background:#fff;border:1px solid #e5e7eb}.pre{background:#ecfdf5;border:1px solid #a7f3d0}.tel{background:#fff7ed;border:1px solid #fed7aa}
.rot{font-size:11px;opacity:.7;display:block;margin-bottom:3px}.linha{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.linha>*{flex:1}small{color:#6b7280}`;
function cabecalho(t) { return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title><style>${CSS}</style></head><body><header><b>DENIA ${VERSAO}</b><a href="/chat">Testar</a><a href="/treinar">Treinar IA</a><a href="/api/saude">Saúde</a></header><main>`; }

function paginaTeste() {
  const opcoes = PRESTADORES.map(p => `<option value="${esc(p.id)}">Prestador: ${esc(p.nome)} — ${esc(CATEGORIAS[p.area].rotulo.split(" (")[0])}</option>`).join("");
  return cabecalho("DENIA — Teste") + `<div class="card"><b>Simulador</b><br><small>Nada é enviado de verdade pelo WhatsApp. O fluxo completo roda (casos, consultas, propostas) e mostra o que seria enviado ao cliente, ao prestador e à equipe.</small></div>
<div class="card"><div id="log"></div><div class="linha" style="margin-top:10px"><select id="quem"><option value="cliente">Falar como: Cliente de teste</option>${opcoes}</select>
<label style="flex:0 0 auto;font-size:13px"><input type="checkbox" id="hora" checked style="width:auto"> ignorar horário 8h–21h</label></div>
<div class="linha" style="margin-top:8px"><textarea id="msg" placeholder="Digite a mensagem..." style="min-height:60px"></textarea></div>
<div class="linha" style="margin-top:8px"><button id="env">Enviar</button><button class="sec" id="limpar">Limpar teste</button></div></div>
<div class="card"><b>Emergência</b><br><small>Para todos os envios automáticos reais (clientes e prestadores). As mensagens continuam sendo registradas.</small>
<div class="linha" style="margin-top:8px"><button id="pausar" style="background:#b91c1c">PAUSAR DENIA</button><button class="sec" id="retomar">Reativar DENIA</button><span id="pst"></span></div></div>
<script>
const log=document.getElementById('log');
function add(cls,rot,t){const d=document.createElement('div');d.className='b '+cls;d.innerHTML='<span class="rot"></span>';d.firstChild.textContent=rot;d.appendChild(document.createTextNode(t));log.appendChild(d);log.scrollTop=log.scrollHeight;}
async function enviar(){const t=msg.value.trim();if(!t)return;const q=quem.value;add('eu',q==='cliente'?'Você (cliente)':'Você ('+quem.options[quem.selectedIndex].text+')',t);msg.value='';
const r=await fetch('/api/teste',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({remetente:q,texto:t,ignorarHorario:hora.checked})});
const d=await r.json().catch(()=>({erro:'Resposta inválida'}));if(d.erro)add('tel','Erro',d.erro);
for(const s of d.saidas||[]){const cls=s.canal==='telegram'?'tel':(s.papel==='prestador'?'pre':'cli');add(cls,s.canal==='telegram'?'Telegram da equipe':(s.papel==='prestador'?'DENIA → prestador '+(s.prestador||s.para):'DENIA → cliente'),s.texto);}
if(!(d.saidas||[]).length&&!d.erro)add('cli','(DENIA não respondeu)','—');}
env.onclick=enviar;msg.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();enviar();}});
limpar.onclick=async()=>{await fetch('/api/limpar-teste',{method:'POST'});log.innerHTML='';};
async function pausa(ativa){const r=await fetch('/api/pausa-geral',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ativa})});const d=await r.json();pst.textContent=d.pausa_geral?'DENIA PAUSADA':'DENIA ativa';}
pausar.onclick=()=>pausa(true);retomar.onclick=()=>pausa(false);
</script></main></body></html>`;
}

function paginaTreinar() {
  const campos = CAMPOS_TREINAMENTO.map(k => `<div class="card"><b>${esc(ROTULOS_TREINAMENTO[k])}</b><textarea id="f_${k}" data-campo="${k}"></textarea></div>`).join("");
  return cabecalho("DENIA — Treinar") + `<div class="card"><b>Treinamento</b> <small id="ver"></small><br><small>Cada salvamento cria uma versão nova. Versões antigas podem ser restauradas. Um campo preenchido nunca é apagado sem confirmação.</small></div>${campos}
<div class="card linha"><button id="salvar" disabled>Salvar nova versão</button><span id="st"></span></div>
<div class="card"><b>Versões</b><div id="versoes"></div></div>
<script>
let carregado=false;
async function carregar(){const r=await fetch('/api/treinamento');const d=await r.json();if(!r.ok){st.textContent=d.erro||'Erro';return;}
for(const el of document.querySelectorAll('[data-campo]'))el.value=(d.dados||{})[el.dataset.campo]||'';ver.textContent='versão '+d.versao;carregado=true;salvar.disabled=false;
const v=await (await fetch('/api/treinamento/versoes')).json();versoes.innerHTML='';for(const x of v.versoes||[]){const b=document.createElement('button');b.className='sec';b.style.margin='4px';b.textContent='Restaurar v'+x.versao+' ('+x.autor+', '+new Date(x.criado_ms).toLocaleString('pt-BR')+')';b.onclick=()=>restaurar(x.versao);versoes.appendChild(b);}}
async function gravar(confirmar){const dados={};for(const el of document.querySelectorAll('[data-campo]'))dados[el.dataset.campo]=el.value;
const r=await fetch('/api/treinamento',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({treinamento:dados,confirmar_vazio:confirmar})});const d=await r.json();
if(d.codigo==='CONFIRMAR_VAZIO'){if(confirm('Estes campos ficarão vazios: '+d.campos.join(', ')+'. Confirmar?'))return gravar(true);st.textContent='Nada foi salvo.';return;}
st.textContent=r.ok?'Salvo como versão '+d.versao:(d.erro||'Erro ao salvar');if(r.ok)carregar();}
async function restaurar(v){if(!confirm('Restaurar a versão '+v+'? (será criada uma versão nova com esse conteúdo)'))return;const r=await fetch('/api/treinamento/restaurar',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({versao:v})});const d=await r.json();st.textContent=r.ok?'Restaurado como versão '+d.versao:(d.erro||'Erro');carregar();}
salvar.onclick=()=>{if(carregado)gravar(false);};carregar();
</script></main></body></html>`;
}

async function apiTeste(request, env) {
  const corpo = await request.json().catch(() => ({}));
  const texto = txt(corpo?.texto, 3000);
  if (!texto) return json({ erro: "Mensagem vazia." }, 400);
  const c = criarContexto(env, { simulacao: true, ignorarHorario: corpo?.ignorarHorario !== false });
  await garantirSchema(c);
  const prest = PRESTADORES.find(p => p.id === corpo?.remetente);
  const tel = prest ? "000" + prest.telefone : TEL_TESTE_CLIENTE;
  const wamid = "sim." + crypto.randomUUID();
  const msg = { wamid, de: tel, nome: prest ? prest.nome : "Cliente de teste", ts: String(Math.floor(c.agora() / 1000)), tipo: "text", texto, mediaId: "", contextId: "" };
  try {
    const id = prest ? { papel: "PRESTADOR", prestador: prest, pessoa: await buscarPessoa(c, tel) } : { papel: "CLIENTE", pessoa: await buscarPessoa(c, tel) };
    const opts = { apenasRegistrar: false, chaveLote: wamid };
    if (prest) await processarPrestador(c, tel, id, [msg], opts); else await processarCliente(c, tel, id, [msg], opts);
  } catch (e) { return json({ erro: txt(e?.message, 300), saidas: c.registro }, 500); }
  return json({ saidas: c.registro });
}
async function limparTeste(env) {
  const c = criarContexto(env, { simulacao: true });
  await garantirSchema(c);
  const pessoas = (await c.db.prepare("SELECT id FROM pessoas WHERE telefone=? OR telefone LIKE '000%'").bind(TEL_TESTE_CLIENTE).all())?.results || [];
  for (const p of pessoas) {
    const casos = (await c.db.prepare("SELECT caso_id FROM d30_casos WHERE cliente_id=?").bind(p.id).all())?.results || [];
    for (const k of casos) {
      for (const s of ["DELETE FROM d30_consultas WHERE caso_id=?", "DELETE FROM d30_midias WHERE caso_id=?", "DELETE FROM d30_agendados WHERE caso_id=?", "DELETE FROM d30_casos WHERE caso_id=?", "DELETE FROM casos WHERE id=?"]) await c.db.prepare(s).bind(k.caso_id).run();
    }
    await c.db.prepare("DELETE FROM mensagens WHERE pessoa_id=?").bind(p.id).run();
  }
  await c.db.prepare("DELETE FROM d30_pausas WHERE telefone=? OR telefone LIKE '000%'").bind(TEL_TESTE_CLIENTE).run();
  return json({ sucesso: true });
}

// ============================================================================
// ROTEADOR
// ============================================================================

async function rotear(request, env, ctx) {
  const url = new URL(request.url);
  const caminho = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const metodo = request.method.toUpperCase();

  if (caminho === "/webhook" && metodo === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && env.WHATSAPP_VERIFY_TOKEN && iguaisSeguro(url.searchParams.get("hub.verify_token"), env.WHATSAPP_VERIFY_TOKEN);
    return new Response(ok ? url.searchParams.get("hub.challenge") || "" : "Não autorizado.", { status: ok ? 200 : 403 });
  }
  if (caminho === "/webhook" && metodo === "POST") return webhookPost(request, env, ctx);
  if (caminho.startsWith("/platform/")) return platformApi(request, env, caminho, metodo);
  if (caminho === "/favicon.ico") return new Response(null, { status: 204 });

  if (caminho === "/login") return login(request, env);
  if (caminho === "/sair") return new Response(null, { status: 302, headers: { location: "/login", "set-cookie": "denia_sess=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" } });
  if (!(await painelAutorizado(request, env))) return negarPainel(request);
  const c = criarContexto(env);
  if (caminho === "/" || caminho === "/chat") return paginaHTML(paginaTeste());
  if (caminho === "/treinar") return paginaHTML(paginaTreinar());
  if (caminho === "/api/saude") { const s = await saude(c); return json(s, s.ok ? 200 : 503); }
  if (caminho === "/api/teste" && metodo === "POST") return apiTeste(request, env);
  if (caminho === "/api/limpar-teste" && metodo === "POST") return limparTeste(env);
  if (caminho === "/api/pausa-geral" && metodo === "POST") {
    await garantirSchema(c);
    const ativa = (await request.json().catch(() => ({})))?.ativa === true;
    await c.db.prepare("INSERT OR REPLACE INTO d30_meta(chave,valor) VALUES('pausa_geral',?)").bind(ativa ? "1" : "0").run();
    cachePausaGeral = { em: 0, valor: false };
    await evento(c, null, "PAUSA_GERAL", ativa ? "ativada" : "desativada");
    return json({ pausa_geral: ativa });
  }
  await garantirSchema(c);
  if (caminho === "/api/treinamento" && metodo === "GET") return json(await carregarTreinamento(c));
  if (caminho === "/api/treinamento" && metodo === "POST") {
    const corpo = await request.json().catch(() => ({}));
    const r = await salvarTreinamento(c, corpo?.treinamento || {}, "painel", corpo?.confirmar_vazio === true);
    return json(r, r.ok ? 200 : 409);
  }
  if (caminho === "/api/treinamento/versoes") {
    const r = await c.db.prepare("SELECT versao, autor, criado_ms FROM d30_treinamento ORDER BY versao DESC LIMIT 30").all();
    return json({ versoes: r?.results || [] });
  }
  if (caminho === "/api/treinamento/restaurar" && metodo === "POST") {
    const v = Number((await request.json().catch(() => ({})))?.versao);
    const row = await c.db.prepare("SELECT json FROM d30_treinamento WHERE versao=?").bind(v).first();
    if (!row) return json({ ok: false, erro: "Versão não encontrada." }, 404);
    return json(await salvarTreinamento(c, JSON.parse(row.json), `restauração da v${v}`, true));
  }
  return json({ erro: "Rota não encontrada." }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try { return await rotear(request, env, ctx); }
    catch (e) { console.error("ERRO NÃO TRATADO:", e?.stack || e); return json({ sucesso: false, erro: "Erro interno." }, 500); }
  },
  async scheduled(event, env, ctx) {
    const c = criarContexto(env);
    try { await cron(c); } catch (e) { console.error("cron:", e?.stack || e); }
  },
  // A V30 não usa Cloudflare Queues. Se a configuração antiga ainda tiver uma fila
  // ligada a este Worker, as mensagens antigas são descartadas (nunca respondidas).
  async queue(batch) {
    for (const m of batch.messages) m.ack();
  }
};
