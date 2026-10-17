// Servidor Node (Hostinger): site, plataforma, IA do WhatsApp, tarefas, dados que sobrevivem
// a um reinício e importação a partir da Cloudflare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { iniciar } from "../servidor/index.mjs";

const CHAVE = "chave-do-servidor-de-teste-123";
const SENHA = "SenhaForte2026!";
const base = extra => ({ PLATFORM_ADMIN_EMAIL: "dono@teste.com", PLATFORM_ADMIN_PASSWORD: SENHA, SESSION_SECRET: "s".repeat(40), DENIA_CHAVE_SERVIDOR: CHAVE, SITE_URL: "https://denia.test", ...extra });

function cliente(porta) {
  const cookies = {};
  return async (caminho, { metodo = "GET", corpo, cabecalhos = {} } = {}) => {
    const headers = { "x-forwarded-proto": "https", "x-forwarded-host": "denia.test", "x-forwarded-for": "203.0.113.9", origin: "https://denia.test", "x-denia": "1", ...cabecalhos };
    if (cookies.s) headers.cookie = cookies.s;
    if (corpo !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(`http://127.0.0.1:${porta}${caminho}`, { method: metodo, headers, redirect: "manual", body: corpo !== undefined ? JSON.stringify(corpo) : undefined });
    const ck = r.headers.getSetCookie()[0];
    if (ck) cookies.s = ck.split(";")[0];
    const texto = await r.text();
    let dados = null; try { dados = JSON.parse(texto); } catch { }
    return { status: r.status, dados, texto, r };
  };
}

test("Servidor Node — site, plataforma com login, IA do WhatsApp e rotas do servidor", async () => {
  const pasta = mkdtempSync(path.join(os.tmpdir(), "denia-srv-"));
  const s = await iniciar({ env: base({ DENIA_DADOS: pasta }), porta: 0, ip: "127.0.0.1", semRelogio: true, silencioso: true });
  try {
    const req = cliente(s.porta);
    const home = await req("/");
    assert.equal(home.status, 200);
    assert.match(home.r.headers.get("content-type"), /text\/html/);
    assert.equal((await req("/entrar.html")).r.headers.get("location"), "/entrar");
    assert.equal((await req("/nada-aqui")).status, 404);
    assert.notEqual((await req("/..%2f..%2f..%2fetc%2fpasswd")).status, 200, "não sai da pasta public");
    const css = await req("/assets/css/app.css");
    assert.equal(css.status, 200);
    assert.equal((await req("/assets/css/app.css", { cabecalhos: { "if-none-match": css.r.headers.get("etag") } })).status, 304);

    assert.equal((await req("/app")).status, 302);
    const entrou = await req("/api/entrar", { metodo: "POST", corpo: { email: "dono@teste.com", senha: SENHA } });
    assert.equal(entrou.status, 200, entrou.texto);
    const eu = await req("/api/eu");
    assert.equal(eu.dados.usuario.super_admin, true);
    assert.equal((await req("/app")).status, 200);
    const conta = await req("/api/orgs/1/zap/conta", { cabecalhos: { "x-forwarded-host": "evil.test", host: "evil.test" } });
    assert.match(conta.dados.webhook_url, /^https:\/\/denia\.test\//, "cabeçalho forjado não muda o endereço (vale o SITE_URL)");

    const ia = await req("/ia/api/saude");
    assert.ok(ia.dados && typeof ia.dados === "object", "a IA do WhatsApp responde em /ia/");

    assert.equal((await req("/__denia/estado")).status, 403, "rotas do servidor pedem a chave");
    const t = await req("/__denia/tique?chave=" + CHAVE);
    assert.equal(t.dados.rodou, true);
    assert.equal(t.dados.plataforma, true);
    assert.equal(t.dados.engine, true);
    const t2 = await req("/__denia/tique?chave=" + CHAVE);
    assert.equal(t2.dados.plataforma, undefined, "não roda as tarefas de novo antes da hora");
    const est = await req("/__denia/estado", { cabecalhos: { "x-denia-chave": CHAVE } });
    assert.equal(est.status, 200);
    assert.ok(est.dados.ultimas_tarefas.plataforma);
    assert.match(est.dados.copias_de_seguranca[0] || "", /^denia-\d{4}-\d{2}-\d{2}\.db$/, "primeira cópia de segurança feita");
    assert.ok(!JSON.stringify(est.dados).includes(SENHA));

    assert.equal(est.dados.chave_das_conexoes, "sem conexões salvas para conferir");
    assert.equal((await req("/api/orgs/1/ia/chave", { metodo: "POST", corpo: { chave: "sk-proj-" + "a".repeat(40) + "WXYZ" } })).status, 200);
    assert.equal((await req("/__denia/estado?chave=" + CHAVE)).dados.chave_das_conexoes, "confere");

    const aud = s.envPlataforma.DB.prepare("SELECT ip FROM plt_auditoria WHERE ip IS NOT NULL ORDER BY rowid DESC LIMIT 1");
    const ultimo = await aud.first();
    if (ultimo) assert.equal(ultimo.ip, "203.0.113.9", "IP real do visitante (atrás do proxy da Hostinger)");
  } finally { await s.parar(); }

  // Reinício: os dados continuam no arquivo.
  const s2 = await iniciar({ env: base({ DENIA_DADOS: pasta, PLATFORM_ADMIN_PASSWORD: "" }), porta: 0, ip: "127.0.0.1", semRelogio: true, silencioso: true });
  try {
    const n = await s2.envPlataforma.DB.prepare("SELECT COUNT(*) n FROM plt_usuarios").first();
    assert.ok(n.n >= 1, "usuários continuam salvos depois de reiniciar");
    assert.match((await cliente(s2.porta)("/__denia/estado?chave=" + CHAVE)).dados.chave_das_conexoes, /^confere$/);
  } finally { await s2.parar(); }
  const s3 = await iniciar({ env: base({ DENIA_DADOS: pasta, SESSION_SECRET: "outra".repeat(10) }), porta: 0, ip: "127.0.0.1", semRelogio: true, silencioso: true });
  try {
    assert.match((await cliente(s3.porta)("/__denia/estado?chave=" + CHAVE)).dados.chave_das_conexoes, /^NÃO CONFERE/, "avisa quando a SESSION_SECRET não é a mesma");
  } finally { await s3.parar(); rmSync(pasta, { recursive: true, force: true }); }
});

test("Servidor Node — tarefas desligadas (período de teste antes da troca)", async () => {
  const pasta = mkdtempSync(path.join(os.tmpdir(), "denia-srv-"));
  const s = await iniciar({ env: base({ DENIA_DADOS: pasta, DENIA_TAREFAS: "desligadas" }), porta: 0, ip: "127.0.0.1", semRelogio: true, silencioso: true });
  try {
    const t = await cliente(s.porta)("/__denia/tique?chave=" + CHAVE);
    assert.equal(t.dados.rodou, false);
  } finally { await s.parar(); rmSync(pasta, { recursive: true, force: true }); }
});

test("Servidor Node — importa banco e memória da Cloudflare na primeira vez", async () => {
  const pasta = mkdtempSync(path.join(os.tmpdir(), "denia-srv-"));
  const fonte = new DatabaseSync(":memory:");
  const dump = [
    "PRAGMA defer_foreign_keys=TRUE;",
    "CREATE TABLE sqlite_sequence(name,seq);",
    "CREATE TABLE IF NOT EXISTS plt_meta (chave TEXT PRIMARY KEY, valor TEXT);",
    "INSERT INTO \"plt_meta\" (\"chave\",\"valor\") VALUES('marca','texto com ; ponto e vírgula\nem duas linhas');",
    "INSERT INTO \"plt_meta\" (\"chave\",\"valor\") VALUES('base_url','https://denia-landing.velho.workers.dev');",
    "CREATE TABLE contas (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT);",
    "INSERT INTO \"contas\" (\"id\",\"nome\") VALUES(7,'Ana');",
    "INSERT INTO \"sqlite_sequence\" (\"name\",\"seq\") VALUES('contas',7);",
    "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;",
    "INSERT INTO \"_cf_KV\" VALUES('x','y');"
  ].join("\n");
  fonte.close();
  const chamadas = [];
  let polls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, op = {}) => {
    url = String(url);
    chamadas.push({ url, auth: new Headers(op.headers).get("authorization") });
    const j = obj => new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/d1/database/banco-1/export")) {
      polls++;
      return j({ success: true, result: polls < 2 ? { status: "active", at_bookmark: "b1" } : { status: "complete", at_bookmark: "b1", result: { filename: "x.sql", signed_url: "https://r2.test/x.sql" } } });
    }
    if (url === "https://r2.test/x.sql") return new Response(dump);
    if (url.includes("/storage/kv/namespaces/kv-1/keys")) return j({ success: true, result: [{ name: "d30:treinamento" }, { name: "velho", expiration: 1 }], result_info: { cursor: "" } });
    if (url.includes("/values/d30%3Atreinamento")) return new Response("{\"empresa\":\"X\"}");
    if (url.startsWith("http://127.0.0.1")) return original(url, op);
    throw new Error("rede inesperada: " + url);
  };
  try {
    const s = await iniciar({ env: base({ DENIA_DADOS: pasta, CF_CONTA_ID: "conta-1", CF_API_TOKEN: "token-cf-secreto", CF_D1_ID: "banco-1", CF_KV_ID: "kv-1", SITE_URL: "https://app.denia.test/" }), porta: 0, ip: "127.0.0.1", semRelogio: true, silencioso: true });
    try {
      assert.equal(s.situacao.importacao.status, "concluida", JSON.stringify(s.situacao));
      const m = await s.envPlataforma.DB.prepare("SELECT valor FROM plt_meta WHERE chave='marca'").first();
      assert.equal(m.valor, "texto com ; ponto e vírgula\nem duas linhas");
      assert.equal((await s.envPlataforma.DB.prepare("SELECT valor FROM plt_meta WHERE chave='base_url'").first()).valor, "https://app.denia.test", "endereço novo no lugar do workers.dev");
      await s.envPlataforma.DB.prepare("INSERT INTO contas(nome) VALUES('Bia')").run();
      assert.equal((await s.envPlataforma.DB.prepare("SELECT id FROM contas WHERE nome='Bia'").first()).id, 8, "sequência continua de onde parou");
      assert.equal(await s.envEngine.MEMORIA.get("d30:treinamento"), "{\"empresa\":\"X\"}");
      assert.equal(await s.envEngine.MEMORIA.get("velho"), null, "itens vencidos não são copiados");
      assert.ok(chamadas.filter(c => c.url.includes("cloudflare.com")).every(c => c.auth === "Bearer token-cf-secreto"));
      const est = await cliente(s.porta)("/__denia/estado?chave=" + CHAVE);
      assert.ok(!est.texto.includes("token-cf-secreto"), "o token nunca aparece");
    } finally { await s.parar(); }
    // Segunda vez: banco já existe, não importa de novo.
    const antes = polls;
    const s2 = await iniciar({ env: base({ DENIA_DADOS: pasta, CF_CONTA_ID: "conta-1", CF_API_TOKEN: "token-cf-secreto", CF_D1_ID: "banco-1" }), porta: 0, ip: "127.0.0.1", semRelogio: true, silencioso: true });
    await s2.parar();
    assert.equal(polls, antes);
  } finally { globalThis.fetch = original; rmSync(pasta, { recursive: true, force: true }); }
});
