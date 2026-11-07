// DENIA Platform — Administração da empresa (a "central executiva").
// Junta, numa tela só, o que uma administradora faria: agenda e compromissos, obrigações e manutenção do prédio,
// aluguéis e locatários, documentos com validade, banco e caixa (dinheiro em espécie) e o relatório do mês
// no layout aprovado (Entrou / Saiu / Resultado / Saldo no banco, em aberto, atrasos e assinatura).
// O dinheiro continua no Financeiro (tabela fin_lanc): aqui só acrescentamos conta (banco/caixa), locatário,
// competência e valor efetivamente pago. Nada é inventado: o que não foi lançado aparece como "a conferir".
import { garantirFinanceiro, dinheiro, centavos, dataValida, mesValido, nomeMes, CATEGORIAS_PERFIL } from "./financeiro.js";
export { CATEGORIAS_PERFIL };
import { gerarPdf } from "./pdf.js";
import { gerarXlsx } from "./planilha.js";

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
  "CREATE UNIQUE INDEX IF NOT EXISTS adm_transf_ext ON adm_transf(org_id, externo)",
  // Cadastros: fornecedores e prestadores, e centros de custo (imóvel, pessoa, veículo, unidade…).
  `CREATE TABLE IF NOT EXISTS adm_cadastros (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, tipo TEXT NOT NULL, nome TEXT NOT NULL, subtipo TEXT, telefone TEXT, email TEXT,
    pix TEXT, documento TEXT, endereco TEXT, obs TEXT, ativo INTEGER NOT NULL DEFAULT 1, criado_ms INTEGER)`,
  "CREATE INDEX IF NOT EXISTS adm_cadastros_org ON adm_cadastros(org_id, tipo)",
  // Mês isento de aluguel (a cobrança daquele mês não é gerada).
  "CREATE TABLE IF NOT EXISTS adm_isencoes (org_id INTEGER NOT NULL, locatario_id INTEGER NOT NULL, mes TEXT NOT NULL, motivo TEXT, por TEXT, ms INTEGER, PRIMARY KEY (org_id, locatario_id, mes))"
];
const ALTERS_ADMIN = ["ALTER TABLE adm_locatarios ADD COLUMN periodicidade TEXT", "ALTER TABLE adm_locatarios ADD COLUMN dia_semana INTEGER", "ALTER TABLE adm_config ADD COLUMN recibo_emissor TEXT", "ALTER TABLE adm_config ADD COLUMN endereco TEXT",
  // Pontos a conferir escritos à mão para o relatório de um mês.
  "CREATE TABLE IF NOT EXISTS adm_rel_notas (org_id INTEGER NOT NULL, mes TEXT NOT NULL, texto TEXT, ms INTEGER, PRIMARY KEY (org_id, mes))"];

const prontos = new WeakSet();
export async function garantirAdmin(env) {
  if (prontos.has(env.DB)) return;
  await garantirFinanceiro(env); // cria fin_lanc com as colunas de conta, locatário e valor pago
  for (const s of DDL_ADMIN) await env.DB.prepare(s).run();
  for (const s of ALTERS_ADMIN) await env.DB.prepare(s).run().catch(() => { });
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
  const lanc = (await env.DB.prepare("SELECT id, tipo, valor_cent, valor_pago_cent, forma, conta_id, pago_em FROM fin_lanc WHERE org_id=? AND pago=1 AND COALESCE(fora_conta,0)=0 AND pago_em > ? AND pago_em <= ?").bind(orgId, minimo, maximo).all()).results || [];
  const tr = (await env.DB.prepare("SELECT * FROM adm_transf WHERE org_id=? AND data > ? AND data <= ?").bind(orgId, minimo, maximo).all()).results || [];
  // Pagamento dividido (parte Pix, parte dinheiro): cada parte vai para a sua conta.
  const partes = (await env.DB.prepare("SELECT p.* FROM fin_partes p JOIN fin_lanc l ON l.id=p.lanc_id WHERE p.org_id=? AND l.pago=1 AND l.pago_em > ? AND l.pago_em <= ?").bind(orgId, minimo, maximo).all()).results || [];
  const porLanc = new Map(); for (const x of partes) { if (!porLanc.has(x.lanc_id)) porLanc.set(x.lanc_id, []); porLanc.get(x.lanc_id).push(x); }
  return contas.map(c => {
    // Movimento entre (a, b]: positivo = entrou na conta.
    const mov = (a, b) => {
      let s = 0;
      for (const l of lanc) {
        if (!(l.pago_em > a && l.pago_em <= b)) continue;
        const sinal = l.tipo === "ENTRADA" ? 1 : -1, ps = porLanc.get(l.id);
        if (ps && ps.length) { for (const x of ps) if (contaDoLancamento({ conta_id: x.conta_id, forma: x.forma }, contas) === c.id) s += sinal * x.valor_cent; }
        else if (contaDoLancamento(l, contas) === c.id) s += sinal * valorDe(l);
      }
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
  const isentos = new Set(((await env.DB.prepare("SELECT locatario_id FROM adm_isencoes WHERE org_id=? AND mes=?").bind(orgId, mes).all()).results || []).map(x => x.locatario_id));
  let n = 0;
  for (const l of ls) {
    const total = (l.aluguel_cent || 0) + (l.condominio_cent || 0) + (l.outras_cent || 0);
    if (total <= 0 || isentos.has(l.id)) continue;
    // Aluguel semanal: uma cobrança por semana, no dia da semana combinado.
    const datas = l.periodicidade === "semanal"
      ? Array.from({ length: ultimoDia(mes) }, (_, i) => `${mes}-${String(i + 1).padStart(2, "0")}`).filter(d => new Date(d + "T12:00:00Z").getUTCDay() === (l.dia_semana ?? 1) && (!l.inicio || d >= l.inicio) && (!l.fim || d <= l.fim))
      : [`${mes}-${String(Math.min(Math.max(1, l.dia_venc || 5), ultimoDia(mes))).padStart(2, "0")}`];
    for (const data of datas) {
      const semanal = l.periodicidade === "semanal";
      const r = await env.DB.prepare(`INSERT OR IGNORE INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,contato,locatario_id,competencia,origem,chave_externa,criado_por,criado_ms,atualizado_ms)
        VALUES(?,'ENTRADA',?,?,'Aluguéis recebidos',?,0,?,?,?,'aluguel',?,'DENIA',?,?)`)
        .bind(orgId, `Aluguel ${semanal ? `semanal (venc. ${br(data)})` : nomeMes(mes)}${l.unidade ? " — " + l.unidade : ""} — ${l.nome}`, total, data, l.nome, l.id, mes, semanal ? `alug:${l.id}:${data}` : `alug:${l.id}:${mes}`, agoraMs, agoraMs).run();
      if (r.meta?.changes) n++;
    }
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
export async function relatorioDoMes(env, orgId, mes, agoraMs, periodo = null) {
  await garantirAdmin(env);
  // Período livre (trimestre, ano, datas escolhidas) ou o mês.
  const ini = periodo ? periodo.de : mes + "-01", fim = periodo ? periodo.ate : `${mes}-${String(ultimoDia(mes)).padStart(2, "0")}`, hoje = hojeLocal(agoraMs);
  const corte = fim < hoje ? fim : hoje;
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
  const todosPagos = await q("SELECT * FROM fin_lanc WHERE org_id=? AND pago=1 AND pago_em BETWEEN ? AND ? ORDER BY pago_em, id", orgId, ini, fim);
  // "Pago fora da conta" (ex.: pago por outra pessoa): fica fora dos números e aparece só como observação.
  const pagos = todosPagos.filter(l => !l.fora_conta), foraConta = todosPagos.filter(l => l.fora_conta);
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
  // ----- Detalhes da prestação de contas (linha a linha, como no modelo aprovado)
  const ids = pagos.map(l => l.id);
  const partesDe = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const pedaco = ids.slice(i, i + 90);
    for (const x of await q(`SELECT * FROM fin_partes WHERE org_id=? AND lanc_id IN (${pedaco.map(() => "?").join(",")})`, orgId, ...pedaco)) { if (!partesDe.has(x.lanc_id)) partesDe.set(x.lanc_id, []); partesDe.get(x.lanc_id).push(x); }
  }
  const semanaDe = l => /semanal/i.test(l.descricao) ? ` · semana ${br(l.data).slice(0, 5)}` : "";
  const quemDe = l => l.locatario_id ? `${l.contato || l.descricao}${semanaDe(l)}` : l.contato && !l.descricao.toLowerCase().includes(String(l.contato).toLowerCase()) ? `${l.contato} · ${l.descricao}` : l.descricao;
  const extraDe = l => { const m = /\((?:em m[ãa]os|restante|desconto|isen)[^)]*\)/i.exec(l.descricao) || /desconto[^·]*/i.exec(l.obs || ""); return m ? m[0].replace(/^\(|\)$/g, "") : ""; };
  const atrasoTxt = (venc, pago, rapido) => rapido ? "—" : (() => { const d = diasDeAtraso(venc, pago); return d > 0 ? `${d} dia${d > 1 ? "s" : ""}` : "no prazo"; })();
  const rapidoDe = l => l.origem === "rapido" || /^central:mov:/.test(l.chave_externa || "") || l.origem === "extrato";
  const linhasDe = tipo => pagos.filter(l => l.tipo === tipo).flatMap(l => {
    const ps = partesDe.get(l.id), acres = Math.max(0, valorDe(l) - l.valor_cent);
    const base = { id: l.id, pago_em: l.pago_em, venc: l.data, quem: quemDe(l), para: l.contato || "", descricao: l.descricao, extra: extraDe(l), atraso: atrasoTxt(l.data, l.pago_em, rapidoDe(l)), rapido: rapidoDe(l), categoria: l.categoria || "" };
    if (ps && ps.length > 1) return ps.map((x, i) => ({ ...base, forma: x.forma || "", juros_cent: i ? 0 : acres, valor_cent: x.valor_cent, extra: i ? "restante" : `parte em ${String(x.forma || "").toLowerCase()}` }));
    return [{ ...base, forma: l.forma || "", juros_cent: acres, valor_cent: valorDe(l) }];
  });
  const linhas_entradas = linhasDe("ENTRADA"), linhas_saidas = linhasDe("SAIDA");
  const porForma = ls => { const m = new Map(); for (const l of ls) m.set(l.forma || "Outro", (m.get(l.forma || "Outro") || 0) + l.valor_cent); return [...m.entries()].map(([forma, valor_cent]) => ({ forma, valor_cent })).sort((a, b) => b.valor_cent - a.valor_cent); };
  // Recebimentos com atraso que não são aluguel de contrato (sem multa prevista): entram na lista com "—".
  const atrasados_outros = pagos.filter(l => l.tipo === "ENTRADA" && !l.locatario_id && !rapidoDe(l) && diasDeAtraso(l.data, l.pago_em) > 0 && valorDe(l) <= l.valor_cent).map(l => ({ ...l, dias: diasDeAtraso(l.data, l.pago_em), deixou_cent: null }));
  const pagaram_juros = [...juntos.values()].filter(l => valorDe(l) > l.valor_cent).map(l => ({ quem: l.contato || l.descricao, acrescimo_cent: valorDe(l) - l.valor_cent }));
  const isentos = (await q("SELECT i.*, l.nome FROM adm_isencoes i LEFT JOIN adm_locatarios l ON l.id=i.locatario_id WHERE i.org_id=? AND i.mes BETWEEN ? AND ? ORDER BY l.nome", orgId, ini.slice(0, 7), fim.slice(0, 7))).map(x => x.nome).filter(Boolean);
  const contrato = (await q("SELECT multa_pct, juros_pct, COUNT(*) n FROM adm_locatarios WHERE org_id=? AND ativo=1 GROUP BY 1,2 ORDER BY n DESC LIMIT 1", orgId))[0] || null;
  // Para onde foi o dinheiro: despesas, retiradas dos sócios e transferências.
  const ehRetirada = l => /retirad/i.test(l.categoria || ""), ehTransf = l => /transfer/i.test(l.categoria || "");
  const saiPagos = pagos.filter(l => l.tipo === "SAIDA");
  const retiradas = saiPagos.filter(ehRetirada), transfs = saiPagos.filter(l => ehTransf(l) && !ehRetirada(l));
  const destino = {
    despesas_cent: saiPagos.filter(l => !ehRetirada(l) && !ehTransf(l)).reduce((a, l) => a + valorDe(l), 0),
    retiradas: Object.values(retiradas.reduce((m, l) => { const k = l.contato || l.descricao.replace(/^(pix|pg|transfer[eê]ncia)\s+(p\/|para|pra)?\s*/i, "").trim() || "sócios"; (m[k] = m[k] || { quem: k, itens: [], total_cent: 0 }).itens.push({ data: l.pago_em, valor_cent: valorDe(l) }); m[k].total_cent += valorDe(l); return m; }, {})),
    transferencias: transfs.map(l => ({ quem: l.contato || l.descricao, data: l.pago_em, valor_cent: valorDe(l) }))
  };
  // Onde está o dinheiro: banco e espécie (o que entrou e saiu em dinheiro no período).
  const especie = { recebido_cent: linhas_entradas.filter(l => l.forma === "Dinheiro").reduce((a, l) => a + l.valor_cent, 0), pago_cent: linhas_saidas.filter(l => l.forma === "Dinheiro").reduce((a, l) => a + l.valor_cent, 0) };
  // Conferência com o extrato: se o saldo do banco foi informado depois do fim do período, mostra o caminho até ele.
  const conferencia = [];
  for (const s of banco) {
    if (s.base_em <= fim) continue;
    const contas = await contasDa(env, orgId);
    const movs = (await q("SELECT * FROM fin_lanc WHERE org_id=? AND pago=1 AND COALESCE(fora_conta,0)=0 AND pago_em > ? AND pago_em <= ? ORDER BY pago_em", orgId, fim, s.base_em)).filter(l => contaDoLancamento(l, contas) === s.id);
    const trs = (await q("SELECT * FROM adm_transf WHERE org_id=? AND data > ? AND data <= ? AND (de_id=? OR para_id=?)", orgId, fim, s.base_em, s.id, s.id));
    const ent = movs.filter(l => l.tipo === "ENTRADA").map(l => ({ data: l.pago_em, valor_cent: valorDe(l) })).concat(trs.filter(t => t.para_id === s.id).map(t => ({ data: t.data, valor_cent: t.valor_cent })));
    const sai = movs.filter(l => l.tipo === "SAIDA").map(l => ({ data: l.pago_em, valor_cent: valorDe(l) })).concat(trs.filter(t => t.de_id === s.id).map(t => ({ data: t.data, valor_cent: t.valor_cent })));
    conferencia.push({ conta: s.nome, saldo_fim_cent: s.saldo_cent, entradas: ent, saidas: sai, base_em: s.base_em, base_cent: s.base_cent });
  }
  const notas = (await env.DB.prepare("SELECT texto FROM adm_rel_notas WHERE org_id=? AND mes=?").bind(orgId, fim.slice(0, 7)).first().catch(() => null))?.texto || "";
  const tr = await q("SELECT t.*, c.nome AS de_nome, p.nome AS para_conta FROM adm_transf t LEFT JOIN adm_contas c ON c.id=t.de_id LEFT JOIN adm_contas p ON p.id=t.para_id WHERE t.org_id=? AND t.data BETWEEN ? AND ? ORDER BY t.data", orgId, ini, fim);
  // Pontos a conferir: só fatos que a pessoa precisa olhar — nada de suposição.
  const conferir = [];
  if (!saldos.length) conferir.push("Cadastre a conta do banco e o saldo de um dia conhecido (Administração → Banco e caixa) para o relatório mostrar o saldo no banco.");
  for (const s of banco) if (s.base_em > fim) conferir.push(`O saldo de ${s.nome} foi informado em ${br(s.base_em)}, depois deste mês: o saldo de ${br(fim)} foi calculado para trás com os lançamentos. Confira com o extrato.`);
  const semCat = pagos.filter(l => !l.categoria || /^(outros|outras despesas)$/i.test(l.categoria));
  if (semCat.length) conferir.push(`${semCat.length} lançamento(s) em "Outros"/sem categoria (${dinheiro(semCat.reduce((s, l) => s + valorDe(l), 0))}). Vale classificar.`);
  const dinheiroSemDestino = pagos.filter(l => l.tipo === "ENTRADA" && l.forma === "Dinheiro");
  if (dinheiroSemDestino.length && caixa.length) conferir.push(`Entrou ${dinheiro(dinheiroSemDestino.reduce((s, l) => s + valorDe(l), 0))} em dinheiro no mês. Confirme onde está esse dinheiro (caixa, depósito ou entregue a alguém).`);
  for (const l of foraConta) conferir.push(`${l.descricao} (${dinheiro(valorDe(l))}, ${br(l.pago_em)}): foi pago fora da conta da empresa e não entra nos números. Confirmar de onde saiu o dinheiro.`);
  const vencRec = antes(receber);
  if (vencRec.length) conferir.push(`${vencRec.length} cobrança(s) de meses anteriores continuam em aberto (${dinheiro(soma(vencRec))}).`);
  const acima = pagos.filter(l => l.tipo === "SAIDA").sort((a, b) => valorDe(b) - valorDe(a))[0];
  if (acima && saiu && valorDe(acima) >= saiu * 0.3) conferir.push(`A maior saída foi "${acima.descricao}" (${dinheiro(valorDe(acima))}), ${Math.round(100 * valorDe(acima) / saiu)}% de tudo que saiu.`);
  return {
    mes, nome: periodo ? (periodo.nome || `${br(ini)} a ${br(fim)}`) : nomeMes(mes), periodo: Boolean(periodo), inicio: ini, fim, corte, entrou, saiu, resultado: entrou - saiu, entradas, saidas,
    banco_cent: banco.reduce((s, b) => s + b.saldo_cent, 0), caixa_cent: caixa.reduce((s, b) => s + b.saldo_cent, 0), saldos,
    receber: { mes: doMes(receber), antes: antes(receber), total: soma(receber), total_mes: soma(doMes(receber)), total_antes: soma(antes(receber)) },
    pagar: { mes: doMes(pagar), antes: antes(pagar), total: soma(pagar) },
    atrasados, atrasados_total: atrasados.reduce((s, l) => s + valorDe(l), 0), atrasados_deixou: atrasados.reduce((s, l) => s + l.deixou_cent, 0), transferencias: tr, conferir,
    linhas_entradas, linhas_saidas, forma_entradas: porForma(linhas_entradas), forma_saidas: porForma(linhas_saidas), juros_recebidos_cent: linhas_entradas.reduce((a, l) => a + l.juros_cent, 0),
    juros_pagos_cent: linhas_saidas.reduce((a, l) => a + l.juros_cent, 0), atrasados_outros, pagaram_juros, isentos, contrato, destino, especie, conferencia,
    fora_conta: foraConta.map(l => ({ descricao: l.descricao, data: l.pago_em, valor_cent: valorDe(l), tipo: l.tipo })), notas
  };
}

// Prestação de contas no modelo aprovado (papel branco): Entrou / Saiu / Resultado / Saldo no banco; entradas e saídas
// linha a linha com atraso e juros; em aberto do mês e de antes; quem pagou atrasado sem juros (e quanto deixou de ser
// cobrado); declaração e assinaturas logo abaixo; e, na página seguinte, a explicação do resultado e os pontos a conferir.
export function pdfRelatorioMes(r, empresa, { moeda = "BRL", assinaturas = [], cidade = "", endereco = "", geradoEm = "", logo = null } = {}) {
  const f = c => dinheiro(c, moeda), menos = c => "− " + f(c), mais = c => "+ " + f(c);
  const VERDE = "#15803d", VERMELHO = "#b91c1c", AZUL = "#1d4ed8";
  const mesTxt = r.periodo ? r.nome : r.nome.replace(/^./, c => c.toUpperCase());
  const blocos = [];
  const bancoNome = (r.saldos.find(s => s.tipo === "BANCO") || {}).nome || "";
  blocos.push({ tipo: "caixas", itens: [
    { rotulo: "(+) Entrou", valor: mais(r.entrou), cor: VERDE },
    { rotulo: "(−) Saiu", valor: menos(r.saiu), cor: VERMELHO },
    { rotulo: r.periodo ? "(=) Resultado do período" : "(=) Resultado do mês", valor: (r.resultado < 0 ? "− " : "+ ") + f(Math.abs(r.resultado)), cor: r.resultado < 0 ? VERMELHO : VERDE, fundo: r.resultado < 0 ? "#fdecec" : "#ecfdf3", borda: r.resultado < 0 ? "#f5b5b5" : "#a7e3bf" },
    { rotulo: `Saldo no banco${bancoNome ? " " + bancoNome : ""} em ${br(r.fim).slice(0, 5)}`, valor: r.saldos.some(s => s.tipo === "BANCO") ? f(r.banco_cent) : "—", cor: "#111827" }] });
  const resTxt = `${r.resultado < 0 ? "− " : ""}${f(Math.abs(r.resultado))}`;
  blocos.push({ tipo: "rico", tamanho: 9, partes: [
    { t: `Resultado de ${r.periodo ? "período" : r.nome.split(" de ")[0]}: ${resTxt}`, negrito: true, cor: r.resultado < 0 ? VERMELHO : VERDE },
    { t: ` — ${r.resultado < 0 ? `${empresa || "a empresa"} gastou ${f(-r.resultado)} a mais do que recebeu` : `sobrou ${f(r.resultado)}`}. (${f(r.entrou)} − ${f(r.saiu)} = ${resTxt})`, cor: r.resultado < 0 ? VERMELHO : "#374151" }] });
  const atrasoCel = t => ({ t, cor: t === "no prazo" || t === "—" ? "#374151" : VERMELHO });
  // Entradas
  blocos.push({ tipo: "secao", texto: "Entradas — o que foi recebido" });
  if (r.linhas_entradas.length) blocos.push({ tipo: "tabela", colunas: ["Pago em", "Quem pagou", "Venc.", "Forma", "Atraso", "Juros/multa", "Valor recebido"], larguras: [0.75, 3.1, 0.75, 0.95, 0.8, 0.95, 1.25], alinharDireita: [5, 6],
    linhas: [...r.linhas_entradas.map(l => [br(l.pago_em).slice(0, 5), { t: l.quem, cinza: l.extra }, br(l.venc).slice(0, 5), l.forma || "—", atrasoCel(l.atraso), l.juros_cent ? f(l.juros_cent) : "não", f(l.valor_cent)]),
      { celulas: ["TOTAL RECEBIDO", "", "", "", "", r.juros_recebidos_cent ? f(r.juros_recebidos_cent) : "", f(r.entrou)], negrito: true, borda: true }] });
  else blocos.push({ tipo: "texto", texto: "Nada foi recebido no período.", tamanho: 9 });
  if (r.forma_entradas.length) blocos.push({ tipo: "texto", tamanho: 8.5, cor: "#4b5563", texto: `Por forma de pagamento: ${r.forma_entradas.map(x => `${x.forma} ${f(x.valor_cent)}`).join(" · ")}.` });
  // Saídas
  blocos.push({ tipo: "secao", texto: "Saídas — o que foi pago" });
  if (r.linhas_saidas.length) blocos.push({ tipo: "tabela", colunas: ["Pago em", "Descrição", "Para quem", "Forma", "Atraso", "Juros", "Valor"], larguras: [0.75, 2.7, 1.4, 1, 0.75, 0.6, 1.2], alinharDireita: [5, 6],
    linhas: [...r.linhas_saidas.map(l => [br(l.pago_em).slice(0, 5), { t: l.descricao, cinza: l.rapido ? "gasto do dia a dia" : "" }, l.para && l.para !== l.descricao ? l.para : "", l.forma || "—", atrasoCel(l.atraso), l.juros_cent ? f(l.juros_cent) : "não", f(l.valor_cent)]),
      { celulas: ["TOTAL PAGO", "", "", "", "", "", f(r.saiu)], negrito: true, borda: true }] });
  else blocos.push({ tipo: "texto", texto: "Nada foi pago no período.", tamanho: 9 });
  if (r.forma_saidas.length) blocos.push({ tipo: "texto", tamanho: 8.5, cor: "#4b5563", texto: `Por forma de pagamento: ${r.forma_saidas.map(x => `${x.forma} ${f(x.valor_cent)}`).join(" · ")}.${r.juros_pagos_cent ? ` Juros e multa pagos: ${f(r.juros_pagos_cent)}.` : " Nenhuma conta foi paga com juros."}` });
  // Em aberto
  const lab = r.receber;
  blocos.push({ tipo: "secao", texto: "Em aberto: o que ainda não foi pago" });
  const tabAberto = ls => ({ tipo: "tabela", colunas: ["Venc.", "Quem", "Valor"], larguras: [0.9, 5, 1.3], alinharDireita: [2],
    linhas: ls.map(l => [br(l.data).slice(0, l.data.slice(0, 4) === r.fim.slice(0, 4) ? 5 : 10).replace(/\/(\d{2})(\d{2})$/, "/$2"), { t: l.locatario_id ? `${l.contato || l.descricao}${/semanal/i.test(l.descricao) ? ` · semana ${br(l.data).slice(0, 5)}` : ""}` : l.descricao, cinza: /desconto/i.test(l.obs || "") ? l.obs : "" }, f(l.valor_cent)]) });
  if (lab.mes.length) { blocos.push({ tipo: "subsecao", texto: r.periodo ? "Do período" : `De ${r.nome.split(" de ")[0]}` }); const t = tabAberto(lab.mes); t.linhas.push({ celulas: [r.periodo ? "SUBTOTAL DO PERÍODO" : `SUBTOTAL ${r.nome.split(" de ")[0].toUpperCase()}`, "", f(lab.total_mes)], negrito: true, borda: true }); blocos.push(t); }
  if (lab.antes.length) { blocos.push({ tipo: "subsecao", texto: r.periodo ? "De antes do período" : "De meses anteriores" }); const t = tabAberto(lab.antes); t.linhas.push({ celulas: ["SUBTOTAL ANTERIORES", "", f(lab.total_antes)], negrito: true, borda: true }); blocos.push(t); }
  blocos.push({ tipo: "texto", tamanho: 8.5, cor: "#374151", texto: `${lab.total ? `Total em aberto até ${br(r.fim)}: ${f(lab.total_mes)} + ${f(lab.total_antes)} = ${f(lab.total)}.` : `Nada em aberto até ${br(r.fim)}.`} Contas a pagar vencidas até ${br(r.fim)}: ${r.pagar.total ? f(r.pagar.total) + " em aberto" : "nenhuma em aberto"}.${r.isentos.length ? ` Isentos (não pagam): ${r.isentos.join(", ")}.` : ""}` });
  // Pagaram com atraso e sem juros — a assinatura vem logo abaixo desta última tabela.
  const SIG = 120;
  const lista = [...r.atrasados.map(l => ({ quem: l.contato || l.descricao, semana: /semanal/i.test(l.descricao) ? ` · semana ${br(l.data).slice(0, 5)}` : "", ...l })), ...r.atrasados_outros.map(l => ({ quem: l.contato ? `${l.contato}` : l.descricao, semana: "", ...l }))];
  if (lista.length) {
    blocos.push({ tipo: "secao", texto: "Pagaram com atraso e sem juros" });
    const ct = r.contrato ? `O contrato prevê multa de ${String(r.contrato.multa_pct).replace(".", ",")}% + juros de ${String(r.contrato.juros_pct).replace(".", ",")}% ao mês. ` : "";
    const pj = r.pagaram_juros.length ? `${r.pagaram_juros.length === 1 ? "Só " + r.pagaram_juros[0].quem + " pagou" : r.pagaram_juros.map(x => x.quem).join(", ") + " pagaram"} juros e multa (${f(r.pagaram_juros.reduce((a, x) => a + x.acrescimo_cent, 0))}). ` : "";
    blocos.push({ tipo: "texto", tamanho: 8.5, cor: "#374151", texto: `${ct}${pj}Os abaixo atrasaram e pagaram o valor normal:` });
    blocos.push({ tipo: "tabela", reservaFim: SIG, colunas: ["Quem", "Venc.", "Pagou em", "Atraso", "Valor", "Poderia ter cobrado"], larguras: [3, 0.75, 0.85, 0.85, 1.2, 1.45], alinharDireita: [4, 5],
      linhas: [...lista.map(l => [l.quem + l.semana, br(l.data).slice(0, 5), br(l.pago_em).slice(0, 5), { t: `${l.dias} dia${l.dias > 1 ? "s" : ""}`, cor: VERMELHO }, f(valorDe(l)), l.deixou_cent == null ? "—" : f(l.deixou_cent)]),
        { celulas: ["TOTAL QUE DEIXOU DE SER COBRADO", "", "", "", "", f(r.atrasados_deixou)], negrito: true, borda: true }] });
  }
  blocos.push({ tipo: "assinatura", declaracao: "Declaro que conferi as informações deste relatório (entradas, saídas e valores em aberto) e que estão de acordo.",
    nomes: assinaturas.length ? assinaturas : ["Elaborado por (nome e assinatura)", "Administrador / responsável (de acordo)"], data: `${cidade ? cidade + ", " : ""}Data: ____/____/________` });
  // Página seguinte: explicação
  blocos.push({ tipo: "quebra" }, { tipo: "secao", texto: "Explicação do resultado" });
  const d = r.destino;
  const linhasDest = [[`Despesas (contas, funcionários, manutenção, compras)`, f(d.despesas_cent)]];
  // Retiradas numa linha só (mesmo que o nome tenha sido escrito de jeitos diferentes em cada Pix).
  const itensRet = d.retiradas.flatMap(x => x.itens).sort((a0, b0) => a0.data.localeCompare(b0.data));
  if (itensRet.length) { const nomes = [...new Set(d.retiradas.map(x => x.quem.split(" ")[0].toLowerCase()))]; linhasDest.push([`Retiradas ${nomes.length === 1 && nomes[0] !== "sócios" ? "para " + d.retiradas[0].quem.split(" ")[0].replace(/^./, c => c.toUpperCase()) : "dos sócios"} (${itensRet.map(i0 => `${br(i0.data).slice(0, 5)} ${f(i0.valor_cent)}`).join(" · ")})`, f(itensRet.reduce((a0, i0) => a0 + i0.valor_cent, 0))]); }
  for (const x of d.transferencias) linhasDest.push([`Transferência para ${x.quem} (${br(x.data).slice(0, 5)})`, f(x.valor_cent)]);
  linhasDest.push({ celulas: ["= Total que saiu (igual ao total da tabela Saídas)", f(r.saiu)], negrito: true, borda: true });
  blocos.push({ tipo: "subsecao", texto: "Para onde foi o dinheiro que saiu" }, { tipo: "tabela", semCabecalho: true, colunas: ["", ""], larguras: [5, 1.4], alinharDireita: [1], linhas: linhasDest });
  const onde = [];
  for (const s of r.saldos.filter(x => x.tipo === "BANCO")) onde.push([`Conta ${s.nome}${r.conferencia.some(c => c.conta === s.nome) ? " (conferido com o extrato abaixo)" : ""}`, f(s.saldo_cent)]);
  for (const s of r.saldos.filter(x => x.tipo === "CAIXA")) onde.push([`Dinheiro em espécie: recebido ${f(r.especie.recebido_cent)} − pago ${f(r.especie.pago_cent)} no período (confirmar se está em mãos ou se foi depositado)`, f(s.saldo_cent)]);
  if (onde.length) blocos.push({ tipo: "subsecao", texto: `Onde está o dinheiro em ${br(r.fim)}` }, { tipo: "tabela", semCabecalho: true, colunas: ["", ""], larguras: [5, 1.4], alinharDireita: [1], linhas: onde });
  for (const c of r.conferencia) {
    const ls = [[`Saldo da conta em ${br(r.fim)}`, f(c.saldo_fim_cent)]];
    const sai = c.saidas.reduce((a, x) => a + x.valor_cent, 0), ent = c.entradas.reduce((a, x) => a + x.valor_cent, 0);
    if (sai) ls.push([`(−) Saídas de ${[...new Set(c.saidas.map(x => br(x.data).slice(0, 5)))].join(", ")} (${c.saidas.map(x => f(x.valor_cent)).join(" + ")})`, menos(sai)]);
    if (ent) ls.push([`(+) Entradas de ${[...new Set(c.entradas.map(x => br(x.data).slice(0, 5)))].join(", ")}`, mais(ent)]);
    ls.push({ celulas: [`= Saldo em ${br(c.base_em)} (igual ao extrato informado)`, f(c.base_cent)], negrito: true, borda: true });
    blocos.push({ tipo: "subsecao", texto: `Conferência com o extrato do banco (${c.conta})` }, { tipo: "tabela", semCabecalho: true, colunas: ["", ""], larguras: [5, 1.4], alinharDireita: [1], linhas: ls });
  }
  for (const x of r.fora_conta) blocos.push({ tipo: "texto", tamanho: 8.5, cor: "#374151", texto: `Pago fora da conta da empresa (não entra nas contas acima): ${x.descricao} ${f(x.valor_cent)} em ${br(x.data)}. Confirmar de onde saiu o dinheiro.` });
  blocos.push({ tipo: "texto", tamanho: 8, cor: "#6b7280", texto: `Datas reais de pagamento entre ${br(r.inicio)} e ${br(r.fim)}. Atraso contado pela regra do dia útil: vencimento em sábado, domingo ou feriado pode ser pago no dia útil seguinte sem atraso.` });
  const pontos = [...String(r.notas || "").split(/\n+/).map(t => t.replace(/^[•\-\s]+/, "").trim()).filter(Boolean), ...r.conferir];
  blocos.push({ tipo: "subsecao", texto: "Pontos para conferir" });
  blocos.push(pontos.length ? { tipo: "lista", itens: pontos.map(t => ({ texto: t, cor: "#9ca3af" })) } : { tipo: "texto", texto: "Nada a conferir.", tamanho: 9 });
  return gerarPdf({ estilo: "limpo", corPrincipal: AZUL, logo, titulo: r.periodo ? `Resultado de ${r.nome}` : `Resultado de ${mesTxt}`,
    subtitulo: [empresa, endereco, geradoEm ? `gerado em ${geradoEm}` : ""].filter(Boolean).join(" · "),
    rodape: `DENIA · ${empresa || ""} · ${r.periodo ? r.nome : r.nome.replace(/^./, c => c.toUpperCase()).replace(" de ", "/")}`, blocos });
}

// ---------------------------------------------------------------------------
// Recibo de pagamento (aluguel ou qualquer recebimento), com o valor por extenso.
// ---------------------------------------------------------------------------
const UN = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const DZ = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const CT = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
function ate999(n) {
  if (n === 0) return ""; if (n === 100) return "cem";
  const c = Math.floor(n / 100), r = n % 100, p = [];
  if (c) p.push(CT[c]);
  if (r) p.push(r < 20 ? UN[r] : DZ[Math.floor(r / 10)] + (r % 10 ? " e " + UN[r % 10] : ""));
  return p.join(" e ");
}
export function porExtenso(cent) {
  const reais = Math.floor(Math.abs(cent) / 100), cts = Math.abs(cent) % 100;
  const grupos = [[1e9, "bilhão", "bilhões"], [1e6, "milhão", "milhões"], [1e3, "mil", "mil"]];
  let n = reais; const partes = [];
  for (const [v, s1, sN] of grupos) { const q = Math.floor(n / v); if (q) { partes.push(v === 1e3 && q === 1 ? "mil" : `${ate999(q)} ${q === 1 ? s1 : sN}`); n %= v; } }
  if (n) partes.push(ate999(n));
  let txt = partes.length > 1 && (n && (n < 100 || n % 100 === 0)) ? partes.slice(0, -1).join(" ") + " e " + partes[partes.length - 1] : partes.join(" ");
  if (reais) txt += reais === 1 ? " real" : (reais % 1e6 === 0 ? " de reais" : " reais");
  if (cts) txt += (reais ? " e " : "") + ate999(cts) + (cts === 1 ? " centavo" : " centavos");
  return txt || "zero real";
}
export function pdfRecibo(l, { empresa = "", emissor = "", cidade = "", moeda = "BRL" } = {}) {
  const v = valorDe(l);
  const ref = l.competencia && mesValido(l.competencia) && /alug/i.test(l.categoria || l.descricao) ? `aluguel de ${nomeMes(l.competencia)}` : l.descricao;
  const texto = `Recebi de ${l.contato || "____________________"} a quantia de ${dinheiro(v, moeda)} (${porExtenso(v)}), referente a ${ref}, paga em ${br(l.pago_em)}${l.forma ? " por " + l.forma.toLowerCase() : ""}.`;
  return gerarPdf({ titulo: "Recibo", subtitulo: `${emissor || empresa}`, rodape: `Recibo nº ${l.id} · DENIA`, corPrincipal: "#1e3a8a", blocos: [
    { tipo: "metricas", itens: [{ rotulo: "Valor", valor: dinheiro(v, moeda), nota: `Pago em ${br(l.pago_em)}`, cor: "#16a34a" }] },
    { tipo: "texto", texto, tamanho: 12 },
    { tipo: "espaco", altura: 10 },
    { tipo: "assinatura", local: `${cidade ? cidade + ", " : ""}${br(l.pago_em)}.`, nomes: [emissor || empresa || "Recebedor"] }
  ] });
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
  // Centros de custo (imóveis, pessoas, bens): cada conta fica ligada ao seu.
  const mapaCentro = new Map(); n.centros = 0;
  for (const c of lista(dados.centros)) {
    const nome = re(c.nome, 120); if (!nome) continue;
    let x = await env.DB.prepare("SELECT id FROM adm_cadastros WHERE org_id=? AND tipo='CENTRO' AND lower(nome)=lower(?)").bind(orgId, nome).first();
    if (!x) { await env.DB.prepare("INSERT INTO adm_cadastros(org_id,tipo,nome,subtipo,endereco,obs,ativo,criado_ms) VALUES(?,'CENTRO',?,?,?,?,1,?)").bind(orgId, nome, re(c.tipo, 60) || null, re(c.endereco, 200) || null, re(c.obs, 500) || null, agoraMs).run(); n.centros++; }
    mapaCentro.set(c.id, nome);
  }
  const centroDe = x => mapaCentro.get(x?.centroId) || null;
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
    if (c.status === "isenta" && loc && mesValido(c.competencia)) { await env.DB.prepare("INSERT OR IGNORE INTO adm_isencoes(org_id,locatario_id,mes,motivo,por,ms) VALUES(?,?,?,?,?,?)").bind(orgId, loc.id, c.competencia, re(c.obs || c.descontoTxt, 200) || "Isento (Central)", quem, agoraMs).run(); n.ignorados++; continue; }
    if (c.status === "isenta" || c.status === "cancelada" || !v || !venc) { n.ignorados++; continue; }
    const ref = c.semana ? `semanal (venc. ${br(venc)})` : mesValido(c.competencia) ? nomeMes(c.competencia) : "";
    await recebido({ tipo: "ENTRADA", descricao: `Aluguel ${ref}${loc?.unidade ? " — " + loc.unidade : ""} — ${loc?.nome || "locatário"}`.replace("Aluguel  —", "Aluguel —"),
      valor_cent: v, categoria: "Aluguéis recebidos", data: venc, contato: loc?.nome, obs: [re(c.descontoTxt, 120), re(c.obs, 300)].filter(Boolean).join(" · ") || null, chave: `central:cob:${c.id}`,
      locatario_id: loc?.id, competencia: mesValido(c.competencia) ? c.competencia : venc.slice(0, 7) }, c, () => n.cobrancas++);
  }
  for (const c of lista(dados.receber)) {
    const v = cents(c.valor), venc = dt(c.venc); if (!v || !venc) { n.ignorados++; continue; }
    await recebido({ tipo: "ENTRADA", descricao: c.desc, valor_cent: v, categoria: c.categoria || "Outras receitas", data: venc, contato: c.pagador, obs: c.obs, centro: centroDe(c), chave: `central:rec:${c.id}` }, c, () => n.recebimentos++);
  }
  for (const c of lista(dados.contas)) {
    const v = cents(c.valor), venc = dt(c.venc);
    // Conta de valor variável ainda sem valor (fatura do cartão, por exemplo): vira lembrete na agenda no vencimento.
    if (!v && venc && re(c.desc) && c.status !== "paga") {
      const r = await env.DB.prepare("INSERT OR IGNORE INTO adm_agenda(org_id,titulo,data,prioridade,aviso_min,obs,externo,criado_ms) VALUES(?,?,?,'ALTA',1440,?,?,?)")
        .bind(orgId, `Conta a pagar (confirmar o valor): ${re(c.desc, 120)}`, venc, "Lance o valor no Financeiro quando chegar a fatura.", `central:conta0:${c.id}`, agoraMs).run();
      if (r.meta?.changes) n.agenda++;
      continue;
    }
    if (!v || !venc) { n.ignorados++; continue; }
    const pago = c.status === "paga";
    // "Paga fora da conta" na Central não entra nos números (ex.: paga por outra pessoa): fica de fora aqui também.
    if (pago && c.foraDaConta) {
      const r0 = await env.DB.prepare(`INSERT OR IGNORE INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,pago_em,forma,contato,obs,origem,chave_externa,criado_por,criado_ms,atualizado_ms,fora_conta) VALUES(?,'SAIDA',?,?,?,?,1,?,?,?,?,'central',?,?,?,?,1)`)
        .bind(orgId, re(c.desc, 160) || "Conta", v, re(c.categoria, 60) || null, venc, dt(c.pagoEm) || venc, re(c.forma, 30) || null, re(c.fornecedor, 120) || null, "Pago fora da conta da empresa (não entra nos números).", `central:conta:${c.id}`, quem, agoraMs, agoraMs).run();
      if (r0.meta?.changes) n.fora_da_conta++;
      continue;
    }
    if (await lancar({ tipo: "SAIDA", descricao: c.desc, valor_cent: v, categoria: c.categoria, data: venc, pago, pago_em: dt(c.pagoEm), forma: c.forma, contato: c.fornecedor, obs: c.obs, centro: centroDe(c), chave: `central:conta:${c.id}`, valor_pago_cent: pago && Number(c.valorPago) > 0 ? cents(c.valorPago) : undefined })) n.contas++;
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
        reajuste_mes: inteiro(v.reajuste_mes, 1, 12, null), indice: re(v.indice, 20) || null, multa_pct: pctNum(v.multa_pct), juros_pct: pctNum(v.juros_pct), garantia: re(v.garantia, 120) || null, ativo: v.ativo === false || v.ativo === 0 ? 0 : 1, obs: re(v.obs, 800) || null,
        periodicidade: v.periodicidade === "semanal" ? "semanal" : "mensal", dia_semana: inteiro(v.dia_semana, 0, 6, 1) };
    };
    if (metodo === "GET" && !id1) {
      await gerarCobrancas(env, orgId, hoje.slice(0, 7), ms);
      const ls = (await env.DB.prepare("SELECT * FROM adm_locatarios WHERE org_id=? ORDER BY ativo DESC, unidade, nome").bind(orgId).all()).results || [];
      const abertos = (await env.DB.prepare("SELECT * FROM fin_lanc WHERE org_id=? AND tipo='ENTRADA' AND pago=0 AND locatario_id IS NOT NULL ORDER BY data").bind(orgId).all()).results || [];
      const isencoes = (await env.DB.prepare("SELECT * FROM adm_isencoes WHERE org_id=? AND mes >= ? ORDER BY mes").bind(orgId, somarMes(hoje.slice(0, 7), -12)).all()).results || [];
      return json({ hoje, isencoes, locatarios: ls.map(l => {
        const ab = abertos.filter(a => a.locatario_id === l.id).map(a => ({ ...a, ...encargosAtraso(a.valor_cent, a.data, hoje, l.multa_pct, l.juros_pct) }));
        const reajusteProximo = l.reajuste_mes ? (() => { const m = Number(hoje.slice(5, 7)); const ano = Number(hoje.slice(0, 4)) + (l.reajuste_mes < m ? 1 : 0); return `${ano}-${String(l.reajuste_mes).padStart(2, "0")}`; })() : null;
        return { ...l, em_aberto: ab, em_aberto_cent: ab.reduce((s, a) => s + a.valor_cent, 0), vencido_cent: ab.filter(a => a.data < hoje).reduce((s, a) => s + a.valor_cent, 0), reajuste_proximo: reajusteProximo,
          contrato_vence_dias: l.fim ? diasEntre(hoje, l.fim) : null };
      }) });
    }
    // Isentar o aluguel de um mês (ou desfazer a isenção). A cobrança em aberto daquele mês sai do a receber.
    if (metodo === "POST" && id1 && partes[2] === "isentar") {
      const { c, erro } = await corpo(); if (erro) return erro;
      const mes = mesValido(c.mes) ? c.mes : null; if (!mes) return json({ erro: "Escolha o mês." }, 400);
      if (c.desfazer) { await env.DB.prepare("DELETE FROM adm_isencoes WHERE org_id=? AND locatario_id=? AND mes=?").bind(orgId, id1, mes).run(); await gerarCobrancas(env, orgId, mes, ms); return json({ ok: true }); }
      const pagos = await env.DB.prepare("SELECT COUNT(*) n FROM fin_lanc WHERE org_id=? AND locatario_id=? AND competencia=? AND pago=1").bind(orgId, id1, mes).first();
      if (pagos?.n) return json({ erro: "Este mês já tem pagamento registrado. Desfaça o recebimento antes de isentar." }, 409);
      await env.DB.prepare("INSERT OR REPLACE INTO adm_isencoes(org_id,locatario_id,mes,motivo,por,ms) VALUES(?,?,?,?,?,?)").bind(orgId, id1, mes, re(c.motivo, 200) || null, quem, ms).run();
      const apagados = await env.DB.prepare("DELETE FROM fin_lanc WHERE org_id=? AND locatario_id=? AND competencia=? AND pago=0 AND origem='aluguel'").bind(orgId, id1, mes).run();
      return json({ ok: true, removidas: apagados.meta?.changes || 0 });
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
      await env.DB.prepare("UPDATE adm_locatarios SET periodicidade=?, dia_semana=? WHERE id=?").bind(v.periodicidade, v.dia_semana, r.meta?.last_row_id).run();
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
        await env.DB.prepare("UPDATE adm_locatarios SET periodicidade=?, dia_semana=? WHERE id=?").bind(v.periodicidade, v.dia_semana, id1).run();
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

  // ----- Cadastros: fornecedores/prestadores e centros de custo
  if (area === "cadastros") {
    if (metodo === "GET" && !id1) {
      const tipo = url.searchParams.get("tipo");
      const itens = (await env.DB.prepare(`SELECT * FROM adm_cadastros WHERE org_id=?${tipo ? " AND tipo=?" : ""} ORDER BY ativo DESC, nome`).bind(...(tipo ? [orgId, tipo] : [orgId])).all()).results || [];
      return json({ itens });
    }
    if ((metodo === "POST" && !id1) || (metodo === "PUT" && id1)) {
      const { c, erro } = await corpo(); if (erro) return erro;
      const tipo = c.tipo === "CENTRO" ? "CENTRO" : "FORNECEDOR";
      if (!re(c.nome)) return json({ erro: tipo === "CENTRO" ? "Escreva o nome (ex.: Apto 302, Carro, Filha)." : "Escreva o nome do fornecedor." }, 400);
      const vals = [tipo, re(c.nome, 120), re(c.subtipo, 60) || null, re(c.telefone, 30) || null, emailOk(c.email) ? c.email : null, re(c.pix, 120) || null, re(c.documento, 30) || null, re(c.endereco, 200) || null, re(c.obs, 500) || null, c.ativo === false ? 0 : 1];
      if (metodo === "POST") { const r = await env.DB.prepare("INSERT INTO adm_cadastros(org_id,tipo,nome,subtipo,telefone,email,pix,documento,endereco,obs,ativo,criado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(orgId, ...vals, ms).run(); return json({ ok: true, id: r.meta?.last_row_id }, 201); }
      const r = await env.DB.prepare("UPDATE adm_cadastros SET tipo=?,nome=?,subtipo=?,telefone=?,email=?,pix=?,documento=?,endereco=?,obs=?,ativo=? WHERE id=? AND org_id=?").bind(...vals, id1, orgId).run();
      return r.meta?.changes ? json({ ok: true }) : json({ erro: "Cadastro não encontrado." }, 404);
    }
    if (id1 && metodo === "DELETE") { await env.DB.prepare("UPDATE adm_cadastros SET ativo=0 WHERE id=? AND org_id=?").bind(id1, orgId).run(); return json({ ok: true }); }
  }

  // ----- Recibo de um recebimento (PDF) e envio ao e-mail do próprio pagador
  if (area === "recibo" && id1) {
    const l = await env.DB.prepare("SELECT * FROM fin_lanc WHERE id=? AND org_id=?").bind(id1, orgId).first();
    if (!l || l.tipo !== "ENTRADA" || !l.pago) return json({ erro: "O recibo é só para recebimentos já registrados." }, 400);
    const c = await config(), pdf = pdfRecibo(l, { empresa: await empresa(), emissor: c.recibo_emissor || "", cidade: c.cidade || "", moeda: await moeda() });
    if (metodo === "GET") return new Response(pdf, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="recibo-${l.id}.pdf"`, "cache-control": "no-store" } });
    if (metodo === "POST" && partes[2] === "enviar") {
      // Só para o e-mail cadastrado do próprio locatário: nunca para um endereço digitado na hora.
      const loc = l.locatario_id ? await env.DB.prepare("SELECT nome, email FROM adm_locatarios WHERE id=? AND org_id=?").bind(l.locatario_id, orgId).first() : null;
      if (!loc?.email) return json({ erro: "Este locatário não tem e-mail cadastrado. Cadastre em Aluguéis e locatários." }, 400);
      if (!k.enviarEmail || !(k.emailConfigurado && k.emailConfigurado())) return json({ erro: "O envio de e-mails ainda não está configurado na plataforma." }, 400);
      const b64 = (() => { let t = ""; for (let i = 0; i < pdf.length; i += 0x8000) t += String.fromCharCode(...pdf.subarray(i, i + 0x8000)); return btoa(t); })();
      const ok = await k.enviarEmail(loc.email, `Recibo — ${l.descricao}`, `Olá, ${loc.nome}!\n\nSegue o recibo de ${dinheiro(valorDe(l), await moeda())}, referente a ${l.descricao}, pago em ${br(l.pago_em)}.\n\n${c.recibo_emissor || await empresa()}`, [{ nome: `recibo-${l.id}.pdf`, base64: b64 }]);
      return ok ? json({ ok: true, para: loc.email }) : json({ erro: "Não foi possível enviar o e-mail agora." }, 502);
    }
  }

  // Pontos a conferir escritos à mão (saem no relatório daquele mês).
  if (area === "relatorio-notas" && metodo === "PUT") {
    const { c, erro } = await corpo(); if (erro) return erro;
    if (!mesValido(c.mes)) return json({ erro: "Escolha o mês." }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO adm_rel_notas(org_id,mes,texto,ms) VALUES(?,?,?,?)").bind(orgId, c.mes, String(c.texto || "").slice(0, 3000), ms).run();
    return json({ ok: true });
  }
  // ----- Relatório do mês (ou de um período: trimestre, ano, datas escolhidas)
  if (area === "relatorio" || area === "relatorio.pdf" || area === "relatorio.xlsx") {
    const mes = mesValido(url.searchParams.get("mes")) ? url.searchParams.get("mes") : hoje.slice(0, 7);
    const de = url.searchParams.get("de"), ate = url.searchParams.get("ate");
    if ((de || ate) && !(dataValida(de) && dataValida(ate) && de <= ate && diasEntre(de, ate) <= 1100)) return json({ erro: "Período inválido (de até 3 anos)." }, 400);
    const r = await relatorioDoMes(env, orgId, de ? de.slice(0, 7) : mes, ms, de ? { de, ate } : null);
    if (area === "relatorio.xlsx") {
      const v = c0 => Math.round(c0) / 100;
      const abas = [
        { nome: "Resumo", linhas: [["Item", "Valor"], ["Período", r.nome], ["Entrou", v(r.entrou)], ["Saiu", v(r.saiu)], ["Resultado", v(r.resultado)], ...r.saldos.map(x => [`${x.tipo === "CAIXA" ? "Caixa" : "Banco"} — ${x.nome} em ${br(r.fim)}`, v(x.saldo_cent)]), ["Em aberto (a receber)", v(r.receber.total)], ["Pagos com atraso", r.atrasados.length], ["Multa + juros não cobrados", v(r.atrasados_deixou)]], larguras: [40, 18] },
        { nome: "Entradas", linhas: [["Data", "Categoria", "Descrição", "Quem", "Forma", "Valor"], ...r.entradas.flatMap(g => g.itens.map(l => [br(l.pago_em), g.categoria, l.descricao, l.contato || "", l.forma || "", v(valorDe(l))]))], larguras: [12, 24, 50, 26, 14, 14] },
        { nome: "Saídas", linhas: [["Data", "Categoria", "Descrição", "Quem", "Forma", "Valor"], ...r.saidas.flatMap(g => g.itens.map(l => [br(l.pago_em), g.categoria, l.descricao, l.contato || "", l.forma || "", v(valorDe(l))]))], larguras: [12, 24, 50, 26, 14, 14] },
        { nome: "Em aberto", linhas: [["Vencimento", "Descrição", "Quem", "Valor", "Situação"], ...[...r.receber.antes, ...r.receber.mes].map(l => [br(l.data), l.descricao, l.contato || "", v(l.valor_cent), l.data < r.inicio ? "Anterior" : "Do período"])], larguras: [12, 50, 26, 14, 12] },
        { nome: "Atrasos", linhas: [["Pago em", "Quem", "Dias", "Aluguel", "Multa + juros"], ...r.atrasados.map(l => [br(l.pago_em), l.contato || l.descricao, l.dias, v(valorDe(l)), v(l.deixou_cent)])], larguras: [12, 40, 8, 14, 14] }
      ];
      return new Response(gerarXlsx(abas), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="relatorio-${de ? de + "_" + ate : mes}.xlsx"`, "cache-control": "no-store" } });
    }
    if (area === "relatorio") return json({ ...r, moeda: await moeda() });
    const c = await config();
    const pdf = pdfRelatorioMes(r, await empresa(), { moeda: await moeda(), assinaturas: String(c.assinaturas || "").split("|").map(s => s.trim()).filter(Boolean).slice(0, 3), cidade: c.cidade || "", endereco: c.endereco || "", geradoEm: br(hoje) });
    return new Response(pdf, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="relatorio-${de ? de + "_" + ate : mes}.pdf"`, "cache-control": "no-store" } });
  }

  // ----- Configuração, calendário no celular e importação
  if (area === "config") {
    if (metodo === "GET") { const c = await config(); return json({ config: c, perfis: PERFIS, categorias: CATEGORIAS_PERFIL[c.perfil] || null }); }
    if (metodo === "PUT") {
      const { c, erro } = await corpo(); if (erro) return erro;
      const emails = String(c.emails || "").split(/[\s,;]+/).filter(emailOk).slice(0, 5).join(", ");
      const assin = (Array.isArray(c.assinaturas) ? c.assinaturas : String(c.assinaturas || "").split("|")).map(s => re(s, 60)).filter(Boolean).slice(0, 3).join("|");
      await config();
      await env.DB.prepare("UPDATE adm_config SET perfil=?, resumo_diario=?, emails=?, hora_resumo=?, tp_no_fin=?, assinaturas=?, cidade=?, recibo_emissor=?, endereco=?, atualizado_ms=? WHERE org_id=?")
        .bind(PERFIS[c.perfil] ? c.perfil : null, c.resumo_diario ? 1 : 0, emails, inteiro(c.hora_resumo, 5, 22, 8), c.tp_no_fin ? 1 : 0, assin || null, re(c.cidade, 60) || null, re(c.recibo_emissor, 160) || null, re(c.endereco, 160) || null, ms, orgId).run();
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

// Visão de todas as empresas (para quem administra várias): resultado do mês, saldos, em aberto e o que está vencido.
export async function consolidadoAdmin(env, orgs, mes, agoraMs) {
  await garantirAdmin(env);
  const hoje = hojeLocal(agoraMs), m = mes || hoje.slice(0, 7), out = [];
  for (const o of orgs) {
    try {
      const r = await relatorioDoMes(env, o.id, m, agoraMs);
      const venc = await env.DB.prepare("SELECT tipo, COUNT(*) n, SUM(valor_cent) v FROM fin_lanc WHERE org_id=? AND pago=0 AND data < ? GROUP BY tipo").bind(o.id, hoje).all();
      const vv = t => (venc.results || []).find(x => x.tipo === t) || { n: 0, v: 0 };
      const ag = await env.DB.prepare("SELECT COUNT(*) n FROM adm_agenda WHERE org_id=? AND feito=0 AND data <= ?").bind(o.id, hoje).first();
      out.push({ id: o.id, nome: o.nome, mes: m, entrou: r.entrou, saiu: r.saiu, resultado: r.resultado, banco_cent: r.banco_cent, caixa_cent: r.caixa_cent, tem_contas: r.saldos.length > 0,
        a_receber: r.receber.total, vencido_receber: vv("ENTRADA").v || 0, vencido_pagar: vv("SAIDA").v || 0, contas_vencidas: (vv("ENTRADA").n || 0) + (vv("SAIDA").n || 0), agenda_pendente: ag?.n || 0 });
    } catch (e) { out.push({ id: o.id, nome: o.nome, erro: "Não foi possível ler os números desta empresa." }); }
  }
  return out;
}
