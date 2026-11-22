// DENIA Platform — Ordens de serviço (OS) alimentadas pelo atendimento no WhatsApp.
// A IA do atendimento (o motor da Central) já registra cliente, endereço, serviço, profissional, valores combinados
// e comprovantes. Aqui isso vira o cadastro de clientes e de profissionais, a OS de cada atendimento e os
// lançamentos do financeiro (comissão da Central, ou serviço + repasse), mês a mês, sem digitar de novo.
// O que a equipe corrige à mão fica travado: a sincronização nunca sobrescreve uma correção humana.
import { garantirFinanceiro, centavos, dataValida, mesValido, nomeMes, dinheiro } from "./financeiro.js";
import { registrarHistorico } from "./agendaequipe.js";
import { garantirAdmin } from "./administracao.js";
import { gerarXlsx } from "./planilha.js";

const DDL_OS = [
  `CREATE TABLE IF NOT EXISTS os_clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, ext_id INTEGER, nome TEXT, telefone TEXT, bairro TEXT, cidade TEXT, endereco TEXT,
    documento TEXT, email TEXT, obs TEXT, origem TEXT, manual TEXT, primeiro_ms INTEGER, ultimo_ms INTEGER, criado_ms INTEGER, atualizado_ms INTEGER)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS os_clientes_ext ON os_clientes(org_id, ext_id)",
  "CREATE INDEX IF NOT EXISTS os_clientes_tel ON os_clientes(org_id, telefone)",
  `CREATE TABLE IF NOT EXISTS os_profissionais (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, ext_id TEXT, nome TEXT, telefone TEXT, area TEXT, documento TEXT, pix TEXT, email TEXT,
    obs TEXT, manual TEXT, ativo INTEGER NOT NULL DEFAULT 1, criado_ms INTEGER, atualizado_ms INTEGER)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS os_prof_ext ON os_profissionais(org_id, ext_id)",
  `CREATE TABLE IF NOT EXISTS os_ordens (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, caso_id INTEGER, cliente_id INTEGER, profissional_id INTEGER, servico TEXT, descricao TEXT,
    endereco TEXT, bairro TEXT, etapa TEXT, status TEXT NOT NULL DEFAULT 'ABERTA', aberta_ms INTEGER, agendado_txt TEXT, concluida_em TEXT, competencia TEXT,
    valor_cliente_cent INTEGER, valor_prof_cent INTEGER, comissao_cent INTEGER, quem_recebe TEXT NOT NULL DEFAULT 'PROFISSIONAL',
    cliente_pagto TEXT NOT NULL DEFAULT 'PENDENTE', cliente_pago_em TEXT, cliente_forma TEXT, prof_repasse TEXT NOT NULL DEFAULT 'PENDENTE', prof_pago_em TEXT,
    nf_status TEXT NOT NULL DEFAULT 'PENDENTE', nf_numero TEXT, nf_data TEXT, a_caminho_ms INTEGER, manual TEXT, obs TEXT, resumo TEXT, origem TEXT, criado_ms INTEGER, atualizado_ms INTEGER)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS os_ordens_caso ON os_ordens(org_id, caso_id)",
  "CREATE INDEX IF NOT EXISTS os_ordens_comp ON os_ordens(org_id, competencia)",
  `CREATE TABLE IF NOT EXISTS os_anexos (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, os_id INTEGER NOT NULL, tipo TEXT NOT NULL, nome TEXT, mime TEXT, dados TEXT,
    ext_midia INTEGER, origem TEXT, por TEXT, erro TEXT, ms INTEGER)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS os_anexos_ext ON os_anexos(org_id, ext_midia)",
  "CREATE TABLE IF NOT EXISTS os_sync (org_id INTEGER PRIMARY KEY, desde_ms INTEGER NOT NULL DEFAULT 0, clientes_ms INTEGER, ultimo_ms INTEGER, erro TEXT, novas INTEGER)"
];
const prontos = new WeakSet();
export async function garantirOS(env) {
  if (prontos.has(env.DB)) return;
  await garantirFinanceiro(env);
  await garantirAdmin(env); // histórico (adm_historico) e contas
  for (const s of DDL_OS) await env.DB.prepare(s).run();
  prontos.add(env.DB);
}

const re = (s, n = 200) => String(s ?? "").replace(/[\u0000-\u001F]/g, " ").trim().slice(0, n);
const hojeLocal = ms => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
const diaDe = ms => ms ? hojeLocal(ms) : null;
const digitos = s => String(s || "").replace(/\D/g, "");
const br = d => d ? String(d).slice(0, 10).split("-").reverse().join("/") : "—";
const lerJson = (s, p) => { try { return JSON.parse(s || "") ?? p; } catch { return p; } };

export const STATUS_OS = { ABERTA: "Orçamento", AGENDADA: "Agendada", A_CAMINHO: "Técnico a caminho", EM_EXECUCAO: "Em execução", CONCLUIDA: "Concluída", CANCELADA: "Cancelada" };
export const PAGTO = { PENDENTE: "Pendente", A_CONFERIR: "Comprovante recebido (conferir)", PAGO: "Pago", NAO_SE_APLICA: "Não se aplica" };
export const NF = { PENDENTE: "A emitir", EMITIDA: "Emitida", NAO_SE_APLICA: "Não se aplica" };
function statusDaEtapa(etapa, aCaminho) {
  const e = String(etapa || "").toUpperCase();
  if (e === "CONCLUIDO") return "CONCLUIDA";
  if (e === "CANCELADO") return "CANCELADA";
  if (e === "EM_ANDAMENTO") return "EM_EXECUCAO";
  if (e === "AGENDADO") return aCaminho ? "A_CAMINHO" : "AGENDADA";
  return "ABERTA";
}
// Vira OS quando há profissional confirmado ou o atendimento já foi agendado/concluído (pedido só de informação não vira OS).
const ehOrdem = o => (o.consulta && ["CONFIRMADA", "AGUARDANDO_CONFIRMACAO"].includes(o.consulta.status)) || ["AGENDADO", "EM_ANDAMENTO", "CONCLUIDO"].includes(String(o.etapa || "").toUpperCase());

// ---------------------------------------------------------------------------
// Sincronização com o atendimento (a cada 10 minutos e pelo botão)
// ---------------------------------------------------------------------------
export async function sincronizarOS(env, k, orgId, { forcar = false } = {}) {
  await garantirOS(env);
  const ms = k.agora(env);
  const st = (await env.DB.prepare("SELECT * FROM os_sync WHERE org_id=?").bind(orgId).first()) || { desde_ms: 0 };
  if (!forcar && st.ultimo_ms && ms - st.ultimo_ms < 9 * 60000) return { pulou: true };
  let desde = Number(st.desde_ms || 0), novas = 0, atualizadas = 0, anexos = 0;
  try {
    for (let volta = 0; volta < 6; volta++) {
      const r = await k.engine(orgId, "GET", "os", null, { desde_ms: String(desde), limite: "300" });
      if (!r || r.status >= 300 || !r.dados?.sucesso) throw new Error(r?.dados?.erro || (r ? `a IA respondeu ${r.status}` : "a IA desta empresa não está conectada"));
      for (const o of r.dados.os || []) {
        const res = await gravarOrdem(env, k, orgId, o, ms);
        if (res === "nova") novas++; else if (res === "atualizada") atualizadas++;
        anexos += await baixarComprovantes(env, k, orgId, o, ms).catch(() => 0);
      }
      desde = Math.max(desde, Number(r.dados.proximo_ms || desde));
      if (!r.dados.mais) break;
    }
    // A base de clientes inteira (todo mundo que já falou no WhatsApp), uma vez por dia.
    if (forcar || !st.clientes_ms || ms - st.clientes_ms > 20 * 3600000) await importarClientes(env, k, orgId, ms).catch(e => console.error("os clientes", e?.message));
    await env.DB.prepare("INSERT INTO os_sync(org_id,desde_ms,ultimo_ms,erro,novas,clientes_ms) VALUES(?,?,?,NULL,?,?) ON CONFLICT(org_id) DO UPDATE SET desde_ms=excluded.desde_ms, ultimo_ms=excluded.ultimo_ms, erro=NULL, novas=excluded.novas, clientes_ms=COALESCE(excluded.clientes_ms, os_sync.clientes_ms)")
      .bind(orgId, desde, ms, novas, forcar || !st.clientes_ms || ms - st.clientes_ms > 20 * 3600000 ? ms : null).run();
    return { novas, atualizadas, anexos };
  } catch (e) {
    await env.DB.prepare("INSERT INTO os_sync(org_id,desde_ms,ultimo_ms,erro) VALUES(?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET ultimo_ms=excluded.ultimo_ms, erro=excluded.erro").bind(orgId, desde, ms, re(e?.message, 300)).run();
    return { erro: e?.message || String(e) };
  }
}
async function importarClientes(env, k, orgId, ms) {
  const r = await k.engine(orgId, "GET", "clients", null, {});
  if (!r?.dados?.sucesso) return 0;
  let n = 0;
  for (const c of (r.dados.clientes || []).slice(0, 20000)) {
    await env.DB.prepare(`INSERT INTO os_clientes(org_id,ext_id,nome,telefone,bairro,origem,primeiro_ms,ultimo_ms,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,'whatsapp',?,?,?,?)
      ON CONFLICT(org_id, ext_id) DO UPDATE SET nome=CASE WHEN COALESCE(os_clientes.manual,'') LIKE '%nome%' THEN os_clientes.nome ELSE COALESCE(NULLIF(excluded.nome,''), os_clientes.nome) END,
        telefone=excluded.telefone, bairro=CASE WHEN COALESCE(os_clientes.manual,'') LIKE '%bairro%' THEN os_clientes.bairro ELSE COALESCE(NULLIF(excluded.bairro,''), os_clientes.bairro) END,
        primeiro_ms=MIN(COALESCE(os_clientes.primeiro_ms, excluded.primeiro_ms), excluded.primeiro_ms), ultimo_ms=MAX(COALESCE(os_clientes.ultimo_ms,0), COALESCE(excluded.ultimo_ms,0))`)
      .bind(orgId, Number(c.id), re(c.nome, 120) || null, digitos(c.telefone) || null, re(c.bairro, 80) || null, c.primeiro_contato_ms || null, c.ultimo_contato_ms || null, ms, ms).run();
    n++;
  }
  return n;
}
async function gravarCliente(env, orgId, c, ms) {
  if (!c?.id) return null;
  const m = await env.DB.prepare("SELECT id, manual FROM os_clientes WHERE org_id=? AND ext_id=?").bind(orgId, Number(c.id)).first();
  if (!m) {
    const r = await env.DB.prepare("INSERT INTO os_clientes(org_id,ext_id,nome,telefone,bairro,cidade,endereco,origem,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,?,?,'whatsapp',?,?) RETURNING id")
      .bind(orgId, Number(c.id), re(c.nome, 120) || null, digitos(c.telefone) || null, re(c.bairro, 80) || null, re(c.cidade, 80) || null, re(c.endereco, 200) || null, ms, ms).first();
    return r.id;
  }
  const trav = lerJson(m.manual, []);
  const sets = [], args = [];
  for (const [campo, v] of [["nome", re(c.nome, 120)], ["bairro", re(c.bairro, 80)], ["cidade", re(c.cidade, 80)], ["endereco", re(c.endereco, 200)], ["telefone", digitos(c.telefone)]])
    if (v && !trav.includes(campo)) { sets.push(`${campo}=?`); args.push(v); }
  if (sets.length) await env.DB.prepare(`UPDATE os_clientes SET ${sets.join(",")}, atualizado_ms=? WHERE id=?`).bind(...args, ms, m.id).run();
  return m.id;
}
async function gravarProfissional(env, orgId, p, ms) {
  if (!p?.nome && !p?.telefone) return null;
  const ext = String(p.id || "tel:" + digitos(p.telefone));
  const m = await env.DB.prepare("SELECT id, manual FROM os_profissionais WHERE org_id=? AND ext_id=?").bind(orgId, ext).first();
  if (m) {
    const trav = lerJson(m.manual, []);
    if (!trav.includes("nome") && p.nome) await env.DB.prepare("UPDATE os_profissionais SET nome=?, telefone=COALESCE(?, telefone), area=COALESCE(NULLIF(?,''), area), atualizado_ms=? WHERE id=?").bind(re(p.nome, 120), digitos(p.telefone) || null, re(p.area, 40), ms, m.id).run();
    return m.id;
  }
  return (await env.DB.prepare("INSERT INTO os_profissionais(org_id,ext_id,nome,telefone,area,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,?,?) RETURNING id").bind(orgId, ext, re(p.nome, 120) || null, digitos(p.telefone) || null, re(p.area, 40) || null, ms, ms).first()).id;
}
async function gravarOrdem(env, k, orgId, o, ms) {
  const clienteId = await gravarCliente(env, orgId, o.cliente, ms);
  if (!ehOrdem(o)) return "ignorada";
  const profId = o.profissional ? await gravarProfissional(env, orgId, o.profissional, ms) : null;
  const status = statusDaEtapa(o.etapa, o.a_caminho_ms);
  const vc = o.consulta?.valor_cliente ?? null, vp = o.consulta?.valor_prestador ?? null;
  const comissao = vc != null && vp != null && vc >= vp ? vc - vp : null;
  const concluida = status === "CONCLUIDA" ? diaDe(o.atualizado_ms) : null;
  const atual = await env.DB.prepare("SELECT * FROM os_ordens WHERE org_id=? AND caso_id=?").bind(orgId, o.caso_id).first();
  const desc = [o.problema, [o.marca, o.modelo].filter(Boolean).join(" ")].filter(Boolean).join(" — ");
  if (!atual) {
    const r = await env.DB.prepare(`INSERT INTO os_ordens(org_id,caso_id,cliente_id,profissional_id,servico,descricao,endereco,bairro,etapa,status,aberta_ms,agendado_txt,concluida_em,competencia,
        valor_cliente_cent,valor_prof_cent,comissao_cent,a_caminho_ms,resumo,origem,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'whatsapp',?,?) RETURNING id`)
      .bind(orgId, o.caso_id, clienteId, profId, re(o.servico, 120) || null, re(desc, 400) || null, re(o.cliente?.endereco, 200) || null, re(o.cliente?.bairro, 80) || null, o.etapa || null, status,
        o.criado_ms || ms, re(o.consulta?.disponibilidade, 200) || null, concluida, (concluida || diaDe(o.criado_ms || ms)).slice(0, 7), vc, vp, comissao, o.a_caminho_ms || null, re(o.resumo, 600) || null, ms, ms).first();
    await registrarHistorico(env, orgId, "OS", r.id, "criou", `OS ${o.caso_id}`, `Do atendimento no WhatsApp: ${o.servico || "serviço"}${o.cliente?.nome ? " — " + o.cliente.nome : ""}`, "DENIA (atendimento)", ms, "automatico");
    await lancarNoFinanceiro(env, orgId, r.id, ms);
    return "nova";
  }
  // Atualiza só o que a equipe não corrigiu à mão.
  const trav = new Set(lerJson(atual.manual, []));
  const novo = { cliente_id: clienteId, profissional_id: profId, servico: re(o.servico, 120) || null, descricao: re(desc, 400) || null, endereco: re(o.cliente?.endereco, 200) || null, bairro: re(o.cliente?.bairro, 80) || null,
    etapa: o.etapa || null, status, agendado_txt: re(o.consulta?.disponibilidade, 200) || null, concluida_em: concluida, valor_cliente_cent: vc, valor_prof_cent: vp, comissao_cent: comissao, a_caminho_ms: o.a_caminho_ms || null, resumo: re(o.resumo, 600) || null };
  if (novo.concluida_em) novo.competencia = novo.concluida_em.slice(0, 7);
  // Comissão = o que o cliente paga − o que o profissional recebe, com os valores que valem (os corrigidos pela equipe têm prioridade).
  const evc = trav.has("valor_cliente_cent") ? atual.valor_cliente_cent : vc, evp = trav.has("valor_prof_cent") ? atual.valor_prof_cent : vp;
  novo.comissao_cent = evc != null && evp != null && evc >= evp ? evc - evp : null;
  const mudou = Object.entries(novo).filter(([c, v]) => !trav.has(c) && v !== null && v !== undefined && String(atual[c] ?? "") !== String(v));
  if (trav.has("status")) for (let i = mudou.length - 1; i >= 0; i--) if (["concluida_em", "competencia"].includes(mudou[i][0])) mudou.splice(i, 1);
  if (!mudou.length) return "igual";
  await env.DB.prepare(`UPDATE os_ordens SET ${mudou.map(([c]) => c + "=?").join(",")}, atualizado_ms=? WHERE id=?`).bind(...mudou.map(([, v]) => v), ms, atual.id).run();
  const relevantes = mudou.filter(([c]) => ["status", "valor_cliente_cent", "valor_prof_cent", "profissional_id"].includes(c));
  if (relevantes.length) await registrarHistorico(env, orgId, "OS", atual.id, "atualizou", `OS ${o.caso_id}`, relevantes.map(([c, v]) => `${c}: ${atual[c] ?? "—"} → ${v}`).join("; "), "DENIA (atendimento)", ms, "automatico");
  await lancarNoFinanceiro(env, orgId, atual.id, ms);
  return "atualizada";
}
// Comprovante que o cliente mandou no WhatsApp: guarda a imagem na OS e marca "comprovante recebido (conferir)".
async function baixarComprovantes(env, k, orgId, o, ms) {
  let n = 0;
  const os = await env.DB.prepare("SELECT id, cliente_pagto FROM os_ordens WHERE org_id=? AND caso_id=?").bind(orgId, o.caso_id).first();
  if (!os) return 0;
  for (const m of (o.midias || []).filter(x => x.comprovante || x.enviado_para === "FOTO_SERVICO").slice(0, 10)) {
    const ja = await env.DB.prepare("SELECT 1 FROM os_anexos WHERE org_id=? AND ext_midia=?").bind(orgId, m.id).first();
    if (ja) continue;
    const tipo = m.comprovante && m.de === "CLIENTE" ? "COMPROVANTE_CLIENTE" : m.comprovante ? "COMPROVANTE_PROFISSIONAL" : "FOTO_SERVICO";
    const r = await k.engine(orgId, "GET", `os/midia/${m.id}`, null, {}).catch(() => null);
    const ok = r?.dados?.sucesso && r.dados.base64;
    await env.DB.prepare("INSERT OR IGNORE INTO os_anexos(org_id,os_id,tipo,nome,mime,dados,ext_midia,origem,por,erro,ms) VALUES(?,?,?,?,?,?,?,'whatsapp','DENIA (WhatsApp)',?,?)")
      .bind(orgId, os.id, tipo, re(m.legenda || r?.dados?.nome || tipo.toLowerCase(), 120), ok ? r.dados.mime : m.mime || null, ok ? r.dados.base64 : null, m.id, ok ? null : re(r?.dados?.erro || "não foi possível baixar", 200), m.criado_ms || ms).run();
    n++;
    if (tipo === "COMPROVANTE_CLIENTE" && os.cliente_pagto === "PENDENTE") {
      await env.DB.prepare("UPDATE os_ordens SET cliente_pagto='A_CONFERIR', cliente_pago_em=COALESCE(cliente_pago_em, ?), atualizado_ms=? WHERE id=?").bind(diaDe(m.criado_ms || ms), ms, os.id).run();
      await registrarHistorico(env, orgId, "OS", os.id, "comprovante", `OS ${o.caso_id}`, "Cliente mandou o comprovante pelo WhatsApp: marcado para conferir.", "DENIA (WhatsApp)", ms, "automatico");
      os.cliente_pagto = "A_CONFERIR";
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Financeiro: cada OS concluída com valor vira lançamento no mês em que foi concluída (competência).
// - Cliente paga o profissional: a receita da Central é a comissão (cobrada do profissional).
// - Cliente paga a Central: entra o valor do serviço e sai o repasse ao profissional.
// ---------------------------------------------------------------------------
export async function lancarNoFinanceiro(env, orgId, osId, ms) {
  const o = await env.DB.prepare(`SELECT o.*, c.nome AS cliente_nome, p.nome AS prof_nome FROM os_ordens o LEFT JOIN os_clientes c ON c.id=o.cliente_id LEFT JOIN os_profissionais p ON p.id=o.profissional_id WHERE o.id=? AND o.org_id=?`).bind(osId, orgId).first();
  if (!o) return;
  const chaves = [`os:${o.id}:comissao`, `os:${o.id}:servico`, `os:${o.id}:repasse`];
  const fechado = async data => Boolean(await env.DB.prepare("SELECT 1 FROM fin_fechamento WHERE org_id=? AND mes=? AND fechado=1").bind(orgId, String(data).slice(0, 7)).first().catch(() => null));
  const apagar = async ch => { const l = await env.DB.prepare("SELECT id, data, pago_em FROM fin_lanc WHERE org_id=? AND chave_externa=?").bind(orgId, ch).first(); if (l && !(await fechado(l.data)) && !(l.pago_em && await fechado(l.pago_em))) await env.DB.prepare("DELETE FROM fin_lanc WHERE id=?").bind(l.id).run(); };
  const gravar = async (ch, tipo, descricao, valor, categoria, contato, pago, pagoEm) => {
    const l = await env.DB.prepare("SELECT * FROM fin_lanc WHERE org_id=? AND chave_externa=?").bind(orgId, ch).first();
    const data = o.concluida_em || hojeLocal(ms);
    if (l && (await fechado(l.data) || (l.pago_em && await fechado(l.pago_em)))) return; // mês fechado: não mexe
    if (!l) {
      await env.DB.prepare(`INSERT INTO fin_lanc(org_id,tipo,descricao,valor_cent,categoria,data,pago,pago_em,contato,obs,origem,chave_externa,criado_por,criado_ms,atualizado_ms,competencia,confirmado_por,confirmado_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,'os',?,'DENIA (ordem de serviço)',?,?,?,?,?)`).bind(orgId, tipo, descricao, valor, categoria, data, pago ? 1 : 0, pago ? (pagoEm || data) : null, contato || null, `OS ${o.caso_id || "M" + o.id}`, ch, ms, ms, data.slice(0, 7), pago ? "conferido na OS" : null, pago ? ms : null).run();
      return;
    }
    await env.DB.prepare("UPDATE fin_lanc SET descricao=?, valor_cent=?, categoria=COALESCE(categoria, ?), data=?, competencia=?, pago=?, pago_em=?, contato=?, atualizado_ms=? WHERE id=?")
      .bind(descricao, valor, categoria, data, data.slice(0, 7), pago ? 1 : 0, pago ? (pagoEm || l.pago_em || data) : null, contato || null, ms, l.id).run();
  };
  const valido = o.status === "CONCLUIDA" && o.valor_cliente_cent > 0;
  if (!valido) { for (const ch of chaves) await apagar(ch); return; }
  const ref = `OS ${o.caso_id || "M" + o.id} — ${o.servico || "serviço"}${o.cliente_nome ? " — " + o.cliente_nome : ""}`;
  if (o.quem_recebe === "CENTRAL") {
    await apagar(chaves[0]);
    await gravar(chaves[1], "ENTRADA", `Serviço ${ref}`, o.valor_cliente_cent, "Vendas e serviços", o.cliente_nome, o.cliente_pagto === "PAGO", o.cliente_pago_em);
    if (o.valor_prof_cent > 0) await gravar(chaves[2], "SAIDA", `Repasse ao profissional ${o.prof_nome || ""} — ${ref}`.replace(/\s+/g, " "), o.valor_prof_cent, "Repasse a profissionais", o.prof_nome, o.prof_repasse === "PAGO", o.prof_pago_em);
    else await apagar(chaves[2]);
  } else {
    await apagar(chaves[1]); await apagar(chaves[2]);
    if (o.comissao_cent > 0) await gravar(chaves[0], "ENTRADA", `Comissão ${ref}${o.prof_nome ? " (profissional: " + o.prof_nome + ")" : ""}`, o.comissao_cent, "Comissões", o.prof_nome, o.prof_repasse === "PAGO", o.prof_pago_em);
    else await apagar(chaves[0]);
  }
}

// ---------------------------------------------------------------------------
// Resumo do mês (sempre separado por mês) e os 12 meses para os gráficos.
// ---------------------------------------------------------------------------
export async function resumoOS(env, orgId, mes) {
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
  const ordens = await q(`SELECT o.*, c.nome AS cliente_nome, p.nome AS prof_nome FROM os_ordens o LEFT JOIN os_clientes c ON c.id=o.cliente_id LEFT JOIN os_profissionais p ON p.id=o.profissional_id WHERE o.org_id=? AND o.competencia=?`, orgId, mes);
  const conc = ordens.filter(o => o.status === "CONCLUIDA");
  const soma = (l, f) => l.reduce((t, o) => t + (Number(f(o)) || 0), 0);
  const receitaCentral = o => o.quem_recebe === "CENTRAL" ? (o.valor_cliente_cent || 0) - (o.valor_prof_cent || 0) : (o.comissao_cent || 0);
  const agrupar = (f, val = o => o.valor_cliente_cent || 0) => { const m = new Map(); for (const o of conc) { const k0 = f(o) || "—"; const e = m.get(k0) || { nome: k0, os: 0, faturado: 0, receita: 0 }; e.os++; e.faturado += val(o); e.receita += receitaCentral(o); m.set(k0, e); } return [...m.values()].sort((a, b) => b.faturado - a.faturado); };
  const doze = await q(`SELECT competencia mes, COUNT(*) os, SUM(CASE WHEN status='CONCLUIDA' THEN 1 ELSE 0 END) concluidas, SUM(CASE WHEN status='CONCLUIDA' THEN COALESCE(valor_cliente_cent,0) ELSE 0 END) faturado,
      SUM(CASE WHEN status='CONCLUIDA' THEN (CASE WHEN quem_recebe='CENTRAL' THEN COALESCE(valor_cliente_cent,0)-COALESCE(valor_prof_cent,0) ELSE COALESCE(comissao_cent,0) END) ELSE 0 END) receita
    FROM os_ordens WHERE org_id=? AND competencia BETWEEN ? AND ? GROUP BY competencia ORDER BY competencia`, orgId, somarMes(mes, -11), mes);
  return {
    mes, nome: nomeMes(mes),
    totais: {
      os: ordens.length, concluidas: conc.length, canceladas: ordens.filter(o => o.status === "CANCELADA").length, em_aberto: ordens.filter(o => !["CONCLUIDA", "CANCELADA"].includes(o.status)).length,
      faturado_cent: soma(conc, o => o.valor_cliente_cent), pago_profissionais_cent: soma(conc, o => o.valor_prof_cent), receita_central_cent: soma(conc, receitaCentral),
      ticket_medio_cent: conc.length ? Math.round(soma(conc, o => o.valor_cliente_cent) / conc.length) : 0,
      clientes_pendentes: conc.filter(o => o.cliente_pagto !== "PAGO").length, clientes_a_conferir: conc.filter(o => o.cliente_pagto === "A_CONFERIR").length,
      comissoes_a_receber_cent: soma(conc.filter(o => o.quem_recebe !== "CENTRAL" && o.prof_repasse !== "PAGO"), o => o.comissao_cent),
      repasses_a_pagar_cent: soma(conc.filter(o => o.quem_recebe === "CENTRAL" && o.prof_repasse !== "PAGO"), o => o.valor_prof_cent),
      nf_a_emitir: conc.filter(o => o.nf_status === "PENDENTE").length, sem_valor: conc.filter(o => !o.valor_cliente_cent).length
    },
    por_profissional: agrupar(o => o.prof_nome), por_servico: agrupar(o => o.servico), por_bairro: agrupar(o => o.bairro), doze_meses: doze
  };
}
const somarMes = (mes, n) => { const [a, m] = mes.split("-").map(Number); return new Date(Date.UTC(a, m - 1 + n, 1)).toISOString().slice(0, 7); };

// ---------------------------------------------------------------------------
// Rotas: /api/orgs/:id/os/...
// ---------------------------------------------------------------------------
export async function rotasOS(request, env, k, orgId, papel, resto) {
  const { json, lerCorpo, pode, agora } = k;
  await garantirOS(env);
  const url = new URL(request.url), metodo = request.method, partes = resto.split("/").slice(1), ms = agora(env), hoje = hojeLocal(ms);
  const contador = papel === "CONTADOR";
  if (!pode(papel, "AGENTE") && !contador) return json({ erro: "Seu perfil não tem acesso às ordens de serviço." }, 403);
  if (contador && metodo !== "GET") return json({ erro: "O acesso do contador é somente leitura." }, 403);
  const admin = pode(papel, "ADMIN");
  const eu = { id: k.sessao?.usuario?.id || null, nome: k.sessao?.usuario?.nome || k.sessao?.usuario?.email || null };
  const corpo = async () => { const { corpo: c, erro } = await lerCorpo(request, 6_000_000); return erro ? { erro } : { c: c || {} }; };
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
  const area = partes[0], id1 = /^\d+$/.test(partes[1] || "") ? Number(partes[1]) : null;
  const mesPedido = () => mesValido(url.searchParams.get("mes")) ? url.searchParams.get("mes") : hoje.slice(0, 7);

  if (area === "estado" && metodo === "GET") {
    const st = await env.DB.prepare("SELECT * FROM os_sync WHERE org_id=?").bind(orgId).first();
    return json({ conectado: Boolean(await k.engineConectado(orgId)), sync: st || null });
  }
  if (area === "sincronizar" && metodo === "POST") {
    const r = await sincronizarOS(env, k, orgId, { forcar: true });
    return r.erro ? json({ erro: "Não consegui ler o atendimento: " + r.erro }, 502) : json({ ok: true, ...r });
  }
  if (area === "resumo" && metodo === "GET") return json(await resumoOS(env, orgId, mesPedido()));

  // ----- Ordens
  if (area === "ordens" && !id1 && metodo === "GET") {
    const mes = mesPedido(), st = url.searchParams.get("status"), busca = re(url.searchParams.get("q"), 60), fin = url.searchParams.get("financeiro");
    let sql = `SELECT o.id, o.caso_id, o.servico, o.descricao, o.bairro, o.status, o.aberta_ms, o.agendado_txt, o.concluida_em, o.competencia, o.valor_cliente_cent, o.valor_prof_cent, o.comissao_cent, o.quem_recebe,
      o.cliente_pagto, o.prof_repasse, o.nf_status, o.nf_numero, o.a_caminho_ms, o.origem, c.nome AS cliente_nome, c.telefone AS cliente_tel, p.nome AS prof_nome,
      (SELECT COUNT(*) FROM os_anexos a WHERE a.org_id=o.org_id AND a.os_id=o.id) AS anexos FROM os_ordens o LEFT JOIN os_clientes c ON c.id=o.cliente_id LEFT JOIN os_profissionais p ON p.id=o.profissional_id WHERE o.org_id=?`;
    const args = [orgId];
    if (url.searchParams.get("todas") !== "1") { sql += " AND o.competencia=?"; args.push(mes); }
    if (STATUS_OS[st]) { sql += " AND o.status=?"; args.push(st); }
    if (fin === "cliente_pendente") sql += " AND o.status='CONCLUIDA' AND o.cliente_pagto<>'PAGO'";
    if (fin === "conferir") sql += " AND o.cliente_pagto='A_CONFERIR'";
    if (fin === "comissao_pendente") sql += " AND o.status='CONCLUIDA' AND o.prof_repasse<>'PAGO' AND o.prof_repasse<>'NAO_SE_APLICA'";
    if (fin === "nf_pendente") sql += " AND o.status='CONCLUIDA' AND o.nf_status='PENDENTE'";
    if (busca) { sql += " AND (c.nome LIKE ? OR c.telefone LIKE ? OR p.nome LIKE ? OR o.servico LIKE ? OR o.bairro LIKE ? OR CAST(o.caso_id AS TEXT)=?)"; args.push(...Array(5).fill(`%${busca}%`), busca); }
    return json({ ordens: await q(sql + " ORDER BY COALESCE(o.concluida_em, '') DESC, o.aberta_ms DESC LIMIT 1000", ...args), mes });
  }
  if (area === "ordens" && id1 && !partes[2] && metodo === "GET") {
    const o = await env.DB.prepare(`SELECT o.*, c.nome AS cliente_nome, c.telefone AS cliente_tel, c.endereco AS cliente_endereco, c.bairro AS cliente_bairro, p.nome AS prof_nome, p.telefone AS prof_tel, p.area AS prof_area
      FROM os_ordens o LEFT JOIN os_clientes c ON c.id=o.cliente_id LEFT JOIN os_profissionais p ON p.id=o.profissional_id WHERE o.id=? AND o.org_id=?`).bind(id1, orgId).first();
    if (!o) return json({ erro: "OS não encontrada." }, 404);
    const anexos = await q("SELECT id, tipo, nome, mime, origem, por, erro, ms, (dados IS NOT NULL) AS tem FROM os_anexos WHERE org_id=? AND os_id=? ORDER BY id", orgId, id1);
    const historico = await q("SELECT * FROM adm_historico WHERE org_id=? AND tipo='OS' AND item_id=? ORDER BY ms DESC LIMIT 100", orgId, id1).catch(() => []);
    const lancs = admin || contador ? await q("SELECT id, tipo, descricao, valor_cent, data, pago, pago_em, chave_externa FROM fin_lanc WHERE org_id=? AND chave_externa LIKE ?", orgId, `os:${id1}:%`) : [];
    return json({ ordem: { ...o, manual: lerJson(o.manual, []) }, anexos, historico, lancamentos: lancs });
  }
  if (area === "ordens" && !id1 && metodo === "POST") {
    const { c, erro } = await corpo(); if (erro) return erro;
    const v = await validarOrdem(env, orgId, c, {}, ms);
    if (typeof v === "string") return json({ erro: v }, 400);
    const r = await env.DB.prepare(`INSERT INTO os_ordens(org_id,cliente_id,profissional_id,servico,descricao,endereco,bairro,status,aberta_ms,agendado_txt,concluida_em,competencia,valor_cliente_cent,valor_prof_cent,comissao_cent,quem_recebe,
        cliente_pagto,cliente_pago_em,cliente_forma,prof_repasse,prof_pago_em,nf_status,nf_numero,nf_data,obs,origem,manual,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'painel','[]',?,?) RETURNING id`)
      .bind(orgId, v.cliente_id, v.profissional_id, v.servico, v.descricao, v.endereco, v.bairro, v.status, ms, v.agendado_txt, v.concluida_em, v.competencia, v.valor_cliente_cent, v.valor_prof_cent, v.comissao_cent, v.quem_recebe,
        v.cliente_pagto, v.cliente_pago_em, v.cliente_forma, v.prof_repasse, v.prof_pago_em, v.nf_status, v.nf_numero, v.nf_data, v.obs, ms, ms).first();
    await registrarHistorico(env, orgId, "OS", r.id, "criou", `OS manual ${r.id}`, v.servico || "", eu, ms, "painel");
    await lancarNoFinanceiro(env, orgId, r.id, ms);
    return json({ ok: true, id: r.id }, 201);
  }
  if (area === "ordens" && id1 && !partes[2] && metodo === "PUT") {
    const atual = await env.DB.prepare("SELECT * FROM os_ordens WHERE id=? AND org_id=?").bind(id1, orgId).first();
    if (!atual) return json({ erro: "OS não encontrada." }, 404);
    const { c, erro } = await corpo(); if (erro) return erro;
    const financeiros = ["valor_cliente", "valor_prof", "comissao", "quem_recebe", "cliente_pagto", "cliente_pago_em", "cliente_forma", "prof_repasse", "prof_pago_em", "nf_status", "nf_numero", "nf_data"];
    if (!admin && financeiros.some(x => c[x] !== undefined)) return json({ erro: "Valores, pagamentos e nota fiscal só o dono e os administradores alteram." }, 403);
    const v = await validarOrdem(env, orgId, c, atual, ms);
    if (typeof v === "string") return json({ erro: v }, 400);
    const campos = Object.keys(v).filter(x => String(v[x] ?? "") !== String(atual[x] ?? ""));
    if (!campos.length) return json({ ok: true });
    const manual = [...new Set([...lerJson(atual.manual, []), ...campos.filter(x => !["competencia", "comissao_cent"].includes(x))])];
    await env.DB.prepare(`UPDATE os_ordens SET ${campos.map(x => x + "=?").join(",")}, manual=?, atualizado_ms=? WHERE id=?`).bind(...campos.map(x => v[x]), JSON.stringify(manual), ms, id1).run();
    const legivel = x => ({ valor_cliente_cent: "valor do cliente", valor_prof_cent: "valor do profissional", comissao_cent: "comissão", cliente_pagto: "pagamento do cliente", prof_repasse: "acerto com o profissional", nf_status: "nota fiscal" }[x] || x.replace(/_/g, " "));
    await registrarHistorico(env, orgId, "OS", id1, "alterou", `OS ${atual.caso_id || id1}`, campos.map(x => `${legivel(x)}: ${/_cent$/.test(x) ? dinheiro(atual[x] || 0) : atual[x] ?? "—"} → ${/_cent$/.test(x) ? dinheiro(v[x] || 0) : v[x] ?? "—"}`).join("; "), eu, ms, "painel");
    await lancarNoFinanceiro(env, orgId, id1, ms);
    return json({ ok: true });
  }
  if (area === "ordens" && id1 && partes[2] === "a-caminho" && metodo === "POST") {
    const o = await env.DB.prepare("SELECT caso_id FROM os_ordens WHERE id=? AND org_id=?").bind(id1, orgId).first();
    if (!o?.caso_id) return json({ erro: "Esta OS não veio do atendimento no WhatsApp." }, 400);
    const { c } = await corpo();
    const r = await k.engine(orgId, "POST", "os/a-caminho", { caso_id: o.caso_id, previsao: re(c?.previsao, 60), autor: eu.nome }, {});
    if (!r?.dados?.sucesso) return json({ erro: r?.dados?.erro || "Não foi possível avisar o cliente agora." }, 400);
    await env.DB.prepare("UPDATE os_ordens SET a_caminho_ms=?, status=CASE WHEN status='AGENDADA' THEN 'A_CAMINHO' ELSE status END, atualizado_ms=? WHERE id=?").bind(ms, ms, id1).run();
    await registrarHistorico(env, orgId, "OS", id1, "avisou", `OS ${o.caso_id}`, "Cliente avisado: técnico a caminho.", eu, ms, "painel");
    return json({ ok: true, texto: r.dados.texto });
  }
  // Anexos (comprovante, nota fiscal, foto): enviar e baixar.
  if (area === "ordens" && id1 && partes[2] === "anexos" && metodo === "POST") {
    const o = await env.DB.prepare("SELECT id FROM os_ordens WHERE id=? AND org_id=?").bind(id1, orgId).first();
    if (!o) return json({ erro: "OS não encontrada." }, 404);
    const { c, erro } = await corpo(); if (erro) return erro;
    const dados = String(c.base64 || "").replace(/^data:[^,]+,/, "");
    if (!dados || dados.length > 5_600_000) return json({ erro: "Arquivo vazio ou maior que 4 MB." }, 400);
    const tipo = ["COMPROVANTE_CLIENTE", "COMPROVANTE_PROFISSIONAL", "NOTA_FISCAL", "FOTO_SERVICO", "OUTRO"].includes(c.tipo) ? c.tipo : "OUTRO";
    await env.DB.prepare("INSERT INTO os_anexos(org_id,os_id,tipo,nome,mime,dados,origem,por,ms) VALUES(?,?,?,?,?,?,'painel',?,?)").bind(orgId, id1, tipo, re(c.nome, 120) || tipo.toLowerCase(), re(c.mime, 80) || "application/octet-stream", dados, eu.nome, ms).run();
    await registrarHistorico(env, orgId, "OS", id1, "anexou", `OS ${id1}`, `${tipo.toLowerCase().replace(/_/g, " ")}: ${re(c.nome, 80)}`, eu, ms, "painel");
    return json({ ok: true }, 201);
  }
  if (area === "anexos" && id1 && metodo === "GET") {
    const a = await env.DB.prepare("SELECT * FROM os_anexos WHERE id=? AND org_id=?").bind(id1, orgId).first();
    if (!a?.dados) return json({ erro: a?.erro || "Arquivo não encontrado." }, 404);
    const bin = Uint8Array.from(atob(a.dados), ch => ch.charCodeAt(0));
    return new Response(bin, { headers: { "content-type": a.mime || "application/octet-stream", "content-disposition": `inline; filename="${(a.nome || "anexo").replace(/[^\w.-]+/g, "_")}"`, "cache-control": "private, no-store" } });
  }

  // ----- Cadastros: clientes e profissionais
  if (area === "clientes" && !id1 && metodo === "GET") {
    const busca = re(url.searchParams.get("q"), 60);
    const args = [orgId]; let filtro = "";
    if (busca) { filtro = " AND (c.nome LIKE ? OR c.telefone LIKE ? OR c.bairro LIKE ? OR c.endereco LIKE ?)"; args.push(...Array(4).fill(`%${busca}%`)); }
    const lista = await q(`SELECT c.*, (SELECT COUNT(*) FROM os_ordens o WHERE o.org_id=c.org_id AND o.cliente_id=c.id) AS ordens,
      (SELECT COALESCE(SUM(valor_cliente_cent),0) FROM os_ordens o WHERE o.org_id=c.org_id AND o.cliente_id=c.id AND o.status='CONCLUIDA') AS total_cent,
      (SELECT MAX(COALESCE(concluida_em,'')) FROM os_ordens o WHERE o.org_id=c.org_id AND o.cliente_id=c.id) AS ultima_os FROM os_clientes c WHERE c.org_id=?${filtro} ORDER BY COALESCE(c.ultimo_ms, c.atualizado_ms) DESC LIMIT 2000`, ...args);
    const total = await env.DB.prepare("SELECT COUNT(*) n FROM os_clientes WHERE org_id=?").bind(orgId).first();
    return json({ clientes: lista, total: total?.n || 0 });
  }
  if (area === "clientes" && !id1 && metodo === "POST") {
    const { c, erro } = await corpo(); if (erro) return erro;
    if (!re(c.nome)) return json({ erro: "Escreva o nome do cliente." }, 400);
    const r = await env.DB.prepare("INSERT INTO os_clientes(org_id,nome,telefone,bairro,cidade,endereco,documento,email,obs,origem,manual,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,?,?,?,?,'painel','[\"nome\",\"telefone\",\"bairro\",\"cidade\",\"endereco\"]',?,?) RETURNING id")
      .bind(orgId, re(c.nome, 120), digitos(c.telefone) || null, re(c.bairro, 80) || null, re(c.cidade, 80) || null, re(c.endereco, 200) || null, re(c.documento, 30) || null, re(c.email, 120) || null, re(c.obs, 500) || null, ms, ms).first();
    return json({ ok: true, id: r.id }, 201);
  }
  if (area === "clientes" && id1 && metodo === "PUT") {
    const a = await env.DB.prepare("SELECT * FROM os_clientes WHERE id=? AND org_id=?").bind(id1, orgId).first();
    if (!a) return json({ erro: "Cliente não encontrado." }, 404);
    const { c, erro } = await corpo(); if (erro) return erro;
    const campos = ["nome", "telefone", "bairro", "cidade", "endereco", "documento", "email", "obs"].filter(x => c[x] !== undefined);
    const val = x => x === "telefone" ? digitos(c[x]) || null : re(c[x], x === "endereco" || x === "obs" ? 500 : 120) || null;
    if (campos.length) await env.DB.prepare(`UPDATE os_clientes SET ${campos.map(x => x + "=?").join(",")}, manual=?, atualizado_ms=? WHERE id=?`).bind(...campos.map(val), JSON.stringify([...new Set([...lerJson(a.manual, []), ...campos])]), ms, id1).run();
    return json({ ok: true });
  }
  if (area === "profissionais" && !id1 && metodo === "GET") {
    const mes = mesPedido();
    return json({ profissionais: await q(`SELECT p.*, (SELECT COUNT(*) FROM os_ordens o WHERE o.org_id=p.org_id AND o.profissional_id=p.id AND o.status='CONCLUIDA') AS concluidas,
      (SELECT COALESCE(SUM(comissao_cent),0) FROM os_ordens o WHERE o.org_id=p.org_id AND o.profissional_id=p.id AND o.status='CONCLUIDA' AND o.quem_recebe<>'CENTRAL' AND o.prof_repasse<>'PAGO') AS comissao_pendente_cent,
      (SELECT COALESCE(SUM(valor_cliente_cent),0) FROM os_ordens o WHERE o.org_id=p.org_id AND o.profissional_id=p.id AND o.status='CONCLUIDA' AND o.competencia=?) AS faturado_mes_cent
      FROM os_profissionais p WHERE p.org_id=? ORDER BY p.nome LIMIT 1000`, mes, orgId), mes });
  }
  if (area === "profissionais" && id1 && metodo === "PUT") {
    if (!admin) return json({ erro: "Só o dono e os administradores alteram o cadastro dos profissionais." }, 403);
    const a = await env.DB.prepare("SELECT * FROM os_profissionais WHERE id=? AND org_id=?").bind(id1, orgId).first();
    if (!a) return json({ erro: "Profissional não encontrado." }, 404);
    const { c, erro } = await corpo(); if (erro) return erro;
    const campos = ["nome", "telefone", "area", "documento", "pix", "email", "obs"].filter(x => c[x] !== undefined);
    if (campos.length) await env.DB.prepare(`UPDATE os_profissionais SET ${campos.map(x => x + "=?").join(",")}, manual=?, atualizado_ms=? WHERE id=?`).bind(...campos.map(x => x === "telefone" ? digitos(c[x]) || null : re(c[x], 200) || null), JSON.stringify([...new Set([...lerJson(a.manual, []), ...campos])]), ms, id1).run();
    return json({ ok: true });
  }

  // ----- Planilha do mês (para o contador): OS, clientes que pagaram, comissões, notas fiscais.
  if (area === "exportar" && metodo === "GET") {
    const mes = mesPedido();
    const lista = await q(`SELECT o.*, c.nome AS cliente_nome, c.telefone AS cliente_tel, p.nome AS prof_nome, p.documento AS prof_doc FROM os_ordens o LEFT JOIN os_clientes c ON c.id=o.cliente_id LEFT JOIN os_profissionais p ON p.id=o.profissional_id WHERE o.org_id=? AND o.competencia=? ORDER BY o.concluida_em, o.id`, orgId, mes);
    const v = c => c == null ? "" : c / 100;
    const r = await resumoOS(env, orgId, mes);
    const xlsx = gerarXlsx([
      { nome: "Ordens", linhas: [["OS", "Aberta em", "Concluída em", "Situação", "Cliente", "Telefone", "Bairro", "Serviço", "Profissional", "CPF/CNPJ do profissional", "Valor do cliente", "Valor do profissional", "Receita da Central", "Quem recebeu do cliente", "Pagamento do cliente", "Pago em", "Acerto com o profissional", "Acertado em", "Nota fiscal", "Nº da NF", "Data da NF"],
        ...lista.map(o => [o.caso_id || o.id, br(diaDe(o.aberta_ms)), br(o.concluida_em), STATUS_OS[o.status] || o.status, o.cliente_nome || "", o.cliente_tel || "", o.bairro || "", o.servico || "", o.prof_nome || "", o.prof_doc || "", v(o.valor_cliente_cent), v(o.valor_prof_cent),
          v(o.quem_recebe === "CENTRAL" ? (o.valor_cliente_cent || 0) - (o.valor_prof_cent || 0) : o.comissao_cent), o.quem_recebe === "CENTRAL" ? "Central" : "Profissional", PAGTO[o.cliente_pagto] || o.cliente_pagto, br(o.cliente_pago_em), PAGTO[o.prof_repasse] || o.prof_repasse, br(o.prof_pago_em), NF[o.nf_status] || o.nf_status, o.nf_numero || "", br(o.nf_data)])],
        larguras: [8, 11, 11, 16, 26, 15, 18, 26, 22, 18, 13, 13, 13, 14, 22, 11, 22, 11, 11, 11, 11] },
      { nome: "Resumo", linhas: [["Mês", r.nome], ["OS no mês", r.totais.os], ["Concluídas", r.totais.concluidas], ["Faturado (clientes)", v(r.totais.faturado_cent)], ["Pago aos profissionais", v(r.totais.pago_profissionais_cent)], ["Receita da Central", v(r.totais.receita_central_cent)], ["Ticket médio", v(r.totais.ticket_medio_cent)], ["Comissões a receber", v(r.totais.comissoes_a_receber_cent)], ["Notas fiscais a emitir", r.totais.nf_a_emitir]], larguras: [28, 22] },
      { nome: "Por profissional", linhas: [["Profissional", "OS concluídas", "Faturado", "Receita da Central"], ...r.por_profissional.map(x => [x.nome, x.os, v(x.faturado), v(x.receita)])], larguras: [30, 14, 14, 18] }
    ]);
    return new Response(xlsx, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="ordens-de-servico-${mes}.xlsx"`, "cache-control": "no-store" } });
  }
  return json({ erro: "Rota não encontrada." }, 404);
}

async function validarOrdem(env, orgId, c, atual, ms) {
  const v = {};
  const texto = (campo, n) => { if (c[campo] !== undefined) v[campo] = re(c[campo], n) || null; };
  texto("servico", 120); texto("descricao", 400); texto("endereco", 200); texto("bairro", 80); texto("agendado_txt", 200); texto("obs", 800); texto("nf_numero", 40); texto("cliente_forma", 40);
  if (c.cliente_id !== undefined) { const n = Number(c.cliente_id) || null; if (n && !(await env.DB.prepare("SELECT 1 FROM os_clientes WHERE id=? AND org_id=?").bind(n, orgId).first())) return "Cliente inválido."; v.cliente_id = n; }
  if (c.profissional_id !== undefined) { const n = Number(c.profissional_id) || null; if (n && !(await env.DB.prepare("SELECT 1 FROM os_profissionais WHERE id=? AND org_id=?").bind(n, orgId).first())) return "Profissional inválido."; v.profissional_id = n; }
  if (c.status !== undefined) { if (!STATUS_OS[c.status]) return "Situação inválida."; v.status = c.status; }
  for (const [campo, col] of [["valor_cliente", "valor_cliente_cent"], ["valor_prof", "valor_prof_cent"], ["comissao", "comissao_cent"]]) if (c[campo] !== undefined) {
    if (c[campo] === "" || c[campo] === null) { v[col] = null; continue; }
    const n = centavos(c[campo]); if (n === null || n < 0) return "Valor inválido."; v[col] = n;
  }
  if (c.quem_recebe !== undefined) v.quem_recebe = c.quem_recebe === "CENTRAL" ? "CENTRAL" : "PROFISSIONAL";
  if (c.cliente_pagto !== undefined) { if (!PAGTO[c.cliente_pagto]) return "Situação do pagamento inválida."; v.cliente_pagto = c.cliente_pagto; }
  if (c.prof_repasse !== undefined) { if (!PAGTO[c.prof_repasse]) return "Situação do acerto inválida."; v.prof_repasse = c.prof_repasse; }
  if (c.nf_status !== undefined) { if (!NF[c.nf_status]) return "Situação da nota fiscal inválida."; v.nf_status = c.nf_status; }
  for (const d of ["cliente_pago_em", "prof_pago_em", "nf_data", "concluida_em"]) if (c[d] !== undefined) { if (c[d] && !dataValida(c[d])) return "Data inválida."; v[d] = c[d] || null; }
  const fim = { ...atual, ...v };
  // Comissão: se não foi informada, é a diferença entre o que o cliente paga e o que o profissional recebe.
  if (c.comissao === undefined && (v.valor_cliente_cent !== undefined || v.valor_prof_cent !== undefined)) v.comissao_cent = fim.valor_cliente_cent != null && fim.valor_prof_cent != null && fim.valor_cliente_cent >= fim.valor_prof_cent ? fim.valor_cliente_cent - fim.valor_prof_cent : fim.comissao_cent ?? null;
  if (fim.status === "CONCLUIDA" && !fim.concluida_em) v.concluida_em = hojeLocal(ms);
  if ((v.status && v.status !== "CONCLUIDA") || (fim.status !== "CONCLUIDA" && c.concluida_em === undefined && atual.concluida_em)) v.concluida_em = null;
  const conc = v.concluida_em !== undefined ? v.concluida_em : fim.concluida_em;
  v.competencia = (conc || diaDe(fim.aberta_ms || ms)).slice(0, 7);
  if (v.cliente_pagto === "PAGO" && !fim.cliente_pago_em && c.cliente_pago_em === undefined) v.cliente_pago_em = hojeLocal(ms);
  if (v.prof_repasse === "PAGO" && !fim.prof_pago_em && c.prof_pago_em === undefined) v.prof_pago_em = hojeLocal(ms);
  if (v.nf_status === "EMITIDA" && !fim.nf_data && c.nf_data === undefined) v.nf_data = hojeLocal(ms);
  if (!atual.id) { // nova OS pelo painel: valores padrão
    v.status = v.status || "ABERTA"; v.quem_recebe = v.quem_recebe || "PROFISSIONAL"; v.cliente_pagto = v.cliente_pagto || "PENDENTE"; v.prof_repasse = v.prof_repasse || "PENDENTE"; v.nf_status = v.nf_status || "PENDENTE";
    for (const x of ["cliente_id", "profissional_id", "servico", "descricao", "endereco", "bairro", "agendado_txt", "concluida_em", "valor_cliente_cent", "valor_prof_cent", "comissao_cent", "cliente_pago_em", "cliente_forma", "prof_pago_em", "nf_numero", "nf_data", "obs"]) if (v[x] === undefined) v[x] = null;
    if (!v.servico) return "Escreva o serviço.";
  }
  return v;
}

// Cron: sincroniza as empresas que têm o atendimento da DENIA ligado.
export async function osDoCron(env, k) {
  await garantirOS(env);
  const orgs = (await env.DB.prepare("SELECT id FROM plt_organizacoes WHERE status='ATIVA' ORDER BY id LIMIT 50").all()).results || [];
  const out = {};
  for (const o of orgs) if (await k.engineConectado(o.id)) out[o.id] = await sincronizarOS(env, k, o.id).catch(e => ({ erro: e?.message }));
  return out;
}
