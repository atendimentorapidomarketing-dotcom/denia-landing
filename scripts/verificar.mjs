// Verificação rápida antes de publicar: arquivos obrigatórios e sintaxe dos scripts.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const obrigatorios = ["public/sw.js", "src/worker.js", "public/index.html", "public/app.html", "public/entrar.html", "public/404.html", "public/assets/js/app.js", "public/assets/js/site.js", "public/assets/js/entrar.js"];
const faltando = obrigatorios.filter(f => !existsSync(f));
if (faltando.length) { console.error("Arquivos faltando:", faltando.join(", ")); process.exit(1); }
for (const f of ["src/worker.js", "public/assets/js/app.js", "public/assets/js/site.js", "public/assets/js/entrar.js"]) {
  execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
}
for (const f of ["public/index.html", "public/app.html", "public/entrar.html"]) {
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(readFileSync(f, "utf8"))) { console.error(`${f}: script embutido não é permitido pela política de segurança.`); process.exit(1); }
}
console.log("DENIA Platform: tudo certo para publicar.");
