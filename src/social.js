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

// ----- "O que funciona" e checagem do perfil: calculados só com os números reais das publicações.
const normal = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const DIAS_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const media = l => l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0;
const mediana = l => { if (!l.length) return 0; const o = [...l].sort((a, b) => a - b), m = Math.floor(o.length / 2); return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2; };
async function emLotes(lista, n, f) { const r = []; for (let i = 0; i < lista.length; i += n) r.push(...await Promise.all(lista.slice(i, i + n).map(f))); return r; }
async function postsComNumeros(env, conta, token, canal) {
  const a = await midias(env, conta, token, canal, null);
  const b = a.proximo ? await midias(env, conta, token, canal, a.proximo).catch(() => ({ itens: [] })) : { itens: [] };
  const itens = [...a.itens, ...b.itens].filter(x => x.tipo !== "STORY").slice(0, 30);
  return emLotes(itens, 5, async x => {
    const m = await insightsDaMidia(env, token, canal, x.id, x.tipo).catch(() => ({}));
    const reacoes = typeof m.post_reactions_by_type_total === "object" ? Object.values(m.post_reactions_by_type_total).reduce((t, v) => t + Number(v || 0), 0) : 0;
    const alcance = canal === "instagram" ? Number(m.reach || 0) : Number(m.post_impressions_unique || 0);
    const interacoes = canal === "instagram" ? Number(m.total_interactions || (Number(x.curtidas || 0) + Number(x.comentarios || 0) + Number(m.shares || 0) + Number(m.saved || 0)))
      : Number(x.curtidas || reacoes || 0) + Number(x.comentarios || 0) + Number(x.compartilhamentos || 0);
    return { ...x, alcance, interacoes, visualizacoes: Number(m.views || m.post_media_view || 0), salvos: Number(m.saved || 0), compartilhados: Number(m.shares || x.compartilhamentos || 0), cliques: Number(m.post_clicks || 0) };
  });
}
function oQueFunciona(posts, agoraMs) {
  const comAlcance = posts.filter(p => p.alcance > 0), medida = comAlcance.length >= Math.max(3, posts.length / 2) ? "alcance" : "interacoes";
  const valor = p => p[medida];
  const geral = media(posts.map(valor));
  const grupo = (chave) => { const g = new Map(); for (const p of posts) { const k = chave(p); if (k == null) continue; if (!g.has(k)) g.set(k, []); g.get(k).push(p); } return [...g.entries()].map(([k, l]) => ({ nome: k, posts: l.length, media: Math.round(media(l.map(valor))), interacoes: Math.round(media(l.map(p => p.interacoes))), taxa: l.some(p => p.alcance) ? Math.round(media(l.filter(p => p.alcance).map(p => p.interacoes / p.alcance)) * 1000) / 10 : null })).sort((a, b) => b.media - a.media); };
  const formatos = grupo(p => p.tipo);
  const hora = p => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }).format(new Date(p.quando)));
  const diaSem = p => DIAS_SEMANA[new Date(Date.parse(p.quando) - 3 * 3600000).getUTCDay()];
  const dias = grupo(diaSem), faixas = grupo(p => { const h = hora(p); return h < 12 ? "manhã (até 12h)" : h < 18 ? "tarde (12h às 18h)" : "noite (depois das 18h)"; });
  const legenda = grupo(p => { const n = String(p.texto || "").length; return n < 125 ? "curta (até 125 letras)" : n < 500 ? "média" : "longa (mais de 500 letras)"; });
  const tags = new Map();
  for (const p of posts) for (const t of new Set((String(p.texto || "").match(/#[\p{L}\p{N}_]+/gu) || []).map(x => x.toLowerCase()))) { if (!tags.has(t)) tags.set(t, []); tags.get(t).push(valor(p)); }
  const hashtags = [...tags.entries()].filter(([, l]) => l.length >= 2).map(([t, l]) => ({ hashtag: t, posts: l.length, media: Math.round(media(l)), vs_geral: geral ? Math.round((media(l) / geral - 1) * 100) : 0 })).sort((a, b) => b.media - a.media).slice(0, 15);
  const ord = [...posts].sort((a, b) => valor(b) - valor(a));
  const resumo = p => ({ id: p.id, texto: String(p.texto || "").slice(0, 140), tipo: p.tipo, quando: p.quando, link: p.link, imagem: p.imagem, alcance: p.alcance, interacoes: p.interacoes });
  const semanas = [0, 1, 2, 3].map(i => posts.filter(p => { const t = Date.parse(p.quando); return t <= agoraMs - i * 7 * DIA_MS && t > agoraMs - (i + 1) * 7 * DIA_MS; }).length);
  const ultimo = posts.length ? Math.floor((agoraMs - Math.max(...posts.map(p => Date.parse(p.quando)))) / DIA_MS) : null;
  // Recomendações tiradas dos números (só quando a diferença é clara e há posts suficientes).
  const dicas = [], nomeF = { REELS: "reels", CARROSSEL: "carrosséis", FOTO: "fotos", "VÍDEO": "vídeos", TEXTO: "posts só de texto" };
  const fs = formatos.filter(f => f.posts >= 2);
  if (fs.length >= 2 && fs[fs.length - 1].media > 0 && fs[0].media / fs[fs.length - 1].media >= 1.3) dicas.push(`${nomeF[fs[0].nome] || fs[0].nome} alcançam ${String(Math.round(fs[0].media / fs[fs.length - 1].media * 10) / 10).replace(".", ",")}x mais que ${nomeF[fs[fs.length - 1].nome] || fs[fs.length - 1].nome}: faça mais ${nomeF[fs[0].nome] || fs[0].nome}.`);
  const ds = dias.filter(d => d.posts >= 2);
  if (ds.length >= 3 && ds[ds.length - 1].media > 0 && ds[0].media / ds[ds.length - 1].media >= 1.3) dicas.push(`Posts de ${ds[0].nome} vão melhor (média ${ds[0].media.toLocaleString("pt-BR")}); ${ds[ds.length - 1].nome} é o dia mais fraco.`);
  const fx = faixas.filter(f => f.posts >= 2);
  if (fx.length >= 2 && fx[fx.length - 1].media > 0 && fx[0].media / fx[fx.length - 1].media >= 1.25) dicas.push(`O melhor horário tem sido de ${fx[0].nome}.`);
  const ls = legenda.filter(l => l.posts >= 2);
  if (ls.length >= 2 && ls[ls.length - 1].media > 0 && ls[0].media / ls[ls.length - 1].media >= 1.3) dicas.push(`Legendas ${ls[0].nome.split(" (")[0]}s rendem mais que as ${ls[ls.length - 1].nome.split(" (")[0]}s.`);
  const ht = hashtags.filter(h => h.vs_geral >= 25);
  if (ht.length) dicas.push(`Hashtags que puxam o alcance para cima: ${ht.slice(0, 4).map(h => h.hashtag).join(", ")}.`);
  const porSemana = media(semanas);
  if (porSemana < 2) dicas.push(`Você postou em média ${String(Math.round(porSemana * 10) / 10).replace(".", ",")} vez(es) por semana nas últimas 4 semanas. O ideal é pelo menos 3: a DENIA monta a semana em Agenda e criação.`);
  if (ultimo != null && ultimo > 7) dicas.push(`O último post foi há ${ultimo} dias: perfis parados perdem alcance.`);
  return { medida, posts_analisados: posts.length, media_geral: Math.round(geral), formatos, dias, faixas, legenda, hashtags, melhores: ord.slice(0, 3).map(resumo), piores: ord.slice(-3).reverse().map(resumo), por_semana: semanas, dias_sem_postar: ultimo, dicas: dicas.map(t => t.charAt(0).toUpperCase() + t.slice(1)) };
}
function checagemSocial(canal, pf, posts, comentariosLista, marca, analise) {
  const itens = [];
  const add = (chave, titulo, max, pontos, detalhe, dica) => itens.push({ chave, titulo, max, pontos: Math.max(0, Math.min(max, Math.round(pontos))), ok: pontos >= max ? "ok" : pontos > 0 ? "parcial" : "falta", detalhe, dica });
  const conferir = (chave, titulo, detalhe, dica) => itens.push({ chave, titulo, max: 0, pontos: 0, ok: "conferir", detalhe, dica });
  const bio = String(pf.bio || "").trim();
  add("foto", "Foto de perfil", 5, pf.foto ? 5 : 0, pf.foto ? "tem foto" : "sem foto", pf.foto ? "" : "Use a logo ou uma foto clara da fachada.");
  add("bio", canal === "instagram" ? "Bio" : "Sobre a página", 10, bio.length >= 40 ? 10 : bio ? 5 : 0, bio ? `${bio.length} letras` : "vazia", bio.length >= 40 ? "" : "Diga em uma frase o que faz, onde e como chamar.");
  const cidade = normal(marca?.cidade || "").split(/[—,-]/)[0].trim();
  if (cidade) add("onde", "Bio diz onde atende", 5, normal(bio).includes(cidade) ? 5 : 0, normal(bio).includes(cidade) ? `cita ${marca.cidade}` : `não cita ${marca.cidade}`, normal(bio).includes(cidade) ? "" : "Coloque a cidade ou os bairros: quem procura perto encontra mais fácil.");
  else conferir("onde", "Bio diz onde atende", "a cidade não está no cadastro do perfil", "Preencha a cidade em Contas conectadas → Editar para a DENIA conferir.");
  add("link", canal === "instagram" ? "Link na bio" : "Site na página", 8, pf.site ? 8 : 0, pf.site || "sem link", pf.site ? "" : "Coloque o link do WhatsApp ou do site.");
  if (canal === "instagram") add("chamada", "Chamada para ação na bio", 5, /whats|agend|chame|cham[ae]|link|or[cç]amento|ligu|pe[cç]a|clique|direct|dm|reserv/i.test(bio) ? 5 : 0, /whats|agend|link|or[cç]amento|direct|dm/i.test(bio) ? "tem" : "não tem", "Termine a bio com o que a pessoa deve fazer: \"Peça seu orçamento pelo WhatsApp 👇\".");
  else add("categoria", "Categoria da página", 5, pf.categoria ? 5 : 0, pf.categoria || "sem categoria", pf.categoria ? "" : "Escolha a categoria certa nas configurações da página.");
  const porSemana = media(analise.por_semana);
  add("frequencia", "Frequência de posts", 15, porSemana >= 3 ? 15 : porSemana >= 2 ? 10 : porSemana >= 1 ? 5 : 0, `${String(Math.round(porSemana * 10) / 10).replace(".", ",")} por semana (últimas 4)`, porSemana >= 3 ? "" : "Poste pelo menos 3 vezes por semana. A DENIA cria e agenda em Agenda e criação.");
  const ult = analise.dias_sem_postar;
  add("recente", "Último post", 8, ult == null ? 0 : ult <= 7 ? 8 : ult <= 14 ? 4 : 0, ult == null ? "nenhum post" : ult === 0 ? "hoje" : `há ${ult} dia(s)`, ult != null && ult <= 7 ? "" : "Perfis parados perdem alcance. Publique esta semana.");
  const recentes = posts.slice(0, 20), videos = recentes.filter(p => ["REELS", "VÍDEO"].includes(p.tipo)).length;
  const pv = recentes.length ? videos / recentes.length : 0;
  add("video", canal === "instagram" ? "Reels" : "Vídeos", 10, pv >= 0.3 ? 10 : pv > 0 ? 5 : 0, `${videos} dos últimos ${recentes.length} posts`, pv >= 0.3 ? "" : `${canal === "instagram" ? "Reels" : "Vídeos"} curtos são o que mais alcança gente nova. Faça pelo menos 1 em cada 3 posts.`);
  const taxas = posts.filter(p => p.alcance > 0).map(p => p.interacoes / p.alcance);
  if (taxas.length >= 3) { const t = mediana(taxas) * 100; add("engajamento", "Engajamento", 12, t >= 5 ? 12 : t >= 2 ? 8 : t >= 1 ? 4 : 0, `${String(Math.round(t * 10) / 10).replace(".", ",")}% de quem vê interage`, t >= 5 ? "" : "Faça perguntas na legenda, mostre antes e depois e responda todo comentário."); }
  else conferir("engajamento", "Engajamento", "a Meta não liberou o alcance dos posts", "Reconecte o Instagram/Facebook aceitando as permissões de números (insights).");
  const doCliente = comentariosLista.filter(c => !c.oculto);
  if (doCliente.length) { const r = doCliente.filter(c => c.respondido).length / doCliente.length; add("respostas", "Comentários respondidos", 10, r * 10, `${doCliente.filter(c => c.respondido).length} de ${doCliente.length}`, r >= 1 ? "" : "Responda todos os comentários: a DENIA sugere a resposta em Comentários."); }
  else add("respostas", "Comentários respondidos", 10, 10, "nenhum comentário esperando", "");
  if (canal === "facebook" && pf.nota != null) add("nota", "Nota das recomendações", 9, pf.nota >= 4.5 ? 9 : pf.nota >= 4 ? 5 : 0, String(pf.nota).replace(".", ",") + " ★", pf.nota >= 4.5 ? "" : "Peça recomendação aos clientes satisfeitos.");
  const max = itens.reduce((t, x) => t + x.max, 0), pts = itens.reduce((t, x) => t + x.pontos, 0);
  return { nota: max ? Math.round(pts / max * 100) : 0, itens, faltam: itens.filter(x => x.ok === "parcial" || x.ok === "falta").length };
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
    if (resto === "social/analise") return responder(async () => {
      const { conta, token } = await contaDa(env, k, orgId, marcaId);
      if (canal === "instagram" && !conta.ig_id) throw new Error("A página desta marca não tem um Instagram profissional ligado.");
      const chaveCache = `analise_${orgId}_${Number(marcaId)}_${canal}`;
      if (url.searchParams.get("atualizar") !== "1") {
        const c = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind(chaveCache).first().catch(() => null);
        try { const v = c?.valor ? JSON.parse(c.valor) : null; if (v && k.agora(env) - v.em < 6 * 3600000) return { ...v, do_cache: true }; } catch { /* refaz */ }
      }
      const [pf, posts, cs, marca] = await Promise.all([perfil(env, conta, token, canal), postsComNumeros(env, conta, token, canal), comentarios(env, conta, token, canal, conta.ig_usuario).catch(() => []),
        env.DB.prepare("SELECT * FROM plt_mk_marcas WHERE id=? AND org_id=?").bind(Number(marcaId), orgId).first().catch(() => null)]);
      const analise = oQueFunciona(posts, k.agora(env));
      const r = { em: k.agora(env), perfil: pf, analise, checagem: checagemSocial(canal, pf, posts, cs, marca, analise) };
      await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind(chaveCache, JSON.stringify(r)).run().catch(() => {});
      return r;
    });
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
