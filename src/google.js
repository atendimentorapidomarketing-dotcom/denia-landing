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
  `CREATE TABLE IF NOT EXISTS plt_mk_google (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, conta_nome TEXT NOT NULL, local_nome TEXT NOT NULL, local_titulo TEXT, token_cifrado TEXT NOT NULL, criado_por TEXT, criado_ms INTEGER NOT NULL, atualizado_ms INTEGER NOT NULL, sincronizado_ms INTEGER, UNIQUE(org_id, marca_id))`
];
const ALTERS = ["ALTER TABLE plt_mk_google ADD COLUMN desempenho_ms INTEGER", "ALTER TABLE plt_mk_google ADD COLUMN erro TEXT", "ALTER TABLE plt_mk_google ADD COLUMN maps_uri TEXT", "ALTER TABLE plt_mk_avaliacoes ADD COLUMN removida_ms INTEGER",
  "ALTER TABLE plt_mk_avaliacoes ADD COLUMN visto_ms INTEGER", "ALTER TABLE plt_mk_google ADD COLUMN sync_token TEXT", "ALTER TABLE plt_mk_google ADD COLUMN sync_inicio_ms INTEGER",
  "ALTER TABLE plt_mk_google ADD COLUMN total_google INTEGER", "ALTER TABLE plt_mk_google ADD COLUMN media_google REAL", "ALTER TABLE plt_mk_google ADD COLUMN completo_ms INTEGER"];
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
const baseDe = request => new URL(request.url).origin;

// ----- Chamadas à API do Google
function explicarErro(d, status) {
  const msg = String(d?.error?.message || d?.error_description || d?.error || `HTTP ${status}`);
  if (status === 401 || /invalid_grant/i.test(msg)) return "O acesso ao Google desta marca expirou ou foi removido. Conecte de novo em Marcas.";
  if (status === 403 && /disabled|not been used|has not been enabled/i.test(msg)) return "Uma API do Google Perfil da Empresa não está ativada no projeto do Google Cloud. Ative as APIs do Google Business Profile e tente de novo.";
  if (status === 403) return "O Google não deu permissão para esta ação. Confira se a conta usada é proprietária ou administradora do perfil e conecte de novo.";
  if (status === 429) return "Limite de uso do Google atingido por agora. A DENIA tenta de novo mais tarde.";
  return "O Google respondeu: " + msg.slice(0, 220);
}
async function chamar(metodo, url, token, corpo) {
  const r = await fetch(url, {
    method: metodo, signal: AbortSignal.timeout(30000),
    headers: { authorization: "Bearer " + token, ...(corpo ? { "content-type": "application/json" } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(explicarErro(d, r.status)); e.status = r.status; throw e; }
  return d;
}
async function trocarToken(env, params) {
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
    const contas = (await env.DB.prepare(`SELECT marca_id, local_titulo, atualizado_ms, sincronizado_ms, erro, total_google, media_google, sync_token IS NOT NULL AS lendo,
      (SELECT COUNT(*) FROM plt_mk_avaliacoes a WHERE a.org_id=g.org_id AND a.marca_id=g.marca_id AND a.google_id IS NOT NULL AND a.removida_ms IS NULL) AS na_denia FROM plt_mk_google g WHERE org_id=?`).bind(orgId).all())?.results || [];
    return json({ configurada: googleConfigurada(env), faltando: faltando(env), contas });
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
    dialogo.searchParams.set("redirect_uri", baseDe(request) + "/api/google/retorno");
    dialogo.searchParams.set("response_type", "code");
    dialogo.searchParams.set("scope", ESCOPO);
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
    const l = reg.locais.find(x => x.local === String(corpo.local_id || ""));
    if (!l) return json({ erro: "Escolha um dos perfis." }, 400);
    await env.DB.prepare(`INSERT INTO plt_mk_google(org_id,marca_id,conta_nome,local_nome,local_titulo,token_cifrado,criado_por,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(org_id, marca_id) DO UPDATE SET conta_nome=excluded.conta_nome, local_nome=excluded.local_nome, local_titulo=excluded.local_titulo, token_cifrado=excluded.token_cifrado, criado_por=excluded.criado_por, atualizado_ms=excluded.atualizado_ms, sincronizado_ms=NULL`)
      .bind(orgId, reg.m, l.conta, l.local, l.titulo, await k.cifrar(env, reg.refresh), sessao.usuario.email, agora(env), agora(env)).run();
    await env.DB.prepare("UPDATE plt_mk_marcas SET google=COALESCE(NULLIF(google,''),?) WHERE id=? AND org_id=?").bind(l.titulo, reg.m, orgId).run();
    await env.DB.prepare("DELETE FROM plt_meta WHERE chave=?").bind("google_n_" + n).run();
    await auditar(env, request, sessao, orgId, "INTEGRACAO", `Google conectado à marca #${reg.m}: perfil ${l.titulo}`);
    // Já traz as avaliações e o desempenho.
    const conta = await contaGoogleDe(env, orgId, reg.m);
    const sinc = await sincronizarConta(env, k, conta).catch(e => ({ erro: e.message }));
    return json({ ok: true, perfil: l.titulo, sincronizacao: sinc });
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
    if (!conta) return json({ erro: "Esta marca ainda não está conectada ao Google (Marcas → Conectar Google)." }, 409);
    try { return json({ ok: true, ...(await sincronizarConta(env, k, conta, { continuar: corpo.continuar === true })) }); }
    catch (e) {
      await env.DB.prepare("UPDATE plt_mk_google SET erro=? WHERE id=?").bind(String(e?.message || e).slice(0, 400), conta.id).run();
      return json({ erro: e.message }, 502);
    }
  }
  // Desempenho de qualquer período (7 dias a 18 meses, ou datas escolhidas), com comparação e as buscas do período.
  if (resto === "google/desempenho" && metodo === "GET") {
    const conta = await contaGoogleDe(env, orgId, Number(url.searchParams.get("marca")));
    if (!conta) return json({ conectada: false });
    const q = n => url.searchParams.get(n) || undefined;
    try { return json({ conectada: true, ...(await desempenhoDoPeriodo(env, k, conta, { dias: q("dias"), de: q("de"), ate: q("ate"), atalho: q("atalho"), comparar: q("comparar") })) }); }
    catch (e) { return json({ conectada: true, erro: e.message }); }
  }
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
    const t = await trocarToken(env, { grant_type: "authorization_code", code, redirect_uri: baseDe(request) + "/api/google/retorno" });
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
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("google_n_" + st.n, await k.cifrar(env, JSON.stringify({ ...reg, refresh: t.refresh_token, locais, e: k.agora(env) + VALIDADE_STATE_MS }))).run();
    return pagina("Quase pronto", "Conta do Google autorizada. Agora escolha, na plataforma, o perfil desta marca.", `/app#/marcas/google-${st.n}`);
  } catch (e) {
    console.error("google retorno", e?.message);
    return pagina("Conexão não concluída", e.message || "Não foi possível falar com o Google. Tente de novo.", "/app#/marcas");
  }
}

// ----- Publicação de post no perfil (texto + foto + botão)
export async function publicarGoogle(env, k, conta, p, imagem) {
  const token = await tokenDa(env, k, conta);
  const marca = await env.DB.prepare("SELECT site, idioma FROM plt_mk_marcas WHERE id=?").bind(p.marca_id).first();
  const resumo = [p.legenda, p.chamada].map(x => String(x || "").trim()).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join("\n\n").slice(0, 1500);
  if (!resumo) throw new Error("O post do Google precisa de texto (a legenda está vazia).");
  const corpo = { languageCode: IDIOMA_GOOGLE[marca?.idioma] || "pt-BR", summary: resumo, topicType: "STANDARD" };
  if (imagem) corpo.media = [{ mediaFormat: "PHOTO", sourceUrl: imagem }];
  const site = String(marca?.site || "").trim();
  corpo.callToAction = /^https?:\/\//i.test(site) ? { actionType: "LEARN_MORE", url: site } : { actionType: "CALL" };
  const r = await chamar("POST", `${API_V4}/${caminhoV4(conta)}/localPosts`, token, corpo);
  return { id: r.name || "google", link: r.searchUrl || null };
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
async function palavrasDoPeriodo(conta, token, ini, fim, agoraMs, limite = 50) {
  const agora = new Date(agoraMs), ultimoMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1));
  let ate = new Date(Date.UTC(fim.getUTCFullYear(), fim.getUTCMonth(), 1));
  if (ate > ultimoMes) ate = ultimoMes;
  let de = new Date(Date.UTC(ini.getUTCFullYear(), ini.getUTCMonth(), 1));
  if (de > ate) de = ate;
  const faixa = `monthlyRange.startMonth.year=${de.getUTCFullYear()}&monthlyRange.startMonth.month=${de.getUTCMonth() + 1}&monthlyRange.endMonth.year=${ate.getUTCFullYear()}&monthlyRange.endMonth.month=${ate.getUTCMonth() + 1}`;
  const todas = [];
  let pagina = "";
  for (let i = 0; i < 5; i++) {
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
    palavrasDoPeriodo(conta, token, per.ini, per.fim, agora).catch(() => ({ lista: [], mes_de: null, mes_ate: null }))
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
