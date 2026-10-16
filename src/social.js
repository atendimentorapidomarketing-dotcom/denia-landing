// DENIA Platform — Instagram e Facebook por dentro: perfil, números (insights), publicações com
// métricas, comentários (responder, ocultar, apagar, sugestão da IA) e comparação com concorrentes.
// Usa o token da página guardado na conexão da marca (plt_mk_contas) e a API oficial da Meta.

import { graph, garantir } from "./meta.js";

const DIA_MS = 86400000;
const ID_OK = /^[\w.-]{1,90}$/;
const CANAIS = ["instagram", "facebook"];

// Números do Instagram (API v22+: "views" substituiu "impressions").
const IG_TOTAIS = ["reach", "views", "accounts_engaged", "total_interactions", "likes", "comments", "shares", "saves", "replies", "profile_links_taps"];
// Números da página do Facebook: cada um é pedido sozinho, porque a Meta aposenta métricas com o tempo.
const FB_METRICAS = ["page_media_view", "page_impressions_unique", "page_post_engagements", "page_total_actions", "page_views_total", "page_daily_follows_unique", "page_daily_unfollows_unique", "page_follows"];

async function contaDa(env, k, orgId, marcaId) {
  const conta = await env.DB.prepare("SELECT * FROM plt_mk_contas WHERE org_id=? AND marca_id=?").bind(orgId, Number(marcaId)).first();
  if (!conta) { const e = new Error("Esta marca ainda não está conectada à Meta (Marcas → Conectar Instagram e Facebook)."); e.status = 409; throw e; }
  const token = await k.decifrar(env, conta.token_cifrado);
  if (!token) { const e = new Error("O acesso à Meta desta marca não pôde ser lido. Conecte de novo."); e.status = 409; throw e; }
  return { conta, token };
}
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const seg = ms => Math.floor(ms / 1000);

// Período pedido: "dias" (1–730) terminando ontem, ou "de"/"ate".
function periodo(url, agoraMs) {
  const valida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  let de = url.searchParams.get("de"), ate = url.searchParams.get("ate");
  const ontem = iso(agoraMs - DIA_MS);
  if (!valida(de) || !valida(ate)) { const n = Math.min(730, Math.max(1, Number(url.searchParams.get("dias")) || 30)); ate = ontem; de = iso(Date.parse(ontem) - (n - 1) * DIA_MS); }
  if (de > ate) [de, ate] = [ate, de];
  if (ate > ontem) ate = ontem;
  return { de, ate, ini: Date.parse(de + "T00:00:00Z"), fim: Date.parse(ate + "T00:00:00Z") + DIA_MS, dias: Math.round((Date.parse(ate) - Date.parse(de)) / DIA_MS) + 1 };
}
// A Meta aceita no máximo 30 dias por pedido de insights.
function janelas(ini, fim) {
  const r = [];
  for (let a = ini; a < fim; a += 30 * DIA_MS) r.push([a, Math.min(fim, a + 30 * DIA_MS)]);
  return r;
}

async function perfil(env, conta, token, canal) {
  if (canal === "instagram") {
    if (!conta.ig_id) throw new Error("A página desta marca não tem um Instagram profissional ligado.");
    const d = await graph(env, "GET", conta.ig_id, { fields: "id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url", access_token: token });
    return { id: d.id, usuario: d.username, nome: d.name, bio: d.biography || "", site: d.website || "", seguidores: d.followers_count ?? null, seguindo: d.follows_count ?? null, publicacoes: d.media_count ?? null, foto: d.profile_picture_url || null, link: d.username ? `https://www.instagram.com/${d.username}/` : null };
  }
  const d = await graph(env, "GET", conta.pagina_id, { fields: "id,name,about,category,link,fan_count,followers_count,picture{url},website,rating_count,overall_star_rating", access_token: token });
  return { id: d.id, usuario: null, nome: d.name, bio: d.about || "", categoria: d.category || "", site: d.website || "", seguidores: d.followers_count ?? null, curtidas: d.fan_count ?? null, foto: d.picture?.data?.url || null, link: d.link || `https://www.facebook.com/${d.id}`, nota: d.overall_star_rating ?? null, avaliacoes: d.rating_count ?? null };
}

async function insightsInstagram(env, conta, token, p) {
  const totais = Object.fromEntries(IG_TOTAIS.map(m => [m, 0]));
  const indisponiveis = new Set();
  for (const [a, b] of janelas(p.ini, p.fim)) {
    try {
      const d = await graph(env, "GET", `${conta.ig_id}/insights`, { metric: IG_TOTAIS.join(","), period: "day", metric_type: "total_value", since: String(seg(a)), until: String(seg(b)), access_token: token });
      for (const m of d.data || []) {
        totais[m.name] = (totais[m.name] || 0) + Number(m.total_value?.value || 0);
      }
    } catch (e) { if (/permiss/i.test(e.message)) throw e; IG_TOTAIS.forEach(x => indisponiveis.add(x)); }
  }
  // Alcance e seguidores dia a dia (a Meta só dá seguidores por dia dos últimos 30 dias).
  const diario = new Map();
  for (const [a, b] of janelas(p.ini, p.fim)) {
    try {
      const d = await graph(env, "GET", `${conta.ig_id}/insights`, { metric: "reach", period: "day", since: String(seg(a)), until: String(seg(b)), access_token: token });
      for (const m of d.data || []) for (const v of m.values || []) { const dia = String(v.end_time || "").slice(0, 10); if (dia) diario.set(dia, { ...(diario.get(dia) || {}), alcance: Number(v.value || 0) }); }
    } catch { /* série opcional */ }
  }
  try {
    const a = Math.max(p.ini, p.fim - 30 * DIA_MS);
    const d = await graph(env, "GET", `${conta.ig_id}/insights`, { metric: "follower_count", period: "day", since: String(seg(a)), until: String(seg(p.fim)), access_token: token });
    for (const m of d.data || []) for (const v of m.values || []) { const dia = String(v.end_time || "").slice(0, 10); if (dia) diario.set(dia, { ...(diario.get(dia) || {}), novos_seguidores: Number(v.value || 0) }); }
  } catch { /* série opcional */ }
  // Visitas ao perfil e quem começou/deixou de seguir (só as quantidades: a Meta não diz quem).
  let visitasPerfil = null, comecaram = null, deixaram = null;
  for (const [a, b] of janelas(p.ini, p.fim)) {
    try {
      const d = await graph(env, "GET", `${conta.ig_id}/insights`, { metric: "profile_views", period: "day", metric_type: "total_value", since: String(seg(a)), until: String(seg(b)), access_token: token });
      visitasPerfil = (visitasPerfil || 0) + Number(d.data?.[0]?.total_value?.value || 0);
    } catch { /* métrica indisponível para esta conta */ }
    try {
      const d = await graph(env, "GET", `${conta.ig_id}/insights`, { metric: "follows_and_unfollows", period: "day", metric_type: "total_value", breakdown: "follow_type", since: String(seg(a)), until: String(seg(b)), access_token: token });
      for (const r of d.data?.[0]?.total_value?.breakdowns?.[0]?.results || []) {
        const tipo = String(r.dimension_values?.[0] || "").toUpperCase();
        if (tipo === "FOLLOWER") comecaram = (comecaram || 0) + Number(r.value || 0);
        if (tipo === "NON_FOLLOWER") deixaram = (deixaram || 0) + Number(r.value || 0);
      }
    } catch { /* métrica indisponível */ }
  }
  // Público: cidades, países, idade e gênero de quem segue (mínimo de 100 seguidores).
  const publico = {};
  for (const quebra of ["city", "country", "age", "gender"]) {
    try {
      const d = await graph(env, "GET", `${conta.ig_id}/insights`, { metric: "follower_demographics", period: "lifetime", metric_type: "total_value", breakdown: quebra, timeframe: "this_month", access_token: token });
      publico[quebra] = (d.data?.[0]?.total_value?.breakdowns?.[0]?.results || []).map(x => ({ nome: String(x.dimension_values?.[0] || ""), valor: Number(x.value || 0) })).sort((a, b) => b.valor - a.valor).slice(0, 10);
    } catch { publico[quebra] = []; }
  }
  return {
    totais: { alcance: totais.reach, visualizacoes: totais.views, contas_engajadas: totais.accounts_engaged, interacoes: totais.total_interactions, curtidas: totais.likes, comentarios: totais.comments, compartilhamentos: totais.shares, salvamentos: totais.saves, respostas_stories: totais.replies, cliques_link: totais.profile_links_taps, novos_seguidores: [...diario.values()].reduce((t, v) => t + (v.novos_seguidores || 0), 0), visitas_perfil: visitasPerfil, comecaram_a_seguir: comecaram, deixaram_de_seguir: deixaram },
    diario: [...diario.entries()].sort().map(([data, v]) => ({ data, alcance: v.alcance || 0, novos_seguidores: v.novos_seguidores || 0 })),
    publico, indisponiveis: [...indisponiveis], seguidores_ultimos_30_dias: true
  };
}

async function insightsFacebook(env, conta, token, p) {
  const totais = {}, diario = new Map(), indisponiveis = [];
  const NOME = { page_media_view: "visualizacoes", page_impressions_unique: "alcance", page_post_engagements: "interacoes", page_total_actions: "acoes_na_pagina", page_views_total: "visitas_pagina", page_daily_follows_unique: "novos_seguidores", page_daily_unfollows_unique: "deixaram_de_seguir", page_follows: "seguidores" };
  for (const m of FB_METRICAS) {
    let ok = false;
    for (const [a, b] of janelas(p.ini, p.fim)) {
      try {
        const d = await graph(env, "GET", `${conta.pagina_id}/insights`, { metric: m, period: "day", since: String(seg(a)), until: String(seg(b)), access_token: token });
        ok = true;
        for (const serie of d.data || []) for (const v of serie.values || []) {
          const dia = String(v.end_time || "").slice(0, 10), n = typeof v.value === "number" ? v.value : Number(v.value || 0) || 0;
          if (m === "page_follows") totais[NOME[m]] = n; // é o total acumulado: vale o último
          else totais[NOME[m]] = (totais[NOME[m]] || 0) + n;
          if (dia && ["page_impressions_unique", "page_media_view", "page_daily_follows_unique"].includes(m)) diario.set(dia, { ...(diario.get(dia) || {}), [NOME[m]]: n });
        }
      } catch (e) { if (/permiss/i.test(e.message) && m === FB_METRICAS[0]) throw e; break; }
    }
    if (!ok) indisponiveis.push(m);
  }
  return { totais, diario: [...diario.entries()].sort().map(([data, v]) => ({ data, alcance: v.alcance || 0, visualizacoes: v.visualizacoes || 0, novos_seguidores: v.novos_seguidores || 0 })), publico: {}, indisponiveis };
}

async function midias(env, conta, token, canal, depois) {
  if (canal === "instagram") {
    const d = await graph(env, "GET", `${conta.ig_id}/media`, { fields: "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count", limit: "24", ...(depois ? { after: depois } : {}), access_token: token });
    return { itens: (d.data || []).map(m => ({ id: m.id, texto: m.caption || "", tipo: m.media_product_type === "REELS" ? "REELS" : m.media_product_type === "STORY" ? "STORY" : m.media_type === "CAROUSEL_ALBUM" ? "CARROSSEL" : m.media_type === "VIDEO" ? "VÍDEO" : "FOTO", imagem: m.thumbnail_url || (m.media_type !== "VIDEO" ? m.media_url : null) || null, link: m.permalink, quando: m.timestamp, curtidas: m.like_count ?? null, comentarios: m.comments_count ?? null })), proximo: d.paging?.cursors?.after && d.paging?.next ? d.paging.cursors.after : null };
  }
  const d = await graph(env, "GET", `${conta.pagina_id}/published_posts`, { fields: "id,message,created_time,permalink_url,full_picture,status_type,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)", limit: "24", ...(depois ? { after: depois } : {}), access_token: token });
  return { itens: (d.data || []).map(m => ({ id: m.id, texto: m.message || "", tipo: /video/i.test(m.status_type || "") ? "VÍDEO" : m.full_picture ? "FOTO" : "TEXTO", imagem: m.full_picture || null, link: m.permalink_url, quando: m.created_time, curtidas: m.reactions?.summary?.total_count ?? null, comentarios: m.comments?.summary?.total_count ?? null, compartilhamentos: m.shares?.count ?? 0 })), proximo: d.paging?.cursors?.after && d.paging?.next ? d.paging.cursors.after : null };
}

async function insightsDaMidia(env, token, canal, id, tipo) {
  if (canal === "instagram") {
    const lista = tipo === "REELS" ? ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time"]
      : tipo === "STORY" ? ["reach", "views", "replies", "shares", "total_interactions", "navigation"] : ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions", "profile_visits", "follows"];
    const r = {};
    try { const d = await graph(env, "GET", `${id}/insights`, { metric: lista.join(","), access_token: token }); for (const m of d.data || []) r[m.name] = Number(m.values?.[0]?.value ?? m.total_value?.value ?? 0); }
    catch { for (const m of lista) { try { const d = await graph(env, "GET", `${id}/insights`, { metric: m, access_token: token }); r[m] = Number(d.data?.[0]?.values?.[0]?.value ?? 0); } catch { /* métrica não existe para este tipo */ } } }
    return r;
  }
  const r = {};
  for (const m of ["post_impressions_unique", "post_media_view", "post_clicks", "post_reactions_by_type_total"]) {
    try { const d = await graph(env, "GET", `${id}/insights`, { metric: m, access_token: token }); const v = d.data?.[0]?.values?.[0]?.value; r[m] = typeof v === "object" && v ? v : Number(v || 0); } catch { /* métrica aposentada */ }
  }
  return r;
}

// Comentários das últimas publicações, com quem respondeu e se a marca já respondeu.
async function comentarios(env, conta, token, canal, perfilProprio) {
  const lista = [];
  if (canal === "instagram") {
    const d = await graph(env, "GET", `${conta.ig_id}/media`, { fields: "id,caption,permalink,timestamp,media_url,thumbnail_url,comments_count,comments.limit(30){id,text,username,timestamp,like_count,hidden,replies.limit(10){id,text,username,timestamp}}", limit: "15", access_token: token });
    for (const m of d.data || []) for (const c of m.comments?.data || []) {
      const respostas = (c.replies?.data || []).map(r => ({ id: r.id, texto: r.text, autor: r.username, quando: r.timestamp, da_marca: r.username === perfilProprio }));
      if (c.username === perfilProprio) continue;
      lista.push({ id: c.id, texto: c.text || "", autor: c.username || "", quando: c.timestamp, curtidas: c.like_count || 0, oculto: Boolean(c.hidden), respostas, respondido: respostas.some(r => r.da_marca), post: { id: m.id, texto: String(m.caption || "").slice(0, 300), link: m.permalink, imagem: m.thumbnail_url || m.media_url || null } });
    }
  } else {
    const d = await graph(env, "GET", `${conta.pagina_id}/published_posts`, { fields: "id,message,permalink_url,full_picture,created_time,comments.limit(30).filter(toplevel).order(reverse_chronological){id,message,from,created_time,like_count,is_hidden,comments.limit(10){id,message,from,created_time}}", limit: "15", access_token: token });
    for (const m of d.data || []) for (const c of m.comments?.data || []) {
      if (c.from?.id === conta.pagina_id) continue;
      const respostas = (c.comments?.data || []).map(r => ({ id: r.id, texto: r.message, autor: r.from?.name || "", quando: r.created_time, da_marca: r.from?.id === conta.pagina_id }));
      lista.push({ id: c.id, texto: c.message || "", autor: c.from?.name || "Pessoa no Facebook", quando: c.created_time, curtidas: c.like_count || 0, oculto: Boolean(c.is_hidden), respostas, respondido: respostas.some(r => r.da_marca), post: { id: m.id, texto: String(m.message || "").slice(0, 300), link: m.permalink_url, imagem: m.full_picture || null } });
    }
  }
  return lista.sort((a, b) => String(b.quando).localeCompare(String(a.quando)));
}

export async function rotasSocial(request, env, k, orgId, papel, resto, ajuda = {}) {
  if (!resto.startsWith("social/")) return null;
  await garantir(env);
  const { json, pode, lerCorpo, auditar, sessao } = k;
  const url = new URL(request.url), metodo = request.method;
  const canal = url.searchParams.get("canal");
  const responder = async fn => { try { return json(await fn()); } catch (e) { return json({ erro: e.message }, e.status || 502); } };

  if (metodo === "GET") {
    if (!CANAIS.includes(canal)) return json({ erro: "Canal inválido." }, 400);
    const marcaId = url.searchParams.get("marca");
    if (resto === "social/perfil") return responder(async () => { const { conta, token } = await contaDa(env, k, orgId, marcaId); return { perfil: await perfil(env, conta, token, canal) }; });
    if (resto === "social/insights") return responder(async () => {
      const { conta, token } = await contaDa(env, k, orgId, marcaId);
      const p = periodo(url, k.agora(env));
      if (canal === "instagram" && !conta.ig_id) throw new Error("A página desta marca não tem um Instagram profissional ligado.");
      const atual = canal === "instagram" ? await insightsInstagram(env, conta, token, p) : await insightsFacebook(env, conta, token, p);
      // Período anterior do mesmo tamanho, só os totais, para comparar.
      let anterior = null;
      if (url.searchParams.get("comparar") !== "nada") {
        const pa = { ini: p.ini - p.dias * DIA_MS, fim: p.ini, dias: p.dias };
        try { anterior = { de: iso(pa.ini), ate: iso(pa.fim - DIA_MS), totais: (canal === "instagram" ? await insightsInstagram(env, conta, token, pa) : await insightsFacebook(env, conta, token, pa)).totais }; } catch { anterior = null; }
      }
      return { de: p.de, ate: p.ate, dias: p.dias, ...atual, anterior };
    });
    if (resto === "social/midias") return responder(async () => { const { conta, token } = await contaDa(env, k, orgId, marcaId); return await midias(env, conta, token, canal, ID_OK.test(url.searchParams.get("depois") || "") ? url.searchParams.get("depois") : null); });
    const m = resto.match(/^social\/midias\/([\w.-]{1,90})$/);
    if (m) return responder(async () => { const { token } = await contaDa(env, k, orgId, marcaId); return { id: m[1], metricas: await insightsDaMidia(env, token, canal, m[1], String(url.searchParams.get("tipo") || "")) }; });
    if (resto === "social/comentarios") return responder(async () => {
      const { conta, token } = await contaDa(env, k, orgId, marcaId);
      if (canal === "instagram" && !conta.ig_id) throw new Error("A página desta marca não tem um Instagram profissional ligado.");
      const lista = await comentarios(env, conta, token, canal, conta.ig_usuario);
      return { comentarios: lista, sem_resposta: lista.filter(c => !c.respondido && !c.oculto).length };
    });
    if (resto === "social/concorrente") return responder(async () => {
      if (canal !== "instagram") throw new Error("A comparação com concorrentes é do Instagram.");
      const usuario = String(url.searchParams.get("usuario") || "").replace(/^@/, "").trim();
      if (!/^[A-Za-z0-9._]{1,30}$/.test(usuario)) throw new Error("Digite o @ do Instagram do concorrente.");
      const { conta, token } = await contaDa(env, k, orgId, marcaId);
      const d = await graph(env, "GET", conta.ig_id, { fields: `business_discovery.username(${usuario}){username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,media.limit(12){id,caption,media_type,media_product_type,like_count,comments_count,permalink,timestamp}}`, access_token: token });
      const b = d.business_discovery || {};
      const posts = (b.media?.data || []).map(x => ({ texto: String(x.caption || "").slice(0, 200), tipo: x.media_product_type === "REELS" ? "REELS" : x.media_type, curtidas: x.like_count ?? 0, comentarios: x.comments_count ?? 0, link: x.permalink, quando: x.timestamp }));
      const media = posts.length ? posts.reduce((s, x) => s + x.curtidas + x.comentarios, 0) / posts.length : 0;
      return { usuario: b.username, nome: b.name, bio: b.biography || "", site: b.website || "", seguidores: b.followers_count ?? null, publicacoes: b.media_count ?? null, foto: b.profile_picture_url || null, posts, engajamento_medio: Math.round(media), taxa_engajamento: b.followers_count ? Math.round((media / b.followers_count) * 10000) / 100 : null };
    });
    // Melhores horários: engajamento médio das últimas 100 publicações por dia da semana e hora (fuso de Brasília).
    if (resto === "social/horarios") return responder(async () => {
      const { conta, token } = await contaDa(env, k, orgId, marcaId);
      const itens = [];
      let depois = null;
      for (let i = 0; i < 4 && itens.length < 100; i++) { const r = await midias(env, conta, token, canal, depois); itens.push(...r.itens); depois = r.proximo; if (!depois) break; }
      const soma = Array.from({ length: 7 }, () => Array(24).fill(0)), qtd = Array.from({ length: 7 }, () => Array(24).fill(0));
      const porTipo = {};
      for (const x of itens) {
        if (!x.quando) continue;
        const t = new Date(Date.parse(x.quando) - 3 * 3600000), d = t.getUTCDay(), hr = t.getUTCHours();
        const eng = Number(x.curtidas || 0) + Number(x.comentarios || 0) * 2 + Number(x.compartilhamentos || 0) * 3;
        soma[d][hr] += eng; qtd[d][hr]++;
        const pt = porTipo[x.tipo] || (porTipo[x.tipo] = { tipo: x.tipo, posts: 0, engajamento: 0 }); pt.posts++; pt.engajamento += eng;
      }
      const media = soma.map((l, d) => l.map((v, hr) => (qtd[d][hr] ? Math.round(v / qtd[d][hr]) : 0)));
      const melhores = [];
      media.forEach((l, d) => l.forEach((v, hr) => { if (qtd[d][hr]) melhores.push({ dia: d, hora: hr, media: v, posts: qtd[d][hr] }); }));
      melhores.sort((a, b) => b.media - a.media);
      return { analisadas: itens.length, mapa: media, melhores: melhores.slice(0, 8), por_tipo: Object.values(porTipo).map(x => ({ ...x, media: Math.round(x.engajamento / x.posts) })).sort((a, b) => b.media - a.media) };
    });
    // Stories no ar agora (a Meta só entrega os das últimas 24 h) com alcance, respostas e saídas.
    if (resto === "social/stories") return responder(async () => {
      if (canal !== "instagram") throw new Error("Stories são do Instagram.");
      const { conta, token } = await contaDa(env, k, orgId, marcaId);
      const d = await graph(env, "GET", `${conta.ig_id}/stories`, { fields: "id,media_type,media_url,thumbnail_url,permalink,timestamp", access_token: token });
      const lista = [];
      for (const st of (d.data || []).slice(0, 25)) lista.push({ id: st.id, tipo: st.media_type, imagem: st.thumbnail_url || st.media_url || null, link: st.permalink, quando: st.timestamp, metricas: await insightsDaMidia(env, token, "instagram", st.id, "STORY").catch(() => ({})) });
      return { stories: lista };
    });
    // Publicações de outras pessoas que marcaram o perfil (só as públicas; a Meta não mostra as privadas).
    if (resto === "social/marcacoes") return responder(async () => {
      if (canal !== "instagram") throw new Error("Marcações são do Instagram.");
      const { conta, token } = await contaDa(env, k, orgId, marcaId);
      const d = await graph(env, "GET", `${conta.ig_id}/tags`, { fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,username,like_count,comments_count", limit: "50", access_token: token });
      return { marcacoes: (d.data || []).map(m => ({ id: m.id, autor: m.username || "", texto: String(m.caption || "").slice(0, 400), imagem: m.thumbnail_url || m.media_url || null, link: m.permalink, quando: m.timestamp, curtidas: m.like_count ?? 0, comentarios: m.comments_count ?? 0 })) };
    });
    // Recomendações (avaliações) da página do Facebook.
    if (resto === "social/avaliacoes") return responder(async () => {
      if (canal !== "facebook") throw new Error("Recomendações são da página do Facebook.");
      const { conta, token } = await contaDa(env, k, orgId, marcaId);
      const [pag, d] = await Promise.all([
        graph(env, "GET", conta.pagina_id, { fields: "overall_star_rating,rating_count", access_token: token }).catch(() => ({})),
        graph(env, "GET", `${conta.pagina_id}/ratings`, { fields: "created_time,recommendation_type,review_text,rating,reviewer{name},open_graph_story{id}", limit: "100", access_token: token })
      ]);
      const lista = (d.data || []).map(x => ({ quando: x.created_time, recomenda: x.recommendation_type === "positive" ? true : x.recommendation_type === "negative" ? false : null, nota: x.rating ?? null, texto: x.review_text || "", autor: x.reviewer?.name || "Pessoa no Facebook", historia: x.open_graph_story?.id || null }));
      return { nota: pag.overall_star_rating ?? null, total: pag.rating_count ?? lista.length, positivas: lista.filter(x => x.recomenda === true).length, negativas: lista.filter(x => x.recomenda === false).length, avaliacoes: lista };
    });
    return null;
  }

  // Ações nos comentários.
  const acao = resto.match(/^social\/comentarios\/([\w.-]{1,90})\/(responder|ocultar|apagar|sugerir)$/);
  if (acao && metodo === "POST") {
    if (!pode(papel, "AGENTE")) return json({ erro: "Seu perfil não tem permissão para esta ação." }, 403);
    const { corpo, erro } = await lerCorpo(request, 6000);
    if (erro) return erro;
    if (!CANAIS.includes(corpo.canal)) return json({ erro: "Canal inválido." }, 400);
    const [, id, tipo] = acao;
    return responder(async () => {
      const { conta, token } = await contaDa(env, k, orgId, corpo.marca_id);
      if (tipo === "sugerir") {
        if (!ajuda.sugerir) throw new Error("A IA não está disponível agora.");
        return await ajuda.sugerir(Number(corpo.marca_id), corpo.canal, { comentario: String(corpo.comentario || "").slice(0, 1500), autor: String(corpo.autor || "").slice(0, 80), post: String(corpo.post || "").slice(0, 800) });
      }
      if (tipo === "responder") {
        const texto = String(corpo.texto || "").trim().slice(0, 2000);
        if (!texto) throw new Error("Escreva a resposta.");
        const d = corpo.canal === "instagram" ? await graph(env, "POST", `${id}/replies`, { message: texto, access_token: token }) : await graph(env, "POST", `${id}/comments`, { message: texto, access_token: token });
        await auditar(env, request, sessao, orgId, "SOCIAL", `Resposta publicada no ${corpo.canal === "instagram" ? "Instagram" : "Facebook"} (comentário ${id})`);
        return { ok: true, id: d.id || null };
      }
      if (tipo === "ocultar") {
        const ocultar = corpo.ocultar !== false;
        if (corpo.canal === "instagram") await graph(env, "POST", id, { hide: String(ocultar), access_token: token });
        else await graph(env, "POST", id, { is_hidden: String(ocultar), access_token: token });
        await auditar(env, request, sessao, orgId, "SOCIAL", `Comentário ${ocultar ? "ocultado" : "mostrado de novo"} (${id})`);
        return { ok: true, oculto: ocultar };
      }
      await graph(env, "DELETE", id, { access_token: token });
      await auditar(env, request, sessao, orgId, "SOCIAL", `Comentário apagado (${id}) por ${conta.pagina_nome || "marca"}`);
      return { ok: true };
    });
  }
  return null;
}
