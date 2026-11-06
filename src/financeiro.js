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
  ENTRADA: ["Vendas e serviços", "Locação / diárias", "Comissões", "Outras receitas"],
  SAIDA: ["Fornecedores e peças", "Salários e comissões", "Aluguel e condomínio", "Água, luz, internet e telefone", "Impostos e taxas",
    "Marketing e anúncios", "Sistemas e assinaturas", "Transporte e combustível", "Manutenção", "Tarifas bancárias", "Retirada dos sócios", "Outras despesas"]
};
const FORMAS = ["Pix", "Dinheiro", "Cartão de crédito", "Cartão de débito", "Boleto", "Transferência", "Outro"];
const MOEDAS = { BRL: "pt-BR", USD: "en-US", EUR: "de-DE", GBP: "en-GB", ARS: "es-AR", CLP: "es-CL", MXN: "es-MX", COP: "es-CO", PEN: "es-PE", UYU: "es-UY", PYG: "es-PY" };

const prontos = new WeakSet();
export async function garantirFinanceiro(env) {
  if (prontos.has(env.DB)) return;
  for (const s of DDL_FINANCEIRO) await env.DB.prepare(s).run();
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
    const ent = l.tipo === "ENTRADA";
    if (l.pago) { t[ent ? "entradas" : "saidas"] += l.valor_cent; const k = (ent ? "E|" : "S|") + (l.categoria || (ent ? "Outras receitas" : "Outras despesas")); cats[k] = (cats[k] || 0) + l.valor_cent; }
    else { t[ent ? "a_receber" : "a_pagar"] += l.valor_cent; if (l.data < hoje) t[ent ? "vencidas_receber" : "vencidas_pagar"] += l.valor_cent; }
  }
  t.saldo = t.entradas - t.saidas;
  t.margem = t.entradas ? Math.round(1000 * t.saldo / t.entradas) / 10 : null;
  const categorias = Object.entries(cats).map(([k, v]) => ({ tipo: k[0] === "E" ? "ENTRADA" : "SAIDA", categoria: k.slice(2), valor_cent: v })).sort((a, b) => b.valor_cent - a.valor_cent);
  // Últimos 6 meses (só o que foi pago/recebido), para o gráfico e a comparação.
  const ini = somarMes(mes, -5) + "-01";
  const serieR = (await env.DB.prepare("SELECT substr(data,1,7) AS mes, tipo, SUM(valor_cent) AS v FROM fin_lanc WHERE org_id=? AND pago=1 AND data BETWEEN ? AND ? GROUP BY 1,2").bind(orgId, ini, ate).all()).results || [];
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

// Recorrentes: cria a conta do mês uma vez só (aluguel, internet, salário...).
export async function gerarRecorrentes(env, orgId, mes, agoraMs) {
  await garantirFinanceiro(env);
  const rs = (await env.DB.prepare("SELECT * FROM fin_recorrente WHERE org_id=? AND ativo=1 AND (ultimo_mes IS NULL OR ultimo_mes < ?)").bind(orgId, mes).all()).results || [];
  let n = 0;
  for (const r of rs) {
    const dia = Math.min(Math.max(1, r.dia || 1), ultimoDia(mes));
    await env.DB.prepare(`INSERT OR IGNORE INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,recorrente_id,origem,chave_externa,criado_por,criado_ms)
      VALUES(?,?,?,?,?,?,0,?,'recorrente',?,'DENIA',?)`).bind(orgId, r.tipo, r.descricao, r.valor_cent, r.categoria, `${mes}-${String(dia).padStart(2, "0")}`, r.id, `rec:${r.id}:${mes}`, agoraMs).run();
    await env.DB.prepare("UPDATE fin_recorrente SET ultimo_mes=? WHERE id=?").bind(mes, r.id).run();
    n++;
  }
  return n;
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
      pago: c.pago ? 1 : 0, pago_em: c.pago ? (dataValida(c.pago_em) ? c.pago_em : c.data <= hoje ? c.data : hoje) : null, forma: FORMAS.includes(c.forma) ? c.forma : null, contato: re(c.contato, 120) || null, obs: re(c.obs, 500) || null };
  };

  if (partes[0] === "opcoes" && metodo === "GET") {
    const usadas = (await env.DB.prepare("SELECT DISTINCT tipo, categoria FROM fin_lanc WHERE org_id=? AND categoria IS NOT NULL LIMIT 200").bind(orgId).all()).results || [];
    const cats = { ENTRADA: [...CATEGORIAS.ENTRADA], SAIDA: [...CATEGORIAS.SAIDA] };
    for (const u of usadas) if (cats[u.tipo] && !cats[u.tipo].includes(u.categoria)) cats[u.tipo].push(u.categoria);
    return json({ categorias: cats, formas: FORMAS, moedas: Object.keys(MOEDAS), config: await config(), hoje });
  }
  if (partes[0] === "resumo" && metodo === "GET") {
    const mes = mesPedido();
    if (mes === hoje.slice(0, 7)) await gerarRecorrentes(env, orgId, mes, ms);
    const r = await resumoDoMes(env, orgId, mes, ms);
    return json({ ...r, moeda: (await config()).moeda || "BRL" });
  }
  if (partes[0] === "lancamentos" && !partes[1]) {
    if (metodo === "GET") {
      const mes = mesPedido(), tipo = url.searchParams.get("tipo"), status = url.searchParams.get("status"), q = re(url.searchParams.get("q"), 60);
      let sql = "SELECT * FROM fin_lanc WHERE org_id=? AND data BETWEEN ? AND ?"; const args = [orgId, mes + "-01", mes + "-" + ultimoDia(mes)];
      if (tipo === "ENTRADA" || tipo === "SAIDA") { sql += " AND tipo=?"; args.push(tipo); }
      if (status === "aberto") sql += " AND pago=0"; else if (status === "pago") sql += " AND pago=1"; else if (status === "vencido") { sql += " AND pago=0 AND data<?"; args.push(hoje); }
      if (q) { sql += " AND (descricao LIKE ? OR categoria LIKE ? OR contato LIKE ?)"; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      const lista = (await env.DB.prepare(sql + " ORDER BY data DESC, id DESC LIMIT 1000").bind(...args).all()).results || [];
      return json({ lancamentos: lista, hoje });
    }
    if (metodo === "POST") {
      const { corpo, erro } = await lerCorpo(request); if (erro) return erro;
      const v = validar(corpo); if (typeof v === "string") return json({ erro: v }, 400);
      const parcelas = Math.min(Math.max(1, Number(corpo.parcelas) || 1), 60);
      const ids = [];
      for (let i = 0; i < parcelas; i++) {
        const [a, m, d] = v.data.split("-").map(Number);
        const mesI = somarMes(`${a}-${String(m).padStart(2, "0")}`, i), data = `${mesI}-${String(Math.min(d, ultimoDia(mesI))).padStart(2, "0")}`;
        const r = await env.DB.prepare(`INSERT INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,pago_em,forma,contato,obs,origem,criado_por,criado_ms,atualizado_ms)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'manual',?,?,?)`).bind(orgId, v.tipo, parcelas > 1 ? `${v.descricao} (${i + 1}/${parcelas})` : v.descricao,
          parcelas > 1 ? Math.round(v.valor_cent / parcelas) + (i === 0 ? v.valor_cent - Math.round(v.valor_cent / parcelas) * parcelas : 0) : v.valor_cent,
          v.categoria, data, i === 0 ? v.pago : 0, i === 0 ? v.pago_em : null, v.forma, v.contato, v.obs, k.sessao?.usuario?.email || null, ms, ms).run();
        ids.push(r.meta?.last_row_id);
      }
      if (corpo.repetir_todo_mes && parcelas === 1) {
        await env.DB.prepare("INSERT INTO fin_recorrente(org_id,tipo,descricao,valor_cent,categoria,dia,ativo,ultimo_mes,criado_ms) VALUES(?,?,?,?,?,?,1,?,?)")
          .bind(orgId, v.tipo, v.descricao, v.valor_cent, v.categoria, Number(v.data.slice(8)), mesDe(v.data), ms).run();
      }
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
      await env.DB.prepare("UPDATE fin_lanc SET pago=?, pago_em=?, forma=COALESCE(?,forma), atualizado_ms=? WHERE id=? AND org_id=?").bind(pago, quando, FORMAS.includes(corpo?.forma) ? corpo.forma : null, ms, id, orgId).run();
      return json({ ok: true });
    }
    if (metodo === "PUT") {
      const { corpo, erro } = await lerCorpo(request); if (erro) return erro;
      const v = validar({ ...atual, valor: atual.valor_cent / 100, ...corpo }); if (typeof v === "string") return json({ erro: v }, 400);
      await env.DB.prepare("UPDATE fin_lanc SET tipo=?,descricao=?,valor_cent=?,categoria=?,data=?,pago=?,pago_em=?,forma=?,contato=?,obs=?,atualizado_ms=? WHERE id=? AND org_id=?")
        .bind(v.tipo, v.descricao, v.valor_cent, v.categoria, v.data, v.pago, v.pago_em, v.forma, v.contato, v.obs, ms, id, orgId).run();
      return json({ ok: true });
    }
    if (metodo === "DELETE") { await env.DB.prepare("DELETE FROM fin_lanc WHERE id=? AND org_id=?").bind(id, orgId).run(); return json({ ok: true }); }
  }
  if (partes[0] === "recorrentes") {
    if (metodo === "GET" && !partes[1]) return json({ recorrentes: (await env.DB.prepare("SELECT * FROM fin_recorrente WHERE org_id=? ORDER BY ativo DESC, tipo, descricao").bind(orgId).all()).results || [] });
    if (metodo === "POST" && !partes[1]) {
      const { corpo, erro } = await lerCorpo(request); if (erro) return erro;
      const v = validar({ ...corpo, data: hoje }); if (typeof v === "string") return json({ erro: v }, 400);
      const dia = Math.min(Math.max(1, Number(corpo.dia) || 5), 31);
      const r = await env.DB.prepare("INSERT INTO fin_recorrente(org_id,tipo,descricao,valor_cent,categoria,dia,ativo,criado_ms) VALUES(?,?,?,?,?,?,1,?)").bind(orgId, v.tipo, v.descricao, v.valor_cent, v.categoria, dia, ms).run();
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
    let novos = 0, repetidos = 0;
    for (const it of itens.slice(0, 5000)) {
      const tipo = it.valor_cent > 0 ? "ENTRADA" : "SAIDA";
      const r = await env.DB.prepare(`INSERT OR IGNORE INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,pago_em,origem,chave_externa,criado_por,criado_ms,atualizado_ms)
        VALUES(?,?,?,?,?,?,1,?,'extrato',?,?,?,?)`).bind(orgId, tipo, it.descricao, Math.abs(it.valor_cent), categoriaProvavel(it.descricao, tipo), it.data, it.data, it.chave, k.sessao?.usuario?.email || null, ms, ms).run();
      if (r.meta?.changes) novos++; else repetidos++;
    }
    return json({ ok: true, lidos: itens.length, novos, repetidos });
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
