// Verificação rápida antes de publicar: arquivos obrigatórios, sintaxe dos scripts e
// nenhuma página com script embutido (bloqueado pela política de segurança).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const obrigatorios = ["src/worker.js", "public/sw.js", "public/index.html", "public/app.html", "public/entrar.html", "public/cadastro.html", "public/recuperar.html", "public/redefinir.html", "public/404.html"];
const faltando = obrigatorios.filter(f => !existsSync(f));
if (faltando.length) { console.error("Arquivos faltando:", faltando.join(", ")); process.exit(1); }
const scripts = ["src/worker.js", ...readdirSync("public/assets/js").map(f => "public/assets/js/" + f)];
for (const f of scripts) execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
for (const f of readdirSync("public").filter(f => f.endsWith(".html")).map(f => "public/" + f)) {
  const html = readFileSync(f, "utf8");
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) { console.error(`${f}: script embutido não é permitido pela política de segurança.`); process.exit(1); }
  if (/\sstyle="/i.test(html)) { console.error(`${f}: atributo style embutido não é permitido pela política de segurança.`); process.exit(1); }
  for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"#?]+)"/g)) if (!existsSync("public" + m[1])) { console.error(`${f}: arquivo ${m[1]} não existe.`); process.exit(1); }
}
// Dicionários de idioma: JSON válido, e um aviso (não bloqueia) se houver texto novo sem tradução.
for (const f of existsSync("public/assets/i18n") ? readdirSync("public/assets/i18n") : []) {
  try { JSON.parse(readFileSync("public/assets/i18n/" + f, "utf8")); } catch (e) { console.error(`${f}: dicionário de idioma inválido (${e.message}).`); process.exit(1); }
}
try { execFileSync(process.execPath, ["scripts/i18n.mjs", "verificar"], { stdio: "inherit" }); } catch { /* só informativo */ }
console.log("DENIA Platform: tudo certo para publicar.");
