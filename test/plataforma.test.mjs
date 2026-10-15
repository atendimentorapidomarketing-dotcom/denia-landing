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
    if (p && p.google && /^https:\/\/(oauth2|mybusiness[a-z]*|businessprofileperformance)\.googleapis\.com\//.test(String(url))) {
      const corpo = op.body ? (typeof op.body === "string" ? JSON.parse(op.body) : Object.fromEntries(new URLSearchParams(String(op.body)))) : null;
      (p.googleChamadas ||= []).push({ url: String(url), metodo: op.method || "GET", corpo });
      const r = p.google(String(url), op.method || "GET", corpo);
      return new Response(JSON.stringify(r), { status: r && r.error ? (r.error.code || 400) : 200, headers: { "content-type": "application/json" } });
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
  assert.deepEqual(sessao.tools.map(t => t.name), ["criar_semana", "criar_post", "aprovar_posts", "publicar_post", "treinar", "pausar_ia", "google_resumo", "atualizar_google", "responder_avaliacoes", "relatorio_google", "pesquisar_web", "dados_do_painel"]);
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
  await mod.default.scheduled({}, p.env, { waitUntil: (pr) => pr });
  assert.equal(p.emails.filter(e => /não está entregando/.test(e.subject)).length, 0);
  // A Meta avisou falha de pagamento: o motor marca o bloqueio.
  await p.engine.env.DB.prepare("CREATE TABLE IF NOT EXISTS d30_meta (chave TEXT PRIMARY KEY, valor TEXT)").run();
  await p.engine.env.DB.prepare("INSERT OR REPLACE INTO d30_meta(chave,valor) VALUES('entrega_bloqueada',?)").bind(JSON.stringify({ codigo: 131042, erro: "Problema de pagamento na conta do WhatsApp Business", em: Date.now() })).run();
  const st = (await p.req("/api/orgs/1/engine/status", { quem: "admin" })).dados;
  assert.equal(st.entrega_bloqueada.codigo, 131042);
  await mod.default.scheduled({}, p.env, { waitUntil: (pr) => pr });
  const avisos = p.emails.filter(e => /não está entregando/.test(e.subject));
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].text, /pagamento/);
  await mod.default.scheduled({}, p.env, { waitUntil: (pr) => pr });
  assert.equal(p.emails.filter(e => /não está entregando/.test(e.subject)).length, 1, "não repete o mesmo aviso em menos de 6 h");
});
