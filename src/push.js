// Notificações no celular (Web Push) — do próprio app da DENIA instalado na tela inicial, sem loja e sem custo.
// Android (Chrome) e iPhone (iOS 16.4+, com a DENIA adicionada à Tela de Início) recebem mesmo com o app fechado.
// Padrões: RFC 8030 (envio), RFC 8291 (conteúdo cifrado aes128gcm) e RFC 8292 (VAPID). Só WebCrypto, sem bibliotecas.
// As chaves VAPID nascem sozinhas na primeira vez e ficam no banco (a pública vai para o navegador).

export const DDL_PUSH = [
  `CREATE TABLE IF NOT EXISTS plt_push (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    aparelho TEXT, criado_ms INTEGER, ultimo_ms INTEGER, falhas INTEGER NOT NULL DEFAULT 0)`,
  "CREATE INDEX IF NOT EXISTS plt_push_usuario ON plt_push(usuario_id)",
  "CREATE TABLE IF NOT EXISTS plt_push_enviados (org_id INTEGER NOT NULL, chave TEXT NOT NULL, ms INTEGER, PRIMARY KEY (org_id, chave))"
];
const prontos = new WeakSet();
async function garantir(env) {
  if (prontos.has(env.DB)) return;
  for (const s of DDL_PUSH) await env.DB.prepare(s).run();
  prontos.add(env.DB);
}

const enc = new TextEncoder();
const b64url = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deB64url = s => { const t = String(s).replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(t + "===".slice((t.length + 3) % 4)); return Uint8Array.from(bin, c => c.charCodeAt(0)); };
const juntar = (...partes) => { const out = new Uint8Array(partes.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of partes) { out.set(p, i); i += p.length; } return out; };

// Chaves VAPID (ECDSA P-256): criadas uma vez e guardadas.
export async function chavesVapid(env) {
  await garantir(env);
  const salvo = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='vapid'").first().catch(() => null);
  if (salvo?.valor) { try { const v = JSON.parse(salvo.valor); if (v.publica && v.privada) return v; } catch { /* recria */ } }
  const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const v = { publica: b64url(await crypto.subtle.exportKey("raw", par.publicKey)), privada: await crypto.subtle.exportKey("jwk", par.privateKey) };
  await env.DB.prepare("INSERT OR IGNORE INTO plt_meta(chave,valor) VALUES('vapid',?)").bind(JSON.stringify(v)).run();
  const final = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='vapid'").first();
  return JSON.parse(final.valor);
}

async function jwtVapid(env, endpoint, sujeito) {
  const v = await chavesVapid(env);
  const chave = await crypto.subtle.importKey("jwk", v.privada, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const cab = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const corpo = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: sujeito })));
  const assinatura = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chave, enc.encode(`${cab}.${corpo}`));
  return { jwt: `${cab}.${corpo}.${b64url(assinatura)}`, publica: v.publica };
}

const hkdf = async (salt, ikm, info, bytes) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), bytes * 8));

// Conteúdo cifrado para um aparelho (RFC 8291): só o navegador daquele aparelho consegue ler.
export async function cifrar(p256dh, auth, texto) {
  const uaPub = deB64url(p256dh), segredo = deB64url(auth);
  const efemera = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", efemera.publicKey));
  const chaveUa = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const compartilhado = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: chaveUa }, efemera.privateKey, 256));
  const ikm = await hkdf(segredo, compartilhado, juntar(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const claro = juntar(enc.encode(texto), new Uint8Array([2])); // 0x02 = último (e único) bloco
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]), claro));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return juntar(salt, rs, new Uint8Array([asPub.length]), asPub, cifrado);
}

// Envia para um aparelho. Devolve { ok, status }; aparelho que saiu (404/410) é apagado.
export async function enviarParaAparelho(env, insc, dados) {
  const sujeito = /^https:\/\//.test(String(env.SITE_URL || "")) ? String(env.SITE_URL).replace(/\/+$/, "") : "https://denia-ai.com";
  const { jwt, publica } = await jwtVapid(env, insc.endpoint, sujeito);
  const corpo = await cifrar(insc.p256dh, insc.auth, JSON.stringify(dados).slice(0, 3000));
  let r;
  try {
    r = await fetch(insc.endpoint, { method: "POST", headers: { authorization: `vapid t=${jwt}, k=${publica}`, "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: dados.urgente ? "high" : "normal", ...(dados.tag ? { topic: String(dados.tag).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}) }, body: corpo, signal: AbortSignal.timeout(15000) });
  } catch (e) { return { ok: false, status: 0, erro: e?.message }; }
  const agora = typeof env.__agora === "function" ? env.__agora() : Date.now();
  if (r.status === 404 || r.status === 410) await env.DB.prepare("DELETE FROM plt_push WHERE endpoint=?").bind(insc.endpoint).run().catch(() => { });
  else if (r.ok) await env.DB.prepare("UPDATE plt_push SET ultimo_ms=?, falhas=0 WHERE endpoint=?").bind(agora, insc.endpoint).run().catch(() => { });
  else await env.DB.prepare("UPDATE plt_push SET falhas=falhas+1 WHERE endpoint=?").bind(insc.endpoint).run().catch(() => { });
  return { ok: r.ok, status: r.status };
}

// Notifica pessoas (todos os aparelhos de cada uma).
export async function notificarUsuarios(env, usuarioIds, dados) {
  await garantir(env);
  const ids = [...new Set(usuarioIds.map(Number).filter(Boolean))];
  if (!ids.length) return 0;
  const aparelhos = (await env.DB.prepare(`SELECT * FROM plt_push WHERE usuario_id IN (${ids.map(() => "?").join(",")}) AND falhas < 20`).bind(...ids).all())?.results || [];
  let n = 0;
  for (const a of aparelhos) if ((await enviarParaAparelho(env, a, dados)).ok) n++;
  return n;
}

// Quem recebe os avisos de uma empresa: dono e administradores dela, e quem administra a plataforma.
async function destinatarios(env, orgId) {
  const r = (await env.DB.prepare(`SELECT DISTINCT p.usuario_id FROM plt_push p JOIN plt_usuarios u ON u.id=p.usuario_id AND u.ativo=1
    LEFT JOIN plt_membros m ON m.usuario_id=p.usuario_id AND m.org_id=? WHERE m.papel IN ('OWNER','ADMIN') OR u.super_admin=1`).bind(orgId).all().catch(() => null))?.results || [];
  return r.map(x => x.usuario_id);
}

// Lembrete de compromisso (no "avisar antes" e na hora): toca como alarme no celular de quem é o compromisso.
// Sem responsável: o dono e os administradores. Marcado para um contato sem login: quem cuida da agenda de todos.
export async function pushAgenda(env, orgId, responsavelId, contatoId, dados) {
  await garantir(env);
  const linhas = async (sql, ...a) => ((await env.DB.prepare(sql).bind(...a).all().catch(() => null))?.results || []).map(x => x.usuario_id);
  const ids = [];
  if (responsavelId) ids.push(Number(responsavelId));
  ids.push(...await linhas("SELECT usuario_id FROM adm_pessoas WHERE org_id=? AND ativo=1 AND so_minhas=0 AND lembretes_todos=1", orgId));
  if (!responsavelId && !contatoId) ids.push(...await linhas(`SELECT DISTINCT p.usuario_id FROM plt_push p JOIN plt_usuarios u ON u.id=p.usuario_id AND u.ativo=1
    LEFT JOIN plt_membros m ON m.usuario_id=p.usuario_id AND m.org_id=? WHERE m.papel IN ('OWNER','ADMIN') OR u.super_admin=1`, orgId));
  return notificarUsuarios(env, ids, { alarme: true, urgente: true, org: orgId, ...dados });
}

const ICONE_AREA = { WHATSAPP: "💬", PUBLICACOES: "📣", CLIENTES: "⭐", TEMPORADA: "🏠", AGENDA: "📅", CENTRAL: "🛠️", FINANCEIRO: "💰" };
// Tarefa automática: cada aviso novo da página "Avisos e problemas" vira uma notificação no celular (uma vez só).
// Na primeira vez de cada empresa, o que já estava aberto só é marcado (ninguém recebe uma enxurrada).
export async function avisosNoCelular(env, problemasDe, agora = Date.now()) {
  await garantir(env);
  const temAparelho = await env.DB.prepare("SELECT 1 FROM plt_push LIMIT 1").first().catch(() => null);
  if (!temAparelho) return { enviados: 0 };
  const orgs = (await env.DB.prepare("SELECT id, nome FROM plt_organizacoes WHERE status='ATIVA' ORDER BY id LIMIT 200").all())?.results || [];
  let enviados = 0;
  for (const o of orgs) {
    try {
      const para = await destinatarios(env, o.id);
      if (!para.length) continue;
      const abertos = await problemasDe(o.id);
      const ja = new Set(((await env.DB.prepare("SELECT chave FROM plt_push_enviados WHERE org_id=?").bind(o.id).all())?.results || []).map(x => x.chave));
      const primeira = !(await env.DB.prepare("SELECT 1 FROM plt_meta WHERE chave=?").bind("push_base_" + o.id).first().catch(() => null));
      // Agendamento novo ou cancelado não vira notificação: o celular só toca na hora do lembrete do compromisso.
      const novos = abertos.filter(p => p.chave && !ja.has(p.chave) && p.area !== "AGENDA");
      if (novos.length) await env.DB.batch(novos.slice(0, 300).map(p => env.DB.prepare("INSERT OR IGNORE INTO plt_push_enviados(org_id,chave,ms) VALUES(?,?,?)").bind(o.id, p.chave, agora)));
      if (primeira) { await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("push_base_" + o.id, String(agora)).run(); continue; }
      if (!novos.length) continue;
      const empresa = orgs.length > 1 ? ` — ${o.nome}` : "";
      if (novos.length <= 3) {
        for (const p of novos) enviados += await notificarUsuarios(env, para, { titulo: `${ICONE_AREA[p.area] || "🔔"} ${p.titulo}`.slice(0, 120), texto: `${p.motivo || p.dica || "Toque para ver."}${empresa}`.slice(0, 240), url: p.link ? `/app${p.link}` : "/app#/problemas", tag: "p" + o.id + "-" + String(p.chave).slice(-20), org: o.id, urgente: p.gravidade === "ALTA" });
      } else {
        enviados += await notificarUsuarios(env, para, { titulo: `🔔 ${novos.length} avisos novos${empresa}`, texto: novos.slice(0, 3).map(p => p.titulo).join(" · ").slice(0, 240), url: "/app#/problemas", tag: "resumo-" + o.id, org: o.id, urgente: novos.some(p => p.gravidade === "ALTA") });
      }
    } catch (e) { console.error("avisos no celular", o.id, e?.message); }
  }
  await env.DB.prepare("DELETE FROM plt_push_enviados WHERE ms < ?").bind(agora - 60 * 86400000).run().catch(() => { });
  return { enviados };
}

// Rotas da pessoa logada: chave pública, ativar/desativar este aparelho, teste e lista de aparelhos.
export async function rotasPush(request, env, sessao, caminho, { json, lerCorpo }) {
  await garantir(env);
  const metodo = request.method, u = sessao.usuario;
  const agora = typeof env.__agora === "function" ? env.__agora() : Date.now();
  if (caminho === "/api/push" && metodo === "GET") {
    const ap = (await env.DB.prepare("SELECT id, aparelho, criado_ms, ultimo_ms, endpoint FROM plt_push WHERE usuario_id=? ORDER BY criado_ms DESC").bind(u.id).all())?.results || [];
    return json({ chave: (await chavesVapid(env)).publica, aparelhos: ap.map(a => ({ id: a.id, aparelho: a.aparelho, criado_ms: a.criado_ms, ultimo_ms: a.ultimo_ms, fim: a.endpoint.slice(-12) })) });
  }
  if (caminho === "/api/push/inscrever" && metodo === "POST") {
    const { corpo, erro } = await lerCorpo(request, 4000); if (erro) return erro;
    const ep = String(corpo?.endpoint || ""), p256dh = String(corpo?.keys?.p256dh || ""), auth = String(corpo?.keys?.auth || "");
    if (!/^https:\/\/[^\s]{10,800}$/.test(ep) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return json({ erro: "Inscrição inválida. Tente ativar de novo." }, 400);
    const aparelho = String(corpo?.aparelho || request.headers.get("user-agent") || "").replace(/\s+/g, " ").slice(0, 120);
    await env.DB.prepare(`INSERT INTO plt_push(usuario_id,endpoint,p256dh,auth,aparelho,criado_ms,falhas) VALUES(?,?,?,?,?,?,0)
      ON CONFLICT(endpoint) DO UPDATE SET usuario_id=excluded.usuario_id, p256dh=excluded.p256dh, auth=excluded.auth, aparelho=excluded.aparelho, falhas=0`).bind(u.id, ep, p256dh, auth, aparelho, agora).run();
    return json({ ok: true }, 201);
  }
  if (caminho === "/api/push/sair" && metodo === "POST") {
    const { corpo, erro } = await lerCorpo(request, 4000); if (erro) return erro;
    if (corpo?.id) await env.DB.prepare("DELETE FROM plt_push WHERE id=? AND usuario_id=?").bind(Number(corpo.id), u.id).run();
    else await env.DB.prepare("DELETE FROM plt_push WHERE endpoint=? AND usuario_id=?").bind(String(corpo?.endpoint || ""), u.id).run();
    return json({ ok: true });
  }
  if (caminho === "/api/push/testar" && metodo === "POST") {
    const n = await notificarUsuarios(env, [u.id], { titulo: "🔔 DENIA: notificações ligadas", texto: "É assim que os avisos chegam: avaliação ruim, post que não saiu, mensagem não entregue e o que mais precisar de você.", url: "/app#/problemas", tag: "teste" });
    return n ? json({ ok: true, aparelhos: n }) : json({ erro: "Nenhum aparelho recebeu. Ative as notificações neste aparelho primeiro." }, 409);
  }
  return null;
}
