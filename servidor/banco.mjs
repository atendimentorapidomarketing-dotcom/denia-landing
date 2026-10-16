// Banco de dados e memória para rodar fora da Cloudflare (Hostinger, VPS, computador).
// Imita a API do Cloudflare D1 (prepare/bind/first/all/run/raw/batch/exec) e do KV
// (get/put/delete/list) usando SQLite em arquivo, que já vem dentro do Node 22.
import { DatabaseSync } from "node:sqlite";

const LIMITE_CACHE = 400;

function valores(args, sql) {
  return args.map((v, i) => {
    if (v === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined' (parâmetro ${i + 1} de: ${String(sql).slice(0, 120)})`);
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (typeof v === "bigint") return v;
    return v;
  });
}
const linha = r => r ? Object.assign({}, r) : r;
const devolveLinhas = sql => /\breturning\b/i.test(sql) || /^\s*(select|with|pragma|values)\b/i.test(sql);

class Comando {
  constructor(banco, sql, args = []) { this.banco = banco; this.sql = sql; this.args = args; }
  bind(...a) { return new Comando(this.banco, this.sql, a); }
  _st() { return this.banco._preparar(this.sql); }
  _rodar() {
    const st = this._st();
    const a = valores(this.args, this.sql);
    if (devolveLinhas(this.sql)) {
      const rows = st.all(...a).map(linha);
      return { success: true, results: rows, meta: { changes: /^\s*(select|with|pragma|values)\b/i.test(this.sql) ? 0 : rows.length, last_row_id: 0, rows_read: rows.length, rows_written: 0, duration: 0 } };
    }
    const r = st.run(...a);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), rows_read: 0, rows_written: Number(r.changes), duration: 0 } };
  }
  async first(coluna) {
    const r = linha(this._st().get(...valores(this.args, this.sql)));
    if (coluna === undefined) return r ?? null;
    if (!r) return null;
    if (!(coluna in r)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${coluna})`);
    return r[coluna];
  }
  async all() {
    const rows = this._st().all(...valores(this.args, this.sql)).map(linha);
    return { success: true, results: rows, meta: { changes: 0, rows_read: rows.length, duration: 0 } };
  }
  async run() { return this._rodar(); }
  async raw(op = {}) {
    const st = this._st();
    const rows = st.all(...valores(this.args, this.sql));
    const colunas = st.columns().map(c => c.name);
    const lista = rows.map(r => colunas.map(c => r[c]));
    return op.columnNames ? [colunas, ...lista] : lista;
  }
}

export class BancoD1 {
  constructor(arquivo) {
    this.arquivo = arquivo;
    this.db = new DatabaseSync(arquivo);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=OFF;");
    this.cache = new Map();
  }
  _preparar(sql) {
    let st = this.cache.get(sql);
    if (st) { this.cache.delete(sql); this.cache.set(sql, st); return st; }
    st = this.db.prepare(sql);
    this.cache.set(sql, st);
    if (this.cache.size > LIMITE_CACHE) this.cache.delete(this.cache.keys().next().value);
    return st;
  }
  prepare(sql) { return new Comando(this, sql); }
  // Como no D1: tudo ou nada.
  async batch(comandos) {
    const lista = comandos.map(c => c instanceof Comando ? c : c?._st);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = lista.map(c => c._rodar());
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { }
      throw e;
    }
  }
  async exec(sql) {
    this.cache.clear();
    this.db.exec(sql);
    return { count: String(sql).split(";").filter(s => s.trim()).length, duration: 0 };
  }
  static temTabelas(arquivo) { const b = new BancoD1(arquivo); try { return b.tabelas().length > 0; } finally { b.fechar(); } }
  tabelas() { return this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name); }
  fechar() { this.cache.clear(); try { this.db.close(); } catch { } }
}

export class MemoriaKV {
  constructor(arquivo, relogio = () => Date.now()) {
    this.db = new DatabaseSync(arquivo);
    this.relogio = relogio;
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; CREATE TABLE IF NOT EXISTS kv (chave TEXT PRIMARY KEY, valor TEXT, expira_ms INTEGER, meta TEXT)");
  }
  async get(chave, op) {
    const tipo = typeof op === "string" ? op : op?.type || "text";
    const r = this.db.prepare("SELECT valor, expira_ms FROM kv WHERE chave=?").get(String(chave));
    if (!r) return null;
    if (r.expira_ms && r.expira_ms <= this.relogio()) { this.db.prepare("DELETE FROM kv WHERE chave=?").run(String(chave)); return null; }
    if (tipo === "json") return JSON.parse(r.valor);
    if (tipo === "arrayBuffer") return new TextEncoder().encode(r.valor).buffer;
    return r.valor;
  }
  async put(chave, valor, op = {}) {
    let expira = null;
    if (op.expiration) expira = Number(op.expiration) * 1000;
    else if (op.expirationTtl) expira = this.relogio() + Number(op.expirationTtl) * 1000;
    const texto = typeof valor === "string" ? valor : valor instanceof ArrayBuffer || ArrayBuffer.isView(valor) ? new TextDecoder().decode(valor) : String(valor);
    this.db.prepare("INSERT INTO kv(chave,valor,expira_ms,meta) VALUES(?,?,?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor, expira_ms=excluded.expira_ms, meta=excluded.meta")
      .run(String(chave), texto, expira, op.metadata ? JSON.stringify(op.metadata) : null);
  }
  async delete(chave) { this.db.prepare("DELETE FROM kv WHERE chave=?").run(String(chave)); }
  async list(op = {}) {
    const limite = Math.min(1000, Math.max(1, Number(op.limit) || 1000));
    const prefixo = String(op.prefix || "");
    const depois = op.cursor ? Buffer.from(op.cursor, "base64url").toString() : "";
    const rows = this.db.prepare("SELECT chave, expira_ms, meta FROM kv WHERE chave >= ? AND chave < ? AND chave > ? AND (expira_ms IS NULL OR expira_ms > ?) ORDER BY chave LIMIT ?")
      .all(prefixo, prefixo + "￿", depois, this.relogio(), limite + 1);
    const mais = rows.length > limite;
    const keys = rows.slice(0, limite).map(r => ({ name: r.chave, ...(r.expira_ms ? { expiration: Math.floor(r.expira_ms / 1000) } : {}), ...(r.meta ? { metadata: JSON.parse(r.meta) } : {}) }));
    return { keys, list_complete: !mais, ...(mais ? { cursor: Buffer.from(keys.at(-1).name).toString("base64url") } : {}) };
  }
  limparVencidos() { this.db.prepare("DELETE FROM kv WHERE expira_ms IS NOT NULL AND expira_ms <= ?").run(this.relogio()); }
  fechar() { try { this.db.close(); } catch { } }
}
