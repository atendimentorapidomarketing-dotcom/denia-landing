// DENIA Platform — Administração da empresa (a "central executiva").
// Junta, numa tela só, o que uma administradora faria: agenda e compromissos, obrigações e manutenção do prédio,
// aluguéis e locatários, documentos com validade, banco e caixa (dinheiro em espécie) e o relatório do mês
// no layout aprovado (Entrou / Saiu / Resultado / Saldo no banco, em aberto, atrasos e assinatura).
// O dinheiro continua no Financeiro (tabela fin_lanc): aqui só acrescentamos conta (banco/caixa), locatário,
// competência e valor efetivamente pago. Nada é inventado: o que não foi lançado aparece como "a conferir".
import { garantirFinanceiro, dinheiro, centavos, dataValida, mesValido, nomeMes, CATEGORIAS_PERFIL } from "./financeiro.js";
export { CATEGORIAS_PERFIL };
import { gerarPdf } from "./pdf.js";

export const DDL_ADMIN = [
  `CREATE TABLE IF NOT EXISTS adm_config (org_id INTEGER PRIMARY KEY, perfil TEXT, ical_token TEXT, resumo_diario INTEGER NOT NULL DEFAULT 1,
    emails TEXT, hora_resumo INTEGER NOT NULL DEFAULT 8, ultimo_resumo TEXT, tp_no_fin INTEGER NOT NULL DEFAULT 0, assinaturas TEXT, cidade TEXT, atualizado_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS adm_agenda (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, titulo TEXT NOT NULL, data TEXT NOT NULL, hora TEXT,
    duracao_min INTEGER, quem TEXT, local TEXT, prioridade TEXT NOT NULL DEFAULT 'NORMAL', aviso_min INTEGER NOT NULL DEFAULT 60, repetir TEXT,
    feito INTEGER NOT NULL DEFAULT 0, feito_em TEXT, obs TEXT, avisado_ms INTEGER, externo TEXT, criado_ms INTEGER)`,
  "CREATE INDEX IF NOT EXISTS adm_agenda_org ON adm_agenda(org_id, data)",
  "CREATE UNIQUE INDEX IF NOT EXISTS adm_agenda_ext ON adm_agenda(org_id, externo)",
  `CREATE TABLE IF NOT EXISTS adm_rotinas (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, titulo TEXT NOT NULL, area TEXT, dias INTEGER NOT NULL DEFAULT 30,
    ultima TEXT, proxima TEXT, aviso_dias INTEGER NOT NULL DEFAULT 7, fornecedor TEXT, telefone TEXT, obs TEXT, ativo INTEGER NOT NULL DEFAULT 1, externo TEXT, criado_ms INTEGER)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS adm_rotinas_ext ON adm_rotinas(org_id, externo)",
  `CREATE TABLE IF NOT EXISTS adm_servicos (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, titulo TEXT NOT NULL, data TEXT NOT NULL, tipo TEXT, local TEXT,
    problema TEXT, solucao TEXT, prestador TEXT, telefone TEXT, valor_cent INTEGER, garantia_ate TEXT, rotina_id INTEGER, fin_lanc_id INTEGER, externo TEXT, criado_ms INTEGER)`,
  "CREATE INDEX IF NOT EXISTS adm_servicos_org ON adm_servicos(org_id, data)",
  "CREATE UNIQUE INDEX IF NOT EXISTS adm_servicos_ext ON adm_servicos(org_id, externo)",
  `CREATE TABLE IF NOT EXISTS adm_locatarios (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, nome TEXT NOT NULL, unidade TEXT, responsavel TEXT, documento TEXT,
    email TEXT, telefone TEXT, aluguel_cent INTEGER NOT NULL DEFAULT 0, condominio_cent INTEGER NOT NULL DEFAULT 0, outras_cent INTEGER NOT NULL DEFAULT 0,
    dia_venc INTEGER NOT NULL DEFAULT 5, inicio TEXT, fim TEXT, reajuste_mes INTEGER, indice TEXT, multa_pct REAL NOT NULL DEFAULT 0, juros_pct REAL NOT NULL DEFAULT 0,
    garantia TEXT, ativo INTEGER NOT NULL DEFAULT 1, obs TEXT, externo TEXT, criado_ms INTEGER)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS adm_locatarios_ext ON adm_locatarios(org_id, externo)",
  `CREATE TABLE IF NOT EXISTS adm_documentos (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, titulo TEXT NOT NULL, tipo TEXT, numero TEXT, vence_em TEXT,
    aviso_dias INTEGER NOT NULL DEFAULT 30, link TEXT, obs TEXT, externo TEXT, criado_ms INTEGER)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS adm_documentos_ext ON adm_documentos(org_id, externo)",
  `CREATE TABLE IF NOT EXISTS adm_contas (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, nome TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'BANCO',
    saldo_cent INTEGER NOT NULL DEFAULT 0, saldo_em TEXT NOT NULL, padrao INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1, criado_ms INTEGER)`,
  // Dinheiro que muda de lugar sem ser receita nem despesa: depósito do caixa no banco, ou dinheiro entregue a uma pessoa.
  `CREATE TABLE IF NOT EXISTS adm_transf (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, de_id INTEGER, para_id INTEGER, para_nome TEXT,
    valor_cent INTEGER NOT NULL, data TEXT NOT NULL, obs TEXT, externo TEXT, criado_por TEXT, criado_ms INTEGER)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS adm_transf_ext ON adm_transf(org_id, externo)"
];

const prontos = new WeakSet();
export async function garantirAdmin(env) {
  if (prontos.has(env.DB)) return;
  await garantirFinanceiro(env); // cria fin_lanc com as colunas de conta, locatário e valor pago
  for (const s of DDL_ADMIN) await env.DB.prepare(s).run();
  prontos.add(env.DB);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const re = (s, n = 200) => String(s ?? "").replace(/[\u0000-\u001F]/g, " ").trim().slice(0, n);
const hojeLocal = ms => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
const agoraLocal = ms => new Date(ms - 3 * 3600000).toISOString().slice(11, 16);
const somarDias = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const diasEntre = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
const ultimoDia = mes => { const [a, m] = mes.split("-").map(Number); return new Date(Date.UTC(a, m, 0)).getUTCDate(); };
const somarMes = (mes, n) => { const [a, m] = mes.split("-").map(Number); return new Date(Date.UTC(a, m - 1 + n, 1)).toISOString().slice(0, 7); };
const somarMesesData = (d, n) => { const mes = somarMes(d.slice(0, 7), n); return `${mes}-${String(Math.min(Number(d.slice(8)), ultimoDia(mes))).padStart(2, "0")}`; };
const br = d => d ? String(d).slice(0, 10).split("-").reverse().join("/") : "—";
const horaValida = h => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h || ""));
const emailOk = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ""));
const valorDe = l => l.valor_pago_cent ?? l.valor_cent;
const inteiro = (v, min, max, padrao) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao; };
const pctNum = v => { const n = Number(String(v ?? "").replace(",", ".")); return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : 0; };

// Perfis: cada tipo de empresa já começa com as categorias e as obrigações que fazem sentido.
export const PERFIS = {
  comercial: { nome: "Prédio comercial, shopping ou condomínio", locatarios: true },
  empresa: { nome: "Empresa de serviços ou comércio", locatarios: false },
  temporada: { nome: "Gestão de locação por temporada", locatarios: false },
  pessoal: { nome: "Pessoal, família e imóveis próprios", locatarios: true },
  mei: { nome: "Autônomo ou MEI", locatarios: false }
};
// Obrigações e manutenções (frequência em dias, aviso em dias antes). As do prédio seguem as exigências usuais de
// bombeiros, vigilância sanitária e PMOC; a empresa ajusta a frequência ao que o contrato ou o laudo pedir.
export const MODELOS_ROTINA = [
  ["Extintores: inspeção visual (lacre, pressão, validade)", "Segurança e bombeiros", 30, 7, "Conferir manômetro, lacre e etiqueta de cada extintor.", ["comercial"]],
  ["Extintores: recarga e manutenção", "Segurança e bombeiros", 365, 60, "Empresa certificada pelo Inmetro.", ["comercial", "empresa"]],
  ["Extintores: teste hidrostático", "Segurança e bombeiros", 1825, 60, "", ["comercial"]],
  ["Certificado do Corpo de Bombeiros (CA/AVCB): renovação", "Documentos e licenças", 365, 60, "Começar o processo 60 dias antes do vencimento.", ["comercial", "empresa"]],
  ["Brigada de incêndio: treinamento", "Segurança e bombeiros", 365, 60, "Curso anual; refazer se mais da metade da brigada mudar.", ["comercial"]],
  ["Alarme e detectores de incêndio: teste", "Segurança e bombeiros", 90, 15, "", ["comercial"]],
  ["Iluminação de emergência: teste", "Segurança e bombeiros", 30, 7, "Desligar a energia do circuito e ver se as luzes acendem.", ["comercial"]],
  ["Hidrantes e mangueiras: inspeção", "Segurança e bombeiros", 180, 15, "", ["comercial"]],
  ["Portas corta-fogo: regulagem e molas", "Segurança e bombeiros", 180, 15, "Se houver porta corta-fogo.", ["comercial"]],
  ["Para-raios (SPDA): inspeção e laudo", "Segurança e bombeiros", 365, 60, "", ["comercial"]],
  ["Ar-condicionado: limpeza dos filtros", "Manutenção", 30, 7, "Guardar comprovante ou ordem de serviço.", ["comercial", "empresa", "temporada"]],
  ["Ar-condicionado: manutenção preventiva (PMOC)", "Manutenção", 90, 15, "PMOC é obrigatório (Lei 13.589/2018) quando o ar-condicionado de um ambiente soma mais de 60.000 BTU/h. Empresa com responsável técnico; guardar o plano e os relatórios.", ["comercial", "empresa"]],
  ["Quadros elétricos: revisão", "Manutenção", 180, 15, "Eletricista: reaperto, disjuntores, aquecimento.", ["comercial", "empresa"]],
  ["Bombas d'água: revisão", "Manutenção", 180, 15, "", ["comercial"]],
  ["Calhas, telhado e ralos: limpeza", "Manutenção", 180, 15, "Antes do verão (chuvas).", ["comercial", "pessoal"]],
  ["Limpeza da caixa d'água", "Limpeza e higiene", 180, 15, "Pedir certificado de limpeza e análise da água.", ["comercial", "empresa", "temporada", "pessoal"]],
  ["Dedetização e desratização", "Limpeza e higiene", 90, 15, "Pedir certificado da empresa dedetizadora e arquivar.", ["comercial", "empresa", "temporada"]],
  ["Alvará de funcionamento: renovação/taxa", "Documentos e licenças", 365, 60, "", ["comercial", "empresa"]],
  ["Seguro do prédio: renovação", "Documentos e licenças", 365, 60, "Cotar com 30 dias de antecedência.", ["comercial", "pessoal"]],
  ["Reajuste anual dos contratos de locação", "Financeiro", 365, 60, "Conferir o mês e o índice de reajuste de cada contrato.", ["comercial", "pessoal"]],
  ["Conferir ponto e folha dos funcionários", "Pessoal / RH", 30, 7, "", ["comercial", "empresa"]],
  ["Férias dos funcionários: programar", "Pessoal / RH", 365, 60, "", ["comercial", "empresa"]],
  ["Enxoval: conferir e repor", "Temporada", 90, 7, "Lençóis, toalhas e capas: trocar o que estiver manchado ou gasto.", ["temporada"]],
  ["Revisão geral do apartamento (chuveiro, tomadas, fechaduras)", "Temporada", 90, 7, "", ["temporada"]],
  ["DAS do MEI", "Impostos", 30, 5, "Vence todo dia 20.", ["mei"]],
  ["Declaração anual do MEI (DASN-SIMEI)", "Impostos", 365, 30, "Prazo: 31 de maio.", ["mei"]],
  ["IPTU: conferir carnê ou cota única", "Impostos", 365, 30, "", ["pessoal", "comercial"]]
];


// Dia útil (Brasil): sem sábado, domingo e feriados nacionais (fixos + Carnaval, Sexta-feira Santa e Corpus Christi).
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}
const feriadosCache = new Map();
export function feriado(d) {
  const ano = Number(d.slice(0, 4));
  if (!feriadosCache.has(ano)) {
    const p = pascoa(ano);
    feriadosCache.set(ano, new Set(["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25"].map(x => `${ano}-${x}`).concat([somarDias(p, -48), somarDias(p, -47), somarDias(p, -2), somarDias(p, 60)])));
  }
  return feriadosCache.get(ano).has(d);
}
export const diaUtil = d => { const w = new Date(d + "T12:00:00Z").getUTCDay(); return w !== 0 && w !== 6 && !feriado(d); };
export function proximoDiaUtil(d) { let x = d; for (let i = 0; i < 10 && !diaUtil(x); i++) x = somarDias(x, 1); return x; }
// Dias de atraso: zero se pagou até o próximo dia útil depois do vencimento; se passou disso, conta desde o vencimento.
export const diasDeAtraso = (venc, quando) => quando <= proximoDiaUtil(venc) ? 0 : Math.max(0, diasEntre(venc, quando));

// Multa (%) uma vez + juros (% ao mês, proporcional aos dias) sobre o valor em atraso. Só mostra: nada é cobrado sozinho.
export function encargosAtraso(valorCent, venc, hoje, multaPct, jurosPct) {
  const dias = diasDeAtraso(venc, hoje);
  if (dias <= 0 || (!multaPct && !jurosPct)) return { dias, multa: 0, juros: 0, total: valorCent };
  const multa = Math.round(valorCent * (multaPct || 0) / 100), juros = Math.round(valorCent * (jurosPct || 0) / 100 * dias / 30);
  return { dias, multa, juros, total: valorCent + multa + juros };
}

// ---------------------------------------------------------------------------
// Contas (banco e caixa) e saldos
// ---------------------------------------------------------------------------
async function contasDa(env, orgId) {
  return (await env.DB.prepare("SELECT * FROM adm_contas WHERE org_id=? AND ativo=1 ORDER BY padrao DESC, tipo, id").bind(orgId).all()).results || [];
}
// Para onde foi (ou de onde saiu) o dinheiro de um lançamento: a conta escolhida, ou caixa se foi em dinheiro, ou o banco principal.
export function contaDoLancamento(l, contas) {
  if (l.conta_id && contas.some(c => c.id === l.conta_id)) return l.conta_id;
  if (l.forma === "Dinheiro") { const cx = contas.find(c => c.tipo === "CAIXA"); if (cx) return cx.id; }
  return (contas.find(c => c.tipo === "BANCO" && c.padrao) || contas.find(c => c.tipo === "BANCO") || {}).id || null;
}
// Saldo de cada conta no fim do dia `data`: parte do saldo informado (fim do dia saldo_em) e soma/subtrai o que andou.
export async function saldosNa(env, orgId, data) {
  const contas = await contasDa(env, orgId);
  if (!contas.length) return [];
  const minimo = contas.reduce((m, c) => c.saldo_em < m ? c.saldo_em : m, data), maximo = contas.reduce((m, c) => c.saldo_em > m ? c.saldo_em : m, data);
  const lanc = (await env.DB.prepare("SELECT id, tipo, valor_cent, valor_pago_cent, forma, conta_id, pago_em FROM fin_lanc WHERE org_id=? AND pago=1 AND pago_em > ? AND pago_em <= ?").bind(orgId, minimo, maximo).all()).results || [];
  const tr = (await env.DB.prepare("SELECT * FROM adm_transf WHERE org_id=? AND data > ? AND data <= ?").bind(orgId, minimo, maximo).all()).results || [];
  return contas.map(c => {
    // Movimento entre (a, b]: positivo = entrou na conta.
    const mov = (a, b) => {
      let s = 0;
      for (const l of lanc) if (l.pago_em > a && l.pago_em <= b && contaDoLancamento(l, contas) === c.id) s += (l.tipo === "ENTRADA" ? 1 : -1) * valorDe(l);
      for (const t of tr) if (t.data > a && t.data <= b) { if (t.para_id === c.id) s += t.valor_cent; if (t.de_id === c.id) s -= t.valor_cent; }
      return s;
    };
    const saldo = data >= c.saldo_em ? c.saldo_cent + mov(c.saldo_em, data) : c.saldo_cent - mov(data, c.saldo_em);
    return { id: c.id, nome: c.nome, tipo: c.tipo, padrao: c.padrao, saldo_cent: saldo, base_cent: c.saldo_cent, base_em: c.saldo_em };
  });
}

// ---------------------------------------------------------------------------
// Aluguéis: a cobrança do mês de cada locatário vira um "a receber" no Financeiro (uma vez só).
// ---------------------------------------------------------------------------
export async function gerarCobrancas(env, orgId, mes, agoraMs) {
  await garantirAdmin(env);
  const fimMes = `${mes}-${String(ultimoDia(mes)).padStart(2, "0")}`;
  const ls = (await env.DB.prepare("SELECT * FROM adm_locatarios WHERE org_id=? AND ativo=1 AND (inicio IS NULL OR inicio <= ?) AND (fim IS NULL OR fim = '' OR fim >= ?)").bind(orgId, fimMes, mes + "-01").all()).results || [];
  let n = 0;
  for (const l of ls) {
    const total = (l.aluguel_cent || 0) + (l.condominio_cent || 0) + (l.outras_cent || 0);
    if (total <= 0) continue;
    const data = `${mes}-${String(Math.min(Math.max(1, l.dia_venc || 5), ultimoDia(mes))).padStart(2, "0")}`;
    const r = await env.DB.prepare(`INSERT OR IGNORE INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,contato,locatario_id,competencia,origem,chave_externa,criado_por,criado_ms,atualizado_ms)
      VALUES(?,'ENTRADA',?,?,'Aluguéis recebidos',?,0,?,?,?,'aluguel',?,'DENIA',?,?)`)
      .bind(orgId, `Aluguel ${nomeMes(mes)}${l.unidade ? " — " + l.unidade : ""} — ${l.nome}`, total, data, l.nome, l.id, mes, `alug:${l.id}:${mes}`, agoraMs, agoraMs).run();
    if (r.meta?.changes) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Rotinas: próxima data = última + frequência (ou a data informada).
// ---------------------------------------------------------------------------
const proximaDe = r => r.proxima || (r.ultima ? somarDias(r.ultima, r.dias || 30) : null);
function situacaoRotina(r, hoje) {
  const p = proximaDe(r);
  if (!p) return { proxima: null, situacao: "SEM_DATA", dias: null };
  const d = diasEntre(hoje, p);
  return { proxima: p, situacao: d < 0 ? "VENCIDA" : d <= (r.aviso_dias || 7) ? "PROXIMA" : "EM_DIA", dias: d };
}

// ---------------------------------------------------------------------------
// O dia (central executiva): tudo que precisa de atenção hoje, sem precisar abrir cada área.
// ---------------------------------------------------------------------------
export async function oDia(env, orgId, agoraMs) {
  await garantirAdmin(env);
  const hoje = hojeLocal(agoraMs), semana = somarDias(hoje, 7), mes = hoje.slice(0, 7);
  await gerarCobrancas(env, orgId, mes, agoraMs);
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
  const agenda = await q("SELECT * FROM adm_agenda WHERE org_id=? AND feito=0 AND data <= ? ORDER BY data, COALESCE(hora,'99:99') LIMIT 100", orgId, semana);
  const contas = await q("SELECT id, tipo, descricao, valor_cent, data, contato, categoria, locatario_id FROM fin_lanc WHERE org_id=? AND pago=0 AND data <= ? ORDER BY data LIMIT 200", orgId, semana);
  const rotinas = (await q("SELECT * FROM adm_rotinas WHERE org_id=? AND ativo=1", orgId)).map(r => ({ ...r, ...situacaoRotina(r, hoje) }))
    .filter(r => r.situacao === "VENCIDA" || r.situacao === "PROXIMA").sort((a, b) => (a.proxima || "").localeCompare(b.proxima || ""));
  const semData = (await q("SELECT COUNT(*) n FROM adm_rotinas WHERE org_id=? AND ativo=1 AND ultima IS NULL AND proxima IS NULL", orgId))[0]?.n || 0;
  const documentos = (await q("SELECT * FROM adm_documentos WHERE org_id=? AND vence_em IS NOT NULL AND vence_em <> ''", orgId))
    .map(d => ({ ...d, dias: diasEntre(hoje, d.vence_em) })).filter(d => d.dias <= (d.aviso_dias || 30)).sort((a, b) => a.dias - b.dias);
  let temporada = [];
  try {
    temporada = await q(`SELECT r.id, r.hospede, r.inicio, r.fim, r.canal, i.nome AS imovel FROM plt_tp_reservas r JOIN plt_tp_imoveis i ON i.id=r.imovel_id
      WHERE r.org_id=? AND r.status <> 'CANCELADA' AND r.tipo='RESERVA' AND (r.inicio BETWEEN ? AND ? OR r.fim BETWEEN ? AND ?) ORDER BY r.inicio LIMIT 50`, orgId, hoje, somarDias(hoje, 2), hoje, somarDias(hoje, 2));
  } catch { /* sem temporada */ }
  const saldos = await saldosNa(env, orgId, hoje);
  const soma = (ls, f) => ls.filter(f).reduce((s, l) => s + l.valor_cent, 0);
  return {
    hoje, agora: agoraLocal(agoraMs),
    agenda: agenda.map(a => ({ ...a, atrasado: a.data < hoje })),
    contas: contas.map(c => ({ ...c, vencida: c.data < hoje })),
    rotinas, rotinas_sem_data: semData, documentos, temporada, saldos,
    totais: {
      pagar_vencido: soma(contas, c => c.tipo === "SAIDA" && c.data < hoje), pagar_semana: soma(contas, c => c.tipo === "SAIDA" && c.data >= hoje),
      receber_vencido: soma(contas, c => c.tipo === "ENTRADA" && c.data < hoje), receber_semana: soma(contas, c => c.tipo === "ENTRADA" && c.data >= hoje),
      agenda_hoje: agenda.filter(a => a.data === hoje).length, agenda_atrasada: agenda.filter(a => a.data < hoje).length,
      rotinas_vencidas: rotinas.filter(r => r.situacao === "VENCIDA").length
    }
  };
}
export function textoDoDia(d, empresa, moeda = "BRL") {
  const f = c => dinheiro(c, moeda), L = [`Bom dia! O dia de ${br(d.hoje)}${empresa ? " — " + empresa : ""}:`, ""];
  const hojeA = d.agenda.filter(a => a.data === d.hoje), atr = d.agenda.filter(a => a.atrasado);
  if (hojeA.length) L.push("Compromissos de hoje:", ...hojeA.map(a => `• ${a.hora ? a.hora + " " : ""}${a.titulo}${a.local ? " (" + a.local + ")" : ""}`), "");
  if (atr.length) L.push("Ficaram para trás:", ...atr.map(a => `• ${br(a.data)} ${a.titulo}`), "");
  const venc = d.contas.filter(c => c.vencida), hojeC = d.contas.filter(c => c.data === d.hoje);
  if (hojeC.length) L.push("Vence hoje:", ...hojeC.map(c => `• ${c.tipo === "ENTRADA" ? "Receber" : "Pagar"} ${c.descricao}: ${f(c.valor_cent)}`), "");
  if (venc.length) L.push(`Vencidas: ${venc.length} (a pagar ${f(d.totais.pagar_vencido)} · a receber ${f(d.totais.receber_vencido)})`, "");
  if (d.rotinas.length) L.push("Manutenção e obrigações:", ...d.rotinas.slice(0, 10).map(r => `• ${r.titulo}: ${r.situacao === "VENCIDA" ? `vencida desde ${br(r.proxima)}` : `vence ${br(r.proxima)}`}`), "");
  if (d.documentos.length) L.push("Documentos:", ...d.documentos.map(x => `• ${x.titulo}: ${x.dias < 0 ? "venceu em" : "vence em"} ${br(x.vence_em)}`), "");
  if (d.temporada.length) L.push("Temporada (hoje a depois de amanhã):", ...d.temporada.map(t => `• ${t.inicio >= d.hoje && t.inicio <= somarDias(d.hoje, 2) ? `Entrada ${br(t.inicio)}` : `Saída ${br(t.fim)}`}: ${t.hospede || "hóspede"} — ${t.imovel}`), "");
  if (d.saldos.length) L.push("Saldos de hoje:", ...d.saldos.map(s => `• ${s.nome}: ${f(s.saldo_cent)}`), "");
  if (L.length <= 2) L.push("Nada pendente para hoje. 🙂");
  return L.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Relatório do mês no layout aprovado
// ---------------------------------------------------------------------------
export async function relatorioDoMes(env, orgId, mes, agoraMs) {
  await garantirAdmin(env);
  const ini = mes + "-01", fim = `${mes}-${String(ultimoDia(mes)).padStart(2, "0")}`, hoje = hojeLocal(agoraMs);
  const corte = fim < hoje ? fim : hoje;
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
  const pagos = await q("SELECT * FROM fin_lanc WHERE org_id=? AND pago=1 AND pago_em BETWEEN ? AND ? ORDER BY pago_em, id", orgId, ini, fim);
  const agrupar = tipo => {
    const g = new Map();
    for (const l of pagos.filter(x => x.tipo === tipo)) { const c = l.categoria || (tipo === "ENTRADA" ? "Outras receitas" : "Outras despesas"); if (!g.has(c)) g.set(c, []); g.get(c).push(l); }
    return [...g.entries()].map(([categoria, itens]) => ({ categoria, total: itens.reduce((s, l) => s + valorDe(l), 0), itens })).sort((a, b) => b.total - a.total);
  };
  const entradas = agrupar("ENTRADA"), saidas = agrupar("SAIDA");
  const entrou = entradas.reduce((s, g) => s + g.total, 0), saiu = saidas.reduce((s, g) => s + g.total, 0);
  // Em aberto no fim do mês: vencia até o fim do mês e não estava pago naquele dia.
  const abertos = await q("SELECT * FROM fin_lanc WHERE org_id=? AND data <= ? AND (pago=0 OR pago_em > ?) ORDER BY data, id", orgId, fim, fim);
  const receber = abertos.filter(l => l.tipo === "ENTRADA"), pagar = abertos.filter(l => l.tipo === "SAIDA");
  const doMes = ls => ls.filter(l => l.data >= ini), antes = ls => ls.filter(l => l.data < ini);
  const soma = ls => ls.reduce((s, l) => s + l.valor_cent, 0);
  // Aluguéis recebidos no mês depois do vencimento (passado o próximo dia útil), pelo valor original: sem multa nem juros.
  const multaDe = new Map(((await q("SELECT id, multa_pct, juros_pct FROM adm_locatarios WHERE org_id=?", orgId))).map(x => [x.id, x]));
  // Pagamento dividido em formas (dinheiro + Pix) vira um só: a multa e os juros do contrato valem sobre o aluguel inteiro.
  const juntos = new Map();
  for (const l of pagos.filter(x => x.tipo === "ENTRADA" && x.locatario_id)) {
    const k = l.chave_externa ? l.chave_externa.replace(/#\d+$/, "") : "id" + l.id, j = juntos.get(k);
    if (j) { const pago = valorDe(j) + valorDe(l); j.valor_cent += l.valor_cent; j.valor_pago_cent = pago; } else juntos.set(k, { ...l });
  }
  const atrasados = [...juntos.values()].filter(l => diasDeAtraso(l.data, l.pago_em) > 0 && valorDe(l) <= l.valor_cent)
    .map(l => { const loc = multaDe.get(l.locatario_id) || {}, e = encargosAtraso(l.valor_cent, l.data, l.pago_em, loc.multa_pct, loc.juros_pct); return { ...l, dias: e.dias, deixou_cent: e.multa + e.juros }; });
  const saldos = await saldosNa(env, orgId, fim);
  const banco = saldos.filter(s => s.tipo === "BANCO"), caixa = saldos.filter(s => s.tipo === "CAIXA");
  const tr = await q("SELECT t.*, c.nome AS de_nome, p.nome AS para_conta FROM adm_transf t LEFT JOIN adm_contas c ON c.id=t.de_id LEFT JOIN adm_contas p ON p.id=t.para_id WHERE t.org_id=? AND t.data BETWEEN ? AND ? ORDER BY t.data", orgId, ini, fim);
  // Pontos a conferir: só fatos que a pessoa precisa olhar — nada de suposição.
  const conferir = [];
  if (!saldos.length) conferir.push("Cadastre a conta do banco e o saldo de um dia conhecido (Administração → Banco e caixa) para o relatório mostrar o saldo no banco.");
  for (const s of banco) if (s.base_em > fim) conferir.push(`O saldo de ${s.nome} foi informado em ${br(s.base_em)}, depois deste mês: o saldo de ${br(fim)} foi calculado para trás com os lançamentos. Confira com o extrato.`);
  const semCat = pagos.filter(l => !l.categoria || /^(outros|outras despesas)$/i.test(l.categoria));
  if (semCat.length) conferir.push(`${semCat.length} lançamento(s) em "Outros"/sem categoria (${dinheiro(semCat.reduce((s, l) => s + valorDe(l), 0))}). Vale classificar.`);
  const dinheiroSemDestino = pagos.filter(l => l.tipo === "ENTRADA" && l.forma === "Dinheiro");
  if (dinheiroSemDestino.length && caixa.length) conferir.push(`Entrou ${dinheiro(dinheiroSemDestino.reduce((s, l) => s + valorDe(l), 0))} em dinheiro no mês. Confirme onde está esse dinheiro (caixa, depósito ou entregue a alguém).`);
  const vencRec = antes(receber);
  if (vencRec.length) conferir.push(`${vencRec.length} cobrança(s) de meses anteriores continuam em aberto (${dinheiro(soma(vencRec))}).`);
  const acima = pagos.filter(l => l.tipo === "SAIDA").sort((a, b) => valorDe(b) - valorDe(a))[0];
  if (acima && saiu && valorDe(acima) >= saiu * 0.3) conferir.push(`A maior saída foi "${acima.descricao}" (${dinheiro(valorDe(acima))}), ${Math.round(100 * valorDe(acima) / saiu)}% de tudo que saiu.`);
  return {
    mes, nome: nomeMes(mes), inicio: ini, fim, corte, entrou, saiu, resultado: entrou - saiu, entradas, saidas,
    banco_cent: banco.reduce((s, b) => s + b.saldo_cent, 0), caixa_cent: caixa.reduce((s, b) => s + b.saldo_cent, 0), saldos,
    receber: { mes: doMes(receber), antes: antes(receber), total: soma(receber), total_mes: soma(doMes(receber)), total_antes: soma(antes(receber)) },
    pagar: { mes: doMes(pagar), antes: antes(pagar), total: soma(pagar) },
    atrasados, atrasados_total: atrasados.reduce((s, l) => s + valorDe(l), 0), atrasados_deixou: atrasados.reduce((s, l) => s + l.deixou_cent, 0), transferencias: tr, conferir
  };
}

export function pdfRelatorioMes(r, empresa, { moeda = "BRL", assinaturas = [], cidade = "", logo = null } = {}) {
  const f = c => dinheiro(c, moeda);
  const blocos = [];
  const metr = [
    { rotulo: "Entrou", valor: f(r.entrou), nota: "Recebido no mês", cor: "#16a34a" },
    { rotulo: "Saiu", valor: f(r.saiu), nota: "Pago no mês", cor: "#dc2626" },
    { rotulo: "Resultado", valor: f(r.resultado), nota: r.resultado >= 0 ? "Sobrou no mês" : "Faltou no mês", cor: r.resultado >= 0 ? "#2563eb" : "#dc2626" },
    { rotulo: "Saldo no banco", valor: r.saldos.some(s => s.tipo === "BANCO") ? f(r.banco_cent) : "—", nota: `Em ${br(r.fim)}`, cor: "#0f766e" }
  ];
  if (r.caixa_cent) metr.push({ rotulo: "Dinheiro em caixa", valor: f(r.caixa_cent), nota: `Em espécie em ${br(r.fim)}`, cor: "#a16207" });
  blocos.push({ tipo: "metricas", itens: metr });
  const tabelaGrupos = (titulo, grupos, total) => {
    const linhas = [];
    for (const g of grupos) {
      linhas.push({ celulas: [g.categoria, "", "", f(g.total)], negrito: true, fundo: "#eef2f7" });
      for (const l of g.itens) linhas.push([`   ${l.descricao}`, br(l.pago_em), l.forma || "", f(valorDe(l))]);
    }
    linhas.push({ celulas: [`Total de ${titulo.toLowerCase()}`, "", "", f(total)], negrito: true, fundo: "#e5e7eb" });
    return { tipo: "tabela", colunas: ["Descrição", "Data", "Forma", "Valor"], larguras: [3.4, 0.9, 1, 1.2], alinharDireita: [3], linhas };
  };
  const tabelas = [];
  tabelas.push({ titulo: "Entradas", t: r.entradas.length ? tabelaGrupos("Entradas", r.entradas, r.entrou) : null, vazio: "Nenhuma entrada recebida no mês." });
  tabelas.push({ titulo: "Saídas", t: r.saidas.length ? tabelaGrupos("Saídas", r.saidas, r.saiu) : null, vazio: "Nenhuma saída paga no mês." });
  const lab = r.receber;
  if (lab.total) {
    const linhas = [];
    if (lab.mes.length) { linhas.push({ celulas: [`Do mês (${r.nome})`, "", "", f(lab.total_mes)], negrito: true, fundo: "#eef2f7" }); for (const l of lab.mes) linhas.push([`   ${l.descricao}`, br(l.data), l.contato || "", f(l.valor_cent)]); }
    if (lab.antes.length) { linhas.push({ celulas: ["De meses anteriores", "", "", f(lab.total_antes)], negrito: true, fundo: "#eef2f7" }); for (const l of lab.antes) linhas.push([`   ${l.descricao}`, br(l.data), l.contato || "", f(l.valor_cent)]); }
    linhas.push({ celulas: ["Total em aberto", "", "", f(lab.total)], negrito: true, fundo: "#e5e7eb" });
    tabelas.push({ titulo: `Em aberto em ${br(r.fim)} (a receber)`, t: { tipo: "tabela", colunas: ["Descrição", "Vencimento", "Quem", "Valor"], larguras: [3, 1, 1.3, 1.2], alinharDireita: [3], linhas } });
  }
  if (r.pagar.total) tabelas.push({ titulo: `Contas a pagar em aberto em ${br(r.fim)}`, t: { tipo: "tabela", colunas: ["Descrição", "Vencimento", "Valor"], larguras: [3.6, 1, 1.2], alinharDireita: [2],
    linhas: [...[...r.pagar.antes, ...r.pagar.mes].map(l => [l.descricao, br(l.data), f(l.valor_cent)]), { celulas: ["Total a pagar", "", f(r.pagar.total)], negrito: true, fundo: "#e5e7eb" }] } });
  if (r.atrasados.length) tabelas.push({ titulo: "Pagos com atraso, sem multa e juros", t: { tipo: "tabela", colunas: ["Pago em", "Quem", "Dias", "Aluguel", "Multa + juros (contrato)"], larguras: [0.9, 2.6, 0.6, 1.1, 1.5], alinharDireita: [2, 3, 4],
    linhas: [...r.atrasados.map(l => [br(l.pago_em), l.contato || l.descricao, String(l.dias), f(valorDe(l)), f(l.deixou_cent)]), { celulas: ["Total", `${r.atrasados.length} pagos com atraso`, "", f(r.atrasados_total), f(r.atrasados_deixou)], negrito: true, fundo: "#e5e7eb" }] } });
  // A assinatura fica logo abaixo da última tabela, na mesma página.
  const SIG = 112;
  tabelas.forEach((x, i) => {
    blocos.push({ tipo: "titulo", texto: x.titulo });
    if (x.t) blocos.push(i === tabelas.length - 1 ? { ...x.t, reservaFim: SIG } : x.t);
    else blocos.push({ tipo: "texto", texto: x.vazio });
  });
  blocos.push({ tipo: "assinatura", local: `${cidade ? cidade + ", " : ""}____ de ______________ de ${r.mes.slice(0, 4)}.`, nomes: assinaturas.length ? assinaturas : ["Responsável pela administração", "Proprietário"] });
  // Próxima página: explicação simples e o que conferir.
  blocos.push({ tipo: "quebra" }, { tipo: "titulo", texto: "Como ler este relatório" });
  const exp = [
    `Entrou (${f(r.entrou)}) é tudo que foi recebido de ${br(r.inicio)} a ${br(r.fim)}, pela data em que o dinheiro entrou. Saiu (${f(r.saiu)}) é tudo que foi pago no mesmo período.`,
    `Resultado (${f(r.resultado)}) é Entrou menos Saiu. ${r.resultado >= 0 ? "Positivo: sobrou dinheiro no mês." : "Negativo: saiu mais do que entrou no mês."}`,
    r.saldos.length ? `Saldo no banco é o saldo calculado de cada conta no fim do dia ${br(r.fim)}: ${r.saldos.map(s => `${s.nome} ${f(s.saldo_cent)}`).join("; ")}. Depósitos do caixa no banco não contam como entrada nem saída.` : "O saldo no banco aparece quando a conta e um saldo conhecido forem cadastrados.",
    lab.total ? `Em aberto (${f(lab.total)}) são cobranças que venciam até ${br(r.fim)} e não estavam pagas nesse dia: ${f(lab.total_mes)} do mês e ${f(lab.total_antes)} de meses anteriores.` : "Não havia cobranças em aberto no fim do mês.",
    r.atrasados.length ? `Pagos com atraso: ${r.atrasados.length} aluguel(éis), somando ${f(r.atrasados_total)}, foram pagos depois do vencimento (contando o próximo dia útil) pelo valor original. Pela multa e pelos juros de cada contrato, deixaram de ser cobrados ${f(r.atrasados_deixou)}.` : "Nenhum aluguel foi pago com atraso no mês."
  ];
  if (r.transferencias.length) exp.push(`Movimentos entre contas no mês (não são entrada nem saída): ${r.transferencias.map(t => `${br(t.data)} ${t.de_nome || "?"} → ${t.para_conta || t.para_nome || "?"} ${f(t.valor_cent)}`).join("; ")}.`);
  blocos.push({ tipo: "lista", itens: exp.map(t => ({ texto: t })) });
  blocos.push({ tipo: "titulo", texto: "Pontos a conferir" });
  blocos.push(r.conferir.length ? { tipo: "lista", itens: r.conferir.map(t => ({ texto: t, cor: "#d97706" })) } : { tipo: "texto", texto: "Nada a conferir: todos os lançamentos do mês têm categoria e as contas estão com saldo informado." });
  return gerarPdf({ titulo: "Relatório do mês", subtitulo: `${empresa ? empresa + " · " : ""}${r.nome}`, rodape: "DENIA · valores conforme lançados na plataforma", corPrincipal: "#1e3a8a", logo, blocos });
}

// ---------------------------------------------------------------------------
// Calendário (iCal) para assinar no celular: agenda, contas, obrigações e documentos com alarme.
// ---------------------------------------------------------------------------
const icalEsc = s => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icalDia = d => d.replace(/-/g, "");
export async function icalAdmin(env, caminho, agoraMs = Date.now()) {
  const m = /^\/adm\/ical\/([A-Za-z0-9_-]{20,80})\.ics$/.exec(caminho);
  if (!m) return null;
  await garantirAdmin(env);
  const c = await env.DB.prepare("SELECT org_id FROM adm_config WHERE ical_token=?").bind(m[1]).first();
  if (!c) return null;
  const org = c.org_id, hoje = hojeLocal(agoraMs), de = somarDias(hoje, -60), ate = somarDias(hoje, 400);
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
  const ev = [];
  const alarme = (gatilho, txt) => ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icalEsc(txt)}`, `TRIGGER:${gatilho}`, "END:VALARM"];
  const diaInteiro = (uid, data, titulo, desc, alarmes) => ev.push("BEGIN:VEVENT", `UID:${uid}@denia`, `DTSTAMP:${icalDia(hoje)}T000000Z`, `DTSTART;VALUE=DATE:${icalDia(data)}`, `DTEND;VALUE=DATE:${icalDia(somarDias(data, 1))}`, `SUMMARY:${icalEsc(titulo)}`, desc ? `DESCRIPTION:${icalEsc(desc)}` : null, ...alarmes, "END:VEVENT");
  for (const a of await q("SELECT * FROM adm_agenda WHERE org_id=? AND data BETWEEN ? AND ?", org, de, ate)) {
    if (a.hora) {
      const ini = `${icalDia(a.data)}T${a.hora.replace(":", "")}00`, fimMs = Date.parse(`${a.data}T${a.hora}:00Z`) + (a.duracao_min || 60) * 60000;
      const fim = new Date(fimMs).toISOString().replace(/[-:]/g, "").slice(0, 15);
      ev.push("BEGIN:VEVENT", `UID:adm-ag-${a.id}@denia`, `DTSTAMP:${icalDia(hoje)}T000000Z`, `DTSTART;TZID=America/Sao_Paulo:${ini}`, `DTEND;TZID=America/Sao_Paulo:${fim}`, `SUMMARY:${icalEsc((a.feito ? "✓ " : "") + a.titulo)}`,
        a.local ? `LOCATION:${icalEsc(a.local)}` : null, a.obs ? `DESCRIPTION:${icalEsc(a.obs)}` : null, ...(a.feito ? [] : alarme(`-PT${Math.max(0, a.aviso_min || 0)}M`, a.titulo)), "END:VEVENT");
    } else diaInteiro(`adm-ag-${a.id}`, a.data, (a.feito ? "✓ " : "") + a.titulo, a.obs, a.feito ? [] : alarme("PT9H", a.titulo));
  }
  for (const l of await q("SELECT id, tipo, descricao, valor_cent, data FROM fin_lanc WHERE org_id=? AND pago=0 AND data BETWEEN ? AND ?", org, de, ate))
    diaInteiro(`adm-fin-${l.id}`, l.data, `${l.tipo === "ENTRADA" ? "Receber" : "Pagar"}: ${l.descricao} (${dinheiro(l.valor_cent)})`, "", [...alarme("-PT15H", "Vence amanhã: " + l.descricao), ...alarme("PT9H", "Vence hoje: " + l.descricao)]);
  for (const r of await q("SELECT * FROM adm_rotinas WHERE org_id=? AND ativo=1", org)) {
    const p = proximaDe(r); if (!p || p > ate) continue;
    diaInteiro(`adm-rot-${r.id}-${p}`, p < hoje ? hoje : p, `Manutenção: ${r.titulo}${p < hoje ? " (vencida)" : ""}`, [r.fornecedor, r.telefone, r.obs].filter(Boolean).join(" · "),
      [...alarme(`-P${Math.max(1, r.aviso_dias || 7)}D`, `Agendar: ${r.titulo}`), ...alarme("-PT15H", `Amanhã: ${r.titulo}`), ...alarme("PT9H", r.titulo)]);
  }
  for (const d of await q("SELECT * FROM adm_documentos WHERE org_id=? AND vence_em BETWEEN ? AND ?", org, de, ate))
    diaInteiro(`adm-doc-${d.id}`, d.vence_em, `Vence: ${d.titulo}`, d.obs, [...alarme(`-P${Math.max(1, d.aviso_dias || 30)}D`, `Renovar: ${d.titulo}`), ...alarme("PT9H", `Vence hoje: ${d.titulo}`)]);
  const corpo = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DENIA//Administracao//PT", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:DENIA — Administração", "X-WR-TIMEZONE:America/Sao_Paulo",
    "BEGIN:VTIMEZONE", "TZID:America/Sao_Paulo", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:-0300", "TZOFFSETTO:-0300", "TZNAME:-03", "END:STANDARD", "END:VTIMEZONE",
    ...ev.filter(Boolean), "END:VCALENDAR"].join("\r\n");
  return new Response(corpo, { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" } });
}

// ---------------------------------------------------------------------------
// Importar da Central Administrativa (arquivo JSON exportado): lojistas, cobranças, contas, recebimentos,
// movimentos, rotinas, serviços, agenda, documentos e o saldo do banco. Pode rodar de novo: não duplica.
// ---------------------------------------------------------------------------
const isDeposito = (para, tipo) => tipo === "banco" || tipo === "deposito" || /banco|c6|dep[oó]sit|conta corrente|ag[eê]ncia/i.test(String(para || ""));
export async function importarCentral(env, orgId, dados, quem, agoraMs) {
  await garantirAdmin(env);
  const lista = v => Array.isArray(v) ? v : v && typeof v === "object" ? Object.entries(v).map(([id, d]) => ({ id, ...d })) : [];
  const cents = v => { const c = centavos(v); return c === null ? 0 : Math.abs(c); };
  const vazio = v => v === null || v === undefined || v === ""; // na Central, multa/juros vazios = padrão do painel (10% e 1% ao mês)
  const dt = v => dataValida(String(v || "").slice(0, 10)) ? String(v).slice(0, 10) : null;
  const n = { locatarios: 0, cobrancas: 0, contas: 0, recebimentos: 0, movimentos: 0, rotinas: 0, servicos: 0, agenda: 0, documentos: 0, transferencias: 0, ignorados: 0, fora_da_conta: 0 };
  // Contas: banco (com o saldo informado na Central) e caixa.
  let contas = await contasDa(env, orgId);
  const bancoCfg = dados.config?.banco || dados.banco;
  if (!contas.some(c => c.tipo === "BANCO")) {
    const saldoEm = dt(bancoCfg?.saldoEm) || hojeLocal(agoraMs);
    await env.DB.prepare("INSERT INTO adm_contas(org_id,nome,tipo,saldo_cent,saldo_em,padrao,criado_ms) VALUES(?,?,'BANCO',?,?,1,?)").bind(orgId, re(bancoCfg?.conta, 60) || "Banco", cents(bancoCfg?.saldo), saldoEm, agoraMs).run();
  }
  if (!contas.some(c => c.tipo === "CAIXA")) await env.DB.prepare("INSERT INTO adm_contas(org_id,nome,tipo,saldo_cent,saldo_em,padrao,criado_ms) VALUES(?,'Dinheiro em espécie (caixa)','CAIXA',?,?,0,?)").bind(orgId, cents(bancoCfg?.caixaSaldo), dt(bancoCfg?.caixaEm) || "2000-01-01", agoraMs).run();
  contas = await contasDa(env, orgId);
  const banco = contas.find(c => c.tipo === "BANCO"), caixa = contas.find(c => c.tipo === "CAIXA");
  // Locatários (lojistas).
  const mapaLoc = new Map();
  for (const l of lista(dados.lojistas)) {
    if (!re(l.nome)) { n.ignorados++; continue; }
    const unidade = re([l.espacoTipo, l.numero].filter(Boolean).join(" "), 60);
    const r = await env.DB.prepare(`INSERT INTO adm_locatarios(org_id,nome,unidade,responsavel,documento,email,telefone,aluguel_cent,condominio_cent,outras_cent,dia_venc,inicio,fim,indice,reajuste_mes,multa_pct,juros_pct,garantia,ativo,obs,externo,criado_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id, externo) DO UPDATE SET nome=excluded.nome, unidade=excluded.unidade, aluguel_cent=excluded.aluguel_cent, condominio_cent=excluded.condominio_cent,
      outras_cent=excluded.outras_cent, dia_venc=excluded.dia_venc, fim=excluded.fim, ativo=excluded.ativo RETURNING id`)
      .bind(orgId, re(l.nome, 120), unidade || null, re(l.responsavel, 120) || null, re(l.documento, 30) || null, emailOk(l.email) ? l.email : null, re(l.telefone, 30) || null,
        cents(l.aluguel), cents(l.condominio), cents(l.outras), inteiro(l.diaVenc, 1, 31, 5), dt(l.contratoInicio), dt(l.contratoFim), re(l.reajusteIndice, 20) || null,
        inteiro(l.reajusteMes, 1, 12, null), pctNum(vazio(l.multa) ? dados.config?.geral?.multa ?? 10 : l.multa), pctNum(vazio(l.juros) ? dados.config?.geral?.juros ?? 1 : l.juros), re([l.garantia, l.garantiaDetalhe].filter(Boolean).join(" — "), 120) || null, l.ativa === false ? 0 : 1, re(l.obs, 500) || null, `central:${l.id}`, agoraMs).first();
    mapaLoc.set(l.id, { id: r.id, nome: re(l.nome, 120), unidade });
    n.locatarios++;
  }
  const lancar = async (o) => {
    const r = await env.DB.prepare(`INSERT OR IGNORE INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,pago_em,forma,contato,obs,origem,chave_externa,criado_por,criado_ms,atualizado_ms,conta_id,locatario_id,competencia,valor_pago_cent,centro)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'central',?,?,?,?,?,?,?,?,?)`)
      .bind(orgId, o.tipo, re(o.descricao, 160) || "Lançamento", o.valor_cent, re(o.categoria, 60) || null, o.data, o.pago ? 1 : 0, o.pago ? o.pago_em || o.data : null, re(o.forma, 30) || null, re(o.contato, 120) || null, re(o.obs, 500) || null,
        o.chave, quem, agoraMs, agoraMs, o.forma === "Dinheiro" ? caixa.id : null, o.locatario_id || null, o.competencia || null, o.pago && o.valor_pago_cent !== undefined && o.valor_pago_cent !== o.valor_cent ? o.valor_pago_cent : null, re(o.centro, 60) || null).run();
    return Boolean(r.meta?.changes);
  };
  // Dinheiro em espécie que saiu do caixa: depósito no banco ou entregue a uma pessoa.
  const entrega = async (x, col, valor) => {
    if (!(x.entregue && valor > 0 && dt(x.entregueEm) && re(x.entreguePara))) return;
    const dep = isDeposito(x.entreguePara, x.entregueTipo);
    const r = await env.DB.prepare("INSERT OR IGNORE INTO adm_transf(org_id,de_id,para_id,para_nome,valor_cent,data,obs,externo,criado_por,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(orgId, caixa.id, dep ? banco.id : null, dep ? null : re(x.entreguePara, 80), valor, dt(x.entregueEm), "Importado da Central", `central:entrega:${col}:${x.id}`, quem, agoraMs).run();
    if (r.meta?.changes) n.transferencias++;
  };
  // Recebido em mais de uma forma (ex.: parte em dinheiro, parte no Pix): um lançamento por forma, para o caixa e o banco baterem.
  const recebido = async (base, c, contar) => {
    const pago = c.status === "recebida", vp = pago && Number(c.valorPago) > 0 ? cents(c.valorPago) : undefined;
    const formas = Array.isArray(c.formas) && c.formas.length > 1 ? c.formas.filter(f => Number(f.valor) > 0) : null;
    if (pago && formas && formas.length > 1) {
      const total = formas.reduce((s, f) => s + cents(f.valor), 0);
      let ok = false, resto = base.valor_cent;
      for (const [i, f] of formas.entries()) {
        const parte = i === formas.length - 1 ? resto : Math.round(base.valor_cent * cents(f.valor) / (total || 1)); resto -= parte;
        if (await lancar({ ...base, descricao: `${base.descricao} (${String(f.forma || "").toLowerCase()})`, valor_cent: parte, forma: f.forma, pago, pago_em: dt(c.recebidoEm), chave: `${base.chave}${i ? "#" + i : ""}`, valor_pago_cent: cents(f.valor) })) ok = true;
      }
      if (ok) contar();
    } else if (await lancar({ ...base, forma: c.forma, pago, pago_em: dt(c.recebidoEm), valor_pago_cent: vp })) contar();
    if (pago) await entrega(c, base.chave.split(":")[1], cents(formas ? formas.filter(f => f.forma === "Dinheiro").reduce((s, f) => s + Number(f.valor || 0), 0) : c.forma === "Dinheiro" ? c.valorPago || c.valor : 0));
  };
  for (const c of lista(dados.cobrancas)) {
    const loc = mapaLoc.get(c.lojistaId), v = cents(c.valor), venc = dt(c.venc);
    if (c.status === "isenta" || c.status === "cancelada" || !v || !venc) { n.ignorados++; continue; }
    const ref = c.semana ? `semanal (venc. ${br(venc)})` : mesValido(c.competencia) ? nomeMes(c.competencia) : "";
    await recebido({ tipo: "ENTRADA", descricao: `Aluguel ${ref}${loc?.unidade ? " — " + loc.unidade : ""} — ${loc?.nome || "locatário"}`.replace("Aluguel  —", "Aluguel —"),
      valor_cent: v, categoria: "Aluguéis recebidos", data: venc, contato: loc?.nome, obs: c.obs, chave: `central:cob:${c.id}`,
      locatario_id: loc?.id, competencia: mesValido(c.competencia) ? c.competencia : venc.slice(0, 7) }, c, () => n.cobrancas++);
  }
  for (const c of lista(dados.receber)) {
    const v = cents(c.valor), venc = dt(c.venc); if (!v || !venc) { n.ignorados++; continue; }
    await recebido({ tipo: "ENTRADA", descricao: c.desc, valor_cent: v, categoria: c.categoria || "Outras receitas", data: venc, contato: c.pagador, obs: c.obs, chave: `central:rec:${c.id}` }, c, () => n.recebimentos++);
  }
  for (const c of lista(dados.contas)) {
    const v = cents(c.valor), venc = dt(c.venc); if (!v || !venc) { n.ignorados++; continue; }
    const pago = c.status === "paga";
    // "Paga fora da conta" na Central não entra nos números (ex.: paga por outra pessoa): fica de fora aqui também.
    if (pago && c.foraDaConta) { n.fora_da_conta++; continue; }
    if (await lancar({ tipo: "SAIDA", descricao: c.desc, valor_cent: v, categoria: c.categoria, data: venc, pago, pago_em: dt(c.pagoEm), forma: c.forma, contato: c.fornecedor, obs: c.obs, chave: `central:conta:${c.id}`, valor_pago_cent: pago && Number(c.valorPago) > 0 ? cents(c.valorPago) : undefined })) n.contas++;
  }
  for (const m of lista(dados.movimentos)) {
    const v = cents(m.valor), d = dt(m.data); if (!v || !d || m.vinculo || m.ignorado) { n.ignorados++; continue; }
    if (await lancar({ tipo: m.tipo === "entrada" ? "ENTRADA" : "SAIDA", descricao: m.desc, valor_cent: v, categoria: m.categoria, data: d, pago: true, pago_em: d, forma: m.forma, contato: m.quem, obs: m.obs, chave: `central:mov:${m.id}` })) n.movimentos++;
  }
  const mapaRot = new Map();
  for (const r0 of lista(dados.rotinas)) {
    if (!re(r0.titulo)) continue;
    const r = await env.DB.prepare(`INSERT INTO adm_rotinas(org_id,titulo,area,dias,ultima,proxima,aviso_dias,fornecedor,telefone,obs,externo,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(org_id, externo) DO UPDATE SET ultima=COALESCE(excluded.ultima, adm_rotinas.ultima), fornecedor=COALESCE(excluded.fornecedor, adm_rotinas.fornecedor) RETURNING id`)
      .bind(orgId, re(r0.titulo, 120), re(r0.area, 60) || null, inteiro(r0.dias, 1, 3650, 30), dt(r0.ultima), dt(r0.proxima), inteiro(r0.aviso, 0, 365, 7), re(r0.fornecedor, 120) || null, re(r0.telefone, 30) || null, re(r0.obs, 500) || null, `central:${r0.id}`, agoraMs).first();
    mapaRot.set(r0.id, r.id); n.rotinas++;
  }
  for (const s of lista(dados.servicos)) {
    const d = dt(s.data); if (!d || !re(s.titulo)) continue;
    const r = await env.DB.prepare(`INSERT OR IGNORE INTO adm_servicos(org_id,titulo,data,tipo,local,problema,solucao,prestador,telefone,valor_cent,garantia_ate,rotina_id,externo,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(orgId, re(s.titulo, 160), d, re(s.tipo, 60) || null, re(s.local, 120) || null, re(s.problema, 500) || null, re(s.solucao, 800) || null, re(s.prestador, 120) || null, re(s.telefone, 30) || null,
        s.valor != null ? cents(s.valor) : null, dt(s.garantiaAte), mapaRot.get(s.rotinaId) || null, `central:${s.id}`, agoraMs).run();
    if (r.meta?.changes) n.servicos++;
  }
  for (const a of lista(dados.agenda)) {
    const d = dt(a.data); if (!d || !re(a.titulo)) continue;
    const r = await env.DB.prepare(`INSERT OR IGNORE INTO adm_agenda(org_id,titulo,data,hora,quem,prioridade,aviso_min,feito,feito_em,obs,externo,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(orgId, re(a.titulo, 160), d, horaValida(a.hora) ? a.hora : null, re(a.quem, 60) || null, /alta/i.test(a.prioridade || "") ? "ALTA" : "NORMAL", inteiro(a.aviso, 0, 10080, 60), a.feito ? 1 : 0, dt(a.feitoEm), re(a.obs, 500) || null, `central:${a.id}`, agoraMs).run();
    if (r.meta?.changes) n.agenda++;
  }
  for (const d0 of lista(dados.documentos)) {
    if (!re(d0.titulo || d0.nome)) continue;
    const r = await env.DB.prepare(`INSERT OR IGNORE INTO adm_documentos(org_id,titulo,tipo,numero,vence_em,aviso_dias,obs,externo,criado_ms) VALUES(?,?,?,?,?,?,?,?,?)`)
      .bind(orgId, re(d0.titulo || d0.nome, 160), re(d0.tipo, 60) || null, re(d0.numero, 60) || null, dt(d0.validade || d0.venceEm || d0.vence_em), inteiro(d0.aviso, 0, 365, 30), re(d0.obs, 500) || null, `central:${d0.id}`, agoraMs).run();
    if (r.meta?.changes) n.documentos++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Temporada → Financeiro: cada reserva confirmada vira um "a receber" (se a empresa ligar).
// ---------------------------------------------------------------------------
export async function reservasNoFinanceiro(env, orgId, agoraMs) {
  await garantirAdmin(env);
  const moeda = (await env.DB.prepare("SELECT moeda FROM fin_config WHERE org_id=?").bind(orgId).first().catch(() => null))?.moeda || "BRL";
  let rs = [];
  try {
    rs = (await env.DB.prepare(`SELECT r.*, i.nome AS imovel FROM plt_tp_reservas r JOIN plt_tp_imoveis i ON i.id=r.imovel_id WHERE r.org_id=? AND r.tipo='RESERVA' AND r.valor > 0 AND r.inicio >= ?`)
      .bind(orgId, somarDias(hojeLocal(agoraMs), -60)).all()).results || [];
  } catch { return 0; }
  let n = 0;
  for (const r of rs) {
    const chave = `tp:${r.id}`;
    if (r.status === "CANCELADA") { await env.DB.prepare("DELETE FROM fin_lanc WHERE org_id=? AND chave_externa=? AND pago=0").bind(orgId, chave).run(); continue; }
    if (r.moeda && r.moeda !== moeda) continue; // não converte moeda por conta própria
    // Airbnb repassa ~1 dia depois do check-in; Booking e direto, no check-out (a data pode ser ajustada no lançamento).
    const data = /airbnb/i.test(r.canal) ? somarDias(r.inicio, 1) : r.fim;
    const res = await env.DB.prepare(`INSERT OR IGNORE INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,contato,origem,chave_externa,criado_por,criado_ms,atualizado_ms,centro)
      VALUES(?,'ENTRADA',?,?,'Locação / diárias',?,0,?,'temporada',?,'DENIA',?,?,?)`).bind(orgId, `Reserva ${r.canal} — ${r.hospede || "hóspede"} (${br(r.inicio)} a ${br(r.fim)})`, Math.round(Number(r.valor) * 100), data, r.hospede || null, chave, agoraMs, agoraMs, r.imovel).run();
    if (res.meta?.changes) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Rotas: /api/orgs/:id/adm/...
// ---------------------------------------------------------------------------
export async function rotasAdmin(request, env, k, orgId, papel, resto) {
  const { json, lerCorpo, pode, agora } = k;
  await garantirAdmin(env);
  const url = new URL(request.url), metodo = request.method, partes = resto.split("/").slice(1), ms = agora(env), hoje = hojeLocal(ms);
  const admin = pode(papel, "ADMIN"), equipe = pode(papel, "AGENTE");
  // Agenda e manutenção a equipe pode ver e usar; dinheiro, contratos e configuração só o dono e os administradores.
  const area = partes[0];
  if (!equipe) return json({ erro: "Seu perfil é somente leitura." }, 403);
  if (!["dia", "agenda", "rotinas", "servicos"].includes(area) && !admin) return json({ erro: "Esta parte da administração é visível só para o dono e os administradores." }, 403);
  const quem = k.sessao?.usuario?.email || null;
  const config = async () => {
    let c = await env.DB.prepare("SELECT * FROM adm_config WHERE org_id=?").bind(orgId).first();
    if (!c) { await env.DB.prepare("INSERT OR IGNORE INTO adm_config(org_id, atualizado_ms) VALUES(?,?)").bind(orgId, ms).run(); c = await env.DB.prepare("SELECT * FROM adm_config WHERE org_id=?").bind(orgId).first(); }
    return c;
  };
  const empresa = async () => (await env.DB.prepare("SELECT nome FROM plt_organizacoes WHERE id=?").bind(orgId).first().catch(() => null))?.nome || "";
  const moeda = async () => (await env.DB.prepare("SELECT moeda FROM fin_config WHERE org_id=?").bind(orgId).first().catch(() => null))?.moeda || "BRL";
  const corpo = async () => { const { corpo: c, erro } = await lerCorpo(request, 3_000_000); return erro ? { erro } : { c: c || {} }; };
  const id1 = /^\d+$/.test(partes[1] || "") ? Number(partes[1]) : null;

  if (area === "dia" && metodo === "GET") {
    const d = await oDia(env, orgId, ms);
    if (!admin) { d.contas = []; d.saldos = []; d.totais = { ...d.totais, pagar_vencido: 0, pagar_semana: 0, receber_vencido: 0, receber_semana: 0 }; d.documentos = []; }
    return json({ ...d, moeda: await moeda(), config: admin ? await config() : null, admin });
  }

  // ----- Agenda e compromissos
  if (area === "agenda") {
    const validar = (c, atual = {}) => {
      const v = { ...atual, ...c };
      if (!re(v.titulo)) return "Escreva o compromisso (ex.: Vistoria dos bombeiros).";
      if (!dataValida(v.data)) return "Escolha a data.";
      if (v.hora && !horaValida(v.hora)) return "Hora inválida (use 14:30).";
      return { titulo: re(v.titulo, 160), data: v.data, hora: v.hora || null, duracao_min: inteiro(v.duracao_min, 5, 1440, 60), quem: re(v.quem, 60) || null, local: re(v.local, 120) || null,
        prioridade: v.prioridade === "ALTA" ? "ALTA" : "NORMAL", aviso_min: inteiro(v.aviso_min, 0, 10080, 60), repetir: ["semanal", "mensal", "anual"].includes(v.repetir) ? v.repetir : null, obs: re(v.obs, 800) || null };
    };
    if (metodo === "GET" && !id1) {
      const de = dataValida(url.searchParams.get("de")) ? url.searchParams.get("de") : somarDias(hoje, -30), ate = dataValida(url.searchParams.get("ate")) ? url.searchParams.get("ate") : somarDias(hoje, 120);
      const itens = (await env.DB.prepare("SELECT * FROM adm_agenda WHERE org_id=? AND ((data BETWEEN ? AND ?) OR (feito=0 AND data < ?)) ORDER BY data, COALESCE(hora,'99:99') LIMIT 1000").bind(orgId, de, ate, hoje).all()).results || [];
      return json({ itens, hoje });
    }
    if (metodo === "POST" && !id1) {
      const { c, erro } = await corpo(); if (erro) return erro;
      const v = validar(c); if (typeof v === "string") return json({ erro: v }, 400);
      const r = await env.DB.prepare("INSERT INTO adm_agenda(org_id,titulo,data,hora,duracao_min,quem,local,prioridade,aviso_min,repetir,obs,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(orgId, v.titulo, v.data, v.hora, v.duracao_min, v.quem, v.local, v.prioridade, v.aviso_min, v.repetir, v.obs, ms).run();
      return json({ ok: true, id: r.meta?.last_row_id }, 201);
    }
    if (id1) {
      const atual = await env.DB.prepare("SELECT * FROM adm_agenda WHERE id=? AND org_id=?").bind(id1, orgId).first();
      if (!atual) return json({ erro: "Compromisso não encontrado." }, 404);
      if (partes[2] === "feito" && metodo === "POST") {
        const { c } = await corpo();
        if (c?.desfazer) { await env.DB.prepare("UPDATE adm_agenda SET feito=0, feito_em=NULL WHERE id=?").bind(id1).run(); return json({ ok: true }); }
        await env.DB.prepare("UPDATE adm_agenda SET feito=1, feito_em=? WHERE id=?").bind(hoje, id1).run();
        let proximo = null;
        if (atual.repetir) {
          const data = atual.repetir === "semanal" ? somarDias(atual.data, 7) : somarMesesData(atual.data, atual.repetir === "anual" ? 12 : 1);
          const r = await env.DB.prepare("INSERT INTO adm_agenda(org_id,titulo,data,hora,duracao_min,quem,local,prioridade,aviso_min,repetir,obs,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(orgId, atual.titulo, data, atual.hora, atual.duracao_min, atual.quem, atual.local, atual.prioridade, atual.aviso_min, atual.repetir, atual.obs, ms).run();
          proximo = { id: r.meta?.last_row_id, data };
        }
        return json({ ok: true, proximo });
      }
      if (metodo === "PUT") {
        const { c, erro } = await corpo(); if (erro) return erro;
        const v = validar(c, atual); if (typeof v === "string") return json({ erro: v }, 400);
        await env.DB.prepare("UPDATE adm_agenda SET titulo=?,data=?,hora=?,duracao_min=?,quem=?,local=?,prioridade=?,aviso_min=?,repetir=?,obs=?,avisado_ms=NULL WHERE id=?")
          .bind(v.titulo, v.data, v.hora, v.duracao_min, v.quem, v.local, v.prioridade, v.aviso_min, v.repetir, v.obs, id1).run();
        return json({ ok: true });
      }
      if (metodo === "DELETE") { await env.DB.prepare("DELETE FROM adm_agenda WHERE id=? AND org_id=?").bind(id1, orgId).run(); return json({ ok: true }); }
    }
  }

  // ----- Obrigações e manutenção (rotinas) e histórico de serviços
  if (area === "rotinas") {
    const validar = (c, atual = {}) => {
      const v = { ...atual, ...c };
      if (!re(v.titulo)) return "Escreva a obrigação (ex.: Recarga dos extintores).";
      return { titulo: re(v.titulo, 120), area: re(v.area, 60) || null, dias: inteiro(v.dias, 1, 3650, 30), ultima: dataValida(v.ultima) ? v.ultima : null, proxima: dataValida(v.proxima) ? v.proxima : null,
        aviso_dias: inteiro(v.aviso_dias, 0, 365, 7), fornecedor: re(v.fornecedor, 120) || null, telefone: re(v.telefone, 30) || null, obs: re(v.obs, 800) || null };
    };
    if (metodo === "GET" && !partes[1]) {
      const rs = (await env.DB.prepare("SELECT * FROM adm_rotinas WHERE org_id=? AND ativo=1 ORDER BY titulo").bind(orgId).all()).results || [];
      const perfil = (await config()).perfil || "comercial";
      const ja = new Set(rs.map(r => r.titulo.toLowerCase()));
      return json({ rotinas: rs.map(r => ({ ...r, ...situacaoRotina(r, hoje) })), hoje,
        modelos: MODELOS_ROTINA.map(([titulo, area0, dias, aviso, obs, perfis]) => ({ titulo, area: area0, dias, aviso_dias: aviso, obs, sugerido: perfis.includes(perfil), ja: ja.has(titulo.toLowerCase()) })) });
    }
    if (partes[1] === "modelos" && metodo === "POST") {
      const { c, erro } = await corpo(); if (erro) return erro;
      const escolhidos = new Set((c.titulos || []).map(String));
      let n = 0;
      for (const [titulo, area0, dias, aviso, obs] of MODELOS_ROTINA) {
        if (!escolhidos.has(titulo)) continue;
        const existe = await env.DB.prepare("SELECT id FROM adm_rotinas WHERE org_id=? AND lower(titulo)=lower(?) AND ativo=1").bind(orgId, titulo).first();
        if (existe) continue;
        await env.DB.prepare("INSERT INTO adm_rotinas(org_id,titulo,area,dias,aviso_dias,obs,criado_ms) VALUES(?,?,?,?,?,?,?)").bind(orgId, titulo, area0, dias, aviso, obs || null, ms).run();
        n++;
      }
      return json({ ok: true, adicionadas: n }, 201);
    }
    if (metodo === "POST" && !partes[1]) {
      const { c, erro } = await corpo(); if (erro) return erro;
      const v = validar(c); if (typeof v === "string") return json({ erro: v }, 400);
      const r = await env.DB.prepare("INSERT INTO adm_rotinas(org_id,titulo,area,dias,ultima,proxima,aviso_dias,fornecedor,telefone,obs,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .bind(orgId, v.titulo, v.area, v.dias, v.ultima, v.proxima, v.aviso_dias, v.fornecedor, v.telefone, v.obs, ms).run();
      return json({ ok: true, id: r.meta?.last_row_id }, 201);
    }
    if (id1) {
      const atual = await env.DB.prepare("SELECT * FROM adm_rotinas WHERE id=? AND org_id=?").bind(id1, orgId).first();
      if (!atual) return json({ erro: "Obrigação não encontrada." }, 404);
      // Feito: registra o serviço no histórico, atualiza a última vez e, se quiser, lança a despesa no financeiro.
      if (partes[2] === "feito" && metodo === "POST") {
        const { c, erro } = await corpo(); if (erro) return erro;
        const data = dataValida(c.data) ? c.data : hoje;
        if (data > hoje) return json({ erro: "A data do serviço não pode ser no futuro." }, 400);
        const valor = c.valor !== undefined && c.valor !== "" ? centavos(c.valor) : null;
        if (valor !== null && (valor < 0 || valor > 1e11)) return json({ erro: "Valor inválido." }, 400);
        let finId = null;
        if (valor && c.lancar && admin) {
          const r = await env.DB.prepare(`INSERT INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,pago_em,forma,contato,origem,criado_por,criado_ms,atualizado_ms) VALUES(?,'SAIDA',?,?,'Manutenção',?,?,?,?,?,'manutencao',?,?,?)`)
            .bind(orgId, re(atual.titulo, 160), valor, data, c.pago === false ? 0 : 1, c.pago === false ? null : data, re(c.forma, 30) || null, re(c.prestador, 120) || atual.fornecedor || null, quem, ms, ms).run();
          finId = r.meta?.last_row_id;
        }
        const s = await env.DB.prepare(`INSERT INTO adm_servicos(org_id,titulo,data,tipo,local,problema,solucao,prestador,telefone,valor_cent,garantia_ate,rotina_id,fin_lanc_id,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(orgId, atual.titulo, data, re(c.tipo, 60) || "Preventiva", re(c.local, 120) || null, null, re(c.obs, 800) || null, re(c.prestador, 120) || atual.fornecedor || null, re(c.telefone, 30) || atual.telefone || null,
            valor, dataValida(c.garantia_ate) ? c.garantia_ate : null, id1, finId, ms).run();
        const ultima = !atual.ultima || data > atual.ultima ? data : atual.ultima;
        await env.DB.prepare("UPDATE adm_rotinas SET ultima=?, proxima=NULL, fornecedor=COALESCE(?, fornecedor), telefone=COALESCE(?, telefone) WHERE id=?").bind(ultima, re(c.prestador, 120) || null, re(c.telefone, 30) || null, id1).run();
        return json({ ok: true, servico_id: s.meta?.last_row_id, proxima: somarDias(ultima, atual.dias || 30), fin_lanc_id: finId });
      }
      if (metodo === "PUT") {
        const { c, erro } = await corpo(); if (erro) return erro;
        const v = validar(c, atual); if (typeof v === "string") return json({ erro: v }, 400);
        await env.DB.prepare("UPDATE adm_rotinas SET titulo=?,area=?,dias=?,ultima=?,proxima=?,aviso_dias=?,fornecedor=?,telefone=?,obs=? WHERE id=?")
          .bind(v.titulo, v.area, v.dias, v.ultima, v.proxima, v.aviso_dias, v.fornecedor, v.telefone, v.obs, id1).run();
        return json({ ok: true });
      }
      if (metodo === "DELETE") { await env.DB.prepare("UPDATE adm_rotinas SET ativo=0 WHERE id=? AND org_id=?").bind(id1, orgId).run(); return json({ ok: true }); }
    }
  }
  if (area === "servicos") {
    if (metodo === "GET" && !id1) {
      const rot = Number(url.searchParams.get("rotina")) || null;
      const itens = (await env.DB.prepare(`SELECT s.*, r.titulo AS rotina FROM adm_servicos s LEFT JOIN adm_rotinas r ON r.id=s.rotina_id WHERE s.org_id=?${rot ? " AND s.rotina_id=?" : ""} ORDER BY s.data DESC, s.id DESC LIMIT 500`)
        .bind(...(rot ? [orgId, rot] : [orgId])).all()).results || [];
      return json({ servicos: admin ? itens : itens.map(s => ({ ...s, valor_cent: null })) });
    }
    if (metodo === "POST" && !id1) {
      const { c, erro } = await corpo(); if (erro) return erro;
      if (!re(c.titulo)) return json({ erro: "Escreva o serviço (ex.: Troca do disjuntor)." }, 400);
      if (!dataValida(c.data)) return json({ erro: "Escolha a data do serviço." }, 400);
      const valor = c.valor !== undefined && c.valor !== "" ? centavos(c.valor) : null;
      const r = await env.DB.prepare(`INSERT INTO adm_servicos(org_id,titulo,data,tipo,local,problema,solucao,prestador,telefone,valor_cent,garantia_ate,rotina_id,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(orgId, re(c.titulo, 160), c.data, re(c.tipo, 60) || null, re(c.local, 120) || null, re(c.problema, 800) || null, re(c.solucao, 800) || null, re(c.prestador, 120) || null, re(c.telefone, 30) || null,
          valor !== null && valor >= 0 ? valor : null, dataValida(c.garantia_ate) ? c.garantia_ate : null, Number(c.rotina_id) || null, ms).run();
      return json({ ok: true, id: r.meta?.last_row_id }, 201);
    }
    if (id1 && metodo === "DELETE") { if (!admin) return json({ erro: "Só administradores apagam o histórico." }, 403); await env.DB.prepare("DELETE FROM adm_servicos WHERE id=? AND org_id=?").bind(id1, orgId).run(); return json({ ok: true }); }
  }

  // ----- Locatários e aluguéis
  if (area === "locatarios") {
    const validar = (c, atual = {}) => {
      const v = { ...atual, ...c };
      if (!re(v.nome)) return "Escreva o nome do locatário.";
      const al = c.aluguel !== undefined ? centavos(c.aluguel) : atual.aluguel_cent ?? 0, co = c.condominio !== undefined ? centavos(c.condominio) : atual.condominio_cent ?? 0, ou = c.outras !== undefined ? centavos(c.outras) : atual.outras_cent ?? 0;
      if ([al, co, ou].some(x => x === null || x < 0)) return "Valores inválidos.";
      return { nome: re(v.nome, 120), unidade: re(v.unidade, 60) || null, responsavel: re(v.responsavel, 120) || null, documento: re(v.documento, 30) || null, email: emailOk(v.email) ? v.email : null, telefone: re(v.telefone, 30) || null,
        aluguel_cent: al || 0, condominio_cent: co || 0, outras_cent: ou || 0, dia_venc: inteiro(v.dia_venc, 1, 31, 5), inicio: dataValida(v.inicio) ? v.inicio : null, fim: dataValida(v.fim) ? v.fim : null,
        reajuste_mes: inteiro(v.reajuste_mes, 1, 12, null), indice: re(v.indice, 20) || null, multa_pct: pctNum(v.multa_pct), juros_pct: pctNum(v.juros_pct), garantia: re(v.garantia, 120) || null, ativo: v.ativo === false || v.ativo === 0 ? 0 : 1, obs: re(v.obs, 800) || null };
    };
    if (metodo === "GET" && !id1) {
      await gerarCobrancas(env, orgId, hoje.slice(0, 7), ms);
      const ls = (await env.DB.prepare("SELECT * FROM adm_locatarios WHERE org_id=? ORDER BY ativo DESC, unidade, nome").bind(orgId).all()).results || [];
      const abertos = (await env.DB.prepare("SELECT * FROM fin_lanc WHERE org_id=? AND tipo='ENTRADA' AND pago=0 AND locatario_id IS NOT NULL ORDER BY data").bind(orgId).all()).results || [];
      return json({ hoje, locatarios: ls.map(l => {
        const ab = abertos.filter(a => a.locatario_id === l.id).map(a => ({ ...a, ...encargosAtraso(a.valor_cent, a.data, hoje, l.multa_pct, l.juros_pct) }));
        const reajusteProximo = l.reajuste_mes ? (() => { const m = Number(hoje.slice(5, 7)); const ano = Number(hoje.slice(0, 4)) + (l.reajuste_mes < m ? 1 : 0); return `${ano}-${String(l.reajuste_mes).padStart(2, "0")}`; })() : null;
        return { ...l, em_aberto: ab, em_aberto_cent: ab.reduce((s, a) => s + a.valor_cent, 0), vencido_cent: ab.filter(a => a.data < hoje).reduce((s, a) => s + a.valor_cent, 0), reajuste_proximo: reajusteProximo,
          contrato_vence_dias: l.fim ? diasEntre(hoje, l.fim) : null };
      }) });
    }
    if (metodo === "POST" && partes[1] === "gerar") {
      const mes = mesValido(url.searchParams.get("mes")) ? url.searchParams.get("mes") : hoje.slice(0, 7);
      return json({ ok: true, criadas: await gerarCobrancas(env, orgId, mes, ms), mes });
    }
    if (metodo === "POST" && !id1) {
      const { c, erro } = await corpo(); if (erro) return erro;
      const v = validar(c); if (typeof v === "string") return json({ erro: v }, 400);
      const r = await env.DB.prepare(`INSERT INTO adm_locatarios(org_id,nome,unidade,responsavel,documento,email,telefone,aluguel_cent,condominio_cent,outras_cent,dia_venc,inicio,fim,reajuste_mes,indice,multa_pct,juros_pct,garantia,ativo,obs,criado_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(orgId, v.nome, v.unidade, v.responsavel, v.documento, v.email, v.telefone, v.aluguel_cent, v.condominio_cent, v.outras_cent, v.dia_venc, v.inicio, v.fim, v.reajuste_mes, v.indice, v.multa_pct, v.juros_pct, v.garantia, v.ativo, v.obs, ms).run();
      await gerarCobrancas(env, orgId, hoje.slice(0, 7), ms);
      return json({ ok: true, id: r.meta?.last_row_id }, 201);
    }
    if (id1) {
      const atual = await env.DB.prepare("SELECT * FROM adm_locatarios WHERE id=? AND org_id=?").bind(id1, orgId).first();
      if (!atual) return json({ erro: "Locatário não encontrado." }, 404);
      if (metodo === "PUT") {
        const { c, erro } = await corpo(); if (erro) return erro;
        const v = validar(c, atual); if (typeof v === "string") return json({ erro: v }, 400);
        await env.DB.prepare(`UPDATE adm_locatarios SET nome=?,unidade=?,responsavel=?,documento=?,email=?,telefone=?,aluguel_cent=?,condominio_cent=?,outras_cent=?,dia_venc=?,inicio=?,fim=?,reajuste_mes=?,indice=?,multa_pct=?,juros_pct=?,garantia=?,ativo=?,obs=? WHERE id=?`)
          .bind(v.nome, v.unidade, v.responsavel, v.documento, v.email, v.telefone, v.aluguel_cent, v.condominio_cent, v.outras_cent, v.dia_venc, v.inicio, v.fim, v.reajuste_mes, v.indice, v.multa_pct, v.juros_pct, v.garantia, v.ativo, v.obs, id1).run();
        return json({ ok: true });
      }
      // Encerrar: deixa de gerar cobranças (o histórico continua).
      if (metodo === "DELETE") { await env.DB.prepare("UPDATE adm_locatarios SET ativo=0, fim=COALESCE(fim, ?) WHERE id=?").bind(hoje, id1).run(); return json({ ok: true }); }
    }
  }

  // ----- Documentos com validade
  if (area === "documentos") {
    if (metodo === "GET" && !id1) {
      const ds = (await env.DB.prepare("SELECT * FROM adm_documentos WHERE org_id=? ORDER BY CASE WHEN vence_em IS NULL OR vence_em='' THEN 1 ELSE 0 END, vence_em, titulo").bind(orgId).all()).results || [];
      return json({ hoje, documentos: ds.map(d => ({ ...d, dias: d.vence_em ? diasEntre(hoje, d.vence_em) : null })) });
    }
    if ((metodo === "POST" && !id1) || (metodo === "PUT" && id1)) {
      const { c, erro } = await corpo(); if (erro) return erro;
      if (!re(c.titulo)) return json({ erro: "Escreva o nome do documento (ex.: AVCB, Alvará, Seguro)." }, 400);
      if (c.vence_em && !dataValida(c.vence_em)) return json({ erro: "Data de validade inválida." }, 400);
      const link = /^https:\/\/[^\s]{4,500}$/.test(String(c.link || "")) ? c.link : null;
      const vals = [re(c.titulo, 160), re(c.tipo, 60) || null, re(c.numero, 60) || null, c.vence_em || null, inteiro(c.aviso_dias, 0, 365, 30), link, re(c.obs, 800) || null];
      if (metodo === "POST") { const r = await env.DB.prepare("INSERT INTO adm_documentos(org_id,titulo,tipo,numero,vence_em,aviso_dias,link,obs,criado_ms) VALUES(?,?,?,?,?,?,?,?,?)").bind(orgId, ...vals, ms).run(); return json({ ok: true, id: r.meta?.last_row_id }, 201); }
      const r = await env.DB.prepare("UPDATE adm_documentos SET titulo=?,tipo=?,numero=?,vence_em=?,aviso_dias=?,link=?,obs=? WHERE id=? AND org_id=?").bind(...vals, id1, orgId).run();
      return r.meta?.changes ? json({ ok: true }) : json({ erro: "Documento não encontrado." }, 404);
    }
    if (id1 && metodo === "DELETE") { await env.DB.prepare("DELETE FROM adm_documentos WHERE id=? AND org_id=?").bind(id1, orgId).run(); return json({ ok: true }); }
  }

  // ----- Banco e caixa
  if (area === "contas") {
    if (metodo === "GET" && !partes[1]) {
      const data = dataValida(url.searchParams.get("data")) ? url.searchParams.get("data") : hoje;
      const tr = (await env.DB.prepare("SELECT t.*, c.nome AS de_nome, p.nome AS para_conta FROM adm_transf t LEFT JOIN adm_contas c ON c.id=t.de_id LEFT JOIN adm_contas p ON p.id=t.para_id WHERE t.org_id=? ORDER BY t.data DESC, t.id DESC LIMIT 100").bind(orgId).all()).results || [];
      // Dinheiro recebido em espécie nos últimos 60 dias (para conferir o caixa).
      const especie = (await env.DB.prepare("SELECT id, descricao, valor_cent, valor_pago_cent, pago_em, contato FROM fin_lanc WHERE org_id=? AND tipo='ENTRADA' AND pago=1 AND forma='Dinheiro' AND pago_em >= ? ORDER BY pago_em DESC LIMIT 100").bind(orgId, somarDias(hoje, -60)).all()).results || [];
      return json({ data, hoje, contas: await saldosNa(env, orgId, data), transferencias: tr, especie });
    }
    if (metodo === "POST" && partes[1] === "transferir") {
      const { c, erro } = await corpo(); if (erro) return erro;
      const contas = await contasDa(env, orgId), de = contas.find(x => x.id === Number(c.de_id)), para = contas.find(x => x.id === Number(c.para_id));
      const v = centavos(c.valor);
      if (!de) return json({ erro: "Escolha de onde sai o dinheiro." }, 400);
      if (!para && !re(c.para_nome)) return json({ erro: "Escolha a conta de destino ou escreva para quem o dinheiro foi entregue." }, 400);
      if (para && para.id === de.id) return json({ erro: "Origem e destino são a mesma conta." }, 400);
      if (v === null || v <= 0) return json({ erro: "Informe um valor maior que zero." }, 400);
      const data = dataValida(c.data) ? c.data : hoje;
      if (data > hoje) return json({ erro: "A data não pode ser no futuro." }, 400);
      const r = await env.DB.prepare("INSERT INTO adm_transf(org_id,de_id,para_id,para_nome,valor_cent,data,obs,criado_por,criado_ms) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(orgId, de.id, para?.id || null, para ? null : re(c.para_nome, 80), Math.abs(v), data, re(c.obs, 300) || null, quem, ms).run();
      return json({ ok: true, id: r.meta?.last_row_id }, 201);
    }
    if (metodo === "DELETE" && partes[1] === "transferencias" && /^\d+$/.test(partes[2] || "")) {
      await env.DB.prepare("DELETE FROM adm_transf WHERE id=? AND org_id=?").bind(Number(partes[2]), orgId).run(); return json({ ok: true });
    }
    if ((metodo === "POST" && !partes[1]) || (metodo === "PUT" && id1)) {
      const { c, erro } = await corpo(); if (erro) return erro;
      if (!re(c.nome)) return json({ erro: "Dê um nome à conta (ex.: C6 Bank, Caixa da portaria)." }, 400);
      const saldo = centavos(c.saldo ?? 0);
      if (saldo === null) return json({ erro: "Saldo inválido." }, 400);
      if (!dataValida(c.saldo_em)) return json({ erro: "Informe o dia desse saldo (o saldo no fim daquele dia, como no extrato)." }, 400);
      const tipo = c.tipo === "CAIXA" ? "CAIXA" : "BANCO";
      if (c.padrao) await env.DB.prepare("UPDATE adm_contas SET padrao=0 WHERE org_id=?").bind(orgId).run();
      if (metodo === "POST") {
        const ja = (await contasDa(env, orgId)).length;
        const r = await env.DB.prepare("INSERT INTO adm_contas(org_id,nome,tipo,saldo_cent,saldo_em,padrao,criado_ms) VALUES(?,?,?,?,?,?,?)").bind(orgId, re(c.nome, 60), tipo, saldo, c.saldo_em, c.padrao || (!ja && tipo === "BANCO") ? 1 : 0, ms).run();
        return json({ ok: true, id: r.meta?.last_row_id }, 201);
      }
      const r = await env.DB.prepare("UPDATE adm_contas SET nome=?, tipo=?, saldo_cent=?, saldo_em=?, padrao=CASE WHEN ? THEN 1 ELSE padrao END WHERE id=? AND org_id=?").bind(re(c.nome, 60), tipo, saldo, c.saldo_em, c.padrao ? 1 : 0, id1, orgId).run();
      return r.meta?.changes ? json({ ok: true }) : json({ erro: "Conta não encontrada." }, 404);
    }
    if (id1 && metodo === "DELETE") { await env.DB.prepare("UPDATE adm_contas SET ativo=0 WHERE id=? AND org_id=?").bind(id1, orgId).run(); return json({ ok: true }); }
  }

  // ----- Relatório do mês
  if (area === "relatorio" || area === "relatorio.pdf") {
    const mes = mesValido(url.searchParams.get("mes")) ? url.searchParams.get("mes") : hoje.slice(0, 7);
    const r = await relatorioDoMes(env, orgId, mes, ms);
    if (area === "relatorio") return json({ ...r, moeda: await moeda() });
    const c = await config();
    const pdf = pdfRelatorioMes(r, await empresa(), { moeda: await moeda(), assinaturas: String(c.assinaturas || "").split("|").map(s => s.trim()).filter(Boolean).slice(0, 3), cidade: c.cidade || "" });
    return new Response(pdf, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="relatorio-${mes}.pdf"`, "cache-control": "no-store" } });
  }

  // ----- Configuração, calendário no celular e importação
  if (area === "config") {
    if (metodo === "GET") { const c = await config(); return json({ config: c, perfis: PERFIS, categorias: CATEGORIAS_PERFIL[c.perfil] || null }); }
    if (metodo === "PUT") {
      const { c, erro } = await corpo(); if (erro) return erro;
      const emails = String(c.emails || "").split(/[\s,;]+/).filter(emailOk).slice(0, 5).join(", ");
      const assin = (Array.isArray(c.assinaturas) ? c.assinaturas : String(c.assinaturas || "").split("|")).map(s => re(s, 60)).filter(Boolean).slice(0, 3).join("|");
      await config();
      await env.DB.prepare("UPDATE adm_config SET perfil=?, resumo_diario=?, emails=?, hora_resumo=?, tp_no_fin=?, assinaturas=?, cidade=?, atualizado_ms=? WHERE org_id=?")
        .bind(PERFIS[c.perfil] ? c.perfil : null, c.resumo_diario ? 1 : 0, emails, inteiro(c.hora_resumo, 5, 22, 8), c.tp_no_fin ? 1 : 0, assin || null, re(c.cidade, 60) || null, ms, orgId).run();
      if (c.tp_no_fin) await reservasNoFinanceiro(env, orgId, ms);
      return json({ ok: true, config: await config() });
    }
  }
  if (area === "ical" && metodo === "POST") {
    await config();
    const token = k.b64url ? k.b64url(crypto.getRandomValues(new Uint8Array(24))) : [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("UPDATE adm_config SET ical_token=? WHERE org_id=?").bind(token, orgId).run();
    return json({ ok: true, caminho: `/adm/ical/${token}.ics` });
  }
  if (area === "importar" && metodo === "POST") {
    const { c, erro } = await corpo(); if (erro) return erro;
    const dados = c.dados && typeof c.dados === "object" ? c.dados : null;
    if (!dados) return json({ erro: "Arquivo inválido. Use o arquivo .json exportado da Central Administrativa." }, 400);
    const n = await importarCentral(env, orgId, dados, quem, ms);
    if (k.auditar) await k.auditar(env, request, k.sessao, orgId, "adm.importar", JSON.stringify(n));
    return json({ ok: true, ...n });
  }
  return json({ erro: "Rota não encontrada." }, 404);
}

// ---------------------------------------------------------------------------
// Cron (a cada 5 minutos): cobranças do mês, aviso dos compromissos, resumo do dia e reservas no financeiro.
// ---------------------------------------------------------------------------
export async function adminDoCron(env, k) {
  await garantirAdmin(env);
  const ms = k.agora(env), hoje = hojeLocal(ms), hora = Number(agoraLocal(ms).slice(0, 2));
  const out = { cobrancas: 0, avisos: 0, resumos: 0 };
  for (const { org_id } of (await env.DB.prepare("SELECT DISTINCT org_id FROM adm_locatarios WHERE ativo=1 LIMIT 500").all()).results || [])
    out.cobrancas += await gerarCobrancas(env, org_id, hoje.slice(0, 7), ms).catch(() => 0);
  for (const { org_id } of (await env.DB.prepare("SELECT org_id FROM adm_config WHERE tp_no_fin=1 LIMIT 100").all()).results || [])
    await reservasNoFinanceiro(env, org_id, ms).catch(e => console.error("adm reservas", e?.message));
  if (!k.emailConfigurado || !k.emailConfigurado()) return out;
  const destinos = async orgId => { const c = await env.DB.prepare("SELECT emails FROM adm_config WHERE org_id=?").bind(orgId).first(); const l = String(c?.emails || "").split(/,\s*/).filter(Boolean); return l.length ? l : await k.responsaveis(orgId); };
  // Compromisso com hora: e-mail no horário do aviso (uma vez só).
  const agoraMin = Date.parse(`${hoje}T${agoraLocal(ms)}:00Z`);
  const pend = (await env.DB.prepare("SELECT * FROM adm_agenda WHERE feito=0 AND avisado_ms IS NULL AND hora IS NOT NULL AND data BETWEEN ? AND ? LIMIT 200").bind(hoje, somarDias(hoje, 8)).all()).results || [];
  for (const a of pend) {
    const inicio = Date.parse(`${a.data}T${a.hora}:00Z`);
    if (agoraMin < inicio - (a.aviso_min || 0) * 60000 || agoraMin > inicio + 30 * 60000) continue;
    await env.DB.prepare("UPDATE adm_agenda SET avisado_ms=? WHERE id=?").bind(ms, a.id).run();
    const texto = `${a.titulo}\n${br(a.data)} às ${a.hora}${a.local ? "\nLocal: " + a.local : ""}${a.quem ? "\nCom: " + a.quem : ""}${a.obs ? "\n\n" + a.obs : ""}${k.base ? `\n\nAgenda: ${k.base}/app#/admin/agenda` : ""}`;
    for (const para of await destinos(a.org_id)) if (await k.enviarEmail(para, `Lembrete: ${a.titulo} às ${a.hora}`, texto)) out.avisos++;
  }
  // Resumo do dia por e-mail, no horário escolhido.
  const cfgs = (await env.DB.prepare("SELECT * FROM adm_config WHERE resumo_diario=1 AND COALESCE(ultimo_resumo,'') < ? AND hora_resumo <= ? LIMIT 20").bind(hoje, hora).all()).results || [];
  for (const c of cfgs) {
    try {
      await env.DB.prepare("UPDATE adm_config SET ultimo_resumo=? WHERE org_id=?").bind(hoje, c.org_id).run();
      const d = await oDia(env, c.org_id, ms);
      const tem = d.agenda.length || d.contas.length || d.rotinas.length || d.documentos.length || d.temporada.length;
      if (!tem) continue; // dia vazio: não manda e-mail à toa
      const emp = (await env.DB.prepare("SELECT nome FROM plt_organizacoes WHERE id=?").bind(c.org_id).first().catch(() => null))?.nome || "";
      const moeda = (await env.DB.prepare("SELECT moeda FROM fin_config WHERE org_id=?").bind(c.org_id).first().catch(() => null))?.moeda || "BRL";
      const texto = textoDoDia(d, emp, moeda) + (k.base ? `\n\nAbrir o painel: ${k.base}/app#/admin/hoje` : "");
      for (const para of await destinos(c.org_id)) if (await k.enviarEmail(para, `DENIA — seu dia ${br(hoje)}${emp ? " (" + emp + ")" : ""}`, texto)) out.resumos++;
    } catch (e) { console.error("adm resumo", c.org_id, e?.message); }
  }
  return out;
}
