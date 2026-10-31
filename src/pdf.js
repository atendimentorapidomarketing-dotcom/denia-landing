// DENIA Platform — PDF sem dependências (relatórios e propostas).
// Páginas A4 com texto (Helvetica, acentos do português pela codificação WinAnsi), faixas coloridas, tabelas
// simples, barras e uma logo em JPEG. Uso: gerarPdf({ titulo, subtitulo, logo: {bytes, largura, altura}, blocos }).
// Blocos: { tipo: "titulo" | "texto" | "metricas" | "tabela" | "lista" | "espaco" | "quebra", ... }.

const A4 = { l: 595.28, a: 841.89 }, MARGEM = 46;
const cor = hex => { const n = parseInt(String(hex || "#000").replace("#", ""), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255].map(v => v.toFixed(3)).join(" "); };
// Texto em WinAnsi: letras do português ficam iguais (Latin-1); o resto vira "?" (sem quebrar o arquivo).
function winAnsi(t) {
  let s = "";
  for (const ch of String(t ?? "").normalize("NFC")) {
    const c = ch.codePointAt(0);
    if (ch === "—" || ch === "–") s += "-";
    else if (ch === "“" || ch === "”") s += '"';
    else if (ch === "‘" || ch === "’") s += "'";
    else if (ch === "•") s += "\x95";
    else if (ch === "★") s += "*";
    else if (c < 32) s += " ";
    else if (c < 256) s += ch;
    else s += "?";
  }
  return s.replace(/[\\()]/g, m => "\\" + m);
}
// Larguras aproximadas da Helvetica (em milésimos do tamanho), para quebrar linhas.
const LARGURA = c => /[il.,:;'|!]/.test(c) ? 260 : /[fjtrI\s]/.test(c) ? 320 : /[mwMW]/.test(c) ? 860 : /[A-Z0-9]/.test(c) ? 660 : 540;
const medir = (t, tam) => [...String(t)].reduce((s, c) => s + LARGURA(c), 0) * tam / 1000;
function quebrar(t, tam, largura) {
  const linhas = [];
  for (const par of String(t ?? "").split("\n")) {
    let atual = "";
    for (const p of par.split(/\s+/)) { const tentativa = atual ? atual + " " + p : p; if (medir(tentativa, tam) > largura && atual) { linhas.push(atual); atual = p; } else atual = tentativa; }
    linhas.push(atual);
  }
  return linhas;
}

export function gerarPdf({ titulo = "", subtitulo = "", rodape = "", corPrincipal = "#4f46e5", logo = null, blocos = [] }) {
  const paginas = [];
  let ops = [], y = 0;
  const larguraUtil = A4.l - 2 * MARGEM;
  const texto = (x, yy, t, tam = 10, negrito = false, c = "#1f2937") => ops.push(`BT /${negrito ? "F2" : "F1"} ${tam} Tf ${cor(c)} rg ${x.toFixed(1)} ${yy.toFixed(1)} Td (${winAnsi(t)}) Tj ET`);
  const ret = (x, yy, l, a, c) => ops.push(`${cor(c)} rg ${x.toFixed(1)} ${yy.toFixed(1)} ${l.toFixed(1)} ${a.toFixed(1)} re f`);
  const novaPagina = () => {
    if (ops.length) paginas.push(ops);
    ops = [];
    ret(0, A4.a - 92, A4.l, 92, corPrincipal);
    let xTit = MARGEM;
    if (logo) { const a = 56, l = Math.min(140, a * logo.largura / logo.altura); ops.push(`q ${l.toFixed(1)} 0 0 ${a} ${MARGEM} ${A4.a - 74} cm /Logo Do Q`); xTit += l + 14; }
    texto(xTit, A4.a - 44, titulo, 18, true, "#ffffff");
    if (subtitulo) texto(xTit, A4.a - 64, subtitulo, 10, false, "#e0e7ff");
    if (rodape) texto(MARGEM, 24, rodape, 8, false, "#6b7280");
    texto(A4.l - MARGEM - 40, 24, `Página ${paginas.length + 1}`, 8, false, "#6b7280");
    y = A4.a - 120;
  };
  const caber = alt => { if (y - alt < 50) novaPagina(); };
  novaPagina();
  for (const b of blocos) {
    if (b.tipo === "quebra") { novaPagina(); continue; }
    if (b.tipo === "espaco") { y -= b.altura || 10; continue; }
    if (b.tipo === "titulo") { caber(40); y -= 8; texto(MARGEM, y - 14, b.texto, 13, true, "#111827"); ret(MARGEM, y - 22, 40, 2.5, corPrincipal); y -= 34; continue; }
    if (b.tipo === "texto") {
      const tam = b.tamanho || 10;
      for (const l of quebrar(b.texto, tam, larguraUtil)) { caber(tam + 5); texto(MARGEM, y - tam, l, tam, Boolean(b.negrito), b.cor || "#374151"); y -= tam + 5; }
      y -= 4; continue;
    }
    if (b.tipo === "lista") {
      for (const it of b.itens || []) {
        const linhas = quebrar(it.texto ?? it, 10, larguraUtil - 18);
        caber(linhas.length * 15 + 4);
        ret(MARGEM, y - 10, 7, 7, it.cor || corPrincipal);
        linhas.forEach((l, i) => { texto(MARGEM + 16, y - 10, l, 10, i === 0 && Boolean(it.negrito), "#374151"); y -= 15; });
        y -= 3;
      }
      y -= 4; continue;
    }
    if (b.tipo === "metricas") {
      const n = Math.min(4, (b.itens || []).length) || 1, gap = 10, l = (larguraUtil - gap * (n - 1)) / n, a = 62;
      for (let i = 0; i < b.itens.length; i += n) {
        caber(a + 10);
        b.itens.slice(i, i + n).forEach((m, j) => {
          const x = MARGEM + j * (l + gap);
          ret(x, y - a, l, a, "#f3f4f6"); ret(x, y - a, 3, a, m.cor || corPrincipal);
          let rot = String(m.rotulo).toUpperCase(); while (rot.length > 4 && medir(rot, 7.5) * 1.12 > l - 18) rot = rot.slice(0, -1); texto(x + 12, y - 18, rot === String(m.rotulo).toUpperCase() ? rot : rot.trimEnd() + "…", 7.5, true, "#6b7280");
          texto(x + 12, y - 40, m.valor, 17, true, "#111827");
          if (m.nota) { let n2 = String(m.nota); while (n2.length > 4 && medir(n2, 7.5) > l - 18) n2 = n2.slice(0, -1); texto(x + 12, y - 54, n2, 7.5, false, "#6b7280"); }
        });
        y -= a + 12;
      }
      continue;
    }
    if (b.tipo === "tabela") {
      const cols = b.colunas || [], pesos = b.larguras || cols.map(() => 1), soma = pesos.reduce((s, v) => s + v, 0);
      const ls = pesos.map(p => larguraUtil * p / soma), alt = 20;
      const cab = () => { caber(alt * 2); ret(MARGEM, y - alt, larguraUtil, alt, "#e5e7eb"); let x = MARGEM; cols.forEach((c, i) => { texto(x + 6, y - 13.5, c, 8, true, "#374151"); x += ls[i]; }); y -= alt; };
      cab();
      (b.linhas || []).forEach((lin, k) => {
        if (y - alt < 50) { novaPagina(); cab(); }
        if (k % 2) ret(MARGEM, y - alt, larguraUtil, alt, "#f9fafb");
        let x = MARGEM;
        lin.forEach((v, i) => { let t = String(v ?? ""); while (t.length > 3 && medir(t, 9) > ls[i] - 10) t = t.slice(0, -2); texto(x + 6, y - 13.5, t === String(v ?? "") ? t : t + "…", 9, false, "#1f2937"); x += ls[i]; });
        y -= alt;
      });
      y -= 12; continue;
    }
  }
  paginas.push(ops);

  // Monta o arquivo: catálogo, páginas, fontes, logo e conteúdos.
  const objs = [];
  const add = conteudo => { objs.push(conteudo); return objs.length; };
  const catalogo = add(null), arvore = add(null);
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const img = logo ? add({ img: logo }) : 0;
  const filhos = [];
  for (const p of paginas) {
    const corpo = p.join("\n");
    const cont = add({ stream: corpo });
    filhos.push(add(`<< /Type /Page /Parent ${arvore} 0 R /MediaBox [0 0 ${A4.l} ${A4.a}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${img ? ` /XObject << /Logo ${img} 0 R >>` : ""} >> /Contents ${cont} 0 R >>`));
  }
  objs[catalogo - 1] = `<< /Type /Catalog /Pages ${arvore} 0 R >>`;
  objs[arvore - 1] = `<< /Type /Pages /Kids [${filhos.map(f => f + " 0 R").join(" ")}] /Count ${filhos.length} >>`;
  const partes = [], offsets = [];
  let tam = 0;
  const pôr = b => { partes.push(b); tam += b.length; };
  const bin = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
  pôr(bin("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"));
  objs.forEach((o, i) => {
    offsets.push(tam);
    if (o && o.stream !== undefined) { const s = bin(o.stream); pôr(bin(`${i + 1} 0 obj\n<< /Length ${s.length} >>\nstream\n`)); pôr(s); pôr(bin("\nendstream\nendobj\n")); }
    else if (o && o.img) { const d = o.img.bytes; pôr(bin(`${i + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${o.img.largura} /Height ${o.img.altura} /ColorSpace /${o.img.componentes === 1 ? "DeviceGray" : o.img.componentes === 4 ? "DeviceCMYK" : "DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode /Length ${d.length} >>\nstream\n`)); pôr(d); pôr(bin("\nendstream\nendobj\n")); }
    else pôr(bin(`${i + 1} 0 obj\n${o}\nendobj\n`));
  });
  const xref = tam;
  pôr(bin(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root ${catalogo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  const saida = new Uint8Array(tam);
  let o = 0; for (const p of partes) { saida.set(p, o); o += p.length; }
  return saida;
}

// Dimensões de um JPEG (para usar a logo no PDF). Devolve null se não for JPEG.
export function dimensoesJpeg(bytes) {
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return null;
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const m = bytes[i + 1], len = bytes[i + 2] << 8 | bytes[i + 3];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { altura: bytes[i + 5] << 8 | bytes[i + 6], largura: bytes[i + 7] << 8 | bytes[i + 8], componentes: bytes[i + 9] };
    i += 2 + len;
  }
  return null;
}
