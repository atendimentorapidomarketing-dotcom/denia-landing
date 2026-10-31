import { registrarUso, orgDoUso } from "./uso.js";
import { registrarProblema, resolverProblema } from "./problemas.js";
import { gerarPdf, dimensoesJpeg } from "./pdf.js";
// DENIA Platform — Google Perfil da Empresa (Google Meu Negócio), pela API oficial.
// Conexão por marca (login do Google), publicação dos posts aprovados, avaliações (buscar e responder)
// e desempenho do perfil (visualizações, ligações, rotas, cliques e as buscas que levam ao perfil).
//
// Secrets no Worker denia-landing: GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (cliente OAuth do tipo
// "Aplicativo da Web", com o URI de redirecionamento <site>/api/google/retorno).
//
// Como na Meta: o cookie de sessão é SameSite=Strict, então a volta do Google é validada por um
// "state" assinado e de uso único.

const ESCOPO = "https://www.googleapis.com/auth/business.manage";
const ESCOPO_SC = "https://www.googleapis.com/auth/webmasters"; // Search Console (ler números, enviar sitemap, inspecionar páginas)
const ESCOPO_ADS = "https://www.googleapis.com/auth/adwords"; // Google Ads (só pedido quando a DENIA tem o token de desenvolvedor)
// Permissões em etapas: a conexão normal pede só o perfil; o Search Console e o Ads são pedidos quando a pessoa liga cada um
// (assim a tela do Google nunca mostra aviso por permissão que a empresa não vai usar).
const escoposPedidos = (env, extra) => [ESCOPO, ...(/sc/.test(extra || "") ? [ESCOPO_SC] : []), ...(/ads/.test(extra || "") && String(env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim() ? [ESCOPO_ADS] : [])].join(" ");
const VALIDADE_STATE_MS = 15 * 60000;
const SINCRONIZAR_A_CADA_MS = 10 * 60000; // avaliações: a cada 10 minutos
const DESEMPENHO_A_CADA_MS = 6 * 3600000; // desempenho: a cada 6 horas (o Google consolida com dias de atraso)
const API_CONTAS = "https://mybusinessaccountmanagement.googleapis.com/v1";
const API_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
const API_V4 = "https://mybusiness.googleapis.com/v4";
const API_DESEMPENHO = "https://businessprofileperformance.googleapis.com/v1";
const ESTRELAS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const IDIOMA_GOOGLE = { "pt-BR": "pt-BR", en: "en", es: "es", de: "de", it: "it", fr: "fr", ja: "ja", hi: "hi" };

const DDL = [
  `CREATE TABLE IF NOT EXISTS plt_mk_geogrid (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, palavra TEXT NOT NULL, raio_km REAL, tamanho INTEGER, media REAL, top3 INTEGER, dados TEXT, criado_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_concorrencia (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, busca TEXT NOT NULL, dia TEXT NOT NULL, posicao INTEGER, total INTEGER, dados TEXT, criado_ms INTEGER NOT NULL, UNIQUE(org_id, marca_id, busca, dia))`,
  `CREATE TABLE IF NOT EXISTS plt_mk_google (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, conta_nome TEXT NOT NULL, local_nome TEXT NOT NULL, local_titulo TEXT, token_cifrado TEXT NOT NULL, criado_por TEXT, criado_ms INTEGER NOT NULL, atualizado_ms INTEGER NOT NULL, sincronizado_ms INTEGER, UNIQUE(org_id, marca_id))`
];
const ALTERS = ["ALTER TABLE plt_mk_google ADD COLUMN desempenho_ms INTEGER", "ALTER TABLE plt_mk_google ADD COLUMN erro TEXT", "ALTER TABLE plt_mk_google ADD COLUMN maps_uri TEXT", "ALTER TABLE plt_mk_avaliacoes ADD COLUMN removida_ms INTEGER",
  "ALTER TABLE plt_mk_avaliacoes ADD COLUMN visto_ms INTEGER", "ALTER TABLE plt_mk_google ADD COLUMN sync_token TEXT", "ALTER TABLE plt_mk_google ADD COLUMN sync_inicio_ms INTEGER",
  "ALTER TABLE plt_mk_google ADD COLUMN total_google INTEGER", "ALTER TABLE plt_mk_google ADD COLUMN media_google REAL", "ALTER TABLE plt_mk_google ADD COLUMN completo_ms INTEGER",
  "ALTER TABLE plt_mk_google ADD COLUMN escopos TEXT", "ALTER TABLE plt_mk_google ADD COLUMN sc_site TEXT", "ALTER TABLE plt_mk_google ADD COLUMN ads_cliente TEXT", "ALTER TABLE plt_mk_google ADD COLUMN ads_gerente TEXT", "ALTER TABLE plt_mk_google ADD COLUMN ads_nome TEXT", "ALTER TABLE plt_mk_google ADD COLUMN ads_moeda TEXT"];
const prontos = new WeakSet();
async function garantir(env) {
  if (prontos.has(env.DB)) return;
  await env.DB.batch(DDL.map(s => env.DB.prepare(s)));
  await env.DB.prepare("ALTER TABLE plt_mk_avaliacoes ADD COLUMN google_id TEXT").run().catch(() => { }); // coluna já existe
  for (const a of ALTERS) await env.DB.prepare(a).run().catch(() => { });
  // Duas buscas ao mesmo tempo (a automática e a do botão) chegaram a gravar a mesma avaliação duas vezes:
  // apaga as cópias (fica a mais antiga, que guarda análise e respostas) e impede que aconteça de novo.
  if (!(await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='plt_mk_av_google_unico'").first().catch(() => null))) {
    await env.DB.prepare(`DELETE FROM plt_mk_avaliacoes WHERE google_id IS NOT NULL AND id NOT IN (SELECT MIN(id) FROM plt_mk_avaliacoes WHERE google_id IS NOT NULL GROUP BY org_id, marca_id, google_id)`).run().catch(e => console.error("dedup", e?.message));
    await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS plt_mk_av_google_unico ON plt_mk_avaliacoes(org_id, marca_id, google_id)").run().catch(e => console.error("índice", e?.message));
  }
  prontos.add(env.DB);
}

export const googleConfigurada = env => Boolean(String(env.GOOGLE_CLIENT_ID || "").trim() && String(env.GOOGLE_CLIENT_SECRET || "").trim());
const faltando = env => ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].filter(n => !String(env[n] || "").trim());
// Endereço público da plataforma para os retornos do Google e da Meta: sempre o oficial (SITE_URL), senão o do
// pedido sem "www" e com https. Assim o endereço de retorno é o mesmo no computador e no celular.
const baseDe = (request, env) => {
  const site = String(env?.SITE_URL || "").trim().replace(/\/+$/, "");
  if (/^https:\/\/[^/\s]+$/.test(site)) return site;
  const u = new URL(request.url);
  const local = /^(localhost|127\.|\[::1\])/.test(u.hostname) || u.hostname.endsWith(".test");
  return local ? u.origin : `https://${u.host.replace(/^www\./i, "")}`;
};

// ----- Chamadas à API do Google
function explicarErro(d, status) {
  const msg = String(d?.error?.message || d?.error_description || d?.error || `HTTP ${status}`);
  if (/insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(msg)) return "Falta permissão nesta conexão do Google. Toque em Ligar (Search Console ou Google Ads) e marque todas as caixas na tela do Google.";
  if (status === 401 || /invalid_grant/i.test(msg)) return "O acesso ao Google desta marca expirou ou foi removido. Conecte de novo em Contas conectadas.";
  if (status === 403 && /disabled|not been used|has not been enabled/i.test(msg)) return "Uma API do Google Perfil da Empresa não está ativada no projeto do Google Cloud. Ative as APIs do Google Business Profile e tente de novo.";
  if (status === 403) return "O Google não deu permissão para esta ação. Confira se a conta usada é proprietária ou administradora do perfil e conecte de novo.";
  if (status === 429) return "Limite de uso do Google atingido por agora. A DENIA tenta de novo mais tarde.";
  return "O Google respondeu: " + msg.slice(0, 220);
}
// Qual API do Google (e cota) cada endereço usa — para a página Consumo.
function apiGoogleDe(url) {
  const u = String(url);
  if (u.includes("mybusinessaccountmanagement")) return "contas";
  if (u.includes("mybusinessbusinessinformation")) return "informacoes";
  if (u.includes("businessprofileperformance")) return "desempenho";
  if (u.includes("oauth2.googleapis.com")) return "login";
  if (u.includes("webmasters") || u.includes("searchconsole")) return "search_console";
  if (u.includes("googleads.googleapis.com")) return "ads";
  if (u.includes("places.googleapis.com")) return "lugares";
  return "avaliacoes";
}
function operacaoGoogle(metodo, url) {
  const caminho = new URL(url).pathname.split("/").filter(x => x && !/^(v\d+|accounts|locations|\d+)$/.test(x));
  const ultimo = (caminho.slice(-1)[0] || "").split(":").slice(-1)[0];
  return `${metodo} ${ultimo}`.slice(0, 50);
}
const orgDoToken = new Map(); // token de acesso → empresa (para somar o consumo na empresa certa)
async function chamar(metodo, url, token, corpo) {
  const inicio = Date.now(), org = orgDoToken.get(token) || 0;
  let r;
  try {
    r = await fetch(url, {
      method: metodo, signal: AbortSignal.timeout(30000),
      headers: { authorization: "Bearer " + token, ...(corpo ? { "content-type": "application/json" } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined
    });
  } catch (e) { registrarUso(org, "google", apiGoogleDe(url), operacaoGoogle(metodo, url), { erro: true, ms: Date.now() - inicio }); throw e; }
  registrarUso(org, "google", apiGoogleDe(url), operacaoGoogle(metodo, url), { erro: !r.ok, limitada: r.status === 429, ms: Date.now() - inicio });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(explicarErro(d, r.status)); e.status = r.status; if (/insufficient.*scope|SCOPE_INSUFFICIENT/i.test(JSON.stringify(d))) e.codigo = "RECONECTAR"; throw e; }
  return d;
}
async function trocarToken(env, params) {
  registrarUso(orgDoUso(env), "google", "login", params.grant_type === "refresh_token" ? "renovar acesso" : "conectar");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", signal: AbortSignal.timeout(20000), headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: String(env.GOOGLE_CLIENT_ID).trim(), client_secret: String(env.GOOGLE_CLIENT_SECRET).trim(), ...params })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) { const e = new Error(explicarErro(d, r.status === 400 ? 401 : r.status)); e.status = r.status; throw e; }
  return d;
}
// Token de acesso (1 h) a partir do token permanente guardado cifrado.
const cacheTokens = new Map();
async function tokenDa(env, k, conta) {
  const c = cacheTokens.get(conta.id);
  if (c && c.ate > k.agora(env) + 60000) return c.token;
  const refresh = await k.decifrar(env, conta.token_cifrado);
  if (!refresh) throw new Error("O acesso ao Google desta marca não pôde ser lido. Conecte de novo.");
  const d = await trocarToken(env, { grant_type: "refresh_token", refresh_token: refresh });
  cacheTokens.set(conta.id, { token: d.access_token, ate: k.agora(env) + Number(d.expires_in || 3600) * 1000 });
  if (orgDoToken.size > 500) orgDoToken.clear();
  orgDoToken.set(d.access_token, conta.org_id);
  return d.access_token;
}

// ----- State assinado (uso único)
async function assinarState(k, dados) {
  const corpo = k.b64url(new TextEncoder().encode(JSON.stringify(dados)));
  return corpo + "." + await k.hmac(await k.segredo(k.env), "google-state:" + corpo);
}
async function lerState(k, state) {
  const [corpo, sig] = String(state || "").split(".");
  if (!corpo || !sig || sig !== await k.hmac(await k.segredo(k.env), "google-state:" + corpo)) return null;
  try { return JSON.parse(new TextDecoder().decode(k.deB64url(corpo))); } catch { return null; }
}
async function lerNonce(env, k, n) {
  if (!/^[A-Za-z0-9_-]{10,60}$/.test(String(n || ""))) return null;
  const v = (await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("google_n_" + n).first())?.valor;
  if (!v) return null;
  try { const d = JSON.parse(await k.decifrar(env, v)); return d.e > k.agora(env) ? d : null; } catch { return null; }
}

export async function contaGoogleDe(env, orgId, marcaId) {
  await garantir(env);
  return env.DB.prepare("SELECT * FROM plt_mk_google WHERE org_id=? AND marca_id=?").bind(orgId, marcaId).first();
}
const caminhoV4 = conta => `${conta.conta_nome}/${conta.local_nome}`; // accounts/1/locations/2

// ----- Rotas da empresa: /api/orgs/:id/mk/google/...
export async function rotasGoogle(request, env, k, orgId, papel, resto) {
  if (!resto.startsWith("google/")) return null;
  const { json, txt, pode, agora, auditar, sessao } = k;
  await garantir(env);
  const metodo = request.method;
  const url = new URL(request.url);

  if (resto === "google/estado" && metodo === "GET") {
    const contas = (await env.DB.prepare(`SELECT marca_id, local_titulo, atualizado_ms, sincronizado_ms, erro, total_google, media_google, sync_token IS NOT NULL AS lendo, escopos, sc_site, ads_cliente, ads_nome, ads_moeda,
      (SELECT COUNT(*) FROM plt_mk_avaliacoes a WHERE a.org_id=g.org_id AND a.marca_id=g.marca_id AND a.google_id IS NOT NULL AND a.removida_ms IS NULL) AS na_denia FROM plt_mk_google g WHERE org_id=?`).bind(orgId).all())?.results || [];
    return json({ configurada: googleConfigurada(env), faltando: faltando(env), contas, ads_configurado: adsConfigurado(env), places_configurado: Boolean(chavePlaces(env)) });
  }
  if (resto === "google/conectar" && metodo === "GET") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores conectam contas." }, 403);
    if (!googleConfigurada(env)) return json({ erro: `A conexão com o Google ainda não foi configurada: falta ${faltando(env).join(" e ")} no Worker denia-landing.`, codigo: "GOOGLE_NAO_CONFIGURADO", faltando: faltando(env) }, 503);
    const marcaId = Number(url.searchParams.get("marca"));
    const marca = await env.DB.prepare("SELECT id FROM plt_mk_marcas WHERE id=? AND org_id=?").bind(marcaId, orgId).first();
    if (!marca) return json({ erro: "Marca não encontrada." }, 404);
    const nonce = k.b64url(crypto.getRandomValues(new Uint8Array(18)));
    const reg = { o: orgId, m: marcaId, u: sessao.usuario.id, e: agora(env) + VALIDADE_STATE_MS };
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("google_n_" + nonce, await k.cifrar(env, JSON.stringify(reg))).run();
    const dialogo = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    dialogo.searchParams.set("client_id", String(env.GOOGLE_CLIENT_ID).trim());
    dialogo.searchParams.set("redirect_uri", baseDe(request, env) + "/api/google/retorno");
    dialogo.searchParams.set("response_type", "code");
    dialogo.searchParams.set("scope", escoposPedidos(env, String(url.searchParams.get("extra") || "").slice(0, 10)));
    dialogo.searchParams.set("include_granted_scopes", "true");
    dialogo.searchParams.set("access_type", "offline");
    dialogo.searchParams.set("prompt", "consent select_account");
    dialogo.searchParams.set("state", await assinarState(k, { ...reg, n: nonce }));
    return new Response(null, { status: 302, headers: { location: dialogo.toString() } });
  }
  if (resto === "google/locais" && metodo === "GET") {
    const reg = await lerNonce(env, k, txt(url.searchParams.get("n"), 60));
    if (!reg || reg.o !== orgId || reg.u !== sessao.usuario.id || !reg.locais) return json({ erro: "A conexão expirou. Clique em Conectar Google de novo." }, 410);
    return json({ marca_id: reg.m, locais: reg.locais.map(l => ({ id: l.local, titulo: l.titulo, endereco: l.endereco })) });
  }
  if (resto === "google/escolher" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores conectam contas." }, 403);
    const { corpo, erro } = await k.lerCorpo(request, 2000);
    if (erro) return erro;
    const n = txt(corpo.n, 60);
    const reg = await lerNonce(env, k, n);
    if (!reg || reg.o !== orgId || reg.u !== sessao.usuario.id || !reg.locais) return json({ erro: "A conexão expirou. Clique em Conectar Google de novo." }, 410);
    // Um ou vários perfis: o primeiro vai para o perfil que pediu a conexão; cada outro vira um perfil novo.
    const ids = [...new Set((Array.isArray(corpo.local_ids) ? corpo.local_ids : [corpo.local_id]).map(x => String(x || "")).filter(Boolean))].slice(0, 30);
    const escolhidos = ids.map(id => reg.locais.find(x => x.local === id)).filter(Boolean);
    if (!escolhidos.length) return json({ erro: "Escolha um dos perfis." }, 400);
    const conectados = [];
    for (const [i, l] of escolhidos.entries()) {
      let marcaId = reg.m;
      if (i > 0) marcaId = (await env.DB.prepare("INSERT INTO plt_mk_marcas(org_id,nome,ativa,criado_ms) VALUES(?,?,1,?) RETURNING id").bind(orgId, String(l.titulo || "Novo perfil").slice(0, 200), agora(env)).first()).id;
      else if (corpo.renomear === true) await env.DB.prepare("UPDATE plt_mk_marcas SET nome=? WHERE id=? AND org_id=?").bind(String(l.titulo || "").slice(0, 200) || "Novo perfil", marcaId, orgId).run();
      await env.DB.prepare(`INSERT INTO plt_mk_google(org_id,marca_id,conta_nome,local_nome,local_titulo,token_cifrado,criado_por,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(org_id, marca_id) DO UPDATE SET conta_nome=excluded.conta_nome, local_nome=excluded.local_nome, local_titulo=excluded.local_titulo, token_cifrado=excluded.token_cifrado, criado_por=excluded.criado_por, atualizado_ms=excluded.atualizado_ms, sincronizado_ms=NULL, erro=NULL`)
        .bind(orgId, marcaId, l.conta, l.local, l.titulo, await k.cifrar(env, reg.refresh), sessao.usuario.email, agora(env), agora(env)).run();
      await env.DB.prepare("UPDATE plt_mk_marcas SET google=COALESCE(NULLIF(google,''),?) WHERE id=? AND org_id=?").bind(l.titulo, marcaId, orgId).run();
      await env.DB.prepare("UPDATE plt_mk_google SET escopos=? WHERE org_id=? AND marca_id=?").bind(reg.escopos || ESCOPO, orgId, marcaId).run();
      await auditar(env, request, sessao, orgId, "INTEGRACAO", `Google conectado à marca #${marcaId}: perfil ${l.titulo}`);
      const conta = await contaGoogleDe(env, orgId, marcaId);
      // Trazer avaliações e dados pode demorar em perfis grandes: espera no máximo 8 s e o resto continua sozinho.
      const trabalho = Promise.all([sincronizarConta(env, k, conta).catch(e => ({ erro: e.message })),
        preencherPeloGoogle(env, k, conta).catch(e => { console.error("preencher pelo Google", e?.message); return { preenchidos: [] }; })]);
      if (k.emSegundoPlano) k.emSegundoPlano(() => trabalho);
      const [sinc, auto] = await Promise.race([trabalho, new Promise(r => setTimeout(() => r([{ em_andamento: true }, { preenchidos: [] }]), 8000))]);
      conectados.push({ marca_id: marcaId, perfil: l.titulo, sincronizacao: sinc, preenchidos: auto.preenchidos });
    }
    await env.DB.prepare("DELETE FROM plt_meta WHERE chave=?").bind("google_n_" + n).run();
    const pri = conectados[0];
    return json({ ok: true, perfil: pri.perfil, sincronizacao: pri.sincronizacao, preenchidos: pri.preenchidos, conectados });
  }
  if (resto === "google/desconectar" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores." }, 403);
    const { corpo, erro } = await k.lerCorpo(request, 1000);
    if (erro) return erro;
    await env.DB.prepare("DELETE FROM plt_mk_google WHERE org_id=? AND marca_id=?").bind(orgId, Number(corpo.marca_id)).run();
    await auditar(env, request, sessao, orgId, "INTEGRACAO", `Google desconectado da marca #${Number(corpo.marca_id)}`);
    return json({ ok: true });
  }
  if (resto === "google/sincronizar" && metodo === "POST") {
    if (!pode(papel, "AGENTE")) return json({ erro: "Seu perfil não tem permissão para esta ação." }, 403);
    const { corpo, erro } = await k.lerCorpo(request, 1000);
    if (erro) return erro;
    const conta = await contaGoogleDe(env, orgId, Number(corpo.marca_id));
    if (!conta) return json({ erro: "Esta marca ainda não está conectada ao Google (Contas conectadas → Conectar Google)." }, 409);
    try { return json({ ok: true, ...(await sincronizarConta(env, k, conta, { continuar: corpo.continuar === true })) }); }
    catch (e) {
      await env.DB.prepare("UPDATE plt_mk_google SET erro=? WHERE id=?").bind(String(e?.message || e).slice(0, 400), conta.id).run();
      return json({ erro: e.message }, 502);
    }
  }
  // Desempenho de qualquer período (7 dias a 18 meses, ou datas escolhidas), com comparação e as buscas do período.
  if (resto === "google/checagem" && metodo === "GET") {
    const conta = await contaGoogleDe(env, orgId, Number(url.searchParams.get("marca")));
    if (!conta) return json({ conectada: false });
    try { return json({ conectada: true, ...(await checagemDoPerfil(env, k, conta)) }); }
    catch (e) { return json({ conectada: true, erro: e.message }); }
  }
  if (resto === "google/desempenho" && metodo === "GET") {
    const conta = await contaGoogleDe(env, orgId, Number(url.searchParams.get("marca")));
    if (!conta) return json({ conectada: false });
    const q = n => url.searchParams.get(n) || undefined;
    try { return json({ conectada: true, ...(await desempenhoDoPeriodo(env, k, conta, { dias: q("dias"), de: q("de"), ate: q("ate"), atalho: q("atalho"), comparar: q("comparar"), meses_buscas: q("meses_buscas") })) }); }
    catch (e) { return json({ conectada: true, erro: e.message }); }
  }
  const extra = await rotasGoogleExtra(request, env, k, orgId, papel, resto, url);
  if (extra) return extra;
  return null; // outras rotas google/* ficam no marketing.js (resumo)
}

// ----- Volta do Google: /api/google/retorno?code&state (sem sessão)
export async function retornoGoogle(request, env, k) {
  await garantir(env);
  const url = new URL(request.url);
  const esc = t => String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pagina = (titulo, texto, destino) => new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} — DENIA</title><link rel="stylesheet" href="/assets/css/base.css"><script src="/assets/js/i18n.js"></script></head><body class="retorno-meta"><main><h1>${esc(titulo)}</h1><p>${esc(texto)}</p><p><a class="btn btn-primario" id="seguir" href="${esc(destino)}">Continuar</a></p></main><script src="/assets/js/retorno.js" defer></script></body></html>`, { headers: { "content-type": "text/html; charset=UTF-8" } });
  const st = await lerState(k, url.searchParams.get("state"));
  if (!st || !st.n || st.e < k.agora(env)) return pagina("Conexão expirada", "O pedido de conexão expirou. Volte à plataforma e clique em Conectar Google de novo.", "/app#/marcas");
  const reg = await lerNonce(env, k, st.n);
  if (!reg || reg.locais || reg.o !== st.o || reg.u !== st.u) return pagina("Conexão expirada", "Este pedido de conexão já foi usado ou expirou. Clique em Conectar Google de novo.", "/app#/marcas");
  if (url.searchParams.get("error")) return pagina("Conexão cancelada", "A conexão com o Google foi cancelada. Nada foi alterado.", "/app#/marcas");
  const code = String(url.searchParams.get("code") || "");
  if (!code) return pagina("Conexão não concluída", "O Google não devolveu a autorização. Tente de novo.", "/app#/marcas");
  try {
    const t = await trocarToken(env, { grant_type: "authorization_code", code, redirect_uri: baseDe(request, env) + "/api/google/retorno" });
    if (!t.refresh_token) return pagina("Conexão não concluída", "O Google não liberou o acesso permanente. Em myaccount.google.com → Segurança → Apps de terceiros, remova o acesso da DENIA e conecte de novo.", "/app#/marcas");
    const contas = (await chamar("GET", `${API_CONTAS}/accounts?pageSize=20`, t.access_token)).accounts || [];
    const locais = [];
    for (const c of contas.slice(0, 20)) {
      const ls = (await chamar("GET", `${API_INFO}/${c.name}/locations?readMask=name,title,storefrontAddress&pageSize=100`, t.access_token).catch(() => ({}))).locations || [];
      for (const l of ls) {
        const a = l.storefrontAddress || {};
        locais.push({ conta: c.name, local: l.name, titulo: String(l.title || l.name).slice(0, 120), endereco: [...(a.addressLines || []), a.sublocality, a.locality].filter(Boolean).join(", ").slice(0, 200) });
      }
    }
    if (!locais.length) return pagina("Nenhum perfil encontrado", "A conta do Google usada não administra nenhum perfil de empresa. Entre com a conta que é proprietária ou administradora do perfil no Google Meu Negócio.", "/app#/marcas");
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("google_n_" + st.n, await k.cifrar(env, JSON.stringify({ ...reg, refresh: t.refresh_token, escopos: String(t.scope || ESCOPO).slice(0, 500), locais, e: k.agora(env) + VALIDADE_STATE_MS }))).run();
    return pagina("Quase pronto", "Conta do Google autorizada. Agora escolha, na plataforma, o perfil desta marca.", `/app#/marcas/google-${st.n}`);
  } catch (e) {
    console.error("google retorno", e?.message);
    return pagina("Conexão não concluída", e.message || "Não foi possível falar com o Google. Tente de novo.", "/app#/marcas");
  }
}

// ----- Publicação de post no perfil (texto + foto + botão)
export function semTelefone(t) {
  const fone = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4}\b/g;
  return String(t || "").split("\n").map(l => {
    if (l.search(fone) < 0) return l;
    const r = l.replace(fone, "").replace(/\s{2,}/g, " ").trim();
    // Linha que era só o contato ("WhatsApp: …", "Chame já: …") some inteira.
    return /^[^\p{L}]*$/u.test(r) || /[:–-]$/.test(r) || r.length < 4 ? null : r;
  }).filter(l => l !== null).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
export async function publicarGoogle(env, k, conta, p, imagem, video) {
  const token = await tokenDa(env, k, conta);
  // Vídeo: vai para a galeria de vídeos do perfil (o Google não aceita vídeo dentro do post pela API); o post sai com a capa.
  let videoId = null;
  if (video?.url) { const v = await chamar("POST", `${API_V4}/${caminhoV4(conta)}/media`, token, { mediaFormat: "VIDEO", locationAssociation: { category: "ADDITIONAL" }, sourceUrl: video.url }); videoId = v.name || null; }
  const marca = await env.DB.prepare("SELECT site, idioma FROM plt_mk_marcas WHERE id=?").bind(p.marca_id).first();
  // O Google recusa posts com telefone no texto: o número sai (o botão "Ligar" do post já leva ao telefone do perfil).
  const resumo = semTelefone([p.legenda, p.chamada].map(x => String(x || "").trim()).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join("\n\n")).slice(0, 1500);
  if (!resumo) throw new Error("O post do Google precisa de texto (a legenda está vazia).");
  const corpo = { languageCode: IDIOMA_GOOGLE[marca?.idioma] || "pt-BR", summary: resumo, topicType: "STANDARD" };
  if (imagem) corpo.media = [{ mediaFormat: "PHOTO", sourceUrl: imagem }];
  const site = String(marca?.site || "").trim();
  corpo.callToAction = /^https?:\/\//i.test(site) ? { actionType: "LEARN_MORE", url: site } : { actionType: "CALL" };
  const r = await chamar("POST", `${API_V4}/${caminhoV4(conta)}/localPosts`, token, corpo);
  return { id: r.name || "google", link: r.searchUrl || null, ...(videoId ? { video: videoId } : {}) };
}

// ----- Avaliações: busca no Google e grava (as novas ficam "sem resposta" para a DENIA sugerir).
// Busca as avaliações em partes (até `paginas` páginas de 50 por vez): perfis com milhares de avaliações são lidos
// em várias chamadas seguidas, continuando de onde parou (sync_token). Grava em poucas consultas (lotes em JSON),
// para não estourar o limite de consultas por execução do banco (D1). Numa leitura completa, o que não apareceu
// mais no Google é marcado como removido (por exemplo, depois de uma denúncia aceita).
async function sincronizarAvaliacoes(env, k, conta, token, { paginas = 20, continuar = false, rapida = false } = {}) {
  const agoraMs = k.agora(env);
  let pagina = continuar && conta.sync_token ? conta.sync_token : "", completo = false, info = {};
  const inicioPassada = continuar && conta.sync_token ? Number(conta.sync_inicio_ms || agoraMs) : agoraMs;
  const doGoogle = [];
  for (let i = 0; i < paginas; i++) {
    const d = await chamar("GET", `${API_V4}/${caminhoV4(conta)}/reviews?pageSize=50${pagina ? "&pageToken=" + encodeURIComponent(pagina) : ""}`, token);
    if (d.totalReviewCount != null) info = { total: Number(d.totalReviewCount), media: d.averageRating != null ? Number(d.averageRating) : null };
    for (const r of d.reviews || []) doGoogle.push({
      id: String(r.reviewId), autor: String(r.reviewer?.displayName || "Cliente").slice(0, 120), nota: ESTRELAS[r.starRating] || 0,
      texto: String(r.comment || "").slice(0, 3000), data: String(r.createTime || "").slice(0, 10) || null, r: r.reviewReply?.comment ? String(r.reviewReply.comment).slice(0, 4000) : null
    });
    pagina = d.nextPageToken || "";
    if (!pagina) { completo = true; break; }
  }
  const ids = doGoogle.map(r => r.id);
  const ja = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const r = (await env.DB.prepare("SELECT google_id, resposta, removida_ms, nota, texto FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? AND google_id IN (SELECT value FROM json_each(?))").bind(conta.org_id, conta.marca_id, JSON.stringify(ids.slice(i, i + 400))).all())?.results || [];
    for (const a of r) ja.set(a.google_id, a);
  }
  const novas = doGoogle.filter(r => !ja.has(r.id));
  const mudouResposta = doGoogle.filter(r => ja.has(r.id) && (ja.get(r.id).resposta || null) !== (r.r || null));
  // O cliente pode editar a avaliação no Google (nota ou texto): atualiza e manda ler de novo.
  const editadas = doGoogle.filter(r => ja.has(r.id) && (Number(ja.get(r.id).nota) !== r.nota || String(ja.get(r.id).texto || "") !== r.texto));
  const st = [];
  for (let i = 0; i < novas.length; i += 150) {
    st.push(env.DB.prepare(`INSERT OR IGNORE INTO plt_mk_avaliacoes(org_id,marca_id,autor,nota,texto,data,resposta,status,criado_ms,google_id,visto_ms)
      SELECT ?, ?, json_extract(value,'$.autor'), json_extract(value,'$.nota'), json_extract(value,'$.texto'), json_extract(value,'$.data'), json_extract(value,'$.r'),
        CASE WHEN json_extract(value,'$.r') IS NULL THEN 'PENDENTE' ELSE 'RESPONDIDA' END, ?, json_extract(value,'$.id'), ? FROM json_each(?)`)
      .bind(conta.org_id, conta.marca_id, agoraMs, agoraMs, JSON.stringify(novas.slice(i, i + 150))));
  }
  // Resposta publicada ou apagada direto no Google: acompanha.
  for (let i = 0; i < mudouResposta.length; i += 150) st.push(env.DB.prepare(`UPDATE plt_mk_avaliacoes SET
      resposta=(SELECT json_extract(value,'$.r') FROM json_each(?1) WHERE json_extract(value,'$.id')=plt_mk_avaliacoes.google_id),
      status=CASE WHEN (SELECT json_extract(value,'$.r') FROM json_each(?1) WHERE json_extract(value,'$.id')=plt_mk_avaliacoes.google_id) IS NULL THEN 'PENDENTE' ELSE 'RESPONDIDA' END
      WHERE org_id=?2 AND marca_id=?3 AND google_id IN (SELECT json_extract(value,'$.id') FROM json_each(?1))`).bind(JSON.stringify(mudouResposta.slice(i, i + 150).map(r => ({ id: r.id, r: r.r }))), conta.org_id, conta.marca_id));
  for (let i = 0; i < editadas.length; i += 150) st.push(env.DB.prepare(`UPDATE plt_mk_avaliacoes SET
      nota=(SELECT json_extract(value,'$.nota') FROM json_each(?1) WHERE json_extract(value,'$.id')=plt_mk_avaliacoes.google_id),
      texto=(SELECT json_extract(value,'$.texto') FROM json_each(?1) WHERE json_extract(value,'$.id')=plt_mk_avaliacoes.google_id),
      analise=NULL, triagem=NULL
      WHERE org_id=?2 AND marca_id=?3 AND google_id IN (SELECT json_extract(value,'$.id') FROM json_each(?1))`).bind(JSON.stringify(editadas.slice(i, i + 150).map(r => ({ id: r.id, nota: r.nota, texto: r.texto }))), conta.org_id, conta.marca_id));
  // Vistas agora no Google: não estão removidas.
  for (let i = 0; i < ids.length; i += 400) st.push(env.DB.prepare("UPDATE plt_mk_avaliacoes SET visto_ms=?, removida_ms=NULL WHERE org_id=? AND marca_id=? AND google_id IN (SELECT value FROM json_each(?))").bind(agoraMs, conta.org_id, conta.marca_id, JSON.stringify(ids.slice(i, i + 400))));
  if (!rapida) st.push(env.DB.prepare("UPDATE plt_mk_google SET sync_token=?, sync_inicio_ms=?, completo_ms=COALESCE(?, completo_ms) WHERE id=?").bind(completo ? null : pagina, completo ? null : inicioPassada, completo ? agoraMs : null, conta.id));
  if (info.total != null) st.push(env.DB.prepare("UPDATE plt_mk_google SET total_google=?, media_google=? WHERE id=?").bind(info.total, info.media, conta.id));
  if (st.length) await env.DB.batch(st);
  let removidas = 0;
  if (completo) {
    // Leitura completa (do começo ao fim): o que não foi visto nesta passada saiu do Google.
    const r = await env.DB.prepare("UPDATE plt_mk_avaliacoes SET removida_ms=? WHERE org_id=? AND marca_id=? AND google_id IS NOT NULL AND removida_ms IS NULL AND (visto_ms IS NULL OR visto_ms < ?)").bind(agoraMs, conta.org_id, conta.marca_id, inicioPassada).run();
    removidas = Number(r?.meta?.changes || 0);
  }
  return { novas: novas.length, total: info.total ?? doGoogle.length, lidas: doGoogle.length, removidas, completo };
}
// ---------------------------------------------------------------------------
// Checagem do perfil (como o GBP Check): o que falta preencher para o perfil ficar 100% no Google.
// Só lê — nada é alterado no Google. Cada item tem peso, situação e o que fazer.
// ---------------------------------------------------------------------------
// Feriados nacionais do Brasil (fixos + os que dependem da Páscoa).
function feriadosNacionais(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const pascoa = Date.UTC(ano, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1), dia = 86400000;
  const fixos = [["Confraternização Universal", 1, 1], ["Tiradentes", 4, 21], ["Dia do Trabalho", 5, 1], ["Independência", 9, 7], ["Nossa Senhora Aparecida", 10, 12], ["Finados", 11, 2], ["Proclamação da República", 11, 15], ["Consciência Negra", 11, 20], ["Natal", 12, 25]];
  return [...fixos.map(([nome, mes, d2]) => ({ nome, ms: Date.UTC(ano, mes - 1, d2) })), { nome: "Carnaval", ms: pascoa - 47 * dia }, { nome: "Sexta-feira Santa", ms: pascoa - 2 * dia }, { nome: "Corpus Christi", ms: pascoa + 60 * dia }].sort((x, y) => x.ms - y.ms);
}
export function avaliarPerfil({ info = {}, midias = [], posts = [], avaliacoes = {}, atributos = [], agoraMs = Date.now(), postsErro = "", postsDenia = { ultimos7: 0, ultimos30: 0, agendados: 0 } }) {
  const itens = [];
  const conferir = (grupo, chave, titulo, detalhe, dica) => itens.push({ grupo, chave, titulo, max: 0, pontos: 0, ok: "conferir", detalhe, dica });
  const add = (grupo, chave, titulo, max, pontos, detalhe, dica) => itens.push({ grupo, chave, titulo, max, pontos: Math.max(0, Math.min(max, Math.round(pontos * 10) / 10)), ok: pontos >= max ? "ok" : pontos > 0 ? "parcial" : "falta", detalhe, dica });
  const end = info.storefrontAddress || {};
  const atende = Boolean(info.serviceArea && (info.serviceArea.places?.placeInfos?.length || info.serviceArea.regionCode));
  const titulo = String(info.title || "").trim();
  add("Informações", "nome", "Nome da empresa", 5, titulo ? 5 : 0, titulo || "sem nome", titulo ? "" : "Coloque o nome real da empresa (sem palavras-chave extras, o Google pode suspender).");
  const cat1 = info.categories?.primaryCategory?.displayName, extras = (info.categories?.additionalCategories || []).length;
  add("Informações", "categoria", "Categoria principal", 8, cat1 ? 8 : 0, cat1 || "sem categoria", cat1 ? "" : "Escolha a categoria principal: é o que mais pesa para aparecer nas buscas.");
  add("Informações", "categorias_extras", "Categorias adicionais", 5, Math.min(5, extras * (5 / 3)), `${extras} de 3 recomendadas`, extras >= 3 ? "" : "Adicione até 9 categorias secundárias que descrevam os serviços (o ideal é pelo menos 3).");
  const desc = String(info.profile?.description || "").trim();
  add("Informações", "descricao", "Descrição", 8, desc.length >= 500 ? 8 : desc.length >= 250 ? 6 : desc.length ? 3 : 0, desc ? `${desc.length} de 750 letras` : "sem descrição",
    desc.length >= 500 ? "" : "Escreva uma descrição de 500 a 750 letras: o que faz, para quem, bairro/cidade e diferenciais (sem links nem telefone).");
  const tel = String(info.phoneNumbers?.primaryPhone || "").replace(/\D/g, "");
  add("Informações", "telefone", "Telefone com DDD", 6, tel.length >= 10 ? 6 : tel ? 3 : 0, info.phoneNumbers?.primaryPhone || "sem telefone", tel.length >= 10 ? "" : "Coloque o telefone principal completo, com DDD.");
  const temRua = (end.addressLines || []).some(x => String(x).trim()), cep = String(end.postalCode || "").replace(/\D/g, "");
  const ptsEnd = atende && !temRua ? 8 : (temRua ? 3 : 0) + (end.locality ? 1.5 : 0) + (end.administrativeArea ? 1 : 0) + (cep.length === 8 ? 2.5 : 0);
  add("Informações", "endereco", "Endereço completo com CEP", 8, ptsEnd, temRua ? [...(end.addressLines || []), end.sublocality, end.locality, end.administrativeArea, end.postalCode].filter(Boolean).join(", ") : atende ? "atende na região (sem endereço público)" : "sem endereço",
    ptsEnd >= 8 ? "" : !temRua && !atende ? "Coloque o endereço completo (rua, número, bairro, cidade, estado e CEP) ou a área de atendimento." : cep.length !== 8 ? "Falta o CEP (8 números) no endereço." : "Complete cidade e estado no endereço.");
  const site = String(info.websiteUri || "").trim();
  add("Informações", "site", "Site", 6, site ? 6 : 0, site || "sem site", site ? "" : "Coloque o site (ou o link do Instagram/WhatsApp, se não tiver site).");
  const periodos = info.regularHours?.periods || [];
  const dias = new Set(periodos.map(x => x.openDay)).size;
  add("Horários", "horario", "Horário de funcionamento", 8, periodos.length ? 8 : 0, periodos.length ? `${dias} dia(s) da semana` : "sem horário", periodos.length ? "" : "Coloque o horário de cada dia: perfis sem horário aparecem menos e confundem o cliente.");
  // Feriados: só conta como falta quando um feriado nacional está chegando (14 dias) e o Google não tem horário para ele.
  const diaMs = x => x && x.year ? Date.UTC(x.year, (x.month || 1) - 1, x.day || 1) : 0;
  const periodosEsp = (info.specialHours?.specialHourPeriods || []).map(x => ({ ini: diaMs(x.startDate), fim: diaMs(x.endDate) || diaMs(x.startDate) })).filter(x => x.ini);
  const hoje = Math.floor((agoraMs - 3 * 3600000) / 86400000) * 86400000;
  const futuros = periodosEsp.filter(x => x.fim >= hoje);
  const dataBr = ms => new Date(ms).toISOString().slice(5, 10).split("-").reverse().join("/");
  const proximos = feriadosNacionais(new Date(hoje).getUTCFullYear()).concat(feriadosNacionais(new Date(hoje).getUTCFullYear() + 1)).filter(f => f.ms >= hoje && f.ms <= hoje + 14 * 86400000);
  const semHorario = proximos.filter(f => !periodosEsp.some(x => f.ms >= x.ini && f.ms <= x.fim));
  const marcadas = futuros.length ? `o Google tem ${futuros.length} data(s) especial(is) marcada(s): ${futuros.slice(0, 6).map(x => dataBr(x.ini)).join(", ")}` : periodosEsp.length ? `o Google só tem datas que já passaram (última: ${dataBr(Math.max(...periodosEsp.map(x => x.ini)))})` : "o Google não informou nenhuma data especial";
  if (semHorario.length) add("Horários", "feriados", "Horários de feriados", 3, 0, `${marcadas}; falta ${semHorario.map(f => `${f.nome} (${dataBr(f.ms)})`).join(", ")}`, "Marque no Google o horário (ou fechado) dos feriados que estão chegando.");
  else add("Horários", "feriados", "Horários de feriados", 3, 3, proximos.length ? `${marcadas}; próximos feriados cobertos` : `${marcadas}; nenhum feriado nacional nos próximos 14 dias`, "");
  const fotos = midias.filter(m => m.mediaFormat === "PHOTO"), videos = midias.filter(m => m.mediaFormat === "VIDEO");
  const cat = c => midias.some(m => m.locationAssociation?.category === c);
  add("Fotos e vídeos", "fotos", "Fotos (mínimo 3, ideal 10+)", 10, fotos.length >= 10 ? 10 : fotos.length >= 3 ? 7 : fotos.length * 2, `${fotos.length} foto(s)`, fotos.length >= 10 ? "" : fotos.length >= 3 ? "Chegue a 10 fotos ou mais: fachada, interior, equipe e serviços/produtos." : `Faltam ${3 - fotos.length} foto(s) para o mínimo de 3.`);
  add("Fotos e vídeos", "logo", "Logo", 3, cat("PROFILE") || cat("LOGO") ? 3 : 0, cat("PROFILE") || cat("LOGO") ? "tem logo" : "sem logo", cat("PROFILE") || cat("LOGO") ? "" : "Envie a logo (foto de perfil) quadrada.");
  add("Fotos e vídeos", "capa", "Foto de capa", 3, cat("COVER") ? 3 : 0, cat("COVER") ? "tem capa" : "sem capa", cat("COVER") ? "" : "Escolha uma foto de capa bonita da fachada ou do ambiente.");
  add("Fotos e vídeos", "videos", "Vídeos (mínimo 3)", 7, Math.min(7, videos.length * (7 / 3)), `${videos.length} vídeo(s)`, videos.length >= 3 ? "" : `Faltam ${3 - videos.length} vídeo(s) curtos (até 30 s): ambiente, atendimento, um serviço sendo feito.`);
  const total = Number(avaliacoes.total || 0), mediaNota = Number(avaliacoes.media || 0), semResp = Number(avaliacoes.sem_resposta || 0), lidas = Number(avaliacoes.lidas || 0);
  add("Avaliações", "avaliacoes", "Avaliações (mínimo 5)", 8, total >= 5 ? 8 : total * 1.6, `${total} avaliação(ões)${total ? `, nota ${String(Math.round(mediaNota * 10) / 10).replace(".", ",")}` : ""}`, total >= 5 ? (mediaNota && mediaNota < 4.5 ? "A nota está abaixo de 4,5: peça avaliação aos clientes satisfeitos logo após o atendimento." : "") : `Faltam ${5 - total} avaliação(ões) para o mínimo de 5. Mande o link de avaliação para clientes satisfeitos.`);
  const respondidas = lidas ? (lidas - semResp) / lidas : 1;
  add("Avaliações", "respostas", "Avaliações respondidas", 5, lidas ? 5 * respondidas : total ? 0 : 5, lidas ? `${lidas - semResp} de ${lidas} recentes respondidas` : "sem avaliações", semResp ? `Responda as ${semResp} avaliação(ões) sem resposta (a DENIA sugere as respostas em Avaliações).` : "");
  // Posts: o que o Google devolve + o que a DENIA publicou no perfil. Se o Google não deixou ler, não chuta: pede para conferir.
  const doGoogle = d => posts.filter(p => Date.parse(p.createTime || p.updateTime || 0) >= agoraMs - d * 86400000).length;
  const recentes = Math.max(doGoogle(7), postsDenia.ultimos7 || 0), mes = Math.max(doGoogle(30), postsDenia.ultimos30 || 0);
  const agend = postsDenia.agendados ? `; ${postsDenia.agendados} programado(s) pela DENIA` : "";
  if (postsErro && !mes) conferir("Atividade", "posts", "Posts recentes", `o Google não deixou ler os posts agora (${postsErro})${agend}`, "Não entra na nota. Toque em Checar de novo daqui a pouco; se continuar, reconecte o Google.");
  else add("Atividade", "posts", "Posts recentes", 4, recentes ? 4 : mes ? 2 : 0, (recentes ? `${recentes} nos últimos 7 dias` : mes ? `${mes} nos últimos 30 dias` : "o Google não mostra nenhum post no último mês") + agend, recentes ? "" : "Publique pelo menos 1 post por semana (novidade, oferta ou evento). A DENIA cria e publica em Posts e imagens.");
  const aberto = !info.openInfo?.status || info.openInfo.status === "OPEN";
  add("Atividade", "status", "Perfil aberto", 2, aberto ? 2 : 0, aberto ? "aberto" : info.openInfo.status === "CLOSED_TEMPORARILY" ? "fechado temporariamente" : "fechado", aberto ? "" : "O perfil está marcado como fechado: reabra se a empresa está funcionando.");
  const abertura = info.openInfo?.openingDate;
  add("Atividade", "abertura", "Data de abertura", 1, abertura?.year ? 1 : 0, abertura?.year ? `${String(abertura.month || 1).padStart(2, "0")}/${abertura.year}` : "sem data", abertura?.year ? "" : "Coloque o mês e o ano em que a empresa abriu.");
  add("Atividade", "atributos", "Atributos (Wi-Fi, acessibilidade, pagamentos…)", 2, Math.min(2, atributos.length * (2 / 3)), `${atributos.length} marcado(s)`, atributos.length >= 3 ? "" : "Marque os atributos que valem para a empresa: formas de pagamento, acessibilidade, Wi-Fi, estacionamento…");
  const max = itens.reduce((t, x) => t + x.max, 0), pts = itens.reduce((t, x) => t + x.pontos, 0);
  return { nota: Math.round((pts / max) * 100), itens, faltam: itens.filter(x => x.ok === "parcial" || x.ok === "falta").length, conferir: itens.filter(x => x.ok === "conferir").length };
}
// Dados do perfil do Google para completar o cadastro (só o que estiver vazio): logo, categoria, cidade,
// telefone, site, horários e a descrição (a IA tira dela o tom de voz, o público e os diferenciais).
const DIAS_GOOGLE = { MONDAY: "seg", TUESDAY: "ter", WEDNESDAY: "qua", THURSDAY: "qui", FRIDAY: "sex", SATURDAY: "sáb", SUNDAY: "dom" };
async function preencherPeloGoogle(env, k, conta) {
  const token = await tokenDa(env, k, conta);
  const [info, midias] = await Promise.all([
    chamar("GET", `${API_INFO}/${conta.local_nome}?readMask=title,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,profile,metadata`, token),
    chamar("GET", `${API_V4}/${caminhoV4(conta)}/media?pageSize=100`, token).then(d => d.mediaItems || []).catch(() => [])
  ]);
  const hm = t => t ? `${String(t.hours || 0).padStart(2, "0")}:${String(t.minutes || 0).padStart(2, "0")}` : "";
  const horarios = (info.regularHours?.periods || []).map(x => `${DIAS_GOOGLE[x.openDay] || x.openDay} ${hm(x.openTime)}-${hm(x.closeTime)}`).join(", ");
  const end = info.storefrontAddress || {};
  const logos = ["LOGO", "PROFILE"].flatMap(cat => midias.filter(m => m.locationAssociation?.category === cat && m.mediaFormat !== "VIDEO").map(m => m.googleUrl));
  const { preencherMarca } = await import("./marketing.js");
  return preencherMarca(env, conta.org_id, conta.marca_id, {
    segmento: info.categories?.primaryCategory?.displayName, cidade: [end.sublocality, end.locality, end.administrativeArea].filter(Boolean).join(" — "),
    whatsapp: info.phoneNumbers?.primaryPhone, site: info.websiteUri, google: info.metadata?.mapsUri || info.title, horarios,
    sobre: info.profile?.description || "", logos
  });
}
const NOMES_CAMPO_GBP = { title: "nome", phoneNumbers: "telefone", websiteUri: "site", regularHours: "horário", specialHours: "horário de feriado", categories: "categorias", storefrontAddress: "endereço", profile: "descrição", serviceArea: "área de atendimento", openInfo: "aberto/fechado", latlng: "ponto no mapa" };
export async function situacaoDoPerfil(env, k, conta) {
  const token = await tokenDa(env, k, conta);
  const campos = "title,phoneNumbers,websiteUri,regularHours,specialHours,categories,storefrontAddress,profile,serviceArea,openInfo";
  const [atual, google, voz] = await Promise.all([
    chamar("GET", `${API_INFO}/${conta.local_nome}?readMask=${campos},metadata`, token),
    chamar("GET", `${API_INFO}/${conta.local_nome}:getGoogleUpdated?readMask=${campos}`, token).catch(e => ({ erro: e.message })),
    chamar("GET", `https://mybusinessverifications.googleapis.com/v1/${conta.local_nome}/VoiceOfMerchantState`, token).catch(e => ({ erro: e.message }))]);
  const diff = String(google?.diffMask || "").split(",").map(x => x.trim()).filter(Boolean);
  const pend = String(google?.pendingMask || "").split(",").map(x => x.trim()).filter(Boolean);
  const nome = c => NOMES_CAMPO_GBP[c.split(".")[0]] || c;
  const mudancas = [...new Set(diff.map(c => c.split(".")[0]))].map(c => ({ campo: nome(c), no_google: resumoCampo(google?.location?.[c]), no_perfil: resumoCampo(atual?.[c]) }));
  let estadoV = "desconhecido", motivo = "";
  if (voz?.erro) { estadoV = "desconhecido"; motivo = /not been used|disabled/i.test(voz.erro) ? "Ative a \"My Business Verifications API\" no Google Cloud para a DENIA ler a situação." : voz.erro; }
  else if (voz?.hasVoiceOfMerchant) estadoV = "ativo";
  else if (voz?.complyWithGuidelines) { estadoV = "suspenso"; motivo = voz.complyWithGuidelines.recommendationReason === "BUSINESS_LOCATION_SUSPENDED" ? "Perfil suspenso pelo Google por não seguir as regras." : "O Google pede para o perfil seguir as diretrizes."; }
  else if (voz?.verify) { estadoV = "nao_verificado"; motivo = "O perfil ainda não foi verificado no Google."; }
  else if (voz?.resolveOwnershipConflict) { estadoV = "conflito"; motivo = "Outra pessoa também diz ser dona do perfil."; }
  else if (voz?.waitForVoiceOfMerchant) { estadoV = "aguardando"; motivo = "O Google está analisando o perfil (pode levar alguns dias)."; }
  return { situacao: estadoV, motivo, mudancas_do_google: mudancas, pendentes: [...new Set(pend.map(c => nome(c)))], pode_editar: Boolean(atual?.metadata?.canModifyServiceList ?? true), erro_alteracoes: google?.erro || null };
}
function resumoCampo(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, 120);
  if (v.primaryPhone) return v.primaryPhone;
  if (v.description) return String(v.description).slice(0, 120) + (String(v.description).length > 120 ? "…" : "");
  if (v.primaryCategory) return v.primaryCategory.displayName || "";
  if (v.periods) return `${v.periods.length} período(s)`;
  if (v.specialHourPeriods) return `${v.specialHourPeriods.length} data(s)`;
  if (v.addressLines) return [...v.addressLines, v.locality].filter(Boolean).join(", ");
  if (v.status) return v.status;
  return JSON.stringify(v).slice(0, 120);
}
export async function checagemDoPerfil(env, k, conta) {
  const token = await tokenDa(env, k, conta);
  const campos = "title,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,specialHours,serviceArea,profile,openInfo,metadata";
  let postsErro = "";
  const [info, midias, posts, rev, atributos] = await Promise.all([
    chamar("GET", `${API_INFO}/${conta.local_nome}?readMask=${campos}`, token),
    (async () => { const lista = []; let pg = ""; for (let i = 0; i < 5; i++) { const d = await chamar("GET", `${API_V4}/${caminhoV4(conta)}/media?pageSize=100${pg ? "&pageToken=" + encodeURIComponent(pg) : ""}`, token); lista.push(...(d.mediaItems || [])); if (!d.nextPageToken) break; pg = d.nextPageToken; } return lista; })().catch(() => []),
    (async () => { const lista = []; let pg = ""; for (let i = 0; i < 3; i++) { const d = await chamar("GET", `${API_V4}/${caminhoV4(conta)}/localPosts?pageSize=100${pg ? "&pageToken=" + encodeURIComponent(pg) : ""}`, token); lista.push(...(d.localPosts || [])); if (!d.nextPageToken) break; pg = d.nextPageToken; } return lista; })().catch(e => { postsErro = String(e?.message || "erro").slice(0, 160); return []; }),
    chamar("GET", `${API_V4}/${caminhoV4(conta)}/reviews?pageSize=50`, token).catch(() => ({})),
    chamar("GET", `${API_INFO}/${conta.local_nome}/attributes`, token).then(d => (d.attributes || []).filter(a => (a.values || []).some(Boolean) || (a.uriValues || []).length)).catch(() => [])
  ]);
  const lidas = (rev.reviews || []).length, semResposta = (rev.reviews || []).filter(r => !r.reviewReply).length;
  const agoraMs = k.agora(env), hojeBr = new Date(agoraMs - 3 * 3600000).toISOString().slice(0, 10);
  const pd = await env.DB.prepare(`SELECT SUM(CASE WHEN status='PUBLICADO' AND atualizado_ms>=? THEN 1 ELSE 0 END) u7, SUM(CASE WHEN status='PUBLICADO' AND atualizado_ms>=? THEN 1 ELSE 0 END) u30,
      SUM(CASE WHEN status='APROVADO' AND data>=? THEN 1 ELSE 0 END) ag FROM plt_mk_posts WHERE org_id=? AND marca_id=? AND canais LIKE '%google%'`).bind(agoraMs - 7 * 86400000, agoraMs - 30 * 86400000, hojeBr, conta.org_id, conta.marca_id).first().catch(() => null);
  const r = avaliarPerfil({ info, midias, posts, atributos, agoraMs, postsErro, postsDenia: { ultimos7: Number(pd?.u7 || 0), ultimos30: Number(pd?.u30 || 0), agendados: Number(pd?.ag || 0) }, avaliacoes: { total: Number(rev.totalReviewCount || 0), media: Number(rev.averageRating || 0), lidas, sem_resposta: semResposta } });
  return { perfil: info.title || conta.local_titulo, maps: info.metadata?.mapsUri || conta.maps_uri || null, ...r };
}

// Endereço do perfil no Google Maps (para abrir e denunciar uma avaliação).
export async function linkDoPerfil(env, k, conta) {
  if (conta.maps_uri) return conta.maps_uri;
  const token = await tokenDa(env, k, conta);
  const d = await chamar("GET", `${API_INFO}/${conta.local_nome}?readMask=metadata`, token);
  const uri = d?.metadata?.mapsUri || null;
  if (uri) await env.DB.prepare("UPDATE plt_mk_google SET maps_uri=? WHERE id=?").bind(uri, conta.id).run();
  return uri;
}

// Apaga no Google a resposta de uma avaliação.
export async function apagarRespostaGoogle(env, k, avaliacao) {
  const conta = await contaGoogleDe(env, avaliacao.org_id, avaliacao.marca_id);
  if (!conta) throw new Error("A marca não está mais conectada ao Google.");
  const token = await tokenDa(env, k, conta);
  await chamar("DELETE", `${API_V4}/${caminhoV4(conta)}/reviews/${encodeURIComponent(avaliacao.google_id)}/reply`, token);
}

// Publica no Google a resposta de uma avaliação que veio de lá.
export async function responderAvaliacaoGoogle(env, k, avaliacao, texto) {
  if (!avaliacao.google_id) return { publicada: false };
  const conta = await contaGoogleDe(env, avaliacao.org_id, avaliacao.marca_id);
  if (!conta) return { publicada: false, erro: "A marca não está mais conectada ao Google." };
  const token = await tokenDa(env, k, conta);
  await chamar("PUT", `${API_V4}/${caminhoV4(conta)}/reviews/${encodeURIComponent(avaliacao.google_id)}/reply`, token, { comment: String(texto).slice(0, 4000) });
  return { publicada: true };
}

// ----- Desempenho
// Todas as métricas diárias que o Google oferece para um perfil (as de reserva e comida só existem em alguns ramos).
const METRICAS = {
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: "maps_celular", BUSINESS_IMPRESSIONS_DESKTOP_MAPS: "maps_computador",
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: "pesquisa_celular", BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "pesquisa_computador",
  CALL_CLICKS: "ligacoes", BUSINESS_DIRECTION_REQUESTS: "rotas", WEBSITE_CLICKS: "cliques_site", BUSINESS_CONVERSATIONS: "mensagens",
  BUSINESS_BOOKINGS: "reservas", BUSINESS_FOOD_ORDERS: "pedidos_comida", BUSINESS_FOOD_MENU_CLICKS: "cliques_cardapio"
};
const METRICAS_DE_RAMO = new Set(["BUSINESS_BOOKINGS", "BUSINESS_FOOD_ORDERS", "BUSINESS_FOOD_MENU_CLICKS"]);
const DIA_MS = 86400000;
export const HISTORICO_DIAS = 540; // o Google guarda cerca de 18 meses de desempenho
const ATRASO_DIAS = 2; // e consolida os números com ~2 dias de atraso
const isoDia = d => d.toISOString().slice(0, 10);
const diaUTC = iso => new Date(iso + "T00:00:00Z");
const zerado = () => Object.fromEntries(Object.values(METRICAS).map(c => [c, 0]));
const parteData = (prefixo, d) => `${prefixo}.year=${d.getUTCFullYear()}&${prefixo}.month=${d.getUTCMonth() + 1}&${prefixo}.day=${d.getUTCDate()}`;
// Totais (visualizações = Maps + Pesquisa) a partir do detalhe por métrica.
function resumir(det) {
  const maps = det.maps_celular + det.maps_computador, pesquisa = det.pesquisa_celular + det.pesquisa_computador;
  return { visualizacoes: maps + pesquisa, buscas: pesquisa, maps, ligacoes: det.ligacoes, rotas: det.rotas, cliques_site: det.cliques_site, mensagens: det.mensagens,
    reservas: det.reservas, pedidos_comida: det.pedidos_comida, cliques_cardapio: det.cliques_cardapio,
    interacoes: det.ligacoes + det.rotas + det.cliques_site + det.mensagens + det.reservas + det.pedidos_comida + det.cliques_cardapio };
}
// Uma chamada traz todas as métricas, dia a dia, do período.
async function serieDoPeriodo(conta, token, ini, fim) {
  const pedir = nomes => chamar("GET", `${API_DESEMPENHO}/${conta.local_nome}:fetchMultiDailyMetricsTimeSeries?${nomes.map(m => "dailyMetrics=" + m).join("&")}&${parteData("dailyRange.startDate", ini)}&${parteData("dailyRange.endDate", fim)}`, token);
  let d;
  try { d = await pedir(Object.keys(METRICAS)); }
  catch { d = await pedir(Object.keys(METRICAS).filter(m => !METRICAS_DE_RAMO.has(m))); } // perfis que não aceitam as métricas de ramo
  const detalhe = zerado(), porDia = new Map();
  for (const grupo of d.multiDailyMetricTimeSeries || []) for (const s of grupo.dailyMetricTimeSeries || []) {
    const campo = METRICAS[s.dailyMetric];
    if (!campo) continue;
    for (const v of s.timeSeries?.datedValues || []) {
      const n = Number(v.value || 0);
      detalhe[campo] += n;
      if (!v.date?.year) continue;
      const chave = `${v.date.year}-${String(v.date.month).padStart(2, "0")}-${String(v.date.day).padStart(2, "0")}`;
      if (!porDia.has(chave)) porDia.set(chave, zerado());
      porDia.get(chave)[campo] += n;
    }
  }
  const diario = [];
  for (let t = diaUTC(isoDia(ini)).getTime(); t <= fim.getTime(); t += DIA_MS) {
    const data = isoDia(new Date(t)), det = porDia.get(data) || zerado();
    diario.push({ data, ...det, ...resumir(det) });
  }
  return { detalhe, totais: resumir(detalhe), diario };
}
async function metricas(conta, token, ini, fim) { return (await serieDoPeriodo(conta, token, ini, fim)).totais; }
// Buscas que levaram ao perfil: o Google só publica meses completos, então usa os meses do período até o mês passado.
async function palavrasDoPeriodo(conta, token, ini, fim, agoraMs, limite = 2000) {
  const agora = new Date(agoraMs), ultimoMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1));
  let ate = new Date(Date.UTC(fim.getUTCFullYear(), fim.getUTCMonth(), 1));
  if (ate > ultimoMes) ate = ultimoMes;
  let de = new Date(Date.UTC(ini.getUTCFullYear(), ini.getUTCMonth(), 1));
  if (de > ate) de = ate;
  const faixa = `monthlyRange.startMonth.year=${de.getUTCFullYear()}&monthlyRange.startMonth.month=${de.getUTCMonth() + 1}&monthlyRange.endMonth.year=${ate.getUTCFullYear()}&monthlyRange.endMonth.month=${ate.getUTCMonth() + 1}`;
  const todas = [];
  let pagina = "";
  // Todas as páginas (até 2.000 buscas): as menos frequentes ("menos de 15") também aparecem, como no painel do Google.
  for (let i = 0; i < 20; i++) {
    const r = await chamar("GET", `${API_DESEMPENHO}/${conta.local_nome}/searchkeywords/impressions/monthly?${faixa}&pageSize=100${pagina ? "&pageToken=" + encodeURIComponent(pagina) : ""}`, token);
    todas.push(...(r.searchKeywordsCounts || []));
    if (!r.nextPageToken) break;
    pagina = r.nextPageToken;
  }
  const lista = todas.map(x => ({ palavra: String(x.searchKeyword || ""), buscas: x.insightsValue?.value != null ? Number(x.insightsValue.value) : null, menos_de: x.insightsValue?.threshold != null ? Number(x.insightsValue.threshold) : null }))
    .filter(x => x.palavra).sort((a, b) => (b.buscas ?? b.menos_de ?? 0) - (a.buscas ?? a.menos_de ?? 0)).slice(0, limite);
  return { lista, mes_de: isoDia(de).slice(0, 7), mes_ate: isoDia(ate).slice(0, 7) };
}
async function palavrasDoMes(conta, token, agoraMs) {
  const mes = new Date(agoraMs); mes.setUTCDate(1); mes.setUTCMonth(mes.getUTCMonth() - 1);
  return (await palavrasDoPeriodo(conta, token, mes, mes, agoraMs, 15)).lista;
}
function segundaDe(ms) { const d = new Date(ms); const dia = (d.getUTCDay() + 6) % 7; d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() - dia); return d; }
// Grava as duas últimas semanas completas na aba Desempenho (o Google consolida os números com alguns dias de atraso).
async function gravarSemanas(env, k, conta, token) {
  const nota = await env.DB.prepare("SELECT AVG(nota) m, COUNT(*) n FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? AND google_id IS NOT NULL").bind(conta.org_id, conta.marca_id).first();
  for (const atras of [1, 2]) {
    const ini = segundaDe(k.agora(env)); ini.setUTCDate(ini.getUTCDate() - 7 * atras);
    const fim = new Date(ini.getTime() + 6 * 86400000);
    const t = await metricas(conta, token, ini, fim);
    const dados = { ...t, nota_media: nota?.n ? Math.round(nota.m * 10) / 10 : null, total_avaliacoes: nota?.n || 0, origem: "google" };
    await env.DB.prepare("INSERT OR REPLACE INTO plt_mk_metricas(org_id,marca_id,semana,dados,criado_ms) VALUES(?,?,?,?,?)").bind(conta.org_id, conta.marca_id, ini.toISOString().slice(0, 10), JSON.stringify(dados), k.agora(env)).run();
  }
}

// Últimos 30 dias (o Google consolida com ~2 dias de atraso) e as buscas do mês passado.
// Totais do Google num período de N dias (para o relatório geral).
export async function desempenhoDosDias(env, k, conta, dias = 30) {
  const token = await tokenDa(env, k, conta);
  const fim = new Date(k.agora(env) - ATRASO_DIAS * DIA_MS), ini = new Date(fim.getTime() - (Math.max(1, dias) - 1) * DIA_MS);
  return { de: isoDia(ini), ate: isoDia(fim), totais: await metricas(conta, token, ini, fim) };
}
export async function desempenhoAoVivo(env, k, conta) {
  const token = await tokenDa(env, k, conta);
  const fim = new Date(k.agora(env) - ATRASO_DIAS * DIA_MS), ini = new Date(fim.getTime() - 29 * DIA_MS);
  const [totais, palavras] = await Promise.all([metricas(conta, token, ini, fim), palavrasDoMes(conta, token, k.agora(env)).catch(() => [])]);
  return { perfil: conta.local_titulo, de: isoDia(ini), ate: isoDia(fim), totais, palavras };
}

// Escolhe o período pedido: "dias" (7, 30, 60…), "de"/"ate" (AAAA-MM-DD) ou os atalhos "mes" (este mês) e "mes_passado".
export function periodoPedido(agoraMs, { dias, de, ate, atalho } = {}) {
  const ultimo = diaUTC(isoDia(new Date(agoraMs - ATRASO_DIAS * DIA_MS)));
  const primeiro = new Date(ultimo.getTime() - (HISTORICO_DIAS - 1) * DIA_MS);
  const valida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(diaUTC(s));
  let ini, fim;
  if (atalho === "mes") { fim = ultimo; ini = new Date(Date.UTC(ultimo.getUTCFullYear(), ultimo.getUTCMonth(), 1)); }
  else if (atalho === "mes_passado") { const hoje = diaUTC(isoDia(new Date(agoraMs))); fim = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 0)); ini = new Date(Date.UTC(fim.getUTCFullYear(), fim.getUTCMonth(), 1)); if (fim > ultimo) fim = ultimo; }
  else if (de || ate) {
    if (!valida(de) || !valida(ate)) throw new Error("Escolha a data de início e a data de fim.");
    ini = diaUTC(de); fim = diaUTC(ate);
    if (ini > fim) [ini, fim] = [fim, ini];
  } else {
    const n = Math.min(HISTORICO_DIAS, Math.max(1, Math.round(Number(dias) || 30)));
    fim = ultimo; ini = new Date(ultimo.getTime() - (n - 1) * DIA_MS);
  }
  if (fim > ultimo) fim = ultimo;
  if (ini < primeiro) ini = primeiro;
  if (ini > fim) throw new Error(`O Google só tem números até ${isoDia(ultimo).split("-").reverse().join("/")} (ele consolida com 2 dias de atraso).`);
  return { ini, fim, primeiro, ultimo, dias: Math.round((fim - ini) / DIA_MS) + 1 };
}

// Desempenho completo de qualquer período (até 18 meses): totais, detalhe, dia a dia, comparação e buscas.
// comparar: "anterior" (mesmo tamanho, logo antes), "ano" (mesmo período do ano passado) ou "nada".
export async function desempenhoDoPeriodo(env, k, conta, pedido = {}) {
  const agora = k.agora(env);
  const per = periodoPedido(agora, pedido);
  const token = await tokenDa(env, k, conta);
  const modo = ["anterior", "ano", "nada"].includes(pedido.comparar) ? pedido.comparar : "anterior";
  let cIni = null, cFim = null;
  if (modo === "anterior") { cFim = new Date(per.ini.getTime() - DIA_MS); cIni = new Date(cFim.getTime() - (per.dias - 1) * DIA_MS); }
  if (modo === "ano") { cIni = new Date(Date.UTC(per.ini.getUTCFullYear() - 1, per.ini.getUTCMonth(), per.ini.getUTCDate())); cFim = new Date(Date.UTC(per.fim.getUTCFullYear() - 1, per.fim.getUTCMonth(), per.fim.getUTCDate())); }
  const cabe = cIni && cIni >= per.primeiro;
  const [atual, antes, palavras] = await Promise.all([
    serieDoPeriodo(conta, token, per.ini, per.fim),
    cabe ? serieDoPeriodo(conta, token, cIni, cFim).catch(() => null) : null,
    (() => {
      // Buscas por meses fechados: os N últimos meses (como o filtro do painel do Google) ou os meses do período.
      const n = Math.min(18, Math.max(0, Number(pedido.meses_buscas) || 0));
      if (!n) return palavrasDoPeriodo(conta, token, per.ini, per.fim, agora);
      const ag = new Date(agora), fimM = new Date(Date.UTC(ag.getUTCFullYear(), ag.getUTCMonth() - 1, 1)), iniM = new Date(Date.UTC(ag.getUTCFullYear(), ag.getUTCMonth() - n, 1));
      return palavrasDoPeriodo(conta, token, iniM, fimM, agora);
    })().catch(() => ({ lista: [], mes_de: null, mes_ate: null }))
  ]);
  const comparacao = modo === "nada" ? null : antes ? { modo, de: isoDia(cIni), ate: isoDia(cFim), totais: antes.totais, detalhe: antes.detalhe, diario: antes.diario }
    : { modo, indisponivel: "O Google guarda só os últimos 18 meses, então não há números para comparar com esse período." };
  return { perfil: conta.local_titulo, de: isoDia(per.ini), ate: isoDia(per.fim), dias: per.dias, primeiro_dia: isoDia(per.primeiro), ultimo_dia: isoDia(per.ultimo),
    totais: atual.totais, detalhe: atual.detalhe, diario: atual.diario, comparacao,
    palavras: palavras.lista, palavras_de: palavras.mes_de, palavras_ate: palavras.mes_ate };
}

export async function sincronizarConta(env, k, conta, { forcarDesempenho = true, completa = true, continuar = false } = {}) {
  const token = await tokenDa(env, k, conta);
  // completa: lê o perfil inteiro em partes de 20 páginas (1.000 avaliações) por chamada; rápida: só as 2 primeiras (as novas).
  const av = await sincronizarAvaliacoes(env, k, conta, token, completa ? { paginas: 20, continuar } : { paginas: 2, rapida: true });
  let desempenho = null;
  if (forcarDesempenho || !conta.desempenho_ms || conta.desempenho_ms < k.agora(env) - DESEMPENHO_A_CADA_MS) {
    try { await gravarSemanas(env, k, conta, token); desempenho = true; await env.DB.prepare("UPDATE plt_mk_google SET desempenho_ms=? WHERE id=?").bind(k.agora(env), conta.id).run(); }
    catch (e) { desempenho = false; console.error("google desempenho", e?.message); }
  }
  await env.DB.prepare("UPDATE plt_mk_google SET sincronizado_ms=?, erro=NULL WHERE id=?").bind(k.agora(env), conta.id).run();
  return { avaliacoes_novas: av.novas, avaliacoes_total: av.total, avaliacoes_lidas: av.lidas, avaliacoes_removidas: av.removidas, completo: av.completo, desempenho };
}

// Cron: a cada 10 minutos traz as avaliações novas; o desempenho, a cada 6 horas.
export async function sincronizarGooglePendentes(env, k) {
  if (!googleConfigurada(env)) return { sincronizadas: 0 };
  await garantir(env);
  const contas = (await env.DB.prepare(`SELECT g.*, (SELECT COUNT(*) FROM plt_mk_avaliacoes a WHERE a.org_id=g.org_id AND a.marca_id=g.marca_id AND a.google_id IS NOT NULL AND a.removida_ms IS NULL) AS na_denia
    FROM plt_mk_google g WHERE g.sincronizado_ms IS NULL OR g.sincronizado_ms < ? ORDER BY g.sincronizado_ms LIMIT 5`).bind(k.agora(env) - SINCRONIZAR_A_CADA_MS).all())?.results || [];
  let n = 0, completas = 0;
  for (const c of contas) {
    // Faltando avaliações (perfil grande, leitura interrompida) ou uma vez por dia: continua a leitura completa,
    // em partes, uma conta por rodada. Nas outras rodadas, só as novas.
    const faltam = c.sync_token || c.total_google == null || Number(c.na_denia) < Number(c.total_google) || !c.completo_ms || c.completo_ms < k.agora(env) - 86400000;
    const completa = faltam && completas === 0;
    if (completa) completas++;
    try { await sincronizarConta(env, k, c, { forcarDesempenho: false, completa, continuar: Boolean(completa && c.sync_token) }); n++; }
    catch (e) {
      console.error("google sync", c.id, e?.message);
      // Guarda o motivo para aparecer no painel; tenta de novo na próxima rodada.
      await env.DB.prepare("UPDATE plt_mk_google SET sincronizado_ms=?, erro=? WHERE id=?").bind(k.agora(env), String(e?.message || e).slice(0, 400), c.id).run();
    }
  }
  return { sincronizadas: n };
}

// =============================================================================
// Search Console (Google orgânico), Google Ads e concorrentes (Google Maps)
// =============================================================================
// Search Console: mesmo login do Google (escopo webmasters). Mostra cliques, impressões, CTR e posição média
//   por palavra, página, país e aparelho; inspeciona páginas (indexada ou não) e envia sitemaps.
// Google Ads: precisa do secret GOOGLE_ADS_DEVELOPER_TOKEN (o token de desenvolvedor da DENIA, aprovado pelo
//   Google) e, opcional, GOOGLE_ADS_VERSAO (padrão v25). Lê gasto, campanhas, palavras, termos de pesquisa,
//   aparelhos e horários; pausa/ativa campanhas, muda orçamento diário, adiciona palavra negativa e aplica
//   recomendações do Google.
// Concorrentes: secret GOOGLE_PLACES_API_KEY (Places API New, cobrada por consulta pelo Google).
const SC_API = "https://www.googleapis.com/webmasters/v3";
const SC_INSPECAO = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const SC_ATRASO = 3; // o Search Console consolida com ~2–3 dias
const SC_HISTORICO = 485; // 16 meses
export const adsConfigurado = env => Boolean(String(env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim());
const chavePlaces = env => String(env.GOOGLE_PLACES_API_KEY || env.GOOGLE_MAPS_API_KEY || "").trim();
export const placesConfigurado = env => Boolean(chavePlaces(env));
const versaoAds = env => (/^v\d{2}$/.test(String(env.GOOGLE_ADS_VERSAO || "").trim()) ? String(env.GOOGLE_ADS_VERSAO).trim() : "v25");
const temEscopo = (conta, e) => !conta.escopos ? e === ESCOPO : String(conta.escopos).split(/\s+/).includes(e);
const microsParaReal = m => Math.round(Number(m || 0) / 10000) / 100;

function periodoSc(agoraMs, { dias, de, ate } = {}) {
  const ultimo = diaUTC(isoDia(new Date(agoraMs - SC_ATRASO * DIA_MS)));
  const primeiro = new Date(ultimo.getTime() - (SC_HISTORICO - 1) * DIA_MS);
  const valida = x => /^\d{4}-\d{2}-\d{2}$/.test(String(x || ""));
  let ini, fim;
  if (valida(de) && valida(ate)) { ini = diaUTC(de); fim = diaUTC(ate); if (ini > fim) [ini, fim] = [fim, ini]; }
  else { const n = Math.min(SC_HISTORICO, Math.max(1, Math.round(Number(dias) || 28))); fim = ultimo; ini = new Date(ultimo.getTime() - (n - 1) * DIA_MS); }
  if (fim > ultimo) fim = ultimo;
  if (ini < primeiro) ini = primeiro;
  return { ini, fim, dias: Math.round((fim - ini) / DIA_MS) + 1, primeiro, ultimo };
}

async function consultaSc(token, site, ini, fim, dimensoes, limite, filtros) {
  const corpo = { startDate: isoDia(ini), endDate: isoDia(fim), dimensions: dimensoes, rowLimit: limite, dataState: "final" };
  if (filtros) corpo.dimensionFilterGroups = [{ filters: filtros }];
  const d = await chamar("POST", `${SC_API}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, token, corpo);
  return (d.rows || []).map(r => ({ chave: r.keys || [], cliques: r.clicks || 0, impressoes: r.impressions || 0, ctr: Math.round((r.ctr || 0) * 10000) / 100, posicao: Math.round((r.position || 0) * 10) / 10 }));
}
const somaSc = linhas => {
  const t = linhas.reduce((a, l) => ({ cliques: a.cliques + l.cliques, impressoes: a.impressoes + l.impressoes, pos: a.pos + l.posicao * l.impressoes }), { cliques: 0, impressoes: 0, pos: 0 });
  return { cliques: t.cliques, impressoes: t.impressoes, ctr: t.impressoes ? Math.round((t.cliques / t.impressoes) * 10000) / 100 : 0, posicao: t.impressoes ? Math.round((t.pos / t.impressoes) * 10) / 10 : 0 };
};
// Palavras com muitas impressões e posição 4–20 ou CTR baixo: onde um ajuste de título/conteúdo traz mais cliques.
function oportunidadesSc(palavras) {
  const ctrEsperado = p => (p <= 1.5 ? 28 : p <= 3 ? 15 : p <= 5 ? 8 : p <= 10 ? 3 : 1);
  return palavras.filter(p => p.impressoes >= 30).map(p => {
    let motivo = null;
    if (p.posicao > 3 && p.posicao <= 10) motivo = "Quase no topo: subir 1–3 posições pode multiplicar os cliques.";
    else if (p.posicao > 10 && p.posicao <= 20) motivo = "Na 2ª página: um conteúdo melhor para esta busca leva para a 1ª.";
    else if (p.ctr < ctrEsperado(p.posicao) / 2) motivo = "Aparece bem, mas poucos clicam: melhore o título e a descrição da página.";
    return motivo ? { ...p, motivo, ganho: Math.max(0, Math.round(p.impressoes * (ctrEsperado(Math.max(1, p.posicao - 3)) - p.ctr) / 100)) } : null;
  }).filter(Boolean).sort((a, b) => b.ganho - a.ganho).slice(0, 25);
}

export async function searchConsole(env, k, conta, pedido = {}) {
  if (!conta.sc_site) return { conectado: false, motivo: "SEM_SITE" };
  const token = await tokenDa(env, k, conta);
  const per = periodoSc(k.agora(env), pedido);
  const cFim = new Date(per.ini.getTime() - DIA_MS), cIni = new Date(cFim.getTime() - (per.dias - 1) * DIA_MS);
  const site = conta.sc_site;
  const [diario, palavras, paginas, paises, aparelhos, aparencia, antes, sitemaps] = await Promise.all([
    consultaSc(token, site, per.ini, per.fim, ["date"], 500),
    consultaSc(token, site, per.ini, per.fim, ["query"], 1000),
    consultaSc(token, site, per.ini, per.fim, ["page"], 250),
    consultaSc(token, site, per.ini, per.fim, ["country"], 50),
    consultaSc(token, site, per.ini, per.fim, ["device"], 5),
    consultaSc(token, site, per.ini, per.fim, ["searchAppearance"], 20).catch(() => []),
    cIni >= per.primeiro ? consultaSc(token, site, cIni, cFim, ["date"], 500).catch(() => null) : null,
    chamar("GET", `${SC_API}/sites/${encodeURIComponent(site)}/sitemaps`, token).then(d => d.sitemap || []).catch(() => [])
  ]);
  const pl = palavras.map(p => ({ ...p, palavra: p.chave[0] }));
  return {
    conectado: true, site, de: isoDia(per.ini), ate: isoDia(per.fim), dias: per.dias, primeiro_dia: isoDia(per.primeiro), ultimo_dia: isoDia(per.ultimo),
    totais: somaSc(diario), comparacao: antes ? { de: isoDia(cIni), ate: isoDia(cFim), totais: somaSc(antes), diario: antes.map(d => ({ data: d.chave[0], ...d, chave: undefined })) } : null,
    diario: diario.map(d => ({ data: d.chave[0], cliques: d.cliques, impressoes: d.impressoes, ctr: d.ctr, posicao: d.posicao })),
    palavras: pl, paginas: paginas.map(p => ({ ...p, pagina: p.chave[0] })), paises: paises.map(p => ({ ...p, pais: p.chave[0] })),
    aparelhos: aparelhos.map(p => ({ ...p, aparelho: p.chave[0] })), aparencia: aparencia.map(p => ({ ...p, tipo: p.chave[0] })),
    oportunidades: oportunidadesSc(pl),
    sitemaps: sitemaps.map(m => ({ caminho: m.path, enviado: m.lastSubmitted || null, lido: m.lastDownloaded || null, pendente: Boolean(m.isPending), erros: Number(m.errors || 0), avisos: Number(m.warnings || 0), urls: (m.contents || []).reduce((s, c) => s + Number(c.submitted || 0), 0) }))
  };
}

// ----- Google Ads
async function chamarAds(env, token, metodo, caminho, corpo, gerente) {
  const inicio = Date.now(), org = orgDoToken.get(token) || 0;
  const r = await fetch(`https://googleads.googleapis.com/${versaoAds(env)}/${caminho}`, {
    method: metodo, signal: AbortSignal.timeout(30000),
    headers: { authorization: "Bearer " + token, "developer-token": String(env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim(), ...(gerente ? { "login-customer-id": String(gerente) } : {}), ...(corpo ? { "content-type": "application/json" } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  registrarUso(org, "google", "ads", `${metodo} ${caminho.split("/").pop().split(":").pop()}`.slice(0, 50), { erro: !r.ok, limitada: r.status === 429, ms: Date.now() - inicio });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const det = JSON.stringify(d);
    let msg = (d?.error?.details?.[0]?.errors?.[0]?.message) || d?.error?.message || `HTTP ${r.status}`;
    if (/DEVELOPER_TOKEN_NOT_APPROVED|only approved for use with test accounts/i.test(det)) msg = "O token de desenvolvedor da DENIA ainda está em modo de teste no Google Ads: só funciona com contas de teste até o Google aprovar o acesso básico.";
    else if (/USER_PERMISSION_DENIED/i.test(det)) msg = "A conta do Google usada não tem acesso a esta conta do Google Ads (ou falta escolher a conta gerente/MCC).";
    else if (/SCOPE_INSUFFICIENT|insufficient.*scope/i.test(det)) msg = "Falta a permissão do Google Ads nesta conexão. Toque em Ligar o Google Ads e marque a caixa do Google Ads.";
    else if (r.status === 404 && /version|not found/i.test(det)) msg = `A versão ${versaoAds(env)} da API do Google Ads não está disponível. Ajuste o secret GOOGLE_ADS_VERSAO para a versão atual.`;
    const e = new Error("Google Ads: " + String(msg).slice(0, 300)); e.status = r.status; throw e;
  }
  return d;
}
async function gaql(env, token, cliente, gerente, consulta) {
  const d = await chamarAds(env, token, "POST", `customers/${cliente}/googleAds:search`, { query: consulta }, gerente);
  return d.results || [];
}
const entre = (ini, fim) => `segments.date BETWEEN '${isoDia(ini)}' AND '${isoDia(fim)}'`;
const metricasAds = m => {
  const custo = microsParaReal(m?.costMicros), cliques = Number(m?.clicks || 0), imp = Number(m?.impressions || 0), conv = Math.round(Number(m?.conversions || 0) * 100) / 100;
  return { custo, cliques, impressoes: imp, conversoes: conv, valor_conversoes: Math.round(Number(m?.conversionsValue || 0) * 100) / 100,
    ctr: imp ? Math.round((cliques / imp) * 10000) / 100 : 0, cpc: cliques ? Math.round((custo / cliques) * 100) / 100 : 0, custo_conversao: conv ? Math.round((custo / conv) * 100) / 100 : 0 };
};
export async function contasAds(env, k, conta) {
  const token = await tokenDa(env, k, conta);
  const d = await chamarAds(env, token, "GET", "customers:listAccessibleCustomers");
  const ids = (d.resourceNames || []).map(n => n.split("/")[1]).slice(0, 25);
  const lista = [];
  for (const id of ids) {
    const r = await gaql(env, token, id, null, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager, customer.test_account FROM customer LIMIT 1").catch(e => ({ erro: e.message }));
    if (r.erro) { lista.push({ id, nome: `Conta ${id}`, erro: r.erro }); continue; }
    const c = r[0]?.customer || {};
    lista.push({ id, nome: c.descriptiveName || `Conta ${id}`, moeda: c.currencyCode || "", gerente: Boolean(c.manager), teste: Boolean(c.testAccount) });
    // Conta gerente (MCC): lista as contas de anúncio debaixo dela.
    if (c.manager) {
      const filhos = await gaql(env, token, id, id, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager FROM customer_client WHERE customer_client.level <= 2").catch(() => []);
      for (const f of filhos) { const cc = f.customerClient || {}; if (!cc.manager && String(cc.id) !== id) lista.push({ id: String(cc.id), nome: cc.descriptiveName || `Conta ${cc.id}`, moeda: cc.currencyCode || "", gerente: false, via: id }); }
    }
  }
  return lista;
}
export async function relatorioAds(env, k, conta, pedido = {}) {
  if (!conta.ads_cliente) return { conectado: false };
  const token = await tokenDa(env, k, conta);
  const cli = conta.ads_cliente, ger = conta.ads_gerente || null;
  const per = periodoSc(k.agora(env) + (SC_ATRASO - 0) * DIA_MS, pedido); // Ads tem números de hoje
  const cFim = new Date(per.ini.getTime() - DIA_MS), cIni = new Date(cFim.getTime() - (per.dias - 1) * DIA_MS);
  const W = entre(per.ini, per.fim);
  const q = c => gaql(env, token, cli, ger, c);
  const [conta0, diario, antes, campanhas, palavras, termos, aparelhos, horas, recomendacoes, orcamentoConta, hoje] = await Promise.all([
    q("SELECT customer.descriptive_name, customer.currency_code, customer.optimization_score, customer.time_zone FROM customer LIMIT 1"),
    q(`SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM customer WHERE ${W}`),
    q(`SELECT metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM customer WHERE ${entre(cIni, cFim)}`).catch(() => []),
    q(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.resource_name, campaign_budget.amount_micros, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value, metrics.search_impression_share FROM campaign WHERE ${W} AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC LIMIT 200`),
    q(`SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.quality_info.quality_score, ad_group.name, campaign.id, campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM keyword_view WHERE ${W} ORDER BY metrics.cost_micros DESC LIMIT 300`).catch(() => []),
    q(`SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM search_term_view WHERE ${W} ORDER BY metrics.cost_micros DESC LIMIT 300`).catch(() => []),
    q(`SELECT segments.device, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM customer WHERE ${W}`).catch(() => []),
    q(`SELECT segments.day_of_week, segments.hour, metrics.clicks, metrics.conversions, metrics.cost_micros FROM customer WHERE ${W}`).catch(() => []),
    q("SELECT recommendation.resource_name, recommendation.type, recommendation.campaign, recommendation.impact FROM recommendation LIMIT 50").catch(() => []),
    q("SELECT account_budget.status, account_budget.approved_spending_limit_micros, account_budget.adjusted_spending_limit_micros, account_budget.amount_served_micros, account_budget.approved_end_date_time FROM account_budget WHERE account_budget.status = 'APPROVED' LIMIT 5").catch(() => []),
    q("SELECT metrics.cost_micros, metrics.clicks FROM customer WHERE segments.date DURING TODAY").catch(() => [])
  ]);
  const c0 = conta0[0]?.customer || {};
  const somaM = linhas => metricasAds(linhas.reduce((a, l) => { const m = l.metrics || {}; for (const k2 of ["costMicros", "clicks", "impressions", "conversions", "conversionsValue"]) a[k2] = Number(a[k2] || 0) + Number(m[k2] || 0); return a; }, {}));
  const DIAS_SEM = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
  const mapaHoras = Array.from({ length: 7 }, () => Array(24).fill(0)), mapaConv = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const l of horas) { const d = (DIAS_SEM.indexOf(l.segments?.dayOfWeek) + 1) % 7, hr = Number(l.segments?.hour || 0); if (d >= 0) { mapaHoras[d][hr] += Number(l.metrics?.clicks || 0); mapaConv[d][hr] += Number(l.metrics?.conversions || 0); } }
  const saldo = orcamentoConta.map(l => l.accountBudget || {}).map(b => {
    const limite = Number(b.adjustedSpendingLimitMicros || b.approvedSpendingLimitMicros || 0), gasto = Number(b.amountServedMicros || 0);
    return limite ? { limite: microsParaReal(limite), gasto: microsParaReal(gasto), restante: microsParaReal(limite - gasto), fim: b.approvedEndDateTime || null } : null;
  }).filter(Boolean)[0] || null;
  const NOME_REC = { KEYWORD: "Adicionar palavras-chave", CAMPAIGN_BUDGET: "Aumentar o orçamento (campanha limitada)", TEXT_AD: "Adicionar anúncio", TARGET_CPA_OPT_IN: "Usar CPA desejado", MAXIMIZE_CONVERSIONS_OPT_IN: "Maximizar conversões", MAXIMIZE_CLICKS_OPT_IN: "Maximizar cliques", RESPONSIVE_SEARCH_AD: "Adicionar anúncio responsivo", SITELINK_ASSET: "Adicionar sitelinks", CALLOUT_ASSET: "Adicionar frases de destaque", CALL_ASSET: "Adicionar telefone", KEYWORD_MATCH_TYPE: "Ampliar correspondência", SEARCH_PARTNERS_OPT_IN: "Ativar parceiros de pesquisa", USE_BROAD_MATCH_KEYWORD: "Usar correspondência ampla", RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH: "Melhorar a força do anúncio", REMOVE_REDUNDANT_KEYWORDS: "Remover palavras repetidas", IMPROVE_PERFORMANCE_MAX_AD_STRENGTH: "Melhorar a força do Performance Max" };
  return {
    conectado: true, cliente: cli, nome: c0.descriptiveName || conta.ads_nome || cli, moeda: c0.currencyCode || conta.ads_moeda || "BRL", pontuacao: c0.optimizationScore != null ? Math.round(c0.optimizationScore * 1000) / 10 : null,
    de: isoDia(per.ini), ate: isoDia(per.fim), dias: per.dias, totais: somaM(diario), anterior: antes.length ? { de: isoDia(cIni), ate: isoDia(cFim), totais: somaM(antes) } : null,
    hoje: somaM(hoje), saldo,
    diario: diario.map(l => ({ data: l.segments?.date, ...metricasAds(l.metrics) })).sort((a, b) => (a.data < b.data ? -1 : 1)),
    campanhas: campanhas.map(l => ({ id: String(l.campaign?.id), nome: l.campaign?.name, status: l.campaign?.status, tipo: l.campaign?.advertisingChannelType, lance: l.campaign?.biddingStrategyType, orcamento: l.campaignBudget?.resourceName || null, orcamento_dia: microsParaReal(l.campaignBudget?.amountMicros), parcela_impressoes: l.metrics?.searchImpressionShare != null ? Math.round(l.metrics.searchImpressionShare * 1000) / 10 : null, ...metricasAds(l.metrics) })),
    palavras: palavras.map(l => ({ texto: l.adGroupCriterion?.keyword?.text, tipo: l.adGroupCriterion?.keyword?.matchType, qualidade: l.adGroupCriterion?.qualityInfo?.qualityScore ?? null, grupo: l.adGroup?.name, campanha: l.campaign?.name, campanha_id: String(l.campaign?.id || ""), ...metricasAds(l.metrics) })),
    termos: termos.map(l => ({ termo: l.searchTermView?.searchTerm, status: l.searchTermView?.status, campanha: l.campaign?.name, campanha_id: String(l.campaign?.id || ""), ...metricasAds(l.metrics) })),
    aparelhos: aparelhos.map(l => ({ aparelho: l.segments?.device, ...metricasAds(l.metrics) })).filter(a => a.impressoes),
    horarios: mapaHoras, horarios_conversoes: mapaConv,
    recomendacoes: recomendacoes.map(l => l.recommendation || {}).map(r => ({ id: r.resourceName, tipo: r.type, nome: NOME_REC[r.type] || String(r.type || "").toLowerCase().replace(/_/g, " "), campanha: r.campaign || null,
      ganho_cliques: r.impact ? Math.round(Number(r.impact.potentialMetrics?.clicks || 0) - Number(r.impact.baseMetrics?.clicks || 0)) : null, ganho_conversoes: r.impact ? Math.round((Number(r.impact.potentialMetrics?.conversions || 0) - Number(r.impact.baseMetrics?.conversions || 0)) * 10) / 10 : null }))
  };
}
async function alterarAds(env, k, conta, acao, c) {
  const invalido = m => Object.assign(new Error(m), { status: 400 });
  const token = await tokenDa(env, k, conta);
  const cli = conta.ads_cliente, ger = conta.ads_gerente || null;
  const idOk = v => /^\d{1,20}$/.test(String(v || ""));
  if (acao === "campanha") {
    if (!idOk(c.campanha_id) || !["ENABLED", "PAUSED"].includes(c.status)) throw invalido("Campanha ou situação inválida.");
    return chamarAds(env, token, "POST", `customers/${cli}/campaigns:mutate`, { operations: [{ update: { resourceName: `customers/${cli}/campaigns/${c.campanha_id}`, status: c.status }, updateMask: "status" }] }, ger);
  }
  if (acao === "orcamento") {
    const valor = Number(c.valor);
    if (!new RegExp(`^customers/${cli}/campaignBudgets/\\d+$`).test(String(c.orcamento || "")) || !(valor >= 1 && valor <= 1e6)) throw invalido("Orçamento inválido.");
    return chamarAds(env, token, "POST", `customers/${cli}/campaignBudgets:mutate`, { operations: [{ update: { resourceName: c.orcamento, amountMicros: String(Math.round(valor * 100) * 10000) }, updateMask: "amount_micros" }] }, ger);
  }
  if (acao === "negativa") {
    const termo = String(c.termo || "").trim().slice(0, 80);
    if (!idOk(c.campanha_id) || !termo) throw invalido("Escolha o termo e a campanha.");
    return chamarAds(env, token, "POST", `customers/${cli}/campaignCriteria:mutate`, { operations: [{ create: { campaign: `customers/${cli}/campaigns/${c.campanha_id}`, negative: true, keyword: { text: termo, matchType: c.correspondencia === "PHRASE" ? "PHRASE" : "EXACT" } } }] }, ger);
  }
  if (acao === "recomendacao") {
    if (!new RegExp(`^customers/${cli}/recommendations/[\\w~-]+$`).test(String(c.id || ""))) throw invalido("Recomendação inválida.");
    const caminho = c.descartar ? "recommendations:dismiss" : "recommendations:apply";
    return chamarAds(env, token, "POST", `customers/${cli}/${caminho}`, { operations: [{ resourceName: c.id }] }, ger);
  }
  throw invalido("Ação desconhecida.");
}

// ----- Concorrentes (Google Maps): quem aparece para uma busca, em que posição o seu perfil está, nota e avaliações.
const normal = t => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export async function buscarConcorrentes(env, k, conta, busca) {
  const chave = chavePlaces(env);
  if (!chave) { const e = new Error("A pesquisa de concorrentes ainda não foi ligada: falta a variável GOOGLE_PLACES_API_KEY (Places API do Google) na Hostinger."); e.status = 503; throw e; }
  const inicio = Date.now();
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST", signal: AbortSignal.timeout(20000),
    headers: { "content-type": "application/json", "X-Goog-Api-Key": chave, "X-Goog-FieldMask": "places.id,places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.primaryTypeDisplayName,places.websiteUri,places.googleMapsUri,places.businessStatus,places.nationalPhoneNumber,places.priceLevel" },
    body: JSON.stringify({ textQuery: busca, languageCode: "pt-BR", regionCode: "BR", pageSize: 20 })
  });
  registrarUso(conta.org_id, "google", "lugares", "searchText", { erro: !r.ok, limitada: r.status === 429, ms: Date.now() - inicio });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error("Google Maps: " + String(d?.error?.message || `HTTP ${r.status}`).slice(0, 200)); e.status = 502; throw e; }
  const meu = normal(conta.local_titulo);
  const lugares = (d.places || []).map((p, i) => ({ posicao: i + 1, nome: p.displayName?.text || "", nota: p.rating ?? null, avaliacoes: p.userRatingCount || 0, endereco: p.formattedAddress || "", categoria: p.primaryTypeDisplayName?.text || "", site: p.websiteUri || "", mapa: p.googleMapsUri || "", telefone: p.nationalPhoneNumber || "", aberto: p.businessStatus !== "CLOSED_PERMANENTLY" }))
    .map(p => ({ ...p, voce: Boolean(meu) && (normal(p.nome) === meu || (meu.length > 5 && normal(p.nome).includes(meu))) }));
  const minha = lugares.find(p => p.voce);
  const dia = isoDia(new Date(k.agora(env)));
  await env.DB.prepare(`INSERT INTO plt_mk_concorrencia(org_id,marca_id,busca,dia,posicao,total,dados,criado_ms) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(org_id,marca_id,busca,dia) DO UPDATE SET posicao=excluded.posicao, total=excluded.total, dados=excluded.dados, criado_ms=excluded.criado_ms`)
    .bind(conta.org_id, conta.marca_id, busca.slice(0, 120), dia, minha ? minha.posicao : null, lugares.length, JSON.stringify(lugares.slice(0, 20)), k.agora(env)).run();
  const outros = lugares.filter(p => !p.voce && p.nota != null);
  const media = outros.length ? Math.round((outros.reduce((s, p) => s + p.nota, 0) / outros.length) * 10) / 10 : null;
  return { busca, dia, posicao: minha ? minha.posicao : null, lugares, media_nota: media, media_avaliacoes: outros.length ? Math.round(outros.reduce((s, p) => s + p.avaliacoes, 0) / outros.length) : null };
}

// ----- Places API (Google Maps): pré-análise de qualquer empresa, concorrentes e mapa de posição em grade.
async function chamarPlaces(env, orgId, metodo, caminho, corpo, mascara) {
  const chave = chavePlaces(env);
  if (!chave) { const e = new Error("Falta a variável GOOGLE_PLACES_API_KEY (Places API do Google) na Hostinger."); e.status = 503; e.codigo = "PLACES_NAO_CONFIGURADO"; throw e; }
  const inicio = Date.now();
  const r = await fetch(`https://places.googleapis.com/v1/${caminho}`, { method: metodo, signal: AbortSignal.timeout(20000),
    headers: { "content-type": "application/json", "X-Goog-Api-Key": chave, "X-Goog-FieldMask": mascara }, body: corpo ? JSON.stringify(corpo) : undefined });
  registrarUso(orgId, "google", "lugares", caminho.startsWith("places:") ? caminho.slice(7) : "detalhes", { erro: !r.ok, limitada: r.status === 429, ms: Date.now() - inicio });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error("Google Maps: " + String(d?.error?.message || `HTTP ${r.status}`).slice(0, 200)); e.status = 502; throw e; }
  return d;
}
const CAMPOS_PLACE = "id,displayName,formattedAddress,location,rating,userRatingCount,primaryType,primaryTypeDisplayName,types,websiteUri,nationalPhoneNumber,regularOpeningHours,photos,editorialSummary,reviews,businessStatus,googleMapsUri,addressComponents";
function cidadeDoPlace(p) { const c = (p.addressComponents || []).find(x => (x.types || []).includes("administrative_area_level_2")) || (p.addressComponents || []).find(x => (x.types || []).includes("locality")); return c?.longText || ""; }
// Pré-análise (sem acesso ao perfil): só o que o Google mostra publicamente. O que a API pública não mostra fica como "conferir".
export function preAnalisar(pl, concorrentes = []) {
  const itens = [];
  const add = (grupo, chave, titulo, max, pontos, detalhe, dica) => itens.push({ grupo, chave, titulo, max, pontos: Math.max(0, Math.min(max, Math.round(pontos))), ok: pontos >= max ? "ok" : pontos > 0 ? "parcial" : "falta", detalhe, dica });
  const conferir = (grupo, chave, titulo, detalhe, dica) => itens.push({ grupo, chave, titulo, max: 0, pontos: 0, ok: "conferir", detalhe, dica });
  const nota = Number(pl.rating || 0), total = Number(pl.userRatingCount || 0), fotos = (pl.photos || []).length;
  const medN = concorrentes.length ? concorrentes.reduce((t, c) => t + Number(c.nota || 0), 0) / concorrentes.length : 0;
  const medT = concorrentes.length ? concorrentes.reduce((t, c) => t + Number(c.avaliacoes || 0), 0) / concorrentes.length : 0;
  add("Informações", "categoria", "Categoria principal", 10, pl.primaryTypeDisplayName?.text ? 10 : 0, pl.primaryTypeDisplayName?.text || "sem categoria", pl.primaryTypeDisplayName?.text ? "" : "Escolher a categoria principal certa é o que mais pesa para aparecer.");
  add("Informações", "telefone", "Telefone", 8, pl.nationalPhoneNumber ? 8 : 0, pl.nationalPhoneNumber || "sem telefone", pl.nationalPhoneNumber ? "" : "Sem telefone o cliente não consegue ligar pelo Google.");
  add("Informações", "site", "Site", 8, pl.websiteUri ? 8 : 0, pl.websiteUri || "sem site", pl.websiteUri ? "" : "Coloque o site ou o link do WhatsApp/Instagram.");
  const dias = new Set((pl.regularOpeningHours?.periods || []).map(x => x.open?.day)).size;
  add("Informações", "horario", "Horário de funcionamento", 8, dias ? 8 : 0, dias ? `${dias} dia(s) com horário` : "sem horário", dias ? "" : "Perfil sem horário aparece menos e gera visita com a porta fechada.");
  add("Fotos", "fotos", "Fotos", 12, fotos >= 10 ? 12 : fotos * 1.2, fotos >= 10 ? "10 ou mais" : `${fotos} foto(s)`, fotos >= 10 ? "" : "Perfis com muitas fotos recebem mais cliques e pedidos de rota.");
  add("Avaliações", "nota", "Nota média", 14, nota >= 4.7 ? 14 : nota >= 4.5 ? 11 : nota >= 4.2 ? 8 : nota >= 4 ? 5 : nota ? 2 : 0, nota ? String(nota).replace(".", ",") + " ★" + (medN ? ` (concorrentes: ${String(Math.round(medN * 10) / 10).replace(".", ",")})` : "") : "sem nota", nota >= 4.5 ? "" : "Responder todas as avaliações e pedir avaliação aos clientes satisfeitos sobe a nota.");
  const metaT = Math.max(50, Math.round(medT));
  add("Avaliações", "quantidade", "Quantidade de avaliações", 14, total >= metaT ? 14 : total / metaT * 14, `${total}${medT ? ` (concorrentes: ${Math.round(medT)} em média)` : ""}`, total >= metaT ? "" : `O ideal é passar de ${metaT}: peça avaliação depois de cada atendimento.`);
  const recentes = (pl.reviews || []).map(r => Date.parse(r.publishTime || 0)).filter(Boolean);
  const ultima = recentes.length ? Math.floor((Date.now() - Math.max(...recentes)) / 86400000) : null;
  add("Avaliações", "recencia", "Avaliações recentes", 8, ultima == null ? 0 : ultima <= 30 ? 8 : ultima <= 90 ? 4 : 0, ultima == null ? "nenhuma" : `a mais recente há ${ultima} dia(s)`, ultima != null && ultima <= 30 ? "" : "O Google valoriza avaliação nova toda semana.");
  add("Informações", "situacao", "Empresa aberta no Google", 6, pl.businessStatus === "OPERATIONAL" ? 6 : 0, pl.businessStatus === "OPERATIONAL" ? "aberta" : String(pl.businessStatus || "?").toLowerCase(), pl.businessStatus === "OPERATIONAL" ? "" : "O perfil aparece como fechado: isso derruba as visitas.");
  conferir("Informações", "descricao", "Descrição da empresa", "a busca pública não mostra a descrição escrita pela empresa", "Com o perfil conectado, a checagem completa confere a descrição.");
  conferir("Atividade", "posts", "Posts recentes", "a busca pública não mostra os posts", "Com o perfil conectado, a DENIA cria e publica os posts.");
  conferir("Avaliações", "respostas", "Respostas às avaliações", "a busca pública não mostra as respostas da empresa", "Com o perfil conectado, a DENIA responde as avaliações.");
  const max = itens.reduce((t, x) => t + x.max, 0), pts = itens.reduce((t, x) => t + x.pontos, 0);
  return { nota: max ? Math.round(pts / max * 100) : 0, itens, faltam: itens.filter(x => x.ok === "parcial" || x.ok === "falta").length };
}
// Mapa de posição em grade: a mesma busca feita de vários pontos em volta da empresa.
export function pontosDaGrade(lat, lng, raioKm, tamanho) {
  const n = [3, 5, 7].includes(Number(tamanho)) ? Number(tamanho) : 5, meio = (n - 1) / 2, passo = raioKm / Math.max(1, meio);
  const pts = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const dy = (meio - i) * passo, dx = (j - meio) * passo;
    pts.push({ linha: i, coluna: j, lat: lat + dy / 111.32, lng: lng + dx / (111.32 * Math.cos(lat * Math.PI / 180)), km: Math.round(Math.hypot(dx, dy) * 10) / 10 });
  }
  return { n, passo, pts };
}

async function rotasGoogleExtra(request, env, k, orgId, papel, resto, url) {
  const { json, pode } = k;
  const metodo = request.method;
  const marcaDe = async () => contaGoogleDe(env, orgId, Number(url.searchParams.get("marca")));
  const erroJson = e => json({ erro: e.message, codigo: e.codigo || (/Falta (a )?permissão/.test(e.message) ? "RECONECTAR" : undefined) }, e.status && e.status < 500 && e.status !== 401 ? e.status : 502);
  const corpoDe = async () => { const { corpo, erro } = await k.lerCorpo(request, 4000); if (erro) throw Object.assign(new Error("Pedido inválido."), { status: 400 }); return corpo; };

  // Search Console
  // ----- Perfil: ler e editar pela DENIA (descrição, telefone, site, horários e feriados), sem abrir o Google.
  if (resto === "google/perfil" && metodo === "GET") {
    const conta = await marcaDe();
    if (!conta) return json({ conectada: false });
    try {
      const token = await tokenDa(env, k, conta);
      const info = await chamar("GET", `${API_INFO}/${conta.local_nome}?readMask=title,phoneNumbers,websiteUri,regularHours,specialHours,profile,metadata,categories,storefrontAddress,serviceItems`, token);
      const hojeMs = Math.floor((k.agora(env) - 3 * 3600000) / 86400000) * 86400000;
      const ano = new Date(hojeMs).getUTCFullYear();
      const proximos = [...feriadosNacionais(ano), ...feriadosNacionais(ano + 1)].filter(f => f.ms >= hojeMs && f.ms <= hojeMs + 120 * 86400000).map(f => ({ nome: f.nome, data: isoDia(new Date(f.ms)) }));
      return json({ conectada: true, perfil: {
        titulo: info.title || conta.local_titulo, descricao: info.profile?.description || "", telefone: info.phoneNumbers?.primaryPhone || "", site: info.websiteUri || "",
        categoria: info.categories?.primaryCategory?.displayName || "", horarios: info.regularHours?.periods || [], feriados: info.specialHours?.specialHourPeriods || [],
        avaliar: info.metadata?.newReviewUri || "", maps: info.metadata?.mapsUri || conta.maps_uri || "", cidade: info.storefrontAddress?.locality || "",
        servicos: (info.serviceItems || []).map(x => x.freeFormServiceItem ? { nome: x.freeFormServiceItem.label?.displayName || "", descricao: x.freeFormServiceItem.label?.description || "", livre: true } : { nome: String(x.structuredServiceItem?.serviceTypeId || "").replace(/^job_type_id:/, "").replace(/_/g, " "), descricao: x.structuredServiceItem?.description || "", livre: false, id: x.structuredServiceItem?.serviceTypeId }) }, proximos_feriados: proximos });
    } catch (e) { return erroJson(e); }
  }
  if (resto === "google/perfil" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores mudam o perfil no Google." }, 403);
    const c = await corpoDe().catch(e => e);
    if (c instanceof Error) return json({ erro: c.message }, 400);
    const conta = await contaGoogleDe(env, orgId, Number(c.marca_id));
    if (!conta) return json({ erro: "Conecte o Google deste perfil primeiro." }, 409);
    const local = {}, mascara = [];
    if (typeof c.descricao === "string") {
      const d = c.descricao.trim();
      if (d.length > 750) return json({ erro: `A descrição tem ${d.length} letras; o Google aceita até 750.` }, 400);
      if (/https?:\/\/|www\./i.test(d)) return json({ erro: "O Google não aceita links na descrição. Tire o link e tente de novo." }, 400);
      if (/(\+?55[\s-]?)?\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}/.test(d)) return json({ erro: "O Google não aceita telefone na descrição (ele já aparece no botão Ligar)." }, 400);
      local.profile = { description: d }; mascara.push("profile.description");
    }
    if (typeof c.telefone === "string") { const t = c.telefone.trim(); if (t && t.replace(/\D/g, "").length < 10) return json({ erro: "Coloque o telefone completo, com DDD." }, 400); local.phoneNumbers = { primaryPhone: t }; mascara.push("phoneNumbers"); }
    if (typeof c.site === "string") { const u = c.site.trim(); if (u && !/^https?:\/\/[^\s]+\.[^\s]+/.test(u)) return json({ erro: "O site precisa começar com https://" }, 400); local.websiteUri = u; mascara.push("websiteUri"); }
    const hora = v => { const m = String(v || "").match(/^(\d{1,2}):(\d{2})$/); return m ? { hours: Number(m[1]), minutes: Number(m[2]) } : null; };
    const dataG = v => { const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null; };
    if (Array.isArray(c.horarios)) {
      const DIAS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
      const periods = c.horarios.filter(x => DIAS.includes(x.dia) && hora(x.abre) && hora(x.fecha)).slice(0, 21).map(x => ({ openDay: x.dia, openTime: hora(x.abre), closeDay: x.dia, closeTime: hora(x.fecha) }));
      local.regularHours = { periods }; mascara.push("regularHours");
    }
    if (Array.isArray(c.feriados)) {
      const sp = c.feriados.filter(x => dataG(x.data)).slice(0, 60).map(x => x.fechado ? { startDate: dataG(x.data), closed: true } : (hora(x.abre) && hora(x.fecha) ? { startDate: dataG(x.data), openTime: hora(x.abre), closeTime: hora(x.fecha) } : null)).filter(Boolean);
      local.specialHours = { specialHourPeriods: sp }; mascara.push("specialHours");
    }
    if (!mascara.length && !Array.isArray(c.servicos)) return json({ erro: "Nada para mudar." }, 400);
    try {
      const token = await tokenDa(env, k, conta);
      if (Array.isArray(c.servicos)) {
        // Serviços escritos por você (livres) ficam na categoria principal; os do catálogo do Google são mantidos como estão.
        const atual = await chamar("GET", `${API_INFO}/${conta.local_nome}?readMask=categories,serviceItems`, token);
        const cat = atual.categories?.primaryCategory?.name;
        if (!cat) return json({ erro: "O perfil precisa ter uma categoria principal no Google antes de cadastrar serviços." }, 409);
        const livres = c.servicos.map(x => ({ nome: String(x.nome || "").trim().slice(0, 140), descricao: String(x.descricao || "").trim().slice(0, 300) })).filter(x => x.nome).slice(0, 100);
        local.serviceItems = [...(atual.serviceItems || []).filter(x => x.structuredServiceItem), ...livres.map(x => ({ freeFormServiceItem: { category: cat, label: { displayName: x.nome, ...(x.descricao ? { description: x.descricao } : {}), languageCode: "pt-BR" } } }))];
        mascara.push("serviceItems");
      }
      await chamar("PATCH", `${API_INFO}/${conta.local_nome}?updateMask=${encodeURIComponent(mascara.join(","))}`, token, local);
      await k.auditar(env, request, k.sessao, orgId, "MARKETING", `Mudou no Google (${conta.local_titulo}): ${mascara.join(", ")}`).catch(() => {});
      return json({ ok: true, mudou: mascara });
    } catch (e) { return erroJson(e); }
  }
  // ----- Fotos do perfil: ver as que estão no Google e enviar novas (o Google busca a imagem por um link assinado).
  const CATEGORIAS_FOTO = ["ADDITIONAL", "COVER", "LOGO", "EXTERIOR", "INTERIOR", "PRODUCT", "AT_WORK", "TEAM", "FOOD_AND_DRINK", "MENU", "COMMON_AREA", "ROOMS"];
  if (resto === "google/fotos" && metodo === "GET") {
    const conta = await marcaDe();
    if (!conta) return json({ conectada: false });
    try {
      const token = await tokenDa(env, k, conta);
      const lista = []; let pg = "";
      for (let i = 0; i < 3; i++) { const d = await chamar("GET", `${API_V4}/${caminhoV4(conta)}/media?pageSize=100${pg ? "&pageToken=" + encodeURIComponent(pg) : ""}`, token); lista.push(...(d.mediaItems || [])); if (!d.nextPageToken) break; pg = d.nextPageToken; }
      return json({ conectada: true, fotos: lista.map(m => ({ id: m.name, url: m.thumbnailUrl || m.googleUrl, grande: m.googleUrl, tipo: m.mediaFormat, categoria: m.locationAssociation?.category || "", quando: m.createTime, vistas: Number(m.insights?.viewCount || 0) })).sort((a, b) => String(b.quando).localeCompare(String(a.quando))) });
    } catch (e) { return erroJson(e); }
  }
  if (resto === "google/foto" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores enviam fotos ao Google." }, 403);
    const { corpo: c, erro } = await k.lerCorpo(request, 2_200_000);
    if (erro) return erro;
    const conta = await contaGoogleDe(env, orgId, Number(c.marca_id));
    if (!conta) return json({ erro: "Conecte o Google deste perfil primeiro." }, 409);
    const dados = String(c.dados || "").replace(/^data:[^,]*,/, "");
    const ini = (() => { try { return atob(dados.slice(0, 16)); } catch { return ""; } })();
    const mime = ini.startsWith("\xff\xd8\xff") ? "image/jpeg" : ini.startsWith("\x89PNG") ? "image/png" : "";
    if (!mime) return json({ erro: "Envie a foto em JPG ou PNG." }, 400);
    if (dados.length < 14000) return json({ erro: "A foto é pequena demais para o Google (mínimo 10 KB e 250 pixels)." }, 400);
    const categoria = CATEGORIAS_FOTO.includes(c.categoria) ? c.categoria : "ADDITIONAL";
    // A IA dá nome e descrição pensados para busca (ex.: conserto-tv-botafogo); sem chave da OpenAI, usa o que a pessoa escreveu.
    const marcaRow = await env.DB.prepare("SELECT * FROM plt_mk_marcas WHERE id=? AND org_id=?").bind(conta.marca_id, orgId).first();
    const mk = await import("./marketing.js");
    let seo = { nome: mk.slugSeo(c.nome_arquivo || `${marcaRow?.segmento || "foto"} ${marcaRow?.cidade || ""} ${marcaRow?.nome || ""}`), descricao: String(c.descricao || "").trim().slice(0, 300) };
    if (!c.nome_arquivo && env.OPENAI_API_KEY && marcaRow) seo = await mk.nomearFotoComIA(env, marcaRow, mime, dados, c.descricao || "").catch(() => seo);
    const nomeArq = await mk.nomeUnico(env, orgId, seo.nome);
    const n = await env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms,marca_id,nome_arquivo,origem,enviado_por,descricao) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id")
      .bind(orgId, mime, dados, "foto google", k.agora(env), conta.marca_id, nomeArq, "foto-google", k.sessao?.usuario?.nome || k.sessao?.usuario?.email || "", seo.descricao).first();
    try {
      const { urlPublicaMidia } = await import("./meta.js");
      const fonte = await urlPublicaMidia({ ...k, env }, baseDe(request, env), n.id);
      const token = await tokenDa(env, k, conta);
      const corpoMidia = { mediaFormat: "PHOTO", locationAssociation: { category: categoria }, sourceUrl: fonte };
      if (seo.descricao) corpoMidia.description = seo.descricao;
      const r = await chamar("POST", `${API_V4}/${caminhoV4(conta)}/media`, token, corpoMidia);
      if (r.name) await env.DB.prepare("UPDATE plt_mk_midias SET google_id=? WHERE id=?").bind(String(r.name).slice(0, 300), n.id).run();
      await k.auditar(env, request, k.sessao, orgId, "MARKETING", `Enviou foto ao Google (${conta.local_titulo}, ${categoria})`).catch(() => {});
      return json({ ok: true, id: r.name || null, nome_arquivo: nomeArq, descricao: seo.descricao });
    } catch (e) { return erroJson(e); }
  }
  // ----- Pré-análise de qualquer empresa (prospecção): busca pelo nome, escolhe e analisa, com concorrentes e categorias.
  if (resto === "google/pre-analise" && metodo === "POST") {
    if (!pode(papel, "AGENTE")) return json({ erro: "Seu perfil não tem permissão para esta ação." }, 403);
    const c = await corpoDe().catch(e => e);
    if (c instanceof Error) return json({ erro: c.message }, 400);
    try {
      if (!c.place_id) {
        const busca = String(c.busca || "").trim().slice(0, 150);
        if (busca.length < 3) return json({ erro: "Digite o nome da empresa e a cidade." }, 400);
        const d = await chamarPlaces(env, orgId, "POST", "places:searchText", { textQuery: busca, languageCode: "pt-BR", regionCode: "BR", pageSize: 8 }, "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.primaryTypeDisplayName");
        return json({ opcoes: (d.places || []).map(x => ({ id: x.id, nome: x.displayName?.text || "", endereco: x.formattedAddress || "", nota: x.rating ?? null, avaliacoes: x.userRatingCount || 0, categoria: x.primaryTypeDisplayName?.text || "" })) });
      }
      if (!/^[\w-]{3,300}$/.test(String(c.place_id))) return json({ erro: "Empresa inválida." }, 400);
      const pl = await chamarPlaces(env, orgId, "GET", `places/${c.place_id}?languageCode=pt-BR`, null, CAMPOS_PLACE);
      let concorrentes = [], posicao = null, categorias = [];
      const cat = pl.primaryTypeDisplayName?.text;
      if (cat && pl.location) {
        const d = await chamarPlaces(env, orgId, "POST", "places:searchText", { textQuery: `${cat} ${cidadeDoPlace(pl)}`.trim(), languageCode: "pt-BR", regionCode: "BR", pageSize: 20, locationBias: { circle: { center: pl.location, radius: 5000 } } },
          "places.id,places.displayName,places.rating,places.userRatingCount,places.primaryTypeDisplayName,places.types,places.formattedAddress,places.googleMapsUri,places.photos").catch(() => ({ places: [] }));
        const lista = d.places || [];
        const i = lista.findIndex(x => x.id === pl.id); posicao = i >= 0 ? i + 1 : 0;
        concorrentes = lista.filter(x => x.id !== pl.id).slice(0, 10).map(x => ({ posicao: lista.indexOf(x) + 1, nome: x.displayName?.text || "", nota: x.rating ?? null, avaliacoes: x.userRatingCount || 0, categoria: x.primaryTypeDisplayName?.text || "", fotos: (x.photos || []).length, endereco: x.formattedAddress || "", maps: x.googleMapsUri || "" }));
        // Categoria principal de cada concorrente, no nome em português que o Google mostra.
        const cont = new Map();
        for (const x of concorrentes) if (x.categoria) cont.set(x.categoria, (cont.get(x.categoria) || 0) + 1);
        categorias = [...cont.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([nome, n]) => ({ nome, concorrentes: n, voce: nome === cat }));
      }
      const empresa = { id: pl.id, nome: pl.displayName?.text || "", endereco: pl.formattedAddress || "", categoria: cat || "", nota: pl.rating ?? null, avaliacoes: pl.userRatingCount || 0, telefone: pl.nationalPhoneNumber || "", site: pl.websiteUri || "", maps: pl.googleMapsUri || "", fotos: (pl.photos || []).length, resumo: pl.editorialSummary?.text || "",
        ultimas_avaliacoes: (pl.reviews || []).slice(0, 5).map(r => ({ autor: r.authorAttribution?.displayName || "", nota: r.rating, texto: String(r.text?.text || "").slice(0, 400), quando: r.relativePublishTimeDescription || "" })) };
      return json({ empresa, analise: preAnalisar(pl, concorrentes), posicao_na_categoria: posicao, busca_concorrentes: cat ? `${cat} ${cidadeDoPlace(pl)}`.trim() : "", concorrentes, categorias });
    } catch (e) { return erroJson(e); }
  }
  // ----- Mapa de posição em grade (raio em volta da empresa). Cada ponto é uma busca no Google Maps: custa centavos.
  if (resto === "google/geogrid" && metodo === "GET") {
    const conta = await marcaDe();
    if (!conta) return json({ conectada: false, grades: [] });
    const r = (await env.DB.prepare("SELECT id, palavra, raio_km, tamanho, media, top3, dados, criado_ms FROM plt_mk_geogrid WHERE org_id=? AND marca_id=? ORDER BY id DESC LIMIT 12").bind(orgId, conta.marca_id).all().catch(() => null))?.results || [];
    return json({ conectada: true, places_configurado: Boolean(chavePlaces(env)), grades: r.map(x => ({ ...x, dados: JSON.parse(x.dados || "{}") })) });
  }
  if (resto === "google/geogrid" && metodo === "POST") {
    if (!pode(papel, "AGENTE")) return json({ erro: "Seu perfil não tem permissão para esta ação." }, 403);
    const c = await corpoDe().catch(e => e);
    if (c instanceof Error) return json({ erro: c.message }, 400);
    const conta = await contaGoogleDe(env, orgId, Number(c.marca_id));
    if (!conta) return json({ erro: "Conecte o Google deste perfil primeiro." }, 409);
    const palavra = String(c.palavra || "").trim().slice(0, 100);
    if (palavra.length < 2) return json({ erro: "Digite a busca, por exemplo \"pedreiro\"." }, 400);
    const raio = Math.min(15, Math.max(0.5, Number(c.raio_km) || 3));
    try {
      const token = await tokenDa(env, k, conta);
      const info = await chamar("GET", `${API_INFO}/${conta.local_nome}?readMask=latlng,metadata,title`, token);
      const placeId = info.metadata?.placeId, ll = info.latlng;
      if (!placeId || !ll?.latitude) return json({ erro: "O Google não informou a localização deste perfil (perfis só com área de atendimento, sem endereço, não têm ponto no mapa)." }, 409);
      const { n, pts } = pontosDaGrade(ll.latitude, ll.longitude, raio, c.tamanho);
      const raioBusca = Math.round(Math.max(500, Math.min(3000, raio * 1000 / Math.max(1, (n - 1) / 2))));
      const res = [];
      for (let i = 0; i < pts.length; i += 5) res.push(...await Promise.all(pts.slice(i, i + 5).map(async pt => {
        const d = await chamarPlaces(env, orgId, "POST", "places:searchText", { textQuery: palavra, languageCode: "pt-BR", regionCode: "BR", pageSize: 20, locationBias: { circle: { center: { latitude: pt.lat, longitude: pt.lng }, radius: raioBusca } } }, "places.id,places.displayName").catch(() => null);
        if (!d) return { ...pt, posicao: null, primeiro: "" };
        const l = d.places || [], idx = l.findIndex(x => x.id === placeId);
        return { ...pt, posicao: idx >= 0 ? idx + 1 : 0, primeiro: l[0]?.displayName?.text || "" };
      })));
      const medidos = res.filter(x => x.posicao != null);
      const media = medidos.length ? Math.round(medidos.reduce((t, x) => t + (x.posicao || 21), 0) / medidos.length * 10) / 10 : null;
      const top3 = medidos.length ? Math.round(medidos.filter(x => x.posicao && x.posicao <= 3).length / medidos.length * 100) : 0;
      const dados = { n, centro: { lat: ll.latitude, lng: ll.longitude }, pontos: res };
      const ins = await env.DB.prepare("INSERT INTO plt_mk_geogrid(org_id,marca_id,palavra,raio_km,tamanho,media,top3,dados,criado_ms) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id").bind(orgId, conta.marca_id, palavra, raio, n, media, top3, JSON.stringify(dados), k.agora(env)).first();
      return json({ id: ins.id, palavra, raio_km: raio, tamanho: n, media, top3, dados, criado_ms: k.agora(env) });
    } catch (e) { return erroJson(e); }
  }
  // ----- Buscas no Google: o que as pessoas digitaram e quantas vezes (dado oficial do Google), a posição medida
  // em cada busca, por onde viram o perfil (Pesquisa/Maps, celular/computador) e até onde o perfil chega no mapa.
  if (resto === "google/buscas" && metodo === "GET") {
    const conta = await marcaDe();
    if (!conta) return json({ conectada: false });
    const meses = Math.min(12, Math.max(1, Number(url.searchParams.get("meses")) || 3));
    try {
      const token = await tokenDa(env, k, conta);
      const agora = k.agora(env), hoje = new Date(agora);
      const fimMes = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 0)); // último dia do mês passado
      const iniMes = new Date(Date.UTC(fimMes.getUTCFullYear(), fimMes.getUTCMonth() - (meses - 1), 1));
      const [pal, serie, anterior] = await Promise.all([
        palavrasDoPeriodo(conta, token, iniMes, fimMes, agora, 500),
        serieDoPeriodo(conta, token, iniMes, fimMes).catch(() => null),
        palavrasDoPeriodo(conta, token, new Date(Date.UTC(iniMes.getUTCFullYear(), iniMes.getUTCMonth() - meses, 1)), new Date(Date.UTC(iniMes.getUTCFullYear(), iniMes.getUTCMonth(), 0)), agora, 500).catch(() => null)
      ]);
      const norm = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
      const antes = new Map((anterior?.lista || []).map(x => [norm(x.palavra), x.buscas ?? null]));
      const acomp = (await env.DB.prepare("SELECT id, palavra, cidade FROM plt_mk_palavras WHERE org_id=? AND marca_id=?").bind(orgId, conta.marca_id).all().catch(() => null))?.results || [];
      const pos = acomp.length ? ((await env.DB.prepare(`SELECT palavra_id, semana, posicao FROM plt_mk_posicoes WHERE palavra_id IN (${acomp.map(() => "?").join(",")}) ORDER BY semana DESC`).bind(...acomp.map(a => a.id)).all())?.results || []) : [];
      const posDe = id => { const l = pos.filter(x => x.palavra_id === id); return { atual: l[0] ? l[0].posicao : null, semana: l[0]?.semana || null, anterior: l[1] ? l[1].posicao : null }; };
      const porPalavra = new Map(acomp.map(a => [norm(a.palavra), a]));
      const lista = pal.lista.map(x => { const a = porPalavra.get(norm(x.palavra)); const p = a ? posDe(a.id) : null;
        return { palavra: x.palavra, buscas: x.buscas, menos_de: x.menos_de, antes: antes.has(norm(x.palavra)) ? antes.get(norm(x.palavra)) : null, palavra_id: a?.id || null, posicao: p?.atual ?? null, posicao_anterior: p?.anterior ?? null, medido_em: p?.semana || null }; });
      // Palavras acompanhadas que o Google não listou (ainda sem buscas registradas).
      for (const a of acomp) if (!lista.some(x => norm(x.palavra) === norm(a.palavra))) { const p = posDe(a.id); lista.push({ palavra: a.palavra, buscas: null, menos_de: null, antes: null, palavra_id: a.id, posicao: p.atual, posicao_anterior: p.anterior, medido_em: p.semana, so_acompanhada: true }); }
      const det = serie?.detalhe || null;
      const onde = det ? { pesquisa_celular: det.pesquisa_celular, pesquisa_computador: det.pesquisa_computador, maps_celular: det.maps_celular, maps_computador: det.maps_computador, rotas: det.rotas, ligacoes: det.ligacoes, cliques_site: det.cliques_site, mensagens: det.mensagens } : null;
      // Alcance no mapa: a partir das medições do Mapa de posição (uma por busca, a mais recente).
      const grades = (await env.DB.prepare("SELECT palavra, raio_km, tamanho, media, top3, dados, criado_ms FROM plt_mk_geogrid WHERE org_id=? AND marca_id=? ORDER BY id DESC LIMIT 20").bind(orgId, conta.marca_id).all().catch(() => null))?.results || [];
      const vistas = new Set(), alcance = [];
      for (const g of grades) {
        if (vistas.has(norm(g.palavra))) continue; vistas.add(norm(g.palavra));
        const d = JSON.parse(g.dados || "{}"), c = d.centro;
        if (!c) continue;
        const km = (a, b) => { const R = 6371, r = x => x * Math.PI / 180, dl = r(b.lat - a.lat), dg = r(b.lng - a.lng); const h2 = Math.sin(dl / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h2)); };
        const pts = (d.pontos || []).filter(p => p.posicao != null);
        const ate = lim => { const l = pts.filter(p => p.posicao && p.posicao <= lim); return l.length ? Math.round(Math.max(...l.map(p => km(c, p))) * 10) / 10 : 0; };
        alcance.push({ palavra: g.palavra, raio_km: g.raio_km, medido_ms: g.criado_ms, media: g.media, top3_pct: g.top3, top10_pct: pts.length ? Math.round(pts.filter(p => p.posicao && p.posicao <= 10).length / pts.length * 100) : 0, top3_km: ate(3), top10_km: ate(10), aparece_km: ate(20), pontos: pts.length });
      }
      return json({ conectada: true, periodo: { de: pal.mes_de, ate: pal.mes_ate, meses }, total_buscas: lista.reduce((t, x) => t + (x.buscas || 0), 0), palavras: lista, onde, alcance, places_configurado: Boolean(chavePlaces(env)) });
    } catch (e) { return erroJson(e); }
  }
  // ----- Situação do perfil: suspensão/verificação e alterações feitas pelo Google ou por outras pessoas.
  if (resto === "google/situacao" && metodo === "GET") {
    const conta = await marcaDe();
    if (!conta) return json({ conectada: false });
    try { return json({ conectada: true, ...(await situacaoDoPerfil(env, k, conta)) }); } catch (e) { return erroJson(e); }
  }
  // ----- Relatório em PDF para o cliente, envio automático e proposta comercial.
  if (resto === "google/relatorio-pdf" && metodo === "GET") {
    const conta = await marcaDe();
    if (!conta) return json({ erro: "Conecte o Google deste perfil primeiro." }, 409);
    try { const r = await relatorioPdfDoPerfil(env, k, conta, [15, 30, 90].includes(Number(url.searchParams.get("dias"))) ? Number(url.searchParams.get("dias")) : 30); return json({ nome: r.nome, base64: paraBase64(r.bytes) }); }
    catch (e) { return erroJson(e); }
  }
  if (resto === "google/relatorio-envio" && metodo === "GET") {
    const id = Number(url.searchParams.get("marca"));
    let cfg = null; try { cfg = JSON.parse((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind(`relpdf_${orgId}_${id}`).first())?.valor || "null"); } catch { cfg = null; }
    return json({ config: cfg || { ativo: false, frequencia: "mensal", emails: "" } });
  }
  if (resto === "google/relatorio-envio" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores." }, 403);
    const c = await corpoDe().catch(e => e);
    if (c instanceof Error) return json({ erro: c.message }, 400);
    const emails = String(c.emails || "").split(/[,;\s]+/).filter(Boolean);
    if (emails.some(e => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) return json({ erro: "Confira os e-mails (separe por vírgula)." }, 400);
    if (c.ativo && !emails.length) return json({ erro: "Coloque pelo menos um e-mail." }, 400);
    const cfg = { ativo: Boolean(c.ativo), frequencia: c.frequencia === "quinzenal" ? "quinzenal" : "mensal", emails: emails.join(", ") };
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind(`relpdf_${orgId}_${Number(c.marca_id)}`, JSON.stringify(cfg)).run();
    return json({ ok: true, config: cfg });
  }
  if (resto === "google/proposta" && metodo === "POST") {
    if (!pode(papel, "AGENTE")) return json({ erro: "Seu perfil não tem permissão para esta ação." }, 403);
    const { corpo: c, erro } = await k.lerCorpo(request, 60000);
    if (erro) return erro;
    if (!c?.empresa?.nome) return json({ erro: "Faça a pré-análise da empresa antes." }, 400);
    const org = await env.DB.prepare("SELECT nome FROM plt_organizacoes WHERE id=?").bind(orgId).first().catch(() => null);
    const t = (v, n) => String(v ?? "").slice(0, n);
    return json(propostaPdf({ agencia: t(c.agencia, 120) || org?.nome || "", empresa: { nome: t(c.empresa.nome, 120), nota: Number(c.empresa.nota) || null, avaliacoes: Number(c.empresa.avaliacoes) || 0 },
      analise: { nota: Number(c.analise?.nota) || 0, itens: (c.analise?.itens || []).slice(0, 20).map(i => ({ titulo: t(i.titulo, 80), detalhe: t(i.detalhe, 120), dica: t(i.dica, 200), ok: t(i.ok, 10) })) },
      concorrentes: (c.concorrentes || []).slice(0, 10).map(x => ({ posicao: Number(x.posicao) || 0, nome: t(x.nome, 80), nota: Number(x.nota) || null, avaliacoes: Number(x.avaliacoes) || 0 })),
      posicao: c.posicao == null ? null : Number(c.posicao), busca: t(c.busca, 120), valor: t(c.valor, 200), servicos: (c.servicos || []).slice(0, 15).map(x => t(x, 200)).filter(Boolean), validade: Math.min(90, Math.max(1, Number(c.validade) || 15)), contato: t(c.contato, 300) }));
  }
  // Visão geral de todos os perfis do Google da empresa (como numa agência): nota, avaliações sem resposta, posts e posições.
  if (resto === "google/visao" && metodo === "GET") {
    const contas = (await env.DB.prepare(`SELECT g.marca_id, g.local_titulo, g.media_google, g.total_google, g.sincronizado_ms, g.erro, m.nome,
      (SELECT COUNT(*) FROM plt_mk_avaliacoes a WHERE a.org_id=g.org_id AND a.marca_id=g.marca_id AND a.status='PENDENTE' AND a.google_id IS NOT NULL AND a.removida_ms IS NULL) sem_resposta,
      (SELECT COUNT(*) FROM plt_mk_avaliacoes a WHERE a.org_id=g.org_id AND a.marca_id=g.marca_id AND a.google_id IS NOT NULL AND a.nota<=2 AND a.removida_ms IS NULL AND a.criado_ms>?) ruins_30d,
      (SELECT COUNT(*) FROM plt_mk_posts p WHERE p.org_id=g.org_id AND p.marca_id=g.marca_id AND p.canais LIKE '%google%' AND p.status='PUBLICADO' AND p.atualizado_ms>?) posts_30d,
      (SELECT COUNT(*) FROM plt_mk_posts p WHERE p.org_id=g.org_id AND p.marca_id=g.marca_id AND p.canais LIKE '%google%' AND p.status='APROVADO') programados
      FROM plt_mk_google g JOIN plt_mk_marcas m ON m.id=g.marca_id WHERE g.org_id=? AND m.ativa=1 ORDER BY m.nome`).bind(k.agora(env) - 30 * 86400000, k.agora(env) - 30 * 86400000, orgId).all().catch(() => null))?.results || [];
    const pos = (await env.DB.prepare(`SELECT w.marca_id, w.palavra, x.posicao, x.semana FROM plt_mk_palavras w JOIN plt_mk_posicoes x ON x.palavra_id=w.id WHERE w.org_id=? ORDER BY x.semana DESC`).bind(orgId).all().catch(() => null))?.results || [];
    return json({ perfis: contas.map(c => {
      const minhas = pos.filter(x => x.marca_id === c.marca_id), ultima = minhas[0]?.semana;
      const atuais = minhas.filter(x => x.semana === ultima);
      return { ...c, palavras: atuais.map(x => ({ palavra: x.palavra, posicao: x.posicao })) };
    }) });
  }
  if (resto === "google/sc/sites" && metodo === "GET") {
    const conta = await marcaDe();
    if (!conta) return json({ conectada: false });
    if (!temEscopo(conta, ESCOPO_SC)) return json({ conectada: true, precisa_reconectar: true, sites: [] });
    try {
      const token = await tokenDa(env, k, conta);
      const d = await chamar("GET", `${SC_API}/sites`, token);
      return json({ conectada: true, atual: conta.sc_site || null, sites: (d.siteEntry || []).filter(s => s.permissionLevel !== "siteUnverifiedUser").map(s => ({ site: s.siteUrl, permissao: s.permissionLevel })) });
    } catch (e) { return erroJson(e); }
  }
  if (resto === "google/sc/site" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores." }, 403);
    const c = await corpoDe().catch(e => e);
    if (c instanceof Error) return json({ erro: c.message }, 400);
    const site = String(c.site || "").trim().slice(0, 300);
    if (site && !/^(https?:\/\/|sc-domain:)/.test(site)) return json({ erro: "Escolha uma propriedade do Search Console." }, 400);
    await env.DB.prepare("UPDATE plt_mk_google SET sc_site=? WHERE org_id=? AND marca_id=?").bind(site || null, orgId, Number(c.marca_id)).run();
    return json({ ok: true });
  }
  if (resto === "google/sc" && metodo === "GET") {
    const conta = await marcaDe();
    if (!conta) return json({ conectada: false });
    if (!temEscopo(conta, ESCOPO_SC)) return json({ conectada: true, precisa_reconectar: true });
    try { return json({ conectada: true, ...(await searchConsole(env, k, conta, { dias: url.searchParams.get("dias"), de: url.searchParams.get("de"), ate: url.searchParams.get("ate") })) }); }
    catch (e) { return erroJson(e); }
  }
  if (resto === "google/sc/inspecionar" && metodo === "POST") {
    if (!pode(papel, "AGENTE")) return json({ erro: "Seu perfil não tem permissão para esta ação." }, 403);
    const c = await corpoDe().catch(e => e);
    if (c instanceof Error) return json({ erro: c.message }, 400);
    const conta = await contaGoogleDe(env, orgId, Number(c.marca_id));
    if (!conta?.sc_site) return json({ erro: "Escolha o site do Search Console primeiro." }, 409);
    const pagina = String(c.url || "").trim().slice(0, 800);
    if (!/^https?:\/\//.test(pagina)) return json({ erro: "Cole o endereço completo da página (https://...)." }, 400);
    try {
      const token = await tokenDa(env, k, conta);
      const d = await chamar("POST", SC_INSPECAO, token, { inspectionUrl: pagina, siteUrl: conta.sc_site, languageCode: "pt-BR" });
      const i = d.inspectionResult || {}, x = i.indexStatusResult || {};
      return json({ url: pagina, veredito: x.verdict || null, cobertura: x.coverageState || null, indexacao: x.indexingState || null, rastreio: x.lastCrawlTime || null, robots: x.robotsTxtState || null, busca: x.pageFetchState || null,
        canonica_google: x.googleCanonical || null, canonica_site: x.userCanonical || null, celular: i.mobileUsabilityResult?.verdict || null, ricos: (i.richResultsResult?.detectedItems || []).map(r => r.richResultType), link: i.inspectionResultLink || null });
    } catch (e) { return erroJson(e); }
  }
  if (resto === "google/sc/sitemap" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores." }, 403);
    const c = await corpoDe().catch(e => e);
    if (c instanceof Error) return json({ erro: c.message }, 400);
    const conta = await contaGoogleDe(env, orgId, Number(c.marca_id));
    if (!conta?.sc_site) return json({ erro: "Escolha o site do Search Console primeiro." }, 409);
    const mapa = String(c.url || "").trim().slice(0, 500);
    if (!/^https?:\/\/\S+$/.test(mapa)) return json({ erro: "Cole o endereço do sitemap (ex.: https://seusite.com.br/sitemap.xml)." }, 400);
    try { const token = await tokenDa(env, k, conta); await chamar("PUT", `${SC_API}/sites/${encodeURIComponent(conta.sc_site)}/sitemaps/${encodeURIComponent(mapa)}`, token); return json({ ok: true }); }
    catch (e) { return erroJson(e); }
  }

  // Google Ads
  if (resto === "google/ads/contas" && metodo === "GET") {
    const conta = await marcaDe();
    if (!conta) return json({ conectada: false });
    if (!adsConfigurado(env)) return json({ conectada: true, configurado: false, contas: [] });
    if (!temEscopo(conta, ESCOPO_ADS)) return json({ conectada: true, configurado: true, precisa_reconectar: true, contas: [] });
    try { return json({ conectada: true, configurado: true, atual: conta.ads_cliente || null, contas: await contasAds(env, k, conta) }); }
    catch (e) { return erroJson(e); }
  }
  if (resto === "google/ads/conta" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores." }, 403);
    const c = await corpoDe().catch(e => e);
    if (c instanceof Error) return json({ erro: c.message }, 400);
    const id = String(c.cliente || "").replace(/-/g, ""), via = String(c.gerente || "").replace(/-/g, "");
    if (id && !/^\d{6,12}$/.test(id) || via && !/^\d{6,12}$/.test(via)) return json({ erro: "Conta do Google Ads inválida." }, 400);
    await env.DB.prepare("UPDATE plt_mk_google SET ads_cliente=?, ads_gerente=?, ads_nome=?, ads_moeda=? WHERE org_id=? AND marca_id=?").bind(id || null, via || null, k.txt(c.nome, 120) || null, k.txt(c.moeda, 3) || null, orgId, Number(c.marca_id)).run();
    return json({ ok: true });
  }
  if (resto === "google/ads" && metodo === "GET") {
    const conta = await marcaDe();
    if (!conta) return json({ conectada: false });
    if (!adsConfigurado(env)) return json({ conectada: true, configurado: false });
    if (!temEscopo(conta, ESCOPO_ADS)) return json({ conectada: true, configurado: true, precisa_reconectar: true });
    try { return json({ conectada: true, configurado: true, ...(await relatorioAds(env, k, conta, { dias: url.searchParams.get("dias"), de: url.searchParams.get("de"), ate: url.searchParams.get("ate") })) }); }
    catch (e) { return erroJson(e); }
  }
  if (resto.startsWith("google/ads/") && ["campanha", "orcamento", "negativa", "recomendacao"].includes(resto.slice(11)) && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores mexem nos anúncios." }, 403);
    const c = await corpoDe().catch(e => e);
    if (c instanceof Error) return json({ erro: c.message }, 400);
    const conta = await contaGoogleDe(env, orgId, Number(c.marca_id));
    if (!conta?.ads_cliente) return json({ erro: "Escolha a conta do Google Ads primeiro." }, 409);
    try {
      await alterarAds(env, k, conta, resto.slice(11), c);
      await k.auditar(env, request, k.sessao, orgId, "INTEGRACAO", `Google Ads (${conta.ads_cliente}): ${resto.slice(11)} ${JSON.stringify({ ...c, marca_id: undefined }).slice(0, 200)}`);
      return json({ ok: true });
    } catch (e) { return json({ erro: e.message }, e.status && e.status < 500 ? 400 : 502); }
  }

  // Concorrentes
  if (resto === "google/concorrentes" && metodo === "GET") {
    const conta = await marcaDe();
    if (!conta) return json({ conectada: false });
    const hist = (await env.DB.prepare("SELECT busca, dia, posicao, total FROM plt_mk_concorrencia WHERE org_id=? AND marca_id=? ORDER BY dia DESC LIMIT 400").bind(orgId, conta.marca_id).all())?.results || [];
    const ultimo = await env.DB.prepare("SELECT busca, dia, posicao, dados FROM plt_mk_concorrencia WHERE org_id=? AND marca_id=? ORDER BY criado_ms DESC LIMIT 1").bind(orgId, conta.marca_id).first();
    return json({ conectada: true, configurado: Boolean(chavePlaces(env)), perfil: conta.local_titulo, historico: hist, ultimo: ultimo ? { busca: ultimo.busca, dia: ultimo.dia, posicao: ultimo.posicao, lugares: JSON.parse(ultimo.dados || "[]") } : null });
  }
  if (resto === "google/concorrentes" && metodo === "POST") {
    if (!pode(papel, "AGENTE")) return json({ erro: "Seu perfil não tem permissão para esta ação." }, 403);
    const c = await corpoDe().catch(e => e);
    if (c instanceof Error) return json({ erro: c.message }, 400);
    const conta = await contaGoogleDe(env, orgId, Number(c.marca_id));
    if (!conta) return json({ erro: "Conecte o Google desta marca primeiro." }, 409);
    const busca = String(c.busca || "").trim().slice(0, 120);
    if (busca.length < 3) return json({ erro: "Escreva a busca, com a cidade (ex.: oficina mecânica em Niterói)." }, 400);
    try { return json(await buscarConcorrentes(env, k, conta, busca)); }
    catch (e) { return json({ erro: e.message }, e.status || 502); }
  }
  return null;
}

// Uma vez por dia por perfil: suspensão/verificação e dados mudados pelo Google ou por outras pessoas viram aviso.
export async function vigiarPerfis(env, k, avisar) {
  await garantir(env);
  const hoje = new Date(k.agora(env) - 3 * 3600000).toISOString().slice(0, 10);
  const contas = (await env.DB.prepare("SELECT g.* FROM plt_mk_google g WHERE NOT EXISTS (SELECT 1 FROM plt_meta m WHERE m.chave='situacao_' || g.id || '_' || ?) LIMIT 3").bind(hoje).all().catch(() => null))?.results || [];
  for (const conta of contas) {
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind(`situacao_${conta.id}_${hoje}`, "1").run().catch(() => {});
    let s;
    try { s = await situacaoDoPerfil(env, k, conta); } catch (e) { continue; }
    const chaveS = `gbp_situacao:${conta.marca_id}`, chaveM = `gbp_mudancas:${conta.marca_id}`;
    if (["suspenso", "nao_verificado", "conflito"].includes(s.situacao)) {
      await registrarProblema(env, conta.org_id, { chave: chaveS, area: "PUBLICACOES", gravidade: "ALTA", titulo: `Perfil do Google com problema: ${conta.local_titulo}`, motivo: s.motivo, dica: "Abra o perfil em business.google.com para ver o aviso do Google e resolver.", link: "#/google/checagem" });
      if (avisar) await avisar(conta.org_id, `⚠️ Perfil do Google com problema: ${conta.local_titulo}\n${s.motivo}`).catch(() => {});
    } else if (s.situacao === "ativo") await resolverProblema(env, conta.org_id, chaveS);
    if (s.mudancas_do_google.length) {
      const lista = s.mudancas_do_google.map(m => `${m.campo}: "${m.no_google}"`).join("; ");
      await registrarProblema(env, conta.org_id, { chave: chaveM, area: "PUBLICACOES", gravidade: "MEDIA", titulo: `O Google mudou dados do perfil ${conta.local_titulo}`, motivo: lista, dica: "Confira em Google → Checagem do perfil e, se estiver errado, corrija em Editar perfil.", link: "#/google/checagem" });
    } else await resolverProblema(env, conta.org_id, chaveM);
  }
  return contas.length;
}

// ----- Relatório do perfil em PDF (para o cliente), com a logo do perfil, comparação com o período anterior,
// avaliações, posições nas buscas e o que fazer a seguir.
const fmtN = v => v == null ? "—" : Number(v).toLocaleString("pt-BR");
const variacao = (a, b) => b ? `${a >= b ? "+" : ""}${Math.round((a / b - 1) * 100)}% vs. período anterior` : "";
const dataBr = d => d.toISOString().slice(0, 10).split("-").reverse().join("/");
async function logoDaMarca(env, orgId, marca) {
  if (!marca?.logo_midia_id) return null;
  const m = await env.DB.prepare("SELECT mime, dados FROM plt_mk_midias WHERE id=? AND org_id=?").bind(marca.logo_midia_id, orgId).first().catch(() => null);
  if (!m || !/jpe?g/.test(m.mime || "")) return null;
  const bytes = Uint8Array.from(atob(m.dados), c => c.charCodeAt(0)), d = dimensoesJpeg(bytes);
  return d ? { bytes, ...d } : null;
}
export async function relatorioPdfDoPerfil(env, k, conta, dias = 30) {
  const token = await tokenDa(env, k, conta);
  const fim = new Date(k.agora(env) - ATRASO_DIAS * DIA_MS), ini = new Date(fim.getTime() - (dias - 1) * DIA_MS);
  const fimA = new Date(ini.getTime() - DIA_MS), iniA = new Date(fimA.getTime() - (dias - 1) * DIA_MS);
  const [atual, antes] = await Promise.all([metricas(conta, token, ini, fim), metricas(conta, token, iniA, fimA).catch(() => null)]);
  const marca = await env.DB.prepare("SELECT * FROM plt_mk_marcas WHERE id=? AND org_id=?").bind(conta.marca_id, conta.org_id).first().catch(() => null);
  const org = await env.DB.prepare("SELECT nome FROM plt_organizacoes WHERE id=?").bind(conta.org_id).first().catch(() => null);
  const desde = ini.getTime(), um = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first().catch(() => null)) || {};
  const av = await um("SELECT COUNT(*) n, AVG(nota) media, SUM(CASE WHEN status='RESPONDIDA' THEN 1 ELSE 0 END) resp, SUM(CASE WHEN nota<=3 THEN 1 ELSE 0 END) ruins FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? AND google_id IS NOT NULL AND removida_ms IS NULL AND criado_ms>=?", conta.org_id, conta.marca_id, desde);
  const posts = await um("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND marca_id=? AND canais LIKE '%google%' AND status='PUBLICADO' AND atualizado_ms>=?", conta.org_id, conta.marca_id, desde);
  const pal = (await env.DB.prepare("SELECT w.palavra, w.cidade, x.semana, x.posicao FROM plt_mk_palavras w JOIN plt_mk_posicoes x ON x.palavra_id=w.id WHERE w.org_id=? AND w.marca_id=? ORDER BY x.semana DESC").bind(conta.org_id, conta.marca_id).all().catch(() => null))?.results || [];
  const porPalavra = new Map(); for (const x of pal) { const l = porPalavra.get(x.palavra) || []; l.push(x); porPalavra.set(x.palavra, l); }
  const grade = await um("SELECT palavra, raio_km, media, top3, criado_ms FROM plt_mk_geogrid WHERE org_id=? AND marca_id=? ORDER BY id DESC LIMIT 1", conta.org_id, conta.marca_id);
  const pos = v => v == null ? "—" : v === 0 ? "fora do top 20" : v + "º";
  const acoes = Number(atual.ligacoes || 0) + Number(atual.rotas || 0) + Number(atual.cliques_site || 0) + Number(atual.mensagens || 0);
  const acoesA = antes ? Number(antes.ligacoes || 0) + Number(antes.rotas || 0) + Number(antes.cliques_site || 0) + Number(antes.mensagens || 0) : 0;
  const proximos = [];
  if (Number(av.n || 0) < Math.max(4, Math.round(dias / 7))) proximos.push("Pedir avaliação a todo cliente satisfeito: avaliação nova e frequente é o que mais ajuda a subir no Maps.");
  if (Number(posts.n || 0) < Math.max(2, Math.round(dias / 7))) proximos.push("Publicar pelo menos 1 post por semana no perfil (serviço feito, dica ou oferta).");
  if (Number(av.n || 0) > Number(av.resp || 0)) proximos.push(`Responder as ${Number(av.n) - Number(av.resp || 0)} avaliação(ões) do período ainda sem resposta.`);
  if (!porPalavra.size) proximos.push("Acompanhar as buscas mais importantes (ex.: o serviço principal + a cidade) para medir a posição toda semana.");
  proximos.push("Enviar fotos novas todo mês: fachada, ambiente, equipe trabalhando e serviços prontos.");
  const blocos = [
    { tipo: "metricas", itens: [
      { rotulo: "Visualizações do perfil", valor: fmtN(atual.visualizacoes), nota: antes ? variacao(atual.visualizacoes, antes.visualizacoes) : "" },
      { rotulo: "Clientes que agiram", valor: fmtN(acoes), nota: antes ? variacao(acoes, acoesA) : "ligações, rotas, site e mensagens" },
      { rotulo: "Ligações", valor: fmtN(atual.ligacoes), nota: antes ? variacao(atual.ligacoes, antes.ligacoes) : "" },
      { rotulo: "Pedidos de rota", valor: fmtN(atual.rotas), nota: antes ? variacao(atual.rotas, antes.rotas) : "" }] },
    { tipo: "metricas", itens: [
      { rotulo: "Na Pesquisa Google", valor: fmtN(atual.buscas) }, { rotulo: "No Google Maps", valor: fmtN(atual.maps) },
      { rotulo: "Cliques no site", valor: fmtN(atual.cliques_site) }, { rotulo: "Mensagens", valor: fmtN(atual.mensagens) }] },
    { tipo: "titulo", texto: "Avaliações" },
    { tipo: "metricas", itens: [
      { rotulo: "Nota no Google", valor: conta.media_google ? String(Math.round(conta.media_google * 10) / 10).replace(".", ",") : "—", nota: conta.total_google ? `${fmtN(conta.total_google)} avaliações no total` : "" },
      { rotulo: "Avaliações novas", valor: fmtN(av.n || 0), nota: av.media ? `nota média ${String(Math.round(av.media * 10) / 10).replace(".", ",")}` : "" },
      { rotulo: "Respondidas", valor: fmtN(av.resp || 0), nota: av.n ? `de ${fmtN(av.n)} no período` : "" },
      { rotulo: "Ruins (3 estrelas ou menos)", valor: fmtN(av.ruins || 0) }] },
    { tipo: "titulo", texto: "Posição nas buscas" }
  ];
  if (porPalavra.size) blocos.push({ tipo: "tabela", colunas: ["Busca", "Posição agora", "Semana anterior", "Mudança"], larguras: [3, 1.2, 1.2, 1], linhas: [...porPalavra.entries()].map(([p, l]) => {
    const a = l[0]?.posicao, b = l[1]?.posicao;
    const m = a && b ? (b - a > 0 ? `subiu ${b - a}` : b - a < 0 ? `caiu ${a - b}` : "igual") : "—";
    return [`${p}${l[0]?.cidade ? " (" + l[0].cidade + ")" : ""}`, pos(a), pos(b), m]; }) });
  else blocos.push({ tipo: "texto", texto: "Nenhuma busca acompanhada ainda." });
  if (grade.palavra) blocos.push({ tipo: "texto", texto: `Mapa de posição para "${grade.palavra}" (raio de ${String(grade.raio_km).replace(".", ",")} km): posição média ${grade.media != null ? String(grade.media).replace(".", ",") : "—"}, no top 3 em ${grade.top3}% dos pontos.` });
  blocos.push({ tipo: "titulo", texto: "Trabalho no período" }, { tipo: "texto", texto: `${fmtN(posts.n || 0)} post(s) publicados no perfil e ${fmtN(av.resp || 0)} avaliação(ões) respondidas.` },
    { tipo: "titulo", texto: "Próximos passos" }, { tipo: "lista", itens: proximos });
  const logo = await logoDaMarca(env, conta.org_id, marca);
  const bytes = gerarPdf({ titulo: `Relatório do Google — ${conta.local_titulo}`, subtitulo: `${dataBr(ini)} a ${dataBr(fim)}${org?.nome ? " · " + org.nome : ""}`, rodape: "Números do Google (Perfil da Empresa). O Google libera os dados com alguns dias de atraso.", logo, blocos });
  return { nome: `relatorio-google-${String(conta.local_titulo || "perfil").toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${fim.toISOString().slice(0, 10)}.pdf`, bytes };
}
const paraBase64 = b => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
// Proposta comercial a partir da pré-análise (o diagnóstico vem da tela; preços e serviços quem escreve é a agência).
export function propostaPdf({ agencia, empresa, analise, concorrentes = [], posicao, busca, valor, servicos = [], validade = 15, contato = "" }) {
  const falta = (analise?.itens || []).filter(i => i.ok === "falta" || i.ok === "parcial");
  const media = concorrentes.length ? concorrentes.slice(0, 5).reduce((t, c) => t + Number(c.avaliacoes || 0), 0) / Math.min(5, concorrentes.length) : 0;
  const blocos = [
    { tipo: "texto", texto: `Preparamos esta proposta depois de analisar o perfil de ${empresa.nome} no Google e compará-lo com os concorrentes que aparecem na frente dele.` }, { tipo: "espaco", altura: 6 },
    { tipo: "metricas", itens: [{ rotulo: "Nota do perfil hoje", valor: `${analise?.nota ?? "—"}%`, nota: "do ideal" }, { rotulo: "Nota no Google", valor: empresa.nota ? String(empresa.nota).replace(".", ",") : "—", nota: `${fmtN(empresa.avaliacoes)} avaliações` },
      { rotulo: "Posição na categoria", valor: posicao ? posicao + "º" : posicao === 0 ? "20+" : "—", nota: busca || "" }, { rotulo: "Avaliações dos líderes", valor: media ? fmtN(Math.round(media)) : "—", nota: "média dos 5 primeiros" }] },
    { tipo: "titulo", texto: "O que encontramos" },
    falta.length ? { tipo: "lista", itens: falta.map(i => ({ texto: `${i.titulo}: ${i.detalhe}${i.dica ? " — " + i.dica : ""}` })) } : { tipo: "texto", texto: "O perfil já está bem cuidado; o trabalho é manter a constância e crescer nas avaliações." }
  ];
  if (concorrentes.length) blocos.push({ tipo: "titulo", texto: "Quem aparece na frente" }, { tipo: "tabela", colunas: ["Posição", "Empresa", "Nota", "Avaliações"], larguras: [0.8, 3, 0.8, 1], linhas: concorrentes.slice(0, 8).map(c => [c.posicao + "º", c.nome, c.nota ? String(c.nota).replace(".", ",") : "—", fmtN(c.avaliacoes)]) });
  blocos.push({ tipo: "titulo", texto: "O que vamos fazer" }, { tipo: "lista", itens: (servicos.length ? servicos : ["Otimização completa do perfil (descrição, categorias, serviços, horários e fotos)", "Posts toda semana no perfil", "Resposta a todas as avaliações", "Campanha para pedir avaliações aos clientes", "Mapa de posição e relatório mensal com os resultados"]).map(t => ({ texto: String(t) })) });
  if (valor) blocos.push({ tipo: "titulo", texto: "Investimento" }, { tipo: "texto", texto: String(valor), tamanho: 14, negrito: true }, { tipo: "texto", texto: `Proposta válida por ${validade} dias.` });
  if (contato) blocos.push({ tipo: "texto", texto: contato });
  const bytes = gerarPdf({ titulo: `Proposta — ${empresa.nome}`, subtitulo: `${agencia || ""}${agencia ? " · " : ""}${new Date().toLocaleDateString("pt-BR")}`, rodape: "Diagnóstico feito com os dados públicos do Google no dia da proposta.", blocos });
  return { nome: `proposta-${String(empresa.nome || "empresa").toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.pdf`, base64: paraBase64(bytes) };
}
// Envio automático do relatório em PDF para o cliente (quinzenal: dias 1 e 16; mensal: dia 1), a partir das 8h.
export async function enviarRelatoriosPdf(env, k, enviar) {
  const agoraBr = new Date(k.agora(env) - 3 * 3600000), dia = agoraBr.getUTCDate(), hoje = agoraBr.toISOString().slice(0, 10);
  if (agoraBr.getUTCHours() < 8 || ![1, 16].includes(dia)) return 0;
  const cfgs = (await env.DB.prepare("SELECT chave, valor FROM plt_meta WHERE chave LIKE 'relpdf_%'").all().catch(() => null))?.results || [];
  let n = 0;
  for (const c of cfgs) {
    const m = c.chave.match(/^relpdf_(\d+)_(\d+)$/); if (!m) continue;
    let cfg; try { cfg = JSON.parse(c.valor); } catch { continue; }
    if (!cfg.ativo || !(cfg.emails || "").trim() || (cfg.frequencia !== "quinzenal" && dia !== 1)) continue;
    const marca = `relpdf_env_${m[1]}_${m[2]}_${hoje}`;
    if (await env.DB.prepare("SELECT 1 FROM plt_meta WHERE chave=?").bind(marca).first().catch(() => null)) continue;
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind(marca, "1").run();
    const conta = await contaGoogleDe(env, Number(m[1]), Number(m[2])).catch(() => null);
    if (!conta) continue;
    try {
      const r = await relatorioPdfDoPerfil(env, k, conta, cfg.frequencia === "quinzenal" ? 15 : 30);
      for (const para of cfg.emails.split(/[,;\s]+/).filter(e => /@/.test(e)).slice(0, 10))
        await enviar(para, `Relatório do Google — ${conta.local_titulo}`, `Olá!\n\nSegue em anexo o relatório do perfil ${conta.local_titulo} no Google: visualizações, clientes que ligaram e pediram rota, avaliações e posição nas buscas, com os próximos passos.\n\nQualquer dúvida, é só responder este e-mail.`, [{ nome: r.nome, base64: paraBase64(r.bytes) }]);
      n++;
    } catch (e) { console.error("relatório pdf", e?.message); }
  }
  return n;
}
