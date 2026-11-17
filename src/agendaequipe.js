// DENIA Platform — Agenda inteligente da equipe: prioridades, situação, histórico de quem fez o quê,
// agenda do dia e lembretes pelo WhatsApp que a empresa já usa (texto livre dentro da janela de 24h; fora dela,
// só modelo aprovado pela Meta), comandos pelo WhatsApp, alarmes no iPhone (calendário assinado + Atalhos)
// e relatórios com filtros em Excel e PDF. Não há cadastro duplicado: compromissos, tarefas e contas são os
// mesmos da Administração e do Financeiro; aqui só se organiza, avisa e registra.
import { garantirAdmin, compromissoPorTexto, tarefaPorTexto, interpretarCompromisso } from "./administracao.js";
import { dinheiro } from "./financeiro.js";
import { gerarPdf } from "./pdf.js";
import { gerarXlsx } from "./planilha.js";

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const re = (s, n = 200) => String(s ?? "").replace(/[\u0000-\u001F]/g, " ").trim().slice(0, n);
const hojeLocal = ms => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
const horaLocal = ms => new Date(ms - 3 * 3600000).toISOString().slice(11, 16);
const somarDias = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const br = d => d ? String(d).slice(0, 10).split("-").reverse().join("/") : "—";
const dataValida = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) && !Number.isNaN(Date.parse(d + "T12:00:00Z"));
const inicioDoDia = d => Date.parse(d + "T03:00:00Z"); // 00:00 em Brasília
const semAcento = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const digitos = s => String(s || "").replace(/\D/g, "");
const quando = ms => { const d = new Date(ms - 3 * 3600000).toISOString(); return `${d.slice(8, 10)}/${d.slice(5, 7)} ${d.slice(11, 16)}`; };
const NOMES_DIA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const nomeDia = (d, hoje) => { const dif = Math.round((Date.parse(d + "T12:00:00Z") - Date.parse(hoje + "T12:00:00Z")) / 86400000); return dif === 0 ? "hoje" : dif === 1 ? "amanhã" : dif === -1 ? "ontem" : `${NOMES_DIA[new Date(d + "T12:00:00Z").getUTCDay()]}, ${br(d)}`; };
const ultimoDia = mes => { const [a, m] = mes.split("-").map(Number); return new Date(Date.UTC(a, m, 0)).getUTCDate(); };
const somarMesesData = (d, n) => { const [a, m] = d.slice(0, 7).split("-").map(Number); const mes = new Date(Date.UTC(a, m - 1 + n, 1)).toISOString().slice(0, 7); return `${mes}-${String(Math.min(Number(d.slice(8)), ultimoDia(mes))).padStart(2, "0")}`; };

// Telefones do Brasil chegam do WhatsApp às vezes sem o 9 do celular (55 + DDD + 8 dígitos): aceita os dois jeitos.
export function variantesTel(t) {
  const d = digitos(t); if (d.length < 10) return [];
  const v = new Set([d]);
  if (/^55\d{2}9\d{8}$/.test(d)) v.add(d.slice(0, 4) + d.slice(5));
  if (/^55\d{2}[6-9]\d{7}$/.test(d)) v.add(d.slice(0, 4) + "9" + d.slice(4));
  return [...v];
}
export function telefoneValido(t) {
  let d = digitos(t);
  if (d.length === 10 || d.length === 11) d = "55" + d; // número do Brasil sem o 55
  return d.length >= 12 && d.length <= 15 ? d : null;
}

// ---------------------------------------------------------------------------
// Prioridade, situação, categorias
// ---------------------------------------------------------------------------
export const PRIORIDADES = ["BAIXA", "NORMAL", "ALTA", "EXTREMA"];
export const NOME_PRIORIDADE = { BAIXA: "Baixa", NORMAL: "Normal", ALTA: "Alta", EXTREMA: "Extrema importância" };
const PESO = { EXTREMA: 0, ALTA: 1, NORMAL: 2, BAIXA: 3 };
export function prioridadeValida(p, padrao = "NORMAL") {
  const x = semAcento(p).toUpperCase().trim();
  if (PRIORIDADES.includes(x)) return x;
  if (/URGENT|EXTREM|CRITIC/.test(x)) return "EXTREMA";
  if (/ALT|IMPORTANT/.test(x)) return "ALTA";
  if (/BAIX/.test(x)) return "BAIXA";
  return padrao;
}
export const SITUACOES = ["PENDENTE", "EM_ANDAMENTO", "CONCLUIDA", "ATRASADA"];
export const NOME_SITUACAO = { PENDENTE: "Pendente", EM_ANDAMENTO: "Em andamento", CONCLUIDA: "Concluída", ATRASADA: "Atrasada" };
export function situacaoDe(x, hoje) {
  if (x.feito) return "CONCLUIDA";
  const d = x.data || x.prazo;
  if (d && d < hoje) return "ATRASADA";
  return x.situacao === "EM_ANDAMENTO" ? "EM_ANDAMENTO" : "PENDENTE";
}
export const CATEGORIAS_AGENDA = ["Geral", "Reunião", "Visita", "Compras", "Alimentação", "Suprimentos", "Estoque", "Manutenção", "Documentos", "Financeiro", "Saúde", "Família"];
export const categoriaValida = c => re(c, 40) || null;
export const escopoValido = e => /pessoal/i.test(String(e || "")) ? "PESSOAL" : /prof/i.test(String(e || "")) ? "PROFISSIONAL" : null;
export const REPETICOES = { diario: "todo dia", semanal: "toda semana", mensal: "todo mês", anual: "todo ano" };
export const repeticaoValida = r => REPETICOES[r] ? r : null;
export function proximaData(data, repetir) {
  if (repetir === "diario") return somarDias(data, 1);
  if (repetir === "semanal") return somarDias(data, 7);
  if (repetir === "mensal") return somarMesesData(data, 1);
  if (repetir === "anual") return somarMesesData(data, 12);
  return null;
}
const marca = p => p === "EXTREMA" ? "🚨 " : p === "ALTA" ? "⚠️ " : "";

// ---------------------------------------------------------------------------
// Histórico: quem criou, alterou, concluiu, adiou ou apagou — e por qual canal.
// ---------------------------------------------------------------------------
export async function registrarHistorico(env, orgId, tipo, itemId, acao, titulo, detalhe, por, ms, canal = "painel") {
  const p = typeof por === "object" && por ? por : { nome: por || null, id: null };
  await env.DB.prepare("INSERT INTO adm_historico(org_id,tipo,item_id,acao,titulo,detalhe,por,por_id,canal,ms) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind(orgId, tipo, itemId || null, acao, re(titulo, 200) || null, re(typeof detalhe === "string" ? detalhe : detalhe ? JSON.stringify(detalhe) : "", 1500) || null, re(p.nome, 120) || null, Number(p.id) || null, canal, ms).run().catch(e => console.error("histórico", e?.message));
}
// Diferença legível entre o antes e o depois ("data: 15/11 → 16/11").
export function diferencas(antes, depois, campos) {
  const fmt = (c, v) => v === null || v === undefined || v === "" ? "—" : /data|prazo|acompanhar/.test(c) ? br(v) : c.endsWith("_id") ? `#${v}` : String(v);
  return campos.filter(c => depois[c] !== undefined && String(antes[c] ?? "") !== String(depois[c] ?? "")).map(c => `${c.replace("_id", "").replace("_", " ")}: ${fmt(c, antes[c])} → ${fmt(c, depois[c])}`).join("; ");
}

// Repetição: a próxima ocorrência nasce uma vez só (ao concluir, ou quando a data passa sem concluir).
export async function garantirProxima(env, tabela, item, ms, hoje) {
  if (!item?.repetir || item.gerou_prox) return null;
  const campo = tabela === "adm_agenda" ? "data" : "prazo";
  let d = proximaData(item[campo] || hoje, item.repetir), n = 0;
  while (d && d < hoje && n++ < 400) d = proximaData(d, item.repetir); // ficou muito para trás: pula para a próxima a partir de hoje
  if (!d) return null;
  const marcou = await env.DB.prepare(`UPDATE ${tabela} SET gerou_prox=1 WHERE id=? AND COALESCE(gerou_prox,0)=0`).bind(item.id).run();
  if (!Number(marcou.meta?.changes)) return null; // outro processo já criou
  let r;
  if (tabela === "adm_agenda") {
    r = await env.DB.prepare(`INSERT INTO adm_agenda(org_id,titulo,data,hora,duracao_min,quem,local,prioridade,aviso_min,repetir,obs,criado_ms,responsavel_id,origem,tipo,categoria,escopo,criado_por,criado_por_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(item.org_id, item.titulo, d, item.hora || null, item.duracao_min || 60, item.quem || null, item.local || null, item.prioridade || "NORMAL", item.aviso_min ?? 60,
      item.repetir, item.obs || null, ms, item.responsavel_id || null, item.origem === "google" ? "painel" : item.origem || "painel", item.tipo || null, item.categoria || null, item.escopo || null, "DENIA (repetição)", null).run();
  } else {
    r = await env.DB.prepare(`INSERT INTO adm_tarefas(org_id,titulo,responsavel_id,prazo,checklist,prioridade,obs,criado_por,criado_ms,categoria,escopo,repetir)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(item.org_id, item.titulo, item.responsavel_id || null, d, JSON.stringify((() => { try { return JSON.parse(item.checklist || "[]").map(x => ({ ...x, ok: false })); } catch { return []; } })()),
      item.prioridade || "NORMAL", item.obs || null, "DENIA (repetição)", ms, item.categoria || null, item.escopo || null, item.repetir).run();
  }
  const id = r.meta?.last_row_id;
  await registrarHistorico(env, item.org_id, tabela === "adm_agenda" ? "AGENDA" : "TAREFA", id, "criou", item.titulo, `Repetição (${REPETICOES[item.repetir]}) para ${br(d)}`, "DENIA (automático)", ms, "automatico");
  return { id, data: d };
}

// Concluir (ou reabrir) compromisso ou tarefa, registrando quem concluiu de fato e a hora real.
export async function concluirItem(env, orgId, tipo, id, por, ms, canal = "painel", desfazer = false) {
  const tabela = tipo === "AGENDA" ? "adm_agenda" : "adm_tarefas";
  const item = await env.DB.prepare(`SELECT * FROM ${tabela} WHERE id=? AND org_id=?`).bind(id, orgId).first();
  if (!item) return { erro: tipo === "AGENDA" ? "Compromisso não encontrado." : "Tarefa não encontrada." };
  const p = typeof por === "object" && por ? por : { nome: por || null, id: null };
  const hoje = hojeLocal(ms);
  if (desfazer) {
    await env.DB.prepare(`UPDATE ${tabela} SET feito=0, feito_em=NULL, feito_por=NULL, feito_por_id=NULL, feito_ms=NULL WHERE id=?`).bind(id).run();
    await registrarHistorico(env, orgId, tipo, id, "reabriu", item.titulo, "", p, ms, canal);
    return { ok: true, item };
  }
  if (item.feito) return { ok: true, item, ja: true };
  await env.DB.prepare(`UPDATE ${tabela} SET feito=1, feito_em=?, feito_por=?, feito_por_id=?, feito_ms=?, situacao=NULL WHERE id=?`).bind(hoje, re(p.nome, 120) || null, Number(p.id) || null, ms, id).run();
  const resp = item.responsavel_id && p.id && Number(item.responsavel_id) !== Number(p.id) ? " (não era o responsável)" : "";
  await registrarHistorico(env, orgId, tipo, id, "concluiu", item.titulo, `Concluído às ${horaLocal(ms)}${resp}`, p, ms, canal);
  const proximo = await garantirProxima(env, tabela, item, ms, hoje);
  return { ok: true, item, proximo };
}

// Confirmar pagamento ou recebimento (registrando quem confirmou e quando).
export async function confirmarConta(env, orgId, id, por, ms, canal = "painel") {
  const l = await env.DB.prepare("SELECT * FROM fin_lanc WHERE id=? AND org_id=?").bind(id, orgId).first();
  if (!l) return { erro: "Conta não encontrada." };
  if (l.pago) return { ok: true, ja: true, l };
  const fech = await env.DB.prepare("SELECT 1 FROM fin_fechamento WHERE org_id=? AND mes=? AND fechado=1").bind(orgId, hojeLocal(ms).slice(0, 7)).first().catch(() => null);
  if (fech) return { erro: "O mês está fechado no financeiro. Reabra pelo painel para confirmar." };
  const p = typeof por === "object" && por ? por : { nome: por || null, id: null };
  await env.DB.prepare("UPDATE fin_lanc SET pago=1, pago_em=?, confirmado_por=?, confirmado_ms=?, atualizado_ms=? WHERE id=? AND org_id=?").bind(hojeLocal(ms), re(p.nome, 120) || null, ms, ms, id, orgId).run();
  await env.DB.prepare("INSERT INTO fin_log(org_id,lanc_id,acao,detalhe,por,ms) VALUES(?,?,?,?,?,?)").bind(orgId, id, l.tipo === "ENTRADA" ? "recebeu" : "pagou", re(JSON.stringify({ descricao: l.descricao, data: hojeLocal(ms), valor: l.valor_cent, canal }), 1500), re(p.nome, 120) || null, ms).run().catch(() => { });
  await registrarHistorico(env, orgId, "CONTA", id, l.tipo === "ENTRADA" ? "confirmou recebimento" : "confirmou pagamento", l.descricao, dinheiro(l.valor_cent), p, ms, canal);
  return { ok: true, l };
}

// ---------------------------------------------------------------------------
// O dia de uma empresa, organizado: com horário, sem horário, tarefas, contas, atrasados e avisos antecipados.
// ---------------------------------------------------------------------------
export async function itensDoDia(env, orgId, data, hoje, { pessoaId = null, contatoId = null, soMinhas = false, fin = true, finDias = 0 } = {}) {
  await garantirAdmin(env);
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
  // Só o que é da pessoa: da equipe = o que é dela ou sem responsável; contato de fora = só o que foi marcado para ele.
  const meu = soMinhas && contatoId ? " AND x.contato_id=?" : soMinhas && pessoaId ? " AND (x.responsavel_id=? OR x.responsavel_id IS NULL)" : "";
  const argMeu = soMinhas && contatoId ? [contatoId] : soMinhas && pessoaId ? [pessoaId] : [];
  if (contatoId) fin = false;
  const comAtrasos = data === hoje;
  const ag = await q(`SELECT x.*, COALESCE(NULLIF(u.nome,''), u.email, ct.nome) AS responsavel_nome FROM adm_agenda x LEFT JOIN plt_usuarios u ON u.id=x.responsavel_id LEFT JOIN adm_contatos ct ON ct.id=x.contato_id
    WHERE x.org_id=? AND (x.data=? ${comAtrasos ? "OR (x.feito=0 AND x.data<? AND x.data>=?)" : ""})${meu} ORDER BY x.data, COALESCE(x.hora,'99:99') LIMIT 200`, orgId, data, ...(comAtrasos ? [data, somarDias(data, -45)] : []), ...argMeu);
  const tf = await q(`SELECT x.*, COALESCE(NULLIF(u.nome,''), u.email, ct.nome) AS responsavel_nome FROM adm_tarefas x LEFT JOIN plt_usuarios u ON u.id=x.responsavel_id LEFT JOIN adm_contatos ct ON ct.id=x.contato_id
    WHERE x.org_id=? AND ((x.feito=0 AND ((x.prazo IS NOT NULL AND x.prazo <= ? ${comAtrasos ? "" : "AND x.prazo >= ?"}) OR (x.prazo IS NULL AND (x.prioridade IN ('ALTA','EXTREMA') OR x.situacao='EM_ANDAMENTO' OR x.acompanhar_em <= ?)))) OR (x.feito=1 AND x.prazo=?))${meu}
    ORDER BY COALESCE(x.prazo, '9999'), x.id LIMIT 120`, orgId, data, ...(comAtrasos ? [] : [data]), data, data, ...argMeu);
  let contas = [];
  if (fin) {
    const ate = somarDias(data, Math.max(0, finDias));
    contas = await q(`SELECT x.*, COALESCE(NULLIF(u.nome,''), u.email) AS responsavel_nome FROM fin_lanc x LEFT JOIN plt_usuarios u ON u.id=x.responsavel_id
      WHERE x.org_id=? AND ((x.pago=0 AND x.data <= ? AND x.data >= ?) OR (x.pago=1 AND x.data=?))${meu} ORDER BY x.data, x.id LIMIT 200`, orgId, ate, comAtrasos ? somarDias(data, -60) : data, data, ...argMeu).catch(() => []);
  }
  const it = (tipo, x, extra) => ({ tipo, id: x.id, cod: tipo + x.id, titulo: x.titulo || x.descricao, prioridade: prioridadeValida(x.prioridade), responsavel_id: x.responsavel_id || null, responsavel_nome: x.responsavel_nome || null,
    categoria: x.categoria || null, feito: Boolean(x.feito || x.pago), feito_por: x.feito_por || x.confirmado_por || null, feito_ms: x.feito_ms || x.confirmado_ms || null, ...extra });
  const agenda = ag.map(x => it("C", x, { data: x.data, hora: x.hora || null, local: x.local || null, lembrete: x.tipo === "LEMBRETE", atrasado: !x.feito && x.data < data, situacao: situacaoDe(x, hoje) }));
  const tarefas = tf.map(x => it("T", x, { data: x.prazo || null, hora: null, atrasado: !x.feito && x.prazo && x.prazo < data, situacao: situacaoDe(x, hoje), em_andamento: x.situacao === "EM_ANDAMENTO" }));
  const fins = contas.map(x => it("P", x, { data: x.data, hora: null, valor_cent: x.valor_cent, entrada: x.tipo === "ENTRADA", atrasado: !x.pago && x.data < data, antecipado: !x.pago && x.data > data, situacao: x.pago ? "CONCLUIDA" : x.data < hoje ? "ATRASADA" : "PENDENTE" }));
  const ord = (a, b) => PESO[a.prioridade] - PESO[b.prioridade];
  return {
    data,
    comHora: agenda.filter(a => a.data === data && a.hora),
    semHora: [...agenda.filter(a => a.data === data && !a.hora), ...tarefas.filter(t => !t.atrasado && (t.data === data || !t.data))].sort(ord),
    pagar: fins.filter(f => !f.entrada && f.data === data), receber: fins.filter(f => f.entrada && f.data === data),
    antecipados: fins.filter(f => f.antecipado),
    atrasados: [...agenda.filter(a => a.atrasado), ...tarefas.filter(t => t.atrasado), ...fins.filter(f => f.atrasado)].sort(ord),
    todos: [...agenda, ...tarefas, ...fins]
  };
}
const linha = (x, moeda, { comResp = true, comData = false, hoje } = {}) => {
  const resp = comResp && x.responsavel_nome ? ` · ${x.responsavel_nome}` : "";
  const valor = x.valor_cent !== undefined ? ` — ${dinheiro(x.valor_cent, moeda)}` : "";
  const dt = comData && x.data ? ` (${hoje ? nomeDia(x.data, hoje) : br(x.data)})` : "";
  const status = x.feito ? "✓ " : x.em_andamento ? "▶ " : "";
  return `• ${marca(x.prioridade)}${status}${x.hora ? x.hora + " " : ""}${x.titulo}${valor}${x.local ? ` (${x.local})` : ""}${dt}${resp} [${x.cod}]`;
};
// Texto do dia para o WhatsApp (negrito com *asteriscos*) e o e-mail (os asteriscos somem).
export function textoDoDiaEquipe(d, { empresa = "", moeda = "BRL", hoje, titulo = null, rodape = true } = {}) {
  const L = [];
  L.push(titulo || `☀️ *Agenda de ${nomeDia(d.data, hoje)}${d.data === hoje ? ", " + br(d.data) : ""}*${empresa ? " — " + empresa : ""}`);
  const urg = d.todos.filter(x => !x.feito && x.prioridade === "EXTREMA" && (x.data === d.data || x.atrasado || !x.data));
  if (urg.length) L.push("", "🚨 *EXTREMA IMPORTÂNCIA*", ...urg.map(x => linha(x, moeda, { comData: x.data !== d.data, hoje })));
  if (d.comHora.length) L.push("", "🕘 *Com horário*", ...d.comHora.map(x => linha(x, moeda)));
  if (d.semHora.length) L.push("", "📝 *Sem horário (tarefas e lembretes)*", ...d.semHora.map(x => linha(x, moeda)));
  if (d.pagar.length) L.push("", "💸 *Pagar*", ...d.pagar.map(x => linha(x, moeda)));
  if (d.receber.length) L.push("", "💰 *Receber*", ...d.receber.map(x => linha(x, moeda)));
  if (d.atrasados.length) L.push("", `⏰ *Atrasados (${d.atrasados.length})*`, ...d.atrasados.slice(0, 25).map(x => linha(x, moeda, { comData: true, hoje })), ...(d.atrasados.length > 25 ? [`… e mais ${d.atrasados.length - 25} no painel`] : []));
  if (d.antecipados.length) L.push("", "🔔 *Vencem nos próximos dias*", ...d.antecipados.map(x => linha(x, moeda, { comData: true, hoje })));
  const resp = [...new Set(d.todos.filter(x => !x.feito && x.responsavel_nome && (x.data === d.data || x.atrasado)).map(x => x.responsavel_nome))];
  if (resp.length > 1) L.push("", "👥 *Por responsável*", ...resp.map(n => `• ${n}: ${d.todos.filter(x => !x.feito && x.responsavel_nome === n && (x.data === d.data || x.atrasado)).length} item(ns)`));
  if (L.length === 1) L.push("", "Nada marcado. 🙂");
  else if (rodape) L.push("", "Responda: FEITO C12 · PAGO P34 · ADIAR T5 amanhã · AJUDA");
  return L.join("\n");
}
// A lista do dia numa linha só (vai dentro do modelo aprovado, que não aceita quebra de linha): a pessoa recebe
// os compromissos mesmo sem ter escrito para o número nas últimas 24 horas.
export function listaCurta(d, max = 650) {
  const itens = [...d.comHora, ...d.semHora, ...d.pagar, ...d.receber].filter(x => !x.feito).map(x => `${x.prioridade === "EXTREMA" ? "URGENTE " : ""}${x.hora ? x.hora + " " : ""}${x.titulo}`)
    .concat(d.atrasados.map(x => `atrasado: ${x.titulo}`));
  if (!itens.length) return "nada marcado";
  let out = "";
  for (let i = 0; i < itens.length; i++) { const prox = (out ? out + "; " : "") + itens[i]; if (prox.length > max) return `${out}; e mais ${itens.length - i}`; out = prox; }
  return out;
}
// Contagem curta (vai no modelo aprovado, que não aceita quebra de linha).
export function contagem(d) {
  const p = [];
  const n = (k, s, pl) => k ? p.push(`${k} ${k === 1 ? s : pl}`) : null;
  n(d.comHora.length, "compromisso", "compromissos"); n(d.semHora.length, "tarefa ou lembrete", "tarefas ou lembretes");
  n(d.pagar.filter(x => !x.feito).length, "conta a pagar", "contas a pagar"); n(d.receber.filter(x => !x.feito).length, "recebimento", "recebimentos"); n(d.atrasados.length, "atrasado", "atrasados");
  const urg = d.todos.filter(x => !x.feito && x.prioridade === "EXTREMA").length;
  return (p.length ? p.join(", ") : "nada marcado") + (urg ? ` (${urg} de extrema importância)` : "");
}

// ---------------------------------------------------------------------------
// Pessoas da equipe no WhatsApp e o número da empresa que envia
// ---------------------------------------------------------------------------
export const MODELO_LEMBRETE = "denia_lembrete_agenda", MODELO_RESUMO = "denia_resumo_agenda";
async function contaZapDaOrg(env, orgId) {
  const c = await env.DB.prepare("SELECT zap_org_id FROM adm_config WHERE org_id=?").bind(orgId).first().catch(() => null);
  return Number(c?.zap_org_id) || orgId;
}
// Quem recebe um aviso: o responsável (se estiver cadastrado no WhatsApp) ou, sem responsável, quem recebe tudo.
// Contato de fora (quem recebe no WhatsApp sem login): recebe o que foi marcado para ele.
async function pessoasParaAviso(env, orgId, responsavelId, campo = "zap_lembretes", contatoId = null) {
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
  const out = [];
  if (contatoId) out.push(...(await q(`SELECT *, id AS contato_id FROM adm_contatos WHERE org_id=? AND id=? AND ativo=1 AND ${campo}=1`, orgId, contatoId)));
  if (responsavelId) out.push(...(await q(`SELECT * FROM adm_pessoas WHERE org_id=? AND usuario_id=? AND ativo=1 AND telefone IS NOT NULL AND ${campo}=1`, orgId, responsavelId)));
  if (out.length) return dedupTel(out);
  if (contatoId) return []; // marcado para um contato que não recebe lembretes: não manda para os outros
  return dedupTel([...(await q(`SELECT * FROM adm_pessoas WHERE org_id=? AND ativo=1 AND telefone IS NOT NULL AND ${campo}=1 AND so_minhas=0`, orgId)),
    ...(await q(`SELECT *, id AS contato_id FROM adm_contatos WHERE org_id=? AND ativo=1 AND ${campo}=1 AND so_minhas=0`, orgId))]);
}
const dedupTel = lista => { const vistos = new Set(); return lista.filter(p => { const k0 = variantesTel(p.telefone)[0]; if (!k0 || vistos.has(k0)) return false; vistos.add(k0); return true; }); };
async function lembrarUltimo(env, contaOrg, tel, tipo, id, orgId, ms) {
  await env.DB.prepare("INSERT INTO adm_zap_estado(conta_org,telefone,ultimo_tipo,ultimo_id,ultimo_org,ultimo_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(conta_org,telefone) DO UPDATE SET ultimo_tipo=excluded.ultimo_tipo, ultimo_id=excluded.ultimo_id, ultimo_org=excluded.ultimo_org, ultimo_ms=excluded.ultimo_ms")
    .bind(contaOrg, tel, tipo, id, orgId, ms).run().catch(() => { });
}
// Envia a uma pessoa: texto completo se a janela de 24h estiver aberta; senão o modelo aprovado (curto).
async function enviarPessoa(env, k, pessoa, texto, modelo) {
  if (!k.zapEquipe) return "";
  const conta = await contaZapDaOrg(env, pessoa.org_id);
  return k.zapEquipe(conta, pessoa.telefone, texto, modelo).catch(e => { console.error("zap equipe", e?.message); return ""; });
}
// Aviso de um item (lembrete antes, na hora, mudança) para as pessoas certas. Devolve quantas receberam.
export async function avisarPessoasZap(env, k, orgId, item, texto, params, ms) {
  let n = 0;
  for (const p of await pessoasParaAviso(env, orgId, item.responsavel_id, "zap_lembretes", item.contato_id || null)) {
    const via = await enviarPessoa(env, k, p, texto, { nome: MODELO_LEMBRETE, idioma: "pt_BR", params });
    if (via) { n++; if (item.tipo && item.id) await lembrarUltimo(env, await contaZapDaOrg(env, orgId), p.telefone, item.tipo, item.id, orgId, ms); }
  }
  return n;
}
// Mudança num item de hoje ou amanhã feita por outra pessoa: o responsável fica sabendo na hora.
export async function avisarMudanca(env, k, orgId, item, acao, por, ms) {
  try {
    if (!k.zapEquipe || (!item?.responsavel_id && !item?.contato_id)) return;
    const hoje = hojeLocal(ms), d = item.data || item.prazo;
    if (!d || d < hoje || d > somarDias(hoje, 1)) return;
    const resp = item.responsavel_id && !(por?.id && Number(por.id) === Number(item.responsavel_id)) ? item.responsavel_id : null; // a própria pessoa mexeu: não avisa ela
    if (!resp && !item.contato_id) return;
    const ps = await pessoasParaAviso(env, orgId, resp, "zap_lembretes", item.contato_id || null);
    const alvo = ps.filter(p => (p.contato_id && Number(p.contato_id) === Number(item.contato_id)) || (resp && Number(p.usuario_id) === Number(resp)));
    const txt = `🔄 *Agenda atualizada*: ${item.titulo} — ${acao} por ${por?.nome || "alguém da equipe"} (${nomeDia(d, hoje)}${item.hora ? " às " + item.hora : ""}).`;
    for (const p of alvo) await enviarPessoa(env, k, p, txt, { nome: MODELO_RESUMO, idioma: "pt_BR", params: [`${nomeDia(d, hoje)}`, `${item.titulo} foi ${acao} por ${por?.nome || "alguém da equipe"}`] });
  } catch (e) { console.error("aviso de mudança", e?.message); }
}

// ---------------------------------------------------------------------------
// Comandos pelo WhatsApp (de um número cadastrado da equipe)
// ---------------------------------------------------------------------------
const AJUDA_ZAP = `*Agenda pelo WhatsApp* — comandos:
• AGENDA (ou HOJE) — o seu dia
• AMANHÃ · SEMANA · PENDÊNCIAS
• MARCAR reunião com o contador terça às 10h
• LEMBRAR de ligar para o banco amanhã às 9h
• TAREFA pedir orçamento da pintura até sexta
• COMPRAR café e açúcar
• FEITO C12 (ou só OK depois de um lembrete)
• INICIAR T5 (em andamento)
• ADIAR T5 amanhã · ADIAR C12 sexta às 15h
• PAGO P34 / RECEBIDO P35
• CONTAS — a pagar e a receber de hoje e vencidas
• EMPRESA — escolher a empresa (quem cuida de várias)
Os códigos (C = compromisso, T = tarefa, P = conta) aparecem entre colchetes na agenda.`;

export async function comandoEquipeZap(env, k, contaOrg, tel, texto, responder) {
  const bruto = String(texto || "").trim();
  if (!bruto || bruto.length > 600) return false;
  await garantirAdmin(env);
  const tels = variantesTel(tel); if (!tels.length) return false;
  const pessoas = (await env.DB.prepare(`SELECT p.*, COALESCE(NULLIF(u.nome,''), u.email) AS nome, u.email, u.super_admin, o.nome AS org_nome, m.papel
    FROM adm_pessoas p JOIN plt_usuarios u ON u.id=p.usuario_id JOIN plt_organizacoes o ON o.id=p.org_id LEFT JOIN plt_membros m ON m.org_id=p.org_id AND m.usuario_id=p.usuario_id LEFT JOIN adm_config c ON c.org_id=p.org_id
    WHERE p.telefone IN (${tels.map(() => "?").join(",")}) AND p.ativo=1 AND u.ativo=1 AND o.status='ATIVA' AND COALESCE(c.zap_org_id, p.org_id)=? ORDER BY p.org_id`).bind(...tels, contaOrg).all().catch(() => null))?.results || [];
  // Contatos de fora da equipe (sem login) também consultam a própria agenda e concluem pelo WhatsApp.
  const contatos = (await env.DB.prepare(`SELECT p.*, p.id AS contato_id, NULL AS usuario_id, o.nome AS org_nome FROM adm_contatos p JOIN plt_organizacoes o ON o.id=p.org_id LEFT JOIN adm_config c ON c.org_id=p.org_id
    WHERE p.telefone IN (${tels.map(() => "?").join(",")}) AND p.ativo=1 AND o.status='ATIVA' AND COALESCE(c.zap_org_id, p.org_id)=? ORDER BY p.org_id`).bind(...tels, contaOrg).all().catch(() => null))?.results || [];
  for (const c0 of contatos) if (!pessoas.some(p => p.org_id === c0.org_id)) pessoas.push(c0);
  if (!pessoas.length) return false;
  const t = semAcento(bruto).toLowerCase().replace(/\s+/g, " ").replace(/^[/!]/, "").trim();
  const ms = k.agora(env), hoje = hojeLocal(ms);
  const estado = await env.DB.prepare("SELECT * FROM adm_zap_estado WHERE conta_org=? AND telefone IN (" + tels.map(() => "?").join(",") + ") ORDER BY ultimo_ms DESC LIMIT 1").bind(contaOrg, ...tels).first().catch(() => null);
  const atual = pessoas.find(p => p.org_id === Number(estado?.org_atual)) || pessoas[0];
  const quem = p => ({ id: p.usuario_id || null, nome: p.nome });
  const filtroDe = (p, a = "a") => p.contato_id ? (p.so_minhas ? [` AND ${a}.contato_id=?`, [p.contato_id]] : ["", []]) : p.so_minhas ? [` AND (${a}.responsavel_id=? OR ${a}.responsavel_id IS NULL)`, [p.usuario_id]] : ["", []];
  const admin = p => p.super_admin || ["OWNER", "ADMIN"].includes(p.papel);
  const moedaDe = async org => (await env.DB.prepare("SELECT moeda FROM fin_config WHERE org_id=?").bind(org).first().catch(() => null))?.moeda || "BRL";
  const pessoaDoCodigo = async (letra, id) => {
    const tabela = letra === "C" ? "adm_agenda" : letra === "T" ? "adm_tarefas" : "fin_lanc";
    const r = await env.DB.prepare(`SELECT org_id FROM ${tabela} WHERE id=?`).bind(id).first().catch(() => null);
    return r ? pessoas.find(p => p.org_id === r.org_id) || null : null;
  };
  const agendaDe = async (data, titulo) => {
    const partes = [];
    for (const p of pessoas) {
      if (!p.zap_manha && pessoas.length > 1 && data !== hoje) continue;
      const d = await itensDoDia(env, p.org_id, data, hoje, { pessoaId: p.usuario_id, contatoId: p.contato_id || null, soMinhas: Boolean(p.so_minhas), fin: admin(p) });
      partes.push(textoDoDiaEquipe(d, { empresa: pessoas.length > 1 ? p.org_nome : "", moeda: await moedaDe(p.org_id), hoje, titulo: titulo ? `${titulo}${pessoas.length > 1 ? " — " + p.org_nome : ""}` : null, rodape: false }));
    }
    return partes.join("\n\n———\n\n") + "\n\nResponda: FEITO C12 · ADIAR T5 amanhã · AJUDA";
  };
  let m;
  if (/^(ajuda|menu|comandos|\?|help)$/.test(t)) { await responder(AJUDA_ZAP); return true; }
  if (/^(agenda|hoje|minha agenda|agenda de hoje|meu dia|o dia)$/.test(t)) { await responder(await agendaDe(hoje)); return true; }
  if (/^(amanha|agenda de amanha|agenda amanha)$/.test(t)) { await responder(await agendaDe(somarDias(hoje, 1), `📅 *Agenda de amanhã, ${br(somarDias(hoje, 1))}*`)); return true; }
  if (/^(semana|proximos dias|agenda da semana)$/.test(t)) {
    const L = ["📅 *Próximos 7 dias*"];
    for (const p of pessoas) {
      const [meu, am] = filtroDe(p);
      const ag = (await env.DB.prepare(`SELECT a.* FROM adm_agenda a WHERE a.org_id=? AND a.feito=0 AND a.data BETWEEN ? AND ?${meu} ORDER BY a.data, COALESCE(a.hora,'99:99') LIMIT 60`).bind(p.org_id, hoje, somarDias(hoje, 7), ...am).all()).results || [];
      const tf = (await env.DB.prepare(`SELECT a.* FROM adm_tarefas a WHERE a.org_id=? AND a.feito=0 AND a.prazo BETWEEN ? AND ?${meu} ORDER BY a.prazo LIMIT 40`).bind(p.org_id, hoje, somarDias(hoje, 7), ...am).all()).results || [];
      if (pessoas.length > 1) L.push("", `*${p.org_nome}*`);
      for (const a of ag) L.push(`• ${marca(prioridadeValida(a.prioridade))}${nomeDia(a.data, hoje)}${a.hora ? " " + a.hora : ""} — ${a.titulo} [C${a.id}]`);
      for (const x of tf) L.push(`• ${marca(prioridadeValida(x.prioridade))}${nomeDia(x.prazo, hoje)} — tarefa: ${x.titulo} [T${x.id}]`);
      if (!ag.length && !tf.length) L.push("Nada marcado.");
    }
    await responder(L.join("\n")); return true;
  }
  if (/^(pendencias|pendentes|pendencia|atrasados|atrasadas|o que falta)$/.test(t)) { await responder(await textoPendencias(env, pessoas, hoje, admin, moedaDe) || "Nenhuma pendência. 🙂"); return true; }
  if (/^(contas|pagar|receber|financeiro|contas de hoje)$/.test(t)) {
    const L = [];
    for (const p of pessoas.filter(admin)) {
      const d = await itensDoDia(env, p.org_id, hoje, hoje, { fin: true, finDias: 7 });
      const moeda = await moedaDe(p.org_id), fins = d.todos.filter(x => x.tipo === "P" && !x.feito);
      if (pessoas.length > 1) L.push(`*${p.org_nome}*`);
      L.push(...(fins.length ? fins.map(x => linha(x, moeda, { comData: true, hoje })) : ["Nada a pagar ou receber até a próxima semana."]), "");
    }
    await responder(L.length ? "💸 *Contas (vencidas, de hoje e dos próximos 7 dias)*\n" + L.join("\n").trim() + "\n\nPara confirmar: PAGO P34 ou RECEBIDO P35" : "O financeiro é visível só para o dono e os administradores."); return true;
  }
  if ((m = /^empresa\s*(.*)$/.exec(t))) {
    if (pessoas.length < 2) { await responder(`Você está na ${atual.org_nome}.`); return true; }
    const alvo = m[1] ? pessoas.find((p, i) => String(i + 1) === m[1] || semAcento(p.org_nome).toLowerCase().includes(m[1])) : null;
    if (!alvo) { await responder(`Empresas:\n${pessoas.map((p, i) => `${i + 1}. ${p.org_nome}${p.org_id === atual.org_id ? " (atual)" : ""}`).join("\n")}\nResponda EMPRESA 2 para trocar. O que você marcar vai para a empresa atual.`); return true; }
    await env.DB.prepare("INSERT INTO adm_zap_estado(conta_org,telefone,org_atual,ultimo_ms) VALUES(?,?,?,?) ON CONFLICT(conta_org,telefone) DO UPDATE SET org_atual=excluded.org_atual").bind(contaOrg, tels[0], alvo.org_id, ms).run();
    await responder(`Pronto: o que você marcar agora vai para ${alvo.org_nome}.`); return true;
  }
  // Criar compromisso, lembrete ou tarefa.
  if ((m = /^(marcar|agendar|compromisso|reuniao|lembrar|lembrete|me lembre|lembre-me|me lembra)\s+(?:de\s+|que\s+)?(.+)$/i.exec(semAcento(bruto).replace(/^[/!]/, "")))) {
    const corpo = bruto.slice(bruto.length - m[2].length);
    const lembrete = /^lembr|^me lembr/.test(m[1].toLowerCase());
    const r = await compromissoPorTexto(env, atual.org_id, (lembrete ? "lembrar de " : "") + corpo, ms, "whatsapp");
    if (!r.ok) { await responder(`${r.erro} Ex.: MARCAR reunião com o contador terça às 10h`); return true; }
    const prio = /urgente|extrema|importantissim/i.test(semAcento(corpo)) ? "EXTREMA" : null;
    await env.DB.prepare("UPDATE adm_agenda SET responsavel_id=?, contato_id=?, criado_por=?, criado_por_id=?, tipo=?, prioridade=COALESCE(?, prioridade) WHERE id=?").bind(atual.usuario_id || null, atual.contato_id || null, atual.nome, atual.usuario_id || null, lembrete ? "LEMBRETE" : "COMPROMISSO", prio, r.id).run();
    await registrarHistorico(env, atual.org_id, "AGENDA", r.id, "criou", r.titulo, `${br(r.data)}${r.hora ? " " + r.hora : ""}`, quem(atual), ms, "whatsapp");
    await responder(`✅ ${r.frase.replace(/^Anotado: /, lembrete ? "Lembrete anotado: " : "Anotado: ")} [C${r.id}]${pessoas.length > 1 ? ` (${atual.org_nome})` : ""}`); return true;
  }
  if ((m = /^(tarefa|anotar|anota|fazer|comprar|compras|repor|estoque)\s*:?\s+(.+)$/i.exec(semAcento(bruto).replace(/^[/!]/, "")))) {
    const corpo = bruto.slice(bruto.length - m[2].length), v = m[1].toLowerCase();
    const compra = /^(comprar|compras)$/.test(v), estoque = /^(repor|estoque)$/.test(v);
    const r = await tarefaPorTexto(env, atual.org_id, compra ? "Comprar " + corpo : estoque ? "Repor " + corpo : corpo, ms, atual.nome);
    if (!r.ok) { await responder(r.erro); return true; }
    const prio = /urgente|extrema|importantissim/i.test(semAcento(corpo)) ? "EXTREMA" : null;
    await env.DB.prepare("UPDATE adm_tarefas SET responsavel_id=?, contato_id=?, criado_por_id=?, categoria=?, prioridade=COALESCE(?, prioridade) WHERE id=?").bind(atual.usuario_id || null, atual.contato_id || null, atual.usuario_id || null, compra ? "Compras" : estoque ? "Estoque" : null, prio, r.id).run();
    await registrarHistorico(env, atual.org_id, "TAREFA", r.id, "criou", r.titulo, r.prazo ? `prazo ${br(r.prazo)}` : "", quem(atual), ms, "whatsapp");
    await responder(`✅ ${r.frase} [T${r.id}]${pessoas.length > 1 ? ` (${atual.org_nome})` : ""}`); return true;
  }
  // Concluir: FEITO C12 / OK (o último lembrete recebido).
  if ((m = /^(feito|feita|concluido|concluida|concluir|pronto|pronta|fiz|ok|okay|resolvido)\s*([ct])?\s*(\d+)?\s*[.!]?$/.exec(t))) {
    let letra = m[2] ? m[2].toUpperCase() : null, id = m[3] ? Number(m[3]) : null;
    if (!letra || !id) {
      if (estado?.ultimo_id && estado.ultimo_tipo && ms - Number(estado.ultimo_ms || 0) < 18 * 3600000 && ["C", "T"].includes(estado.ultimo_tipo)) { letra = estado.ultimo_tipo; id = Number(estado.ultimo_id); }
      else if (/^(ok|okay|pronto|pronta|fiz|resolvido)$/.test(m[1]) && !m[3]) return false; // "ok" solto numa conversa qualquer: segue o atendimento normal
      else { await responder("Qual item? Ex.: FEITO C12 (o código está entre colchetes na agenda)."); return true; }
    }
    const p = await pessoaDoCodigo(letra, id);
    if (!p) { await responder(`Não encontrei ${letra}${id} nas suas empresas.`); return true; }
    const r = await concluirItem(env, p.org_id, letra === "C" ? "AGENDA" : "TAREFA", id, quem(p), ms, "whatsapp");
    if (r.erro) { await responder(r.erro); return true; }
    await env.DB.prepare("UPDATE adm_zap_estado SET ultimo_id=NULL WHERE conta_org=? AND telefone IN (" + tels.map(() => "?").join(",") + ")").bind(contaOrg, ...tels).run().catch(() => { });
    await responder(r.ja ? `${r.item.titulo} já estava concluído.` : `✅ Concluído: ${r.item.titulo} (por ${p.nome}, ${horaLocal(ms)}).${r.proximo ? ` Próxima: ${br(r.proximo.data)}.` : ""}`); return true;
  }
  if ((m = /^(iniciar|iniciei|comecei|comecar|andamento|em andamento)\s*([ct])\s*(\d+)$/.exec(t))) {
    const letra = m[2].toUpperCase(), id = Number(m[3]), p = await pessoaDoCodigo(letra, id);
    if (!p) { await responder(`Não encontrei ${letra}${id}.`); return true; }
    const tabela = letra === "C" ? "adm_agenda" : "adm_tarefas";
    const item = await env.DB.prepare(`SELECT * FROM ${tabela} WHERE id=?`).bind(id).first();
    await env.DB.prepare(`UPDATE ${tabela} SET situacao='EM_ANDAMENTO', alterado_por=?, alterado_ms=? WHERE id=?`).bind(p.nome, ms, id).run();
    await registrarHistorico(env, p.org_id, letra === "C" ? "AGENDA" : "TAREFA", id, "iniciou", item.titulo, "Em andamento", quem(p), ms, "whatsapp");
    await responder(`▶ Em andamento: ${item.titulo}.`); return true;
  }
  if ((m = /^(adiar|adia|transferir|remarcar|mudar)\s*([ct])\s*(\d+)\s*(?:para|pra|p\/)?\s*(.*)$/.exec(t))) {
    const letra = m[2].toUpperCase(), id = Number(m[3]), p = await pessoaDoCodigo(letra, id);
    if (!p) { await responder(`Não encontrei ${letra}${id}.`); return true; }
    const v = interpretarCompromisso(`item ${m[4] || "amanhã"}`, hoje);
    const nova = v.data || (!m[4] ? somarDias(hoje, 1) : null);
    if (!nova) { await responder("Para quando? Ex.: ADIAR T5 amanhã · ADIAR C12 sexta às 15h"); return true; }
    const r = await adiarItem(env, p.org_id, letra === "C" ? "AGENDA" : "TAREFA", id, nova, v.hora || null, quem(p), ms, "whatsapp");
    await responder(r.erro || `➡️ Adiado: ${r.item.titulo} para ${nomeDia(nova, hoje)}${letra === "C" && (v.hora || r.item.hora) ? " às " + (v.hora || r.item.hora) : ""}.`); return true;
  }
  if ((m = /^(pago|paga|paguei|pagamos|recebido|recebida|recebi|recebemos)\s*p?\s*(\d+)$/.exec(t))) {
    const id = Number(m[2]), p = await pessoaDoCodigo("P", id);
    if (!p) { await responder(`Não encontrei a conta P${id}.`); return true; }
    if (!admin(p)) { await responder("Confirmar pagamentos é só para o dono e os administradores."); return true; }
    const r = await confirmarConta(env, p.org_id, id, quem(p), ms, "whatsapp");
    await responder(r.erro || (r.ja ? `${r.l.descricao} já estava confirmado.` : `✅ ${r.l.tipo === "ENTRADA" ? "Recebimento" : "Pagamento"} confirmado: ${r.l.descricao} — ${dinheiro(r.l.valor_cent, await moedaDe(p.org_id))} (por ${p.nome}, ${quando(ms)}).`)); return true;
  }
  return false;
}
async function textoPendencias(env, pessoas, hoje, admin, moedaDe, titulo = "📌 *Pendências*") {
  const partes = [];
  for (const p of pessoas) {
    const d = await itensDoDia(env, p.org_id, hoje, hoje, { pessoaId: p.usuario_id, contatoId: p.contato_id || null, soMinhas: Boolean(p.so_minhas), fin: admin(p) });
    const moeda = await moedaDe(p.org_id);
    const abertos = [...d.comHora, ...d.semHora, ...d.pagar, ...d.receber].filter(x => !x.feito);
    if (!abertos.length && !d.atrasados.length) continue;
    const L = [`${titulo}${pessoas.length > 1 ? " — " + p.org_nome : ""}`];
    if (abertos.length) L.push("", "*De hoje, ainda em aberto*", ...abertos.sort((a, b) => PESO[a.prioridade] - PESO[b.prioridade]).map(x => linha(x, moeda)));
    if (d.atrasados.length) L.push("", `*Atrasados (${d.atrasados.length})*`, ...d.atrasados.slice(0, 20).map(x => linha(x, moeda, { comData: true, hoje })));
    partes.push(L.join("\n"));
  }
  return partes.length ? partes.join("\n\n———\n\n") + "\n\nResponda: FEITO C12 · ADIAR T5 amanhã" : "";
}

// Adiar (mudar a data) com histórico de adiamentos.
export async function adiarItem(env, orgId, tipo, id, novaData, novaHora, por, ms, canal = "painel") {
  if (!dataValida(novaData)) return { erro: "Data inválida." };
  const tabela = tipo === "AGENDA" ? "adm_agenda" : "adm_tarefas", campo = tipo === "AGENDA" ? "data" : "prazo";
  const item = await env.DB.prepare(`SELECT * FROM ${tabela} WHERE id=? AND org_id=?`).bind(id, orgId).first();
  if (!item) return { erro: "Item não encontrado." };
  if (item.origem === "google") return { erro: "Este compromisso vem do Google Agenda: mude lá (a DENIA atualiza sozinha)." };
  if (tipo === "AGENDA") await env.DB.prepare("UPDATE adm_agenda SET data=?, hora=COALESCE(?, hora), adiado_n=COALESCE(adiado_n,0)+1, avisado_ms=NULL, avisado_hora_ms=NULL, alterado_por=?, alterado_ms=? WHERE id=?").bind(novaData, novaHora, re(por?.nome, 120) || null, ms, id).run();
  else await env.DB.prepare("UPDATE adm_tarefas SET prazo=?, adiado_n=COALESCE(adiado_n,0)+1, avisado=NULL, alterado_por=?, alterado_ms=? WHERE id=?").bind(novaData, re(por?.nome, 120) || null, ms, id).run();
  await registrarHistorico(env, orgId, tipo, id, "adiou", item.titulo, `${br(item[campo])}${item.hora ? " " + item.hora : ""} → ${br(novaData)}${novaHora ? " " + novaHora : ""}`, por, ms, canal);
  return { ok: true, item };
}

// ---------------------------------------------------------------------------
// Cron (a cada 5 minutos): repetições, lembrete na hora, agenda da manhã, pendências do meio-dia,
// fechamento do fim do dia (com transferência para amanhã) e avisos das contas.
// ---------------------------------------------------------------------------
export async function cronAgendaEquipe(env, k, avisar) {
  await garantirAdmin(env);
  const ms = k.agora(env), hoje = hojeLocal(ms), hora = Number(horaLocal(ms).slice(0, 2)), out = { repeticoes: 0, na_hora: 0, manha: 0, meio: 0, fim: 0, transferidas: 0, contas: 0 };
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
  // 1) Repetições que passaram da data sem concluir: cria a próxima (uma vez).
  for (const a of await q("SELECT * FROM adm_agenda WHERE repetir IS NOT NULL AND COALESCE(gerou_prox,0)=0 AND data < ? LIMIT 200", hoje)) if (await garantirProxima(env, "adm_agenda", a, ms, hoje)) out.repeticoes++;
  for (const t of await q("SELECT * FROM adm_tarefas WHERE repetir IS NOT NULL AND COALESCE(gerou_prox,0)=0 AND prazo IS NOT NULL AND prazo < ? LIMIT 200", hoje)) if (await garantirProxima(env, "adm_tarefas", t, ms, hoje)) out.repeticoes++;
  // 2) Segundo aviso, NA HORA (o primeiro, "antes", já saiu pelo aviso normal). Extrema importância sempre tem.
  const agoraMin = Date.parse(`${hoje}T${horaLocal(ms)}:00Z`);
  for (const a of await q("SELECT * FROM adm_agenda WHERE feito=0 AND hora IS NOT NULL AND data=? AND avisado_hora_ms IS NULL AND aviso_min > 0 LIMIT 200", hoje)) {
    const inicio = Date.parse(`${a.data}T${a.hora}:00Z`);
    if (agoraMin < inicio || agoraMin > inicio + 20 * 60000) continue;
    await env.DB.prepare("UPDATE adm_agenda SET avisado_hora_ms=? WHERE id=?").bind(ms, a.id).run();
    const p = prioridadeValida(a.prioridade);
    const txt = `${p === "EXTREMA" ? "🚨 *EXTREMA IMPORTÂNCIA* — " : p === "ALTA" ? "⚠️ " : "⏰ "}*Agora (${a.hora})*: ${a.titulo}${a.local ? "\nLocal: " + a.local : ""}\n\nResponda OK quando concluir. [C${a.id}]`;
    out.na_hora += await avisarPessoasZap(env, k, a.org_id, { tipo: "C", id: a.id, responsavel_id: a.responsavel_id, contato_id: a.contato_id }, txt, [`${p === "EXTREMA" ? "URGENTE: " : ""}${a.titulo}`, `agora, ${a.hora}`], ms);
    if (p === "EXTREMA" && avisar) await avisar(a.org_id, `🚨 Agora: ${a.titulo}`, `${a.titulo}\nAgora, ${a.hora}${a.local ? "\nLocal: " + a.local : ""}`, a.responsavel_id, null, { semZap: true }).catch(() => 0);
  }
  // 3) Contas com aviso antecipado ou de extrema/alta importância: aviso individual ao responsável, uma vez.
  if (hora >= 8) {
    for (const l of await q(`SELECT l.*, COALESCE(c.aviso_fin_dias, 2) AS dias_cfg FROM fin_lanc l LEFT JOIN adm_config c ON c.org_id=l.org_id WHERE l.pago=0 AND l.data BETWEEN ? AND ? AND (l.responsavel_id IS NOT NULL OR l.prioridade IN ('ALTA','EXTREMA') OR l.aviso_dias IS NOT NULL) LIMIT 300`, hoje, somarDias(hoje, 30)).catch(() => [])) {
      const dias = l.aviso_dias ?? l.dias_cfg ?? 2, antes = somarDias(l.data, -dias);
      const ehDia = l.data === hoje && l.avisado_dia !== hoje, ehAntes = dias > 0 && hoje >= antes && l.data > hoje && !l.avisado_antes;
      if (!ehDia && !ehAntes) continue;
      await env.DB.prepare(`UPDATE fin_lanc SET ${ehDia ? "avisado_dia" : "avisado_antes"}=? WHERE id=?`).bind(hoje, l.id).run();
      const moeda = (await env.DB.prepare("SELECT moeda FROM fin_config WHERE org_id=?").bind(l.org_id).first().catch(() => null))?.moeda || "BRL";
      const p = prioridadeValida(l.prioridade), oQue = l.tipo === "ENTRADA" ? "Receber" : "Pagar";
      const qd = ehDia ? "vence hoje" : `vence ${nomeDia(l.data, hoje)}`;
      const txt = `${marca(p)}💸 *${oQue}: ${l.descricao}* — ${dinheiro(l.valor_cent, moeda)}, ${qd}.${l.contato ? "\n" + l.contato : ""}\n\nDepois de ${l.tipo === "ENTRADA" ? "receber" : "pagar"}, responda ${l.tipo === "ENTRADA" ? "RECEBIDO" : "PAGO"} P${l.id}.`;
      out.contas += await avisarPessoasZap(env, k, l.org_id, { tipo: "P", id: l.id, responsavel_id: l.responsavel_id }, txt, [`${oQue.toLowerCase()} ${l.descricao} (${dinheiro(l.valor_cent, moeda)})`, qd], ms);
      if (avisar) await avisar(l.org_id, `${oQue}: ${l.descricao} — ${qd}`, `${l.descricao}\n${dinheiro(l.valor_cent, moeda)} — ${qd}${l.contato ? "\n" + l.contato : ""}`, l.responsavel_id, null, { semZap: true }).catch(() => 0);
    }
  }
  // 4) Fim do dia: transfere para amanhã as tarefas do dia e os lembretes sem hora que não foram feitos.
  const orgsDoDia = await q(`SELECT org_id FROM adm_tarefas WHERE feito=0 AND prazo=? AND repetir IS NULL UNION SELECT org_id FROM adm_agenda WHERE feito=0 AND data=? AND hora IS NULL AND repetir IS NULL`, hoje, hoje);
  for (const { org_id } of orgsDoDia) {
    const c = (await env.DB.prepare("SELECT * FROM adm_config WHERE org_id=?").bind(org_id).first()) || { org_id };
    if ((c.ultimo_fim || "") >= hoje || hora < Number(c.hora_fim ?? 18)) continue;
    await env.DB.prepare("INSERT OR IGNORE INTO adm_config(org_id, atualizado_ms) VALUES(?,?)").bind(org_id, ms).run();
    await env.DB.prepare("UPDATE adm_config SET ultimo_fim=? WHERE org_id=?").bind(hoje, c.org_id).run();
    if (c.transferir === 0) continue;
    const amanha = somarDias(hoje, 1), por = "DENIA (fim do dia)";
    for (const t of await q("SELECT * FROM adm_tarefas WHERE org_id=? AND feito=0 AND prazo=? AND repetir IS NULL", c.org_id, hoje)) {
      await env.DB.prepare("UPDATE adm_tarefas SET prazo=?, adiado_n=COALESCE(adiado_n,0)+1, avisado=NULL WHERE id=?").bind(amanha, t.id).run();
      await registrarHistorico(env, c.org_id, "TAREFA", t.id, "transferiu", t.titulo, `${br(hoje)} → ${br(amanha)} (não concluída no dia)`, por, ms, "automatico"); out.transferidas++;
    }
    for (const a of await q("SELECT * FROM adm_agenda WHERE org_id=? AND feito=0 AND data=? AND hora IS NULL AND repetir IS NULL AND COALESCE(origem,'') <> 'google'", c.org_id, hoje)) {
      await env.DB.prepare("UPDATE adm_agenda SET data=?, adiado_n=COALESCE(adiado_n,0)+1, avisado_ms=NULL WHERE id=?").bind(amanha, a.id).run();
      await registrarHistorico(env, c.org_id, "AGENDA", a.id, "transferiu", a.titulo, `${br(hoje)} → ${br(amanha)} (não concluído no dia)`, por, ms, "automatico"); out.transferidas++;
    }
  }
  // 5) Mensagens às pessoas: manhã, meio-dia e fim do dia (agrupadas por telefone: quem cuida de várias empresas recebe uma só).
  const pessoas = await q(`SELECT p.*, COALESCE(NULLIF(u.nome,''), u.email) AS nome, u.email, u.super_admin, o.nome AS org_nome, m.papel, COALESCE(c.zap_org_id, p.org_id) AS conta_org,
      COALESCE(c.hora_resumo, 8) AS h_manha, COALESCE(c.hora_meio, 12) AS h_meio, COALESCE(c.hora_fim, 18) AS h_fim, COALESCE(c.relatorio_meio, 1) AS r_meio, COALESCE(c.relatorio_fim, 1) AS r_fim, COALESCE(c.aviso_fin_dias, 2) AS fin_dias
    FROM adm_pessoas p JOIN plt_usuarios u ON u.id=p.usuario_id JOIN plt_organizacoes o ON o.id=p.org_id LEFT JOIN plt_membros m ON m.org_id=p.org_id AND m.usuario_id=p.usuario_id LEFT JOIN adm_config c ON c.org_id=p.org_id
    WHERE p.ativo=1 AND p.telefone IS NOT NULL AND u.ativo=1 AND o.status='ATIVA' AND (COALESCE(p.ultimo_manha,'') < ? OR COALESCE(p.ultimo_meio,'') < ? OR COALESCE(p.ultimo_fim,'') < ?) LIMIT 500`, hoje, hoje, hoje).catch(() => []);
  // Contatos sem login (ex.: o mecânico da oficina) recebem a lista do dia com os compromissos marcados para eles.
  pessoas.push(...(await q(`SELECT p.*, p.id AS contato_id, NULL AS usuario_id, o.nome AS org_nome, COALESCE(c.zap_org_id, p.org_id) AS conta_org,
      COALESCE(c.hora_resumo, 8) AS h_manha, COALESCE(c.hora_meio, 12) AS h_meio, COALESCE(c.hora_fim, 18) AS h_fim, COALESCE(c.relatorio_meio, 1) AS r_meio, COALESCE(c.relatorio_fim, 1) AS r_fim, 0 AS fin_dias
    FROM adm_contatos p JOIN plt_organizacoes o ON o.id=p.org_id LEFT JOIN adm_config c ON c.org_id=p.org_id
    WHERE p.ativo=1 AND o.status='ATIVA' AND (COALESCE(p.ultimo_manha,'') < ? OR COALESCE(p.ultimo_meio,'') < ? OR COALESCE(p.ultimo_fim,'') < ?) LIMIT 500`, hoje, hoje, hoje).catch(() => [])));
  const admin = p => p.super_admin || ["OWNER", "ADMIN"].includes(p.papel);
  const moedas = new Map(), moedaDe = async org => { if (!moedas.has(org)) moedas.set(org, (await env.DB.prepare("SELECT moeda FROM fin_config WHERE org_id=?").bind(org).first().catch(() => null))?.moeda || "BRL"); return moedas.get(org); };
  const grupos = new Map();
  for (const p of pessoas) { const ch = `${p.conta_org}:${variantesTel(p.telefone)[0]}`; if (!grupos.has(ch)) grupos.set(ch, []); grupos.get(ch).push(p); }
  const marcar = async (lista, col) => { for (const p of lista) await (p.contato_id ? env.DB.prepare(`UPDATE adm_contatos SET ${col}=? WHERE id=?`).bind(hoje, p.contato_id) : env.DB.prepare(`UPDATE adm_pessoas SET ${col}=? WHERE org_id=? AND usuario_id=?`).bind(hoje, p.org_id, p.usuario_id)).run(); };
  for (const lista of grupos.values()) {
    const p0 = lista[0];
    try {
      // Manhã
      const manha = lista.filter(p => p.zap_manha && (p.ultimo_manha || "") < hoje && hora >= p.h_manha);
      if (manha.length) {
        await marcar(manha, "ultimo_manha");
        const partes = [], cont = [];
        for (const p of manha) {
          const d = await itensDoDia(env, p.org_id, hoje, hoje, { pessoaId: p.usuario_id, contatoId: p.contato_id || null, soMinhas: Boolean(p.so_minhas), fin: admin(p), finDias: p.fin_dias });
          if (!d.todos.filter(x => !x.feito).length) continue;
          partes.push(textoDoDiaEquipe(d, { empresa: manha.length > 1 || lista.length > 1 ? p.org_nome : "", moeda: await moedaDe(p.org_id), hoje, rodape: false }));
          cont.push((manha.length > 1 ? p.org_nome + ": " : "") + listaCurta(d, Math.floor(650 / manha.length)));
        }
        if (partes.length) {
          const via = await enviarPessoa(env, k, p0, partes.join("\n\n———\n\n") + "\n\nResponda: FEITO C12 · PAGO P34 · ADIAR T5 amanhã · AJUDA", { nome: MODELO_RESUMO, idioma: "pt_BR", params: [`hoje, ${br(hoje)}`, cont.join("; ").slice(0, 900)] });
          if (via) out.manha++;
        }
      }
      // Meio-dia: pendências
      const meio = lista.filter(p => p.zap_relatorios && p.r_meio && (p.ultimo_meio || "") < hoje && hora >= p.h_meio && hora < p.h_fim);
      if (meio.length) {
        await marcar(meio, "ultimo_meio");
        const txt = await textoPendencias(env, meio, hoje, admin, moedaDe, "📌 *Pendências do meio-dia*");
        if (txt) { const n = (txt.match(/\[[CTP]\d+\]/g) || []).length; if (await enviarPessoa(env, k, p0, txt, { nome: MODELO_RESUMO, idioma: "pt_BR", params: ["meio-dia de hoje", `${n} pendência(s) em aberto`] })) out.meio++; }
      }
      // Fim do dia: concluídas (quem fez e a hora), contas confirmadas, atrasadas e transferidas.
      const fim = lista.filter(p => p.zap_relatorios && p.r_fim && (p.ultimo_fim || "") < hoje && hora >= p.h_fim);
      if (fim.length) {
        await marcar(fim, "ultimo_fim");
        const partes = [], cont = [];
        for (const p of fim) {
          const r = await fechamentoDoDia(env, p.org_id, hoje, admin(p), await moedaDe(p.org_id), p.so_minhas && !p.contato_id ? p.usuario_id : null, p.contato_id && p.so_minhas ? p.contato_id : null);
          if (!r.vazio) { partes.push(`🌙 *Fechamento de ${br(hoje)}*${fim.length > 1 || lista.length > 1 ? " — " + p.org_nome : ""}\n${r.texto}`); cont.push(r.resumo); }
        }
        if (partes.length && await enviarPessoa(env, k, p0, partes.join("\n\n———\n\n"), { nome: MODELO_RESUMO, idioma: "pt_BR", params: [`hoje, ${br(hoje)}`, cont.join("; ").slice(0, 900)] })) out.fim++;
      }
    } catch (e) { console.error("agenda equipe", e?.message); }
  }
  return out;
}

export async function fechamentoDoDia(env, orgId, hoje, comFin, moeda, soDe = null, soContato = null) {
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
  const ini = inicioDoDia(hoje), fimMs = ini + 86400000;
  const meu = soContato ? " AND contato_id=?" : soDe ? " AND (responsavel_id=? OR responsavel_id IS NULL OR feito_por_id=?)" : "", am = soContato ? [soContato] : soDe ? [soDe, soDe] : [];
  const feitos = [...(await q(`SELECT 'C' t, id, titulo, feito_por, feito_ms, responsavel_id FROM adm_agenda WHERE org_id=? AND feito=1 AND (feito_ms BETWEEN ? AND ? OR (feito_ms IS NULL AND feito_em=?))${meu}`, orgId, ini, fimMs, hoje, ...am)),
    ...(await q(`SELECT 'T' t, id, titulo, feito_por, feito_ms, responsavel_id FROM adm_tarefas WHERE org_id=? AND feito=1 AND (feito_ms BETWEEN ? AND ? OR (feito_ms IS NULL AND feito_em=?))${meu}`, orgId, ini, fimMs, hoje, ...am))].sort((a, b) => (a.feito_ms || 0) - (b.feito_ms || 0));
  const contas = comFin ? await q("SELECT id, tipo, descricao, valor_cent, confirmado_por, confirmado_ms FROM fin_lanc WHERE org_id=? AND pago=1 AND (confirmado_ms BETWEEN ? AND ? OR (confirmado_ms IS NULL AND pago_em=? AND atualizado_ms BETWEEN ? AND ?)) ORDER BY confirmado_ms", orgId, ini, fimMs, hoje, ini, fimMs).catch(() => []) : [];
  const transf = await q("SELECT tipo, item_id, titulo FROM adm_historico WHERE org_id=? AND acao='transferiu' AND ms BETWEEN ? AND ?", orgId, ini, fimMs);
  const d = await itensDoDia(env, orgId, hoje, hoje, { pessoaId: soDe, contatoId: soContato, soMinhas: Boolean(soDe || soContato), fin: comFin });
  const naoFeitos = [...d.comHora.filter(x => !x.feito), ...d.semHora.filter(x => !x.feito && x.data === hoje), ...d.atrasados, ...(comFin ? [...d.pagar, ...d.receber].filter(x => !x.feito) : [])];
  const L = [];
  if (feitos.length) L.push("", `✅ *Concluídas (${feitos.length})*`, ...feitos.map(x => `• ${x.titulo}${x.feito_por ? ` — ${x.feito_por}` : ""}${x.feito_ms ? ` às ${horaLocal(x.feito_ms)}` : ""} [${x.t}${x.id}]`));
  if (contas.length) L.push("", `💳 *Pagamentos e recebimentos confirmados (${contas.length})*`, ...contas.map(x => `• ${x.tipo === "ENTRADA" ? "Recebido" : "Pago"}: ${x.descricao} — ${dinheiro(x.valor_cent, moeda)}${x.confirmado_por ? ` — ${x.confirmado_por}` : ""}${x.confirmado_ms ? ` às ${horaLocal(x.confirmado_ms)}` : ""}`));
  if (naoFeitos.length) L.push("", `⏰ *Em aberto ou atrasadas (${naoFeitos.length})*`, ...naoFeitos.slice(0, 25).map(x => linha(x, moeda, { comData: x.data !== hoje, hoje })));
  if (transf.length) L.push("", `➡️ *Transferidas para amanhã (${transf.length})*`, ...transf.map(x => `• ${x.titulo} [${x.tipo === "AGENDA" ? "C" : "T"}${x.item_id}]`));
  const resumo = `${feitos.length} concluída(s), ${naoFeitos.length} em aberto, ${transf.length} transferida(s) para amanhã${contas.length ? `, ${contas.length} conta(s) confirmada(s)` : ""}`;
  return { vazio: !L.length, texto: L.join("\n").trim(), resumo, feitos, contas, naoFeitos, transf };
}

// ---------------------------------------------------------------------------
// iPhone: calendário pessoal (com alertas por prioridade) e alarmes de verdade pelo app Atalhos.
// ---------------------------------------------------------------------------
const icalEsc = s => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icalDia = d => d.replace(/-/g, "");
async function orgsDoUsuario(env, usuarioId) {
  const u = await env.DB.prepare("SELECT id, super_admin, ativo FROM plt_usuarios WHERE id=?").bind(usuarioId).first();
  if (!u || !u.ativo) return [];
  const r = (await env.DB.prepare(`SELECT o.id, o.nome, m.papel FROM plt_membros m JOIN plt_organizacoes o ON o.id=m.org_id WHERE m.usuario_id=? AND o.status='ATIVA'
    UNION SELECT o.id, o.nome, 'OWNER' FROM adm_pessoas p JOIN plt_organizacoes o ON o.id=p.org_id WHERE p.usuario_id=? AND ? = 1 AND o.status='ATIVA'`).bind(usuarioId, usuarioId, u.super_admin ? 1 : 0).all()).results || [];
  const vistos = new Set();
  return r.filter(o => !vistos.has(o.id) && vistos.add(o.id)).map(o => ({ ...o, admin: Boolean(u.super_admin) || ["OWNER", "ADMIN"].includes(o.papel) }));
}
// Antecedência dos alarmes por prioridade: extrema = 3 alertas, alta = 2, normal = o aviso do compromisso, baixa = nenhum.
function gatilhos(p, avisoMin, antecedencia) {
  if (p === "EXTREMA") return [...new Set([Math.max(antecedencia, 60), antecedencia, 0])];
  if (p === "ALTA") return [...new Set([antecedencia, 0])];
  if (p === "NORMAL") return [Math.max(0, avisoMin ?? antecedencia)];
  return [];
}
export async function publicoCelular(env, caminho, url, ms) {
  let m = /^\/adm\/(ical\/p|alarmes)\/([A-Za-z0-9_-]{20,80})\.(ics|json|txt)$/.exec(caminho);
  if (!m) return null;
  await garantirAdmin(env);
  const tk = await env.DB.prepare("SELECT * FROM adm_alarme_tokens WHERE token=?").bind(m[2]).first();
  if (!tk) return new Response("Não encontrado.", { status: 404 });
  const orgs = await orgsDoUsuario(env, tk.usuario_id);
  const hoje = hojeLocal(ms), prioMin = prioridadeValida(tk.prio_min, "ALTA"), antecedencia = Math.max(0, Math.min(240, Number(tk.antecedencia ?? 15)));
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
  const meus = async (o, de, ate) => {
    const ag = await q("SELECT * FROM adm_agenda WHERE org_id=? AND data BETWEEN ? AND ? AND (responsavel_id=? OR responsavel_id IS NULL) ORDER BY data, COALESCE(hora,'99:99') LIMIT 800", o.id, de, ate, tk.usuario_id);
    const tf = await q("SELECT * FROM adm_tarefas WHERE org_id=? AND prazo BETWEEN ? AND ? AND (responsavel_id=? OR responsavel_id IS NULL) LIMIT 400", o.id, de, ate, tk.usuario_id);
    const fin = o.admin ? await q("SELECT * FROM fin_lanc WHERE org_id=? AND pago=0 AND data BETWEEN ? AND ? AND (responsavel_id=? OR responsavel_id IS NULL OR prioridade IN ('ALTA','EXTREMA')) LIMIT 400", o.id, de, ate, tk.usuario_id).catch(() => []) : [];
    return { ag, tf, fin };
  };
  if (m[1] === "alarmes") {
    // Para o app Atalhos: os alarmes de hoje (a partir de agora), da prioridade escolhida para cima.
    const agora = horaLocal(ms), lista = [];
    const novos = url.searchParams.get("novos") === "1";
    for (const o of orgs) {
      const { ag } = await meus(o, hoje, hoje);
      for (const a of ag.filter(a => !a.feito && a.hora)) {
        const p = prioridadeValida(a.prioridade);
        if (PESO[p] > PESO[prioMin]) continue;
        const ant = p === "EXTREMA" ? Math.max(antecedencia, 30) : antecedencia;
        const minIni = Number(a.hora.slice(0, 2)) * 60 + Number(a.hora.slice(3)) - ant;
        if (minIni < 0) continue;
        const hAl = `${String(Math.floor(minIni / 60)).padStart(2, "0")}:${String(minIni % 60).padStart(2, "0")}`;
        if (hAl < agora) continue;
        lista.push({ chave: `C${a.id}@${a.data}T${hAl}`, hora_alarme: hAl, hora: a.hora, rotulo: `${p === "EXTREMA" ? "URGENTE: " : ""}${a.titulo} (${a.hora})${orgs.length > 1 ? " — " + o.nome : ""}`.slice(0, 120), prioridade: p, empresa: o.nome });
      }
    }
    lista.sort((a, b) => a.hora_alarme.localeCompare(b.hora_alarme));
    let saida = lista;
    if (novos) {
      const ja = new Set(((await env.DB.prepare("SELECT chave FROM adm_alarmes_ok WHERE usuario_id=? AND ms > ?").bind(tk.usuario_id, ms - 3 * 86400000).all()).results || []).map(x => x.chave));
      saida = lista.filter(x => !ja.has(x.chave));
      for (const x of saida) await env.DB.prepare("INSERT OR IGNORE INTO adm_alarmes_ok(usuario_id,chave,ms) VALUES(?,?,?)").bind(tk.usuario_id, x.chave, ms).run();
      await env.DB.prepare("DELETE FROM adm_alarmes_ok WHERE ms < ?").bind(ms - 7 * 86400000).run().catch(() => { });
    }
    await env.DB.prepare("UPDATE adm_alarme_tokens SET usado_ms=? WHERE token=?").bind(ms, tk.token).run().catch(() => { });
    if (m[3] === "txt") return new Response(saida.map(x => `${x.hora_alarme} ${x.rotulo}`).join("\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    return new Response(JSON.stringify({ data: hoje, alarmes: saida, horas: saida.map(x => x.hora_alarme), rotulos: saida.map(x => x.rotulo) }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  if (m[3] !== "ics") return new Response("Não encontrado.", { status: 404 });
  const de = somarDias(hoje, -30), ate = somarDias(hoje, 200), ev = [];
  const alarme = (min, txt) => ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icalEsc(txt)}`, `TRIGGER:${min ? "-PT" + min + "M" : "PT0S"}`, "END:VALARM"];
  const alarmeDia = (gat, txt) => ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icalEsc(txt)}`, `TRIGGER:${gat}`, "END:VALARM"];
  for (const o of orgs) {
    const { ag, tf, fin } = await meus(o, de, ate), suf = orgs.length > 1 ? ` — ${o.nome}` : "";
    for (const a of ag) {
      const p = prioridadeValida(a.prioridade), tit = `${p === "EXTREMA" ? "🚨 " : p === "ALTA" ? "⚠️ " : ""}${a.feito ? "✓ " : ""}${a.titulo}${suf}`;
      const desc = [a.local, a.obs, `Prioridade: ${NOME_PRIORIDADE[p]}`, `Código na DENIA: C${a.id}`].filter(Boolean).join("\n");
      if (a.hora) {
        const ini = `${icalDia(a.data)}T${a.hora.replace(":", "")}00`, fimMs = Date.parse(`${a.data}T${a.hora}:00Z`) + (a.duracao_min || 60) * 60000;
        const fim = new Date(fimMs).toISOString().replace(/[-:]/g, "").slice(0, 15);
        ev.push("BEGIN:VEVENT", `UID:denia-p-ag-${a.id}@denia`, `DTSTAMP:${icalDia(hoje)}T000000Z`, `DTSTART;TZID=America/Sao_Paulo:${ini}`, `DTEND;TZID=America/Sao_Paulo:${fim}`, `SUMMARY:${icalEsc(tit)}`,
          a.local ? `LOCATION:${icalEsc(a.local)}` : null, `DESCRIPTION:${icalEsc(desc)}`, p === "EXTREMA" ? "PRIORITY:1" : p === "ALTA" ? "PRIORITY:3" : null,
          ...(a.feito ? [] : gatilhos(p, a.aviso_min, antecedencia).flatMap(min => alarme(min, a.titulo))), "END:VEVENT");
      } else ev.push("BEGIN:VEVENT", `UID:denia-p-ag-${a.id}@denia`, `DTSTAMP:${icalDia(hoje)}T000000Z`, `DTSTART;VALUE=DATE:${icalDia(a.data)}`, `DTEND;VALUE=DATE:${icalDia(somarDias(a.data, 1))}`, `SUMMARY:${icalEsc(tit)}`, `DESCRIPTION:${icalEsc(desc)}`,
        ...(a.feito || p === "BAIXA" ? [] : alarmeDia("PT8H", a.titulo)), ...(!a.feito && p === "EXTREMA" ? alarmeDia("PT12H", a.titulo) : []), "END:VEVENT");
    }
    for (const t of tf) {
      const p = prioridadeValida(t.prioridade);
      ev.push("BEGIN:VEVENT", `UID:denia-p-tf-${t.id}@denia`, `DTSTAMP:${icalDia(hoje)}T000000Z`, `DTSTART;VALUE=DATE:${icalDia(t.prazo)}`, `DTEND;VALUE=DATE:${icalDia(somarDias(t.prazo, 1))}`, `SUMMARY:${icalEsc(`${t.feito ? "✓ " : "☐ "}Tarefa: ${t.titulo}${suf}`)}`,
        `DESCRIPTION:${icalEsc(`Prioridade: ${NOME_PRIORIDADE[p]}\nCódigo na DENIA: T${t.id}`)}`, ...(t.feito || p === "BAIXA" ? [] : alarmeDia("PT9H", t.titulo)), "END:VEVENT");
    }
    for (const l of fin) {
      const p = prioridadeValida(l.prioridade);
      ev.push("BEGIN:VEVENT", `UID:denia-p-fin-${l.id}@denia`, `DTSTAMP:${icalDia(hoje)}T000000Z`, `DTSTART;VALUE=DATE:${icalDia(l.data)}`, `DTEND;VALUE=DATE:${icalDia(somarDias(l.data, 1))}`,
        `SUMMARY:${icalEsc(`${p === "EXTREMA" ? "🚨 " : ""}${l.tipo === "ENTRADA" ? "Receber" : "Pagar"}: ${l.descricao} (${dinheiro(l.valor_cent)})${suf}`)}`, `DESCRIPTION:${icalEsc(`Código na DENIA: P${l.id}`)}`,
        ...alarmeDia(`-P${Math.max(1, l.aviso_dias ?? 1)}D`, "Vence em breve: " + l.descricao), ...alarmeDia("PT9H", "Vence hoje: " + l.descricao), "END:VEVENT");
    }
  }
  const corpo = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DENIA//Agenda pessoal//PT", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:DENIA — Minha agenda", "X-WR-TIMEZONE:America/Sao_Paulo", "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M",
    "BEGIN:VTIMEZONE", "TZID:America/Sao_Paulo", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:-0300", "TZOFFSETTO:-0300", "TZNAME:-03", "END:STANDARD", "END:VTIMEZONE",
    ...ev.filter(Boolean), "END:VCALENDAR"].join("\r\n");
  return new Response(corpo, { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" } });
}

// ---------------------------------------------------------------------------
// Relatório da agenda e das contas: filtros por período, colaborador, categoria, prioridade e situação.
// ---------------------------------------------------------------------------
export async function relatorioAgenda(env, orgId, f, hoje, comFin) {
  await garantirAdmin(env);
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
  const de = dataValida(f.de) ? f.de : somarDias(hoje, -30), ate = dataValida(f.ate) ? f.ate : hoje;
  const colab = Number(f.colaborador) || null;
  const nomes = new Map(((await q("SELECT id, COALESCE(NULLIF(nome,''), email) nome FROM plt_usuarios")).map(u => [u.id, u.nome])));
  const linhas = [];
  const tipos = String(f.tipo || "").split(",").filter(Boolean);
  const quer = t => !tipos.length || tipos.includes(t);
  if (quer("compromisso") || quer("lembrete")) for (const a of await q("SELECT * FROM adm_agenda WHERE org_id=? AND data BETWEEN ? AND ? ORDER BY data, COALESCE(hora,'99:99') LIMIT 5000", orgId, de, ate)) {
    const t = a.tipo === "LEMBRETE" ? "lembrete" : "compromisso"; if (!quer(t)) continue;
    linhas.push({ cod: "C" + a.id, tipo: t, titulo: a.titulo, data: a.data, hora: a.hora, prioridade: prioridadeValida(a.prioridade), categoria: a.categoria || "", escopo: a.escopo || "", responsavel_id: a.responsavel_id, responsavel: nomes.get(a.responsavel_id) || "",
      situacao: situacaoDe(a, hoje), criado_por: a.criado_por || (a.origem === "google" ? "Google Agenda" : ""), criado_ms: a.criado_ms, alterado_por: a.alterado_por || "", alterado_ms: a.alterado_ms, feito_por: a.feito_por || "", feito_por_id: a.feito_por_id, feito_ms: a.feito_ms, feito_em: a.feito_em, adiado_n: a.adiado_n || 0 });
  }
  if (quer("tarefa")) for (const x of await q("SELECT * FROM adm_tarefas WHERE org_id=? AND ((prazo BETWEEN ? AND ?) OR (prazo IS NULL AND criado_ms BETWEEN ? AND ?) OR (feito_em BETWEEN ? AND ?)) ORDER BY COALESCE(prazo, feito_em) LIMIT 5000", orgId, de, ate, inicioDoDia(de), inicioDoDia(ate) + 86400000, de, ate)) {
    linhas.push({ cod: "T" + x.id, tipo: "tarefa", titulo: x.titulo, data: x.prazo, hora: null, prioridade: prioridadeValida(x.prioridade), categoria: x.categoria || "", escopo: x.escopo || "", responsavel_id: x.responsavel_id, responsavel: nomes.get(x.responsavel_id) || "",
      situacao: situacaoDe(x, hoje), criado_por: x.criado_por || "", criado_ms: x.criado_ms, alterado_por: x.alterado_por || "", alterado_ms: x.alterado_ms, feito_por: x.feito_por || "", feito_por_id: x.feito_por_id, feito_ms: x.feito_ms, feito_em: x.feito_em, adiado_n: x.adiado_n || 0 });
  }
  if (comFin && (quer("pagar") || quer("receber"))) for (const l of await q("SELECT * FROM fin_lanc WHERE org_id=? AND data BETWEEN ? AND ? ORDER BY data LIMIT 5000", orgId, de, ate).catch(() => [])) {
    const t = l.tipo === "ENTRADA" ? "receber" : "pagar"; if (!quer(t)) continue;
    linhas.push({ cod: "P" + l.id, tipo: t, titulo: l.descricao, data: l.data, hora: null, prioridade: prioridadeValida(l.prioridade), categoria: l.categoria || "", escopo: "", responsavel_id: l.responsavel_id, responsavel: nomes.get(l.responsavel_id) || "", valor_cent: l.valor_cent,
      situacao: l.pago ? "CONCLUIDA" : l.data < hoje ? "ATRASADA" : "PENDENTE", criado_por: l.criado_por || "", criado_ms: l.criado_ms, alterado_por: "", alterado_ms: l.atualizado_ms, feito_por: l.confirmado_por || "", feito_por_id: null, feito_ms: l.confirmado_ms, feito_em: l.pago_em, adiado_n: 0 });
  }
  const cats = String(f.categoria || "").split(",").filter(Boolean), prios = String(f.prioridade || "").split(",").filter(Boolean), sits = String(f.situacao || "").split(",").filter(Boolean);
  const filtradas = linhas.filter(l => (!colab || l.responsavel_id === colab || l.feito_por_id === colab || (nomes.get(colab) && (l.feito_por === nomes.get(colab) || l.criado_por === nomes.get(colab))))
    && (!cats.length || cats.includes(l.categoria)) && (!prios.length || prios.includes(l.prioridade)) && (!sits.length || sits.includes(l.situacao)) && (!f.escopo || l.escopo === f.escopo));
  const historico = await q(`SELECT * FROM adm_historico WHERE org_id=? AND ms BETWEEN ? AND ? ${comFin ? "" : "AND tipo <> 'CONTA'"} ORDER BY ms DESC LIMIT 3000`, orgId, inicioDoDia(de), inicioDoDia(ate) + 86400000);
  const histF = colab ? historico.filter(h => h.por_id === colab || h.por === nomes.get(colab)) : historico;
  const porSit = Object.fromEntries(SITUACOES.map(s => [s, filtradas.filter(l => l.situacao === s).length]));
  // Quem concluiu de fato (inclusive o que não era dela).
  const porPessoa = {};
  for (const l of filtradas) {
    if (l.responsavel) { porPessoa[l.responsavel] = porPessoa[l.responsavel] || { responsavel: 0, concluiu: 0, atrasadas: 0, de_outros: 0 }; porPessoa[l.responsavel].responsavel++; if (l.situacao === "ATRASADA") porPessoa[l.responsavel].atrasadas++; }
    if (l.feito_por) { porPessoa[l.feito_por] = porPessoa[l.feito_por] || { responsavel: 0, concluiu: 0, atrasadas: 0, de_outros: 0 }; porPessoa[l.feito_por].concluiu++; if (l.responsavel && l.responsavel !== l.feito_por) porPessoa[l.feito_por].de_outros++; }
  }
  return { de, ate, linhas: filtradas, historico: histF.slice(0, 1500), totais: { itens: filtradas.length, ...porSit, adiamentos: filtradas.reduce((s, l) => s + l.adiado_n, 0) }, por_pessoa: Object.entries(porPessoa).map(([nome, v]) => ({ nome, ...v })).sort((a, b) => b.concluiu - a.concluiu) };
}
const TIPO_NOME = { compromisso: "Compromisso", lembrete: "Lembrete", tarefa: "Tarefa", pagar: "A pagar", receber: "A receber" };
export function xlsxRelatorioAgenda(r, moeda = "BRL") {
  const dt = ms => ms ? quando(ms) : "";
  const abas = [
    { nome: "Itens", linhas: [["Código", "Tipo", "Descrição", "Data", "Hora", "Prioridade", "Categoria", "Pessoal/Profissional", "Responsável", "Situação", "Valor", "Criado por", "Criado em", "Alterado por", "Alterado em", "Concluído/confirmado por", "Concluído em", "Adiamentos"],
      ...r.linhas.map(l => [l.cod, TIPO_NOME[l.tipo], l.titulo, br(l.data), l.hora || "", NOME_PRIORIDADE[l.prioridade], l.categoria, l.escopo === "PESSOAL" ? "Pessoal" : l.escopo === "PROFISSIONAL" ? "Profissional" : "", l.responsavel, NOME_SITUACAO[l.situacao], l.valor_cent !== undefined ? l.valor_cent / 100 : "",
        l.criado_por, dt(l.criado_ms), l.alterado_por, dt(l.alterado_ms), l.feito_por, l.feito_ms ? dt(l.feito_ms) : l.feito_em ? br(l.feito_em) : "", l.adiado_n])], larguras: [9, 12, 44, 11, 7, 18, 14, 14, 22, 13, 12, 22, 15, 22, 15, 24, 15, 10] },
    { nome: "Por pessoa", linhas: [["Pessoa", "Itens sob responsabilidade", "Concluiu", "Concluiu de outras pessoas", "Atrasadas"], ...r.por_pessoa.map(p => [p.nome, p.responsavel, p.concluiu, p.de_outros, p.atrasadas])], larguras: [30, 24, 12, 24, 12] },
    { nome: "Histórico", linhas: [["Quando", "Quem", "Ação", "Item", "Detalhe", "Canal"], ...r.historico.map(h => [dt(h.ms), h.por || "", h.acao, `${h.tipo === "AGENDA" ? "C" : h.tipo === "TAREFA" ? "T" : "P"}${h.item_id || ""} ${h.titulo || ""}`, h.detalhe || "", h.canal || ""])], larguras: [15, 24, 20, 44, 50, 12] }
  ];
  return gerarXlsx(abas);
}
export function pdfRelatorioAgenda(r, empresa, moeda = "BRL", geradoEm = "") {
  const dt = ms => ms ? quando(ms) : "";
  const blocos = [
    { tipo: "metricas", itens: [{ rotulo: "Itens", valor: String(r.totais.itens) }, { rotulo: "Concluídos", valor: String(r.totais.CONCLUIDA) }, { rotulo: "Pendentes", valor: String(r.totais.PENDENTE + r.totais.EM_ANDAMENTO) }, { rotulo: "Atrasados", valor: String(r.totais.ATRASADA) }] },
    { tipo: "titulo", texto: "Itens do período" },
    { tipo: "tabela", colunas: ["Data", "Item", "Prioridade", "Responsável", "Situação", "Concluído por"], larguras: [1.1, 3.4, 1.2, 1.6, 1.2, 2],
      linhas: r.linhas.slice(0, 600).map(l => [`${br(l.data)}${l.hora ? " " + l.hora : ""}`, `[${l.cod}] ${l.titulo}${l.valor_cent !== undefined ? " — " + dinheiro(l.valor_cent, moeda) : ""}`, NOME_PRIORIDADE[l.prioridade], l.responsavel || "—", NOME_SITUACAO[l.situacao], l.feito_por ? `${l.feito_por}${l.feito_ms ? " " + dt(l.feito_ms) : ""}` : "—"]) }
  ];
  if (r.por_pessoa.length) blocos.push({ tipo: "titulo", texto: "Por pessoa (quem concluiu de fato)" }, { tipo: "tabela", colunas: ["Pessoa", "Responsável por", "Concluiu", "De outras pessoas", "Atrasadas"], larguras: [3, 1.4, 1.2, 1.6, 1.2], linhas: r.por_pessoa.map(p => [p.nome, String(p.responsavel), String(p.concluiu), String(p.de_outros), String(p.atrasadas)]) });
  if (r.historico.length) blocos.push({ tipo: "titulo", texto: "Histórico (criações, alterações, conclusões, adiamentos e exclusões)" }, { tipo: "tabela", colunas: ["Quando", "Quem", "Ação", "Item e detalhe"], larguras: [1.3, 1.8, 1.4, 4.5], linhas: r.historico.slice(0, 400).map(h => [dt(h.ms), h.por || "—", h.acao, `${h.titulo || ""}${h.detalhe ? " — " + h.detalhe : ""}`]) });
  return gerarPdf({ titulo: "Relatório da agenda e das tarefas", subtitulo: `${empresa ? empresa + " · " : ""}${br(r.de)} a ${br(r.ate)}`, rodape: `DENIA · gerado em ${geradoEm} · dados como registrados na plataforma`, corPrincipal: "#2563eb", blocos });
}

// ---------------------------------------------------------------------------
// Rotas: /api/orgs/:id/adm/{pessoas, historico, relatorio-agenda, zap, celular}
// ---------------------------------------------------------------------------
export const AREAS_EQUIPE = ["contatos", "pessoas", "historico", "relatorio-agenda", "zap", "celular", "adiar"];
export async function rotasAgendaEquipe(request, env, k, orgId, papel, partes, ajudas) {
  const { json, lerCorpo, pode, agora } = k;
  const url = new URL(request.url), metodo = request.method, ms = agora(env), hoje = hojeLocal(ms);
  const admin = pode(papel, "ADMIN"), eu = k.sessao?.usuario || {};
  const euP = { id: eu.id || null, nome: eu.nome || eu.email || null };
  const corpo = async () => { const { corpo: c, erro } = await lerCorpo(request); return erro ? { erro } : { c: c || {} }; };
  const area = partes[0];
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];

  // Os modelos aprovados da Meta são criados sozinhos na primeira vez que alguém é cadastrado para receber.
  const garantirModelos = async () => { try { const cfg = await ajudas.config(); if (k.modelosAgendaZap) await k.modelosAgendaZap(Number(cfg.zap_org_id) || orgId, true); } catch { /* sem WhatsApp conectado ainda */ } };

  // Quem recebe no WhatsApp sem precisar de login (ex.: o mecânico, a secretária, o cliente da oficina).
  if (area === "contatos") {
    const id = /^\d+$/.test(partes[1] || "") ? Number(partes[1]) : null;
    if (metodo === "GET" && !id) return json({ contatos: await q("SELECT * FROM adm_contatos WHERE org_id=? ORDER BY ativo DESC, nome", orgId) });
    const ler = async atual => {
      const { c, erro } = await corpo(); if (erro) return { erro };
      const nome = re(c.nome ?? atual?.nome, 80);
      if (!nome) return { msg: "Escreva o nome de quem vai receber." };
      const tel = telefoneValido(c.telefone ?? atual?.telefone);
      if (!tel) return { msg: "WhatsApp inválido. Use DDD + número (ex.: 21 99999-9162)." };
      const dono = await env.DB.prepare(`SELECT id FROM adm_contatos WHERE org_id=? AND telefone IN (${variantesTel(tel).map(() => "?").join(",")}) AND id<>?`).bind(orgId, ...variantesTel(tel), atual?.id || 0).first();
      if (dono) return { msg: "Este WhatsApp já está cadastrado.", existente: dono.id };
      const b = (v, padrao) => v === undefined ? padrao : v === false || v === 0 || v === "0" ? 0 : 1;
      return { v: { nome, telefone: tel, ativo: b(c.ativo, atual?.ativo ?? 1), zap_manha: b(c.zap_manha, atual?.zap_manha ?? 1), zap_lembretes: b(c.zap_lembretes, atual?.zap_lembretes ?? 1), zap_relatorios: b(c.zap_relatorios, atual?.zap_relatorios ?? 0), so_minhas: b(c.so_minhas, atual?.so_minhas ?? 1) } };
    };
    if (metodo === "POST" && !id) {
      const r = await ler(null); if (r.erro) return r.erro; if (r.msg) return json({ erro: r.msg, existente: r.existente || null }, r.existente ? 409 : 400);
      const v = r.v;
      const ins = await env.DB.prepare("INSERT INTO adm_contatos(org_id,nome,telefone,ativo,zap_manha,zap_lembretes,zap_relatorios,so_minhas,criado_ms) VALUES(?,?,?,?,?,?,?,?,?)").bind(orgId, v.nome, v.telefone, v.ativo, v.zap_manha, v.zap_lembretes, v.zap_relatorios, v.so_minhas, ms).run();
      await garantirModelos();
      return json({ ok: true, id: ins.meta?.last_row_id, ...v }, 201);
    }
    if (id) {
      const atual = await env.DB.prepare("SELECT * FROM adm_contatos WHERE id=? AND org_id=?").bind(id, orgId).first();
      if (!atual) return json({ erro: "Contato não encontrado." }, 404);
      if (metodo === "PUT") {
        const r = await ler(atual); if (r.erro) return r.erro; if (r.msg) return json({ erro: r.msg }, 400);
        const v = r.v;
        await env.DB.prepare("UPDATE adm_contatos SET nome=?, telefone=?, ativo=?, zap_manha=?, zap_lembretes=?, zap_relatorios=?, so_minhas=? WHERE id=?").bind(v.nome, v.telefone, v.ativo, v.zap_manha, v.zap_lembretes, v.zap_relatorios, v.so_minhas, id).run();
        return json({ ok: true, ...v });
      }
      if (metodo === "DELETE") {
        await env.DB.prepare("UPDATE adm_agenda SET contato_id=NULL WHERE org_id=? AND contato_id=?").bind(orgId, id).run();
        await env.DB.prepare("UPDATE adm_tarefas SET contato_id=NULL WHERE org_id=? AND contato_id=?").bind(orgId, id).run();
        await env.DB.prepare("DELETE FROM adm_contatos WHERE id=? AND org_id=?").bind(id, orgId).run();
        return json({ ok: true });
      }
      if (partes[2] === "testar" && metodo === "POST") {
        const cfg = await ajudas.config();
        const d = await itensDoDia(env, orgId, hoje, hoje, { contatoId: id, soMinhas: Boolean(atual.so_minhas), fin: false });
        const via = k.zapEquipe ? await k.zapEquipe(Number(cfg.zap_org_id) || orgId, atual.telefone, textoDoDiaEquipe(d, { hoje }), { nome: MODELO_RESUMO, idioma: "pt_BR", params: [`hoje, ${br(hoje)}`, listaCurta(d)] }).catch(() => "") : "";
        if (!via) return json({ erro: "Não consegui enviar. Confira se o WhatsApp da empresa está conectado e se os modelos já foram aprovados pela Meta (WhatsApp e celular). Se a pessoa mandar um “oi” para o número da empresa, a lista chega na hora." }, 502);
        return json({ ok: true, via });
      }
    }
  }

  // Equipe no WhatsApp: telefone e o que cada pessoa recebe.
  if (area === "pessoas") {
    const membros = await ajudas.membros();
    if (metodo === "GET") {
      const regs = new Map((await q("SELECT * FROM adm_pessoas WHERE org_id=?", orgId)).map(p => [p.usuario_id, p]));
      const lista = membros.filter(m0 => admin || m0.id === eu.id).map(m0 => { const r = regs.get(m0.id) || {}; return { usuario_id: m0.id, nome: m0.nome, email: m0.email, papel: m0.papel, telefone: r.telefone || "", ativo: r.ativo ?? 1, zap_manha: r.zap_manha ?? 1, zap_lembretes: r.zap_lembretes ?? 1, zap_relatorios: r.zap_relatorios ?? 1, so_minhas: r.so_minhas ?? 0, cadastrado: Boolean(r.telefone) }; });
      return json({ pessoas: lista, eu: eu.id || null });
    }
    if (metodo === "PUT") {
      const { c, erro } = await corpo(); if (erro) return erro;
      const uid = Number(c.usuario_id) || 0;
      if (!membros.some(m0 => m0.id === uid)) return json({ erro: "Pessoa não encontrada na equipe." }, 404);
      if (!admin && uid !== eu.id) return json({ erro: "Você só pode alterar o seu próprio WhatsApp." }, 403);
      const tel = c.telefone ? telefoneValido(c.telefone) : null;
      if (c.telefone && !tel) return json({ erro: "Telefone inválido. Use DDD + número (ex.: 11 98765-4321) ou com o código do país." }, 400);
      if (tel) {
        const dono = await env.DB.prepare(`SELECT usuario_id FROM adm_pessoas WHERE org_id=? AND telefone IN (${variantesTel(tel).map(() => "?").join(",")}) AND usuario_id<>?`).bind(orgId, ...variantesTel(tel), uid).first();
        if (dono) return json({ erro: "Este número já está cadastrado para outra pessoa da equipe." }, 409);
      }
      const b = v => v === false || v === 0 || v === "0" ? 0 : 1;
      await env.DB.prepare(`INSERT INTO adm_pessoas(org_id,usuario_id,telefone,ativo,zap_manha,zap_lembretes,zap_relatorios,so_minhas,atualizado_ms) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(org_id,usuario_id) DO UPDATE SET telefone=excluded.telefone, ativo=excluded.ativo, zap_manha=excluded.zap_manha, zap_lembretes=excluded.zap_lembretes, zap_relatorios=excluded.zap_relatorios, so_minhas=excluded.so_minhas, atualizado_ms=excluded.atualizado_ms`)
        .bind(orgId, uid, tel, b(c.ativo), b(c.zap_manha), b(c.zap_lembretes), b(c.zap_relatorios), c.so_minhas ? 1 : 0, ms).run();
      if (tel) await garantirModelos();
      return json({ ok: true, telefone: tel });
    }
  }

  // Histórico de um item, ou do período.
  if (area === "historico" && metodo === "GET") {
    const tipo = String(url.searchParams.get("tipo") || "").toUpperCase(), id = Number(url.searchParams.get("id")) || 0;
    if (tipo === "CONTA" && !admin) return json({ erro: "Só o dono e os administradores veem o histórico das contas." }, 403);
    if (["AGENDA", "TAREFA", "CONTA"].includes(tipo) && id) return json({ historico: await q("SELECT * FROM adm_historico WHERE org_id=? AND tipo=? AND item_id=? ORDER BY ms DESC LIMIT 200", orgId, tipo, id) });
    return json({ historico: await q(`SELECT * FROM adm_historico WHERE org_id=? ${admin ? "" : "AND tipo <> 'CONTA'"} ORDER BY ms DESC LIMIT 300`, orgId) });
  }

  // Adiar pelo painel (mantém o histórico de adiamentos).
  if (area === "adiar" && metodo === "POST") {
    const { c, erro } = await corpo(); if (erro) return erro;
    const tipo = c.tipo === "TAREFA" ? "TAREFA" : "AGENDA";
    const r = await adiarItem(env, orgId, tipo, Number(c.id) || 0, c.data, c.hora && /^\d{2}:\d{2}$/.test(c.hora) ? c.hora : null, euP, ms, "painel");
    if (r.erro) return json({ erro: r.erro }, 400);
    await avisarMudanca(env, k, orgId, { ...r.item, data: c.data, prazo: c.data }, "adiado", euP, ms);
    return json({ ok: true });
  }

  // Relatório com filtros (JSON, Excel ou PDF).
  if (area === "relatorio-agenda" && metodo === "GET") {
    const f = Object.fromEntries(["de", "ate", "colaborador", "categoria", "prioridade", "situacao", "tipo", "escopo"].map(n => [n, url.searchParams.get(n) || ""]));
    const r = await relatorioAgenda(env, orgId, f, hoje, admin);
    const moeda = (await env.DB.prepare("SELECT moeda FROM fin_config WHERE org_id=?").bind(orgId).first().catch(() => null))?.moeda || "BRL";
    const formato = url.searchParams.get("formato");
    if (formato === "xlsx") return new Response(xlsxRelatorioAgenda(r, moeda), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="agenda-${r.de}_${r.ate}.xlsx"`, "cache-control": "no-store" } });
    if (formato === "pdf") return new Response(pdfRelatorioAgenda(r, await ajudas.empresa(), moeda, br(hoje)), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="agenda-${r.de}_${r.ate}.pdf"`, "cache-control": "no-store" } });
    return json({ ...r, moeda, categorias: CATEGORIAS_AGENDA, equipe: await ajudas.membros() });
  }

  // WhatsApp da agenda: qual número envia, horários, modelos aprovados e teste.
  if (area === "zap") {
    if (!admin && !(partes[1] === "testar")) return json({ erro: "Só o dono e os administradores configuram o WhatsApp da agenda." }, 403);
    const cfg = await ajudas.config();
    const contaOrg = Number(cfg.zap_org_id) || orgId;
    if (metodo === "GET" && !partes[1]) {
      // Números de WhatsApp que esta pessoa administra (a própria empresa ou outra das suas empresas).
      const opcoes = await q(eu.super_admin ? "SELECT z.org_id, o.nome, z.numero, z.nome_verificado FROM plt_zap_contas z JOIN plt_organizacoes o ON o.id=z.org_id WHERE z.phone_number_id IS NOT NULL AND z.token_cifrado IS NOT NULL AND z.ativo=1 AND o.status='ATIVA'"
        : "SELECT z.org_id, o.nome, z.numero, z.nome_verificado FROM plt_zap_contas z JOIN plt_organizacoes o ON o.id=z.org_id JOIN plt_membros m ON m.org_id=z.org_id AND m.usuario_id=? AND m.papel IN ('OWNER','ADMIN') WHERE z.phone_number_id IS NOT NULL AND z.token_cifrado IS NOT NULL AND z.ativo=1 AND o.status='ATIVA'", ...(eu.super_admin ? [] : [eu.id])).catch(() => []);
      let modelos = null;
      if (k.modelosAgendaZap && opcoes.some(o => o.org_id === contaOrg)) modelos = await k.modelosAgendaZap(contaOrg, false).catch(e => ({ erro: e.message }));
      return json({ conta_org: opcoes.some(o => o.org_id === contaOrg) ? contaOrg : null, opcoes, modelos, config: { hora_resumo: cfg.hora_resumo ?? 8, hora_meio: cfg.hora_meio ?? 12, hora_fim: cfg.hora_fim ?? 18, transferir: cfg.transferir ?? 1, aviso_fin_dias: cfg.aviso_fin_dias ?? 2, relatorio_meio: cfg.relatorio_meio ?? 1, relatorio_fim: cfg.relatorio_fim ?? 1 } });
    }
    if (metodo === "PUT" && !partes[1]) {
      const { c, erro } = await corpo(); if (erro) return erro;
      let zapOrg = c.zap_org_id ? Number(c.zap_org_id) : null;
      if (zapOrg) {
        const ok = eu.super_admin || await env.DB.prepare("SELECT 1 FROM plt_membros WHERE org_id=? AND usuario_id=? AND papel IN ('OWNER','ADMIN')").bind(zapOrg, eu.id).first();
        if (!ok) return json({ erro: "Você precisa ser administrador da empresa dona desse número." }, 403);
        if (zapOrg === orgId) zapOrg = null;
      }
      const n = (v, a, b, p) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(b, Math.max(a, x)) : p; };
      await env.DB.prepare("UPDATE adm_config SET zap_org_id=?, hora_resumo=?, hora_meio=?, hora_fim=?, transferir=?, aviso_fin_dias=?, relatorio_meio=?, relatorio_fim=?, atualizado_ms=? WHERE org_id=?")
        .bind(zapOrg, n(c.hora_resumo, 5, 22, 8), n(c.hora_meio, 10, 16, 12), n(c.hora_fim, 15, 23, 18), c.transferir === false ? 0 : 1, n(c.aviso_fin_dias, 0, 30, 2), c.relatorio_meio === false ? 0 : 1, c.relatorio_fim === false ? 0 : 1, ms, orgId).run();
      return json({ ok: true });
    }
    if (partes[1] === "modelos" && metodo === "POST") {
      if (!k.modelosAgendaZap) return json({ erro: "WhatsApp indisponível." }, 503);
      const r = await k.modelosAgendaZap(contaOrg, true).catch(e => ({ erro: e.message }));
      return r.erro ? json(r, 502) : json(r);
    }
    if (partes[1] === "testar" && metodo === "POST") {
      const p = await env.DB.prepare("SELECT * FROM adm_pessoas WHERE org_id=? AND usuario_id=? AND telefone IS NOT NULL").bind(orgId, eu.id).first();
      if (!p) return json({ erro: "Cadastre primeiro o seu WhatsApp na lista da equipe." }, 400);
      const d = await itensDoDia(env, orgId, hoje, hoje, { pessoaId: eu.id, soMinhas: Boolean(p.so_minhas), fin: admin, finDias: Number(cfg.aviso_fin_dias ?? 2) });
      const moeda = (await env.DB.prepare("SELECT moeda FROM fin_config WHERE org_id=?").bind(orgId).first().catch(() => null))?.moeda || "BRL";
      const via = k.zapEquipe ? await k.zapEquipe(contaOrg, p.telefone, textoDoDiaEquipe(d, { moeda, hoje }), { nome: MODELO_RESUMO, idioma: "pt_BR", params: [`hoje, ${br(hoje)}`, listaCurta(d)] }).catch(() => "") : "";
      if (!via) return json({ erro: "Não consegui enviar. Se você nunca escreveu para este número, mande um “oi” para ele pelo WhatsApp (abre a janela de 24 horas) ou aguarde a Meta aprovar os modelos." }, 502);
      return json({ ok: true, via });
    }
  }

  // Celular (iPhone/Android): calendário pessoal com alertas e alarmes pelo app Atalhos.
  if (area === "celular") {
    if (!eu.id) return json({ erro: "Entre com o seu usuário." }, 401);
    let tk = await env.DB.prepare("SELECT * FROM adm_alarme_tokens WHERE usuario_id=?").bind(eu.id).first();
    if (metodo === "POST") {
      const { c, erro } = await corpo(); if (erro) return erro;
      const novo = !tk || c.novo_link;
      const token = novo ? (k.b64url ? k.b64url(crypto.getRandomValues(new Uint8Array(24))) : [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, "0")).join("")) : tk.token;
      const antecedencia = Math.max(0, Math.min(240, Math.round(Number(c.antecedencia ?? tk?.antecedencia ?? 15)) || 0));
      await env.DB.prepare("INSERT INTO adm_alarme_tokens(usuario_id,token,prio_min,antecedencia,ms) VALUES(?,?,?,?,?) ON CONFLICT(usuario_id) DO UPDATE SET token=excluded.token, prio_min=excluded.prio_min, antecedencia=excluded.antecedencia, ms=excluded.ms")
        .bind(eu.id, token, prioridadeValida(c.prio_min ?? tk?.prio_min, "ALTA"), antecedencia, ms).run();
      tk = await env.DB.prepare("SELECT * FROM adm_alarme_tokens WHERE usuario_id=?").bind(eu.id).first();
    }
    return json(tk ? { ativo: true, ical: `/adm/ical/p/${tk.token}.ics`, alarmes: `/adm/alarmes/${tk.token}.json?novos=1`, alarmes_txt: `/adm/alarmes/${tk.token}.txt?novos=1`, prio_min: tk.prio_min, antecedencia: tk.antecedencia, usado_ms: tk.usado_ms || null } : { ativo: false });
  }
  return null;
}
