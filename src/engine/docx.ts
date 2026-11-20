// Gera um .docx (Word) a partir do texto e das imagens das páginas.
// O MuPDF desta versão não traz o gravador de DOCX, então o pacote é montado aqui:
// um ZIP com o XML do WordprocessingML.
import { deflateRawSync } from "node:zlib";

export type RGB = [number, number, number];

export interface DocxRun { text: string; family: string; size: number; color: RGB; bold: boolean; italic: boolean }
export interface DocxPara {
  kind: "p";
  runs: DocxRun[];          // "\n" no texto vira quebra de linha
  indent: number;           // recuo à esquerda, em pontos
  spaceBefore: number;      // espaço antes, em pontos
  align: "left" | "center" | "right" | "both";
}
export interface DocxImage { kind: "img"; data: Uint8Array; ext: "png" | "jpeg"; width: number; height: number; indent: number; spaceBefore: number }
export interface DocxPage {
  width: number; height: number; // pontos
  margins: { top: number; right: number; bottom: number; left: number };
  items: (DocxPara | DocxImage)[];
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const tw = (pt: number) => Math.max(0, Math.round(pt * 20));       // pontos → vigésimos de ponto
const emu = (pt: number) => Math.max(1, Math.round(pt * 12700));   // pontos → EMU

/** Texto seguro para XML (sem caracteres de controle, que o Word recusa). */
export function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const hex = (c: RGB) => c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();

function runXml(r: DocxRun): string {
  const f = xmlText(r.family);
  let pr = `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}" w:eastAsia="${f}"/>`;
  if (r.bold) pr += "<w:b/><w:bCs/>";
  if (r.italic) pr += "<w:i/><w:iCs/>";
  const c = hex(r.color);
  if (c !== "000000") pr += `<w:color w:val="${c}"/>`;
  const hp = Math.max(2, Math.round(r.size * 2));
  pr += `<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`;
  // quebras de linha e tabulações viram elementos próprios
  const parts = r.text.split(/(\n|\t)/);
  let body = "";
  for (const p of parts) {
    if (p === "\n") body += "<w:br/>";
    else if (p === "\t") body += "<w:tab/>";
    else if (p) body += `<w:t xml:space="preserve">${xmlText(p)}</w:t>`;
  }
  return `<w:r><w:rPr>${pr}</w:rPr>${body}</w:r>`;
}

function paraXml(p: DocxPara): string {
  const ppr = `<w:pPr><w:spacing w:before="${tw(p.spaceBefore)}" w:after="0" w:line="240" w:lineRule="auto"/>` +
    (p.indent > 1 ? `<w:ind w:left="${tw(p.indent)}"/>` : "") +
    (p.align !== "left" ? `<w:jc w:val="${p.align}"/>` : "") + "</w:pPr>";
  return `<w:p>${ppr}${p.runs.map(runXml).join("")}</w:p>`;
}

function imageXml(img: DocxImage, rid: string, n: number): string {
  const cx = emu(img.width), cy = emu(img.height);
  return `<w:p><w:pPr><w:spacing w:before="${tw(img.spaceBefore)}" w:after="0"/>` +
    (img.indent > 1 ? `<w:ind w:left="${tw(img.indent)}"/>` : "") + "</w:pPr>" +
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${n}" name="Imagem ${n}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="${n}" name="imagem${n}.${img.ext === "png" ? "png" : "jpg"}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function sectXml(pg: DocxPage, nextPage: boolean): string {
  const land = pg.width > pg.height;
  const m = pg.margins;
  return `<w:sectPr>${nextPage ? '<w:type w:val="nextPage"/>' : ""}` +
    `<w:pgSz w:w="${tw(pg.width)}" w:h="${tw(pg.height)}"${land ? ' w:orient="landscape"' : ""}/>` +
    `<w:pgMar w:top="${tw(m.top)}" w:right="${tw(m.right)}" w:bottom="${tw(m.bottom)}" w:left="${tw(m.left)}" w:header="360" w:footer="360" w:gutter="0"/>` +
    "</w:sectPr>";
}

/** Monta o .docx. Cada página do PDF vira uma seção (mantém tamanho e orientação de cada uma). */
export function buildDocx(pages: DocxPage[], title: string): Uint8Array {
  const media: { name: string; data: Uint8Array; rid: string }[] = [];
  let body = "";
  let n = 0;
  pages.forEach((pg, i) => {
    for (const it of pg.items) {
      if (it.kind === "p") body += paraXml(it);
      else {
        n++;
        const name = `imagem${n}.${it.ext === "png" ? "png" : "jpeg"}`;
        const rid = `rIdImg${n}`;
        media.push({ name, data: it.data, rid });
        body += imageXml(it, rid, n);
      }
    }
    // Cada seção é descrita no último parágrafo dela (a última, no fim do corpo);
    // da segunda em diante, cada uma começa em página nova.
    if (i < pages.length - 1) body += `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/>${sectXml(pg, i > 0)}</w:pPr></w:p>`;
  });
  const last = pages[pages.length - 1] ?? { width: 595, height: 842, margins: { top: 72, right: 72, bottom: 72, left: 72 }, items: [] };
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body}${sectXml(last, pages.length > 1)}</w:body></w:document>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join("") +
    "</Relationships>";

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;

  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    "</Types>";

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    "</Relationships>";

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${xmlText(title)}</dc:title><dc:creator>PapyrusPDF</dc:creator></cp:coreProperties>`;

  const enc = new TextEncoder();
  return zip([
    { name: "[Content_Types].xml", data: enc.encode(types) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "docProps/core.xml", data: enc.encode(core) },
    { name: "word/document.xml", data: enc.encode(document) },
    { name: "word/styles.xml", data: enc.encode(styles) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(rels) },
    ...media.map((m) => ({ name: `word/media/${m.name}`, data: m.data, stored: true })),
  ]);
}

// ---------- ZIP ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP simples: XML compactado (deflate), imagens guardadas como estão (já são comprimidas). */
export function zip(files: { name: string; data: Uint8Array; stored?: boolean }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // data fixa (1/1/2026): o arquivo gerado não depende do relógio
  const time = 0, date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = enc.encode(f.name);
    const comp = f.stored ? f.data : new Uint8Array(deflateRawSync(f.data, { level: 6 }));
    const method = f.stored ? 0 : 8;
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // nomes em UTF-8
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, comp.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, comp);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, comp.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + comp.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

/** Lê um ZIP gerado por `zip` (para os testes conferirem o conteúdo). */
export async function unzip(data: Uint8Array): Promise<Map<string, Uint8Array>> {
  const { inflateRawSync } = await import("node:zlib");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Map<string, Uint8Array>();
  let p = 0;
  const dec = new TextDecoder();
  while (p + 30 <= data.length && dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true);
    const size = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true), extra = dv.getUint16(p + 28, true);
    const name = dec.decode(data.subarray(p + 30, p + 30 + nameLen));
    const start = p + 30 + nameLen + extra;
    const raw = data.subarray(start, start + size);
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw);
    p = start + size;
  }
  return out;
}
