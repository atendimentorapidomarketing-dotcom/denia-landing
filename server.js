// Arquivo de entrada para hospedagens Node.js (Hostinger e outras): sobe o servidor do DENIA.
// Sem "await" no nível de cima: a Hostinger (LiteSpeed, lsnode.js) carrega este arquivo com require(),
// que não aceita módulo com top-level await (ERR_REQUIRE_ASYNC_MODULE). O resto carrega com import().
// O banco usa o SQLite que vem no Node (node:sqlite). Do Node 22.5 ao 22.12 ele só liga com a opção
// --experimental-sqlite: rodando direto (node server.js / npm start), o servidor se reinicia com ela.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const [maior, menor] = process.versions.node.split(".").map(Number);
const esteArquivo = fileURLToPath(import.meta.url);
const rodandoDireto = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === esteArquivo;
const forcarSemSqlite = process.env.DENIA_TESTE_SEM_SQLITE === "1" && !process.env.DENIA_RELANCADO;

// O aviso "SQLite is an experimental feature" aparecia como erro vermelho nos logs da Hostinger: some só ele.
const emitirAviso = process.emitWarning;
process.emitWarning = function (aviso, ...resto) {
  if (/SQLite is an experimental feature/i.test(String(aviso?.message || aviso))) return;
  return emitirAviso.call(process, aviso, ...resto);
};

function falhar(e) { console.error("DENIA não conseguiu iniciar:", e?.stack || e); process.exitCode = 1; }

(forcarSemSqlite ? Promise.resolve(false) : import("node:sqlite").then(() => true, () => false)).then(temSqlite => {
  if (temSqlite) return import("./servidor/index.mjs").then(m => m.iniciarProducao());
  if ((maior > 22 || (maior === 22 && menor >= 5)) && rodandoDireto && !process.env.DENIA_RELANCADO) {
    console.log(`Node ${process.versions.node}: ligando o SQLite (--experimental-sqlite) e reiniciando o servidor…`);
    const filho = spawn(process.execPath, ["--experimental-sqlite", "--disable-warning=ExperimentalWarning", ...process.execArgv, esteArquivo, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, DENIA_RELANCADO: "1" } });
    for (const sinal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sinal, () => filho.kill(sinal));
    filho.on("exit", (codigo, sinal) => process.exit(codigo ?? (sinal ? 1 : 0)));
    return;
  }
  console.error(`DENIA precisa do Node.js 22.13 ou mais novo (este é ${process.versions.node}). No painel da Hostinger, escolha a versão 22 (mais nova) ou 24 e implante de novo.`);
  process.exitCode = 1;
}).catch(falhar);
