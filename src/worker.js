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

import { apiMarketing, apiAssistente, analisarAvaliacoesPendentes, relatoriosDaSemana, medirPosicoesDaSemana } from "./marketing.js";
import { retornoMeta, servirMidiaPublica, publicarPendentes } from "./meta.js";
import { retornoGoogle, sincronizarGooglePendentes, vigiarPerfis, enviarRelatoriosPdf } from "./google.js";
import { comOrgUso, comRecurso, descarregarUso } from "./uso.js";
import { DDL_TEMPORADA, ALTERS_TEMPORADA, rotasTemporada, icalPublico, webhookChannex, sincronizarTemporada, desligarInadimplentes, lembrarEstoque, limpezaPublica, avaliacoesDoCron } from "./temporada.js";
import { openaiBruto } from "./marketing.js";
import { DDL_PROBLEMAS, rotasProblemas, registrarProblema, resolverProblema, limparProblemas } from "./problemas.js";
import { DDL_ZAP, webhookZap, rotasZap, webhookTelegram, segredoTelegram, tokenTelegramPlataforma, processarCampanhas, lembrarAgenda, brutoRelatorioZap, avisarTelegramDaEmpresa } from "./zap.js";
import { montarRelatorio, planilhaRelatorio, textoRelatorio, base64, ultimos7Dias, lerConfigRelatorio, horaDeEnviar, diaBR, dataBR, DIAS_SEMANA, inicioDoDia as inicioDoDiaBR } from "./relatorio.js";
import { lerPlanos, acessoDa, recursoDaRota, planoMinimo, rotasPlano, webhookAsaas, lembretesDePlano, TESTE_DIAS, STATUS as STATUS_PLANO, PLANOS_PADRAO, RECURSOS } from "./planos.js";

const VERSAO = "3.23.3";
// Versão dos Termos de uso e da Política de privacidade aceitas no cadastro.
const VERSAO_TERMOS = "2026-10-16";
// WhatsApp da Central de Atendimento (botão flutuante do site).
const WHATSAPP_CENTRAL = "5521975469162";
const SCHEMA = "2.15.0";
const COOKIE = "__Host-denia_sessao";
const SESSAO_MS = 8 * 60 * 60 * 1000;
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MS = 15 * 60 * 1000;
// PBKDF2: o número fica gravado com cada senha, então pode subir no futuro sem
// invalidar as senhas antigas. 20 mil cabe no limite de CPU do plano gratuito.
const PBKDF2_ITER = 20000;
const PAPEIS = ["OWNER", "ADMIN", "AGENTE", "VISUALIZADOR", "REVISOR"];
const NIVEL = { VISUALIZADOR: 1, AGENTE: 2, ADMIN: 3, OWNER: 4 };
const NOME_PAPEL = { OWNER: "Proprietário", ADMIN: "Administrador", AGENTE: "Atendente", VISUALIZADOR: "Somente leitura", REVISOR: "Revisor de aprendizados" };

// Operações do Engine liberadas, com o papel mínimo de cada uma.
const ROTAS_ENGINE = [
  ["GET", /^status$/, "VISUALIZADOR"],
  ["GET", /^usage$/, "ADMIN"],
  ["GET", /^metrics$/, "VISUALIZADOR"],
  ["GET", /^conversations$/, "VISUALIZADOR"],
  ["GET", /^clients$/, "VISUALIZADOR"],
  ["GET", /^conversations\/\d{1,12}$/, "VISUALIZADOR"],
  ["POST", /^conversations\/\d{1,12}\/(send|takeover|release)$/, "AGENTE", "CONVERSA"],
  ["POST", /^conversations\/\d{1,12}\/type$/, "AGENTE", "CONVERSA"],
  ["POST", /^conversations\/\d{1,12}\/note$/, "AGENTE", "CONVERSA"],
  ["POST", /^clients\/match$/, "AGENTE"],
  ["GET", /^cases$/, "VISUALIZADOR"],
  ["POST", /^cases\/\d{1,12}\/status$/, "AGENTE", "ATENDIMENTO"],
  ["POST", /^cases\/\d{1,12}\/review$/, "AGENTE", "ATENDIMENTO"],
  ["GET", /^professionals$/, "VISUALIZADOR"],
  ["POST", /^professionals$/, "ADMIN", "PROFISSIONAIS"],
  ["POST", /^professionals\/[\w-]{1,40}\/delete$/, "ADMIN", "PROFISSIONAIS"],
  ["GET", /^training$/, "VISUALIZADOR"],
  ["POST", /^training$/, "ADMIN", "TREINAMENTO"],
  ["GET", /^training\/versions$/, "VISUALIZADOR"],
  ["POST", /^training\/restore$/, "ADMIN", "TREINAMENTO"],
  ["GET", /^learning$/, "VISUALIZADOR"],
  ["POST", /^learning\/start$/, "ADMIN", "APRENDIZADO"],
  ["GET", /^learning\/suggestions$/, "VISUALIZADOR"],
  ["GET", /^study$/, "VISUALIZADOR"],
  ["POST", /^study\/run$/, "ADMIN", "APRENDIZADO"],
  ["POST", /^learning\/suggestions\/\d{1,12}$/, "ADMIN", "APRENDIZADO"],
  ["GET", /^import\/clients$/, "VISUALIZADOR"],
  ["POST", /^import\/clients$/, "ADMIN", "IMPORTACAO"],
  ["POST", /^pause$/, "ADMIN", "PAUSA_GERAL"],
  ["GET", /^telegram$/, "ADMIN"],
  ["POST", /^telegram\/connect$/, "ADMIN", "TELEGRAM"],
  // Guia de lojas (motor em MODO=guia, ex.: shopping)
  ["GET", /^guide$/, "VISUALIZADOR"],
  ["GET", /^guide\/stats$/, "VISUALIZADOR"],
  ["POST", /^guide\/test$/, "AGENTE"],
  ["POST", /^guide\/(config|categories|stores|import)$/, "AGENTE", "GUIA"],
  ["POST", /^guide\/(categories|stores)\/\d{1,12}\/delete$/, "AGENTE", "GUIA"]
];
const PARAMS_ENGINE = { limit: /^\d{1,3}$/, status: /^(PENDENTE|APROVADA|REJEITADA)$/, completo: /^1$/, de: /^\d{4}-\d{2}-\d{2}$/, ate: /^\d{4}-\d{2}-\d{2}$/ };

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
function origemPublica(env, request) {
  const site = String(env.SITE_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^/\s]+$/.test(site) ? site : new URL(request.url).origin;
}
function paraEnderecoOficial(request, env) {
  const site = String(env.SITE_URL || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+$/.test(site) || String(env.DENIA_SEM_REDIRECIONAR || "") === "1" || request.method !== "GET") return null;
  const u = new URL(request.url), oficial = new URL(site);
  if (u.host.toLowerCase() === oficial.host.toLowerCase() || /^(localhost|127\.)/.test(u.hostname)) return null;
  const pagina = /^\/(app|entrar|cadastro|recuperar|redefinir|manifest\.webmanifest)?$/.test(u.pathname) || u.pathname.startsWith("/app/");
  return pagina ? new Response(null, { status: 301, headers: { location: oficial.origin + u.pathname + u.search, "cache-control": "no-store" } }) : null;
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
  `CREATE TABLE IF NOT EXISTS plt_contatos (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, email TEXT, empresa TEXT, telefone TEXT, assunto TEXT, mensagem TEXT, ip TEXT, lido INTEGER NOT NULL DEFAULT 0, criado_ms INTEGER NOT NULL)`,
  ...DDL_ZAP,
  ...DDL_PROBLEMAS,
  ...DDL_TEMPORADA,
  `CREATE TABLE IF NOT EXISTS plt_pagamentos (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL, gateway_id TEXT UNIQUE, valor REAL, status TEXT, vencimento TEXT, pago_ms INTEGER, link TEXT, forma TEXT, criado_ms INTEGER)`
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
// Erros do banco (D1) explicados em português: limite diário do plano gratuito, banco cheio ou fora do ar.
function erroDoBanco(e) {
  const m = String(e?.message || e || "");
  if (/row.?read|rows? read|daily.*limit|exceeded.*limit|free.?tier/i.test(m)) return { codigo: "D1_LIMITE_LEITURA", erro: "O banco de dados atingiu o limite diário do plano gratuito da Cloudflare. Ele libera sozinho às 21h (horário de Brasília). Para nunca mais acontecer: Cloudflare → Workers → Planos → Workers Paid (US$ 5/mês)." };
  if (/SQLITE_FULL|database or disk is full|storage|size limit|too large|exceeds.*size/i.test(m)) return { codigo: "D1_CHEIO", erro: "O banco de dados está cheio (limite de espaço do plano gratuito da Cloudflare). Assine o Workers Paid (US$ 5/mês) para ter 5 GB, ou fale com a equipe DENIA para liberar espaço." };
  if (/D1_|SQLITE|database/i.test(m)) return { codigo: "D1_FORA", erro: "O banco de dados da plataforma está indisponível agora. Tente de novo em instantes." };
  return null;
}
async function garantirSchema(env) {
  if (schemaPronto) return;
  if (!env.DB) throw Object.assign(new Error("D1 ausente"), { codigo: "SEM_BANCO" });
  const v = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='schema'").first().catch(() => null);
  if (v?.valor !== SCHEMA) {
    await env.DB.batch(DDL.map(s => env.DB.prepare(s)));
    await env.DB.prepare("ALTER TABLE plt_organizacoes ADD COLUMN legado_id TEXT").run().catch(() => { }); // já existe
    await env.DB.prepare("ALTER TABLE plt_organizacoes ADD COLUMN plano TEXT").run().catch(() => { });
    await env.DB.prepare("ALTER TABLE plt_organizacoes ADD COLUMN plano_status TEXT").run().catch(() => { });
    await env.DB.prepare("ALTER TABLE plt_zap_itens ADD COLUMN exibicao TEXT").run().catch(() => { });
    await env.DB.prepare("ALTER TABLE plt_zap_itens ADD COLUMN extra TEXT").run().catch(() => { });
    await env.DB.prepare("ALTER TABLE plt_zap_catalogo ADD COLUMN link TEXT").run().catch(() => { });
    // E-mail ainda não comprovado (contas do cadastro aberto). NULL = contas antigas ou criadas pela equipe.
    await env.DB.prepare("ALTER TABLE plt_usuarios ADD COLUMN email_confirmado INTEGER").run().catch(() => { });
    await env.DB.prepare("ALTER TABLE plt_zap_cat_itens ADD COLUMN ordem INTEGER").run().catch(() => { });
    await env.DB.prepare("ALTER TABLE plt_zap_contas ADD COLUMN telegram_chat TEXT").run().catch(() => { });
    await env.DB.prepare("ALTER TABLE plt_zap_contatos ADD COLUMN memoria TEXT").run().catch(() => { });
    await env.DB.prepare("ALTER TABLE plt_zap_contas ADD COLUMN telegram_nome TEXT").run().catch(() => { });
    await env.DB.prepare("ALTER TABLE plt_zap_contatos ADD COLUMN ultimo_menu INTEGER").run().catch(() => { });
    for (const a of ALTERS_TEMPORADA) await env.DB.prepare(a).run().catch(() => { });
    for (const col of ["optout INTEGER NOT NULL DEFAULT 0", "etiquetas TEXT"]) await env.DB.prepare("ALTER TABLE plt_zap_contatos ADD COLUMN " + col).run().catch(() => { });
    for (const col of ["teste_ate INTEGER", "pago_ate INTEGER", "ciclo TEXT", "cobranca_cliente TEXT", "assinatura_id TEXT", "assinatura_plano TEXT"])
      await env.DB.prepare("ALTER TABLE plt_organizacoes ADD COLUMN " + col).run().catch(() => { });
    // A primeira empresa da plataforma.
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM plt_organizacoes").first();
    if (!Number(n?.n)) {
      await env.DB.prepare("INSERT INTO plt_organizacoes(nome,slug,segmento,cor,status,criado_ms) VALUES(?,?,?,?, 'ATIVA', ?)")
        .bind("Central de Atendimento", "central-de-atendimento", "Serviços residenciais e assistência técnica", "#4f8cff", agora(env)).run();
    }
    await reconciliarContasLegadas(env).catch(e => console.error("contas antigas", e?.message));
    // Planos: a primeira empresa (Central) é cortesia; as que já existiam ganham 7 dias de teste a partir de agora.
    const primeiraId = Number((await env.DB.prepare("SELECT MIN(id) id FROM plt_organizacoes").first())?.id || 0);
    await env.DB.prepare("UPDATE plt_organizacoes SET plano_status='CORTESIA', plano=COALESCE(plano,'elite') WHERE id=? AND (plano_status IS NULL OR plano_status='ATIVO' AND pago_ate IS NULL)").bind(primeiraId).run();
    await env.DB.prepare("UPDATE plt_organizacoes SET teste_ate=? WHERE teste_ate IS NULL").bind(agora(env) + TESTE_DIAS * 86400000).run();
    await env.DB.prepare("UPDATE plt_organizacoes SET plano_status='TESTE' WHERE plano_status IS NULL").run();
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
const SESSAO_LONGA_MS = 90 * 24 * 60 * 60 * 1000; // "manter conectado" e o aplicativo na tela inicial
async function criarCookie(env, usuario, duracao = SESSAO_MS) {
  const dados = b64url(enc.encode(JSON.stringify({ u: usuario.id, sv: usuario.sessao_versao, exp: agora(env) + duracao, v: 2, ...(duracao >= SESSAO_LONGA_MS ? { l: 1 } : {}) })));
  return `${dados}.${await hmac(await segredo(env), dados)}`;
}
function cookieSessao(valor, maxAge) { return `${COOKIE}=${valor}; Path=/; HttpOnly; Secure; SameSite=Strict${maxAge === null ? "" : `; Max-Age=${maxAge}`}`; }
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
  return { usuario: { ...u, super_admin: Boolean(u.super_admin), trocar_senha: Boolean(u.trocar_senha), tem_senha: Boolean(u.tem_senha) }, exp: s.exp, longa: s.l === 1 };
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
  // Mesmo site: compara só o domínio (com ou sem www; http ou https atrás do proxy da hospedagem).
  const origem = request.headers.get("origin");
  const dominio = u => { try { return new URL(u).host.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
  if (origem && dominio(origem) !== dominio(request.url)) return false;
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
  return json({ ok: true, trocar_senha: Boolean(usuario.trocar_senha) }, 200, { "set-cookie": cookieSessao(await criarCookie(env, usuario, duracao), corpo.lembrar === true ? duracao / 1000 : null) });
}

async function criarEmpresa(env, nome, legadoId = null) {
  let sl = slug(nome), n = 1;
  while (await env.DB.prepare("SELECT 1 FROM plt_organizacoes WHERE slug=?").bind(sl).first()) sl = `${slug(nome)}-${++n}`;
  return env.DB.prepare("INSERT INTO plt_organizacoes(nome,slug,cor,status,legado_id,criado_ms,plano_status,teste_ate) VALUES(?,?,'#4f8cff','ATIVA',?,?,'TESTE',?) RETURNING id").bind(txt(nome, 120), sl, legadoId, agora(env), agora(env) + TESTE_DIAS * 86400000).first();
}

// Criar conta: cada pessoa nova ganha a sua própria empresa, ainda sem a IA configurada.
async function cadastrar(request, env) {
  if (String(env.CADASTRO_FECHADO || "") === "1") return json({ erro: "O cadastro está fechado no momento. Fale com a equipe DENIA." }, 403);
  const { corpo, erro } = await lerCorpo(request, 4000);
  if (erro) return erro;
  const nome = txt(corpo.nome, 120), empresa = txt(corpo.empresa, 120), email = normEmail(corpo.email), senha = String(corpo.senha || "");
  if (nome.length < 2 || empresa.length < 2) return json({ erro: "Informe o seu nome e o nome da empresa." }, 400);
  if (!emailValido(email)) return json({ erro: "Informe um e-mail válido." }, 400);
  if (corpo.aceite !== true) return json({ erro: "Para criar a conta, aceite os Termos de uso e a Política de privacidade." }, 400);
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
  const u = await env.DB.prepare("INSERT INTO plt_usuarios(email,nome,senha_hash,senha_salt,senha_iter,super_admin,ativo,origem,email_confirmado,criado_ms) VALUES(?,?,?,?,?,0,1,'CADASTRO',0,?) RETURNING *").bind(email, nome, h.hash, h.salt, h.iter, agora(env)).first();
  const o = await criarEmpresa(env, empresa);
  const plano = PLANOS_PADRAO[String(corpo.plano || "")] ? String(corpo.plano) : "start";
  await env.DB.prepare("UPDATE plt_organizacoes SET plano=?, plano_status='TESTE' WHERE id=?").bind(plano, o.id).run();
  await env.DB.prepare("INSERT INTO plt_membros(org_id,usuario_id,papel,criado_ms) VALUES(?,?,'OWNER',?)").bind(o.id, u.id, agora(env)).run();
  await auditar(env, request, { usuario: u }, o.id, "EMPRESA", `Conta criada: ${empresa}`);
  // Prova do aceite: versão dos documentos, data, IP (registrado pela auditoria) e idioma da página.
  await auditar(env, request, { usuario: u }, o.id, "ACEITE", `Aceitou os Termos de uso ${VERSAO_TERMOS}, a Política de privacidade ${VERSAO_TERMOS} e o Contrato de tratamento de dados ${VERSAO_TERMOS} (idioma ${txt(corpo.idioma, 10) || "pt-BR"}; navegador ${txt(request.headers.get("user-agent"), 160)})`);
  return json({ ok: true }, 200, { "set-cookie": cookieSessao(await criarCookie(env, u), SESSAO_MS / 1000) });
}

// ---------------------------------------------------------------------------
// E-mail (opcional): com RESEND_API_KEY e EMAIL_REMETENTE, a plataforma envia e-mails
// (redefinição de senha e avisos de contato). Sem eles, nada é enviado.
// ---------------------------------------------------------------------------
function emailConfigurado(env) { return Boolean(String(env.RESEND_API_KEY || "").trim() && emailValido(String(env.EMAIL_REMETENTE || "").replace(/^.*<|>$/g, ""))); }
async function enviarEmail(env, para, assunto, texto, anexos = []) {
  if (!emailConfigurado(env)) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`, "content-type": "application/json" },
      body: JSON.stringify({ from: String(env.EMAIL_REMETENTE).trim(), to: [para], subject: assunto, text: texto, ...(anexos.length ? { attachments: anexos.map(a => ({ filename: a.nome, content: a.base64 })) } : {}) }), signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) {
      const motivo = String((await r.json().catch(() => ({})))?.message || `HTTP ${r.status}`).slice(0, 240);
      await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES('email_erro',?)").bind(JSON.stringify({ em: agora(env), motivo })).run().catch(() => {});
    } else await env.DB.prepare("DELETE FROM plt_meta WHERE chave='email_erro'").run().catch(() => {});
    return r.ok;
  } catch (e) { console.error("e-mail", e?.message); return false; }
}
async function situacaoEmail(env) {
  if (!emailConfigurado(env)) return { ok: false, motivo: `faltam as variáveis ${[!String(env.RESEND_API_KEY || "").trim() ? "RESEND_API_KEY" : "", !emailValido(String(env.EMAIL_REMETENTE || "").replace(/^.*<|>$/g, "")) ? "EMAIL_REMETENTE" : ""].filter(Boolean).join(" e ")} na Hostinger` };
  let e = null; try { e = JSON.parse((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='email_erro'").first())?.valor || "null"); } catch { e = null; }
  return e ? { ok: false, motivo: `o Resend recusou o último envio: ${e.motivo}` } : { ok: true };
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
      // Endereço fixo da plataforma (SITE_URL) quando existir: o link nunca depende de cabeçalhos do pedido.
      const link = `${origemPublica(env, request)}/redefinir?t=${token}`;
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
    env.DB.prepare("UPDATE plt_usuarios SET senha_hash=?, senha_salt=?, senha_iter=?, trocar_senha=0, email_confirmado=1, sessao_versao=sessao_versao+1 WHERE id=?").bind(h.hash, h.salt, h.iter, r.usuario_id),
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
    ? `SELECT o.*, 'OWNER' papel, (SELECT 1 FROM plt_integracoes i WHERE i.org_id=o.id AND i.token_cifrado IS NOT NULL) conectada, (SELECT 1 FROM plt_zap_contas z WHERE z.org_id=o.id AND (z.phone_number_id IS NOT NULL OR z.config IS NOT NULL)) chatbot FROM plt_organizacoes o ORDER BY o.id`
    : `SELECT o.*, m.papel, (SELECT 1 FROM plt_integracoes i WHERE i.org_id=o.id AND i.token_cifrado IS NOT NULL) conectada, (SELECT 1 FROM plt_zap_contas z WHERE z.org_id=o.id AND (z.phone_number_id IS NOT NULL OR z.config IS NOT NULL)) chatbot FROM plt_membros m JOIN plt_organizacoes o ON o.id=m.org_id WHERE m.usuario_id=? AND o.status='ATIVA' ORDER BY o.id`;
  const st = env.DB.prepare(sql);
  const r = await (usuario.super_admin ? st : st.bind(usuario.id)).all();
  const primeira = conexaoCloudflare(env) || (env.ENGINE && typeof env.ENGINE.fetch === "function") ? await primeiraEmpresa(env) : 0;
  const { planos } = await lerPlanos(env);
  return (r?.results || []).map(o => ({ acesso: acessoDa(o, agora(env), planos), id: o.id, nome: o.nome, slug: o.slug, segmento: o.segmento || "", cor: o.cor || "#4f8cff", status: o.status, papel: o.papel, conectada: Boolean(o.conectada) || o.id === primeira, chatbot: Boolean(o.chatbot), plano: o.plano || (o.id === primeira ? "elite" : "start"), plano_status: o.plano_status || "TESTE" }));
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
  try { u = new URL(s); } catch { return { erro: "Endereço inválido. Exemplo: https://ia.suaempresa.com.br" }; }
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
  // Ligação direta com o Worker "denia" (service binding ENGINE): não passa pela internet e
  // não sofre o bloqueio da Cloudflare a chamadas entre Workers da mesma conta (erro 1042).
  if (env.ENGINE && typeof env.ENGINE.fetch === "function" && token.trim()) return { url: "https://denia-engine.interno", token: token.trim(), binding: env.ENGINE };
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
  // Na Central (primeira empresa), a ligação direta com o Worker "denia" sempre tem prioridade.
  // O token pode vir da plataforma (Integrações) ou do secret DENIA_PLATFORM_SERVICE_TOKEN.
  if (env.ENGINE && typeof env.ENGINE.fetch === "function" && orgId === await primeiraEmpresa(env)) {
    const salvo = i?.token_cifrado ? await decifrar(env, i.token_cifrado) : "";
    const doServidor = String(env.DENIA_PLATFORM_SERVICE_TOKEN || env.DENIA_ENGINE_SERVICE_TOKEN || "").trim();
    // No servidor próprio (Hostinger) a IA roda junto e usa o mesmo token: um token antigo salvo em Integrações não atrapalha.
    const token = (env.DENIA_IA_LOCAL === "1" && doServidor ? doServidor : salvo || doServidor).trim();
    return { url: "https://denia-engine.interno", token, binding: env.ENGINE, origemToken: salvo ? "plataforma" : token ? "cloudflare" : "" };
  }
  if (!i?.engine_url || !i?.token_cifrado) {
    const cf = conexaoCloudflare(env);
    return cf && orgId === await primeiraEmpresa(env) ? cf : null;
  }
  const token = await decifrar(env, i.token_cifrado);
  return token.length >= 16 ? { url: i.engine_url, token } : null;
}
function explicarFalha(r) {
  const t = String(r.trecho || "");
  if (/1042/.test(t)) return "A Cloudflare bloqueou a chamada entre os dois Workers (erro 1042). A ligação direta com o Worker \"denia\" resolve isso.";
  if (r.status === 404) return `A IA não reconheceu o pedido (HTTP 404). Confira se o código mais recente da DENIA está no Worker "denia". ${t ? "Resposta: " + t : ""}`.trim();
  if (r.status >= 300 && r.status < 400) return `O endereço da IA redirecionou (HTTP ${r.status}). Use o endereço https:// do Worker "denia".`;
  return `A IA respondeu de forma inesperada (HTTP ${r.status}).${t ? " Resposta: " + t : ""}`;
}
async function chamarEngine(con, metodo, caminho, corpo, params) {
  const destino = new URL(`${con.url}/platform/${caminho}`);
  for (const [k, v] of Object.entries(params || {})) destino.searchParams.set(k, v);
  const init = { method: metodo, headers: { authorization: `Bearer ${con.token}`, accept: "application/json" }, signal: AbortSignal.timeout(25000), redirect: "manual" };
  if (metodo === "POST") { init.body = JSON.stringify(corpo || {}); init.headers["content-type"] = "application/json"; }
  const r = con.binding ? await con.binding.fetch(new Request(destino.toString(), init)) : await fetch(destino.toString(), init);
  const texto = await r.text();
  let dados;
  try { dados = JSON.parse(texto); } catch { dados = null; }
  return { status: r.status, dados, trecho: dados ? "" : txt(texto.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), 160) };
}

async function proxyEngine(request, env, sessao, orgId, papel, caminho) {
  const rota = ROTAS_ENGINE.find(([m, re]) => m === request.method && re.test(caminho));
  if (!rota) return json({ erro: "Operação não permitida." }, 404);
  if (!pode(papel, rota[2]) && papel !== "REVISOR") return json({ erro: "Seu perfil não tem permissão para esta ação." }, 403); // o revisor só chega aqui pelas rotas de aprendizado
  const con = await conexaoDa(env, orgId);
  if (!con) return json({ erro: "A IA desta empresa ainda não foi conectada. Vá em Integrações e informe o endereço e o token da IA.", codigo: "ENGINE_NAO_CONFIGURADO" }, 503);
  let corpo;
  if (request.method === "POST") {
    const lido = await lerCorpo(request, caminho === "import/clients" || caminho === "guide/import" ? 600000 : 200000);
    if (lido.erro) return lido.erro;
    corpo = lido.corpo;
    const autor = sessao.usuario.nome ? `${sessao.usuario.nome} <${sessao.usuario.email}>` : sessao.usuario.email;
    if (/^(training|training\/restore|learning\/suggestions\/\d+|pause|conversations\/\d+\/(type|note)|cases\/\d+\/review|professionals(\/[\w-]+\/delete)?)$/.test(caminho)) corpo.autor = autor;
  }
  const params = {};
  const q = new URL(request.url).searchParams;
  for (const [k, re] of Object.entries(PARAMS_ENGINE)) if (q.get(k) && re.test(q.get(k))) params[k] = q.get(k);
  try {
    const r = await chamarEngine(con, request.method, caminho, corpo, params);
    if (!r.dados) return json({ erro: explicarFalha(r), status: r.status }, 502);
    if (r.status === 401) return json({ erro: con.token ? `A IA recusou o token (o que termina em …${con.token.slice(-4)}). Vá em Integrações e cole o mesmo DENIA_PLATFORM_SERVICE_TOKEN que está no Worker "denia".` : "Falta o token da IA. Vá em Integrações e cole o DENIA_PLATFORM_SERVICE_TOKEN do Worker \"denia\".", codigo: "ENGINE_TOKEN" }, 502);
    if (rota[3] && r.status < 300) {
      const detalhe = caminho === "import/clients" ? `${r.dados.importadas ?? 0} cliente(s) importado(s)` :
        caminho === "pause" ? (corpo.ativa ? "IA pausada" : "IA retomada") :
          caminho.startsWith("learning/suggestions/") ? `${corpo.acao === "aprovar" ? "Aprovou" : "Rejeitou"} a sugestão #${caminho.split("/").pop()}` :
            caminho === "training" ? `Versão ${r.dados.versao ?? ""}` :
              caminho === "telegram/connect" ? (corpo.forcar ? "Conectou o Telegram (forçado)" : "Conectou o Telegram") :
              caminho === "professionals" ? `${txt(corpo.nome, 60)} (${txt(corpo.area, 30)})` :
                caminho.startsWith("professionals/") ? `Desativou o profissional ${caminho.split("/")[1]}` :
              caminho.startsWith("cases/") ? `Caso #${caminho.split("/")[1]} → ${txt(corpo.etapa, 30)}` :
                caminho.startsWith("conversations/") ? `Conversa #${caminho.split("/")[1]}: ${caminho.split("/")[2]}` :
                  caminho === "guide/import" ? `Guia: ${r.dados.lojas ?? 0} loja(s) importada(s)` :
                    caminho.startsWith("guide/") ? `Guia: ${caminho.slice(6).replace(/\/\d+\/delete$/, " (excluiu)")}${corpo.nome ? " — " + txt(corpo.nome, 60) : ""}` : caminho;
      await auditar(env, request, sessao, orgId, rota[3], detalhe);
    }
    return json(r.dados, r.status);
  } catch (e) {
    console.error("Engine:", e?.message || e);
    return json({ erro: "Não foi possível falar com a IA desta empresa agora." }, 502);
  }
}

// Ferramentas que os módulos (marketing, Meta) usam.
function kitBase(env) { return { env, json, lerCorpo, txt, pode, agora, auditar, cifrar, decifrar, hmac, segredo, b64url, deB64url }; }
// Chatbot do WhatsApp (src/zap.js): IA da empresa, aviso por e-mail quando não há Telegram e o endereço do painel.
async function kitZap(env, base) {
  const url = base || String((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='base_url'").first().catch(() => null))?.valor || "").replace(/\/+$/, "");
  return {
    ...kitBase(env), comIA, base: url,
    alertarEmail: async (orgId, assunto, texto) => { let ok = false; for (const para of await responsaveisDa(env, orgId)) if (await enviarEmail(env, para, assunto, texto)) ok = true; return ok; },
    enviarEmail: (para, assunto, texto, anexos) => enviarEmail(env, para, assunto, texto, anexos), emailConfigurado: () => emailConfigurado(env), emailValido,
    responsaveis: orgId => responsaveisDa(env, orgId)
  };
}

// Chave da OpenAI: a colada em Integrações (cifrada no banco) ou o secret OPENAI_API_KEY.
async function chaveIA(env, orgId) {
  const salva = (await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("openai_org_" + orgId).first().catch(() => null))?.valor;
  const daPlataforma = salva ? await decifrar(env, salva) : "";
  if (daPlataforma) return { chave: daPlataforma, origem: "plataforma" };
  // Colada uma vez na Central, vale para todas as empresas que não tiverem a própria.
  const central = await primeiraEmpresa(env);
  if (central && central !== orgId) {
    const daCentral = (await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("openai_org_" + central).first().catch(() => null))?.valor;
    const c = daCentral ? await decifrar(env, daCentral) : "";
    if (c) return { chave: c, origem: "central" };
  }
  const doSecret = String(env.OPENAI_API_KEY || "").trim();
  return { chave: doSecret, origem: doSecret ? "cloudflare" : "" };
}
async function comIA(env, orgId) {
  const { chave } = await chaveIA(env, orgId);
  // Leva a empresa junto para o consumo (página Consumo e custos) ficar na conta certa.
  return Object.assign(Object.create(env), { USO_ORG: Number(orgId) || 0, ...(chave ? { OPENAI_API_KEY: chave } : {}) });
}

// Cron: a DENIA lê as avaliações novas (boa, ruim, grave, possível violação), avisa por e-mail os
// responsáveis quando uma pessoa precisa agir e, toda segunda-feira, gera o relatório semanal de cada marca.
async function responsaveisDa(env, orgId) {
  const r = (await env.DB.prepare("SELECT u.email FROM plt_membros m JOIN plt_usuarios u ON u.id=m.usuario_id WHERE m.org_id=? AND m.papel IN ('OWNER','ADMIN') LIMIT 5").bind(orgId).all().catch(() => null))?.results || [];
  const emails = r.map(x => x.email).filter(Boolean);
  if (!emails.length && emailValido(String(env.PLATFORM_ADMIN_EMAIL || ""))) emails.push(String(env.PLATFORM_ADMIN_EMAIL).trim());
  return emails;
}
async function cuidarDasAvaliacoes(env, k) {
  // Empresas com avaliação nova para ler, ou com o automático ligado e avaliação esperando resposta.
  const orgs = (await env.DB.prepare(`SELECT DISTINCT a.org_id FROM plt_mk_avaliacoes a LEFT JOIN plt_mk_config c ON c.org_id=a.org_id
    WHERE a.status='PENDENTE' AND (a.analise IS NULL OR (COALESCE(c.avaliacoes_auto,'DESLIGADO')<>'DESLIGADO' AND a.google_id IS NOT NULL)) LIMIT 5`).all().catch(() => null))?.results || [];
  const base = String((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='base_url'").first().catch(() => null))?.valor || "").replace(/\/+$/, "");
  for (const { org_id } of orgs) {
    const envIA = await comIA(env, org_id);
    const { alertas } = await analisarAvaliacoesPendentes(comRecurso(envIA, "automático/avaliações"), org_id, 10, k);
    if (!alertas.length || !emailConfigurado(env)) continue;
    const texto = `A DENIA encontrou ${alertas.length} avaliação(ões) do Google que precisam de você:\n\n` + alertas.map(x =>
      `• ${x.marca} — ${x.autor || "Cliente"} (${x.nota}★): "${String(x.texto || "").slice(0, 300)}"\n  ${x.analise.motivo_humano || ""}${x.analise.viola_politica ? `\n  Pode violar as regras do Google (${x.analise.politica}). ${x.analise.como_remover}` : ""}`).join("\n\n") +
      `\n\nA resposta sugerida já está pronta em Google Meu Negócio → Avaliações${base ? ": " + base + "/app#/google/avaliacoes" : ""}. Nada foi publicado sem você.`;
    for (const para of await responsaveisDa(env, org_id)) await enviarEmail(env, para, "DENIA — avaliação do Google precisa de você", texto);
  }
  // Avaliação ruim (3 estrelas ou menos) que chegou agora: avisa a equipe na hora, no Telegram da empresa (ou por
  // e-mail) — com ou sem IA, e nunca sobre as antigas trazidas ao conectar o perfil.
  const desde = new Date(agora(env) - 3 * 86400000).toISOString().slice(0, 10);
  const ruins = (await env.DB.prepare(`SELECT a.id, a.org_id, a.autor, a.nota, a.texto, a.data, m.nome marca FROM plt_mk_avaliacoes a LEFT JOIN plt_mk_marcas m ON m.id=a.marca_id
    WHERE a.google_id IS NOT NULL AND a.nota<=3 AND a.avisado_ms IS NULL AND a.removida_ms IS NULL AND a.status='PENDENTE' AND a.data>=? ORDER BY a.id LIMIT 20`).bind(desde).all().catch(() => null))?.results || [];
  const central = await primeiraEmpresa(env).catch(() => 0);
  for (const a of ruins) {
    const texto = `⚠️ Avaliação ${a.nota}★ no Google${a.marca ? " — " + a.marca : ""}\n${a.autor || "Cliente"}: "${String(a.texto || "(sem texto, só a nota)").slice(0, 600)}"\n\nA DENIA não respondeu sozinha. A resposta sugerida está em Google → Avaliações${base ? ": " + base + "/app#/google/avaliacoes" : ""}.`;
    const foi = await avisarTelegramDaEmpresa(env, { ...kitBase(env), ehCentral: a.org_id === central }, a.org_id, texto).catch(() => false);
    if (!foi && emailConfigurado(env)) for (const para of await responsaveisDa(env, a.org_id)) await enviarEmail(env, para, `DENIA — avaliação ${a.nota}★ no Google${a.marca ? " (" + a.marca + ")" : ""}`, texto);
    await env.DB.prepare("UPDATE plt_mk_avaliacoes SET avisado_ms=? WHERE id=?").bind(agora(env), a.id).run().catch(() => {});
  }
  // Relatório do Google em PDF para os clientes (dia 1 e, no quinzenal, dia 16).
  if (emailConfigurado(env)) await enviarRelatoriosPdf(env, k, (para, assunto, texto, anexos) => enviarEmail(env, para, assunto, texto, anexos)).catch(e => console.error("relatórios pdf", e?.message));
  // Situação de cada perfil do Google (suspensão e mudanças feitas pelo Google), uma vez por dia.
  await vigiarPerfis(env, k, (org, texto) => avisarTelegramDaEmpresa(env, { ...kitBase(env), ehCentral: org === central }, org, texto)).catch(e => console.error("vigiar perfis", e?.message));
  // Relatório semanal (segunda-feira), para as empresas com perfil do Google conectado.
  const comGoogle = (await env.DB.prepare("SELECT DISTINCT org_id FROM plt_mk_google LIMIT 20").all().catch(() => null))?.results || [];
  for (const { org_id } of comGoogle) {
    await medirPosicoesDaSemana(env, k, org_id).catch(e => console.error("posições", e?.message));
    const feitos = await relatoriosDaSemana(comRecurso(await comIA(env, org_id), "automático/relatórios"), k, org_id);
    if (!feitos.length || !emailConfigurado(env)) continue;
    for (const f of feitos) for (const para of await responsaveisDa(env, org_id)) await enviarEmail(env, para, `DENIA — relatório da semana: ${f.marca}`, f.texto + (base ? `\n\nVeja no painel: ${base}/app#/google/relatorio` : ""));
  }
}

// Cron: o WhatsApp de cada empresa está ENTREGANDO? (motor 31.2+). Se a Meta parou de entregar
// (pagamento, token, número bloqueado) ou muitas mensagens falharam, avisa os responsáveis por
// e-mail — no máximo uma vez a cada 6 horas para o mesmo problema.
async function vigiarWhatsapp(env) {
  if (!(await aCada(env, "vigiar_whatsapp", 25 * 60000))) return; // a cada 30 min (a consulta de saúde lê várias tabelas do motor)
  const orgs = new Set(((await env.DB.prepare("SELECT org_id FROM plt_integracoes LIMIT 50").all().catch(() => null))?.results || []).map(x => x.org_id));
  const central = await primeiraEmpresa(env).catch(() => null);
  if (central) orgs.add(central);
  const base = String((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='base_url'").first().catch(() => null))?.valor || "").replace(/\/+$/, "");
  for (const org of orgs) {
    try {
      const con = await conexaoDa(env, org);
      if (!con?.token) continue;
      const st = (await chamarEngine(con, "GET", "status")).dados || {};
      if (st.versao) await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("versao_motor_" + org, String(st.versao)).run().catch(() => {});
      const en = st.entregas_24h;
      const pendentes = en ? (en.falhas_pendentes != null ? en.falhas_pendentes : en.falhas) : 0;
      const muitas = en && pendentes >= Math.max(3, (en.total || 0) * 0.2);
      if (!st.entrega_bloqueada && !muitas) { await resolverProblema(env, org, "engine_entrega"); continue; }
      const motivo = st.entrega_bloqueada ? `${st.entrega_bloqueada.erro} (código ${st.entrega_bloqueada.codigo})` : (en.motivos || []).map(m => `${m.motivo} (${m.n}×)`).join(" · ");
      await registrarProblema(env, org, { chave: "engine_entrega", area: "WHATSAPP", gravidade: "ALTA", titulo: st.entrega_bloqueada ? "O WhatsApp da IA não está entregando as mensagens" : `A IA do WhatsApp não conseguiu entregar ${pendentes} mensagem(ns) nas últimas 24 h`, motivo: "Motivo informado pela Meta: " + motivo, dica: "Até resolver, responda os clientes pelo celular. O diagnóstico completo está em WhatsApp → Diagnóstico.", link: "#/whatsapp/diagnostico" });
      const chave = "alerta_entrega_" + org;
      const ultimo = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind(chave).first().catch(() => null);
      let antes = {};
      try { antes = JSON.parse(ultimo?.valor || "{}"); } catch { antes = {}; }
      const assinatura = st.entrega_bloqueada ? "b" + st.entrega_bloqueada.codigo : "f" + ((en.motivos || [])[0]?.codigo || "");
      if (antes.assinatura === assinatura && Date.now() - Number(antes.em || 0) < 6 * 3600000) continue;
      await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind(chave, JSON.stringify({ assinatura, em: Date.now() })).run();
      if (!emailConfigurado(env)) continue;
      const texto = `O WhatsApp da DENIA NÃO está entregando as mensagens aos clientes e profissionais.\n\nMotivo informado pela Meta: ${motivo}\n${en ? `Nas últimas 24 h: ${en.falhas} de ${en.total} mensagens não chegaram.\n` : ""}\nAté resolver, responda os clientes pelo celular. O diagnóstico completo e o passo a passo estão no painel${base ? ": " + base + "/app#/whatsapp" : " (WhatsApp → Verificar agora)"}.`;
      for (const para of await responsaveisDa(env, org)) await enviarEmail(env, para, "URGENTE — o WhatsApp não está entregando as mensagens", texto);
    } catch (e) { console.error("vigiar whatsapp", org, e?.message); }
  }
}

// Cron (5 min): pede ao motor de cada empresa para enviar a fila de respostas e responder mensagens
// recentes que ficaram para trás. Assim nada depende do cron do próprio motor (que a empresa pode deixar
// desligado). O motor só responde o que é recente e nunca manda em massa.
// Roda no máximo uma vez a cada "ms" (guardado no banco, vale entre execuções do cron).
// ---------------------------------------------------------------------------
// Relatório de clientes (planilha) de cada empresa: junta o chatbot e a IA da empresa, se ela tiver os dois.
// ---------------------------------------------------------------------------
async function brutoRelatorio(env, orgId, ini, fim) {
  const bruto = { entradas: [], buscas: [], nomes: {}, antigos: [] }, fontes = [];
  const juntar = b => { bruto.entradas.push(...(b.entradas || [])); bruto.buscas.push(...(b.buscas || [])); Object.assign(bruto.nomes, b.nomes || {}); bruto.antigos.push(...(b.antigos || [])); if (Array.isArray(b.telegram)) (bruto.telegram ||= []).push(...b.telegram); };
  const zap = await env.DB.prepare("SELECT phone_number_id FROM plt_zap_contas WHERE org_id=?").bind(orgId).first().catch(() => null);
  if (zap?.phone_number_id) { juntar(await brutoRelatorioZap(env, orgId, ini, fim)); fontes.push("chatbot"); }
  const con = await conexaoDa(env, orgId).catch(() => null);
  if (con?.token && con?.url) {
    const r = await chamarEngine(con, "GET", "report", null, { ini: String(ini), fim: String(fim) }).catch(e => ({ status: 0, erro: e?.message }));
    if (r?.dados?.sucesso) { juntar(r.dados); fontes.push("ia"); }
    else fontes.push("ia-indisponivel");
  }
  return { bruto, fontes };
}
async function configRelatorio(env, orgId) {
  return lerConfigRelatorio((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("relatorio_" + orgId).first().catch(() => null))?.valor);
}
async function gerarRelatorioOrg(env, orgId, ini, fim) {
  const org = await env.DB.prepare("SELECT nome FROM plt_organizacoes WHERE id=?").bind(orgId).first().catch(() => null);
  const { bruto, fontes } = await brutoRelatorio(env, orgId, ini, fim);
  const d = montarRelatorio(bruto, ini, fim);
  return { d, fontes, empresa: org?.nome || "", arquivo: { nome: `relatorio-clientes-${d.de}-a-${d.ate}.xlsx`, base64: base64(planilhaRelatorio(d, org?.nome || "")) } };
}
async function enviarRelatorioOrg(env, orgId, ini, fim, para = null) {
  const cfg = await configRelatorio(env, orgId);
  const g = await gerarRelatorioOrg(env, orgId, ini, fim);
  const extras = cfg.emails.split(/[,;\s]+/).map(e => e.trim()).filter(emailValido);
  const destinos = para ? [para] : [...new Set([...(await responsaveisDa(env, orgId)), ...extras])].slice(0, 10);
  let enviados = 0;
  for (const e of destinos) if (await enviarEmail(env, e, `Relatório de atendimento ${g.empresa ? "- " + g.empresa + " " : ""}(${dataBR(g.d.de)} a ${dataBR(g.d.ate)})`, textoRelatorio(g.d, g.empresa), [g.arquivo])) enviados++;
  return { enviados, destinos: destinos.length, totais: g.d.totais, fontes: g.fontes };
}
// A cada 5 min: empresa cujo dia e hora de envio chegaram recebe os últimos 7 dias (uma vez por dia escolhido).
async function relatoriosAgendados(env) {
  if (!emailConfigurado(env)) return;
  const t = agora(env);
  const orgs = (await env.DB.prepare("SELECT id FROM plt_organizacoes").all().catch(() => null))?.results || [];
  for (const { id } of orgs) {
    const cfg = await configRelatorio(env, id);
    if (!horaDeEnviar(cfg, t)) continue;
    const chave = `relatorio_enviado_${id}_${diaBR(t)}`;
    if (await env.DB.prepare("SELECT 1 FROM plt_meta WHERE chave=?").bind(chave).first().catch(() => null)) continue;
    const temFonte = await env.DB.prepare("SELECT 1 FROM plt_zap_contas WHERE org_id=? AND phone_number_id IS NOT NULL").bind(id).first().catch(() => null) || await conexaoDa(env, id).catch(() => null);
    if (!temFonte) continue;
    await env.DB.prepare("INSERT OR IGNORE INTO plt_meta(chave,valor) VALUES(?,?)").bind(chave, String(t)).run();
    const { ini, fim } = ultimos7Dias(t);
    try { await enviarRelatorioOrg(env, id, ini, fim); } catch (e) { console.error("relatório", id, e?.message); }
  }
}
async function rotasRelatorio(request, env, sessao, orgId, papel, resto) {
  const metodo = request.method, q = new URL(request.url).searchParams, t = agora(env);
  if (resto === "relatorio/config" && metodo === "GET") return json({ config: await configRelatorio(env, orgId), email_configurado: emailConfigurado(env), dias: DIAS_SEMANA });
  // Administrador geral: situação do relatório semanal de TODAS as empresas (se as mensagens chegam aqui e para quem vai).
  if (resto === "relatorio/todas" && metodo === "GET") {
    if (!sessao.usuario.super_admin) return json({ erro: "Só o administrador geral vê todas as empresas." }, 403);
    const orgs = (await env.DB.prepare("SELECT id, nome, status FROM plt_organizacoes ORDER BY id").all())?.results || [];
    const lista = [];
    for (const o of orgs) {
      const zap = await env.DB.prepare("SELECT phone_number_id FROM plt_zap_contas WHERE org_id=?").bind(o.id).first().catch(() => null);
      const ia = await conexaoDa(env, o.id).catch(() => null);
      if (!zap?.phone_number_id && !ia) continue;
      const ult = zap?.phone_number_id ? await env.DB.prepare("SELECT MAX(criado_ms) m, SUM(CASE WHEN criado_ms > ? THEN 1 ELSE 0 END) d FROM plt_zap_msgs WHERE org_id=? AND direcao='E'").bind(t - 7 * 86400000, o.id).first().catch(() => null) : null;
      const cfg = await configRelatorio(env, o.id);
      const extras = cfg.emails.split(/[,;\s]+/).map(e => e.trim()).filter(emailValido);
      const envio = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave LIKE ? ORDER BY valor DESC LIMIT 1").bind(`relatorio_enviado_${o.id}_%`).first().catch(() => null);
      lista.push({ id: o.id, nome: o.nome, status: o.status, chatbot: Boolean(zap?.phone_number_id), ia: Boolean(ia), ultima_mensagem_ms: ult?.m || null, mensagens_7d: Number(ult?.d || 0),
        config: cfg, destinatarios: [...new Set([...(await responsaveisDa(env, o.id)), ...extras])], ultimo_envio_ms: envio ? Number(envio.valor) : null });
    }
    return json({ email_configurado: emailConfigurado(env), dias: DIAS_SEMANA, empresas: lista });
  }
  if (resto === "relatorio/config" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Só administradores mudam o envio do relatório." }, 403);
    const lido = await lerCorpo(request, 4000); if (lido.erro) return lido.erro;
    const c = lido.corpo || {};
    const emails = String(c.emails || "").split(/[,;\s]+/).map(e => e.trim()).filter(Boolean);
    const invalidos = emails.filter(e => !emailValido(e));
    if (invalidos.length) return json({ erro: `E-mail inválido: ${invalidos.slice(0, 3).join(", ")}` }, 400);
    const cfg = lerConfigRelatorio(JSON.stringify({ ativo: c.ativo !== false, dia: Number(c.dia), hora: Number(c.hora), emails: emails.slice(0, 8).join(", ") }));
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("relatorio_" + orgId, JSON.stringify(cfg)).run();
    await auditar(env, request, sessao, orgId, "RELATORIO", cfg.ativo ? `Envio do relatório: ${DIAS_SEMANA[cfg.dia]} às ${cfg.hora}h` : "Envio do relatório desligado");
    return json({ ok: true, config: cfg });
  }
  if (resto === "relatorio" && metodo === "GET") {
    if (!pode(papel, "AGENTE")) return json({ erro: "Seu perfil não pode ver os dados dos clientes." }, 403);
    const de = q.get("de"), ate = q.get("ate"), u = ultimos7Dias(t);
    const ini = /^\d{4}-\d{2}-\d{2}$/.test(de || "") ? Date.parse(de + "T03:00:00Z") : u.ini;
    const fim = /^\d{4}-\d{2}-\d{2}$/.test(ate || "") ? Math.min(t + 1, Date.parse(ate + "T03:00:00Z") + 86400000) : u.fim;
    if (fim <= ini || fim - ini > 92 * 86400000) return json({ erro: "Escolha um período de até 3 meses." }, 400);
    // Resumo do painel: últimas 24 h, hoje e os últimos 7 dias até agora (uma leitura só).
    if (q.get("resumo") === "1") {
      const i7 = inicioDoDiaBR(t) - 6 * 86400000;
      const { bruto, fontes } = await brutoRelatorio(env, orgId, i7, t + 1);
      const sete = montarRelatorio(bruto, i7, t + 1);
      return json({ fontes, ultimas_24h: montarRelatorio(bruto, t - 86400000, t + 1).totais, hoje: montarRelatorio(bruto, inicioDoDiaBR(t), t + 1).totais, sete_dias: sete.totais, por_dia: sete.por_dia, categorias: sete.categorias.slice(0, 5) });
    }
    const g = await gerarRelatorioOrg(env, orgId, ini, fim);
    if (q.get("formato") === "xlsx") return json({ nome: g.arquivo.nome, base64: g.arquivo.base64, totais: g.d.totais });
    return json({ ...g.d, fontes: g.fontes });
  }
  if (resto === "relatorio/enviar" && metodo === "POST") {
    if (!pode(papel, "AGENTE")) return json({ erro: "Seu perfil não pode enviar relatórios." }, 403);
    if (!emailConfigurado(env)) return json({ erro: "O envio de e-mail ainda não está configurado (RESEND_API_KEY e EMAIL_REMETENTE)." }, 409);
    const { ini, fim } = ultimos7Dias(t);
    const r = await enviarRelatorioOrg(env, orgId, ini, fim, sessao.usuario.email);
    await auditar(env, request, sessao, orgId, "RELATORIO", "Enviou o relatório dos últimos 7 dias para o próprio e-mail");
    return json({ ok: r.enviados > 0, ...r, para: sessao.usuario.email });
  }
  return null;
}

async function aCada(env, nome, ms) {
  const t = agora(env);
  const r = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("acada_" + nome).first().catch(() => null);
  if (r && t - Number(r.valor || 0) < ms) return false;
  await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("acada_" + nome, String(t)).run().catch(() => {});
  return true;
}
// Uma vez por dia: apaga o que só ocupa espaço (imagens geradas e não usadas, registros técnicos antigos).
async function limparBanco(env) {
  const hoje = new Date(agora(env) - 3 * 3600000).toISOString().slice(0, 10);
  const feito = await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='limpeza_dia'").first().catch(() => null);
  if (feito?.valor === hoje) return;
  await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES('limpeza_dia',?)").bind(hoje).run();
  const t = agora(env);
  // Só artes de posts antigos: imagens do chatbot e logos das marcas nunca são apagadas.
  // (Separado: sem o Marketing em uso, as tabelas de posts/marcas podem não existir.)
  await env.DB.prepare("DELETE FROM plt_mk_midias WHERE criado_ms < ? AND COALESCE(prompt,'') NOT IN ('chatbot','logo') AND id NOT IN (SELECT logo_midia_id FROM plt_mk_marcas WHERE logo_midia_id IS NOT NULL) AND id NOT IN (SELECT midia_id FROM plt_mk_posts WHERE midia_id IS NOT NULL AND (status NOT IN ('PUBLICADO','REJEITADO') OR atualizado_ms > ?))").bind(t - 30 * 86400000, t - 90 * 86400000).run().catch(() => { });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plt_tentativas WHERE ate < ?").bind(t - 86400000),
    env.DB.prepare("DELETE FROM plt_redefinicoes WHERE expira_ms < ?").bind(t - 7 * 86400000),
    env.DB.prepare("DELETE FROM plt_meta WHERE chave LIKE 'tg_codigo:%' AND CAST(json_extract(valor,'$.ate') AS INTEGER) < ?").bind(t),
    env.DB.prepare("DELETE FROM plt_meta WHERE chave LIKE 'zap_ia_%' AND chave NOT LIKE 'zap_ia_mes_%' AND chave NOT LIKE ?").bind(`%_${hoje}`),
    env.DB.prepare("DELETE FROM plt_zap_tg WHERE criado_ms < ?").bind(t - 30 * 86400000)
  ]).catch(e => console.error("limpeza", e?.message));
  await limparProblemas(env, t);
}

// Motores antigos (antes do 31.9) liam o histórico inteiro a cada "tick": com eles, só a cada 30 min.
async function tickMotores(env) {
  const orgs = new Set(((await env.DB.prepare("SELECT org_id FROM plt_integracoes LIMIT 50").all().catch(() => null))?.results || []).map(x => x.org_id));
  const central = await primeiraEmpresa(env).catch(() => null);
  if (central) orgs.add(central);
  for (const org of orgs) {
    try {
      const versao = String((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave=?").bind("versao_motor_" + org).first().catch(() => null))?.valor || "");
      const novo = /^(3[2-9]|[4-9]\d)\.|^31\.(9|\d{2})\./.test(versao);
      if (!novo && !(await aCada(env, "tick_" + org, 25 * 60000))) continue;
      const con = await conexaoDa(env, org); if (con?.token) await chamarEngine(con, "POST", "tick", {});
    } catch (e) { console.error("tick motor", org, e?.message); }
  }
}

// O que a DENIA sabe da empresa quando conversa com a equipe no painel.
async function contextoAssistente(env, orgId) {
  const o = await env.DB.prepare("SELECT nome FROM plt_organizacoes WHERE id=?").bind(orgId).first();
  const linhas = [];
  const con = await conexaoDa(env, orgId).catch(() => null);
  if (con?.token) {
    try {
      const pega = (c, q) => chamarEngine(con, "GET", c, null, q).then(r => r.dados).catch(() => null);
      const [st0, cv, ap, tr] = await Promise.all([pega("status"), pega("conversations", { limit: "15" }), pega("learning"), pega("training")]);
      if (!st0) throw new Error("sem status");
      const st = st0;
      const soma = (l, f) => (l || []).filter(f).reduce((t, x) => t + Number(x.n || 0), 0);
      linhas.push(`IA do WhatsApp: ${st.pausa_geral ? "PAUSADA" : st.ok ? "funcionando" : "com alertas"} (versão ${st.versao || "?"}).`);
      linhas.push(`Mensagens recebidas nas últimas 24 h: ${soma(st.fila_24h, () => true)}.`);
      linhas.push(`Casos (30 dias) por etapa: ${(st.casos_por_etapa || []).map(x => `${x.etapa}=${x.n}`).join(", ") || "nenhum"}.`);
      const conv = cv?.conversas || [];
      if (conv.length) linhas.push("Conversas mais recentes: " + conv.slice(0, 15).map(c => `${c.nome || "cliente"} (${String(c.ultima_mensagem || "").slice(0, 60)})${c.ia_pausada ? " [com a equipe]" : ""}`).join("; ") + ".");
      if (ap?.sugestoes) linhas.push(`Aprendizados aguardando aprovação: ${ap.sugestoes.PENDENTE || 0}.`);
      if (tr?.dados) linhas.push(`TREINAMENTO ATUAL DA IA DO WHATSAPP (versão ${tr.versao}; campos: instrucoes, servicos, regras, precos, procedimentos, informacoes, exemplos):\n` +
        ["instrucoes", "servicos", "regras", "precos", "procedimentos", "informacoes", "exemplos"].map(k => `- ${k}: ${String(tr.dados[k] || "(vazio)").replace(/\s+/g, " ").slice(0, 700)}`).join("\n"));
    } catch (e) { linhas.push("IA do WhatsApp: não respondeu agora."); }
  } else linhas.push("IA do WhatsApp: ainda não conectada a esta empresa.");
  try {
    const q = async (sql) => Number((await env.DB.prepare(sql).bind(orgId).first())?.n || 0);
    linhas.push(`Estúdio de Marketing: ${await q("SELECT COUNT(*) n FROM plt_mk_marcas WHERE org_id=? AND ativa=1")} marca(s), ${await q("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND status='AGUARDANDO'")} post(s) aguardando aprovação, ${await q("SELECT COUNT(*) n FROM plt_mk_posts WHERE org_id=? AND status='APROVADO'")} aprovado(s) prontos para publicar, ${await q("SELECT COUNT(*) n FROM plt_mk_avaliacoes WHERE org_id=? AND status='PENDENTE'")} avaliação(ões) do Google sem resposta.`);
    const marcas = (await env.DB.prepare("SELECT id, nome, segmento, cidade, instagram, facebook, google, whatsapp FROM plt_mk_marcas WHERE org_id=? AND ativa=1 ORDER BY nome LIMIT 40").bind(orgId).all())?.results || [];
    const conectadas = async (sql) => new Set((((await env.DB.prepare(sql).bind(orgId).all().catch(() => null))?.results) || []).map(x => x.marca_id));
    const [comMeta, comGoogle] = await Promise.all([conectadas("SELECT marca_id FROM plt_mk_contas WHERE org_id=?"), conectadas("SELECT marca_id FROM plt_mk_google WHERE org_id=?")]);
    if (marcas.length) linhas.push("MARCAS E PERFIS (marca conectada publica sozinha os posts aprovados no horário; sem conexão, a equipe baixa a arte e publica):\n" +
      marcas.map(m => `- ${m.nome}${m.segmento ? " (" + m.segmento + ")" : ""}${m.cidade ? ", " + m.cidade : ""}: Instagram ${m.instagram ? "@" + m.instagram : "não informado"}; Facebook ${m.facebook || "não informado"}; Google ${m.google || "não informado"}; WhatsApp ${m.whatsapp || "não informado"}. Instagram/Facebook: ${comMeta.has(m.id) ? "CONECTADO" : "não conectado"}; Google: ${comGoogle.has(m.id) ? "CONECTADO" : "não conectado"}.`).join("\n"));
    const prox = (await env.DB.prepare("SELECT p.id, p.data, p.hora, p.titulo, p.status, p.canais, m.nome marca FROM plt_mk_posts p JOIN plt_mk_marcas m ON m.id=p.marca_id WHERE p.org_id=? AND p.status IN ('AGUARDANDO','APROVADO','RASCUNHO') ORDER BY p.data, p.hora LIMIT 25").bind(orgId).all())?.results || [];
    if (prox.length) linhas.push("PRÓXIMOS POSTS: " + prox.map(x => `#${x.id} ${x.marca} ${x.data || "sem data"} ${x.hora || ""} "${x.titulo || ""}" [${x.status}] ${x.canais}`).join("; ") + ".");
  } catch { /* tabelas ainda não criadas */ }
  try {
    const ims = (await env.DB.prepare("SELECT id, nome, cidade, preco_base, preco_fds, minimo_noites, taxa_limpeza, desconto_semanal, desconto_mensal, moeda FROM plt_tp_imoveis WHERE org_id=? AND ativo=1 ORDER BY nome LIMIT 40").bind(orgId).all())?.results || [];
    if (ims.length) {
      const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
      const [res, baixos, notas] = await Promise.all([
        env.DB.prepare("SELECT r.imovel_id, r.hospede, r.inicio, r.fim, r.canal, r.valor FROM plt_tp_reservas r WHERE r.org_id=? AND r.status='CONFIRMADA' AND r.tipo='RESERVA' AND r.fim >= ? ORDER BY r.inicio LIMIT 30").bind(orgId, hoje).all(),
        env.DB.prepare("SELECT e.imovel_id, e.item, e.quantidade, e.unidade FROM plt_tp_estoque e WHERE e.org_id=? AND e.quantidade <= e.minimo AND e.minimo > 0 LIMIT 40").bind(orgId).all(),
        env.DB.prepare("SELECT imovel_id, texto, prioridade FROM plt_tp_notas WHERE org_id=? AND status<>'FEITA' ORDER BY id DESC LIMIT 30").bind(orgId).all()
      ]);
      const nome = id => (ims.find(i => i.id === id) || {}).nome || "imóvel";
      linhas.push("LOCAÇÃO POR TEMPORADA — IMÓVEIS: " + ims.map(i => `${i.nome}${i.cidade ? " (" + i.cidade + ")" : ""}: diária ${i.moeda} ${i.preco_base ?? "?"}, fim de semana ${i.preco_fds ?? "igual"}, mínimo ${i.minimo_noites || 1} noite(s), limpeza ${i.taxa_limpeza ?? 0}, desconto semanal ${i.desconto_semanal || 0}%, mensal ${i.desconto_mensal || 0}%`).join("; ") + ".");
      if (res?.results?.length) linhas.push("PRÓXIMAS RESERVAS: " + res.results.map(r => `${nome(r.imovel_id)}: ${r.hospede || "hóspede"} ${r.inicio} a ${r.fim} (${r.canal}${r.valor ? ", " + r.valor : ""})`).join("; ") + ".");
      if (baixos?.results?.length) linhas.push("ESTOQUE ACABANDO: " + baixos.results.map(b => `${nome(b.imovel_id)}: ${b.item} (${b.quantidade} ${b.unidade || ""})`).join("; ") + ".");
      if (notas?.results?.length) linhas.push("MELHORIAS ABERTAS: " + notas.results.map(n => `${nome(n.imovel_id)}: ${n.texto.slice(0, 80)} [${n.prioridade}]`).join("; ") + ".");
    }
  } catch { /* módulo de temporada ainda sem tabelas */ }
  linhas.push(`Data de hoje: ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`);
  return { empresa: o?.nome || "empresa", dados: linhas.join("\n") };
}

async function apiOrg(request, env, sessao, orgId, resto, ctx) {
  const papel = await papelNa(env, sessao.usuario, orgId);
  if (!papel) return json({ erro: "Empresa não encontrada." }, 404);
  // Revisor de aprendizados: só vê e decide o que a IA aprendeu; nada mais da empresa.
  if (papel === "REVISOR" && !/^engine\/learning(\/suggestions(\/\d{1,12})?)?$/.test(resto)) return json({ erro: "Seu perfil só tem acesso aos aprendizados da IA." }, 403);
  const metodo = request.method;
  // Plano: cada área exige um recurso; fora do teste ou sem pagamento, só o plano e a equipe ficam abertos.
  const recurso = recursoDaRota(resto, metodo);
  const o = await env.DB.prepare("SELECT * FROM plt_organizacoes WHERE id=?").bind(orgId).first();
  const { planos } = await lerPlanos(env);
  const acesso = acessoDa(o, agora(env), planos);
  if (recurso !== "LIVRE" && !sessao.usuario.super_admin) {
    if (!acesso.liberado) return json({ erro: acesso.status === "TESTE_ACABOU" ? "O teste grátis terminou. Escolha um plano para continuar (Plano e pagamento)." : "O plano desta empresa está pendente. Regularize em Plano e pagamento.", codigo: "PLANO_VENCIDO" }, 402);
    if (recurso && !acesso.recursos.includes(recurso)) { const min = planoMinimo(recurso, planos); return json({ erro: `Este recurso faz parte do plano ${min ? min.nome : "superior"}. Atualize o plano em Plano e pagamento.`, codigo: "PLANO_RECURSO", recurso, plano_minimo: min }, 402); }
  }
  if (resto === "plano" || resto.startsWith("plano/")) return rotasPlano(request, env, { ...kitBase(env), sessao }, orgId, papel, resto);
  if (resto.startsWith("engine/")) return proxyEngine(request, env, sessao, orgId, papel, resto.slice(7));
  const kit = { ...kitBase(env), sessao, emSegundoPlano: tarefa => { const t = Promise.resolve().then(tarefa).catch(e => console.error("segundo plano", e?.message)); if (ctx && ctx.waitUntil) ctx.waitUntil(t); return t; } };
  if (resto === "tp" || resto.startsWith("tp/")) return rotasTemporada(request, env, { ...(await kitZap(env, new URL(request.url).origin)), sessao, superAdmin: Boolean(sessao.usuario.super_admin), openai: openaiBruto, acesso: sessao.usuario.super_admin ? { ...acesso, limites: { ...acesso.limites, imoveis: 0 } } : acesso, avisar: async (o, texto) => { for (const para of await responsaveisDa(env, o)) await enviarEmail(env, para, "DENIA — hóspede precisa de você", texto); } }, orgId, papel, resto);
  if (resto === "problemas" || resto.startsWith("problemas/")) {
    // Empresa com a IA da Central ligada: os avisos não urgentes dela (que não vão ao Telegram) entram aqui.
    const avisosCentral = async () => {
      const con = await conexaoDa(env, orgId).catch(() => null);
      if (!con?.token || !con?.url) return [];
      const r = await Promise.race([chamarEngine(con, "GET", "avisos").catch(() => null), new Promise(ok => setTimeout(() => ok(null), 5000))]);
      return r?.dados?.avisos || [];
    };
    return (await rotasProblemas(request, env, orgId, papel, resto, pode(papel, "AGENTE"), sessao.usuario.email, avisosCentral)) || json({ erro: "Rota não encontrada." }, 404);
  }
  if (resto === "relatorio" || resto.startsWith("relatorio/")) return (await rotasRelatorio(request, env, sessao, orgId, papel, resto)) || json({ erro: "Rota não encontrada." }, 404);
  if (resto === "zap" || resto.startsWith("zap/")) return rotasZap(request, env, { ...(await kitZap(env, new URL(request.url).origin)), sessao, acesso: sessao.usuario.super_admin ? { ...acesso, recursos: Object.keys(RECURSOS) } : acesso }, orgId, papel, resto);
  if (resto === "ia/chave" && metodo === "GET") {
    const k = await chaveIA(env, orgId);
    return json({ configurada: Boolean(k.chave), origem: k.origem, final: k.chave && pode(papel, "ADMIN") ? k.chave.slice(-4) : "" });
  }
  if (resto === "ia/chave" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Somente administradores podem mudar a chave da IA." }, 403);
    const { corpo, erro } = await lerCorpo(request);
    if (erro) return erro;
    const chave = String(corpo.chave || "").replace(/\s+/g, "");
    if (corpo.remover) await env.DB.prepare("DELETE FROM plt_meta WHERE chave=?").bind("openai_org_" + orgId).run();
    else {
      if (!/^sk-[A-Za-z0-9_\-]{20,300}$/.test(chave)) return json({ erro: "Essa não parece uma chave da OpenAI. Ela começa com sk- (copie em platform.openai.com → API keys)." }, 400);
      await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES(?,?)").bind("openai_org_" + orgId, await cifrar(env, chave)).run();
    }
    await auditar(env, request, sessao, orgId, "INTEGRACAO", corpo.remover ? "Chave da OpenAI removida" : `Chave da OpenAI salva (final ${chave.slice(-4)})`);
    return json({ ok: true });
  }
  if (resto === "ia/chave/testar" && metodo === "POST") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Sem permissão." }, 403);
    const { chave } = await chaveIA(env, orgId);
    if (!chave) return json({ ok: false, erro: "Nenhuma chave salva ainda." });
    try {
      const r = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${chave}` }, signal: AbortSignal.timeout(15000) });
      if (r.ok) return json({ ok: true });
      const d = await r.json().catch(() => ({}));
      const msg = r.status === 401 ? "A OpenAI recusou a chave (inválida ou apagada). Crie outra em platform.openai.com → API keys." :
        r.status === 429 ? "A chave funciona, mas a conta da OpenAI está sem crédito ou no limite. Adicione crédito em platform.openai.com → Billing." :
          `A OpenAI respondeu ${r.status}: ${txt(d?.error?.message, 160)}`;
      return json({ ok: false, erro: msg });
    } catch (e) { return json({ ok: false, erro: "Não consegui falar com a OpenAI: " + txt(e?.message, 120) }); }
  }
  if (resto.startsWith("mk/")) {
    // O marketing também consulta a IA do WhatsApp (ex.: a triagem das avaliações confere a base de clientes).
    const engine = async (metodo, caminho, corpo) => {
      const req = new Request(new URL(`/api/orgs/${orgId}/engine/${caminho}`, request.url), { method: metodo, headers: { "content-type": "application/json", origin: new URL(request.url).origin }, body: metodo === "POST" ? JSON.stringify(corpo || {}) : undefined });
      const r = await proxyEngine(req, env, sessao, orgId, papel, caminho);
      return { status: r.status, dados: await r.json().catch(() => ({})) };
    };
    return apiMarketing(request, await comIA(env, orgId), { ...kit, engine, central: (await primeiraEmpresa(env)) === orgId }, orgId, papel, resto.slice(3));
  }
  if (resto.startsWith("assistente/")) {
    // A DENIA age pelo comando de voz usando as mesmas rotas (e permissões) do painel.
    const interno = (base) => async (metodo, caminho, corpo) => {
      const req = new Request(new URL(`/api/orgs/${orgId}/${base}/${caminho}`, request.url), { method: metodo, headers: { "content-type": "application/json", origin: new URL(request.url).origin }, body: metodo === "POST" ? JSON.stringify(corpo || {}) : undefined });
      const rota = caminho.split("?")[0];
      const r = base === "mk" ? await apiMarketing(req, await comIA(env, orgId), kit, orgId, papel, rota)
        : base === "tp" ? await apiOrg(req, env, sessao, orgId, "tp/" + rota)
          : await proxyEngine(req, env, sessao, orgId, papel, rota);
      return { status: r.status, dados: await r.json().catch(() => ({})) };
    };
    const ctx = ["assistente/conversa", "assistente/ao-vivo", "assistente/contexto"].includes(resto) ? await contextoAssistente(env, orgId) : { empresa: "", dados: "" };
    return apiAssistente(request, comRecurso(await comIA(env, orgId), "assistente"), kit, orgId, papel, resto, { ...ctx, mk: interno("mk"), engine: interno("engine"), tp: interno("tp") });
  }

  if (resto === "membros" && metodo === "GET") {
    if (!pode(papel, "ADMIN")) return json({ erro: "Sem permissão." }, 403);
    const r = await env.DB.prepare(`SELECT u.id, u.email, u.nome, u.ativo, u.trocar_senha, u.ultimo_acesso_ms, m.papel, m.criado_ms FROM plt_membros m JOIN plt_usuarios u ON u.id=m.usuario_id WHERE m.org_id=? ORDER BY m.criado_ms`).bind(orgId).all();
    return json({ email: await situacaoEmail(env), membros: (r?.results || []).map(x => ({ ...x, ativo: Boolean(x.ativo), trocar_senha: Boolean(x.trocar_senha) })) });
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
    // Conta aberta no cadastro e com e-mail nunca comprovado: qualquer um poderia ter criado com o e-mail de
    // outra pessoa para "herdar" o acesso. Ganha uma senha temporária nova (entregue pela equipe/e-mail) e
    // as sessões antigas caem; quem criou sem ser dono do e-mail perde o acesso.
    if (u.email_confirmado === 0 && !u.super_admin) {
      senha = senhaTemporaria();
      const h = await hashSenha(senha, null, PBKDF2_ITER);
      u = await env.DB.prepare("UPDATE plt_usuarios SET senha_hash=?, senha_salt=?, senha_iter=?, trocar_senha=1, email_confirmado=1, sessao_versao=sessao_versao+1 WHERE id=? RETURNING *").bind(h.hash, h.salt, h.iter, u.id).first();
    }
    const naEquipe = Number((await env.DB.prepare("SELECT COUNT(*) n FROM plt_membros WHERE org_id=?").bind(orgId).first())?.n || 0);
    if (!sessao.usuario.super_admin && naEquipe >= Number(acesso.limites?.usuarios || 0)) return json({ erro: `O plano ${acesso.nome} permite até ${acesso.limites.usuarios} pessoas na equipe. Atualize o plano para adicionar mais.`, codigo: "PLANO_LIMITE" }, 402);
    await env.DB.prepare("INSERT INTO plt_membros(org_id,usuario_id,papel,criado_ms) VALUES(?,?,?,?)").bind(orgId, u.id, novoPapel, agora(env)).run();
    await auditar(env, request, sessao, orgId, "EQUIPE", `Adicionou ${email} como ${NOME_PAPEL[novoPapel]}`);
    return json({ ok: true, usuario_id: u.id, senha_temporaria: senha || null, ja_tinha_conta: !senha });
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
    if (env.ENGINE && typeof env.ENGINE.fetch === "function" && orgId === await primeiraEmpresa(env)) {
      const con = await conexaoDa(env, orgId);
      return json({ engine_url: "Worker \"denia\" (ligação direta na Cloudflare)", origem: "direta", token_configurado: Boolean(con.token), token_origem: con.origemToken, token_final: con.token ? con.token.slice(-4) : "", token_tamanho: con.token.length, atualizado_ms: i?.atualizado_ms || null, atualizado_por: pode(papel, "ADMIN") ? i?.atualizado_por || null : null });
    }
    const cfBruto = orgId === await primeiraEmpresa(env) ? conexaoCloudflare(env) : null;
    const cf = cfBruto && (cfBruto.binding || !(i?.engine_url && i?.token_cifrado)) ? cfBruto : null;
    if (cf) return json({ engine_url: cf.binding ? "Worker \"denia\" (ligação direta na Cloudflare)" : cf.url, token_configurado: true, origem: cf.binding ? "direta" : "cloudflare", atualizado_ms: null, atualizado_por: null });
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
    if (con.binding && !con.token) return json({ ok: false, erro: "Falta o token: cole aqui o DENIA_PLATFORM_SERVICE_TOKEN do Worker \"denia\" e salve." });
    try {
      const r = await chamarEngine(con, "GET", "status");
      if (r.status === 401) return json({ ok: false, erro: con.token ? `O Worker "denia" recusou o token que termina em …${con.token.slice(-4)} (${con.token.length} caracteres). O DENIA_PLATFORM_SERVICE_TOKEN do Worker "denia" precisa ser exatamente igual (sem espaços) e ter pelo menos 16 caracteres. Depois de salvar o secret lá, clique em Deploy.` : "Falta o token: cole aqui o DENIA_PLATFORM_SERVICE_TOKEN do Worker \"denia\" e salve." });
      if (!r.dados) return json({ ok: false, erro: explicarFalha(r) });
      return json({ ok: true, versao: r.dados.versao || "", saude: r.dados, direta: Boolean(con.binding) });
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
    const plano = PLANOS_PADRAO[String(corpo.plano || "")] ? String(corpo.plano) : "start";
    const st = STATUS_PLANO.includes(corpo.plano_status) ? corpo.plano_status : "TESTE";
    const o = await env.DB.prepare("INSERT INTO plt_organizacoes(nome,slug,segmento,cor,status,criado_ms,plano,plano_status,teste_ate) VALUES(?,?,?,?, 'ATIVA', ?,?,?,?) RETURNING id").bind(nome, s, segmento || null, cor, agora(env), plano, st, agora(env) + TESTE_DIAS * 86400000).first();
    await auditar(env, request, sessao, o.id, "EMPRESA", `Criou a empresa ${nome}${st === "CORTESIA" ? " (cortesia: acesso total sem custo)" : ""}`);
    return json({ ok: true, id: o.id });
  }
  const id = Number(resto);
  const o = await env.DB.prepare("SELECT * FROM plt_organizacoes WHERE id=?").bind(id).first();
  if (!o) return json({ erro: "Empresa não encontrada." }, 404);
  const status = ["ATIVA", "SUSPENSA"].includes(corpo.status) ? corpo.status : o.status;
  await env.DB.prepare("UPDATE plt_organizacoes SET nome=?, segmento=?, cor=?, status=? WHERE id=?").bind(nome.length >= 2 ? nome : o.nome, corpo.segmento !== undefined ? segmento || null : o.segmento, corpo.cor ? cor : o.cor, status, id).run();
  // Plano decidido pelo administrador geral: cortesia (acesso total sem custo), mais dias de teste, liberar até uma data.
  if (corpo.plano !== undefined || corpo.plano_status !== undefined || corpo.mais_dias_teste || corpo.pago_ate) {
    const plano = PLANOS_PADRAO[String(corpo.plano || "")] ? String(corpo.plano) : o.plano;
    const pst = STATUS_PLANO.includes(corpo.plano_status) ? corpo.plano_status : o.plano_status;
    const dias = Math.max(0, Math.min(365, Number(corpo.mais_dias_teste) || 0));
    const teste = dias ? Math.max(agora(env), Number(o.teste_ate || 0)) + dias * 86400000 : o.teste_ate;
    const pago = /^\d{4}-\d{2}-\d{2}$/.test(String(corpo.pago_ate || "")) ? Date.parse(corpo.pago_ate + "T23:59:59-03:00") : o.pago_ate;
    await env.DB.prepare("UPDATE plt_organizacoes SET plano=?, plano_status=?, teste_ate=?, pago_ate=? WHERE id=?").bind(plano, pst, teste, pago, id).run();
    await auditar(env, request, sessao, id, "PLANO", `Administrador: plano ${plano}, situação ${pst}${dias ? `, +${dias} dia(s) de teste` : ""}${corpo.pago_ate ? `, liberado até ${corpo.pago_ate}` : ""}`);
  }
  await auditar(env, request, sessao, id, "EMPRESA", `Atualizou a empresa${status !== o.status ? ` (${status === "ATIVA" ? "reativada" : "suspensa"})` : ""}`);
  return json({ ok: true });
}

async function api(request, env, caminho, ctx) {
  const metodo = request.method;
  if (caminho === "/api/publico" && metodo === "GET") {
    let whatsapp = String(env.CONTATO_WHATSAPP || "").replace(/\D/g, "");
    if (!whatsapp) whatsapp = String((await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='whatsapp_site'").first().catch(() => null))?.valor || "");
    if (!whatsapp) whatsapp = WHATSAPP_CENTRAL;
    const email = String(env.CONTATO_EMAIL || "").trim();
    return json({ whatsapp: whatsapp.length >= 10 ? whatsapp : "", email: emailValido(email) ? email : "", versao: VERSAO });
  }
  if (metodo !== "GET" && !postLegitimo(request)) return json({ erro: "Requisição não autorizada." }, 403);
  if (!["GET", "POST"].includes(metodo)) return json({ erro: "Método não permitido." }, 405);
  try { await garantirSchema(env); }
  catch (e) {
    console.error("D1:", e?.message);
    const b = erroDoBanco(e);
    return json({ erro: e?.codigo === "SEM_BANCO" ? "A plataforma ainda não foi configurada: falta o banco D1 (binding DB)." : b ? b.erro : "O banco de dados da plataforma está indisponível. Tente novamente em instantes.", codigo: b?.codigo || "SEM_BANCO" }, 503);
  }
  if (caminho === "/api/entrar" && metodo === "POST") return entrar(request, env);
  if (caminho === "/api/cadastro" && metodo === "POST") return cadastrar(request, env);
  if (caminho === "/api/senha/esqueci" && metodo === "POST") return esqueciSenha(request, env);
  if (caminho === "/api/senha/redefinir" && metodo === "POST") return redefinirSenha(request, env);
  if (caminho === "/api/contato" && metodo === "POST") return receberContato(request, env);
  if (caminho === "/api/sair" && metodo === "POST") return json({ ok: true }, 200, { "set-cookie": cookieSessao("", 0) });

  // Volta do Login do Facebook: chega sem a sessão (cookie SameSite=Strict); vale pelo state assinado.
  if (caminho === "/api/meta/retorno" && metodo === "GET") return retornoMeta(request, env, kitBase(env));
  if (caminho === "/api/google/retorno" && metodo === "GET") return retornoGoogle(request, env, kitBase(env));

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
  if (caminho === "/api/admin/site") {
    if (!u.super_admin) return json({ erro: "Sem permissão." }, 403);
    if (metodo === "POST") {
      const { corpo, erro } = await lerCorpo(request);
      if (erro) return erro;
      let w = String(corpo.whatsapp || "").replace(/\D/g, "");
      if (w && w.length <= 11) w = "55" + w;
      if (w && (w.length < 12 || w.length > 13)) return json({ erro: "Informe o WhatsApp com DDD, por exemplo (21) 99999-9162." }, 400);
      await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES('whatsapp_site',?)").bind(w).run();
      await auditar(env, request, sessao, null, "SITE", w ? `WhatsApp do site: final ${w.slice(-4)}` : "WhatsApp do site removido");
    }
    const w = (await env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='whatsapp_site'").first())?.valor || "";
    return json({ whatsapp: w, pelo_secret: Boolean(String(env.CONTATO_WHATSAPP || "").trim()) });
  }
  if ((m = caminho.match(/^\/api\/admin\/organizacoes(?:\/(\d{1,12}))?$/)) && metodo === "POST") return apiAdminOrgs(request, env, sessao, m[1] || "");
  // Liga o bot do Telegram da plataforma (um só bot para todas as empresas).
  if (caminho === "/api/admin/telegram" && metodo === "POST") {
    if (!u.super_admin) return json({ erro: "Sem permissão." }, 403);
    const token = tokenTelegramPlataforma(env);
    if (!token) return json({ erro: "Crie no Worker da plataforma o secret TELEGRAM_BOT_TOKEN_PLATAFORMA com o token do bot (do @BotFather)." }, 400);
    const chamar = async (m, corpo) => (await fetch(`https://api.telegram.org/bot${token}/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo || {}), signal: AbortSignal.timeout(15000) })).json().catch(() => ({}));
    const eu = await chamar("getMe");
    if (!eu.ok) return json({ erro: "O Telegram recusou o token do bot." }, 400);
    const w = await chamar("setWebhook", { url: new URL("/webhook/telegram", request.url).toString(), secret_token: await segredoTelegram(env, kitBase(env)), allowed_updates: ["message", "channel_post"] });
    if (!w.ok) return json({ erro: "Não consegui ligar o webhook do Telegram: " + txt(w.description, 200) }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES('tg_bot_usuario',?)").bind(eu.result.username).run();
    await auditar(env, request, sessao, null, "INTEGRACAO", `Bot do Telegram da plataforma ligado (@${eu.result.username})`);
    return json({ ok: true, bot: eu.result.username });
  }
  if (caminho === "/api/admin/planos") {
    if (!u.super_admin) return json({ erro: "Sem permissão." }, 403);
    if (metodo === "POST") {
      const { corpo, erro } = await lerCorpo(request, 20000);
      if (erro) return erro;
      const cfg = { desconto_anual: Math.max(0, Math.min(0.5, Number(corpo.desconto_anual) || 0)), planos: {} };
      for (const [id, p] of Object.entries(corpo.planos || {})) if (PLANOS_PADRAO[id]) cfg.planos[id] = { mensal: Math.max(0, Number(p.mensal) || 0), anual: Math.max(0, Number(p.anual) || 0) || undefined, visivel: p.visivel !== false, limites: { usuarios: Math.max(1, Number(p.limites?.usuarios) || PLANOS_PADRAO[id].limites.usuarios), ia_mes: Math.max(0, Number(p.limites?.ia_mes) || PLANOS_PADRAO[id].limites.ia_mes) } };
      await env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES('planos_config',?)").bind(JSON.stringify(cfg)).run();
      await auditar(env, request, sessao, null, "PLANO", "Valores e limites dos planos atualizados");
    }
    return json({ ...(await lerPlanos(env)), recursos: RECURSOS, cobranca: Boolean(String(env.ASAAS_API_KEY || "").trim()) });
  }
  if ((m = caminho.match(/^\/api\/orgs\/(\d{1,12})\/(.+)$/))) return apiOrg(request, env, sessao, Number(m[1]), m[2], ctx);
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
async function rotear(request, env, ctx) {
  const url = new URL(request.url);
  const caminho = url.pathname;
  if (caminho.startsWith("/api/")) return api(request, env, caminho, ctx);
  // Um só webhook do WhatsApp para todas as empresas (cada mensagem diz de qual número ela é).
  if (caminho === "/webhook/whatsapp") { await garantirSchema(env); return webhookZap(request, env, await kitZap(env), ctx); }
  if (caminho === "/webhook/telegram" && request.method === "POST") { await garantirSchema(env); return webhookTelegram(request, env, await kitZap(env)); }
  if (caminho === "/webhook/channex" && request.method === "POST") { await garantirSchema(env); return webhookChannex(request, env, await kitZap(env)); }
  if (caminho.startsWith("/tp/limpeza/") && ["GET", "POST"].includes(request.method)) { await garantirSchema(env); return comSeguranca((await limpezaPublica(request, env, await kitZap(env))) || new Response("Não encontrado.", { status: 404 }), request); }
  if (caminho.startsWith("/tp/ical/") && request.method === "GET") { await garantirSchema(env); return (await icalPublico(env, caminho)) || new Response("Não encontrado.", { status: 404 }); }
  if (caminho === "/webhook/asaas" && request.method === "POST") { await garantirSchema(env); return webhookAsaas(request, env, kitBase(env)); }
  if (!["GET", "HEAD"].includes(request.method)) return new Response("Método não permitido.", { status: 405 });

  // SEO: mapa do site e robots com o endereço oficial (SITE_URL), para o Google achar as páginas públicas.
  if (caminho === "/sitemap.xml") {
    const base = origemPublica(env, request);
    const paginas = [["/", "1.0", "weekly"], ["/cadastro", "0.8", "monthly"], ["/contato", "0.6", "monthly"], ["/termos", "0.3", "yearly"], ["/privacidade", "0.3", "yearly"], ["/contrato-de-dados", "0.3", "yearly"], ["/exclusao-de-dados", "0.2", "yearly"]];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paginas.map(([u, pr, f]) => `  <url><loc>${base}${u}</loc><changefreq>${f}</changefreq><priority>${pr}</priority></url>`).join("\n")}\n</urlset>\n`;
    return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
  }
  if (caminho === "/robots.txt") {
    const txtRobots = ["User-agent: *", "Allow: /", "Disallow: /app", "Disallow: /entrar", "Disallow: /api/", "Disallow: /recuperar", "Disallow: /redefinir", "Disallow: /ia/", "", `Sitemap: ${origemPublica(env, request)}/sitemap.xml`, ""].join("\n");
    return new Response(txtRobots, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
  }

  // Imagens dos posts com link assinado: o Instagram e o Facebook baixam a arte por aqui.
  if (caminho.startsWith("/m/")) { await garantirSchema(env); return servirMidiaPublica(env, kitBase(env), caminho); }
  const antigo = ANTIGOS[caminho.replace(/\.html$/, "")];
  if (antigo) return redirecionar(antigo);
  const ehPainel = caminho === "/app" || caminho === "/app.html" || caminho.startsWith("/app/");
  const sessao = ehPainel || caminho === "/entrar" || caminho === "/entrar.html" || caminho === "/cadastro" ? await lerSessao(request, env).catch(() => null) : null;
  if (ehPainel) {
    if (!sessao) return redirecionar("/entrar");
    const pagina = await env.ASSETS.fetch(new Request(new URL("/app", url).toString(), { headers: request.headers }));
    // Quem marcou "manter conectado" (e o aplicativo na tela inicial) nunca precisa entrar de novo:
    // a cada abertura, se já passou um mês, a sessão é renovada por mais 90 dias.
    if (sessao.longa && sessao.exp - agora(env) < SESSAO_LONGA_MS - 30 * 24 * 3600000) {
      const renovada = new Response(pagina.body, pagina);
      renovada.headers.append("set-cookie", cookieSessao(await criarCookie(env, sessao.usuario, SESSAO_LONGA_MS), SESSAO_LONGA_MS / 1000));
      return renovada;
    }
    return pagina;
  }
  if (caminho === "/cadastro" && sessao) return redirecionar("/app");
  // Já conectado: entrar vai direto para o painel (?trocar=1 deixa entrar com outra conta).
  if ((caminho === "/entrar" || caminho === "/entrar.html") && sessao && url.searchParams.get("trocar") !== "1") return redirecionar("/app");
  return env.ASSETS.fetch(request);
}

function comSeguranca(resposta, request) {
  const h = new Headers(resposta.headers);
  h.set("content-security-policy", [
    "default-src 'self'", "script-src 'self' https://connect.facebook.net", "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob: https: ", "media-src 'self' blob:", "connect-src 'self' https://api.openai.com https://*.facebook.com https://graph.facebook.com",
    "frame-src https://*.facebook.com https://*.fbcdn.net",
    "manifest-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"
  ].join("; "));
  h.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("permissions-policy", "camera=(), microphone=(self), geolocation=(), payment=()");
  h.set("cross-origin-opener-policy", "same-origin-allow-popups"); // a janela do Facebook (cadastro do WhatsApp) precisa responder à página
  const caminho = new URL(request.url).pathname;
  // Páginas, scripts, estilos e dicionários: o navegador sempre confere se há versão nova (resposta rápida 304 quando não há).
  if (caminho.startsWith("/assets/i18n/") || caminho.startsWith("/assets/js/") || caminho.startsWith("/assets/css/") || caminho.endsWith(".html") || !caminho.split("/").pop().includes(".")) h.set("cache-control", "no-cache");
  if (caminho.startsWith("/api/") || caminho.startsWith("/app") || caminho.startsWith("/entrar") || caminho.startsWith("/cadastro") || caminho.startsWith("/recuperar") || caminho.startsWith("/redefinir")) h.set("cache-control", "no-store");
  return new Response(resposta.body, { status: resposta.status, statusText: resposta.statusText, headers: h });
}

function paginaBancoIndisponivel(b) {
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DENIA — banco indisponível</title>
<body style="margin:0;font-family:system-ui,sans-serif;background:#070b14;color:#e8edf7;display:grid;place-items:center;min-height:100vh;padding:16px"><main style="max-width:560px;background:#0f1626;border:1px solid #24304a;border-radius:20px;padding:28px">
<h1 style="margin:0 0 12px;font-size:22px">A plataforma está temporariamente sem acesso ao banco de dados</h1><p style="line-height:1.6;color:#b9c3d8">${esc(b.erro)}</p>
<p style="line-height:1.6;color:#b9c3d8">Nada foi perdido: contas, conversas e configurações continuam guardadas.</p><p><a href="/entrar" style="color:#7aa7ff">Tentar de novo</a></p></main></body></html>`;
}

export default {
  async fetch(request, env, ctx) {
    // Páginas abertas por um endereço antigo (ícone salvo na tela inicial do celular antes da mudança, www, workers.dev)
    // vão para o endereço oficial. Webhooks, API e IA continuam respondendo onde estão.
    const fora = paraEnderecoOficial(request, env);
    if (fora) return fora;
    try { return comSeguranca(await rotear(request, env, ctx), request); }
    catch (e) {
      console.error("Erro não tratado:", e?.stack || e);
      const b = erroDoBanco(e);
      if (b) return comSeguranca(new URL(request.url).pathname.startsWith("/api/") ? json(b, 503) : new Response(paginaBancoIndisponivel(b), { status: 503, headers: { "content-type": "text/html; charset=UTF-8" } }), request);
      return comSeguranca(json({ erro: "Erro interno. Tente novamente." }, 500), request);
    }
    finally { await descarregarUso(env); } // grava o consumo somado nesta requisição
  },
  // A cada 5 minutos: publica no Instagram, Facebook e Google os posts aprovados cujo horário chegou;
  // de hora em hora, traz as avaliações e o desempenho dos perfis do Google.
  async scheduled(_evento, env, ctx) {
    const tarefa = (async () => {
      await garantirSchema(env);
      const k = kitBase(env);
      await publicarPendentes(env, k).catch(e => console.error("publicação agendada", e?.message));
      await sincronizarGooglePendentes(env, k).catch(e => console.error("google", e?.message));
      await cuidarDasAvaliacoes(env, k).catch(e => console.error("avaliações", e?.message));
      await tickMotores(env).catch(e => console.error("tick", e?.message));
      await vigiarWhatsapp(env).catch(e => console.error("whatsapp", e?.message));
      await limparBanco(env).catch(e => console.error("limpeza", e?.message));
      await sincronizarTemporada(env, await kitZap(env)).catch(e => console.error("temporada", e?.message));
      await processarCampanhas(env, await kitZap(env)).catch(e => console.error("campanhas", e?.message));
      await lembrarAgenda(env, await kitZap(env)).catch(e => console.error("agenda", e?.message));
      await relatoriosAgendados(env).catch(e => console.error("relatórios agendados", e?.message));
      await lembrarEstoque(env, await kitZap(env)).catch(e => console.error("estoque", e?.message));
      await avaliacoesDoCron(env, { ...(await kitZap(env)) }).catch(e => console.error("avaliações temporada", e?.message));
      if (await aCada(env, "temporada_inadimplentes", 20 * 3600000)) {
        const { planos } = await lerPlanos(env);
        await desligarInadimplentes(env, { ...(await kitZap(env)), avisar: async (o, texto) => { for (const para of await responsaveisDa(env, o)) await enviarEmail(env, para, "DENIA — conexão com as plataformas pausada", texto); } },
          async o => { const r = await env.DB.prepare("SELECT * FROM plt_organizacoes WHERE id=?").bind(o).first(); return r ? acessoDa(r, agora(env), planos) : null; }).catch(e => console.error("temporada inadimplentes", e?.message));
      }
      await lembretesDePlano(env, { ...(await kitZap(env)), enviarEmail, responsaveis: o => responsaveisDa(env, o) }).catch(e => console.error("lembretes", e?.message));
    })().catch(e => console.error("cron", e?.message)).finally(() => descarregarUso(env));
    if (ctx && ctx.waitUntil) ctx.waitUntil(tarefa); else await tarefa;
  }
};
