// Testes da DENIA Platform: login, permissões, isolamento entre empresas e
// integração de ponta a ponta com o DENIA Engine real (em memória).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
      openaiChamadas.push({ url: String(url), corpo, form: op.body instanceof FormData ? op.body : null });
      const r = p.openai ? p.openai(String(url), corpo) : {};
      if (r instanceof Response) return r;
      return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (p && p.meta && String(url).startsWith("https://graph.facebook.com/")) {
      const corpo = op.body ? Object.fromEntries(new URLSearchParams(String(op.body))) : null;
      (p.metaChamadas ||= []).push({ url: String(url), metodo: op.method || "GET", corpo });
      const r = p.meta(String(url), op.method || "GET", corpo);
      return new Response(JSON.stringify(r), { status: r && r.error ? 400 : 200, headers: { "content-type": "application/json" } });
    }
    if (p && p.google && /^https:\/\/(oauth2|mybusiness[a-z]*|businessprofileperformance|www|searchconsole|googleads|places)\.googleapis\.com\//.test(String(url))) {
      const corpo = op.body ? (typeof op.body === "string" ? JSON.parse(op.body) : Object.fromEntries(new URLSearchParams(String(op.body)))) : null;
      (p.googleChamadas ||= []).push({ url: String(url), metodo: op.method || "GET", corpo });
      const r = p.google(String(url), op.method || "GET", corpo);
      return new Response(JSON.stringify(r), { status: r && r.error ? (r.error.code || 400) : 200, headers: { "content-type": "application/json" } });
    }
    if (p && p.asaas && /^https:\/\/api(-sandbox)?\.asaas\.com\/v3\//.test(String(url))) {
      const corpo = op.body ? JSON.parse(op.body) : null;
      (p.asaasChamadas ||= []).push({ url: String(url), metodo: op.method || "GET", corpo, headers: op.headers });
      const r = p.asaas(String(url).replace(/^https:\/\/api(-sandbox)?\.asaas\.com\/v3/, ""), op.method || "GET", corpo);
      return new Response(JSON.stringify(r), { status: r && r.errors ? 400 : 200, headers: { "content-type": "application/json" } });
    }
    if (p && p.channex && /^https:\/\/(staging|app)\.channex\.io\/api\/v1\//.test(String(url))) {
      const corpo = op.body ? JSON.parse(op.body) : null;
      (p.channexChamadas ||= []).push({ caminho: String(url).replace(/^https:\/\/(staging|app)\.channex\.io\/api\/v1/, ""), metodo: op.method || "GET", corpo });
      const r = p.channex(String(url).replace(/^https:\/\/(staging|app)\.channex\.io\/api\/v1/, ""), op.method || "GET", corpo);
      return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (p && p.web && p.web[String(url)] !== undefined) return new Response(p.web[String(url)], { status: 200, headers: { "content-type": "text/calendar" } });
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
  const banco = new D1Fake(); banco.estrito = true; // como o D1 de verdade: "undefined" num parâmetro é erro
  const env = {
    DB: banco, PLATFORM_ADMIN_EMAIL: ADMIN, PLATFORM_ADMIN_PASSWORD: SENHA_ADMIN, SESSION_SECRET: "s".repeat(40),
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
  assert.equal(entrar.status, 302, "já conectado: o login (e o ícone do aplicativo) vai direto para o painel");
  assert.equal(new URL(entrar.r.headers.get("location"), "https://x").pathname, "/app");
  assert.equal((await p.req("/entrar?trocar=1", { quem: "admin" })).status, 200, "dá para entrar com outra conta");
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
  assert.match(teste.dados.versao, /^3\d\./);

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
  // Revisor de aprendizados: aprova e rejeita o que a IA aprendeu, e não vê mais nada da empresa.
  const rev = await p.req("/api/orgs/1/membros", { metodo: "POST", quem: "admin", corpo: { email: "revisora@central.test", papel: "REVISOR" } });
  assert.equal(rev.status, 200);
  await p.entrar("revisora", "revisora@central.test", rev.dados.senha_temporaria);
  await p.req("/api/conta", { metodo: "POST", quem: "revisora", corpo: { acao: "senha", atual: rev.dados.senha_temporaria, nova: "SenhaDaRevisora2026" } });
  const sug = await p.req("/api/orgs/1/engine/learning/suggestions?status=PENDENTE", { quem: "revisora" });
  assert.equal(sug.dados.sugestoes.length, 1);
  assert.equal((await p.req("/api/orgs/1/engine/learning", { quem: "revisora" })).status, 200);
  for (const [metodo, rota] of [["GET", "engine/conversations"], ["GET", "engine/training"], ["GET", "mk/marcas"], ["GET", "membros"], ["POST", "engine/learning/start"], ["GET", "assistente/contexto"]])
    assert.equal((await p.req(`/api/orgs/1/${rota}`, { metodo, quem: "revisora", corpo: metodo === "POST" ? {} : undefined })).status, 403, `revisor sem acesso a ${rota}`);
  const ap = await p.req(`/api/orgs/1/engine/learning/suggestions/${sug.dados.sugestoes[0].id}`, { metodo: "POST", quem: "revisora", corpo: { acao: "aprovar", conteudo: "Geladeira é sempre com a assistência técnica." } });
  assert.equal(ap.status, 200);
  const t = await p.req("/api/orgs/1/engine/training", { quem: "admin" });
  assert.match(t.dados.dados.aprendizados, /Geladeira é sempre com a assistência técnica/);
  assert.match(t.dados.autor, /revisora@central\.test/);
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

test("Segurança — conta criada com o e-mail de outra pessoa não herda o acesso quando a empresa a adiciona", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  // Alguém abre conta com o e-mail do financeiro de outra empresa, antes dele.
  const golpe = await p.req("/api/cadastro", { metodo: "POST", quem: "golpista", corpo: { nome: "Xis", empresa: "Fachada", email: "cfo@vitima.test", senha: "SenhaDoGolpe2026", aceite: true } });
  assert.equal(golpe.status, 200);
  const add = await p.req("/api/orgs/1/membros", { metodo: "POST", quem: "admin", corpo: { email: "cfo@vitima.test", nome: "CFO", papel: "ADMIN" } });
  assert.equal(add.status, 200);
  assert.ok(add.dados.senha_temporaria, "ganha senha temporária nova, entregue pela equipe");
  assert.equal((await p.req("/api/eu", { quem: "golpista" })).status, 401, "a sessão de quem criou cai");
  assert.equal((await p.entrar("golpista", "cfo@vitima.test", "SenhaDoGolpe2026")).status, 401, "a senha de quem criou não vale mais");
  assert.equal((await p.entrar("cfo", "cfo@vitima.test", add.dados.senha_temporaria)).status, 200, "o dono do e-mail entra com a senha temporária");
});

test("Plataforma — criar conta: empresa própria, sem configuração e sem acesso à Central", async () => {
  const p = await criarPlataforma({ DENIA_ENGINE_URL: "https://engine.test", DENIA_PLATFORM_SERVICE_TOKEN: TOKEN_ENGINE });
  const fraca = await p.req("/api/cadastro", { metodo: "POST", quem: "novo", corpo: { nome: "Rafa", empresa: "Clínica Sol", email: "rafa@sol.test", senha: "123" } });
  assert.equal(fraca.status, 400);
  const semAceite = await p.req("/api/cadastro", { metodo: "POST", quem: "novo", corpo: { nome: "Rafa", empresa: "Clínica Sol", email: "Rafa@Sol.test", senha: "SenhaDaRafa2026" } });
  assert.equal(semAceite.status, 400, "sem aceitar os Termos não cria conta");
  const r = await p.req("/api/cadastro", { metodo: "POST", quem: "novo", corpo: { nome: "Rafa", empresa: "Clínica Sol", email: "Rafa@Sol.test", senha: "SenhaDaRafa2026", aceite: true, idioma: "pt-BR" } });
  assert.equal(r.status, 200);
  const aceite = p.env.DB.q("SELECT detalhe, ip FROM plt_auditoria WHERE acao='ACEITE'")[0];
  assert.match(aceite.detalhe, /Termos de uso 2026-10/, "o aceite fica registrado com a versão");
  const eu = await p.req("/api/eu", { quem: "novo" });
  assert.deepEqual(eu.dados.organizacoes.map(o => [o.nome, o.papel, o.conectada]), [["Clínica Sol", "OWNER", false]]);
  const id = eu.dados.organizacoes[0].id;
  assert.equal((await p.req(`/api/orgs/${id}/engine/training`, { quem: "novo" })).dados.codigo, "ENGINE_NAO_CONFIGURADO");
  assert.equal((await p.req("/api/orgs/1/engine/training", { quem: "novo" })).status, 404, "não vê a IA da Central");
  const repetido = await p.req("/api/cadastro", { metodo: "POST", corpo: { nome: "Xavier", empresa: "Ypsilon", email: "rafa@sol.test", senha: "SenhaDaRafa2026", aceite: true } });
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
  assert.match(r.r.headers.get("set-cookie"), /Max-Age=7776000/, "90 dias");
  // Abrir o painel com a sessão longa já usada há mais de um mês renova por mais 90 dias.
  const app1 = await p.req("/app", { quem: "a" });
  assert.equal(app1.r.headers.get("set-cookie"), null, "sessão nova não precisa renovar");
  const agoraReal = Date.now;
  Date.now = () => agoraReal() + 40 * 86400000;
  try {
    const app2 = await p.req("/app", { quem: "a" });
    assert.match(app2.r.headers.get("set-cookie") || "", /Max-Age=7776000/, "renovada");
  } finally { Date.now = agoraReal; }
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

test("Artes — logo oficial vai junto, qualidade alta, texto da arte conferido e refeito se vier errado; horários preferidos", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Clínica Sol", cores: "azul e dourado", horarios: "terça e quinta às 19h", ofertas: "Clareamento dental em 3x sem juros" } })).dados.id;

  // Logo: só imagem de verdade (PNG/JPG/WEBP); aparece na marca.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("resto-do-png")]).toString("base64");
  assert.equal((await p.req(`/api/orgs/1/mk/marcas/${marca}/logo`, { metodo: "POST", quem: "admin", corpo: { dados: Buffer.from("<svg>").toString("base64") } })).status, 400);
  assert.equal((await p.req(`/api/orgs/1/mk/marcas/${marca}/logo`, { metodo: "POST", quem: "admin", corpo: { dados: "data:image/png;base64," + png } })).status, 200);
  const m = (await p.req("/api/orgs/1/mk/marcas", { quem: "admin" })).dados.marcas[0];
  assert.ok(m.logo_midia_id);
  assert.equal(m.horarios, "terça e quinta às 19h");

  // Semana: os horários preferidos e o texto da arte entram no pedido à IA.
  p.openai = () => ({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ posts: [{ dia: 1, hora: "19:00", formato: "post", titulo: "Sorriso", legenda: "L", hashtags: "", chamada: "", texto_arte: "Seu sorriso merece cuidado", ideia_imagem: "Dentista sorrindo" }] }) }] }] });
  const sem = await p.req("/api/orgs/1/mk/ia/semana", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, inicio: "2030-01-07" } });
  const pedido = JSON.stringify(p.openaiChamadas.at(-1).corpo);
  assert.match(pedido, /terça e quinta às 19h/);
  assert.match(pedido, /Clareamento dental em 3x sem juros/, "as ofertas reais da marca entram na legenda");
  assert.match(pedido, /Legenda que VENDE/);
  const post = sem.dados.criados[0].id;
  assert.equal(p.env.DB.q("SELECT texto_arte FROM plt_mk_posts WHERE id=?", post)[0].texto_arte, "Seu sorriso merece cuidado");

  // Arte: vai pela edição de imagem com a logo anexada, qualidade alta; a revisão acha erro e a DENIA refaz uma vez.
  let conferencias = 0;
  p.openai = (url) => {
    if (url.endsWith("images/edits")) return { data: [{ b64_json: Buffer.from("arte-" + conferencias).toString("base64") }] };
    if (url.endsWith("responses")) { conferencias++; return { output: [{ content: [{ type: "output_text", text: JSON.stringify(conferencias === 1 ? { correto: false, problemas: "Escreveu \"sorizo\" sem o segundo r." } : { correto: true, problemas: "" }) }] }] }; }
    return { error: { message: "inesperado " + url } };
  };
  const arte = await p.req("/api/orgs/1/mk/ia/imagem", { metodo: "POST", quem: "admin", corpo: { post_id: post } });
  assert.equal(arte.status, 200);
  assert.deepEqual(arte.dados.conferencia, { correto: true, problemas: "" });
  const edicoes = p.openaiChamadas.filter(c => c.url.endsWith("images/edits"));
  assert.equal(edicoes.length, 2, "refez a arte depois da revisão");
  const form = edicoes[1].form;
  assert.equal(form.get("quality"), "high");
  assert.equal(form.get("input_fidelity"), "high");
  assert.ok(form.get("image[]") instanceof Blob, "a logo vai anexada");
  assert.match(form.get("prompt"), /exatamente, "Seu sorriso merece cuidado"/);
  assert.match(form.get("prompt"), /correção obrigatória da tentativa anterior: Escreveu "sorizo"/);
  const visao = p.openaiChamadas.find(c => c.url.endsWith("responses") && JSON.stringify(c.corpo).includes("input_image"));
  assert.ok(visao, "a revisão olha a imagem pronta");
  assert.equal(await (await p.req(`/api/orgs/1/mk/midias/${arte.dados.midia_id}`, { quem: "admin" })).r.text(), "arte-1");

  // Sem logo e sem texto: arte direta, sem revisão de texto.
  await p.req(`/api/orgs/1/mk/marcas/${marca}/logo`, { metodo: "POST", quem: "admin", corpo: { remover: true } });
  p.openai = (url) => url.endsWith("images/generations") ? { data: [{ b64_json: Buffer.from("x").toString("base64") }] } : { error: { message: "inesperado" } };
  const simples = await p.req("/api/orgs/1/mk/ia/imagem", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, ideia: "Consultório claro" } });
  assert.equal(simples.status, 200);
  assert.equal(simples.dados.conferencia, null);
  assert.match(p.openaiChamadas.at(-1).corpo.prompt, /não escreva nenhuma palavra/);
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
  assert.deepEqual(sessao.tools.map(t => t.name), ["criar_semana", "criar_post", "aprovar_posts", "publicar_post", "treinar", "pausar_ia", "google_resumo", "atualizar_google", "responder_avaliacoes", "relatorio_google", "pesquisar_web", "tp_resumo", "tp_precos", "tp_disponibilidade", "tp_config", "tp_estoque", "tp_nota", "tp_cotacao", "tp_mercado", "dados_do_painel"]);
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

test("Idiomas — cada marca cria no seu idioma e a DENIA responde no idioma do painel", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const m = await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Sakura Dental", idioma: "ja" } });
  const ruim = await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Outra", idioma: "klingon" } });
  const lista = (await p.req("/api/orgs/1/mk/marcas", { quem: "admin" })).dados.marcas;
  assert.deepEqual(lista.map(x => [x.nome, x.idioma]), [["Outra", "pt-BR"], ["Sakura Dental", "ja"]], "idioma inválido vira português");
  let instr = "";
  p.openai = (url, corpo) => { instr = JSON.stringify(corpo); return { output: [{ content: [{ type: "output_text", text: JSON.stringify({ titulo: "t", legenda: "l", hashtags: "", chamada: "", ideia_imagem: "" }) }] }] }; };
  await p.req("/api/orgs/1/mk/ia/legenda", { metodo: "POST", quem: "admin", corpo: { marca_id: m.dados.id, tema: "limpeza" } });
  assert.match(instr, /IDIOMA DO CONTEÚDO: japonês/);
  assert.ok(ruim.dados.id);
  const r = await p.req("/api/orgs/1/assistente/conversa", { metodo: "POST", quem: "admin", cabecalhos: { "x-denia-idioma": "de" }, corpo: { mensagens: [{ papel: "usuario", texto: "Hallo" }] } });
  assert.equal(r.status, 200);
  assert.match(instr, /alemão \(Deutsch\)/, "a DENIA fala alemão quando o painel está em alemão");
});

test("Site — páginas, scripts e dicionários de idioma sempre conferem se há versão nova", async () => {
  const p = await criarPlataforma();
  for (const c of ["/", "/assets/i18n/ja.json", "/assets/js/site.js", "/termos"]) {
    const r = await p.req(c);
    assert.equal(r.r.headers.get("cache-control"), "no-cache", c);
  }
});

test("Conversas — a equipe marca um contato como profissional pela plataforma", async () => {
  const p = await criarPlataforma({ DENIA_PLATFORM_SERVICE_TOKEN: TOKEN_ENGINE });
  p.env.ENGINE = { fetch: async (req) => p.engine.worker.fetch(req, p.engine.env, { waitUntil() { } }) };
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  p.engine.llmCliente = () => ({ resposta: "Oi!", intencao: "CONVERSA", fatos: {} });
  await p.engine.cliente("5521977776666", "Oi");
  const id = (await p.req("/api/orgs/1/engine/conversations", { quem: "admin" })).dados.conversas[0].pessoa_id;
  const r = await p.req(`/api/orgs/1/engine/conversations/${id}/type`, { metodo: "POST", quem: "admin", corpo: { tipo: "TECNICO", prestador_id: "CHAV-ANDERSON" } });
  assert.equal(r.status, 200);
  const d = (await p.req(`/api/orgs/1/engine/conversations/${id}`, { quem: "admin" })).dados;
  assert.deepEqual([d.pessoa.tipo, d.pessoa.profissional, d.pessoa.oficial], ["TECNICO", "Anderson (chaveiro)", false]);
  const aud = p.env.DB.q("SELECT detalhe FROM plt_auditoria WHERE acao='CONVERSA'").map(x => x.detalhe);
  assert.ok(aud.some(x => /type/.test(x)), "fica na auditoria");
});


test("Instagram e Facebook — conectar a marca pela Meta, publicar no horário (cron) e Publicar agora", async () => {
  const p = await criarPlataforma({ META_APP_ID: "123456", META_APP_SECRET: "segredo-do-app" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Clínica Sol" } })).dados.id;
  assert.equal((await p.req("/api/orgs/1/mk/meta/estado", { quem: "admin" })).dados.configurada, true);

  // 1) Conectar: vai para o diálogo da Meta com um state assinado.
  const ida = await p.req(`/api/orgs/1/mk/meta/conectar?marca=${marca}`, { quem: "admin" });
  assert.equal(ida.status, 302);
  const dialogo = new URL(ida.r.headers.get("location"));
  assert.equal(dialogo.hostname, "www.facebook.com");
  assert.equal(dialogo.searchParams.get("redirect_uri"), "https://plataforma.test/api/meta/retorno");
  assert.match(dialogo.searchParams.get("scope"), /instagram_content_publish/);
  const state = dialogo.searchParams.get("state");

  // 2) A Meta devolve (sem cookie: SameSite=Strict) e a plataforma troca o código pelos acessos.
  p.meta = (url) => {
    if (url.includes("oauth/access_token") && url.includes("code=")) return { access_token: "curto" };
    if (url.includes("oauth/access_token")) return { access_token: "longo" };
    if (url.includes("me/accounts")) return { data: [{ id: "PAG1", name: "Clínica Sol Niterói", access_token: "token-da-pagina", instagram_business_account: { id: "IG1", username: "clinicasol" } }] };
    return { error: { message: "inesperado " + url } };
  };
  const volta = await p.req(`/api/meta/retorno?code=abc&state=${encodeURIComponent(state)}`);
  const html = await volta.r.text();
  const nonce = html.match(/\/app#\/marcas\/meta-([A-Za-z0-9_-]+)/)[1];
  assert.ok(nonce, "volta para a plataforma escolher a página");
  assert.equal((await p.req(`/api/meta/retorno?code=abc&state=${encodeURIComponent(state)}`)).r.status, 200);
  const pags = (await p.req(`/api/orgs/1/mk/meta/paginas?n=${nonce}`, { quem: "admin" })).dados.paginas;
  assert.deepEqual(pags, [{ id: "PAG1", nome: "Clínica Sol Niterói", ig_id: "IG1", ig_usuario: "clinicasol" }], "o token nunca vai para o navegador");
  const esc = await p.req("/api/orgs/1/mk/meta/escolher", { metodo: "POST", quem: "admin", corpo: { n: nonce, pagina_id: "PAG1" } });
  assert.deepEqual([esc.dados.pagina, esc.dados.instagram], ["Clínica Sol Niterói", "clinicasol"]);
  const salvo = p.env.DB.q("SELECT token_cifrado FROM plt_mk_contas")[0].token_cifrado;
  assert.ok(!salvo.includes("token-da-pagina"), "token guardado cifrado");
  assert.equal((await p.req(`/api/orgs/1/mk/meta/paginas?n=${nonce}`, { quem: "admin" })).status, 410, "uso único");

  // 3) Post aprovado com arte, no horário: o cron publica no Instagram e no Facebook.
  p.env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms) VALUES(1,'image/jpeg',?, 'x', 1)").bind(Buffer.from("JPEGDATA").toString("base64")).run();
  const post = (await p.req("/api/orgs/1/mk/posts", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, canais: ["instagram", "facebook"], data: "2099-03-07", hora: "09:30", titulo: "Sorriso", legenda: "Cuide do seu sorriso", hashtags: "#niteroi", midia_id: 1 } })).dados.id;
  const aprov = await p.req(`/api/orgs/1/mk/posts/${post}/acao`, { metodo: "POST", quem: "admin", corpo: { acao: "aprovar" } });
  assert.equal(aprov.dados.publicado, false);
  assert.match(aprov.dados.resumo, /sai sozinho em 07\/03 às 09:30/, "ao aprovar, diz quando vai sair");
  let imagem = "";
  p.meta = (url, metodo, corpo) => {
    if (url.includes("/IG1/media_publish")) return { id: "IGPOST1" };
    if (url.includes("/IG1/media")) { imagem = corpo.image_url; assert.equal(corpo.caption, "Cuide do seu sorriso\n\n#niteroi"); return { id: "CONT1" }; }
    if (url.includes("/IGPOST1")) return { permalink: "https://www.instagram.com/p/abc/" };
    if (url.includes("/PAG1/photos")) return { id: "FOTO1", post_id: "PAG1_99" };
    return { error: { message: "inesperado " + url } };
  };
  // data do post no passado distante: não sai sozinho (mais de 48 h) — ajusta para agora
  const agora = new Date(Date.now() - 3 * 3600000).toISOString();
  p.env.DB.prepare("UPDATE plt_mk_posts SET data=?, hora=? WHERE id=?").bind(agora.slice(0, 10), agora.slice(11, 16), post).run();
  const mod = await import("../src/worker.js");
  await mod.default.scheduled({}, p.env, { waitUntil: (pr) => pr });
  await new Promise(r => setTimeout(r, 50));
  const depois = p.env.DB.q("SELECT status, publicacao FROM plt_mk_posts WHERE id=?", post)[0];
  assert.equal(depois.status, "PUBLICADO");
  const pub = JSON.parse(depois.publicacao);
  assert.deepEqual([pub.instagram.link, pub.facebook.link], ["https://www.instagram.com/p/abc/", "https://www.facebook.com/PAG1_99"]);

  // 4) A imagem tem um link público e assinado que o Instagram consegue baixar; link adulterado não abre.
  const caminho = new URL(imagem).pathname;
  const arq = await p.req(caminho);
  assert.equal(arq.r.headers.get("content-type"), "image/jpeg");
  assert.equal(await arq.r.text(), "JPEGDATA");
  assert.equal((await p.req(caminho.replace(/-[A-Za-z0-9_-]{4}/, "-XXXX"))).status, 404);

  // 5) Publicar agora com erro do Instagram: post continua aprovado e o erro aparece.
  const outro = (await p.req("/api/orgs/1/mk/posts", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, canais: ["instagram"], data: "2030-01-01", hora: "09:00", titulo: "Outro", legenda: "x", midia_id: 1 } })).dados.id;
  await p.req(`/api/orgs/1/mk/posts/${outro}/acao`, { metodo: "POST", quem: "admin", corpo: { acao: "aprovar" } });
  p.meta = () => ({ error: { message: "Invalid OAuth access token", code: 190 } });
  const falha = await p.req(`/api/orgs/1/mk/posts/${outro}/publicar`, { metodo: "POST", quem: "admin", corpo: {} });
  assert.equal(falha.status, 502);
  assert.match(falha.dados.resumo, /expirou ou foi removido/);
  assert.equal(p.env.DB.q("SELECT status FROM plt_mk_posts WHERE id=?", outro)[0].status, "APROVADO");

  // 6) Aprovar um post cujo horário já chegou: publica na hora e diz o resultado.
  p.meta = (url) => {
    if (url.includes("/PAG1/photos")) return { id: "FOTO2", post_id: "PAG1_100" };
    return { error: { message: "inesperado " + url } };
  };
  const jaPassou = (await p.req("/api/orgs/1/mk/posts", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, canais: ["facebook"], data: "2020-01-01", hora: "09:00", titulo: "Atrasado", legenda: "y", midia_id: 1 } })).dados.id;
  const na_hora = await p.req(`/api/orgs/1/mk/posts/${jaPassou}/acao`, { metodo: "POST", quem: "admin", corpo: { acao: "aprovar" } });
  assert.equal(na_hora.dados.publicado, true);
  assert.match(na_hora.dados.resumo, /^Post aprovado e publicado\. Facebook: https:\/\/www\.facebook\.com\/PAG1_100/);
  assert.equal(p.env.DB.q("SELECT status FROM plt_mk_posts WHERE id=?", jaPassou)[0].status, "PUBLICADO");
});

test("Aprovar sem a marca conectada avisa que falta conectar", async () => {
  const p = await criarPlataforma({ META_APP_ID: "123456", META_APP_SECRET: "segredo-do-app" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Clínica Sol" } })).dados.id;
  const post = (await p.req("/api/orgs/1/mk/posts", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, canais: ["instagram"], data: "2020-01-01", hora: "09:00", titulo: "x", legenda: "x" } })).dados.id;
  const r = await p.req(`/api/orgs/1/mk/posts/${post}/acao`, { metodo: "POST", quem: "admin", corpo: { acao: "aprovar" } });
  assert.equal(r.dados.publicado, false);
  assert.match(r.dados.resumo, /ainda não está conectada/);
  assert.equal(p.env.DB.q("SELECT status FROM plt_mk_posts WHERE id=?", post)[0].status, "APROVADO");
});

test("Google Meu Negócio — conectar o perfil, trazer avaliações e desempenho, responder no Google e publicar post", async () => {
  const p = await criarPlataforma({ GOOGLE_CLIENT_ID: "cliente.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "segredo-google" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Oficina", site: "https://oficina.test" } })).dados.id;
  assert.equal((await p.req("/api/orgs/1/mk/google/estado", { quem: "admin" })).dados.configurada, true);
  const ida = await p.req(`/api/orgs/1/mk/google/conectar?marca=${marca}`, { quem: "admin" });
  assert.equal(ida.status, 302);
  const dialogo = new URL(ida.r.headers.get("location"));
  assert.equal(dialogo.hostname, "accounts.google.com");
  assert.equal(dialogo.searchParams.get("redirect_uri"), "https://plataforma.test/api/google/retorno");
  assert.equal(dialogo.searchParams.get("access_type"), "offline");
  assert.match(dialogo.searchParams.get("scope"), /business\.manage/);
  const state = dialogo.searchParams.get("state");

  let respondida = null;
  p.google = (url, metodo, corpo) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return corpo.grant_type === "authorization_code" ? { access_token: "ya29.a", refresh_token: "1//permanente", expires_in: 3599 } : { access_token: "ya29.b", expires_in: 3599 };
    if (url.includes("/v1/accounts?")) return { accounts: [{ name: "accounts/111", accountName: "Oficina" }] };
    if (url.includes("/accounts/111/locations?")) return { locations: [{ name: "locations/222", title: "Oficina SEO Brasil", storefrontAddress: { addressLines: ["Rua A, 10"], locality: "Niterói" } }] };
    if (url.endsWith("/accounts/111/locations/222/reviews/r1/reply") && metodo === "PUT") { respondida = corpo.comment; return { comment: corpo.comment }; }
    if (url.includes("/accounts/111/locations/222/reviews?")) return { reviews: [
      { reviewId: "r1", reviewer: { displayName: "Ana" }, starRating: "FIVE", comment: "Atendimento excelente!", createTime: "2026-10-01T10:00:00Z" },
      { reviewId: "r2", reviewer: { displayName: "Bruno" }, starRating: "TWO", comment: "Demorou.", createTime: "2026-10-02T10:00:00Z", reviewReply: { comment: "Sentimos muito, Bruno." } }] };
    if (url.includes(":fetchMultiDailyMetricsTimeSeries")) return { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
      { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ value: "3" }, { value: "2" }] } },
      { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_MAPS", timeSeries: { datedValues: [{ value: "40" }, {}] } },
      { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", timeSeries: { datedValues: [{ value: "10" }] } }] }] };
    if (url.includes("/searchkeywords/impressions/monthly")) return { searchKeywordsCounts: [{ searchKeyword: "marketing niteroi", insightsValue: { value: "120" } }, { searchKeyword: "agencia seo", insightsValue: { threshold: "15" } }] };
    if (url.endsWith("/accounts/111/locations/222/localPosts") && metodo === "POST") return { name: "accounts/111/locations/222/localPosts/9", searchUrl: "https://local.google.com/place?id=9" };
    return { error: { code: 404, message: "inesperado " + url } };
  };
  const volta = await p.req(`/api/google/retorno?code=abc&state=${encodeURIComponent(state)}`);
  const nonce = (await volta.r.text()).match(/\/app#\/marcas\/google-([A-Za-z0-9_-]+)/)[1];
  const locais = (await p.req(`/api/orgs/1/mk/google/locais?n=${nonce}`, { quem: "admin" })).dados.locais;
  assert.deepEqual(locais, [{ id: "locations/222", titulo: "Oficina SEO Brasil", endereco: "Rua A, 10, Niterói" }]);
  const esc = await p.req("/api/orgs/1/mk/google/escolher", { metodo: "POST", quem: "admin", corpo: { n: nonce, local_id: "locations/222" } });
  assert.equal(esc.dados.perfil, "Oficina SEO Brasil");
  assert.equal(esc.dados.sincronizacao.avaliacoes_total, 2);
  assert.ok(!p.env.DB.q("SELECT token_cifrado FROM plt_mk_google")[0].token_cifrado.includes("permanente"), "token guardado cifrado");

  // Avaliações vieram do Google; responder publica no perfil.
  const avs = (await p.req(`/api/orgs/1/mk/avaliacoes?marca=${marca}`, { quem: "admin" })).dados.avaliacoes;
  const ana = avs.find(a => a.autor === "Ana"), bruno = avs.find(a => a.autor === "Bruno");
  assert.equal(ana.status, "PENDENTE"); assert.equal(bruno.status, "RESPONDIDA");
  const resp = await p.req(`/api/orgs/1/mk/avaliacoes/${ana.id}/responder`, { metodo: "POST", quem: "admin", corpo: { resposta: "Obrigada, Ana!" } });
  assert.equal(resp.dados.publicada_google, true);
  assert.equal(respondida, "Obrigada, Ana!");
  // "Buscar e responder agora" sem a chave da OpenAI: traz as avaliações e explica o que falta.
  const agoraR = await p.req("/api/orgs/1/mk/google/agora", { metodo: "POST", quem: "admin", corpo: { marca_id: marca } });
  assert.equal(agoraR.dados.avaliacoes_total, 2);
  assert.match(agoraR.dados.aviso, /falta a chave da OpenAI/);
  // Sincronizar de novo não duplica.
  await p.req("/api/orgs/1/mk/google/sincronizar", { metodo: "POST", quem: "admin", corpo: { marca_id: marca } });
  assert.equal((await p.req(`/api/orgs/1/mk/avaliacoes?marca=${marca}`, { quem: "admin" })).dados.avaliacoes.length, 2);

  // Avaliação que some do Google (denúncia aceita) fica marcada como removida.
  const googleAntes = p.google;
  p.google = (url, metodo, corpo) => url.includes("/reviews?") ? { reviews: [{ reviewId: "r2", reviewer: { displayName: "Bruno" }, starRating: "TWO", comment: "Demorou.", reviewReply: { comment: "Sentimos muito, Bruno." } }] } : googleAntes(url, metodo, corpo);
  const sinc2 = await p.req("/api/orgs/1/mk/google/sincronizar", { metodo: "POST", quem: "admin", corpo: { marca_id: marca } });
  assert.equal(sinc2.dados.avaliacoes_removidas, 1);
  assert.ok((await p.req(`/api/orgs/1/mk/avaliacoes?marca=${marca}`, { quem: "admin" })).dados.avaliacoes.find(a => a.autor === "Ana").removida_ms);
  p.google = googleAntes;
  await p.req("/api/orgs/1/mk/google/sincronizar", { metodo: "POST", quem: "admin", corpo: { marca_id: marca } });
  assert.equal((await p.req(`/api/orgs/1/mk/avaliacoes?marca=${marca}`, { quem: "admin" })).dados.avaliacoes.find(a => a.autor === "Ana").removida_ms, null, "se voltar a aparecer, deixa de contar como removida");
  // Desempenho: semanas gravadas e números ao vivo com as buscas do mês.
  const sem = (await p.req(`/api/orgs/1/mk/metricas?marca=${marca}`, { quem: "admin" })).dados.metricas;
  assert.equal(sem.length, 2);
  assert.equal(sem[0].ligacoes, 5);
  const des = (await p.req(`/api/orgs/1/mk/google/desempenho?marca=${marca}`, { quem: "admin" })).dados;
  assert.equal(des.totais.visualizacoes, 50);
  assert.deepEqual(des.palavras[0], { palavra: "marketing niteroi", buscas: 120, menos_de: null });
  // Outros períodos: 60 dias com comparação, datas escolhidas e o limite de 18 meses do Google.
  const pedidos = [];
  const googleD = p.google;
  p.google = (url, metodo, corpo) => {
    if (url.includes(":fetchMultiDailyMetricsTimeSeries")) {
      pedidos.push(url);
      const de = url.match(/startDate\.year=(\d+)&dailyRange\.startDate\.month=(\d+)&dailyRange\.startDate\.day=(\d+)/);
      const data = { year: +de[1], month: +de[2], day: +de[3] };
      return { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
        { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_MAPS", timeSeries: { datedValues: [{ date: data, value: "30" }] } },
        { dailyMetric: "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", timeSeries: { datedValues: [{ date: data, value: "10" }] } },
        { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ date: data, value: "4" }] } },
        { dailyMetric: "BUSINESS_BOOKINGS", timeSeries: { datedValues: [{ date: data, value: "1" }] } }] }] };
    }
    return googleD(url, metodo, corpo);
  };
  const d60 = (await p.req(`/api/orgs/1/mk/google/desempenho?marca=${marca}&dias=60`, { quem: "admin" })).dados;
  assert.equal(d60.dias, 60);
  assert.equal(d60.diario.length, 60);
  assert.equal(d60.totais.visualizacoes, 40);
  assert.equal(d60.totais.interacoes, 5);
  assert.equal(d60.detalhe.maps_celular, 30);
  assert.equal(d60.diario[0].visualizacoes, 40, "o valor cai no dia certo");
  assert.equal(d60.comparacao.modo, "anterior");
  assert.equal(new Date(d60.comparacao.ate + "T00:00:00Z").getTime(), new Date(d60.de + "T00:00:00Z").getTime() - 86400000, "o período anterior termina no dia antes");
  assert.equal(d60.comparacao.diario.length, 60);
  assert.ok(pedidos.some(u => u.includes("dailyMetrics=BUSINESS_BOOKINGS")));
  const escolhido = (await p.req(`/api/orgs/1/mk/google/desempenho?marca=${marca}&de=2026-01-01&ate=2026-01-31&comparar=ano`, { quem: "admin" })).dados;
  assert.equal(escolhido.de, "2026-01-01"); assert.equal(escolhido.ate, "2026-01-31"); assert.equal(escolhido.dias, 31);
  assert.equal(escolhido.comparacao.modo, "ano");
  assert.ok(escolhido.comparacao.de === "2025-01-01" || escolhido.comparacao.indisponivel, "ano passado ou aviso dos 18 meses");
  const longo = (await p.req(`/api/orgs/1/mk/google/desempenho?marca=${marca}&dias=5000`, { quem: "admin" })).dados;
  assert.equal(longo.dias, 540, "no máximo 18 meses");
  assert.ok(longo.comparacao.indisponivel, "sem comparação além dos 18 meses");
  p.google = googleD;

  // Post para o Google: aprovar com o horário já chegado publica no perfil, com o botão para o site.
  p.env.DB.prepare("INSERT INTO plt_mk_midias(org_id,mime,dados,prompt,criado_ms) VALUES(1,'image/jpeg',?, 'x', 1)").bind(Buffer.from("JPEG").toString("base64")).run();
  const post = (await p.req("/api/orgs/1/mk/posts", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, canais: ["google"], formato: "google", data: "2020-01-01", hora: "09:00", titulo: "Novidade", legenda: "Agora atendemos em Niterói!", midia_id: 1 } })).dados.id;
  const ap = await p.req(`/api/orgs/1/mk/posts/${post}/acao`, { metodo: "POST", quem: "admin", corpo: { acao: "aprovar" } });
  assert.equal(ap.dados.publicado, true);
  assert.match(ap.dados.resumo, /Google: https:\/\/local\.google\.com/);
  const envio = p.googleChamadas.find(c => c.url.endsWith("/localPosts"));
  assert.equal(envio.corpo.summary, "Agora atendemos em Niterói!");
  assert.deepEqual(envio.corpo.callToAction, { actionType: "LEARN_MORE", url: "https://oficina.test" });
  assert.match(envio.corpo.media[0].sourceUrl, /^https:\/\/plataforma\.test\/m\/1-/);
});

test("Avaliações — a DENIA lê cada uma no contexto, avisa quando precisa de uma pessoa e nunca publica sozinha as graves", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste", RESEND_API_KEY: "re_teste", EMAIL_REMETENTE: "DENIA <nao-responda@denia.test>" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Oficina" } })).dados.id;
  const boa = (await p.req("/api/orgs/1/mk/avaliacoes", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, autor: "Ana", nota: 5, texto: "Atendimento rápido e muito educado!" } })).dados.id;
  const ruim = (await p.req("/api/orgs/1/mk/avaliacoes", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, autor: "Concorrente X", nota: 1, texto: "Nunca usei, mas soube que são ladrões." } })).dados.id;
  const respostaIA = (entrada) => /ladrões/.test(entrada)
    ? { sentimento: "GRAVE", temas: ["acusação"], resumo: "Acusa sem ter sido cliente.", urgencia: "ALTA", precisa_humano: true, motivo_humano: "Confirmar se é cliente.", viola_politica: true, politica: "conflito de interesses / avaliação falsa", como_remover: "Denunciar avaliação no Perfil da Empresa.", resposta: "Não localizamos seu atendimento; fale conosco no WhatsApp." }
    : { sentimento: "OTIMA", temas: ["rapidez", "educação"], resumo: "Elogio à rapidez.", urgencia: "BAIXA", precisa_humano: false, viola_politica: false, resposta: "Ana, que alegria saber que o atendimento foi rápido e educado! Volte sempre." };
  p.openai = (url, corpo) => ({ output: [{ content: [{ type: "output_text", text: JSON.stringify(respostaIA(corpo?.input?.[0]?.content?.[0]?.text || "")) }] }] });

  // Cron: lê as novas, guarda a análise e a resposta sugerida, e avisa os responsáveis por e-mail.
  const mod = await import("../src/worker.js");
  await mod.default.scheduled({}, p.env, { waitUntil: (pr) => pr });
  await new Promise(r => setTimeout(r, 50));
  const avs = (await p.req(`/api/orgs/1/mk/avaliacoes?marca=${marca}`, { quem: "admin" })).dados.avaliacoes;
  const a1 = avs.find(a => a.id === boa), a2 = avs.find(a => a.id === ruim);
  assert.equal(JSON.parse(a1.analise).sentimento, "OTIMA");
  assert.match(a1.resposta_sugerida, /rápido e educado/, "resposta específica à avaliação");
  assert.equal(JSON.parse(a2.analise).viola_politica, true);
  assert.equal((await p.req("/api/orgs/1/mk/alertas", { quem: "admin" })).dados.avaliacoes, 1);
  assert.ok(p.emails.some(e => /precisa de você/.test(e.subject) && /Concorrente X/.test(e.text) && /regras do Google/.test(e.text)));

  // Pela DENIA do painel: "responda e publique" publica a boa e segura a grave.
  const r = await p.req("/api/orgs/1/assistente/executar", { metodo: "POST", quem: "admin", corpo: { acao: { tipo: "responder_avaliacoes", marca: "Oficina", publicar: true } } });
  assert.match(r.dados.resumo, /1 resposta\(s\) publicada/);
  assert.match(r.dados.resumo, /Concorrente X \(1★\): Confirmar se é cliente/);
  const depois = (await p.req(`/api/orgs/1/mk/avaliacoes?marca=${marca}`, { quem: "admin" })).dados.avaliacoes;
  assert.equal(depois.find(a => a.id === boa).status, "RESPONDIDA");
  assert.equal(depois.find(a => a.id === ruim).status, "PENDENTE");
  // As próximas aprendem com as respostas já dadas pela empresa.
  let pedido = "";
  p.openai = (url, corpo) => { pedido = corpo?.input?.[0]?.content?.[0]?.text || ""; return { output: [{ content: [{ type: "output_text", text: JSON.stringify(respostaIA(pedido)) }] }] }; };
  const nova = (await p.req("/api/orgs/1/mk/avaliacoes", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, autor: "Carla", nota: 4, texto: "Bom serviço." } })).dados.id;
  await p.req(`/api/orgs/1/mk/avaliacoes/${nova}/sugerir`, { metodo: "POST", quem: "admin", corpo: {} });
  assert.match(pedido, /RESPOSTAS QUE A EMPRESA JÁ DEU[\s\S]*Ana, que alegria/);
  await p.req(`/api/orgs/1/mk/avaliacoes/${nova}/remover`, { metodo: "POST", quem: "admin", corpo: {} });
  const resumo = await p.req("/api/orgs/1/assistente/executar", { metodo: "POST", quem: "admin", corpo: { acao: { tipo: "google_resumo", marca: "Oficina" } } });
  assert.match(resumo.dados.resumo, /nota média 3 em 2 avaliações[\s\S]*Precisam de uma pessoa: Concorrente X/);

  // Relatório de especialista sob demanda.
  p.openai = () => ({ output: [{ content: [{ type: "output_text", text: "RESUMO DA SEMANA\nTudo certo." }] }] });
  const rel = await p.req("/api/orgs/1/mk/relatorios/gerar", { metodo: "POST", quem: "admin", corpo: { marca_id: marca } });
  assert.match(rel.dados.texto, /RESUMO DA SEMANA/);
  assert.equal((await p.req(`/api/orgs/1/mk/relatorios?marca=${marca}`, { quem: "admin" })).dados.relatorios.length, 1);
});

test("Avaliações no automático — a DENIA responde sozinha no Google as normais e segura as graves", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Oficina" } })).dados.id;
  // Perfil já conectado (como depois de "Conectar Google").
  await p.req("/api/orgs/1/mk/google/estado", { quem: "admin" });
  const mod = await import("../src/worker.js");
  p.env.DB.prepare("INSERT INTO plt_mk_google(org_id,marca_id,conta_nome,local_nome,local_titulo,token_cifrado,criado_ms,atualizado_ms) VALUES(1,?,?,?,?,?,1,1)").bind(marca, "accounts/1", "locations/2", "Oficina", "x").run();
  // Uma avaliação que já estava lida e esperando, de antes de ligar o automático, também sai.
  p.env.DB.prepare("INSERT INTO plt_mk_avaliacoes(org_id,marca_id,autor,nota,texto,resposta_sugerida,status,criado_ms,google_id,analise) VALUES(1,?,?,?,?,?,'PENDENTE',1,?,?)")
    .bind(marca, "Bia", 5, "Amei!", "Bia, que bom que amou! Volte sempre.", "antiga", JSON.stringify({ sentimento: "OTIMA", urgencia: "BAIXA", precisa_humano: false, viola_politica: false })).run();
  assert.equal((await p.req("/api/orgs/1/mk/config/avaliacoes", { metodo: "POST", quem: "admin", corpo: { modo: "TODAS" } })).dados.avaliacoes_auto, "TODAS");
  assert.equal((await p.req("/api/orgs/1/mk/config", { quem: "admin" })).dados.avaliacoes_auto, "TODAS");
  const publicadas = [];
  p.google = (url, metodo, corpo) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return { access_token: "t", expires_in: 3599 };
    if (url.includes("/reviews/") && metodo === "PUT") { publicadas.push({ url, comment: corpo.comment }); return {}; }
    if (url.includes("/reviews?")) return { reviews: [
      { reviewId: "boa", reviewer: { displayName: "Ana" }, starRating: "THREE", comment: "Foi ok, mas demorou um pouco." },
      { reviewId: "grave", reviewer: { displayName: "Rui" }, starRating: "ONE", comment: "Vou processar vocês!" }] };
    return { multiDailyMetricTimeSeries: [] };
  };
  p.openai = (url, corpo) => {
    const t = corpo?.input?.[0]?.content?.[0]?.text || "";
    const r = /processar/.test(t) ? { sentimento: "GRAVE", urgencia: "ALTA", precisa_humano: true, motivo_humano: "Ameaça de processo.", resposta: "Lamentamos. Fale conosco." }
      : { sentimento: "NEUTRA", urgencia: "MEDIA", precisa_humano: false, viola_politica: false, resposta: "Ana, obrigada! Sentimos pela demora e já ajustamos a agenda." };
    return { output: [{ content: [{ type: "output_text", text: JSON.stringify(r) }] }] };
  };
  const ja = await p.req("/api/orgs/1/mk/google/agora", { metodo: "POST", quem: "admin", corpo: { marca_id: marca } });
  assert.deepEqual([ja.dados.analisadas, ja.dados.publicadas, ja.dados.precisam_de_voce], [2, 2, 1], "buscar e responder agora, sem esperar a rodada");
  await mod.default.scheduled({}, p.env, { waitUntil: (pr) => pr });
  await new Promise(r => setTimeout(r, 50));
  const avs = (await p.req(`/api/orgs/1/mk/avaliacoes?marca=${marca}`, { quem: "admin" })).dados.avaliacoes;
  assert.equal(avs.length, 3, JSON.stringify(p.googleChamadas?.map(c => c.url)));
  assert.deepEqual(publicadas.map(x => x.url.match(/reviews\/(\w+)\/reply$/)[1]).sort(), ["antiga", "boa"], "a normal nova e a que já esperava saem sozinhas; a grave não");
  assert.equal(avs.find(a => a.autor === "Bia").status, "RESPONDIDA");
  assert.equal(avs.find(a => a.autor === "Ana").status, "RESPONDIDA");
  assert.equal(avs.find(a => a.autor === "Rui").status, "PENDENTE");
});

test("Triagem 1★ — confere a base de clientes, aponta o tópico de denúncia e acompanha a remoção", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://engine.test", token: TOKEN_ENGINE } });
  p.engine.llmCliente = () => ({ resposta: "Oi!", intencao: "CONVERSA", fatos: {} });
  await p.engine.cliente("5521911112222", "Oi", { nome: "Márcia Ferreira" });
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Oficina" } })).dados.id;
  const real = (await p.req("/api/orgs/1/mk/avaliacoes", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, autor: "Márcia Ferreira", nota: 1, texto: "O técnico atrasou 2 horas." } })).dados.id;
  const falsa = (await p.req("/api/orgs/1/mk/avaliacoes", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, autor: "Carlos Mendes Rocha", nota: 1, texto: "Péssimo, não recomendo." } })).dados.id;
  const pedidos = [];
  p.openai = (url, corpo) => {
    const t = corpo?.input?.[0]?.content?.[0]?.text || ""; pedidos.push(t);
    const r = /NÃO está na base/.test(t) ? { veredito: "PROVAVEL_FALSA", categoria: "Spam", evidencias: ["não é cliente"], motivo: "Não está na base e o texto é genérico.", justificativa: "Não há registro desta pessoa como cliente." }
      : { veredito: "PARECE_REAL", categoria: "", motivo: "Cliente real reclamando de atraso." };
    return { output: [{ content: [{ type: "output_text", text: JSON.stringify(r) }] }] };
  };
  const tri = await p.req("/api/orgs/1/mk/avaliacoes/triagem", { metodo: "POST", quem: "admin", corpo: { marca_id: marca } });
  assert.deepEqual([tri.dados.feitas, tri.dados.restantes], [2, 0]);
  assert.ok(pedidos.some(t => /Márcia Ferreira[\s\S]*ESTÁ na base de clientes \(WhatsApp/.test(t)));
  assert.ok(pedidos.some(t => /Carlos Mendes Rocha[\s\S]*NÃO está na base de clientes/.test(t)));
  const avs = (await p.req(`/api/orgs/1/mk/avaliacoes?marca=${marca}`, { quem: "admin" })).dados.avaliacoes;
  const tf = JSON.parse(avs.find(a => a.id === falsa).triagem), tr = JSON.parse(avs.find(a => a.id === real).triagem);
  assert.deepEqual([tf.veredito, tf.categoria, tr.veredito, tr.categoria], ["PROVAVEL_FALSA", "Spam", "PARECE_REAL", ""]);
  const den = await p.req(`/api/orgs/1/mk/avaliacoes/${falsa}/denuncia`, { metodo: "POST", quem: "admin", corpo: { status: "DENUNCIADA", categoria: "Spam" } });
  assert.equal(den.dados.denuncia.status, "DENUNCIADA");
  assert.equal((await p.req("/api/orgs/1/mk/avaliacoes/triagem", { metodo: "POST", quem: "admin", corpo: { marca_id: marca } })).dados.feitas, 0, "não refaz o que já foi analisado");
});

test("Google — perfil com milhares de avaliações é lido em partes, e dá para apagar resposta e marcar denúncias em lote", async () => {
  const p = await criarPlataforma({ GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Shopping" } })).dados.id;
  // Cópias antigas (duas buscas ao mesmo tempo) são apagadas e não voltam.
  p.env.DB.prepare("INSERT INTO plt_mk_avaliacoes(org_id,marca_id,autor,nota,texto,status,criado_ms,google_id) VALUES(1,?,?,1,'t','PENDENTE',1,'g0'),(1,?,?,1,'t','PENDENTE',1,'g0')").bind(marca, "Pessoa 0", marca, "Pessoa 0").run();
  await p.req("/api/orgs/1/mk/google/estado", { quem: "admin" });
  assert.equal(p.env.DB.q("SELECT COUNT(*) n FROM plt_mk_avaliacoes WHERE google_id='g0'")[0].n, 1);
  p.env.DB.prepare("INSERT INTO plt_mk_google(org_id,marca_id,conta_nome,local_nome,local_titulo,token_cifrado,criado_ms,atualizado_ms) VALUES(1,?,?,?,?,?,1,1)").bind(marca, "accounts/1", "locations/2", "Shopping", "x").run();
  // 2.100 avaliações = 42 páginas de 50: a leitura completa precisa de 3 chamadas (20 páginas cada).
  const TOTAL = 2100, apagadas = [];
  p.google = (url, metodo) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return { access_token: "t", expires_in: 3599 };
    if (metodo === "DELETE") { apagadas.push(url); return {}; }
    if (url.includes("/reviews?")) {
      const pag = Number(new URL(url).searchParams.get("pageToken") || 0);
      const reviews = Array.from({ length: 50 }, (_, i) => { const n = pag * 50 + i; return { reviewId: "g" + n, reviewer: { displayName: "Pessoa " + n }, starRating: n % 2 ? "ONE" : "FIVE", comment: "t" + n, ...(n === 1 ? { reviewReply: { comment: "Resposta antiga" } } : {}) }; });
      return { reviews, totalReviewCount: TOTAL, averageRating: 3, ...((pag + 1) * 50 < TOTAL ? { nextPageToken: String(pag + 1) } : {}) };
    }
    return { multiDailyMetricTimeSeries: [] };
  };
  let continuar = false, voltas = 0, r;
  do { r = (await p.req("/api/orgs/1/mk/google/sincronizar", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, continuar } })).dados; continuar = true; voltas++; } while (!r.completo && voltas < 10);
  assert.equal(voltas, 3);
  assert.equal(p.env.DB.q("SELECT COUNT(*) n FROM plt_mk_avaliacoes WHERE marca_id=?", marca)[0].n, TOTAL, "todas as 2.100 avaliações estão na DENIA");
  const est = (await p.req("/api/orgs/1/mk/google/estado", { quem: "admin" })).dados.contas[0];
  assert.deepEqual([est.total_google, est.lendo], [TOTAL, 0]);
  const neg = (await p.req(`/api/orgs/1/mk/avaliacoes?marca=${marca}&nota_max=2&pagina=0&por_pagina=50`, { quem: "admin" })).dados;
  assert.deepEqual([neg.resumo.n1, neg.resumo.com_resposta, neg.encontradas, neg.avaliacoes.length], [1050, 1, 1050, 50]);
  // Apagar a resposta de uma avaliação: some também no Google.
  const comResp = p.env.DB.q("SELECT id FROM plt_mk_avaliacoes WHERE google_id='g1'")[0].id;
  assert.equal((await p.req(`/api/orgs/1/mk/avaliacoes/${comResp}/apagar-resposta`, { metodo: "POST", quem: "admin", corpo: {} })).status, 200);
  assert.match(apagadas[0], /reviews\/g1\/reply$/);
  // Marcar várias como denunciadas de uma vez.
  const ids = neg.avaliacoes.slice(0, 10).map(a => a.id);
  assert.equal((await p.req("/api/orgs/1/mk/avaliacoes/denuncia-lote", { metodo: "POST", quem: "admin", corpo: { ids, status: "DENUNCIADA" } })).dados.marcadas, 10);
  const den = (await p.req(`/api/orgs/1/mk/avaliacoes?marca=${marca}&nota_max=2&pagina=0&denuncia=DENUNCIADA`, { quem: "admin" })).dados;
  assert.deepEqual([den.encontradas, den.resumo.denunciadas], [10, 10]);
});

test("Google Meu Negócio — sem os secrets, a plataforma diz o que falta", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Oficina" } })).dados.id;
  const est = (await p.req("/api/orgs/1/mk/google/estado", { quem: "admin" })).dados;
  assert.deepEqual([est.configurada, est.faltando], [false, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]]);
  assert.equal((await p.req(`/api/orgs/1/mk/google/conectar?marca=${marca}`, { quem: "admin" })).dados.codigo, "GOOGLE_NAO_CONFIGURADO");
  assert.equal((await p.req("/api/google/retorno?code=x&state=forjado")).r.status, 200, "state forjado não conecta nada");
});

test("Instagram e Facebook — sem os secrets da Meta, a plataforma explica o que falta", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Clínica Sol" } })).dados.id;
  assert.equal((await p.req("/api/orgs/1/mk/meta/estado", { quem: "admin" })).dados.configurada, false);
  const r = await p.req(`/api/orgs/1/mk/meta/conectar?marca=${marca}`, { quem: "admin" });
  assert.equal(r.dados.codigo, "META_NAO_CONFIGURADA");
  assert.equal((await p.req("/api/meta/retorno?code=x&state=forjado")).r.status, 200, "state forjado não conecta nada");
  assert.equal(p.env.DB.q("SELECT COUNT(*) n FROM plt_meta WHERE chave LIKE 'meta_n_%'")[0].n, 0);
});

test("Consumo e custos — cada chamada da OpenAI entra na conta com tokens e custo, preços ajustáveis e voz ao vivo", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Oficina" } })).dados.id;
  const comUso = obj => ({ ...resposta(obj), usage: { input_tokens: 1_000_000, output_tokens: 100_000, input_tokens_details: { cached_tokens: 0 } } });
  p.openai = () => comUso({ posts: [{ dia: 0, hora: "18:00", formato: "post", titulo: "T", legenda: "L", hashtags: "", chamada: "", ideia_imagem: "" }] });
  await p.req("/api/orgs/1/mk/ia/semana", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, inicio: "2026-10-14", quantidade: 1 } });
  let uso = (await p.req("/api/orgs/1/mk/uso?dias=7", { quem: "admin" })).dados;
  const linha = uso.linhas.find(l => l.servico === "openai" && l.operacao === "texto");
  assert.ok(linha, "a chamada de texto foi registrada");
  assert.equal(linha.recurso, "ia/semana");
  assert.equal(linha.tokens_entrada, 1_000_000);
  assert.equal(linha.tokens_saida, 100_000);
  assert.ok(Math.abs(linha.custo_usd - 2.25) < 1e-9, "1M de entrada a US$1,25 + 100 mil de saída a US$10/M");
  assert.equal(uso.moeda, "BRL");
  // Preço ajustado pelo administrador vale para as próximas chamadas.
  const salvo = await p.req("/api/orgs/1/mk/uso/precos", { metodo: "POST", quem: "admin", corpo: { precos: { "gpt-5.6": { entrada: 2, cache: 0.2, saida: 20 } }, moeda: "EUR", cotacao: 0.9 } });
  assert.equal(salvo.dados.precos["gpt-5.6"].entrada, 2);
  await p.req("/api/orgs/1/mk/ia/semana", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, inicio: "2026-10-21", quantidade: 1 } });
  uso = (await p.req("/api/orgs/1/mk/uso?dias=7", { quem: "admin" })).dados;
  const texto = uso.linhas.filter(l => l.servico === "openai" && l.operacao === "texto");
  assert.equal(texto.reduce((s, l) => s + l.chamadas, 0), 2, "somadas no mesmo dia");
  assert.ok(Math.abs(texto.reduce((s, l) => s + l.custo_usd, 0) - (2.25 + 4)) < 1e-9);
  assert.equal(uso.moeda, "EUR"); assert.equal(uso.cotacao, 0.9);
  // A voz ao vivo (no navegador) manda o uso de cada resposta.
  await p.req("/api/orgs/1/mk/uso/realtime", { metodo: "POST", quem: "admin", corpo: { modelo: "gpt-realtime", usage: { input_tokens: 1000, output_tokens: 1000, input_tokens_details: { audio_tokens: 1000 }, output_tokens_details: { audio_tokens: 1000 } } } });
  uso = (await p.req("/api/orgs/1/mk/uso?dias=7", { quem: "admin" })).dados;
  const voz = uso.linhas.find(l => l.operacao === "voz_ao_vivo");
  assert.ok(Math.abs(voz.custo_usd - (1000 * 32 + 1000 * 64) / 1e6) < 1e-9, "áudio de entrada e saída pelo preço de áudio");
  // Chave de administrador da OpenAI: só aceita sk-admin-.
  const errada = await p.req("/api/orgs/1/mk/uso/chave-admin", { metodo: "POST", quem: "admin", corpo: { chave: "sk-normal-1234567890abcdefghijkl" } });
  assert.equal(errada.status, 400);
});

test("Instagram e Facebook por dentro — perfil, números, publicações, comentários (responder, ocultar, apagar, IA) e concorrente", async () => {
  const p = await criarPlataforma({ META_APP_ID: "123456", META_APP_SECRET: "segredo-do-app", OPENAI_API_KEY: "sk-teste" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Clínica Sol" } })).dados.id;
  const ida = await p.req(`/api/orgs/1/mk/meta/conectar?marca=${marca}`, { quem: "admin" });
  const dialogo = new URL(ida.r.headers.get("location"));
  assert.match(dialogo.searchParams.get("scope"), /instagram_manage_comments/);
  assert.match(dialogo.searchParams.get("scope"), /instagram_manage_insights/);
  assert.match(dialogo.searchParams.get("scope"), /pages_manage_engagement/);
  p.meta = (url) => {
    if (url.includes("oauth/access_token")) return { access_token: "longo" };
    if (url.includes("me/accounts")) return { data: [{ id: "PAG1", name: "Clínica Sol", access_token: "token-da-pagina", instagram_business_account: { id: "IG1", username: "clinicasol" } }] };
    return { error: { message: "inesperado " + url } };
  };
  const nonce = (await (await p.req(`/api/meta/retorno?code=abc&state=${encodeURIComponent(dialogo.searchParams.get("state"))}`)).r.text()).match(/meta-([A-Za-z0-9_-]+)/)[1];
  await p.req("/api/orgs/1/mk/meta/escolher", { metodo: "POST", quem: "admin", corpo: { n: nonce, pagina_id: "PAG1" } });

  const feitas = [];
  p.meta = (url, metodo, corpo) => {
    const u = new URL(url);
    feitas.push({ caminho: u.pathname, metodo, corpo, q: Object.fromEntries(u.searchParams) });
    assert.ok((u.searchParams.get("access_token") || corpo?.access_token) === "token-da-pagina", "usa o token da página");
    if (u.pathname.endsWith("/IG1") && u.searchParams.get("fields").startsWith("business_discovery")) return { business_discovery: { username: "rival", followers_count: 1000, media_count: 50, media: { data: [{ like_count: 30, comments_count: 10, media_type: "IMAGE" }, { like_count: 50, comments_count: 10, media_type: "IMAGE" }] } } };
    if (u.pathname.endsWith("/IG1")) return { id: "IG1", username: "clinicasol", followers_count: 1234, media_count: 80 };
    if (u.pathname.endsWith("/IG1/insights") && u.searchParams.get("metric_type") === "total_value" && u.searchParams.get("metric") !== "follower_demographics") return { data: [{ name: "reach", total_value: { value: 500 } }, { name: "views", total_value: { value: 900 } }, { name: "total_interactions", total_value: { value: 70 } }] };
    if (u.pathname.endsWith("/IG1/insights") && u.searchParams.get("metric") === "reach") return { data: [{ name: "reach", values: [{ value: 20, end_time: "2026-10-10T07:00:00+0000" }] }] };
    if (u.pathname.endsWith("/IG1/insights") && u.searchParams.get("metric") === "follower_count") return { data: [{ name: "follower_count", values: [{ value: 3, end_time: "2026-10-10T07:00:00+0000" }, { value: 2, end_time: "2026-10-11T07:00:00+0000" }] }] };
    if (u.pathname.endsWith("/IG1/insights")) return { data: [{ total_value: { breakdowns: [{ results: [{ dimension_values: ["Niterói"], value: 300 }] }] } }] };
    if (u.pathname.endsWith("/IG1/media") && u.searchParams.get("fields").includes("comments.limit")) return { data: [{ id: "M1", caption: "Promoção de clareamento", permalink: "https://instagram.com/p/1", comments: { data: [
      { id: "C1", text: "Quanto custa?", username: "ana", timestamp: "2026-10-12T10:00:00Z", replies: { data: [] } },
      { id: "C2", text: "Amei!", username: "bia", timestamp: "2026-10-11T10:00:00Z", replies: { data: [{ id: "R1", text: "Obrigada, Bia!", username: "clinicasol" }] } },
      { id: "C3", text: "resposta da própria marca", username: "clinicasol", timestamp: "2026-10-10T10:00:00Z" }] } }] };
    if (u.pathname.endsWith("/IG1/media")) return { data: [{ id: "M1", caption: "Promoção", media_type: "IMAGE", media_product_type: "FEED", media_url: "https://cdn/1.jpg", permalink: "https://instagram.com/p/1", timestamp: "2026-10-01T10:00:00Z", like_count: 40, comments_count: 3 }], paging: { cursors: { after: "XYZ" }, next: "https://graph/next" } };
    if (u.pathname.endsWith("/M1/insights")) return { data: [{ name: "reach", values: [{ value: 321 }] }, { name: "saved", values: [{ value: 9 }] }] };
    if (u.pathname.endsWith("/C1/replies") && metodo === "POST") return { id: "R2" };
    if (u.pathname.endsWith("/C1") && metodo === "POST") return { success: true };
    if (u.pathname.endsWith("/C1") && metodo === "DELETE") return { success: true };
    return { error: { message: "inesperado " + url } };
  };
  const base = `/api/orgs/1/mk/social`;
  const perfil = (await p.req(`${base}/perfil?marca=${marca}&canal=instagram`, { quem: "admin" })).dados.perfil;
  assert.deepEqual([perfil.usuario, perfil.seguidores, perfil.publicacoes], ["clinicasol", 1234, 80]);
  const ins = (await p.req(`${base}/insights?marca=${marca}&canal=instagram&dias=60`, { quem: "admin" })).dados;
  assert.equal(ins.dias, 60);
  assert.equal(ins.totais.alcance, 1000, "60 dias = duas janelas de 30 somadas");
  assert.equal(ins.totais.visualizacoes, 1800);
  assert.equal(ins.totais.novos_seguidores, 5);
  assert.equal(ins.publico.city[0].nome, "Niterói");
  assert.ok(ins.anterior && ins.anterior.totais.alcance === 1000, "compara com o período anterior");
  const mid = (await p.req(`${base}/midias?marca=${marca}&canal=instagram`, { quem: "admin" })).dados;
  assert.equal(mid.itens[0].curtidas, 40); assert.equal(mid.proximo, "XYZ");
  const met = (await p.req(`${base}/midias/M1?marca=${marca}&canal=instagram&tipo=FOTO`, { quem: "admin" })).dados.metricas;
  assert.equal(met.reach, 321); assert.equal(met.saved, 9);
  const com = (await p.req(`${base}/comentarios?marca=${marca}&canal=instagram`, { quem: "admin" })).dados;
  assert.equal(com.comentarios.length, 2, "os comentários da própria marca ficam de fora");
  assert.equal(com.sem_resposta, 1);
  assert.equal(com.comentarios.find(c => c.id === "C2").respondido, true);
  p.openai = () => resposta({ resposta: "Oi, Ana! Te mandamos os valores no direct 😊", tipo: "INTERESSE", acao: "LEVAR_PARA_PRIVADO", precisa_humano: false, motivo: "Pergunta de preço" });
  const sug = (await p.req(`${base}/comentarios/C1/sugerir`, { metodo: "POST", quem: "admin", corpo: { marca_id: marca, canal: "instagram", comentario: "Quanto custa?", autor: "ana", post: "Promoção" } })).dados;
  assert.equal(sug.tipo, "INTERESSE"); assert.match(sug.resposta, /direct/);
  assert.equal((await p.req(`${base}/comentarios/C1/responder`, { metodo: "POST", quem: "admin", corpo: { marca_id: marca, canal: "instagram", texto: sug.resposta } })).dados.ok, true);
  assert.equal(feitas.find(f => f.caminho.endsWith("/C1/replies")).corpo.message, sug.resposta);
  await p.req(`${base}/comentarios/C1/ocultar`, { metodo: "POST", quem: "admin", corpo: { marca_id: marca, canal: "instagram", ocultar: true } });
  assert.equal(feitas.find(f => f.caminho.endsWith("/C1") && f.metodo === "POST").corpo.hide, "true");
  await p.req(`${base}/comentarios/C1/apagar`, { metodo: "POST", quem: "admin", corpo: { marca_id: marca, canal: "instagram" } });
  assert.ok(feitas.find(f => f.caminho.endsWith("/C1") && f.metodo === "DELETE"), "apaga pela API");
  const rival = (await p.req(`${base}/concorrente?marca=${marca}&canal=instagram&usuario=@rival`, { quem: "admin" })).dados;
  assert.equal(rival.seguidores, 1000); assert.equal(rival.engajamento_medio, 50); assert.equal(rival.taxa_engajamento, 5);
  // Tudo isso entra no consumo da Meta.
  const uso = (await p.req("/api/orgs/1/mk/uso?dias=7", { quem: "admin" })).dados;
  assert.ok(uso.linhas.filter(l => l.servico === "meta").reduce((s, l) => s + l.chamadas, 0) >= 10);
});

test("WhatsApp sem entregar — o cron avisa os responsáveis por e-mail (uma vez a cada 6 h) e o status mostra o bloqueio", async () => {
  const p = await criarPlataforma({ RESEND_API_KEY: "re_teste", EMAIL_REMETENTE: "DENIA <nao-responda@denia.test>" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://engine.test/", token: TOKEN_ENGINE } });
  const mod = await import(new URL("../src/worker.js?t=" + (++n), import.meta.url).href);
  // Sem problema: nenhum e-mail.
  { let tarefa; await mod.default.scheduled({}, p.env, { waitUntil: (pr) => { tarefa = pr; } }); await tarefa; }
  assert.equal(p.emails.filter(e => /não está entregando/.test(e.subject)).length, 0);
  // A Meta avisou falha de pagamento: o motor marca o bloqueio.
  await p.engine.env.DB.prepare("CREATE TABLE IF NOT EXISTS d30_meta (chave TEXT PRIMARY KEY, valor TEXT)").run();
  await p.engine.env.DB.prepare("INSERT OR REPLACE INTO d30_meta(chave,valor) VALUES('entrega_bloqueada',?)").bind(JSON.stringify({ codigo: 131042, erro: "Problema de pagamento na conta do WhatsApp Business", em: Date.now() })).run();
  const st = (await p.req("/api/orgs/1/engine/status", { quem: "admin" })).dados;
  assert.equal(st.entrega_bloqueada.codigo, 131042);
  { const t0 = Date.now() + 26 * 60000; p.env.__agora = () => t0; }
  { let tarefa; await mod.default.scheduled({}, p.env, { waitUntil: (pr) => { tarefa = pr; } }); await tarefa; }
  const avisos = p.emails.filter(e => /não está entregando/.test(e.subject));
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].text, /pagamento/);
  { const t1 = Date.now() + 52 * 60000; p.env.__agora = () => t1; }
  { let tarefa; await mod.default.scheduled({}, p.env, { waitUntil: (pr) => { tarefa = pr; } }); await tarefa; }
  assert.equal(p.emails.filter(e => /não está entregando/.test(e.subject)).length, 1, "não repete o mesmo aviso em menos de 6 h");
});

test("Voz da DENIA — voz natural escolhida, voz clonada da pessoa (com autorização) e fala com a voz clonada", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const pedidos = [];
  const anterior = globalThis.fetch;
  globalThis.fetch = async (url, op = {}) => {
    if (String(url).startsWith("https://api.elevenlabs.io/")) {
      pedidos.push({ url: String(url), op });
      if (op.headers?.["xi-api-key"] !== "sk_" + "a".repeat(40)) return new Response(JSON.stringify({ detail: { message: "invalid" } }), { status: 401 });
      if (String(url).endsWith("/v1/user")) return new Response(JSON.stringify({ subscription: { tier: "starter" } }), { status: 200 });
      if (String(url).endsWith("/v1/voices/add")) return new Response(JSON.stringify({ voice_id: "VozClonada123456", requires_verification: false }), { status: 200 });
      if (String(url).includes("/v1/text-to-speech/VozClonada123456")) return new Response(new Uint8Array([7, 7, 7]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    return anterior(url, op);
  };
  try {
    let cfg = (await p.req("/api/orgs/1/mk/voz/config", { quem: "admin" })).dados;
    assert.equal(cfg.provedor, "openai");
    assert.equal(cfg.voz_openai, "marin", "voz natural por padrão");
    cfg = (await p.req("/api/orgs/1/mk/voz/config", { metodo: "POST", quem: "admin", corpo: { voz_openai: "cedar", estilo: "Carioca, animado." } })).dados;
    assert.equal(cfg.voz_openai, "cedar");
    let falado = null;
    p.openai = (url, corpo) => { if (url.endsWith("audio/speech")) { falado = corpo; return new Response(new Uint8Array([1]), { status: 200 }); } return {}; };
    await p.req("/api/orgs/1/assistente/falar", { metodo: "POST", quem: "admin", corpo: { texto: "Oi!" } });
    assert.equal(falado.voice, "cedar"); assert.match(falado.instructions, /Carioca/);
    // Minha voz: chave da ElevenLabs, gravação e consentimento.
    assert.equal((await p.req("/api/orgs/1/mk/voz/eleven-chave", { metodo: "POST", quem: "admin", corpo: { chave: "sk_" + "b".repeat(40) } })).status, 400, "chave recusada");
    assert.equal((await p.req("/api/orgs/1/mk/voz/eleven-chave", { metodo: "POST", quem: "admin", corpo: { chave: "sk_" + "a".repeat(40) } })).dados.ok, true);
    assert.ok(!JSON.stringify(p.env.DB.q("SELECT valor FROM plt_meta WHERE chave='voz_org_1'")).includes("a".repeat(40)), "chave guardada cifrada");
    const form = (consent) => { const f = new FormData(); f.append("audio", new Blob([new Uint8Array(80000)], { type: "audio/webm" }), "voz.webm"); f.append("nome", "Voz do Dono"); if (consent) f.append("consentimento", "sim"); return f; };
    const mod = await import(new URL("../src/worker.js?t=" + (++n), import.meta.url).href);
    const pedir = async (f) => { const r = await mod.default.fetch(new Request("https://plataforma.test/api/orgs/1/mk/voz/clonar", { method: "POST", headers: { "x-denia": "1", origin: "https://plataforma.test", cookie: p.cookies.admin }, body: f }), p.env); return { status: r.status, dados: await r.json() }; };
    assert.equal((await pedir(form(false))).status, 400, "sem consentimento não clona");
    const clone = await pedir(form(true));
    assert.equal(clone.dados.ok, true);
    cfg = (await p.req("/api/orgs/1/mk/voz/config", { quem: "admin" })).dados;
    assert.equal(cfg.provedor, "elevenlabs"); assert.equal(cfg.eleven_nome, "Voz do Dono");
    const fala = await p.req("/api/orgs/1/assistente/falar", { metodo: "POST", quem: "admin", corpo: { texto: "Olá, cliente!" } });
    assert.equal(fala.status, 200);
    assert.ok(pedidos.some(x => x.url.includes("/text-to-speech/VozClonada123456")), "falou com a voz clonada");
    // Conversa ao vivo com a voz da pessoa: a sessão devolve texto.
    let sessao = null;
    p.openai = (url, corpo) => { if (url.endsWith("realtime/client_secrets")) { sessao = corpo.session; return { value: "ek_1" }; } return {}; };
    const vivo = (await p.req("/api/orgs/1/assistente/ao-vivo", { metodo: "POST", quem: "admin", corpo: {} })).dados;
    assert.equal(vivo.minha_voz, true);
    assert.deepEqual(sessao.output_modalities, ["text"]);
  } finally { globalThis.fetch = anterior; }
});

test("Plataforma — guia de lojas (motor em MODO=guia): status, importação, auditoria e permissões", async () => {
  const p = await criarPlataforma();
  p.engine.env.MODO = "guia";
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://engine.test/", token: TOKEN_ENGINE } });
  const st = await p.req("/api/orgs/1/engine/status", { quem: "admin" });
  assert.equal(st.dados.modo, "guia");
  const imp = await p.req("/api/orgs/1/engine/guide/import", { metodo: "POST", quem: "admin", corpo: { linhas: [{ loja: "Cell Center", whatsapp: "21988887777", produtos: "Celulares" }] } });
  assert.equal(imp.status, 200); assert.equal(imp.dados.lojas, 1);
  const g = await p.req("/api/orgs/1/engine/guide", { quem: "admin" });
  assert.equal(g.dados.lojas[0].nome, "Cell Center");
  const loja = g.dados.lojas[0];
  assert.equal((await p.req(`/api/orgs/1/engine/guide/stores/${loja.id}/delete`, { metodo: "POST", quem: "admin", corpo: {} })).status, 200);
  const teste = await p.req("/api/orgs/1/engine/guide/test", { metodo: "POST", quem: "admin", corpo: { texto: "oi" } });
  assert.equal(teste.dados.respostas[0].interativo.type, "button");
  assert.equal((await p.req("/api/orgs/1/engine/guide/stats?de=2026-10-01&ate=2026-10-31", { quem: "admin" })).status, 200);
  assert.ok(p.chamadasEngine.at(-1).url.includes("de=2026-10-01"));
  const acoes = (await p.req("/api/orgs/1/auditoria", { quem: "admin" })).dados.eventos.filter(e => e.acao === "GUIA").map(e => e.detalhe);
  assert.ok(acoes.some(d => /1 loja\(s\) importada/.test(d)), JSON.stringify(acoes));
  assert.ok(acoes.some(d => /excluiu/.test(d)));
});

// ===== Chatbot do WhatsApp da plataforma: qualquer empresa, sem Worker por empresa
const TOKEN_META = "EAAG" + "x".repeat(60);
// Como a Meta: com a chave do app configurada, o webhook vem assinado (x-hub-signature-256).
const webhookAssinado = (p, corpo) => {
  const bruto = JSON.stringify(corpo);
  const cab = p.env.META_APP_SECRET ? { "x-hub-signature-256": "sha256=" + createHmac("sha256", p.env.META_APP_SECRET).update(bruto).digest("hex") } : {};
  return p.req("/webhook/whatsapp", { metodo: "POST", corpo, cabecalhos: cab });
};
const webhookZap = (p, pnid, msg, nome = "Marcos") => webhookAssinado(p, { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: pnid }, contacts: [{ wa_id: msg.from, profile: { name: nome } }], messages: [{ id: "wamid." + Math.random().toString(36).slice(2), timestamp: String(Math.floor(Date.now() / 1000)), ...msg }] } }] }] });
const clicar = (p, pnid, de, id) => webhookZap(p, pnid, { from: de, type: "interactive", interactive: { type: "list_reply", list_reply: { id, title: "x" } } });
async function duasEmpresasComChatbot() {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const nova = await p.req("/api/admin/organizacoes", { metodo: "POST", quem: "admin", corpo: { nome: "Shopping Infomix", segmento: "Shopping" } });
  const inf = nova.dados.id;
  for (const [org, pnid] of [[inf, "111111111111"], [1, "222222222222"]]) {
    const c = await p.req(`/api/orgs/${org}/zap/conta`, { metodo: "POST", quem: "admin", corpo: { phone_number_id: pnid, token: TOKEN_META } });
    assert.equal(c.status, 200, JSON.stringify(c.dados));
  }
  return { p, inf };
}
const enviadosPara = (p, tel) => p.engine.enviados.filter(e => e.to === tel);

test("Chatbot — uma plataforma, um webhook, várias empresas: cada número cai na empresa certa, menu por botões sem IA", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  const conta = await p.req(`/api/orgs/${inf}/zap/conta`, { quem: "admin" });
  assert.match(conta.dados.webhook_url, /\/webhook\/whatsapp$/);
  const ver = await p.req(`/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${conta.dados.verify_token}&hub.challenge=123`);
  assert.equal(await ver.r.text(), "123", "a Meta valida o webhook com o token mostrado no painel");
  assert.equal((await p.req("/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1")).status, 403);
  assert.equal((await p.req(`/api/orgs/1/zap/conta`, { metodo: "POST", quem: "admin", corpo: { phone_number_id: "111111111111", token: TOKEN_META } })).status, 409, "o mesmo número não entra em duas empresas");

  assert.equal((await p.req(`/api/orgs/${inf}/zap/modelo`, { metodo: "POST", quem: "admin", corpo: { tipo: "shopping" } })).status, 200);
  const imp = await p.req(`/api/orgs/${inf}/zap/importar`, { metodo: "POST", quem: "admin", corpo: { linhas: [
    { loja: "Cell Center", whatsapp: "21988887777", local: "Loja 12", produtos: "Celulares, Capinhas", servicos: "Conserto de celular" },
    { loja: "Tech Fix", whatsapp: "21977776666", servicos: "Conserto de celular, Conserto de notebook" },
    { loja: "Game Zone", whatsapp: "21966665555", produtos: "Videogames" }] } });
  assert.deepEqual([imp.dados.contatos, imp.dados.opcoes_novas], [3, 5]);
  await p.req(`/api/orgs/1/zap/config`, { metodo: "POST", quem: "admin", corpo: { boas_vindas: "Central aqui!" } });

  const CLI = "5521955556666";
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "Oi" } });
  let e = enviadosPara(p, CLI).at(-1);
  assert.equal(e.corpo.interactive.type, "button");
  assert.match(e.corpo.interactive.body.text, /bem-vindo/);
  assert.deepEqual(e.corpo.interactive.action.buttons.map(b => b.reply.title), ["🛍️ Produtos", "🔧 Serviços", "💬 Falar com alguém"]);
  await clicar(p, "111111111111", CLI, e.corpo.interactive.action.buttons[1].reply.id);
  e = enviadosPara(p, CLI).at(-1);
  assert.equal(e.corpo.interactive.type, "button", "até 3 opções: botões");
  const rows = e.corpo.interactive.action.buttons.map(b => ({ id: b.reply.id, title: b.reply.title }));
  assert.deepEqual(rows.map(r => r.title), ["Conserto de celular", "Conserto de notebook"]);
  await clicar(p, "111111111111", CLI, rows[0].id);
  const listaLojas = enviadosPara(p, CLI).at(-2).corpo.text.body;
  assert.match(listaLojas, /Cell Center/); assert.match(listaLojas, /wa\.me\/5521977776666/); assert.doesNotMatch(listaLojas, /Game Zone/);
  assert.equal(p.openaiChamadas.length, 0, "botões não usam IA");
  // Mais de 3 opções: lista com descrição e paginação de 9 + "Mais opções".
  const prod = (await p.req(`/api/orgs/${inf}/zap/itens`, { quem: "admin" })).dados.itens.find(i => /Produtos/.test(i.titulo));
  const linhas = Array.from({ length: 12 }, (_, i) => ({ loja: "Loja " + i, whatsapp: "2190000" + String(1000 + i), produtos: "Cat " + String(i).padStart(2, "0") }));
  await p.req(`/api/orgs/${inf}/zap/importar`, { metodo: "POST", quem: "admin", corpo: { linhas } });
  await clicar(p, "111111111111", CLI, "z:i:" + prod.id);
  let l = enviadosPara(p, CLI).at(-1).corpo.interactive;
  assert.equal(l.type, "list"); assert.equal(l.action.sections[0].rows.length, 10);
  assert.deepEqual([l.action.sections[0].rows[0].title, l.action.sections[0].rows[0].description], ["Celulares", "1 loja"]);
  assert.equal(l.action.sections[0].rows.at(-1).id, `z:pg:${prod.id}:1`);
  await clicar(p, "111111111111", CLI, `z:pg:${prod.id}:1`);
  l = enviadosPara(p, CLI).at(-1).corpo.interactive;
  assert.equal(l.action.sections[0].rows.at(-1).id, "z:inicio");
  for (const r of l.action.sections[0].rows) assert.ok(r.title.length <= 24);
  // Outra empresa, outro número: menu e mensagens dela, sem misturar.
  await webhookZap(p, "222222222222", { from: CLI, type: "text", text: { body: "bom dia" } });
  assert.equal(enviadosPara(p, CLI).at(-1).corpo.text.body, "Central aqui!\n\n(Em breve teremos mais opções por aqui.)");
  // Número desconhecido: ignora.
  const antes = p.engine.enviados.length;
  await webhookZap(p, "999999999999", { from: CLI, type: "text", text: { body: "oi" } });
  assert.equal(p.engine.enviados.length, antes);
  const st = await p.req(`/api/orgs/${inf}/zap/stats`, { quem: "admin" });
  assert.equal(st.dados.total_buscas, 1); assert.equal(st.dados.contatos, 1); assert.equal(st.dados.por_via[0].via, "BOTAO");
  assert.equal((await p.req(`/api/orgs/1/zap/stats`, { quem: "admin" })).dados.total_buscas, 0, "métricas separadas por empresa");
});

test("Chatbot — palavra sem IA, IA barata só na dúvida, 'falar com alguém' pausa e a equipe responde pelo painel", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  await p.req(`/api/orgs/${inf}/zap/modelo`, { metodo: "POST", quem: "admin", corpo: { tipo: "shopping" } });
  await p.req(`/api/orgs/${inf}/zap/importar`, { metodo: "POST", quem: "admin", corpo: { linhas: [{ loja: "Game Zone", whatsapp: "21966665555", produtos: "Videogames" }, { loja: "Tech Fix", whatsapp: "21977776666", servicos: "Conserto de notebook" }] } });
  await p.req("/api/orgs/1/ia/chave", { metodo: "POST", quem: "admin", corpo: { chave: "sk-proj-" + "c".repeat(40) } });
  const CLI = "5521944443333";
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "vocês têm videogames?" } });
  assert.match(enviadosPara(p, CLI).at(-2).corpo.text.body, /Game Zone/);
  assert.equal(p.openaiChamadas.length, 0, "achou por palavra, sem IA");
  // Só botões: pergunta sem palavra conhecida volta ao menu, sem IA.
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "meu laptop não liga, quem arruma?" } });
  assert.equal(p.openaiChamadas.length, 0);
  assert.match(enviadosPara(p, CLI).at(-1).corpo.interactive.body.text, /Não entendi/);
  // Botões + IA: aí sim usa o modelo barato.
  await p.req(`/api/orgs/${inf}/zap/config`, { metodo: "POST", quem: "admin", corpo: { modo: "MISTO", sobre: "Aberto de segunda a sábado, das 10h às 22h." } });
  const itens = (await p.req(`/api/orgs/${inf}/zap/itens`, { quem: "admin" })).dados.itens;
  const note = itens.find(i => i.titulo === "Conserto de notebook");
  p.openai = (url, corpo) => { const t = corpo.input[0].content[0].text; return { output: [{ content: [{ type: "output_text", text: JSON.stringify(/laptop/.test(t) ? { item: note.id } : { resposta: "Abrimos de segunda a sábado, das 10h às 22h." }) }] }], usage: { input_tokens: 300, output_tokens: 20 } }; };
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "meu laptop não liga, quem arruma?" } });
  assert.equal(p.openaiChamadas.length, 1); assert.equal(p.openaiChamadas[0].corpo.model, "gpt-5-nano");
  assert.match(enviadosPara(p, CLI).at(-2).corpo.text.body, /Tech Fix/);
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "que horas vocês fecham sábado?" } });
  assert.match(enviadosPara(p, CLI).at(-2).corpo.text.body, /22h/);
  // Falar com alguém: pausa, avisa no Telegram e a equipe responde pela plataforma.
  await p.req(`/api/orgs/${inf}/zap/conta/telegram`, { metodo: "POST", quem: "admin", corpo: { telegram_token: "123456:" + "A".repeat(30), telegram_chat: "-100123456" } });
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "quero falar com atendente" } });
  assert.match(enviadosPara(p, CLI).at(-1).corpo.text.body, /chamar alguém da equipe/);
  assert.ok(p.engine.telegram.some(t => /quer falar com alguém/.test(t)));
  const n = enviadosPara(p, CLI).length;
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "oi?" } });
  assert.equal(enviadosPara(p, CLI).length, n, "em pausa, o robô não responde");
  const conv = await p.req(`/api/orgs/${inf}/zap/conversas`, { quem: "admin" });
  assert.equal(conv.dados.conversas[0].pausado, true);
  assert.equal((await p.req(`/api/orgs/${inf}/zap/conversas/${CLI}/enviar`, { metodo: "POST", quem: "admin", corpo: { texto: "Oi Marcos, aqui é a Ana!" } })).status, 200);
  assert.equal(enviadosPara(p, CLI).at(-1).corpo.text.body, "Oi Marcos, aqui é a Ana!");
  const hist = await p.req(`/api/orgs/${inf}/zap/conversas/${CLI}`, { quem: "admin" });
  assert.ok(hist.dados.mensagens.some(m => m.origem === "EQUIPE"));
  await p.req(`/api/orgs/${inf}/zap/conversas/${CLI}/robo`, { metodo: "POST", quem: "admin", corpo: { ligar: true } });
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "oi" } });
  assert.equal(enviadosPara(p, CLI).at(-1).corpo.interactive.type, "button", "robô de volta");
  // Simulador do painel não envia nada.
  const antes = p.engine.enviados.length;
  const t = await p.req(`/api/orgs/${inf}/zap/testar`, { metodo: "POST", quem: "admin", corpo: { texto: "oi" } });
  assert.equal(t.dados.respostas[0].interativo.type, "button");
  assert.equal(p.engine.enviados.length, antes);
  // Mensagem repetida pela Meta não gera resposta duplicada.
  const msg = { id: "wamid.fixo", from: CLI, type: "text", text: { body: "oi" } };
  await webhookZap(p, "111111111111", msg); const depois1 = p.engine.enviados.length;
  await webhookZap(p, "111111111111", msg);
  assert.equal(p.engine.enviados.length, depois1);
});

test("Chatbot — com a chave secreta do app, só aceita mensagem assinada pela Meta", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  await p.req(`/api/orgs/${inf}/zap/modelo`, { metodo: "POST", quem: "admin", corpo: { tipo: "servicos" } });
  assert.equal((await p.req(`/api/orgs/${inf}/zap/conta`, { metodo: "POST", quem: "admin", corpo: { app_secret: "a".repeat(32) } })).status, 200);
  const CLI = "5521922221111";
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "oi" } });
  assert.equal(enviadosPara(p, CLI).length, 0, "sem assinatura: ignorada");

  const corpo = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "111111111111" }, messages: [{ id: "wamid.ass", from: CLI, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "oi" } }] } }] }] });
  const r = await p.req("/webhook/whatsapp", { metodo: "POST", corpo: JSON.parse(corpo), cabecalhos: { "x-hub-signature-256": "sha256=" + createHmac("sha256", "a".repeat(32)).update(corpo).digest("hex") } });
  assert.equal(r.status, 200);
  assert.equal(enviadosPara(p, CLI).length, 1);
});

// ===== Planos: teste grátis de 7 dias, recursos por plano, cortesia e cobrança (Asaas)
test("Planos — teste de 7 dias, recurso fora do plano, cortesia pelo administrador e limite da equipe", async () => {
  const p = await criarPlataforma();
  const r = await p.req("/api/cadastro", { metodo: "POST", quem: "ana", corpo: { nome: "Ana", empresa: "Loja da Ana", email: "ana@loja.test", senha: "SenhaMuitoForte#2026", aceite: true, plano: "essencial" } });
  assert.equal(r.status, 200);
  const eu = await p.req("/api/eu", { quem: "ana" });
  const org = eu.dados.organizacoes[0];
  assert.equal(org.acesso.status, "TESTE"); assert.equal(org.acesso.dias, 7); assert.equal(org.acesso.plano, "essencial");
  assert.equal((await p.req(`/api/orgs/${org.id}/zap/itens`, { quem: "ana" })).status, 200, "chatbot faz parte do Essencial");
  const mk = await p.req(`/api/orgs/${org.id}/mk/marcas`, { quem: "ana" });
  assert.equal(mk.status, 402); assert.equal(mk.dados.codigo, "PLANO_RECURSO"); assert.equal(mk.dados.plano_minimo.id, "growth");
  const plano = await p.req(`/api/orgs/${org.id}/plano`, { quem: "ana" });
  assert.equal(plano.dados.planos.find(x => x.id === "start").anual, Math.round(690 * 12 * 0.8));
  // Equipe: o Essencial permite 2 pessoas.
  assert.equal((await p.req(`/api/orgs/${org.id}/membros`, { metodo: "POST", quem: "ana", corpo: { email: "b@loja.test", papel: "AGENTE" } })).status, 200);
  const terceira = await p.req(`/api/orgs/${org.id}/membros`, { metodo: "POST", quem: "ana", corpo: { email: "c@loja.test", papel: "AGENTE" } });
  assert.equal(terceira.status, 402); assert.equal(terceira.dados.codigo, "PLANO_LIMITE");
  // Passaram 8 dias: só o plano fica aberto, e o robô do WhatsApp para.
  p.env.DB.db.prepare("UPDATE plt_organizacoes SET teste_ate=? WHERE id=?").run(Date.now() - 86400000, org.id);
  const fim = await p.req(`/api/orgs/${org.id}/zap/itens`, { quem: "ana" });
  assert.equal(fim.status, 402); assert.equal(fim.dados.codigo, "PLANO_VENCIDO");
  assert.equal((await p.req(`/api/orgs/${org.id}/plano`, { quem: "ana" })).dados.acesso.status, "TESTE_ACABOU");
  // O administrador geral dá cortesia: acesso total sem custo.
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  assert.equal((await p.req(`/api/admin/organizacoes/${org.id}`, { metodo: "POST", quem: "admin", corpo: { plano_status: "CORTESIA" } })).status, 200);
  assert.equal((await p.req(`/api/orgs/${org.id}/mk/marcas`, { quem: "ana" })).status, 200, "cortesia libera tudo");
  assert.equal((await p.req("/api/eu", { quem: "admin" })).dados.organizacoes.find(o => o.id === 1).acesso.cortesia, true, "a Central é cortesia");
});

test("Planos — assinatura pelo Asaas (Pix, boleto ou cartão), pagamento confirmado libera, sem fidelidade", async () => {
  const p = await criarPlataforma({ ASAAS_API_KEY: "aact_teste", ASAAS_SANDBOX: "1", ASAAS_WEBHOOK_TOKEN: "segredo-do-webhook-123" });
  await p.req("/api/cadastro", { metodo: "POST", quem: "ana", corpo: { nome: "Ana", empresa: "Pousada Sol", email: "ana@sol.test", senha: "SenhaMuitoForte#2026", aceite: true, plano: "start" } });
  const org = (await p.req("/api/eu", { quem: "ana" })).dados.organizacoes[0];
  p.asaas = (caminho, metodo, corpo) => {
    if (caminho === "/customers" && metodo === "POST") return { id: "cus_1" };
    if (caminho === "/subscriptions" && metodo === "POST") return { id: "sub_1", ...corpo };
    if (caminho === "/subscriptions/sub_1/payments") return { data: [{ id: "pay_1", value: 6624, status: "PENDING", dueDate: "2026-10-22", invoiceUrl: "https://sandbox.asaas.com/i/pay_1" }] };
    return {};
  };
  const ruim = await p.req(`/api/orgs/${org.id}/plano/assinar`, { metodo: "POST", quem: "ana", corpo: { plano: "growth", ciclo: "ANUAL", nome: "Pousada Sol LTDA", documento: "11.111.111/1111-11", email: "fin@sol.test" } });
  assert.equal(ruim.status, 400, "CNPJ inválido");
  const ok = await p.req(`/api/orgs/${org.id}/plano/assinar`, { metodo: "POST", quem: "ana", corpo: { plano: "growth", ciclo: "ANUAL", nome: "Pousada Sol LTDA", documento: "11.222.333/0001-81", email: "fin@sol.test" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.dados));
  assert.equal(ok.dados.link, "https://sandbox.asaas.com/i/pay_1");
  const sub = p.asaasChamadas.find(c => c.url.endsWith("/subscriptions") && c.metodo === "POST").corpo;
  assert.equal(sub.billingType, "UNDEFINED", "o cliente escolhe Pix, boleto ou cartão");
  assert.equal(sub.cycle, "YEARLY"); assert.equal(sub.value, Math.round(1890 * 12 * 0.8));
  assert.ok(p.asaasChamadas[0].url.startsWith("https://api-sandbox.asaas.com/"));
  // Webhook sem o token: recusado.
  assert.equal((await p.req("/webhook/asaas", { metodo: "POST", corpo: { event: "PAYMENT_RECEIVED", payment: { id: "pay_1", subscription: "sub_1" } } })).status, 401);
  const pago = await p.req("/webhook/asaas", { metodo: "POST", cabecalhos: { "asaas-access-token": "segredo-do-webhook-123" }, corpo: { event: "PAYMENT_RECEIVED", payment: { id: "pay_1", subscription: "sub_1", value: 18144, status: "RECEIVED", billingType: "PIX", dueDate: "2026-10-22", paymentDate: "2026-10-22", externalReference: `org:${org.id}:growth:ANUAL` } } });
  assert.equal(pago.status, 200);
  const a = (await p.req(`/api/orgs/${org.id}/plano`, { quem: "ana" })).dados;
  assert.equal(a.acesso.status, "ATIVO"); assert.equal(a.acesso.plano, "growth"); assert.equal(a.acesso.ciclo, "ANUAL");
  assert.equal(a.pagamentos[0].status, "RECEIVED"); assert.equal(a.pagamentos[0].forma, "PIX");
  assert.equal((await p.req(`/api/orgs/${org.id}/mk/marcas`, { quem: "ana" })).status, 200, "Growth libera o marketing");
  // Cancelar: sem multa, continua até o fim do período pago.
  assert.equal((await p.req(`/api/orgs/${org.id}/plano/cancelar`, { metodo: "POST", quem: "ana", corpo: {} })).status, 200);
  const c = (await p.req(`/api/orgs/${org.id}/plano`, { quem: "ana" })).dados.acesso;
  assert.equal(c.status, "CANCELADO"); assert.equal(c.liberado, true);
});

test("Planos — lembrete por e-mail quando o teste está acabando (uma vez só)", async () => {
  const p = await criarPlataforma({ RESEND_API_KEY: "re_teste", EMAIL_REMETENTE: "DENIA <ola@denia.test>" });
  await p.req("/api/cadastro", { metodo: "POST", quem: "ana", corpo: { nome: "Ana", empresa: "Loja da Ana", email: "ana@loja.test", senha: "SenhaMuitoForte#2026", aceite: true } });
  const base = Date.parse("2026-10-21T13:00:00Z");
  p.env.__agora = () => base;
  p.env.DB.db.prepare("UPDATE plt_organizacoes SET teste_ate=? WHERE nome='Loja da Ana'").run(base + 1.5 * 86400000);
  const mod = await import("../src/worker.js?lembrete");
  await mod.default.scheduled({}, p.env, null);
  const para = p.emails.filter(e => e.to[0] === "ana@loja.test");
  assert.equal(para.length, 1); assert.match(para[0].subject, /termina em 2 dias/);
  p.env.DB.db.prepare("DELETE FROM plt_meta WHERE chave='lembretes_plano_dia'").run();
  await mod.default.scheduled({}, p.env, null);
  assert.equal(p.emails.filter(e => e.to[0] === "ana@loja.test").length, 1, "não repete o mesmo aviso");
});

test("Chatbot — mais de 10 opções: lista com 'Mais opções' ou texto numerado sem limite, resposta pelo número", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  await p.req(`/api/orgs/${inf}/zap/modelo`, { metodo: "POST", quem: "admin", corpo: { tipo: "shopping" } });
  const servicos = Array.from({ length: 22 }, (_, i) => "Serviço " + String(i + 1).padStart(2, "0")).join(", ");
  await p.req(`/api/orgs/${inf}/zap/importar`, { metodo: "POST", quem: "admin", corpo: { linhas: [{ loja: "Faz Tudo", whatsapp: "21955554444", servicos }] } });
  const serv = (await p.req(`/api/orgs/${inf}/zap/itens`, { quem: "admin" })).dados.itens.find(i => /Serviços/.test(i.titulo));
  const CLI = "5521911110000";
  await clicar(p, "111111111111", CLI, "z:i:" + serv.id);
  const l = enviadosPara(p, CLI).at(-1).corpo.interactive;
  assert.equal(l.type, "list"); assert.match(l.body.text, /São 22 opções/);
  // Texto numerado: todas numa mensagem, e o cliente responde "17".
  assert.equal((await p.req(`/api/orgs/${inf}/zap/itens`, { metodo: "POST", quem: "admin", corpo: { ...serv, exibicao: "NUMERADO" } })).status, 200);
  await clicar(p, "111111111111", CLI, "z:i:" + serv.id);
  const txt = enviadosPara(p, CLI).at(-1).corpo.text.body;
  assert.match(txt, /\*22\* · Serviço 22/); assert.match(txt, /\*0\* · Voltar/);
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "17" } });
  assert.match(enviadosPara(p, CLI).at(-2).corpo.text.body, /\*Serviço 17\*[\s\S]*Faz Tudo/);
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "0" } });
  assert.equal(enviadosPara(p, CLI).at(-1).corpo.interactive.type, "button", "0 volta ao menu inicial");
});

test("Telegram — bot da plataforma conecta o grupo com um toque e a equipe responde o cliente pelo Telegram", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  p.env.TELEGRAM_BOT_TOKEN_PLATAFORMA = "999:" + "T".repeat(30);
  const anterior = globalThis.fetch, tg = [];
  let segredo = "";
  globalThis.fetch = async (url, op = {}) => {
    if (String(url).startsWith("https://api.telegram.org/bot999:")) {
      const metodo = String(url).split("/").pop(), corpo = op.body ? JSON.parse(op.body) : {};
      tg.push({ metodo, corpo });
      if (metodo === "getMe") return new Response(JSON.stringify({ ok: true, result: { username: "DeniaAvisosBot" } }));
      if (metodo === "setWebhook") { segredo = corpo.secret_token; return new Response(JSON.stringify({ ok: true })); }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 500 + tg.length } }));
    }
    return anterior(url, op);
  };
  try {
    const liga = await p.req("/api/admin/telegram", { metodo: "POST", quem: "admin", corpo: {} });
    assert.equal(liga.dados.bot, "DeniaAvisosBot");
    assert.ok(segredo.length >= 20);
    const link = await p.req(`/api/orgs/${inf}/zap/telegram/link`, { metodo: "POST", quem: "admin", corpo: {} });
    assert.match(link.dados.grupo, /^https:\/\/t\.me\/DeniaAvisosBot\?startgroup=/);
    const upd = (texto, extra = {}) => p.req("/webhook/telegram", { metodo: "POST", cabecalhos: { "x-telegram-bot-api-secret-token": segredo }, corpo: { message: { message_id: 10 + tg.length, chat: { id: -100777, type: "supergroup", title: "Equipe Infomix" }, from: { first_name: "Ana" }, text: texto, ...extra } } });
    assert.equal((await p.req("/webhook/telegram", { metodo: "POST", corpo: { message: { text: "/start x" } } })).status, 401, "sem o segredo, recusado");
    await upd(`/start@DeniaAvisosBot ${link.dados.codigo}`);
    assert.match(tg.at(-1).corpo.text, /conectado à DENIA \(Shopping Infomix\)/);
    assert.equal((await p.req(`/api/orgs/${inf}/zap/telegram`, { quem: "admin" })).dados.grupo, "Equipe Infomix");
    // Cliente pede atendente: o aviso vai para o grupo pelo bot da plataforma.
    await p.req(`/api/orgs/${inf}/zap/modelo`, { metodo: "POST", quem: "admin", corpo: { tipo: "servicos" } });
    const CLI = "5521933332222";
    await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "quero falar com atendente" } });
    const aviso = tg.filter(x => x.metodo === "sendMessage").at(-1);
    assert.equal(aviso.corpo.chat_id, "-100777"); assert.match(aviso.corpo.text, /Responda esta mensagem/);
    const idAviso = 500 + tg.indexOf(aviso) + 1;
    // A equipe responde o aviso no Telegram e o cliente recebe no WhatsApp.
    await upd("Oi Marcos! Aqui é a Ana, já te ajudo.", { reply_to_message: { message_id: idAviso } });
    assert.equal(enviadosPara(p, CLI).at(-1).corpo.text.body, "Oi Marcos! Aqui é a Ana, já te ajudo.");
    assert.match(tg.at(-1).corpo.text, /Enviado para/);
    await upd("/resumo");
    assert.match(tg.at(-1).corpo.text, /Mensagens recebidas: 1/);
    // Outro grupo (de outra empresa ou desconhecido) não consegue responder clientes do Infomix.
    const antes = p.engine.enviados.length;
    await p.req("/webhook/telegram", { metodo: "POST", cabecalhos: { "x-telegram-bot-api-secret-token": segredo }, corpo: { message: { message_id: 99, chat: { id: -100888, type: "group" }, text: "oi", reply_to_message: { message_id: idAviso } } } });
    assert.equal(p.engine.enviados.length, antes);
  } finally { globalThis.fetch = anterior; }
});

test("Chatbot — cliente manda várias mensagens seguidas: uma resposta só (menu e IA)", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  p.env.ZAP_JANELA_MS = "250";
  const CLI = "5521944443333";
  await Promise.all(["Oi", "tudo bem?", "queria uma informação"].map((body, i) => new Promise(r => setTimeout(r, i * 40)).then(() => webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body } }))));
  assert.equal(enviadosPara(p, CLI).length, 1, "menu: uma resposta para as três mensagens");
  // Clique em botão responde na hora (sem esperar).
  const antes = Date.now();
  await clicar(p, "111111111111", CLI, "z:inicio");
  assert.ok(Date.now() - antes < 200);
  assert.equal(enviadosPara(p, CLI).length, 2);

  await p.req("/api/orgs/1/ia/chave", { metodo: "POST", quem: "admin", corpo: { chave: "sk-proj-" + "d".repeat(40) } });
  await p.req(`/api/orgs/${inf}/zap/config`, { metodo: "POST", quem: "admin", corpo: { modo: "IA", sobre: "Shopping Infomix: aberto das 10h às 22h." } });
  const entradas = [];
  p.openai = (url, corpo) => {
    const t = corpo.input[0].content[0].text; entradas.push(t);
    return { output: [{ content: [{ type: "output_text", text: JSON.stringify({ resposta: "Abrimos às 10h e fechamos às 22h, Marcos!" }) }] }], usage: { input_tokens: 500, output_tokens: 20 } };
  };
  const CLI2 = "5521933332222";
  await Promise.all(["Boa tarde", "meu nome é Marcos", "que horas vocês abrem?"].map((body, i) => new Promise(r => setTimeout(r, i * 40)).then(() => webhookZap(p, "111111111111", { from: CLI2, type: "text", text: { body } }))));
  assert.equal(enviadosPara(p, CLI2).length, 1, "IA: uma resposta para as três mensagens");
  assert.equal(entradas.length, 1, "a IA é chamada uma vez só");
  assert.match(entradas[0], /MENSAGEM NOVA DO CLIENTE: "Boa tarde\nmeu nome é Marcos\nque horas vocês abrem\?"/, "a IA lê tudo junto");
  // Depois da resposta, uma mensagem nova é respondida normalmente (e só ela é a "nova").
  await webhookZap(p, "111111111111", { from: CLI2, type: "text", text: { body: "obrigado" } });
  assert.equal(enviadosPara(p, CLI2).length, 2);
  assert.match(entradas.at(-1), /MENSAGEM NOVA DO CLIENTE: "obrigado"/);
});

test("Fluxo de botões (como no Botpress) — submenus, lojas em cartões, imagem, link, carrossel e aviso de NOVO CLIENTE no Telegram", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  const z = (c, op) => p.req(`/api/orgs/${inf}/zap/${c}`, { quem: "admin", ...(op || {}) });
  const post = (c, corpo) => z(c, { metodo: "POST", corpo });
  await z("conta/telegram", { metodo: "POST", corpo: { telegram_token: "123456:" + "A".repeat(30), telegram_chat: "-100123456" } });
  const foto = "data:image/jpeg;base64," + Buffer.from("JPEGDATA-foto").toString("base64");
  const midia = await post("midia", { dados: foto });
  assert.equal(midia.status, 200, JSON.stringify(midia.dados));
  assert.match(midia.dados.url, /^\/m\/\d+-[A-Za-z0-9_-]{32}\.jpg$/);
  assert.equal((await post("midia", { dados: "data:text/html;base64,AAAA" })).status, 400);
  await post("config", { boas_vindas: "Olá! Bem-vindo ao Shopping Infomix 😊", imagem_inicio: midia.dados.id });
  const servicos = (await post("itens", { tipo: "MENU", titulo: "🔧 Serviços", texto: "Você selecionou serviços. Qual aparelho?", pai_id: 0 })).dados.id;
  const produtos = (await post("itens", { tipo: "MENU", titulo: "🛍️ Produtos", texto: "O que você procura?", pai_id: 0 })).dados.id;
  const info = (await post("itens", { tipo: "RESPOSTA", titulo: "ℹ️ Informações", texto: "Aberto de seg a sáb, 10h às 22h.", pai_id: 0,
    extra: { imagem_id: midia.dados.id, link_texto: "📍 Como chegar", link_url: "https://maps.google.com/?q=infomix",
      cartoes: [{ titulo: "Promoção de capinhas", texto: "Leve 2, pague 1", imagem_id: midia.dados.id, link_texto: "Ver no Instagram", link_url: "https://instagram.com/infomix" }] } })).dados.id;
  assert.equal((await post("itens", { tipo: "RESPOSTA", titulo: "Ruim", pai_id: 0, extra: { link_texto: "Site", link_url: "javascript:alert(1)" } })).status, 400, "link precisa ser https");
  const celular = (await post("itens", { tipo: "MENU", titulo: "📱 Celular", texto: "Qual conserto?", pai_id: servicos })).dados.id;
  const tela = (await post("itens", { tipo: "LISTA", titulo: "Troca de tela", texto: "Lojas que trocam a tela:", pai_id: celular, extra: { estilo: "CARTOES" } })).dados.id;
  const info2 = (await post("itens", { tipo: "LISTA", titulo: "💻 Informática", pai_id: produtos })).dados.id;
  await post("catalogo", { nome: "Cell Center", whatsapp: "21988887777", local: "Loja 12", itens: [tela, info2] });
  await post("catalogo", { nome: "Tech Fix", whatsapp: "21977776666", local: "Sala 3", descricao: "Troca de tela na hora", itens: [tela] });
  const ord = await post("itens/ordem", { ids: [produtos, servicos, info] });
  assert.equal(ord.status, 200);
  const lista = (await z("itens")).dados;
  assert.equal(lista.itens.find(i => i.id === info).extra.cartoes.length, 1);
  assert.match(lista.itens.find(i => i.id === info).imagens[midia.dados.id], /^\/m\//, "a prévia recebe o endereço da imagem");
  assert.equal(lista.inicio.imagem_id, midia.dados.id);

  const CLI = "5521979862792";
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "oi" } });
  let e = enviadosPara(p, CLI).at(-1);
  assert.equal(e.corpo.interactive.type, "button");
  assert.equal(e.corpo.interactive.header.type, "image", "menu inicial com a imagem no topo");
  assert.deepEqual(e.corpo.interactive.action.buttons.map(b => b.reply.title), ["🛍️ Produtos", "🔧 Serviços", "ℹ️ Informações"], "ordem escolhida no construtor");
  await clicar(p, "111111111111", CLI, "z:i:" + servicos);
  await clicar(p, "111111111111", CLI, "z:i:" + celular);
  const antes = enviadosPara(p, CLI).length;
  await clicar(p, "111111111111", CLI, "z:i:" + tela);
  const novas = enviadosPara(p, CLI).slice(antes);
  assert.equal(novas[0].corpo.text.body, "*Troca de tela*\nLojas que trocam a tela:");
  const cartoes = novas.filter(x => x.corpo.interactive?.type === "cta_url");
  assert.equal(cartoes.length, 2, "uma loja por cartão");
  assert.equal(cartoes[0].corpo.interactive.action.parameters.url, "https://wa.me/5521988887777");
  assert.match(cartoes[1].corpo.interactive.body.text, /\*Tech Fix\*\nSala 3\nTroca de tela na hora/);
  const lead = p.engine.telegram.at(-1);
  assert.match(lead, /^🔔 NOVO CLIENTE!\n\n👤 \*Nome:\* Marcos\n📱 \*WhatsApp:\* 5521979862792\n💬 \*Pedido:\* 🔧 Serviços > 📱 Celular > Troca de tela\n/);
  assert.match(lead, /🕒 \*Horário:\* \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}\n\n#infomix #leads$/);
  assert.doesNotMatch(lead, /Responda esta mensagem/);
  // Resposta com imagem + botão de link + carrossel.
  const n0 = enviadosPara(p, CLI).length;
  await clicar(p, "111111111111", CLI, "z:i:" + info);
  const r = enviadosPara(p, CLI).slice(n0);
  assert.equal(r[0].corpo.interactive.type, "cta_url");
  assert.equal(r[0].corpo.interactive.header.type, "image");
  assert.match(r[0].corpo.interactive.header.image.link, /^https?:\/\/[^/]+\/m\/\d+-/, "imagem com endereço completo para o WhatsApp buscar");
  assert.equal(r[0].corpo.interactive.action.parameters.display_text, "📍 Como chegar");
  assert.match(r[1].corpo.interactive.body.text, /\*Promoção de capinhas\*\nLeve 2, pague 1/);
  assert.equal(r.at(-1).corpo.interactive.type, "button", "depois vem Menu inicial / Voltar / Finalizar");
  // Etiquetas próprias e aviso desligado por opção.
  await post("config", { lead_titulo: "🔔 Cliente novo", lead_tags: "infomix, vendas" });
  await post("itens", { id: info2, tipo: "LISTA", titulo: "💻 Informática", pai_id: produtos, extra: { lead: false } });
  const tg = p.engine.telegram.length;
  await clicar(p, "111111111111", CLI, "z:i:" + info2);
  assert.equal(p.engine.telegram.length, tg, "opção com aviso desligado não manda para o Telegram");
  await clicar(p, "111111111111", CLI, "z:i:" + tela);
  assert.equal(p.engine.telegram.length, tg, "o mesmo pedido em menos de 1 hora não repete o aviso");
  const CLI2 = "5521911112222";
  await clicar(p, "111111111111", CLI2, "z:i:" + tela);
  assert.match(p.engine.telegram.at(-1), /^🔔 Cliente novo\n[\s\S]*#infomix #vendas$/);
  // Imagem de outra empresa não pode ser usada.
  const outra = await p.req(`/api/orgs/1/zap/midia`, { metodo: "POST", quem: "admin", corpo: { dados: foto } });
  await post("itens", { id: info, tipo: "RESPOSTA", titulo: "ℹ️ Informações", texto: "x", pai_id: 0, extra: { imagem_id: outra.dados.id } });
  assert.equal((await z("itens")).dados.itens.find(i => i.id === info).extra.imagem_id, undefined);
});

test("Roteiro em texto (vindo do Botpress) — boas-vindas separada, qualquer mensagem mostra o começo, lojas numa mensagem com links próprios", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  const z = (c, op) => p.req(`/api/orgs/${inf}/zap/${c}`, { quem: "admin", ...(op || {}) });
  const roteiro = `# comentário
BOAS-VINDAS: Olá! Bem-vindo ao Atendimento Digital do Shopping Teste, o maior hub do bairro.
MENU: Escolha abaixo o que você procura hoje:
DEPOIS DE CADA RESPOSTA: Posso ajudar com algo mais?
BOTÕES DO FIM: Menu Principal | Menu Anterior | Finalizar
RODAPÉ DAS LOJAS: -
ENCERRAMENTO: Rua Exemplo, 10.
Site: https://exemplo.test/

Foi um prazer!

> Produtos
Qual tipo de produto está buscando?

>> Celular
Estes são os contatos de algumas lojas:
Loja A - Loja dos Celulares | https://tinyurl.com/teste-celulares
Loja 04- Conserta Celular | https://tinyurl.com/teste-conserta

>> Informática
Estes são os contatos:
Loja 04 - Conserta Celular | https://tinyurl.com/teste-conserta-2
Sala 12 Oficina | 21 98888-7777

> Serviços
Você selecionou serviços.

Informe o serviço:
${Array.from({ length: 10 }, (_, i) => `>> Serviço ${i + 1}\nLoja ${i} - Oficina ${i} | https://tinyurl.com/oficina-${i}`).join("\n")}

> Falar com alguém [atendente]
Vou chamar a equipe.`;
  const ruim = await z("roteiro", { metodo: "POST", corpo: { roteiro: "> A\n>>> B\nx" } });
  assert.equal(ruim.status, 400);
  assert.match(ruim.dados.erros.join(" "), /pulou um nível/);
  const previa = await z("roteiro", { metodo: "POST", corpo: { roteiro, previa: true } });
  assert.equal(previa.status, 200, JSON.stringify(previa.dados));
  assert.deepEqual([previa.dados.botoes, previa.dados.lojas], [15, 14]);
  const ok = await z("roteiro", { metodo: "POST", corpo: { roteiro } });
  assert.equal(ok.status, 200, JSON.stringify(ok.dados));
  assert.equal((await z("roteiro", { metodo: "POST", corpo: { roteiro } })).status, 409, "pede confirmação para substituir");
  const cat = (await z("itens")).dados.catalogo;
  assert.equal(cat.filter(c => c.nome.includes("Conserta Celular")).length, 2, "mesma loja com links diferentes: cada link continua o mesmo");

  const CLI = "5521966665555";
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "quero consertar meu telefone" } });
  let e = enviadosPara(p, CLI);
  assert.equal(e.at(-2).corpo.text.body, "Olá! Bem-vindo ao Atendimento Digital do Shopping Teste, o maior hub do bairro.", "boas-vindas sozinha");
  assert.equal(e.at(-1).corpo.interactive.body.text, "Escolha abaixo o que você procura hoje:");
  assert.deepEqual(e.at(-1).corpo.interactive.action.buttons.map(b => b.reply.title), ["Produtos", "Serviços", "Falar com alguém"]);
  const itens = (await z("itens")).dados.itens;
  const id = t => itens.find(i => i.titulo === t).id;
  await clicar(p, "111111111111", CLI, "z:i:" + id("Produtos"));
  await clicar(p, "111111111111", CLI, "z:i:" + id("Celular"));
  e = enviadosPara(p, CLI);
  assert.equal(e.at(-2).corpo.text.body, "Estes são os contatos de algumas lojas:\n\nLoja A - Loja dos Celulares\nhttps://tinyurl.com/teste-celulares\n\nLoja 04- Conserta Celular\nhttps://tinyurl.com/teste-conserta", "todas as lojas numa mensagem, com os nomes e links exatos");
  assert.equal(e.at(-1).corpo.interactive.body.text, "Posso ajudar com algo mais?");
  assert.deepEqual(e.at(-1).corpo.interactive.action.buttons.map(b => b.reply.title), ["Menu Principal", "Menu Anterior", "Finalizar"]);
  await clicar(p, "111111111111", CLI, "z:i:" + id("Informática"));
  assert.match(enviadosPara(p, CLI).at(-2).corpo.text.body, /Sala 12 Oficina\nhttps:\/\/wa\.me\/5521988887777/);
  await clicar(p, "111111111111", CLI, "z:i:" + id("Serviços"));
  e = enviadosPara(p, CLI).at(-1);
  assert.equal(e.corpo.interactive.type, "list");
  assert.equal(e.corpo.interactive.action.sections[0].rows.length, 10, "10 opções numa lista só");
  assert.match(e.corpo.interactive.body.text, /^Você selecionou serviços\.\n\nInforme o serviço:/);
  await clicar(p, "111111111111", CLI, "z:fim");
  assert.equal(enviadosPara(p, CLI).at(-1).corpo.text.body, "Rua Exemplo, 10.\nSite: https://exemplo.test/\n\nFoi um prazer!");
  // Exportar e aplicar de novo dá o mesmo fluxo.
  const exp = (await z("roteiro")).dados.roteiro;
  assert.match(exp, /^BOAS-VINDAS: Olá!/);
  assert.match(exp, />> Celular\nEstes são os contatos de algumas lojas:\nLoja A - Loja dos Celulares \| https:\/\/tinyurl\.com\/teste-celulares/);
  const de_novo = await z("roteiro", { metodo: "POST", corpo: { roteiro: exp, substituir: true } });
  assert.equal(de_novo.dados.botoes, 15);
  assert.equal(de_novo.dados.lojas_novas, 0, "lojas reaproveitadas pelo link");
});

test("Importar do Botpress — mesma ordem, mesmos textos, mensagens separadas, rodapé e aviso só onde o Botpress avisava", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  const z = (c, op) => p.req(`/api/orgs/${inf}/zap/${c}`, { quem: "admin", ...(op || {}) });
  await z("conta/telegram", { metodo: "POST", corpo: { telegram_token: "123456:" + "A".repeat(30), telegram_chat: "-100123456" } });
  const txt = t => ({ type: "content", content: { type: "text", text: { valueType: "dynamic", dynamicValue: t } } });
  const ir = d => ({ type: "transition", condition: { payload: "true" }, destination: { node: d } });
  const pergunta = (q, ops) => ({ type: "capture", question: { dynamicValue: q }, transitions: ops.map(([l, d]) => ({ label: l, condition: { payload: "__CHOICE=" + l }, destination: { node: d } })) });
  const fim = [["Menu Pincipal", "menu"], ["Menu Anterior", "menu"], ["Finalizar", "tchau"]];
  const aviso = { type: "action", hashtags: "#shop #leads", titulo: "🔔 NOVO CLIENTE!" };
  const bot = { flows: [{ name: "Error", nodes: [] }, { name: "Main", startNode: "s", nodes: [
    { id: "s", type: "start", instructions: [ir("ini")] },
    { id: "ini", type: "standard", instructions: [txt("Olá! Bem-vindo ao Shopping Teste.")], defaultTransition: { targetNodeId: "menu" } },
    { id: "menu", type: "standard", instructions: [pergunta("Escolha abaixo que você procura hoje:", [["Serviços", "serv"], ["Produtos", "prod"], ["Informações", "info"]])] },
    { id: "serv", type: "standard", instructions: [txt("Você selecionou serviços. "), pergunta("Informe o serviço:", [["Celular", "a1"], ["Refrigeração | Lava e Seca", "a2"]])] },
    { id: "a1", type: "standard", instructions: [aviso], defaultTransition: { targetNodeId: "l1" } },
    { id: "l1", type: "standard", instructions: [txt("Estes são os contatos:"), txt("Loja A - Celulares \nhttps://tinyurl.com/t-cel"), txt("Loja: 03 - Games\nhttps://tinyurl.com/t-games"), pergunta("Posso ajudar com algo mais?", fim)] },
    { id: "a2", type: "standard", instructions: [aviso], defaultTransition: { targetNodeId: "l2" } },
    { id: "l2", type: "standard", instructions: [txt("Estes são os contatos:"), txt("Loja 05 - Frio\nhttps://tinyurl.com/t-frio"), pergunta("Posso ajudar com algo mais?", fim)] },
    { id: "prod", type: "standard", instructions: [pergunta("Qual tipo de produto?", [["Informática", "a1"], ["Celular", "a1"]])] },
    { id: "info", type: "standard", instructions: [pergunta("Qual informação Gostaria?", [["Endereço", "end"], ["Horário de funcionamento", "hor"]])] },
    { id: "end", type: "standard", instructions: [txt("Rua Teste, 1."), pergunta("Posso ajudar com algo mais?", fim)] },
    { id: "hor", type: "standard", instructions: [txt("Seg a sex, 9h às 19h."), pergunta("Posso ajudar com algo mais?", fim)] },
    { id: "tchau", type: "standard", instructions: [txt("Site: https://teste.test/"), txt("Foi um prazer atendê-lo(a)!")], defaultTransition: { targetNodeId: "e" } },
    { id: "e", type: "end", instructions: [] }] }] };
  // O grupo ligado pelo botão da DENIA dá lugar ao bot próprio vindo do Botpress.
  p.env.DB.db.prepare("UPDATE plt_zap_contas SET telegram_chat='-100999' WHERE org_id=?").run(inf);
  await z("conta/telegram", { metodo: "POST", corpo: { telegram_token: "654321:" + "B".repeat(30), telegram_chat: "-5000000001" } });
  assert.equal(p.env.DB.q("SELECT telegram_chat FROM plt_zap_contas WHERE org_id=?", inf)[0].telegram_chat, null);
  const conv = await z("botpress", { metodo: "POST", corpo: { bot } });
  assert.equal(conv.status, 200, JSON.stringify(conv.dados));
  const rot = conv.dados.roteiro;
  assert.match(rot, /\n> Serviços\nVocê selecionou serviços\.\n---\nInforme o serviço:\n\n>> Celular\n/, "mesma ordem e mensagens separadas");
  assert.match(rot, />> Refrigeração\|Lava e Seca/, "nome encurtado só porque passa de 24 letras");
  assert.match(rot, />> Endereço \[sem aviso\]/);
  assert.match(rot, /ETIQUETAS DO AVISO: #shop #leads/);
  assert.equal((await z("botpress", { metodo: "POST", corpo: { bot: { flows: [] } } })).status, 400);
  assert.equal((await z("roteiro", { metodo: "POST", corpo: { roteiro: rot } })).status, 200);

  const CLI = "5521955554444";
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "boa tarde" } }, "Henrique");
  let e = enviadosPara(p, CLI);
  assert.equal(e.at(-2).corpo.text.body, "Olá! Bem-vindo ao Shopping Teste.");
  assert.equal(e.at(-1).corpo.interactive.body.text, "Escolha abaixo que você procura hoje:");
  assert.deepEqual(e.at(-1).corpo.interactive.action.buttons.map(b => b.reply.title), ["Serviços", "Produtos", "Informações"]);
  const itens = (await z("itens")).dados.itens;
  const id = (t, pai) => itens.find(i => i.titulo === t && (pai === undefined || i.pai_id === pai)).id;
  await clicar(p, "111111111111", CLI, "z:i:" + id("Serviços"));
  e = enviadosPara(p, CLI);
  assert.equal(e.at(-2).corpo.text.body, "Você selecionou serviços.", "primeiro balão");
  assert.equal(e.at(-1).corpo.interactive.body.text, "Informe o serviço:", "segundo balão, com os botões");
  await clicar(p, "111111111111", CLI, "z:i:" + id("Celular", id("Serviços")));
  e = enviadosPara(p, CLI);
  assert.equal(e.at(-2).corpo.text.body, "Estes são os contatos:\n\nLoja A - Celulares\nhttps://tinyurl.com/t-cel\n\nLoja: 03 - Games\nhttps://tinyurl.com/t-games");
  assert.deepEqual(e.at(-1).corpo.interactive.action.buttons.map(b => b.reply.title), ["Menu Principal", "Menu Anterior", "Finalizar"]);
  assert.equal(p.engine.telegram.at(-1).replace(/\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}/, "DATA"), "🔔 NOVO CLIENTE!\n\n👤 *Nome:* Marcos\n📱 *WhatsApp:* 5521955554444\n💬 *Pedido:* Serviços > Celular\n🕒 *Horário:* DATA\n\n#shop #leads", "mesmo aviso do Botpress");
  const nAvisos = p.engine.telegram.length;
  await clicar(p, "111111111111", CLI, "z:i:" + id("Informações"));
  e = enviadosPara(p, CLI).at(-1);
  assert.equal(e.corpo.interactive.type, "list", "\"Horário de funcionamento\" não cabe num botão (20 letras): vira lista e o nome fica inteiro");
  assert.deepEqual(e.corpo.interactive.action.sections[0].rows.map(r => [r.title, r.description]), [["Endereço", undefined], ["Horário de funcionamento", undefined]]);
  assert.equal(e.corpo.interactive.body.text, "Qual informação Gostaria?", "lista simples, sem dica extra");
  await clicar(p, "111111111111", CLI, "z:i:" + id("Endereço"));
  assert.equal(p.engine.telegram.length, nAvisos, "informação não manda aviso (o Botpress também não mandava)");
  const antes = enviadosPara(p, CLI).length;
  await clicar(p, "111111111111", CLI, "z:fim");
  assert.deepEqual(enviadosPara(p, CLI).slice(antes).map(x => x.corpo.text.body), ["Site: https://teste.test/", "Foi um prazer atendê-lo(a)!"], "encerramento em dois balões");
});

test("Importar do Typebot — balões, botões, setas, lojas e rodapé viram o mesmo fluxo", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  const z = (c, op) => p.req(`/api/orgs/${inf}/zap/${c}`, { quem: "admin", ...(op || {}) });
  const bal = (id, t) => ({ id, type: "text", content: { richText: [{ type: "p", children: [{ text: t }] }] } });
  const bot = (id, itens) => ({ id, type: "choice input", items: itens.map(([i, t, e]) => ({ id: i, content: t, outgoingEdgeId: e })) });
  const fim = n => bot("f" + n, [["fi1" + n, "Menu Principal", "eMenu" + n], ["fi2" + n, "Menu Anterior", "eAnt" + n], ["fi3" + n, "Finalizar", "eFim" + n]]);
  const typebot = { version: "6", events: [{ id: "ev", type: "start", outgoingEdgeId: "e0" }],
    groups: [
      { id: "g1", title: "Início", blocks: [bal("b1", "Olá! Bem-vindo ao Shopping Teste."), bal("b2", "Escolha abaixo:"), bot("c1", [["i1", "Serviços", "e1"], ["i2", "Informações", "e2"]])] },
      { id: "g2", title: "Serviços", blocks: [bal("b3", "Qual serviço?"), bot("c2", [["i3", "Celular", "e3"]])] },
      { id: "g3", title: "Celular", blocks: [bal("b4", "Estes são os contatos:"), bal("b5", "Loja A - Celulares"), { id: "b5b", type: "text", content: { richText: [{ type: "p", children: [{ type: "a", url: "https://tinyurl.com/tb-cel", children: [{ text: "https://tinyurl.com/tb-cel" }] }] }] } }, bal("b6", "Posso ajudar com algo mais?"), fim(1)] },
      { id: "g4", title: "Info", blocks: [bal("b7", "Rua Teste, 1."), bal("b8", "Posso ajudar com algo mais?"), fim(2)] },
      { id: "g5", title: "Fim", blocks: [bal("b9", "Foi um prazer!")] }],
    edges: [{ id: "e0", from: { eventId: "ev" }, to: { groupId: "g1" } }, { id: "e1", from: { blockId: "c1", itemId: "i1" }, to: { groupId: "g2" } }, { id: "e2", from: { blockId: "c1", itemId: "i2" }, to: { groupId: "g4" } },
      { id: "e3", from: { blockId: "c2", itemId: "i3" }, to: { groupId: "g3" } },
      ...[1, 2].flatMap(n => [{ id: "eMenu" + n, to: { groupId: "g1" } }, { id: "eAnt" + n, to: { groupId: "g1" } }, { id: "eFim" + n, to: { groupId: "g5" } }])] };
  const conv = await z("botpress", { metodo: "POST", corpo: { typebot } });
  assert.equal(conv.status, 200, JSON.stringify(conv.dados));
  const rot = conv.dados.roteiro;
  assert.match(rot, /BOAS-VINDAS: Olá! Bem-vindo ao Shopping Teste\.\nMENU: Escolha abaixo:/);
  assert.match(rot, /DEPOIS DE CADA RESPOSTA: Posso ajudar com algo mais\?/);
  assert.match(rot, /ENCERRAMENTO: Foi um prazer!/);
  assert.match(rot, /> Serviços\nQual serviço\?\n\n>> Celular\nEstes são os contatos:\nLoja A - Celulares \| https:\/\/tinyurl\.com\/tb-cel/);
  assert.match(rot, /> Informações \[sem aviso\]\nRua Teste, 1\.\n/);
  assert.doesNotMatch(rot, /Rua Teste, 1\.\n---\nPosso ajudar/, "a pergunta do fim não entra na resposta");
  assert.equal((await z("roteiro", { metodo: "POST", corpo: { roteiro: rot } })).status, 200);
  const CLI = "5521944441111";
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "oi" } });
  const e = enviadosPara(p, CLI);
  assert.equal(e.at(-2).corpo.text.body, "Olá! Bem-vindo ao Shopping Teste.");
  assert.deepEqual(e.at(-1).corpo.interactive.action.buttons.map(b => b.reply.title), ["Serviços", "Informações"]);
  assert.equal((await z("botpress", { metodo: "POST", corpo: { typebot: { groups: [] } } })).status, 400);
});

test("IA completa — qualquer empresa: conversa como gente, lembra do cliente, não mistura empresas e chama a equipe", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  await p.req("/api/orgs/1/ia/chave", { metodo: "POST", quem: "admin", corpo: { chave: "sk-proj-" + "d".repeat(40) } });
  await p.req(`/api/orgs/${inf}/zap/modelo`, { metodo: "POST", quem: "admin", corpo: { tipo: "shopping" } });
  await p.req(`/api/orgs/${inf}/zap/config`, { metodo: "POST", quem: "admin", corpo: { modo: "IA", nome_atendente: "Bia", sobre: "Shopping Infomix: aberto de segunda a sábado, 10h às 22h. Estacionamento grátis por 2 horas.", ia_tom: "Simpática e direta." } });
  await p.req(`/api/orgs/1/zap/config`, { metodo: "POST", quem: "admin", corpo: { modo: "IA", sobre: "Central de Atendimento: eletricistas e chaveiros 24h." } });
  const entradas = [];
  p.openai = (url, corpo) => {
    const t = corpo.input[0].content[0].text; entradas.push({ t, modelo: corpo.model });
    const nova = t.match(/MENSAGEM NOVA DO CLIENTE: "([^"]*)"/)[1];
    let o = { resposta: "Oi! Como posso ajudar?" };
    if (/estacionamento/i.test(nova)) o = { resposta: "Temos estacionamento grátis por 2 horas! 🚗", lembrar: "Vem de carro." };
    if (/meu nome é/i.test(nova)) o = { resposta: "Prazer, Marcos!", lembrar: "Chama-se Marcos." };
    if (/parking/i.test(nova)) o = { resposta: "Yes! Free parking for 2 hours." };
    if (/gerente|reembolso/i.test(nova)) o = { resposta: "Entendo. Vou chamar alguém da equipe agora.", humano: true };
    return { output: [{ content: [{ type: "output_text", text: JSON.stringify(o) }] }], usage: { input_tokens: 900, output_tokens: 40 } };
  };
  const CLI = "5521977770000";
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "Oi, meu nome é Marcos" } });
  assert.equal(enviadosPara(p, CLI).at(-1).corpo.text.body, "Prazer, Marcos!");
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "tem estacionamento?" } });
  assert.match(enviadosPara(p, CLI).at(-1).corpo.text.body, /estacionamento grátis/);
  const ultima = entradas.at(-1);
  assert.equal(ultima.modelo, "gpt-5-mini");
  assert.match(ultima.t, /SEU NOME NO ATENDIMENTO: Bia/);
  assert.match(ultima.t, /Chama-se Marcos/, "lembra do que o cliente disse");
  assert.match(ultima.t, /CLIENTE: Oi, meu nome é Marcos[\s\S]*VOCÊ: Prazer, Marcos!/, "lê a conversa");
  assert.doesNotMatch(ultima.t, /eletricistas/, "só os dados desta empresa");
  // O mesmo número falando com a outra empresa: memória e treinamento da outra empresa, sem misturar.
  await webhookZap(p, "222222222222", { from: CLI, type: "text", text: { body: "boa noite" } });
  const outra = entradas.at(-1).t;
  assert.match(outra, /eletricistas/); assert.doesNotMatch(outra, /Chama-se|Vem de carro|Infomix|estacionamento|Prazer/);
  // Idioma do cliente.
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "do you have parking?" } });
  assert.equal(enviadosPara(p, CLI).at(-1).corpo.text.body, "Yes! Free parking for 2 hours.");
  // Assunto sensível: chama a equipe e pausa.
  await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: "quero reembolso de uma compra" } });
  assert.match(enviadosPara(p, CLI).at(-1).corpo.text.body, /chamar alguém/);
  const conv = (await p.req(`/api/orgs/${inf}/zap/conversas/${CLI}`, { quem: "admin" })).dados;
  assert.equal(conv.contato.pausado, true); assert.match(conv.contato.memoria, /Vem de carro/);
  // Botões continuam funcionando no modo IA, sem gastar IA.
  await p.req(`/api/orgs/${inf}/zap/conversas/${CLI}/robo`, { metodo: "POST", quem: "admin", corpo: { ligar: true } });
  const n = entradas.length;
  await clicar(p, "111111111111", CLI, "z:inicio");
  assert.equal(enviadosPara(p, CLI).at(-1).corpo.interactive.type, "button"); assert.equal(entradas.length, n);
  // Plano sem IA completa (Essencial): não deixa ligar o modo IA.
  const anaOrg = await p.req("/api/cadastro", { metodo: "POST", quem: "ana", corpo: { nome: "Ana", empresa: "Loja Ana", email: "ana@x.test", senha: "SenhaMuitoForte#2026", aceite: true, plano: "essencial" } });
  const oa = (await p.req("/api/eu", { quem: "ana" })).dados.organizacoes[0];
  const r = await p.req(`/api/orgs/${oa.id}/zap/config`, { metodo: "POST", quem: "ana", corpo: { modo: "IA" } });
  assert.equal(r.status, 402); assert.match(r.dados.erro, /Start/);
  assert.equal(anaOrg.status, 200);
});

test("Chatbot — a IA monta o chatbot a partir da descrição (pergunta o essencial e aplica)", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  await p.req("/api/orgs/1/ia/chave", { metodo: "POST", quem: "admin", corpo: { chave: "sk-proj-" + "e".repeat(40) } });
  let vez = 0;
  p.openai = () => {
    vez++;
    const o = vez === 1 ? { perguntas: ["Qual o horário de funcionamento?"] } : { plano: { modo: "BOTOES", boas_vindas: "Olá! Bem-vindo ao Infomix 👋", humano: "Já chamo alguém!", rotulo_catalogo: "lojas", sobre: "Seg a sáb, 10h às 22h.",
      menu: [{ tipo: "MENU", titulo: "🛍️ Produtos com um título comprido demais", texto: "O que procura?", filhos: [{ tipo: "LISTA", titulo: "Celulares", palavras: "celular, smartphone" }] }, { tipo: "RESPOSTA", titulo: "🕒 Horário", texto: "Seg a sáb, 10h às 22h." }, { tipo: "HUMANO", titulo: "💬 Falar com alguém" }] } };
    return { output: [{ content: [{ type: "output_text", text: JSON.stringify(o) }] }] };
  };
  const desc = "Shopping com lojas de celular e informática; quero que o cliente ache a loja pelo WhatsApp.";
  const r1 = await p.req(`/api/orgs/${inf}/zap/assistente`, { metodo: "POST", quem: "admin", corpo: { descricao: desc } });
  assert.deepEqual(r1.dados.perguntas, ["Qual o horário de funcionamento?"]);
  const r2 = await p.req(`/api/orgs/${inf}/zap/assistente`, { metodo: "POST", quem: "admin", corpo: { descricao: desc, respostas: [{ pergunta: "Qual o horário?", resposta: "10h às 22h" }] } });
  assert.equal(r2.dados.plano.menu[0].titulo.length <= 24, true);
  const ap = await p.req(`/api/orgs/${inf}/zap/assistente`, { metodo: "POST", quem: "admin", corpo: { acao: "aplicar", plano: r2.dados.plano } });
  assert.equal(ap.dados.opcoes, 4);
  const cfg = (await p.req(`/api/orgs/${inf}/zap/config`, { quem: "admin" })).dados.config;
  assert.equal(cfg.boas_vindas, "Olá! Bem-vindo ao Infomix 👋"); assert.equal(cfg.rotulo_catalogo, "lojas");
  assert.equal((await p.req(`/api/orgs/${inf}/zap/assistente`, { metodo: "POST", quem: "admin", corpo: { acao: "aplicar", plano: r2.dados.plano } })).status, 409, "não apaga o menu sem confirmar");
  const t = await p.req(`/api/orgs/${inf}/zap/testar`, { metodo: "POST", quem: "admin", corpo: { texto: "oi" } });
  assert.match(t.dados.respostas[0].interativo.body.text, /Bem-vindo ao Infomix/);
});

// ===== Locação por temporada
const ICAL_AIRBNB = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261020", "DTEND;VALUE=DATE:20261025", "UID:abc123@airbnb.com", "SUMMARY:Reserved", "DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HM123\\nPhone Number (Last 4 Digits): 1234", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261103", "UID:blk1@airbnb.com", "SUMMARY:Airbnb (Not available)", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
test("Temporada — imóvel, calendário do Airbnb importado, calendário único para o Booking e reserva dupla bloqueada", async () => {
  const p = await criarPlataforma();
  let relogio = Date.parse("2026-10-16T12:00:00Z");
  p.env.__agora = () => relogio;
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  p.web = { "https://www.airbnb.com.br/calendar/ical/111.ics?s=abc": ICAL_AIRBNB };
  const im = await p.req("/api/orgs/1/tp/imoveis", { metodo: "POST", quem: "admin", corpo: { nome: "Apto Copacabana 302", cidade: "Rio de Janeiro", capacidade: 4, preco_base: 400, preco_fds: 520, minimo_noites: 2, ajustes: { airbnb: 0, booking: 18, vrbo: 10 } } });
  assert.equal(im.status, 200);
  const id = im.dados.id;
  const cal = await p.req(`/api/orgs/1/tp/imoveis/${id}/calendarios`, { metodo: "POST", quem: "admin", corpo: { url: "https://www.airbnb.com.br/calendar/ical/111.ics?s=abc" } });
  assert.equal(cal.dados.ok, true); assert.equal(cal.dados.eventos, 2);
  const res = (await p.req("/api/orgs/1/tp/reservas", { quem: "admin" })).dados.reservas;
  assert.equal(res.length, 1); assert.equal(res[0].canal, "airbnb"); assert.equal(res[0].noites, 5);
  const det = (await p.req(`/api/orgs/1/tp/imoveis/${id}`, { quem: "admin" })).dados.imovel;
  const token = det.ical_url.match(/ical\/([a-f0-9]+)\.ics/)[1];
  const paraBooking = await (await p.req(`/tp/ical/${token}/booking.ics`)).r.text();
  assert.match(paraBooking, /DTSTART;VALUE=DATE:20261020/); assert.match(paraBooking, /DTEND;VALUE=DATE:20261025/);
  assert.doesNotMatch(await (await p.req(`/tp/ical/${token}/airbnb.ics`)).r.text(), /20261020/, "o Airbnb não recebe de volta as reservas dele");
  const dupla = await p.req("/api/orgs/1/tp/reservas", { metodo: "POST", quem: "admin", corpo: { imovel_id: id, inicio: "2026-10-22", fim: "2026-10-24", hospede: "Direto" } });
  assert.equal(dupla.status, 409); assert.equal(dupla.dados.codigo, "CONFLITO");
  // Limpeza agendada para o dia da saída.
  const limp = (await p.req("/api/orgs/1/tp/limpezas", { quem: "admin" })).dados.limpezas;
  assert.equal(limp[0].data, "2026-10-25");
  // Preço: fim de semana e ajuste por plataforma no calendário.
  const c = (await p.req("/api/orgs/1/tp/calendario?de=2026-10-23&ate=2026-10-24", { quem: "admin" })).dados;
  assert.equal(c.imoveis[0].precos[0].preco, 520, "sexta à noite = fim de semana");
  // Cancelaram no Airbnb: o evento some do calendário e a DENIA marca como cancelada.
  p.web["https://www.airbnb.com.br/calendar/ical/111.ics?s=abc"] = ICAL_AIRBNB.replace(/BEGIN:VEVENT[\s\S]*?abc123[\s\S]*?END:VEVENT\r\n/, "");
  relogio = Date.parse("2026-10-16T13:00:00Z");
  await p.req(`/api/orgs/1/tp/calendarios/${cal.dados.id}/sincronizar`, { metodo: "POST", quem: "admin", corpo: {} });
  assert.equal((await p.req("/api/orgs/1/tp/reservas", { quem: "admin" })).dados.reservas.find(r => r.inicio === "2026-10-20").status, "CANCELADA");
});

test("Temporada — conexão oficial (Channex): preço por plataforma, reserva e mensagem chegam, IA responde no idioma do hóspede", async () => {
  const p = await criarPlataforma({ CHANNEX_API_KEY: "cx_teste", CHANNEX_STAGING: "1" });
  p.env.__agora = () => Date.parse("2026-10-16T12:00:00Z");
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/ia/chave", { metodo: "POST", quem: "admin", corpo: { chave: "sk-proj-" + "f".repeat(40) } });
  let n = 0;
  p.channex = (caminho, metodo, corpo) => {
    if (caminho === "/properties") return { data: { id: "prop-1" } };
    if (caminho === "/room_types") return { data: { id: "room-1" } };
    if (caminho === "/rate_plans") return { data: { id: "rate-" + (++n) } };
    if (caminho === "/auth/one_time_token") return { data: { token: "tok123" } };
    if (caminho === "/bookings/bk-9") return { data: { attributes: { ota_name: "Booking.com", status: "new", arrival_date: "2026-11-10", departure_date: "2026-11-13", amount: "1500.00", currency: "BRL", customer: { name: "Anna", surname: "Müller", mail: "anna@guest.booking.com" }, occupancy: { adults: 2, children: 0 } } } };
    return { data: {} };
  };
  const id = (await p.req("/api/orgs/1/tp/imoveis", { metodo: "POST", quem: "admin", corpo: { nome: "Casa Búzios", capacidade: 6, preco_base: 800, ajustes: { airbnb: 0, booking: 20, vrbo: 10 }, ia_modo: "AUTO", treinamento: { checkin: "Check-in às 15h, chave no cofre (código enviado no dia).", wifi: "Rede CasaBuzios, senha mar2026" } } })).dados.id;
  const con = await p.req(`/api/orgs/1/tp/imoveis/${id}/conectar`, { metodo: "POST", quem: "admin", corpo: {} });
  assert.match(con.dados.url, /^https:\/\/staging\.channex\.io\/auth\/exchange\?oauth_session_key=tok123/);
  const rest = p.channexChamadas.filter(c => c.caminho === "/restrictions").flatMap(c => c.corpo.values);
  const doDia = rest.filter(v => v.date_from === "2026-10-20");
  assert.deepEqual(doDia.map(v => v.rate).sort(), ["800.00", "880.00", "960.00"], "Airbnb 800, Vrbo +10%, Booking +20%");
  // Mudar o preço de um período: vai para as três plataformas.
  p.channexChamadas.length = 0;
  await p.req("/api/orgs/1/tp/precos", { metodo: "POST", quem: "admin", corpo: { imovel_id: id, de: "2026-12-28", ate: "2027-01-02", preco: 1500, minimo: 4 } });
  const vals = p.channexChamadas.filter(c => c.caminho === "/restrictions").flatMap(c => c.corpo.values);
  assert.equal(vals.length, 18); assert.ok(vals.every(v => v.min_stay_arrival === 4));
  assert.ok(vals.some(v => v.rate === "1800.00"));
  // Webhook do Channex: sem o token, recusado; com ele, a reserva entra.
  const cfg = (await p.req("/api/orgs/1/tp/config", { quem: "admin" })).dados;
  const caminhoWebhook = cfg.webhook.replace(/^https?:\/\/[^/]+/, "");
  assert.equal((await p.req("/webhook/channex?org=1&t=errado", { metodo: "POST", corpo: { event: "booking", payload: {} } })).status, 401);
  await p.req(caminhoWebhook, { metodo: "POST", corpo: { event: "booking_new", payload: { property_id: "prop-1", booking_id: "bk-9", revision_id: "rev-1" } } });
  const r = (await p.req("/api/orgs/1/tp/reservas", { quem: "admin" })).dados.reservas.find(x => x.canal === "booking");
  assert.equal(r.hospede, "Anna Müller"); assert.equal(r.valor, 1500); assert.equal(r.hospedes, 2);
  assert.ok(p.channexChamadas.some(c => c.caminho === "/booking_revisions/rev-1/ack"));
  // Mensagem do hóspede em alemão: a IA responde em alemão (com tradução para o anfitrião) e envia (modo automático).
  p.openai = (url, corpo) => {
    const t = corpo.input[0].content[0].text;
    assert.match(t, /Rede CasaBuzios/); assert.match(t, /Anna Müller/);
    assert.match(t, /RESPONDER EM: no idioma em que o hóspede escreveu/);
    return { output: [{ content: [{ type: "output_text", text: JSON.stringify({ resposta: "Hallo Anna! Das WLAN heißt CasaBuzios, Passwort mar2026. 😊", traducao: "Olá Anna! O Wi-Fi é CasaBuzios, senha mar2026.", traducao_hospede: "Olá! Qual é a senha do Wi-Fi?", precisa_anfitriao: false, risco: "baixo" }) }] }] };
  };
  await p.req(caminhoWebhook, { metodo: "POST", corpo: { event: "message", payload: { property_id: "prop-1", booking_id: "bk-9", id: "msg-1", message: "Hallo! Wie ist das WLAN-Passwort?", sender: "guest" } } });
  const enviada = p.channexChamadas.find(c => c.caminho === "/bookings/bk-9/messages");
  assert.match(enviada.corpo.message.message, /Hallo Anna/);
  const conv = (await p.req(`/api/orgs/1/tp/mensagens/${r.id}`, { quem: "admin" })).dados.mensagens;
  assert.equal(conv.length, 2); assert.match(conv[1].traducao, /Olá Anna/);
  assert.equal(conv[0].traducao, "Olá! Qual é a senha do Wi-Fi?", "o anfitrião lê a mensagem do hóspede em português");
  // Visão geral: receita e reservas por plataforma.
  const v = (await p.req("/api/orgs/1/tp/visao?de=2026-11-01&ate=2026-11-30", { quem: "admin" })).dados;
  assert.equal(v.receita, 1500); assert.equal(v.por_canal[0].nome, "Booking.com"); assert.equal(v.noites_ocupadas, 3);
  assert.equal(v.ocupacao, Math.round((3 / 30) * 1000) / 10);
});

test("Temporada — plano: o Essencial não inclui; o plano Temporada libera até 5 imóveis", async () => {
  const p = await criarPlataforma();
  await p.req("/api/cadastro", { metodo: "POST", quem: "ana", corpo: { nome: "Ana", empresa: "Ana Temporada", email: "ana@temp.test", senha: "SenhaMuitoForte#2026", aceite: true, plano: "essencial" } });
  const org = (await p.req("/api/eu", { quem: "ana" })).dados.organizacoes[0];
  const bloq = await p.req(`/api/orgs/${org.id}/tp/imoveis`, { quem: "ana" });
  assert.equal(bloq.status, 402); assert.equal(bloq.dados.plano_minimo.id, "temporada");
  p.env.DB.db.prepare("UPDATE plt_organizacoes SET plano='temporada' WHERE id=?").run(org.id);
  for (let i = 0; i < 5; i++) assert.equal((await p.req(`/api/orgs/${org.id}/tp/imoveis`, { metodo: "POST", quem: "ana", corpo: { nome: "Imóvel " + i } })).status, 200);
  const sexto = await p.req(`/api/orgs/${org.id}/tp/imoveis`, { metodo: "POST", quem: "ana", corpo: { nome: "Imóvel 6" } });
  assert.equal(sexto.status, 402); assert.equal(sexto.dados.codigo, "PLANO_LIMITE");
});

test("Temporada — conexão oficial só para quem pagou; quem para de pagar é desligado sozinho (sem custo à toa)", async () => {
  const p = await criarPlataforma({ CHANNEX_API_KEY: "cx_teste", CHANNEX_STAGING: "1" });
  p.channex = (caminho) => caminho === "/properties" ? { data: { id: "prop-x" } } : caminho === "/room_types" ? { data: { id: "room-x" } } : caminho === "/rate_plans" ? { data: { id: "rate-" + Math.random() } } : caminho === "/auth/one_time_token" ? { data: { token: "t" } } : { data: {} };
  await p.req("/api/cadastro", { metodo: "POST", quem: "ana", corpo: { nome: "Ana", empresa: "Ana Temporada", email: "ana@t.test", senha: "SenhaMuitoForte#2026", aceite: true, plano: "temporada" } });
  const org = (await p.req("/api/eu", { quem: "ana" })).dados.organizacoes[0];
  const id = (await p.req(`/api/orgs/${org.id}/tp/imoveis`, { metodo: "POST", quem: "ana", corpo: { nome: "Casa", preco_base: 300 } })).dados.id;
  const teste = await p.req(`/api/orgs/${org.id}/tp/imoveis/${id}/conectar`, { metodo: "POST", quem: "ana", corpo: {} });
  assert.equal(teste.status, 402); assert.equal(teste.dados.codigo, "PLANO_PAGO", "no teste grátis, só calendário");
  assert.equal((p.channexChamadas || []).length, 0, "nada criado no Channex");
  p.env.DB.db.prepare("UPDATE plt_organizacoes SET plano_status='ATIVO', pago_ate=? WHERE id=?").run(Date.now() + 30 * 86400000, org.id);
  assert.equal((await p.req(`/api/orgs/${org.id}/tp/imoveis/${id}/conectar`, { metodo: "POST", quem: "ana", corpo: {} })).status, 200);
  // Parou de pagar: no cron, a conexão é desligada no Channex e os dados ficam.
  p.env.DB.db.prepare("UPDATE plt_organizacoes SET plano_status='ATRASADO', pago_ate=? WHERE id=?").run(Date.now() - 10 * 86400000, org.id);
  const mod = await import("../src/worker.js?inadimplente");
  await mod.default.scheduled({}, p.env, null);
  assert.ok(p.channexChamadas.some(c => c.metodo === "DELETE" && c.caminho === "/properties/prop-x"));
  assert.equal(p.env.DB.q("SELECT channex_property FROM plt_tp_imoveis WHERE id=?", id)[0].channex_property, null);
  assert.equal(p.env.DB.q("SELECT nome FROM plt_tp_imoveis WHERE id=?", id)[0].nome, "Casa", "imóvel e dados continuam");
});

test("Temporada — cadastro rápido: só os links dos calendários, vários imóveis de uma vez", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  p.web = { "https://www.airbnb.com.br/calendar/ical/55501.ics?s=a": ICAL_AIRBNB, "https://www.airbnb.com.br/calendar/ical/55502.ics?s=b": ICAL_AIRBNB.replace("VERSION:2.0", "VERSION:2.0\r\nX-WR-CALNAME:Casa da Praia"), "https://admin.booking.com/hotel/hoteladmin/ical.html?t=xyz": ICAL_AIRBNB.replace(/Reserved/g, "CLOSED - Not available") };
  const r = await p.req("/api/orgs/1/tp/imoveis/rapido", { metodo: "POST", quem: "admin", corpo: { imoveis: [
    { nome: "", links: ["https://www.airbnb.com.br/calendar/ical/55501.ics?s=a", "https://admin.booking.com/hotel/hoteladmin/ical.html?t=xyz"] },
    { nome: "", links: ["https://www.airbnb.com.br/calendar/ical/55502.ics?s=b"] }] } });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  assert.equal(r.dados.imoveis.length, 2);
  assert.equal(r.dados.imoveis[0].nome, "Airbnb — anúncio 55501"); assert.equal(r.dados.imoveis[0].calendarios, 2);
  assert.equal(r.dados.imoveis[1].nome, "Casa da Praia", "usa o nome do calendário quando existe");
  const ims = (await p.req("/api/orgs/1/tp/imoveis", { quem: "admin" })).dados.imoveis;
  assert.equal(ims.length, 2);
  const anuncio = await p.req("/api/orgs/1/tp/imoveis/rapido", { metodo: "POST", quem: "admin", corpo: { imoveis: [{ links: ["https://www.airbnb.com.br/rooms/123456"] }] } });
  assert.equal(anuncio.dados.codigo, "LINK_ANUNCIO", "explica que precisa do link do calendário");
});

test("WhatsApp — conectar pelo Facebook com coexistência: número continua no app e respostas do celular pausam o robô", async () => {
  const p = await criarPlataforma({ META_APP_ID: "1234567890", META_APP_SECRET: "a".repeat(32), META_WA_CONFIG_ID: "998877" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const nova = await p.req("/api/admin/organizacoes", { metodo: "POST", quem: "admin", corpo: { nome: "Loja Coexistência" } });
  const org = nova.dados.id;
  const cfg = await p.req(`/api/orgs/${org}/zap/embedded`, { quem: "admin" });
  assert.equal(cfg.dados.disponivel, true); assert.equal(cfg.dados.config_id, "998877");
  p.meta = (url, metodo) => {
    if (url.includes("oauth/access_token")) return { access_token: "EAAT" + "y".repeat(60) };
    if (url.includes("/subscribed_apps") || url.includes("/smb_app_data")) return { success: true };
    if (url.includes("/555666777888?")) return { display_phone_number: "+55 21 99999-0000", verified_name: "Loja" };
    if (url.includes("111222333444/phone_numbers")) return { data: [{ id: "555666777888" }] };
    return {};
  };
  const alheio = await p.req(`/api/orgs/${org}/zap/embedded`, { metodo: "POST", quem: "admin", corpo: { code: "codigo-da-meta", phone_number_id: "999888777666", waba_id: "111222333444" } });
  assert.equal(alheio.status, 400, "número que não é da conta liberada não conecta");
  assert.equal(p.env.DB.q("SELECT COUNT(*) n FROM plt_zap_contas WHERE phone_number_id='999888777666'")[0].n, 0);
  const r = await p.req(`/api/orgs/${org}/zap/embedded`, { metodo: "POST", quem: "admin", corpo: { code: "codigo-da-meta", phone_number_id: "555666777888", waba_id: "111222333444", coexistencia: true } });
  assert.equal(r.status, 200, JSON.stringify(r.dados)); assert.equal(r.dados.numero, "+55 21 99999-0000");
  const chamadas = p.metaChamadas.map(c => c.url);
  assert.ok(chamadas.some(u => u.includes("111222333444/subscribed_apps")));
  assert.ok(chamadas.filter(u => u.includes("555666777888/smb_app_data")).length === 2, "sincroniza contatos e histórico do app");
  assert.ok(!chamadas.some(u => u.includes("/register")), "na coexistência o número não é registrado de novo");
  // A equipe respondeu pelo celular (eco): fica na conversa e o robô pausa.
  p.meta = null;
  await p.req(`/api/orgs/${org}/zap/modelo`, { metodo: "POST", quem: "admin", corpo: { tipo: "servicos" } });
  const CLI = "5521944440000";
  await webhookZap(p, "555666777888", { from: CLI, type: "text", text: { body: "oi" } });
  assert.equal(enviadosPara(p, CLI).length, 1);
  // Webhook falso (sem a assinatura da Meta) é ignorado: ninguém pausa o robô nem se passa por cliente.
  const falso = await p.req("/webhook/whatsapp", { metodo: "POST", corpo: { entry: [{ changes: [{ field: "smb_message_echoes", value: { metadata: { phone_number_id: "555666777888" }, message_echoes: [{ id: "wamid.falso", from: "5521999990000", to: CLI, type: "text", text: { body: "falso" } }] } }] }] } });
  assert.equal(falso.status, 200);
  assert.equal(p.env.DB.q("SELECT COUNT(*) n FROM plt_zap_msgs WHERE wamid='wamid.falso'")[0].n, 0, "webhook sem assinatura não entra");
  await webhookAssinado(p, { entry: [{ changes: [{ field: "smb_message_echoes", value: { metadata: { phone_number_id: "555666777888" }, message_echoes: [{ id: "wamid.eco1", from: "5521999990000", to: CLI, type: "text", text: { body: "Oi! Aqui é a Ana, pelo celular." } }] } }] }] });
  const conv = (await p.req(`/api/orgs/${org}/zap/conversas/${CLI}`, { quem: "admin" })).dados;
  assert.ok(conv.mensagens.some(m => m.origem === "EQUIPE" && /pelo celular/.test(m.texto)));
  assert.equal(conv.contato.pausado, true);
  await webhookZap(p, "555666777888", { from: CLI, type: "text", text: { body: "obrigado" } });
  assert.equal(enviadosPara(p, CLI).length, 1, "robô em pausa enquanto a equipe atende pelo celular");
});

// Conecta o Google de uma marca (login do Google simulado), com as permissões pedidas.
async function conectarGoogleTeste(p, escopos, extra = "") {
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Oficina" } })).dados.id;
  const ida = await p.req(`/api/orgs/1/mk/google/conectar?marca=${marca}${extra ? "&extra=" + extra : ""}`, { quem: "admin" });
  const dialogo = new URL(ida.r.headers.get("location"));
  const base = p.google;
  p.google = (url, metodo, corpo) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return corpo.grant_type === "authorization_code" ? { access_token: "ya29.a", refresh_token: "1//perm", expires_in: 3599, scope: escopos } : { access_token: "ya29.b", expires_in: 3599 };
    if (url.includes("/v1/accounts?")) return { accounts: [{ name: "accounts/111" }] };
    if (url.includes("/accounts/111/locations?")) return { locations: [{ name: "locations/222", title: "Oficina Niterói" }] };
    if (/reviews\?|fetchMultiDailyMetrics|searchkeywords/.test(url)) return {};
    return base ? base(url, metodo, corpo) : { error: { code: 404, message: "inesperado " + url } };
  };
  const volta = await p.req(`/api/google/retorno?code=abc&state=${encodeURIComponent(dialogo.searchParams.get("state"))}`);
  const nonce = (await volta.r.text()).match(/google-([A-Za-z0-9_-]+)/)[1];
  await p.req("/api/orgs/1/mk/google/escolher", { metodo: "POST", quem: "admin", corpo: { n: nonce, local_id: "locations/222" } });
  return { marca, dialogo };
}

test("Google — checagem do perfil (como o GBP Check) e todas as buscas que acharam o perfil", async () => {
  const p = await criarPlataforma({ GOOGLE_CLIENT_ID: "c.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "s" });
  p.env.__agora = () => Date.parse("2026-10-16T12:00:00Z");
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const { marca } = await conectarGoogleTeste(p, "https://www.googleapis.com/auth/business.manage");
  const base = p.google;
  let completo = false;
  const chamadas = [];
  p.google = (url, metodo, corpo) => {
    chamadas.push([metodo, url]);
    if (url.includes("/locations/222?readMask=")) return completo
      ? { title: "Oficina Niterói", phoneNumbers: { primaryPhone: "(21) 3333-4444" }, categories: { primaryCategory: { displayName: "Oficina" }, additionalCategories: [{}, {}, {}] }, profile: { description: "x".repeat(600) },
        storefrontAddress: { addressLines: ["Rua A, 10"], locality: "Niterói", administrativeArea: "RJ", postalCode: "24000-000" }, websiteUri: "https://oficina.test", regularHours: { periods: [{ openDay: "MONDAY" }] },
        specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 25 } }] }, openInfo: { status: "OPEN", openingDate: { year: 2015, month: 3 } }, metadata: { mapsUri: "https://maps.google.com/?cid=1" } }
      : { title: "Oficina Niterói", categories: { primaryCategory: { displayName: "Oficina" } }, storefrontAddress: { addressLines: ["Rua A, 10"], locality: "Niterói" } };
    if (url.includes("/media?")) return { mediaItems: completo ? [...Array(10).fill({ mediaFormat: "PHOTO" }), { mediaFormat: "PHOTO", locationAssociation: { category: "PROFILE" } }, { mediaFormat: "PHOTO", locationAssociation: { category: "COVER" } }, ...Array(3).fill({ mediaFormat: "VIDEO" })] : [{ mediaFormat: "PHOTO" }] };
    if (url.includes("/localPosts?")) return { localPosts: completo ? [{ createTime: "2026-10-14T10:00:00Z" }] : [] };
    if (url.includes("/reviews?pageSize=50")) return completo ? { totalReviewCount: 12, averageRating: 4.8, reviews: [{ reviewReply: { comment: "ok" } }, { reviewReply: { comment: "ok" } }] } : { totalReviewCount: 2, averageRating: 5, reviews: [{}, { reviewReply: {} }] };
    if (url.includes("/attributes")) return { attributes: completo ? [{ values: [true] }, { values: [true] }, { values: [true] }] : [] };
    if (url.includes("searchkeywords")) {
      const pg = url.includes("pageToken=p2") ? 2 : 1;
      return { searchKeywordsCounts: Array.from({ length: pg === 1 ? 100 : 30 }, (_, i) => ({ searchKeyword: pg === 2 && i === 29 ? "reforma tudo rt" : `busca ${pg}-${i}`, insightsValue: pg === 2 ? { threshold: "15" } : { value: String(500 - i) } })), ...(pg === 1 ? { nextPageToken: "p2" } : {}) };
    }
    return base(url, metodo, corpo);
  };
  const r = await p.req(`/api/orgs/1/mk/google/checagem?marca=${marca}`, { quem: "admin" });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  assert.ok(r.dados.nota < 50, "perfil incompleto tem nota baixa: " + r.dados.nota);
  const it = c => r.dados.itens.find(i => i.chave === c);
  assert.equal(it("endereco").ok, "parcial"); assert.match(it("endereco").dica, /CEP/);
  assert.equal(it("fotos").detalhe, "1 foto(s)"); assert.match(it("fotos").dica, /Faltam 2 foto/);
  assert.match(it("videos").dica, /Faltam 3 vídeo/);
  assert.match(it("avaliacoes").dica, /Faltam 3 avaliação/);
  assert.equal(it("respostas").detalhe, "1 de 2 recentes respondidas");
  assert.ok(chamadas.every(([m]) => m === "GET"), "a checagem só lê, não muda nada no Google");
  completo = true;
  const r2 = await p.req(`/api/orgs/1/mk/google/checagem?marca=${marca}`, { quem: "admin" });
  assert.equal(r2.dados.nota, 100, JSON.stringify(r2.dados.itens.filter(i => i.ok !== "ok")));
  assert.equal(r2.dados.faltam, 0);
  // Buscas: todas as páginas (inclusive as "menos de 15") e os meses escolhidos.
  const dsp = await p.req(`/api/orgs/1/mk/google/desempenho?marca=${marca}&dias=30&meses_buscas=6`, { quem: "admin" });
  assert.equal(dsp.dados.palavras.length, 130, "nenhuma busca fica de fora");
  assert.ok(dsp.dados.palavras.some(x => x.palavra === "reforma tudo rt" && x.menos_de === 15));
  assert.deepEqual([dsp.dados.palavras_de, dsp.dados.palavras_ate], ["2026-04", "2026-09"], "últimos 6 meses fechados");
});

test("Google — Search Console: escolher o site, números por busca e página, oportunidades, inspecionar e sitemap", async () => {
  const p = await criarPlataforma({ GOOGLE_CLIENT_ID: "c.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "s" });
  p.env.__agora = () => Date.parse("2026-10-16T12:00:00Z");
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  // Conexão antiga (só o perfil): pede para reconectar, sem quebrar.
  const antiga = await conectarGoogleTeste(p, "https://www.googleapis.com/auth/business.manage");
  assert.equal(antiga.dialogo.searchParams.get("scope"), "https://www.googleapis.com/auth/business.manage", "a conexão normal pede só o perfil");
  assert.equal(antiga.dialogo.searchParams.get("include_granted_scopes"), "true");
  assert.equal((await p.req(`/api/orgs/1/mk/google/sc/sites?marca=${antiga.marca}`, { quem: "admin" })).dados.precisa_reconectar, true);
  const consultas = [];
  p.google = (url, metodo, corpo) => {
    if (url.endsWith("/webmasters/v3/sites")) return { siteEntry: [{ siteUrl: "https://oficina.test/", permissionLevel: "siteOwner" }, { siteUrl: "https://outro.test/", permissionLevel: "siteUnverifiedUser" }] };
    if (url.includes("/searchAnalytics/query")) {
      consultas.push(corpo);
      const dim = corpo.dimensions[0];
      if (dim === "date") return { rows: [{ keys: [corpo.startDate], clicks: 10, impressions: 200, ctr: 0.05, position: 8 }, { keys: [corpo.endDate], clicks: 30, impressions: 800, ctr: 0.0375, position: 6 }] };
      if (dim === "query") return { rows: [{ keys: ["conserto de macbook"], clicks: 5, impressions: 900, ctr: 0.0055, position: 6.2 }, { keys: ["oficina niteroi"], clicks: 40, impressions: 100, ctr: 0.4, position: 1.1 }] };
      if (dim === "page") return { rows: [{ keys: ["https://oficina.test/servicos"], clicks: 20, impressions: 500, ctr: 0.04, position: 7 }] };
      return { rows: [] };
    }
    if (url.includes("/sitemaps") && metodo === "GET") return { sitemap: [{ path: "https://oficina.test/sitemap.xml", lastDownloaded: "2026-10-10T00:00:00Z", errors: "0", warnings: "1", contents: [{ submitted: "42" }] }] };
    if (url.includes("/sitemaps/") && metodo === "PUT") return {};
    if (url.includes("urlInspection/index:inspect")) return { inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Enviada e indexada", lastCrawlTime: "2026-10-12T10:00:00Z", googleCanonical: "https://oficina.test/servicos" }, inspectionResultLink: "https://search.google.com/x" } };
    return { error: { code: 404, message: "inesperado " + url } };
  };
  const { marca, dialogo } = await conectarGoogleTeste(p, "https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/webmasters", "sc");
  assert.match(dialogo.searchParams.get("scope"), /webmasters/);
  const sites = (await p.req(`/api/orgs/1/mk/google/sc/sites?marca=${marca}`, { quem: "admin" })).dados;
  assert.deepEqual(sites.sites.map(s => s.site), ["https://oficina.test/"], "site não verificado fica de fora");
  assert.equal((await p.req("/api/orgs/1/mk/google/sc/site", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, site: "https://oficina.test/" } })).status, 200);
  const sc = (await p.req(`/api/orgs/1/mk/google/sc?marca=${marca}&dias=28`, { quem: "admin" })).dados;
  assert.equal(sc.totais.cliques, 40); assert.equal(sc.totais.impressoes, 1000); assert.equal(sc.totais.posicao, 6.4);
  assert.equal(sc.ate, "2026-10-13", "Search Console com 3 dias de atraso"); assert.equal(sc.de, "2026-09-16");
  assert.ok(sc.comparacao, "compara com o período anterior");
  assert.equal(sc.oportunidades[0].palavra, "conserto de macbook", "aparece muito, poucos cliques: oportunidade");
  assert.ok(!sc.oportunidades.some(o => o.palavra === "oficina niteroi"), "já em 1º com bom CTR não é oportunidade");
  assert.equal(sc.sitemaps[0].urls, 42);
  const insp = (await p.req("/api/orgs/1/mk/google/sc/inspecionar", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, url: "https://oficina.test/servicos" } })).dados;
  assert.equal(insp.veredito, "PASS");
  assert.equal((await p.req("/api/orgs/1/mk/google/sc/sitemap", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, url: "https://oficina.test/sitemap.xml" } })).status, 200);
  assert.ok(p.googleChamadas.some(c => c.metodo === "PUT" && c.url.includes(encodeURIComponent("https://oficina.test/sitemap.xml"))));
});

test("Google Ads — contas (com MCC), gasto e campanhas, pausar, orçamento e palavra negativa; sem token da DENIA explica como ligar", async () => {
  const sem = await criarPlataforma({ GOOGLE_CLIENT_ID: "c.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "s" });
  await sem.entrar("admin", ADMIN, SENHA_ADMIN);
  const m0 = await conectarGoogleTeste(sem, "https://www.googleapis.com/auth/business.manage", "ads");
  assert.ok(!m0.dialogo.searchParams.get("scope").includes("adwords"), "sem token de desenvolvedor não pede o Google Ads");
  assert.equal((await sem.req(`/api/orgs/1/mk/google/ads/contas?marca=${m0.marca}`, { quem: "admin" })).dados.configurado, false);

  const p = await criarPlataforma({ GOOGLE_CLIENT_ID: "c.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "s", GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token" });
  p.env.__agora = () => Date.parse("2026-10-16T12:00:00Z");
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const mut = [];
  p.google = (url, metodo, corpo) => {
    if (url.endsWith("customers:listAccessibleCustomers")) return { resourceNames: ["customers/9990001111"] };
    if (url.includes(":mutate")) { mut.push({ url, corpo }); return { results: [{}] }; }
    if (url.includes("googleAds:search")) {
      const q = corpo.query;
      if (/FROM customer_client/.test(q)) return { results: [{ customerClient: { id: "1234567890", descriptiveName: "Oficina Ads", currencyCode: "BRL", manager: false } }] };
      if (/FROM customer LIMIT 1/.test(q) && url.includes("9990001111")) return { results: [{ customer: { id: "9990001111", descriptiveName: "Agência MCC", manager: true } }] };
      if (/optimization_score/.test(q)) return { results: [{ customer: { descriptiveName: "Oficina Ads", currencyCode: "BRL", optimizationScore: 0.785 } }] };
      if (/segments.date, metrics.cost_micros/.test(q)) return { results: [{ segments: { date: "2026-10-15" }, metrics: { costMicros: "50000000", clicks: "25", impressions: "1000", conversions: 2 } }, { segments: { date: "2026-10-14" }, metrics: { costMicros: "30000000", clicks: "15", impressions: "600", conversions: 1 } }] };
      if (/FROM campaign WHERE/.test(q)) return { results: [{ campaign: { id: "77", name: "Pesquisa", status: "ENABLED", advertisingChannelType: "SEARCH" }, campaignBudget: { resourceName: "customers/1234567890/campaignBudgets/55", amountMicros: "40000000" }, metrics: { costMicros: "80000000", clicks: "40", impressions: "1600", conversions: 3, searchImpressionShare: 0.35 } }] };
      if (/FROM search_term_view/.test(q)) return { results: [{ searchTermView: { searchTerm: "conserto gratis", status: "NONE" }, campaign: { id: "77", name: "Pesquisa" }, metrics: { costMicros: "20000000", clicks: "8", impressions: "100", conversions: 0 } }] };
      if (/DURING TODAY/.test(q)) return { results: [{ metrics: { costMicros: "12340000", clicks: "6" } }] };
      return { results: [] };
    }
    return { error: { code: 404, message: "inesperado " + url } };
  };
  const { marca, dialogo } = await conectarGoogleTeste(p, "https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/adwords", "sc-ads");
  assert.match(dialogo.searchParams.get("scope"), /adwords/);
  const contas = (await p.req(`/api/orgs/1/mk/google/ads/contas?marca=${marca}`, { quem: "admin" })).dados;
  assert.deepEqual(contas.contas.filter(c => !c.gerente).map(c => [c.id, c.via]), [["1234567890", "9990001111"]], "conta de anúncios debaixo da MCC");
  await p.req("/api/orgs/1/mk/google/ads/conta", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, cliente: "123-456-7890", gerente: "9990001111", nome: "Oficina Ads", moeda: "BRL" } });
  const d = (await p.req(`/api/orgs/1/mk/google/ads?marca=${marca}&dias=30`, { quem: "admin" })).dados;
  assert.equal(d.totais.custo, 80); assert.equal(d.totais.cliques, 40); assert.equal(d.totais.cpc, 2); assert.equal(d.hoje.custo, 12.34);
  assert.equal(d.pontuacao, 78.5); assert.equal(d.campanhas[0].orcamento_dia, 40); assert.equal(d.campanhas[0].parcela_impressoes, 35);
  assert.equal(d.ate, "2026-10-16", "Ads mostra até hoje");
  const ads = p.googleChamadas.filter(c => c.url.includes("googleads.googleapis.com/v25/customers/1234567890"));
  assert.ok(ads.length > 3, "usa a versão atual da API e a conta escolhida");
  await p.req("/api/orgs/1/mk/google/ads/campanha", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, campanha_id: "77", status: "PAUSED" } });
  await p.req("/api/orgs/1/mk/google/ads/orcamento", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, orcamento: "customers/1234567890/campaignBudgets/55", valor: 55.5 } });
  await p.req("/api/orgs/1/mk/google/ads/negativa", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, campanha_id: "77", termo: "conserto gratis" } });
  assert.deepEqual(mut[0].corpo.operations[0], { update: { resourceName: "customers/1234567890/campaigns/77", status: "PAUSED" }, updateMask: "status" });
  assert.equal(mut[1].corpo.operations[0].update.amountMicros, "55500000");
  assert.equal(mut[2].corpo.operations[0].create.negative, true);
  assert.equal((await p.req("/api/orgs/1/mk/google/ads/orcamento", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, orcamento: "customers/999/campaignBudgets/55", valor: 10 } })).status, 400, "orçamento de outra conta é recusado");
});

test("Google — concorrentes no Maps: posição do perfil, notas dos outros e histórico", async () => {
  const p = await criarPlataforma({ GOOGLE_CLIENT_ID: "c.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "s", GOOGLE_PLACES_API_KEY: "chave-places" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  p.google = (url, metodo, corpo) => url.includes("places:searchText") ? { places: [
    { id: "a", displayName: { text: "Auto Center Icaraí" }, rating: 4.8, userRatingCount: 900 },
    { id: "b", displayName: { text: "Oficina Niterói" }, rating: 4.9, userRatingCount: 120 },
    { id: "c", displayName: { text: "Mecânica Boa" }, rating: 4.2, userRatingCount: 300 }] } : { error: { code: 404, message: "x" } };
  const { marca } = await conectarGoogleTeste(p, "https://www.googleapis.com/auth/business.manage");
  const r = (await p.req("/api/orgs/1/mk/google/concorrentes", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, busca: "oficina em niterói" } })).dados;
  assert.equal(r.posicao, 2); assert.equal(r.media_nota, 4.5); assert.equal(r.media_avaliacoes, 600);
  assert.ok(r.lugares.find(l => l.voce).nome === "Oficina Niterói");
  const ch = p.googleChamadas.find(c => c.url.includes("places:searchText"));
  assert.equal(ch.corpo.textQuery, "oficina em niterói");
  const hist = (await p.req(`/api/orgs/1/mk/google/concorrentes?marca=${marca}`, { quem: "admin" })).dados;
  assert.equal(hist.historico[0].posicao, 2); assert.equal(hist.ultimo.lugares.length, 3);
});

test("WhatsApp — perfil comercial, saúde, modelos, clientes com etiqueta, campanha em fila e quem pede SAIR não recebe", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const org = (await p.req("/api/admin/organizacoes", { metodo: "POST", quem: "admin", corpo: { nome: "Loja Campanhas" } })).dados.id;
  const PN = "777000111222";
  const enviados = [];
  p.meta = (url, metodo, corpo) => {
    if (url.includes(`/${PN}?fields=display_phone_number,verified_name,quality_rating`) && !url.includes("messaging_limit")) return { display_phone_number: "+55 21 98888-0000", verified_name: "Loja" };
    if (url.includes(`/${PN}?fields=`)) return { display_phone_number: "+55 21 98888-0000", verified_name: "Loja", quality_rating: "GREEN", messaging_limit_tier: "TIER_1K", status: "CONNECTED" };
    if (url.includes("/whatsapp_business_profile")) return metodo === "GET" ? { data: [{ about: "Oi", websites: ["https://loja.test"] }] } : { success: true };
    if (url.includes("/message_templates") && metodo === "GET") return { data: [{ name: "promo", status: "APPROVED", category: "MARKETING", language: "pt_BR", components: [{ type: "BODY", text: "Olá {{1}}, 20% off!" }] }] };
    if (url.includes("/message_templates") && metodo === "POST") return { id: "t1", status: "PENDING" };
    if (url.includes("/WABA1?")) return { business_verification_status: "verified" };
    if (url.endsWith(`/${PN}/messages`)) { enviados.push(JSON.parse(p.ultimoCorpo || "{}")); return { messages: [{ id: "wamid.c" + enviados.length }] }; }
    return {};
  };
  // O mock da Meta lê o corpo como formulário; os envios do WhatsApp são JSON: guarda o original.
  const f0 = globalThis.fetch;
  globalThis.fetch = (url, op = {}) => { if (String(url).startsWith("https://graph.facebook.com/")) p.ultimoCorpo = op.body; return f0(url, op); };
  try {
    const con = await p.req(`/api/orgs/${org}/zap/conta`, { metodo: "POST", quem: "admin", corpo: { phone_number_id: PN, waba_id: "WABA1".replace(/\D/g, "") || "", token: "EAAT" + "z".repeat(60) } });
    assert.equal(con.status, 200, JSON.stringify(con.dados));
    p.env.DB.prepare("UPDATE plt_zap_contas SET waba_id='WABA1' WHERE org_id=?").bind(org).run();
    assert.equal((await p.req(`/api/orgs/${org}/zap/perfil`, { quem: "admin" })).dados.perfil.about, "Oi");
    assert.equal((await p.req(`/api/orgs/${org}/zap/perfil`, { metodo: "POST", quem: "admin", corpo: { about: "Conserto em 1 hora", websites: ["https://loja.test", "javascript:alert(1)"] } })).status, 200);
    const s = (await p.req(`/api/orgs/${org}/zap/saude`, { quem: "admin" })).dados;
    assert.equal(s.qualidade_nome, "Alta"); assert.equal(s.limite, 1000);
    const mods = (await p.req(`/api/orgs/${org}/zap/modelos`, { quem: "admin" })).dados.modelos;
    assert.equal(mods[0].variaveis, 1);
    const novo = await p.req(`/api/orgs/${org}/zap/modelos`, { metodo: "POST", quem: "admin", corpo: { nome: "Promoção de Outubro!", categoria: "MARKETING", corpo: "Olá {{1}}! Temos novidade.", exemplos: ["Maria"] } });
    assert.equal(novo.dados.nome, "promocao_de_outubro");
    assert.equal((await p.req(`/api/orgs/${org}/zap/modelos`, { metodo: "POST", quem: "admin", corpo: { nome: "x", corpo: "Oi {{1}}" } })).status, 400, "sem exemplo da variável a Meta recusa");
    // Clientes: importados com consentimento, com etiqueta.
    assert.equal((await p.req(`/api/orgs/${org}/zap/clientes/importar`, { metodo: "POST", quem: "admin", corpo: { linhas: [{ telefone: "21911110000" }] } })).status, 400, "precisa confirmar o consentimento");
    const imp = await p.req(`/api/orgs/${org}/zap/clientes/importar`, { metodo: "POST", quem: "admin", corpo: { consentimento: true, linhas: [{ telefone: "21911110000", nome: "Maria Souza", etiquetas: "fiel" }, { telefone: "21922220000", nome: "João", etiquetas: "fiel" }, { telefone: "21933330000", nome: "Ana" }, { telefone: "123" }] } });
    assert.equal(imp.dados.importados, 3);
    const cl = (await p.req(`/api/orgs/${org}/zap/clientes?etiqueta=fiel`, { quem: "admin" })).dados;
    assert.equal(cl.clientes.length, 2); assert.deepEqual(cl.etiquetas, [{ nome: "fiel", n: 2 }]);
    // João pede para sair.
    await p.req("/api/orgs/" + org + "/zap/modelo", { metodo: "POST", quem: "admin", corpo: { tipo: "servicos" } });
    await webhookZap(p, PN, { from: "5521922220000", type: "text", text: { body: "SAIR" } });
    assert.equal(p.env.DB.q("SELECT optout FROM plt_zap_contatos WHERE org_id=? AND telefone='5521922220000'", org)[0].optout, 1);
    // Campanha para a etiqueta "fiel": só a Maria recebe.
    const sim = await p.req(`/api/orgs/${org}/zap/campanhas`, { metodo: "POST", quem: "admin", corpo: { nome: "Promo", modelo: "promo", idioma: "pt_BR", publico: "etiqueta", etiqueta: "fiel", variaveis: ["{nome}"], simular: true } });
    assert.equal(sim.dados.total, 1);
    const c = await p.req(`/api/orgs/${org}/zap/campanhas`, { metodo: "POST", quem: "admin", corpo: { nome: "Promo", modelo: "promo", idioma: "pt_BR", publico: "etiqueta", etiqueta: "fiel", variaveis: ["{nome}"] } });
    assert.equal(c.dados.total, 1);
    enviados.length = 0;
    const mod = await import("../src/worker.js");
    { let tarefa; await mod.default.scheduled({}, p.env, { waitUntil: pr => { tarefa = pr; } }); await tarefa; }
    const tpl = enviados.filter(e => e.type === "template");
    assert.equal(tpl.length, 1); assert.equal(tpl[0].to, "5521911110000");
    assert.deepEqual(tpl[0].template.components[0].parameters, [{ type: "text", text: "Maria" }], "{nome} vira o primeiro nome");
    const camp = (await p.req(`/api/orgs/${org}/zap/campanhas`, { quem: "admin" })).dados.campanhas[0];
    assert.equal(camp.enviados, 1);
    { let tarefa; await mod.default.scheduled({}, p.env, { waitUntil: pr => { tarefa = pr; } }); await tarefa; }
    assert.equal((await p.req(`/api/orgs/${org}/zap/campanhas`, { quem: "admin" })).dados.campanhas[0].status, "CONCLUIDA");
    // Respostas rápidas.
    await p.req(`/api/orgs/${org}/zap/respostas`, { metodo: "POST", quem: "admin", corpo: { respostas: [{ atalho: "/horario", texto: "9h às 18h" }, { atalho: "", texto: "x" }] } });
    assert.deepEqual((await p.req(`/api/orgs/${org}/zap/respostas`, { quem: "admin" })).dados.respostas, [{ atalho: "horario", texto: "9h às 18h" }]);
  } finally { globalThis.fetch = f0; }
});

test("Temporada — importar todos os anúncios da conta (Channex): só os do grupo da empresa, com reservas futuras", async () => {
  const p = await criarPlataforma({ CHANNEX_API_KEY: "cx_teste", CHANNEX_STAGING: "1" });
  p.env.__agora = () => Date.parse("2026-10-16T12:00:00Z");
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  p.channex = (caminho, metodo) => {
    if (caminho === "/groups") return { data: { id: "grp-1" } };
    if (caminho === "/auth/one_time_token") return { data: { token: "tokG" } };
    if (caminho.startsWith("/properties?filter[group_id]=grp-1")) return { data: [{ id: "p-a", attributes: { title: "Loft Ipanema", city: "Rio de Janeiro", currency: "BRL" } }, { id: "p-b", attributes: { title: "Casa Búzios", currency: "BRL" } }] };
    if (caminho.startsWith("/room_types?")) return { data: [{ id: "r-1", attributes: { occ_adults: 4 } }] };
    if (caminho.startsWith("/bookings?filter[property_id]=p-a")) return { data: [{ id: "bk-1", attributes: { ota_name: "Airbnb", status: "new", arrival_date: "2026-11-01", departure_date: "2026-11-05", amount: "2000.00", currency: "BRL", customer: { name: "John" } } }] };
    if (caminho.startsWith("/bookings?")) return { data: [] };
    return { data: {} };
  };
  const vazio = await p.req("/api/orgs/1/tp/channex/importar", { metodo: "POST", quem: "admin", corpo: {} });
  assert.equal(vazio.dados.sem_grupo, true, "antes de entrar nas plataformas não há o que importar");
  const conta = await p.req("/api/orgs/1/tp/channex/conta", { metodo: "POST", quem: "admin", corpo: {} });
  assert.match(conta.dados.url, /oauth_session_key=tokG.*group_id=grp-1/);
  const r = (await p.req("/api/orgs/1/tp/channex/importar", { metodo: "POST", quem: "admin", corpo: {} })).dados;
  assert.equal(r.total, 2); assert.equal(r.imoveis_novos, 2); assert.equal(r.reservas, 1);
  const ims = (await p.req("/api/orgs/1/tp/imoveis", { quem: "admin" })).dados.imoveis;
  assert.deepEqual(ims.map(i => i.nome).sort(), ["Casa Búzios", "Loft Ipanema"]);
  assert.ok(ims.every(i => i.conectado_channex && i.ical_url));
  assert.equal(p.env.DB.q("SELECT hospede, canal FROM plt_tp_reservas")[0].canal, "airbnb");
  const de2 = (await p.req("/api/orgs/1/tp/channex/importar", { metodo: "POST", quem: "admin", corpo: {} })).dados;
  assert.equal(de2.imoveis_novos, 0, "importar de novo não duplica");
  assert.equal(p.env.DB.q("SELECT COUNT(*) n FROM plt_tp_reservas")[0].n, 1);
  assert.ok(p.channexChamadas.filter(c => c.caminho === "/webhooks").length === 2, "cada anúncio importado já avisa reservas e mensagens");
});


test("Temporada — cotação com descontos, valores da reserva e planilha da plataforma (Booking 'indisponível' vira reserva)", async () => {
  const p = await criarPlataforma();
  p.env.__agora = () => Date.parse("2026-10-16T12:00:00Z");
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const id = (await p.req("/api/orgs/1/tp/imoveis", { metodo: "POST", quem: "admin", corpo: { nome: "Loft Ipanema", capacidade: 4, preco_base: 500, preco_fds: 700, taxa_limpeza: 180, desconto_semanal: 10, desconto_mensal: 30, hospedes_incluidos: 2, taxa_hospede_extra: 50, comodidades: ["Wi-Fi", "Ar-condicionado", "Wi-Fi"] } })).dados.id;
  const im = (await p.req(`/api/orgs/1/tp/imoveis/${id}`, { quem: "admin" })).dados.imovel;
  assert.deepEqual(im.comodidades, ["Wi-Fi", "Ar-condicionado"]);
  // 7 noites (seg 19/10 a seg 26/10): 5×500 + sex e sáb 2×700 = 3900; −10% = 3510; 2 hóspedes extras × 50 × 7 = 700; limpeza 180.
  const c = (await p.req(`/api/orgs/1/tp/cotacao?imovel=${id}&inicio=2026-10-19&fim=2026-10-26&hospedes=4`, { quem: "admin" })).dados;
  assert.equal(c.diarias, 3900); assert.equal(c.desconto_pct, 10); assert.equal(c.desconto, 390); assert.equal(c.hospede_extra, 700); assert.equal(c.limpeza, 180); assert.equal(c.total, 4390);
  assert.equal((await p.req(`/api/orgs/1/tp/cotacao?imovel=${id}&inicio=2026-11-01&fim=2026-12-01`, { quem: "admin" })).dados.desconto_pct, 30, "28+ noites: desconto mensal");
  // Reserva manual já entra com a limpeza do imóvel; valores editáveis.
  const r = (await p.req("/api/orgs/1/tp/reservas", { metodo: "POST", quem: "admin", corpo: { imovel_id: id, inicio: "2026-11-10", fim: "2026-11-13", hospede: "Ana", valor: 1800 } })).dados.id;
  assert.equal(p.env.DB.q("SELECT taxa_limpeza FROM plt_tp_reservas WHERE id=?", r)[0].taxa_limpeza, 180);
  await p.req(`/api/orgs/1/tp/reservas/${r}/valores`, { metodo: "POST", quem: "admin", corpo: { valor: 1900, taxas: 57 } });
  assert.deepEqual(p.env.DB.q("SELECT valor, taxas, taxa_limpeza FROM plt_tp_reservas WHERE id=?", r)[0], { valor: 1900, taxas: 57, taxa_limpeza: 180 });
  // O calendário do Booking trouxe "indisponível": a planilha completa como reserva, com valor e hóspede.
  p.env.DB.prepare("INSERT INTO plt_tp_reservas(org_id,imovel_id,canal,externo_id,tipo,status,hospede,inicio,fim,origem,criado_ms,atualizado_ms) VALUES(1,?,'booking','ical1','BLOQUEIO','CONFIRMADA','Bloqueio','2026-12-01','2026-12-05','ICAL',1,1)").bind(id).run();
  const imp = (await p.req("/api/orgs/1/tp/reservas/importar", { metodo: "POST", quem: "admin", corpo: { canal: "booking", linhas: [
    { inicio: "2026-12-01", fim: "2026-12-05", hospede: "Hans Müller", valor: 2600, limpeza: 180, taxas: 390, anuncio: "Loft Ipanema", codigo: "BK123" },
    { inicio: "2027-01-02", fim: "2027-01-06", hospede: "Joana", valor: 3000, anuncio: "loft ipanema" },
    { inicio: "2027-01-02", fim: "2027-01-06", anuncio: "Outro imóvel" }, { inicio: "x", fim: "y" }] } })).dados;
  assert.deepEqual([imp.atualizadas, imp.criadas, imp.sem_imovel, imp.invalidas], [1, 1, 1, 1]);
  const bk = p.env.DB.q("SELECT tipo, hospede, valor, taxas, codigo FROM plt_tp_reservas WHERE externo_id='ical1'")[0];
  assert.deepEqual(bk, { tipo: "RESERVA", hospede: "Hans Müller", valor: 2600, taxas: 390, codigo: "BK123" });
});

test("Temporada — estoque: lista pronta, check-out pede conferência, link sem login para quem limpa e problemas viram melhoria", async () => {
  const p = await criarPlataforma({ RESEND_API_KEY: "re_teste", EMAIL_REMETENTE: "DENIA <oi@denia.test>" });
  p.env.__agora = () => Date.parse("2026-10-16T20:00:00Z");
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  p.env.DB.prepare("INSERT OR REPLACE INTO plt_meta(chave,valor) VALUES('base_url','https://plataforma.test')").run();
  const id = (await p.req("/api/orgs/1/tp/imoveis", { metodo: "POST", quem: "admin", corpo: { nome: "Casa Búzios" } })).dados.id;
  assert.equal((await p.req("/api/orgs/1/tp/estoque", { metodo: "POST", quem: "admin", corpo: { imovel_id: id, padrao: true } })).dados.itens, 18);
  await p.req("/api/orgs/1/tp/reservas", { metodo: "POST", quem: "admin", corpo: { imovel_id: id, inicio: "2026-10-12", fim: "2026-10-16", hospede: "Ana" } });
  const est = (await p.req(`/api/orgs/1/tp/estoque?imovel=${id}`, { quem: "admin" })).dados;
  assert.equal(est.pendentes.length, 1, "check-out de hoje sem conferência");
  const papel = est.itens.find(x => x.item === "Papel higiênico");
  // Cron: e-mail com o link para quem limpa.
  const mod = await import("../src/worker.js");
  { let t; await mod.default.scheduled({}, p.env, { waitUntil: x => { t = x; } }); await t; }
  const email = p.emails.find(e => /confira o estoque/.test(e.subject));
  assert.match(email.text, /Levar: Papel|Mande este link/);
  assert.ok(email, "avisou o responsável");
  const link = String(email.text || email.html).match(/https:\/\/plataforma\.test(\/tp\/limpeza\/\d+-[A-Za-z0-9]{32})/)[1];
  assert.equal((await p.req(link.replace(/.$/, "x"))).status, 404, "link adulterado não abre");
  const pag = await p.req(link);
  assert.equal(pag.status, 200); assert.match(await pag.r.text(), /limpeza\.js/);
  // Quem limpa responde pelo celular (tela simples, sem login).
  const dados = (await p.req(link + "/dados")).dados;
  assert.equal(dados.imovel, "Casa Búzios"); assert.ok(dados.estoque.length === 18);
  assert.ok(dados.briefing.levar.length === 0);
  const r1 = await mod.default.fetch(new Request("https://plataforma.test" + link + "/enviar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quem: "Dona Maria", estoque: { [papel.id]: 4 }, obs: "Chuveiro do banheiro pingando" }) }), p.env);
  const env2 = await r1.json();
  assert.deepEqual(env2.baixos.map(b => b.item), ["Papel higiênico"]);
  assert.ok(p.emails.some(e => /concluída/.test(e.subject) && /Comprar: Papel higiênico/.test(e.text)), "anfitrião avisado do que comprar");
  const depois = (await p.req(`/api/orgs/1/tp/estoque?imovel=${id}`, { quem: "admin" })).dados;
  assert.equal(depois.itens.find(x => x.item === "Papel higiênico").quantidade, 4);
  assert.equal(depois.pendentes.length, 0, "conferência feita");
  assert.equal(depois.movimentos[0].origem, "CHECKOUT"); assert.equal(depois.movimentos[0].autor, "Dona Maria");
  const notas = (await p.req("/api/orgs/1/tp/notas", { quem: "admin" })).dados.notas;
  assert.match(notas[0].texto, /Chuveiro do banheiro pingando/);
  assert.equal(p.env.DB.q("SELECT status, responsavel FROM plt_tp_limpezas")[0].status, "FEITA");
  // Melhorias: concluir.
  await p.req(`/api/orgs/1/tp/notas/${notas[0].id}`, { metodo: "POST", quem: "admin", corpo: { status: "FEITA", custo: 120 } });
  assert.equal(p.env.DB.q("SELECT status, custo FROM plt_tp_notas")[0].custo, 120);
});

test("Temporada — preços ficam na plataforma, janela de reservas e fotos", async () => {
  const p = await criarPlataforma({ CHANNEX_API_KEY: "cx_teste", CHANNEX_STAGING: "1" });
  p.env.__agora = () => Date.parse("2026-10-16T12:00:00Z");
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  let n = 0;
  p.channex = caminho => caminho === "/properties" ? { data: { id: "prop-1" } } : caminho === "/room_types" ? { data: { id: "room-1" } } : caminho === "/rate_plans" ? { data: { id: "rate-" + (++n) } } : caminho === "/auth/one_time_token" ? { data: { token: "t" } } : caminho === "/groups" ? { data: { id: "g1" } } : { data: {} };
  const id = (await p.req("/api/orgs/1/tp/imoveis", { metodo: "POST", quem: "admin", corpo: { nome: "Apto", preco_base: 400, precos_modo: "PLATAFORMA", janela_meses: 3 } })).dados.id;
  await p.req(`/api/orgs/1/tp/imoveis/${id}/conectar`, { metodo: "POST", quem: "admin", corpo: {} });
  const vals = p.channexChamadas.filter(c => c.caminho === "/restrictions").flatMap(c => c.corpo.values);
  assert.ok(vals.length > 300);
  assert.ok(vals.every(v => v.rate === undefined), "com os preços na plataforma, a DENIA não grava preço noite a noite");
  assert.ok(vals.filter(v => v.date_from > "2027-01-16").every(v => v.stop_sell === true), "depois da janela de 3 meses: fechado");
  assert.ok(vals.filter(v => v.date_from <= "2027-01-16").every(v => v.stop_sell === false));
  const cal = (await p.req("/api/orgs/1/tp/calendario?de=2027-01-10&ate=2027-01-20", { quem: "admin" })).dados.imoveis[0];
  assert.equal(cal.precos.find(x => x.data === "2027-01-20").fora_janela, true);
  const ical = await (await p.req(`/tp/ical/${p.env.DB.q("SELECT ical_token FROM plt_tp_imoveis")[0].ical_token}.ics`)).r.text();
  assert.match(ical, /Fora da janela de reservas/);
  // Fotos: guarda reduzida e devolve a imagem só para a empresa.
  const png = "data:image/png;base64," + btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0));
  const f = (await p.req(`/api/orgs/1/tp/imoveis/${id}/fotos`, { metodo: "POST", quem: "admin", corpo: { dados: png, legenda: "Sala" } })).dados.id;
  const img = await p.req(`/api/orgs/1/tp/fotos/${f}`, { quem: "admin" });
  assert.equal(img.r.headers.get("content-type"), "image/png");
  assert.equal((await p.req(`/api/orgs/1/tp/imoveis/${id}/fotos`, { metodo: "POST", quem: "admin", corpo: { dados: "data:text/html;base64,PHNjcmlwdD4=" } })).status, 400);
  // Desconectar apaga o imóvel do Channex.
  await p.req(`/api/orgs/1/tp/imoveis/${id}/desconectar`, { metodo: "POST", quem: "admin", corpo: {} });
  assert.ok(p.channexChamadas.some(c => c.metodo === "DELETE" && c.caminho === "/properties/prop-1"));
});

test("DENIA por voz — temporada: muda preço de um período, atualiza estoque, anota melhoria e cota estadia", async () => {
  const p = await criarPlataforma();
  p.env.__agora = () => Date.parse("2026-10-16T12:00:00Z");
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/ia/chave", { metodo: "POST", quem: "admin", corpo: { chave: "sk-proj-" + "f".repeat(40) } });
  const id = (await p.req("/api/orgs/1/tp/imoveis", { metodo: "POST", quem: "admin", corpo: { nome: "Loft Ipanema", preco_base: 500 } })).dados.id;
  await p.req("/api/orgs/1/tp/estoque", { metodo: "POST", quem: "admin", corpo: { imovel_id: id, item: "Papel higiênico", quantidade: 10, minimo: 6, unidade: "rolos" } });
  const ex = acao => p.req("/api/orgs/1/assistente/executar", { metodo: "POST", quem: "admin", corpo: { acao } });
  const a = (await ex({ tipo: "tp_precos", imovel: "loft ipanema", de: "2026-12-30", ate: "2027-01-01", preco: 1500, minimo: 3 })).dados;
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(p.env.DB.q("SELECT COUNT(*) n FROM plt_tp_precos WHERE preco=1500 AND minimo=3")[0].n, 3);
  const b = (await ex({ tipo: "tp_estoque", imovel: "Loft", item: "papel", somar: -5 })).dados;
  assert.equal(b.ok, true); assert.match(b.resumo, /agora 5/); assert.match(b.resumo, /Acabando: Papel higiênico/);
  const c = (await ex({ tipo: "tp_nota", imovel: "Loft Ipanema", texto: "Trocar a lâmpada da sala", prioridade: "ALTA" })).dados;
  assert.equal(c.ok, true); assert.equal(p.env.DB.q("SELECT prioridade FROM plt_tp_notas")[0].prioridade, "ALTA");
  const d = (await ex({ tipo: "tp_config", imovel: "Loft Ipanema", taxa_limpeza: 150, desconto_semanal: 12 })).dados;
  assert.equal(d.ok, true); assert.deepEqual(p.env.DB.q("SELECT taxa_limpeza, desconto_semanal FROM plt_tp_imoveis")[0], { taxa_limpeza: 150, desconto_semanal: 12 });
  const e = (await ex({ tipo: "tp_cotacao", imovel: "Loft Ipanema", inicio: "2026-12-30", fim: "2027-01-02" })).dados;
  assert.match(e.resumo, /Total BRL 4650/, e.resumo);
  const f = (await ex({ tipo: "tp_precos", imovel: "Casa que não existe", de: "2026-12-01", ate: "2026-12-02", preco: 1 })).dados;
  assert.equal(f.ok, false); assert.match(f.resumo, /Não achei o imóvel/);
});

test("Temporada — inventário por cômodo e checklist: quem limpa toca no nome, confere cada cômodo, e o que sumiu aparece na próxima limpeza", async () => {
  const p = await criarPlataforma();
  p.env.__agora = () => Date.parse("2026-10-16T15:00:00Z");
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const id = (await p.req("/api/orgs/1/tp/imoveis", { metodo: "POST", quem: "admin", corpo: { nome: "Casa Búzios" } })).dados.id;
  const cr = (await p.req(`/api/orgs/1/tp/imoveis/${id}/organizacao/modelo`, { metodo: "POST", quem: "admin", corpo: { quantidades: { sala: 1, quarto: 2, banheiro: 1, cozinha: 1 } } })).dados;
  assert.equal(cr.comodos, 5);
  const org = (await p.req(`/api/orgs/1/tp/imoveis/${id}/organizacao`, { quem: "admin" })).dados;
  assert.deepEqual(org.comodos.map(c => c.nome), ["Sala", "Cozinha", "Quarto 1", "Quarto 2", "Banheiro"]);
  const q1 = org.comodos[2], ban = org.comodos[4];
  assert.ok(q1.tarefas.some(t => /debaixo da cama/.test(t.tarefa)) && ban.tarefas.some(t => /descarga/i.test(t.tarefa)) && org.comodos[1].tarefas.some(t => /dentro dos armários/.test(t.tarefa)));
  await p.req("/api/orgs/1/tp/equipe", { metodo: "POST", quem: "admin", corpo: { equipe: [{ nome: "Dona Maria" }, { nome: "Joana" }] } });
  await p.req("/api/orgs/1/tp/reservas", { metodo: "POST", quem: "admin", corpo: { imovel_id: id, inicio: "2026-10-12", fim: "2026-10-16", hospede: "Ana" } });
  await p.req("/api/orgs/1/tp/reservas", { metodo: "POST", quem: "admin", corpo: { imovel_id: id, inicio: "2026-10-18", fim: "2026-10-20", hospede: "Bruno" } });
  // A limpeza é remarcada para outro dia (não no dia da saída).
  const lim = p.env.DB.q("SELECT id FROM plt_tp_limpezas ORDER BY data")[0].id;
  await p.req(`/api/orgs/1/tp/limpezas/${lim}/agendar`, { metodo: "POST", quem: "admin", corpo: { data: "2026-10-17", responsavel: "Joana" } });
  assert.deepEqual(p.env.DB.q("SELECT data, data_saida FROM plt_tp_limpezas WHERE id=?", lim)[0], { data: "2026-10-17", data_saida: "2026-10-16" });
  const det = (await p.req(`/api/orgs/1/tp/limpezas/${lim}/detalhe`, { quem: "admin" })).dados;
  const link = new URL(det.link).pathname;
  const dados = (await p.req(link + "/dados")).dados;
  assert.deepEqual(dados.equipe, ["Dona Maria", "Joana"]);
  assert.equal(dados.briefing.proximo.inicio, "2026-10-18");
  const mod = await import("../src/worker.js");
  const post = (cam, corpo) => mod.default.fetch(new Request("https://plataforma.test" + link + cam, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) }), p.env).then(r => r.json());
  await post("/comecar", { quem: "Joana" });
  const travesseiro = dados.comodos[2].itens.find(i => i.item === "Travesseiros"), toalha = dados.comodos[4].itens.find(i => i.item === "Toalhas de banho");
  const todas = Object.fromEntries([...dados.comodos.flatMap(c => c.tarefas)].slice(0, 10).map(t => [t.id, true]));
  const r = await post("/enviar", { quem: "Joana", checklist: todas, inventario: { [travesseiro.id]: "SUMIU", [toalha.id]: "QUEBRADO" }, faltou: ["Toalha de rosto"], fotos: ["data:image/png;base64," + btoa("PNGTESTE")] });
  assert.deepEqual(r.problemas, ["Travesseiros (Quarto 1): sumiu", "Toalhas de banho (Banheiro): quebrado"]);
  const reg = (await p.req(`/api/orgs/1/tp/limpezas/${lim}/detalhe`, { quem: "admin" })).dados;
  assert.equal(reg.limpeza.responsavel, "Joana"); assert.ok(reg.limpeza.inicio_ms && reg.limpeza.fim_ms);
  assert.equal(reg.limpeza.resumo.checklist_feitas, 10); assert.ok(reg.limpeza.resumo.checklist_total > 10);
  assert.equal(reg.midias.length, 1);
  assert.equal(p.env.DB.q("SELECT prioridade FROM plt_tp_notas")[0].prioridade, "ALTA", "sumiço vira melhoria urgente");
  // A próxima limpeza já sabe o que sumiu e o que faltou da última vez.
  const prox = p.env.DB.q("SELECT id FROM plt_tp_limpezas WHERE id<>? ORDER BY data", lim)[0].id;
  const b = (await p.req(`/api/orgs/1/tp/limpezas/${prox}/detalhe`, { quem: "admin" })).dados.briefing;
  assert.deepEqual(b.quebrados.map(x => x.item).sort(), ["Toalhas de banho", "Travesseiros"]);
  assert.deepEqual(b.faltou_ultima, ["Toalha de rosto"]);
  assert.equal(b.ultima.responsavel, "Joana");
});

test("Temporada — avaliações dos hóspedes: 5 estrelas responde sozinha; abaixo disso estuda e diz se dá para pedir a remoção", async () => {
  const p = await criarPlataforma({ CHANNEX_API_KEY: "cx_teste", CHANNEX_STAGING: "1" });
  p.env.__agora = () => Date.parse("2026-10-16T12:00:00Z");
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/ia/chave", { metodo: "POST", quem: "admin", corpo: { chave: "sk-proj-" + "f".repeat(40) } });
  p.channex = (caminho, metodo) => caminho === "/properties" ? { data: { id: "prop-1" } } : caminho === "/room_types" ? { data: { id: "room-1" } } : caminho === "/rate_plans" ? { data: { id: "r1" } } : caminho === "/groups" ? { data: { id: "g" } } : caminho === "/auth/one_time_token" ? { data: { token: "t" } }
    : caminho.startsWith("/reviews?") ? { data: [{ id: "rv1", attributes: { ota: "AirBNB", guest_name: "Laura", overall_score: 5, content: "Perfect stay, super clean!" } }, { id: "rv2", attributes: { ota: "BookingCom", guest_name: "Marco", overall_score: 4, content: "Host refused my extra guests party. Bad." } }] } : { data: {} };
  const id = (await p.req("/api/orgs/1/tp/imoveis", { metodo: "POST", quem: "admin", corpo: { nome: "Loft", treinamento: { regras: "Proibido festas. Máximo 4 pessoas." } } })).dados.id;
  await p.req(`/api/orgs/1/tp/imoveis/${id}/conectar`, { metodo: "POST", quem: "admin", corpo: {} });
  p.openai = (url, corpo) => {
    const texto = JSON.stringify(corpo);
    if (/Perfect stay/.test(texto)) return { output_text: JSON.stringify({ sentimento: "OTIMA", resumo: "Adorou", resposta: "Thank you, Laura!", resposta_traducao: "Obrigado, Laura!", remocao: { chance: "NENHUMA" } }) };
    return { output_text: JSON.stringify({ sentimento: "NEGATIVA", resumo: "Reclamou que não pôde fazer festa", resposta: "Thank you, Marco. Our house rules...", remocao: { chance: "ALTA", argumentos: ["O hóspede quis fazer festa, proibida nas regras"], regra: "Retaliação após violar regras", texto_pedido: "Olá, suporte...", passos: ["Extranet → Avaliações → Reportar"] } }) };
  };
  const mod = await import("../src/worker.js");
  { let t; await mod.default.scheduled({}, p.env, { waitUntil: x => { t = x; } }); await t; }
  const l = (await p.req("/api/orgs/1/tp/avaliacoes", { quem: "admin" })).dados.avaliacoes;
  const laura = l.find(a => a.autor === "Laura"), marco = l.find(a => a.autor === "Marco");
  assert.equal(laura.status, "RESPONDIDA"); assert.equal(laura.resposta, "Thank you, Laura!");
  assert.ok(p.channexChamadas.some(c => c.caminho === "/reviews/rv1/reply" && c.corpo.reply.reply === "Thank you, Laura!"));
  assert.equal(marco.status, "PRECISA_VOCE", "4 de 10 no Booking: não responde sozinha");
  assert.equal(marco.estrelas, 2); assert.equal(marco.analise.remocao.chance, "ALTA");
  assert.ok(!p.channexChamadas.some(c => c.caminho === "/reviews/rv2/reply"));
  // O anfitrião aprova a resposta sugerida.
  await p.req(`/api/orgs/1/tp/avaliacoes/${marco.id}/responder`, { metodo: "POST", quem: "admin", corpo: { texto: "Obrigado, Marco." } });
  assert.ok(p.channexChamadas.some(c => c.caminho === "/reviews/rv2/reply"));
  // Sem a conexão oficial: cola a avaliação e recebe a análise.
  const man = (await p.req("/api/orgs/1/tp/avaliacoes", { metodo: "POST", quem: "admin", corpo: { imovel_id: id, canal: "airbnb", nota: 3, autor: "Rui", texto: "Barulho na rua." } })).dados;
  assert.equal(man.avaliacao.status, "PRECISA_VOCE");
});

test("Temporada — importar anúncio colando a página: título, descrição, regras e comodidades; cartão mostra as plataformas", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/ia/chave", { metodo: "POST", quem: "admin", corpo: { chave: "sk-proj-" + "f".repeat(40) } });
  p.web = { "https://www.airbnb.com.br/calendar/ical/123.ics?s=x": "BEGIN:VCALENDAR\nEND:VCALENDAR" };
  const r0 = (await p.req("/api/orgs/1/tp/imoveis/rapido", { metodo: "POST", quem: "admin", corpo: { imoveis: [{ nome: "Apê Samba Vila Isabel", links: ["https://www.airbnb.com.br/calendar/ical/123.ics?s=x"] }] } })).dados;
  const id = r0.imoveis[0].id;
  p.openai = () => ({ output_text: JSON.stringify({ titulo: "Apê Samba Vila Isabel! Próx UERJ", descricao: "Apartamento aconchegante…", capacidade: 7, quartos: 2, banheiros: 1, checkin: "14:00", checkout: "11:00", regras: "Proibido festas. Sem pets.", comodidades: ["Wi-Fi", "Ar-condicionado", "Piscina olímpica"], camas: "1 casal e 3 solteiro" }) });
  const r = (await p.req(`/api/orgs/1/tp/imoveis/${id}/anuncio/colar`, { metodo: "POST", quem: "admin", corpo: { texto: "Apê Samba Vila Isabel! ".repeat(10) + "Mostrar mais… Comodidades: Wi-Fi, Ar-condicionado. Regras: proibido festas." } })).dados;
  assert.equal(r.comodidades, 2, "só comodidades da lista oficial");
  const im = (await p.req(`/api/orgs/1/tp/imoveis/${id}`, { quem: "admin" })).dados.imovel;
  assert.equal(im.anuncio.titulo, "Apê Samba Vila Isabel! Próx UERJ"); assert.equal(im.capacidade, 7); assert.equal(im.checkin, "14:00");
  assert.match(im.treinamento.regras, /Proibido festas/); assert.match(im.treinamento.estrutura, /1 casal e 3 solteiro/);
  const lista = (await p.req("/api/orgs/1/tp/imoveis", { quem: "admin" })).dados.imoveis;
  assert.deepEqual(lista[0].plataformas.map(x => x.canal), ["airbnb"]);
  assert.equal((await p.req(`/api/orgs/1/tp/imoveis/${id}/anuncio/colar`, { metodo: "POST", quem: "admin", corpo: { texto: "curto" } })).status, 400);
});

test("Problemas — mensagens não entregues, clientes esperando, posts que não saíram e contador do menu", async () => {
  const p = await criarPlataforma();
  const t0 = Date.parse("2026-10-20T15:00:00Z");
  p.env.__agora = () => t0;
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const vazio = await p.req("/api/orgs/1/problemas", { quem: "admin" });
  assert.equal(vazio.status, 200, JSON.stringify(vazio.dados));
  assert.equal(vazio.dados.total, 0);
  await p.req("/api/orgs/1/mk/resumo", { quem: "admin" }); // cria as tabelas do marketing
  const db = p.env.DB, min = 60000;
  const exec = (sql, ...a) => db.prepare(sql).bind(...a).run();
  await exec("INSERT INTO plt_zap_contatos(org_id,telefone,nome,pausado_ate,ultima_entrada_ms,ultimo_ms) VALUES(1,'5521999990001','Ana',?,?,?)", t0 + 600 * min, t0 - 90 * min, t0 - 90 * min);
  await exec("INSERT INTO plt_zap_contatos(org_id,telefone,nome,pausado_ate,ultima_entrada_ms,ultimo_ms) VALUES(1,'5521999990002','Beto',?,?,?)", t0 + 600 * min, t0 - 90 * min, t0 - 80 * min);
  await exec("INSERT INTO plt_zap_msgs(org_id,telefone,direcao,origem,texto,status,criado_ms) VALUES(1,'5521999990002','S','EQUIPE','Oi Beto, já vamos ver','ENVIADA',?)", t0 - 80 * min);
  for (const [i, erro] of [[1, "131047: Re-engagement message"], [2, "131047: Re-engagement message"], [3, "131026: Message undeliverable"]])
    await exec("INSERT INTO plt_zap_msgs(org_id,telefone,direcao,origem,texto,wamid,status,erro,criado_ms) VALUES(1,?,'S','ROBO','Menu','w" + i + "','FAILED',?,?)", i < 3 ? "5521999990003" : "5521999990004", erro, t0 - i * min);
  await exec("INSERT INTO plt_zap_msgs(org_id,telefone,direcao,origem,texto,wamid,status,erro,criado_ms) VALUES(1,'5521999990005','S','ROBO','velha','w9','FAILED','131026: x',?)", t0 - 9 * 86400000);
  for (const c of ["publicacao TEXT", "tentativas INTEGER"]) await exec("ALTER TABLE plt_mk_posts ADD COLUMN " + c).catch(() => { }); // colunas da publicação automática
  const marca = await db.prepare("INSERT INTO plt_mk_marcas(org_id,nome,criado_ms) VALUES(1,'Loja X',?) RETURNING id").bind(t0).first().catch(() => null);
  const mid = marca?.id || 1;
  await exec("INSERT INTO plt_mk_posts(org_id,marca_id,canais,data,hora,titulo,status,publicacao,criado_ms,atualizado_ms) VALUES(1,?,'[\"instagram\"]','2026-10-20','09:00','Promoção de outubro','APROVADO',?,?,?)", mid, JSON.stringify({ instagram: { erro: "O Instagram exige uma imagem. Crie a arte do post antes de publicar.", em: t0 - 30 * min } }), t0, t0);
  await exec("INSERT INTO plt_mk_posts(org_id,marca_id,canais,data,hora,titulo,status,criado_ms,atualizado_ms) VALUES(1,?,'[\"facebook\"]','2026-10-19','10:00','Dica da semana','APROVADO',?,?)", mid, t0, t0);
  await exec("INSERT INTO plt_mk_posts(org_id,marca_id,canais,data,hora,titulo,status,criado_ms,atualizado_ms) VALUES(1,?,'[\"facebook\"]','2026-10-25','10:00','Futuro','APROVADO',?,?)", mid, t0, t0);
  await exec("INSERT INTO plt_mk_avaliacoes(org_id,marca_id,autor,nota,texto,status,criado_ms) VALUES(1,?,'Carla',1,'Péssimo atendimento','PENDENTE',?)", mid, t0 - 5 * min);
  await exec("INSERT INTO plt_mk_avaliacoes(org_id,marca_id,autor,nota,texto,status,criado_ms) VALUES(1,?,'Davi',5,'Ótimo','PENDENTE',?)", mid, t0 - 5 * min);
  await exec("INSERT INTO plt_meta(chave,valor) VALUES('zap_assinatura_falhou_1',?)", String(t0 - 10 * min));
  const { registrarProblema, resolverProblema } = await import(new URL("../src/problemas.js", import.meta.url).href);
  await registrarProblema(p.env, 1, { chave: "telegram", area: "AVISOS", gravidade: "ALTA", titulo: "O aviso para a equipe no Telegram não foi enviado", motivo: "O bot foi removido do grupo." });
  await registrarProblema(p.env, 1, { chave: "telegram", area: "AVISOS", gravidade: "ALTA", titulo: "O aviso para a equipe no Telegram não foi enviado", motivo: "O bot foi removido do grupo." });
  await registrarProblema(p.env, 2, { chave: "telegram", area: "AVISOS", titulo: "de outra empresa" });

  const r = await p.req("/api/orgs/1/problemas", { quem: "admin" });
  const lista = r.dados.problemas;
  const achar = re => lista.find(x => re.test(x.titulo));
  assert.ok(achar(/Ana .*esperando resposta/), "cliente pediu atendente e ninguém respondeu");
  assert.ok(!achar(/Beto/), "a equipe já respondeu o Beto");
  const nao = achar(/não entregue para 5521999990003/);
  assert.equal(nao.vezes, 2); assert.match(nao.motivo, /24 horas/); assert.match(nao.dica, /modelo aprovado/);
  assert.match(achar(/5521999990004/).motivo, /não tem WhatsApp|não recebeu/);
  assert.ok(!achar(/5521999990005/), "falhas com mais de 7 dias não aparecem");
  assert.match(achar(/Promoção de outubro.*Instagram/).motivo, /sem arte/);
  assert.ok(achar(/Dica da semana.*não saiu/), "post atrasado aparece");
  assert.ok(!achar(/Futuro/));
  assert.ok(achar(/1★ de Carla/)); assert.ok(!achar(/Davi/));
  assert.ok(achar(/recusadas/), "assinatura do webhook");
  const tg = achar(/Telegram/); assert.equal(tg.vezes, 2); assert.equal(tg.gravidade, "ALTA");
  assert.ok(!lista.some(x => x.titulo === "de outra empresa"), "cada empresa só vê os seus");
  assert.equal(lista.length, 8, lista.map(x => x.titulo).join(" | "));
  assert.equal((await p.req("/api/orgs/1/problemas?contar=1", { quem: "admin" })).dados.total, 8);

  // Marcar como resolvido esconde; se acontecer de novo, volta.
  assert.equal((await p.req("/api/orgs/1/problemas/resolver", { quem: "admin", metodo: "POST", corpo: { chaves: [nao.chave, tg.chave] } })).status, 200);
  assert.equal((await p.req("/api/orgs/1/problemas?contar=1", { quem: "admin" })).dados.total, 6);
  await exec("INSERT INTO plt_zap_msgs(org_id,telefone,direcao,origem,texto,wamid,status,erro,criado_ms) VALUES(1,'5521999990003','S','ROBO','Menu','w10','FAILED','131047: x',?)", t0);
  await registrarProblema(p.env, 1, { chave: "telegram", area: "AVISOS", titulo: "O aviso para a equipe no Telegram não foi enviado", motivo: "x" });
  const r2 = (await p.req("/api/orgs/1/problemas", { quem: "admin" })).dados.problemas;
  assert.equal(r2.find(x => /5521999990003/.test(x.titulo)).vezes, 3, "falha nova faz voltar");
  assert.equal(r2.find(x => /Telegram/.test(x.titulo)).vezes, 1, "volta contando do zero");
  await resolverProblema(p.env, 1, "telegram");
  assert.ok(!(await p.req("/api/orgs/1/problemas", { quem: "admin" })).dados.problemas.some(x => /Telegram/.test(x.titulo)), "some quando volta a funcionar");
});

test("Agenda — a IA marca a reunião, a equipe é avisada no Telegram, vê na Agenda e em Problemas e recebe lembrete", async () => {
  const { p, inf } = await duasEmpresasComChatbot();
  const t0 = Date.parse("2026-10-20T15:00:00Z"); // 12:00 em Brasília
  let agora = t0;
  p.env.__agora = () => agora;
  p.env.TELEGRAM_BOT_TOKEN_PLATAFORMA = "999:" + "T".repeat(30);
  const anterior = globalThis.fetch, tg = [];
  let segredo = "", tgFora = false;
  globalThis.fetch = async (url, op = {}) => {
    if (String(url).startsWith("https://api.telegram.org/bot999:")) {
      const metodo = String(url).split("/").pop(), corpo = op.body ? JSON.parse(op.body) : {};
      if (metodo === "sendMessage" && tgFora) return new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was kicked from the supergroup chat" }), { status: 403 });
      tg.push({ metodo, corpo });
      if (metodo === "getMe") return new Response(JSON.stringify({ ok: true, result: { username: "DeniaAvisosBot" } }));
      if (metodo === "setWebhook") { segredo = corpo.secret_token; return new Response(JSON.stringify({ ok: true })); }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 500 + tg.length } }));
    }
    return anterior(url, op);
  };
  try {
    await p.req("/api/admin/telegram", { metodo: "POST", quem: "admin", corpo: {} });
    const link = await p.req(`/api/orgs/${inf}/zap/telegram/link`, { metodo: "POST", quem: "admin", corpo: {} });
    await p.req("/webhook/telegram", { metodo: "POST", cabecalhos: { "x-telegram-bot-api-secret-token": segredo }, corpo: { message: { message_id: 1, chat: { id: -100777, type: "supergroup", title: "Equipe" }, from: { first_name: "Ana" }, text: `/start@DeniaAvisosBot ${link.dados.codigo}` } } });
    await p.req("/api/orgs/1/ia/chave", { metodo: "POST", quem: "admin", corpo: { chave: "sk-proj-" + "d".repeat(40) } });
    await p.req(`/api/orgs/${inf}/zap/config`, { metodo: "POST", quem: "admin", corpo: { modo: "IA", sobre: "Consultoria. Reuniões online de 30 min, seg a sex, 9h às 17h.", ia_regras: "Pode marcar reuniões online." } });
    const entradas = [];
    p.openai = (url, corpo) => {
      const t = corpo.input[0].content[0].text; entradas.push(t);
      const nova = t.match(/MENSAGEM NOVA DO CLIENTE: "([^"]*)"/)[1];
      let o = { resposta: "Claro! Que dia fica bom?" };
      if (/quinta às 15/i.test(nova)) o = { resposta: "Pronto, Marcos! Reunião online marcada para quinta, 22/10, às 15h. A equipe já foi avisada.", agendamento: { acao: "marcar", quando: "2026-10-22 15:00", o_que: "Reunião online", detalhes: "Assunto: plano de marketing. E-mail: marcos@cliente.test" } };
      if (/de novo/i.test(nova)) o = { resposta: "Já está marcado!", agendamento: { acao: "marcar", quando: "2026-10-22 15:00", o_que: "Reunião online" } };
      if (/sexta às 10/i.test(nova)) o = { resposta: "Mudei para sexta às 10h.", agendamento: { acao: "remarcar", quando: "2026-10-23 10:00" } };
      if (/desmarcar/i.test(nova)) o = { resposta: "Tudo bem, desmarquei.", agendamento: { acao: "cancelar" } };
      return { output: [{ content: [{ type: "output_text", text: JSON.stringify(o) }] }], usage: { input_tokens: 900, output_tokens: 40 } };
    };
    const CLI = "5521977770000";
    const enviar = async texto => { agora += 60000; await webhookZap(p, "111111111111", { from: CLI, type: "text", text: { body: texto }, timestamp: String(Math.floor(agora / 1000)) }, "Marcos"); };
    await enviar("quero marcar uma reunião");
    await enviar("pode ser quinta às 15h");
    assert.match(enviadosPara(p, CLI).at(-1).corpo.text.body, /marcada para quinta/);
    const aviso = tg.filter(x => x.metodo === "sendMessage").at(-1);
    assert.equal(aviso.corpo.chat_id, "-100777");
    assert.match(aviso.corpo.text, /NOVO AGENDAMENTO[\s\S]*5521977770000[\s\S]*qui\.?, 22\/10 às 15:00[\s\S]*Reunião online[\s\S]*plano de marketing/);
    let ag = (await p.req(`/api/orgs/${inf}/zap/agenda`, { quem: "admin" })).dados.agenda;
    assert.equal(ag.length, 1); assert.equal(ag[0].status, "MARCADO"); assert.equal(ag[0].avisado, 1);
    assert.equal(ag[0].quando_ms, Date.parse("2026-10-22T18:00:00Z"));
    // A IA vê o que já está marcado e não duplica.
    await enviar("confirma de novo?");
    assert.match(entradas.at(-1), /AGENDAMENTOS DESTE CLIENTE: qui\.?, 22\/10 às 15:00 — Reunião online/);
    assert.equal((await p.req(`/api/orgs/${inf}/zap/agenda`, { quem: "admin" })).dados.agenda.length, 1);
    // Aparece em Problemas até alguém da equipe tocar em "Vi".
    let prb = (await p.req(`/api/orgs/${inf}/problemas`, { quem: "admin" })).dados.problemas.filter(x => x.area === "AGENDA");
    assert.equal(prb.length, 1); assert.match(prb[0].titulo, /Novo agendamento: Reunião online com Marcos/);
    assert.equal((await p.req(`/api/orgs/${inf}/zap/agenda/${ag[0].id}`, { metodo: "POST", quem: "admin", corpo: { acao: "visto" } })).status, 200);
    assert.equal((await p.req(`/api/orgs/${inf}/problemas`, { quem: "admin" })).dados.problemas.filter(x => x.area === "AGENDA").length, 0);
    // Remarcou: avisa de novo e volta para "ninguém viu".
    await enviar("pode mudar para sexta às 10h?");
    assert.match(tg.filter(x => x.metodo === "sendMessage").at(-1).corpo.text, /REMARCADO \(antes: qui\.?, 22\/10 às 15:00\)[\s\S]*sex\.?, 23\/10 às 10:00/);
    ag = (await p.req(`/api/orgs/${inf}/zap/agenda`, { quem: "admin" })).dados.agenda;
    assert.equal(ag.length, 1); assert.equal(ag[0].visto_ms, null);
    // Lembrete cerca de 1 hora antes (pelo cron).
    const mod = await import(new URL("../src/worker.js?t=" + (++n), import.meta.url).href);
    const cron = async () => { let tarefa; await mod.default.scheduled({}, p.env, { waitUntil: pr => { tarefa = pr; } }); await tarefa; };
    agora = Date.parse("2026-10-23T12:10:00Z"); // 09:10 em Brasília
    await p.entrar("admin", ADMIN, SENHA_ADMIN); // a sessão expira em 3 dias parados
    const antes = tg.length;
    await cron();
    assert.match(tg.slice(antes).filter(x => x.metodo === "sendMessage").map(x => x.corpo.text).join("\n"), /LEMBRETE: daqui a 50 min[\s\S]*Marcos/);
    const depois = tg.length; agora += 5 * 60000; await cron();
    assert.ok(!tg.slice(depois).some(x => /LEMBRETE/.test(x.corpo?.text || "")), "lembra uma vez só");
    // Cancelou com o Telegram fora do ar: fica em Problemas como urgente.
    tgFora = true;
    await enviar("preciso desmarcar");
    ag = (await p.req(`/api/orgs/${inf}/zap/agenda`, { quem: "admin" })).dados.agenda;
    assert.equal(ag[0].status, "CANCELADO"); assert.equal(ag[0].avisado, 0);
    prb = (await p.req(`/api/orgs/${inf}/problemas`, { quem: "admin" })).dados.problemas;
    assert.ok(prb.some(x => x.area === "AGENDA" && /cancelou/.test(x.titulo) && x.gravidade === "ALTA"));
    assert.ok(prb.some(x => /não foi avisada de um agendamento/.test(x.titulo)));
    // Cada empresa só vê a própria agenda.
    assert.equal((await p.req(`/api/orgs/1/zap/agenda`, { quem: "admin" })).dados.agenda.length, 0);
  } finally { globalThis.fetch = anterior; }
});

test("Problemas — avisos não urgentes da IA da Central aparecem na página (e só para a empresa ligada a ela)", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://engine.test/", token: TOKEN_ENGINE } });
  await p.engine.cliente("5521911112222", "oi"); // o motor cria as tabelas
  const t = p.engine.agora;
  await p.engine.DB.prepare("INSERT INTO d30_eventos(caso_id,tipo,descricao,criado_ms) VALUES(12,'AVISO_PAINEL',?,?)").bind('Carlos (estofador) (caso #12) escreveu: "chego 15h". Nenhuma ação automática foi tomada.', t).run();
  await p.engine.DB.prepare("INSERT INTO d30_eventos(caso_id,tipo,descricao,criado_ms) VALUES(NULL,'ALERTA_EQUIPE','urgente que foi ao Telegram',?)").bind(t).run();
  const r = await p.req("/api/orgs/1/problemas", { quem: "admin" });
  const central = r.dados.problemas.filter(x => x.area === "CENTRAL");
  assert.equal(central.length, 1, JSON.stringify(r.dados.problemas.map(x => x.titulo)));
  assert.match(central[0].titulo, /^Carlos \(estofador\) \(caso #12\) escreveu/);
  assert.match(central[0].motivo, /Nenhuma ação automática/);
  // Marcar como resolvido esconde.
  await p.req("/api/orgs/1/problemas/resolver", { metodo: "POST", quem: "admin", corpo: { chaves: [central[0].chave] } });
  assert.equal((await p.req("/api/orgs/1/problemas", { quem: "admin" })).dados.problemas.filter(x => x.area === "CENTRAL").length, 0);
  // Outra empresa (sem a IA da Central) não vê nada disso.
  const nova = await p.req("/api/admin/organizacoes", { metodo: "POST", quem: "admin", corpo: { nome: "Shopping Infomix", segmento: "Shopping" } });
  const outra = await p.req(`/api/orgs/${nova.dados.id}/problemas`, { quem: "admin" });
  assert.equal(outra.dados.problemas.filter(x => x.area === "CENTRAL").length, 0);
});

test("Profissionais da Central: o administrador cadastra pela plataforma e a IA passa a usar", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://engine.test/", token: TOKEN_ENGINE } });
  const r = await p.req("/api/orgs/1/engine/professionals", { metodo: "POST", quem: "admin", corpo: { nome: "João Faz Tudo", telefone: "21 91111-9999", area: "PEQUENOS_REPAROS", servicos: "pendura quadros" } });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const l = await p.req("/api/orgs/1/engine/professionals", { quem: "admin" });
  assert.ok(l.dados.profissionais.some(x => x.nome === "João Faz Tudo" && x.area === "PEQUENOS_REPAROS" && x.ativo));
  const aud = await p.req("/api/orgs/1/auditoria", { quem: "admin" });
  assert.ok(aud.dados.eventos.some(e => /João Faz Tudo/.test(e.detalhe || "")), "fica na auditoria");
});

test("Relatórios — conversas pela janela de 24 h, planilha profissional e envio no dia e horário escolhidos", async () => {
  const p = await criarPlataforma({ RESEND_API_KEY: "re_teste", EMAIL_REMETENTE: "DENIA <nao-responda@denia.test>" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const nova = await p.req("/api/admin/organizacoes", { metodo: "POST", quem: "admin", corpo: { nome: "Loja Chatbot", segmento: "Varejo" } });
  const inf = nova.dados.id;
  assert.ok(inf, JSON.stringify(nova.dados));
  await p.req(`/api/orgs/${inf}/zap/stats`, { quem: "admin" }); // cria as tabelas do chatbot
  const db = p.env.DB, exec = (sql, ...a) => db.prepare(sql).bind(...a).run();
  const ms = s => Date.parse(s);
  await exec("INSERT INTO plt_zap_contas(org_id,phone_number_id,config,modo,ativo,atualizado_ms) VALUES(?,'555000111','{}','BOTOES',1,?)", inf, ms("2026-10-01T12:00:00Z"));
  await exec("INSERT INTO plt_zap_contatos(org_id,telefone,nome,ultimo_ms) VALUES(?,'5521911110001','Ana Lima',0),(?,'5521911110002','Beto',0)", inf, inf);
  // Beto já tinha falado antes (recorrente). Ana: 3 mensagens na segunda de manhã (1 conversa), volta na quarta (2ª conversa).
  await exec("INSERT INTO plt_zap_msgs(org_id,telefone,direcao,origem,texto,criado_ms) VALUES(?,'5521911110002','E','CLIENTE','oi',?)", inf, ms("2026-09-20T15:00:00Z"));
  for (const [tel, quando] of [["5521911110001", "2026-10-12T13:05:00Z"], ["5521911110001", "2026-10-12T13:06:00Z"], ["5521911110001", "2026-10-12T22:00:00Z"], ["5521911110002", "2026-10-12T18:30:00Z"], ["5521911110001", "2026-10-14T20:10:00Z"]])
    await exec("INSERT INTO plt_zap_msgs(org_id,telefone,direcao,origem,texto,criado_ms) VALUES(?,?,'E','CLIENTE','oi',?)", inf, tel, ms(quando));
  for (const [tel, cam, quando] of [["5521911110001", "Serviços › Celular", "2026-10-12T13:06:30Z"], ["5521911110002", "Serviços › Celular", "2026-10-12T18:31:00Z"], ["5521911110001", "Produtos › Roupas", "2026-10-14T20:11:00Z"]])
    await exec("INSERT INTO plt_zap_buscas(org_id,telefone,caminho,titulo,tipo,via,resultados,criado_ms) VALUES(?,?,?,?,'LISTA','BOTAO',1,?)", inf, tel, cam, cam.split(" › ").pop(), ms(quando));
  // Registro do que foi para o grupo do Telegram (um aviso por busca).
  for (const [i, tel, quando] of [[1, "5521911110001", "2026-10-12T13:06:30Z"], [2, "5521911110002", "2026-10-12T18:31:00Z"], [3, "5521911110001", "2026-10-14T20:11:00Z"]])
    await exec("INSERT INTO plt_zap_tg(chat_id,message_id,org_id,telefone,criado_ms) VALUES('-100',?,?,?,?)", i, inf, tel, ms(quando));
  p.env.__agora = () => ms("2026-10-19T14:00:00Z"); // segunda: últimos 7 dias = 12 a 18/10
  const r = (await p.req(`/api/orgs/${inf}/relatorio`, { quem: "admin" })).dados;
  assert.equal(r.de, "2026-10-12"); assert.equal(r.ate, "2026-10-18");
  const { clientes, conversas, novos, recorrentes, voltaram, buscas, escolheram, avisados } = r.totais;
  assert.deepEqual({ clientes, conversas, novos, recorrentes, voltaram, buscas }, { clientes: 2, conversas: 3, novos: 1, recorrentes: 1, voltaram: 1, buscas: 3 }, "3 conversas, não 5 mensagens");
  assert.deepEqual([escolheram, avisados], [2, 2], "os dois escolheram uma opção e geraram aviso no Telegram");
  assert.deepEqual(r.por_dia.map(d => d.clientes), [2, 0, 1, 0, 0, 0, 0]);
  assert.equal(r.categorias[0].categoria, "Serviços › Celular"); assert.equal(r.categorias[0].clientes, 2);
  const ana = r.conversas[0];
  assert.equal(ana.nome, "Ana Lima"); assert.equal(ana.mensagens, 3); assert.equal(ana.vezes, 2); assert.equal(ana.recorrente, false); assert.deepEqual(ana.buscas, ["Serviços › Celular"]);
  assert.equal(r.conversas[1].recorrente, true, "Beto já era cliente");
  // Planilha Excel.
  const x = (await p.req(`/api/orgs/${inf}/relatorio?formato=xlsx`, { quem: "admin" })).dados;
  const z = Buffer.from(x.base64, "base64");
  assert.equal(z.subarray(0, 2).toString(), "PK");
  const t = z.toString("utf8");
  for (const aba of ["Resumo", "Por dia", "Clientes", "Categorias"]) assert.match(t, new RegExp(`name="${aba}"`));
  assert.match(t, /Ana Lima/); assert.match(t, /Total do período/); assert.match(t, /10:05/, "hora de Brasília"); assert.match(t, /segunda-feira/);
  assert.doesNotMatch(t, /[\u{1F300}-\u{1FAFF}]/u, "sem emoji na planilha");
  // Painel: últimas 24 h e chatbot contando conversas.
  p.env.__agora = () => ms("2026-10-15T12:00:00Z");
  const res = (await p.req(`/api/orgs/${inf}/relatorio?resumo=1`, { quem: "admin" })).dados;
  assert.equal(res.ultimas_24h.clientes, 1); assert.equal(res.ultimas_24h.conversas, 1);
  const st = (await p.req(`/api/orgs/${inf}/zap/stats?de=2026-10-12&ate=2026-10-18`, { quem: "admin" })).dados;
  assert.equal(st.contatos, 2); assert.equal(st.conversas, 3);
  // Envio: o administrador escolhe quarta às 10h.
  assert.equal((await p.req(`/api/orgs/${inf}/relatorio/config`, { metodo: "POST", quem: "admin", corpo: { ativo: true, dia: 3, hora: 10, emails: "gerente@loja.test, invalido" } })).status, 400, "e-mail inválido é recusado");
  const cfg = await p.req(`/api/orgs/${inf}/relatorio/config`, { metodo: "POST", quem: "admin", corpo: { ativo: true, dia: 3, hora: 10, emails: "gerente@loja.test" } });
  assert.deepEqual(cfg.dados.config, { ativo: true, dia: 3, hora: 10, emails: "gerente@loja.test" });
  const mod = await import(new URL("../src/worker.js?t=rel" + Math.random(), import.meta.url).href);
  const rodar = async () => { await mod.default.scheduled({}, p.env, { waitUntil: pr => pr }); await new Promise(r => setTimeout(r, 50)); };
  p.env.__agora = () => ms("2026-10-19T11:30:00Z"); await rodar(); // segunda: não é o dia escolhido
  p.env.__agora = () => ms("2026-10-21T12:30:00Z"); await rodar(); // quarta 09:30: antes do horário
  const daLoja = () => p.emails.filter(e => /Loja Chatbot/.test(e.subject));
  assert.equal(daLoja().length, 0);
  p.env.__agora = () => ms("2026-10-21T13:10:00Z"); await rodar(); // quarta 10:10
  assert.deepEqual(daLoja().map(e => e.to[0]).sort(), [ADMIN, "gerente@loja.test"].sort());
  assert.match(daLoja()[0].subject, /14\/10\/2026 a 20\/10\/2026/, "os 7 dias anteriores ao envio");
  assert.match(daLoja()[0].text, /Clientes que entraram em contato: 1/);
  assert.equal(daLoja()[0].attachments[0].filename, "relatorio-clientes-2026-10-14-a-2026-10-20.xlsx");
  await rodar();
  assert.equal(daLoja().length, 2, "uma vez só no dia");
});

test("Relatórios — empresa com IA: clientes da IA entram na planilha, profissionais não", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://engine.test", token: TOKEN_ENGINE } });
  p.engine.agora = Date.now() - 60000; // o banco grava a hora real nas mensagens: o relógio do motor acompanha
  p.engine.llmCliente = () => ({ resposta: "Certo!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: false, fatos: { servico: "chaveiro", problema: "troca de fechadura", categoria: "CHAVEIRO" }, categoria_confianca: "ALTA" });
  await p.engine.cliente("5521911112222", "Preciso trocar a fechadura", { nome: "Marta" });
  await p.engine.cliente("5521964545279", "Bom dia"); // profissional (chaveiro): não conta como cliente
  const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const r = (await p.req(`/api/orgs/1/relatorio?de=2026-10-01&ate=${hoje}`, { quem: "admin" })).dados;
  assert.ok(r.fontes.includes("ia"), JSON.stringify(r.fontes));
  assert.equal(r.totais.clientes, 1);
  assert.equal(r.conversas[0].nome, "Marta");
  assert.match(r.conversas[0].buscas[0], /^Chaveiro: troca de fechadura/);
  assert.equal(r.categorias[0].categoria, "Chaveiro");
});

test("Relatórios — chatbot: separa quem só mandou mensagem de quem gerou aviso no Telegram (registro exato do grupo)", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const nova = await p.req("/api/admin/organizacoes", { metodo: "POST", quem: "admin", corpo: { nome: "Shopping Teste", segmento: "Shopping" } });
  const org = nova.dados.id;
  await p.req(`/api/orgs/${org}/zap/stats`, { quem: "admin" });
  const db = p.env.DB, exec = (sql, ...a) => db.prepare(sql).bind(...a).run(), ms = s => Date.parse(s);
  await exec("INSERT INTO plt_zap_contas(org_id,phone_number_id,config,modo,ativo,atualizado_ms) VALUES(?,'555000222','{}','BOTOES',1,?)", org, ms("2026-10-01T12:00:00Z"));
  const lojas = (await exec("INSERT INTO plt_zap_itens(org_id,pai_id,tipo,titulo,ordem,ativo,extra) VALUES(?,0,'LISTA','Celular',1,1,'{}') RETURNING id", org)).results?.[0]?.id
    || db.q("SELECT id FROM plt_zap_itens WHERE org_id=? AND titulo='Celular'", org)[0].id;
  await exec("INSERT INTO plt_zap_itens(org_id,pai_id,tipo,titulo,ordem,ativo,extra) VALUES(?,0,'RESPOSTA','Endereço',2,1,'{\"lead\":false}')", org);
  const endereco = db.q("SELECT id FROM plt_zap_itens WHERE org_id=? AND titulo='Endereço'", org)[0].id;
  const msg = (tel, q) => exec("INSERT INTO plt_zap_msgs(org_id,telefone,direcao,origem,texto,criado_ms) VALUES(?,?,'E','CLIENTE','x',?)", org, tel, ms(q));
  const busca = (tel, item, cam, q) => exec("INSERT INTO plt_zap_buscas(org_id,telefone,item_id,tipo,titulo,caminho,via,resultados,criado_ms) VALUES(?,?,?,?,?,?,'BOTAO',1,?)", org, tel, item, item === endereco ? "RESPOSTA" : "LISTA", cam, cam, ms(q));
  // Domingo 25/10: 4 pessoas mandaram mensagem; 3 geraram aviso.
  for (const t of ["5521900000001", "5521900000002", "5521900000003", "5521900000004", "5521900000005"]) await msg(t, "2026-10-25T14:00:00Z");
  await busca("5521900000001", lojas, "Celular", "2026-10-25T14:01:00Z");
  await busca("5521900000001", lojas, "Celular", "2026-10-25T14:20:00Z"); // repetida em 1 h: não avisa de novo
  await busca("5521900000002", lojas, "Celular", "2026-10-25T15:00:00Z");
  await busca("5521900000003", lojas, "Celular", "2026-10-25T16:00:00Z");
  await busca("5521900000004", endereco, "Endereço", "2026-10-25T17:00:00Z"); // opção sem aviso
  // 5521900000005 só mandou "oi"
  // O que de fato foi para o grupo: 1 aviso para cada um dos 3, e o cliente 1 também pediu atendente (2º aviso).
  for (const [i, tel, q] of [[1, "5521900000001", "2026-10-25T14:01:00Z"], [2, "5521900000002", "2026-10-25T15:00:00Z"], [3, "5521900000003", "2026-10-25T16:00:00Z"], [4, "5521900000001", "2026-10-25T14:30:00Z"]])
    await exec("INSERT INTO plt_zap_tg(chat_id,message_id,org_id,telefone,criado_ms) VALUES('-100',?,?,?,?)", i, org, tel, ms(q));
  const r = (await p.req(`/api/orgs/${org}/relatorio?de=2026-10-25&ate=2026-10-25`, { quem: "admin" })).dados;
  assert.equal(r.totais.clientes, 5, "5 números mandaram mensagem");
  assert.equal(r.totais.escolheram, 4, "4 escolheram alguma opção");
  assert.equal(r.totais.avisados, 3, "3 clientes geraram aviso no Telegram — igual ao Telegram");
  assert.equal(r.totais.avisos, 4, "4 avisos no grupo — o mesmo número do Telegram (1 cliente pode gerar vários)");
  assert.equal(r.por_dia[0].avisos, 4);
  assert.equal(r.por_dia[0].avisados, 3);
  const so = r.conversas.find(c => c.telefone === "5521900000005");
  assert.deepEqual([so.buscas.length, so.avisos], [0, 0]);
});

test("Login: aceita o próprio site com www ou atrás do proxy (http/https), recusa outro site", async () => {
  const p = await criarPlataforma();
  for (const origin of ["https://www.plataforma.test", "http://plataforma.test"]) {
    const r = await p.req("/api/entrar", { metodo: "POST", corpo: { email: ADMIN, senha: SENHA_ADMIN }, cabecalhos: { origin } });
    assert.equal(r.status, 200, origin + " " + JSON.stringify(r.dados));
  }
  for (const origin of ["https://malicioso.test", "https://plataforma.test.malicioso.test"]) {
    const r = await p.req("/api/entrar", { metodo: "POST", corpo: { email: ADMIN, senha: SENHA_ADMIN }, cabecalhos: { origin } });
    assert.equal(r.status, 403, origin);
  }
});

test("Contas conectadas — ao conectar a Meta e o Google, a DENIA puxa a logo e preenche só o que está vazio", async () => {
  const p = await criarPlataforma({ META_APP_ID: "123456", META_APP_SECRET: "segredo-do-app", GOOGLE_CLIENT_ID: "cliente.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "segredo-google", OPENAI_API_KEY: "sk-teste" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Clínica Sol", cidade: "Niterói (escrito à mão)" } })).dados.id;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  p.web = { "https://img.test/ig.png": png };
  p.openai = () => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ tom: "Acolhedor e direto", publico: "Famílias de Niterói", diferenciais: "Atendimento no mesmo dia" }) }] }] });
  // Meta
  const ida = await p.req(`/api/orgs/1/mk/meta/conectar?marca=${marca}`, { quem: "admin" });
  const state = new URL(ida.r.headers.get("location")).searchParams.get("state");
  p.meta = (url) => {
    if (url.includes("oauth/access_token")) return { access_token: "longo" };
    if (url.includes("me/accounts")) return { data: [{ id: "PAG1", name: "Clínica Sol Niterói", access_token: "token-da-pagina", instagram_business_account: { id: "IG1", username: "clinicasol" } }] };
    if (url.includes("/PAG1?")) return { category: "Clínica odontológica", website: "https://clinicasol.test", phone: "+55 21 3333-4444", link: "https://facebook.com/clinicasol", location: { city: "Niterói", state: "RJ" }, about: "Clínica de odontologia com atendimento no mesmo dia para toda a família." };
    if (url.includes("/IG1?")) return { profile_picture_url: "https://img.test/ig.png", biography: "Sorrisos que mudam vidas", username: "clinicasol" };
    return { error: { message: "inesperado " + url } };
  };
  const nonce = (await (await p.req(`/api/meta/retorno?code=abc&state=${encodeURIComponent(state)}`)).r.text()).match(/\/app#\/marcas\/meta-([A-Za-z0-9_-]+)/)[1];
  const esc = await p.req("/api/orgs/1/mk/meta/escolher", { metodo: "POST", quem: "admin", corpo: { n: nonce, pagina_id: "PAG1" } });
  assert.ok(esc.dados.preenchidos.includes("logo"), JSON.stringify(esc.dados));
  let m = p.env.DB.q("SELECT * FROM plt_mk_marcas WHERE id=?", marca)[0];
  assert.equal(m.cidade, "Niterói (escrito à mão)", "não troca o que a pessoa escreveu");
  assert.deepEqual([m.segmento, m.site, m.whatsapp, m.facebook, m.instagram, m.tom, m.publico], ["Clínica odontológica", "https://clinicasol.test", "+55 21 3333-4444", "https://facebook.com/clinicasol", "clinicasol", "Acolhedor e direto", "Famílias de Niterói"]);
  assert.ok(m.logo_midia_id, "logo puxada do Instagram");
  assert.equal(p.env.DB.q("SELECT mime FROM plt_mk_midias WHERE id=?", m.logo_midia_id)[0].mime, "image/png");
  // Google: a logo já existe (não troca); horários vêm do perfil.
  const idaG = await p.req(`/api/orgs/1/mk/google/conectar?marca=${marca}`, { quem: "admin" });
  const stateG = new URL(idaG.r.headers.get("location")).searchParams.get("state");
  p.google = (url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return { access_token: "ya29.a", refresh_token: "1//permanente", expires_in: 3599 };
    if (url.includes("/v1/accounts?")) return { accounts: [{ name: "accounts/111" }] };
    if (url.includes("/accounts/111/locations?")) return { locations: [{ name: "locations/222", title: "Clínica Sol" }] };
    if (url.includes("/locations/222?readMask=")) return { title: "Clínica Sol", regularHours: { periods: [{ openDay: "MONDAY", openTime: { hours: 9 }, closeTime: { hours: 18 } }] }, metadata: { mapsUri: "https://maps.google.com/?cid=1" } };
    if (url.includes("/media?")) return { mediaItems: [{ googleUrl: "https://img.test/google.png", locationAssociation: { category: "LOGO" } }] };
    if (url.includes("/reviews?")) return { reviews: [] };
    return { error: { code: 404, message: "inesperado " + url } };
  };
  const nG = (await (await p.req(`/api/google/retorno?code=abc&state=${encodeURIComponent(stateG)}`)).r.text()).match(/\/app#\/marcas\/google-([A-Za-z0-9_-]+)/)[1];
  const escG = await p.req("/api/orgs/1/mk/google/escolher", { metodo: "POST", quem: "admin", corpo: { n: nG, local_id: "locations/222" } });
  assert.deepEqual(escG.dados.preenchidos, ["horarios"], JSON.stringify(escG.dados));
  m = p.env.DB.q("SELECT * FROM plt_mk_marcas WHERE id=?", marca)[0];
  assert.equal(m.horarios, "seg 09:00-18:00");
  assert.equal(p.env.DB.q("SELECT COUNT(*) n FROM plt_mk_midias")[0].n, 1, "a logo do Instagram fica");
});

test("Base de clientes: a DENIA cadastra sozinha quem conversou (nome, número, o que buscou e quando), sem profissionais", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://engine.test", token: TOKEN_ENGINE } });
  p.engine.agora = Date.now() - 60000;
  p.engine.llmCliente = () => ({ resposta: "Certo!", intencao: "NOVO_PEDIDO", quer_orcamento_ou_atendimento: true, pronto_para_profissional: false, fatos: { servico: "chaveiro", problema: "troca de fechadura", categoria: "CHAVEIRO", bairro: "Tijuca" }, categoria_confianca: "ALTA" });
  await p.engine.cliente("5521911112222", "Preciso trocar a fechadura", { nome: "Marta" });
  await p.engine.cliente("5521964545279", "Bom dia"); // profissional
  const r = await p.req("/api/orgs/1/engine/clients", { quem: "admin" });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const cs = r.dados.clientes;
  assert.equal(cs.length, 1, JSON.stringify(cs));
  assert.equal(cs[0].nome, "Marta"); assert.equal(cs[0].telefone, "5521911112222");
  assert.match(cs[0].ultimo_pedido, /^Chaveiro: troca de fechadura/);
  assert.equal(cs[0].pedidos, 1); assert.equal(cs[0].servicos_feitos, 0); assert.equal(cs[0].bairro, "Tijuca");
  assert.ok(cs[0].ultimo_pedido_ms && cs[0].primeiro_contato_ms);
});

test("Treinar IA: versões anteriores e Restaurar trazem de volta o treinamento apagado; jeito de falar vai para a IA", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  await p.req("/api/orgs/1/integracao", { metodo: "POST", quem: "admin", corpo: { engine_url: "https://engine.test", token: TOKEN_ENGINE } });
  const salvar = corpo => p.req("/api/orgs/1/engine/training", { metodo: "POST", quem: "admin", corpo });
  const v1 = await salvar({ treinamento: { servicos: "Chaveiro, eletricista e encanador.", jeito: "Personalidade: Acolhedora. Emojis: Nunca." } });
  assert.equal(v1.status, 200, JSON.stringify(v1.dados));
  assert.equal((await salvar({ treinamento: { servicos: "" } })).status, 409, "apagar pede confirmação");
  await salvar({ treinamento: { servicos: "" }, confirmar_vazio: true });
  const vs = (await p.req("/api/orgs/1/engine/training/versions", { quem: "admin" })).dados.versoes;
  const comConteudo = vs.find(v => v.campos.includes("servicos"));
  assert.ok(comConteudo, JSON.stringify(vs));
  const r = await p.req("/api/orgs/1/engine/training/restore", { metodo: "POST", quem: "admin", corpo: { versao: comConteudo.versao } });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const t = (await p.req("/api/orgs/1/engine/training", { quem: "admin" })).dados;
  assert.equal(t.dados.servicos, "Chaveiro, eletricista e encanador.");
  assert.match(t.autor, /restaurou a versão/);
  // O jeito de falar entra na instrução da IA.
  let entrada = "";
  p.engine.agora = Date.now() - 60000;
  p.engine.llmCliente = (e) => { entrada = e; return { resposta: "Oi!", intencao: "CONVERSA", fatos: {} }; };
  await p.engine.cliente("5521911113333", "Oi");
  assert.match(entrada, /JEITO DE FALAR[^\n]*:\nPersonalidade: Acolhedora\. Emojis: Nunca\./);
});

test("Conectar conta nova: vários perfis do Google de uma vez viram perfis, com o nome certo; palavra-chave tem a posição medida sozinha", async () => {
  const p = await criarPlataforma({ GOOGLE_CLIENT_ID: "cliente.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "segredo-google", GOOGLE_PLACES_API_KEY: "chave-places" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Central de Atendimento" } })).dados.id;
  const ida = await p.req(`/api/orgs/1/mk/google/conectar?marca=${marca}`, { quem: "admin" });
  const state = new URL(ida.r.headers.get("location")).searchParams.get("state");
  p.google = (url, metodo, corpo) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return { access_token: "ya29.a", refresh_token: "1//permanente", expires_in: 3599 };
    if (url.includes("/v1/accounts?")) return { accounts: [{ name: "accounts/111" }] };
    if (url.includes("/accounts/111/locations?")) return { locations: [{ name: "locations/1", title: "Reforma Tudo RT" }, { name: "locations/2", title: "Chaveiro Tijuca" }, { name: "locations/3", title: "Outro" }] };
    if (url.includes("/reviews?")) return { reviews: [] };
    if (url.startsWith("https://places.googleapis.com/")) return { places: [{ id: "a", displayName: { text: "Pedreiro Bom" } }, { id: "b", displayName: { text: "Reforma Tudo RT" } }] };
    return { error: { code: 404, message: "inesperado " + url } };
  };
  const nonce = (await (await p.req(`/api/google/retorno?code=abc&state=${encodeURIComponent(state)}`)).r.text()).match(/\/app#\/marcas\/google-([A-Za-z0-9_-]+)/)[1];
  const esc = await p.req("/api/orgs/1/mk/google/escolher", { metodo: "POST", quem: "admin", corpo: { n: nonce, local_ids: ["locations/1", "locations/2"], renomear: true } });
  assert.equal(esc.status, 200, JSON.stringify(esc.dados));
  assert.deepEqual(esc.dados.conectados.map(c => c.perfil), ["Reforma Tudo RT", "Chaveiro Tijuca"]);
  const nomes = p.env.DB.q("SELECT m.nome, g.local_titulo FROM plt_mk_marcas m JOIN plt_mk_google g ON g.marca_id=m.id ORDER BY m.id").map(x => `${x.nome}=${x.local_titulo}`);
  assert.deepEqual(nomes, ["Reforma Tudo RT=Reforma Tudo RT", "Chaveiro Tijuca=Chaveiro Tijuca"], "o perfil novo ganhou o nome do perfil do Google");
  // Palavra-chave: ao adicionar, já mede (2º lugar).
  const add = await p.req("/api/orgs/1/mk/palavras", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, palavra: "pedreiro", cidade: "Rio de Janeiro" } });
  assert.equal(add.dados.medicao.posicao, 2, JSON.stringify(add.dados));
  const busca = p.googleChamadas.filter(c => c.url.startsWith("https://places.googleapis.com/")).pop();
  assert.equal(busca.corpo.textQuery, "pedreiro Rio de Janeiro");
  const l = (await p.req(`/api/orgs/1/mk/palavras?marca=${marca}`, { quem: "admin" })).dados;
  assert.equal(l.medicao_automatica, true);
  assert.equal(l.palavras[0].posicoes[0].posicao, 2);
  // Fora dos 20 primeiros: 0.
  p.google = (url) => url.startsWith("https://places.googleapis.com/") ? { places: [{ id: "a", displayName: { text: "Outro" } }] } : url.startsWith("https://oauth2") ? { access_token: "x", expires_in: 3599 } : { error: { code: 404, message: "x" } };
  const med = await p.req(`/api/orgs/1/mk/palavras/${add.dados.id}/medir`, { metodo: "POST", quem: "admin", corpo: {} });
  assert.equal(med.dados.posicao, 0);
});

test("Equipe: sem e-mail configurado a tela avisa, e quem já tinha conta pode receber senha temporária", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const l = (await p.req("/api/orgs/1/membros", { quem: "admin" })).dados;
  assert.equal(l.email.ok, false); assert.match(l.email.motivo, /RESEND_API_KEY/);
  const a = (await p.req("/api/orgs/1/membros", { metodo: "POST", quem: "admin", corpo: { nome: "Teste", email: "teste.auditoria@exemplo.test", papel: "ADMIN" } })).dados;
  assert.ok(a.senha_temporaria, "conta nova: senha temporária na tela");
  assert.equal(a.ja_tinha_conta, false);
});

test("Google: editar o perfil pela DENIA (descrição, telefone, site, horários, feriados), regras do Google e visão geral de todos os perfis", async () => {
  const p = await criarPlataforma({ GOOGLE_CLIENT_ID: "cliente.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "segredo-google" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Reforma Tudo RT" } })).dados.id;
  const ida = await p.req(`/api/orgs/1/mk/google/conectar?marca=${marca}`, { quem: "admin" });
  const state = new URL(ida.r.headers.get("location")).searchParams.get("state");
  let patch = null;
  p.google = (url, metodo, corpo) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return { access_token: "ya29.a", refresh_token: "1//p", expires_in: 3599 };
    if (url.includes("/v1/accounts?")) return { accounts: [{ name: "accounts/111" }] };
    if (url.includes("/accounts/111/locations?")) return { locations: [{ name: "locations/1", title: "Reforma Tudo RT" }] };
    if (url.includes("/reviews?")) return { reviews: [{ reviewId: "r1", reviewer: { displayName: "Ana" }, starRating: "FIVE", comment: "Ótimo", createTime: "2026-10-20T10:00:00Z" }], totalReviewCount: 1, averageRating: 5 };
    if (metodo === "PATCH" && url.includes("/locations/1?updateMask=")) { patch = { url, corpo }; return { name: "locations/1" }; }
    if (url.includes("/locations/1?readMask=")) return { title: "Reforma Tudo RT", profile: { description: "Antiga" }, phoneNumbers: { primaryPhone: "(21) 3333-4444" }, metadata: { newReviewUri: "https://g.page/r/abc/review", mapsUri: "https://maps.google.com/?cid=1" }, regularHours: { periods: [] }, specialHours: { specialHourPeriods: [] } };
    return { error: { code: 404, message: "inesperado " + url } };
  };
  const nonce = (await (await p.req(`/api/google/retorno?code=abc&state=${encodeURIComponent(state)}`)).r.text()).match(/\/app#\/marcas\/google-([A-Za-z0-9_-]+)/)[1];
  await p.req("/api/orgs/1/mk/google/escolher", { metodo: "POST", quem: "admin", corpo: { n: nonce, local_id: "locations/1" } });
  const perfil = (await p.req(`/api/orgs/1/mk/google/perfil?marca=${marca}`, { quem: "admin" })).dados;
  assert.equal(perfil.perfil.avaliar, "https://g.page/r/abc/review", "link para pedir avaliação");
  assert.ok(perfil.proximos_feriados.length >= 1);
  const salvar = corpo => p.req("/api/orgs/1/mk/google/perfil", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, ...corpo } });
  assert.equal((await salvar({ descricao: "Veja www.site.com" })).status, 400, "sem link");
  assert.equal((await salvar({ descricao: "Ligue 21 99999-8888" })).status, 400, "sem telefone");
  assert.equal((await salvar({ descricao: "x".repeat(751) })).status, 400, "até 750");
  const ok = await salvar({ descricao: "Reformas e reparos na Tijuca.", horarios: [{ dia: "MONDAY", abre: "08:00", fecha: "18:00" }], feriados: [{ data: "2026-11-02", fechado: true }, { data: "2026-11-15", abre: "09:00", fecha: "13:00" }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.dados));
  assert.match(decodeURIComponent(patch.url), /updateMask=profile\.description,regularHours,specialHours/);
  assert.equal(patch.corpo.profile.description, "Reformas e reparos na Tijuca.");
  assert.deepEqual(patch.corpo.regularHours.periods[0], { openDay: "MONDAY", openTime: { hours: 8, minutes: 0 }, closeDay: "MONDAY", closeTime: { hours: 18, minutes: 0 } });
  assert.deepEqual(patch.corpo.specialHours.specialHourPeriods[0], { startDate: { year: 2026, month: 11, day: 2 }, closed: true });
  const v = (await p.req("/api/orgs/1/mk/google/visao", { quem: "admin" })).dados.perfis;
  assert.equal(v.length, 1); assert.equal(v[0].sem_resposta, 1, "a avaliação da Ana está sem resposta");
});

test("Google: serviços e fotos pelo perfil (foto vai por link assinado; serviços do catálogo são mantidos)", async () => {
  const p = await criarPlataforma({ GOOGLE_CLIENT_ID: "cliente.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "segredo-google" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Reforma Tudo RT" } })).dados.id;
  const ida = await p.req(`/api/orgs/1/mk/google/conectar?marca=${marca}`, { quem: "admin" });
  const state = new URL(ida.r.headers.get("location")).searchParams.get("state");
  let patch = null, foto = null;
  p.google = (url, metodo, corpo) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return { access_token: "ya29.a", refresh_token: "1//p", expires_in: 3599 };
    if (url.includes("/v1/accounts?")) return { accounts: [{ name: "accounts/111" }] };
    if (url.includes("/accounts/111/locations?")) return { locations: [{ name: "locations/1", title: "Reforma Tudo RT" }] };
    if (url.includes("/reviews?")) return { reviews: [] };
    if (metodo === "POST" && url.endsWith("/accounts/111/locations/1/media")) { foto = corpo; return { name: "accounts/111/locations/1/media/9" }; }
    if (metodo === "PATCH") { patch = corpo; return {}; }
    if (url.includes("readMask=categories,serviceItems")) return { categories: { primaryCategory: { name: "categories/gcid:contractor" } }, serviceItems: [{ structuredServiceItem: { serviceTypeId: "job_type_id:pintura" } }, { freeFormServiceItem: { label: { displayName: "Velho" } } }] };
    return { error: { code: 404, message: "inesperado " + url } };
  };
  const nonce = (await (await p.req(`/api/google/retorno?code=abc&state=${encodeURIComponent(state)}`)).r.text()).match(/\/app#\/marcas\/google-([A-Za-z0-9_-]+)/)[1];
  await p.req("/api/orgs/1/mk/google/escolher", { metodo: "POST", quem: "admin", corpo: { n: nonce, local_id: "locations/1" } });
  const s = await p.req("/api/orgs/1/mk/google/perfil", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, servicos: [{ nome: "Troca de piso", descricao: "Porcelanato e vinílico" }] } });
  assert.equal(s.status, 200, JSON.stringify(s.dados));
  assert.deepEqual(patch.serviceItems, [{ structuredServiceItem: { serviceTypeId: "job_type_id:pintura" } }, { freeFormServiceItem: { category: "categories/gcid:contractor", label: { displayName: "Troca de piso", description: "Porcelanato e vinílico", languageCode: "pt-BR" } } }]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20000, 7)]).toString("base64");
  const f = await p.req("/api/orgs/1/mk/google/foto", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, categoria: "EXTERIOR", dados: jpg } });
  assert.equal(f.status, 200, JSON.stringify(f.dados));
  assert.equal(foto.locationAssociation.category, "EXTERIOR");
  assert.match(foto.sourceUrl, /^https:\/\/plataforma\.test\/m\/\d+-[\w-]{32}\/[a-z0-9-]+\.jpg$/, "o endereço termina com o nome pensado para busca");
  const pub = await p.req(new URL(foto.sourceUrl).pathname);
  assert.equal(pub.status, 200, "o Google consegue baixar a foto pelo link assinado");
  assert.equal((await p.req("/api/orgs/1/mk/google/foto", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, dados: "aGVsbG8=" } })).status, 400, "só JPG/PNG");
});

test("Instagram: 'O que funciona' e checagem do perfil calculados com os números reais das publicações", async () => {
  const p = await criarPlataforma({ META_APP_ID: "123456", META_APP_SECRET: "segredo-do-app" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Reforma Tudo RT", cidade: "Rio de Janeiro" } })).dados.id;
  const ida = await p.req(`/api/orgs/1/mk/meta/conectar?marca=${marca}`, { quem: "admin" });
  const state = new URL(ida.r.headers.get("location")).searchParams.get("state");
  const agora = Date.now(), dia = 86400000;
  // 8 posts: 4 reels com alcance alto, 4 fotos com alcance baixo; #reforma só nos reels.
  const posts = Array.from({ length: 8 }, (_, i) => ({ id: "M" + i, caption: i % 2 ? "Antes e depois #reforma #rj" : "Foto do dia #rj", media_type: i % 2 ? "VIDEO" : "IMAGE", media_product_type: i % 2 ? "REELS" : "FEED", timestamp: new Date(agora - (i + 1) * 2 * dia).toISOString(), like_count: 10, comments_count: 1, permalink: "https://instagram.com/p/" + i }));
  p.meta = (url) => {
    if (url.includes("oauth/access_token")) return { access_token: "longo" };
    if (url.includes("me/accounts")) return { data: [{ id: "PAG1", name: "Reforma Tudo RT", access_token: "tok", instagram_business_account: { id: "IG1", username: "reformatudort" } }] };
    if (/\/IG1\/media\?/.test(url) && url.includes("comments.limit")) return { data: [{ id: "M1", caption: "x", comments: { data: [{ id: "c1", text: "Quanto custa?", username: "ana", timestamp: new Date().toISOString(), replies: { data: [] } }] } }] };
    if (/\/IG1\/media\?/.test(url)) return { data: posts };
    const mi = url.match(/\/(M\d)\/insights/);
    if (mi) { const n = Number(mi[1].slice(1)); return { data: [{ name: "reach", values: [{ value: n % 2 ? 1000 : 300 }] }, { name: "total_interactions", values: [{ value: n % 2 ? 60 : 9 }] }] }; }
    if (/\/IG1\?/.test(url)) return { id: "IG1", username: "reformatudort", biography: "Reformas e reparos. Peça seu orçamento pelo WhatsApp", website: "https://wa.me/5521999999999", followers_count: 900, profile_picture_url: "https://x/y.jpg" };
    return { data: [] };
  };
  const nonce = (await (await p.req(`/api/meta/retorno?code=abc&state=${encodeURIComponent(state)}`)).r.text()).match(/\/app#\/marcas\/meta-([A-Za-z0-9_-]+)/)[1];
  await p.req("/api/orgs/1/mk/meta/escolher", { metodo: "POST", quem: "admin", corpo: { n: nonce, pagina_id: "PAG1" } });
  const r = await p.req(`/api/orgs/1/mk/social/analise?marca=${marca}&canal=instagram`, { quem: "admin" });
  assert.equal(r.status, 200, JSON.stringify(r.dados).slice(0, 400));
  const a = r.dados.analise, c = r.dados.checagem;
  assert.equal(a.medida, "alcance");
  assert.equal(a.formatos[0].nome, "REELS"); assert.equal(a.formatos[0].media, 1000);
  assert.ok(a.dicas.some(t => /Reels alcançam 3,3x mais que fotos/.test(t)), a.dicas.join(" | "));
  assert.equal(a.hashtags[0].hashtag, "#reforma"); assert.ok(a.hashtags[0].vs_geral > 0);
  const item = k => c.itens.find(i => i.chave === k);
  assert.equal(item("onde").ok, "falta", "a bio não cita o Rio de Janeiro");
  assert.equal(item("chamada").ok, "ok");
  assert.equal(item("video").ok, "ok", "metade são reels");
  assert.equal(item("respostas").ok, "falta", "o comentário da Ana está sem resposta");
  // Segunda leitura vem do cache (não gasta a cota da Meta).
  const antes = (p.metaChamadas || []).length;
  const r2 = await p.req(`/api/orgs/1/mk/social/analise?marca=${marca}&canal=instagram`, { quem: "admin" });
  assert.equal(r2.dados.do_cache, true); assert.equal((p.metaChamadas || []).length, antes);
});

test("Relatório geral de marketing: Google de todos os perfis no período, com planilha", async () => {
  const p = await criarPlataforma({ GOOGLE_CLIENT_ID: "cliente.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "segredo-google" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Reforma Tudo RT" } })).dados.id;
  await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Sem contas" } });
  const ida = await p.req(`/api/orgs/1/mk/google/conectar?marca=${marca}`, { quem: "admin" });
  const state = new URL(ida.r.headers.get("location")).searchParams.get("state");
  p.google = (url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return { access_token: "ya29.a", refresh_token: "1//p", expires_in: 3599 };
    if (url.includes("/v1/accounts?")) return { accounts: [{ name: "accounts/111" }] };
    if (url.includes("/accounts/111/locations?")) return { locations: [{ name: "locations/1", title: "Reforma Tudo RT" }] };
    if (url.includes("/reviews?")) return { reviews: [{ reviewId: "r1", reviewer: { displayName: "Ana" }, starRating: "FIVE", comment: "Ótimo", createTime: new Date().toISOString() }], totalReviewCount: 1, averageRating: 5 };
    if (url.includes(":fetchMultiDailyMetricsTimeSeries")) return { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
      { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ value: "3" }, { value: "2" }] } }, { dailyMetric: "BUSINESS_DIRECTION_REQUESTS", timeSeries: { datedValues: [{ value: "4" }] } },
      { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_MAPS", timeSeries: { datedValues: [{ value: "40" }] } }, { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", timeSeries: { datedValues: [{ value: "10" }] } }] }] };
    return { error: { code: 404, message: "inesperado " + url } };
  };
  const nonce = (await (await p.req(`/api/google/retorno?code=abc&state=${encodeURIComponent(state)}`)).r.text()).match(/\/app#\/marcas\/google-([A-Za-z0-9_-]+)/)[1];
  await p.req("/api/orgs/1/mk/google/escolher", { metodo: "POST", quem: "admin", corpo: { n: nonce, local_id: "locations/1" } });
  const r = (await p.req("/api/orgs/1/mk/relatorio-marketing?dias=30", { quem: "admin" })).dados;
  const rt = r.perfis.find(x => x.nome === "Reforma Tudo RT"), sem = r.perfis.find(x => x.nome === "Sem contas");
  assert.equal(rt.google.totais.ligacoes, 5); assert.equal(rt.google.totais.rotas, 4); assert.equal(rt.google.totais.visualizacoes, 50);
  assert.equal(rt.google.avaliacoes_novas, 1); assert.equal(rt.google.sem_resposta, 1);
  assert.equal(sem.google, null); assert.equal(sem.instagram, null);
  const x = (await p.req("/api/orgs/1/mk/relatorio-marketing?dias=30&formato=xlsx", { quem: "admin" })).dados;
  const z = Buffer.from(x.base64, "base64").toString("utf8");
  for (const aba of ["Resumo", "Google", "Instagram", "Facebook"]) assert.match(z, new RegExp(`name="${aba}"`));
  assert.match(z, /Reforma Tudo RT/);
});

test("Endereço antigo (ícone salvo antes da mudança, www, workers.dev): as páginas vão para o endereço oficial; API e webhooks não", async () => {
  const p = await criarPlataforma({ SITE_URL: "https://denia-ai.test" });
  const app = await p.req("/app?origem=app");
  assert.equal(app.status, 301); assert.equal(app.r.headers.get("location"), "https://denia-ai.test/app?origem=app");
  assert.equal((await p.req("/entrar")).r.headers.get("location"), "https://denia-ai.test/entrar");
  assert.notEqual((await p.req("/api/eu")).status, 301, "a API continua respondendo");
  assert.notEqual((await p.req("/webhook/whatsapp?hub.mode=subscribe")).status, 301, "o webhook continua respondendo");
});

test("Avaliação ruim no Google (3★ ou menos) que chegou agora: avisa a equipe uma vez; antigas não avisam", async () => {
  const p = await criarPlataforma({ RESEND_API_KEY: "re_teste", EMAIL_REMETENTE: "DENIA <nao-responda@denia.test>" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Reforma Tudo RT" } })).dados.id;
  await p.req("/api/orgs/1/mk/avaliacoes?marca=" + marca, { quem: "admin" }); // cria as colunas
  const hoje = new Date().toISOString().slice(0, 10);
  const ins = (gid, nota, data) => p.env.DB.prepare("INSERT INTO plt_mk_avaliacoes(org_id,marca_id,autor,nota,texto,data,status,criado_ms,google_id) VALUES(1,?,?,?,?,?,'PENDENTE',?,?)").bind(marca, "Cliente " + gid, nota, "Demorou muito", data, Date.now(), gid).run();
  await ins("g1", 2, hoje); await ins("g2", 5, hoje); await ins("g3", 1, "2024-01-10");
  const mod = await import(new URL("../src/worker.js?t=aval" + Math.random(), import.meta.url).href);
  const rodar = async () => { await mod.default.scheduled({}, p.env, { waitUntil: pr => pr }); await new Promise(r => setTimeout(r, 50)); };
  await rodar();
  const avisos = () => p.emails.filter(e => /avaliação \d★ no Google/.test(e.subject));
  assert.equal(avisos().length, 1, JSON.stringify(p.emails.map(e => e.subject)));
  assert.match(avisos()[0].subject, /avaliação 2★ no Google \(Reforma Tudo RT\)/);
  assert.match(avisos()[0].text, /Demorou muito/);
  await rodar();
  assert.equal(avisos().length, 1, "não avisa duas vezes");
});

test("Rotina do especialista: situação real de cada perfil (avaliações sem resposta, posts, posições)", async () => {
  const p = await criarPlataforma();
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Reforma Tudo RT" } })).dados.id;
  await p.req("/api/orgs/1/mk/google/estado", { quem: "admin" });
  await p.req("/api/orgs/1/mk/avaliacoes?marca=" + marca, { quem: "admin" });
  p.env.DB.prepare("INSERT INTO plt_mk_google(org_id,marca_id,conta_nome,local_nome,local_titulo,token_cifrado,criado_ms,atualizado_ms) VALUES(1,?,'accounts/1','locations/1','Reforma Tudo RT','x',?,?)").bind(marca, Date.now(), Date.now()).run();
  p.env.DB.prepare("INSERT INTO plt_mk_avaliacoes(org_id,marca_id,autor,nota,texto,status,criado_ms,google_id) VALUES(1,?,'Ana',2,'Ruim','PENDENTE',?,'g1')").bind(marca, Date.now()).run();
  const r = (await p.req("/api/orgs/1/mk/rotina", { quem: "admin" })).dados;
  const rt = r.perfis.find(x => x.nome === "Reforma Tudo RT");
  assert.equal(rt.google, true); assert.equal(rt.g.sem_resposta, 1); assert.equal(rt.g.ruins_sem_resposta, 1); assert.equal(rt.g.posts_7d, 0);
  assert.equal(rt.instagram, false); assert.equal(r.modo_avaliacoes, "DESLIGADO");
});

test("Google: pré-análise de qualquer empresa, mapa de posição em grade e situação do perfil (suspensão e mudanças do Google)", async () => {
  const p = await criarPlataforma({ GOOGLE_CLIENT_ID: "cliente.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "segredo-google", GOOGLE_PLACES_API_KEY: "chave-places" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Reforma Tudo RT" } })).dados.id;
  const ida = await p.req(`/api/orgs/1/mk/google/conectar?marca=${marca}`, { quem: "admin" });
  const state = new URL(ida.r.headers.get("location")).searchParams.get("state");
  let buscasGrade = 0;
  p.google = (url, metodo, corpo) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return { access_token: "ya29.a", refresh_token: "1//p", expires_in: 3599 };
    if (url.includes("/v1/accounts?")) return { accounts: [{ name: "accounts/111" }] };
    if (url.includes("/accounts/111/locations?")) return { locations: [{ name: "locations/1", title: "Reforma Tudo RT" }] };
    if (url.includes("/reviews?")) return { reviews: [] };
    if (url.includes("readMask=latlng")) return { title: "Reforma Tudo RT", latlng: { latitude: -22.92, longitude: -43.23 }, metadata: { placeId: "PLACE_RT" } };
    if (url.includes(":getGoogleUpdated")) return { location: { phoneNumbers: { primaryPhone: "(21) 0000-0000" } }, diffMask: "phoneNumbers" };
    if (url.includes("VoiceOfMerchantState")) return { hasVoiceOfMerchant: false, complyWithGuidelines: { recommendationReason: "BUSINESS_LOCATION_SUSPENDED" } };
    if (url.includes("/locations/1?readMask=")) return { title: "Reforma Tudo RT", phoneNumbers: { primaryPhone: "(21) 3333-4444" }, metadata: {} };
    if (url.startsWith("https://places.googleapis.com/v1/places:searchText")) {
      if (corpo.locationBias && corpo.textQuery === "pedreiro") { buscasGrade++; return { places: buscasGrade % 2 ? [{ id: "PLACE_RT", displayName: { text: "Reforma Tudo RT" } }] : [{ id: "X", displayName: { text: "Outro" } }, { id: "Y" }, { id: "PLACE_RT" }] }; }
      if (corpo.locationBias) return { places: [{ id: "C1", displayName: { text: "Concorrente 1" }, rating: 4.9, userRatingCount: 300, types: ["general_contractor", "roofing_contractor"], primaryTypeDisplayName: { text: "Empreiteiro" } }, { id: "PLACE_RT" }, { id: "C2", displayName: { text: "Concorrente 2" }, rating: 4.6, userRatingCount: 100, types: ["general_contractor"] }] };
      return { places: [{ id: "PLACE_RT", displayName: { text: "Reforma Tudo RT" }, formattedAddress: "Tijuca, Rio de Janeiro", rating: 4.8, userRatingCount: 40 }] };
    }
    if (url.includes("/searchkeywords/impressions/monthly")) return { searchKeywordsCounts: [{ searchKeyword: "pedreiro tijuca", insightsValue: { value: "120" } }, { searchKeyword: "reforma apartamento", insightsValue: { threshold: "15" } }] };
    if (url.includes(":fetchMultiDailyMetricsTimeSeries")) return { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "300" }] } }, { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_MAPS", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "100" }] } }, { dailyMetric: "BUSINESS_DIRECTION_REQUESTS", timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 1 }, value: "7" }] } }] }] };
    if (url.startsWith("https://places.googleapis.com/v1/places/PLACE_RT")) return { id: "PLACE_RT", displayName: { text: "Reforma Tudo RT" }, rating: 4.8, userRatingCount: 40, primaryTypeDisplayName: { text: "Empreiteiro" }, types: ["general_contractor"], location: { latitude: -22.92, longitude: -43.23 }, businessStatus: "OPERATIONAL", photos: [1, 2, 3], addressComponents: [{ longText: "Rio de Janeiro", types: ["administrative_area_level_2"] }] };
    return { error: { code: 404, message: "inesperado " + url } };
  };
  const nonce = (await (await p.req(`/api/google/retorno?code=abc&state=${encodeURIComponent(state)}`)).r.text()).match(/\/app#\/marcas\/google-([A-Za-z0-9_-]+)/)[1];
  await p.req("/api/orgs/1/mk/google/escolher", { metodo: "POST", quem: "admin", corpo: { n: nonce, local_id: "locations/1" } });
  // Pré-análise
  const op = (await p.req("/api/orgs/1/mk/google/pre-analise", { metodo: "POST", quem: "admin", corpo: { busca: "Reforma Tudo RT Rio" } })).dados;
  assert.equal(op.opcoes[0].id, "PLACE_RT");
  const pa = (await p.req("/api/orgs/1/mk/google/pre-analise", { metodo: "POST", quem: "admin", corpo: { place_id: "PLACE_RT" } })).dados;
  assert.equal(pa.posicao_na_categoria, 2, JSON.stringify(pa).slice(0, 300));
  assert.equal(pa.concorrentes.length, 2);
  assert.deepEqual(pa.categorias, [{ nome: "Empreiteiro", concorrentes: 1, voce: true }]);
  assert.equal(pa.analise.itens.find(i => i.chave === "telefone").ok, "falta");
  assert.equal(pa.analise.itens.find(i => i.chave === "descricao").ok, "conferir", "o que a busca pública não mostra fica fora da nota");
  // Mapa em grade 3x3
  const g = (await p.req("/api/orgs/1/mk/google/geogrid", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, palavra: "pedreiro", raio_km: 2, tamanho: 3 } })).dados;
  assert.equal(g.dados.pontos.length, 9); assert.equal(buscasGrade, 9);
  assert.ok(g.dados.pontos.every(x => [1, 3].includes(x.posicao)));
  assert.equal((await p.req(`/api/orgs/1/mk/google/geogrid?marca=${marca}`, { quem: "admin" })).dados.grades.length, 1);
  // Buscas no Google: o que digitaram, quantas vezes, posição acompanhada, por onde viram e alcance no mapa
  await p.req("/api/orgs/1/mk/palavras", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, palavra: "Pedreiro Tijuca" } });
  const bu = await p.req(`/api/orgs/1/mk/google/buscas?marca=${marca}&meses=3`, { quem: "admin" });
  assert.equal(bu.status, 200, JSON.stringify(bu.dados));
  assert.equal(bu.dados.palavras[0].palavra, "pedreiro tijuca"); assert.equal(bu.dados.palavras[0].buscas, 120);
  assert.ok(bu.dados.palavras[0].palavra_id, "liga a busca do Google com a palavra acompanhada, sem diferenciar maiúsculas");
  assert.equal(bu.dados.palavras[1].menos_de, 15);
  assert.equal(bu.dados.onde.pesquisa_celular, 300); assert.equal(bu.dados.onde.rotas, 7);
  assert.equal(bu.dados.alcance[0].palavra, "pedreiro"); assert.ok(bu.dados.alcance[0].top3_km > 0, "mede até quantos km o perfil fica no top 3");
  // Situação
  const s = (await p.req(`/api/orgs/1/mk/google/situacao?marca=${marca}`, { quem: "admin" })).dados;
  assert.equal(s.situacao, "suspenso");
  assert.deepEqual(s.mudancas_do_google, [{ campo: "telefone", no_google: "(21) 0000-0000", no_perfil: "(21) 3333-4444" }]);
});

test("Google: relatório em PDF para o cliente, envio automático (dia 1) e proposta comercial em PDF", async () => {
  const p = await criarPlataforma({ GOOGLE_CLIENT_ID: "cliente.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "segredo-google", RESEND_API_KEY: "re_teste", EMAIL_REMETENTE: "DENIA <nao-responda@denia.test>" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const marca = (await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Reforma Tudo RT" } })).dados.id;
  const ida = await p.req(`/api/orgs/1/mk/google/conectar?marca=${marca}`, { quem: "admin" });
  const state = new URL(ida.r.headers.get("location")).searchParams.get("state");
  p.google = (url) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return { access_token: "ya29.a", refresh_token: "1//p", expires_in: 3599 };
    if (url.includes("/v1/accounts?")) return { accounts: [{ name: "accounts/111" }] };
    if (url.includes("/accounts/111/locations?")) return { locations: [{ name: "locations/1", title: "Reforma Tudo RT" }] };
    if (url.includes("/reviews?")) return { reviews: [] };
    if (url.includes(":fetchMultiDailyMetricsTimeSeries")) return { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ value: "7" }] } }, { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_MAPS", timeSeries: { datedValues: [{ value: "90" }] } }] }] };
    return { error: { code: 404, message: "inesperado " + url } };
  };
  const nonce = (await (await p.req(`/api/google/retorno?code=abc&state=${encodeURIComponent(state)}`)).r.text()).match(/\/app#\/marcas\/google-([A-Za-z0-9_-]+)/)[1];
  await p.req("/api/orgs/1/mk/google/escolher", { metodo: "POST", quem: "admin", corpo: { n: nonce, local_id: "locations/1" } });
  const pdf = (await p.req(`/api/orgs/1/mk/google/relatorio-pdf?marca=${marca}&dias=30`, { quem: "admin" })).dados;
  assert.ok(pdf.base64, JSON.stringify(pdf)); const b = Buffer.from(pdf.base64, "base64");
  assert.equal(b.subarray(0, 5).toString(), "%PDF-"); assert.match(pdf.nome, /^relatorio-google-reforma-tudo-rt-/);
  assert.match(b.toString("latin1"), /Relat\xf3rio do Google/);
  // Envio automático
  assert.equal((await p.req("/api/orgs/1/mk/google/relatorio-envio", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, ativo: true, frequencia: "mensal", emails: "errado" } })).status, 400);
  await p.req("/api/orgs/1/mk/google/relatorio-envio", { metodo: "POST", quem: "admin", corpo: { marca_id: marca, ativo: true, frequencia: "mensal", emails: "cliente@empresa.test" } });
  const mod = await import(new URL("../src/worker.js?t=relpdf" + Math.random(), import.meta.url).href);
  const rodar = async () => { await mod.default.scheduled({}, p.env, { waitUntil: pr => pr }); await new Promise(r => setTimeout(r, 50)); };
  const doCliente = () => p.emails.filter(e => e.to[0] === "cliente@empresa.test");
  p.env.__agora = () => Date.parse("2026-11-02T12:00:00Z"); await rodar();
  assert.equal(doCliente().length, 0, "dia 2: não é dia de mandar");
  p.env.__agora = () => Date.parse("2026-12-01T12:00:00Z"); await rodar(); await rodar();
  assert.equal(doCliente().length, 1, "dia 1: manda uma vez");
  assert.match(doCliente()[0].attachments[0].filename, /\.pdf$/);
  // Proposta
  delete p.env.__agora;
  const pr = (await p.req("/api/orgs/1/mk/google/proposta", { metodo: "POST", quem: "admin", corpo: { empresa: { nome: "Chaveiro Tijuca", nota: 4.5, avaliacoes: 20 }, analise: { nota: 61, itens: [{ titulo: "Fotos", detalhe: "3 foto(s)", dica: "Mande mais fotos.", ok: "parcial" }] }, concorrentes: [{ posicao: 1, nome: "Chaves Já", nota: 4.9, avaliacoes: 300 }], posicao: 4, busca: "Chaveiro Rio de Janeiro", valor: "R$ 890 por mês" } })).dados;
  assert.ok(pr.base64, JSON.stringify(pr)); const bp = Buffer.from(pr.base64, "base64").toString("latin1");
  assert.match(bp, /^%PDF-/); assert.match(bp, /R\$ 890 por m\xeas/); assert.match(bp, /Chaves J\xe1/);
});

test("Postar as minhas fotos — a IA olha a foto, escreve o post com o WhatsApp e ele vai para aprovação; no Google o telefone sai", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const m = await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "Limpeza Zona Sul", whatsapp: "11 98765-4321", cidade: "Zona Sul de SP" } });
  let pedido = null;
  p.openai = (url, corpo) => { pedido = corpo; return { output: [{ content: [{ type: "output_text", text: JSON.stringify({ titulo: "Tapete como novo", legenda: "Seu tapete merece!\n\n📱 WhatsApp: 11 98765-4321", hashtags: "#tapete", chamada: "Peça já", descricao_foto: "Tapete persa limpo estendido no chão" }) }] }] }; };
  const jpeg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString("base64");
  const r = await p.req("/api/orgs/1/mk/ia/post-foto", { metodo: "POST", quem: "admin", corpo: { marca_id: m.dados.id, foto: jpeg, pedido: "lavagem de tapete persa", canais: ["instagram", "facebook"], data: "2026-11-02", hora: "18:00" } });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const conteudo = pedido.input[0].content;
  assert.equal(conteudo[1].type, "input_image", "a IA recebe a foto");
  assert.match(conteudo[0].text, /98765-4321/, "a IA recebe o WhatsApp da marca");
  assert.match(conteudo[0].text, /lavagem de tapete persa/);
  assert.equal(r.dados.status, "AGUARDANDO");
  assert.ok(r.dados.post.midia_id, "a própria foto vira a imagem do post");
  const foto = await p.req(`/api/orgs/1/mk/midias/${r.dados.post.midia_id}`, { quem: "admin" });
  assert.equal(foto.status, 200);
  const sem = await p.req("/api/orgs/1/mk/ia/post-foto", { metodo: "POST", quem: "admin", corpo: { marca_id: m.dados.id, foto: "data:text/plain;base64,aGVsbG8=" } });
  assert.equal(sem.status, 400, "só aceita imagem");
  await p.req("/api/orgs/1/mk/ia/post-foto", { metodo: "POST", quem: "admin", corpo: { marca_id: m.dados.id, foto: jpeg, canais: ["google"] } });
  assert.match(pedido.instructions, /NÃO coloque telefone/, "no Google a IA não põe telefone");
  const { semTelefone } = await import("../src/google.js");
  assert.equal(semTelefone("Seu tapete merece!\n\n📱 WhatsApp: 11 98765-4321\nZona Sul."), "Seu tapete merece!\n\nZona Sul.");
});

test("Fotos e mídias — nome pensado para o Google, texto na foto opcional e controle de quem subiu cada foto", async () => {
  const p = await criarPlataforma({ OPENAI_API_KEY: "sk-teste" });
  await p.entrar("admin", ADMIN, SENHA_ADMIN);
  const m = await p.req("/api/orgs/1/mk/marcas", { metodo: "POST", quem: "admin", corpo: { nome: "TV Rio", cidade: "Botafogo, Rio de Janeiro" } });
  let instr = "";
  p.openai = (url, corpo) => { instr = corpo.instructions; return { output: [{ content: [{ type: "output_text", text: JSON.stringify({ titulo: "TV nova de novo", legenda: "l", hashtags: "", chamada: "", texto_arte: "Conserto no mesmo dia", nome_arquivo: "Conserto TV Samsung Botafogo", descricao_foto: "Técnico consertando TV Samsung em Botafogo" }) }] }] }; };
  const jpeg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString("base64");
  const a = (await p.req("/api/orgs/1/mk/ia/post-foto", { metodo: "POST", quem: "admin", corpo: { marca_id: m.dados.id, foto: jpeg, texto_na_foto: "sim" } })).dados;
  assert.equal(a.nome_arquivo, "conserto-tv-samsung-botafogo");
  assert.equal(a.texto_arte, "Conserto no mesmo dia");
  assert.match(instr, /OBRIGATÓRIO/);
  const b = (await p.req("/api/orgs/1/mk/ia/post-foto", { metodo: "POST", quem: "admin", corpo: { marca_id: m.dados.id, foto: jpeg, texto_na_foto: "nao" } })).dados;
  assert.equal(b.nome_arquivo, "conserto-tv-samsung-botafogo-2", "nome repetido ganha número");
  assert.equal(b.texto_arte, "", "sem texto quando a pessoa pede foto limpa");
  // Foto com texto montada no navegador e volta para a original
  const t = (await p.req(`/api/orgs/1/mk/posts/${a.id}/foto`, { metodo: "POST", quem: "admin", corpo: { dados: jpeg, texto_arte: "Conserto no mesmo dia" } })).dados;
  assert.notEqual(t.midia_id, a.post.midia_id);
  let lib = (await p.req(`/api/orgs/1/mk/midias?marca=${m.dados.id}`, { quem: "admin" })).dados.midias;
  assert.equal(lib.length, 2, "a original fica guardada, mas não repete na lista");
  const comTexto = lib.find(x => x.id === t.midia_id);
  assert.equal(comTexto.com_texto, true); assert.equal(comTexto.nome_arquivo, "conserto-tv-samsung-botafogo");
  assert.ok(comTexto.enviado_por); assert.equal(comTexto.origem, "foto"); assert.equal(comTexto.posts[0].id, a.id);
  const volta = (await p.req(`/api/orgs/1/mk/posts/${a.id}/foto`, { metodo: "POST", quem: "admin", corpo: { original: true } })).dados;
  assert.equal(volta.midia_id, a.post.midia_id);
  // Baixar com o nome e renomear
  const baixa = await p.req(`/api/orgs/1/mk/midias/${a.post.midia_id}?baixar=1`, { quem: "admin" });
  assert.match(baixa.r.headers.get("content-disposition"), /conserto-tv-samsung-botafogo\.jpg/);
  await p.req(`/api/orgs/1/mk/midias/${a.post.midia_id}`, { metodo: "POST", quem: "admin", corpo: { nome_arquivo: "Conserto de TV — Botafogo", descricao: "nova" } });
  lib = (await p.req(`/api/orgs/1/mk/midias?origem=foto`, { quem: "admin" })).dados.midias;
  assert.ok(lib.some(x => x.nome_arquivo === "conserto-de-tv-botafogo" && x.descricao === "nova"));
});
