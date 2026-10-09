// DENIA — textos para tradução.
//   node scripts/i18n.mjs extrair  → grava i18n-fonte.json (todos os textos em português)
//   node scripts/i18n.mjs verificar → mostra, por idioma, quantos textos ainda não têm tradução
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";

const IDIOMAS = ["en", "es", "de", "it", "fr", "ja"];
const limpo = s => String(s).replace(/\s+/g, " ").trim();
const decodificar = s => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&rarr;/g, "→").replace(/&middot;/g, "·");
const temLetra = s => /[A-Za-zÀ-ú]{2,}/.test(s);
const t = new Set(), h = new Map(), p = new Set();

// Textos que parecem código, não texto para pessoas.
function pareceCodigo(s) {
  if (!temLetra(s)) return true;
  if (/^</.test(s) || /^\[/.test(s) || /^[\w-]+\(/.test(s) || /\$\{/.test(s)) return true; // marcação, seletores, funções CSS, templates quebrados
  if (/^(SELECT|INSERT|UPDATE|CREATE|DELETE|ALTER|WITH)\b/.test(s)) return true;
  if (/^[a-z0-9_\-:.\/#?=&%[\]*>+~ ]+$/.test(s) && !/ [a-zà-ú]{3,} /.test(" " + s + " ")) return true; // classes, seletores, rotas
  if (/^[A-Z0-9_]+$/.test(s)) return true; // CONSTANTES
  if (/[{};]/.test(s) && /:/.test(s) && !/[.!?]$/.test(s)) return true; // CSS
  if (/^(https?:|mailto:|data:|\/|#|\.)/.test(s)) return true;
  if (/^[a-z]+(-[a-z]+)+$/.test(s)) return true; // ids
  if (/^(application|image|audio|text)\//.test(s)) return true;
  if (/^(GET|POST|PUT|DELETE|Bearer|sk-|ek_)/.test(s)) return true;
  return false;
}
function ehTextoUI(s) {
  if (pareceCodigo(s)) return false;
  return / /.test(s) || /[À-ú]/.test(s) || /^[A-ZÀ-Ú][a-zà-ú]+[.!?…]?$/.test(s) || /^[A-ZÀ-Ú][a-zà-ú]+ ?[•…]$/.test(s);
}

// ----- HTML: blocos com marcação interna viram uma unidade; o resto, texto puro.
function html(arquivo) {
  let s = readFileSync(arquivo, "utf8").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const ti = s.match(/<title>([\s\S]*?)<\/title>/); if (ti) t.add(limpo(decodificar(ti[1])));
  for (const m of s.matchAll(/<meta name="description" content="([^"]*)"/g)) t.add(limpo(decodificar(m[1])));
  for (const m of s.matchAll(/\s(placeholder|title|aria-label|alt)="([^"]*)"/g)) { const v = limpo(decodificar(m[2])); if (v && ehTextoUI(v)) t.add(v); }
  s = s.replace(/<title>[\s\S]*?<\/title>/, "");
  const BLOCO = /<(p|li|h1|h2|h3|summary|label|td|span|small)\b[^>]*>((?:(?!<\/?(?:p|li|h1|h2|h3|ul|ol|div|section|article|summary|details|table)\b)[\s\S])*?)<\/\1>/g;
  s = s.replace(BLOCO, (bloco, _tag, dentro) => {
    if (/<(a|strong|em|b|small|br|span|code)\b/.test(dentro) && !/<(input|select|button|svg|img)\b/.test(dentro)) {
      const texto = limpo(decodificar(dentro.replace(/<[^>]+>/g, "")));
      if (texto && temLetra(texto)) { h.set(texto, limpo(dentro)); return ""; }
    }
    return bloco;
  });
  for (const m of s.replace(/<svg[\s\S]*?<\/svg>/g, "").matchAll(/>([^<>]+)</g)) {
    const v = limpo(decodificar(m[1]));
    if (v && temLetra(v) && !pareceCodigo(v)) t.add(v);
  }
}

// ----- JavaScript: literais com texto para pessoas; templates com ${...} viram padrões {0}, {1}…
function js(arquivo, soMensagens) {
  const s = readFileSync(arquivo, "utf8");
  const contexto = /(erro|resumo|resposta|mensagem|motivo|texto|titulo|aviso|detalhe)\s*:\s*$|new Error\(\s*$|aviso\(\s*$|json\(\{\s*erro:\s*$/;
  for (const m of s.matchAll(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    const v = m[2].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'");
    if (soMensagens && !contexto.test(s.slice(Math.max(0, m.index - 40), m.index))) continue;
    v.split("\n").map(limpo).forEach(x => { if (x && ehTextoUI(x) && x.length < 600) t.add(x); });
  }
  for (const m of s.matchAll(/`((?:\\.|[^`\\])*)`/g)) {
    const corpo = m[1];
    if (soMensagens && !contexto.test(s.slice(Math.max(0, m.index - 40), m.index))) continue;
    if (/^(SELECT|INSERT|UPDATE|CREATE|DELETE|ALTER)\b/.test(corpo.trim()) || corpo.length > 400) continue;
    let n = 0, aninhado = false;
    const padrao = limpo(corpo.replace(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_x, dentro) => { if (/[`"']/.test(dentro) && /[A-Za-zÀ-ú]{3,} [A-Za-zÀ-ú]{3,}/.test(dentro)) aninhado = true; return "{" + (n++) + "}"; }));
    if (!padrao || !temLetra(padrao.replace(/\{\d+\}/g, ""))) continue;
    if (pareceCodigo(padrao.replace(/\{\d+\}/g, "x"))) continue;
    if (!/[A-Za-zÀ-ú]{3,}/.test(padrao.replace(/\{\d+\}/g, ""))) continue;
    if (n === 0) { if (ehTextoUI(padrao)) t.add(padrao); }
    else if (/[a-zà-ú]{3,}/i.test(padrao.replace(/\{\d+\}/g, "")) && !/^[{}\d\s·:/.,-]+$/.test(padrao)) p.add(padrao);
    if (aninhado) { /* os textos de dentro já entram como literais */ }
  }
}

const modo = process.argv[2] || "extrair";
for (const f of readdirSync("public").filter(f => f.endsWith(".html"))) html("public/" + f);
for (const f of ["app.js", "site.js", "auth.js", "contato.js"]) js("public/assets/js/" + f, false);
for (const f of ["src/worker.js", "src/marketing.js"]) js(f, true);
for (const k of h.keys()) t.delete(k);
const fonte = { t: Object.fromEntries([...t].sort().map(k => [k, ""])), h: Object.fromEntries([...h].sort()), p: Object.fromEntries([...p].sort().map(k => [k, ""])) };

if (modo === "extrair") {
  writeFileSync("i18n-fonte.json", JSON.stringify(fonte, null, 1));
  console.log(`textos: ${Object.keys(fonte.t).length} · blocos: ${Object.keys(fonte.h).length} · padrões: ${Object.keys(fonte.p).length} → i18n-fonte.json`);
} else {
  let falta = 0;
  for (const l of IDIOMAS) {
    const arq = `public/assets/i18n/${l}.json`;
    const d = existsSync(arq) ? JSON.parse(readFileSync(arq, "utf8")) : {};
    const sem = ["t", "h", "p"].reduce((n, k) => n + Object.keys(fonte[k]).filter(x => !(d[k] || {})[x]).length, 0);
    falta += sem;
    console.log(`${l}: ${sem ? sem + " texto(s) sem tradução" : "completo"}`);
  }
  if (process.argv.includes("--listar")) {
    const d = JSON.parse(readFileSync("public/assets/i18n/en.json", "utf8"));
    for (const k of ["t", "h", "p"]) for (const x of Object.keys(fonte[k])) if (!(d[k] || {})[x]) console.log(k, "|", x);
  }
  process.exitCode = 0;
}
