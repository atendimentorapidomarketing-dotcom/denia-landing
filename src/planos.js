// DENIA Platform — Planos, teste grátis de 7 dias, cortesia, liberação de recursos por plano e cobrança.
// Cobrança pelo Asaas (Pix, boleto e cartão de crédito; a nota fiscal de serviço pode sair automática
// pelo próprio Asaas). Sem fidelidade: cancela quando quiser e usa até o fim do período pago.
// Os valores ficam editáveis pelo administrador geral (plt_meta 'planos_config').

export const RECURSOS = {
  chatbot: "Chatbot do WhatsApp com botões e listas",
  chatbot_ia: "IA no chatbot (responde o que o cliente escrever)",
  ia_completa: "IA completa de atendimento (atende como uma pessoa, com memória)",
  marketing: "Instagram, Facebook e Google: posts, artes, comentários e avaliações",
  voz: "DENIA por voz, ao vivo",
  multiempresa: "Várias empresas, marcas e unidades",
  temporada: "Locação por temporada (Airbnb, Booking e Vrbo)"
};
export const PLANOS_PADRAO = {
  essencial: { nome: "Essencial", mensal: 149, desc: "Chatbot de botões com IA para dúvidas.", recursos: ["chatbot", "chatbot_ia"], limites: { usuarios: 2, ia_mes: 1000 } },
  start: { nome: "Start", mensal: 690, desc: "Atendimento com IA completa no WhatsApp.", recursos: ["chatbot", "chatbot_ia", "ia_completa"], limites: { usuarios: 5, ia_mes: 3000 } },
  pro: { nome: "Pro", mensal: 1290, desc: "Para operar com uma rede de profissionais.", recursos: ["chatbot", "chatbot_ia", "ia_completa"], limites: { usuarios: 10, ia_mes: 6000 } },
  growth: { nome: "Growth", mensal: 1890, desc: "Atendimento, redes sociais e Google.", recursos: ["chatbot", "chatbot_ia", "ia_completa", "marketing", "voz"], limites: { usuarios: 20, ia_mes: 12000 } },
  elite: { nome: "Elite", mensal: 2990, desc: "Para operações com várias frentes.", recursos: ["chatbot", "chatbot_ia", "ia_completa", "marketing", "voz", "multiempresa"], limites: { usuarios: 50, ia_mes: 30000 } }
};
export const TESTE_DIAS = 7;
const CARENCIA_MS = 3 * 86400000; // depois do vencimento, 3 dias para pagar sem perder o acesso
const DIA = 86400000;
export const STATUS = ["TESTE", "ATIVO", "ATRASADO", "CANCELADO", "CORTESIA", "BLOQUEADO"];

export async function lerPlanos(env) {
  let c = {};
  try { c = JSON.parse((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='planos_config'").first().catch(() => null))?.valor || "{}") || {}; } catch { c = {}; }
  const desconto = Number.isFinite(Number(c.desconto_anual)) ? Math.max(0, Math.min(0.5, Number(c.desconto_anual))) : 0.2;
  const planos = {};
  for (const [id, p] of Object.entries(PLANOS_PADRAO)) {
    const o = c.planos?.[id] || {};
    const mensal = Number(o.mensal) > 0 ? Math.round(Number(o.mensal) * 100) / 100 : p.mensal;
    planos[id] = { id, ...p, mensal, anual: Number(o.anual) > 0 ? Number(o.anual) : Math.round(mensal * 12 * (1 - desconto)), visivel: o.visivel !== false, limites: { ...p.limites, ...(o.limites || {}) } };
  }
  return { planos, desconto_anual: desconto };
}

// O que a empresa pode usar agora.
export function acessoDa(o, agora, planos) {
  const plano = planos[o?.plano] ? o.plano : "start";
  const p = planos[plano];
  const st = STATUS.includes(o?.plano_status) ? o.plano_status : "TESTE";
  if (st === "CORTESIA") return { plano, nome: p.nome, status: st, liberado: true, cortesia: true, recursos: Object.keys(RECURSOS), limites: { usuarios: 9999, ia_mes: 1e9 }, ate: null, dias: null };
  let ate = null, liberado = false;
  if (st === "TESTE") { ate = Number(o.teste_ate || 0); liberado = agora < ate; }
  else if (st === "BLOQUEADO") liberado = false;
  else { ate = Number(o.pago_ate || 0); liberado = agora < ate + CARENCIA_MS; }
  const dias = ate ? Math.max(0, Math.ceil((ate - agora) / DIA)) : null;
  const situacao = liberado ? (st === "ATIVO" && agora >= ate ? "ATRASADO" : st) : st === "TESTE" ? "TESTE_ACABOU" : "BLOQUEADO";
  return { plano, nome: p.nome, status: situacao, liberado, cortesia: false, recursos: liberado ? p.recursos : [], limites: p.limites, ate, dias, ciclo: o.ciclo || null, assinatura: Boolean(o.assinatura_id) };
}
export async function acessoOrg(env, orgId, agora) {
  const o = await env.DB.prepare("SELECT * FROM plt_organizacoes WHERE id=?").bind(orgId).first();
  if (!o) return null;
  return acessoDa(o, agora, (await lerPlanos(env)).planos);
}
// Qual recurso cada área do painel exige (null = livre para todas as empresas).
export function recursoDaRota(resto, metodo) {
  if (/^(plano|membros|auditoria)(\/|$)/.test(resto) || resto === "ia/chave" && metodo === "GET") return "LIVRE";
  if (resto.startsWith("engine/") || (resto === "integracao" && metodo === "POST")) return "ia_completa";
  if (resto === "zap" || resto.startsWith("zap/")) return "chatbot";
  if (resto.startsWith("mk/voz") || resto.startsWith("assistente/ao-vivo")) return "voz";
  if (resto.startsWith("mk/uso")) return null;
  if (resto.startsWith("mk/")) return "marketing";
  return null;
}
export function planoMinimo(recurso, planos) {
  const p = Object.values(planos).filter(x => x.recursos.includes(recurso)).sort((a, b) => a.mensal - b.mensal)[0];
  return p ? { id: p.id, nome: p.nome } : null;
}

// ---------------------------------------------------------------------------
// Asaas (Pix, boleto e cartão). Variáveis: ASAAS_API_KEY, ASAAS_SANDBOX=1 (testes), ASAAS_WEBHOOK_TOKEN.
// ---------------------------------------------------------------------------

function asaasBase(env) { return String(env.ASAAS_SANDBOX || "") === "1" ? "https://api-sandbox.asaas.com/v3" : "https://api.asaas.com/v3"; }
export function cobrancaConfigurada(env) { return Boolean(String(env.ASAAS_API_KEY || "").trim()); }
async function asaas(env, metodo, caminho, corpo) {
  const r = await fetch(asaasBase(env) + caminho, {
    method: metodo, headers: { access_token: String(env.ASAAS_API_KEY).trim(), "content-type": "application/json", "user-agent": "DENIA Platform" },
    body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(20000)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d?.errors || []).map(e => e.description).join(" ") || `Asaas HTTP ${r.status}`);
  return d;
}
function digitos(s) { return String(s || "").replace(/\D/g, ""); }
export function documentoValido(doc) {
  const d = digitos(doc);
  if (d.length === 11) {
    if (/^(\d)\1+$/.test(d)) return false;
    const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
  }
  if (d.length === 14) {
    if (/^(\d)\1+$/.test(d)) return false;
    const dv = n => { const p = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * p[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
    return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
  }
  return false;
}
const isoBR = ms => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
function somarCiclo(iso, ciclo) {
  const d = new Date(iso + "T12:00:00Z");
  if (ciclo === "ANUAL") d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1);
  return Date.parse(d.toISOString().slice(0, 10) + "T23:59:59-03:00");
}

// ---------------------------------------------------------------------------
// Rotas da empresa: /api/orgs/:id/plano...
// ---------------------------------------------------------------------------

export async function rotasPlano(request, env, k, orgId, papel, resto) {
  if (resto !== "plano" && !resto.startsWith("plano/")) return null;
  const { json, lerCorpo, pode, auditar, sessao, agora } = k;
  const metodo = request.method;
  const t = agora(env);
  const { planos, desconto_anual } = await lerPlanos(env);
  const o = await env.DB.prepare("SELECT * FROM plt_organizacoes WHERE id=?").bind(orgId).first();
  if (resto === "plano" && metodo === "GET") {
    const pag = (await env.DB.prepare("SELECT id, valor, status, vencimento, pago_ms, link, forma FROM plt_pagamentos WHERE org_id=? ORDER BY id DESC LIMIT 24").bind(orgId).all().catch(() => null))?.results || [];
    const usuarios = Number((await env.DB.prepare("SELECT COUNT(*) n FROM plt_membros WHERE org_id=?").bind(orgId).first())?.n || 0);
    return json({ acesso: acessoDa(o, t, planos), planos: Object.values(planos).filter(p => p.visivel || p.id === o.plano), recursos: RECURSOS, desconto_anual, cobranca: cobrancaConfigurada(env), pagamentos: pag, uso: { usuarios }, pode_assinar: pode(papel, "ADMIN") });
  }
  if (!pode(papel, "ADMIN")) return json({ erro: "Somente o proprietário ou um administrador cuida do plano." }, 403);
  if (resto === "plano/assinar" && metodo === "POST") {
    const { corpo, erro } = await lerCorpo(request, 4000);
    if (erro) return erro;
    const plano = planos[corpo.plano] ? corpo.plano : null;
    const ciclo = corpo.ciclo === "ANUAL" ? "ANUAL" : "MENSAL";
    if (!plano) return json({ erro: "Escolha um plano." }, 400);
    if (!cobrancaConfigurada(env)) return json({ erro: "O pagamento on-line ainda está sendo ativado. Fale com a equipe DENIA para assinar.", codigo: "SEM_COBRANCA" }, 503);
    const doc = digitos(corpo.documento), nome = k.txt(corpo.nome, 120), email = String(corpo.email || "").trim().toLowerCase().slice(0, 200);
    if (!documentoValido(doc)) return json({ erro: "Informe um CPF ou CNPJ válido (vai na nota fiscal)." }, 400);
    if (nome.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ erro: "Informe o nome (ou razão social) e o e-mail para a cobrança." }, 400);
    const valor = ciclo === "ANUAL" ? planos[plano].anual : planos[plano].mensal;
    try {
      let cliente = o.cobranca_cliente;
      if (!cliente) cliente = (await asaas(env, "POST", "/customers", { name: nome, cpfCnpj: doc, email, mobilePhone: digitos(corpo.telefone) || undefined, externalReference: "org:" + orgId })).id;
      else await asaas(env, "POST", "/customers/" + cliente, { name: nome, cpfCnpj: doc, email }).catch(() => {});
      if (o.assinatura_id) await asaas(env, "DELETE", "/subscriptions/" + o.assinatura_id).catch(() => {});
      // O primeiro vencimento respeita o teste grátis e o período já pago (ninguém perde dias).
      const inicio = Math.max(t, o.plano_status === "TESTE" ? Number(o.teste_ate || 0) : 0, ["ATIVO", "CANCELADO"].includes(o.plano_status) ? Number(o.pago_ate || 0) : 0);
      const ass = await asaas(env, "POST", "/subscriptions", { customer: cliente, billingType: "UNDEFINED", value: valor, nextDueDate: isoBR(inicio), cycle: ciclo === "ANUAL" ? "YEARLY" : "MONTHLY", description: `DENIA — plano ${planos[plano].nome} (${ciclo === "ANUAL" ? "anual" : "mensal"}) — ${o.nome}`, externalReference: `org:${orgId}:${plano}:${ciclo}` });
      const pags = await asaas(env, "GET", `/subscriptions/${ass.id}/payments`);
      const primeira = (pags.data || [])[0];
      await env.DB.prepare("UPDATE plt_organizacoes SET cobranca_cliente=?, assinatura_id=?, assinatura_plano=?, ciclo=?, plano=CASE WHEN plano_status='TESTE' THEN ? ELSE plano END WHERE id=?").bind(cliente, ass.id, plano, ciclo, plano, orgId).run();
      if (primeira) await registrarPagamento(env, orgId, primeira);
      await auditar(env, request, sessao, orgId, "PLANO", `Assinatura criada: ${planos[plano].nome} ${ciclo === "ANUAL" ? "anual" : "mensal"} (R$ ${valor})`);
      return json({ ok: true, link: primeira?.invoiceUrl || null, vencimento: primeira?.dueDate || isoBR(inicio) });
    } catch (e) { return json({ erro: "Não foi possível criar a cobrança: " + e.message }, 502); }
  }
  if (resto === "plano/cancelar" && metodo === "POST") {
    if (o.assinatura_id && cobrancaConfigurada(env)) await asaas(env, "DELETE", "/subscriptions/" + o.assinatura_id).catch(() => {});
    if (o.plano_status !== "CORTESIA") await env.DB.prepare("UPDATE plt_organizacoes SET plano_status=CASE WHEN plano_status='TESTE' THEN 'TESTE' ELSE 'CANCELADO' END, assinatura_id=NULL WHERE id=?").bind(orgId).run();
    await auditar(env, request, sessao, orgId, "PLANO", "Assinatura cancelada (usa até o fim do período pago)");
    return json({ ok: true });
  }
  return json({ erro: "Rota não encontrada." }, 404);
}

async function registrarPagamento(env, orgId, p) {
  await env.DB.prepare(`INSERT INTO plt_pagamentos(org_id,gateway_id,valor,status,vencimento,pago_ms,link,forma,criado_ms) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(gateway_id) DO UPDATE SET status=excluded.status, pago_ms=COALESCE(excluded.pago_ms,pago_ms), link=COALESCE(excluded.link,link), forma=COALESCE(excluded.forma,forma), valor=excluded.valor, vencimento=excluded.vencimento`)
    .bind(orgId, String(p.id), Number(p.value || 0), String(p.status || ""), String(p.dueDate || ""), p.paymentDate || p.clientPaymentDate ? Date.parse((p.paymentDate || p.clientPaymentDate) + "T12:00:00-03:00") : null, p.invoiceUrl || null, p.billingType || null, Date.now()).run();
}

// Avisos do Asaas: pagamento confirmado libera; vencido entra em carência; estorno bloqueia.
export async function webhookAsaas(request, env, k) {
  const token = String(env.ASAAS_WEBHOOK_TOKEN || "");
  if (token.length < 16 || !iguais(String(request.headers.get("asaas-access-token") || ""), token)) return new Response("Não autorizado.", { status: 401 });
  let d;
  try { d = await request.json(); } catch { return new Response("JSON inválido.", { status: 400 }); }
  const p = d?.payment;
  if (!p?.subscription && !p?.externalReference) return new Response("ok");
  let o = p.subscription ? await env.DB.prepare("SELECT * FROM plt_organizacoes WHERE assinatura_id=?").bind(p.subscription).first() : null;
  const ref = String(p.externalReference || "").match(/^org:(\d+)(?::(\w+):(MENSAL|ANUAL))?/);
  if (!o && ref) o = await env.DB.prepare("SELECT * FROM plt_organizacoes WHERE id=?").bind(Number(ref[1])).first();
  if (!o) return new Response("ok");
  await registrarPagamento(env, o.id, p);
  const ev = String(d.event || "");
  const { planos } = await lerPlanos(env);
  if (["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"].includes(ev)) {
    const ciclo = ref?.[3] || o.ciclo || "MENSAL";
    const plano = planos[ref?.[2]] ? ref[2] : planos[o.assinatura_plano] ? o.assinatura_plano : o.plano;
    const ate = Math.max(Number(o.pago_ate || 0), somarCiclo(String(p.dueDate || isoBR(Date.now())), ciclo));
    await env.DB.prepare("UPDATE plt_organizacoes SET plano=?, ciclo=?, pago_ate=?, plano_status=CASE WHEN plano_status='CORTESIA' THEN 'CORTESIA' ELSE 'ATIVO' END WHERE id=?").bind(plano, ciclo, ate, o.id).run();
    await k.auditar(env, request, null, o.id, "PLANO", `Pagamento confirmado: R$ ${p.value} (${p.billingType || "—"}) — ${planos[plano]?.nome || plano} até ${isoBR(ate)}`);
  } else if (ev === "PAYMENT_OVERDUE") {
    await env.DB.prepare("UPDATE plt_organizacoes SET plano_status='ATRASADO' WHERE id=? AND plano_status='ATIVO'").bind(o.id).run();
  } else if (["PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED", "PAYMENT_DELETED"].includes(ev) && p.status !== "PENDING") {
    if (ev !== "PAYMENT_DELETED") await env.DB.prepare("UPDATE plt_organizacoes SET pago_ate=? WHERE id=? AND plano_status<>'CORTESIA'").bind(Date.now(), o.id).run();
  }
  return new Response("ok");
}
function iguais(a, b) { let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; }

// ---------------------------------------------------------------------------
// Lembretes por e-mail (uma vez por dia): teste acabando, teste acabou, pagamento atrasado.
// ---------------------------------------------------------------------------

export async function lembretesDePlano(env, k) {
  const t = k.agora(env);
  const hoje = isoBR(t);
  const feito = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='lembretes_plano_dia'").first().catch(() => null);
  if (feito?.valor === hoje || new Date(t - 3 * 3600000).getUTCHours() < 9) return 0;
  await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES('lembretes_plano_dia',?)").bind(hoje).run();
  const { planos } = await lerPlanos(env);
  const orgs = (await env.DB.prepare("SELECT * FROM plt_organizacoes WHERE status='ATIVA' AND COALESCE(plano_status,'TESTE') IN ('TESTE','ATIVO','ATRASADO','CANCELADO') LIMIT 500").all())?.results || [];
  let n = 0;
  for (const o of orgs) {
    const a = acessoDa(o, t, planos);
    let tipo = null, assunto = "", texto = "";
    const link = (k.base || "") + "/app#/plano";
    if (o.plano_status === "TESTE" && a.liberado && a.dias <= 2) { tipo = "teste-" + a.dias; assunto = `Seu teste grátis da DENIA termina em ${a.dias <= 1 ? "1 dia" : a.dias + " dias"}`; texto = `Olá! O teste grátis de ${o.nome} na DENIA termina em ${a.dias <= 1 ? "1 dia" : a.dias + " dias"}.\n\nPara não parar o atendimento, escolha o plano e a forma de pagamento (Pix, boleto ou cartão): ${link}\n\nSem fidelidade: você cancela quando quiser.`; }
    else if (a.status === "TESTE_ACABOU" && t - Number(o.teste_ate || 0) < 10 * DIA) { tipo = "teste-acabou-" + Math.floor((t - Number(o.teste_ate || 0)) / (3 * DIA)); assunto = "Seu teste grátis da DENIA terminou"; texto = `Olá! O teste grátis de ${o.nome} terminou e o atendimento automático foi pausado.\n\nSeus dados, menu e treinamento continuam guardados. Para voltar a atender, assine em: ${link}`; }
    else if (a.status === "ATRASADO") { tipo = "atrasado-" + Math.floor((t - Number(o.pago_ate || 0)) / (2 * DIA)); assunto = "Pagamento da DENIA pendente"; texto = `Olá! O pagamento do plano de ${o.nome} está pendente. O acesso continua por até 3 dias depois do vencimento.\n\nVeja a cobrança (Pix, boleto ou cartão) em: ${link}`; }
    if (!tipo) continue;
    const chave = `lembrete:${o.id}:${tipo}:${o.plano_status === "TESTE" ? o.teste_ate : o.pago_ate}`;
    const ja = await env.DB.prepare("SELECT 1 FROM plt_meta WHERE chave=?").bind(chave).first();
    if (ja) continue;
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind(chave, hoje).run();
    for (const para of await k.responsaveis(o.id)) { if (await k.enviarEmail(env, para, assunto, texto)) n++; }
  }
  return n;
}
