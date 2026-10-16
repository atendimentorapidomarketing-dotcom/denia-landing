// Arquivos do site (pasta public/), com as mesmas regras da Cloudflare usadas no wrangler.jsonc:
// html_handling "drop-trailing-slash" e not_found_handling "404-page".
import { stat, readFile } from "node:fs/promises";
import path from "node:path";

const TIPOS = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf", ".wasm": "application/wasm"
};

export function criarArquivos(raiz) {
  raiz = path.resolve(raiz);
  async function arquivo(rel) {
    const alvo = path.resolve(raiz, "." + rel);
    if (alvo !== raiz && !alvo.startsWith(raiz + path.sep)) return null;
    try { const s = await stat(alvo); return s.isFile() ? { alvo, s } : null; } catch { return null; }
  }
  async function servir(request, achado, status = 200) {
    const { alvo, s } = achado;
    const etag = `"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`;
    const headers = new Headers({ "content-type": TIPOS[path.extname(alvo).toLowerCase()] || "application/octet-stream", etag, "cache-control": "public, max-age=0, must-revalidate" });
    if (status === 200 && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    headers.set("content-length", String(s.size));
    return new Response(request.method === "HEAD" ? null : await readFile(alvo), { status, headers });
  }
  const redirecionar = (url, caminho) => new Response(null, { status: 307, headers: { location: caminho + url.search } });

  return {
    async fetch(entrada) {
      const request = entrada instanceof Request ? entrada : new Request(entrada);
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      let caminho;
      try { caminho = decodeURIComponent(url.pathname); } catch { return new Response("Bad Request", { status: 400 }); }
      if (caminho.includes("\0")) return new Response("Bad Request", { status: 400 });

      if (caminho === "/" || caminho === "/index.html") {
        const idx = await arquivo("/index.html");
        if (caminho === "/index.html" && idx) return redirecionar(url, "/");
        if (idx) return servir(request, idx);
      } else if (caminho.endsWith("/")) {
        const sem = caminho.replace(/\/+$/, "");
        if (await arquivo(sem + ".html") || await arquivo(sem + "/index.html")) return redirecionar(url, url.pathname.replace(/\/+$/, ""));
      } else if (caminho.endsWith("/index.html")) {
        if (await arquivo(caminho)) return redirecionar(url, url.pathname.slice(0, -"/index.html".length) || "/");
      } else if (caminho.endsWith(".html")) {
        if (await arquivo(caminho)) return redirecionar(url, url.pathname.slice(0, -".html".length));
      } else {
        const achado = await arquivo(caminho) || await arquivo(caminho + ".html") || await arquivo(caminho + "/index.html");
        if (achado) return servir(request, achado);
      }
      // Página 404 mais próxima.
      let pasta = path.posix.dirname(caminho.endsWith("/") ? caminho + "x" : caminho);
      for (;;) {
        const p404 = await arquivo(path.posix.join(pasta, "404.html"));
        if (p404) return servir(request, p404, 404);
        if (pasta === "/" || pasta === ".") break;
        pasta = path.posix.dirname(pasta);
      }
      return new Response("Not Found", { status: 404 });
    }
  };
}
