// Ambiente de teste: D1 real (SQLite), KV em memória e mocks de Meta, OpenAI e Telegram.
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";

let contadorModulo = 0;

class Stmt {
  constructor(h, sql, args = []) { this.h = h; this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.h, this.sql, a); }
  _a() { this.h.checar(); return this.args.map(v => v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v); }
  async first() { const r = this.h.db.prepare(this.sql).get(...this._a()); return r ? { ...r } : null; }
  async all() { return { results: this.h.db.prepare(this.sql).all(...this._a()).map(r => ({ ...r })) }; }
  async run() {
    const st = this.h.db.prepare(this.sql);
    if (/\breturning\b/i.test(this.sql)) { const rows = st.all(...this._a()); return { meta: { changes: rows.length }, results: rows }; }
    const r = st.run(...this._a());
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}
export class D1Fake {
  constructor() { this.db = new DatabaseSync(":memory:"); this.falhar = false; }
  checar() { if (this.falhar) throw new Error("D1_ERROR: account exceeded the free-tier daily row-read limit"); }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(sts) { return Promise.all(sts.map(s => s.run())); }
  q(sql, ...a) { return this.db.prepare(sql).all(...a).map(r => ({ ...r })); }
}
export class KVFake {
  constructor(relogio = () => Date.now()) { this.m = new Map(); this.puts = 0; this.relogio = relogio; }
  async get(k) { const e = this.m.get(k); if (!e) return null; if (e.ate && this.relogio() > e.ate) { this.m.delete(k); return null; } return e.v; }
  async put(k, v, op = {}) { this.puts++; this.m.set(k, { v: String(v), ate: op.expirationTtl ? this.relogio() + op.expirationTtl * 1000 : 0 }); }
  async delete(k) { this.m.delete(k); }
}

export async function criarAmbiente({ inicio = "2026-10-07T14:00:00-03:00", env: extra = {} } = {}) {
  const mod = await import(new URL("../worker.js?t=" + (++contadorModulo), import.meta.url).href);
  const worker = mod.default;
  const amb = {
    agora: Date.parse(inicio), DB: new D1Fake(), KV: null,
    enviados: [], telegram: [], llm: [], plataforma: [], crmConsultas: [], crmResposta: null, llmCliente: null, llmPrestador: null, metaFalha: null, contador: 0, transcricoes: {}
  };
  amb.KV = new KVFake(() => amb.agora);
  amb.env = {
    DB: amb.DB, MEMORIA: amb.KV, OPENAI_API_KEY: "sk-test", WHATSAPP_TOKEN: "tok", WHATSAPP_VERIFY_TOKEN: "verify",
    PAINEL_SENHA: "senha-de-teste-123", TELEGRAM_BOT_TOKEN: "tg", TELEGRAM_CHAT_ID: "1", JANELA_AGRUPAMENTO_MS: "0",
    __agora: () => amb.agora, ...extra
  };
  globalThis.fetch = async (url, op = {}) => {
    url = String(url);
    const corpo = op.body && typeof op.body === "string" ? JSON.parse(op.body) : op.body;
    const resp = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/messages") && url.includes("graph.facebook.com")) {
      const falha = amb.metaFalha?.(corpo);
      if (falha) return resp({ error: falha }, 400);
      const id = "wamid.out." + (++amb.contador);
      amb.enviados.push({ id, to: corpo.to, type: corpo.type, texto: corpo.text?.body || corpo.template?.name || corpo[corpo.type]?.id, corpo });
      return resp({ messages: [{ id }] });
    }
    if (url.includes("graph.facebook.com")) return resp({ url: "https://media.test/" + url.split("/").pop(), mime_type: "audio/ogg" });
    if (url.startsWith("https://media.test/")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/ogg" } });
    if (url.includes("/audio/transcriptions")) return resp({ text: amb.transcricaoAtual || "áudio" });
    if (url.includes("api.openai.com/v1/responses")) {
      const entrada = corpo.input[0].content[0].text;
      const papel = corpo.instructions.startsWith("Você é a DENIA") ? "cliente" : corpo.instructions.startsWith("Você trabalha") ? "prestador" : "outro";
      amb.llm.push({ papel, entrada });
      const fn = papel === "cliente" ? amb.llmCliente : papel === "prestador" ? amb.llmPrestador : (corpo.instructions.startsWith("Você analisa conversas") && amb.llmAprendizado) || (() => ({ analise: "ok", descricao: "ok" }));
      if (!fn) throw new Error("LLM não esperado: " + papel);
      const out = fn(entrada);
      if (out instanceof Error) return resp({ error: { message: out.message } }, 500);
      return resp({ output: [{ content: [{ type: "output_text", text: JSON.stringify(out) }] }] });
    }
    if (url.startsWith("https://plataforma.test/")) { amb.plataforma.push({ headers: op.headers, corpo }); return resp({ ok: true, cliente_id: 77, os_id: 88 }); }
    if (url.startsWith("https://crm.test/")) { amb.crmConsultas.push(url); return resp(amb.crmResposta || {}); }
    if (url.includes("api.telegram.org")) { amb.telegram.push(corpo.text); return resp({ ok: true, result: { message_id: 1 } }); }
    throw new Error("fetch inesperado: " + url);
  };
  const executar = async (req) => {
    const pend = [];
    const ctx = { waitUntil: p => pend.push(p) };
    const r = await worker.fetch(req, amb.env, ctx);
    while (pend.length) await pend.shift();
    return r;
  };
  amb.passo = 40000; // cada mensagem chega 40 s depois da anterior, como numa conversa real
  amb.webhook = async (value, { headers = {}, assinar } = {}) => {
    amb.agora += amb.passo;
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: value.message_echoes ? "smb_message_echoes" : "messages", value: { metadata: { phone_number_id: "473474732510163" }, ...value } }] }] });
    const h = { "content-type": "application/json", ...headers };
    if (assinar) h["x-hub-signature-256"] = "sha256=" + createHmac("sha256", assinar).update(body).digest("hex");
    return executar(new Request("https://denia.test/webhook", { method: "POST", headers: h, body }));
  };
  let n = 0;
  amb.msg = (de, texto, extra = {}) => ({
    contacts: [{ wa_id: de, profile: { name: extra.nome || "" } }],
    messages: [{ id: "wamid.in." + (++n) + "." + Math.random().toString(36).slice(2), from: de, timestamp: String(Math.floor((extra.ts ?? amb.agora) / 1000)), type: extra.type || "text", text: { body: texto }, ...(extra.raw || {}) }]
  });
  amb.cliente = (de, texto, extra) => amb.webhook(amb.msg(de, texto, extra));
  amb.eco = (para, texto, extra = {}) => amb.webhook({ message_echoes: [{ id: "wamid.eco." + (++n), from: "5521000000000", to: para, timestamp: String(Math.floor(amb.agora / 1000)), type: extra.type || "text", text: { body: texto }, ...(extra.raw || {}) }] });
  amb.cron = () => worker.scheduled({}, amb.env, { waitUntil() { } });
  amb.http = (caminho, op = {}) => executar(new Request("https://denia.test" + caminho, { ...op, headers: { authorization: "Basic " + btoa("x:senha-de-teste-123"), "content-type": "application/json", ...(op.headers || {}) } }));
  amb.para = tel => amb.enviados.filter(e => e.to === tel);
  amb.ultimoPara = tel => amb.para(tel).at(-1)?.texto?.replace(/\u00a0/g, " ");
  amb.avancar = ms => { amb.agora += ms; };
  amb.worker = worker;
  return amb;
}
