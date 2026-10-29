import { registrarUso, lerLimitesMeta, orgDoUso, recursoDo, comOrgUso } from "./uso.js";
// DENIA Platform — Instagram e Facebook (API oficial da Meta).
// Conexão por marca (Login do Facebook), publicação dos posts aprovados no horário (cron) e "Publicar agora".
//
// Secrets no Worker denia-landing: META_APP_ID, META_APP_SECRET e, se o app usar "Login do Facebook
// para Empresas", META_CONFIG_ID (o ID da configuração com as permissões). Opcional: META_GRAPH_VERSION.
//
// O cookie de sessão da plataforma é SameSite=Strict, então a volta da Meta não traz a sessão:
// ela é validada por um "state" assinado e de uso único.

import { contaGoogleDe, publicarGoogle, googleConfigurada } from "./google.js";

const GRAPH_PADRAO = "v25.0";
// Publicar, ler os números (insights), responder e moderar comentários do Instagram e da página.
const PERMISSOES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "pages_manage_engagement", "pages_read_user_content", "read_insights",
  "instagram_basic", "instagram_content_publish", "instagram_manage_comments", "instagram_manage_insights", "business_management"];
const VALIDADE_STATE_MS = 15 * 60000;
const MAX_TENTATIVAS = 3;
const JANELA_ATRASO_MS = 48 * 3600000; // post agendado há mais de 48 h não sai sozinho (evita surpresa)

const DDL = [
  `CREATE TABLE IF NOT EXISTS plt_mk_contas (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, pagina_id TEXT NOT NULL, pagina_nome TEXT, ig_id TEXT, ig_usuario TEXT, token_cifrado TEXT NOT NULL, criado_por TEXT, criado_ms INTEGER NOT NULL, atualizado_ms INTEGER NOT NULL, UNIQUE(org_id, marca_id))`
];
const prontos = new WeakSet();
export async function garantir(env) {
  if (prontos.has(env.DB)) return;
  await env.DB.batch(DDL.map(s => env.DB.prepare(s)));
  await env.DB.prepare("ALTER TABLE plt_mk_posts ADD COLUMN publicacao TEXT").run().catch(() => { });
  await env.DB.prepare("ALTER TABLE plt_mk_posts ADD COLUMN tentativas INTEGER NOT NULL DEFAULT 0").run().catch(() => { });
  prontos.add(env.DB);
}

const versao = env => String(env.META_GRAPH_VERSION || GRAPH_PADRAO).trim();
export const metaConfigurada = env => Boolean(String(env.META_APP_ID || "").trim() && String(env.META_APP_SECRET || "").trim());

// Nome curto da chamada (sem ids) para a página Consumo: "GET media", "POST media_publish", "POST photos"…
function operacaoMeta(metodo, caminho) {
  const partes = String(caminho).split("?")[0].split("/").filter(x => x && !/^\d+$/.test(x));
  return `${metodo} ${partes.slice(-1)[0] || "objeto"}`.slice(0, 50);
}
// Dados públicos da página e do Instagram para completar o cadastro do perfil (só o que estiver vazio).
async function preencherPelaMeta(env, orgId, marcaId, p) {
  const [pag, ig] = await Promise.all([
    graph(env, "GET", p.id, { fields: "about,description,category,website,phone,whatsapp_number,link,location{city,state},picture.width(512).height(512){url,is_silhouette}", access_token: p.token }).catch(() => ({})),
    p.ig_id ? graph(env, "GET", p.ig_id, { fields: "profile_picture_url,biography,website,username", access_token: p.token }).catch(() => ({})) : {}
  ]);
  const cidade = [pag.location?.city, pag.location?.state].filter(Boolean).join(" — ");
  const { preencherMarca } = await import("./marketing.js");
  return preencherMarca(env, orgId, marcaId, {
    segmento: pag.category, cidade, whatsapp: pag.whatsapp_number || pag.phone, site: pag.website || ig.website,
    facebook: pag.link, instagram: ig.username || p.ig_usuario,
    sobre: [ig.biography, pag.about, pag.description].filter(Boolean).join("\n"),
    logos: [ig.profile_picture_url, pag.picture?.data?.is_silhouette ? "" : pag.picture?.data?.url]
  });
}
export async function graph(env, metodo, caminho, params = {}) {
  const url = new URL(`https://graph.facebook.com/${versao(env)}/${caminho.replace(/^\//, "")}`);
  const init = { method: metodo, signal: AbortSignal.timeout(30000) };
  if (metodo === "GET" || metodo === "DELETE") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  else { init.body = new URLSearchParams(params); init.headers = { "content-type": "application/x-www-form-urlencoded" }; }
  const inicio = Date.now(), org = orgDoUso(env);
  let r;
  try { r = await fetch(url.toString(), init); }
  catch (e) { registrarUso(org, "meta", operacaoMeta(metodo, caminho), "", { erro: true, ms: Date.now() - inicio }, recursoDo(env)); throw e; }
  lerLimitesMeta(org, r.headers);
  const d = await r.json().catch(() => ({}));
  registrarUso(org, "meta", operacaoMeta(metodo, caminho), "", { erro: !r.ok || Boolean(d.error), limitada: [4, 17, 32, 613, 80001, 80002].includes(Number(d.error?.code)), ms: Date.now() - inicio }, recursoDo(env));
  if (!r.ok || d.error) {
    const e = new Error(explicarErro(d.error, r.status));
    e.codigo = d.error?.code; e.sub = d.error?.error_subcode;
    throw e;
  }
  return d;
}
function explicarErro(err, status) {
  const c = err?.code, msg = String(err?.message || `HTTP ${status}`);
  if (c === 190) return "O acesso à conta da Meta expirou ou foi removido. Conecte de novo em Contas conectadas.";
  if (c === 10 || c === 200 || c === 3 || (c >= 200 && c < 300)) return "A Meta não deu permissão para esta ação. Conecte a marca de novo (Marcas → Conectar Instagram e Facebook) e aceite todas as permissões pedidas — as novas liberam números, comentários e respostas.";
  if (c === 4 || c === 17 || c === 32 || c === 613) return "Limite de publicações da Meta atingido por agora. A DENIA tenta de novo mais tarde.";
  if (c === 9004 || /image|imagem|media/i.test(msg) && c === 100) return "O Instagram não conseguiu baixar a imagem do post. Gere a arte de novo e tente outra vez.";
  return "A Meta respondeu: " + msg.slice(0, 220);
}

// ----- State assinado (uso único)
async function assinarState(k, dados) {
  const corpo = k.b64url(new TextEncoder().encode(JSON.stringify(dados)));
  return corpo + "." + await k.hmac(await k.segredo(k.env), "meta-state:" + corpo);
}
async function lerState(k, state) {
  const [corpo, sig] = String(state || "").split(".");
  if (!corpo || !sig || sig !== await k.hmac(await k.segredo(k.env), "meta-state:" + corpo)) return null;
  try { return JSON.parse(new TextDecoder().decode(k.deB64url(corpo))); } catch { return null; }
}

// ----- Link público e assinado da imagem (o Instagram busca a arte por um endereço aberto)
export async function urlPublicaMidia(k, base, midiaId) {
  const sig = (await k.hmac(await k.segredo(k.env), "midia-publica:" + midiaId)).slice(0, 32);
  return `${base}/m/${midiaId}-${sig}.jpg`;
}
export async function servirMidiaPublica(env, k, caminho) {
  const m = caminho.match(/^\/m\/(\d{1,12})-([A-Za-z0-9_-]{32})\.jpg$/);
  if (!m) return new Response("Não encontrado.", { status: 404 });
  const certo = (await k.hmac(await k.segredo(env), "midia-publica:" + m[1])).slice(0, 32);
  if (certo !== m[2]) return new Response("Não encontrado.", { status: 404 });
  const r = await env.DB.prepare("SELECT mime, dados FROM plt_mk_midias WHERE id=?").bind(Number(m[1])).first();
  if (!r) return new Response("Não encontrado.", { status: 404 });
  const bin = Uint8Array.from(atob(r.dados), c => c.charCodeAt(0));
  return new Response(bin, { headers: { "content-type": r.mime || "image/jpeg", "cache-control": "public, max-age=86400" } });
}

const baseDe = request => new URL(request.url).origin;
async function guardarBase(env, base) {
  await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES('base_url',?)").bind(base).run();
}
async function baseGuardada(env) {
  return String(env.SITE_URL || (await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='base_url'").first().catch(() => null))?.valor || "").replace(/\/+$/, "");
}

// ----- Rotas da empresa: /api/orgs/:id/mk/meta/...
export async function rotasMeta(request, env, k, orgId, papel, resto) {
  const { json, txt, pode, agora, auditar, sessao } = k;
  if (!resto.startsWith("meta/") && !/^posts\/\d{1,12}\/publicar$/.test(resto)) return null;
  await garantir(env);
  const metodo = request.method;
  const url = new URL(request.url);

  if (resto === "meta/estado" && metodo === "GET") {
    const contas = (await env.DB.prepare("SELECT marca_id, pagina_id, pagina_nome, ig_id, ig_usuario, atualizado_ms FROM plt_mk_contas WHERE org_id=?").bind(orgId).all())?.results || [];
    return json({ configurada: metaConfigurada(env), faltando: ["META_APP_ID", "META_APP_SECRET"].filter(n => !String(env[n] || "").trim()), contas });
  }

  if (resto === "meta/conectar" && metodo === "GET") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores conectam contas." }, 403);
    if (!metaConfigurada(env)) return json({ erro: "A conexão com a Meta ainda não foi configurada: faltam os secrets META_APP_ID e META_APP_SECRET no Worker denia-landing.", codigo: "META_NAO_CONFIGURADA" }, 503);
    const marcaId = Number(url.searchParams.get("marca"));
    const marca = await env.DB.prepare("SELECT id FROM plt_mk_marcas WHERE id=? AND org_id=?").bind(marcaId, orgId).first();
    if (!marca) return json({ erro: "Marca não encontrada." }, 404);
    const base = baseDe(request);
    await guardarBase(env, base);
    const nonce = k.b64url(crypto.getRandomValues(new Uint8Array(18)));
    const state = await assinarState(k, { o: orgId, m: marcaId, u: sessao.usuario.id, n: nonce, e: agora(env) + VALIDADE_STATE_MS });
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("meta_n_" + nonce, await k.cifrar(env, JSON.stringify({ o: orgId, m: marcaId, u: sessao.usuario.id, e: agora(env) + VALIDADE_STATE_MS }))).run();
    const dialogo = new URL(`https://www.facebook.com/${versao(env)}/dialog/oauth`);
    dialogo.searchParams.set("client_id", String(env.META_APP_ID).trim());
    dialogo.searchParams.set("redirect_uri", base + "/api/meta/retorno");
    dialogo.searchParams.set("state", state);
    dialogo.searchParams.set("response_type", "code");
    if (String(env.META_CONFIG_ID || "").trim()) dialogo.searchParams.set("config_id", String(env.META_CONFIG_ID).trim());
    else dialogo.searchParams.set("scope", PERMISSOES.join(","));
    return new Response(null, { status: 302, headers: { location: dialogo.toString() } });
  }

  // Páginas devolvidas pela Meta para a pessoa escolher a da marca.
  if (resto === "meta/paginas" && metodo === "GET") {
    const n = txt(url.searchParams.get("n"), 60);
    const reg = await lerNonce(env, k, n);
    if (!reg || reg.o !== orgId || reg.u !== sessao.usuario.id || !reg.paginas) return json({ erro: "A conexão expirou. Clique em Conectar de novo." }, 410);
    return json({ marca_id: reg.m, paginas: reg.paginas.map(p => ({ id: p.id, nome: p.nome, ig_id: p.ig_id || null, ig_usuario: p.ig_usuario || null })) });
  }
  if (resto === "meta/escolher" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores conectam contas." }, 403);
    const { corpo, erro } = await k.lerCorpo(request, 2000);
    if (erro) return erro;
    const reg = await lerNonce(env, k, txt(corpo.n, 60));
    if (!reg || reg.o !== orgId || reg.u !== sessao.usuario.id || !reg.paginas) return json({ erro: "A conexão expirou. Clique em Conectar de novo." }, 410);
    // Uma ou várias páginas: a primeira vai para o perfil que pediu a conexão; cada outra vira um perfil novo.
    const ids = [...new Set((Array.isArray(corpo.pagina_ids) ? corpo.pagina_ids : [corpo.pagina_id]).map(x => String(x || "")).filter(Boolean))].slice(0, 30);
    const escolhidas = ids.map(id => reg.paginas.find(x => x.id === id)).filter(Boolean);
    if (!escolhidas.length) return json({ erro: "Escolha uma das páginas." }, 400);
    const conectadas = [];
    for (const [n, p] of escolhidas.entries()) {
      let marcaId = reg.m;
      if (n > 0) marcaId = (await env.DB.prepare("INSERT INTO plt_mk_marcas(org_id,nome,ativa,criado_ms) VALUES(?,?,1,?) RETURNING id").bind(orgId, String(p.nome || "Novo perfil").slice(0, 200), agora(env)).first()).id;
      else if (corpo.renomear === true) await env.DB.prepare("UPDATE plt_mk_marcas SET nome=? WHERE id=? AND org_id=?").bind(String(p.nome || "").slice(0, 200) || "Novo perfil", marcaId, orgId).run();
      await env.DB.prepare(`INSERT INTO plt_mk_contas(org_id,marca_id,pagina_id,pagina_nome,ig_id,ig_usuario,token_cifrado,criado_por,criado_ms,atualizado_ms) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(org_id, marca_id) DO UPDATE SET pagina_id=excluded.pagina_id, pagina_nome=excluded.pagina_nome, ig_id=excluded.ig_id, ig_usuario=excluded.ig_usuario, token_cifrado=excluded.token_cifrado, criado_por=excluded.criado_por, atualizado_ms=excluded.atualizado_ms`)
        .bind(orgId, marcaId, p.id, p.nome, p.ig_id || null, p.ig_usuario || null, await k.cifrar(env, p.token), sessao.usuario.email, agora(env), agora(env)).run();
      if (p.ig_usuario) await env.DB.prepare("UPDATE plt_mk_marcas SET instagram=COALESCE(NULLIF(instagram,''),?) WHERE id=? AND org_id=?").bind(p.ig_usuario, marcaId, orgId).run();
      await auditar(env, request, sessao, orgId, "INTEGRACAO", `Meta conectada à marca #${marcaId}: página ${p.nome}${p.ig_usuario ? " · @" + p.ig_usuario : " (sem Instagram profissional ligado)"}`);
      const trabalho = preencherPelaMeta(env, orgId, marcaId, p).catch(e => { console.error("preencher pela Meta", e?.message); return { preenchidos: [] }; });
      if (k.emSegundoPlano) k.emSegundoPlano(() => trabalho);
      const auto = await Promise.race([trabalho, new Promise(r => setTimeout(() => r({ preenchidos: [] }), 6000))]);
      conectadas.push({ marca_id: marcaId, pagina: p.nome, instagram: p.ig_usuario || null, preenchidos: auto.preenchidos });
    }
    await env.DB.prepare("DELETE FROM plt_meta WHERE chave=?").bind("meta_n_" + txt(corpo.n, 60)).run();
    const pri = conectadas[0];
    return json({ ok: true, pagina: pri.pagina, instagram: pri.instagram, preenchidos: pri.preenchidos, conectadas });
  }
  if (resto === "meta/desconectar" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores." }, 403);
    const { corpo, erro } = await k.lerCorpo(request, 1000);
    if (erro) return erro;
    await env.DB.prepare("DELETE FROM plt_mk_contas WHERE org_id=? AND marca_id=?").bind(orgId, Number(corpo.marca_id)).run();
    await auditar(env, request, sessao, orgId, "INTEGRACAO", `Meta desconectada da marca #${Number(corpo.marca_id)}`);
    return json({ ok: true });
  }

  const pub = resto.match(/^posts\/(\d{1,12})\/publicar$/);
  if (pub && metodo === "POST") {
    if (!pode(papel, "AGENTE")) return json({ erro: "Seu perfil não tem permissão para esta ação." }, 403);
    const p = await env.DB.prepare("SELECT * FROM plt_mk_posts WHERE id=? AND org_id=?").bind(Number(pub[1]), orgId).first();
    if (!p) return json({ erro: "Post não encontrado." }, 404);
    if (p.status !== "APROVADO") return json({ erro: "Aprove o post antes de publicar." }, 409);
    await guardarBase(env, baseDe(request));
    const r = await publicarPost(env, k, p, baseDe(request));
    await auditar(env, request, sessao, orgId, "MARKETING", `Post #${p.id}: publicar agora — ${r.resumo}`);
    return json(r, r.ok ? 200 : 502);
  }
  return json({ erro: "Rota não encontrada." }, 404);
}

async function lerNonce(env, k, n) {
  if (!/^[A-Za-z0-9_-]{10,60}$/.test(n)) return null;
  const v = (await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("meta_n_" + n).first())?.valor;
  if (!v) return null;
  try { const d = JSON.parse(await k.decifrar(env, v)); return d.e > k.agora(env) ? d : null; } catch { return null; }
}

// ----- Volta da Meta: /api/meta/retorno?code&state (sem sessão: SameSite=Strict)
export async function retornoMeta(request, env, k) {
  await garantir(env);
  const url = new URL(request.url);
  const st = await lerState(k, url.searchParams.get("state"));
  const esc = t => String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pagina = (titulo, texto, destino) => new Response(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} — DENIA</title><link rel="stylesheet" href="/assets/css/base.css"><script src="/assets/js/i18n.js"></script></head><body class="retorno-meta"><main><h1>${esc(titulo)}</h1><p>${esc(texto)}</p><p><a class="btn btn-primario" id="seguir" href="${esc(destino)}">Continuar</a></p></main><script src="/assets/js/retorno.js" defer></script></body></html>`, { headers: { "content-type": "text/html; charset=UTF-8" } });
  if (!st || !st.n || st.e < k.agora(env)) return pagina("Conexão expirada", "O pedido de conexão expirou. Volte à plataforma e clique em Conectar de novo.", "/app#/marcas");
  const reg = await lerNonce(env, k, st.n);
  if (!reg || reg.paginas || reg.o !== st.o || reg.u !== st.u) return pagina("Conexão expirada", "Este pedido de conexão já foi usado ou expirou. Clique em Conectar de novo.", "/app#/marcas");
  if (url.searchParams.get("error")) return pagina("Conexão cancelada", "A conexão com o Instagram e o Facebook foi cancelada na Meta. Nada foi alterado.", "/app#/marcas");
  const code = String(url.searchParams.get("code") || "");
  if (!code) return pagina("Conexão não concluída", "A Meta não devolveu a autorização. Tente de novo.", "/app#/marcas");
  try {
    const base = baseDe(request);
    const curto = await graph(env, "GET", "oauth/access_token", { client_id: String(env.META_APP_ID).trim(), client_secret: String(env.META_APP_SECRET).trim(), redirect_uri: base + "/api/meta/retorno", code });
    const longo = await graph(env, "GET", "oauth/access_token", { grant_type: "fb_exchange_token", client_id: String(env.META_APP_ID).trim(), client_secret: String(env.META_APP_SECRET).trim(), fb_exchange_token: curto.access_token });
    const contas = await graph(env, "GET", "me/accounts", { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "100", access_token: longo.access_token || curto.access_token });
    const paginas = (contas.data || []).filter(p => p.id && p.access_token).map(p => ({ id: String(p.id), nome: String(p.name || p.id).slice(0, 120), token: p.access_token, ig_id: p.instagram_business_account?.id ? String(p.instagram_business_account.id) : null, ig_usuario: p.instagram_business_account?.username || null }));
    if (!paginas.length) return pagina("Nenhuma página encontrada", "A conta usada não administra nenhuma página do Facebook, ou as páginas não foram liberadas na tela da Meta. Conecte de novo e marque as páginas da marca.", "/app#/marcas");
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("meta_n_" + st.n, await k.cifrar(env, JSON.stringify({ ...reg, paginas, e: k.agora(env) + VALIDADE_STATE_MS }))).run();
    return pagina("Quase pronto", "Contas autorizadas. Agora escolha a página desta marca na plataforma.", `/app#/marcas/meta-${st.n}`);
  } catch (e) {
    console.error("meta retorno", e?.message);
    return pagina("Conexão não concluída", e.message || "Não foi possível falar com a Meta. Tente de novo.", "/app#/marcas");
  }
}

// ----- Publicação
const legendaDe = p => [p.legenda, p.hashtags].map(x => String(x || "").trim()).filter(Boolean).join("\n\n").slice(0, 2200);
const canaisDe = p => { try { const c = JSON.parse(p.canais || "[]"); return Array.isArray(c) ? c : []; } catch { return []; } };

async function publicarInstagram(env, conta, token, p, imagem) {
  if (!conta.ig_id) throw new Error("A página desta marca não tem um Instagram profissional ligado. No Instagram, ligue a conta à página do Facebook e conecte de novo.");
  if (!imagem) throw new Error("O Instagram exige uma imagem. Crie a arte do post antes de publicar.");
  const params = { image_url: imagem, access_token: token };
  if (p.formato === "story") params.media_type = "STORIES"; else params.caption = legendaDe(p);
  const cont = await graph(env, "POST", `${conta.ig_id}/media`, params);
  let pub = null;
  for (let i = 0; i < 5; i++) {
    try { pub = await graph(env, "POST", `${conta.ig_id}/media_publish`, { creation_id: cont.id, access_token: token }); break; }
    catch (e) { if (e.codigo !== 9007 || i === 4) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } // mídia ainda processando
  }
  let link = null;
  try { link = (await graph(env, "GET", pub.id, { fields: "permalink", access_token: token })).permalink || null; } catch { /* sem link */ }
  return { id: pub.id, link };
}
async function publicarFacebook(env, conta, token, p, imagem) {
  const r = imagem
    ? await graph(env, "POST", `${conta.pagina_id}/photos`, { url: imagem, message: legendaDe(p), access_token: token })
    : await graph(env, "POST", `${conta.pagina_id}/feed`, { message: legendaDe(p), access_token: token });
  const id = r.post_id || r.id;
  return { id, link: id ? `https://www.facebook.com/${id}` : null };
}

const NOME_CANAL = { instagram: "Instagram", facebook: "Facebook", google: "Google" };
// Publica um post aprovado em cada canal conectado (Instagram e Facebook pela Meta, Google pelo Perfil da Empresa).
// Canais já publicados não se repetem; canais sem conexão ficam de fora.
export async function publicarPost(env, k, p, base) {
  await garantir(env);
  env = comOrgUso(env, p.org_id); // o consumo da publicação conta para a empresa do post
  const conta = await env.DB.prepare("SELECT * FROM plt_mk_contas WHERE org_id=? AND marca_id=?").bind(p.org_id, p.marca_id).first(); // o token da página não depende dos secrets do app
  const contaG = googleConfigurada(env) ? await contaGoogleDe(env, p.org_id, p.marca_id) : null;
  if (!conta && !contaG) return { ok: false, resumo: "A marca deste post ainda não está conectada (Marcas → Conectar Instagram e Facebook ou Conectar Google)." };
  const token = conta ? await k.decifrar(env, conta.token_cifrado) : null;
  if (conta && !token) return { ok: false, resumo: "O acesso à Meta desta marca não pôde ser lido. Conecte de novo." };
  let feito = {};
  try { feito = JSON.parse(p.publicacao || "{}") || {}; } catch { feito = {}; }
  delete feito.aviso;
  const imagem = p.midia_id && base ? await urlPublicaMidia(k, base, p.midia_id) : null;
  const marcados = canaisDe(p);
  const alvo = marcados.filter(c => ((c === "instagram" || c === "facebook") && conta) || (c === "google" && contaG)).filter(c => !(c === "facebook" && p.formato === "story"));
  if (!alvo.length) {
    const falta = marcados.filter(c => NOME_CANAL[c]).map(c => NOME_CANAL[c]).join(" e ");
    return { ok: false, resumo: falta ? `Este post é para ${falta}, mas esse canal ainda não está conectado nesta marca (Marcas → Conectar).` : "Este post não está marcado para nenhum canal." };
  }
  const erros = [];
  for (const canal of alvo) {
    if (feito[canal]?.id) continue;
    try {
      const r = canal === "instagram" ? await publicarInstagram(env, conta, token, p, imagem)
        : canal === "facebook" ? await publicarFacebook(env, conta, token, p, imagem)
          : await publicarGoogle(env, k, contaG, p, imagem);
      feito[canal] = { id: r.id, link: r.link, em: k.agora(env) };
    } catch (e) {
      feito[canal] = { erro: String(e.message || e).slice(0, 300), em: k.agora(env) };
      erros.push(`${NOME_CANAL[canal]}: ${feito[canal].erro}`);
    }
  }
  const tudo = alvo.every(c => feito[c]?.id);
  await env.DB.prepare("UPDATE plt_mk_posts SET publicacao=?, status=?, tentativas=?, atualizado_ms=? WHERE id=?")
    .bind(JSON.stringify(feito), tudo ? "PUBLICADO" : p.status, tudo ? Number(p.tentativas || 0) : Number(p.tentativas || 0) + 1, k.agora(env), p.id).run();
  const links = alvo.filter(c => feito[c]?.link).map(c => `${NOME_CANAL[c]}: ${feito[c].link}`);
  return { ok: tudo, publicacao: feito, resumo: tudo ? `Publicado. ${links.join(" · ")}`.trim() : erros.join(" | ") };
}

// Logo após aprovar: se o dia e a hora do post já chegaram (ou não há data), publica na hora;
// senão, diz quando vai sair. Sem marca conectada, avisa o que falta.
export async function aoAprovar(request, env, k, p) {
  await garantir(env);
  const conta = await env.DB.prepare("SELECT id FROM plt_mk_contas WHERE org_id=? AND marca_id=?").bind(p.org_id, p.marca_id).first();
  const contaG = googleConfigurada(env) ? await contaGoogleDe(env, p.org_id, p.marca_id) : null;
  if (!conta && !contaG) return { publicado: false, resumo: "Post aprovado. A marca ainda não está conectada ao Instagram/Facebook: vá em Contas conectadas → Conectar para ele sair sozinho." };
  const quando = p.data ? Date.parse(`${p.data}T${p.hora || "00:00"}:00-03:00`) : NaN;
  if (Number.isFinite(quando) && quando > k.agora(env)) {
    const [, mes, dia] = p.data.split("-");
    return { publicado: false, resumo: `Post aprovado. Ele sai sozinho em ${dia}/${mes} às ${p.hora || "00:00"} (horário de Brasília). Para publicar já, abra o post e clique em Publicar agora.` };
  }
  const base = baseDe(request);
  await guardarBase(env, base);
  const r = await publicarPost(env, k, { ...p, status: "APROVADO" }, base).catch(e => ({ ok: false, resumo: e.message }));
  return { publicado: r.ok, resumo: r.ok ? `Post aprovado e ${r.resumo.charAt(0).toLowerCase()}${r.resumo.slice(1)}` : `Post aprovado, mas a publicação falhou: ${r.resumo}` };
}

// Cron (a cada 5 min): publica os posts aprovados cujo dia e hora já chegaram.
export async function publicarPendentes(env, k) {
  await garantir(env);
  const base = await baseGuardada(env);
  if (!base) return { publicados: 0 };
  const agoraMs = k.agora(env);
  const local = new Date(agoraMs - 3 * 3600000).toISOString(); // horário de Brasília (sem horário de verão)
  const hoje = local.slice(0, 10), hora = local.slice(11, 16);
  if (googleConfigurada(env)) await contaGoogleDe(env, 0, 0); // garante a tabela do Google
  const r = await env.DB.prepare(`SELECT p.* FROM plt_mk_posts p
    WHERE (EXISTS (SELECT 1 FROM plt_mk_contas c WHERE c.org_id=p.org_id AND c.marca_id=p.marca_id) ${googleConfigurada(env) ? "OR EXISTS (SELECT 1 FROM plt_mk_google g WHERE g.org_id=p.org_id AND g.marca_id=p.marca_id)" : ""})
    AND p.status='APROVADO' AND p.data IS NOT NULL AND (p.data < ? OR (p.data = ? AND COALESCE(p.hora,'00:00') <= ?)) AND COALESCE(p.tentativas,0) < ? ORDER BY p.data, p.hora LIMIT 10`)
    .bind(hoje, hoje, hora, MAX_TENTATIVAS).all();
  let publicados = 0;
  for (const p of r?.results || []) {
    const quando = Date.parse(`${p.data}T${p.hora || "00:00"}:00-03:00`);
    if (agoraMs - quando > JANELA_ATRASO_MS) {
      await env.DB.prepare("UPDATE plt_mk_posts SET publicacao=?, tentativas=?, atualizado_ms=? WHERE id=?").bind(JSON.stringify({ aviso: "A data do post passou há mais de 48 h. Ajuste a data ou use Publicar agora." }), MAX_TENTATIVAS, agoraMs, p.id).run();
      continue;
    }
    const res = await publicarPost(env, k, p, base).catch(e => ({ ok: false, resumo: e.message }));
    if (res.ok) publicados++;
    try { await env.DB.prepare("INSERT INTO plt_auditoria(org_id,usuario_id,email,acao,detalhe,ip,criado_ms) VALUES(?,?,?,?,?,?,?)").bind(p.org_id, null, "DENIA (publicação automática)", "MARKETING", `Post #${p.id}: ${res.resumo}`.slice(0, 400), null, agoraMs).run(); } catch { /* auditoria opcional */ }
  }
  return { publicados };
}
