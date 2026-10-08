// ============================================================================
// DENIA Platform — Estúdio de Marketing e Assistente DENIA (texto e voz)
// ============================================================================
//
// Marcas (uma empresa pode cuidar de várias marcas), calendário semanal de posts,
// criação com IA (textos e imagens), aprovação humana ou automática, Google Meu
// Negócio (avaliações, palavras-chave, desempenho) e o assistente DENIA.
//
// Usa o secret OPENAI_API_KEY do Worker da plataforma. Sem ele, tudo funciona,
// menos as funções de IA (que explicam o que falta).
// ============================================================================

const MODELO_TEXTO = "gpt-5.6-luna";
const STATUS_POST = ["RASCUNHO", "AGUARDANDO", "APROVADO", "PUBLICADO", "REJEITADO"];
const CANAIS = ["instagram", "facebook", "google"];
const FORMATOS = ["post", "carrossel", "story", "reels", "google"];

const DDL = [
  `CREATE TABLE IF NOT EXISTS plt_mk_marcas (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, nome TEXT NOT NULL, segmento TEXT, cidade TEXT, instagram TEXT, facebook TEXT, google TEXT, site TEXT, whatsapp TEXT, tom TEXT, publico TEXT, cores TEXT, diferenciais TEXT, ativa INTEGER NOT NULL DEFAULT 1, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS plt_mk_marcas_org ON plt_mk_marcas(org_id)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_config (org_id INTEGER PRIMARY KEY, modo TEXT NOT NULL DEFAULT 'HUMANO', posts_semana INTEGER NOT NULL DEFAULT 3, nota_minima INTEGER NOT NULL DEFAULT 8, atualizado_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, canais TEXT NOT NULL DEFAULT '["instagram"]', formato TEXT NOT NULL DEFAULT 'post', data TEXT, hora TEXT, titulo TEXT, legenda TEXT, hashtags TEXT, chamada TEXT, ideia_imagem TEXT, midia_id INTEGER, status TEXT NOT NULL DEFAULT 'RASCUNHO', revisao TEXT, comentario TEXT, criado_por TEXT, aprovado_por TEXT, criado_ms INTEGER NOT NULL, atualizado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS plt_mk_posts_org ON plt_mk_posts(org_id, data)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_midias (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, mime TEXT NOT NULL, dados TEXT NOT NULL, prompt TEXT, criado_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_avaliacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, autor TEXT, nota INTEGER, texto TEXT, data TEXT, resposta_sugerida TEXT, resposta TEXT, status TEXT NOT NULL DEFAULT 'PENDENTE', criado_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_palavras (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, palavra TEXT NOT NULL, cidade TEXT, criado_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plt_mk_posicoes (palavra_id INTEGER NOT NULL, semana TEXT NOT NULL, posicao INTEGER, criado_ms INTEGER NOT NULL, PRIMARY KEY (palavra_id, semana))`,
  `CREATE TABLE IF NOT EXISTS plt_mk_metricas (org_id INTEGER NOT NULL, marca_id INTEGER NOT NULL, semana TEXT NOT NULL, dados TEXT NOT NULL, criado_ms INTEGER NOT NULL, PRIMARY KEY (org_id, marca_id, semana))`
];
const prontos = new WeakSet();
async function garantir(env) {
  if (prontos.has(env.DB)) return;
  await env.DB.batch(DDL.map(s => env.DB.prepare(s)));
  prontos.add(env.DB);
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

function chave(env) { return String(env.OPENAI_API_KEY || "").trim(); }
function semChave() {
  return { status: 503, corpo: { erro: "A inteligência do Estúdio ainda não foi ligada: falta o secret OPENAI_API_KEY no Worker denia-landing (Cloudflare → denia-landing → Settings → Variables and Secrets).", codigo: "SEM_OPENAI" } };
}
function textoDaResposta(d) {
  if (typeof d?.output_text === "string" && d.output_text) return d.output_text;
  const partes = [];
  for (const o of d?.output || []) for (const c of o?.content || []) if (typeof c?.text === "string") partes.push(c.text);
  return partes.join("");
}
async function openai(env, caminho, corpo, extras = {}) {
  const r = await fetch("https://api.openai.com/v1/" + caminho, {
    method: "POST",
    headers: { authorization: `Bearer ${chave(env)}`, ...(corpo instanceof FormData ? {} : { "content-type": "application/json" }) },
    body: corpo instanceof FormData ? corpo : JSON.stringify(corpo),
    signal: AbortSignal.timeout(extras.timeout || 60000)
  });
  if (extras.binario) {
    if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}`);
    return r;
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = d?.error?.message || `HTTP ${r.status}`;
    const e = new Error(r.status === 401 ? "A chave da OpenAI foi recusada. Confira o OPENAI_API_KEY no Worker denia-landing." : r.status === 429 ? "A OpenAI recusou por limite ou falta de crédito na conta. Confira em platform.openai.com → Billing." : "A IA não conseguiu responder agora: " + msg);
    e.status = r.status;
    throw e;
  }
  return d;
}
async function iaJSON(env, instrucoes, entrada, maxTokens = 2500) {
  const d = await openai(env, "responses", {
    model: String(env.OPENAI_MODEL || MODELO_TEXTO).trim(), instructions: instrucoes,
    input: [{ role: "user", content: [{ type: "input_text", text: entrada }] }],
    text: { format: { type: "json_object" } }, max_output_tokens: maxTokens, store: false
  });
  try { return JSON.parse(textoDaResposta(d)); } catch { throw new Error("A IA respondeu num formato inesperado. Tente de novo."); }
}
async function iaTexto(env, instrucoes, mensagens, maxTokens = 900) {
  const d = await openai(env, "responses", {
    model: String(env.OPENAI_MODEL || MODELO_TEXTO).trim(), instructions: instrucoes,
    input: mensagens.map(m => ({ role: m.papel === "denia" ? "assistant" : "user", content: [{ type: m.papel === "denia" ? "output_text" : "input_text", text: m.texto }] })),
    max_output_tokens: maxTokens, store: false
  });
  return textoDaResposta(d).trim();
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function dataISO(v) { const s = String(v || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; }
function horaOk(v) { const s = String(v || "").slice(0, 5); return /^\d{2}:\d{2}$/.test(s) ? s : ""; }
function semanaDe(iso) {
  const d = new Date(iso + "T12:00:00Z"); const dia = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dia); return d.toISOString().slice(0, 10);
}
function maisDias(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function canaisOk(v) { const l = (Array.isArray(v) ? v : []).map(String).filter(c => CANAIS.includes(c)); return l.length ? [...new Set(l)] : ["instagram"]; }
function linhaPost(p) {
  let canais = []; let revisao = null;
  try { canais = JSON.parse(p.canais || "[]"); } catch { canais = []; }
  try { revisao = p.revisao ? JSON.parse(p.revisao) : null; } catch { revisao = null; }
  return { ...p, canais, revisao };
}
function resumoMarca(m) {
  return [`Marca: ${m.nome}`, m.segmento && `Segmento: ${m.segmento}`, m.cidade && `Cidade/região: ${m.cidade}`, m.publico && `Público: ${m.publico}`, m.tom && `Tom de voz: ${m.tom}`,
    m.diferenciais && `Diferenciais: ${m.diferenciais}`, m.cores && `Cores da marca: ${m.cores}`, m.whatsapp && `WhatsApp para contato: ${m.whatsapp}`, m.site && `Site: ${m.site}`].filter(Boolean).join("\n");
}
const REGRAS_CONTEUDO = `Regras: português do Brasil impecável, sem erros; nada de promessas que a empresa não pode cumprir; não invente preços, descontos, prêmios, números ou depoimentos; nada de conteúdo enganoso; respeite as políticas do Instagram, Facebook e Google; chamadas para ação claras (ex.: "Chame no WhatsApp"); hashtags relevantes e locais, no máximo 12.`;

// Revisão da IA (modo automático): dá nota de 0 a 10 e diz o que melhorar.
async function revisar(env, marca, post) {
  const r = await iaJSON(env, `Você é a diretora de criação de uma agência. Avalie um post antes da publicação. ${REGRAS_CONTEUDO}
Responda em JSON: {"nota":0,"aprovado":false,"comentario":""} — nota de 0 a 10; aprovado=true só se estiver pronto para publicar sem nenhum ajuste; comentario em 1 ou 2 frases.`,
  `${resumoMarca(marca)}\n\nPOST (${post.formato}, canais ${post.canais.join(", ")}):\nTítulo: ${post.titulo || "-"}\nLegenda: ${post.legenda || "-"}\nHashtags: ${post.hashtags || "-"}\nChamada: ${post.chamada || "-"}\nIdeia da imagem: ${post.ideia_imagem || "-"}`, 400);
  return { nota: Math.max(0, Math.min(10, Math.round(Number(r?.nota) || 0))), aprovado: r?.aprovado === true, comentario: String(r?.comentario || "").slice(0, 400) };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function apiMarketing(request, env, k, orgId, papel, resto) {
  const { json, lerCorpo, txt, pode, agora, auditar, sessao } = k;
  await garantir(env);
  const metodo = request.method;
  const autor = sessao.usuario.nome || sessao.usuario.email;
  const corpoOu = async (limite) => { const l = await lerCorpo(request, limite); if (l.erro) throw Object.assign(new Error("corpo"), { resposta: l.erro }); return l.corpo; };
  const marcaDa = async (id) => env.DB.prepare("SELECT * FROM plt_mk_marcas WHERE id=? AND org_id=?").bind(Number(id), orgId).first();
  const exigir = (min) => { if (!pode(papel, min)) throw Object.assign(new Error("perm"), { resposta: json({ erro: "Seu perfil não tem permissão para esta ação." }, 403) }); };
  let m;
  try {
    // ----- Marcas
    if (resto === "marcas" && metodo === "GET") {
      const r = await env.DB.prepare("SELECT * FROM plt_mk_marcas WHERE org_id=? AND ativa=1 ORDER BY nome").bind(orgId).all();
      return json({ marcas: r?.results || [] });
    }
    if (resto === "marcas" && metodo === "POST") {
      exigir("ADMIN");
      const c = await corpoOu(8000);
      const campos = ["nome", "segmento", "cidade", "instagram", "facebook", "google", "site", "whatsapp", "tom", "publico", "cores", "diferenciais"];
      const v = Object.fromEntries(campos.map(x => [x, txt(c[x], x === "diferenciais" || x === "publico" ? 600 : 200)]));
      v.instagram = v.instagram.replace(/^@+/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "");
      if (v.nome.length < 2) return json({ erro: "Informe o nome da marca." }, 400);
      if (c.id) {
        if (!(await marcaDa(c.id))) return json({ erro: "Marca não encontrada." }, 404);
        await env.DB.prepare(`UPDATE plt_mk_marcas SET ${campos.map(x => x + "=?").join(",")} WHERE id=? AND org_id=?`).bind(...campos.map(x => v[x] || null), Number(c.id), orgId).run();
        await auditar(env, request, sessao, orgId, "MARKETING", `Atualizou a marca ${v.nome}`);
        return json({ ok: true, id: Number(c.id) });
      }
      const n = await env.DB.prepare(`INSERT INTO plt_mk_marcas(org_id,${campos.join(",")},ativa,criado_ms) VALUES(?,${campos.map(() => "?").join(",")},1,?) RETURNING id`).bind(orgId, ...campos.map(x => v[x] || null), agora(env)).first();
      await auditar(env, request, sessao, orgId, "MARKETING", `Criou a marca ${v.nome}`);
      return json({ ok: true, id: n.id });
    }
    if ((m = resto.match(/^marcas\/(\d{1,12})\/remover$/)) && metodo === "POST") {
      exigir("ADMIN");
      await env.DB.prepare("UPDATE plt_mk_marcas SET ativa=0 WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).run();
      return json({ ok: true });
    }

    // ----- Configuração (modo de aprovação)
    if (resto === "config" && metodo === "GET") {
      const c = await env.DB.prepare("SELECT * FROM plt_mk_config WHERE org_id=?").bind(orgId).first();
      return json({ modo: c?.modo || "HUMANO", posts_semana: c?.posts_semana || 3, nota_minima: c?.nota_minima || 8, ia_ligada: Boolean(chave(env)) });
    }
    if (resto === "config" && metodo === "POST") {
      exigir("ADMIN");
      const c = await corpoOu(2000);
      const modo = c.modo === "AUTOMATICO" ? "AUTOMATICO" : "HUMANO";
      const ps = Math.max(1, Math.min(14, Math.round(Number(c.posts_semana) || 3)));
      const nota = Math.max(5, Math.min(10, Math.round(Number(c.nota_minima) || 8)));
      await env.DB.prepare("INSERT OR REPLACE INTO plt_mk_config(org_id,modo,posts_semana,nota_minima,atualizado_ms) VALUES(?,?,?,?,?)").bind(orgId, modo, ps, nota, agora(env)).run();
      await auditar(env, request, sessao, orgId, "MARKETING", `Aprovação de artes: ${modo === "AUTOMATICO" ? `automática (nota mínima ${nota})` : "por uma pessoa"} · ${ps} posts por semana`);
      return json({ ok: true });
    }

    // ----- Posts
    if (resto === "posts" && metodo === "GET") {
      const q = new URL(request.url).searchParams;
      const de = dataISO(q.get("de")) || "0000-01-01", ate = dataISO(q.get("ate")) || "9999-12-31";
      const marca = Number(q.get("marca") || 0), st = String(q.get("status") || "").toUpperCase(), canal = String(q.get("canal") || "");
      let sql = "SELECT * FROM plt_mk_posts WHERE org_id=? AND (data IS NULL OR (data>=? AND data<=?))";
      const args = [orgId, de, ate];
      if (marca) { sql += " AND marca_id=?"; args.push(marca); }
      if (STATUS_POST.includes(st)) { sql += " AND status=?"; args.push(st); }
      if (CANAIS.includes(canal)) { sql += " AND canais LIKE ?"; args.push(`%"${canal}"%`); }
      const r = await env.DB.prepare(sql + " ORDER BY data, hora, id LIMIT 400").bind(...args).all();
      return json({ posts: (r?.results || []).map(linhaPost) });
    }
    if (resto === "posts" && metodo === "POST") {
      exigir("AGENTE");
      const c = await corpoOu(20000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha a marca do post." }, 400);
      const v = { canais: JSON.stringify(canaisOk(c.canais)), formato: FORMATOS.includes(c.formato) ? c.formato : "post", data: dataISO(c.data) || null, hora: horaOk(c.hora) || null,
        titulo: txt(c.titulo, 200), legenda: txt(c.legenda, 2200), hashtags: txt(c.hashtags, 600), chamada: txt(c.chamada, 200), ideia_imagem: txt(c.ideia_imagem, 1000) };
      if (c.id) {
        const p = await env.DB.prepare("SELECT * FROM plt_mk_posts WHERE id=? AND org_id=?").bind(Number(c.id), orgId).first();
        if (!p) return json({ erro: "Post não encontrado." }, 404);
        if (p.status === "PUBLICADO") return json({ erro: "Este post já foi publicado." }, 409);
        // Editar um post aprovado devolve ele para aprovação.
        const status = p.status === "APROVADO" && !pode(papel, "ADMIN") ? "AGUARDANDO" : p.status;
        await env.DB.prepare("UPDATE plt_mk_posts SET marca_id=?, canais=?, formato=?, data=?, hora=?, titulo=?, legenda=?, hashtags=?, chamada=?, ideia_imagem=?, status=?, atualizado_ms=? WHERE id=? AND org_id=?")
          .bind(marca.id, v.canais, v.formato, v.data, v.hora, v.titulo, v.legenda, v.hashtags, v.chamada, v.ideia_imagem, status, agora(env), Number(c.id), orgId).run();
        return json({ ok: true, id: Number(c.id) });
      }
      const n = await env.DB.prepare(`INSERT INTO plt_mk_posts(org_id,marca_id,canais,formato,data,hora,titulo,legenda,hashtags,chamada,ideia_imagem,status,criado_por,criado_ms,atualizado_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'RASCUNHO',?,?,?) RETURNING id`).bind(orgId, marca.id, v.canais, v.formato, v.data, v.hora, v.titulo, v.legenda, v.hashtags, v.chamada, v.ideia_imagem, autor, agora(env), agora(env)).first();
      return json({ ok: true, id: n.id });
    }
    if ((m = resto.match(/^posts\/(\d{1,12})\/acao$/)) && metodo === "POST") {
      const c = await corpoOu(4000);
      const p = await env.DB.prepare("SELECT * FROM plt_mk_posts WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!p) return json({ erro: "Post não encontrado." }, 404);
      const acao = String(c.acao || "");
      const mudar = async (status, extra = {}) => {
        await env.DB.prepare("UPDATE plt_mk_posts SET status=?, comentario=COALESCE(?,comentario), aprovado_por=COALESCE(?,aprovado_por), atualizado_ms=? WHERE id=?").bind(status, extra.comentario ?? null, extra.aprovado_por ?? null, agora(env), p.id).run();
        await auditar(env, request, sessao, orgId, "MARKETING", `Post #${p.id}: ${status.toLowerCase()}${extra.comentario ? " — " + extra.comentario : ""}`);
        return json({ ok: true, status });
      };
      if (acao === "enviar") { exigir("AGENTE"); return mudar("AGUARDANDO"); }
      if (acao === "aprovar") { exigir("ADMIN"); return mudar("APROVADO", { aprovado_por: autor }); }
      if (acao === "rejeitar") { exigir("ADMIN"); return mudar("REJEITADO", { comentario: txt(c.comentario, 400) || "Rejeitado" }); }
      if (acao === "publicado") { exigir("AGENTE"); if (p.status !== "APROVADO") return json({ erro: "Só posts aprovados podem ser marcados como publicados." }, 409); return mudar("PUBLICADO"); }
      if (acao === "rascunho") { exigir("AGENTE"); return mudar("RASCUNHO"); }
      if (acao === "excluir") {
        exigir("ADMIN");
        await env.DB.batch([env.DB.prepare("DELETE FROM plt_mk_posts WHERE id=?").bind(p.id), env.DB.prepare("DELETE FROM plt_mk_midias WHERE id=? AND org_id=?").bind(p.midia_id || 0, orgId)]);
        return json({ ok: true });
      }
      if (acao === "revisar") {
        exigir("AGENTE");
        if (!chave(env)) { const s = semChave(); return json(s.corpo, s.status); }
        const marca = await marcaDa(p.marca_id);
        const rv = await revisar(env, marca, linhaPost(p));
        await env.DB.prepare("UPDATE plt_mk_posts SET revisao=?, atualizado_ms=? WHERE id=?").bind(JSON.stringify(rv), agora(env), p.id).run();
        return json({ ok: true, revisao: rv });
      }
      return json({ erro: "Ação inválida." }, 400);
    }

    // ----- Imagens
    if ((m = resto.match(/^midias\/(\d{1,12})$/)) && metodo === "GET") {
      const r = await env.DB.prepare("SELECT mime, dados FROM plt_mk_midias WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!r) return new Response("Não encontrado.", { status: 404 });
      const bin = Uint8Array.from(atob(r.dados), ch => ch.charCodeAt(0));
      return new Response(bin, { headers: { "content-type": r.mime, "cache-control": "private, max-age=86400" } });
    }

    // ----- IA: semana de conteúdo, legenda, imagem
    if (resto.startsWith("ia/")) {
      if (!chave(env)) { const s = semChave(); return json(s.corpo, s.status); }
      if (resto === "ia/semana" && metodo === "POST") {
        exigir("AGENTE");
        const c = await corpoOu(4000);
        const marca = await marcaDa(c.marca_id);
        if (!marca) return json({ erro: "Escolha a marca." }, 400);
        const cfg = (await env.DB.prepare("SELECT * FROM plt_mk_config WHERE org_id=?").bind(orgId).first()) || { modo: "HUMANO", posts_semana: 3, nota_minima: 8 };
        const inicio = semanaDe(dataISO(c.inicio) || new Date(agora(env)).toISOString().slice(0, 10));
        const qtd = Math.max(1, Math.min(14, Number(c.quantidade) || cfg.posts_semana || 3));
        const canais = canaisOk(c.canais && c.canais.length ? c.canais : ["instagram", "facebook"]);
        const anteriores = ((await env.DB.prepare("SELECT titulo FROM plt_mk_posts WHERE marca_id=? ORDER BY id DESC LIMIT 20").bind(marca.id).all())?.results || []).map(x => x.titulo).filter(Boolean);
        const r = await iaJSON(env, `Você é a estrategista de conteúdo de uma agência de marketing digital de alto nível. Crie o calendário de posts de UMA semana para a marca, variado (dicas, bastidores, prova social sem inventar depoimentos, oferta de serviço, educativo, sazonal), com foco em gerar contatos pelo WhatsApp. ${REGRAS_CONTEUDO}
Responda em JSON: {"posts":[{"dia":0,"hora":"18:00","formato":"post","titulo":"","legenda":"","hashtags":"","chamada":"","ideia_imagem":""}]}
- dia: 0=segunda … 6=domingo; distribua bem na semana; horários de maior alcance.
- formato: post, carrossel, story ou reels.
- legenda: pronta para publicar (pode usar emojis com moderação e quebras de linha).
- ideia_imagem: descrição visual detalhada da arte (cena, composição, cores da marca, texto curto que aparece na arte), para um designer ou gerador de imagens.`,
        `${resumoMarca(marca)}\n\nSemana que começa em ${inicio}. Quantidade de posts: ${qtd}. Canais: ${canais.join(", ")}.\nTemas já usados recentemente (evite repetir): ${anteriores.join("; ") || "nenhum"}.\nResponda em JSON.`, 4000);
        const lista = (Array.isArray(r?.posts) ? r.posts : []).slice(0, qtd);
        const criados = [];
        for (const it of lista) {
          const post = { canais, formato: FORMATOS.includes(it.formato) ? it.formato : "post", data: maisDias(inicio, Math.max(0, Math.min(6, Number(it.dia) || 0))), hora: horaOk(it.hora) || "18:00",
            titulo: txt(it.titulo, 200), legenda: txt(it.legenda, 2200), hashtags: txt(it.hashtags, 600), chamada: txt(it.chamada, 200), ideia_imagem: txt(it.ideia_imagem, 1000) };
          let status = "AGUARDANDO", revisao = null;
          if (cfg.modo === "AUTOMATICO") {
            revisao = await revisar(env, marca, post).catch(() => null);
            status = revisao && revisao.aprovado && revisao.nota >= cfg.nota_minima ? "APROVADO" : "AGUARDANDO";
          }
          const n = await env.DB.prepare(`INSERT INTO plt_mk_posts(org_id,marca_id,canais,formato,data,hora,titulo,legenda,hashtags,chamada,ideia_imagem,status,revisao,criado_por,aprovado_por,criado_ms,atualizado_ms)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).bind(orgId, marca.id, JSON.stringify(post.canais), post.formato, post.data, post.hora, post.titulo, post.legenda, post.hashtags, post.chamada, post.ideia_imagem, status, revisao ? JSON.stringify(revisao) : null, "DENIA (IA)", status === "APROVADO" ? "DENIA (aprovação automática)" : null, agora(env), agora(env)).first();
          criados.push({ id: n.id, status });
        }
        await auditar(env, request, sessao, orgId, "MARKETING", `IA criou ${criados.length} post(s) para ${marca.nome} (semana de ${inicio})`);
        return json({ ok: true, criados, modo: cfg.modo });
      }
      if (resto === "ia/legenda" && metodo === "POST") {
        exigir("AGENTE");
        const c = await corpoOu(4000);
        const marca = await marcaDa(c.marca_id);
        if (!marca) return json({ erro: "Escolha a marca." }, 400);
        const r = await iaJSON(env, `Você é redatora publicitária sênior. Escreva um post a partir do tema pedido. ${REGRAS_CONTEUDO}
Responda em JSON: {"titulo":"","legenda":"","hashtags":"","chamada":"","ideia_imagem":""}`, `${resumoMarca(marca)}\n\nTema: ${txt(c.tema, 600)}\nFormato: ${FORMATOS.includes(c.formato) ? c.formato : "post"}\nCanal: ${CANAIS.includes(c.canal) ? c.canal : "instagram"}\nResponda em JSON.`, 1500);
        return json({ ok: true, sugestao: { titulo: txt(r.titulo, 200), legenda: txt(r.legenda, 2200), hashtags: txt(r.hashtags, 600), chamada: txt(r.chamada, 200), ideia_imagem: txt(r.ideia_imagem, 1000) } });
      }
      if (resto === "ia/imagem" && metodo === "POST") {
        exigir("AGENTE");
        const c = await corpoOu(4000);
        const p = c.post_id ? await env.DB.prepare("SELECT * FROM plt_mk_posts WHERE id=? AND org_id=?").bind(Number(c.post_id), orgId).first() : null;
        const marca = await marcaDa(p ? p.marca_id : c.marca_id);
        if (!marca) return json({ erro: "Escolha a marca." }, 400);
        const ideia = txt(c.ideia || p?.ideia_imagem || p?.titulo, 1000);
        if (!ideia) return json({ erro: "Descreva a imagem que a IA deve criar." }, 400);
        const prompt = `Arte profissional para redes sociais da marca "${marca.nome}" (${marca.segmento || "serviços"}${marca.cidade ? ", " + marca.cidade : ""}). ${marca.cores ? "Cores da marca: " + marca.cores + ". " : ""}${ideia}. Visual moderno, limpo, de agência de alto padrão, boa iluminação, composição equilibrada; se houver texto na arte, em português do Brasil, curto e sem erros.`;
        const formato = p?.formato === "story" || p?.formato === "reels" ? "1024x1536" : "1024x1024";
        const d = await openai(env, "images/generations", { model: String(env.OPENAI_IMAGE_MODEL || "gpt-image-1").trim(), prompt, size: formato, quality: "medium", output_format: "jpeg", output_compression: 82, n: 1 }, { timeout: 120000 });
        const b64 = d?.data?.[0]?.b64_json;
        if (!b64) return json({ erro: "A IA não devolveu a imagem. Tente de novo." }, 502);
        const md = await env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms) VALUES(?,?,?,?,?) RETURNING id").bind(orgId, "image/jpeg", b64, prompt.slice(0, 2000), agora(env)).first();
        if (p) {
          await env.DB.prepare("UPDATE plt_mk_posts SET midia_id=?, atualizado_ms=? WHERE id=?").bind(md.id, agora(env), p.id).run();
          if (p.midia_id) await env.DB.prepare("DELETE FROM plt_mk_midias WHERE id=? AND org_id=?").bind(p.midia_id, orgId).run();
        }
        return json({ ok: true, midia_id: md.id });
      }
    }

    // ----- Google Meu Negócio: avaliações
    if (resto === "avaliacoes" && metodo === "GET") {
      const marca = Number(new URL(request.url).searchParams.get("marca") || 0);
      const r = await env.DB.prepare(`SELECT * FROM plt_mk_avaliacoes WHERE org_id=? ${marca ? "AND marca_id=?" : ""} ORDER BY status='RESPONDIDA', id DESC LIMIT 300`).bind(...(marca ? [orgId, marca] : [orgId])).all();
      return json({ avaliacoes: r?.results || [] });
    }
    if (resto === "avaliacoes" && metodo === "POST") {
      exigir("AGENTE");
      const c = await corpoOu(6000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha a marca." }, 400);
      const nota = Math.max(1, Math.min(5, Math.round(Number(c.nota) || 5)));
      const n = await env.DB.prepare("INSERT INTO plt_mk_avaliacoes(org_id,marca_id,autor,nota,texto,data,status,criado_ms) VALUES(?,?,?,?,?,?,'PENDENTE',?) RETURNING id").bind(orgId, marca.id, txt(c.autor, 120) || "Cliente", nota, txt(c.texto, 3000), dataISO(c.data) || new Date(agora(env)).toISOString().slice(0, 10), agora(env)).first();
      return json({ ok: true, id: n.id });
    }
    if ((m = resto.match(/^avaliacoes\/(\d{1,12})\/(sugerir|responder|remover)$/)) && metodo === "POST") {
      exigir("AGENTE");
      const a = await env.DB.prepare("SELECT * FROM plt_mk_avaliacoes WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!a) return json({ erro: "Avaliação não encontrada." }, 404);
      if (m[2] === "remover") { await env.DB.prepare("DELETE FROM plt_mk_avaliacoes WHERE id=?").bind(a.id).run(); return json({ ok: true }); }
      if (m[2] === "responder") {
        const c = await corpoOu(4000);
        await env.DB.prepare("UPDATE plt_mk_avaliacoes SET resposta=?, status='RESPONDIDA' WHERE id=?").bind(txt(c.resposta, 2000), a.id).run();
        await auditar(env, request, sessao, orgId, "MARKETING", `Respondeu a avaliação de ${a.autor} (${a.nota}★)`);
        return json({ ok: true });
      }
      if (!chave(env)) { const s = semChave(); return json(s.corpo, s.status); }
      const marca = await marcaDa(a.marca_id);
      const r = await iaJSON(env, `Você responde avaliações do Google em nome da empresa, como o dono responderia: cordial, humano, específico ao que o cliente escreveu, curto (2 a 4 frases). Agradeça sempre. Em avaliação negativa: peça desculpas sem se defender, mostre que vai resolver e convide para falar no WhatsApp; nunca exponha dados do cliente nem discuta. Não invente fatos. Português do Brasil impecável.
Responda em JSON: {"resposta":""}`, `${resumoMarca(marca)}\n\nAvaliação de ${a.autor} (${a.nota} de 5 estrelas):\n"${a.texto || "(sem texto)"}"\nResponda em JSON.`, 600);
      const resp = txt(r.resposta, 2000);
      await env.DB.prepare("UPDATE plt_mk_avaliacoes SET resposta_sugerida=? WHERE id=?").bind(resp, a.id).run();
      return json({ ok: true, resposta: resp });
    }

    // ----- Google Meu Negócio: palavras-chave e posição semanal
    if (resto === "palavras" && metodo === "GET") {
      const marca = Number(new URL(request.url).searchParams.get("marca") || 0);
      const r = await env.DB.prepare(`SELECT * FROM plt_mk_palavras WHERE org_id=? ${marca ? "AND marca_id=?" : ""} ORDER BY id`).bind(...(marca ? [orgId, marca] : [orgId])).all();
      const palavras = r?.results || [];
      const pos = palavras.length ? ((await env.DB.prepare(`SELECT * FROM plt_mk_posicoes WHERE palavra_id IN (${palavras.map(() => "?").join(",")}) ORDER BY semana`).bind(...palavras.map(p => p.id)).all())?.results || []) : [];
      return json({ palavras: palavras.map(p => ({ ...p, posicoes: pos.filter(x => x.palavra_id === p.id) })) });
    }
    if (resto === "palavras" && metodo === "POST") {
      exigir("AGENTE");
      const c = await corpoOu(2000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha a marca." }, 400);
      const palavra = txt(c.palavra, 120);
      if (palavra.length < 2) return json({ erro: "Informe a palavra-chave." }, 400);
      const n = await env.DB.prepare("INSERT INTO plt_mk_palavras(org_id,marca_id,palavra,cidade,criado_ms) VALUES(?,?,?,?,?) RETURNING id").bind(orgId, marca.id, palavra, txt(c.cidade, 120) || marca.cidade || null, agora(env)).first();
      return json({ ok: true, id: n.id });
    }
    if ((m = resto.match(/^palavras\/(\d{1,12})\/(posicao|remover)$/)) && metodo === "POST") {
      exigir("AGENTE");
      const p = await env.DB.prepare("SELECT * FROM plt_mk_palavras WHERE id=? AND org_id=?").bind(Number(m[1]), orgId).first();
      if (!p) return json({ erro: "Palavra-chave não encontrada." }, 404);
      if (m[2] === "remover") { await env.DB.batch([env.DB.prepare("DELETE FROM plt_mk_palavras WHERE id=?").bind(p.id), env.DB.prepare("DELETE FROM plt_mk_posicoes WHERE palavra_id=?").bind(p.id)]); return json({ ok: true }); }
      const c = await corpoOu(1000);
      const semana = semanaDe(dataISO(c.semana) || new Date(agora(env)).toISOString().slice(0, 10));
      const posicao = c.posicao === null || c.posicao === "" ? null : Math.max(1, Math.min(100, Math.round(Number(c.posicao))));
      await env.DB.prepare("INSERT OR REPLACE INTO plt_mk_posicoes(palavra_id,semana,posicao,criado_ms) VALUES(?,?,?,?)").bind(p.id, semana, Number.isFinite(posicao) ? posicao : null, agora(env)).run();
      return json({ ok: true });
    }

    // ----- Google Meu Negócio: desempenho semanal
    if (resto === "metricas" && metodo === "GET") {
      const marca = Number(new URL(request.url).searchParams.get("marca") || 0);
      const r = await env.DB.prepare("SELECT * FROM plt_mk_metricas WHERE org_id=? AND marca_id=? ORDER BY semana DESC LIMIT 26").bind(orgId, marca).all();
      return json({ metricas: (r?.results || []).map(x => ({ semana: x.semana, ...JSON.parse(x.dados || "{}") })) });
    }
    if (resto === "metricas" && metodo === "POST") {
      exigir("AGENTE");
      const c = await corpoOu(2000);
      const marca = await marcaDa(c.marca_id);
      if (!marca) return json({ erro: "Escolha a marca." }, 400);
      const nomes = ["visualizacoes", "buscas", "ligacoes", "rotas", "cliques_site", "mensagens", "nota_media", "total_avaliacoes"];
      const dados = Object.fromEntries(nomes.map(n => [n, c[n] === "" || c[n] == null ? null : Math.max(0, Number(c[n]) || 0)]));
      const semana = semanaDe(dataISO(c.semana) || new Date(agora(env)).toISOString().slice(0, 10));
      await env.DB.prepare("INSERT OR REPLACE INTO plt_mk_metricas(org_id,marca_id,semana,dados,criado_ms) VALUES(?,?,?,?,?)").bind(orgId, marca.id, semana, JSON.stringify(dados), agora(env)).run();
      return json({ ok: true });
    }

    // ----- Resumo do Estúdio
    if (resto === "resumo" && metodo === "GET") {
      const hoje = new Date(agora(env)).toISOString().slice(0, 10), ini = semanaDe(hoje), fim = maisDias(ini, 6);
      const q = async (sql, ...a) => Number((await env.DB.prepare(sql).bind(...a).first())?.n || 0);
      return json({
        marcas: await q("SELECT COUNT(*) n FROM plt_mk_marcas WHERE org_id=? AND ativa=1", orgId),
        aguardando: await q("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND status='AGUARDANDO'", orgId),
        aprovados: await q("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND status='APROVADO'", orgId),
        semana: await q("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND data>=? AND data<=?", orgId, ini, fim),
        publicados: await q("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND status='PUBLICADO'", orgId),
        avaliacoes_pendentes: await q("SELECT COUNT(*) n FROM plt_mk_avaliacoes WHERE org_id=? AND status='PENDENTE'", orgId),
        semana_inicio: ini, ia_ligada: Boolean(chave(env))
      });
    }
    return json({ erro: "Rota não encontrada." }, 404);
  } catch (e) {
    if (e?.resposta) return e.resposta;
    console.error("marketing", e?.message);
    return json({ erro: e?.message || "Não foi possível concluir agora." }, e?.status && e.status < 500 ? 502 : 500);
  }
}

// ---------------------------------------------------------------------------
// Assistente DENIA (texto e voz)
// ---------------------------------------------------------------------------

export async function apiAssistente(request, env, k, orgId, papel, resto, contexto) {
  const { json, lerCorpo, txt } = k;
  if (!chave(env)) { const s = semChave(); return json(s.corpo, s.status); }
  try {
    if (resto === "assistente/transcrever" && request.method === "POST") {
      const tipo = request.headers.get("content-type") || "audio/webm";
      const audio = await request.arrayBuffer();
      if (audio.byteLength > 8 * 1024 * 1024) return json({ erro: "Áudio longo demais (máximo de cerca de 2 minutos)." }, 413);
      const f = new FormData();
      f.append("file", new Blob([audio], { type: tipo.split(";")[0] }), "fala." + (tipo.includes("mp4") ? "mp4" : tipo.includes("ogg") ? "ogg" : "webm"));
      f.append("model", String(env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe"));
      f.append("language", "pt");
      const d = await openai(env, "audio/transcriptions", f, { timeout: 45000 });
      return json({ texto: String(d?.text || "").trim() });
    }
    if (resto === "assistente/falar" && request.method === "POST") {
      const l = await lerCorpo(request, 6000);
      if (l.erro) return l.erro;
      const texto = txt(l.corpo.texto, 1500);
      if (!texto) return json({ erro: "Nada para falar." }, 400);
      const r = await openai(env, "audio/speech", { model: String(env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"), voice: String(env.OPENAI_TTS_VOZ || "coral"), input: texto, response_format: "mp3",
        instructions: "Fale em português do Brasil, com voz feminina calorosa, segura e profissional, ritmo natural." }, { binario: true, timeout: 45000 });
      return new Response(r.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
    }
    if (resto === "assistente/conversa" && request.method === "POST") {
      const l = await lerCorpo(request, 40000);
      if (l.erro) return l.erro;
      const msgs = (Array.isArray(l.corpo.mensagens) ? l.corpo.mensagens : []).slice(-16)
        .map(x => ({ papel: x.papel === "denia" ? "denia" : "usuario", texto: txt(x.texto, 3000) })).filter(x => x.texto);
      if (!msgs.length) return json({ erro: "Escreva ou fale alguma coisa." }, 400);
      const resposta = await iaTexto(env, `Você é a DENIA, a inteligência artificial da plataforma DENIA, conversando com a equipe da empresa "${contexto.empresa}" dentro do painel (não com clientes).
Seja uma colega brilhante: direta, calorosa, prática, em português do Brasil impecável. Respostas curtas (até 5 frases), a não ser que peçam detalhes; se a resposta for ser falada em voz, evite listas longas e símbolos.
Use os DADOS DO PAINEL abaixo para responder sobre a operação. Quando a pessoa quiser fazer algo, diga exatamente onde clicar no painel (Conversas, Atendimentos, Treinar IA, Aprendizados, Estúdio de Marketing, Calendário, Aprovações, Marcas, Google Meu Negócio, Integrações). Nunca invente números, conversas, clientes ou resultados que não estão nos dados. Você ainda não executa ações sozinha por esta conversa: oriente e, se for criação de conteúdo, ofereça um texto pronto.
DADOS DO PAINEL (agora):
${contexto.dados}`, msgs, 900);
      return json({ resposta: resposta || "Desculpe, não consegui responder agora. Pode repetir?" });
    }
    return json({ erro: "Rota não encontrada." }, 404);
  } catch (e) {
    console.error("assistente", e?.message);
    return json({ erro: e?.message || "Não foi possível responder agora." }, 502);
  }
}
