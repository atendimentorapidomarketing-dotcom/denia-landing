// Testes da DENIA Platform: login, permissões, isolamento entre empresas e
// integração de ponta a ponta com o DENIA Engine real (em memória).
import { test } from "node:test";
import assert from "node:assert/strict";
import { D1Fake, criarAmbiente } from "../engine/test/harness.mjs";

const ADMIN = "dono@denia.test", SENHA_ADMIN = "senha-do-admin-123";
const TOKEN_ENGINE = "token-de-servico-da-plataforma-123";
let n = 0;

async function criarPlataforma(extra = {}) {
  const mod = await import(new URL("../src/worker.js?t=" + (++n), import.meta.url).href);
  const engine = await criarAmbiente({ env: { DENIA_PLATFORM_SERVICE_TOKEN: TOKEN_ENGINE } });
  const fetchMock = globalThis.fetch;
  const chamadasEngine = [], emails = [], openaiChamadas = [];
  let p;
  globalThis.fetch = async (url, op = {}) => {
    if (p && p.openai && String(url).startsWith("https://api.openai.com/v1/")) {
      const corpo = op.body && typeof op.body === "string" ? JSON.parse(op.body) : null;
      openaiChamadas.push({ url: String(url), corpo });
      const r = p.openai ? p.openai(String(url), corpo) : {};
      if (r instanceof Response) return r;
      return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url) === "https://api.resend.com/emails") { emails.push(JSON.parse(op.body)); return new Response(JSON.stringify({ id: "e1" }), { status: 200 }); }
    if (String(url).startsWith("https://engine.test/")) {
      chamadasEngine.push({ url: String(url), headers: op.headers, corpo: op.body ? JSON.parse(op.body) : null });
      const pend = [];
      const r = await engine.worker.fetch(new Request(String(url), { method: op.method, headers: op.headers, body: op.body }), engine.env, { waitUntil: p => pend.push(p) });
      await Promise.all(pend);
      return r;
    }
    return fetchMock(url, op);
  };
  const env = {
    DB: new D1Fake(), PLATFORM_ADMIN_EMAIL: ADMIN, PLATFORM_ADMIN_PASSWORD: SENHA_ADMIN, SESSION_SECRET: "s".repeat(40),
    __semEspera: true, ASSETS: { fetch: async req => new Response("asset:" + new URL(req.url).pathname, { status: 200, headers: { "content-type": "text/html" } }) },
    ...extra
  };
  p = { env, engine, chamadasEngine, emails, openaiChamadas, cookies: {} };
  p.req = async (caminho, { metodo = "GET", corpo, quem, cabecalhos = {} } = {}) => {
    const headers = { "x-denia": "1", origin: "https://plataforma.test", ...cabecalhos };
    if (quem && p.cookies[quem]) headers.cookie = p.cookies[quem];
    if (corpo !== undefined) headers["content-type"] = "application/json";
    const r = await mod.default.fetch(new Request("https://plataforma.test" + caminho, { method: metodo, headers, body: corpo !== undefined ? JSON.stringify(corpo) : undefined }), env);
    const ck = r.headers.get("set-cookie");
    if (ck && quem) p.cookies[quem] = ck.split(";")[0];
    let dados = null;
    try { dados = JSON.parse(await r.clone().text()); } catch { }
    return { status: r.status, dados, r };
  };
  p.entrar = async (quem, email, senha) => p.req("/api/entrar", { metodo: "POST", corpo: { email, senha }, quem });
  return p;
}

test("Plataforma — sem SESSION_SECRET a chave das sessões é criada sozinha", async () => {
  const p = await criarPlataforma({ SESSION_SECRET: "" });
  const r = await p.entrar("a", ADMIN, SENHA_ADMIN);
  assert.equal(r.status, 200);
  assert.equal((await p.req("/api/eu", { quem: "a" })).status, 200);
});

test("Plataforma — login do administrador geral, primeira empresa criada e cabeçalhos de segurança", async () => {
  const p = await criarPlataforma();
  const sem = await p.req("/app");
  assert.equal(sem.status, 302);
  assert.equal(sem.r.headers.get("location"), "/entrar");
  const r = await p.entrar("admin", ADMIN, SENHA_ADMIN);
  assert.equal(r.status, 200);
  assert.match(p.cookies.admin, /^__Host-denia_sessao=/);
  assert.match(r.r.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Strict/);
  const eu = await p.req("/api/eu", { quem: "admin" });
  assert.equal(eu.dados.usuario.super_admin, true);
  assert.deepEqual(eu.dados.organizacoes.map(o => o.nome), ["Central de Atendimento"]);
  const app = await p.req("/app", { quem: "admin" });
  assert.equal(app.status, 200);
  assert.match(app.r.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(app.r.headers.get("x-frame-options"), "DENY");
  assert.equal(app.r.headers.get("cache-control"), "no-store");
  const entrar = await p.req("/entrar", { quem: "admin" });
  assert.equal(entrar.status, 200, "a página de login sempre aparece, mesmo já conectado");
  assert.doesNotMatch(r.r.headers.get("set-cookie"), /Max-Age/, "sem 'manter conectado', a sessão termina ao fechar o navegador");
});

test("Plataforma — bloqueia requisição forjada e tentativas repetidas", async () => {
  const p = await criarPlataforma();
  const forjada = await p.req("/api/entrar", { metodo: "POST", corpo: { email: ADMIN, senha: SENHA_ADMIN }, cabecalhos: { "x-denia": "" } });
  assert.equal(forjada.status, 403);
  const outroSite = await p.req("/api/entrar", { metodo: "POST", corpo: { email: ADMIN, senha: SENHA_ADMIN }, cabecalhos: { origin: "https://malicioso.test" } });
  assert.equal(outroSite.status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await p.entrar("x", ADMIN, "errada")).status, 401);
  const bloqueado = await p.entrar("x", ADMIN, SENHA_ADMIN);
  assert.equal(bloqueado.status, 429, "mesmo com a senha certa, espera o bloqueio");
});

test("Plataforma — conecta a IA da empresa com token cifrado e treina pela plataforma", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const ruim = await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "http://engine.test", token: TOKEN_ENGINE } });
  assert.equal(ruim.status, 400, "só https");
  const comCaminho = await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://engine.test/admin", token: TOKEN_ENGINE } });
  assert.equal(comCaminho.status, 400);
  const ok = await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://engine.test/", token: TOKEN_ENGINE } });
  assert.equal(ok.status, 200);
  const guardado = p.env.DB.q("SELECT token_cifrado FROM plt_integracoes")[0].token_cifrado;
  assert.ok(guardado.startsWith("v1.") && !guardado.includes(TOKEN_ENGINE), "token cifrado no banco");
  const lido = await p.req("/api/orgs/1/integracao", { quem: "admin" });
  assert.equal(lido.dados.token_configurado, true);
  assert.doesNotMatch(JSON.stringify(lido.dados), new RegExp(TOKEN_ENGINE), "token nunca volta ao navegador");
  const teste = await p.req("/api/orgs/1/integracao/testar", { metodo: "POST", quem: "admin", corpo: {} });
  assert.equal(teste.dados.ok, true);
  assert.match(teste.dados.versao, /^30\./);

  const salvo = await p.req("/api/orgs/1/engine/training", { metodo: "POST", quem: "admin", corpo: { treinamento: { servicos: "Eletricista não conserta eletrodomésticos." }, autor: "falsificado" } });
  assert.equal(salvo.status, 200);
  const t = await p.req("/api/orgs/1/engine/training", { quem: "admin" });
  assert.equal(t.dados.dados.servicos, "Eletricista não conserta eletrodomésticos.");
  assert.match(t.dados.autor, /dono@denia\.test/, "autor é sempre quem está logado");
  const apagar = await p.req("/api/orgs/1/engine/training", { metodo: "POST", quem: "admin", corpo: { treinamento: { servicos: "" } } });
  assert.equal(apagar.status, 409);
  assert.equal(apagar.dados.codigo, "CONFIRMAR_VAZIO");
  assert.equal(p.chamadasEngine.at(-1).headers.authorization, "Bearer " + TOKEN_ENGINE);

  const fora = await p.req("/api/orgs/1/engine/../api/saude", { quem: "admin" });
  assert.equal(fora.status, 404);
  const naoListada = await p.req("/api/orgs/1/engine/api/teste", { metodo: "POST", quem: "admin", corpo: {} });
  assert.equal(naoListada.status, 404, "só operações da lista");

  const pausa = await p.req("/api/orgs/1/engine/pause", { metodo: "POST", quem: "admin", corpo: { ativa: true } });
  assert.equal(pausa.dados.pausa_geral, true);
  const aud = await p.req("/api/orgs/1/auditoria", { quem: "admin" });
  const acoes = aud.dados.eventos.map(e => e.acao);
  for (const a of ["INTEGRACAO", "TREINAMENTO", "PAUSA_GERAL"]) assert.ok(acoes.includes(a), a);
});

test("Plataforma — equipe por perfil, senha temporária e isolamento entre empresas", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://engine.test", token: TOKEN_ENGINE } });
  const nova = await p.req("/api/admin/organizacoes", { metodo: "POST", quem: "admin", corpo: { nome: "Outra Empresa", segmento: "Teste" } });
  assert.equal(nova.status, 200);

  const add = await p.req("/api/orgs/1/membros", { metodo: "POST", quem: "admin", corpo: { nome: "Carla", email: "Carla@Central.test", papel: "AGENTE" } });
  assert.equal(add.status, 200);
  const temporaria = add.dados.senha_temporaria;
  assert.match(temporaria, /^[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
  const hash = p.env.DB.q("SELECT senha_hash FROM plt_usuarios WHERE email='carla@central.test'")[0].senha_hash;
  assert.ok(hash && !hash.includes(temporaria), "senha guardada só como hash");

  assert.equal((await p.entrar("carla", "carla@central.test", "errada-123")).status, 401);
  const login = await p.entrar("carla", "carla@central.test", temporaria);
  assert.equal(login.dados.trocar_senha, true);
  const antes = await p.req("/api/orgs/1/engine/status", { quem: "carla" });
  assert.equal(antes.status, 403);
  assert.equal(antes.dados.codigo, "TROCAR_SENHA");
  const fraca = await p.req("/api/conta", { metodo: "POST", quem: "carla", corpo: { acao: "senha", atual: temporaria, nova: "curta" } });
  assert.equal(fraca.status, 400);
  const troca = await p.req("/api/conta", { metodo: "POST", quem: "carla", corpo: { acao: "senha", atual: temporaria, nova: "NovaSenhaDaCarla2026" } });
  assert.equal(troca.status, 200);

  const status = await p.req("/api/orgs/1/engine/status", { quem: "carla" });
  assert.equal(status.status, 200, "atendente acompanha a IA");
  const treinar = await p.req("/api/orgs/1/engine/training", { metodo: "POST", quem: "carla", corpo: { treinamento: { regras: "x" } } });
  assert.equal(treinar.status, 403, "atendente não muda o treinamento");
  assert.equal((await p.req("/api/orgs/1/membros", { quem: "carla" })).status, 403);
  assert.equal((await p.req("/api/orgs/2/integracao", { quem: "carla" })).status, 404, "não enxerga outra empresa");
  assert.equal((await p.req("/api/orgs/2/engine/status", { quem: "carla" })).status, 404);
  const eu = await p.req("/api/eu", { quem: "carla" });
  assert.deepEqual(eu.dados.organizacoes.map(o => [o.nome, o.papel]), [["Central de Atendimento", "AGENTE"]]);
  assert.equal((await p.req("/api/admin/organizacoes", { metodo: "POST", quem: "carla", corpo: { nome: "Hack" } })).status, 403);

  // A conversa do WhatsApp aparece e a atendente pode assumir.
  p.engine.llmCliente = () => ({ resposta: "Oi! Como posso ajudar?", intencao: "CONVERSA", fatos: {} });
  await p.engine.cliente("5521911112222", "Oi");
  const conversas = await p.req("/api/orgs/1/engine/conversations", { quem: "carla" });
  const id = conversas.dados.conversas[0].pessoa_id;
  const assumir = await p.req(`/api/orgs/1/engine/conversations/${id}/takeover`, { metodo: "POST", quem: "carla", corpo: {} });
  assert.equal(assumir.dados.ia_pausada, true);
  const lista = await p.req("/api/orgs/1/engine/conversations", { quem: "carla" });
  assert.equal(lista.dados.conversas.find(c => c.pessoa_id === id).ia_pausada, true, "a lista mostra quem está com a equipe (numa consulta só)");

  // Suspender a empresa tira o acesso da equipe.
  await p.req("/api/admin/organizacoes/1", { metodo: "POST", quem: "admin", corpo: { status: "SUSPENSA" } });
  assert.equal((await p.req("/api/orgs/1/engine/status", { quem: "carla" })).status, 404);
  await p.req("/api/admin/organizacoes/1", { metodo: "POST", quem: "admin", corpo: { status: "ATIVA" } });

  // Remover da equipe encerra a sessão na hora.
  const uid = p.env.DB.q("SELECT id FROM plt_usuarios WHERE email='carla@central.test'")[0].id;
  await p.req(`/api/orgs/1/membros/${uid}`, { metodo: "POST", quem: "admin", corpo: { acao: "remover" } });
  assert.equal((await p.req("/api/eu", { quem: "carla" })).status, 401);
});

test("Plataforma — a empresa nunca fica sem proprietário", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const a = await p.req("/api/orgs/1/membros", { metodo: "POST", quem: "admin", corpo: { email: "dona@central.test", papel: "OWNER" } });
  const uid = a.dados.usuario_id;
  const rebaixar = await p.req(`/api/orgs/1/membros/${uid}`, { metodo: "POST", quem: "admin", corpo: { acao: "papel", papel: "ADMIN" } });
  assert.equal(rebaixar.status, 400);
  const remover = await p.req(`/api/orgs/1/membros/${uid}`, { metodo: "POST", quem: "admin", corpo: { acao: "remover" } });
  assert.equal(remover.status, 400);
  const admin = await p.req("/api/orgs/1/membros", { metodo: "POST", quem: "admin", corpo: { email: "gerente@central.test", papel: "ADMIN" } });
  await p.entrar("gerente", "gerente@central.test", admin.dados.senha_temporaria);
  await p.req("/api/conta", { metodo: "POST", quem: "gerente", corpo: { acao: "senha", atual: admin.dados.senha_temporaria, nova: "SenhaDoGerente2026" } });
  const promover = await p.req("/api/orgs/1/membros", { metodo: "POST", quem: "gerente", corpo: { email: "x@central.test", papel: "OWNER" } });
  assert.equal(promover.status, 403, "administrador não cria proprietário");
  const mexerNaDona = await p.req(`/api/orgs/1/membros/${uid}`, { metodo: "POST", quem: "gerente", corpo: { acao: "remover" } });
  assert.equal(mexerNaDona.status, 403);
});

test("Plataforma — aprendizado e importação de clientes passam pela plataforma", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://engine.test", token: TOKEN_ENGINE } });
  p.engine.llmCliente = () => ({ resposta: "Oi!", intencao: "CONVERSA", fatos: {} });
  await p.engine.cliente("5521911112222", "Vocês consertam geladeira?");
  await p.engine.eco("5521911112222", "Consertamos sim! Quem faz é o técnico de assistência.");
  const ini = await p.req("/api/orgs/1/engine/learning/start", { metodo: "POST", quem: "admin", corpo: {} });
  assert.equal(ini.dados.status, "RODANDO");
  p.engine.llmAprendizado = () => ({ itens: [{ tipo: "QUEM_ATENDE", titulo: "Geladeira", conteudo: "Geladeira é com a assistência técnica.", evidencia: "atendente" }] });
  await p.engine.cron();
  const sug = await p.req("/api/orgs/1/engine/learning/suggestions?status=PENDENTE", { quem: "admin" });
  assert.equal(sug.dados.sugestoes.length, 1);
  const ap = await p.req(`/api/orgs/1/engine/learning/suggestions/${sug.dados.sugestoes[0].id}`, { metodo: "POST", quem: "admin", corpo: { acao: "aprovar", conteudo: "Geladeira é sempre com a assistência técnica." } });
  assert.equal(ap.status, 200);
  const t = await p.req("/api/orgs/1/engine/training", { quem: "admin" });
  assert.match(t.dados.dados.aprendizados, /Geladeira é sempre com a assistência técnica/);
  assert.match(t.dados.autor, /dono@denia\.test/);
  const imp = await p.req("/api/orgs/1/engine/import/clients", { metodo: "POST", quem: "admin", corpo: { origem: "clientes.csv", linhas: [{ telefone: "21 98888-7777", nome: "Paulo" }] } });
  assert.equal(imp.dados.importadas, 1);
  const aud = await p.req("/api/orgs/1/auditoria", { quem: "admin" });
  assert.ok(aud.dados.eventos.some(e => e.acao === "IMPORTACAO" && /1 cliente/.test(e.detalhe)));
  assert.ok(aud.dados.eventos.some(e => e.acao === "APRENDIZADO" && /Aprovou/.test(e.detalhe)));
});

test("Plataforma — sem conexão configurada, explica o que fazer", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const r = await p.req("/api/orgs/1/engine/status", { quem: "admin" });
  assert.equal(r.status, 503);
  assert.equal(r.dados.codigo, "ENGINE_NAO_CONFIGURADO");
});

test("Plataforma — funciona sem configurar nada: contas antigas, chave automática e IA pelas variáveis antigas", async () => {
  const p = await criarPlataforma({ SESSION_SECRET: "", PLATFORM_ADMIN_EMAIL: "", PLATFORM_ADMIN_PASSWORD: "", DENIA_ENGINE_URL: "https://engine.test/", DENIA_PLATFORM_SERVICE_TOKEN: TOKEN_ENGINE });
  // Tabelas e conta da versão anterior do site (PBKDF2 30 mil, sal e hash em hexadecimal).
  const { pbkdf2Sync } = await import("node:crypto");
  const salt = "00112233445566778899aabbccddeeff";
  const hash = pbkdf2Sync("SenhaAntiga2026", Buffer.from(salt, "hex"), 30000, 32, "sha256").toString("hex");
  p.env.DB.db.exec("CREATE TABLE organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE users(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,role TEXT NOT NULL)");
  p.env.DB.db.prepare("INSERT INTO organizations VALUES('o1','Central de Atendimento')").run();
  p.env.DB.db.prepare("INSERT INTO users VALUES('u1','o1','Dona','dona@central.test',?,?,'SUPER_ADMIN')").run(hash, salt);
  p.env.DB.db.prepare("INSERT INTO users VALUES('u2','o1','Ana','ana@central.test',?,?,'OWNER')").run(hash, salt);

  assert.equal((await p.entrar("x", "dona@central.test", "errada")).status, 401);
  const r = await p.entrar("dona", "dona@central.test", "SenhaAntiga2026");
  assert.equal(r.status, 200, "a senha antiga continua valendo");
  const eu = await p.req("/api/eu", { quem: "dona" });
  assert.equal(eu.dados.usuario.super_admin, true);
  assert.equal(eu.dados.organizacoes[0].conectada, true, "IA conectada pelas variáveis antigas");
  const st = await p.req("/api/orgs/1/engine/status", { quem: "dona" });
  assert.equal(st.status, 200);
  const integ = await p.req("/api/orgs/1/integracao", { quem: "dona" });
  assert.equal(integ.dados.origem, "cloudflare");
  assert.ok(p.env.DB.q("SELECT valor FROM plt_meta WHERE chave='segredo'")[0].valor.length > 40, "chave de sessão criada sozinha");
  const de_novo = await p.entrar("dona2", "dona@central.test", "SenhaAntiga2026");
  assert.equal(de_novo.status, 200, "segundo acesso já pelo formato novo");

  await p.entrar("ana", "ana@central.test", "SenhaAntiga2026");
  const euAna = await p.req("/api/eu", { quem: "ana" });
  assert.equal(euAna.dados.organizacoes.length, 1);
  assert.notEqual(euAna.dados.organizacoes[0].id, 1, "outra conta nunca entra na Central de Atendimento");
  assert.equal(euAna.dados.organizacoes[0].papel, "OWNER");
  assert.equal(euAna.dados.organizacoes[0].conectada, false, "empresa própria, sem a IA configurada");
  assert.equal((await p.req("/api/orgs/1/engine/status", { quem: "ana" })).status, 404);

  const antigo = await p.req("/login.html");
  assert.equal(antigo.status, 302);
  assert.equal(antigo.r.headers.get("location"), "/entrar");
});

test("Plataforma — criar conta: empresa própria, sem configuração e sem acesso à Central", async () => {
  const p = await criarPlataforma({ DENIA_ENGINE_URL: "https://engine.test", DENIA_PLATFORM_SERVICE_TOKEN: TOKEN_ENGINE });
  const fraca = await p.req("/api/cadastro", { metodo: "POST", quem: "novo", corpo: { nome: "Rafa", empresa: "Clínica Sol", email: "rafa@sol.test", senha: "123" } });
  assert.equal(fraca.status, 400);
  const r = await p.req("/api/cadastro", { metodo: "POST", quem: "novo", corpo: { nome: "Rafa", empresa: "Clínica Sol", email: "Rafa@Sol.test", senha: "SenhaDaRafa2026" } });
  assert.equal(r.status, 200);
  const eu = await p.req("/api/eu", { quem: "novo" });
  assert.deepEqual(eu.dados.organizacoes.map(o => [o.nome, o.papel, o.conectada]), [["Clínica Sol", "OWNER", false]]);
  const id = eu.dados.organizacoes[0].id;
  assert.equal((await p.req(`/api/orgs/${id}/engine/training`, { quem: "novo" })).dados.codigo, "ENGINE_NAO_CONFIGURADO");
  assert.equal((await p.req("/api/orgs/1/engine/training", { quem: "novo" })).status, 404, "não vê a IA da Central");
  const repetido = await p.req("/api/cadastro", { metodo: "POST", corpo: { nome: "Xavier", empresa: "Ypsilon", email: "rafa@sol.test", senha: "SenhaDaRafa2026" } });
  assert.equal(repetido.status, 409);
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const st = await p.req("/api/orgs/1/engine/status", { quem: "admin" });
  assert.equal(st.status, 200, "a conta principal vê a Central configurada");
});

test("Plataforma — conta antiga da empresa principal volta para a Central, mesmo se tinha sido separada", async () => {
  const p = await criarPlataforma({ DENIA_ENGINE_URL: "https://engine.test", DENIA_PLATFORM_SERVICE_TOKEN: TOKEN_ENGINE });
  const { pbkdf2Sync } = await import("node:crypto");
  const salt = "00112233445566778899aabbccddeeff", hash = pbkdf2Sync("SenhaAntiga2026", Buffer.from(salt, "hex"), 30000, 32, "sha256").toString("hex");
  p.env.DB.db.exec("CREATE TABLE organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL); CREATE TABLE users(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT)");
  p.env.DB.db.prepare("INSERT INTO organizations VALUES('o1','DENIA Operação Principal'),('o2','Outra Loja')").run();
  p.env.DB.db.prepare("INSERT INTO users VALUES('u1','o1','Dono','dono@central.test',?,?,'OWNER','2026-01-01'),('u2','o2','Beto','beto@loja.test',?,?,'OWNER','2026-02-01')").run(hash, salt, hash, salt);
  await p.entrar("dono", "dono@central.test", "SenhaAntiga2026");
  const eu = await p.req("/api/eu", { quem: "dono" });
  assert.deepEqual(eu.dados.organizacoes.map(o => [o.id, o.nome, o.conectada]), [[1, "Central de Atendimento", true]], "a primeira conta antiga abre a Central já conectada");
  assert.equal((await p.req("/api/orgs/1/engine/training", { quem: "dono" })).status, 200, "treinamento da Central aparece");
  await p.entrar("beto", "beto@loja.test", "SenhaAntiga2026");
  const beto = await p.req("/api/eu", { quem: "beto" });
  assert.equal(beto.dados.organizacoes[0].nome, "Outra Loja");
  assert.equal(beto.dados.organizacoes[0].conectada, false);

  // Simula o estado deixado pela versão anterior: o dono separado numa "Empresa de Dono".
  const uid = p.env.DB.q("SELECT id FROM plt_usuarios WHERE email='dono@central.test'")[0].id;
  p.env.DB.db.prepare("DELETE FROM plt_membros WHERE usuario_id=?").run(uid);
  p.env.DB.db.prepare("INSERT INTO plt_organizacoes(nome,slug,cor,status,criado_ms) VALUES('Empresa de Dono','empresa-9-x','#4f8cff','ATIVA',1)").run();
  const oid = p.env.DB.q("SELECT id FROM plt_organizacoes WHERE slug='empresa-9-x'")[0].id;
  p.env.DB.db.prepare("INSERT INTO plt_membros VALUES(?,?,'OWNER',1)").run(oid, uid);
  p.env.DB.db.prepare("UPDATE plt_meta SET valor='2.2.0-a' WHERE chave='schema'").run();
  const p2mod = await import(new URL("../src/worker.js?r=" + Math.random(), import.meta.url).href);
  const r = await p2mod.default.fetch(new Request("https://plataforma.test/api/eu", { headers: { cookie: p.cookies.dono } }), p.env);
  const d = await r.json();
  assert.deepEqual(d.organizacoes.map(o => o.nome), ["Central de Atendimento"], "conta corrigida de volta para a Central");
  assert.equal(p.env.DB.q("SELECT COUNT(*) n FROM plt_organizacoes WHERE slug='empresa-9-x'")[0].n, 0, "empresa criada por engano foi removida");
});

test("Plataforma — esqueceu a senha: link por e-mail, uso único, e não revela quem tem conta", async () => {
  const p = await criarPlataforma({ RESEND_API_KEY: "re_teste", EMAIL_REMETENTE: "DENIA <nao-responda@denia.test>" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const add = await p.req("/api/orgs/1/membros", { metodo: "POST", quem: "admin", corpo: { nome: "Lia", email: "lia@central.test", papel: "AGENTE" } });
  assert.ok(add.dados.senha_temporaria);
  const desconhecido = await p.req("/api/senha/esqueci", { metodo: "POST", corpo: { email: "ninguem@x.test" } });
  const conhecido = await p.req("/api/senha/esqueci", { metodo: "POST", corpo: { email: "lia@central.test" } });
  assert.deepEqual(desconhecido.dados, conhecido.dados, "mesma resposta para quem tem e quem não tem conta");
  assert.equal(p.emails.length, 1);
  assert.equal(p.emails[0].to[0], "lia@central.test");
  const token = p.emails[0].text.match(/redefinir\?t=([A-Za-z0-9_-]+)/)[1];
  const fraca = await p.req("/api/senha/redefinir", { metodo: "POST", corpo: { token, nova: "curta" } });
  assert.equal(fraca.status, 400);
  const ok = await p.req("/api/senha/redefinir", { metodo: "POST", corpo: { token, nova: "NovaSenhaDaLia2026" } });
  assert.equal(ok.status, 200);
  assert.equal((await p.req("/api/senha/redefinir", { metodo: "POST", corpo: { token, nova: "OutraSenha2026x" } })).status, 400, "link vale uma vez só");
  const login = await p.entrar("lia", "lia@central.test", "NovaSenhaDaLia2026");
  assert.equal(login.dados.trocar_senha, false);
});

test("Plataforma — lembrar de mim, formulário de contato e páginas antigas", async () => {
  const p = await criarPlataforma();
  const r = await p.req("/api/entrar", { metodo: "POST", quem: "a", corpo: { email: ADMIN, senha: SENHA_ADMIN, lembrar: true } });
  assert.match(r.r.headers.get("set-cookie"), /Max-Age=2592000/, "30 dias");
  const robo = await p.req("/api/contato", { metodo: "POST", corpo: { nome: "Bot", email: "b@x.test", mensagem: "spam spam", site: "http://spam" } });
  assert.equal(robo.status, 200);
  const c = await p.req("/api/contato", { metodo: "POST", corpo: { nome: "Paula", email: "paula@x.test", telefone: "21 99999-0000", assunto: "Planos e valores", mensagem: "Quero uma demonstração" } });
  assert.equal(c.status, 200);
  const lista = await p.req("/api/admin/contatos", { quem: "a" });
  assert.deepEqual(lista.dados.contatos.map(x => x.nome), ["Paula"], "robô ignorado, contato real guardado");
});

test("Plataforma — Central ligada direto ao Worker denia (service binding), com prioridade", async () => {
  const p = await criarPlataforma({ DENIA_PLATFORM_SERVICE_TOKEN: TOKEN_ENGINE });
  const pedidos = [];
  p.env.ENGINE = { fetch: async (req) => { pedidos.push(req.url); return p.engine.worker.fetch(req, p.engine.env, { waitUntil() { } }); } };
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  // Mesmo com um endereço salvo antes, a Central usa a ligação direta; o token salvo na plataforma vale.
  await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://errado.test", token: "token-qualquer-errado-123" } });
  const errado = await p.req("/api/orgs/1/engine/training", { quem: "admin" });
  assert.equal(errado.status, 502);
  assert.match(errado.dados.erro, /termina em …-123/);
  const teste401 = await p.req("/api/orgs/1/integracao/testar", { metodo: "POST", quem: "admin", corpo: {} });
  assert.match(teste401.dados.erro, /25 caracteres/);
  await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "", token: TOKEN_ENGINE } });
  const t = await p.req("/api/orgs/1/engine/training", { quem: "admin" });
  assert.equal(t.status, 200, "com o token certo colado no painel, funciona");
  assert.ok(pedidos.length >= 1 && pedidos.every(u => u.includes("/platform/")));
  const integ = await p.req("/api/orgs/1/integracao", { quem: "admin" });
  assert.equal(integ.dados.origem, "direta");
  assert.equal(integ.dados.token_origem, "plataforma");
  assert.equal(integ.dados.token_final, TOKEN_ENGINE.slice(-4));
  assert.doesNotMatch(JSON.stringify(integ.dados), new RegExp(TOKEN_ENGINE), "o token inteiro nunca volta ao navegador");
  const teste = await p.req("/api/orgs/1/integracao/testar", { metodo: "POST", quem: "admin", corpo: {} });
  assert.equal(teste.dados.direta, true);
});

test("Plataforma — resposta que não é da IA vira uma explicação clara", async () => {
  const p = await criarPlataforma({ DENIA_PLATFORM_SERVICE_TOKEN: TOKEN_ENGINE });
  p.env.ENGINE = { fetch: async () => new Response("<html><body>error code: 1042</body></html>", { status: 403, headers: { "content-type": "text/html" } }) };
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const r = await p.req("/api/orgs/1/engine/conversations", { quem: "admin" });
  assert.equal(r.status, 502);
  assert.match(r.dados.erro, /1042/);
});

const resposta = (obj) => ({ output: [{ content: [{ type: "output_text", text: JSON.stringify(obj) }] }] });

test("Estúdio — marcas, semana criada pela IA, aprovação humana e imagem", async () => {
  const semIa = await criarPlataforma();
  await semIa.entrar("a", ADMIN, SENHA_ADMIN);
  await semIa.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "a", corpo: { nome: "Clínica Sol" } });
  const bloqueado = await semIa.req("/api/orgs/1/mk/ia/semana", { metodo: "POST", quem: "a", corpo: { marca_id: 1 } });
  assert.equal(bloqueado.dados.codigo, "SEM_OPENAI", "sem a chave, explica o que falta");
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);

  const mk = await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Clínica Sol", segmento: "Odontologia", cidade: "Niterói", instagram: "@clinicasol", tom: "acolhedor" } });
  const m2 = await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Pet Feliz", instagram: "https://instagram.com/petfeliz/" } });
  const marcas = (await p.req("/api/orgs/1/mk/marcas", { quem: "admin" })).dados.marcas;
  assert.deepEqual(marcas.map(x => [x.nome, x.instagram]), [["Clínica Sol", "clinicasol"], ["Pet Feliz", "petfeliz"]], "várias marcas, cada uma com o seu Instagram");

  p.openai = () => resposta({ posts: [
    { dia: 0, hora: "18:00", formato: "post", titulo: "Sorriso em dia", legenda: "Cuide do seu sorriso!", hashtags: "#niteroi", chamada: "Chame no WhatsApp", ideia_imagem: "Sorriso" },
    { dia: 3, hora: "12:00", formato: "story", titulo: "Bastidores", legenda: "Conheça a equipe", hashtags: "#odonto", chamada: "Agende", ideia_imagem: "Equipe" }
  ] });
  const sem = await p.req("/api/orgs/1/mk/ia/semana", { metodo: "POST", quem: "admin", corpo: { marca_id: mk.dados.id, inicio: "2026-10-14", quantidade: 2 } });
  assert.equal(sem.dados.criados.length, 2);
  const posts = (await p.req("/api/orgs/1/mk/posts?de=2026-10-12&ate=2026-10-18", { quem: "admin" })).dados.posts;
  assert.deepEqual(posts.map(x => [x.data, x.status]), [["2026-10-12", "AGUARDANDO"], ["2026-10-15", "AGUARDANDO"]], "semana começa na segunda; no modo humano tudo espera aprovação");
  assert.deepEqual(posts[0].canais, ["instagram", "facebook"]);
  assert.match(p.openaiChamadas.at(-1).corpo.input[0].content[0].text, /Clínica Sol[\s\S]*Niterói/);

  const ok = await p.req(`/api/orgs/1/mk/posts/${posts[0].id}/acao`, { metodo: "POST", quem: "admin", corpo: { acao: "aprovar" } });
  assert.equal(ok.dados.status, "APROVADO");
  const rej = await p.req(`/api/orgs/1/mk/posts/${posts[1].id}/acao`, { metodo: "POST", quem: "admin", corpo: { acao: "rejeitar", comentario: "Trocar a foto" } });
  assert.equal(rej.dados.status, "REJEITADO");

  p.openai = (url) => url.endsWith("images/generations") ? { data: [{ b64_json: Buffer.from("imagem-jpeg").toString("base64") }] } : {};
  const img = await p.req("/api/orgs/1/mk/ia/imagem", { metodo: "POST", quem: "admin", corpo: { post_id: posts[0].id } });
  assert.equal(img.status, 200);
  const arquivo = await p.req(`/api/orgs/1/mk/midias/${img.dados.midia_id}`, { quem: "admin" });
  assert.equal(arquivo.r.headers.get("content-type"), "image/jpeg");
  assert.equal(await arquivo.r.text(), "imagem-jpeg");
  const outra = await p.req(`/api/orgs/1/mk/midias/${img.dados.midia_id}`, { quem: "x" });
  assert.equal(outra.status, 401, "imagem só para quem está logado na empresa");
  assert.ok(m2.dados.id);

  // Imagem avulsa (botão "Criar imagem com IA" do Instagram/Facebook/Google), vertical, depois usada num post.
  const avulsa = await p.req("/api/orgs/1/mk/ia/imagem", { metodo: "POST", quem: "admin", corpo: { marca_id: m2.dados.id, ideia: "Cachorro feliz no banho", formato: "story" } });
  assert.equal(avulsa.status, 200);
  assert.equal(p.openaiChamadas.at(-1).corpo.size, "1024x1536", "story sai na vertical");
  const novo = await p.req("/api/orgs/1/mk/posts", { metodo: "POST", quem: "admin", corpo: { marca_id: m2.dados.id, canais: ["instagram"], titulo: "Banho", midia_id: avulsa.dados.midia_id } });
  const doPost = (await p.req("/api/orgs/1/mk/posts?marca=" + m2.dados.id, { quem: "admin" })).dados.posts.find(x => x.id === novo.dados.id);
  assert.equal(doPost.midia_id, avulsa.dados.midia_id, "a imagem criada vira a arte do novo post");
});

test("Estúdio — aprovação automática: a IA revisa e só aprova o que passa da nota mínima", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const mk = await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Central" } });
  await p.req("/api/orgs/1/mk/config", { metodo: "POST", quem: "admin", corpo: { modo: "AUTOMATICO", posts_semana: 2, nota_minima: 8 } });
  let revisoes = 0;
  p.openai = (url, corpo) => {
    if (corpo.instructions.startsWith("Você é a diretora de criação")) { revisoes++; return resposta(revisoes === 1 ? { nota: 9, aprovado: true, comentario: "Ótimo" } : { nota: 6, aprovado: false, comentario: "Legenda fraca" }); }
    return resposta({ posts: [{ dia: 1, titulo: "A", legenda: "a" }, { dia: 2, titulo: "B", legenda: "b" }] });
  };
  const r = await p.req("/api/orgs/1/mk/ia/semana", { metodo: "POST", quem: "admin", corpo: { marca_id: mk.dados.id } });
  assert.deepEqual(r.dados.criados.map(x => x.status), ["APROVADO", "AGUARDANDO"]);
  const posts = (await p.req("/api/orgs/1/mk/posts", { quem: "admin" })).dados.posts;
  assert.equal(posts[0].aprovado_por, "DENIA (aprovação automática)");
  assert.equal(posts[1].revisao.comentario, "Legenda fraca");
});

test("Estúdio — Google: resposta de avaliação pela IA, palavras-chave com posição semanal e métricas", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const mk = await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Central", cidade: "Rio de Janeiro" } });
  const av = await p.req("/api/orgs/1/mk/avaliacoes", { metodo: "POST", quem: "admin", corpo: { marca_id: mk.dados.id, autor: "Ana", nota: 2, texto: "Demoraram para responder" } });
  p.openai = () => resposta({ resposta: "Olá, Ana! Sentimos muito pela demora..." });
  const sug = await p.req(`/api/orgs/1/mk/avaliacoes/${av.dados.id}/sugerir`, { metodo: "POST", quem: "admin", corpo: {} });
  assert.match(sug.dados.resposta, /Ana/);
  await p.req(`/api/orgs/1/mk/avaliacoes/${av.dados.id}/responder`, { metodo: "POST", quem: "admin", corpo: { resposta: sug.dados.resposta } });
  assert.equal((await p.req("/api/orgs/1/mk/avaliacoes", { quem: "admin" })).dados.avaliacoes[0].status, "RESPONDIDA");
  const pk = await p.req("/api/orgs/1/mk/palavras", { metodo: "POST", quem: "admin", corpo: { marca_id: mk.dados.id, palavra: "chaveiro 24 horas" } });
  await p.req(`/api/orgs/1/mk/palavras/${pk.dados.id}/posicao`, { metodo: "POST", quem: "admin", corpo: { semana: "2026-10-15", posicao: 7 } });
  const pal = (await p.req(`/api/orgs/1/mk/palavras?marca=${mk.dados.id}`, { quem: "admin" })).dados.palavras;
  assert.deepEqual([pal[0].cidade, pal[0].posicoes[0].semana, pal[0].posicoes[0].posicao], ["Rio de Janeiro", "2026-10-12", 7]);
  await p.req("/api/orgs/1/mk/metricas", { metodo: "POST", quem: "admin", corpo: { marca_id: mk.dados.id, semana: "2026-10-12", visualizacoes: 1200, ligacoes: 14 } });
  const met = (await p.req(`/api/orgs/1/mk/metricas?marca=${mk.dados.id}`, { quem: "admin" })).dados.metricas;
  assert.equal(met[0].ligacoes, 14);
});

test("Assistente DENIA — conversa com os dados do painel e fala em voz", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste", DENIA_PLATFORM_SERVICE_TOKEN: TOKEN_ENGINE });
  p.env.ENGINE = { fetch: async (req) => p.engine.worker.fetch(req, p.engine.env, { waitUntil() { } }) };
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  let instrucoes = "";
  p.openai = (url, corpo) => {
    if (url.endsWith("audio/speech")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    instrucoes = corpo.instructions;
    return { output: [{ content: [{ type: "output_text", text: "Hoje está tudo funcionando." }] }] };
  };
  const r = await p.req("/api/orgs/1/assistente/conversa", { metodo: "POST", quem: "admin", corpo: { mensagens: [{ papel: "usuario", texto: "Como está a operação?" }] } });
  assert.equal(r.dados.resposta, "Hoje está tudo funcionando.");
  assert.match(instrucoes, /IA do WhatsApp: (funcionando|com alertas)/, "a DENIA conhece o estado real da IA");
  const voz = await p.req("/api/orgs/1/assistente/falar", { metodo: "POST", quem: "admin", corpo: { texto: "Olá" } });
  assert.equal(voz.r.headers.get("content-type"), "audio/mpeg");
  assert.match(voz.r.headers.get("permissions-policy"), /microphone=\(self\)/);
});

test("Assistente DENIA — executa comandos de voz: cria post, muda o treinamento e respeita o perfil", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste", DENIA_PLATFORM_SERVICE_TOKEN: TOKEN_ENGINE });
  p.env.ENGINE = { fetch: async (req) => p.engine.worker.fetch(req, p.engine.env, { waitUntil() { } }) };
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Clínica Sol", instagram: "@clinicasol", facebook: "Clínica Sol Niterói" } });
  let instrucoes = "";
  p.openai = (url, corpo) => {
    if (/superinteligência/.test(corpo.instructions)) {
      instrucoes = corpo.instructions;
      return { output: [{ content: [{ type: "output_text", text: JSON.stringify({ resposta: "Vou criar o post e ajustar o atendimento.", acoes: [
        { tipo: "criar_post", marca: "clinica sol", canais: ["instagram"], tema: "clareamento", data: "2026-10-20", hora: "19:00", com_arte: true },
        { tipo: "treinar", campo: "regras", modo: "acrescentar", texto: "Sempre pergunte o bairro do cliente antes de passar orçamento." }
      ] }) }] }] };
    }
    return { output: [{ content: [{ type: "output_text", text: JSON.stringify({ titulo: "Clareamento seguro", legenda: "Sorria!", hashtags: "#niteroi", chamada: "Chame", ideia_imagem: "Sorriso" }) }] }] };
  };
  const r = await p.req("/api/orgs/1/assistente/conversa", { metodo: "POST", quem: "admin", corpo: { mensagens: [{ papel: "usuario", texto: "Cria um post de clareamento e passa a pedir o bairro" }] } });
  assert.equal(r.status, 200);
  assert.match(instrucoes, /Clínica Sol[\s\S]*@clinicasol/, "a DENIA conhece as marcas e os perfis");
  assert.match(instrucoes, /TREINAMENTO ATUAL/, "e o próprio treinamento");
  assert.deepEqual(r.dados.acoes.map(a => [a.tipo, a.ok]), [["criar_post", true], ["treinar", true]]);
  assert.equal(r.dados.acoes[0].artes, true, "a tela cria a arte em seguida");
  const posts = (await p.req("/api/orgs/1/mk/posts?status=AGUARDANDO", { quem: "admin" })).dados.posts;
  assert.deepEqual(posts.map(x => [x.titulo, x.data, x.hora]), [["Clareamento seguro", "2026-10-20", "19:00"]]);
  const tr = (await p.req("/api/orgs/1/engine/training", { quem: "admin" })).dados;
  assert.match(tr.dados.regras, /bairro do cliente/, "o treinamento da IA do WhatsApp mudou pelo comando");

  // Quem é só atendente não muda o treinamento.
  const novo = await p.req("/api/orgs/1/membros", { metodo: "POST", quem: "admin", corpo: { email: "agente@denia.test", papel: "AGENTE" } });
  await p.entrar("agente", "agente@denia.test", novo.dados.senha_temporaria);
  await p.req("/api/conta", { metodo: "POST", quem: "agente", corpo: { acao: "senha", atual: novo.dados.senha_temporaria, nova: "SenhaDoAgente2026x" } });
  await p.entrar("agente", "agente@denia.test", "SenhaDoAgente2026x");
  const negado = await p.req("/api/orgs/1/assistente/conversa", { metodo: "POST", quem: "agente", corpo: { mensagens: [{ papel: "usuario", texto: "Muda o treinamento" }] } });
  assert.deepEqual(negado.dados.acoes.map(a => [a.tipo, a.ok]), [["criar_post", true], ["treinar", false]], "atendente cria post, mas não muda o treinamento");
  assert.match(negado.dados.acoes[1].resumo, /permissão/);
});

test("Site — número do WhatsApp do botão flutuante, só o administrador geral muda", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  assert.equal((await p.req("/api/publico")).dados.whatsapp, "5521975469162", "sem configurar, vai para o WhatsApp da Central");
  const ruim = await p.req("/api/admin/site", { metodo: "POST", quem: "admin", corpo: { whatsapp: "9162" } });
  assert.equal(ruim.status, 400);
  const ok = await p.req("/api/admin/site", { metodo: "POST", quem: "admin", corpo: { whatsapp: "(21) 99999-9162" } });
  assert.equal(ok.dados.whatsapp, "5521999999162");
  assert.equal((await p.req("/api/publico")).dados.whatsapp, "5521999999162");
  const anonimo = await p.req("/api/admin/site", { metodo: "POST", quem: "x", corpo: { whatsapp: "21999999999" } });
  assert.ok(anonimo.status === 401 || anonimo.status === 403);
});

test("Integrações — chave da OpenAI colada na plataforma liga o Estúdio e a voz (sem mexer na Cloudflare)", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Clínica Sol" } });
  const antes = await p.req("/api/orgs/1/mk/ia/legenda", { metodo: "POST", quem: "admin", corpo: { marca_id: 1, tema: "x" } });
  assert.equal(antes.dados.codigo, "SEM_OPENAI");
  assert.match(antes.dados.erro, /Integrações/, "o aviso diz onde colar a chave");
  assert.equal((await p.req("/api/orgs/1/ia/chave", { metodo: "POST", quem: "admin", corpo: { chave: "minha-chave" } })).status, 400);
  const chave = "sk-proj-" + "a".repeat(40) + "WXYZ";
  assert.equal((await p.req("/api/orgs/1/ia/chave", { metodo: "POST", quem: "admin", corpo: { chave } })).status, 200);
  const info = (await p.req("/api/orgs/1/ia/chave", { quem: "admin" })).dados;
  assert.deepEqual(info, { configurada: true, origem: "plataforma", final: "WXYZ" }, "a chave nunca volta inteira");
  const salvo = (await p.env.DB.prepare("SELECT valor FROM plt_meta WHERE chave='openai_org_1'").first()).valor;
  assert.ok(!salvo.includes(chave), "guardada cifrada");
  p.openai = (url) => url.endsWith("/models") ? { data: [] } : { output: [{ content: [{ type: "output_text", text: JSON.stringify({ titulo: "T", legenda: "L", hashtags: "", chamada: "", ideia_imagem: "" }) }] }] };
  const depois = await p.req("/api/orgs/1/mk/ia/legenda", { metodo: "POST", quem: "admin", corpo: { marca_id: 1, tema: "x" } });
  assert.equal(depois.status, 200);
  assert.equal((await p.req("/api/orgs/1/ia/chave/testar", { metodo: "POST", quem: "admin", corpo: {} })).dados.ok, true);
  assert.equal((await p.req("/api/orgs/1/mk/config", { quem: "admin" })).dados.ia_ligada, true);
});

test("Assistente DENIA — modo assistido devolve o plano para a tela executar à vista, e executar faz cada passo", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste", DENIA_PLATFORM_SERVICE_TOKEN: TOKEN_ENGINE });
  p.env.ENGINE = { fetch: async (req) => p.engine.worker.fetch(req, p.engine.env, { waitUntil() { } }) };
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Clínica Sol" } });
  await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Pet Feliz" } });
  p.openai = () => ({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ resposta: "Vou fazer.", acoes: [
    { tipo: "criar_semana", marca: "pet feliz", canais: ["instagram"], quantidade: 2 },
    { tipo: "treinar", campo: "regras", texto: "Peça o bairro." },
    { tipo: "criar_post", marca: "Marca que não existe" },
    { tipo: "apagar_tudo" }
  ] }) }] }] });
  const r = await p.req("/api/orgs/1/assistente/conversa", { metodo: "POST", quem: "admin", corpo: { mensagens: [{ papel: "usuario", texto: "faça" }], assistido: true } });
  const [semana, treino, ruim, desconhecida] = r.dados.plano;
  assert.deepEqual([semana.tipo, semana.marca, semana.quantidade, semana.canais], ["criar_semana", "Pet Feliz", 2, ["instagram"]]);
  assert.deepEqual([treino.campo, treino.rotulo, treino.modo], ["regras", "Regras", "acrescentar"]);
  assert.match(ruim.erro, /Não encontrei a marca/);
  assert.match(desconhecida.erro, /desconhecida/);
  assert.equal((await p.req("/api/orgs/1/mk/posts", { quem: "admin" })).dados.posts.length, 0, "no modo assistido nada é feito sem a tela");
  const pausa = await p.req("/api/orgs/1/assistente/executar", { metodo: "POST", quem: "admin", corpo: { acao: { tipo: "pausar_ia", pausar: true } } });
  assert.equal(pausa.dados.ok, true);
  assert.equal((await p.req("/api/orgs/1/engine/status", { quem: "admin" })).dados.pausa_geral, true);
});

test("Voz ao vivo — chave temporária com ferramentas, pesquisa na internet, e a chave da Central vale para as outras empresas", async () => {
  const p = await criarPlataforma({ DENIA_PLATFORM_SERVICE_TOKEN: TOKEN_ENGINE });
  p.env.ENGINE = { fetch: async (req) => p.engine.worker.fetch(req, p.engine.env, { waitUntil() { } }) };
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Clínica Sol" } });
  const sem = await p.req("/api/orgs/1/assistente/ao-vivo", { metodo: "POST", quem: "admin", corpo: {} });
  assert.equal(sem.dados.codigo, "SEM_OPENAI");
  await p.req("/api/orgs/1/ia/chave", { metodo: "POST", quem: "admin", corpo: { chave: "sk-proj-" + "b".repeat(40) } });
  let sessao = null;
  p.openai = (url, corpo) => {
    if (url.endsWith("realtime/client_secrets")) { sessao = corpo.session; return { value: "ek_temporaria", expires_at: 1 }; }
    if (corpo && corpo.tools && corpo.tools[0].type === "web_search") return { output: [{ content: [{ type: "output_text", text: "Tendência: vídeos curtos. Fonte: Exemplo." }] }] };
    return {};
  };
  const r = await p.req("/api/orgs/1/assistente/ao-vivo", { metodo: "POST", quem: "admin", corpo: {} });
  assert.deepEqual([r.dados.chave, r.dados.url], ["ek_temporaria", "https://api.openai.com/v1/realtime/calls"], "o navegador recebe só uma chave temporária");
  assert.ok(!JSON.stringify(r.dados).includes("sk-proj"), "a chave de verdade nunca vai para o navegador");
  assert.equal(sessao.audio.input.turn_detection.type, "semantic_vad", "detecta sozinho quando a pessoa terminou de falar");
  assert.deepEqual(sessao.tools.map(t => t.name), ["criar_semana", "criar_post", "aprovar_posts", "publicar_post", "treinar", "pausar_ia", "pesquisar_web", "dados_do_painel"]);
  assert.match(sessao.instructions, /Clínica Sol/);
  assert.match(sessao.instructions, /IA do WhatsApp/);
  const busca = await p.req("/api/orgs/1/assistente/pesquisar", { metodo: "POST", quem: "admin", corpo: { pergunta: "tendências" } });
  assert.match(busca.dados.resultado, /vídeos curtos/);
  const prep = await p.req("/api/orgs/1/assistente/preparar", { metodo: "POST", quem: "admin", corpo: { acao: { tipo: "criar_post", marca: "clinica", tema: "clareamento" } } });
  assert.deepEqual([prep.dados.tipo, prep.dados.marca, prep.dados.canais], ["criar_post", "Clínica Sol", ["instagram"]]);

  // Outra empresa sem chave própria usa a da Central (colada uma vez só).
  const nova = await p.req("/api/admin/organizacoes", { metodo: "POST", quem: "admin", corpo: { nome: "Outra Empresa" } });
  const k = (await p.req(`/api/orgs/${nova.dados.id}/ia/chave`, { quem: "admin" })).dados;
  assert.deepEqual([k.configurada, k.origem], [true, "central"]);
});
