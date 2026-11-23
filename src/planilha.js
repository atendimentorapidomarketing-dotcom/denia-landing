// DENIA Platform — planilha Excel (.xlsx) sem dependências.
// Um .xlsx é um zip com alguns XML. Aqui o zip é "armazenado" (sem compressão), o que o Excel,
// o Google Planilhas e o LibreOffice abrem normalmente. Cada aba: { nome, linhas: [[...], ...], larguras? }.
// A primeira linha de cada aba sai em negrito (cabeçalho); números viram números, o resto vira texto.

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function zip(arquivos) {
  const enc = new TextEncoder();
  const partes = [], central = [];
  let pos = 0;
  for (const { nome, conteudo } of arquivos) {
    const n = enc.encode(nome), dados = typeof conteudo === "string" ? enc.encode(conteudo) : conteudo, crc = crc32(dados);
    const cab = new DataView(new ArrayBuffer(30));
    cab.setUint32(0, 0x04034b50, true); cab.setUint16(4, 20, true); cab.setUint16(6, 0x0800, true); cab.setUint16(8, 0, true);
    cab.setUint16(10, 0, true); cab.setUint16(12, 0x21, true); cab.setUint32(14, crc, true); cab.setUint32(18, dados.length, true);
    cab.setUint32(22, dados.length, true); cab.setUint16(26, n.length, true); cab.setUint16(28, 0, true);
    partes.push(new Uint8Array(cab.buffer), n, dados);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true); cd.setUint16(14, 0x21, true); cd.setUint32(16, crc, true); cd.setUint32(20, dados.length, true); cd.setUint32(24, dados.length, true);
    cd.setUint16(28, n.length, true); cd.setUint32(42, pos, true);
    central.push(new Uint8Array(cd.buffer), n);
    pos += 30 + n.length + dados.length;
  }
  const tamCentral = central.reduce((s, p) => s + p.length, 0);
  const fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054b50, true); fim.setUint16(8, arquivos.length, true); fim.setUint16(10, arquivos.length, true);
  fim.setUint32(12, tamCentral, true); fim.setUint32(16, pos, true);
  const todas = [...partes, ...central, new Uint8Array(fim.buffer)];
  const saida = new Uint8Array(todas.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of todas) { saida.set(p, o); o += p.length; }
  return saida;
}

const esc = v => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function coluna(i) { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
// Estilos (índice no styles.xml). Uma célula pode ser um valor simples ou { v, s: "nome do estilo" }.
// Abas com tabela: { cabecalho: n } = linha (0-based) do cabeçalho; as linhas abaixo ganham bordas e zebra,
// o cabeçalho ganha filtro e fica congelado. Sem "cabecalho", a primeira linha é o cabeçalho (como antes).
const ESTILO = { normal: 0, cab: 1, titulo: 2, sub: 3, kpi: 4, kpiv: 5, txt: 6, num: 7, pct: 8, total: 9, totaln: 10, nota: 11, zt: 12, zn: 13, zp: 14, barra: 15, zbarra: 16, secao: 17, dec: 18, zdec: 19, totalp: 20, kpip: 21, bom: 22, ruim: 23, kpia: 24, kpiap: 25 };
function abaXml(aba, primeira) {
  const { linhas, larguras } = aba;
  const cab = Number.isInteger(aba.cabecalho) ? aba.cabecalho : 0;
  const tabela = Number.isInteger(aba.cabecalho);
  const cols = (larguras || []).length ? `<cols>${larguras.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const ncol = Math.max(1, ...linhas.map(l => (l || []).length));
  const dim = `A1:${coluna(ncol - 1)}${Math.max(1, linhas.length)}`;
  const fimTabela = tabela ? (aba.fimTabela ?? linhas.length - 1) : -1;
  const rows = linhas.map((linha, r) => {
    const alto = (linha || []).some(v => v && typeof v === "object" && v.s === "titulo") ? ' ht="30" customHeight="1"' : (linha || []).some(v => v && typeof v === "object" && (v.s === "kpiv" || v.s === "kpip")) ? ' ht="22" customHeight="1"' : "";
    return `<row r="${r + 1}"${alto}>${(linha || []).map((v0, c) => {
      const obj = v0 && typeof v0 === "object" && !(v0 instanceof Date) ? v0 : { v: v0 };
      const v = obj.v, ref = coluna(c) + (r + 1);
      let s = obj.s ? ESTILO[obj.s] ?? 0 : r === cab ? ESTILO.cab : 0;
      if (!obj.s && tabela && r > cab && r <= fimTabela) {
        const zebra = (r - cab) % 2 === 0;
        s = typeof v === "number" ? (zebra ? ESTILO.zn : ESTILO.num) : (zebra ? ESTILO.zt : ESTILO.txt);
      } else if (obj.s && tabela && r > cab && r <= fimTabela && (r - cab) % 2 === 0) {
        s = { pct: ESTILO.zp, barra: ESTILO.zbarra, dec: ESTILO.zdec }[obj.s] ?? s;
      }
      const st = s ? ` s="${s}"` : "";
      if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
      if (v === null || v === undefined || v === "") return s ? `<c r="${ref}"${st}/>` : "";
      return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join("")}</row>`;
  }).join("");
  // Cabeçalho congelado (como o Excel grava): painel + seleção.
  const fr = cab + 1, fc = Number(aba.congelarColunas) || 0;
  const pane = fc ? `<pane xSplit="${fc}" ySplit="${fr}" topLeftCell="${coluna(fc)}${fr + 1}" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="${coluna(fc)}${fr + 1}" sqref="${coluna(fc)}${fr + 1}"/>`
    : `<pane ySplit="${fr}" topLeftCell="A${fr + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${fr + 1}" sqref="A${fr + 1}"/>`;
  const vista = `<sheetViews><sheetView${primeira ? ' tabSelected="1"' : ""}${aba.semGrade ? ' showGridLines="0"' : ""} workbookViewId="0">${aba.congelar === false ? "" : pane}</sheetView></sheetViews>`;
  const ncolTab = tabela ? Math.max(1, (linhas[cab] || []).length) : 0;
  const filtro = tabela && aba.filtro !== false && fimTabela > cab ? `<autoFilter ref="A${cab + 1}:${coluna(ncolTab - 1)}${fimTabela + 1}"/>` : "";
  const mescla = (aba.mesclar || []).length ? `<mergeCells count="${aba.mesclar.length}">${aba.mesclar.map(m => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  const pagina = `<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${aba.retrato ? "portrait" : "landscape"}" fitToWidth="1" fitToHeight="0"/><headerFooter><oddFooter>&amp;L${esc(aba.rodape || "DENIA")}&amp;RPágina &amp;P de &amp;N</oddFooter></headerFooter>`;
  const ajuste = `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${ajuste}<dimension ref="${dim}"/>${vista}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>${filtro}${mescla}${pagina}</worksheet>`;
}
// Cores sóbrias (azul-marinho, cinza e zebra clara), bordas finas, números com milhar e porcentagem.
const ESTILOS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>
<fonts count="9"><font><sz val="10"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="18"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font><font><i/><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="10"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="10"/><name val="Calibri"/><family val="2"/></font><font><sz val="10"/><color rgb="FF2E75B6"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="12"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDEEAF6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCE4D6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border><border><left/><right/><top style="medium"><color rgb="FF1F3864"/></top><bottom style="medium"><color rgb="FF1F3864"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="26">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="5" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="0" fontId="6" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="6" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="165" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="0" fontId="7" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="7" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="8" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="4" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="165" fontId="6" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="165" fontId="5" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
// Barrinha de gráfico dentro da célula (funciona no Excel, Google Planilhas e LibreOffice).
export const barra = (v, max, largura = 16) => max > 0 && v > 0 ? "█".repeat(Math.max(1, Math.round((v / max) * largura))) : "";

// Estrutura igual à de um arquivo salvo pelo Excel (com bookViews e docProps), para o Excel do computador
// abrir com todas as abas visíveis embaixo.
export function gerarXlsx(abas) {
  const nomes = abas.map((a, i) => esc(String(a.nome || `Aba ${i + 1}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31)));
  const agora = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return zip([
    { nome: "[Content_Types].xml", conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${abas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { nome: "_rels/.rels", conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { nome: "docProps/core.xml", conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>DENIA</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${agora}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${agora}</dcterms:modified></cp:coreProperties>` },
    { nome: "docProps/app.xml", conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Excel</Application><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Planilhas</vt:lpstr></vt:variant><vt:variant><vt:i4>${abas.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${abas.length}" baseType="lpstr">${nomes.map(n => `<vt:lpstr>${n}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts></Properties>` },
    { nome: "xl/workbook.xml", conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr defaultThemeVersion="164011"/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000" tabRatio="600" activeTab="0" showSheetTabs="1"/></bookViews><sheets>${nomes.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { nome: "xl/_rels/workbook.xml.rels", conteudo: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${abas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { nome: "xl/styles.xml", conteudo: ESTILOS_XML },
    ...abas.map((a, i) => ({ nome: `xl/worksheets/sheet${i + 1}.xml`, conteudo: abaXml(a, i === 0) }))
  ]);
}
