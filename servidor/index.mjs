// DENIA fora da Cloudflare: um servidor Node.js que roda a plataforma (src/worker.js) e a IA
// do WhatsApp (engine/worker.js) no mesmo processo, com banco SQLite em arquivo.
// Feito para a hospedagem Node.js da Hostinger (planos Business/Cloud), mas roda em qualquer lugar.
//
//   npm start                → sobe o servidor (porta em PORT, padrão 3000)
//   DENIA_DADOS=/caminho     → pasta do banco (padrão: ~/denia-dados, fora da pasta do app)
//
// Rotas próprias do servidor (protegidas por DENIA_CHAVE_SERVIDOR):
//   /__denia/tique?chave=…     roda as tarefas automáticas (para o "Cron Job" do painel)
//   /__denia/estado?chave=…    situação do servidor e da importação
//   /__denia/importar?chave=…&confirmar=sim  copia de novo os dados da Cloudflare (substitui os daqui)
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdirSync, existsSync, statSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { timingSafeEqual, createHash, randomBytes } from "node:crypto";

const [maior, menor] = process.versions.node.split(".").map(Number);
if (maior < 22 || (maior === 22 && menor < 5)) {
  console.error(`DENIA precisa do Node.js 22.5 ou mais novo (este é ${process.versions.node}). No painel da Hostinger, escolha a versão 22 ou 24.`);
  process.exit(1);
}

const { BancoD1, MemoriaKV } = await import("./banco.mjs");
const { criarArquivos } = await import("./arquivos.mjs");
const { exportarD1, aplicarDump, importarKV } = await import("./importar.mjs");

let instancias = 0;

// Quadros de um vídeo do WhatsApp para a IA olhar (precisa do ffmpeg no servidor; sem ele, a IA usa só a fala do vídeo).
let ffmpegOk = null;
export async function quadrosDoVideo(buffer, mime) {
  const { execFile } = await import("node:child_process");
  const { mkdtempSync, writeFileSync: gravar, readFileSync: ler, readdirSync: listar, rmSync: apagar } = await import("node:fs");
  const bin = process.env.FFMPEG_PATH || "ffmpeg";
  const rodar = args => new Promise((ok, erro) => execFile(bin, args, { timeout: 20000 }, e => e ? erro(e) : ok()));
  if (ffmpegOk === false) return [];
  const dir = mkdtempSync(path.join(os.tmpdir(), "denia-video-"));
  try {
    const arq = path.join(dir, "v." + (/3gp/.test(mime) ? "3gp" : "mp4"));
    gravar(arq, Buffer.from(buffer));
    try { await rodar(["-loglevel", "error", "-i", arq, "-vf", "fps=1/2,scale=640:-2", "-frames:v", "4", path.join(dir, "q%d.jpg")]); ffmpegOk = true; }
    catch (e) { if (e?.code === "ENOENT") ffmpegOk = false; return []; }
    return listar(dir).filter(n => /^q\d+\.jpg$/.test(n)).sort().map(n => ({ mime: "image/jpeg", base64: ler(path.join(dir, n)).toString("base64") }));
  } finally { try { apagar(dir, { recursive: true, force: true }); } catch { } }
}
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Enquanto copia os dados da Cloudflare (ou se a cópia falhou), o site mostra isto no lugar da plataforma.
function paginaAguarde(detalhe, falhou = false) {
  const esc = t => String(t || "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${falhou ? "" : '<meta http-equiv="refresh" content="20">'}<title>DENIA</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#e8ecff;font:16px/1.5 system-ui,sans-serif;padding:16px}main{max-width:520px;text-align:center}h1{font-size:22px}p{color:#b8c0e0}code{background:#1a2140;padding:2px 6px;border-radius:6px;word-break:break-word}</style></head>
<body><main><h1>${falhou ? "A cópia dos dados não deu certo" : "Copiando seus dados da Cloudflare…"}</h1>
<p>${falhou ? `Motivo: <code>${esc(detalhe)}</code><br>Confira CF_CONTA_ID, CF_API_TOKEN, CF_D1_ID e CF_KV_ID nas variáveis do app e reinicie.` : `Na primeira vez a DENIA traz conversas, empresas e configurações. Leva de alguns segundos a poucos minutos. Esta página atualiza sozinha.${detalhe ? `<br><small>${esc(detalhe)}</small>` : ""}`}</p></main></body></html>`;
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "20", "cache-control": "no-store" } });
}

export async function iniciar(op = {}) {
  const ambiente = op.env || process.env;
  const DADOS = path.resolve(ambiente.DENIA_DADOS || path.join(os.homedir(), "denia-dados"));
  mkdirSync(DADOS, { recursive: true });
  // Variáveis também podem ficar num arquivo .env dentro da pasta de dados (nunca no Git).
  if (!op.env && existsSync(path.join(DADOS, ".env"))) { try { process.loadEnvFile(path.join(DADOS, ".env")); } catch (e) { console.error(".env:", e.message); } }
  const ARQ_BANCO = path.join(DADOS, "denia.db");
  const ARQ_ENGINE = ambiente.CF_D1_ID_ENGINE && ambiente.CF_D1_ID_ENGINE !== ambiente.CF_D1_ID ? path.join(DADOS, "engine.db") : ARQ_BANCO;
  const log = (...a) => { if (!op.silencioso) console.log(new Date().toISOString(), ...a); };

  const situacao = { iniciado: Date.now(), importacao: { status: "nao_pedida" }, tiques: { plataforma: 0, engine: 0 }, erros: [] };
  const anotarErro = (onde, e) => { situacao.erros.unshift({ onde, erro: String(e?.message || e).slice(0, 300), em: new Date().toISOString() }); situacao.erros.length = Math.min(situacao.erros.length, 20); console.error(onde, e?.stack || e); };

  // Importação automática na primeira vez (banco vazio + chaves da Cloudflare configuradas).
  async function importar(forcar = false) {
    const conta = ambiente.CF_CONTA_ID, token = ambiente.CF_API_TOKEN;
    if (!conta || !token || !ambiente.CF_D1_ID) throw new Error("Faltam CF_CONTA_ID, CF_API_TOKEN e CF_D1_ID nas variáveis do servidor.");
    situacao.importacao = { status: "importando", inicio: new Date().toISOString(), etapa: "banco" };
    const bancos = [[ambiente.CF_D1_ID, ARQ_BANCO]];
    if (ARQ_ENGINE !== ARQ_BANCO) bancos.push([ambiente.CF_D1_ID_ENGINE, ARQ_ENGINE]);
    const resumo = {};
    for (const [id, arq] of bancos) {
      if (!forcar && existsSync(arq) && BancoD1.temTabelas(arq)) continue;
      const sql = await exportarD1({ conta, token, banco: id, log: m => { situacao.importacao.etapa = m; log(m); } });
      resumo[path.basename(arq)] = await aplicarDump(sql, arq);
    }
    if (ambiente.CF_KV_ID) {
      situacao.importacao.etapa = "memória";
      const kv = new MemoriaKV(path.join(DADOS, "memoria.db"));
      resumo.memoria = await importarKV({ conta, token, namespace: ambiente.CF_KV_ID, kv, log });
      kv.fechar();
    }
    situacao.importacao = { status: "concluida", em: new Date().toISOString(), resumo };
    log("Importação da Cloudflare concluída", JSON.stringify(resumo));
  }

  // A cópia da primeira vez roda por trás: o servidor já responde (a Hostinger derruba app que demora a abrir a porta)
  // com uma página de "copiando seus dados". Se a cópia falhar, o site mostra o erro em vez de abrir vazio.
  const vazio = arq => !existsSync(arq) || !BancoD1.temTabelas(arq);
  let importando = null, importacaoFalhou = false;
  if (ambiente.CF_API_TOKEN && (vazio(ARQ_BANCO) || vazio(ARQ_ENGINE))) {
    importando = importar(false)
      .then(() => { abrir(); gravarEndereco(); })
      .catch(e => { importacaoFalhou = true; situacao.importacao = { status: "erro", erro: e.message }; anotarErro("importação", e); })
      .finally(() => { importando = null; });
  }
  const pronto = importando || Promise.resolve();

  // Bancos com "troca a quente" (para reimportar sem reiniciar).
  const abertos = {};
  function abrir() {
    for (const b of Object.values(abertos)) b.fechar();
    abertos.plataforma = new BancoD1(ARQ_BANCO);
    abertos.engine = ARQ_ENGINE === ARQ_BANCO ? abertos.plataforma : new BancoD1(ARQ_ENGINE);
    abertos.kv = new MemoriaKV(path.join(DADOS, "memoria.db"));
  }
  if (!importando) abrir();
  // Endereço novo: links de e-mail e retornos (Meta/Google) deixam de apontar para o workers.dev antigo.
  function gravarEndereco() {
    const site = String(ambiente.SITE_URL || "").trim().replace(/\/+$/, "");
    if (!/^https:\/\/[^/]+$/.test(site)) return;
    try { abertos.plataforma.db.prepare("UPDATE plt_meta SET valor=? WHERE chave='base_url'").run(site); } catch { }
  }
  if (!importando) gravarEndereco();
  const d1 = qual => ({ prepare: s => abertos[qual].prepare(s), batch: l => abertos[qual].batch(l), exec: s => abertos[qual].exec(s) });
  const kv = { get: (...a) => abertos.kv.get(...a), put: (...a) => abertos.kv.put(...a), delete: (...a) => abertos.kv.delete(...a), list: (...a) => abertos.kv.list(...a) };

  // Cada Worker recebe as variáveis do servidor; ENGINE_<NOME> vale só para a IA do WhatsApp.
  const variaveis = {};
  const variaveisEngine = {};
  for (const [k, v] of Object.entries(ambiente)) { if (typeof v === "string") { variaveis[k] = v; variaveisEngine[k] = v; } }
  for (const [k, v] of Object.entries(ambiente)) if (k.startsWith("ENGINE_") && typeof v === "string") variaveisEngine[k.slice(7)] = v;
  // Plataforma e IA rodam no mesmo servidor: o token entre elas é sempre o mesmo. Sem DENIA_PLATFORM_SERVICE_TOKEN
  // nas variáveis, o servidor cria um e guarda na pasta de dados (as páginas da Central nunca ficam sem a IA).
  let tokenIA = String(variaveisEngine.DENIA_PLATFORM_SERVICE_TOKEN || "").trim();
  if (tokenIA.length < 16) {
    const arq = path.join(DADOS, "token-ia.txt");
    try { tokenIA = readFileSync(arq, "utf8").trim(); } catch { tokenIA = ""; }
    if (tokenIA.length < 32) { tokenIA = randomBytes(32).toString("base64url"); try { writeFileSync(arq, tokenIA, { mode: 0o600 }); } catch (e) { anotarErro("token da IA", e); } }
  }
  variaveis.DENIA_PLATFORM_SERVICE_TOKEN = variaveisEngine.DENIA_PLATFORM_SERVICE_TOKEN = tokenIA;
  variaveis.DENIA_IA_LOCAL = "1";
  variaveisEngine.DENIA_SERVIDOR_PROPRIO = "1";
  // Endereço público da IA (ex.: https://denia-ai.com/ia): usado para ligar o Telegram da equipe.
  { const site = String(ambiente.SITE_URL || "").trim().replace(/\/+$/, ""); if (/^https:\/\/[^/\s]+$/.test(site) && !variaveisEngine.ENDERECO_PUBLICO_IA) variaveisEngine.ENDERECO_PUBLICO_IA = site + "/" + String(ambiente.ENGINE_PREFIXO || "ia").replace(/^\/+|\/+$/g, ""); } // a IA pode esperar o cliente terminar de escrever (sem o limite de 30 s da Cloudflare)
  // Fora da Cloudflare não existe o limite de 50 chamadas por execução do plano gratuito.
  if (!variaveisEngine.LIMITE_CHAMADAS) variaveisEngine.LIMITE_CHAMADAS = "900";

  // Cada iniciar() carrega cópias novas dos Workers (nos testes, cada um com seu banco).
  const sufixo = op.env ? "?instancia=" + (++instancias) : "";
  const plataforma = (await import(pathToFileURL(path.join(RAIZ, "src/worker.js")).href + sufixo)).default;
  const engine = (await import(pathToFileURL(path.join(RAIZ, "engine/worker.js")).href + sufixo)).default;

  const pendentes = new Set();
  const contexto = () => ({
    waitUntil(p) { const x = Promise.resolve(p).catch(e => anotarErro("tarefa em segundo plano", e)).finally(() => pendentes.delete(x)); pendentes.add(x); },
    passThroughOnException() { }
  });
  const envEngine = { ...variaveisEngine, DB: d1("engine"), MEMORIA: kv, QUADROS_VIDEO: quadrosDoVideo, ...(op.extrasEngine || {}) };
  const envPlataforma = {
    ...variaveis, DB: d1("plataforma"), ASSETS: criarArquivos(path.join(RAIZ, "public")),
    ENGINE: { fetch: (req, init) => engine.fetch(req instanceof Request && !init ? req : new Request(req, init), envEngine, contexto()) },
    ...(op.extrasPlataforma || {})
  };

  // Tarefas automáticas: IA do WhatsApp a cada minuto, plataforma a cada 5 minutos (como na Cloudflare).
  const desligadas = /^(desligadas|0|false|nao|não)$/i.test(ambiente.DENIA_TAREFAS || "");
  const rodando = { plataforma: false, engine: false };
  async function rodarAgendado(qual, worker, env, cron) {
    if (rodando[qual]) return false;
    rodando[qual] = true;
    const ctx = contexto();
    const antes = new Set(pendentes);
    try {
      await worker.scheduled({ cron, scheduledTime: Date.now(), type: "scheduled" }, env, ctx);
      await Promise.all([...pendentes].filter(p => !antes.has(p)));
      situacao.tiques[qual] = Date.now();
    } catch (e) { anotarErro("tarefas " + qual, e); }
    finally { rodando[qual] = false; }
    return true;
  }
  // Cópia de segurança diária (madrugada no Brasil), guardando os últimos 7 dias.
  const PASTA_COPIAS = path.join(DADOS, "copias");
  function listarCopias() { try { return readdirSync(PASTA_COPIAS).filter(f => f.endsWith(".db")).sort(); } catch { return []; } }
  function copiaDeSeguranca(forcar = false) {
    const ultima = listarCopias().at(-1);
    const ultimaMs = ultima ? statSync(path.join(PASTA_COPIAS, ultima)).mtimeMs : 0;
    const hora = new Date().getUTCHours();
    if (!forcar && !((hora >= 6 && hora < 9 && Date.now() - ultimaMs > 20 * 3600000) || Date.now() - ultimaMs > 30 * 3600000)) return null;
    mkdirSync(PASTA_COPIAS, { recursive: true });
    const dia = new Date().toISOString().slice(0, 10);
    const feitos = [];
    for (const [nome, b] of [["denia", abertos.plataforma], ...(abertos.engine !== abertos.plataforma ? [["engine", abertos.engine]] : [])]) {
      const destino = path.join(PASTA_COPIAS, `${nome}-${dia}.db`);
      rmSync(destino, { force: true });
      b.db.prepare("VACUUM INTO ?").run(destino);
      feitos.push(path.basename(destino));
    }
    for (const prefixo of ["denia-", "engine-"]) {
      const delas = listarCopias().filter(f => f.startsWith(prefixo));
      for (const velha of delas.slice(0, Math.max(0, delas.length - 7))) rmSync(path.join(PASTA_COPIAS, velha), { force: true });
    }
    return feitos;
  }

  async function tique(origem = "relógio") {
    if (desligadas) return { rodou: false, motivo: "DENIA_TAREFAS=desligadas" };
    if (importando || importacaoFalhou) return { rodou: false, motivo: importando ? "copiando os dados da Cloudflare" : "a cópia dos dados falhou" };
    const agora = Date.now();
    const feito = {};
    if (agora - situacao.tiques.engine >= 50000) feito.engine = rodarAgendado("engine", engine, envEngine, "* * * * *");
    if (agora - situacao.tiques.plataforma >= 4.5 * 60000) feito.plataforma = rodarAgendado("plataforma", plataforma, envPlataforma, "*/5 * * * *");
    if (agora - (situacao.ultimaLimpezaKv || 0) > 3600000) { situacao.ultimaLimpezaKv = agora; try { abertos.kv.limparVencidos(); } catch { } }
    for (const k of Object.keys(feito)) feito[k] = await feito[k];
    try { const c = copiaDeSeguranca(); if (c) { feito.copia = c; log("Cópia de segurança:", c.join(", ")); } } catch (e) { anotarErro("cópia de segurança", e); }
    return { rodou: true, origem, ...feito };
  }
  let relogio = null;
  if (!op.semRelogio && !desligadas) {
    const proximo = () => { relogio = setTimeout(() => { tique().catch(e => anotarErro("tique", e)); proximo(); }, 60000 - (Date.now() % 60000) + 200); relogio.unref?.(); };
    proximo();
  }

  // Confere se a chave das conexões salvas (SESSION_SECRET) é a mesma da Cloudflare:
  // tenta abrir um token cifrado do banco importado, sem mostrar nada dele.
  async function conferirChaveConexoes() {
    const db = abertos.plataforma.db;
    let amostra = null;
    try { amostra = db.prepare("SELECT valor FROM plt_meta WHERE valor LIKE 'v1.%' AND chave<>'schema' LIMIT 1").get()?.valor || null; } catch { }
    if (!amostra) try {
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plt_%'").all()) {
        const col = db.prepare(`PRAGMA table_info("${name.replace(/"/g, "")}")`).all().find(c => /cifrad/i.test(c.name));
        if (!col) continue;
        const r = db.prepare(`SELECT "${col.name}" v FROM "${name}" WHERE "${col.name}" LIKE 'v1.%' LIMIT 1`).get();
        if (r?.v) { amostra = r.v; break; }
      }
    } catch { }
    if (!amostra) return "sem conexões salvas para conferir";
    let chave = String(ambiente.SESSION_SECRET || "");
    if (chave.length < 32) { try { chave = db.prepare("SELECT valor FROM plt_meta WHERE chave='segredo'").get()?.valor || ""; } catch { chave = ""; } }
    if (!chave) return "NÃO CONFERE: falta a SESSION_SECRET igual à da Cloudflare";
    const de64 = t => Uint8Array.from(Buffer.from(t, "base64url"));
    const [, iv, ct] = amostra.split(".");
    try {
      const enc = new TextEncoder();
      const base = await crypto.subtle.importKey("raw", enc.encode(chave), "HKDF", false, ["deriveKey"]);
      const k = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("denia-platform"), info: enc.encode("token-engine-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: de64(iv) }, k, de64(ct));
      return "confere";
    } catch { return "NÃO CONFERE: a SESSION_SECRET é diferente da Cloudflare (as conexões salvas não abrem)"; }
  }

  const chaveServidor = ambiente.DENIA_CHAVE_SERVIDOR || "";
  const confere = dada => {
    if (chaveServidor.length < 16 || !dada) return false;
    const a = createHash("sha256").update(String(dada)).digest(), b = createHash("sha256").update(chaveServidor).digest();
    return timingSafeEqual(a, b);
  };
  const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

  const prefixoIA = "/" + String(ambiente.ENGINE_PREFIXO || "ia").replace(/^\/+|\/+$/g, "");
  const hostIA = String(ambiente.ENGINE_HOST || "").toLowerCase();

  async function atender(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__denia/")) {
      if (!confere(url.searchParams.get("chave") || request.headers.get("x-denia-chave"))) return json({ ok: false, erro: "Chave do servidor ausente ou errada (DENIA_CHAVE_SERVIDOR, mínimo 16 caracteres)." }, 403);
      if (url.pathname === "/__denia/tique") return json({ ok: true, ...(await tique("painel")) });
      if (url.pathname === "/__denia/estado" && (importando || importacaoFalhou)) return json({ ok: !importacaoFalhou, node: process.versions.node, pasta_dados: DADOS, importacao: situacao.importacao, erros_recentes: situacao.erros });
      if (url.pathname === "/__denia/estado") {
        const tam = arq => { try { return Math.round(statSync(arq).size / 1048576 * 10) / 10 + " MB"; } catch { return "—"; } };
        return json({ ok: true, node: process.versions.node, no_ar_desde: new Date(situacao.iniciado).toISOString(), pasta_dados: DADOS,
          banco: tam(ARQ_BANCO), ...(ARQ_ENGINE !== ARQ_BANCO ? { banco_engine: tam(ARQ_ENGINE) } : {}), tarefas: desligadas ? "desligadas" : "ligadas",
          ultimas_tarefas: { plataforma: situacao.tiques.plataforma ? new Date(situacao.tiques.plataforma).toISOString() : null, ia_whatsapp: situacao.tiques.engine ? new Date(situacao.tiques.engine).toISOString() : null },
          chave_das_conexoes: await conferirChaveConexoes(), copias_de_seguranca: listarCopias(), em_andamento: pendentes.size, importacao: situacao.importacao, erros_recentes: situacao.erros });
      }
      if (url.pathname === "/__denia/importar" && (request.method === "POST" || url.searchParams.get("confirmar") === "sim")) {
        try { copiaDeSeguranca(true); } catch (e) { anotarErro("cópia antes de importar", e); }
        if (situacao.importacao.status === "importando") return json({ ok: false, erro: "Já existe uma importação em andamento." }, 409);
        try {
          for (const b of new Set(Object.values(abertos))) b.fechar();
          await importar(true);
          return json({ ok: true, importacao: situacao.importacao });
        } catch (e) { situacao.importacao = { status: "erro", erro: e.message }; anotarErro("importação", e); return json({ ok: false, erro: e.message }, 500); }
        finally { importacaoFalhou = situacao.importacao.status === "erro" && vazio(ARQ_BANCO); abrir(); gravarEndereco(); }
      }
      return json({ ok: false, erro: "Rota desconhecida." }, 404);
    }
    if (importando || importacaoFalhou) return paginaAguarde(importacaoFalhou ? situacao.importacao.erro : situacao.importacao.etapa, importacaoFalhou);
    // A hospedagem pode adormecer o app quando fica sem visitas (o relógio para). Cada pedido que chega
    // (o WhatsApp, o painel) acorda as tarefas atrasadas: nenhuma mensagem fica presa na fila.
    if (!desligadas && !op.semRelogio && Date.now() - situacao.tiques.engine > 90000 && !rodando.engine) tique("pedido").catch(e => anotarErro("tique", e));
    const ehIA = (hostIA && url.hostname.toLowerCase() === hostIA) || url.pathname === prefixoIA || url.pathname.startsWith(prefixoIA + "/");
    if (ehIA) {
      if (!hostIA || url.hostname.toLowerCase() !== hostIA) {
        url.pathname = url.pathname.slice(prefixoIA.length) || "/"; request = new Request(url, request);
        request.headers.set("x-denia-prefixo", prefixoIA); // a IA sabe o próprio endereço público (ex.: Telegram da equipe)
      }
      return engine.fetch(request, envEngine, contexto());
    }
    return plataforma.fetch(request, envPlataforma, contexto());
  }

  // Quantos proxies existem na frente do Node (Hostinger: 1). O IP real do visitante é o
  // último endereço que esses proxies anotaram em X-Forwarded-For.
  const saltos = Math.max(0, Number(ambiente.DENIA_PROXIES ?? 1) || 0);
  function ipDe(req) {
    const lista = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
    if (saltos && lista.length) return lista[Math.max(0, lista.length - saltos)];
    return req.socket.remoteAddress || "local";
  }

  const servidor = http.createServer(async (req, res) => {
    try {
      const protoCab = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
      const proto = /^https?$/.test(protoCab) ? protoCab : (req.socket.encrypted ? "https" : "http");
      // Endereço do pedido: o SITE_URL configurado vale sempre (links de e-mail e retornos não podem ser
      // desviados por um cabeçalho forjado). Sem ele, usa o Host; X-Forwarded-Host só com DENIA_CONFIAR_HOST=1.
      const site = /^https?:\/\/[^/\s]+$/.test(String(ambiente.SITE_URL || "").trim().replace(/\/+$/, "")) ? new URL(String(ambiente.SITE_URL).trim()) : null;
      // www.denia-ai.com → denia-ai.com: um endereço só (o login e os retornos do Google e da Meta valem nele).
      const hostPedido = String(req.headers.host || "").split(",")[0].trim().toLowerCase();
      if (site && hostPedido === "www." + site.host.toLowerCase()) { res.writeHead(301, { location: site.origin + req.url, "cache-control": "public, max-age=3600" }); res.end(); return; }
      const hostCab = ambiente.DENIA_CONFIAR_HOST === "1" ? req.headers["x-forwarded-host"] || req.headers.host : req.headers.host;
      const usaSite = site && !(hostIA && String(req.headers.host || "").toLowerCase() === hostIA);
      const host = site && !(hostIA && String(req.headers.host || "").toLowerCase() === hostIA) ? site.host : String(hostCab || "localhost").split(",")[0].trim();
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.startsWith(":") || k === "cf-connecting-ip") continue;
        if (Array.isArray(v)) v.forEach(x => headers.append(k, x)); else if (v !== undefined) headers.set(k, v);
      }
      headers.set("cf-connecting-ip", ipDe(req));
      const temCorpo = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(`${usaSite ? site.protocol.replace(":", "") : proto}://${host}${req.url}`, { method: req.method, headers, ...(temCorpo ? { body: Readable.toWeb(req), duplex: "half" } : {}) });
      const resposta = await atender(request);
      const cabecalhos = {};
      resposta.headers.forEach((v, k) => { if (k !== "set-cookie") cabecalhos[k] = v; });
      const cookies = resposta.headers.getSetCookie();
      if (cookies.length) cabecalhos["set-cookie"] = cookies;
      res.writeHead(resposta.status, resposta.statusText || undefined, cabecalhos);
      if (!resposta.body || req.method === "HEAD") { res.end(); return; }
      const corpo = Readable.fromWeb(resposta.body);
      corpo.on("error", () => res.destroy());
      res.on("close", () => corpo.destroy());
      corpo.pipe(res);
    } catch (e) {
      anotarErro("requisição " + req.method + " " + String(req.url).split("?")[0], e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, erro: "Erro interno." }));
    }
  });
  servidor.keepAliveTimeout = 65000;

  await new Promise((ok, erro) => { servidor.once("error", erro); 
    const alvo = op.porta ?? (ambiente.PORT && !/^\d+$/.test(ambiente.PORT) ? ambiente.PORT : Number(ambiente.PORT || 3000));
    if (typeof alvo === "string") { try { rmSync(alvo, { force: true }); } catch { } servidor.listen(alvo, ok); } else servidor.listen(alvo, op.ip || ambiente.HOST || undefined, ok);
  });
  const end = servidor.address();
  const porta = typeof end === "string" ? end : end.port;
  log(`DENIA no ar na porta ${porta} · dados em ${DADOS} · tarefas ${desligadas ? "DESLIGADAS" : "ligadas"} · IA do WhatsApp em ${hostIA || prefixoIA + "/"}`);

  async function parar() {
    clearTimeout(relogio);
    await new Promise(ok => servidor.close(() => ok()));
    servidor.closeAllConnections?.();
    await Promise.race([Promise.allSettled([...pendentes]), new Promise(ok => setTimeout(ok, 10000))]);
    for (const b of new Set(Object.values(abertos))) b.fechar();
  }
  return { porta, servidor, parar, tique, atender, situacao, envPlataforma, envEngine, DADOS, pronto };
}

export async function iniciarProducao() {
  const s = await iniciar();
  for (const sinal of ["SIGTERM", "SIGINT"]) process.once(sinal, async () => { console.log("Encerrando com segurança…"); await s.parar(); process.exit(0); });
  return s;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await iniciarProducao();
