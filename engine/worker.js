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
//   Opcionais:   OPENAI_MODEL, OPENAI_TRANSCRIPTION_MODEL, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_WABA_ID,
//                WHATSAPP_TEMPLATE_CONSULTA_TECNICO, WHATSAPP_TEMPLATE_IDIOMA,
//                MARKUP_PERCENT, JANELA_AGRUPAMENTO_MS, VIDEO_PROCESSOR_URL,
//                VIDEO_PROCESSOR_TOKEN, RELATORIO_GMAIL_URL, RELATORIO_GMAIL_SEGREDO,
//                RELATORIO_EMAIL_TO, DENIA_PLATFORM_SERVICE_TOKEN
//                MODO = guia  -> guia de lojas (shopping): menu de botões sem IA (ver "MODO GUIA")
//
// CRON: "* * * * *" (a cada minuto) — recuperação da fila, envios das 8h,
//       relatório diário. Nunca inicia conversa nova por conta própria.
// ============================================================================

const VERSAO = "33.2.0";
const SCHEMA_VERSAO = "33.0.0"; // mude sempre que acrescentar tabela ou índice (senão o banco de produção não recebe)
const EMPRESA_ID = 1;
const PHONE_ID_PADRAO = "473474732510163";
const GRAPH = "v25.0";
const MODELO_PADRAO = "gpt-5.6-luna";
const TZ = "America/Sao_Paulo";

const PAUSA_HUMANA_MS = 10 * 60 * 1000;
const PAUSA_TAKEOVER_MS = 12 * 60 * 60 * 1000;
const FILA_EXPIRA_MS = 15 * 60 * 1000;
// Mensagem atrasada (WhatsApp reenviando, instabilidade): até 12 h a DENIA ainda responde, pedindo desculpas pela demora.
const LIMITE_ATRASO_MS = 12 * 60 * 60 * 1000; // teto absoluto; o padrão real é atrasoMaximo() (30 min)
// Até quanto tempo depois a DENIA ainda responde sozinha uma mensagem que ficou sem resposta.
// Padrão 30 min (variável ATRASO_MAXIMO_MIN). Mais velha que isso: só registra e avisa a equipe —
// nunca sai mandando mensagem para clientes antigos quando o cron volta a funcionar.
function atrasoMaximo(env) { const m = Number(env?.ATRASO_MAXIMO_MIN); return (Number.isFinite(m) && m >= 1 ? Math.min(m, 720) : 30) * 60000; }
const MAX_ATRASADAS_POR_EXECUCAO = 3;
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
// Lista inicial: na primeira vez vai para o banco (d30_prestadores) e, a partir daí, a empresa edita pela
// plataforma (Profissionais): nome, WhatsApp, área e o que cada um faz.
const PRESTADORES_PADRAO = [
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
const PRESTADORES = PRESTADORES_PADRAO.map(p => ({ ...p })); // o que vale agora (carregado do banco)

const CATEGORIAS = {
  MARCENARIA: { rotulo: "Marcenaria (móveis planejados/sob medida, armários, portas de madeira)", modo: "DOMICILIO" },
  ASSISTENCIA_TECNICA: { rotulo: "Assistência técnica de ar-condicionado, geladeira/freezer e lava e seca (inclusive aparelho queimado por ligar em 110/220 V)", modo: "DOMICILIO" },
  ELETRODOMESTICO: { rotulo: "Conserto de outros eletrodomésticos e aparelhos (micro-ondas, air fryer, TV, forno, fogão, cafeteira, ventilador etc.) — sem prestador automático: a equipe avalia", modo: "EQUIPE" },
  REFORMA: { rotulo: "Reforma (pedreiro, pintura, hidráulica, pisos, revestimentos)", modo: "DOMICILIO" },
  ELETRICA: { rotulo: "Elétrica da casa (tomadas, disjuntores, fiação, quadro de luz, iluminação). NÃO conserta eletrodomésticos nem aparelhos queimados", modo: "DOMICILIO" },
  CHAVEIRO: { rotulo: "Chaveiro (fechaduras, cópias, abertura de portas)", modo: "DOMICILIO" },
  ESTOFADOR: { rotulo: "Estofador (reforma/troca de tecido de sofás e poltronas)", modo: "DOMICILIO" },
  HIGIENIZACAO: { rotulo: "Higienização (limpeza de sofás, colchões, tapetes, estofados)", modo: "DOMICILIO" },
  PEQUENOS_REPAROS: { rotulo: "Pequenos reparos e instalações (pendurar quadros e espelhos, prateleiras, cortinas e persianas, suporte de TV, varal, montagem de móveis, furos na parede, pequenos consertos da casa)", modo: "DOMICILIO" },
  BALCAO: { rotulo: "Eletrônicos no balcão da loja (computador, notebook, Apple, celular, smartwatch) — o cliente leva o equipamento", modo: "BALCAO" }
};

const REGRAS_AREA = [
  ["CHAVEIRO", /\b(chaveiro|fechaduras?|cilindro|copias? de chave|porta trancada|trancad[oa] (pra|para) fora|perdi a chave)\b/],
  ["ELETRICA", /\b(eletricista|eletric[ao]s?|tomadas?|disjuntor(es)?|fiacao|curto[- ]?circuito|quadro de luz|luminarias?|chuveiro eletrico)\b/],
  ["ASSISTENCIA_TECNICA", /\b(ar[- ]?condicionado|split|geladeiras?|refrigerador|freezer|lava e seca|lava-e-seca|lavadora|maquina de lavar|secadora)\b/],
  ["ESTOFADOR", /\b(estofador|estofamento|reforma(r)? (de |do |da |o |a )?(sofa|poltrona)|troca(r)? (o |de )?tecido)\b/],
  ["HIGIENIZACAO", /\b(higieniza\w*|limpeza (de |do |da )?(sofa|colchao|estofados?|tapetes?|poltronas?|cadeiras?)|lava(r|gem) (de |do |o )?(sofa|colchao|tapete))\b/],
  ["PEQUENOS_REPAROS", /\b(pendurar|quadros?|espelhos? na parede|cortinas?|persianas?|varal|suporte (de |da |para )?(tv|televis\w*)|montar (um |uma |o |a )?(movel|moveis|guarda[- ]roupas?|armario|estante|cama|rack|berco|mesa)|montagem (de |do |da )?(moveis?|guarda[- ]roupas?|armario|estante|cama|rack)|furar|furos?|buchas?|marido de aluguel|pequen[oa]s? (reparos?|servicos|consertos?|reformas?|instalacoes))\b/],
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

const CAMPOS_TREINAMENTO = ["instrucoes", "servicos", "regras", "precos", "procedimentos", "informacoes", "exemplos", "aprendizados", "licoes_diarias"];
const ROTULOS_TREINAMENTO = {
  instrucoes: "INSTRUÇÕES DO ATENDIMENTO", servicos: "SERVIÇOS", regras: "REGRAS DA EMPRESA",
  precos: "PREÇOS E CONDIÇÕES AUTORIZADOS", procedimentos: "PROCEDIMENTOS",
  informacoes: "INFORMAÇÕES DA EMPRESA", exemplos: "EXEMPLOS DE ATENDIMENTO",
  aprendizados: "APRENDIZADOS APROVADOS (extraídos do histórico real e aprovados pela empresa)",
  licoes_diarias: "LIÇÕES DO ESTUDO DIÁRIO (erros que a DENIA cometeu e corrigiu; boas práticas de atendimento — siga sempre)"
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
// ----- Calendário: feriados nacionais, do estado do RJ e da cidade do Rio de Janeiro (calculados para
// qualquer ano, inclusive os móveis: Carnaval, Sexta-feira Santa e Corpus Christi) e o horário de reuniões.
function pascoaUTC(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(ano, mes - 1, dia);
}
const cacheFeriados = new Map();
// "AAAA-MM-DD" → { nome, livreDepois?: "HH:MM", livreAte?: "HH:MM" } (sem horário: o dia todo é feriado).
function feriadosDoAno(ano) {
  if (cacheFeriados.has(ano)) return cacheFeriados.get(ano);
  const f = new Map(), p = pascoaUTC(ano);
  const fixo = (md, nome, extra = {}) => f.set(`${ano}-${md}`, { nome, ...extra });
  const movel = (dias, nome, extra = {}) => f.set(new Date(p + dias * 86400000).toISOString().slice(0, 10), { nome, ...extra });
  fixo("01-01", "Confraternização Universal (feriado nacional)");
  fixo("01-20", "Dia de São Sebastião (feriado municipal do Rio)");
  fixo("04-21", "Tiradentes (feriado nacional)");
  fixo("04-23", "Dia de São Jorge (feriado estadual do RJ)");
  fixo("05-01", "Dia do Trabalho (feriado nacional)");
  fixo("09-07", "Independência do Brasil (feriado nacional)");
  fixo("10-12", "Nossa Senhora Aparecida (feriado nacional)");
  fixo("11-02", "Finados (feriado nacional)");
  fixo("11-15", "Proclamação da República (feriado nacional)");
  fixo("11-20", "Dia da Consciência Negra (feriado nacional)");
  fixo("12-24", "Véspera de Natal (meio expediente)", { livreAte: "12:00" });
  fixo("12-25", "Natal (feriado nacional)");
  fixo("12-31", "Véspera de Ano-Novo (meio expediente)", { livreAte: "12:00" });
  movel(-48, "Carnaval (segunda-feira)");
  movel(-47, "Carnaval (terça-feira)");
  movel(-46, "Quarta-feira de Cinzas (só a partir das 14h)", { livreDepois: "14:00" });
  movel(-2, "Sexta-feira Santa (feriado nacional)");
  movel(60, "Corpus Christi (feriado no Rio)");
  cacheFeriados.set(ano, f);
  return f;
}
function feriadoEm(dataISO) { return feriadosDoAno(Number(String(dataISO).slice(0, 4))).get(String(dataISO).slice(0, 10)) || null; }
const DIAS_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
const DIAS_LONGOS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
function diaSemanaSP(ms) { return new Date(Date.parse(dataSP(ms) + "T12:00:00-03:00")).getUTCDay(); }
function hhmmSP(ms) { return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms)); }
// REUNIAO_HORARIO (secret opcional), ex.: "seg-sex 09:00-18:00; sab 09:00-12:00". Padrão: seg a sex 8h–18h, sáb 8h–12h.
function horarioReunioes(env) {
  const bruto = String(env?.REUNIAO_HORARIO || "seg-sex 08:00-18:00; sab 08:00-12:00");
  const dias = Array.from({ length: 7 }, () => []);
  for (const parte of bruto.split(/[;\n]+/)) {
    const m = norm(parte).match(/^\s*([a-z ,\-]+?)\s+(\d{1,2}):?(\d{2})?\s*(?:-|a|ate)\s*(\d{1,2}):?(\d{2})?\s*$/);
    if (!m) continue;
    const de = `${m[2].padStart(2, "0")}:${m[3] || "00"}`, ate = `${m[4].padStart(2, "0")}:${m[5] || "00"}`;
    for (const tok of m[1].split(/\s*,\s*/)) {
      const [a, b] = tok.split(/\s*-\s*/).map(x => DIAS_SEMANA.indexOf(x.trim().slice(0, 3)));
      if (a < 0) continue;
      for (let d = a; ; d = (d + 1) % 7) { dias[d].push([de, ate]); if (b === undefined || b < 0 || d === b) break; }
    }
  }
  return dias.some(x => x.length) ? dias : horarioReunioes({});
}
function descreverHorario(dias) {
  const nomes = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  return dias.map((f, i) => f.length ? `${nomes[i]} ${f.map(([a, b]) => `${a}–${b}`).join(", ")}` : "").filter(Boolean).join("; ") || "não definido";
}
// "" se a reunião pode ser nesse horário; senão o motivo, em português, para dizer ao cliente.
function motivoHorarioReuniao(env, agora, ms) {
  if (!Number.isFinite(ms)) return "não entendi o dia e o horário";
  if (ms < agora + 15 * 60000) return "esse horário já passou";
  if (ms > agora + 180 * 86400000) return "é longe demais para marcar agora";
  const data = dataSP(ms), hora = hhmmSP(ms), fer = feriadoEm(data);
  if (fer && !fer.livreDepois && !fer.livreAte) return `${data.slice(8, 10)}/${data.slice(5, 7)} é ${fer.nome.replace(/\s*\(.*\)$/, "")}, feriado`;
  if (fer?.livreDepois && hora < fer.livreDepois) return `${fer.nome.replace(/\s*\(.*\)$/, "")} só tem atendimento a partir das ${fer.livreDepois.replace(":00", "h")}`;
  if (fer?.livreAte && hora >= fer.livreAte) return `${fer.nome.replace(/\s*\(.*\)$/, "")} só tem atendimento até as ${fer.livreAte.replace(":00", "h")}`;
  const faixas = horarioReunioes(env)[diaSemanaSP(ms)];
  if (!faixas.length) return `não fazemos reunião ${diaSemanaSP(ms) === 0 ? "aos domingos" : "aos " + DIAS_LONGOS[diaSemanaSP(ms)] + "s"}`;
  if (!faixas.some(([a, b]) => hora >= a && hora < b)) return `nesse dia as reuniões são ${faixas.map(([a, b]) => `das ${a.replace(":00", "h")} às ${b.replace(":00", "h")}`).join(" ou ")}`;
  return "";
}
// Próximo horário em que dá para marcar: o mesmo horário nos dias seguintes (ou o início do expediente).
function proximoHorarioReuniao(env, agora, ms) {
  const dias = horarioReunioes(env);
  const hora = Number.isFinite(ms) ? hhmmSP(ms) : "10:00";
  let base = Date.parse(dataSP(Number.isFinite(ms) && ms > agora ? ms : agora) + "T12:00:00-03:00");
  for (let i = 0; i < 45; i++, base += 86400000) {
    const data = dataSP(base), faixas = dias[diaSemanaSP(base)], fer = feriadoEm(data);
    // No próprio dia: só mais tarde (ex.: Quarta de Cinzas a partir das 14h). Nos seguintes: o mesmo horário ou o início do expediente.
    const opcoes = i === 0 ? [hora, ...(fer?.livreDepois ? [fer.livreDepois] : []), ...faixas.map(([a]) => a).filter(a => a > hora)] : [hora, ...faixas.map(([a]) => a)];
    for (const h of opcoes) {
      const t = Date.parse(`${data}T${h}:00-03:00`);
      if (!motivoHorarioReuniao(env, agora, t)) return t;
    }
  }
  return null;
}
function dataExtensoSP(ms) { return `${DIAS_LONGOS[diaSemanaSP(ms)].replace("-feira", "")}, ${new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" }).format(new Date(ms))}, às ${hhmmSP(ms).replace(":00", "h").replace(":", "h")}`; }
// O que a IA vê: os próximos dias com o dia da semana (para não errar "terça que vem") e os feriados.
function calendarioTexto(env, agora, dias = 21) {
  const linhas = [];
  let base = Date.parse(dataSP(agora) + "T12:00:00-03:00");
  for (let i = 0; i < dias; i++, base += 86400000) {
    const data = dataSP(base), fer = feriadoEm(data);
    linhas.push(`${DIAS_SEMANA[diaSemanaSP(base)]} ${data.slice(8, 10)}/${data.slice(5, 7)}/${data.slice(0, 4)}${i === 0 ? " (hoje)" : i === 1 ? " (amanhã)" : ""}${fer ? " — " + fer.nome.toUpperCase() : ""}`);
  }
  const prox = [];
  for (let i = dias; i < 200 && prox.length < 8; i++) { const data = dataSP(Date.parse(dataSP(agora) + "T12:00:00-03:00") + i * 86400000), fer = feriadoEm(data); if (fer) prox.push(`${data.slice(8, 10)}/${data.slice(5, 7)}/${data.slice(0, 4)} (${DIAS_SEMANA[diaSemanaSP(Date.parse(data + "T12:00:00-03:00"))]}): ${fer.nome}`); }
  return `${linhas.join("\n")}\nPRÓXIMOS FERIADOS DEPOIS DISSO: ${prox.join("; ") || "-"}\nHORÁRIO DE REUNIÕES ONLINE: ${descreverHorario(horarioReunioes(env))} (fora disso, em feriados e em horário passado, não marque).`;
}

function dataHoraSP(ms) { return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }).format(new Date(ms)); }
function inicioDiaSP(ms) { return Date.parse(dataSP(ms) + "T00:00:00-03:00"); }
function saudacaoSP(ms) { const h = horaSP(ms); return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite"; }
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
// Outros números de um mesmo profissional (vinculados pela equipe na plataforma). Recarregado a cada minuto.
let TELS_EXTRAS = { em: -1, mapa: new Map() };
// Profissionais do banco (editados pela plataforma). Na primeira vez, grava a lista inicial.
let CACHE_PREST = { em: -1, db: null };
async function carregarPrestadores(c, forcar) {
  if (!forcar && CACHE_PREST.db === c.env.DB && CACHE_PREST.em >= 0 && c.agora() - CACHE_PREST.em < 60000) return;
  try {
    let r = (await c.db.prepare("SELECT * FROM d30_prestadores ORDER BY ordem, nome").all())?.results || [];
    if (!r.length && !(await c.db.prepare("SELECT valor FROM d30_meta WHERE chave='prestadores_semeados'").first())) {
      await c.db.batch(PRESTADORES_PADRAO.map((p, i) => c.db.prepare("INSERT OR IGNORE INTO d30_prestadores(id,nome,telefone,area,servicos,ordem,ativo,atualizado_ms) VALUES(?,?,?,?,?,?,1,?)").bind(p.id, p.nome, p.telefone, p.area, p.servicos || null, i, c.agora())));
      await c.db.prepare("INSERT OR REPLACE INTO d30_meta(chave,valor) VALUES('prestadores_semeados','1')").run();
      r = (await c.db.prepare("SELECT * FROM d30_prestadores ORDER BY ordem, nome").all())?.results || [];
    }
    PRESTADORES.length = 0;
    for (const p of r) if (Number(p.ativo) === 1) PRESTADORES.push({ id: p.id, area: p.area, nome: p.nome, telefone: digitos(p.telefone), servicos: p.servicos || "" });
    CACHE_PREST = { em: c.agora(), db: c.env.DB };
  } catch (e) { console.warn("prestadores", e?.message); }
}
// Para a IA: cada área com os profissionais e o que cada um faz.
function categoriasParaIA() {
  return Object.entries(CATEGORIAS).map(([k, v]) => {
    const ps = PRESTADORES.filter(p => p.area === k);
    return `${k}: ${v.rotulo}${ps.length ? ` — profissionais: ${ps.map(p => p.nome + (p.servicos ? ` (faz: ${txt(p.servicos, 160)})` : "")).join("; ")}` : " — sem profissional cadastrado"}`;
  }).join("\n");
}
async function carregarTelsExtras(c, forcar) {
  await carregarPrestadores(c, forcar);
  if (!forcar && TELS_EXTRAS.em >= 0 && c.agora() - TELS_EXTRAS.em < 60000) return;
  try {
    const r = (await c.db.prepare("SELECT telefone, prestador_id FROM d30_prestador_tels").all())?.results || [];
    TELS_EXTRAS = { em: c.agora(), mapa: new Map(r.map(x => [digitos(x.telefone), x.prestador_id])) };
  } catch { TELS_EXTRAS = { em: c.agora(), mapa: new Map() }; }
}
function prestadorPorTelefone(tel) {
  let t = digitos(tel);
  if (t.startsWith("000") && t.length > 13) t = t.slice(3); // telefone simulado do painel de teste
  const vs = variantesTel(t);
  const daLista = PRESTADORES.find(p => vs.includes(p.telefone) || variantesTel(p.telefone).includes(t));
  if (daLista) return daLista;
  for (const v of vs) { const id = TELS_EXTRAS.mapa.get(v); if (id) { const p = PRESTADORES.find(x => x.id === id); if (p) return p; } }
  return null;
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
  // Montar/instalar algo pronto é pequeno reparo, não marcenaria sob medida.
  if (areas.includes("PEQUENOS_REPAROS") && areas.includes("MARCENARIA") && /\b(montar|montagem|instalar|pendurar|fixar)\b/.test(t) && !/\b(sob medida|planejad)/.test(t)) areas = ["PEQUENOS_REPAROS"];
  if (areas.length === 1) {
    if (ia && ia !== areas[0] && certa) return ""; // IA e regras discordam: equipe decide
    return areas[0];
  }
  if (areas.length > 1) return areas.includes(ia) && certa ? ia : "";
  if (r.generico) return ia && certa ? ia : (ia ? "" : /\bpequen[oa]s?\b/.test(t) ? "PEQUENOS_REPAROS" : "REFORMA");
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

// ============================================================================
// LIMITE DE CHAMADAS POR EXECUÇÃO
// No plano gratuito da Cloudflare cada execução do Worker pode fazer só 50 chamadas externas, e cada
// consulta ao banco D1 conta como uma. Passando disso, a chamada seguinte — muitas vezes o envio ao
// WhatsApp — é recusada ("Too many subrequests"). Cada execução conta as próprias chamadas; quando
// está perto do limite, a resposta vai para a fila de envio e sai na execução seguinte (segundos depois).
// No plano pago (limite de milhares), defina LIMITE_CHAMADAS=900 no Worker.
// ============================================================================
function limiteChamadas(c) { const n = Number(c.env.LIMITE_CHAMADAS); return Number.isFinite(n) && n > 10 ? n : 45; }
function sobram(c) { return limiteChamadas(c) - (c.chamadas || 0); }
function gastar(c, n = 1) { if (c) c.chamadas = (c.chamadas || 0) + n; }
function contarDB(db, c) {
  if (!db || typeof db.prepare !== "function") return db;
  const embrulhar = st => ({
    _st: st,
    bind: (...a) => embrulhar(st.bind(...a)),
    first: (...a) => { gastar(c); return st.first(...a); },
    all: (...a) => { gastar(c); return st.all(...a); },
    run: (...a) => { gastar(c); return st.run(...a); },
    raw: (...a) => { gastar(c); return st.raw(...a); }
  });
  return { prepare: sql => embrulhar(db.prepare(sql)), batch: sts => { gastar(c); return db.batch(sts.map(x => x?._st || x)); }, exec: q => { gastar(c); return db.exec(q); } };
}
function criarContexto(env, opcoes = {}) {
  const c = {
    env, db: null, sim: !!opcoes.simulacao, ignorarHorario: !!opcoes.ignorarHorario, chamadas: 0,
    registro: [], agora: () => (typeof env.__agora === "function" ? env.__agora() : Date.now())
  };
  c.db = contarDB(env.DB, c);
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
  `CREATE TABLE IF NOT EXISTS d30_prestador_tels (telefone TEXT PRIMARY KEY, prestador_id TEXT NOT NULL, criado_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS d30_envios (chave TEXT PRIMARY KEY, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_envios_ms ON d30_envios(criado_ms)`,
  `CREATE TABLE IF NOT EXISTS d30_midias (id INTEGER PRIMARY KEY AUTOINCREMENT, caso_id INTEGER, telefone TEXT, media_id TEXT NOT NULL, tipo TEXT, mime TEXT, legenda TEXT, comprovante INTEGER DEFAULT 0, enviado_para TEXT, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_midias_caso ON d30_midias(caso_id)`,
  `CREATE TABLE IF NOT EXISTS d30_agendados (id INTEGER PRIMARY KEY AUTOINCREMENT, consulta_id INTEGER, caso_id INTEGER, para TEXT NOT NULL, texto TEXT NOT NULL, inicial INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'PENDENTE', criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_agendados_status ON d30_agendados(status, criado_ms)`,
  `CREATE TABLE IF NOT EXISTS d30_reunioes (id INTEGER PRIMARY KEY AUTOINCREMENT, pessoa_id INTEGER, telefone TEXT NOT NULL, nome TEXT, caso_id INTEGER, quando_ms INTEGER, quando_txt TEXT, assunto TEXT, status TEXT NOT NULL DEFAULT 'MARCADA', lembrado_ms INTEGER, criado_ms INTEGER NOT NULL, atualizado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_reunioes_quando ON d30_reunioes(status, quando_ms)`,
  `CREATE TABLE IF NOT EXISTS d30_destinos (telefone TEXT PRIMARY KEY, motivo TEXT NOT NULL, codigo INTEGER, desde_ms INTEGER NOT NULL, ate_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS d30_guardadas (id INTEGER PRIMARY KEY AUTOINCREMENT, telefone TEXT NOT NULL, texto TEXT NOT NULL, papel TEXT, status TEXT NOT NULL DEFAULT 'GUARDADA', criado_ms INTEGER NOT NULL, enviado_ms INTEGER)`,
  `CREATE INDEX IF NOT EXISTS d30_guardadas_tel ON d30_guardadas(telefone, status)`,
  `CREATE TABLE IF NOT EXISTS d30_prestadores (id TEXT PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT NOT NULL, area TEXT NOT NULL, servicos TEXT, ordem INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1, atualizado_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS d30_tg_msgs (message_id INTEGER PRIMARY KEY, caso_id INTEGER, telefone TEXT, texto TEXT, criado_ms INTEGER NOT NULL)`,
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
  `CREATE INDEX IF NOT EXISTS d30_ficha_tel ON d30_ficha(telefone)`,
  `CREATE TABLE IF NOT EXISTS d30_guia_categorias (id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL, nome TEXT NOT NULL, palavras TEXT, ordem INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS d30_guia_lojas (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, telefone TEXT, whatsapp TEXT, local TEXT, descricao TEXT, destaque INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS d30_guia_loja_cat (loja_id INTEGER NOT NULL, categoria_id INTEGER NOT NULL, PRIMARY KEY (loja_id, categoria_id))`,
  `CREATE TABLE IF NOT EXISTS d30_guia_buscas (id INTEGER PRIMARY KEY AUTOINCREMENT, telefone TEXT, nome TEXT, tipo TEXT, categoria_id INTEGER, categoria TEXT, texto TEXT, via TEXT, lojas INTEGER, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_guia_buscas_ms ON d30_guia_buscas(criado_ms)`,
  `CREATE TABLE IF NOT EXISTS d30_dossie (pessoa_id INTEGER PRIMARY KEY, resumo TEXT NOT NULL, ate_id INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, atualizado_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS d30_saida_fila (id INTEGER PRIMARY KEY AUTOINCREMENT, para TEXT NOT NULL, corpo TEXT NOT NULL, motivo TEXT, status TEXT NOT NULL DEFAULT 'PENDENTE', tentativas INTEGER NOT NULL DEFAULT 0, erro TEXT, wamid TEXT, criado_ms INTEGER NOT NULL, atualizado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_saida_fila_status ON d30_saida_fila(status, id)`,
  `CREATE TABLE IF NOT EXISTS d30_entregas (wamid TEXT PRIMARY KEY, telefone TEXT, status TEXT NOT NULL, codigo INTEGER, erro TEXT, detalhe TEXT, tentativas INTEGER NOT NULL DEFAULT 0, enviado_ms INTEGER, entregue_ms INTEGER, lido_ms INTEGER, falhou_ms INTEGER, atualizado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS d30_entregas_status ON d30_entregas(status, atualizado_ms)`,
  `CREATE INDEX IF NOT EXISTS d30_entregas_enviado ON d30_entregas(enviado_ms)`,
  `CREATE TABLE IF NOT EXISTS d30_uso (dia TEXT NOT NULL, operacao TEXT NOT NULL, modelo TEXT NOT NULL DEFAULT '', chamadas INTEGER NOT NULL DEFAULT 0, erros INTEGER NOT NULL DEFAULT 0, tokens_entrada INTEGER NOT NULL DEFAULT 0, tokens_saida INTEGER NOT NULL DEFAULT 0, tokens_cache INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (dia, operacao, modelo))`
];
const SQL_INDICES_LEGADO = [
  `CREATE INDEX IF NOT EXISTS d30_idx_msg_pessoa ON mensagens(empresa_id, pessoa_id, id)`,
  `CREATE INDEX IF NOT EXISTS d30_idx_msg_criado ON mensagens(empresa_id, criado_em)`,
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
    // Tudo numa só chamada ao banco (o plano gratuito conta cada consulta).
    try { await c.db.batch(SQL_SCHEMA.map(x => c.db.prepare(x))); }
    catch { for (const x of SQL_SCHEMA) await c.db.prepare(x).run(); }
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

function hashTexto(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
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
  // Guardada durante a execução: a mesma pessoa era lida várias vezes por mensagem.
  const chave = digitos(tel);
  c.cachePessoas = c.cachePessoas || new Map();
  if (c.cachePessoas.has(chave)) { const p = c.cachePessoas.get(chave); return p ? { ...p } : p; }
  const vs = variantesTel(tel);
  const p = await c.db.prepare(`SELECT id,nome,telefone,tipo,email,criado_em FROM pessoas WHERE empresa_id=? AND telefone IN (${vs.map(() => "?").join(",")}) AND COALESCE(ativo,1)=1 ORDER BY id LIMIT 1`)
    .bind(EMPRESA_ID, ...vs).first();
  if (p) c.cachePessoas.set(chave, { ...p });
  return p;
}
async function obterPessoa(c, tel, nome, tipo) {
  let p = await buscarPessoa(c, tel);
  if (!p) {
    try {
      await c.db.prepare("INSERT INTO pessoas(empresa_id,nome,telefone,tipo,ativo,atualizado_em) VALUES(?,?,?,?,1,CURRENT_TIMESTAMP)")
        .bind(EMPRESA_ID, txt(nome, 120) || null, digitos(tel), tipo).run();
    } catch (e) { console.warn("pessoa concorrente", e?.message); }
    c.cachePessoas?.delete(digitos(tel));
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

// ============================================================================
// ESTUDO DIÁRIO — toda noite a DENIA relê as conversas do dia, encontra os próprios erros (perguntas
// repetidas, contexto ignorado, cliente antigo tratado como novo, resposta longa ou robótica, chamar a
// equipe sem precisar, informação errada) e escreve lições que passam a valer no atendimento seguinte.
// Conhecimento novo (preço, serviço, regra) vai para Aprendizados e só vale com aprovação. Uma vez por
// semana pesquisa na internet boas práticas de atendimento com empatia.
// ============================================================================
const INSTRUCOES_ESTUDO = `Você é a supervisora de qualidade da Central de Atendimento e treina a assistente DENIA. Leia as conversas de HOJE (clientes, profissionais, equipe e DENIA) e avalie SÓ as mensagens da DENIA, com rigor e justiça.
Procure: perguntas repetidas ou desnecessárias; contexto ignorado (cliente antigo tratado como novo, endereço já informado pedido de novo, serviço já agendado pela equipe e a DENIA agindo como se não estivesse); informação inventada; resposta longa, fria ou robótica; demora; chamar a equipe quando dava para resolver; não chamar quando precisava; erro com profissional (pedir valor de algo já combinado, confundir atendimentos).
Depois escreva LIÇÕES curtas e acionáveis, no imperativo, que corrijam esses erros e que valham para qualquer conversa (sem nomes, telefones ou dados pessoais). Exemplo: "Antes de pedir valor ao profissional, confira se a equipe já combinou o serviço por fora."
Conhecimento NOVO sobre a empresa que apareceu nas conversas (preço praticado, serviço, quem atende, regra) vai em "conhecimento", nunca em lições.
Responda em JSON: {"nota":0-10,"resumo":"2 frases sobre o dia","erros":[{"erro":"o que aconteceu","correcao":"como deveria ter sido"}],"licoes":["..."],"conhecimento":[{"tipo":"RESPOSTA_PADRAO|PRECO_PRATICADO|QUEM_ATENDE|REGRA|INFORMACAO","titulo":"","conteudo":""}]}`;
const MAX_LICOES = 30;
async function incorporarLicoes(c, novas, autor) {
  const limpas = novas.map(x => ocultarTelefones(txt(x, 280))).filter(x => x.length > 12);
  if (!limpas.length) return 0;
  const treino = await carregarTreinamento(c);
  const atuais = String(treino.dados?.licoes_diarias || "").split("\n").map(l => l.replace(/^[-•]\s*/, "").trim()).filter(Boolean);
  const vistas = new Set(atuais.map(l => norm(l.replace(/^\(\d{2}\/\d{2}\)\s*/, ""))));
  const dia = dataSP(c.agora()).slice(5).split("-").reverse().join("/");
  const acrescentar = limpas.filter(l => !vistas.has(norm(l))).map(l => `(${dia}) ${l}`);
  if (!acrescentar.length) return 0;
  const lista = [...acrescentar, ...atuais].slice(0, MAX_LICOES);
  await salvarTreinamento(c, { licoes_diarias: lista.map(l => "- " + l).join("\n") }, autor, true);
  return acrescentar.length;
}
async function estudoDiario(c, { forcar = false } = {}) {
  if (!c.env.OPENAI_API_KEY || c.sim) return null;
  const agora = c.agora(), dia = dataSP(agora);
  if (!forcar && horaSP(agora) < 21) return null;
  if (!forcar && !(await reservarChave(c, "estudo:" + dia))) return null;
  const linhas = (await c.db.prepare(`SELECT m.pessoa_id, m.direcao, m.origem, m.conteudo, m.criado_em, p.tipo FROM mensagens m LEFT JOIN pessoas p ON p.id=m.pessoa_id
    WHERE m.empresa_id=? AND m.criado_em > datetime('now','-1 day') AND m.pessoa_id IN (SELECT DISTINCT pessoa_id FROM mensagens WHERE empresa_id=? AND UPPER(origem) IN ('IA','SISTEMA') AND criado_em > datetime('now','-1 day') LIMIT 15)
    ORDER BY m.pessoa_id, m.id LIMIT 700`).bind(EMPRESA_ID, EMPRESA_ID).all().catch(() => null))?.results || [];
  if (!linhas.length) return { vazio: true };
  const porPessoa = new Map();
  for (const m of linhas) {
    const quem = String(m.origem).toUpperCase() === "LIGACAO" ? "LIGAÇÃO (resumo da equipe)" : String(m.direcao).toUpperCase() === "ENTRADA" ? (String(m.tipo || "").toUpperCase() === "TECNICO" ? "PROFISSIONAL" : "CLIENTE") : String(m.origem).toUpperCase() === "HUMANO" ? "EQUIPE" : "DENIA";
    if (!porPessoa.has(m.pessoa_id)) porPessoa.set(m.pessoa_id, []);
    porPessoa.get(m.pessoa_id).push(`[${String(m.criado_em || "").slice(11, 16)}] ${quem}: ${ocultarTelefones(txt(m.conteudo, 300))}`);
  }
  const transcricao = [...porPessoa.values()].map((l, i) => `--- Conversa ${i + 1}\n${l.join("\n")}`).join("\n").slice(0, 40000);
  const treino = await carregarTreinamento(c);
  const o = await openaiJSON(c, INSTRUCOES_ESTUDO, `LIÇÕES QUE A DENIA JÁ TEM (não repita):\n${treino.dados?.licoes_diarias || "(nenhuma)"}\n\nCONVERSAS DE HOJE:\n${transcricao}\n\nResponda em JSON.`, [], 1600);
  const licoes = (Array.isArray(o?.licoes) ? o.licoes : []).slice(0, 6);
  const novas = await incorporarLicoes(c, licoes, "estudo diário (automático)");
  let conhecimentos = 0;
  for (const it of (Array.isArray(o?.conhecimento) ? o.conhecimento : []).slice(0, 5)) {
    const tipo = TIPOS_SUGESTAO.includes(String(it?.tipo).toUpperCase()) ? String(it.tipo).toUpperCase() : "INFORMACAO";
    const titulo = ocultarTelefones(txt(it?.titulo, 140)), conteudo = ocultarTelefones(txt(it?.conteudo, 600));
    if (!titulo || !conteudo || /\b(cpf|rg)\b/i.test(conteudo)) continue;
    const hash = await hmacHex("sugestao", tipo + "|" + norm(titulo));
    await c.db.prepare(`INSERT INTO d30_sugestoes(hash,tipo,titulo,conteudo,evidencia,ocorrencias,status,criado_ms) VALUES(?,?,?,?,?,1,'PENDENTE',?) ON CONFLICT(hash) DO UPDATE SET ocorrencias=d30_sugestoes.ocorrencias+1`)
      .bind(hash, tipo, titulo, conteudo, "Estudo diário de " + dia.split("-").reverse().join("/"), agora).run().catch(() => {});
    conhecimentos++;
  }
  const relatorio = { dia, conversas: porPessoa.size, nota: Number.isFinite(Number(o?.nota)) ? Math.max(0, Math.min(10, Number(o.nota))) : null, resumo: txt(o?.resumo, 500),
    erros: (Array.isArray(o?.erros) ? o.erros : []).slice(0, 10).map(e => ({ erro: ocultarTelefones(txt(e?.erro, 300)), correcao: ocultarTelefones(txt(e?.correcao, 300)) })), licoes, licoes_novas: novas, conhecimentos };
  await evento(c, null, "ESTUDO_DIARIO", relatorio.resumo || "Estudo do dia", relatorio);
  if (!forcar && String(c.env.TELEGRAM_AVISOS || "").toLowerCase() === "todos") await c.saida.telegram(`DENIA — estudo do dia (${porPessoa.size} conversas): nota ${relatorio.nota ?? "-"}/10. ${relatorio.resumo}${novas ? ` ${novas} lição(ões) nova(s) já valem amanhã.` : ""}${conhecimentos ? ` ${conhecimentos} conhecimento(s) para aprovar em Aprendizados.` : ""}`).catch(() => {});
  return relatorio;
}
// Uma vez por semana: pesquisa na internet boas práticas de atendimento com empatia e vira lição.
async function pesquisaSemanal(c, { forcar = false } = {}) {
  if (!c.env.OPENAI_API_KEY || c.sim) return null;
  const semana = Math.floor(c.agora() / (7 * 86400000));
  if (!forcar && !(await reservarChave(c, "pesquisa:" + semana))) return null;
  gastar(c);
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.env.OPENAI_API_KEY}` }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({ model: modelo(c.env), tools: [{ type: "web_search" }], max_output_tokens: 1200, store: false,
      input: "Pesquise na internet (cursos, guias e estudos recentes de atendimento ao cliente) as melhores práticas para atender clientes e profissionais parceiros pelo WhatsApp com empatia, rapidez e linguagem humana, para uma central de serviços residenciais no Brasil. Responda SÓ com até 8 regras práticas, uma por linha começando com \"- \", no imperativo, específicas e acionáveis (nada genérico como \"seja educado\")." })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { erro: d?.error?.message || `HTTP ${r.status}` };
  let texto = typeof d.output_text === "string" ? d.output_text : "";
  if (!texto) for (const it of d.output || []) for (const x of it.content || []) if (typeof x.text === "string") texto += x.text;
  const regras = texto.split("\n").map(l => l.replace(/^[-•*\d.)\s]+/, "").replace(/\[[^\]]*\]\([^)]*\)/g, "").trim()).filter(l => l.length > 15).slice(0, 8).map(l => "Boa prática: " + l);
  const novas = await incorporarLicoes(c, regras, "pesquisa semanal de boas práticas (automático)");
  await evento(c, null, "PESQUISA_SEMANAL", `${novas} boa(s) prática(s) nova(s)`, { regras });
  return { regras, novas };
}

// ============================================================================
// MEMÓRIA COMPLETA DO CLIENTE
// O histórico enviado à IA traz as últimas mensagens; esta memória resume TODA a relação com a pessoa,
// desde o primeiro contato (meses atrás): quem é, onde mora, o que já fez, com quem, quanto pagou,
// se houve problema, como prefere ser tratada. É atualizada quando surgem muitas mensagens novas.
// ============================================================================
const INSTRUCOES_MEMORIA = `Você é a memória da Central de Atendimento. Leia TODA a conversa de um contato (desde o primeiro dia) e o resumo anterior, e escreva o DOSSIÊ desse contato para a assistente consultar antes de responder.
Inclua só o que está nas mensagens (nunca invente):
- Quem é: nome e como gosta de ser chamado; se é cliente, profissional ou parceiro.
- Desde quando fala com a empresa, se é recorrente e com que frequência.
- Endereços e bairros já informados (o mais recente primeiro), pontos de referência, horários preferidos.
- Serviços anteriores: quando, o quê, qual profissional, valor, como terminou (concluído, cancelado, reclamação, garantia).
- Pendências em aberto (orçamento esperando resposta, pagamento, retorno prometido).
- Comportamento: educado, exigente, pechincha, atrasa pagamento, já reclamou, já elogiou; cuidados para o atendimento.
- Equipamentos/itens dele já citados (marca, modelo).
Escreva em tópicos curtos, em português, no máximo 1.800 caracteres. Responda em JSON {"dossie":"..."}`;
async function memoriaDoCliente(c, pessoa, { gerar = true, fundo = false } = {}) {
  if (!pessoa?.id) return "";
  try {
    const st = await c.db.prepare("SELECT MIN(criado_em) primeira, COUNT(*) total, MAX(id) ultimo FROM mensagens WHERE empresa_id=? AND pessoa_id=?").bind(EMPRESA_ID, pessoa.id).first();
    const total = Number(st?.total || 0);
    if (!total) return "";
    const dos = await c.db.prepare("SELECT resumo, ate_id, total FROM d30_dossie WHERE pessoa_id=?").bind(pessoa.id).first().catch(() => null);
    const primeira = String(st.primeira || "").slice(0, 10);
    const meses = primeira ? Math.max(0, Math.round((c.agora() - Date.parse(primeira + "T12:00:00Z")) / (30 * 86400000))) : 0;
    const cabeca = `Primeiro contato: ${primeira ? primeira.split("-").reverse().join("/") : "?"}${meses ? ` (há cerca de ${meses} ${meses === 1 ? "mês" : "meses"})` : " (este mês)"}. ${total} mensagem(ns) trocadas no total${total > HISTORICO_LIMITE ? `; o HISTÓRICO abaixo mostra só as ${HISTORICO_LIMITE} últimas — o resto está resumido aqui` : ""}.`;
    let resumo = dos?.resumo || "";
    // Gera (ou atualiza) o dossiê quando há mais mensagens do que cabem no histórico e ele está velho.
    const precisa = total > HISTORICO_LIMITE && (!dos || Number(st.ultimo || 0) - Number(dos.ate_id || 0) > 80);
    // Na resposta ao cliente só gera se sobrar folga (plano pago); senão o tick/cron prepara em segundo plano.
    if (precisa && gerar && !c.sim && sobram(c) > 30 && (fundo || limiteChamadas(c) >= 200)) {
      const antigas = ((await c.db.prepare("SELECT direcao, origem, conteudo, criado_em, caso_id FROM mensagens WHERE empresa_id=? AND pessoa_id=? AND id > ? ORDER BY id DESC LIMIT 900").bind(EMPRESA_ID, pessoa.id, Number(dos?.ate_id || 0)).all())?.results || []).reverse();
      let texto = antigas.map(m => `[${String(m.criado_em || "").slice(0, 10)}] ${String(m.direcao).toUpperCase() === "ENTRADA" ? "CONTATO" : String(m.origem).toUpperCase() === "HUMANO" ? "EQUIPE" : String(m.origem).toUpperCase() === "LIGACAO" ? "LIGAÇÃO (resumo)" : "DENIA"}: ${txt(m.conteudo, 280)}`).join("\n");
      if (texto.length > 45000) texto = texto.slice(0, 12000) + "\n[…]\n" + texto.slice(-33000); // começo da relação + o mais recente
      try {
        const o = await openaiJSON(c, INSTRUCOES_MEMORIA, `NOME NO CADASTRO: ${pessoa.nome || "-"}\nTIPO: ${pessoa.tipo || "CLIENTE"}\nDOSSIÊ ANTERIOR:\n${resumo || "(nenhum)"}\n\nMENSAGENS (mais antigas primeiro):\n${texto}\n\nResponda em JSON.`, [], 1100);
        const novo = txt(o?.dossie, 2200);
        if (novo) {
          resumo = novo;
          await c.db.prepare("INSERT OR REPLACE INTO d30_dossie(pessoa_id,resumo,ate_id,total,atualizado_ms) VALUES(?,?,?,?,?)").bind(pessoa.id, novo, Number(st.ultimo || 0), total, c.agora()).run();
        }
      } catch (e) { console.warn("memória", e?.message); }
    }
    // Sem dossiê ainda: mostra pelo menos como a relação começou (as primeiras mensagens).
    let inicio = "";
    if (!resumo && total > HISTORICO_LIMITE) {
      const primeiras = (await c.db.prepare("SELECT direcao, origem, conteudo, criado_em FROM mensagens WHERE empresa_id=? AND pessoa_id=? ORDER BY id LIMIT 8").bind(EMPRESA_ID, pessoa.id).all().catch(() => null))?.results || [];
      if (primeiras.length) inicio = "Como a conversa começou:\n" + primeiras.map(m => `[${String(m.criado_em || "").slice(0, 10)}] ${String(m.direcao).toUpperCase() === "ENTRADA" ? "CLIENTE" : String(m.origem).toUpperCase() === "HUMANO" ? "EQUIPE" : "DENIA"}: ${txt(m.conteudo, 220)}`).join("\n");
    }
    return [cabeca, resumo, inicio].filter(Boolean).join("\n");
  } catch (e) { console.warn("memória", e?.message); return ""; }
}
// Tick/cron: prepara a memória de quem falou nas últimas horas (a próxima resposta já sai sabendo de tudo).
async function prepararMemorias(c, maximo = 1) {
  // V31.9: no máximo a cada 30 min e só com quem falou nas últimas 24 h, achado pelo índice da fila.
  // (Antes varria a tabela inteira de mensagens a cada 5 min e estourava o limite diário de leitura do D1.)
  if (!(await reservarChave(c, "memorias:" + Math.floor(c.agora() / 1800000)))) return 0;
  const tels = (await c.db.prepare("SELECT telefone, MAX(recebido_ms) u FROM d30_fila WHERE recebido_ms > ? GROUP BY telefone ORDER BY u DESC LIMIT 15").bind(c.agora() - 86400000).all().catch(() => null))?.results || [];
  let feitas = 0;
  for (const t of tels) {
    if (feitas >= maximo || sobram(c) < 30) break;
    const p = await buscarPessoa(c, t.telefone);
    if (!p) continue;
    const x = await c.db.prepare("SELECT COUNT(*) n, MAX(id) ultimo FROM mensagens WHERE empresa_id=? AND pessoa_id=?").bind(EMPRESA_ID, p.id).first().catch(() => null);
    if (!x || Number(x.n) <= HISTORICO_LIMITE) continue;
    const d = await c.db.prepare("SELECT ate_id FROM d30_dossie WHERE pessoa_id=?").bind(p.id).first().catch(() => null);
    if (d && Number(x.ultimo) - Number(d.ate_id) <= 80) continue;
    await memoriaDoCliente(c, p, { fundo: true }); feitas++;
  }
  return feitas;
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
  await carregarTelsExtras(c);
  const prestador = prestadorPorTelefone(tel);
  const pessoa = await buscarPessoa(c, tel);
  if (prestador) return { papel: "PRESTADOR", prestador, pessoa };
  // Quem já recebeu uma consulta da DENIA é profissional, mesmo que o número não esteja (mais) na lista.
  const vsC = variantesTel(tel);
  const consultado = await c.db.prepare(`SELECT prestador_id FROM d30_consultas WHERE prestador_tel IN (${vsC.map(() => "?").join(",")}) AND criado_ms > ? ORDER BY id DESC LIMIT 1`)
    .bind(...vsC, c.agora() - 180 * 86400000).first().catch(() => null);
  if (consultado) return { papel: "PRESTADOR", prestador: PRESTADORES.find(x => x.id === consultado.prestador_id) || null, pessoa };
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
  if (String(m.origem).toUpperCase() === "LIGACAO") return "RESUMO DE LIGAÇÃO REGISTRADO PELA EQUIPE (conversa por telefone, não foi mensagem)";
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
  if (v === "EM_ANDAMENTO") return "EM_ANDAMENTO";
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
  const ligado = prestadorPorTelefone(tel); // número extra: as consultas estão no número principal
  const vs = [...new Set([...variantesTel(tel), ...(ligado ? variantesTel(ligado.telefone) : [])])], agora = c.agora();
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
  c.cachePausas?.clear();
  const ate = c.agora() + ms;
  await c.db.prepare("INSERT INTO d30_pausas(telefone,ate_ms,motivo) VALUES(?,?,?) ON CONFLICT(telefone) DO UPDATE SET ate_ms=MAX(d30_pausas.ate_ms, excluded.ate_ms), motivo=excluded.motivo")
    .bind(digitos(tel), ate, motivo).run();
}
async function liberarPausa(c, tel) {
  c.cachePausas?.clear();
  for (const v of variantesTel(tel)) await c.db.prepare("DELETE FROM d30_pausas WHERE telefone=?").bind(v).run();
}
async function estaPausado(c, tel) {
  const chave = digitos(tel);
  c.cachePausas = c.cachePausas || new Map();
  const g = c.cachePausas.get(chave);
  if (g && g.ate > c.agora()) return g.pausado; // vale por 20 s dentro da mesma execução
  const vs = variantesTel(tel);
  const r = await c.db.prepare(`SELECT ate_ms FROM d30_pausas WHERE telefone IN (${vs.map(() => "?").join(",")}) AND ate_ms > ? LIMIT 1`).bind(...vs, c.agora()).first();
  c.cachePausas.set(chave, { pausado: Boolean(r), ate: c.agora() + 20000 });
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
function corpoTexto(to, texto) { return { messaging_product: "whatsapp", recipient_type: "individual", to: digitos(to), type: "text", text: { preview_url: false, body: String(texto).slice(0, 4000) } }; }
function corpoMidia(to, tipo, mediaId, legenda) {
  const t = ["image", "video", "audio", "document"].includes(tipo) ? tipo : "document";
  const obj = { id: mediaId };
  if (legenda && t !== "audio") obj.caption = String(legenda).slice(0, 900);
  return { messaging_product: "whatsapp", recipient_type: "individual", to: digitos(to), type: t, [t]: obj };
}
function corpoTemplate(env, to, nome, params) {
  return {
    messaging_product: "whatsapp", recipient_type: "individual", to: digitos(to), type: "template",
    template: { name: nome, language: { code: String(env.WHATSAPP_TEMPLATE_IDIOMA || "pt_BR") }, components: [{ type: "body", parameters: params.map(p => ({ type: "text", text: txt(p, 900) || "-" })) }] }
  };
}
function metaTexto(env, to, texto) { return metaPost(env, corpoTexto(to, texto)); }
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

async function telegramEnviar(env, texto, op = {}) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(env.TELEGRAM_CHAT_ID), text: String(texto).slice(0, 4000), disable_web_page_preview: true, ...(op.responderA ? { reply_to_message_id: Number(op.responderA), allow_sending_without_reply: true } : {}) }),
      signal: AbortSignal.timeout(15000)
    });
    const d = await r.json().catch(() => ({}));
    return d?.ok === true ? { ok: true, id: d?.result?.message_id || null } : { ok: false, erro: d?.description || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, erro: String(e?.message || e) }; }
}

// ============================================================================
// CONFIRMAÇÃO DE ENTREGA (statuses do webhook)
// A Meta aceitar a mensagem (devolver o id) NÃO quer dizer que ela chegou. A entrega de verdade
// chega depois pelo webhook: sent → delivered → read, ou failed com o motivo. Tudo é guardado aqui,
// a equipe é avisada quando falha e o painel mostra ✓, ✓✓, lida ou ⚠ em cada mensagem.
// ============================================================================

const ERROS_ENTREGA = {
  131026: "O número não pode receber: não tem WhatsApp, usa uma versão antiga ou ainda não aceitou os novos Termos do WhatsApp.",
  131047: "Passaram mais de 24 horas desde a última mensagem da pessoa: só dá para mandar um modelo (template) aprovado.",
  131049: "A Meta segurou a mensagem para não cansar a pessoa (limite de mensagens de marketing).",
  131050: "A pessoa pediu para não receber mensagens de marketing desta empresa.",
  131042: "Problema de pagamento na conta do WhatsApp Business: cadastre ou regularize o cartão em business.facebook.com → Configurações → Pagamentos do WhatsApp.",
  131031: "A conta do WhatsApp Business foi bloqueada ou restringida pela Meta. Veja o aviso em business.facebook.com → Gerenciador do WhatsApp.",
  131045: "O número de envio não está registrado corretamente na API do WhatsApp (certificado). Registre o número de novo no Gerenciador do WhatsApp.",
  133010: "O número de envio não está registrado na API do WhatsApp. No Gerenciador do WhatsApp, conclua o registro do número.",
  131048: "A Meta limitou os envios por denúncias ou bloqueios de spam. Reduza mensagens não pedidas e aguarde.",
  131056: "Muitas mensagens para o mesmo número em pouco tempo. Aguarde alguns minutos.",
  130429: "Limite de velocidade de envio da Meta atingido. A DENIA tenta de novo.",
  131000: "Erro interno da Meta. A DENIA tenta de novo.",
  131016: "O serviço do WhatsApp está instável agora. A DENIA tenta de novo.",
  131053: "A Meta não conseguiu enviar a mídia (formato ou tamanho).",
  131051: "Tipo de mensagem não suportado.",
  131052: "A Meta não conseguiu baixar a mídia enviada pela pessoa.",
  130472: "O número da pessoa faz parte de um teste da Meta e não recebe esta mensagem agora.",
  131021: "A mensagem foi enviada para o próprio número da empresa.",
  368: "O número da empresa foi bloqueado temporariamente por violar as políticas do WhatsApp.",
  190: "O token do WhatsApp (WHATSAPP_TOKEN) expirou ou foi removido. Gere um token permanente (usuário do sistema) e cole no Worker do motor.",
  10: "O token do WhatsApp não tem permissão para enviar por este número (whatsapp_business_messaging).",
  100: "Pedido recusado pela Meta (parâmetro inválido).",
  132000: "O modelo (template) foi enviado com parâmetros faltando.",
  132001: "O modelo (template) não existe ou não está aprovado neste idioma.",
  132015: "O modelo (template) foi pausado pela Meta por baixa qualidade."
};
// Erros que valem para a conta inteira (ninguém recebe): disparam o alerta crítico.
const ERROS_DA_CONTA = new Set([131042, 131031, 131045, 133010, 131048, 368, 190, 10]);
const ERROS_PASSAGEIROS = new Set([131000, 131016, 130429, 131056]);
const ORDEM_ENTREGA = { ACEITA: 1, SENT: 2, DELIVERED: 3, READ: 4 };
function explicarEntrega(codigo, padrao) { return ERROS_ENTREGA[Number(codigo)] || txt(padrao || "A Meta não entregou a mensagem.", 300); }

async function registrarEnvio(c, wamid, to) {
  if (!wamid || c.sim || sobram(c) < 3) return;
  try { await c.db.prepare("INSERT OR IGNORE INTO d30_entregas(wamid,telefone,status,enviado_ms,atualizado_ms) VALUES(?,?,'ACEITA',?,?)").bind(String(wamid), digitos(to), c.agora(), c.agora()).run(); }
  catch (e) { console.warn("entrega", e?.message); }
}
// Bloqueio da conta (pagamento, token, número): fica guardado para o painel mostrar em vermelho.
async function anotarBloqueio(c, codigo, erro) {
  if (!ERROS_DA_CONTA.has(codigo)) return;
  try {
    await c.db.prepare("INSERT OR REPLACE INTO d30_meta(chave,valor) VALUES('entrega_bloqueada',?)").bind(JSON.stringify({ codigo, erro: explicarEntrega(codigo, erro), original: txt(erro, 300), em: c.agora() })).run();
    await alertarEquipe(c, `🚨 WhatsApp NÃO está entregando mensagens: ${explicarEntrega(codigo, erro)} (código ${codigo}). Até resolver, clientes e profissionais não recebem nada — a equipe precisa responder pelo celular.`, "bloqueio:" + codigo + ":" + Math.floor(c.agora() / 3600000));
  } catch (e) { console.warn("bloqueio", e?.message); }
}

function extrairStatuses(payload, env) {
  const lista = [];
  for (const entry of payload?.entry || []) for (const ch of entry?.changes || []) {
    const v = ch?.value || {};
    const pid = v?.metadata?.phone_number_id;
    if (pid && String(pid) !== phoneId(env)) continue;
    for (const st of v.statuses || []) {
      const erro = (st.errors || [])[0] || null;
      lista.push({ wamid: String(st.id || ""), status: String(st.status || "").toUpperCase(), para: digitos(st.recipient_id || ""), ts: Number(st.timestamp || 0) * 1000 || null,
        codigo: erro ? Number(erro.code) || null : null, erro: erro ? txt(erro.title || erro.message, 300) : null, detalhe: erro ? txt(erro.error_data?.details || erro.message, 500) : null });
    }
  }
  return lista.filter(x => x.wamid && x.status);
}

async function processarStatus(c, st) {
  const atual = await c.db.prepare("SELECT * FROM d30_entregas WHERE wamid=?").bind(st.wamid).first().catch(() => null);
  const agora = c.agora();
  if (st.status === "FAILED") {
    if (atual && ["DELIVERED", "READ"].includes(atual.status)) return; // chegou atrasado: vale a entrega
    await c.db.prepare(`INSERT INTO d30_entregas(wamid,telefone,status,codigo,erro,detalhe,falhou_ms,atualizado_ms) VALUES(?,?,'FAILED',?,?,?,?,?)
      ON CONFLICT(wamid) DO UPDATE SET status='FAILED', codigo=excluded.codigo, erro=excluded.erro, detalhe=excluded.detalhe, falhou_ms=excluded.falhou_ms, atualizado_ms=excluded.atualizado_ms`)
      .bind(st.wamid, st.para, st.codigo, st.erro, st.detalhe, agora, agora).run();
    const msg = await c.db.prepare("SELECT m.id, m.caso_id, m.conteudo, m.tipo_conteudo, m.origem, p.nome, p.tipo FROM mensagens m LEFT JOIN pessoas p ON p.id=m.pessoa_id WHERE m.whatsapp_message_id=? LIMIT 1").bind(st.wamid).first().catch(() => null);
    const motivo = explicarEntrega(st.codigo, st.detalhe || st.erro);
    await evento(c, msg?.caso_id, "FALHA_ENTREGA", motivo, { wamid: st.wamid, para: st.para, codigo: st.codigo, erro: st.erro, detalhe: st.detalhe });
    // Falha passageira: tenta de novo uma vez com o mesmo texto.
    if (ERROS_PASSAGEIROS.has(Number(st.codigo)) && msg && String(msg.tipo_conteudo || "TEXTO").toUpperCase() === "TEXTO" && msg.conteudo && Number(atual?.tentativas || 0) < 1) {
      await c.db.prepare("UPDATE d30_entregas SET tentativas=tentativas+1 WHERE wamid=?").bind(st.wamid).run();
      const r = await c.saida.texto(st.para, msg.conteudo);
      if (r.ok) { await c.db.prepare("UPDATE mensagens SET whatsapp_message_id=? WHERE id=?").bind(r.id, msg.id).run(); await c.db.prepare("UPDATE d30_entregas SET status='REENVIADA' WHERE wamid=?").bind(st.wamid).run(); await evento(c, msg.caso_id, "REENVIO_ENTREGA", "Reenviada depois de falha passageira da Meta.", { antes: st.wamid, depois: r.id }); return; }
    }
    const cod = Number(st.codigo);
    const textoMsg = msg && String(msg.tipo_conteudo || "TEXTO").toUpperCase() === "TEXTO" ? msg.conteudo : "";
    if (ERROS_DA_CONTA.has(cod)) await anotarBloqueio(c, cod, st.detalhe || st.erro);
    // Janela de 24 h: guarda e entrega quando a pessoa responder (sem tentar de novo nem avisar a cada mensagem).
    else if (cod === 131047 || cod === 470) await marcarForaDaJanela(c, st.para, { codigo: cod, texto: textoMsg, nome: msg?.nome, tipo: msg?.tipo });
    else if (cod === 131026) {
      await c.db.prepare("INSERT OR REPLACE INTO d30_destinos(telefone,motivo,codigo,desde_ms,ate_ms) VALUES(?, 'INVALIDO', ?, ?, ?)").bind(digitos(st.para), cod, agora, agora + 7 * 86400000).run().catch(() => { });
      await alertarEquipe(c, `⚠️ Mensagem NÃO entregue para ${msg?.nome || st.para} (${papelLegivel("", msg?.tipo)}, ${st.para}): ${motivo} A DENIA não vai tentar de novo nesse número por 7 dias (ou até a pessoa escrever). Confira o número com ela por outro meio.`, `invalido:${st.para}:${Math.floor(agora / (7 * 86400000))}`, msg?.caso_id);
    }
    else await alertarEquipe(c, `⚠️ Mensagem NÃO entregue para ${msg?.nome || st.para} (${papelLegivel("", msg?.tipo)}): ${motivo}${msg?.caso_id ? ` — caso #${msg.caso_id}` : ""}. Texto: "${txt(msg?.conteudo, 200)}"`, `falha:${st.para}:${cod || "x"}:${Math.floor(agora / (6 * 3600000))}`, msg?.caso_id);
    return;
  }
  if (!ORDEM_ENTREGA[st.status]) return;
  if (atual && atual.status !== "FAILED" && (ORDEM_ENTREGA[atual.status] || 0) >= ORDEM_ENTREGA[st.status]) return;
  const campo = st.status === "DELIVERED" ? "entregue_ms" : st.status === "READ" ? "lido_ms" : null;
  await c.db.prepare(`INSERT INTO d30_entregas(wamid,telefone,status,${campo ? campo + "," : ""}atualizado_ms) VALUES(?,?,?,${campo ? "?," : ""}?)
    ON CONFLICT(wamid) DO UPDATE SET status=excluded.status, ${campo ? `${campo}=COALESCE(${campo}, excluded.${campo}),` : ""} codigo=NULL, erro=NULL, atualizado_ms=excluded.atualizado_ms`)
    .bind(st.wamid, st.para, st.status, ...(campo ? [st.ts || agora] : []), agora).run();
  // Uma entrega confirmada prova que a conta voltou a funcionar.
  if (st.status === "DELIVERED" || st.status === "READ") await c.db.prepare("DELETE FROM d30_meta WHERE chave='entrega_bloqueada'").run().catch(() => {});
}

// Cron: mensagens aceitas há mais de 20 min sem nenhuma confirmação da Meta.
async function vigiarEntregas(c) {
  const agora = c.agora();
  const presas = Number((await c.db.prepare("SELECT COUNT(*) n FROM d30_entregas WHERE status='ACEITA' AND enviado_ms BETWEEN ? AND ?").bind(agora - 6 * 3600000, agora - 20 * 60000).first().catch(() => null))?.n || 0);
  const confirmadas = Number((await c.db.prepare("SELECT COUNT(*) n FROM d30_entregas WHERE status IN ('SENT','DELIVERED','READ','FAILED') AND atualizado_ms > ?").bind(agora - 6 * 3600000).first().catch(() => null))?.n || 0);
  if (presas >= 5 && confirmadas === 0) await alertarEquipe(c, `⚠️ ${presas} mensagens foram aceitas pela Meta nas últimas horas, mas nenhuma confirmação de entrega chegou. Confira no app da Meta → WhatsApp → Configuração → Webhooks se o campo "messages" está assinado, e o diagnóstico no painel.`, "sem-confirmacao:" + Math.floor(agora / (6 * 3600000)));
  await c.db.prepare("DELETE FROM d30_entregas WHERE atualizado_ms < ?").bind(agora - 60 * 86400000).run().catch(() => {});
}
async function resumoEntregas(c, desdeMs) {
  const linhas = (await c.db.prepare("SELECT status, COUNT(*) n FROM d30_entregas WHERE COALESCE(enviado_ms, atualizado_ms) > ? GROUP BY status").bind(desdeMs).all().catch(() => null))?.results || [];
  const r = { aceitas: 0, enviadas: 0, entregues: 0, lidas: 0, falhas: 0, reenviadas: 0 };
  for (const l of linhas) { const k = { ACEITA: "aceitas", SENT: "enviadas", DELIVERED: "entregues", READ: "lidas", FAILED: "falhas", REENVIADA: "reenviadas" }[l.status]; if (k) r[k] += Number(l.n || 0); }
  r.total = r.aceitas + r.enviadas + r.entregues + r.lidas + r.falhas;
  r.taxa_entrega = r.total ? Math.round(((r.entregues + r.lidas) / r.total) * 1000) / 10 : null;
  r.motivos = ((await c.db.prepare("SELECT codigo, MAX(erro) erro, MAX(detalhe) detalhe, COUNT(*) n, MAX(falhou_ms) em FROM d30_entregas WHERE status='FAILED' AND falhou_ms > ? GROUP BY codigo ORDER BY n DESC LIMIT 5").bind(desdeMs).all().catch(() => null))?.results || [])
    .map(x => ({ codigo: x.codigo, n: x.n, em: x.em, motivo: explicarEntrega(x.codigo, x.detalhe || x.erro), original: txt(x.detalhe || x.erro, 200) }));
  // Resolvido? Falhas antigas não contam se depois delas as mensagens voltaram a ser entregues.
  const t = await c.db.prepare("SELECT MAX(CASE WHEN status IN ('DELIVERED','READ') THEN COALESCE(entregue_ms, lido_ms, atualizado_ms) END) ok, MAX(CASE WHEN status='FAILED' THEN falhou_ms END) falha FROM d30_entregas WHERE atualizado_ms > ?").bind(desdeMs).first().catch(() => null);
  r.ultima_entrega_ms = Number(t?.ok || 0) || null;
  r.ultima_falha_ms = Number(t?.falha || 0) || null;
  r.falhas_pendentes = r.ultima_falha_ms && (!r.ultima_entrega_ms || r.ultima_falha_ms > r.ultima_entrega_ms)
    ? Number((await c.db.prepare("SELECT COUNT(*) n FROM d30_entregas WHERE status='FAILED' AND falhou_ms > ?").bind(Math.max(desdeMs, r.ultima_entrega_ms || 0)).first().catch(() => null))?.n || 0) : 0;
  r.resolvido = Boolean(r.falhas && !r.falhas_pendentes);
  return r;
}

// ----- Fila de envio: o que não coube nesta execução sai na próxima (cron a cada minuto ou próximo webhook).
async function adiarEnvio(c, to, corpo, motivo) {
  try {
    const r = await c.db.prepare("INSERT INTO d30_saida_fila(para,corpo,motivo,status,tentativas,criado_ms,atualizado_ms) VALUES(?,?,?,'PENDENTE',0,?,?) RETURNING id")
      .bind(digitos(to), JSON.stringify(corpo), txt(motivo, 200), c.agora(), c.agora()).first();
    const id = r?.id;
    if (!id) throw new Error("fila sem id");
    console.warn("Envio adiado para a próxima execução:", motivo);
    return { ok: true, id: "fila:" + id, adiado: true };
  } catch (e) {
    // Sem banco nesta execução: guarda no KV (tem limite próprio) para o cron enviar.
    try {
      if (c.env.MEMORIA) { const k = "saida:" + c.agora() + ":" + crypto.randomUUID(); await c.env.MEMORIA.put(k, JSON.stringify({ to: digitos(to), corpo, motivo }), { expirationTtl: 86400 }); return { ok: true, id: "kv:" + k, adiado: true }; }
    } catch { /* nada a fazer */ }
    return { ok: false, erro: "Não foi possível enviar nem guardar na fila: " + txt(motivo, 160) };
  }
}
// Envia o que ficou na fila. Primeira coisa do cron, com a execução ainda "zerada".
async function enviarFila(c, maximo = 12) {
  let enviados = 0;
  const itens = (await c.db.prepare("SELECT * FROM d30_saida_fila WHERE status='PENDENTE' ORDER BY id LIMIT ?").bind(maximo).all().catch(() => null))?.results || [];
  for (const it of itens) {
    if (sobram(c) < 8) break;
    // Resposta que não saiu em 15 min não sai mais (a conversa já seguiu): fica marcada como não enviada no painel.
    if (c.agora() - Number(it.criado_ms || 0) > FILA_EXPIRA_MS) {
      await c.db.batch([
        c.db.prepare("UPDATE d30_saida_fila SET status='EXPIRADA', atualizado_ms=? WHERE id=?").bind(c.agora(), it.id),
        c.db.prepare("INSERT OR REPLACE INTO d30_entregas(wamid,telefone,status,erro,falhou_ms,atualizado_ms) VALUES(?,?,'FAILED',?,?,?)").bind("fila:" + it.id, it.para, "Não saiu a tempo (ficou na fila mais de 15 minutos) e não foi enviada para não chegar fora de hora.", c.agora(), c.agora())
      ]);
      continue;
    }
    let corpo; try { corpo = JSON.parse(it.corpo); } catch { corpo = null; }
    if (!corpo) { await c.db.prepare("UPDATE d30_saida_fila SET status='ERRO', erro='corpo inválido', atualizado_ms=? WHERE id=?").bind(c.agora(), it.id).run(); continue; }
    gastar(c);
    const r = await metaPost(c.env, corpo);
    const ref = "fila:" + it.id;
    if (r.ok) {
      enviados++;
      await c.db.batch([
        c.db.prepare("UPDATE d30_saida_fila SET status='ENVIADA', wamid=?, atualizado_ms=? WHERE id=?").bind(r.id, c.agora(), it.id),
        c.db.prepare("UPDATE mensagens SET whatsapp_message_id=? WHERE whatsapp_message_id=?").bind(r.id, ref),
        c.db.prepare("INSERT INTO d30_saidas(telefone,criado_ms) VALUES(?,?)").bind(it.para, c.agora()),
        c.db.prepare("INSERT OR IGNORE INTO d30_entregas(wamid,telefone,status,enviado_ms,atualizado_ms) VALUES(?,?,'ACEITA',?,?)").bind(r.id, it.para, c.agora(), c.agora())
      ]);
    } else if (Number(it.tentativas || 0) < 2 && (r.incerto || /subrequest/i.test(String(r.erro || "")))) {
      await c.db.prepare("UPDATE d30_saida_fila SET tentativas=tentativas+1, erro=?, atualizado_ms=? WHERE id=?").bind(txt(r.erro, 300), c.agora(), it.id).run();
    } else {
      await c.db.batch([
        c.db.prepare("UPDATE d30_saida_fila SET status='ERRO', erro=?, atualizado_ms=? WHERE id=?").bind(txt(r.erro, 300), c.agora(), it.id),
        c.db.prepare("INSERT OR REPLACE INTO d30_entregas(wamid,telefone,status,codigo,erro,falhou_ms,atualizado_ms) VALUES(?,?,'FAILED',?,?,?,?)").bind(ref, it.para, r.codigo || null, txt(r.erro, 300), c.agora(), c.agora())
      ]);
      if (r.codigo) await anotarBloqueio(c, Number(r.codigo), r.erro);
    }
  }
  // Envios guardados no KV quando nem o banco estava disponível.
  if (c.env.MEMORIA && typeof c.env.MEMORIA.list === "function" && sobram(c) > 10) {
    try {
      const l = await c.env.MEMORIA.list({ prefix: "saida:", limit: 5 });
      for (const k of l.keys || []) {
        const v = JSON.parse((await c.env.MEMORIA.get(k.name)) || "null");
        await c.env.MEMORIA.delete(k.name);
        if (v?.corpo) { gastar(c); const r = await metaPost(c.env, v.corpo); if (r.ok) { enviados++; await c.db.prepare("UPDATE mensagens SET whatsapp_message_id=? WHERE whatsapp_message_id=?").bind(r.id, "kv:" + k.name).run().catch(() => {}); } }
      }
    } catch (e) { console.warn("fila KV", e?.message); }
  }
  return enviados;
}

// ----- Destinos que não recebem agora: fora da janela de 24 h do WhatsApp ou número sem WhatsApp.
const ERRO_GUARDADA = "a pessoa não escreve há mais de 24 h, então o WhatsApp não deixa mandar mensagem livre: a mensagem ficou guardada e sai sozinha assim que ela responder";
async function destinoBloqueado(c, to) {
  if (c.contingencia) return null;
  const r = await c.db.prepare("SELECT * FROM d30_destinos WHERE telefone=?").bind(digitos(to)).first().catch(() => null);
  if (!r || (r.ate_ms && r.ate_ms < c.agora())) return null;
  return r;
}
async function guardarParaDepois(c, to, texto, papel) {
  const tel = digitos(to), t = String(texto || "").trim();
  if (!t) return;
  const igual = await c.db.prepare("SELECT 1 ok FROM d30_guardadas WHERE telefone=? AND status='GUARDADA' AND texto=? LIMIT 1").bind(tel, t).first().catch(() => null);
  if (!igual) await c.db.prepare("INSERT INTO d30_guardadas(telefone,texto,papel,criado_ms) VALUES(?,?,?,?)").bind(tel, t.slice(0, 4000), papel || null, c.agora()).run().catch(() => { });
}
function papelLegivel(papel, tipo) {
  const p = String(papel || tipo || "").toUpperCase();
  return p === "PRESTADOR" || p === "TECNICO" ? "profissional" : p === "ATENDENTE" ? "equipe" : "cliente";
}
// A Meta recusou por causa da janela de 24 h: marca, guarda o texto, tenta o modelo de retomada (se houver)
// e avisa a equipe UMA vez por dia por pessoa.
async function marcarForaDaJanela(c, to, { codigo = 131047, texto = "", papel = "", nome = "", tipo = "", semAviso = false } = {}) {
  const tel = digitos(to), agora = c.agora();
  await c.db.prepare("INSERT INTO d30_destinos(telefone,motivo,codigo,desde_ms,ate_ms) VALUES(?, 'JANELA', ?, ?, NULL) ON CONFLICT(telefone) DO UPDATE SET motivo='JANELA', codigo=excluded.codigo, desde_ms=excluded.desde_ms, ate_ms=NULL").bind(tel, codigo, agora).run().catch(() => { });
  if (texto) await guardarParaDepois(c, tel, texto, papel);
  if (!nome) { const p = await buscarPessoa(c, tel).catch(() => null); nome = p?.nome || ""; tipo = tipo || p?.tipo || ""; }
  const modelo = String(c.env.WHATSAPP_TEMPLATE_RETOMAR || "").trim();
  let retomou = false;
  if (modelo && await reservarChave(c, `retomar:${tel}:${dataSP(agora)}`)) {
    const r = await c.saida.template(tel, modelo, [primeiroNome(nome) || "tudo bem"], { papel: papelLegivel(papel, tipo) });
    retomou = r.ok;
    if (r.ok) await evento(c, null, "RETOMADA_ENVIADA", `Modelo ${modelo} para ${tel}`);
  }
  if (semAviso) return;
  await alertarEquipe(c, `📵 ${nome || tel} (${papelLegivel(papel, tipo)}, ${tel}) não escreve há mais de 24 h, e o WhatsApp só deixa mandar modelo aprovado. ${texto ? "A mensagem ficou guardada e sai sozinha assim que a pessoa responder. " : ""}${retomou ? `Mandei o modelo "${modelo}" pedindo para responder.` : "Para falar agora, ligue ou escreva pelo celular da empresa."} A DENIA não vai tentar de novo nem repetir este aviso hoje.`, `janela:${tel}:${dataSP(agora)}`);
}
// A pessoa escreveu: a conversa abriu de novo. Libera o número e entrega o que ficou guardado (até 72 h).
async function liberarDestino(c, tel) {
  if (c.sim || c.contingencia) return;
  const t = digitos(tel);
  const d = await c.db.prepare("SELECT motivo FROM d30_destinos WHERE telefone=?").bind(t).first().catch(() => null);
  if (!d) return;
  await c.db.prepare("DELETE FROM d30_destinos WHERE telefone=?").bind(t).run().catch(() => { });
  const lista = (await c.db.prepare("SELECT * FROM d30_guardadas WHERE telefone=? AND status='GUARDADA' ORDER BY id LIMIT 6").bind(t).all().catch(() => null))?.results || [];
  const pessoa = lista.length ? await buscarPessoa(c, t).catch(() => null) : null;
  for (const g of lista) {
    if (c.agora() - g.criado_ms > 72 * 3600000) { await c.db.prepare("UPDATE d30_guardadas SET status='EXPIRADA' WHERE id=?").bind(g.id).run(); continue; }
    const r = await c.saida.texto(t, g.texto, { papel: g.papel || "" });
    await c.db.prepare("UPDATE d30_guardadas SET status=?, enviado_ms=? WHERE id=?").bind(r.ok ? "ENVIADA" : "FALHA", c.agora(), g.id).run();
    if (r.ok) { await registrarMensagem(c, { pessoaId: pessoa?.id, wamid: r.id, direcao: "SAIDA", origem: "SISTEMA", conteudo: g.texto }); await evento(c, null, "GUARDADA_ENTREGUE", `Para ${t}: ${txt(g.texto, 200)}`); }
  }
}

// Toda saída passa por aqui. No painel de teste (simulação) nada sai de verdade.
function criarSaida(c) {
  const env = c.env;
  const simular = (canal, para, conteudo, extra = {}) => { c.registro.push({ canal, para, texto: conteudo, ...extra }); return { ok: true, id: "sim." + crypto.randomUUID() }; };
  const controlado = async (to, corpo) => {
    // Perto do limite de chamadas desta execução: vai para a fila e sai na próxima execução.
    if (sobram(c) < 6) return await adiarEnvio(c, to, corpo, "limite de chamadas desta execução");
    const bloqueio = await verificarLimites(c, to);
    if (bloqueio) { console.warn("Envio bloqueado:", bloqueio); return { ok: false, bloqueado: true, erro: bloqueio }; }
    gastar(c);
    const r = await metaPost(env, corpo);
    if (!r.ok && /too many subrequests|subrequest/i.test(String(r.erro || ""))) return await adiarEnvio(c, to, corpo, r.erro);
    if (r.ok && !c.contingencia) {
      // Taxa de envio e registro de entrega numa chamada só ao banco.
      try {
        await c.db.batch([
          c.db.prepare("INSERT INTO d30_saidas(telefone,criado_ms) VALUES(?,?)").bind(digitos(to), c.agora()),
          c.db.prepare("INSERT OR IGNORE INTO d30_entregas(wamid,telefone,status,enviado_ms,atualizado_ms) VALUES(?,?,'ACEITA',?,?)").bind(String(r.id), digitos(to), c.agora(), c.agora())
        ]);
      } catch (e) { console.warn("registro do envio", e?.message); }
    } else if (r.ok) await registrarSaidaTaxa(c, to);
    else if (r.codigo) await anotarBloqueio(c, Number(r.codigo), r.erro);
    return r;
  };
  return {
    // Quem não escreve há mais de 24 h (a Meta recusou) ou cujo número não recebe WhatsApp não recebe tentativas
    // que vão falhar de novo: a mensagem fica guardada e sai sozinha quando a pessoa responder.
    texto: async (to, t, info = {}) => {
      if (c.sim) return simular("whatsapp", to, t, info);
      const d = await destinoBloqueado(c, to);
      if (d?.motivo === "INVALIDO") return { ok: false, evitado: true, erro: "este número não recebe WhatsApp (a Meta já recusou antes)" };
      if (d?.motivo === "JANELA") {
        if (info.inicialComTemplate) return { ok: false, codigo: 131047, erro: "fora da janela de 24h" }; // a consulta sai pelo modelo aprovado
        await guardarParaDepois(c, to, t, info.papel);
        return { ok: false, guardada: true, codigo: 131047, erro: ERRO_GUARDADA };
      }
      const r = await controlado(to, corpoTexto(to, t));
      if (!r.ok && foraDaJanela(r) && !info.inicialComTemplate) {
        await marcarForaDaJanela(c, to, { codigo: r.codigo || 131047, texto: t, papel: info.papel, semAviso: info.inicial });
        return { ...r, guardada: true, erro: ERRO_GUARDADA };
      }
      return r;
    },
    bruto: (to, corpo) => controlado(to, corpo),
    midia: (to, m, info = {}) => c.sim ? simular("whatsapp-midia", to, `[${m.tipo}] ${m.legenda || ""}`, info) : controlado(to, corpoMidia(to, m.tipo, m.mediaId, m.legenda)),
    template: (to, nome, params, info = {}) => c.sim ? simular("whatsapp-template", to, `${nome}: ${params.join(" | ")}`, info) : controlado(to, corpoTemplate(env, to, nome, params)),
    telegram: async (t, op = {}) => {
      if (c.sim) return simular("telegram", "equipe", t);
      if (sobram(c) < 8) { console.warn("Telegram adiado (limite de chamadas):", String(t).slice(0, 200)); return { ok: false, erro: "limite de chamadas" }; }
      gastar(c);
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) { console.warn("Telegram não configurado:", t.slice(0, 200)); return { ok: false, erro: "Telegram não configurado" }; }
      return telegramEnviar(env, t, op);
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
  const desde = ms => agora - ms;
  // Uma consulta só (antes eram quatro).
  const t = await c.db.prepare(`SELECT
      SUM(CASE WHEN telefone=? AND criado_ms > ? THEN 1 ELSE 0 END) n2,
      SUM(CASE WHEN telefone=? AND criado_ms > ? THEN 1 ELSE 0 END) n10,
      SUM(CASE WHEN telefone=? THEN 1 ELSE 0 END) n60,
      SUM(CASE WHEN criado_ms > ? THEN 1 ELSE 0 END) g10
    FROM d30_saidas WHERE criado_ms > ?`).bind(tel, desde(120000), tel, desde(600000), tel, desde(600000), desde(3600000)).first();
  const n2 = Number(t?.n2 || 0), n10 = Number(t?.n10 || 0), n60 = Number(t?.n60 || 0), g10 = Number(t?.g10 || 0);
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

// O Telegram da Central é só para o URGENTE (alguém precisa agir agora). O resto (o que o profissional
// ou o cliente escreveu, falhas de entrega, janela de 24 h, erros técnicos) fica registrado e aparece
// na página Problemas da plataforma. TELEGRAM_AVISOS=todos volta a mandar tudo.
const AVISOS_URGENTES = ["bloqueio:", "sem-confirmacao:", "limite:", "ia:", "cancel:", "humano:", "apoio:", "comprovante:", "semcat:", "semprest:", "balcao:",
  "falha-consulta:", "falha-aceite:", "falha-cli:", "valor-incerto:", "pos:", "desist:", "atraso:", "atrasadas:", "guia-humano:", "guia-ia-humano:", "agendado:", "reuniao"];
const AVISOS_SEMPRE = ["humano:", "cancel:", "agendado:", "reuniao", "desist:", "bloqueio:", "sem-confirmacao:", "limite:", "guia-humano:"];
function avisoUrgente(c, chave) { return String(c.env.TELEGRAM_AVISOS || "").toLowerCase() === "todos" || AVISOS_URGENTES.some(p => String(chave || "").startsWith(p)); }
async function alertarEquipe(c, texto, chave, casoId = null) {
  if (chave && !(await reservarChave(c, "alerta:" + chave))) return;
  // O mesmo aviso (mesmo texto) nunca chega duas vezes em 6 h, venha de onde vier.
  if (!(await reservarChave(c, `alerta-txt:${hashTexto(norm(texto))}:${Math.floor(c.agora() / (6 * 3600000))}`))) return;
  if (!avisoUrgente(c, chave)) { await evento(c, casoId, "AVISO_PAINEL", texto); return; }
  // Pedir ajuda o mínimo: no mesmo atendimento, no máximo um aviso a cada 2 h no Telegram (o resto vai para
  // Problemas). Sempre chegam: pedido de atendente, cancelamento, agendado, reunião, desistência e falhas da conta.
  if (casoId && !AVISOS_SEMPRE.some(p => String(chave || "").startsWith(p)) && String(c.env.TELEGRAM_AVISOS || "").toLowerCase() !== "todos") {
    const recente = await c.db.prepare("SELECT 1 ok FROM d30_eventos WHERE caso_id=? AND tipo='ALERTA_EQUIPE' AND criado_ms > ? LIMIT 1").bind(casoId, c.agora() - 2 * 3600000).first().catch(() => null);
    if (recente) { await evento(c, casoId, "AVISO_PAINEL", texto); return; }
  }
  // Teto de alertas por hora: o Telegram nunca vira uma enxurrada.
  const recentes = Number((await c.db.prepare("SELECT COUNT(*) n FROM d30_eventos WHERE tipo='ALERTA_EQUIPE' AND criado_ms > ?").bind(c.agora() - 3600000).first().catch(() => null))?.n || 0);
  await evento(c, casoId, "ALERTA_EQUIPE", texto);
  if (recentes >= LIMITE_ALERTAS_HORA) {
    if (await reservarChave(c, "alerta-teto:" + Math.floor(c.agora() / 3600000))) await c.saida.telegram(`DENIA — Muitos alertas nesta hora (${recentes}). Os próximos ficam só no registro; veja /api/saude.`);
    return;
  }
  const r = await c.saida.telegram("DENIA — " + texto + (casoId ? "\n↩️ Responda esta mensagem para me dizer o que fazer." : ""));
  if (!r.ok) console.warn("Alerta não entregue:", r.erro);
  // Guarda de que caso (ou telefone) é o aviso: quando a equipe responder no Telegram, a DENIA sabe do que se trata.
  else if (r.id) await c.db.prepare("INSERT OR REPLACE INTO d30_tg_msgs(message_id,caso_id,telefone,texto,criado_ms) VALUES(?,?,?,?,?)").bind(Number(r.id), casoId || null, (String(texto).match(/\b55\d{10,11}\b/) || [])[0] || null, txt(texto, 1500), c.agora()).run().catch(() => { });
}

// Envio ao cliente: respeita pausa humana, idempotência e grava no histórico.
async function enviarAoCliente(c, { tel, pessoaId, casoId, texto, chave, origem = "IA" }) {
  const t = (await humanizarCasos(c, String(texto || ""))).trim();
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
  texto = await humanizarCasos(c, texto);
  if (chave && !(await reservarChave(c, "pre:" + chave))) return { ok: true, duplicado: true };
  const template = String(c.env.WHATSAPP_TEMPLATE_CONSULTA_TECNICO || "").trim();
  let r = await c.saida.texto(to, texto, { papel: "prestador", prestador: consulta.prestador_nome, inicial, inicialComTemplate: Boolean(inicial && template) });
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
    const e = await c.saida.midia(consulta.prestador_tel, { tipo: m.tipo, mediaId: m.media_id, legenda: "Foto que o cliente mandou" }, { papel: "prestador" });
    if (e.ok) await c.db.prepare("UPDATE d30_midias SET enviado_para=? WHERE id=?").bind(consulta.prestador_tel, m.id).run();
    else await evento(c, consulta.caso_id, "FALHA_MIDIA_PRESTADOR", e.erro);
  }
}

// ============================================================================
// OPENAI
// ============================================================================

function modelo(env) { return String(env.OPENAI_MODEL || MODELO_PADRAO).trim(); }
// Consumo da OpenAI por dia (a plataforma mostra em Consumo e custos). Nunca atrapalha a resposta.
async function registrarUsoIA(c, operacao, modeloUsado, usage, erro) {
  if (!c?.db || c.sim || sobram(c) < 12) return; // o envio ao cliente vem antes da contabilidade
  try {
    const det = usage?.input_tokens_details || {};
    await c.db.prepare(`INSERT INTO d30_uso (dia,operacao,modelo,chamadas,erros,tokens_entrada,tokens_saida,tokens_cache) VALUES (?,?,?,1,?,?,?,?)
      ON CONFLICT(dia,operacao,modelo) DO UPDATE SET chamadas=chamadas+1, erros=erros+excluded.erros, tokens_entrada=tokens_entrada+excluded.tokens_entrada, tokens_saida=tokens_saida+excluded.tokens_saida, tokens_cache=tokens_cache+excluded.tokens_cache`)
      .bind(new Date(c.agora()).toISOString().slice(0, 10), operacao, String(modeloUsado || ""), erro ? 1 : 0, Number(usage?.input_tokens || 0) || 0, Number(usage?.output_tokens || 0) || 0, Number(det.cached_tokens || 0) || 0).run();
  } catch { /* tabela ainda não criada ou banco ocupado */ }
}
// ============================================================================
// MÉTRICAS DO ATENDIMENTO (WhatsApp) — tempo de resposta, quem respondeu (IA ou equipe), horários de pico,
// contatos novos e recorrentes, atendimentos por etapa e serviço, funil, profissionais e entregas.
// Poucas consultas ao banco (o plano gratuito conta cada uma).
// ============================================================================
async function metricasAtendimento(c, de, ate) {
  const valida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  if (!valida(de) || !valida(ate)) { ate = new Date(c.agora()).toISOString().slice(0, 10); de = new Date(c.agora() - 29 * 86400000).toISOString().slice(0, 10); }
  const ini = Date.parse(de + "T00:00:00Z"), fim = Date.parse(ate + "T00:00:00Z") + 86400000;
  const fimTxt = new Date(fim).toISOString().slice(0, 10);
  // 1) Mensagens do período, em ordem por pessoa (até 25 mil).
  const msgs = (await c.db.prepare(`SELECT m.pessoa_id, UPPER(m.direcao) d, UPPER(COALESCE(m.origem,'')) o, m.criado_em t, UPPER(COALESCE(p.tipo,'')) tipo FROM mensagens m LEFT JOIN pessoas p ON p.id=m.pessoa_id
    WHERE m.empresa_id=? AND m.criado_em >= ? AND m.criado_em < ? ORDER BY m.pessoa_id, m.id LIMIT 25000`).bind(EMPRESA_ID, de, fimTxt).all().catch(() => null))?.results || [];
  const ms = t => Date.parse(String(t || "").replace(" ", "T") + "Z");
  const tempos = { IA: [], EQUIPE: [] }, porHora = Array.from({ length: 7 }, () => Array(24).fill(0));
  const saidas = { IA: 0, EQUIPE: 0, SISTEMA: 0 }, contatos = new Set(), clientes = new Set(), profissionais = new Set();
  let semResposta = 0, entradas = 0;
  const diaSemana = x => { const d = new Date(x - 3 * 3600000); return [d.getUTCDay(), d.getUTCHours()]; }; // horário de Brasília
  let i = 0;
  while (i < msgs.length) {
    const pid = msgs[i].pessoa_id; let j = i;
    while (j < msgs.length && msgs[j].pessoa_id === pid) j++;
    let espera = null;
    for (let k = i; k < j; k++) {
      const m = msgs[k], t = ms(m.t);
      if (m.d === "ENTRADA") {
        entradas++; contatos.add(pid);
        if (m.tipo === "TECNICO") profissionais.add(pid); else clientes.add(pid);
        const [w, h] = diaSemana(t); if (Number.isFinite(w)) porHora[w][h]++;
        if (espera === null) espera = t; // começo de uma vez em que a pessoa ficou esperando resposta
      } else if (m.o !== "LIGACAO") {
        const quem = m.o === "HUMANO" ? "EQUIPE" : m.o === "IA" ? "IA" : "SISTEMA";
        saidas[quem]++;
        if (espera !== null && quem !== "SISTEMA" && t >= espera) { tempos[quem].push((t - espera) / 1000); }
        if (espera !== null && quem === "SISTEMA" && t >= espera) tempos.IA.push((t - espera) / 1000);
        espera = null;
      }
    }
    if (espera !== null && c.agora() - espera > 30 * 60000) semResposta++;
    i = j;
  }
  const mediana = a => { if (!a.length) return null; const o = [...a].sort((x, y) => x - y); return Math.round(o[Math.floor(o.length / 2)]); };
  const p90 = a => { if (!a.length) return null; const o = [...a].sort((x, y) => x - y); return Math.round(o[Math.min(o.length - 1, Math.floor(o.length * 0.9))]); };
  // 2) Contatos novos (primeira mensagem dentro do período).
  // Novos = pessoas cadastradas no período (sem varrer o histórico inteiro de mensagens).
  const novos = Number((await c.db.prepare("SELECT COUNT(*) n FROM pessoas WHERE empresa_id=? AND criado_em >= ? AND criado_em < ? AND UPPER(COALESCE(tipo,'CLIENTE'))<>'TECNICO'").bind(EMPRESA_ID, de, fimTxt).first().catch(() => null))?.n || 0);
  // 3) Atendimentos criados no período: etapa, serviço e funil.
  const casos = (await c.db.prepare("SELECT caso_id, etapa, fatos_json FROM d30_casos WHERE criado_ms >= ? AND criado_ms < ? LIMIT 5000").bind(ini, fim).all().catch(() => null))?.results || [];
  const porEtapa = {}, porServico = {};
  for (const k of casos) {
    porEtapa[k.etapa] = (porEtapa[k.etapa] || 0) + 1;
    let f = {}; try { f = JSON.parse(k.fatos_json || "{}"); } catch { f = {}; }
    const sv = txt(CATEGORIAS[f.categoria]?.rotulo || f.servico || "Não identificado", 40);
    porServico[sv] = (porServico[sv] || 0) + 1;
  }
  // 4) Profissionais: consultas do período.
  const cons = (await c.db.prepare("SELECT prestador_nome, status, valor_cliente, criado_ms, atualizado_ms FROM d30_consultas WHERE criado_ms >= ? AND criado_ms < ? LIMIT 5000").bind(ini, fim).all().catch(() => null))?.results || [];
  const porProf = new Map();
  for (const k of cons) {
    const nome = k.prestador_nome || "Profissional";
    const g = porProf.get(nome) || { nome, consultas: 0, responderam: 0, confirmadas: 0, recusadas: 0, tempos: [], valor: 0 };
    g.consultas++;
    if (!["ENVIADA", "AGENDADA_ENVIO", "PENDENTE"].includes(k.status)) { g.responderam++; g.tempos.push((Number(k.atualizado_ms) - Number(k.criado_ms)) / 60000); }
    if (k.status === "CONFIRMADA") { g.confirmadas++; g.valor += Number(k.valor_cliente || 0); }
    if (k.status === "RECUSADA") g.recusadas++;
    porProf.set(nome, g);
  }
  const casosComProf = new Set((await c.db.prepare("SELECT DISTINCT caso_id FROM d30_consultas WHERE criado_ms >= ? AND criado_ms < ?").bind(ini, fim).all().catch(() => null))?.results?.map(x => x.caso_id) || []);
  const funil = { abertos: casos.length, com_profissional: casos.filter(k => casosComProf.has(k.caso_id)).length, agendados: (porEtapa.AGENDADO || 0) + (porEtapa.EM_ANDAMENTO || 0) + (porEtapa.CONCLUIDO || 0), concluidos: porEtapa.CONCLUIDO || 0, cancelados: porEtapa.CANCELADO || 0 };
  return {
    de, ate,
    conversas: { contatos: contatos.size, clientes: clientes.size, profissionais: profissionais.size, novos, recorrentes: Math.max(0, clientes.size - novos), mensagens_recebidas: entradas, sem_resposta: semResposta },
    respostas: { ia: saidas.IA + saidas.SISTEMA, equipe: saidas.EQUIPE, parte_ia: (saidas.IA + saidas.SISTEMA + saidas.EQUIPE) ? Math.round(((saidas.IA + saidas.SISTEMA) / (saidas.IA + saidas.SISTEMA + saidas.EQUIPE)) * 1000) / 10 : null,
      tempo_ia_s: mediana(tempos.IA), tempo_ia_p90_s: p90(tempos.IA), tempo_equipe_s: mediana(tempos.EQUIPE), tempo_equipe_p90_s: p90(tempos.EQUIPE) },
    horarios: porHora,
    atendimentos: { por_etapa: porEtapa, por_servico: Object.entries(porServico).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([servico, n]) => ({ servico, n })), funil },
    profissionais: [...porProf.values()].map(g => ({ nome: g.nome, consultas: g.consultas, responderam: g.responderam, confirmadas: g.confirmadas, recusadas: g.recusadas, tempo_resposta_min: mediana(g.tempos), valor_confirmado: g.valor })).sort((a, b) => b.consultas - a.consultas).slice(0, 30),
    entregas: await resumoEntregas(c, ini)
  };
}

// Consumo do período: IA, mensagens recebidas/enviadas por dia e, com WHATSAPP_WABA_ID, o custo cobrado pela Meta.
async function consumoDoPeriodo(c, de, ate) {
  const valida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  if (!valida(de) || !valida(ate)) { ate = new Date(c.agora()).toISOString().slice(0, 10); de = new Date(c.agora() - 29 * 86400000).toISOString().slice(0, 10); }
  const ini = Date.parse(de + "T00:00:00Z"), fim = Date.parse(ate + "T00:00:00Z") + 86400000;
  const ia = (await c.db.prepare("SELECT dia,operacao,modelo,chamadas,erros,tokens_entrada,tokens_saida,tokens_cache FROM d30_uso WHERE dia BETWEEN ? AND ? ORDER BY dia").bind(de, ate).all().catch(() => null))?.results || [];
  // Do histórico permanente (a fila e o registro de envios são apagados depois de alguns dias).
  const porDirecao = (await c.db.prepare("SELECT substr(criado_em,1,10) dia, UPPER(direcao) direcao, UPPER(COALESCE(origem,'')) origem, COUNT(*) n FROM mensagens WHERE empresa_id=? AND criado_em >= ? AND criado_em < ? GROUP BY dia, UPPER(direcao), UPPER(COALESCE(origem,''))").bind(EMPRESA_ID, de, new Date(fim).toISOString().slice(0, 10)).all().catch(() => null))?.results || [];
  const somaDia = filtro => { const m = new Map(); for (const x of porDirecao.filter(filtro)) m.set(x.dia, (m.get(x.dia) || 0) + Number(x.n || 0)); return [...m.entries()].sort().map(([dia, n]) => ({ dia, n })); };
  const recebidas = somaDia(x => x.direcao === "ENTRADA");
  const enviadas = somaDia(x => x.direcao === "SAIDA" && x.origem !== "LIGACAO");
  const pela_ia = somaDia(x => x.direcao === "SAIDA" && x.origem === "IA");
  const pela_equipe = somaDia(x => x.direcao === "SAIDA" && x.origem === "HUMANO");
  const entregas = (await c.db.prepare("SELECT strftime('%Y-%m-%d', COALESCE(enviado_ms, atualizado_ms)/1000, 'unixepoch') dia, status, COUNT(*) n FROM d30_entregas WHERE COALESCE(enviado_ms, atualizado_ms) >= ? AND COALESCE(enviado_ms, atualizado_ms) < ? GROUP BY dia, status").bind(ini, fim).all().catch(() => null))?.results || [];
  // Atendimentos: casos novos e concluídos por dia, e quantas pessoas diferentes falaram com a empresa.
  const casosNovos = (await c.db.prepare("SELECT strftime('%Y-%m-%d', criado_ms/1000, 'unixepoch') dia, COUNT(*) n FROM d30_casos WHERE criado_ms >= ? AND criado_ms < ? GROUP BY dia").bind(ini, fim).all().catch(() => null))?.results || [];
  const casosConcluidos = (await c.db.prepare("SELECT strftime('%Y-%m-%d', atualizado_ms/1000, 'unixepoch') dia, COUNT(*) n FROM d30_casos WHERE etapa='CONCLUIDO' AND atualizado_ms >= ? AND atualizado_ms < ? GROUP BY dia").bind(ini, fim).all().catch(() => null))?.results || [];
  const contatos = Number((await c.db.prepare("SELECT COUNT(DISTINCT pessoa_id) n FROM mensagens WHERE empresa_id=? AND UPPER(direcao)='ENTRADA' AND criado_em >= ? AND criado_em < ?").bind(EMPRESA_ID, de, new Date(fim).toISOString().slice(0, 10)).first().catch(() => null))?.n || 0);
  const r = { de, ate, ia, mensagens: { recebidas, enviadas, pela_ia, pela_equipe, entregas }, entregas: await resumoEntregas(c, ini), casos: { novos: casosNovos, concluidos: casosConcluidos }, contatos, meta: null };
  const waba = String(c.env.WHATSAPP_WABA_ID || "").trim();
  if (!waba) r.meta = { configurado: false, ajuda: "Para ver o custo cobrado pela Meta, crie no Worker do motor a variável WHATSAPP_WABA_ID com o ID da conta do WhatsApp Business (Gerenciador do WhatsApp → Configurações da conta)." };
  else if (c.env.WHATSAPP_TOKEN) {
    try {
      const campos = `pricing_analytics.start(${Math.floor(ini / 1000)}).end(${Math.floor(fim / 1000)}).granularity(DAILY).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])`;
      const u = `https://graph.facebook.com/${GRAPH}/${encodeURIComponent(waba)}?fields=${encodeURIComponent(campos)}&access_token=${encodeURIComponent(String(c.env.WHATSAPP_TOKEN).trim())}`;
      const w = await fetch(u, { signal: AbortSignal.timeout(20000) });
      const d = await w.json().catch(() => ({}));
      if (!w.ok || d.error) r.meta = { configurado: true, erro: txt(d?.error?.message || `HTTP ${w.status}`, 300) };
      else {
        const pontos = [];
        for (const bloco of d.pricing_analytics?.data || []) for (const p of bloco.data_points || []) pontos.push({ dia: new Date(Number(p.start) * 1000).toISOString().slice(0, 10), categoria: String(p.pricing_category || ""), tipo: String(p.pricing_type || ""), volume: Number(p.volume || 0), custo: Number(p.cost || 0) });
        r.meta = { configurado: true, moeda: d.pricing_analytics?.currency || null, pontos };
      }
    } catch (e) { r.meta = { configurado: true, erro: txt(e?.message, 200) }; }
  }
  return r;
}
async function openaiJSON(c, instrucoes, entrada, anexos = [], maxTokens = 1400, modeloForcado = "") {
  const env = c.env;
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada.");
  const content = [{ type: "input_text", text: entrada }];
  for (const a of anexos.slice(0, 3)) {
    const url = `data:${a.mime};base64,${a.base64}`;
    if (a.mime.startsWith("image/")) content.push({ type: "input_image", image_url: url, detail: "auto" });
    else content.push({ type: "input_file", filename: a.nome || "documento.pdf", file_data: url });
  }
  const corpo = { model: String(modeloForcado || "").trim() || modelo(env), instructions: instrucoes, input: [{ role: "user", content }], text: { format: { type: "json_object" } }, max_output_tokens: maxTokens, store: false };
  if (/^(gpt-5|o\d)/i.test(corpo.model)) corpo.reasoning = { effort: "low" };
  gastar(c);
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify(corpo), signal: AbortSignal.timeout(18000)
  });
  const bruto = await r.text();
  if (!r.ok) { await registrarUsoIA(c, "atendimento", corpo.model, null, true); throw new Error(`OpenAI HTTP ${r.status}: ${bruto.slice(0, 300)}`); }
  const d = JSON.parse(bruto);
  await registrarUsoIA(c, "atendimento", corpo.model, d.usage, false);
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
  gastar(c);
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${c.env.OPENAI_API_KEY}` }, body: f, signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => ({}));
  await registrarUsoIA(c, "transcricao_audio", String(c.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe"), d?.usage, !r.ok);
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
  if (/\b(agendad[oa]|esta confirmad[oa]|ficou confirmad[oa]|confirmad[oa] para|confirmamos (o|a|seu|sua)|confirmei)\b/.test(n) && g.etapa !== "AGENDADO" && !g.reuniao && !/\?/.test(frase)) return "agendamento não confirmado";
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
    case "EM_ANDAMENTO": return "O serviço já está sendo feito (o profissional já foi ao local ou está com o equipamento). Não recomece a coleta; para dúvidas sobre o andamento, use PERGUNTA_PARA_PROFISSIONAL.";
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

PENSE COMO UMA PESSOA EXPERIENTE DA EQUIPE QUE ACABOU DE RECEBER A MENSAGEM: antes de responder, entenda quem está falando, o que vocês conversaram antes e o que a pessoa quer agora. Comprovante, foto, documento ou áudio: leia o conteúdo (valor, data, nome, serviço) e ligue ao atendimento certo, como uma atendente faria. Fale o MÍNIMO: uma frase curta resolve quase tudo; não repita o que a pessoa disse e não mande mensagem que não ajuda.

ANTES DE RESPONDER, LEIA TUDO: a MEMÓRIA COMPLETA DO CLIENTE, o PERFIL, a FICHA, os OUTROS CASOS e o HISTÓRICO inteiro. Cliente que já falou com a empresa NUNCA é tratado como novo: chame pelo nome, lembre do que já foi feito ("da última vez trocamos o disjuntor, certo?"), use o endereço que ele já passou (confirme em vez de perguntar de novo) e continue de onde a conversa parou. Se houve problema ou reclamação antes, tenha ainda mais cuidado.
BREVIDADE E JEITO HUMANO: escreva como as atendentes escrevem no WhatsApp (veja COMO A EQUIPE FALA): 1 a 2 frases curtas, no máximo 1 pergunta por mensagem, sem repetir o que o cliente acabou de dizer, sem listas, sem formalidade de robô ("Prezado", "Informamos que"). Se der para resolver em uma frase, use uma frase.
NÚMEROS DE CASO são internos: nunca escreva "caso 210", "#210" ou qualquer número de caso para o cliente; fale do serviço ("a instalação do chuveiro", "o conserto da geladeira").

SEU PAPEL: você interpreta as mensagens e redige a resposta. Você NÃO executa ações. O sistema decide e executa (consultar profissional, enviar orçamento, agendar) com base nos fatos que você extrai. Portanto:
- Nunca diga que enviou, consultou, falou, avisou, repassou, agendou, confirmou ou cancelou algo, a menos que o ESTADO DO CASO diga que isso já aconteceu (exceção: a REUNIÃO ONLINE que você registrar em "reuniao", explicada abaixo).
- Nunca invente preço, prazo, disponibilidade, diagnóstico, cobertura de região ou que um profissional faz certo serviço. Valores: somente os listados em VALORES AUTORIZADOS.
- Nunca peça ao cliente para escolher profissional. Nunca informe telefone, CPF ou dados de profissionais ou de outras pessoas. Não peça CPF.
- Bairro NÃO define preço: nunca diga que precisa do bairro para orçamento. Não pergunte bairro por iniciativa própria; o sistema e o profissional pedem quando for necessário. Nunca repita uma pergunta que você já fez nesta conversa, mesmo que o cliente não tenha respondido: siga em frente com o que ele disse.
- Serviços de BALCÃO: o cliente leva o equipamento à loja; nunca pergunte bairro ou endereço.
- Cancelamentos e reclamações sérias: não decida; seja cordial e marque precisa_humano.
- PEÇA AJUDA À EQUIPE O MÍNIMO POSSÍVEL, como uma atendente experiente que resolve sozinha: primeiro tente com o TREINAMENTO, os FATOS e o HISTÓRICO; se falta uma informação do cliente, pergunte a ele; se é dúvida técnica do serviço e já há profissional consultado, use PERGUNTA_PARA_PROFISSIONAL. precisa_humano=true SÓ quando: o cliente pede para falar com uma pessoa, reclamação séria, cancelamento, pedido que só a equipe decide (desconto fora da tabela, reembolso, garantia, exceção às regras) ou situação de risco. Dúvida comum NÃO é motivo para chamar a equipe.

CLIENTE ANTIGO: veja o PERFIL DO CLIENTE e a FICHA NO SISTEMA. Se ele já foi atendido antes, trate-o como cliente conhecido: nunca como novo, não peça dados que já constam e lembre do que já foi feito quando for útil. Dados da FICHA são oficiais; nunca os contradiga e nunca os invente.

MEMÓRIA: o HISTÓRICO pode conter mensagens de outros casos do mesmo cliente (marcadas com #número); use as do caso ativo e só fale de outro caso se o cliente se referir a ele. Leia o ESTADO DO CASO, os FATOS e o HISTÓRICO antes de responder. Nunca pergunte algo que já está nos fatos ou no histórico. A informação mais recente vale mais. Uma resposta curta normalmente responde à última pergunta feita. Mensagens do ATENDENTE HUMANO fazem parte da conversa: continue de onde ele parou, sem repetir o que já foi combinado. Se o caso está AGENDADO ou concluído, não recomece a coleta; só é pedido novo quando o cliente pede claramente outro serviço.

ESTILO: escreva como as atendentes da equipe (veja COMO A EQUIPE FALA): humana, gentil e com empatia — se o cliente está com um problema, mostre que entende ("Poxa, imagino o transtorno") sem exagero; português do Brasil natural; responda primeiro ao que o cliente perguntou; mensagens CURTAS, 1 ou 2 frases; no máximo uma pergunta; retribua cumprimentos; não repita o nome do cliente, o bairro nem o que ele acabou de dizer; sem listas, sem markdown; nunca seco ou grosseiro; não mencione sistema, banco de dados ou modelo de IA. Não se apresente como robô ou assistente virtual por iniciativa própria. Se o cliente perguntar com sinceridade se está falando com um robô ou com uma IA, não negue: responda de forma leve e humana, por exemplo "Sou a assistente virtual da Central, e tem uma equipe aqui comigo acompanhando seu atendimento 😊", e siga ajudando.

A ARTE DE ATENDER (o padrão das melhores atendentes):
- Escute de verdade: antes de pedir qualquer coisa, mostre que entendeu o problema com palavras suas, numa frase curta e específica ao caso (não genérica).
- Espelhe o cliente: se ele escreve informal e curto, responda informal e curto ("tá", "pra", "beleza"); se escreve formal, seja mais formal. Use emoji só se ele usar, e no máximo um.
- Varie: não comece toda mensagem do mesmo jeito ("Entendi!", "Claro!", "Perfeito!"); nada de frases prontas de robô como "Como posso ajudar?", "Fico à disposição", "Agradecemos o contato".
- Uma coisa por vez: uma informação ou uma pergunta por mensagem, na ordem natural da conversa.
- Cliente irritado ou com pressa: reconheça o incômodo sem se justificar e sem culpar ninguém ("Poxa, entendo sua pressa"), diga o próximo passo concreto e marque precisa_humano só se for reclamação séria.
- Venda com naturalidade: destaque o que resolve a vida do cliente (rapidez, garantia, profissional de confiança) só quando for verdade no treinamento; nunca pressione; se ele disser "vou pensar", seja gentil e deixe a porta aberta.
- Dúvida é normal, chute nunca: só afirme o que está no TREINAMENTO, nos FATOS, na FICHA, no ESTADO DO CASO ou no HISTÓRICO. Se não tiver certeza, pergunte ao cliente ou confirme com o profissional; prefira perguntar a supor. Não invente.
- Lembre que do outro lado há uma pessoa real: uma promessa errada (preço, dia, horário, que o profissional vai, que algo está incluso) causa prejuízo e transtorno de verdade ao cliente e à Central. Na dúvida, não prometa.
- RESUMO DE LIGAÇÃO no HISTÓRICO é o que a equipe conversou por telefone com esta pessoa: vale como informação confirmada e mais recente; use naturalmente, sem dizer "conforme registro".
- Você atende somente o que é da Central (serviços, pedidos, agendamentos, dúvidas do atendimento). Não fale de marketing, redes sociais, Google ou assuntos fora do atendimento; se perguntarem, diga com gentileza que por aqui você cuida do atendimento.

REUNIÃO ONLINE (ou ligação/videochamada com a equipe): se o TREINAMENTO permite marcar e o cliente CONFIRMOU um dia e horário, preencha "reuniao" com {"acao":"marcar","quando":"AAAA-MM-DD HH:MM","assunto":"do que é a reunião, em poucas palavras"} (horário de Brasília; use a DATA E HORA ATUAL para entender "amanhã", "terça" etc.). Se ele mudar o horário de uma reunião já marcada, "acao":"remarcar" com o novo horário; se desmarcar, "acao":"cancelar". O sistema registra e avisa a equipe no Telegram da Central; aí você pode dizer que ficou marcado e que a equipe envia o link. Nunca invente link. Enquanto o horário estiver em negociação, deixe "reuniao" vazio. Não repita uma reunião que já está em REUNIÕES MARCADAS.
CALENDÁRIO: para QUALQUER data (reunião ou serviço), confira no CALENDÁRIO o dia da semana certo e se é feriado; nunca calcule o dia da semana de cabeça. Nunca proponha nem marque reunião em feriado, domingo, horário que já passou ou fora do HORÁRIO DE REUNIÕES ONLINE. Se o cliente pedir um desses, explique com gentileza (ex.: "dia 20/11 é feriado da Consciência Negra") e sugira o próximo dia possível. Ao confirmar, diga o dia da semana e a data (ex.: "quinta, 22/10, às 15h").

COMO O SISTEMA AGE: quando o serviço está claro e o cliente quer orçamento, visita ou atendimento, o sistema consulta sozinho o profissional da categoria e avisa o cliente. Para isso basta preencher os fatos, quer_orcamento_ou_atendimento=true e pronto_para_profissional=true. Não é preciso bairro nem endereço para consultar.

Responda SOMENTE com um objeto JSON neste formato:
{"resposta":"","intencao":"CONVERSA","novo_pedido":false,"quer_orcamento_ou_atendimento":false,"pronto_para_profissional":false,"fatos":{"servico":"","categoria":"","problema":"","marca":"","modelo":"","bairro":"","cidade":"","endereco":"","preferencia_horario":"","nome":""},"categoria_confianca":"BAIXA","resposta_para_profissional":"","descricao_anexos":"","comprovante_pagamento":false,"precisa_humano":false,"motivo_humano":"","resumo_caso":"","reuniao":{"acao":"","quando":"","assunto":""}}

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

function montarEntradaCliente({ agora = Date.now(), treinamento, caso, consulta, autorizados, recentes, hist, novas, temAnexos, pessoa, perfil = "", estilo = "", ficha = "", memoria = "", reunioes = "", calendario = "" }) {
  return `TREINAMENTO DA EMPRESA (siga sempre):
${formatarTreinamento(treinamento.dados)}

COMO A EQUIPE FALA (mensagens reais das atendentes; imite o tom e o tamanho, não o conteúdo):
${estilo || "(sem exemplos ainda)"}

MEMÓRIA COMPLETA DO CLIENTE (toda a relação desde o primeiro contato — LEIA ANTES DE RESPONDER):
${memoria || "(primeiro contato: não há conversas anteriores)"}

PERFIL DO CLIENTE:
${perfil || "(cliente sem atendimentos anteriores registrados)"}

FICHA NO SISTEMA DE CADASTRO (dados oficiais):
${ficha || "(não disponível)"}

CATEGORIAS (e quem atende cada uma):
${categoriasParaIA()}

DATA E HORA ATUAL: ${dataHoraSP(agora)} (${new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "long" }).format(new Date(agora))})
REUNIÕES MARCADAS COM ESTE CLIENTE: ${reunioes || "(nenhuma)"}
${calendario ? `CALENDÁRIO (horário de Brasília; feriados nacionais, do RJ e da cidade do Rio):\n${calendario}` : ""}
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

const INSTRUCOES_PRESTADOR = `Você trabalha na Central de Atendimento e está lendo a mensagem de um PROFISSIONAL PRESTADOR (não é cliente) sobre um caso específico. Sua tarefa é CLASSIFICAR a mensagem e extrair fatos.
PENSE COMO UMA PESSOA EXPERIENTE DA EQUIPE QUE ACABOU DE RECEBER A MENSAGEM: antes de responder, entenda quem está falando, o que vocês conversaram antes e o que a pessoa quer agora. Comprovante, foto, documento ou áudio: leia o conteúdo (valor, data, nome, serviço) e ligue ao atendimento certo, como uma atendente faria. Fale o MÍNIMO: uma frase curta resolve quase tudo; não repita o que a pessoa disse e não mande mensagem que não ajuda. Não invente nada. Números de caso são internos: nunca escreva número de caso em texto para o profissional ou para o cliente; refira-se ao atendimento pelo nome do cliente, bairro e serviço.

Responda SOMENTE com um objeto JSON:
{"tipo":"COMENTARIO","valor_centavos":0,"valor_e_final":"NAO_INFORMADO","disponibilidade":"","atende_regiao":"NAO_INFORMADO","pergunta_para_cliente":"","resposta_conhecida":"","mensagem_para_cliente":"","resumo":""}

tipo:
- ACEITA: pode fazer o serviço e informou valor e/ou disponibilidade (ou disse que faz).
- RECUSA: não pode, não faz ou não atende o local.
- PERGUNTA: precisa de uma informação do cliente (modelo, medidas, foto, bairro, endereço...). Escreva pergunta_para_cliente de forma educada e clara, como a central perguntaria ao cliente. Se a resposta estiver EXPLÍCITA nos FATOS DO CASO, escreva-a em resposta_conhecida.
- PEDE_CONTEXTO: não sabe de qual cliente/serviço se trata ("que cliente?", "verificar o quê?").
- CONFIRMA_AGENDAMENTO: confirma o atendimento/dia/horário combinado.
- RESPONDE: responde a um PEDIDO PENDENTE ou PERGUNTA DO CLIENTE (ex.: "sim, o material está incluso"), ou dá um aviso claro para o cliente sobre o atendimento (atraso, horário de chegada). Escreva mensagem_para_cliente em nome da central, educada, sem gírias, sem dados pessoais, sem inventar.
- ENCAMINHAR: ele manda algo PARA O CLIENTE (links, opções, fotos, informações, explicação) ou pede para você encaminhar/mandar/passar ao cliente ("manda pra ela", "encaminha esses links"). Escreva mensagem_para_cliente em nome da central, curta e simpática, com TODO o conteúdo que ele quer que chegue ao cliente: copie os links exatamente como ele escreveu, sem resumir nem cortar. Se ele mandou o conteúdo em mensagens anteriores (veja o HISTÓRICO) e agora só pede para encaminhar, use esse conteúdo. Valor de orçamento do serviço do profissional NÃO é ENCAMINHAR (use ACEITA).
- COMPROVANTE: mandou comprovante de pagamento, recibo ou foto do serviço feito. Em "resumo", escreva o que é, o valor e a data que aparecem.
- COMENTARIO: qualquer outra coisa: comentário solto, exclamação, mensagem ambígua (ex.: "Eita, Niterói"). NA DÚVIDA, use COMENTARIO.
LEIA O CONTEXTO: o HISTÓRICO, a ÚLTIMA MENSAGEM QUE ENVIAMOS e O QUE O CLIENTE ESCREVEU mostram do que se trata. Uma pergunta como "do que se trata?" ou "qual cliente?" é PEDE_CONTEXTO. Nunca trate como novidade algo que ele já respondeu.
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
    resumo: txt(o?.resumo_caso, 600),
    reuniao: o?.reuniao && typeof o.reuniao === "object" && ["marcar", "remarcar", "cancelar"].includes(String(o.reuniao.acao || "").toLowerCase())
      ? { acao: String(o.reuniao.acao).toLowerCase(), quando: txt(o.reuniao.quando, 40), assunto: txt(o.reuniao.assunto, 200) } : null
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

async function processarCliente(c, tel, id, msgs, { apenasRegistrar, chaveLote, atrasoMs = 0 }) {
  const nome = msgs.map(m => m.nome).filter(Boolean).pop() || "";
  const pessoa = id.pessoa || await obterPessoa(c, tel, nome, "CLIENTE");
  let { ativo: caso, recentes } = await carregarCasos(c, pessoa);
  const { anexos, falhas } = await prepararMidias(c, msgs);

  // 1) Tudo que chega é registrado, mesmo quando a DENIA não vai responder (uma vez só, mesmo se o lote for refeito).
  const jaRegistradas = new Set(((await c.db.prepare(`SELECT whatsapp_message_id w FROM mensagens WHERE whatsapp_message_id IN (${msgs.map(() => "?").join(",")})`).bind(...msgs.map(m => m.wamid)).all().catch(() => null))?.results || []).map(x => x.w));
  for (const m of msgs) if (!jaRegistradas.has(m.wamid)) await registrarMensagem(c, { pessoaId: pessoa.id, casoId: caso?.casoId, wamid: m.wamid, direcao: "ENTRADA", origem: "WHATSAPP", tipo: String(m.tipo || "text").toUpperCase(), conteudo: m.conteudo });

  if (apenasRegistrar) {
    // Uma conversa só: avisa com o nome. Várias de uma vez: o cron manda um aviso só (sem enxurrada).
    if ((c.atrasadasSemResposta || 0) <= 1) await alertarEquipe(c, `Mensagens de ${pessoa.nome || tel} ficaram sem resposta por mais tempo e NÃO foram respondidas automaticamente (para não chegar fora de hora). Verifique a conversa.`, "atraso:" + chaveLote, caso?.casoId);
    return;
  }
  if (await estaPausado(c, tel)) return; // atendente humano na conversa

  const hist = await historico(c, pessoa.id);
  // Atrasada: se alguém da equipe já respondeu depois dela, não responde de novo.
  if (atrasoMs) {
    const enviadaEm = Math.max(...msgs.map(m => Number(m.ts) * 1000 || 0));
    const respondida = hist.some(m => String(m.direcao).toUpperCase() === "SAIDA" && Date.parse(String(m.criado_em || "").replace(" ", "T") + "Z") > enviadaEm);
    if (respondida) return;
  }
  const novasIds = new Set(msgs.map(m => m.wamid));

  // 2) "ok", "obrigado" etc. não geram resposta quando não há pergunta pendente.
  const soSocial = msgs.every(m => !m.mediaId && ehMensagemSocial(m.conteudo));
  if (soSocial) {
    const ultimaSaida = [...hist].reverse().find(m => String(m.direcao).toUpperCase() === "SAIDA" && String(m.origem).toUpperCase() !== "LIGACAO");
    const etapaPedeResposta = caso && ["AGUARDANDO_CLIENTE", "AGUARDANDO_ENDERECO"].includes(caso.etapa);
    if (!etapaPedeResposta && !/\?\s*$/.test(String(ultimaSaida?.conteudo || "").trim())) return;
  }

  let consulta = caso ? await consultaDoCaso(c, caso.casoId) : null;
  let autorizados = await autorizadosParaCaso(c, consulta);
  const treinamento = await carregarTreinamento(c);
  const novas = (atrasoMs ? `(ATENÇÃO: estas mensagens chegaram há cerca de ${Math.max(1, Math.round(atrasoMs / 60000))} min e ainda não tinham sido respondidas. Comece com um pedido de desculpas breve e natural pela demora.)\n` : "") + msgs.map(m => `- ${m.conteudo || "(vazio)"}`).join("\n");
  const [perfil, estilo, ficha, memoria, reunioes] = await Promise.all([perfilCliente(c, pessoa), estiloDaEquipe(c), fichaCRM(c, tel), memoriaDoCliente(c, pessoa), reunioesDoCliente(c, tel)]);

  let d;
  try {
    const bruto = await openaiJSON(c, INSTRUCOES_CLIENTE, montarEntradaCliente({ agora: c.agora(), treinamento, caso, consulta, autorizados, recentes, hist: formatarHistorico(hist, "CLIENTE", novasIds), novas, temAnexos: anexos.length > 0, pessoa, perfil, estilo, ficha, memoria, reunioes: reunioes.map(r => `${r.quando_ms ? dataHoraSP(r.quando_ms) : r.quando_txt || "?"} — ${r.assunto || "reunião"}`).join("; "), calendario: calendarioTexto(c.env, c.agora()) }), anexos);
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

  // Reunião online combinada na conversa: registra e avisa a equipe no Telegram da Central.
  const reuniao = d.reuniao ? await registrarReuniao(c, { tel, pessoa, caso, r: d.reuniao, existentes: reunioes }).catch(e => { console.error("reunião", e?.message); return null; }) : null;

  // 4) Decisão determinística.
  const acao = await decidirCliente(c, { tel, pessoa, caso, consulta, d, chaveLote });
  let texto = acao.texto;
  if (!acao.fixa) {
    const g = { reuniao: Boolean(reuniao && !reuniao.recusada), etapa: caso?.etapa || "SEM_CASO", autorizados, modo: CATEGORIAS[caso?.fatos?.categoria]?.modo || "", regiaoConfirmada: caso?.fatos?.regiao_confirmada === "SIM", fatos: caso && !ETAPAS_ENCERRADAS.has(caso.etapa) ? caso.fatos : null, nome: pessoa.nome, perguntadas: perguntasRecentes(hist) };
    const r = guardarResposta(d.resposta, g);
    if (r.removidas.length) await evento(c, caso?.casoId, "RESPOSTA_CORRIGIDA", r.removidas.join(" | "));
    texto = r.texto || respostaPadraoEtapa(caso?.etapa);
  }
  // Reunião: a data dita ao cliente é sempre a que ficou registrada (nunca um dia da semana errado).
  if (reuniao?.recusada) texto = `Poxa, nesse horário não dá: ${reuniao.recusada}. ${reuniao.sugestao ? `Pode ser ${dataExtensoSP(reuniao.sugestao)}?` : "Qual outro dia fica bom pra você?"}`;
  else if (reuniao?.nova && reuniao.quando_ms && !confereDataNoTexto(texto, reuniao.quando_ms)) texto = `Prontinho! Sua reunião online ficou marcada para ${dataExtensoSP(reuniao.quando_ms)}. A equipe vai te enviar o link. 😊`;
  if (!texto) return;
  const ultimaDenia = [...hist].reverse().find(m => String(m.direcao).toUpperCase() === "SAIDA" && !["HUMANO", "LIGACAO"].includes(String(m.origem).toUpperCase()));
  if (!acao.fixa && ultimaDenia && norm(ultimaDenia.conteudo) === norm(texto)) return; // não repetir a mesma frase
  await enviarAoCliente(c, { tel, pessoaId: pessoa.id, casoId: caso?.casoId, texto, chave: chaveLote });
}

// ----- Reuniões online: a DENIA combina com o cliente, a equipe é avisada no Telegram da Central
// (com cliente, dia, hora e assunto) e recebe um lembrete cerca de 1 hora antes.
async function reunioesDoCliente(c, tel) {
  const r = await c.db.prepare("SELECT * FROM d30_reunioes WHERE telefone=? AND status='MARCADA' AND (quando_ms IS NULL OR quando_ms > ?) ORDER BY id DESC LIMIT 5").bind(digitos(tel), c.agora() - 86400000).all().catch(() => null);
  return r?.results || [];
}
function horarioSP(q) {
  const m = String(q || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  const ms = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:00-03:00`) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function textoReuniao(titulo, { nome, tel, quando_ms, quando_txt, assunto }) {
  return [titulo, `Cliente: ${nome || "-"} (${digitos(tel)})`, `Quando: ${quando_ms ? new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(quando_ms)) : quando_txt || "a confirmar"}`,
    `Assunto: ${assunto || "-"}`].join("\n");
}
async function registrarReuniao(c, { tel, pessoa, caso, r, existentes = [] }) {
  const t = digitos(tel), quando_ms = horarioSP(r.quando), agora = c.agora();
  const atual = existentes[0] || null;
  const dados = { nome: pessoa?.nome || "", tel: t, quando_ms, quando_txt: r.quando || null, assunto: r.assunto || atual?.assunto || "" };
  // Trava: feriado, domingo, horário passado ou fora do horário de reuniões não são registrados.
  if (r.acao !== "cancelar" && quando_ms) {
    const motivo = motivoHorarioReuniao(c.env, agora, quando_ms);
    if (motivo) { await evento(c, caso?.casoId, "REUNIAO_RECUSADA", `${dataHoraSP(quando_ms)}: ${motivo}`); return { recusada: motivo, sugestao: proximoHorarioReuniao(c.env, agora, quando_ms) }; }
  }
  if (r.acao === "marcar") {
    if (!quando_ms && !r.quando) return null;
    if (existentes.some(x => quando_ms && x.quando_ms === quando_ms)) return existentes.find(x => x.quando_ms === quando_ms); // já marcada
    const ins = await c.db.prepare("INSERT INTO d30_reunioes(pessoa_id,telefone,nome,caso_id,quando_ms,quando_txt,assunto,status,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,?,?,'MARCADA',?,?) RETURNING id")
      .bind(pessoa?.id || null, t, dados.nome, caso?.casoId || null, quando_ms, dados.quando_txt, dados.assunto, agora, agora).first();
    await alertarEquipe(c, textoReuniao("📅 REUNIÃO ONLINE MARCADA", dados) + "\nCombinado pela DENIA no WhatsApp. Envie o link da reunião ao cliente.", "reuniao:" + ins?.id, caso?.casoId);
    return { ...ins, quando_ms, nova: true };
  }
  if (!atual) return null;
  if (r.acao === "cancelar") {
    await c.db.prepare("UPDATE d30_reunioes SET status='CANCELADA', atualizado_ms=? WHERE id=?").bind(agora, atual.id).run();
    await alertarEquipe(c, textoReuniao("❌ REUNIÃO ONLINE CANCELADA PELO CLIENTE", { ...dados, quando_ms: atual.quando_ms, quando_txt: atual.quando_txt }), "reuniao-cancelada:" + atual.id, caso?.casoId);
    return atual;
  }
  if (!quando_ms && !r.quando) return null;
  if (quando_ms && quando_ms === atual.quando_ms) return atual;
  await c.db.prepare("UPDATE d30_reunioes SET quando_ms=?, quando_txt=?, assunto=COALESCE(NULLIF(?,''),assunto), lembrado_ms=NULL, atualizado_ms=? WHERE id=?").bind(quando_ms, dados.quando_txt, r.assunto || "", agora, atual.id).run();
  const antes = atual.quando_ms ? dataHoraSP(atual.quando_ms) : atual.quando_txt || "?";
  await alertarEquipe(c, textoReuniao(`🔁 REUNIÃO ONLINE REMARCADA (antes: ${antes})`, dados) + "\nEnvie o link atualizado ao cliente, se mudou.", `reuniao-remarcada:${atual.id}:${quando_ms || r.quando}`, caso?.casoId);
  return { ...atual, quando_ms, nova: true };
}
// O texto da IA cita o dia da semana e a data certos da reunião (sem citar outro dia ou outra data)?
function confereDataNoTexto(texto, ms) {
  const n = norm(texto), dia = diaSemanaSP(ms), data = dataSP(ms);
  const citados = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"].map((w, i) => new RegExp(`\\b${w}\\b`).test(n) ? i : -1).filter(i => i >= 0);
  if (citados.some(i => i !== dia)) return false;
  const datas = [...n.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)].map(m => `${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  if (datas.some(d => d !== data.slice(5))) return false;
  return citados.length > 0 || datas.length > 0;
}
async function lembrarReunioes(c) {
  const agora = c.agora();
  const r = await c.db.prepare("SELECT * FROM d30_reunioes WHERE status='MARCADA' AND lembrado_ms IS NULL AND quando_ms BETWEEN ? AND ? LIMIT 10").bind(agora, agora + 65 * 60000).all().catch(() => null);
  for (const x of r?.results || []) {
    await c.db.prepare("UPDATE d30_reunioes SET lembrado_ms=? WHERE id=?").bind(agora, x.id).run();
    if (x.atualizado_ms > x.quando_ms - 70 * 60000) continue; // marcada há pouco: o aviso acabou de sair
    await alertarEquipe(c, textoReuniao(`⏰ LEMBRETE: reunião online daqui a ${Math.max(1, Math.round((x.quando_ms - agora) / 60000))} min`, { nome: x.nome, tel: x.telefone, quando_ms: x.quando_ms, assunto: x.assunto }) + "\nO cliente já recebeu o link?", "reuniao-lembrete:" + x.id, x.caso_id);
  }
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
    const r = await enviarAoPrestador(c, { consulta, caso, texto: `${primeiroNome(consulta.prestador_nome) || "Oi"}, o cliente respondeu: ${d.resposta_para_profissional} (caso ${caso.casoId})`, chave: "resp:" + chaveLote });
    if (r.ok || r.agendado || r.guardada) { await atualizarConsulta(c, consulta.id, { pergunta_pendente: null }); return { texto: "Obrigado! Vamos repassar ao profissional.", fixa: true }; }
    await alertarEquipe(c, `Não foi possível repassar ao profissional a resposta do cliente (caso #${caso.casoId}): ${r.erro}`, "falha-resp:" + chaveLote, caso.casoId);
    return { texto: "Um momento, por favor.", fixa: true };
  }

  // Ponte cliente → profissional: dúvida que só o profissional responde.
  if (d.intencao === "PERGUNTA_PARA_PROFISSIONAL" && consulta && d.resposta_para_profissional && ETAPAS_COM_PRESTADOR.has(caso.etapa)) {
    const pergunta = d.resposta_para_profissional;
    const r = await enviarAoPrestador(c, { consulta, caso, texto: `${primeiroNome(consulta.prestador_nome) || "Oi"}, o cliente do caso ${caso.casoId} perguntou: ${pergunta}`, chave: "pergcli:" + chaveLote });
    if (r.ok || r.agendado || r.guardada) {
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
      const r = await enviarAoPrestador(c, { consulta, caso, texto: `${primeiroNome(consulta.prestador_nome) || "Oi"}, o cliente do caso ${caso.casoId} não consegue nesse horário e pediu outra opção (${pref}). Você teria outro dia ou horário?`, chave: "horario:" + chaveLote });
      if (r.ok || r.agendado || r.guardada) {
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
    const r = await enviarAoPrestador(c, { consulta, caso, texto: `${primeiroNome(consulta.prestador_nome) || "Oi"}, sobre o caso ${caso.casoId}: ${pedido}. Consegue?`, chave: "alter:" + chaveLote });
    if (r.ok || r.agendado || r.guardada) { await atualizarConsulta(c, consulta.id, { pedido_pendente: pedido }); return { texto: "Vamos verificar com o profissional e já retornamos.", fixa: true }; }
    return { texto: "Um momento, por favor.", fixa: true };
  }

  // Mídia nova num caso que já está com o prestador.
  if (consulta && consulta.message_id && ETAPAS_COM_PRESTADOR.has(caso.etapa)) await encaminharMidiasAoPrestador(c, consulta);

  if (caso.etapa === "COLETANDO" && d.quer && d.pronto) {
    // Atendimento no endereço do cliente: pergunta o bairro uma vez antes de chamar o profissional.
    if (CATEGORIAS[caso.fatos.categoria]?.modo === "DOMICILIO" && !caso.fatos.bairro && await reservarChave(c, "pede-bairro:" + caso.casoId))
      return { texto: "Perfeito! Pra eu já passar ao profissional certo: em qual bairro é o atendimento?", fixa: true };
    const r = await consultarPrestador(c, caso, pessoa, chaveLote);
    if (r) return r;
  }
  return { texto: d.resposta };
}

// "escolhido": profissional indicado pela equipe (pelo Telegram). Aí a DENIA consulta exatamente ele,
// mesmo sem categoria certa, e encerra a consulta anterior do caso.
async function consultarPrestador(c, caso, pessoa, chaveLote, escolhido = null) {
  const area = escolhido?.area || caso.fatos.categoria;
  const nomeCli = pessoa.nome || caso.telefone;
  if (!caso.fatos.servico && !caso.fatos.problema) return null;
  if (escolhido) {
    await c.db.prepare(`UPDATE d30_consultas SET status='ENCERRADA', atualizado_ms=? WHERE caso_id=? AND status IN (${STATUS_CONSULTA_ABERTA.map(() => "?").join(",")})`).bind(c.agora(), caso.casoId, ...STATUS_CONSULTA_ABERTA).run();
    await c.db.prepare("UPDATE d30_consultas SET status='ENCERRADA', atualizado_ms=? WHERE caso_id=? AND status='FALHA'").bind(c.agora(), caso.casoId).run();
  } else if (area === "BALCAO") {
    await alertarEquipe(c, `${nomeCli} quer orçamento de balcão (caso #${caso.casoId}): ${caso.fatos.servico || caso.fatos.problema}.`, "balcao:" + caso.casoId, caso.casoId);
    return null;
  }
  else if (!area) {
    await alertarEquipe(c, `Caso #${caso.casoId} (${nomeCli}): não tenho certeza de qual profissional atende "${txt(caso.fatos.servico || caso.fatos.problema, 120)}". Nenhum prestador foi consultado — a equipe decide.`, "semcat:" + caso.casoId, caso.casoId);
    return null;
  }
  if (!escolhido && await consultaDoCaso(c, caso.casoId)) return null; // nunca duplicar consulta
  // Trava: a mensagem de um profissional nunca é repassada a outro profissional como se fosse de cliente.
  if (!escolhido && (prestadorPorTelefone(caso.telefone) || String(pessoa?.tipo || "").toUpperCase() === "TECNICO")) {
    await mudarEtapa(c, caso, "EQUIPE");
    await alertarEquipe(c, `O caso #${caso.casoId} foi aberto por um número de PROFISSIONAL (${nomeCli}). Nenhum outro profissional foi consultado. Verifique a conversa.`, "prof-como-cliente:" + caso.casoId, caso.casoId);
    return null;
  }
  const tentados = new Set(((await c.db.prepare("SELECT prestador_id FROM d30_consultas WHERE caso_id=?").bind(caso.casoId).all())?.results || []).map(x => x.prestador_id));
  const p = escolhido || PRESTADORES.find(x => x.area === area && !tentados.has(x.id));
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
  // Escrita como uma pessoa da equipe escreveria no WhatsApp (sem cara de formulário).
  const local = [f.bairro, f.cidade].filter(Boolean).join(", ");
  const linhas = [
    `${saudacaoSP(c.agora())}, ${primeiroNome(p.nome)}! Tudo bem?`,
    `Tenho um cliente${local ? ` em ${local}` : ""} precisando de ${String(f.problema || f.servico || "").replace(/[.\s]+$/, "")}${f.marca || f.modelo ? ` (${[f.marca, f.modelo].filter(Boolean).join(" ")})` : ""}.`,
    // O que o cliente quer, resumido pela DENIA (frases soltas copiadas do cliente confundiam o profissional).
    caso.resumo && norm(caso.resumo) !== norm(f.problema || f.servico || "") ? `Resumo do pedido: ${ocultarTelefones(txt(caso.resumo, 400))}` : "",
    !f.bairro && CATEGORIAS[area]?.modo === "DOMICILIO" ? "O bairro o cliente ainda não informou." : "",
    `Você consegue pegar? Se sim, me passa o valor e quando pode.`
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
  const partes = [`${primeiroNome(consulta.prestador_nome) || "Oi"}, o cliente do caso ${caso.casoId} aprovou`];
  if (consulta.valor_prestador) partes.push(`o valor de ${moeda(consulta.valor_prestador)}`);
  if (consulta.disponibilidade) partes.push(`para ${consulta.disponibilidade}`);
  const texto = `${partes.join(" ")} 👍${caso.fatos.endereco ? `\nO endereço é ${caso.fatos.endereco}${caso.fatos.bairro ? ` (${caso.fatos.bairro})` : ""}.` : ""}\n${consulta.disponibilidade ? "Pode confirmar pra mim?" : "Qual dia e horário você consegue?"}`;
  const r = await enviarAoPrestador(c, { consulta, caso, texto, chave: "aceite:" + chaveLote });
  if (r.ok || r.agendado || r.guardada) {
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

// ----- Número de caso é só para a DENIA se organizar: no texto para profissionais e clientes vira
// uma referência humana ("Maria (Botafogo)", "o atendimento de Maria (Botafogo)").
const cacheRefCaso = new Map();
async function refCaso(c, casoId) {
  const k = Number(casoId);
  if (cacheRefCaso.has(k)) return cacheRefCaso.get(k);
  let ref = { nome: "", bairro: "" };
  try {
    const caso = await carregarCasoPorId(c, k);
    const cli = caso?.clienteId ? await c.db.prepare("SELECT nome FROM pessoas WHERE id=?").bind(caso.clienteId).first().catch(() => null) : null;
    ref = { nome: primeiroNome(cli?.nome || caso?.fatos?.nome || ""), bairro: String(caso?.fatos?.bairro || "") };
  } catch { /* sem referência */ }
  if (cacheRefCaso.size > 300) cacheRefCaso.clear();
  cacheRefCaso.set(k, ref);
  return ref;
}
const pessoaRef = r => r.nome ? `${r.nome}${r.bairro ? ` (${r.bairro})` : ""}` : r.bairro ? `o cliente de ${r.bairro}` : "o cliente";
const atendimentoRef = r => r.nome ? `o atendimento de ${r.nome}${r.bairro ? ` (${r.bairro})` : ""}` : r.bairro ? `o atendimento em ${r.bairro}` : "o atendimento";
async function humanizarCasos(c, texto) {
  let t = String(texto || "");
  if (!/caso\s*#?\s*\d|#\d{2,}/i.test(t)) return t;
  const ids = [...new Set([...t.matchAll(/(?:caso\s*#?\s*|#)(\d{1,9})/gi)].map(m => m[1]))];
  for (const id of ids) {
    const r = await refCaso(c, id);
    const at = atendimentoRef(r);
    t = t.replace(new RegExp(`\\s*\\((?:do\\s+)?caso\\s*#?\\s*${id}\\)`, "gi"), "")
      .replace(new RegExp(`\\bo cliente do caso\\s*#?\\s*${id}\\b`, "gi"), pessoaRef(r))
      .replace(new RegExp(`\\bsobre o caso\\s*#?\\s*${id}\\b`, "gi"), "sobre " + at)
      .replace(new RegExp(`\\bdo caso\\s*#?\\s*${id}\\b`, "gi"), "d" + at)
      .replace(new RegExp(`\\bno caso\\s*#?\\s*${id}\\b`, "gi"), "n" + at)
      .replace(new RegExp(`\\b[ée] o caso\\s*#?\\s*${id}\\b`, "gi"), "É " + at)
      .replace(new RegExp(`\\bo caso\\s*#?\\s*${id}\\b`, "gi"), at)
      .replace(new RegExp(`\\bcaso\\s*#?\\s*${id}\\b`, "gi"), at.replace(/^o /, ""))
      .replace(new RegExp(`#${id}\\b`, "g"), "");
  }
  return t.split("\n").map(l => l.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?:])/g, "$1").trim()).filter((l, i, arr) => l || (i > 0 && arr[i - 1])).join("\n").trim();
}

// "amanhã às 10h" e "amanhã 10:00" são o mesmo horário: só muda se o dia ou a hora mudarem.
function mesmoHorario(a, b) {
  const partes = v => new Set(norm(v).replace(/(\d{1,2})\s*(?::\s*00|h(?:rs?|oras?|s)?)\b/g, "$1").split(/[^a-z0-9]+/)
    .filter(w => w && !["as", "a", "o", "de", "do", "da", "dia", "h", "hs", "horas", "pelas", "umas", "por", "volta", "partir", "ate", "e", "pode", "ser", "fica", "confirmado", "confirmo", "combinado", "sim", "ok", "entao"].includes(w)));
  const x = partes(a), y = partes(b);
  if (!x.size || !y.size) return true;
  const [menor, maior] = x.size <= y.size ? [x, y] : [y, x];
  return [...menor].every(w => maior.has(w));
}

function resumoParaPrestador(caso, consulta) {
  const f = caso.fatos || {};
  return [`É o caso ${caso.casoId}: cliente${f.bairro ? ` em ${f.bairro}` : ""} precisando de ${String(f.problema || f.servico || "-").replace(/[.\s]+$/, "")}${f.marca || f.modelo ? ` (${[f.marca, f.modelo].filter(Boolean).join(" ")})` : ""}.`,
    caso.resumo && norm(caso.resumo) !== norm(f.problema || "") ? `Resumo: ${txt(caso.resumo, 400)}` : "",
    consulta.status === "ENVIADA" && !["AGENDADO", "EM_ANDAMENTO", "CONCLUIDO"].includes(caso.etapa) ? "Você consegue pegar? Se sim, me passa o valor e quando pode." : ["AGENDADO", "EM_ANDAMENTO"].includes(caso.etapa) && consulta.disponibilidade ? `Está agendado para ${consulta.disponibilidade}.` : ""].filter(Boolean).join("\n");
}

async function consultaPeloContexto(c, abertas, msgs, textoTodo, pessoaPrest) {
  try {
    // Texto da mensagem que ele respondeu (citação), mesmo que tenha sido escrita pela equipe.
    const citados = [];
    for (const m of msgs) {
      if (!m.contextId) continue;
      const ref = await c.db.prepare("SELECT conteudo FROM mensagens WHERE whatsapp_message_id=? LIMIT 1").bind(m.contextId).first().catch(() => null);
      if (ref?.conteudo) citados.push(ref.conteudo);
    }
    // Sem citação: a última mensagem que a equipe ou a DENIA mandou para ele.
    if (!citados.length && pessoaPrest?.id) {
      const ult = await c.db.prepare("SELECT conteudo FROM mensagens WHERE empresa_id=? AND pessoa_id=? AND UPPER(direcao)='SAIDA' ORDER BY id DESC LIMIT 2").bind(EMPRESA_ID, pessoaPrest.id).all().catch(() => null);
      for (const x of ult?.results || []) citados.push(x.conteudo || "");
    }
    const alvo = norm([textoTodo, ...citados].join(" "));
    // Nomes curtos ("Bia", "Ana") também contam, como palavra inteira.
    const pontuar = (v, peso, min = 4) => { let p = 0; for (const w of new Set(norm(v).split(/[^a-z0-9]+/).filter(x => x.length >= min))) if (min < 4 ? new RegExp(`\\b${w}\\b`).test(alvo) : alvo.includes(w)) p += peso; return p; };
    let melhor = null, pontos = 0, segundo = 0;
    for (const k of abertas.slice(0, 6)) {
      const caso = await carregarCasoPorId(c, k.caso_id);
      if (!caso) continue;
      const cli = caso.clienteId ? await c.db.prepare("SELECT nome FROM pessoas WHERE id=?").bind(caso.clienteId).first().catch(() => null) : null;
      const f = caso.fatos || {};
      const p = pontuar(cli?.nome, 3, 3) + pontuar(f.bairro, 2) + pontuar(f.endereco, 2) + pontuar(f.servico, 1) + pontuar(f.problema, 1) + pontuar([f.marca, f.modelo].join(" "), 1);
      if (p > pontos) { segundo = pontos; pontos = p; melhor = k; } else if (p > segundo) segundo = p;
    }
    return pontos >= 3 && pontos >= segundo + 2 ? melhor : null;
  } catch (e) { console.warn("contexto do profissional", e?.message); return null; }
}

// Últimas mensagens do cliente neste atendimento (para o profissional entender do que se trata).
async function palavrasDoCliente(c, caso) {
  if (!caso?.clienteId) return "";
  const r = await c.db.prepare("SELECT conteudo FROM mensagens WHERE empresa_id=? AND pessoa_id=? AND caso_id=? AND UPPER(direcao)='ENTRADA' ORDER BY id DESC LIMIT 8").bind(EMPRESA_ID, caso.clienteId, caso.casoId).all().catch(() => null);
  return (r?.results || []).reverse().map(m => "- " + txt(m.conteudo, 300)).join("\n");
}
// Conversa em andamento: o atendimento de que o profissional estava falando (a última mensagem DELE ligada
// a um caso aberto), desde que nada de outro atendimento tenha sido trocado com ele depois e que a conversa
// esteja ativa (a DENIA falou com ele nas últimas 12 h). Duas consultas novas seguidas não contam: aí pergunta.
async function consultaDaConversa(c, abertas, pessoa) {
  if (!pessoa?.id) return null;
  const vs = variantesTel(pessoa.telefone || "");
  const quente = vs.length ? await c.db.prepare(`SELECT 1 ok FROM d30_saidas WHERE telefone IN (${vs.map(() => "?").join(",")}) AND criado_ms > ? LIMIT 1`).bind(...vs, c.agora() - 12 * 3600000).first().catch(() => null) : null;
  if (!quente) return null;
  // Acabamos de perguntar "de qual atendimento?" (mensagem sem caso): a resposta dele não decide sozinha.
  const ultima = await c.db.prepare("SELECT caso_id, direcao FROM mensagens WHERE empresa_id=? AND pessoa_id=? ORDER BY id DESC LIMIT 1").bind(EMPRESA_ID, pessoa.id).first().catch(() => null);
  if (ultima && !ultima.caso_id && String(ultima.direcao).toUpperCase() === "SAIDA") return null;
  const dele = await c.db.prepare("SELECT id, caso_id FROM mensagens WHERE empresa_id=? AND pessoa_id=? AND caso_id IS NOT NULL AND UPPER(direcao)='ENTRADA' ORDER BY id DESC LIMIT 1").bind(EMPRESA_ID, pessoa.id).first().catch(() => null);
  const k = dele ? abertas.find(x => x.caso_id === dele.caso_id) : null;
  if (k) {
    const outra = await c.db.prepare("SELECT 1 ok FROM mensagens WHERE empresa_id=? AND pessoa_id=? AND id > ? AND caso_id IS NOT NULL AND caso_id <> ? LIMIT 1").bind(EMPRESA_ID, pessoa.id, dele.id, dele.caso_id).first().catch(() => null);
    if (!outra) return k;
  }
  // Acabamos de mandar a ele um atendimento (ex.: a consulta) e os outros abertos estão parados há 10 min ou mais:
  // a mensagem dele é sobre esse ("qual o bairro?" logo depois do pedido).
  const ord = [...abertas].sort((a, b) => Number(b.atualizado_ms || 0) - Number(a.atualizado_ms || 0));
  const recente = ord[0];
  if (recente && c.agora() - Number(recente.atualizado_ms || 0) < 6 * 3600000 && (!ord[1] || Number(recente.atualizado_ms) - Number(ord[1].atualizado_ms || 0) >= 10 * 60000)) return recente;
  return null;
}
// Mensagem que o profissional quer que chegue ao cliente: os links vão inteiros (nunca cortados nem resumidos)
// e só sai o que não pode ir ao cliente (telefone, documento, valor fora dos autorizados).
const URL_RE = /\bhttps?:\/\/[^\s<>"]+|\bwww\.[^\s<>"]+/gi;
function mensagemParaEncaminhar(texto, original, autorizados) {
  const links = [...new Set(String(original || "").match(URL_RE) || [])];
  let t = String(texto || "").trim();
  for (const l of links) if (!t.includes(l)) t += "\n" + l;
  const guardados = [];
  const semLinks = t.replace(URL_RE, m => { guardados.push(m); return `§${guardados.length - 1}§`; });
  const g = { etapa: "AGENDADO", autorizados, regiaoConfirmada: true };
  const removidas = [];
  const linhas = semLinks.split("\n").map(l => {
    const frases = l.match(/[^.!?]+[.!?]*\s*/g) || [l];
    return frases.filter(f => { const m = fraseProibida(f, g); if (m && /telefone|documento|valor/.test(m)) { removidas.push(m); return false; } return true; }).join("").trim();
  });
  const final = linhas.join("\n").replace(/§(\d+)§/g, (_, i) => guardados[Number(i)]).replace(/\n{3,}/g, "\n\n").trim();
  return { texto: final.slice(0, 3500), removidas, links };
}

const INSTRUCOES_IDENTIFICAR = `Você identifica de qual atendimento um PROFISSIONAL parceiro da Central está falando. Pense como uma pessoa experiente da Central que acabou de receber a mensagem: quem está falando, o que vocês conversaram por último e o que ele quer agora. Use tudo: nome do cliente, bairro, endereço, serviço, valores e datas combinados, e o que aparece em fotos, comprovantes ou áudios (valor, data, nome). A conversa mais recente com ele pesa mais.
Responda SOMENTE JSON {"caso_id":0,"confianca":"BAIXA","motivo":""}. caso_id só da lista. confianca "ALTA" ou "MEDIA" só quando der para saber com segurança; senão caso_id 0 e "BAIXA". Nunca chute.`;
async function identificarCasoComIA(c, abertas, msgs, textoTodo, pessoa, anexos = []) {
  if (!c.env.OPENAI_API_KEY || sobram(c) < 15) return null;
  try {
    const linhas = [];
    for (const k of abertas.slice(0, 8)) {
      const caso = await carregarCasoPorId(c, k.caso_id);
      if (!caso) continue;
      const cli = caso.clienteId ? await c.db.prepare("SELECT nome FROM pessoas WHERE id=?").bind(caso.clienteId).first().catch(() => null) : null;
      const f = caso.fatos || {};
      linhas.push(`#${caso.casoId} — cliente ${cli?.nome || "-"}${f.bairro ? ", " + f.bairro : ""}${f.endereco ? ", " + txt(f.endereco, 60) : ""}: ${txt(f.problema || f.servico || "-", 100)} | etapa ${caso.etapa}${k.valor_prestador ? ` | valor dele ${moeda(k.valor_prestador)}` : ""}${k.valor_cliente ? ` | valor ao cliente ${moeda(k.valor_cliente)}` : ""}${k.disponibilidade ? ` | combinado: ${txt(k.disponibilidade, 60)}` : ""} | atualizado ${dataHoraSP(Number(k.atualizado_ms || 0))}`);
    }
    const hist = pessoa?.id ? ((await c.db.prepare("SELECT caso_id, direcao, conteudo FROM mensagens WHERE empresa_id=? AND pessoa_id=? ORDER BY id DESC LIMIT 12").bind(EMPRESA_ID, pessoa.id).all().catch(() => null))?.results || []).reverse()
      .map(m => `${String(m.direcao).toUpperCase() === "ENTRADA" ? "ELE" : "CENTRAL"}${m.caso_id ? ` [#${m.caso_id}]` : ""}: ${txt(m.conteudo, 200)}`).join("\n") : "";
    const o = await openaiJSON(c, INSTRUCOES_IDENTIFICAR, `ATENDIMENTOS ABERTOS COM ELE:\n${linhas.join("\n")}\n\nCONVERSA RECENTE COM ELE (mais antiga primeiro):\n${hist || "-"}\n\nMENSAGEM NOVA DELE:\n${txt(textoTodo, 1500) || "(só anexo)"}${anexos.length ? "\n(há anexo: leia valor, data e nomes)" : ""}\n\nResponda em JSON.`, anexos, 200);
    const id = Number(o?.caso_id || 0), conf = String(o?.confianca || "").toUpperCase();
    if (!id || !["ALTA", "MEDIA"].includes(conf)) return null;
    const escolhida = abertas.find(k => Number(k.caso_id) === id) || null;
    if (escolhida) await evento(c, id, "CASO_IDENTIFICADO_IA", txt(o?.motivo, 300));
    return escolhida;
  } catch (e) { console.warn("identificar caso", e?.message); return null; }
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
  // Várias abertas: descobre pelo contexto — a mensagem que ele respondeu (inclusive as da equipe,
  // como "Serviço agendado: nome, endereço…"), o nome do cliente, o bairro, o endereço e o serviço.
  if (!consulta && abertas.length > 1) consulta = await consultaPeloContexto(c, abertas, msgs, textoTodo, pessoa);
  // Conversa em andamento: sem outra pista, ele continua falando do atendimento da última mensagem trocada com ele.
  if (!consulta && abertas.length > 1) consulta = await consultaDaConversa(c, abertas, pessoa);
  // Ainda sem saber: a IA lê como uma pessoa leria (nomes, bairro, serviço, valores, datas, o comprovante) e escolhe.
  if (!consulta && abertas.length > 1 && !msgs.every(m => !m.mediaId && ehMensagemSocial(m.conteudo))) consulta = await identificarCasoComIA(c, abertas, msgs, textoTodo, pessoa, anexos);

  for (const m of msgs) await registrarMensagem(c, { pessoaId: pessoa?.id, casoId: consulta?.caso_id, wamid: m.wamid, direcao: "ENTRADA", origem: "WHATSAPP", tipo: String(m.tipo || "text").toUpperCase(), conteudo: m.conteudo });
  if (apenasRegistrar || await estaPausado(c, tel)) return;
  if (!prest && !abertas.length) return;

  if (!consulta && abertas.length > 1) {
    // Confirmação simples ("ok", "fechado", "obrigado") não precisa de pergunta: fica registrada para a equipe.
    if (msgs.every(m => !m.mediaId && ehMensagemSocial(m.conteudo))) return;
    const casos = (await Promise.all(abertas.slice(0, 4).map(x => carregarCasoPorId(c, x.caso_id)))).filter(Boolean);
    const opcoes = [];
    for (const k of casos) { const r = await refCaso(c, k.casoId); opcoes.push(`${r.nome ? `de ${r.nome}` : "do cliente"}${r.bairro ? ` em ${r.bairro}` : ""}${k.fatos.problema || k.fatos.servico ? ` (${txt(k.fatos.problema || k.fatos.servico, 50)})` : ""}`); }
    const lista = opcoes.length > 1 ? opcoes.slice(0, -1).join(", ") + " ou " + opcoes.at(-1) : opcoes[0] || "";
    // Pergunta curta: só os nomes (no máximo 3), como uma pessoa perguntaria.
    const nomes = [];
    for (const k of casos.slice(0, 3)) { const r = await refCaso(c, k.casoId); nomes.push((r.nome || `o de ${txt(k.fatos.problema || k.fatos.servico, 40)}`) + (r.bairro ? ` (${r.bairro})` : "")); }
    const nomesCurtos = nomes.length > 1 ? nomes.slice(0, -1).join(", ") + " ou " + nomes.at(-1) : nomes[0] || "o atendimento";
    // Pergunta uma vez só a cada 6 h: se ele não esclareceu, quem resolve é a equipe (nada de repetir a mesma pergunta).
    if (!(await reservarChave(c, `qual:${digitos(tel)}:${Math.floor(c.agora() / (6 * 3600000))}`))) {
      await alertarEquipe(c, `${prest?.nome || pessoa?.nome || tel} mandou mensagem e não deu para saber de qual atendimento é (${lista}): "${txt(textoTodo, 300)}". Nada foi repassado. Responda a ele pelo app.`, "qual-equipe:" + chaveLote);
      return;
    }
    await enviarAgoraAoPrestador(c, { consulta: { ...abertas[0], caso_id: null }, texto: `É sobre qual cliente: ${nomesCurtos}?`, chave: "qual:" + chaveLote });
    return;
  }
  if (!consulta) return; // mensagem solta de prestador: só registra (a equipe vê no app)

  const caso = await carregarCasoPorId(c, consulta.caso_id);
  if (!caso) return;
  // Histórico com ele: o deste caso e o que a equipe mandou (pelo celular) sem caso ligado.
  const histPessoa = await historico(c, pessoa?.id, 40);
  const soltasDaEquipe = histPessoa.filter(m => !m.caso_id && String(m.origem).toUpperCase() === "HUMANO");
  if (soltasDaEquipe.length) { for (const m of soltasDaEquipe) m.caso_id = caso.casoId; await c.db.prepare(`UPDATE mensagens SET caso_id=? WHERE id IN (${soltasDaEquipe.map(() => "?").join(",")})`).bind(caso.casoId, ...soltasDaEquipe.map(m => m.id)).run().catch(() => {}); }
  const histCaso = histPessoa.filter(m => m.caso_id === caso.casoId);
  // A equipe mexeu no caso depois da consulta (agendou por telefone/WhatsApp)? Atualiza a etapa antes de responder.
  const equipeDepois = histCaso.some(m => String(m.origem).toUpperCase() === "HUMANO" && Date.parse(String(m.criado_em || "").replace(" ", "T") + "Z") > Number(consulta.criado_ms || 0));
  if (equipeDepois && !["AGENDADO", "EM_ANDAMENTO"].includes(caso.etapa) && !ETAPAS_ENCERRADAS.has(caso.etapa) && c.env.OPENAI_API_KEY && sobram(c) > 22) {
    try {
      const rev = await revisarEtapaCaso(c, caso, { aplicar: true, autor: "leitura antes de responder ao profissional" });
      if (rev.aplicada) { Object.assign(caso, await carregarCasoPorId(c, caso.casoId)); Object.assign(consulta, await c.db.prepare("SELECT * FROM d30_consultas WHERE id=?").bind(consulta.id).first()); }
    } catch (e) { console.warn("revisão antes de responder", e?.message); }
  }
  const ultimaNossa = [...histCaso].reverse().find(m => String(m.direcao).toUpperCase() === "SAIDA" && String(m.origem).toUpperCase() !== "LIGACAO" && !msgs.some(x => x.wamid === m.whatsapp_message_id));
  const doCliente = await palavrasDoCliente(c, caso);
  let d;
  try {
    d = await openaiJSON(c, INSTRUCOES_PRESTADOR, `CASO #${caso.casoId} — etapa ${caso.etapa}; consulta ${consulta.status}
FATOS DO CASO:
${formatarFatos(caso.fatos)}
${consulta.valor_prestador ? `Valor já informado por ele: ${moeda(consulta.valor_prestador)} (final para o cliente: ${consulta.valor_final || "não informado"})` : ""}
${consulta.disponibilidade ? `Disponibilidade já informada: ${consulta.disponibilidade}` : ""}
${consulta.pedido_pendente ? `PEDIDO PENDENTE DO CLIENTE (responda a ele com RESPONDE e mensagem_para_cliente): ${consulta.pedido_pendente}` : ""}
ÚLTIMA MENSAGEM QUE ENVIAMOS A ELE: ${ultimaNossa?.conteudo || "-"}
RESUMO DO ATENDIMENTO: ${caso.resumo || "-"}
O QUE O CLIENTE ESCREVEU (mais recentes por último):
${doCliente || "-"}

HISTÓRICO DESTE CASO COM O PROFISSIONAL:
${formatarHistorico(histCaso, "PROFISSIONAL", new Set(msgs.map(m => m.wamid)))}

MENSAGEM NOVA DO PROFISSIONAL:
${textoTodo}

Responda em JSON.`, anexos, 700);
  } catch (e) {
    await alertarEquipe(c, `Falha da IA ao ler a resposta de ${consulta.prestador_nome} (caso #${caso.casoId}): "${txt(textoTodo, 300)}". Tratar manualmente.`, "ia:prest:" + chaveLote, caso.casoId);
    return;
  }
  await tratarRespostaPrestador(c, { caso, consulta, d, textoTodo, chaveLote, histCaso, msgs });
}

// Serviço já agendado/em andamento: a DENIA responde o profissional como alguém da equipe que leu tudo
// (só chama a equipe quando ele quer remarcar, cancelar ou relata um problema).
const INSTRUCOES_PROFISSIONAL_AGENDADO = `Você é da equipe da Central e fala com um PROFISSIONAL parceiro sobre um serviço que JÁ ESTÁ AGENDADO (ou em andamento). Leia os fatos e o histórico (inclusive o que a equipe combinou por telefone ou pelo celular) e responda a mensagem dele como uma pessoa da equipe responderia: curto (1 ou 2 frases), simpático, direto, sem formalidade, sem número de caso.
- Se ele confirma, agradece ou avisa que vai: responda curto ("Perfeito, obrigada! Qualquer coisa me chama.") ou deixe resposta vazia se nem precisa responder.
- Se pergunta algo que está nos fatos/histórico (endereço, horário, valor, o que fazer): responda com o dado certo.
- Se ele quer remarcar, cancelar, mudar valor, relata problema no local ou algo que você não sabe: precisa_equipe=true e responda que vai verificar e já retorna.
Nunca invente dado. Responda em JSON {"resposta":"","precisa_equipe":false,"motivo":""}`;

async function tratarRespostaPrestador(c, { caso, consulta, d, textoTodo, chaveLote, histCaso = [], msgs = [] }) {
  let tipo = String(d?.tipo || "COMENTARIO").toUpperCase();
  const cliente = await c.db.prepare("SELECT id,nome,telefone FROM pessoas WHERE id=?").bind(caso.clienteId).first();
  const telCliente = cliente?.telefone || caso.telefone;
  // Nunca manda ao profissional a mesma mensagem que acabou de mandar: se ia repetir, quem responde é a equipe.
  const ultimaAEle = [...histCaso].reverse().find(m => String(m.direcao).toUpperCase() === "SAIDA" && !msgs.some(x => x.wamid === m.whatsapp_message_id));
  const responder = async (texto, k) => {
    if (ultimaAEle && norm(await humanizarCasos(c, texto)) === norm(ultimaAEle.conteudo)) {
      await alertarEquipe(c, `A DENIA ia repetir para ${consulta.prestador_nome} a mesma mensagem ("${txt(texto, 160)}") sobre ${cliente?.nome || "o cliente"} (caso #${caso.casoId}). Ele escreveu: "${txt(textoTodo, 300)}". Responda a ele pelo app.`, "repetiria:" + chaveLote, caso.casoId);
      return { ok: false, repetida: true };
    }
    return enviarAgoraAoPrestador(c, { consulta, caso, texto, chave: k + ":" + chaveLote });
  };
  const avisarCliente = async (texto, k) => {
    const r = await enviarAoCliente(c, { tel: telCliente, pessoaId: cliente?.id, casoId: caso.casoId, texto, chave: k + ":" + chaveLote, origem: "SISTEMA" });
    if (!r.ok && !r.duplicado && !r.guardada) await alertarEquipe(c, `Retorno do profissional no caso #${caso.casoId} NÃO foi enviado ao cliente (${r.pausado ? "atendente está na conversa" : r.erro}). Mensagem que seria enviada: "${texto}"`, "falha-cli:" + k + ":" + chaveLote, caso.casoId);
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

  // Serviço já agendado/em andamento: responde como alguém da equipe que leu tudo.
  const responderAgendado = async () => {
      if (msgs.length && msgs.every(m => !m.mediaId && ehMensagemSocial(m.conteudo))) return; // "ok", "combinado": nada a responder
      let o = null;
      try {
        o = await openaiJSON(c, INSTRUCOES_PROFISSIONAL_AGENDADO, `ETAPA: ${caso.etapa}\nFATOS DO SERVIÇO:\n${formatarFatos(caso.fatos)}\nCliente: ${cliente?.nome || "-"}\nData/horário combinado: ${consulta.disponibilidade || caso.fatos?.preferencia_horario || "-"}\nValor ao cliente: ${consulta.valor_cliente ? moeda(consulta.valor_cliente) : "-"}; parte do profissional: ${consulta.valor_prestador ? moeda(consulta.valor_prestador) : "-"}\nResumo: ${caso.resumo || "-"}\n\nHISTÓRICO COM O PROFISSIONAL:\n${formatarHistorico(histCaso, "PROFISSIONAL", new Set(msgs.map(m => m.wamid)))}\n\nMENSAGEM NOVA DO PROFISSIONAL:\n${textoTodo}\n\nResponda em JSON.`, [], 400);
      } catch (e) { console.warn("resposta ao profissional", e?.message); }
      const resposta = txt(o?.resposta, 600);
      if (resposta) await responder(resposta, "agendado-resp");
      if (!o || o.precisa_equipe === true) await alertarEquipe(c, `${consulta.prestador_nome} escreveu sobre o serviço já agendado de ${cliente?.nome || "um cliente"}: "${txt(textoTodo, 300)}"${o?.motivo ? ` — ${txt(o.motivo, 200)}` : ""}. Confira.`, "pos:" + chaveLote, caso.casoId);
      return;
  };
  if (tipo === "PEDE_CONTEXTO") { await responder(resumoParaPrestador(caso, consulta), "ctx"); return; }
  if (["AGENDADO", "EM_ANDAMENTO"].includes(caso.etapa) && !["RECUSA", "RESPONDE", "ENCAMINHAR", "CONFIRMA_AGENDAMENTO", "ACEITA"].includes(tipo) && d?.atende_regiao !== "NAO") { await responderAgendado(); return; }

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
    if (conhecida) { await responder(`${conhecida} (caso ${caso.casoId})`, "conhecida"); return; }
    const pergunta = txt(d?.pergunta_para_cliente, 300);
    if (!pergunta) return;
    const r = await avisarCliente(pergunta, "pergunta");
    // Mesmo se a mensagem ao cliente ficou guardada ou a equipe vai repassar, o profissional sabe que foi visto.
    if (r.ok || r.guardada) await atualizarConsulta(c, consulta.id, { pergunta_pendente: pergunta });
    if (!r.duplicado) await responder("Vou confirmar com o cliente e já retorno.", "perg-ok");
    return;
  }

  if (tipo === "COMPROVANTE") {
    await responder("Recebido, obrigado! ✅", "comprov-ok");
    await alertarEquipe(c, `Comprovante de ${consulta.prestador_nome} sobre o atendimento de ${cliente?.nome || "o cliente"} (caso #${caso.casoId}): ${txt(d?.resumo || textoTodo, 300) || "ver na conversa"}. Conferir.`, "comprovante:prest:" + chaveLote, caso.casoId);
    return;
  }
  if (tipo === "ENCAMINHAR") {
    const enc = mensagemParaEncaminhar(d?.mensagem_para_cliente || textoTodo, [textoTodo, ...histCaso.filter(m => String(m.direcao).toUpperCase() === "ENTRADA").slice(-6).map(m => m.conteudo)].join("\n"), await autorizadosParaCaso(c, consulta));
    if (!enc.texto) { await alertarEquipe(c, `${consulta.prestador_nome} pediu para encaminhar algo a ${cliente?.nome || "o cliente"} (caso #${caso.casoId}), mas não ficou claro o quê: "${txt(textoTodo, 300)}".`, "enc-vazio:" + chaveLote, caso.casoId); return; }
    const r = await avisarCliente(enc.texto, "encaminhar");
    const quem = primeiroNome(cliente?.nome) || "o cliente";
    if (r.ok) {
      await evento(c, caso.casoId, "ENCAMINHADO_AO_CLIENTE", enc.texto);
      await responder(`Pronto, enviei para ${quem} ✅${enc.links.length ? ` (${enc.links.length} link${enc.links.length > 1 ? "s" : ""})` : ""}${enc.removidas.length ? ". Tirei telefone/valor da mensagem: isso a equipe passa." : ""}`, "enc-ok");
    } else if (!r.duplicado) await responder(r.pausado ? `A equipe está conversando com ${quem} agora, então não enviei. Já avisei a equipe para repassar.` : `Não consegui enviar para ${quem} (${txt(r.erro, 80) || "o WhatsApp recusou"}). Já avisei a equipe.`, "enc-falha");
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
      const novaData = disp && !mesmoHorario(disp, consulta.disponibilidade || "");
      if (novaData && consulta.disponibilidade) {
        // Propôs outro horário: volta ao cliente.
        await atualizarConsulta(c, consulta.id, { disponibilidade: disp, status: "RESPONDIDA" });
        const r = await avisarCliente(`O profissional propôs ${disp}. Podemos confirmar?`, "novohorario");
        if (r.ok) { await mudarEtapa(c, caso, "AGUARDANDO_CLIENTE"); await responder(`Combinado, vou ver com o cliente se ${disp} funciona e te retorno.`, "novohorario-ok"); }
        return;
      }
      const dataFinal = disp || consulta.disponibilidade;
      if (!dataFinal) { await responder(`Combinado! Só me confirma o dia e o horário certinho, por favor (caso ${caso.casoId}).`, "qualdata"); return; }
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
    if (["AGENDADO", "EM_ANDAMENTO"].includes(caso.etapa)) { await responderAgendado(); return; }

    // Proposta (valor e/ou disponibilidade).
    const valorPrest = valor || (consulta.status === "AGUARDANDO_COMPOSICAO" ? Number(consulta.valor_prestador || 0) : 0);
    const composicao = finalInf || (valor ? "" : String(consulta.valor_final || ""));
    if (valorPrest && !composicao) {
      await atualizarConsulta(c, consulta.id, { valor_prestador: valorPrest, status: "AGUARDANDO_COMPOSICAO", disponibilidade: disp || consulta.disponibilidade });
      await responder(`Só pra eu confirmar: ${moeda(valorPrest)} já é o valor final pro cliente ou é só a sua parte?`, "composicao");
      return;
    }
    const dispFinal = disp || consulta.disponibilidade || "";
    if (!valorPrest && !dispFinal) { await responder(`Obrigada! Me passa o valor e quando você pode atender? (caso ${caso.casoId})`, "pedevalor"); return; }
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

  // COMENTARIO: nenhuma ação automática. "Ok", "obrigado", "beleza" não precisam da equipe.
  if (msgs.length && msgs.every(m => !m.mediaId && ehMensagemSocial(m.conteudo))) return;
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
  if (id.papel === "PRESTADOR") {
    const ab = await consultasAbertasPrestador(c, eco.para);
    if (ab.length === 1) casoId = ab[0].caso_id;
    else if (ab.length > 1) casoId = (await consultaPeloContexto(c, ab, [], msg.conteudo, null))?.caso_id || null;
  }
  await registrarMensagem(c, { pessoaId: pessoa?.id, casoId, wamid: eco.wamid, direcao: "SAIDA", origem: "HUMANO", tipo: String(eco.tipo || "text").toUpperCase(), conteudo: msg.conteudo });
  // A equipe combinou algo pelo celular (agendou, confirmou, mudou valor, cancelou, concluiu): a DENIA atualiza o caso.
  if (casoId && /agend|confirm|marcad|combinad|cancel|desist|conclu|finaliz|pront[oa]|valor|r\$|\b\d{1,2}h\b|\d{1,2}:\d{2}|amanh|hoje|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo/i.test(msg.conteudo || "")) {
    const caso = await carregarCasoPorId(c, casoId);
    if (caso && !ETAPAS_ENCERRADAS.has(caso.etapa) && c.env.OPENAI_API_KEY && sobram(c) > 15) await revisarEtapaCaso(c, caso, { aplicar: true, autor: "mensagem da equipe" }).catch(e => console.warn("revisão pela equipe", e?.message));
  }
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
    // Sem chamadas suficientes nesta execução: deixa na fila; o cron (a cada minuto) responde com a execução zerada.
    if (sobram(c) < 18) return;
    const lote = crypto.randomUUID(), agora = c.agora();
    const itens = (await c.db.prepare(`UPDATE d30_fila SET status='PROCESSANDO', lote=?, atualizado_ms=? WHERE telefone=? AND status='PENDENTE'
      AND NOT EXISTS (SELECT 1 FROM d30_fila f2 WHERE f2.telefone=? AND f2.status='PROCESSANDO' AND f2.atualizado_ms > ?) RETURNING wamid, payload, recebido_ms`)
      .bind(lote, agora, tel, tel, agora - 120000).all())?.results || [];
    if (!itens.length) return;
    itens.sort((a, b) => a.recebido_ms - b.recebido_ms);
    let status = "CONCLUIDO", erro = null;
    try {
      try { await processarLote(c, tel, itens); }
      catch (e) {
        if (e?.adiar) throw e;
        // Estourou o limite de chamadas desta execução: devolve à fila para o cron responder (não é erro).
        if (/too many (subrequests|api requests)/i.test(String(e?.message || "")) || sobram(c) < 18) { const x = new Error("limite de chamadas"); x.limite = true; throw x; }
        // Falha passageira (rede, banco, IA): tenta mais uma vez antes de desistir, para nenhuma conversa ficar sem resposta.
        console.error("lote (tentando de novo)", tel, e?.message);
        await sleep(Math.min(2000, janela(c.env)));
        await processarLote(c, tel, itens);
      }
    }
    catch (e) {
      if (e?.limite || /too many (subrequests|api requests)/i.test(String(e?.message || ""))) {
        try { await c.env.DB.prepare("UPDATE d30_fila SET status='PENDENTE', lote=NULL, atualizado_ms=? WHERE lote=?").bind(c.agora() - 180000, lote).run(); } catch { /* o cron recupera os PROCESSANDO presos */ }
        console.warn("Limite de chamadas: mensagens de", tel, "voltaram para a fila do cron.");
        return;
      }
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
  const idade = m => agora - (Number(m.ts) * 1000 || m.recebidoMs || agora);
  const frescas = msgs.filter(m => idade(m) <= FILA_EXPIRA_MS);
  const ate12h = msgs.filter(m => idade(m) <= atrasoMaximo(c.env));
  const opts = { apenasRegistrar: ate12h.length === 0, atrasoMs: frescas.length ? 0 : Math.min(...ate12h.map(idade)), chaveLote: msgs[msgs.length - 1].wamid };
  if (opts.apenasRegistrar) c.atrasadasSemResposta = (c.atrasadasSemResposta || 0) + 1; // velha demais: só registra
  // Resposta atrasada só se ninguém da equipe já respondeu depois da mensagem, e no máximo 3 por execução
  // (se há muitas atrasadas é porque algo ficou parado: a equipe é avisada, nada sai em massa).
  if (!opts.apenasRegistrar && opts.atrasoMs > 0) {
    const desde = new Date(agora - Math.max(...msgs.map(idade))).toISOString().slice(0, 19).replace("T", " ");
    const pessoa = await buscarPessoa(c, tel);
    const respondida = pessoa ? await c.db.prepare("SELECT 1 ok FROM mensagens WHERE empresa_id=? AND pessoa_id=? AND UPPER(direcao)='SAIDA' AND criado_em >= ? LIMIT 1").bind(EMPRESA_ID, pessoa.id, desde).first().catch(() => null) : null;
    c.atrasadas = (c.atrasadas || 0) + 1;
    if (respondida || c.atrasadas > MAX_ATRASADAS_POR_EXECUCAO) {
      opts.apenasRegistrar = true;
      if (!respondida) c.atrasadasSemResposta = (c.atrasadasSemResposta || 0) + 1;
    }
  }
  // A pessoa escreveu: se estava fora da janela de 24 h, entrega primeiro o que ficou guardado para ela.
  if (!opts.apenasRegistrar) await liberarDestino(c, tel).catch(e => console.warn("guardadas", e?.message));
  const id = await identificar(c, tel);
  if (modoGuia(c.env)) return processarGuia(c, tel, id, msgs, opts); // guia de lojas (shopping): botões sem IA
  if (id.papel === "PRESTADOR") return processarPrestador(c, tel, id, msgs, opts);
  if (id.papel === "ATENDENTE") {
    for (const m of msgs) await registrarMensagem(c, { pessoaId: id.pessoa?.id, wamid: m.wamid, direcao: "ENTRADA", origem: "WHATSAPP", tipo: String(m.tipo || "text").toUpperCase(), conteudo: txt(m.texto, 4000) || `[${m.tipo}]` });
    return;
  }
  // Número desconhecido falando de um caso de OUTRA pessoa que está com profissional: provavelmente é o profissional
  // escrevendo de outro número. Não vira pedido novo nem é repassado a ninguém: a equipe confirma no painel.
  const suspeita = await casoDeOutroComProfissional(c, tel, msgs);
  if (suspeita) {
    const pessoa = id.pessoa || await obterPessoa(c, tel, msgs.map(m => m.nome).filter(Boolean).pop() || "", "CLIENTE");
    for (const m of msgs) await registrarMensagem(c, { pessoaId: pessoa?.id, casoId: suspeita.casoId, wamid: m.wamid, direcao: "ENTRADA", origem: "WHATSAPP", tipo: String(m.tipo || "text").toUpperCase(), conteudo: txt(m.texto, 4000) || `[${m.tipo}]` });
    await alertarEquipe(c, `O número ${tel} falou do caso #${suspeita.casoId} (que está com ${suspeita.prestador || "um profissional"}): "${txt(msgs.map(m => m.texto || "").join(" "), 200)}". Pode ser o profissional escrevendo de outro número. Nada foi enviado. Se for profissional, abra a conversa na plataforma e toque em "É profissional".`, "suspeita:" + opts.chaveLote, suspeita.casoId);
    return;
  }
  return processarCliente(c, tel, id, msgs, opts);
}
async function casoDeOutroComProfissional(c, tel, msgs) {
  const texto = msgs.map(m => m.conteudo || m.texto || "").join("\n");
  // "caso 123", "caso #123", "caso nº 123" ou "#123" (pelo menos 2 dígitos, para não confundir com "casa #2").
  const num = texto.match(/\bcaso\s*(?:n[º°o.]?\s*)?#?\s*(\d{1,9})\b/i) || texto.match(/(?:^|\s)#(\d{2,9})\b/);
  if (!num) return null;
  const caso = await carregarCasoPorId(c, Number(num[1]));
  if (!caso || variantesTel(caso.telefone).some(v => variantesTel(tel).includes(v))) return null;
  const k = await c.db.prepare("SELECT prestador_nome FROM d30_consultas WHERE caso_id=? ORDER BY id DESC LIMIT 1").bind(caso.casoId).first().catch(() => null);
  return k ? { casoId: caso.casoId, prestador: k.prestador_nome } : null;
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
    interativoId: String(m?.interactive?.list_reply?.id || m?.interactive?.button_reply?.id || m?.button?.payload || ""),
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
  if (!(await assinaturaValida(bytes, request, env))) {
    // Guarda para o diagnóstico: se o META_APP_SECRET não bate com o app da Meta, nenhuma mensagem é aceita.
    try { await env.DB.prepare("INSERT OR REPLACE INTO d30_meta(chave,valor) VALUES('assinatura_invalida',?)").bind(String(Date.now())).run(); } catch { /* sem banco */ }
    return new Response("assinatura inválida", { status: 401 });
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { return new Response("EVENT_RECEIVED", { status: 200 }); }
  const c = criarContexto(env);
  // Guarda o endereço público (a Meta chama aqui): o cron usa para ligar o Telegram da equipe.
  // (Nunca atrapalha o atendimento: com o banco fora do ar, simplesmente não grava.)
  if (Date.now() - ultimaBaseGuardada > 3600000) {
    ultimaBaseGuardada = Date.now();
    const base = enderecoPublico(request);
    ctx.waitUntil((async () => { await env.DB.prepare("INSERT OR REPLACE INTO d30_meta(chave,valor) VALUES('base_publica',?)").bind(base).run(); })().catch(() => { }));
  }
  const { mensagens, ecos } = extrairEventos(payload, env);
  const statuses = extrairStatuses(payload, env);
  if (!mensagens.length && !ecos.length && !statuses.length) return new Response("EVENT_RECEIVED", { status: 200 });
  try { await garantirSchema(c); }
  catch (e) {
    console.error("D1 indisponível:", e?.message);
    for (const m of mensagens) ctx.waitUntil(contingencia(c, m, e?.message).catch(x => console.error("contingência", x)));
    for (const e2 of ecos) ctx.waitUntil(pausaKV(env, e2.para));
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
  for (const st of statuses) ctx.waitUntil(processarStatus(c, st).catch(x => console.error("status", x)));
  // Avisos de entrega chegam o tempo todo e gastam pouco: aproveita para mandar o que estiver na fila.
  if (!mensagens.length && statuses.length) ctx.waitUntil(enviarFila(criarContexto(env), 4).catch(x => console.error("fila", x)));
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
  // 1º: o que ficou na fila de envio (respostas que não couberam na execução anterior).
  await enviarFila(c).catch(e => console.error("fila de envio", e));
  const agora = c.agora();
  await c.db.prepare("UPDATE d30_fila SET status='PENDENTE', atualizado_ms=? WHERE status='PROCESSANDO' AND atualizado_ms < ? AND recebido_ms > ?")
    .bind(agora, agora - 180000, agora - atrasoMaximo(c.env)).run();
  const tels = (await c.db.prepare("SELECT DISTINCT telefone FROM d30_fila WHERE status='PENDENTE' AND recebido_ms < ? LIMIT 10").bind(agora - 40000).all())?.results || [];
  // Cada etapa só começa se ainda houver chamadas sobrando nesta execução; o resto fica para o próximo minuto.
  for (const t of tels) { if (sobram(c) < 25) break; await processarPendentes(c, t.telefone); }
  if (c.atrasadasSemResposta) await alertarEquipe(c, `${c.atrasadasSemResposta} conversa(s) ficaram sem resposta por mais tempo e a DENIA NÃO respondeu sozinha para não mandar mensagens em massa. Veja em Conversas e responda quem ainda precisa.`, "atrasadas:" + Math.floor(agora / 3600000));
  if (sobram(c) > 20) await processarAgendados(c);
  if (sobram(c) > 20) await cobrarProfissionais(c).catch(e => console.error("profissionais sem resposta", e?.message));
  if (sobram(c) > 12) await lembrarReunioes(c).catch(e => console.error("reuniões", e?.message));
  // Uma vez por dia: liga o Telegram da equipe à DENIA (se ainda não estiver ligado a outro sistema).
  if (sobram(c) > 15 && c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID && String(c.env.TELEGRAM_EQUIPE || "").toLowerCase() !== "desligado" && await reservarChave(c, "tg-conectar:" + dataSP(agora))) {
    const base = (await c.db.prepare("SELECT valor FROM d30_meta WHERE chave='base_publica'").first().catch(() => null))?.valor;
    if (base) { const r = await conectarTelegramEquipe(c, base).catch(e => ({ ok: false, erro: e?.message })); await c.db.prepare("INSERT OR REPLACE INTO d30_meta(chave,valor) VALUES('telegram_equipe',?)").bind(JSON.stringify({ ...r, em: agora })).run().catch(() => { }); }
  }
  if (sobram(c) > 20) await processarSync(c).catch(e => console.error("sync", e));
  if (sobram(c) > 25) await processarAprendizado(c).catch(e => console.error("aprendizado", e));
  if (sobram(c) > 25) await relatorioDiario(c).catch(e => console.error("relatório", e));
  if (sobram(c) > 25) await revisarCasosParados(c).catch(e => console.error("revisão de casos", e));
  if (sobram(c) > 10) await vigiarEntregas(c).catch(e => console.error("entregas", e));
  if (sobram(c) > 30) await prepararMemorias(c, 1).catch(e => console.error("memórias", e));
  if (sobram(c) > 30) await estudoDiario(c).catch(e => console.error("estudo", e?.message));
  const dia = dataSP(agora);
  if (await reservarChave(c, "limpeza:" + dia)) {
    await c.db.prepare("DELETE FROM d30_fila WHERE recebido_ms < ?").bind(agora - 7 * 86400000).run();
    await c.db.prepare("DELETE FROM d30_saidas WHERE criado_ms < ?").bind(agora - 2 * 86400000).run();
    await c.db.prepare("DELETE FROM d30_tg_msgs WHERE criado_ms < ?").bind(agora - 30 * 86400000).run().catch(() => { });
    await c.db.prepare("DELETE FROM d30_guardadas WHERE criado_ms < ?").bind(agora - 14 * 86400000).run().catch(() => { });
    // Telefones da equipe e técnicos do D1, para a contingência nunca respondê-los.
    if (c.env.MEMORIA) {
      const eq = (await c.db.prepare(`SELECT DISTINCT p.telefone FROM pessoas p WHERE p.empresa_id=? AND (UPPER(COALESCE(p.tipo,'')) IN ('ATENDENTE','TECNICO')
        OR p.id IN (SELECT pessoa_id FROM atendentes WHERE COALESCE(ativo,1)=1) OR p.id IN (SELECT pessoa_id FROM tecnicos WHERE COALESCE(ativo,1)=1))`).bind(EMPRESA_ID).all().catch(() => ({ results: [] })))?.results || [];
      await kvPut(c.env, "d30:equipe", JSON.stringify(eq.map(x => digitos(x.telefone)).filter(Boolean)), 60 * 60 * 24 * 30);
    }
    await c.db.prepare("DELETE FROM d30_envios WHERE criado_ms < ? AND chave NOT LIKE 'limpeza:%' AND chave NOT LIKE 'relatorio:%'").bind(agora - 45 * 86400000).run();
  }
}

// ============================================================================
// REVISÃO DA ETAPA PELA IA — a DENIA lê tudo o que aconteceu no caso (cliente, profissional, equipe pelo
// WhatsApp, resumos de ligação, eventos) e descobre em que pé ele está: agendado, em andamento, concluído...
// Com confiança ALTA, move o caso sozinha; senão, só sugere.
// ============================================================================
const ETAPAS_REVISAO = ["COLETANDO", "AGUARDANDO_PRESTADOR", "AGUARDANDO_CLIENTE", "AGUARDANDO_ENDERECO", "AGUARDANDO_CONFIRMACAO_PRESTADOR", "EQUIPE", "AGENDADO", "EM_ANDAMENTO", "CONCLUIDO", "CANCELADO"];
const INSTRUCOES_REVISAO_ETAPA = `Você cuida do acompanhamento dos atendimentos da Central. Leia TODO o histórico de UM caso (mensagens do cliente, do profissional, da equipe e resumos de ligações) e diga em que etapa o caso REALMENTE está agora.
Etapas: COLETANDO (ainda entendendo o pedido), AGUARDANDO_PRESTADOR (esperando o profissional responder valor/disponibilidade), AGUARDANDO_CLIENTE (proposta enviada, esperando o cliente), AGUARDANDO_ENDERECO, AGUARDANDO_CONFIRMACAO_PRESTADOR, EQUIPE (a equipe interna assumiu e não dá para saber mais), AGENDADO (dia/horário combinado e confirmado), EM_ANDAMENTO (o profissional já foi ao local, está com o equipamento ou o serviço está sendo feito), CONCLUIDO (serviço feito/entregue, cliente recebeu, pagou ou agradeceu pelo serviço feito), CANCELADO (cliente desistiu, não quis, ou o serviço não vai acontecer).
Regras: decida pelos FATOS do histórico, inclusive o que a equipe combinou por fora (mensagens da equipe e resumos de ligação valem). Data de agendamento que já passou NÃO significa concluído sem sinal de que o serviço foi feito. confianca ALTA só quando há uma frase clara que comprove (ex.: "o técnico já veio e resolveu", "ficou pronto", "pode vir amanhã às 9h, confirmado", "não quero mais"). Na dúvida, MEDIA ou BAIXA.
Responda em JSON: {"etapa":"","confianca":"ALTA|MEDIA|BAIXA","data_servico":"dia/horário combinado, se houver","motivo":"1 frase citando a evidência","proximo_passo":"o que falta para o caso andar, em 1 frase"}`;

async function revisarEtapaCaso(c, caso, { aplicar = false, autor = "IA" } = {}) {
  const msgs = (await c.db.prepare(`SELECT m.direcao, m.origem, m.conteudo, m.criado_em, p.tipo, p.nome FROM mensagens m LEFT JOIN pessoas p ON p.id=m.pessoa_id
    WHERE m.caso_id=? ORDER BY m.id DESC LIMIT 80`).bind(caso.casoId).all().catch(() => null))?.results || [];
  const eventos = (await c.db.prepare("SELECT tipo, descricao, criado_ms FROM d30_eventos WHERE caso_id=? ORDER BY id DESC LIMIT 25").bind(caso.casoId).all().catch(() => null))?.results || [];
  const consulta = await consultaDoCaso(c, caso.casoId).catch(() => null);
  const quem = m => String(m.origem).toUpperCase() === "LIGACAO" ? "RESUMO DE LIGAÇÃO (equipe)" : String(m.direcao).toUpperCase() === "ENTRADA" ? (String(m.tipo || "").toUpperCase() === "TECNICO" ? "PROFISSIONAL" : "CLIENTE") : String(m.origem).toUpperCase() === "HUMANO" ? "EQUIPE" : "DENIA";
  const entrada = `CASO #${caso.casoId} — etapa registrada: ${caso.etapa}
FATOS:
${formatarFatos(caso.fatos)}
Resumo: ${caso.resumo || "-"}
${consulta ? `Consulta ao profissional ${consulta.prestador_nome || ""}: status ${consulta.status}${consulta.disponibilidade ? ", disponibilidade " + consulta.disponibilidade : ""}${consulta.valor_cliente ? ", valor " + moeda(consulta.valor_cliente) : ""}` : "Nenhum profissional consultado pelo sistema."}
DATA E HORA ATUAL: ${dataHoraSP(c.agora())}

EVENTOS (mais recente primeiro):
${eventos.map(e => `- ${new Date(e.criado_ms).toISOString().slice(0, 16)} ${e.tipo}: ${txt(e.descricao, 200)}`).join("\n") || "(nenhum)"}

HISTÓRICO (mais antigo primeiro):
${[...msgs].reverse().map(m => `[${String(m.criado_em || "").slice(0, 16)}] ${quem(m)}: ${txt(ocultarTelefones(m.conteudo), 500)}`).join("\n") || "(sem mensagens)"}

Responda em JSON.`;
  const d = await openaiJSON(c, INSTRUCOES_REVISAO_ETAPA, entrada, [], 500);
  const etapa = ETAPAS_REVISAO.includes(String(d?.etapa).toUpperCase()) ? String(d.etapa).toUpperCase() : caso.etapa;
  const r = { etapa_atual: caso.etapa, etapa_sugerida: etapa, confianca: ["ALTA", "MEDIA", "BAIXA"].includes(String(d?.confianca).toUpperCase()) ? String(d.confianca).toUpperCase() : "BAIXA",
    data_servico: txt(d?.data_servico, 120), motivo: txt(d?.motivo, 300), proximo_passo: txt(d?.proximo_passo, 300), aplicada: false };
  // Só avança com confiança ALTA e nunca reabre um caso encerrado.
  if (aplicar && r.confianca === "ALTA" && etapa !== caso.etapa && !ETAPAS_ENCERRADAS.has(caso.etapa)) {
    if (r.data_servico && ["AGENDADO", "EM_ANDAMENTO"].includes(etapa)) caso.fatos = { ...(caso.fatos || {}), preferencia_horario: caso.fatos?.preferencia_horario || r.data_servico };
    await mudarEtapa(c, caso, etapa);
    r.aplicada = true;
    // Agendado pela equipe: a consulta ao profissional também fica confirmada (a DENIA não pergunta mais "consegue pegar?").
    if (["AGENDADO", "EM_ANDAMENTO", "CONCLUIDO"].includes(etapa) && consulta && !["CONFIRMADA", "RECUSADA", "ENCERRADA"].includes(consulta.status)) await atualizarConsulta(c, consulta.id, { status: "CONFIRMADA", disponibilidade: r.data_servico || consulta.disponibilidade });
  }
  await evento(c, caso.casoId, "REVISAO_IA", `${caso.etapa === etapa || !r.aplicada ? "sugeriu" : "moveu para"} ${etapa} (${r.confianca}) — ${r.motivo} — por ${autor}`, r);
  return r;
}
// Cron: casos parados há mais de 6 h (e não revisados nas últimas 12 h) são revisados pela IA, 3 por vez.
async function revisarCasosParados(c) {
  if (!c.env.OPENAI_API_KEY) return;
  const agora = c.agora();
  if (!(await reservarChave(c, "revisao-casos:" + Math.floor(agora / 1800000)))) return; // no máximo a cada 30 min
  const casos = (await c.db.prepare(`SELECT * FROM d30_casos k WHERE etapa NOT IN ('CONCLUIDO','CANCELADO') AND atualizado_ms < ? AND atualizado_ms > ?
    AND NOT EXISTS (SELECT 1 FROM d30_eventos e WHERE e.caso_id=k.caso_id AND e.tipo='REVISAO_IA' AND e.criado_ms > ?) ORDER BY atualizado_ms LIMIT 3`)
    .bind(agora - 6 * 3600000, agora - 60 * 86400000, agora - 12 * 3600000).all().catch(() => null))?.results || [];
  for (const row of casos) {
    try { await revisarEtapaCaso(c, linhaParaCaso(row), { aplicar: true, autor: "revisão automática" }); }
    catch (e) { console.error("revisão de caso", row.caso_id, e?.message); }
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
    // A equipe já cuidou do caso depois que a mensagem foi programada: não manda.
    const desde = new Date(Number(a.criado_ms)).toISOString().slice(0, 19).replace("T", " ");
    const equipe = await c.db.prepare("SELECT 1 ok FROM mensagens WHERE empresa_id=? AND caso_id=? AND UPPER(origem)='HUMANO' AND criado_em >= ? LIMIT 1").bind(EMPRESA_ID, a.caso_id, desde).first().catch(() => null);
    if (equipe) { await c.db.prepare("UPDATE d30_agendados SET status='CANCELADO' WHERE id=?").bind(a.id).run(); continue; }
    const r = await enviarAgoraAoPrestador(c, { consulta, caso, texto: a.texto, chave: "agendado:" + a.id, inicial: a.inicial === 1 });
    await c.db.prepare("UPDATE d30_agendados SET status=? WHERE id=?").bind(r.ok ? "ENVIADO" : "FALHA", a.id).run();
    if (r.ok && a.inicial === 1) {
      await atualizarConsulta(c, consulta.id, { status: "ENVIADA", message_id: r.id });
      if (!r.viaTemplate) await encaminharMidiasAoPrestador(c, { ...consulta, message_id: r.id });
    }
    if (!r.ok && !r.guardada) await alertarEquipe(c, `Falha no envio programado ao prestador (caso #${a.caso_id}): ${r.erro}`, "falha-ag:" + a.id, a.caso_id);
  }
}

// Profissional que não respondeu a consulta: a DENIA lembra uma vez (como uma pessoa da equipe faria) e,
// se continuar sem resposta, passa o pedido ao próximo profissional da mesma área. O cliente nunca fica esperando à toa.
function minutosEnv(env, nome, padrao) { const v = Number(env[nome]); return (Number.isFinite(v) && v > 0 ? v : padrao) * 60000; }
async function cobrarProfissionais(c) {
  if (!dentroHorarioPrestador(c)) return;
  const agora = c.agora(), cobrarMs = minutosEnv(c.env, "PROFISSIONAL_COBRAR_MIN", 40), trocarMs = minutosEnv(c.env, "PROFISSIONAL_TROCAR_MIN", 60);
  const paradas = (await c.db.prepare("SELECT * FROM d30_consultas WHERE status='ENVIADA' AND atualizado_ms < ? AND atualizado_ms > ? ORDER BY atualizado_ms LIMIT 5")
    .bind(agora - cobrarMs, agora - 3 * 86400000).all())?.results || [];
  for (const k of paradas) {
    if (sobram(c) < 20) return;
    const caso = await carregarCasoPorId(c, k.caso_id);
    if (!caso || caso.etapa !== "AGUARDANDO_PRESTADOR" || await estaPausado(c, k.prestador_tel) || await estaPausado(c, caso.telefone)) continue;
    // Ele já falou sobre este atendimento (pergunta, comentário) ou a equipe assumiu: não cobra nem troca.
    const prest = await buscarPessoa(c, k.prestador_tel);
    const falou = prest ? await c.db.prepare("SELECT 1 ok FROM mensagens WHERE empresa_id=? AND pessoa_id=? AND caso_id=? AND UPPER(direcao)='ENTRADA' LIMIT 1").bind(EMPRESA_ID, prest.id, k.caso_id).first().catch(() => null) : null;
    const equipe = await c.db.prepare("SELECT 1 ok FROM mensagens WHERE empresa_id=? AND caso_id=? AND UPPER(origem)='HUMANO' LIMIT 1").bind(EMPRESA_ID, k.caso_id).first().catch(() => null);
    if (falou || equipe) continue;
    const cobrado = await c.db.prepare("SELECT 1 ok FROM d30_envios WHERE chave=?").bind("cobrar:" + k.id).first().catch(() => null);
    if (!cobrado) {
      if (!(await reservarChave(c, "cobrar:" + k.id))) continue;
      const r = await enviarAgoraAoPrestador(c, { consulta: k, caso, texto: `${primeiroNome(k.prestador_nome) || "Oi"}, conseguiu ver o pedido de ${pessoaRef(await refCaso(c, k.caso_id))}? Se não puder pegar, sem problema, é só me avisar.`, chave: "cobrar-msg:" + k.id });
      await atualizarConsulta(c, k.id, { status: "ENVIADA" }); // marca a hora do lembrete
      await evento(c, k.caso_id, r.ok ? "PROFISSIONAL_LEMBRADO" : "FALHA_LEMBRETE_PROFISSIONAL", k.prestador_nome);
      continue;
    }
    if (agora - Number(k.atualizado_ms || 0) < trocarMs) continue;
    // Sem resposta depois do lembrete: passa ao próximo profissional da área (se não houver, a equipe é avisada).
    await atualizarConsulta(c, k.id, { status: "EXPIRADA" });
    await evento(c, k.caso_id, "PROFISSIONAL_SEM_RESPOSTA", k.prestador_nome);
    const pessoa = await c.db.prepare("SELECT * FROM pessoas WHERE id=?").bind(caso.clienteId).first().catch(() => null) || { id: caso.clienteId, telefone: caso.telefone };
    caso.etapa = "COLETANDO";
    await salvarCaso(c, caso);
    await consultarPrestador(c, caso, pessoa, "troca:" + k.id);
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
  // Relatório não é urgente: vai por e-mail (se configurado) e fica no painel; no Telegram só com TELEGRAM_AVISOS=todos.
  await evento(c, null, "RELATORIO_DIARIO", texto);
  if (String(c.env.TELEGRAM_AVISOS || "").toLowerCase() === "todos") await c.saida.telegram(texto);
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
// ============================================================================
// MODO GUIA (variável MODO=guia) — guia de lojas pelo WhatsApp, para shoppings e centros comerciais.
// Botões e listas do WhatsApp respondem SEM usar a IA (custo zero de GPT). Só quando a pessoa ESCREVE
// uma pergunta a DENIA usa a IA (modelo econômico) para achar as lojas certas. Cada busca é avisada no
// Telegram (nome, número e o que buscou) e entra nas métricas do painel.
// ============================================================================
function modoGuia(env) { return String(env?.MODO || "").trim().toLowerCase() === "guia"; }
const GUIA_PADRAO = {
  nome: "nosso shopping",
  boas_vindas: "Olá! 👋 Seja bem-vindo(a)! Eu te ajudo a achar a loja certa. O que você procura?",
  encerramento: "Foi um prazer ajudar! Quando precisar, é só mandar um oi. 😊",
  humano: "Certo! Vou chamar alguém da equipe para falar com você. Só um instante.",
  rede_nome: "", rede_url: "", rodape_lojas: "É só chamar a loja no WhatsApp e falar que veio pelo nosso guia. 😉",
  modelo_ia: ""
};
let cacheGuia = { em: 0, valor: null };
async function configGuia(c) {
  if (cacheGuia.valor && c.agora() - cacheGuia.em < 60000) return cacheGuia.valor;
  let v = {};
  try { v = JSON.parse((await c.db.prepare("SELECT valor FROM d30_meta WHERE chave='guia_config'").first())?.valor || "{}") || {}; } catch { v = {}; }
  cacheGuia = { em: c.agora(), valor: { ...GUIA_PADRAO, ...v } };
  return cacheGuia.valor;
}
async function categoriasGuia(c, tipo) {
  return (await c.db.prepare(`SELECT g.id, g.tipo, g.nome, g.palavras, (SELECT COUNT(*) FROM d30_guia_loja_cat lc JOIN d30_guia_lojas l ON l.id=lc.loja_id AND l.ativo=1 WHERE lc.categoria_id=g.id) lojas
    FROM d30_guia_categorias g WHERE g.ativo=1 ${tipo ? "AND g.tipo=?" : ""} ORDER BY g.ordem, g.nome`).bind(...(tipo ? [tipo] : [])).all())?.results || [];
}
async function lojasDaCategoria(c, catId) {
  return (await c.db.prepare(`SELECT l.* FROM d30_guia_lojas l JOIN d30_guia_loja_cat lc ON lc.loja_id=l.id WHERE lc.categoria_id=? AND l.ativo=1 ORDER BY l.destaque DESC, l.nome LIMIT 25`).bind(catId).all())?.results || [];
}
const cortar = (t, n) => { t = String(t || "").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
function linkZap(tel) { const d = digitos(tel); return d.length >= 10 ? `wa.me/${d.length <= 11 ? "55" + d : d}` : ""; }

async function enviarGuia(c, tel, pessoaId, interativo, texto, origem = "SISTEMA") {
  const corpo = interativo ? { messaging_product: "whatsapp", recipient_type: "individual", to: digitos(tel), type: "interactive", interactive: interativo } : corpoTexto(tel, texto);
  const r = c.sim ? { ok: true, id: "sim." + crypto.randomUUID() } : await c.saida.bruto(tel, corpo);
  if (c.sim) c.registro.push({ canal: "whatsapp", para: tel, texto, interativo });
  if (r.ok) await registrarMensagem(c, { pessoaId, wamid: r.id, direcao: "SAIDA", origem, conteudo: texto });
  return r;
}
async function guiaMenuInicial(c, tel, pessoaId, cfg, prefixo = "") {
  const botoes = [{ type: "reply", reply: { id: "g:prod", title: "🛍️ Produtos" } }, { type: "reply", reply: { id: "g:serv", title: "🔧 Serviços" } }, { type: "reply", reply: { id: "g:humano", title: "💬 Falar com alguém" } }];
  const corpo = (prefixo ? prefixo + "\n\n" : "") + cfg.boas_vindas;
  return enviarGuia(c, tel, pessoaId, { type: "button", body: { text: cortar(corpo, 1024) }, action: { buttons: botoes } }, corpo + " [Produtos] [Serviços] [Falar com alguém]");
}
async function guiaListaCategorias(c, tel, pessoaId, tipo, pagina = 0) {
  const cats = (await categoriasGuia(c, tipo)).filter(x => x.lojas > 0);
  if (!cats.length) return enviarGuia(c, tel, pessoaId, null, `Ainda não temos ${tipo === "PRODUTO" ? "produtos" : "serviços"} cadastrados no guia. Quer falar com alguém da equipe? Responda "atendente".`);
  const porPagina = 9, inicio = pagina * porPagina, parte = cats.slice(inicio, inicio + porPagina);
  const rows = parte.map(x => ({ id: "g:cat:" + x.id, title: cortar(x.nome, 24), description: cortar(`${x.lojas} loja${x.lojas === 1 ? "" : "s"}`, 72) }));
  if (inicio + porPagina < cats.length) rows.push({ id: `g:pg:${tipo}:${pagina + 1}`, title: "➡️ Mais opções", description: `Ver mais ${tipo === "PRODUTO" ? "produtos" : "serviços"}` });
  else if (pagina > 0) rows.push({ id: "g:inicio", title: "🏠 Menu inicial", description: "Voltar ao começo" });
  const titulo = tipo === "PRODUTO" ? "Qual produto você procura?" : "Qual serviço você precisa?";
  return enviarGuia(c, tel, pessoaId, { type: "list", body: { text: titulo + " Toque no botão abaixo e escolha." }, action: { button: "Ver opções", sections: [{ title: tipo === "PRODUTO" ? "Produtos" : "Serviços", rows }] } }, `${titulo} [lista: ${parte.map(x => x.nome).join(", ")}]`);
}
async function guiaMostrarLojas(c, tel, pessoa, cat, via, texto, cfg) {
  const lojas = await lojasDaCategoria(c, cat.id);
  const linhas = lojas.map(l => `• *${l.nome}*${l.local ? ` — ${l.local}` : ""}${l.descricao ? `\n  ${cortar(l.descricao, 120)}` : ""}${linkZap(l.whatsapp || l.telefone) ? `\n  📲 ${linkZap(l.whatsapp || l.telefone)}` : l.telefone ? `\n  📞 ${l.telefone}` : ""}`);
  const msg = lojas.length ? `${cat.tipo === "PRODUTO" ? "🛍️" : "🔧"} *${cat.nome}* — ${lojas.length === 1 ? "esta loja tem" : "estas lojas têm"}:\n\n${linhas.join("\n\n")}${cfg.rodape_lojas ? "\n\n" + cfg.rodape_lojas : ""}` : `No momento não tenho lojas cadastradas para *${cat.nome}*.`;
  await enviarGuia(c, tel, pessoa.id, null, cortar(msg, 4000), via === "IA" ? "IA" : "SISTEMA");
  const botoes = [{ type: "reply", reply: { id: "g:inicio", title: "🏠 Menu inicial" } }, { type: "reply", reply: { id: cat.tipo === "PRODUTO" ? "g:prod" : "g:serv", title: "⬅️ Voltar" } }, { type: "reply", reply: { id: "g:fim", title: "✅ Finalizar" } }];
  await enviarGuia(c, tel, pessoa.id, { type: "button", body: { text: "Posso te ajudar com mais alguma coisa?" }, action: { buttons: botoes } }, "Posso te ajudar com mais alguma coisa? [Menu inicial] [Voltar] [Finalizar]");
  await c.db.prepare("INSERT INTO d30_guia_buscas(telefone,nome,tipo,categoria_id,categoria,texto,via,lojas,criado_ms) VALUES(?,?,?,?,?,?,?,?,?)").bind(digitos(tel), pessoa.nome || "", cat.tipo, cat.id, cat.nome, txt(texto, 300), via, lojas.length, c.agora()).run().catch(() => {});
  if (await reservarChave(c, `busca:${digitos(tel)}:${cat.id}:${Math.floor(c.agora() / 3600000)}`))
    await c.saida.telegram(`🔎 ${cfg.nome} — nova busca\nCliente: ${pessoa.nome || "sem nome"} (${digitos(tel)})\nBuscou: ${cat.tipo === "PRODUTO" ? "Produtos" : "Serviços"} › ${cat.nome}${via === "IA" ? ` (escreveu: "${txt(texto, 120)}")` : via === "PALAVRA" ? ` (escreveu: "${txt(texto, 120)}")` : ""}\nLojas indicadas: ${lojas.map(l => l.nome).join(", ") || "nenhuma"}`).catch(() => {});
}
// Busca por palavra (sem IA): nome da categoria, palavras-chave e o que cada loja vende.
function pontuarCategoria(cat, alvo) {
  let p = 0;
  for (const w of new Set(norm([cat.nome, cat.palavras].join(" ")).split(/[^a-z0-9]+/).filter(x => x.length >= 3))) {
    const raiz = w.length > 5 ? w.slice(0, w.length - 1) : w; // "celulares" ~ "celular"
    if (alvo.includes(raiz)) p += w.length >= 5 ? 2 : 1;
  }
  return p;
}
const INSTRUCOES_GUIA = `Você é a atendente virtual do guia de lojas de um shopping, no WhatsApp. A pessoa escreveu uma pergunta. Escolha nas CATEGORIAS (use só os ids da lista) as que respondem ao que ela procura (no máximo 2). Se ela quer falar com uma pessoa, reclamar ou algo fora do guia (horário, estacionamento, vaga de emprego), deixe categorias vazio e escreva uma resposta curta e simpática (1 frase). Nunca invente loja, preço ou telefone. Responda em JSON {"categorias":[id],"resposta":"","humano":false}`;

async function processarGuia(c, tel, id, msgs, { apenasRegistrar, chaveLote }) {
  const pessoa = id.pessoa || await obterPessoa(c, tel, msgs.map(m => m.nome).filter(Boolean).pop() || "", "CLIENTE");
  for (const m of msgs) await registrarMensagem(c, { pessoaId: pessoa?.id, wamid: m.wamid, direcao: "ENTRADA", origem: "WHATSAPP", tipo: String(m.tipo || "text").toUpperCase(), conteudo: txt(m.texto, 4000) || `[${m.tipo}]` });
  if (id.papel === "ATENDENTE" || apenasRegistrar || await estaPausado(c, tel)) return;
  const cfg = await configGuia(c);
  const ultima = msgs[msgs.length - 1];
  const acao = String(ultima.interativoId || "");
  const texto = msgs.map(m => m.texto || "").join(" ").trim();
  if (acao === "g:prod") return guiaListaCategorias(c, tel, pessoa.id, "PRODUTO");
  if (acao === "g:serv") return guiaListaCategorias(c, tel, pessoa.id, "SERVICO");
  if (acao.startsWith("g:pg:")) { const [, , tipo, pg] = acao.split(":"); return guiaListaCategorias(c, tel, pessoa.id, tipo === "SERVICO" ? "SERVICO" : "PRODUTO", Number(pg) || 0); }
  if (acao.startsWith("g:cat:")) {
    const cat = await c.db.prepare("SELECT * FROM d30_guia_categorias WHERE id=?").bind(Number(acao.slice(6))).first();
    return cat ? guiaMostrarLojas(c, tel, pessoa, cat, "BOTAO", cat.nome, cfg) : guiaMenuInicial(c, tel, pessoa.id, cfg);
  }
  if (acao === "g:fim") return enviarGuia(c, tel, pessoa.id, null, cfg.encerramento + (cfg.rede_url ? `\n\nSiga a gente${cfg.rede_nome ? " no " + cfg.rede_nome : ""}: ${cfg.rede_url}` : ""));
  const querHumano = acao === "g:humano" || /\b(atendente|humano|falar com (uma )?(pessoa|algu[eé]m)|reclama[rcç])/i.test(norm(texto));
  if (querHumano) {
    await enviarGuia(c, tel, pessoa.id, null, cfg.humano);
    await pausar(c, tel, PAUSA_TAKEOVER_MS, "GUIA_HUMANO");
    await alertarEquipe(c, `💬 ${pessoa.nome || "Um cliente"} (${digitos(tel)}) quer falar com alguém da equipe no WhatsApp do ${cfg.nome}. A DENIA ficou em pausa nessa conversa.`, "guia-humano:" + chaveLote);
    return;
  }
  if (acao === "g:inicio" || !texto || ehMensagemSocial(texto) || /^(oi|ol[aá]|bom dia|boa tarde|boa noite|menu|in[ií]cio|come[cç]ar|voltar)\b/i.test(norm(texto)) && texto.length < 30) return guiaMenuInicial(c, tel, pessoa.id, cfg);
  // Pergunta escrita: primeiro por palavra (grátis); só se ficar em dúvida usa a IA.
  const cats = await categoriasGuia(c);
  const alvo = norm(texto);
  const pontos = cats.map(x => ({ cat: x, p: pontuarCategoria(x, alvo) })).filter(x => x.p > 0 && x.cat.lojas > 0).sort((a, b) => b.p - a.p);
  if (pontos.length && (pontos.length === 1 || pontos[0].p >= pontos[1].p + 2)) return guiaMostrarLojas(c, tel, pessoa, pontos[0].cat, "PALAVRA", texto, cfg);
  if (!c.env.OPENAI_API_KEY || !cats.length) return guiaMenuInicial(c, tel, pessoa.id, cfg, "Não encontrei exatamente o que você escreveu, mas te mostro as opções:");
  let o = null;
  try {
    const lista = cats.filter(x => x.lojas > 0).map(x => `${x.id}|${x.tipo === "PRODUTO" ? "produto" : "serviço"}|${x.nome}${x.palavras ? " (" + cortar(x.palavras, 80) + ")" : ""}`).join("\n");
    o = await openaiJSON(c, INSTRUCOES_GUIA, `CATEGORIAS (id|tipo|nome):\n${lista}\n\nA PESSOA ESCREVEU: "${txt(texto, 500)}"\nResponda em JSON.`, [], 200, cfg.modelo_ia);
  } catch (e) { console.warn("guia IA", e?.message); }
  const escolhidas = (Array.isArray(o?.categorias) ? o.categorias : []).map(Number).map(x => cats.find(k => k.id === x)).filter(Boolean).slice(0, 2);
  if (o?.humano === true) {
    await enviarGuia(c, tel, pessoa.id, null, txt(o.resposta, 300) || cfg.humano, "IA");
    await alertarEquipe(c, `💬 ${pessoa.nome || "Um cliente"} (${digitos(tel)}) escreveu no ${cfg.nome}: "${txt(texto, 200)}". Precisa de alguém da equipe.`, "guia-ia-humano:" + chaveLote);
    return;
  }
  if (!escolhidas.length) return guiaMenuInicial(c, tel, pessoa.id, cfg, txt(o?.resposta, 300) || "Não encontrei isso no guia, mas te mostro as opções:");
  for (const cat of escolhidas) await guiaMostrarLojas(c, tel, pessoa, cat, "IA", texto, cfg);
}

// ----- Rotas do painel (guia)
async function rotasGuia(c, caminho, metodo, corpo, url) {
  if (!caminho.startsWith("/platform/guide")) return null;
  if (caminho === "/platform/guide" && metodo === "GET") {
    const cats = await categoriasGuia(c);
    const inativas = (await c.db.prepare("SELECT id, tipo, nome, palavras, 0 lojas FROM d30_guia_categorias WHERE ativo=0 ORDER BY nome").all())?.results || [];
    const lojas = (await c.db.prepare("SELECT * FROM d30_guia_lojas ORDER BY nome").all())?.results || [];
    const lc = (await c.db.prepare("SELECT loja_id, categoria_id FROM d30_guia_loja_cat").all())?.results || [];
    const porLoja = new Map(); for (const x of lc) { if (!porLoja.has(x.loja_id)) porLoja.set(x.loja_id, []); porLoja.get(x.loja_id).push(x.categoria_id); }
    return json({ sucesso: true, modo: modoGuia(c.env) ? "guia" : "central", config: await configGuia(c), categorias: [...cats, ...inativas.map(x => ({ ...x, inativa: true }))], lojas: lojas.map(l => ({ ...l, categorias: porLoja.get(l.id) || [] })) });
  }
  if (caminho === "/platform/guide/config" && metodo === "POST") {
    const atual = await configGuia(c), novo = { ...atual };
    for (const k of Object.keys(GUIA_PADRAO)) if (typeof corpo?.[k] === "string") novo[k] = corpo[k].slice(0, k === "boas_vindas" || k === "encerramento" ? 900 : 300);
    await c.db.prepare("INSERT OR REPLACE INTO d30_meta(chave,valor) VALUES('guia_config',?)").bind(JSON.stringify(novo)).run();
    cacheGuia = { em: 0, valor: null };
    return json({ sucesso: true, config: novo });
  }
  let m;
  if (caminho === "/platform/guide/categories" && metodo === "POST") {
    const tipo = corpo?.tipo === "SERVICO" ? "SERVICO" : "PRODUTO", nome = txt(corpo?.nome, 60);
    if (!nome) return json({ sucesso: false, erro: "Dê um nome à categoria." }, 400);
    if (corpo?.id) await c.db.prepare("UPDATE d30_guia_categorias SET tipo=?, nome=?, palavras=?, ordem=?, ativo=? WHERE id=?").bind(tipo, nome, txt(corpo?.palavras, 400), Number(corpo?.ordem) || 0, corpo?.ativo === false ? 0 : 1, Number(corpo.id)).run();
    else await c.db.prepare("INSERT INTO d30_guia_categorias(tipo,nome,palavras,ordem,ativo) VALUES(?,?,?,?,1)").bind(tipo, nome, txt(corpo?.palavras, 400), Number(corpo?.ordem) || 0).run();
    return json({ sucesso: true });
  }
  if ((m = caminho.match(/^\/platform\/guide\/categories\/(\d+)\/delete$/)) && metodo === "POST") {
    await c.db.batch([c.db.prepare("DELETE FROM d30_guia_loja_cat WHERE categoria_id=?").bind(Number(m[1])), c.db.prepare("DELETE FROM d30_guia_categorias WHERE id=?").bind(Number(m[1]))]);
    return json({ sucesso: true });
  }
  if (caminho === "/platform/guide/stores" && metodo === "POST") {
    const nome = txt(corpo?.nome, 80);
    if (!nome) return json({ sucesso: false, erro: "Dê o nome da loja." }, 400);
    const campos = [nome, txt(corpo?.telefone, 30), txt(corpo?.whatsapp, 30), txt(corpo?.local, 80), txt(corpo?.descricao, 300), corpo?.destaque ? 1 : 0, corpo?.ativo === false ? 0 : 1];
    let lojaId = Number(corpo?.id) || 0;
    if (lojaId) await c.db.prepare("UPDATE d30_guia_lojas SET nome=?, telefone=?, whatsapp=?, local=?, descricao=?, destaque=?, ativo=? WHERE id=?").bind(...campos, lojaId).run();
    else lojaId = Number((await c.db.prepare("INSERT INTO d30_guia_lojas(nome,telefone,whatsapp,local,descricao,destaque,ativo) VALUES(?,?,?,?,?,?,?) RETURNING id").bind(...campos).first())?.id || 0);
    const cats = (Array.isArray(corpo?.categorias) ? corpo.categorias : []).map(Number).filter(Boolean).slice(0, 60);
    await c.db.batch([c.db.prepare("DELETE FROM d30_guia_loja_cat WHERE loja_id=?").bind(lojaId), ...cats.map(k => c.db.prepare("INSERT OR IGNORE INTO d30_guia_loja_cat(loja_id,categoria_id) VALUES(?,?)").bind(lojaId, k))]);
    return json({ sucesso: true, id: lojaId });
  }
  if ((m = caminho.match(/^\/platform\/guide\/stores\/(\d+)\/delete$/)) && metodo === "POST") {
    await c.db.batch([c.db.prepare("DELETE FROM d30_guia_loja_cat WHERE loja_id=?").bind(Number(m[1])), c.db.prepare("DELETE FROM d30_guia_lojas WHERE id=?").bind(Number(m[1]))]);
    return json({ sucesso: true });
  }
  // Importar planilha: loja; telefone; whatsapp; local; produtos (separados por vírgula); serviços; descrição.
  if (caminho === "/platform/guide/import" && metodo === "POST") {
    const linhas = (Array.isArray(corpo?.linhas) ? corpo.linhas : []).slice(0, 2000);
    const cats = new Map(((await c.db.prepare("SELECT id, tipo, nome FROM d30_guia_categorias").all())?.results || []).map(x => [x.tipo + "|" + norm(x.nome), x.id]));
    let lojas = 0, novas = 0;
    for (const l of linhas) {
      const nome = txt(l.loja || l.nome, 80);
      if (!nome) continue;
      const ids = [];
      for (const [tipo, campo] of [["PRODUTO", l.produtos], ["SERVICO", l.servicos]]) for (const n of String(campo || "").split(/[,;|]/).map(x => txt(x, 60)).filter(Boolean)) {
        const k = tipo + "|" + norm(n);
        if (!cats.has(k)) { const r = await c.db.prepare("INSERT INTO d30_guia_categorias(tipo,nome,palavras,ordem,ativo) VALUES(?,?,'',0,1) RETURNING id").bind(tipo, n).first(); cats.set(k, r.id); novas++; }
        ids.push(cats.get(k));
      }
      const existente = await c.db.prepare("SELECT id FROM d30_guia_lojas WHERE nome=?").bind(nome).first();
      let lojaId = existente?.id;
      if (lojaId) await c.db.prepare("UPDATE d30_guia_lojas SET telefone=COALESCE(NULLIF(?,''),telefone), whatsapp=COALESCE(NULLIF(?,''),whatsapp), local=COALESCE(NULLIF(?,''),local), descricao=COALESCE(NULLIF(?,''),descricao) WHERE id=?").bind(txt(l.telefone, 30), txt(l.whatsapp, 30), txt(l.local, 80), txt(l.descricao, 300), lojaId).run();
      else lojaId = (await c.db.prepare("INSERT INTO d30_guia_lojas(nome,telefone,whatsapp,local,descricao,destaque,ativo) VALUES(?,?,?,?,?,0,1) RETURNING id").bind(nome, txt(l.telefone, 30), txt(l.whatsapp, 30), txt(l.local, 80), txt(l.descricao, 300)).first())?.id;
      if (lojaId && ids.length) await c.db.batch(ids.map(k => c.db.prepare("INSERT OR IGNORE INTO d30_guia_loja_cat(loja_id,categoria_id) VALUES(?,?)").bind(lojaId, k)));
      lojas++;
    }
    return json({ sucesso: true, lojas, categorias_novas: novas });
  }
  if (caminho === "/platform/guide/stats" && metodo === "GET") {
    const de = url.searchParams.get("de"), ate = url.searchParams.get("ate");
    const ini = /^\d{4}-\d{2}-\d{2}$/.test(de || "") ? Date.parse(de + "T00:00:00Z") + 3 * 3600000 : c.agora() - 30 * 86400000;
    const fim = /^\d{4}-\d{2}-\d{2}$/.test(ate || "") ? Date.parse(ate + "T00:00:00Z") + 27 * 3600000 : c.agora() + 1;
    const q = (sql) => c.db.prepare(sql).bind(ini, fim).all().then(r => r?.results || []).catch(() => []);
    const [porDia, porCat, porVia, contatos, porHora] = await Promise.all([
      q("SELECT strftime('%Y-%m-%d', (criado_ms - 10800000)/1000, 'unixepoch') dia, COUNT(*) n FROM d30_guia_buscas WHERE criado_ms >= ? AND criado_ms < ? GROUP BY dia ORDER BY dia"),
      q("SELECT categoria, tipo, COUNT(*) n, SUM(CASE WHEN lojas=0 THEN 1 ELSE 0 END) sem_loja FROM d30_guia_buscas WHERE criado_ms >= ? AND criado_ms < ? GROUP BY categoria, tipo ORDER BY n DESC LIMIT 20"),
      q("SELECT via, COUNT(*) n FROM d30_guia_buscas WHERE criado_ms >= ? AND criado_ms < ? GROUP BY via"),
      q("SELECT COUNT(DISTINCT telefone) n FROM d30_guia_buscas WHERE criado_ms >= ? AND criado_ms < ?"),
      q("SELECT CAST(strftime('%w', (criado_ms - 10800000)/1000, 'unixepoch') AS INTEGER) d, CAST(strftime('%H', (criado_ms - 10800000)/1000, 'unixepoch') AS INTEGER) h, COUNT(*) n FROM d30_guia_buscas WHERE criado_ms >= ? AND criado_ms < ? GROUP BY d, h")
    ]);
    const horarios = Array.from({ length: 7 }, () => Array(24).fill(0)); for (const x of porHora) if (horarios[x.d]) horarios[x.d][x.h] = x.n;
    return json({ sucesso: true, por_dia: porDia, por_categoria: porCat, por_via: porVia, contatos: Number(contatos[0]?.n || 0), horarios, total: porDia.reduce((s, x) => s + x.n, 0) });
  }
  // Testar sem mandar nada pelo WhatsApp: mostra o que a DENIA responderia.
  if (caminho === "/platform/guide/test" && metodo === "POST") {
    const t = criarContexto(c.env, { simulacao: true });
    const tel = "0005500000000";
    await processarGuia(t, tel, await identificar(t, tel), [{ wamid: "sim." + crypto.randomUUID(), texto: txt(corpo?.texto, 500), tipo: "text", interativoId: String(corpo?.acao || ""), nome: "Teste" }], { chaveLote: "teste:" + Date.now() });
    await c.db.prepare("DELETE FROM d30_guia_buscas WHERE telefone=?").bind(digitos(tel)).run().catch(() => {});
    return json({ sucesso: true, respostas: t.registro.filter(r => r.canal === "whatsapp").map(r => ({ texto: r.texto, interativo: r.interativo || null })) });
  }
  return json({ sucesso: false, erro: "Rota do guia não encontrada." }, 404);
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
  // A plataforma chama a cada 5 min: envia a fila e responde mensagens recentes que ficaram para trás.
  // Funciona mesmo sem o cron do motor (com as mesmas travas: nada velho, nada em massa).
  if (caminho === "/platform/tick" && metodo === "POST") {
    const enviadas = await enviarFila(c, 10).catch(() => 0);
    const tels = (await c.db.prepare("SELECT DISTINCT telefone FROM d30_fila WHERE status='PENDENTE' AND recebido_ms BETWEEN ? AND ? LIMIT 3").bind(c.agora() - atrasoMaximo(env), c.agora() - 40000).all().catch(() => null))?.results || [];
    for (const t of tels) { if (sobram(c) < 25) break; await processarPendentes(c, t.telefone); }
    const memorias = sobram(c) > 30 ? await prepararMemorias(c, 1).catch(() => 0) : 0;
    if (sobram(c) > 30) await estudoDiario(c).catch(e => console.error("estudo", e?.message));
    if (sobram(c) > 30 && horaSP(c.agora()) >= 22) await pesquisaSemanal(c).catch(e => console.error("pesquisa", e?.message));
    return json({ sucesso: true, enviadas, conversas: tels.length, memorias });
  }
  // Avisos que não foram ao Telegram (não urgentes): a plataforma mostra na página Problemas.
  if (caminho === "/platform/avisos" && metodo === "GET") {
    const ev = (await c.db.prepare("SELECT id, caso_id, descricao, criado_ms FROM d30_eventos WHERE tipo='AVISO_PAINEL' AND criado_ms > ? ORDER BY id DESC LIMIT 60").bind(c.agora() - 7 * 86400000).all().catch(() => null))?.results || [];
    return json({ sucesso: true, avisos: ev.map(e => ({ id: e.id, caso_id: e.caso_id, texto: e.descricao, em: e.criado_ms })) });
  }
  if (caminho === "/platform/study" && metodo === "GET") {
    const ev = (await c.db.prepare("SELECT tipo, descricao, dados, criado_ms FROM d30_eventos WHERE tipo IN ('ESTUDO_DIARIO','PESQUISA_SEMANAL') ORDER BY id DESC LIMIT 14").all().catch(() => null))?.results || [];
    const treino = await carregarTreinamento(c);
    return json({ sucesso: true, licoes: String(treino.dados?.licoes_diarias || ""), relatorios: ev.map(e => { let d = null; try { d = JSON.parse(e.dados || "null"); } catch { d = null; } return { tipo: e.tipo, descricao: e.descricao, em: e.criado_ms, ...(d || {}) }; }) });
  }
  if (caminho === "/platform/study/run" && metodo === "POST") {
    const r = String(corpo?.tipo || "") === "pesquisa" ? await pesquisaSemanal(c, { forcar: true }) : await estudoDiario(c, { forcar: true });
    return json({ sucesso: true, resultado: r });
  }
  if (caminho.startsWith("/platform/guide")) return rotasGuia(c, caminho, metodo, corpo, new URL(request.url));
  if (caminho === "/platform/metrics" && metodo === "GET") { const q = new URL(request.url).searchParams; return json({ sucesso: true, versao: VERSAO, ...(await metricasAtendimento(c, q.get("de"), q.get("ate"))) }); }
  if (caminho === "/platform/usage" && metodo === "GET") { const q = new URL(request.url).searchParams; return json({ sucesso: true, versao: VERSAO, ...(await consumoDoPeriodo(c, q.get("de"), q.get("ate"))) }); }
  if (caminho === "/platform/status") return json({ sucesso: true, versao: VERSAO, ...(await saude(c, { completo: new URL(request.url).searchParams.get("completo") === "1" })) });
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
    await carregarTelsExtras(c);
    const daLista = prestadorPorTelefone(p.telefone);
    const msgs = await historico(c, p.id, 500);
    // Situação de entrega de cada mensagem enviada (✓ aceita, ✓✓ entregue, lida, ⚠ falhou e o motivo).
    const ids = msgs.filter(x => x.whatsapp_message_id && String(x.direcao).toUpperCase() === "SAIDA").map(x => x.whatsapp_message_id);
    const entregas = new Map();
    for (let i = 0; i < ids.length; i += 90) {
      const parte = ids.slice(i, i + 90);
      for (const e of (await c.db.prepare(`SELECT wamid,status,codigo,erro,detalhe FROM d30_entregas WHERE wamid IN (${parte.map(() => "?").join(",")})`).bind(...parte).all().catch(() => null))?.results || []) entregas.set(e.wamid, e);
    }
    const mensagens = msgs.map(x => {
      const e = entregas.get(x.whatsapp_message_id);
      if (e) return { ...x, entrega: e.status, entrega_erro: e.status === "FAILED" ? explicarEntrega(e.codigo, e.detalhe || e.erro) : null };
      if (/^(fila|kv):/.test(String(x.whatsapp_message_id || ""))) return { ...x, entrega: "FILA" };
      return x;
    });
    return json({ sucesso: true, pessoa: { ...p, profissional: daLista ? daLista.nome : null, oficial: Boolean(daLista && !TELS_EXTRAS.mapa.has(digitos(p.telefone))) }, ia_pausada: await estaPausado(c, p.telefone), caso_ativo: casos.ativo, casos_recentes: casos.recentes, mensagens });
  }
  // A equipe diz quem é a pessoa: profissional (opcionalmente ligado a um profissional da lista) ou cliente.
  if ((m = caminho.match(/^\/platform\/conversations\/(\d+)\/type$/)) && metodo === "POST") {
    const p = await c.db.prepare("SELECT id,nome,telefone,tipo FROM pessoas WHERE id=?").bind(Number(m[1])).first();
    if (!p) return json({ sucesso: false, erro: "Conversa não encontrada." }, 404);
    await carregarTelsExtras(c, true);
    const tipo = String(corpo?.tipo || "").toUpperCase() === "TECNICO" ? "TECNICO" : "CLIENTE";
    const prest = PRESTADORES.find(x => x.id === corpo?.prestador_id) || null;
    if (prestadorPorTelefone(p.telefone) && !TELS_EXTRAS.mapa.has(digitos(p.telefone)) && tipo === "CLIENTE") return json({ sucesso: false, erro: "Este número está na lista oficial de profissionais e não pode virar cliente." }, 409);
    await c.db.prepare("UPDATE pessoas SET tipo=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?").bind(tipo, p.id).run();
    for (const v of variantesTel(p.telefone)) await c.db.prepare("DELETE FROM d30_prestador_tels WHERE telefone=?").bind(v).run();
    if (tipo === "TECNICO" && prest && !PRESTADORES.some(x => variantesTel(x.telefone).includes(digitos(p.telefone)))) {
      await c.db.prepare("INSERT OR REPLACE INTO d30_prestador_tels(telefone,prestador_id,criado_ms) VALUES(?,?,?)").bind(digitos(p.telefone), prest.id, c.agora()).run();
    }
    await carregarTelsExtras(c, true);
    // Pedidos abertos por engano por um profissional (tratado como cliente) são encerrados, sem avisar ninguém.
    let encerrados = 0;
    if (tipo === "TECNICO") {
      const abertos = (await c.db.prepare("SELECT caso_id FROM d30_casos WHERE cliente_id=? AND etapa NOT IN ('CONCLUIDO','CANCELADO')").bind(p.id).all().catch(() => null))?.results || [];
      for (const x of abertos) {
        const caso = await carregarCasoPorId(c, x.caso_id);
        if (!caso) continue;
        await mudarEtapa(c, caso, "CANCELADO");
        await c.db.prepare("UPDATE d30_consultas SET status='CANCELADA', atualizado_ms=? WHERE caso_id=? AND status NOT IN ('CONFIRMADA','RECUSADA','CANCELADA')").bind(c.agora(), caso.casoId).run();
        await evento(c, caso.casoId, "ABERTO_POR_PROFISSIONAL", `${p.nome || p.telefone} marcado como profissional por ${txt(corpo?.autor, 120) || "platform"}`);
        encerrados++;
      }
    }
    await evento(c, null, "TIPO_CONTATO", `${p.nome || p.telefone} → ${tipo}${prest ? " (" + prest.nome + ")" : ""} por ${txt(corpo?.autor, 120) || "platform"}`);
    return json({ sucesso: true, tipo, prestador: prest ? prest.nome : null, casos_encerrados: encerrados });
  }
  // Resumo de uma ligação (cliente ou profissional): entra no histórico, e a DENIA passa a considerar o que foi combinado.
  if ((m = caminho.match(/^\/platform\/conversations\/(\d+)\/note$/)) && metodo === "POST") {
    const p = await c.db.prepare("SELECT id,nome,telefone FROM pessoas WHERE id=?").bind(Number(m[1])).first();
    if (!p) return json({ sucesso: false, erro: "Conversa não encontrada." }, 404);
    const texto = txt(corpo?.texto, 3000);
    if (texto.length < 3) return json({ sucesso: false, erro: "Escreva o resumo da ligação." }, 400);
    const id = await identificar(c, p.telefone);
    let casoId = null;
    if (id.papel === "PRESTADOR") { const ab = await consultasAbertasPrestador(c, p.telefone); if (ab.length === 1) casoId = ab[0].caso_id; }
    else casoId = (await carregarCasos(c, p)).ativo?.casoId || null;
    const autor = txt(corpo?.autor, 120) || "Equipe";
    await registrarMensagem(c, { pessoaId: p.id, casoId, wamid: null, direcao: "SAIDA", origem: "LIGACAO", tipo: "NOTA", conteudo: `${texto} — registrado por ${autor.replace(/\s*<.*>$/, "")}` });
    await evento(c, casoId, "RESUMO_LIGACAO", `${p.nome || p.telefone}: ${txt(texto, 300)} (${autor})`);
    return json({ sucesso: true, caso_id: casoId });
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
    if (!["COLETANDO", "EQUIPE", "AGENDADO", "EM_ANDAMENTO", "CONCLUIDO", "CANCELADO"].includes(etapa)) return json({ sucesso: false, erro: "Etapa inválida." }, 400);
    await mudarEtapa(c, caso, etapa);
    return json({ sucesso: true, caso });
  }
  if (caminho === "/platform/cases" && metodo === "GET") {
    const r = await c.db.prepare("SELECT * FROM d30_casos ORDER BY atualizado_ms DESC LIMIT 1000").all();
    // Última revisão da IA de cada caso (para a tela mostrar o que ela viu e sugeriu).
    const revs = (await c.db.prepare("SELECT caso_id, dados, criado_ms FROM d30_eventos WHERE tipo='REVISAO_IA' AND id IN (SELECT MAX(id) FROM d30_eventos WHERE tipo='REVISAO_IA' GROUP BY caso_id)").all().catch(() => null))?.results || [];
    const porCaso = new Map(revs.map(x => { let d = null; try { d = JSON.parse(x.dados || "null"); } catch { d = null; } return [x.caso_id, d ? { ...d, em: x.criado_ms } : null]; }));
    return json({ sucesso: true, casos: (r?.results || []).map(row => ({ ...linhaParaCaso(row), revisao_ia: porCaso.get(row.caso_id) || null })) });
  }
  if ((m = caminho.match(/^\/platform\/cases\/(\d+)\/review$/)) && metodo === "POST") {
    const caso = await carregarCasoPorId(c, Number(m[1]));
    if (!caso) return json({ sucesso: false, erro: "Caso não encontrado." }, 404);
    try { return json({ sucesso: true, ...(await revisarEtapaCaso(c, caso, { aplicar: corpo?.aplicar !== false, autor: txt(corpo?.autor, 120) || "platform" })) }); }
    catch (e) { return json({ sucesso: false, erro: "A IA não conseguiu revisar agora: " + txt(e?.message, 200) }, 502); }
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
  // Triagem de avaliações do Google: quem avaliou existe na base de clientes? (só diz sim/não/talvez, sem expor dados)
  if (caminho === "/platform/clients/match" && metodo === "POST") {
    const nomes = (Array.isArray(corpo?.nomes) ? corpo.nomes : []).map(n => txt(n, 120)).slice(0, 80);
    const tokens = n => norm(n).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(t => t.length >= 2);
    const pessoas = ((await c.db.prepare("SELECT nome, atualizado_em FROM pessoas WHERE empresa_id=? AND nome IS NOT NULL AND UPPER(COALESCE(tipo,'')) NOT IN ('TECNICO','ATENDENTE') LIMIT 30000").bind(EMPRESA_ID).all().catch(() => null))?.results || [])
      .map(p => ({ t: new Set(tokens(p.nome)), em: p.atualizado_em, onde: "WhatsApp" }));
    const fichas = ((await c.db.prepare("SELECT dados_json FROM d30_ficha LIMIT 30000").all().catch(() => null))?.results || []).map(f => {
      let d = {}; try { d = JSON.parse(f.dados_json); } catch { d = {}; }
      const nome = Object.entries(d).find(([k]) => /nome|cliente|name/i.test(k))?.[1] || "";
      return { t: new Set(tokens(nome)), em: null, onde: "cadastro" };
    }).filter(f => f.t.size);
    const base = [...pessoas, ...fichas];
    const resultado = {};
    for (const n of nomes) {
      const tk = tokens(n).filter(t => !/^[a-z]$/.test(t) && !["da", "de", "do", "das", "dos"].includes(t));
      if (!tk.length) { resultado[n] = { encontrado: "SEM_NOME" }; continue; }
      const [primeiro, ...resto] = tk;
      // Nome e sobrenome iguais = encontrado; só o primeiro nome = talvez (muita gente tem o mesmo primeiro nome).
      const achados = base.filter(b => b.t.has(primeiro) && resto.every(r => r.length <= 2 ? [...b.t].some(x => x.startsWith(r.replace(".", ""))) : b.t.has(r)));
      resultado[n] = !achados.length ? { encontrado: "NAO" } : resto.length ? { encontrado: "SIM", onde: [...new Set(achados.map(a => a.onde))], ultimo_contato: achados.map(a => a.em).filter(Boolean).sort().pop() || null } : { encontrado: "TALVEZ", quantos: achados.length };
    }
    return json({ sucesso: true, base: { whatsapp: pessoas.length, cadastro: fichas.length }, resultado });
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
  if (caminho === "/platform/professionals" && metodo === "GET") {
    await carregarPrestadores(c, true);
    const todos = (await c.db.prepare("SELECT * FROM d30_prestadores ORDER BY ordem, nome").all())?.results || [];
    return json({ sucesso: true, profissionais: todos.map(p => ({ ...p, ativo: Number(p.ativo) === 1, area_rotulo: CATEGORIAS[p.area]?.rotulo })), categorias: Object.entries(CATEGORIAS).map(([id, v]) => ({ id, rotulo: v.rotulo })) });
  }
  // A empresa cadastra, troca o número ou desativa um profissional (sem mexer no código).
  if (caminho === "/platform/professionals" && metodo === "POST") {
    await carregarPrestadores(c, true);
    const tel = digitos(corpo?.telefone), area = String(corpo?.area || "").toUpperCase(), nome = txt(corpo?.nome, 80);
    if (!nome) return json({ sucesso: false, erro: "Escreva o nome do profissional." }, 400);
    if (!/^55\d{10,11}$/.test(tel.startsWith("55") ? tel : "55" + tel)) return json({ sucesso: false, erro: "WhatsApp inválido. Use DDD + número, ex.: 21 99999-8888." }, 400);
    if (!CATEGORIAS[area]) return json({ sucesso: false, erro: "Escolha a área do profissional." }, 400);
    const telefone = tel.startsWith("55") ? tel : "55" + tel;
    const id = /^[\w-]{1,40}$/.test(String(corpo?.id || "")) ? String(corpo.id) : `P-${area.slice(0, 4)}-${telefone.slice(-6)}-${Math.floor(c.agora() / 1000).toString(36)}`;
    const outro = (await c.db.prepare("SELECT id, nome FROM d30_prestadores WHERE telefone=? AND id<>? AND ativo=1").bind(telefone, id).first());
    if (outro) return json({ sucesso: false, erro: `Esse WhatsApp já é de ${outro.nome}.` }, 409);
    const atual = await c.db.prepare("SELECT ordem FROM d30_prestadores WHERE id=?").bind(id).first();
    const ordem = Number.isFinite(Number(corpo?.ordem)) ? Number(corpo.ordem) : atual ? Number(atual.ordem) : Number((await c.db.prepare("SELECT COALESCE(MAX(ordem),0)+1 n FROM d30_prestadores").first())?.n || 0);
    await c.db.prepare(`INSERT INTO d30_prestadores(id,nome,telefone,area,servicos,ordem,ativo,atualizado_ms) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, telefone=excluded.telefone, area=excluded.area, servicos=excluded.servicos, ordem=excluded.ordem, ativo=excluded.ativo, atualizado_ms=excluded.atualizado_ms`)
      .bind(id, nome, telefone, area, txt(corpo?.servicos, 400) || null, ordem, corpo?.ativo === false ? 0 : 1, c.agora()).run();
    await evento(c, null, "PROFISSIONAL", `${atual ? "Alterado" : "Cadastrado"}: ${nome} (${area}) por ${txt(corpo?.autor, 120) || "plataforma"}`);
    await carregarPrestadores(c, true);
    return json({ sucesso: true, id });
  }
  if ((m = caminho.match(/^\/platform\/professionals\/([\w-]{1,40})\/delete$/)) && metodo === "POST") {
    await c.db.prepare("UPDATE d30_prestadores SET ativo=0, atualizado_ms=? WHERE id=?").bind(c.agora(), m[1]).run();
    await evento(c, null, "PROFISSIONAL", `Desativado: ${m[1]} por ${txt(corpo?.autor, 120) || "plataforma"}`);
    await carregarPrestadores(c, true);
    return json({ sucesso: true });
  }
  return json({ sucesso: false, erro: "Rota não encontrada." }, 404);
}

// ============================================================================
// SAÚDE (testa funcionamento real, não só se o binding existe)
// ============================================================================

async function saude(c, { completo = false } = {}) {
  const env = c.env;
  const r = {
    versao: VERSAO, modelo: modelo(env),
    openai_configurado: Boolean(env.OPENAI_API_KEY), whatsapp_configurado: Boolean(env.WHATSAPP_TOKEN),
    verify_token_configurado: Boolean(env.WHATSAPP_VERIFY_TOKEN), assinatura_meta_verificada: Boolean(env.META_APP_SECRET),
    telegram_configurado: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    telegram_equipe: await c.db.prepare("SELECT valor FROM d30_meta WHERE chave='telegram_equipe'").first().then(r => { try { return JSON.parse(r?.valor || "null"); } catch { return null; } }).catch(() => null), template_prestador_configurado: Boolean(env.WHATSAPP_TEMPLATE_CONSULTA_TECNICO),
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
  // Diagnóstico: chegam mensagens? há erros? os envios estão falhando? a assinatura da Meta bate?
  if (r.d1.operacional) {
    const q = async (sql, ...a) => c.db.prepare(sql).bind(...a).first().catch(() => null);
    const qa = async (sql, ...a) => ((await c.db.prepare(sql).bind(...a).all().catch(() => null))?.results || []);
    const dia = c.agora() - 86400000;
    r.ultima_recebida_ms = Number((await q("SELECT MAX(recebido_ms) m FROM d30_fila"))?.m || 0) || null;
    r.erros_24h = (await qa("SELECT erro, atualizado_ms FROM d30_fila WHERE status='ERRO' AND recebido_ms > ? ORDER BY atualizado_ms DESC LIMIT 3", dia)).map(x => ({ erro: txt(x.erro, 300), em: x.atualizado_ms }));
    const falhas = await qa("SELECT descricao, criado_ms FROM d30_eventos WHERE tipo='FALHA_ENVIO_CLIENTE' AND criado_ms > ? ORDER BY id DESC LIMIT 50", dia);
    r.falhas_envio_24h = { n: falhas.length, ultima: falhas[0] ? txt(falhas[0].descricao, 300) : null, em: falhas[0]?.criado_ms || null };
    r.enviadas_24h = Number((await q("SELECT COUNT(*) n FROM d30_saidas WHERE criado_ms > ?", dia))?.n || 0);
    r.assinatura_invalida_ms = Number((await q("SELECT valor FROM d30_meta WHERE chave='assinatura_invalida'"))?.valor || 0) || null;
    r.entregas_24h = await resumoEntregas(c, dia);
    const fl = await q("SELECT COUNT(*) n, MIN(criado_ms) m FROM d30_saida_fila WHERE status='PENDENTE'");
    r.fila_envio = { pendentes: Number(fl?.n || 0), mais_antiga_ms: Number(fl?.m || 0) || null, adiadas_24h: Number((await q("SELECT COUNT(*) n FROM d30_saida_fila WHERE criado_ms > ?", dia))?.n || 0) };
    r.limite_chamadas = limiteChamadas(c);
    try { r.entrega_bloqueada = JSON.parse((await q("SELECT valor FROM d30_meta WHERE chave='entrega_bloqueada'"))?.valor || "null"); } catch { r.entrega_bloqueada = null; }
    r.ultima_confirmacao_ms = Number((await q("SELECT MAX(atualizado_ms) m FROM d30_entregas WHERE status IN ('SENT','DELIVERED','READ','FAILED') AND atualizado_ms > ?", dia - 6 * 86400000))?.m || 0) || null;
  }
  // Teste real das chaves (só quando pedido): o token do WhatsApp e a chave da OpenAI ainda valem?
  if (completo) {
    try {
      const w = await fetch(`https://graph.facebook.com/${GRAPH}/${phoneId(env)}?fields=display_phone_number,verified_name,quality_rating,status,name_status,code_verification_status,platform_type,account_mode,messaging_limit_tier,throughput`, { headers: { authorization: `Bearer ${String(env.WHATSAPP_TOKEN || "").trim()}` }, signal: AbortSignal.timeout(15000) });
      const d = await w.json().catch(() => ({}));
      r.teste_whatsapp = w.ok ? { ok: true, numero: d.display_phone_number || null, nome: d.verified_name || null, qualidade: d.quality_rating || null, status: d.status || null, nome_status: d.name_status || null, plataforma: d.platform_type || null, modo: d.account_mode || null, limite: d.messaging_limit_tier || null, verificacao: d.code_verification_status || null } : { ok: false, codigo: d?.error?.code || w.status, erro: txt(d?.error?.message || `HTTP ${w.status}`, 300) };
      // Problemas no número que fazem a Meta aceitar e não entregar.
      const alertas = [];
      if (w.ok) {
        if (d.status && !["CONNECTED"].includes(String(d.status).toUpperCase())) alertas.push(`O número está com status ${d.status} na Meta (o normal é CONNECTED). Veja o Gerenciador do WhatsApp.`);
        if (d.platform_type && String(d.platform_type).toUpperCase() !== "CLOUD_API") alertas.push(`O número não está na API de nuvem (plataforma: ${d.platform_type}). Ele precisa estar registrado na Cloud API.`);
        if (d.account_mode && String(d.account_mode).toUpperCase() === "SANDBOX") alertas.push("A conta está em modo de teste (SANDBOX): só números cadastrados como teste recebem.");
        if (d.quality_rating && String(d.quality_rating).toUpperCase() === "RED") alertas.push("A qualidade do número está VERMELHA: a Meta pode limitar ou bloquear os envios.");
        if (d.name_status && !["APPROVED", "AVAILABLE_WITHOUT_REVIEW"].includes(String(d.name_status).toUpperCase())) alertas.push(`O nome de exibição está ${d.name_status}: enquanto não for aprovado, a Meta pode não entregar.`);
      }
      r.teste_whatsapp.alertas = alertas;
      const waba = String(env.WHATSAPP_WABA_ID || "").trim();
      if (waba) {
        const a = await fetch(`https://graph.facebook.com/${GRAPH}/${encodeURIComponent(waba)}?fields=name,account_review_status,business_verification_status,primary_funding_id,health_status`, { headers: { authorization: `Bearer ${String(env.WHATSAPP_TOKEN || "").trim()}` }, signal: AbortSignal.timeout(15000) });
        const da = await a.json().catch(() => ({}));
        r.teste_conta = a.ok ? { ok: true, nome: da.name || null, revisao: da.account_review_status || null, verificacao: da.business_verification_status || null, pagamento: Boolean(da.primary_funding_id), saude: da.health_status?.can_send_message || null, problemas: (da.health_status?.entities || []).flatMap(x => (x.errors || []).map(e => txt(`${x.entity_type}: ${e.error_description || e.possible_solution || e.error_code}`, 300))) } : { ok: false, erro: txt(da?.error?.message || `HTTP ${a.status}`, 300) };
      }
    } catch (e) { r.teste_whatsapp = { ok: false, erro: txt(e?.message, 200) }; }
    try {
      const o = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${String(env.OPENAI_API_KEY || "").trim()}` }, signal: AbortSignal.timeout(15000) });
      const d = await o.json().catch(() => ({}));
      r.teste_openai = o.ok ? { ok: true } : { ok: false, codigo: o.status, erro: txt(d?.error?.message || `HTTP ${o.status}`, 300) };
    } catch (e) { r.teste_openai = { ok: false, erro: txt(e?.message, 200) }; }
  }
  r.limites_envio = LIMITES_ENVIO;
  r.modo = modoGuia(env) ? "guia" : "central";
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
// EQUIPE PELO TELEGRAM — a equipe conversa com a DENIA no grupo da Central (respondendo um aviso ou
// citando o bot) e ela executa: consultar um profissional, falar com o cliente ou com o profissional,
// pausar/retomar a conversa, mudar a etapa ou só responder ("quem faz estofado?"). Só o grupo da
// Central (TELEGRAM_CHAT_ID) é ouvido, e ela sempre confirma no grupo o que fez.
// ============================================================================

function segredoTelegramEngine(env) { return hashTexto("denia-tg:" + String(env.TELEGRAM_BOT_TOKEN || "")) + hashTexto(String(env.TELEGRAM_BOT_TOKEN || "") + ":central"); }

const INSTRUCOES_EQUIPE = `Você coordena a Central de Atendimento junto com a EQUIPE, que fala com você pelo grupo do Telegram. Quem escreve é da equipe (não é cliente nem profissional). Leia o AVISO que ela respondeu (se houver), o CASO, o que o CLIENTE escreveu, os PROFISSIONAIS e os CASOS ABERTOS, e decida o que fazer.

Responda SOMENTE com JSON:
{"caso_id":0,"acoes":[],"resposta":"","pergunta":""}

acoes (só o que a equipe pediu claramente; pode ser mais de uma):
- {"tipo":"CONSULTAR","prestador_id":"","nome":"","telefone":"","categoria":""}: mandar o pedido do cliente para um profissional. Use prestador_id da lista quando a equipe citar alguém da lista (pelo nome ou pela área: "manda pro Carlos estofador", "quem faz higienização é a Mirella"). Se a equipe der nome e telefone de alguém fora da lista, preencha nome e telefone. categoria: uma das CATEGORIAS, se ficar claro.
- {"tipo":"MENSAGEM_CLIENTE","texto":""}: mandar uma mensagem ao cliente do caso, em nome da Central (escreva o texto pronto, curto e educado; se a equipe ditou o texto, use o dela).
- {"tipo":"MENSAGEM_PROFISSIONAL","texto":""}: mandar uma mensagem ao profissional que está com o caso.
- {"tipo":"PAUSAR"}: a equipe vai assumir a conversa com o cliente (a DENIA para de responder por 12 h).
- {"tipo":"RETOMAR"}: a DENIA volta a atender o cliente.
- {"tipo":"ETAPA","etapa":""}: mudar a etapa (COLETANDO, AGUARDANDO_PRESTADOR, AGUARDANDO_CLIENTE, EQUIPE, AGENDADO, EM_ANDAMENTO, CONCLUIDO, CANCELADO).
caso_id: o caso de que a equipe está falando (o do AVISO, ou o que ela citou pelo número, pelo nome do cliente ou pelo serviço, entre os CASOS ABERTOS). 0 se não for sobre um caso.
resposta: o que você diz à equipe no Telegram, curto e direto, em português do Brasil (ex.: responder "quem faz estofado?" com os nomes da lista). Não diga que fez algo: o sistema confirma cada ação.
pergunta: se não der para saber o caso, o profissional ou o que fazer, pergunte aqui e deixe acoes vazia. NUNCA chute caso ou profissional. Nunca invente telefone. Nunca mande valor ao cliente que a equipe não disse.`;

async function casosAbertosResumo(c, limite = 10) {
  const r = await c.db.prepare("SELECT k.*, p.nome cliente_nome FROM d30_casos k LEFT JOIN pessoas p ON p.id=k.cliente_id WHERE k.etapa NOT IN ('CONCLUIDO','CANCELADO') AND k.atualizado_ms > ? ORDER BY k.atualizado_ms DESC LIMIT ?").bind(c.agora() - 30 * 86400000, limite).all().catch(() => null);
  return (r?.results || []).map(x => ({ ...linhaParaCaso(x), clienteNome: x.cliente_nome || "" }));
}
function linhaCaso(k) {
  const f = k.fatos || {};
  return `#${k.casoId} — ${k.clienteNome || "cliente"} (${digitos(k.telefone)})${f.bairro ? ", " + f.bairro : ""}: ${txt(f.problema || f.servico || "-", 120)} [${k.etapa}${f.categoria ? ", " + f.categoria : ""}]`;
}
function acharPrestador(a) {
  const id = String(a?.prestador_id || "").trim();
  if (id) { const p = PRESTADORES.find(x => x.id === id); if (p) return p; }
  const tel = digitos(a?.telefone);
  if (tel.length >= 10) { const p = prestadorPorTelefone(tel); if (p) return p; }
  const nome = norm(a?.nome);
  if (nome) {
    const achados = PRESTADORES.filter(p => norm(p.nome).includes(nome) || nome.includes(norm(primeiroNome(p.nome))));
    if (achados.length === 1) return achados[0];
  }
  if (tel.length >= 10) {
    const area = CATEGORIAS[String(a?.categoria || "").toUpperCase()] ? String(a.categoria).toUpperCase() : "EQUIPE";
    return { id: "EQ-" + tel, area, nome: txt(a?.nome, 60) || "Profissional", telefone: tel.startsWith("55") ? tel : "55" + tel };
  }
  return null;
}

async function processarTelegramEquipe(c, upd) {
  const m = upd?.message;
  if (!m || !m.text || m.from?.is_bot) return;
  if (String(m.chat?.id) !== String(c.env.TELEGRAM_CHAT_ID)) return; // só o grupo da Central
  if (!(await reservarChave(c, "tg-upd:" + upd.update_id))) return;
  await carregarTelsExtras(c);
  const responder = t => c.saida.telegram(t, { responderA: m.message_id });
  const quem = txt([m.from?.first_name, m.from?.last_name].filter(Boolean).join(" "), 60) || "Equipe";
  const aviso = m.reply_to_message?.message_id ? await c.db.prepare("SELECT * FROM d30_tg_msgs WHERE message_id=?").bind(Number(m.reply_to_message.message_id)).first().catch(() => null) : null;
  const textoAviso = aviso?.texto || txt(m.reply_to_message?.text, 1500);
  let casoAviso = aviso?.caso_id ? await carregarCasoPorId(c, aviso.caso_id) : null;
  if (!casoAviso && aviso?.telefone) {
    const pes = await buscarPessoa(c, aviso.telefone).catch(() => null);
    if (pes) casoAviso = (await carregarCasos(c, pes).catch(() => ({ ativo: null })))?.ativo || null;
  }
  const abertos = await casosAbertosResumo(c);
  if (casoAviso && !abertos.some(k => k.casoId === casoAviso.casoId)) abertos.unshift({ ...casoAviso, clienteNome: "" });
  const descreverCaso = async k => {
    if (!k) return "(nenhum caso no aviso)";
    const cli = await c.db.prepare("SELECT nome, telefone FROM pessoas WHERE id=?").bind(k.clienteId).first().catch(() => null);
    const consulta = await consultaDoCaso(c, k.casoId);
    return `#${k.casoId} — cliente ${cli?.nome || "-"} (${digitos(cli?.telefone || k.telefone)}); etapa ${k.etapa}\n${formatarFatos(k.fatos)}\nResumo: ${k.resumo || "-"}\nProfissional atual: ${consulta ? `${consulta.prestador_nome} (${consulta.status})` : "nenhum"}\nO QUE O CLIENTE ESCREVEU:\n${await palavrasDoCliente(c, k) || "-"}`;
  };
  let d;
  try {
    d = await openaiJSON(c, INSTRUCOES_EQUIPE, `DATA E HORA: ${dataHoraSP(c.agora())}
MENSAGEM DE ${quem} (equipe):
${txt(m.text, 2000)}

AVISO QUE ELA RESPONDEU:
${textoAviso || "(não respondeu a um aviso)"}

CASO DO AVISO:
${await descreverCaso(casoAviso)}

CASOS ABERTOS:
${abertos.map(linhaCaso).join("\n") || "(nenhum)"}

PROFISSIONAIS (id | nome | área | categoria):
${PRESTADORES.map(p => `${p.id} | ${p.nome} | ${CATEGORIAS[p.area]?.rotulo || p.area}${p.servicos ? " — faz: " + txt(p.servicos, 120) : ""} | ${p.area}`).join("\n")}

CATEGORIAS: ${Object.keys(CATEGORIAS).join(", ")}

Responda em JSON.`, [], 700);
  } catch (e) { await responder(`Não consegui entender agora (${txt(e?.message, 120)}). Tente de novo em instantes.`); return; }

  const acoes = Array.isArray(d?.acoes) ? d.acoes.slice(0, 4) : [];
  const casoId = Number(d?.caso_id || 0) || casoAviso?.casoId || 0;
  const caso = casoId ? await carregarCasoPorId(c, casoId) : null;
  const linhas = [];
  if (txt(d?.resposta, 1500)) linhas.push(txt(d.resposta, 1500));
  if (!acoes.length) {
    if (txt(d?.pergunta, 500)) linhas.push(txt(d.pergunta, 500));
    if (linhas.length) await responder(linhas.join("\n"));
    return;
  }
  if (!caso) { await responder(txt(d?.pergunta, 500) || "De qual atendimento você está falando? Responda o aviso do caso ou diga o nome do cliente."); return; }
  const cliente = await c.db.prepare("SELECT id, nome, telefone FROM pessoas WHERE id=?").bind(caso.clienteId).first().catch(() => null);
  const telCli = cliente?.telefone || caso.telefone, nomeCli = primeiroNome(cliente?.nome) || "o cliente";
  const chave = "tg:" + upd.update_id;
  for (const [i, a] of acoes.entries()) {
    const tipo = String(a?.tipo || "").toUpperCase();
    try {
      if (tipo === "CONSULTAR") {
        const p = acharPrestador(a);
        if (!p) { linhas.push("⚠️ Não achei esse profissional na lista. Diga o nome como está cadastrado ou mande nome e telefone."); continue; }
        if (CATEGORIAS[String(a?.categoria || "").toUpperCase()]) { caso.fatos.categoria = String(a.categoria).toUpperCase(); await salvarCaso(c, caso); }
        const pessoa = cliente ? { ...cliente } : { id: caso.clienteId, telefone: telCli };
        const r = await consultarPrestador(c, caso, pessoa, chave + ":" + i, p);
        const consulta = await consultaDoCaso(c, caso.casoId);
        if (consulta && consulta.prestador_id === p.id) {
          linhas.push(`✅ ${consulta.status === "AGENDADA_ENVIO" ? "Consulta programada para" : "Consultei"} ${p.nome} sobre o atendimento de ${nomeCli}. Aviso aqui quando responder.`);
          if (r?.texto && r.fixa) await enviarAoCliente(c, { tel: telCli, pessoaId: caso.clienteId, casoId: caso.casoId, texto: r.texto, chave: chave + ":cli:" + i, origem: "SISTEMA" });
        } else linhas.push(`⚠️ Não consegui consultar ${p.nome} (veja o aviso acima).`);
      } else if (tipo === "MENSAGEM_CLIENTE") {
        const t = txt(a?.texto, 1500);
        if (!t) continue;
        // A equipe mandou: sai mesmo com a conversa em pausa (quem pausou foi a própria equipe).
        const r = await c.saida.texto(telCli, t, { papel: "cliente" });
        if (r.ok) { await registrarMensagem(c, { pessoaId: caso.clienteId, casoId: caso.casoId, wamid: r.id, direcao: "SAIDA", origem: "HUMANO", conteudo: t }); linhas.push(`✅ Mandei para ${nomeCli}: "${txt(t, 200)}"`); }
        else linhas.push(r.guardada ? `🕓 ${nomeCli} não escreve há mais de 24 h: a mensagem ficou guardada e sai quando responder.` : `⚠️ Não consegui mandar para ${nomeCli}: ${txt(r.erro, 150)}`);
      } else if (tipo === "MENSAGEM_PROFISSIONAL") {
        const t = txt(a?.texto, 1500), consulta = await consultaDoCaso(c, caso.casoId);
        if (!t) continue;
        if (!consulta) { linhas.push("⚠️ Esse atendimento ainda não tem profissional. Diga para quem mandar."); continue; }
        const r = await enviarAgoraAoPrestador(c, { consulta, caso, texto: t, chave: chave + ":pre:" + i });
        linhas.push(r.ok ? `✅ Mandei para ${consulta.prestador_nome}: "${txt(t, 200)}"` : r.guardada ? `🕓 ${consulta.prestador_nome} não escreve há mais de 24 h: ficou guardada e sai quando responder.` : `⚠️ Não consegui mandar para ${consulta.prestador_nome}: ${txt(r.erro, 150)}`);
      } else if (tipo === "PAUSAR") {
        await pausar(c, telCli, 12 * 3600000, "EQUIPE_TELEGRAM");
        linhas.push(`⏸️ Pausei a DENIA na conversa com ${nomeCli} por 12 h. A equipe assume.`);
      } else if (tipo === "RETOMAR") {
        await liberarPausa(c, telCli);
        linhas.push(`▶️ A DENIA voltou a atender ${nomeCli}.`);
      } else if (tipo === "ETAPA") {
        const etapa = String(a?.etapa || "").toUpperCase();
        if (!ETAPAS_REVISAO.includes(etapa)) continue;
        await mudarEtapa(c, caso, etapa);
        linhas.push(`📌 Atendimento de ${nomeCli} agora está em ${etapa}.`);
      }
    } catch (e) { linhas.push(`⚠️ Falhou ao executar ${tipo}: ${txt(e?.message, 150)}`); }
  }
  await evento(c, caso.casoId, "EQUIPE_TELEGRAM", `${quem}: ${txt(m.text, 300)} → ${linhas.join(" | ")}`.slice(0, 1000));
  await responder(linhas.join("\n") || "Certo.");
}

// Liga o Telegram da Central à DENIA (setWebhook). Sem forçar, não troca um endereço já configurado por outro sistema.
async function conectarTelegramEquipe(c, base, forcar = false) {
  const env = c.env;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !base) return { ok: false, erro: "Faltam TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID ou o endereço público." };
  const api = (metodo, corpo) => fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${metodo}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo || {}), signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(e => ({ ok: false, description: e?.message }));
  const url = base.replace(/\/+$/, "") + "/telegram";
  const info = await api("getWebhookInfo");
  const atual = String(info?.result?.url || "");
  if (atual === url) return { ok: true, url, ja: true };
  // Endereço antigo da própria IA da Central (ex.: o Worker da Cloudflare antes da mudança para a Hostinger):
  // termina em "/telegram" (ou "/ia/telegram"). Esse ela troca sozinha; o de outro sistema, nunca.
  let daCentral = false;
  try { daCentral = /^(\/[\w-]+)?\/telegram$/.test(new URL(atual).pathname) && !/\/webhook\/telegram$/.test(new URL(atual).pathname); } catch { daCentral = false; }
  if (atual && !forcar && !daCentral) return { ok: false, erro: `O bot já entrega mensagens para outro endereço (${atual}). Use "forçar" para trocar.` };
  const r = await api("setWebhook", { url, secret_token: segredoTelegramEngine(env), allowed_updates: ["message"], drop_pending_updates: true });
  return r?.ok ? { ok: true, url } : { ok: false, erro: r?.description || "Telegram recusou." };
}

// ============================================================================
// ROTEADOR
// ============================================================================

// Endereço público deste motor (na Hostinger ele roda em /ia: o servidor avisa pelo cabeçalho x-denia-prefixo).
function enderecoPublico(request) {
  const u = new URL(request.url);
  const prefixo = String(request.headers.get("x-denia-prefixo") || "").replace(/[^a-z0-9/_-]/gi, "").replace(/\/+$/, "");
  return u.origin + prefixo;
}
let ultimaBaseGuardada = 0;
async function rotear(request, env, ctx) {
  const url = new URL(request.url);
  const caminho = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const metodo = request.method.toUpperCase();

  if (caminho === "/webhook" && metodo === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && env.WHATSAPP_VERIFY_TOKEN && iguaisSeguro(url.searchParams.get("hub.verify_token"), env.WHATSAPP_VERIFY_TOKEN);
    return new Response(ok ? url.searchParams.get("hub.challenge") || "" : "Não autorizado.", { status: ok ? 200 : 403 });
  }
  if (caminho === "/webhook" && metodo === "POST") return webhookPost(request, env, ctx);
  // Telegram da Central (a equipe falando com a DENIA): só com o segredo combinado no setWebhook.
  if (caminho === "/telegram" && metodo === "POST") {
    if (!env.TELEGRAM_BOT_TOKEN || !iguaisSeguro(request.headers.get("x-telegram-bot-api-secret-token") || "", segredoTelegramEngine(env))) return new Response("não autorizado", { status: 401 });
    const upd = await request.json().catch(() => null);
    const c = criarContexto(env);
    ctx.waitUntil((async () => { await garantirSchema(c); await processarTelegramEquipe(c, upd); })().catch(e => console.error("telegram equipe", e?.message)));
    return new Response("ok");
  }
  if (caminho.startsWith("/platform/")) return platformApi(request, env, caminho, metodo);
  if (caminho === "/favicon.ico") return new Response(null, { status: 204 });

  if (caminho === "/login") return login(request, env);
  if (caminho === "/sair") return new Response(null, { status: 302, headers: { location: "/login", "set-cookie": "denia_sess=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" } });
  if (!(await painelAutorizado(request, env))) return negarPainel(request);
  const c = criarContexto(env);
  if (caminho === "/api/telegram/conectar" && metodo === "POST") {
    await garantirSchema(c);
    const corpo = await request.json().catch(() => ({}));
    return json(await conectarTelegramEquipe(c, enderecoPublico(request), corpo?.forcar === true));
  }
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
