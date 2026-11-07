// DENIA Platform — Administração financeira da empresa (entradas, saídas, contas a pagar e a receber).
// Valores guardados em centavos (inteiros): nada de arredondamento de ponto flutuante nos totais.
// Extrato do banco: importa OFX (padrão dos bancos brasileiros) e CSV, sem repetir o que já entrou.
// Relatório do mês em PDF com gráficos e, se a empresa quiser, por e-mail no dia 1.
import { gerarPdf } from "./pdf.js";

export const DDL_FINANCEIRO = [
  `CREATE TABLE IF NOT EXISTS fin_lanc (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, tipo TEXT NOT NULL, descricao TEXT NOT NULL,
    valor_cent INTEGER NOT NULL, categoria TEXT, data TEXT NOT NULL, pago INTEGER NOT NULL DEFAULT 0, pago_em TEXT, forma TEXT, contato TEXT,
    obs TEXT, recorrente_id INTEGER, origem TEXT, chave_externa TEXT, criado_por TEXT, criado_ms INTEGER, atualizado_ms INTEGER)`,
  "CREATE INDEX IF NOT EXISTS fin_lanc_org_data ON fin_lanc(org_id, data)",
  "CREATE UNIQUE INDEX IF NOT EXISTS fin_lanc_externa ON fin_lanc(org_id, chave_externa)",
  `CREATE TABLE IF NOT EXISTS fin_recorrente (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, tipo TEXT NOT NULL, descricao TEXT NOT NULL,
    valor_cent INTEGER NOT NULL, categoria TEXT, dia INTEGER NOT NULL DEFAULT 5, ativo INTEGER NOT NULL DEFAULT 1, ultimo_mes TEXT, criado_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS fin_config (org_id INTEGER PRIMARY KEY, email_mensal INTEGER NOT NULL DEFAULT 1, emails TEXT, moeda TEXT DEFAULT 'BRL',
    ultimo_envio TEXT, atualizado_ms INTEGER)`
];

export const CATEGORIAS = {
  ENTRADA: ["Vendas e serviços", "Locação / diárias", "Aluguéis recebidos", "Comissões", "Outras receitas"],
  SAIDA: ["Fornecedores e peças", "Salários e comissões", "Aluguel e condomínio", "Água, luz, internet e telefone", "Impostos e taxas",
    "Marketing e anúncios", "Sistemas e assinaturas", "Transporte e combustível", "Manutenção", "Tarifas bancárias", "Retirada dos sócios", "Transferências", "Outras despesas"]
};
// Categorias por perfil de administração (Administração → Ajustes): somam-se às padrão.
export const CATEGORIAS_PERFIL = {
  comercial: { ENTRADA: ["Aluguéis recebidos", "Condomínio recebido", "Multas e juros recebidos", "Outras receitas"],
    SAIDA: ["Funcionários: salários", "Funcionários: encargos (INSS / FGTS)", "Energia", "Água e esgoto", "Internet e telefone", "Limpeza e material de limpeza", "Segurança e portaria", "Manutenção", "IPTU", "Impostos e taxas", "Contabilidade", "Seguro do prédio", "Tarifas bancárias", "Retirada dos sócios", "Transferências", "Outras despesas"] },
  pessoal: { ENTRADA: ["Aluguéis recebidos", "Salário e pró-labore", "Outras receitas"],
    SAIDA: ["Condomínio", "IPTU", "Energia", "Água", "Internet e telefone", "Escola e educação", "Saúde e plano", "Pensão", "Cartão de crédito", "Empréstimo e financiamento", "Funcionários domésticos", "Veículo", "Manutenção de imóvel", "Advogado e custas", "Seguro", "Despesas pessoais", "Outras despesas"] },
  temporada: { ENTRADA: ["Locação / diárias", "Taxa de limpeza", "Taxa de administração", "Outras receitas"],
    SAIDA: ["Limpeza e faxina", "Lavanderia", "Enxoval e reposição", "Manutenção", "Condomínio", "Energia", "Água", "Internet e TV", "Taxas das plataformas", "Repasse ao proprietário", "Impostos e taxas", "Outras despesas"] },
  mei: { ENTRADA: ["Serviços prestados", "Outras receitas"], SAIDA: ["DAS do MEI", "Contador", "Celular e internet", "Transporte", "Material de trabalho", "Cursos", "Outras despesas"] }
};
const FORMAS = ["Pix", "Dinheiro", "Cartão de crédito", "Cartão de débito", "Boleto", "Transferência", "Débito automático", "Cheque", "Outro"];
const MOEDAS = { BRL: "pt-BR", USD: "en-US", EUR: "de-DE", GBP: "en-GB", ARS: "es-AR", CLP: "es-CL", MXN: "es-MX", COP: "es-CO", PEN: "es-PE", UYU: "es-UY", PYG: "es-PY" };

// Pagamento em mais de uma forma (parte Pix, parte dinheiro…), categorias da empresa, mês fechado, orçamento e histórico.
const DDL_FIN_EXTRA = [
  "CREATE TABLE IF NOT EXISTS fin_partes (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, lanc_id INTEGER NOT NULL, forma TEXT, valor_cent INTEGER NOT NULL, conta_id INTEGER)",
  "CREATE INDEX IF NOT EXISTS fin_partes_lanc ON fin_partes(org_id, lanc_id)",
  "CREATE TABLE IF NOT EXISTS fin_categorias (org_id INTEGER NOT NULL, tipo TEXT NOT NULL, nome TEXT NOT NULL, oculta INTEGER NOT NULL DEFAULT 0, criado_ms INTEGER, PRIMARY KEY (org_id, tipo, nome))",
  "CREATE TABLE IF NOT EXISTS fin_fechamento (org_id INTEGER NOT NULL, mes TEXT NOT NULL, fechado INTEGER NOT NULL DEFAULT 1, obs TEXT, por TEXT, ms INTEGER, PRIMARY KEY (org_id, mes))",
  "CREATE TABLE IF NOT EXISTS fin_orcamento (org_id INTEGER NOT NULL, tipo TEXT NOT NULL, categoria TEXT NOT NULL, valor_cent INTEGER NOT NULL, PRIMARY KEY (org_id, tipo, categoria))",
  "CREATE TABLE IF NOT EXISTS fin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, lanc_id INTEGER, acao TEXT NOT NULL, detalhe TEXT, por TEXT, ms INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS fin_log_org ON fin_log(org_id, ms)",
  "CREATE INDEX IF NOT EXISTS fin_lanc_pago ON fin_lanc(org_id, pago_em)"
];
const prontos = new WeakSet();
export async function garantirFinanceiro(env) {
  if (prontos.has(env.DB)) return;
  for (const s of DDL_FINANCEIRO) await env.DB.prepare(s).run();
  // Colunas da Administração: conta (banco/caixa), locatário, competência, valor efetivamente pago e centro de custo.
  for (const c of ["conta_id INTEGER", "locatario_id INTEGER", "competencia TEXT", "valor_pago_cent INTEGER", "centro TEXT", "fora_conta INTEGER"]) await env.DB.prepare("ALTER TABLE fin_lanc ADD COLUMN " + c).run().catch(() => { });
  for (const c of ["freq TEXT", "inicio_mes TEXT", "dia_semana INTEGER", "ate_mes TEXT", "forma TEXT", "contato TEXT", "centro TEXT", "conta_id INTEGER"]) await env.DB.prepare("ALTER TABLE fin_recorrente ADD COLUMN " + c).run().catch(() => { });
  for (const s of DDL_FIN_EXTRA) await env.DB.prepare(s).run();
  prontos.add(env.DB);
}

const re = (s, n = 200) => String(s ?? "").replace(/[\u0000-\u001F]/g, " ").trim().slice(0, n);
export const dataValida = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) && !Number.isNaN(Date.parse(d + "T12:00:00Z"));
export const mesValido = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ""));
// "1.234,56", "1234.56", "R$ -12,30", 1234.5 → centavos (inteiro). Devolve null se não for número.
export function centavos(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  let s = String(v ?? "").replace(/[^\d,.\-]/g, "");
  if (!s || !/\d/.test(s)) return null;
  const neg = s.includes("-"); s = s.replace(/-/g, "");
  const ul = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  // Último separador com 1 ou 2 dígitos depois dele é o decimal; os outros são de milhar.
  if (ul >= 0 && s.length - ul - 1 <= 2) s = s.slice(0, ul).replace(/[.,]/g, "") + "." + s.slice(ul + 1);
  else s = s.replace(/[.,]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -1 : 1) * Math.round(n * 100) : null;
}
export function dinheiro(cent, moeda = "BRL") {
  const m = MOEDAS[moeda] ? moeda : "BRL";
  return new Intl.NumberFormat(MOEDAS[m], { style: "currency", currency: m }).format((Number(cent) || 0) / 100);
}
const mesDe = d => String(d).slice(0, 7);
const somarDiasF = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
function somarMes(mes, n) { const [a, m] = mes.split("-").map(Number); const t = new Date(Date.UTC(a, m - 1 + n, 1)); return t.toISOString().slice(0, 7); }
const NOMES_MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MES_LONGO = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const nomeMes = mes => `${MES_LONGO[Number(mes.slice(5, 7)) - 1]} de ${mes.slice(0, 4)}`;
const ultimoDia = mes => { const [a, m] = mes.split("-").map(Number); return new Date(Date.UTC(a, m, 0)).getUTCDate(); };
const hojeLocal = agoraMs => new Date(agoraMs - 3 * 3600000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Extrato do banco
// ---------------------------------------------------------------------------

// OFX (SGML ou XML): cada <STMTTRN> vira um lançamento; FITID evita duplicar ao importar de novo.
export function lerOfx(texto) {
  const t = String(texto || "");
  const itens = [];
  for (const bloco of t.split(/<STMTTRN>/i).slice(1)) {
    const corpo = bloco.split(/<\/STMTTRN>/i)[0];
    const campo = n => { const m = corpo.match(new RegExp(`<${n}>([^<\\r\\n]*)`, "i")); return m ? m[1].trim() : ""; };
    const d = campo("DTPOSTED"), v = centavos(campo("TRNAMT").replace(",", "."));
    if (!/^\d{8}/.test(d) || v === null || v === 0) continue;
    const data = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    if (!dataValida(data)) continue;
    const desc = re(campo("MEMO") || campo("NAME") || "Lançamento do banco", 160);
    const id = campo("FITID");
    itens.push({ data, valor_cent: v, descricao: desc, chave: id ? "ofx:" + id : `ofx:${data}:${v}:${desc}` });
  }
  return itens;
}
// CSV de banco/planilha: acha as colunas de data, descrição e valor (ou crédito/débito) pelo cabeçalho.
export function lerCsv(texto) {
  const linhas = String(texto || "").replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
  if (linhas.length < 2) return [];
  const sep = [";", "\t", ","].map(s => [s, linhas[0].split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const partir = l => { const out = []; let cur = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map(x => x.trim()); };
  const cab = partir(linhas[0]).map(c => c.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
  const achar = (...ps) => cab.findIndex(c => ps.some(p => c.includes(p)));
  const iData = achar("data", "date"), iDesc = achar("descri", "historico", "lancamento", "memo", "detalhe", "description"),
    iValor = achar("valor", "value", "amount", "quantia"), iCred = achar("credito", "entrada"), iDeb = achar("debito", "saida");
  if (iData < 0 || (iValor < 0 && iCred < 0 && iDeb < 0)) return [];
  const itens = [];
  for (const l of linhas.slice(1)) {
    const c = partir(l);
    let data = c[iData] || "";
    let m;
    if ((m = data.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) data = `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    else data = data.slice(0, 10);
    if (!dataValida(data)) continue;
    let v = iValor >= 0 ? centavos(c[iValor]) : null;
    if (v === null || v === 0) { const cr = iCred >= 0 ? centavos(c[iCred]) || 0 : 0, db = iDeb >= 0 ? centavos(c[iDeb]) || 0 : 0; v = cr ? Math.abs(cr) : db ? -Math.abs(db) : null; }
    if (!v) continue;
    const descricao = re(iDesc >= 0 ? c[iDesc] : "Lançamento do extrato", 160) || "Lançamento do extrato";
    itens.push({ data, valor_cent: v, descricao, chave: `csv:${data}:${v}:${descricao}` });
  }
  return itens;
}
// Categoria provável pela descrição (o dono pode trocar depois).
export function categoriaProvavel(descricao, tipo) {
  const d = String(descricao || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const regras = tipo === "ENTRADA" ? [[/aluguel|airbnb|booking|vrbo|diaria|hosped/, "Locação / diárias"], [/comiss/, "Comissões"], [/pix|ted|doc|receb|venda|servico|conserto|reparo|manutenc|instalac|orcamento|cliente|cartao|stone|cielo|rede|getnet|pagseguro|mercado ?pago|sumup/, "Vendas e serviços"]]
    : [[/fornecedor|peca|compra|mercadoria|estoque|atacado|distribuidora/, "Fornecedores e peças"], [/salario|folha|comiss|vale|ferias|13/, "Salários e comissões"], [/aluguel|condominio|iptu/, "Aluguel e condomínio"], [/luz|energia|light|enel|cemig|agua|cedae|sabesp|internet|vivo|claro|tim|oi |telefone/, "Água, luz, internet e telefone"],
      [/das|simples|darf|gps|inss|fgts|iss|icms|imposto|taxa|tributo/, "Impostos e taxas"], [/facebook|meta|google ads|instagram|anuncio|marketing/, "Marketing e anúncios"], [/tarifa|iof|juros|manutencao conta|pacote/, "Tarifas bancárias"],
      [/posto|combust|gasolina|uber|99|estacion|pedagio/, "Transporte e combustível"], [/assinatura|software|sistema|openai|hostinger|microsoft|adobe|canva/, "Sistemas e assinaturas"], [/pro.?labore|retirada|socio/, "Retirada dos sócios"]];
  for (const [r, c] of regras) if (r.test(d)) return c;
  return tipo === "ENTRADA" ? "Outras receitas" : "Outras despesas";
}

// ---------------------------------------------------------------------------
// Resumo do mês
// ---------------------------------------------------------------------------

export async function resumoDoMes(env, orgId, mes, agoraMs) {
  await garantirFinanceiro(env);
  const de = mes + "-01", ate = mes + "-" + String(ultimoDia(mes)).padStart(2, "0");
  const lanc = (await env.DB.prepare("SELECT * FROM fin_lanc WHERE org_id=? AND data BETWEEN ? AND ? ORDER BY data, id").bind(orgId, de, ate).all()).results || [];
  const hoje = hojeLocal(agoraMs);
  const t = { entradas: 0, saidas: 0, a_receber: 0, a_pagar: 0, vencidas_pagar: 0, vencidas_receber: 0 };
  const cats = {};
  for (const l of lanc) {
    if (l.fora_conta) continue; // pago fora da conta da empresa: não entra nos números
    const ent = l.tipo === "ENTRADA";
    if (l.pago) { t[ent ? "entradas" : "saidas"] += l.valor_cent; const k = (ent ? "E|" : "S|") + (l.categoria || (ent ? "Outras receitas" : "Outras despesas")); cats[k] = (cats[k] || 0) + l.valor_cent; }
    else { t[ent ? "a_receber" : "a_pagar"] += l.valor_cent; if (l.data < hoje) t[ent ? "vencidas_receber" : "vencidas_pagar"] += l.valor_cent; }
  }
  t.saldo = t.entradas - t.saidas;
  t.margem = t.entradas ? Math.round(1000 * t.saldo / t.entradas) / 10 : null;
  const categorias = Object.entries(cats).map(([k, v]) => ({ tipo: k[0] === "E" ? "ENTRADA" : "SAIDA", categoria: k.slice(2), valor_cent: v })).sort((a, b) => b.valor_cent - a.valor_cent);
  // Últimos 6 meses (só o que foi pago/recebido), para o gráfico e a comparação.
  const ini = somarMes(mes, -5) + "-01";
  const serieR = (await env.DB.prepare("SELECT substr(data,1,7) AS mes, tipo, SUM(valor_cent) AS v FROM fin_lanc WHERE org_id=? AND pago=1 AND COALESCE(fora_conta,0)=0 AND data BETWEEN ? AND ? GROUP BY 1,2").bind(orgId, ini, ate).all()).results || [];
  const serie = [];
  for (let i = -5; i <= 0; i++) {
    const m = somarMes(mes, i);
    const e = serieR.find(x => x.mes === m && x.tipo === "ENTRADA")?.v || 0, s = serieR.find(x => x.mes === m && x.tipo === "SAIDA")?.v || 0;
    serie.push({ mes: m, rotulo: NOMES_MES[Number(m.slice(5)) - 1] + "/" + m.slice(2, 4), entradas: e, saidas: s, saldo: e - s });
  }
  const ant = serie[4];
  const variacao = (a, b) => b ? Math.round(1000 * (a - b) / Math.abs(b)) / 10 : null;
  const comparativo = { entradas: variacao(t.entradas, ant.entradas), saidas: variacao(t.saidas, ant.saidas), saldo: variacao(t.saldo, ant.saldo) };
  const proximas = (await env.DB.prepare("SELECT * FROM fin_lanc WHERE org_id=? AND pago=0 AND data <= date(?, '+15 day') ORDER BY data LIMIT 30").bind(orgId, hoje).all()).results || [];
  return { mes, nome: nomeMes(mes), totais: t, categorias, serie, comparativo, lancamentos: lanc.length, proximas, hoje };
}

// Recorrentes: cria a conta de cada ocorrência uma vez só (aluguel, internet, salário...).
// Frequências: semanal (no dia da semana), mensal, bimestral, trimestral, semestral e anual (contando do mês de início).
export const FREQUENCIAS = { semanal: "Toda semana", mensal: "Todo mês", bimestral: "A cada 2 meses", trimestral: "A cada 3 meses", semestral: "A cada 6 meses", anual: "Todo ano" };
const PASSO = { mensal: 1, bimestral: 2, trimestral: 3, semestral: 6, anual: 12 };
const mesesEntre = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
export function ocorrencias(r, mes) {
  const freq = FREQUENCIAS[r.freq] ? r.freq : "mensal", inicio = r.inicio_mes || (r.criado_ms ? new Date(r.criado_ms - 3 * 3600000).toISOString().slice(0, 7) : mes);
  if (mes < inicio || (r.ate_mes && mes > r.ate_mes)) return [];
  if (freq === "semanal") {
    const ds = [], alvo = Number.isInteger(r.dia_semana) ? r.dia_semana : 1;
    for (let d = 1; d <= ultimoDia(mes); d++) { const x = `${mes}-${String(d).padStart(2, "0")}`; if (new Date(x + "T12:00:00Z").getUTCDay() === alvo) ds.push(x); }
    return ds;
  }
  if (mesesEntre(inicio, mes) % PASSO[freq]) return [];
  return [`${mes}-${String(Math.min(Math.max(1, r.dia || 1), ultimoDia(mes))).padStart(2, "0")}`];
}
const chaveRec = (r, data) => r.freq === "semanal" ? `rec:${r.id}:${data}` : `rec:${r.id}:${data.slice(0, 7)}`;
export async function gerarRecorrentes(env, orgId, mes, agoraMs) {
  await garantirFinanceiro(env);
  const rs = (await env.DB.prepare("SELECT * FROM fin_recorrente WHERE org_id=? AND ativo=1 AND (ultimo_mes IS NULL OR ultimo_mes < ?)").bind(orgId, mes).all()).results || [];
  let n = 0;
  for (const r of rs) {
    for (const data of ocorrencias(r, mes)) {
      const x = await env.DB.prepare(`INSERT OR IGNORE INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,recorrente_id,origem,chave_externa,criado_por,criado_ms,forma,contato,centro,conta_id)
        VALUES(?,?,?,?,?,?,0,?,'recorrente',?,'DENIA',?,?,?,?,?)`).bind(orgId, r.tipo, r.descricao, r.valor_cent, r.categoria, data, r.id, chaveRec(r, data), agoraMs, r.forma || null, r.contato || null, r.centro || null, r.conta_id || null).run();
      if (x.meta?.changes) n++;
    }
    await env.DB.prepare("UPDATE fin_recorrente SET ultimo_mes=? WHERE id=?").bind(mes, r.id).run();
  }
  return n;
}
// Meses futuros: o que já está programado (contas fixas e aluguéis) aparece como previsto, sem criar nada.
export async function previstosDoMes(env, orgId, mes) {
  await garantirFinanceiro(env);
  const out = [];
  const rs = (await env.DB.prepare("SELECT * FROM fin_recorrente WHERE org_id=? AND ativo=1").bind(orgId).all()).results || [];
  for (const r of rs) for (const data of ocorrencias(r, mes)) {
    const ja = await env.DB.prepare("SELECT 1 FROM fin_lanc WHERE org_id=? AND chave_externa=?").bind(orgId, chaveRec(r, data)).first();
    if (!ja) out.push({ id: null, previsto: true, origem: "recorrente", recorrente_id: r.id, tipo: r.tipo, descricao: r.descricao, valor_cent: r.valor_cent, categoria: r.categoria, data, pago: 0, contato: r.contato || null, forma: r.forma || null });
  }
  try {
    const fim = `${mes}-${String(ultimoDia(mes)).padStart(2, "0")}`;
    const ls = (await env.DB.prepare("SELECT * FROM adm_locatarios WHERE org_id=? AND ativo=1 AND (inicio IS NULL OR inicio <= ?) AND (fim IS NULL OR fim = '' OR fim >= ?)").bind(orgId, fim, mes + "-01").all()).results || [];
    const isentos = new Set(((await env.DB.prepare("SELECT locatario_id FROM adm_isencoes WHERE org_id=? AND mes=?").bind(orgId, mes).all().catch(() => null))?.results || []).map(x => x.locatario_id));
    for (const l of ls) {
      const total = (l.aluguel_cent || 0) + (l.condominio_cent || 0) + (l.outras_cent || 0);
      if (total <= 0 || isentos.has(l.id)) continue;
      const datas = l.periodicidade === "semanal" ? ocorrencias({ freq: "semanal", dia_semana: l.dia_semana ?? 1, inicio_mes: mes }, mes) : [`${mes}-${String(Math.min(Math.max(1, l.dia_venc || 5), ultimoDia(mes))).padStart(2, "0")}`];
      for (const data of datas) {
        const chave = l.periodicidade === "semanal" ? `alug:${l.id}:${data}` : `alug:${l.id}:${mes}`;
        if (await env.DB.prepare("SELECT 1 FROM fin_lanc WHERE org_id=? AND chave_externa=?").bind(orgId, chave).first()) continue;
        out.push({ id: null, previsto: true, origem: "aluguel", tipo: "ENTRADA", descricao: `Aluguel${l.unidade ? " — " + l.unidade : ""} — ${l.nome}`, valor_cent: l.periodicidade === "semanal" ? Math.round(total) : total, categoria: "Aluguéis recebidos", data, pago: 0, contato: l.nome, locatario_id: l.id });
      }
    }
  } catch { /* sem administração */ }
  return out.sort((a, b) => a.data.localeCompare(b.data));
}

// ---------------------------------------------------------------------------
// Relatório (texto, PDF e análise da IA)
// ---------------------------------------------------------------------------

const paraBase64 = b => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const pct = v => v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${String(v).replace(".", ",")}%`;
export function textoDoRelatorio(r, empresa, moeda = "BRL") {
  const f = c => dinheiro(c, moeda), t = r.totais;
  const linhas = [
    `Resumo financeiro de ${r.nome}${empresa ? " — " + empresa : ""}`, "",
    `Entradas recebidas: ${f(t.entradas)} (${pct(r.comparativo.entradas)} sobre o mês anterior)`,
    `Saídas pagas: ${f(t.saidas)} (${pct(r.comparativo.saidas)})`,
    `Resultado do mês: ${f(t.saldo)}${t.margem !== null ? ` — margem de ${String(t.margem).replace(".", ",")}%` : ""}`,
    `A receber em aberto: ${f(t.a_receber)}${t.vencidas_receber ? ` (${f(t.vencidas_receber)} já vencido)` : ""}`,
    `A pagar em aberto: ${f(t.a_pagar)}${t.vencidas_pagar ? ` (${f(t.vencidas_pagar)} já vencido)` : ""}`
  ];
  const gastos = r.categorias.filter(c => c.tipo === "SAIDA").slice(0, 5);
  if (gastos.length) linhas.push("", "Onde o dinheiro foi:", ...gastos.map(c => `• ${c.categoria}: ${f(c.valor_cent)}${t.saidas ? ` (${Math.round(100 * c.valor_cent / t.saidas)}%)` : ""}`));
  return linhas.join("\n");
}
export function pdfDoRelatorio(r, empresa, moeda = "BRL", analise = "") {
  const f = c => dinheiro(c, moeda), t = r.totais;
  const blocos = [
    { tipo: "metricas", itens: [
      { rotulo: "Entradas", valor: f(t.entradas), nota: `${pct(r.comparativo.entradas)} vs. mês anterior`, cor: "#16a34a" },
      { rotulo: "Saídas", valor: f(t.saidas), nota: `${pct(r.comparativo.saidas)} vs. mês anterior`, cor: "#dc2626" },
      { rotulo: "Resultado", valor: f(t.saldo), nota: t.margem !== null ? `Margem ${String(t.margem).replace(".", ",")}%` : "Sem entradas no mês", cor: t.saldo >= 0 ? "#2563eb" : "#dc2626" },
      { rotulo: "Em aberto", valor: f(t.a_receber - t.a_pagar), nota: `Receber ${f(t.a_receber)} · Pagar ${f(t.a_pagar)}`, cor: "#9333ea" }] },
    { tipo: "titulo", texto: "Entradas e saídas nos últimos 6 meses" },
    { tipo: "barras", rotulos: r.serie.map(s => s.rotulo), series: [{ nome: "Entradas", cor: "#16a34a", valores: r.serie.map(s => s.entradas) }, { nome: "Saídas", cor: "#dc2626", valores: r.serie.map(s => s.saidas) }], formato: c => f(c) }
  ];
  const gastos = r.categorias.filter(c => c.tipo === "SAIDA");
  if (gastos.length) blocos.push({ tipo: "titulo", texto: "Para onde foi o dinheiro" },
    { tipo: "tabela", colunas: ["Categoria", "Valor", "% das saídas"], larguras: [3, 1.4, 1], linhas: gastos.map(c => [c.categoria, f(c.valor_cent), t.saidas ? `${Math.round(100 * c.valor_cent / t.saidas)}%` : "—"]) });
  const receitas = r.categorias.filter(c => c.tipo === "ENTRADA");
  if (receitas.length) blocos.push({ tipo: "titulo", texto: "De onde veio o dinheiro" },
    { tipo: "tabela", colunas: ["Categoria", "Valor", "% das entradas"], larguras: [3, 1.4, 1], linhas: receitas.map(c => [c.categoria, f(c.valor_cent), t.entradas ? `${Math.round(100 * c.valor_cent / t.entradas)}%` : "—"]) });
  if (r.proximas.length) blocos.push({ tipo: "titulo", texto: "Contas dos próximos 15 dias e vencidas" },
    { tipo: "tabela", colunas: ["Vencimento", "Descrição", "Tipo", "Valor"], larguras: [1, 3, 1, 1.3], linhas: r.proximas.map(l => [l.data.split("-").reverse().join("/"), l.descricao, l.tipo === "ENTRADA" ? "Receber" : "Pagar", f(l.valor_cent)]) });
  if (analise) blocos.push({ tipo: "titulo", texto: "Leitura da DENIA" }, { tipo: "texto", texto: analise });
  if (!r.lancamentos) blocos.push({ tipo: "texto", texto: "Nenhum lançamento neste mês. Cadastre entradas e saídas ou importe o extrato do banco (OFX ou CSV) em Administração → Financeiro." });
  return gerarPdf({ titulo: "Relatório financeiro", subtitulo: `${empresa ? empresa + " · " : ""}${r.nome}`, rodape: "DENIA · valores conforme lançados na plataforma (pagos/recebidos no mês)", corPrincipal: "#0f766e", blocos });
}
// A IA lê só os números (sem nomes de clientes) e escreve 3 a 5 pontos práticos. Nada inventado.
export async function analiseDaIA(envIA, openai, r, moeda = "BRL") {
  if (!String(envIA.OPENAI_API_KEY || "").trim()) return "";
  const dados = { mes: r.nome, totais: r.totais, comparativo_pct: r.comparativo, categorias: r.categorias, ultimos_6_meses: r.serie, moeda };
  const d = await openai(envIA, "responses", {
    model: String(envIA.OPENAI_MODEL || "gpt-5.6-luna").trim(),
    instructions: "Você é a analista financeira da DENIA para pequenas empresas. Valores em centavos. Escreva em português simples, de 3 a 5 pontos curtos (cada um começando com '• '), só com base nos números recebidos: o que melhorou, o que piorou, o maior gasto e uma ação prática para o próximo mês. Não invente dados, não dê conselho jurídico ou tributário, não cite números que não estejam nos dados. Se houver poucos dados, diga isso.",
    input: JSON.stringify(dados), max_output_tokens: 700
  }, { timeout: 40000 });
  return re(d?.output_text || (d?.output || []).flatMap(o => o.content || []).map(c => c.text || "").join("\n"), 2500);
}

// ---------------------------------------------------------------------------
// Rotas: /api/orgs/:id/fin/...
// ---------------------------------------------------------------------------

export async function rotasFinanceiro(request, env, k, orgId, papel, resto) {
  const { json, lerCorpo, pode, agora } = k;
  if (!pode(papel, "ADMIN")) return json({ erro: "O financeiro é visível só para o dono e os administradores da empresa." }, 403);
  await garantirFinanceiro(env);
  const url = new URL(request.url), metodo = request.method, partes = resto.split("/").slice(1);
  const ms = agora(env), hoje = hojeLocal(ms);
  const config = async () => (await env.DB.prepare("SELECT * FROM fin_config WHERE org_id=?").bind(orgId).first()) || { org_id: orgId, email_mensal: 1, emails: "", moeda: "BRL" };
  const empresa = async () => (await env.DB.prepare("SELECT nome FROM plt_organizacoes WHERE id=?").bind(orgId).first().catch(() => null))?.nome || "";
  const mesPedido = () => mesValido(url.searchParams.get("mes")) ? url.searchParams.get("mes") : hoje.slice(0, 7);
  const validar = c => {
    const tipo = c.tipo === "ENTRADA" ? "ENTRADA" : c.tipo === "SAIDA" ? "SAIDA" : null;
    const v = centavos(c.valor);
    if (!tipo) return "Escolha se é entrada ou saída.";
    if (!re(c.descricao)) return "Escreva uma descrição (ex.: Aluguel da loja).";
    if (v === null || v <= 0) return "Informe um valor maior que zero.";
    if (v > 1e13) return "Valor alto demais.";
    if (!dataValida(c.data)) return "Data inválida.";
    return { tipo, valor_cent: Math.abs(v), descricao: re(c.descricao, 160), categoria: re(c.categoria, 60) || categoriaProvavel(c.descricao, tipo), data: c.data,
      pago: c.pago ? 1 : 0, pago_em: c.pago ? (dataValida(c.pago_em) ? c.pago_em : c.data <= hoje ? c.data : hoje) : null, forma: re(c.forma, 30) || null, contato: re(c.contato, 120) || null, obs: re(c.obs, 500) || null,
      conta_id: Number(c.conta_id) > 0 ? Number(c.conta_id) : null, centro: re(c.centro, 60) || null, fora_conta: c.fora_conta ? 1 : 0 };
  };

  const quem = k.sessao?.usuario?.email || null;
  // Histórico: quem fez o quê, quando (não dá para apagar pela tela).
  const registrar = (acao, lancId, detalhe) => env.DB.prepare("INSERT INTO fin_log(org_id,lanc_id,acao,detalhe,por,ms) VALUES(?,?,?,?,?,?)").bind(orgId, lancId || null, acao, re(typeof detalhe === "string" ? detalhe : JSON.stringify(detalhe), 1500), quem, ms).run().catch(() => { });
  // Mês fechado: ninguém altera lançamentos daquele mês até reabrir (com motivo).
  const fechados = new Set(((await env.DB.prepare("SELECT mes FROM fin_fechamento WHERE org_id=? AND fechado=1").bind(orgId).all()).results || []).map(x => x.mes));
  const travado = (...datas) => { const m = datas.filter(Boolean).map(d => String(d).slice(0, 7)).find(x => fechados.has(x)); return m ? json({ erro: `O mês de ${nomeMes(m)} está fechado. Para alterar, reabra em Financeiro → Fechamento do mês (com o motivo).`, codigo: "MES_FECHADO" }, 409) : null; };
  // Partes do pagamento: [{forma, valor, conta_id}] — várias formas no mesmo recebimento ou pagamento.
  const lerPartes = lista => {
    if (!Array.isArray(lista)) return null;
    const ps = lista.map(x => ({ forma: re(x.forma, 30) || null, valor_cent: centavos(x.valor), conta_id: Number(x.conta_id) > 0 ? Number(x.conta_id) : null })).filter(x => x.valor_cent);
    if (ps.some(x => x.valor_cent < 0)) return "Valor inválido numa das formas de pagamento.";
    return ps.length ? ps : null;
  };
  const gravarPartes = async (lancId, ps) => {
    await env.DB.prepare("DELETE FROM fin_partes WHERE org_id=? AND lanc_id=?").bind(orgId, lancId).run();
    if (!ps || ps.length < 2) return;
    for (const x of ps) await env.DB.prepare("INSERT INTO fin_partes(org_id,lanc_id,forma,valor_cent,conta_id) VALUES(?,?,?,?,?)").bind(orgId, lancId, x.forma, x.valor_cent, x.conta_id).run();
  };
  const formaDasPartes = ps => [...new Set(ps.map(x => x.forma || "Outro"))].join(" + ");
  const comPartes = async lista => {
    const ids = lista.filter(l => l.id && /\+/.test(l.forma || "")).map(l => l.id);
    if (!ids.length) return lista;
    const ps = (await env.DB.prepare(`SELECT * FROM fin_partes WHERE org_id=? AND lanc_id IN (${ids.map(() => "?").join(",")})`).bind(orgId, ...ids).all()).results || [];
    return lista.map(l => ({ ...l, partes: ps.filter(x => x.lanc_id === l.id) }));
  };
  const categoriasDa = async () => {
    const cats = { ENTRADA: [...CATEGORIAS.ENTRADA], SAIDA: [...CATEGORIAS.SAIDA] };
    const perfilCats = CATEGORIAS_PERFIL[(await env.DB.prepare("SELECT perfil FROM adm_config WHERE org_id=?").bind(orgId).first().catch(() => null))?.perfil];
    if (perfilCats) for (const t of ["ENTRADA", "SAIDA"]) cats[t] = [...new Set([...perfilCats[t].filter(c => !/^Outr/.test(c)), ...cats[t]])];
    const proprias = (await env.DB.prepare("SELECT * FROM fin_categorias WHERE org_id=?").bind(orgId).all()).results || [];
    const usadas = (await env.DB.prepare("SELECT DISTINCT tipo, categoria FROM fin_lanc WHERE org_id=? AND categoria IS NOT NULL LIMIT 400").bind(orgId).all()).results || [];
    for (const u of [...proprias.filter(x => !x.oculta).map(x => ({ tipo: x.tipo, categoria: x.nome })), ...usadas]) if (cats[u.tipo] && !cats[u.tipo].includes(u.categoria)) cats[u.tipo].push(u.categoria);
    for (const x of proprias.filter(x => x.oculta)) if (cats[x.tipo]) cats[x.tipo] = cats[x.tipo].filter(c => c !== x.nome);
    return cats;
  };

  if (partes[0] === "opcoes" && metodo === "GET") {
    const contas = (await env.DB.prepare("SELECT id, nome, tipo, padrao FROM adm_contas WHERE org_id=? AND ativo=1 ORDER BY padrao DESC, tipo, id").bind(orgId).all().catch(() => null))?.results || [];
    const centros = (await env.DB.prepare("SELECT id, nome, subtipo FROM adm_cadastros WHERE org_id=? AND tipo='CENTRO' AND ativo=1 ORDER BY nome").bind(orgId).all().catch(() => null))?.results || [];
    const fornecedores = (await env.DB.prepare("SELECT id, nome, subtipo FROM adm_cadastros WHERE org_id=? AND tipo='FORNECEDOR' AND ativo=1 ORDER BY nome LIMIT 500").bind(orgId).all().catch(() => null))?.results || [];
    const perfil = (await env.DB.prepare("SELECT perfil FROM adm_config WHERE org_id=?").bind(orgId).first().catch(() => null))?.perfil || null;
    return json({ categorias: await categoriasDa(), formas: FORMAS, frequencias: FREQUENCIAS, moedas: Object.keys(MOEDAS), config: await config(), hoje, contas, centros, fornecedores, perfil, fechados: [...fechados].sort() });
  }
  if (partes[0] === "resumo" && metodo === "GET") {
    const mes = mesPedido();
    if (mes <= hoje.slice(0, 7)) await gerarRecorrentes(env, orgId, mes, ms);
    const r = await resumoDoMes(env, orgId, mes, ms);
    // Mês futuro: soma o que já está programado (contas fixas e aluguéis) como previsto.
    if (mes > hoje.slice(0, 7)) {
      const prev = await previstosDoMes(env, orgId, mes);
      r.totais.previsto_receber = prev.filter(x => x.tipo === "ENTRADA").reduce((a, x) => a + x.valor_cent, 0);
      r.totais.previsto_pagar = prev.filter(x => x.tipo === "SAIDA").reduce((a, x) => a + x.valor_cent, 0);
      r.totais.a_receber += r.totais.previsto_receber; r.totais.a_pagar += r.totais.previsto_pagar;
    }
    const orc = (await env.DB.prepare("SELECT * FROM fin_orcamento WHERE org_id=?").bind(orgId).all()).results || [];
    r.orcamento = orc.map(o => ({ ...o, realizado: (r.categorias.find(c => c.tipo === o.tipo && c.categoria === o.categoria) || {}).valor_cent || 0 }));
    return json({ ...r, fechado: fechados.has(mes), moeda: (await config()).moeda || "BRL" });
  }
  if (partes[0] === "lancamentos" && !partes[1]) {
    if (metodo === "GET") {
      const mes = mesPedido(), tipo = url.searchParams.get("tipo"), status = url.searchParams.get("status"), q = re(url.searchParams.get("q"), 60);
      let sql = "SELECT * FROM fin_lanc WHERE org_id=? AND data BETWEEN ? AND ?"; const args = [orgId, mes + "-01", mes + "-" + ultimoDia(mes)];
      if (tipo === "ENTRADA" || tipo === "SAIDA") { sql += " AND tipo=?"; args.push(tipo); }
      if (status === "aberto") sql += " AND pago=0"; else if (status === "pago") sql += " AND pago=1"; else if (status === "vencido") { sql += " AND pago=0 AND data<?"; args.push(hoje); }
      if (q) { sql += " AND (descricao LIKE ? OR categoria LIKE ? OR contato LIKE ?)"; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      let lista = await comPartes((await env.DB.prepare(sql + " ORDER BY data DESC, id DESC LIMIT 2000").bind(...args).all()).results || []);
      // Pagos neste mês mas lançados (vencidos) em outro: aparecem também, para o mês bater com o caixa.
      const pagosAqui = status === "aberto" ? [] : (await env.DB.prepare("SELECT * FROM fin_lanc WHERE org_id=? AND pago=1 AND pago_em BETWEEN ? AND ? AND data NOT BETWEEN ? AND ? ORDER BY pago_em DESC LIMIT 500").bind(orgId, mes + "-01", mes + "-" + ultimoDia(mes), mes + "-01", mes + "-" + ultimoDia(mes)).all()).results || [];
      if (!q && !tipo) lista = lista.concat((await comPartes(pagosAqui)).map(l => ({ ...l, de_outro_mes: true })));
      const previstos = mes > hoje.slice(0, 7) && status !== "pago" ? await previstosDoMes(env, orgId, mes) : [];
      return json({ lancamentos: lista, previstos, hoje, fechado: fechados.has(mes) });
    }
    if (metodo === "POST") {
      const { corpo, erro } = await lerCorpo(request); if (erro) return erro;
      const v = validar(corpo); if (typeof v === "string") return json({ erro: v }, 400);
      const parcelas = Math.min(Math.max(1, Number(corpo.parcelas) || 1), 60);
      const ps = lerPartes(corpo.partes); if (typeof ps === "string") return json({ erro: ps }, 400);
      const t = travado(v.data, v.pago_em); if (t) return t;
      const ids = [];
      for (let i = 0; i < parcelas; i++) {
        const [a, m, d] = v.data.split("-").map(Number);
        const mesI = somarMes(`${a}-${String(m).padStart(2, "0")}`, i), data = `${mesI}-${String(Math.min(d, ultimoDia(mesI))).padStart(2, "0")}`;
        const pagoAqui = i === 0 && v.pago, multi = pagoAqui && ps && ps.length > 1;
        const pagoTotal = multi ? ps.reduce((a0, x) => a0 + x.valor_cent, 0) : null;
        const valor = parcelas > 1 ? Math.round(v.valor_cent / parcelas) + (i === 0 ? v.valor_cent - Math.round(v.valor_cent / parcelas) * parcelas : 0) : v.valor_cent;
        const r = await env.DB.prepare(`INSERT INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,pago_em,forma,contato,obs,origem,criado_por,criado_ms,atualizado_ms,conta_id,centro,valor_pago_cent,fora_conta)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'${corpo.rapido ? "rapido" : "manual"}',?,?,?,?,?,?,${v.fora_conta})`).bind(orgId, v.tipo, parcelas > 1 ? `${v.descricao} (${i + 1}/${parcelas})` : v.descricao, valor,
          v.categoria, data, pagoAqui ? 1 : 0, pagoAqui ? v.pago_em : null, multi ? formaDasPartes(ps) : v.forma, v.contato, v.obs, quem, ms, ms, v.conta_id, v.centro, multi && pagoTotal !== valor ? pagoTotal : null).run();
        const id = r.meta?.last_row_id; ids.push(id);
        if (multi) await gravarPartes(id, ps);
      }
      const freq = FREQUENCIAS[corpo.frequencia] ? corpo.frequencia : corpo.repetir_todo_mes ? "mensal" : null;
      if (freq && parcelas === 1) {
        const rr = await env.DB.prepare("INSERT INTO fin_recorrente(org_id,tipo,descricao,valor_cent,categoria,dia,ativo,ultimo_mes,criado_ms,freq,inicio_mes,dia_semana,ate_mes,forma,contato,centro,conta_id) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)")
          .bind(orgId, v.tipo, v.descricao, v.valor_cent, v.categoria, Number(v.data.slice(8)), mesDe(v.data), ms, freq, mesDe(v.data), new Date(v.data + "T12:00:00Z").getUTCDay(), mesValido(corpo.ate_mes) ? corpo.ate_mes : null, v.forma, v.contato, v.centro, v.conta_id).run();
        // O lançamento de hoje já é a primeira ocorrência: liga ao recorrente para não duplicar.
        const prim = { id: rr.meta?.last_row_id, freq };
        await env.DB.prepare("UPDATE fin_lanc SET recorrente_id=?, chave_externa=? WHERE id=?").bind(prim.id, chaveRec(prim, v.data), ids[0]).run().catch(() => { });
        if (freq === "semanal") await gerarRecorrentes(env, orgId, mesDe(v.data), ms);
      }
      await registrar("criou", ids[0], { tipo: v.tipo, descricao: v.descricao, valor: v.valor_cent, data: v.data, pago: v.pago, parcelas, freq });
      return json({ ok: true, ids }, 201);
    }
  }
  if (partes[0] === "lancamentos" && /^\d+$/.test(partes[1] || "")) {
    const id = Number(partes[1]);
    const atual = await env.DB.prepare("SELECT * FROM fin_lanc WHERE id=? AND org_id=?").bind(id, orgId).first();
    if (!atual) return json({ erro: "Lançamento não encontrado." }, 404);
    if (partes[2] === "pagar" && metodo === "POST") {
      const { corpo } = await lerCorpo(request);
      const pago = corpo?.desfazer ? 0 : 1, quando = pago ? (dataValida(corpo?.data) ? corpo.data : hoje) : null;
      if (quando && quando > somarDiasF(hoje, 1)) return json({ erro: "A data do pagamento não pode ser no futuro." }, 400);
      const t = travado(atual.pago_em, quando); if (t) return t;
      const ps = pago ? lerPartes(corpo?.partes) : null; if (typeof ps === "string") return json({ erro: ps }, 400);
      const multi = ps && ps.length > 1;
      const vp = multi ? ps.reduce((a0, x) => a0 + x.valor_cent, 0) : pago && corpo?.valor_pago !== undefined && corpo.valor_pago !== "" ? centavos(corpo.valor_pago) : null;
      const forma = multi ? formaDasPartes(ps) : re(corpo?.forma, 30) || (ps && ps[0]?.forma) || null;
      await env.DB.prepare("UPDATE fin_lanc SET pago=?, pago_em=?, forma=COALESCE(?,forma), valor_pago_cent=?, conta_id=COALESCE(?, conta_id), atualizado_ms=? WHERE id=? AND org_id=?")
        .bind(pago, quando, forma, vp !== null && vp > 0 && vp !== atual.valor_cent ? Math.abs(vp) : null, pago && Number(corpo?.conta_id) > 0 ? Number(corpo.conta_id) : !multi && ps && ps[0]?.conta_id ? ps[0].conta_id : null, ms, id, orgId).run();
      await gravarPartes(id, multi ? ps : null);
      await registrar(pago ? (atual.tipo === "ENTRADA" ? "recebeu" : "pagou") : "desfez pagamento", id, { descricao: atual.descricao, data: quando, forma, valor: vp ?? atual.valor_cent });
      return json({ ok: true });
    }
    if (partes[2] === "historico" && metodo === "GET") return json({ historico: (await env.DB.prepare("SELECT * FROM fin_log WHERE org_id=? AND lanc_id=? ORDER BY ms DESC LIMIT 100").bind(orgId, id).all()).results || [] });
    if (metodo === "PUT") {
      const { corpo, erro } = await lerCorpo(request); if (erro) return erro;
      const v = validar({ ...atual, valor: atual.valor_cent / 100, ...corpo, forma: corpo.forma !== undefined ? corpo.forma : atual.forma }); if (typeof v === "string") return json({ erro: v }, 400);
      const t = travado(atual.data, atual.pago_em, v.data, v.pago_em); if (t) return t;
      if (corpo.fora_conta === undefined) v.fora_conta = atual.fora_conta ? 1 : 0;
      await env.DB.prepare("UPDATE fin_lanc SET tipo=?,descricao=?,valor_cent=?,categoria=?,data=?,pago=?,pago_em=?,forma=?,contato=?,obs=?,conta_id=?,centro=?,fora_conta=?,atualizado_ms=? WHERE id=? AND org_id=?")
        .bind(v.tipo, v.descricao, v.valor_cent, v.categoria, v.data, v.pago, v.pago_em, v.forma, v.contato, v.obs, v.conta_id, v.centro, v.fora_conta, ms, id, orgId).run();
      if (!v.pago) await gravarPartes(id, null);
      const mudou = Object.fromEntries(["descricao", "valor_cent", "categoria", "data", "pago", "pago_em", "forma", "contato"].filter(c => String(atual[c] ?? "") !== String(v[c] ?? "")).map(c => [c, [atual[c], v[c]]]));
      await registrar("editou", id, mudou);
      return json({ ok: true });
    }
    if (metodo === "DELETE") {
      const t = travado(atual.data, atual.pago_em); if (t) return t;
      await env.DB.prepare("DELETE FROM fin_lanc WHERE id=? AND org_id=?").bind(id, orgId).run();
      await gravarPartes(id, null);
      await registrar("apagou", id, { descricao: atual.descricao, valor: atual.valor_cent, data: atual.data, pago: atual.pago });
      return json({ ok: true });
    }
  }
  // Sugestões: contas que já existiram (para lançar de novo sem digitar tudo).
  if (partes[0] === "sugestoes" && metodo === "GET") {
    const ls = (await env.DB.prepare("SELECT tipo, descricao, categoria, contato, valor_cent, forma, centro, data FROM fin_lanc WHERE org_id=? ORDER BY data DESC, id DESC LIMIT 1500").bind(orgId).all()).results || [];
    const vistos = new Map();
    for (const l of ls) { const d = l.descricao.replace(/\s*\(\d+\/\d+\)$/, "").replace(/\s*\((dinheiro|pix|cartão|cartao|transferência|boleto)[^)]*\)$/i, ""); const k = l.tipo + "|" + d.toLowerCase(); if (!vistos.has(k)) vistos.set(k, { ...l, descricao: d }); }
    return json({ sugestoes: [...vistos.values()].slice(0, 400) });
  }
  // Categorias próprias: criar, renomear (leva junto os lançamentos) e ocultar.
  if (partes[0] === "categorias") {
    if (metodo === "GET") {
      const uso = (await env.DB.prepare("SELECT tipo, categoria, COUNT(*) n, SUM(valor_cent) v FROM fin_lanc WHERE org_id=? GROUP BY tipo, categoria").bind(orgId).all()).results || [];
      const ocultas = (await env.DB.prepare("SELECT tipo, nome FROM fin_categorias WHERE org_id=? AND oculta=1").bind(orgId).all()).results || [];
      const cats = await categoriasDa();
      return json({ categorias: Object.fromEntries(["ENTRADA", "SAIDA"].map(t => [t, cats[t].map(nome => ({ nome, uso: (uso.find(u => u.tipo === t && u.categoria === nome) || {}).n || 0 }))])), ocultas });
    }
    const { corpo, erro } = await lerCorpo(request); if (erro) return erro;
    const tipo = corpo.tipo === "ENTRADA" ? "ENTRADA" : corpo.tipo === "SAIDA" ? "SAIDA" : null, nome = re(corpo.nome, 60);
    if (!tipo) return json({ erro: "Escolha se a categoria é de entrada ou de saída." }, 400);
    if (metodo === "POST") {
      if (!nome) return json({ erro: "Escreva o nome da categoria." }, 400);
      await env.DB.prepare("INSERT INTO fin_categorias(org_id,tipo,nome,oculta,criado_ms) VALUES(?,?,?,0,?) ON CONFLICT(org_id,tipo,nome) DO UPDATE SET oculta=0").bind(orgId, tipo, nome, ms).run();
      return json({ ok: true }, 201);
    }
    if (metodo === "PUT") {
      const de = re(corpo.de, 60), para = nome;
      if (!de || !para) return json({ erro: "Informe o nome atual e o novo." }, 400);
      const meses = (await env.DB.prepare("SELECT DISTINCT substr(COALESCE(pago_em,data),1,7) m FROM fin_lanc WHERE org_id=? AND tipo=? AND categoria=?").bind(orgId, tipo, de).all()).results || [];
      const f = meses.map(x => x.m).find(m => fechados.has(m)); if (f) return json({ erro: `Há lançamentos dessa categoria em ${nomeMes(f)}, que está fechado. Reabra o mês para renomear.`, codigo: "MES_FECHADO" }, 409);
      const n = await env.DB.prepare("UPDATE fin_lanc SET categoria=? WHERE org_id=? AND tipo=? AND categoria=?").bind(para, orgId, tipo, de).run();
      await env.DB.prepare("UPDATE fin_recorrente SET categoria=? WHERE org_id=? AND tipo=? AND categoria=?").bind(para, orgId, tipo, de).run();
      await env.DB.prepare("UPDATE OR REPLACE fin_orcamento SET categoria=? WHERE org_id=? AND tipo=? AND categoria=?").bind(para, orgId, tipo, de).run();
      await env.DB.prepare("INSERT INTO fin_categorias(org_id,tipo,nome,oculta,criado_ms) VALUES(?,?,?,0,?) ON CONFLICT(org_id,tipo,nome) DO UPDATE SET oculta=0").bind(orgId, tipo, para, ms).run();
      await env.DB.prepare("INSERT INTO fin_categorias(org_id,tipo,nome,oculta,criado_ms) VALUES(?,?,?,1,?) ON CONFLICT(org_id,tipo,nome) DO UPDATE SET oculta=1").bind(orgId, tipo, de, ms).run();
      await registrar("renomeou categoria", null, { tipo, de, para, lancamentos: n.meta?.changes || 0 });
      return json({ ok: true, alterados: n.meta?.changes || 0 });
    }
    if (metodo === "DELETE") {
      await env.DB.prepare("INSERT INTO fin_categorias(org_id,tipo,nome,oculta,criado_ms) VALUES(?,?,?,1,?) ON CONFLICT(org_id,tipo,nome) DO UPDATE SET oculta=1").bind(orgId, tipo, nome, ms).run();
      return json({ ok: true });
    }
  }
  // Fechamento do mês: trava o mês conferido; reabrir exige motivo e fica no histórico.
  if (partes[0] === "fechamento") {
    if (metodo === "GET") return json({ meses: (await env.DB.prepare("SELECT * FROM fin_fechamento WHERE org_id=? ORDER BY mes DESC").bind(orgId).all()).results || [],
      historico: (await env.DB.prepare("SELECT * FROM fin_log WHERE org_id=? AND acao IN ('fechou o mês','reabriu o mês') ORDER BY ms DESC LIMIT 50").bind(orgId).all()).results || [] });
    if (metodo === "POST") {
      const { corpo, erro } = await lerCorpo(request); if (erro) return erro;
      const mes = mesValido(corpo.mes) ? corpo.mes : null;
      if (!mes) return json({ erro: "Escolha o mês." }, 400);
      if (corpo.reabrir) {
        if (re(corpo.motivo).length < 5) return json({ erro: "Escreva o motivo para reabrir (fica registrado)." }, 400);
        await env.DB.prepare("UPDATE fin_fechamento SET fechado=0, obs=?, por=?, ms=? WHERE org_id=? AND mes=?").bind(re(corpo.motivo, 300), quem, ms, orgId, mes).run();
        await registrar("reabriu o mês", null, { mes, motivo: re(corpo.motivo, 300) });
        return json({ ok: true });
      }
      if (mes >= hoje.slice(0, 7)) return json({ erro: "Só dá para fechar um mês que já terminou." }, 400);
      await env.DB.prepare("INSERT INTO fin_fechamento(org_id,mes,fechado,obs,por,ms) VALUES(?,?,1,?,?,?) ON CONFLICT(org_id,mes) DO UPDATE SET fechado=1, obs=excluded.obs, por=excluded.por, ms=excluded.ms").bind(orgId, mes, re(corpo.obs, 300) || null, quem, ms).run();
      await registrar("fechou o mês", null, { mes, obs: re(corpo.obs, 300) });
      return json({ ok: true });
    }
  }
  // Orçamento mensal por categoria.
  if (partes[0] === "orcamento") {
    if (metodo === "GET") return json({ itens: (await env.DB.prepare("SELECT * FROM fin_orcamento WHERE org_id=? ORDER BY tipo DESC, categoria").bind(orgId).all()).results || [] });
    if (metodo === "PUT") {
      const { corpo, erro } = await lerCorpo(request); if (erro) return erro;
      await env.DB.prepare("DELETE FROM fin_orcamento WHERE org_id=?").bind(orgId).run();
      let n = 0;
      for (const x of (Array.isArray(corpo.itens) ? corpo.itens : []).slice(0, 200)) {
        const v = centavos(x.valor), tipo = x.tipo === "ENTRADA" ? "ENTRADA" : "SAIDA";
        if (!re(x.categoria) || !v || v <= 0) continue;
        await env.DB.prepare("INSERT OR REPLACE INTO fin_orcamento(org_id,tipo,categoria,valor_cent) VALUES(?,?,?,?)").bind(orgId, tipo, re(x.categoria, 60), v).run(); n++;
      }
      return json({ ok: true, itens: n });
    }
  }
  if (partes[0] === "historico" && metodo === "GET") return json({ historico: (await env.DB.prepare("SELECT * FROM fin_log WHERE org_id=? ORDER BY ms DESC LIMIT 300").bind(orgId).all()).results || [] });

  if (partes[0] === "recorrentes") {
    if (metodo === "GET" && !partes[1]) return json({ recorrentes: (await env.DB.prepare("SELECT * FROM fin_recorrente WHERE org_id=? ORDER BY ativo DESC, tipo, descricao").bind(orgId).all()).results || [] });
    if (metodo === "POST" && !partes[1]) {
      const { corpo, erro } = await lerCorpo(request); if (erro) return erro;
      const v = validar({ ...corpo, data: hoje }); if (typeof v === "string") return json({ erro: v }, 400);
      const dia = Math.min(Math.max(1, Number(corpo.dia) || 5), 31);
      const freq = FREQUENCIAS[corpo.frequencia] ? corpo.frequencia : "mensal";
      const r = await env.DB.prepare("INSERT INTO fin_recorrente(org_id,tipo,descricao,valor_cent,categoria,dia,ativo,criado_ms,freq,inicio_mes,dia_semana,ate_mes,forma,contato,centro) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)")
        .bind(orgId, v.tipo, v.descricao, v.valor_cent, v.categoria, dia, ms, freq, mesValido(corpo.inicio_mes) ? corpo.inicio_mes : hoje.slice(0, 7), Number.isInteger(Number(corpo.dia_semana)) && corpo.dia_semana !== "" ? Math.min(6, Math.max(0, Number(corpo.dia_semana))) : 1,
          mesValido(corpo.ate_mes) ? corpo.ate_mes : null, v.forma, v.contato, v.centro).run();
      await gerarRecorrentes(env, orgId, hoje.slice(0, 7), ms);
      return json({ ok: true, id: r.meta?.last_row_id }, 201);
    }
    if (/^\d+$/.test(partes[1] || "") && (metodo === "DELETE" || metodo === "PUT")) {
      const ativo = metodo === "PUT" ? ((await lerCorpo(request)).corpo?.ativo ? 1 : 0) : 0;
      await env.DB.prepare("UPDATE fin_recorrente SET ativo=? WHERE id=? AND org_id=?").bind(ativo, Number(partes[1]), orgId).run();
      return json({ ok: true });
    }
  }
  if (partes[0] === "importar" && metodo === "POST") {
    const { corpo, erro } = await lerCorpo(request, 3_000_000); if (erro) return erro;
    const texto = String(corpo.conteudo || "");
    const itens = /<OFX>|<STMTTRN>/i.test(texto) ? lerOfx(texto) : lerCsv(texto);
    if (!itens.length) return json({ erro: "Não encontrei lançamentos neste arquivo. Use o extrato em OFX (Money/Quicken) ou CSV com colunas de data, descrição e valor." }, 400);
    let novos = 0, repetidos = 0, fechadosIgnorados = 0;
    for (const it of itens.slice(0, 5000)) {
      if (fechados.has(it.data.slice(0, 7))) { fechadosIgnorados++; continue; }
      const tipo = it.valor_cent > 0 ? "ENTRADA" : "SAIDA";
      const r = await env.DB.prepare(`INSERT OR IGNORE INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,pago_em,origem,chave_externa,criado_por,criado_ms,atualizado_ms)
        VALUES(?,?,?,?,?,?,1,?,'extrato',?,?,?,?)`).bind(orgId, tipo, it.descricao, Math.abs(it.valor_cent), categoriaProvavel(it.descricao, tipo), it.data, it.data, it.chave, k.sessao?.usuario?.email || null, ms, ms).run();
      if (r.meta?.changes) novos++; else repetidos++;
    }
    await registrar("importou extrato", null, { lidos: itens.length, novos, repetidos });
    return json({ ok: true, lidos: itens.length, novos, repetidos, meses_fechados: fechadosIgnorados });
  }
  if (partes[0] === "config" && metodo === "PUT") {
    const { corpo, erro } = await lerCorpo(request); if (erro) return erro;
    const emails = String(corpo.emails || "").split(/[\s,;]+/).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).slice(0, 5).join(", ");
    const moeda = MOEDAS[corpo.moeda] ? corpo.moeda : "BRL";
    await env.DB.prepare(`INSERT INTO fin_config(org_id,email_mensal,emails,moeda,atualizado_ms) VALUES(?,?,?,?,?)
      ON CONFLICT(org_id) DO UPDATE SET email_mensal=excluded.email_mensal, emails=excluded.emails, moeda=excluded.moeda, atualizado_ms=excluded.atualizado_ms`).bind(orgId, corpo.email_mensal ? 1 : 0, emails, moeda, ms).run();
    return json({ ok: true, emails, moeda });
  }
  if (partes[0] === "analise" && metodo === "POST") {
    const mes = mesPedido(), r = await resumoDoMes(env, orgId, mes, ms);
    if (!r.lancamentos) return json({ analise: "Ainda não há lançamentos neste mês para analisar." });
    try { return json({ analise: await analiseDaIA(await k.comIA(env, orgId), k.openai, r, (await config()).moeda) || "A inteligência ainda não foi ligada (falta a chave da OpenAI em Integrações)." }); }
    catch (e) { return json({ erro: e.message || "A IA não respondeu agora. Tente de novo." }, 502); }
  }
  if (partes[0] === "relatorio.pdf" && metodo === "GET") {
    const mes = mesPedido(), r = await resumoDoMes(env, orgId, mes, ms), c = await config();
    const pdf = pdfDoRelatorio(r, await empresa(), c.moeda || "BRL", "");
    return new Response(pdf, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="financeiro-${mes}.pdf"`, "cache-control": "no-store" } });
  }
  if (partes[0] === "exportar.csv" && metodo === "GET") {
    const mes = mesPedido();
    const lista = (await env.DB.prepare("SELECT * FROM fin_lanc WHERE org_id=? AND data BETWEEN ? AND ? ORDER BY data, id").bind(orgId, mes + "-01", mes + "-" + ultimoDia(mes)).all()).results || [];
    const esc = v => { const s = String(v ?? ""); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const linhas = ["Data;Tipo;Descrição;Categoria;Valor;Situação;Pago em;Forma;Contato", ...lista.map(l => [l.data.split("-").reverse().join("/"), l.tipo === "ENTRADA" ? "Entrada" : "Saída", l.descricao, l.categoria, (l.valor_cent / 100).toFixed(2).replace(".", ","), l.pago ? "Pago" : "Em aberto", l.pago_em ? l.pago_em.split("-").reverse().join("/") : "", l.forma, l.contato].map(esc).join(";"))];
    return new Response("﻿" + linhas.join("\r\n"), { headers: { "content-type": "text/csv; charset=UTF-8", "content-disposition": `attachment; filename="financeiro-${mes}.csv"` } });
  }
  return json({ erro: "Rota não encontrada." }, 404);
}

// Cron diário: recorrentes do mês e, no dia 1 (a partir das 8h), o relatório do mês anterior por e-mail com o PDF.
export async function financeiroDoCron(env, k) {
  await garantirFinanceiro(env);
  const ms = k.agora(env), hoje = hojeLocal(ms), mes = hoje.slice(0, 7);
  const orgs = (await env.DB.prepare("SELECT DISTINCT org_id FROM fin_recorrente WHERE ativo=1 AND (ultimo_mes IS NULL OR ultimo_mes < ?) LIMIT 200").bind(mes).all()).results || [];
  for (const { org_id } of orgs) await gerarRecorrentes(env, org_id, mes, ms).catch(e => console.error("fin recorrentes", e?.message));
  const horaLocal = new Date(ms - 3 * 3600000).getUTCHours();
  if (hoje.slice(8) !== "01" || horaLocal < 8 || !k.emailConfigurado()) return { recorrentes: orgs.length, enviados: 0 };
  const anterior = somarMes(mes, -1);
  // Só empresas que usam o financeiro (têm lançamento no mês anterior) e ainda não receberam este relatório.
  const alvos = (await env.DB.prepare(`SELECT DISTINCT l.org_id FROM fin_lanc l LEFT JOIN fin_config c ON c.org_id=l.org_id
    WHERE l.data BETWEEN ? AND ? AND COALESCE(c.email_mensal,1)=1 AND COALESCE(c.ultimo_envio,'') < ? LIMIT 10`).bind(anterior + "-01", anterior + "-31", anterior).all()).results || [];
  let enviados = 0;
  for (const { org_id } of alvos) {
    try {
      const c = (await env.DB.prepare("SELECT * FROM fin_config WHERE org_id=?").bind(org_id).first()) || {};
      const moeda = c.moeda || "BRL", empresa = (await env.DB.prepare("SELECT nome FROM plt_organizacoes WHERE id=?").bind(org_id).first().catch(() => null))?.nome || "";
      const r = await resumoDoMes(env, org_id, anterior, ms);
      const analise = await analiseDaIA(await k.comIA(env, org_id), k.openai, r, moeda).catch(() => "");
      const pdf = pdfDoRelatorio(r, empresa, moeda, analise);
      const para = String(c.emails || "").split(/,\s*/).filter(Boolean);
      const destinos = para.length ? para : await k.responsaveis(org_id);
      const texto = textoDoRelatorio(r, empresa, moeda) + (analise ? "\n\nLeitura da DENIA:\n" + analise : "") + (k.base ? `\n\nVeja no painel: ${k.base}/app#/financeiro` : "") + "\n\nO relatório completo, com os gráficos, está no PDF anexo.";
      const anexo = { nome: `financeiro-${anterior}.pdf`, base64: paraBase64(pdf) };
      for (const e of destinos) if (await k.enviarEmail(e, `DENIA — resumo financeiro de ${r.nome}${empresa ? " (" + empresa + ")" : ""}`, texto, [anexo])) enviados++;
      await env.DB.prepare(`INSERT INTO fin_config(org_id,email_mensal,ultimo_envio,atualizado_ms) VALUES(?,1,?,?) ON CONFLICT(org_id) DO UPDATE SET ultimo_envio=excluded.ultimo_envio`).bind(org_id, anterior, ms).run();
    } catch (e) { console.error("fin relatório", org_id, e?.message); }
  }
  return { recorrentes: orgs.length, enviados };
}
