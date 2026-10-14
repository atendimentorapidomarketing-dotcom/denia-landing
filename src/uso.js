// DENIA Platform — Consumo e custos.
// Cada chamada às APIs externas (OpenAI, Meta, Google) é somada por dia, empresa, serviço, operação e modelo.
// As somas ficam na memória durante a requisição e são gravadas de uma vez no fim (descarregarUso),
// para não acrescentar uma escrita no banco a cada chamada. Os limites de uso que a Meta devolve nos
// cabeçalhos (x-app-usage, x-business-use-case-usage) ficam guardados para mostrar o quanto falta.

const DIA_MS = 86400000;

// Preços padrão em dólar por 1 milhão de tokens (e por minuto/caractere quando a API não devolve tokens).
// São estimativas: o administrador pode ajustar na página Consumo, e a chave de administrador da OpenAI
// mostra o valor oficial cobrado.
export const PRECOS_PADRAO = {
  "gpt-5.6": { entrada: 1.25, cache: 0.125, saida: 10 },
  "gpt-5-mini": { entrada: 0.25, cache: 0.025, saida: 2 },
  "gpt-5-nano": { entrada: 0.05, cache: 0.005, saida: 0.4 },
  "gpt-5": { entrada: 1.25, cache: 0.125, saida: 10 },
  "gpt-4.1-mini": { entrada: 0.4, cache: 0.1, saida: 1.6 },
  "gpt-4.1": { entrada: 2, cache: 0.5, saida: 8 },
  "gpt-4o-mini-transcribe": { entrada: 1.25, cache: 0, saida: 5 },
  "gpt-4o-transcribe": { entrada: 2.5, cache: 0, saida: 10 },
  "gpt-4o-mini-tts": { entrada: 0.6, cache: 0, saida: 12, por_caractere: 0.0000167 },
  "gpt-4o-mini": { entrada: 0.15, cache: 0.075, saida: 0.6 },
  "gpt-4o": { entrada: 2.5, cache: 1.25, saida: 10 },
  "gpt-image-1.5": { entrada: 5, cache: 1.25, saida: 40, imagem_entrada: 10 },
  "gpt-image-1": { entrada: 5, cache: 1.25, saida: 40, imagem_entrada: 10 },
  "gpt-realtime": { entrada: 4, cache: 0.4, saida: 16, audio_entrada: 32, audio_saida: 64 },
  "*": { entrada: 1.25, cache: 0.125, saida: 10 }
};

// Cotas conhecidas (por minuto, por projeto) — o Google mostra as reais em console.cloud.google.com → Cotas.
export const COTAS_GOOGLE = {
  contas: { nome: "My Business Account Management API", por_minuto: 300 },
  informacoes: { nome: "My Business Business Information API", por_minuto: 300 },
  avaliacoes: { nome: "Google My Business API (avaliações e posts)", por_minuto: 300 },
  desempenho: { nome: "Business Profile Performance API", por_minuto: 300 },
  login: { nome: "Login do Google (OAuth)", por_minuto: null }
};

const buffer = new Map();   // chave → soma
const limites = new Map();  // chave → { org_id, servico, chave, dados, ms }

export function orgDoUso(env) { return Number(env?.USO_ORG || 0) || 0; }
// Cópia leve do env que leva a empresa junto (os bindings continuam pelo protótipo).
export function comOrgUso(env, orgId) {
  if (!env || Number(env.USO_ORG) === Number(orgId)) return env;
  return Object.assign(Object.create(env), { USO_ORG: Number(orgId) || 0 });
}

function dia(ms) { return new Date(ms).toISOString().slice(0, 10); }

// Recurso da plataforma que fez a chamada (ex.: "avaliacoes/triagem", "assistente", "cron:avaliacoes").
export function comRecurso(env, recurso) {
  if (!env) return env;
  return Object.assign(Object.create(env), { USO_RECURSO: String(recurso || "").slice(0, 60) });
}
export function recursoDo(env) { return String(env?.USO_RECURSO || ""); }

// Soma uma chamada. Campos numéricos opcionais: tokens_entrada, tokens_saida, tokens_cache, imagens, caracteres, custo_usd, ms.
export function registrarUso(org, servico, operacao, modelo, n = {}, recurso = "") {
  try {
    const d = dia(Date.now());
    const chave = [org || 0, d, servico, operacao, recurso || "", modelo || ""].join("|");
    const s = buffer.get(chave) || { org_id: org || 0, dia: d, servico, operacao, recurso: recurso || "", modelo: modelo || "", chamadas: 0, erros: 0, limitadas: 0, tokens_entrada: 0, tokens_saida: 0, tokens_cache: 0, imagens: 0, caracteres: 0, custo_usd: 0, ms_total: 0 };
    s.chamadas += 1;
    if (n.erro) s.erros += 1;
    if (n.limitada) s.limitadas += 1;
    for (const c of ["tokens_entrada", "tokens_saida", "tokens_cache", "imagens", "caracteres", "custo_usd"]) s[c] += Number(n[c] || 0) || 0;
    s.ms_total += Math.round(Number(n.ms || 0)) || 0;
    buffer.set(chave, s);
  } catch { /* medir nunca atrapalha a chamada */ }
}
export function registrarLimite(org, servico, chave, dados) {
  try { limites.set([org || 0, servico, chave].join("|"), { org_id: org || 0, servico, chave, dados: JSON.stringify(dados).slice(0, 4000), ms: Date.now() }); } catch { /* ignora */ }
}

// Custo estimado de uma resposta da OpenAI a partir do "usage" que ela devolve.
export function precoDe(modelo, tabela) {
  const t = tabela || PRECOS_PADRAO, m = String(modelo || "").toLowerCase();
  const chaves = Object.keys(t).filter(k => k !== "*" && m.startsWith(k.toLowerCase())).sort((a, b) => b.length - a.length);
  return t[chaves[0]] || t["*"] || PRECOS_PADRAO["*"];
}
export function custoOpenAI(modelo, usage, tabela, extra = {}) {
  const p = precoDe(modelo, tabela);
  if (extra.caracteres && p.por_caractere) return extra.caracteres * p.por_caractere;
  if (!usage) return 0;
  const ent = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const sai = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  const det = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const cache = Number(det.cached_tokens || 0) || 0;
  const imgEnt = Number(det.image_tokens || 0) || 0;
  const audEnt = Number(det.audio_tokens || 0) || 0;
  const audSai = Number((usage.output_tokens_details || {}).audio_tokens || 0) || 0;
  const texto = Math.max(0, ent - cache - imgEnt - audEnt);
  return (texto * p.entrada + cache * (p.cache ?? p.entrada) + imgEnt * (p.imagem_entrada ?? p.entrada) + audEnt * (p.audio_entrada ?? p.entrada)
    + Math.max(0, sai - audSai) * p.saida + audSai * (p.audio_saida ?? p.saida)) / 1e6;
}
export function tokensDe(usage) {
  if (!usage) return {};
  const det = usage.input_tokens_details || usage.prompt_tokens_details || {};
  return { tokens_entrada: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0, tokens_saida: Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0, tokens_cache: Number(det.cached_tokens || 0) || 0 };
}

const prontos = new WeakSet();
export async function garantirUso(env) {
  if (prontos.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS plt_uso_dia (org_id INTEGER NOT NULL DEFAULT 0, dia TEXT NOT NULL, servico TEXT NOT NULL, operacao TEXT NOT NULL, recurso TEXT NOT NULL DEFAULT '', modelo TEXT NOT NULL DEFAULT '',
      chamadas INTEGER NOT NULL DEFAULT 0, erros INTEGER NOT NULL DEFAULT 0, limitadas INTEGER NOT NULL DEFAULT 0, tokens_entrada INTEGER NOT NULL DEFAULT 0, tokens_saida INTEGER NOT NULL DEFAULT 0,
      tokens_cache INTEGER NOT NULL DEFAULT 0, imagens INTEGER NOT NULL DEFAULT 0, caracteres INTEGER NOT NULL DEFAULT 0, custo_usd REAL NOT NULL DEFAULT 0, ms_total INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org_id, dia, servico, operacao, recurso, modelo))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS plt_uso_limites (org_id INTEGER NOT NULL DEFAULT 0, servico TEXT NOT NULL, chave TEXT NOT NULL, dados TEXT NOT NULL, atualizado_ms INTEGER NOT NULL, PRIMARY KEY (org_id, servico, chave))`)
  ]);
  prontos.add(env.DB);
}

// Grava o que foi somado. Chamado no fim de cada requisição e de cada execução do cron.
export async function descarregarUso(env) {
  if (!env?.DB || (!buffer.size && !limites.size)) return;
  const somas = [...buffer.values()], lims = [...limites.values()];
  buffer.clear(); limites.clear();
  try {
    await garantirUso(env);
    const cols = ["chamadas", "erros", "limitadas", "tokens_entrada", "tokens_saida", "tokens_cache", "imagens", "caracteres", "custo_usd", "ms_total"];
    const stmts = somas.map(s => env.DB.prepare(`INSERT INTO plt_uso_dia (org_id,dia,servico,operacao,recurso,modelo,${cols.join(",")}) VALUES (?,?,?,?,?,?,${cols.map(() => "?").join(",")})
      ON CONFLICT(org_id,dia,servico,operacao,recurso,modelo) DO UPDATE SET ${cols.map(c => `${c}=${c}+excluded.${c}`).join(",")}`).bind(s.org_id, s.dia, s.servico, s.operacao, s.recurso, s.modelo, ...cols.map(c => s[c])));
    for (const l of lims) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO plt_uso_limites(org_id,servico,chave,dados,atualizado_ms) VALUES(?,?,?,?,?)").bind(l.org_id, l.servico, l.chave, l.dados, l.ms));
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  } catch (e) { console.error("uso", e?.message); }
}

// Cabeçalhos de limite da Meta (porcentagem usada da janela de 1 hora).
export function lerLimitesMeta(org, headers) {
  try {
    const app = headers.get("x-app-usage");
    if (app) registrarLimite(org, "meta", "app", JSON.parse(app));
    const buc = headers.get("x-business-use-case-usage");
    if (buc) for (const [id, lista] of Object.entries(JSON.parse(buc))) registrarLimite(org, "meta", "buc:" + id, lista);
    const page = headers.get("x-page-usage");
    if (page) registrarLimite(org, "meta", "pagina", JSON.parse(page));
  } catch { /* cabeçalho em formato inesperado */ }
}

// ---------------------------------------------------------------------------
// Rotas: /api/orgs/:id/mk/uso…
// ---------------------------------------------------------------------------

function periodo(url, agoraMs) {
  const hoje = dia(agoraMs);
  const valida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  let de = url.searchParams.get("de"), ate = url.searchParams.get("ate");
  const atalho = url.searchParams.get("atalho");
  if (atalho === "mes") { de = hoje.slice(0, 8) + "01"; ate = hoje; }
  else if (atalho === "mes_passado") { const d = new Date(Date.UTC(+hoje.slice(0, 4), +hoje.slice(5, 7) - 1, 0)); ate = dia(d.getTime()); de = ate.slice(0, 8) + "01"; }
  else if (!valida(de) || !valida(ate)) { const n = Math.min(730, Math.max(1, Number(url.searchParams.get("dias")) || 30)); ate = hoje; de = dia(agoraMs - (n - 1) * DIA_MS); }
  if (de > ate) [de, ate] = [ate, de];
  return { de, ate, dias: Math.round((Date.parse(ate) - Date.parse(de)) / DIA_MS) + 1 };
}

const cachePrecos = new Map();
// Tabela de preços da empresa, guardada por 5 minutos (usada a cada chamada da OpenAI).
export async function precosDaOrg(env, orgId) {
  const c = cachePrecos.get(orgId);
  if (c && c.ate > Date.now()) return c.precos;
  let precos = PRECOS_PADRAO;
  try { precos = (await tabelaDePrecos(env, orgId)).precos; } catch { /* usa o padrão */ }
  cachePrecos.set(orgId, { precos, ate: Date.now() + 300000 });
  return precos;
}
export async function tabelaDePrecos(env, orgId) {
  const r = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("precos_ia_org_" + orgId).first().catch(() => null);
  let salvo = {};
  try { salvo = r?.valor ? JSON.parse(r.valor) : {}; } catch { salvo = {}; }
  return { precos: { ...PRECOS_PADRAO, ...(salvo.precos || {}) }, moeda: salvo.moeda || "BRL", cotacao: Number(salvo.cotacao) > 0 ? Number(salvo.cotacao) : 5.4, personalizado: Boolean(salvo.precos && Object.keys(salvo.precos).length) };
}

async function custosOficiaisOpenAI(chaveAdmin, de, ate) {
  const ini = Math.floor(Date.parse(de + "T00:00:00Z") / 1000), fim = Math.floor((Date.parse(ate + "T00:00:00Z") + DIA_MS) / 1000);
  const porDia = new Map(), porItem = new Map();
  let pagina = null, total = 0;
  for (let i = 0; i < 10; i++) {
    const u = new URL("https://api.openai.com/v1/organization/costs");
    u.searchParams.set("start_time", String(ini)); u.searchParams.set("end_time", String(fim));
    u.searchParams.set("bucket_width", "1d"); u.searchParams.set("limit", "180"); u.searchParams.append("group_by", "line_item");
    if (pagina) u.searchParams.set("page", pagina);
    const r = await fetch(u.toString(), { headers: { authorization: "Bearer " + chaveAdmin }, signal: AbortSignal.timeout(20000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "A OpenAI recusou a chave de administrador. Ela começa com sk-admin- e é criada em platform.openai.com → Settings → Admin keys." : `OpenAI ${r.status}: ${String(d?.error?.message || "").slice(0, 160)}`);
    for (const b of d.data || []) {
      const dd = dia(Number(b.start_time) * 1000);
      for (const x of b.results || []) {
        const v = Number(x.amount?.value || 0) || 0;
        total += v;
        porDia.set(dd, (porDia.get(dd) || 0) + v);
        const item = String(x.line_item || "outros");
        porItem.set(item, (porItem.get(item) || 0) + v);
      }
    }
    if (!d.has_more || !d.next_page) break;
    pagina = d.next_page;
  }
  return { total_usd: total, por_dia: [...porDia.entries()].sort().map(([d, v]) => ({ dia: d, usd: v })), por_item: [...porItem.entries()].sort((a, b) => b[1] - a[1]).map(([item, usd]) => ({ item, usd })) };
}

export async function rotasUso(request, env, k, orgId, papel, resto, { central = false } = {}) {
  const orgs = central ? [orgId, 0] : [orgId, -1]; // o consumo sem empresa (cron geral) aparece só para a Central
  const url = new URL(request.url), metodo = request.method;
  if (!resto.startsWith("uso")) return null;
  await garantirUso(env);
  await descarregarUso(env); // o que está na memória entra na conta antes de ler
  if (resto === "uso" && metodo === "GET") {
    if (!k.pode(papel, "ADMIN")) return k.json({ erro: "Somente administradores veem o consumo e os custos." }, 403);
    const p = periodo(url, k.agora(env));
    const linhas = (await env.DB.prepare("SELECT dia,servico,operacao,recurso,modelo,chamadas,erros,limitadas,tokens_entrada,tokens_saida,tokens_cache,imagens,caracteres,custo_usd,ms_total FROM plt_uso_dia WHERE org_id IN (?,?) AND dia BETWEEN ? AND ? ORDER BY dia").bind(...orgs, p.de, p.ate).all())?.results || [];
    // Período anterior do mesmo tamanho, para comparar.
    const aDe = dia(Date.parse(p.de) - p.dias * DIA_MS), aAte = dia(Date.parse(p.de) - DIA_MS);
    const ant = await env.DB.prepare("SELECT servico, SUM(chamadas) chamadas, SUM(erros) erros, SUM(custo_usd) custo_usd, SUM(tokens_entrada) tokens_entrada, SUM(tokens_saida) tokens_saida FROM plt_uso_dia WHERE org_id IN (?,?) AND dia BETWEEN ? AND ? GROUP BY servico").bind(...orgs, aDe, aAte).all();
    const lim = (await env.DB.prepare("SELECT servico,chave,dados,atualizado_ms FROM plt_uso_limites WHERE org_id IN (?,?) ORDER BY atualizado_ms DESC LIMIT 50").bind(...orgs).all())?.results || [];
    const temAdmin = Boolean((await env.DB.prepare("SELECT 1 FROM plt_meta WHERE chave=?").bind("openai_admin_org_" + orgId).first().catch(() => null)));
    const precos = await tabelaDePrecos(env, orgId);
    return k.json({ ...p, linhas, anterior: { de: aDe, ate: aAte, servicos: ant?.results || [] }, limites: lim.map(l => ({ ...l, dados: (() => { try { return JSON.parse(l.dados); } catch { return null; } })() })),
      cotas_google: COTAS_GOOGLE, tem_chave_admin: temAdmin, ...precos });
  }
  if (resto === "uso/precos" && metodo === "POST") {
    if (!k.pode(papel, "ADMIN")) return k.json({ erro: "Somente administradores mudam os preços." }, 403);
    const { corpo, erro } = await k.lerCorpo(request);
    if (erro) return erro;
    const limpo = {};
    if (!corpo.restaurar) for (const [m, v] of Object.entries(corpo.precos || {}).slice(0, 60)) {
      const nome = String(m).trim().slice(0, 60);
      if (!nome) continue;
      const num = x => (x === "" || x == null || !Number.isFinite(Number(x)) || Number(x) < 0) ? undefined : Number(x);
      const item = { entrada: num(v.entrada), cache: num(v.cache), saida: num(v.saida), imagem_entrada: num(v.imagem_entrada), audio_entrada: num(v.audio_entrada), audio_saida: num(v.audio_saida), por_caractere: num(v.por_caractere) };
      if (item.entrada == null || item.saida == null) continue;
      limpo[nome] = Object.fromEntries(Object.entries(item).filter(([, x]) => x != null));
    }
    const moeda = /^[A-Z]{3}$/.test(String(corpo.moeda || "")) ? corpo.moeda : "BRL";
    const cotacao = Number(corpo.cotacao) > 0 ? Number(corpo.cotacao) : 5.4;
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("precos_ia_org_" + orgId, JSON.stringify({ precos: limpo, moeda, cotacao })).run();
    cachePrecos.delete(orgId);
    return k.json({ ok: true, ...(await tabelaDePrecos(env, orgId)) });
  }
  if (resto === "uso/chave-admin" && metodo === "POST") {
    if (!k.pode(papel, "ADMIN")) return k.json({ erro: "Somente administradores." }, 403);
    const { corpo, erro } = await k.lerCorpo(request);
    if (erro) return erro;
    if (corpo.remover) { await env.DB.prepare("DELETE FROM plt_meta WHERE chave=?").bind("openai_admin_org_" + orgId).run(); return k.json({ ok: true }); }
    const chave = String(corpo.chave || "").replace(/\s+/g, "");
    if (!/^sk-admin-[A-Za-z0-9_\-]{20,300}$/.test(chave)) return k.json({ erro: "A chave de administrador da OpenAI começa com sk-admin- (crie em platform.openai.com → Settings → Admin keys). Ela só lê custos; não é a chave que a DENIA usa para responder." }, 400);
    const hoje = dia(k.agora(env));
    try { await custosOficiaisOpenAI(chave, hoje, hoje); } catch (e) { return k.json({ erro: e.message }, 400); }
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("openai_admin_org_" + orgId, await k.cifrar(env, chave)).run();
    return k.json({ ok: true });
  }
  if (resto === "uso/openai-oficial" && metodo === "GET") {
    if (!k.pode(papel, "ADMIN")) return k.json({ erro: "Somente administradores veem os custos oficiais." }, 403);
    const salvo = (await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("openai_admin_org_" + orgId).first().catch(() => null))?.valor;
    const chave = salvo ? await k.decifrar(env, salvo) : String(env.OPENAI_ADMIN_KEY || "").trim();
    if (!chave) return k.json({ configurada: false });
    const p = periodo(url, k.agora(env));
    try { return k.json({ configurada: true, ...p, ...(await custosOficiaisOpenAI(chave, p.de, p.ate)) }); }
    catch (e) { return k.json({ configurada: true, erro: e.message }); }
  }
  // A voz ao vivo roda no navegador: ele manda o "usage" de cada resposta para entrar na conta.
  if (resto === "uso/realtime" && metodo === "POST") {
    const { corpo, erro } = await k.lerCorpo(request);
    if (erro) return erro;
    const tabela = (await tabelaDePrecos(env, orgId)).precos;
    const modelo = String(corpo.modelo || env.OPENAI_REALTIME_MODEL || "gpt-realtime").slice(0, 60);
    const usage = corpo.usage && typeof corpo.usage === "object" ? corpo.usage : null;
    if (usage) {
      const t = tokensDe(usage);
      if (t.tokens_entrada + t.tokens_saida < 2_000_000) registrarUso(orgId, "openai", "voz_ao_vivo", modelo, { ...t, custo_usd: custoOpenAI(modelo, usage, tabela) }, "assistente/voz");
    }
    return k.json({ ok: true });
  }
  return null;
}
