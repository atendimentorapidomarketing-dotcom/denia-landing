// ============================================================================
// DENIA Platform — servidor multiempresa (Cloudflare Worker + arquivos estáticos)
// ============================================================================
//
// O que este arquivo faz:
//   1. Serve o site público e o painel (pasta /public).
//   2. Login com sessão assinada em cookie HttpOnly; cada usuário vê somente as
//      empresas das quais faz parte, com permissões por papel.
//   3. Guarda, por empresa, a conexão com o DENIA Engine daquela empresa
//      (o token fica cifrado no banco e nunca chega ao navegador).
//   4. Repassa ao Engine, de servidor para servidor, só as operações permitidas
//      para o papel do usuário, e registra tudo na auditoria.
//
// Bindings (wrangler.jsonc): DB (D1 da plataforma) e ASSETS (pasta public).
// Secrets (Workers → Settings → Variables and Secrets):
//   PLATFORM_ADMIN_EMAIL     e-mail do administrador geral (super admin)
//   PLATFORM_ADMIN_PASSWORD  senha do administrador geral (mínimo 12 caracteres)
//   SESSION_SECRET           chave aleatória (mínimo 32 caracteres); também
//                            protege os tokens dos Engines guardados no banco
//   CONTATO_WHATSAPP, CONTATO_EMAIL  (opcionais) botões de contato do site
// ============================================================================

const VERSAO = "2.0.0";
const SCHEMA = "2.3.0-a";
const COOKIE = "__Host-denia_sessao";
const SESSAO_MS = 8 * 60 * 60 * 1000;
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MS = 15 * 60 * 1000;
// PBKDF2: o número fica gravado com cada senha, então pode subir no futuro sem
// invalidar as senhas antigas. 20 mil cabe no limite de CPU do plano gratuito.
const PBKDF2_ITER = 20000;
const PAPEIS = ["OWNER", "ADMIN", "AGENTE", "VISUALIZADOR"];
const NIVEL = { VISUALIZADOR: 1, AGENTE: 2, ADMIN: 3, OWNER: 4 };
const NOME_PAPEL = { OWNER: "Proprietário", ADMIN: "Administrador", AGENTE: "Atendente", VISUALIZADOR: "Somente leitura" };

// Operações do Engine liberadas, com o papel mínimo de cada uma.
const ROTAS_ENGINE = [
  ["GET", /^status$/, "VISUALIZADOR"],
  ["GET", /^conversations$/, "VISUALIZADOR"],
  ["GET", /^conversations\/\d{1,12}$/, "VISUALIZADOR"],
  ["POST", /^conversations\/\d{1,12}\/(send|takeover|release)$/, "AGENTE", "CONVERSA"],
  ["GET", /^cases$/, "VISUALIZADOR"],
  ["POST", /^cases\/\d{1,12}\/status$/, "AGENTE", "ATENDIMENTO"],
  ["GET", /^professionals$/, "VISUALIZADOR"],
  ["GET", /^training$/, "VISUALIZADOR"],
  ["POST", /^training$/, "ADMIN", "TREINAMENTO"],
  ["GET", /^learning$/, "VISUALIZADOR"],
  ["POST", /^learning\/start$/, "ADMIN", "APRENDIZADO"],
  ["GET", /^learning\/suggestions$/, "VISUALIZADOR"],
  ["POST", /^learning\/suggestions\/\d{1,12}$/, "ADMIN", "APRENDIZADO"],
  ["GET", /^import\/clients$/, "VISUALIZADOR"],
  ["POST", /^import\/clients$/, "ADMIN", "IMPORTACAO"],
  ["POST", /^pause$/, "ADMIN", "PAUSA_GERAL"]
];
const PARAMS_ENGINE = { limit: /^\d{1,3}$/, status: /^(PENDENTE|APROVADA|REJEITADA)$/ };

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function agora(env) { return typeof env.__agora === "function" ? env.__agora() : Date.now(); }
function json(dados, status = 200, extras = {}) {
  return new Response(JSON.stringify(dados), { status, headers: { "content-type": "application/json; charset=UTF-8", ...extras } });
}
function redirecionar(destino) { return new Response(null, { status: 302, headers: { location: destino } }); }
function txt(v, max = 500) { return String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max); }
function iguaisSeguro(a, b) {
  a = String(a ?? ""); b = String(b ?? "");
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function deB64url(texto) {
  const s = String(texto).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
}
const enc = new TextEncoder();
async function hmac(chave, texto) {
  const k = await crypto.subtle.importKey("raw", enc.encode(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(texto))));
}
const espera = ms => new Promise(r => setTimeout(r, ms));
function emailValido(e) { return /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$/.test(e); }
function normEmail(e) { return txt(e, 254).toLowerCase(); }
function slug(nome) {
  return String(nome).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "empresa";
}
function senhaTemporaria() {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(14));
  let s = "";
  for (const x of b) s += alfabeto[x % alfabeto.length];
  return `${s.slice(0, 4)}-${s.slice(4, 9)}-${s.slice(9)}`;
}
function ipDe(request) { return request.headers.get("cf-connecting-ip") || "local"; }

// ---------------------------------------------------------------------------
// Banco de dados (criado automaticamente na primeira requisição)
// ---------------------------------------------------------------------------

const DDL = [
  `CREATE TABLE IF NOT EXISTS plt_meta (chave TEXT PRIMARY KEY, valor TEXT)`,
  `CREATE TABLE IF NOT EXISTS plt_organizacoes (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, segmento TEXT, cor TEXT, status TEXT NOT NULL DEFAULT 'ATIVA', criado_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plt_usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, nome TEXT, senha_hash TEXT, senha_salt TEXT, senha_iter INTEGER, super_admin INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1, trocar_senha INTEGER NOT NULL DEFAULT 0, sessao_versao INTEGER NOT NULL DEFAULT 1, origem TEXT, criado_ms INTEGER NOT NULL, ultimo_acesso_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS plt_membros (org_id INTEGER NOT NULL, usuario_id INTEGER NOT NULL, papel TEXT NOT NULL, criado_ms INTEGER NOT NULL, PRIMARY KEY (org_id, usuario_id))`,
  `CREATE INDEX IF NOT EXISTS plt_idx_membros_usuario ON plt_membros(usuario_id)`,
  `CREATE TABLE IF NOT EXISTS plt_integracoes (org_id INTEGER PRIMARY KEY, engine_url TEXT, token_cifrado TEXT, atualizado_ms INTEGER, atualizado_por TEXT)`,
  `CREATE TABLE IF NOT EXISTS plt_auditoria (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER, usuario_id INTEGER, email TEXT, acao TEXT NOT NULL, detalhe TEXT, ip TEXT, criado_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS plt_idx_auditoria_org ON plt_auditoria(org_id, id)`,
  `CREATE TABLE IF NOT EXISTS plt_tentativas (chave TEXT PRIMARY KEY, n INTEGER NOT NULL, ate INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plt_redefinicoes (token_hash TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL, expira_ms INTEGER NOT NULL, usado INTEGER NOT NULL DEFAULT 0, criado_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS plt_contatos (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, email TEXT, empresa TEXT, telefone TEXT, assunto TEXT, mensagem TEXT, ip TEXT, lido INTEGER NOT NULL DEFAULT 0, criado_ms INTEGER NOT NULL)`
];
let schemaPronto = false;
// Empresa principal do site antigo = Central de Atendimento (a primeira empresa da plataforma).
// É a que tem "central" no nome ou, se nenhuma tiver, a da primeira conta criada.
async function legadoPrincipal(env) {
  const r = await env.DB.prepare(`SELECT u.organization_id id FROM users u LEFT JOIN organizations o ON o.id=u.organization_id
    ORDER BY (lower(COALESCE(o.name,'')) LIKE '%central%') DESC, u.created_at ASC, u.rowid ASC LIMIT 1`).first().catch(() => null);
  return r?.id != null ? String(r.id) : null;
}
// As contas antigas da empresa principal ficam na Central; as demais, cada uma na sua empresa.
async function reconciliarContasLegadas(env) {
  const primeira = Number((await env.DB.prepare("SELECT MIN(id) id FROM plt_organizacoes").first())?.id || 0);
  const principal = await legadoPrincipal(env);
  if (!primeira || principal == null) return;
  await env.DB.prepare("UPDATE plt_organizacoes SET legado_id=? WHERE id=? AND legado_id IS NULL").bind(principal, primeira).run();
  const r = await env.DB.prepare("SELECT p.id, p.email, l.organization_id org, upper(COALESCE(l.role,'')) papel FROM plt_usuarios p JOIN users l ON lower(l.email)=p.email WHERE p.origem='LEGADO' AND p.super_admin=0").all().catch(() => null);
  for (const x of r?.results || []) {
    if (String(x.org) !== principal) continue;
    const proprias = (await env.DB.prepare("SELECT m.org_id FROM plt_membros m JOIN plt_organizacoes o ON o.id=m.org_id WHERE m.usuario_id=? AND m.org_id<>? AND o.slug LIKE 'empresa-%' AND (SELECT COUNT(*) FROM plt_membros m2 WHERE m2.org_id=m.org_id)=1").bind(x.id, primeira).all())?.results || [];
    const st = [env.DB.prepare("INSERT OR IGNORE INTO plt_membros(org_id,usuario_id,papel,criado_ms) VALUES(?,?,?,?)").bind(primeira, x.id, x.papel === "OWNER" ? "OWNER" : "ADMIN", agora(env))];
    for (const o of proprias) st.push(env.DB.prepare("DELETE FROM plt_membros WHERE org_id=?").bind(o.org_id), env.DB.prepare("DELETE FROM plt_organizacoes WHERE id=? AND NOT EXISTS (SELECT 1 FROM plt_integracoes WHERE org_id=?)").bind(o.org_id, o.org_id));
    await env.DB.batch(st);
  }
}
async function garantirSchema(env) {
  if (schemaPronto) return;
  if (!env.DB) throw Object.assign(new Error("D1 ausente"), { codigo: "SEM_BANCO" });
  const v = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='schema'").first().catch(() => null);
  if (v?.valor !== SCHEMA) {
    await env.DB.batch(DDL.map(s => env.DB.prepare(s)));
    await env.DB.prepare("ALTER TABLE plt_organizacoes ADD COLUMN legado_id TEXT").run().catch(() => { }); // já existe
    // A primeira empresa da plataforma.
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM plt_organizacoes").first();
    if (!Number(n?.n)) {
      await env.DB.prepare("INSERT INTO plt_organizacoes(nome,slug,segmento,cor,status,criado_ms) VALUES(?,?,?,?, 'ATIVA', ?)")
        .bind("Central de Atendimento", "central-de-atendimento", "Serviços residenciais e assistência técnica", "#4f8cff", agora(env)).run();
    }
    await reconciliarContasLegadas(env).catch(e => console.error("contas antigas", e?.message));
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES('schema',?)").bind(SCHEMA).run();
  }
  schemaPronto = true;
}

async function auditar(env, request, sessao, orgId, acao, detalhe = "") {
  try {
    await env.DB.prepare("INSERT INTO plt_auditoria(org_id,usuario_id,email,acao,detalhe,ip,criado_ms) VALUES(?,?,?,?,?,?,?)")
      .bind(orgId ?? null, sessao?.usuario?.id ?? null, sessao?.usuario?.email ?? null, acao, txt(detalhe, 400), ipDe(request), agora(env)).run();
  } catch (e) { console.error("auditoria", e?.message); }
}

// ---------------------------------------------------------------------------
// Senhas, sessão e cifra dos tokens
// ---------------------------------------------------------------------------

async function hashSenha(senha, saltB64, iter) {
  const salt = saltB64 ? deB64url(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const k = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, k, 256);
  return { hash: b64url(new Uint8Array(bits)), salt: b64url(salt), iter };
}
function senhaForte(s) {
  s = String(s || "");
  if (s.length < 10) return "A senha precisa ter pelo menos 10 caracteres.";
  if (s.length > 200) return "A senha é longa demais.";
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return "Use letras e números na senha.";
  return "";
}
// Chave das sessões: o secret SESSION_SECRET, se existir; senão uma chave aleatória criada
// na primeira vez e guardada no banco da plataforma (assim nada precisa ser configurado).
let segredoCache = "";
async function segredo(env) {
  const s = String(env.SESSION_SECRET || "");
  if (s.length >= 32) return s;
  if (segredoCache) return segredoCache;
  await garantirSchema(env);
  let r = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='segredo'").first();
  if (!r?.valor) {
    const novo = b64url(crypto.getRandomValues(new Uint8Array(48)));
    await env.DB.prepare("INSERT OR IGNORE INTO plt_meta(chave,valor) VALUES('segredo',?)").bind(novo).run();
    r = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='segredo'").first();
  }
  segredoCache = r.valor;
  return segredoCache;
}
function configAdmin(env) {
  const email = normEmail(env.PLATFORM_ADMIN_EMAIL);
  const senha = String(env.PLATFORM_ADMIN_PASSWORD || "");
  return emailValido(email) && senha.length >= 12 ? { email, senha } : null;
}
const SESSAO_LONGA_MS = 30 * 24 * 60 * 60 * 1000;
async function criarCookie(env, usuario, duracao = SESSAO_MS) {
  const dados = b64url(enc.encode(JSON.stringify({ u: usuario.id, sv: usuario.sessao_versao, exp: agora(env) + duracao, v: 2 })));
  return `${dados}.${await hmac(await segredo(env), dados)}`;
}
function cookieSessao(valor, maxAge) { return `${COOKIE}=${valor}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`; }
async function lerSessao(request, env) {
  const chave = await segredo(env);
  const m = String(request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)`));
  if (!m || !iguaisSeguro(m[2], await hmac(chave, m[1]))) return null;
  let s;
  try { s = JSON.parse(new TextDecoder().decode(deB64url(m[1]))); } catch { return null; }
  if (!s || s.v !== 2 || !(Number(s.exp) > agora(env))) return null;
  await garantirSchema(env);
  const u = await env.DB.prepare("SELECT id,email,nome,super_admin,ativo,trocar_senha,sessao_versao,origem,(senha_hash IS NOT NULL) tem_senha FROM plt_usuarios WHERE id=?").bind(Number(s.u)).first();
  if (!u || !u.ativo || u.sessao_versao !== s.sv) return null;
  if (u.super_admin && u.origem === "ENV" && configAdmin(env)?.email !== u.email) return null; // admin geral trocado ou removido da configuração
  return { usuario: { ...u, super_admin: Boolean(u.super_admin), trocar_senha: Boolean(u.trocar_senha), tem_senha: Boolean(u.tem_senha) }, exp: s.exp };
}

async function chaveCifra(env) {
  const base = await crypto.subtle.importKey("raw", enc.encode(await segredo(env)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("denia-platform"), info: enc.encode("token-engine-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function cifrar(env, texto) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await chaveCifra(env), enc.encode(texto));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}
async function decifrar(env, valor) {
  const [v, iv, ct] = String(valor || "").split(".");
  if (v !== "v1" || !iv || !ct) return "";
  try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: deB64url(iv) }, await chaveCifra(env), deB64url(ct))); }
  catch { return ""; }
}

// Proteção contra requisições forjadas: só aceita escrita vinda do próprio site
// e com o cabeçalho X-Denia (que outro site não consegue enviar sem CORS).
function postLegitimo(request) {
  const origem = request.headers.get("origin");
  if (origem && origem !== new URL(request.url).origin) return false;
  return request.headers.get("x-denia") === "1";
}
async function lerCorpo(request, limite = 16000) {
  const texto = await request.text();
  if (texto.length > limite) return { erro: json({ erro: "Conteúdo grande demais." }, 413) };
  try { const c = texto ? JSON.parse(texto) : {}; return { corpo: c && typeof c === "object" && !Array.isArray(c) ? c : {} }; }
  catch { return { erro: json({ erro: "Conteúdo inválido." }, 400) }; }
}

// Bloqueio após tentativas erradas (por IP e por e-mail).
async function bloqueado(env, chaves) {
  for (const k of chaves) {
    const t = await env.DB.prepare("SELECT n, ate FROM plt_tentativas WHERE chave=?").bind(k).first();
    if (t && t.n >= MAX_TENTATIVAS && agora(env) < t.ate) return true;
  }
  return false;
}
async function registrarFalha(env, chaves) {
  const st = chaves.map(k => env.DB.prepare(`INSERT INTO plt_tentativas(chave,n,ate) VALUES(?,1,?)
    ON CONFLICT(chave) DO UPDATE SET n = CASE WHEN plt_tentativas.ate < ? THEN 1 ELSE plt_tentativas.n + 1 END, ate = excluded.ate`).bind(k, agora(env) + BLOQUEIO_MS, agora(env)));
  await env.DB.batch(st);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function entrar(request, env) {
  if (!postLegitimo(request)) return json({ erro: "Requisição não autorizada." }, 403);
  const { corpo, erro } = await lerCorpo(request, 4000);
  if (erro) return erro;
  const email = normEmail(corpo.email), senha = String(corpo.senha || "").slice(0, 200);
  const chaves = ["ip:" + ipDe(request), "email:" + email];
  if (await bloqueado(env, chaves)) return json({ erro: "Muitas tentativas. Aguarde 15 minutos e tente novamente." }, 429);

  let usuario = null;
  const admin = configAdmin(env);
  if (admin && iguaisSeguro(email, admin.email)) {
    if (iguaisSeguro(senha, admin.senha)) {
      usuario = await env.DB.prepare("SELECT * FROM plt_usuarios WHERE email=?").bind(email).first();
      if (!usuario) {
        usuario = await env.DB.prepare("INSERT INTO plt_usuarios(email,nome,super_admin,ativo,origem,criado_ms) VALUES(?,?,1,1,'ENV',?) RETURNING *").bind(email, "Administrador", agora(env)).first();
      } else if (!usuario.super_admin || !usuario.ativo) {
        await env.DB.prepare("UPDATE plt_usuarios SET super_admin=1, ativo=1, trocar_senha=0 WHERE id=?").bind(usuario.id).run();
        usuario = { ...usuario, super_admin: 1, ativo: 1, trocar_senha: 0 };
      }
    }
  } else if (emailValido(email)) {
    const u = await env.DB.prepare("SELECT * FROM plt_usuarios WHERE email=?").bind(email).first();
    if (u && u.ativo && u.senha_hash) {
      const h = await hashSenha(senha, u.senha_salt, u.senha_iter || PBKDF2_ITER);
      if (iguaisSeguro(h.hash, u.senha_hash)) usuario = u;
    } else if (!u) {
      usuario = await loginLegado(env, email, senha);
    }
  }
  if (!usuario) {
    await registrarFalha(env, chaves);
    await auditar(env, request, null, null, "LOGIN_FALHOU", email);
    await espera(env.__semEspera ? 0 : 300);
    return json({ erro: "E-mail ou senha incorretos." }, 401);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plt_tentativas WHERE chave IN (?,?)").bind(...chaves),
    env.DB.prepare("UPDATE plt_usuarios SET ultimo_acesso_ms=? WHERE id=?").bind(agora(env), usuario.id)
  ]);
  await auditar(env, request, { usuario }, null, "LOGIN", "");
  const duracao = corpo.lembrar === true ? SESSAO_LONGA_MS : SESSAO_MS;
  return json({ ok: true, trocar_senha: Boolean(usuario.trocar_senha) }, 200, { "set-cookie": cookieSessao(await criarCookie(env, usuario, duracao), duracao / 1000) });
}

async function criarEmpresa(env, nome, legadoId = null) {
  let sl = slug(nome), n = 1;
  while (await env.DB.prepare("SELECT 1 FROM plt_organizacoes WHERE slug=?").bind(sl).first()) sl = `${slug(nome)}-${++n}`;
  return env.DB.prepare("INSERT INTO plt_organizacoes(nome,slug,cor,status,legado_id,criado_ms) VALUES(?,?,'#4f8cff','ATIVA',?,?) RETURNING id").bind(txt(nome, 120), sl, legadoId, agora(env)).first();
}

// Criar conta: cada pessoa nova ganha a sua própria empresa, ainda sem a IA configurada.
async function cadastrar(request, env) {
  if (String(env.CADASTRO_FECHADO || "") === "1") return json({ erro: "O cadastro está fechado no momento. Fale com a equipe DENIA." }, 403);
  const { corpo, erro } = await lerCorpo(request, 4000);
  if (erro) return erro;
  const nome = txt(corpo.nome, 120), empresa = txt(corpo.empresa, 120), email = normEmail(corpo.email), senha = String(corpo.senha || "");
  if (nome.length < 2 || empresa.length < 2) return json({ erro: "Informe o seu nome e o nome da empresa." }, 400);
  if (!emailValido(email)) return json({ erro: "Informe um e-mail válido." }, 400);
  const fraca = senhaForte(senha);
  if (fraca) return json({ erro: fraca }, 400);
  const chave = "cad:" + ipDe(request);
  const t = await env.DB.prepare("SELECT n, ate FROM plt_tentativas WHERE chave=?").bind(chave).first();
  if (t && t.n >= 5 && agora(env) < t.ate) return json({ erro: "Muitos cadastros a partir desta conexão. Tente novamente mais tarde." }, 429);
  const admin = configAdmin(env);
  const existe = await env.DB.prepare("SELECT 1 FROM plt_usuarios WHERE email=?").bind(email).first()
    || await env.DB.prepare("SELECT 1 FROM users WHERE lower(email)=?").bind(email).first().catch(() => null);
  if (existe || (admin && admin.email === email)) return json({ erro: "Já existe uma conta com este e-mail. Use a opção Entrar." }, 409);
  await env.DB.prepare(`INSERT INTO plt_tentativas(chave,n,ate) VALUES(?,1,?) ON CONFLICT(chave) DO UPDATE SET n = CASE WHEN plt_tentativas.ate < ? THEN 1 ELSE plt_tentativas.n + 1 END, ate = excluded.ate`).bind(chave, agora(env) + 3600000, agora(env)).run();
  const h = await hashSenha(senha, null, PBKDF2_ITER);
  const u = await env.DB.prepare("INSERT INTO plt_usuarios(email,nome,senha_hash,senha_salt,senha_iter,super_admin,ativo,origem,criado_ms) VALUES(?,?,?,?,?,0,1,'CADASTRO',?) RETURNING *").bind(email, nome, h.hash, h.salt, h.iter, agora(env)).first();
  const o = await criarEmpresa(env, empresa);
  await env.DB.prepare("INSERT INTO plt_membros(org_id,usuario_id,papel,criado_ms) VALUES(?,?,'OWNER',?)").bind(o.id, u.id, agora(env)).run();
  await auditar(env, request, { usuario: u }, o.id, "EMPRESA", `Conta criada: ${empresa}`);
  return json({ ok: true }, 200, { "set-cookie": cookieSessao(await criarCookie(env, u), SESSAO_MS / 1000) });
}

// ---------------------------------------------------------------------------
// E-mail (opcional): com RESEND_API_KEY e EMAIL_REMETENTE, a plataforma envia e-mails
// (redefinição de senha e avisos de contato). Sem eles, nada é enviado.
// ---------------------------------------------------------------------------
function emailConfigurado(env) { return Boolean(String(env.RESEND_API_KEY || "").trim() && emailValido(String(env.EMAIL_REMETENTE || "").replace(/^.*<|>$/g, ""))); }
async function enviarEmail(env, para, assunto, texto) {
  if (!emailConfigurado(env)) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`, "content-type": "application/json" },
      body: JSON.stringify({ from: String(env.EMAIL_REMETENTE).trim(), to: [para], subject: assunto, text: texto }), signal: AbortSignal.timeout(15000)
    });
    return r.ok;
  } catch (e) { console.error("e-mail", e?.message); return false; }
}
async function sha256(texto) { return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(texto)))); }
async function limitar(env, chave, max, janelaMs) {
  const t = await env.DB.prepare("SELECT n, ate FROM plt_tentativas WHERE chave=?").bind(chave).first();
  if (t && t.n >= max && agora(env) < t.ate) return false;
  await env.DB.prepare(`INSERT INTO plt_tentativas(chave,n,ate) VALUES(?,1,?) ON CONFLICT(chave) DO UPDATE SET n = CASE WHEN plt_tentativas.ate < ? THEN 1 ELSE plt_tentativas.n + 1 END, ate = excluded.ate`).bind(chave, agora(env) + janelaMs, agora(env)).run();
  return true;
}

// "Esqueceu a senha?": a resposta é sempre a mesma, exista ou não a conta (ninguém descobre e-mails cadastrados).
async function esqueciSenha(request, env) {
  const { corpo, erro } = await lerCorpo(request, 2000);
  if (erro) return erro;
  const email = normEmail(corpo.email);
  if (!emailValido(email)) return json({ erro: "Informe um e-mail válido." }, 400);
  if (!(await limitar(env, "esq:" + ipDe(request), 5, 3600000)) || !(await limitar(env, "esq:" + email, 3, 3600000))) return json({ erro: "Muitos pedidos. Tente novamente em uma hora." }, 429);
  const porEmail = emailConfigurado(env);
  const u = await env.DB.prepare("SELECT id, email, nome, super_admin, senha_hash FROM plt_usuarios WHERE email=? AND ativo=1").bind(email).first();
  if (u && u.senha_hash) {
    if (porEmail) {
      const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
      await env.DB.prepare("INSERT INTO plt_redefinicoes(token_hash,usuario_id,expira_ms,criado_ms) VALUES(?,?,?,?)").bind(await sha256(token), u.id, agora(env) + 30 * 60000, agora(env)).run();
      const link = `${new URL(request.url).origin}/redefinir?t=${token}`;
      await enviarEmail(env, u.email, "DENIA — redefinir a sua senha", `Olá${u.nome ? ", " + u.nome : ""}!\n\nRecebemos um pedido para redefinir a sua senha da DENIA. Para criar uma senha nova, abra o link abaixo (vale por 30 minutos):\n\n${link}\n\nSe não foi você, ignore este e-mail: a sua senha continua a mesma.\n\nEquipe DENIA`);
    }
    const orgs = (await env.DB.prepare("SELECT org_id FROM plt_membros WHERE usuario_id=?").bind(u.id).all())?.results || [];
    for (const o of orgs) await auditar(env, request, { usuario: u }, o.org_id, "SENHA", `Pediu para redefinir a senha (${porEmail ? "link enviado por e-mail" : "envio de e-mail desativado"})`);
  }
  return json({ ok: true, por_email: porEmail });
}
async function redefinirSenha(request, env) {
  const { corpo, erro } = await lerCorpo(request, 2000);
  if (erro) return erro;
  if (!(await limitar(env, "red:" + ipDe(request), 10, 3600000))) return json({ erro: "Muitas tentativas. Tente novamente em uma hora." }, 429);
  const token = String(corpo.token || "");
  const r = token.length >= 20 ? await env.DB.prepare("SELECT * FROM plt_redefinicoes WHERE token_hash=?").bind(await sha256(token)).first() : null;
  if (!r || r.usado || agora(env) > r.expira_ms) return json({ erro: "Este link expirou ou já foi usado. Peça um novo em \"Esqueceu a senha?\"." }, 400);
  const fraca = senhaForte(corpo.nova);
  if (fraca) return json({ erro: fraca }, 400);
  const h = await hashSenha(String(corpo.nova), null, PBKDF2_ITER);
  await env.DB.batch([
    env.DB.prepare("UPDATE plt_usuarios SET senha_hash=?, senha_salt=?, senha_iter=?, trocar_senha=0, sessao_versao=sessao_versao+1 WHERE id=?").bind(h.hash, h.salt, h.iter, r.usuario_id),
    env.DB.prepare("UPDATE plt_redefinicoes SET usado=1 WHERE usuario_id=?").bind(r.usuario_id)
  ]);
  return json({ ok: true });
}

// Formulário de contato do site: fica guardado e aparece para o administrador geral no painel.
async function receberContato(request, env) {
  const { corpo, erro } = await lerCorpo(request, 8000);
  if (erro) return erro;
  if (String(corpo.site || "")) return json({ ok: true }); // campo invisível: robôs preenchem, pessoas não
  const nome = txt(corpo.nome, 120), email = normEmail(corpo.email), mensagem = txt(corpo.mensagem, 3000);
  if (nome.length < 2 || !emailValido(email) || mensagem.length < 5) return json({ erro: "Preencha nome, e-mail e mensagem." }, 400);
  if (!(await limitar(env, "contato:" + ipDe(request), 5, 3600000))) return json({ erro: "Recebemos várias mensagens desta conexão. Tente novamente mais tarde." }, 429);
  const dados = { empresa: txt(corpo.empresa, 120), telefone: txt(corpo.telefone, 40), assunto: txt(corpo.assunto, 80) };
  await env.DB.prepare("INSERT INTO plt_contatos(nome,email,empresa,telefone,assunto,mensagem,ip,criado_ms) VALUES(?,?,?,?,?,?,?,?)").bind(nome, email, dados.empresa, dados.telefone, dados.assunto, mensagem, ipDe(request), agora(env)).run();
  const destino = String(env.CONTATO_EMAIL || "").trim();
  if (emailValido(destino)) await enviarEmail(env, destino, `DENIA — novo contato: ${nome}`, `Nome: ${nome}\nE-mail: ${email}\nEmpresa: ${dados.empresa || "-"}\nTelefone: ${dados.telefone || "-"}\nAssunto: ${dados.assunto || "-"}\n\n${mensagem}`);
  return json({ ok: true });
}

// Contas da versão anterior do site (tabela "users"): o mesmo e-mail e a mesma senha
// continuam valendo. No primeiro acesso, a conta passa para o formato novo.
async function loginLegado(env, email, senha) {
  const tem = await env.DB.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='users'").first().catch(() => null);
  if (!tem) { await hashSenha(senha, null, PBKDF2_ITER); return null; }
  const l = await env.DB.prepare("SELECT * FROM users WHERE lower(email)=?").bind(email).first().catch(() => null);
  if (!l?.password_salt || !l?.password_hash) { await hashSenha(senha, null, PBKDF2_ITER); return null; }
  const k = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(String(l.password_salt).match(/.{1,2}/g) || [], x => parseInt(x, 16));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 30000 }, k, 256);
  const hex = Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, "0")).join("");
  if (!iguaisSeguro(hex, String(l.password_hash).toLowerCase())) return null;
  const papel = String(l.role || "").toUpperCase();
  const h = await hashSenha(senha, null, PBKDF2_ITER);
  const u = await env.DB.prepare("INSERT INTO plt_usuarios(email,nome,senha_hash,senha_salt,senha_iter,super_admin,ativo,origem,criado_ms) VALUES(?,?,?,?,?,?,1,'LEGADO',?) RETURNING *")
    .bind(email, txt(l.name, 120) || null, h.hash, h.salt, h.iter, papel === "SUPER_ADMIN" ? 1 : 0, agora(env)).first();
  if (papel !== "SUPER_ADMIN") {
    // A empresa da conta antiga vira uma empresa própria na plataforma (sem configuração da IA).
    const nomeOrg = (await env.DB.prepare("SELECT name FROM organizations WHERE id=?").bind(l.organization_id).first().catch(() => null))?.name || "Minha empresa";
    // A empresa principal do site antigo é a Central (a primeira); as outras viram empresas próprias.
    let o = String(l.organization_id) === await legadoPrincipal(env) ? { id: await primeiraEmpresa(env) } : null;
    if (!o) o = await env.DB.prepare("SELECT id FROM plt_organizacoes WHERE legado_id=?").bind(String(l.organization_id)).first();
    if (!o) o = await criarEmpresa(env, nomeOrg, String(l.organization_id));
    await env.DB.prepare("INSERT OR IGNORE INTO plt_membros(org_id,usuario_id,papel,criado_ms) VALUES(?,?,?,?)").bind(o.id, u.id, papel === "OWNER" ? "OWNER" : "ADMIN", agora(env)).run();
  }
  return u;
}

// ---------------------------------------------------------------------------
// Empresas, equipe, integração e auditoria
// ---------------------------------------------------------------------------

async function organizacoesDo(env, usuario) {
  const sql = usuario.super_admin
    ? `SELECT o.*, 'OWNER' papel, (SELECT 1 FROM plt_integracoes i WHERE i.org_id=o.id AND i.token_cifrado IS NOT NULL) conectada FROM plt_organizacoes o ORDER BY o.id`
    : `SELECT o.*, m.papel, (SELECT 1 FROM plt_integracoes i WHERE i.org_id=o.id AND i.token_cifrado IS NOT NULL) conectada FROM plt_membros m JOIN plt_organizacoes o ON o.id=m.org_id WHERE m.usuario_id=? AND o.status='ATIVA' ORDER BY o.id`;
  const st = env.DB.prepare(sql);
  const r = await (usuario.super_admin ? st : st.bind(usuario.id)).all();
  const primeira = conexaoCloudflare(env) ? await primeiraEmpresa(env) : 0;
  return (r?.results || []).map(o => ({ id: o.id, nome: o.nome, slug: o.slug, segmento: o.segmento || "", cor: o.cor || "#4f8cff", status: o.status, papel: o.papel, conectada: Boolean(o.conectada) || o.id === primeira }));
}
async function papelNa(env, usuario, orgId) {
  if (usuario.super_admin) {
    const o = await env.DB.prepare("SELECT id FROM plt_organizacoes WHERE id=?").bind(orgId).first();
    return o ? "OWNER" : null;
  }
  const m = await env.DB.prepare("SELECT m.papel FROM plt_membros m JOIN plt_organizacoes o ON o.id=m.org_id WHERE m.org_id=? AND m.usuario_id=? AND o.status='ATIVA'").bind(orgId, usuario.id).first();
  return m?.papel || null;
}
const pode = (papel, minimo) => (NIVEL[papel] || 0) >= NIVEL[minimo];

async function validarEngineUrl(env, valor) {
  const s = txt(valor, 300).replace(/\/+$/, "");
  if (!s) return { url: "" };
  let u;
  try { u = new URL(s); } catch { return { erro: "Endereço inválido. Exemplo: https://denia.seu-usuario.workers.dev" }; }
  const local = u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname) && String(env.PERMITIR_ENGINE_LOCAL || "") === "1";
  if (!(u.protocol === "https:" || local) || u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) {
    return { erro: "Use somente o endereço base do Engine, começando com https:// (sem caminho no final)." };
  }
  return { url: u.origin };
}
// A versão anterior do site guardava a conexão nas variáveis DENIA_ENGINE_URL e
// DENIA_PLATFORM_SERVICE_TOKEN. Elas continuam valendo para a primeira empresa.
function conexaoCloudflare(env) {
  const token = String(env.DENIA_PLATFORM_SERVICE_TOKEN || env.DENIA_ENGINE_SERVICE_TOKEN || "");
  let url = "";
  try {
    const u = new URL(String(env.DENIA_ENGINE_URL || env.DENIA_ENGINE_BASE_URL || "").trim());
    if (u.protocol === "https:" || u.protocol === "http:") url = (u.origin + u.pathname).replace(/\/+$/, "");
  } catch { url = ""; }
  return url && token.trim() ? { url, token: token.trim() } : null;
}
async function primeiraEmpresa(env) {
  return Number((await env.DB.prepare("SELECT MIN(id) id FROM plt_organizacoes").first())?.id || 0);
}
async function conexaoDa(env, orgId) {
  const i = await env.DB.prepare("SELECT * FROM plt_integracoes WHERE org_id=?").bind(orgId).first();
  if (!i?.engine_url || !i?.token_cifrado) {
    const cf = conexaoCloudflare(env);
    return cf && orgId === await primeiraEmpresa(env) ? cf : null;
  }
  const token = await decifrar(env, i.token_cifrado);
  return token.length >= 16 ? { url: i.engine_url, token } : null;
}
async function chamarEngine(con, metodo, caminho, corpo, params) {
  const destino = new URL(`${con.url}/platform/${caminho}`);
  for (const [k, v] of Object.entries(params || {})) destino.searchParams.set(k, v);
  const init = { method: metodo, headers: { authorization: `Bearer ${con.token}`, accept: "application/json" }, signal: AbortSignal.timeout(25000), redirect: "manual" };
  if (metodo === "POST") { init.body = JSON.stringify(corpo || {}); init.headers["content-type"] = "application/json"; }
  const r = await fetch(destino.toString(), init);
  const texto = await r.text();
  let dados;
  try { dados = JSON.parse(texto); } catch { dados = null; }
  return { status: r.status, dados };
}

async function proxyEngine(request, env, sessao, orgId, papel, caminho) {
  const rota = ROTAS_ENGINE.find(([m, re]) => m === request.method && re.test(caminho));
  if (!rota) return json({ erro: "Operação não permitida." }, 404);
  if (!pode(papel, rota[2])) return json({ erro: "Seu perfil não tem permissão para esta ação." }, 403);
  const con = await conexaoDa(env, orgId);
  if (!con) return json({ erro: "A IA desta empresa ainda não foi conectada. Vá em Integrações e informe o endereço e o token da IA.", codigo: "ENGINE_NAO_CONFIGURADO" }, 503);
  let corpo;
  if (request.method === "POST") {
    const lido = await lerCorpo(request, caminho === "import/clients" ? 600000 : 200000);
    if (lido.erro) return lido.erro;
    corpo = lido.corpo;
    const autor = sessao.usuario.nome ? `${sessao.usuario.nome} <${sessao.usuario.email}>` : sessao.usuario.email;
    if (/^(training|learning\/suggestions\/\d+|pause)$/.test(caminho)) corpo.autor = autor;
  }
  const params = {};
  const q = new URL(request.url).searchParams;
  for (const [k, re] of Object.entries(PARAMS_ENGINE)) if (q.get(k) && re.test(q.get(k))) params[k] = q.get(k);
  try {
    const r = await chamarEngine(con, request.method, caminho, corpo, params);
    if (!r.dados) return json({ erro: "A IA respondeu de forma inesperada. Confira o endereço em Integrações.", status: r.status }, 502);
    if (r.status === 401) return json({ erro: "A IA recusou o token. Confira o token em Integrações.", codigo: "ENGINE_TOKEN" }, 502);
    if (rota[3] && r.status < 300) {
      const detalhe = caminho === "import/clients" ? `${r.dados.importadas ?? 0} cliente(s) importado(s)` :
        caminho === "pause" ? (corpo.ativa ? "IA pausada" : "IA retomada") :
          caminho.startsWith("learning/suggestions/") ? `${corpo.acao === "aprovar" ? "Aprovou" : "Rejeitou"} a sugestão #${caminho.split("/").pop()}` :
            caminho === "training" ? `Versão ${r.dados.versao ?? ""}` :
              caminho.startsWith("cases/") ? `Caso #${caminho.split("/")[1]} → ${txt(corpo.etapa, 30)}` :
                caminho.startsWith("conversations/") ? `Conversa #${caminho.split("/")[1]}: ${caminho.split("/")[2]}` : caminho;
      await auditar(env, request, sessao, orgId, rota[3], detalhe);
    }
    return json(r.dados, r.status);
  } catch (e) {
    console.error("Engine:", e?.message || e);
    return json({ erro: "Não foi possível falar com a IA desta empresa agora." }, 502);
  }
}

async function apiOrg(request, env, sessao, orgId, resto) {
  const papel = await papelNa(env, sessao.usuario, orgId);
  if (!papel) return json({ erro: "Empresa não encontrada." }, 404);
  const metodo = request.method;
  if (resto.startsWith("engine/")) return proxyEngine(request, env, sessao, orgId, papel, resto.slice(7));

  if (resto === "membros" && metodo === "GET") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Sem permissão." }, 403);
    const r = await env.DB.prepare(`SELECT u.id, u.email, u.nome, u.ativo, u.trocar_senha, u.ultimo_acesso_ms, m.papel, m.criado_ms FROM plt_membros m JOIN plt_usuarios u ON u.id=m.usuario_id WHERE m.org_id=? ORDER BY m.criado_ms`).bind(orgId).all();
    return json({ membros: (r?.results || []).map(x => ({ ...x, ativo: Boolean(x.ativo), trocar_senha: Boolean(x.trocar_senha) })) });
  }
  if (resto === "membros" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Sem permissão." }, 403);
    const { corpo, erro } = await lerCorpo(request);
    if (erro) return erro;
    const email = normEmail(corpo.email), nome = txt(corpo.nome, 120), novoPapel = String(corpo.papel || "");
    if (!emailValido(email)) return json({ erro: "Informe um e-mail válido." }, 400);
    if (!PAPEIS.includes(novoPapel)) return json({ erro: "Escolha um perfil válido." }, 400);
    if (novoPapel === "OWNER" && papel !== "OWNER") return json({ erro: "Só o proprietário pode adicionar outro proprietário." }, 403);
    const admin = configAdmin(env);
    if (admin && email === admin.email) return json({ erro: "Este e-mail é do administrador geral, que já tem acesso a todas as empresas." }, 400);
    let u = await env.DB.prepare("SELECT * FROM plt_usuarios WHERE email=?").bind(email).first();
    let senha = "";
    if (!u) {
      senha = senhaTemporaria();
      const h = await hashSenha(senha, null, PBKDF2_ITER);
      u = await env.DB.prepare("INSERT INTO plt_usuarios(email,nome,senha_hash,senha_salt,senha_iter,ativo,trocar_senha,criado_ms) VALUES(?,?,?,?,?,1,1,?) RETURNING *").bind(email, nome || null, h.hash, h.salt, h.iter, agora(env)).first();
    }
    const ja = await env.DB.prepare("SELECT 1 FROM plt_membros WHERE org_id=? AND usuario_id=?").bind(orgId, u.id).first();
    if (ja) return json({ erro: "Esta pessoa já faz parte da equipe." }, 409);
    await env.DB.prepare("INSERT INTO plt_membros(org_id,usuario_id,papel,criado_ms) VALUES(?,?,?,?)").bind(orgId, u.id, novoPapel, agora(env)).run();
    await auditar(env, request, sessao, orgId, "EQUIPE", `Adicionou ${email} como ${NOME_PAPEL[novoPapel]}`);
    return json({ ok: true, usuario_id: u.id, senha_temporaria: senha || null });
  }
  let m;
  if ((m = resto.match(/^membros\/(\d{1,12})$/)) && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Sem permissão." }, 403);
    const { corpo, erro } = await lerCorpo(request);
    if (erro) return erro;
    const alvo = await env.DB.prepare("SELECT u.id,u.email,u.super_admin,m.papel FROM plt_membros m JOIN plt_usuarios u ON u.id=m.usuario_id WHERE m.org_id=? AND m.usuario_id=?").bind(orgId, Number(m[1])).first();
    if (!alvo) return json({ erro: "Pessoa não encontrada nesta equipe." }, 404);
    if (alvo.papel === "OWNER" && papel !== "OWNER") return json({ erro: "Só o proprietário pode alterar outro proprietário." }, 403);
    if (alvo.id === sessao.usuario.id && !sessao.usuario.super_admin) return json({ erro: "Você não pode alterar o seu próprio acesso." }, 400);
    const donos = async () => Number((await env.DB.prepare("SELECT COUNT(*) n FROM plt_membros WHERE org_id=? AND papel='OWNER'").bind(orgId).first())?.n || 0);
    if (corpo.acao === "remover") {
      if (alvo.papel === "OWNER" && await donos() <= 1) return json({ erro: "A empresa precisa de pelo menos um proprietário." }, 400);
      await env.DB.prepare("DELETE FROM plt_membros WHERE org_id=? AND usuario_id=?").bind(orgId, alvo.id).run();
      await env.DB.prepare("UPDATE plt_usuarios SET sessao_versao=sessao_versao+1 WHERE id=?").bind(alvo.id).run();
      await auditar(env, request, sessao, orgId, "EQUIPE", `Removeu ${alvo.email}`);
      return json({ ok: true });
    }
    if (corpo.acao === "papel") {
      const novo = String(corpo.papel || "");
      if (!PAPEIS.includes(novo)) return json({ erro: "Perfil inválido." }, 400);
      if (novo === "OWNER" && papel !== "OWNER") return json({ erro: "Só o proprietário pode promover a proprietário." }, 403);
      if (alvo.papel === "OWNER" && novo !== "OWNER" && await donos() <= 1) return json({ erro: "A empresa precisa de pelo menos um proprietário." }, 400);
      await env.DB.prepare("UPDATE plt_membros SET papel=? WHERE org_id=? AND usuario_id=?").bind(novo, orgId, alvo.id).run();
      await auditar(env, request, sessao, orgId, "EQUIPE", `${alvo.email}: ${NOME_PAPEL[alvo.papel]} → ${NOME_PAPEL[novo]}`);
      return json({ ok: true });
    }
    if (corpo.acao === "nova_senha") {
      if (alvo.super_admin) return json({ erro: "A senha do administrador geral é definida na Cloudflare." }, 400);
      const outras = Number((await env.DB.prepare("SELECT COUNT(*) n FROM plt_membros WHERE usuario_id=? AND org_id<>?").bind(alvo.id, orgId).first())?.n || 0);
      if (outras && !sessao.usuario.super_admin) return json({ erro: "Esta pessoa também participa de outra empresa; peça ao administrador geral para gerar uma nova senha." }, 403);
      const senha = senhaTemporaria();
      const h = await hashSenha(senha, null, PBKDF2_ITER);
      await env.DB.prepare("UPDATE plt_usuarios SET senha_hash=?, senha_salt=?, senha_iter=?, trocar_senha=1, sessao_versao=sessao_versao+1 WHERE id=?").bind(h.hash, h.salt, h.iter, alvo.id).run();
      await auditar(env, request, sessao, orgId, "EQUIPE", `Gerou nova senha para ${alvo.email}`);
      return json({ ok: true, senha_temporaria: senha });
    }
    return json({ erro: "Ação inválida." }, 400);
  }

  if (resto === "integracao" && metodo === "GET") {
    const i = await env.DB.prepare("SELECT engine_url, token_cifrado, atualizado_ms, atualizado_por FROM plt_integracoes WHERE org_id=?").bind(orgId).first();
    const cf = !(i?.engine_url && i?.token_cifrado) && orgId === await primeiraEmpresa(env) ? conexaoCloudflare(env) : null;
    if (cf) return json({ engine_url: cf.url, token_configurado: true, origem: "cloudflare", atualizado_ms: null, atualizado_por: null });
    return json({ engine_url: i?.engine_url || "", token_configurado: Boolean(i?.token_cifrado), atualizado_ms: i?.atualizado_ms || null, atualizado_por: pode(papel, "ADMIN") ? i?.atualizado_por || null : null });
  }
  if (resto === "integracao" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Sem permissão." }, 403);
    const { corpo, erro } = await lerCorpo(request);
    if (erro) return erro;
    const v = await validarEngineUrl(env, corpo.engine_url);
    if (v.erro) return json({ erro: v.erro }, 400);
    const token = String(corpo.token || "").trim();
    if (token && (token.length < 16 || token.length > 400)) return json({ erro: "O token precisa ter entre 16 e 400 caracteres (o mesmo DENIA_PLATFORM_SERVICE_TOKEN do Engine)." }, 400);
    const atual = await env.DB.prepare("SELECT token_cifrado FROM plt_integracoes WHERE org_id=?").bind(orgId).first();
    const cifrado = corpo.remover_token ? null : token ? await cifrar(env, token) : atual?.token_cifrado || null;
    await env.DB.prepare("INSERT OR REPLACE INTO plt_integracoes(org_id,engine_url,token_cifrado,atualizado_ms,atualizado_por) VALUES(?,?,?,?,?)").bind(orgId, v.url || null, cifrado, agora(env), sessao.usuario.email).run();
    await auditar(env, request, sessao, orgId, "INTEGRACAO", `Engine: ${v.url || "(sem endereço)"}${token ? " · token atualizado" : ""}${corpo.remover_token ? " · token removido" : ""}`);
    return json({ ok: true });
  }
  if (resto === "integracao/testar" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Sem permissão." }, 403);
    const con = await conexaoDa(env, orgId);
    if (!con) return json({ ok: false, erro: "Informe o endereço e o token e salve antes de testar." }, 400);
    try {
      const r = await chamarEngine(con, "GET", "status");
      if (r.status === 401) return json({ ok: false, erro: "O Engine recusou o token. Confira se é igual ao DENIA_PLATFORM_SERVICE_TOKEN." });
      if (!r.dados) return json({ ok: false, erro: `O endereço respondeu, mas não parece ser o DENIA Engine (HTTP ${r.status}).` });
      return json({ ok: true, versao: r.dados.versao || "", saude: r.dados });
    } catch (e) { return json({ ok: false, erro: "Não consegui acessar o endereço: " + txt(e?.message, 120) }); }
  }
  if (resto === "auditoria" && metodo === "GET") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Sem permissão." }, 403);
    const r = await env.DB.prepare("SELECT id,email,acao,detalhe,ip,criado_ms FROM plt_auditoria WHERE org_id=? ORDER BY id DESC LIMIT 300").bind(orgId).all();
    return json({ eventos: r?.results || [] });
  }
  return json({ erro: "Rota não encontrada." }, 404);
}

async function apiAdminOrgs(request, env, sessao, resto) {
  if (!sessao.usuario.super_admin) return json({ erro: "Sem permissão." }, 403);
  const { corpo, erro } = await lerCorpo(request);
  if (erro) return erro;
  const nome = txt(corpo.nome, 120), segmento = txt(corpo.segmento, 160);
  const cor = /^#[0-9a-f]{6}$/i.test(String(corpo.cor || "")) ? corpo.cor : "#4f8cff";
  if (resto === "") {
    if (nome.length < 2) return json({ erro: "Informe o nome da empresa." }, 400);
    let s = slug(nome), n = 1;
    while (await env.DB.prepare("SELECT 1 FROM plt_organizacoes WHERE slug=?").bind(s).first()) s = `${slug(nome)}-${++n}`;
    const o = await env.DB.prepare("INSERT INTO plt_organizacoes(nome,slug,segmento,cor,status,criado_ms) VALUES(?,?,?,?, 'ATIVA', ?) RETURNING id").bind(nome, s, segmento || null, cor, agora(env)).first();
    await auditar(env, request, sessao, o.id, "EMPRESA", `Criou a empresa ${nome}`);
    return json({ ok: true, id: o.id });
  }
  const id = Number(resto);
  const o = await env.DB.prepare("SELECT * FROM plt_organizacoes WHERE id=?").bind(id).first();
  if (!o) return json({ erro: "Empresa não encontrada." }, 404);
  const status = ["ATIVA", "SUSPENSA"].includes(corpo.status) ? corpo.status : o.status;
  await env.DB.prepare("UPDATE plt_organizacoes SET nome=?, segmento=?, cor=?, status=? WHERE id=?").bind(nome.length >= 2 ? nome : o.nome, corpo.segmento !== undefined ? segmento || null : o.segmento, corpo.cor ? cor : o.cor, status, id).run();
  await auditar(env, request, sessao, id, "EMPRESA", `Atualizou a empresa${status !== o.status ? ` (${status === "ATIVA" ? "reativada" : "suspensa"})` : ""}`);
  return json({ ok: true });
}

async function api(request, env, caminho) {
  const metodo = request.method;
  if (caminho === "/api/publico" && metodo === "GET") {
    const whatsapp = String(env.CONTATO_WHATSAPP || "").replace(/\D/g, "");
    const email = String(env.CONTATO_EMAIL || "").trim();
    return json({ whatsapp: whatsapp.length >= 10 ? whatsapp : "", email: emailValido(email) ? email : "", versao: VERSAO });
  }
  if (metodo !== "GET" && !postLegitimo(request)) return json({ erro: "Requisição não autorizada." }, 403);
  if (!["GET", "POST"].includes(metodo)) return json({ erro: "Método não permitido." }, 405);
  try { await garantirSchema(env); }
  catch (e) {
    console.error("D1:", e?.message);
    return json({ erro: e?.codigo === "SEM_BANCO" ? "A plataforma ainda não foi configurada: falta o banco D1 (binding DB)." : "O banco de dados da plataforma está indisponível. Tente novamente em instantes.", codigo: "SEM_BANCO" }, 503);
  }
  if (caminho === "/api/entrar" && metodo === "POST") return entrar(request, env);
  if (caminho === "/api/cadastro" && metodo === "POST") return cadastrar(request, env);
  if (caminho === "/api/senha/esqueci" && metodo === "POST") return esqueciSenha(request, env);
  if (caminho === "/api/senha/redefinir" && metodo === "POST") return redefinirSenha(request, env);
  if (caminho === "/api/contato" && metodo === "POST") return receberContato(request, env);
  if (caminho === "/api/sair" && metodo === "POST") return json({ ok: true }, 200, { "set-cookie": cookieSessao("", 0) });

  const sessao = await lerSessao(request, env);
  if (!sessao) return json({ erro: "Sua sessão expirou. Entre novamente." }, 401);
  const u = sessao.usuario;

  if (caminho === "/api/eu" && metodo === "GET") {
    return json({ usuario: { id: u.id, email: u.email, nome: u.nome || "", super_admin: u.super_admin, trocar_senha: u.trocar_senha, tem_senha: u.tem_senha }, organizacoes: await organizacoesDo(env, u), sessao_expira_ms: sessao.exp, versao: VERSAO, papeis: NOME_PAPEL });
  }
  if (caminho === "/api/conta" && metodo === "POST") {
    const { corpo, erro } = await lerCorpo(request);
    if (erro) return erro;
    if (corpo.acao === "perfil") {
      await env.DB.prepare("UPDATE plt_usuarios SET nome=? WHERE id=?").bind(txt(corpo.nome, 120) || null, u.id).run();
      return json({ ok: true });
    }
    if (corpo.acao === "senha") {
      if (!u.tem_senha) return json({ erro: "A senha do administrador geral é o secret PLATFORM_ADMIN_PASSWORD, na Cloudflare." }, 400);
      const atual = await env.DB.prepare("SELECT senha_hash, senha_salt, senha_iter FROM plt_usuarios WHERE id=?").bind(u.id).first();
      const h = await hashSenha(String(corpo.atual || "").slice(0, 200), atual.senha_salt, atual.senha_iter || PBKDF2_ITER);
      if (!iguaisSeguro(h.hash, atual.senha_hash)) return json({ erro: "A senha atual não confere." }, 400);
      const fraca = senhaForte(corpo.nova);
      if (fraca) return json({ erro: fraca }, 400);
      if (String(corpo.nova) === String(corpo.atual)) return json({ erro: "A nova senha precisa ser diferente da atual." }, 400);
      const n = await hashSenha(String(corpo.nova), null, PBKDF2_ITER);
      const novo = await env.DB.prepare("UPDATE plt_usuarios SET senha_hash=?, senha_salt=?, senha_iter=?, trocar_senha=0, sessao_versao=sessao_versao+1 WHERE id=? RETURNING id, sessao_versao").bind(n.hash, n.salt, n.iter, u.id).first();
      await auditar(env, request, sessao, null, "SENHA", "Trocou a própria senha");
      return json({ ok: true }, 200, { "set-cookie": cookieSessao(await criarCookie(env, novo), SESSAO_MS / 1000) });
    }
    if (corpo.acao === "sair_de_todos") {
      await env.DB.prepare("UPDATE plt_usuarios SET sessao_versao=sessao_versao+1 WHERE id=?").bind(u.id).run();
      return json({ ok: true }, 200, { "set-cookie": cookieSessao("", 0) });
    }
    return json({ erro: "Ação inválida." }, 400);
  }
  // Enquanto a senha temporária não for trocada, nada além da conta funciona.
  if (u.trocar_senha) return json({ erro: "Troque a senha temporária para continuar.", codigo: "TROCAR_SENHA" }, 403);

  let m;
  if (caminho === "/api/admin/contatos" && metodo === "GET") {
    if (!u.super_admin) return json({ erro: "Sem permissão." }, 403);
    const r = await env.DB.prepare("SELECT * FROM plt_contatos ORDER BY id DESC LIMIT 300").all();
    await env.DB.prepare("UPDATE plt_contatos SET lido=1 WHERE lido=0").run();
    return json({ contatos: r?.results || [] });
  }
  if ((m = caminho.match(/^\/api\/admin\/organizacoes(?:\/(\d{1,12}))?$/)) && metodo === "POST") return apiAdminOrgs(request, env, sessao, m[1] || "");
  if ((m = caminho.match(/^\/api\/orgs\/(\d{1,12})\/(.+)$/))) return apiOrg(request, env, sessao, Number(m[1]), m[2]);
  return json({ erro: "Rota não encontrada." }, 404);
}

// ---------------------------------------------------------------------------
// Roteamento e cabeçalhos de segurança
// ---------------------------------------------------------------------------

// Endereços da versão anterior do site levam às páginas novas.
const ANTIGOS = {
  "/login": "/entrar", "/login-en": "/entrar", "/login-es": "/entrar",
  "/cadastro-en": "/cadastro", "/cadastro-es": "/cadastro", "/criar-conta": "/cadastro",
  "/index": "/", "/index-en": "/", "/index-es": "/", "/app-en": "/app", "/app-es": "/app"
};
async function rotear(request, env) {
  const url = new URL(request.url);
  const caminho = url.pathname;
  if (caminho.startsWith("/api/")) return api(request, env, caminho);
  if (!["GET", "HEAD"].includes(request.method)) return new Response("Método não permitido.", { status: 405 });

  const antigo = ANTIGOS[caminho.replace(/\.html$/, "")];
  if (antigo) return redirecionar(antigo);
  const ehPainel = caminho === "/app" || caminho === "/app.html" || caminho.startsWith("/app/");
  const sessao = ehPainel || caminho === "/entrar" || caminho === "/entrar.html" || caminho === "/cadastro" ? await lerSessao(request, env).catch(() => null) : null;
  if (ehPainel) {
    if (!sessao) return redirecionar("/entrar");
    return env.ASSETS.fetch(new Request(new URL("/app", url).toString(), { headers: request.headers }));
  }
  if ((caminho === "/entrar" || caminho === "/entrar.html" || caminho === "/cadastro") && sessao) return redirecionar("/app");
  return env.ASSETS.fetch(request);
}

function comSeguranca(resposta, request) {
  const h = new Headers(resposta.headers);
  h.set("content-security-policy", [
    "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
    "manifest-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"
  ].join("; "));
  h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  h.set("cross-origin-opener-policy", "same-origin");
  const caminho = new URL(request.url).pathname;
  if (caminho.startsWith("/api/") || caminho.startsWith("/app") || caminho.startsWith("/entrar") || caminho.startsWith("/cadastro") || caminho.startsWith("/recuperar") || caminho.startsWith("/redefinir")) h.set("cache-control", "no-store");
  return new Response(resposta.body, { status: resposta.status, statusText: resposta.statusText, headers: h });
}

export default {
  async fetch(request, env) {
    try { return comSeguranca(await rotear(request, env), request); }
    catch (e) {
      console.error("Erro não tratado:", e?.stack || e);
      return comSeguranca(json({ erro: "Erro interno. Tente novamente." }, 500), request);
    }
  }
};
