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
const SINCRONIZAR_A_CADA_MS = 60 * 60000; // avaliações e desempenho: no máximo uma vez por hora
const API_CONTAS = "https://mybusinessaccountmanagement.googleapis.com/v1";
const API_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
const API_V4 = "https://mybusiness.googleapis.com/v4";
const API_DESEMPENHO = "https://businessprofileperformance.googleapis.com/v1";
const ESTRELAS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const IDIOMA_GOOGLE = { "pt-BR": "pt-BR", en: "en", es: "es", de: "de", it: "it", fr: "fr", ja: "ja", hi: "hi" };

const DDL = [
  `CREATE TABLE IF NOT EXISTS plt_mk_google (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, conta_nome TEXT NOT NULL, local_nome TEXT NOT NULL, local_titulo TEXT, token_cifrado TEXT NOT NULL, criado_por TEXT, criado_ms INTEGER NOT NULL, atualizado_ms INTEGER NOT NULL, sincronizado_ms INTEGER, UNIQUE(org_id, marca_id))`
];
const prontos = new WeakSet();
async function garantir(env) {
  if (prontos.has(env.DB)) return;
  await env.DB.batch(DDL.map(s => env.DB.prepare(s)));
  await env.DB.prepare("ALTER TABLE plt_mk_avaliacoes ADD COLUMN google_id TEXT").run().catch(() => { }); // coluna já existe
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
    const contas = (await env.DB.prepare("SELECT marca_id, local_titulo, atualizado_ms, sincronizado_ms FROM plt_mk_google WHERE org_id=?").bind(orgId).all())?.results || [];
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
    try { return json({ ok: true, ...(await sincronizarConta(env, k, conta)) }); }
    catch (e) { return json({ erro: e.message }, 502); }
  }
  // Desempenho ao vivo: últimos 30 dias e as buscas que mais levaram ao perfil no último mês.
  if (resto === "google/desempenho" && metodo === "GET") {
    const conta = await contaGoogleDe(env, orgId, Number(url.searchParams.get("marca")));
    if (!conta) return json({ conectada: false });
    try {
      const token = await tokenDa(env, k, conta);
      const fim = new Date(agora(env) - 2 * 86400000), ini = new Date(fim.getTime() - 29 * 86400000);
      const [totais, palavras] = await Promise.all([metricas(conta, token, ini, fim), palavrasDoMes(conta, token, agora(env)).catch(() => [])]);
      return json({ conectada: true, perfil: conta.local_titulo, de: ini.toISOString().slice(0, 10), ate: fim.toISOString().slice(0, 10), totais, palavras });
    } catch (e) { return json({ conectada: true, erro: e.message }); }
  }
  return json({ erro: "Rota não encontrada." }, 404);
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
async function sincronizarAvaliacoes(env, k, conta, token) {
  let novas = 0, total = 0, pagina = "";
  for (let i = 0; i < 4; i++) {
    const d = await chamar("GET", `${API_V4}/${caminhoV4(conta)}/reviews?pageSize=50${pagina ? "&pageToken=" + encodeURIComponent(pagina) : ""}`, token);
    for (const r of d.reviews || []) {
      total++;
      const nota = ESTRELAS[r.starRating] || 0;
      const resposta = r.reviewReply?.comment || null;
      const existe = await env.DB.prepare("SELECT id FROM plt_mk_avaliacoes WHERE org_id=? AND marca_id=? AND google_id=?").bind(conta.org_id, conta.marca_id, String(r.reviewId)).first();
      if (existe) {
        if (resposta) await env.DB.prepare("UPDATE plt_mk_avaliacoes SET resposta=?, status='RESPONDIDA' WHERE id=?").bind(resposta, existe.id).run();
        continue;
      }
      await env.DB.prepare("INSERT INTO plt_mk_avaliacoes(org_id,marca_id,autor,nota,texto,data,resposta,status,criado_ms,google_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(conta.org_id, conta.marca_id, String(r.reviewer?.displayName || "Cliente").slice(0, 120), nota, String(r.comment || "").slice(0, 3000), String(r.createTime || "").slice(0, 10) || null, resposta, resposta ? "RESPONDIDA" : "PENDENTE", k.agora(env), String(r.reviewId)).run();
      novas++;
    }
    pagina = d.nextPageToken || "";
    if (!pagina) break;
  }
  return { novas, total };
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
const METRICAS = {
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: "visualizacoes", BUSINESS_IMPRESSIONS_MOBILE_MAPS: "visualizacoes",
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "buscas", BUSINESS_IMPRESSIONS_MOBILE_SEARCH: "buscas",
  CALL_CLICKS: "ligacoes", BUSINESS_DIRECTION_REQUESTS: "rotas", WEBSITE_CLICKS: "cliques_site", BUSINESS_CONVERSATIONS: "mensagens"
};
const parteData = (prefixo, d) => `${prefixo}.year=${d.getUTCFullYear()}&${prefixo}.month=${d.getUTCMonth() + 1}&${prefixo}.day=${d.getUTCDate()}`;
async function metricas(conta, token, ini, fim) {
  const url = `${API_DESEMPENHO}/${conta.local_nome}:fetchMultiDailyMetricsTimeSeries?${Object.keys(METRICAS).map(m => "dailyMetrics=" + m).join("&")}&${parteData("dailyRange.startDate", ini)}&${parteData("dailyRange.endDate", fim)}`;
  const d = await chamar("GET", url, token);
  const totais = { visualizacoes: 0, buscas: 0, ligacoes: 0, rotas: 0, cliques_site: 0, mensagens: 0 };
  for (const grupo of d.multiDailyMetricTimeSeries || []) for (const s of grupo.dailyMetricTimeSeries || []) {
    const campo = METRICAS[s.dailyMetric];
    if (!campo) continue;
    for (const v of s.timeSeries?.datedValues || []) totais[campo] += Number(v.value || 0);
  }
  // "Visualizações do perfil" = todas as vezes que o perfil apareceu (Maps + Pesquisa).
  totais.visualizacoes += totais.buscas;
  return totais;
}
async function palavrasDoMes(conta, token, agoraMs) {
  const d = new Date(agoraMs); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); // mês passado (completo)
  const ano = d.getUTCFullYear(), mes = d.getUTCMonth() + 1;
  const r = await chamar("GET", `${API_DESEMPENHO}/${conta.local_nome}/searchkeywords/impressions/monthly?monthlyRange.startMonth.year=${ano}&monthlyRange.startMonth.month=${mes}&monthlyRange.endMonth.year=${ano}&monthlyRange.endMonth.month=${mes}&pageSize=100`, token);
  return (r.searchKeywordsCounts || []).map(x => ({ palavra: String(x.searchKeyword || ""), buscas: x.insightsValue?.value != null ? Number(x.insightsValue.value) : null, menos_de: x.insightsValue?.threshold != null ? Number(x.insightsValue.threshold) : null }))
    .filter(x => x.palavra).sort((a, b) => (b.buscas ?? b.menos_de ?? 0) - (a.buscas ?? a.menos_de ?? 0)).slice(0, 15);
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

export async function sincronizarConta(env, k, conta) {
  const token = await tokenDa(env, k, conta);
  const av = await sincronizarAvaliacoes(env, k, conta, token);
  let desempenho = true;
  try { await gravarSemanas(env, k, conta, token); } catch (e) { desempenho = false; console.error("google desempenho", e?.message); }
  await env.DB.prepare("UPDATE plt_mk_google SET sincronizado_ms=? WHERE id=?").bind(k.agora(env), conta.id).run();
  return { avaliacoes_novas: av.novas, avaliacoes_total: av.total, desempenho };
}

// Cron: de hora em hora, traz avaliações novas e atualiza o desempenho de cada perfil conectado.
export async function sincronizarGooglePendentes(env, k) {
  if (!googleConfigurada(env)) return { sincronizadas: 0 };
  await garantir(env);
  const contas = (await env.DB.prepare("SELECT * FROM plt_mk_google WHERE sincronizado_ms IS NULL OR sincronizado_ms < ? ORDER BY sincronizado_ms LIMIT 5").bind(k.agora(env) - SINCRONIZAR_A_CADA_MS).all())?.results || [];
  let n = 0;
  for (const c of contas) {
    try { await sincronizarConta(env, k, c); n++; }
    catch (e) {
      console.error("google sync", c.id, e?.message);
      await env.DB.prepare("UPDATE plt_mk_google SET sincronizado_ms=? WHERE id=?").bind(k.agora(env), c.id).run(); // tenta de novo na próxima hora
    }
  }
  return { sincronizadas: n };
}
