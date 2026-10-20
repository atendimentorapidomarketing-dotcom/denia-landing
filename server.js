// Arquivo de entrada para hospedagens Node.js (Hostinger e outras): sobe o servidor do DENIA.
// O banco usa o SQLite que vem no Node (node:sqlite). Do Node 22.5 ao 22.12 ele existe, mas só liga
// com a opção --experimental-sqlite: aí o servidor se reinicia sozinho com ela (a Hostinger às vezes
// oferece um "Node 22" dessa faixa e roda o arquivo direto, sem o "npm start").
import { spawn } from "node:child_process";

const [maior, menor] = process.versions.node.split(".").map(Number);
const temSqlite = process.env.DENIA_TESTE_SEM_SQLITE === "1" && !process.env.DENIA_RELANCADO ? false : await import("node:sqlite").then(() => true, () => false);

if (temSqlite) {
  const { iniciarProducao } = await import("./servidor/index.mjs");
  await iniciarProducao();
} else if ((maior > 22 || (maior === 22 && menor >= 5)) && !process.env.DENIA_RELANCADO) {
  console.log(`Node ${process.versions.node}: ligando o SQLite (--experimental-sqlite) e reiniciando o servidor…`);
  const filho = spawn(process.execPath, ["--experimental-sqlite", "--disable-warning=ExperimentalWarning", ...process.execArgv, process.argv[1], ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, DENIA_RELANCADO: "1" } });
  for (const sinal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sinal, () => filho.kill(sinal));
  filho.on("exit", (codigo, sinal) => process.exit(codigo ?? (sinal ? 1 : 0)));
} else {
  console.error(`DENIA precisa do Node.js 22.5 ou mais novo (este é ${process.versions.node}). No painel da Hostinger, escolha a versão 22 ou 24 e implante de novo.`);
  process.exit(1);
}
