// Copia os dados da Cloudflare (banco D1 e memória KV) para os arquivos SQLite deste servidor.
// Usa a API oficial de exportação do D1 (a mesma do "wrangler d1 export").
// As chaves vêm das variáveis de ambiente; nada é gravado em log.
import { DatabaseSync } from "node:sqlite";
import { rename, rm, copyFile, stat } from "node:fs/promises";

const API = "https://api.cloudflare.com/client/v4";

async function chamar(token, caminho, op = {}) {
  const r = await fetch(API + caminho, { ...op, headers: { authorization: "Bearer " + token, "content-type": "application/json", ...(op.headers || {}) } });
  const texto = await r.text();
  let j = null;
  try { j = JSON.parse(texto); } catch { }
  if (!r.ok || !j || j.success === false) {
    const msg = j?.errors?.map(e => e.message).join("; ") || texto.slice(0, 200) || ("HTTP " + r.status);
    throw new Error(`Cloudflare respondeu ${r.status}: ${msg}`);
  }
  return j;
}

export async function exportarD1({ conta, token, banco, esperar = ms => new Promise(r => setTimeout(r, ms)), log = () => { } }) {
  let marcador;
  for (let i = 0; i < 400; i++) {
    const j = await chamar(token, `/accounts/${conta}/d1/database/${banco}/export`, { method: "POST", body: JSON.stringify({ output_format: "polling", ...(marcador ? { current_bookmark: marcador } : {}) }) });
    const r = j.result || {};
    marcador = r.at_bookmark || marcador;
    if (r.status === "error") throw new Error("Exportação do D1 falhou: " + (r.error || (r.messages || []).join("; ")));
    if (r.status === "complete" && r.result?.signed_url) {
      log("Exportação pronta, baixando…");
      const arq = await fetch(r.result.signed_url);
      if (!arq.ok) throw new Error("Não consegui baixar a exportação do D1 (HTTP " + arq.status + ")");
      return await arq.text();
    }
    if (i % 5 === 0) log("Exportando o banco da Cloudflare…");
    await esperar(1500);
  }
  throw new Error("A exportação do D1 demorou demais. Tente de novo.");
}

// Remove o que é interno do SQLite/Cloudflare e não pode ser recriado.
export function limparDump(sql) {
  return String(sql)
    .replace(/^CREATE TABLE (IF NOT EXISTS )?["'`]?sqlite_sequence["'`]?\s*\(.*\);\s*$/gim, "")
    .replace(/^(CREATE TABLE|INSERT INTO|CREATE INDEX|CREATE UNIQUE INDEX) (IF NOT EXISTS )?["'`]?_cf_[^\n]*$/gim, "")
    .replace(/^(BEGIN TRANSACTION|COMMIT);\s*$/gim, "");
}

// Grava num arquivo temporário e só troca no fim (se algo falhar, o banco atual fica intacto).
export async function aplicarDump(sql, arquivo) {
  const tmp = arquivo + ".importando";
  await rm(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  try {
    db.exec("PRAGMA foreign_keys=OFF; BEGIN");
    db.exec(limparDump(sql));
    db.exec("COMMIT");
    const tabelas = db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
    db.close();
    try { await stat(arquivo); await copyFile(arquivo, arquivo + ".antes-da-importacao"); } catch { }
    for (const ext of ["-wal", "-shm"]) await rm(arquivo + ext, { force: true });
    await rename(tmp, arquivo);
    return { tabelas };
  } catch (e) {
    try { db.close(); } catch { }
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function importarKV({ conta, token, namespace, kv, log = () => { }, limite = 20000 }) {
  let cursor = "", total = 0;
  const agora = Math.floor(Date.now() / 1000);
  do {
    const j = await chamar(token, `/accounts/${conta}/storage/kv/namespaces/${namespace}/keys?limit=1000${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    for (const k of j.result || []) {
      if (k.expiration && k.expiration <= agora + 5) continue;
      const r = await fetch(`${API}/accounts/${conta}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(k.name)}`, { headers: { authorization: "Bearer " + token } });
      if (!r.ok) continue;
      await kv.put(k.name, await r.text(), k.expiration ? { expiration: k.expiration } : {});
      if (++total >= limite) return total;
    }
    cursor = j.result_info?.cursor || "";
    log(`Memória: ${total} itens copiados…`);
  } while (cursor);
  return total;
}
