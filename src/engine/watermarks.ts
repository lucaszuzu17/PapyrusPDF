// Remove marcas d'água sem mexer no resto da página.
//
// Reconhece:
// - anotações do tipo Watermark;
// - conteúdo marcado como marca d'água (/Artifact << /Subtype /Watermark >> BDC … EMC), como gravam o Acrobat,
//   o Foxit e o próprio PapyrusPDF;
// - camadas (OCG) chamadas "Watermark" ou "Marca d'água";
// - formulários (XObject) que o Acrobat identifica como marca d'água (/PieceInfo … /Private /Watermark);
// - a marca d'água do Word: ele a grava como parte do cabeçalho (/Artifact /Header). É um trecho do
//   cabeçalho que fica no meio da página e é grande; cabeçalhos de verdade ficam na margem de cima;
// - marcas d'água de versões antigas do PapyrusPDF, que ainda não eram marcadas.
import * as mupdf from "mupdf";
import type { Rect } from "./types.ts";

export interface ContentOp { op: string; start: number; end: number; args: string }

const DELIM = /[\s()<>\[\]{}\/%]/;
const isDelim = (ch: string | undefined) => ch === undefined || DELIM.test(ch);

/**
 * Divide o conteúdo da página em operadores. `start` é o começo dos operandos do operador
 * (logo depois do operador anterior) e `end`, o fim do próprio operador; `args` é o texto dos operandos.
 */
export function scanContent(src: string): ContentOp[] {
  const ops: ContentOp[] = [];
  const n = src.length;
  let i = 0;
  let argStart = -1;
  const mark = () => { if (argStart < 0) argStart = i; };
  while (i < n) {
    const ch = src[i];
    if (ch === "%") { while (i < n && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "(") {
      mark();
      let level = 1; i++;
      while (i < n && level > 0) { if (src[i] === "\\") i++; else if (src[i] === "(") level++; else if (src[i] === ")") level--; i++; }
      continue;
    }
    if (ch === "<" && src[i + 1] === "<") {
      mark();
      let level = 0;
      while (i < n) {
        if (src[i] === "<" && src[i + 1] === "<") { level++; i += 2; continue; }
        if (src[i] === ">" && src[i + 1] === ">") { level--; i += 2; if (level === 0) break; continue; }
        if (src[i] === "(") { let l = 1; i++; while (i < n && l > 0) { if (src[i] === "\\") i++; else if (src[i] === "(") l++; else if (src[i] === ")") l--; i++; } continue; }
        i++;
      }
      continue;
    }
    if (ch === "<") { mark(); while (i < n && src[i] !== ">") i++; i++; continue; }
    if (ch === "[" || ch === "]" || ch === "{" || ch === "}") { mark(); i++; continue; }
    if (ch === "/") { mark(); i++; while (i < n && !isDelim(src[i])) i++; continue; }
    // número ou operador
    let j = i;
    while (j < n && !isDelim(src[j])) j++;
    const tok = src.slice(i, j);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { mark(); i = j; continue; }
    const start = argStart < 0 ? i : argStart;
    if (tok === "BI") {
      // imagem embutida: vai até o EI que fecha os dados binários
      const id = src.indexOf("ID", j);
      const m = id < 0 ? null : /\sEI(?=[\s\/\[<(]|$)/.exec(src.slice(id));
      const end = m ? id + m.index + m[0].length : n;
      ops.push({ op: "BI", start, end, args: "" });
      i = end;
    } else {
      ops.push({ op: tok, start, end: j, args: src.slice(start, i).trim() });
      i = j;
    }
    argStart = -1;
  }
  return ops;
}

// ---------- leitura das propriedades ----------

const R = (o: mupdf.PDFObject) => (o.isIndirect() ? o.resolve() : o);
const nameOf = (o: mupdf.PDFObject) => (o.isName() ? o.asName() : "");
const WATERMARK_NAME = /water\s*mark|marca\s*d.?[aá]gua/i;

/** Dicionário de propriedades de um BDC: escrito ali mesmo (<<…>>) ou um nome em /Properties. */
function bdcProps(args: string, res: mupdf.PDFObject): { tag: string; inline: string; dict: mupdf.PDFObject | null } {
  const m = /^\/([^\s\/<\[(]+)\s*([\s\S]*)$/.exec(args);
  if (!m) return { tag: "", inline: "", dict: null };
  const rest = m[2].trim();
  if (rest.startsWith("<<")) return { tag: m[1], inline: rest, dict: null };
  const ref = /^\/([^\s\/<\[(]+)/.exec(rest);
  if (!ref || !res.isDictionary()) return { tag: m[1], inline: "", dict: null };
  const props = R(res.get("Properties"));
  const d = props.isDictionary() ? R(props.get(ref[1])) : null;
  return { tag: m[1], inline: "", dict: d && d.isDictionary() ? d : null };
}

const inlineName = (txt: string, key: string) => new RegExp(`\\/${key}\\s*\\/([A-Za-z0-9_.-]+)`).exec(txt)?.[1] ?? "";

/** Tipo de um trecho marcado: marca d'água certa, cabeçalho/rodapé (para medir) ou outro. */
function sectionKind(args: string, res: mupdf.PDFObject): "watermark" | "pagination" | "other" {
  const { tag, inline, dict } = bdcProps(args, res);
  if (tag === "OC" && dict) {
    // camada opcional: vale o nome da camada (ou de alguma das camadas de um grupo)
    const names: string[] = [];
    const n = dict.get("Name");
    if (n.isString()) names.push(n.asString());
    const ocgs = R(dict.get("OCGs"));
    if (ocgs.isArray()) ocgs.forEach((o) => { const x = R(o).get("Name"); if (x.isString()) names.push(x.asString()); });
    return names.some((x) => WATERMARK_NAME.test(x)) ? "watermark" : "other";
  }
  if (tag !== "Artifact") return "other";
  const subtype = inline ? inlineName(inline, "Subtype") : dict ? nameOf(dict.get("Subtype")) : "";
  const type = inline ? inlineName(inline, "Type") : dict ? nameOf(dict.get("Type")) : "";
  if (/^watermark$/i.test(subtype)) return "watermark";
  if (/^(header|footer)$/i.test(subtype) || (/^pagination$/i.test(type) && !subtype)) return "pagination";
  return "other";
}

/** O XObject é uma marca d'água do Acrobat (/PieceInfo) ou está numa camada de marca d'água? */
function xobjectIsWatermark(xo: mupdf.PDFObject): boolean {
  if (!xo.isDictionary()) return false;
  const pi = R(xo.get("PieceInfo"));
  if (pi.isDictionary()) {
    let hit = false;
    pi.forEach((v) => {
      const priv = R(R(v).get("Private"));
      if (priv.isName() && /^watermark$/i.test(priv.asName())) hit = true;
    });
    if (hit) return true;
  }
  const oc = R(xo.get("OC"));
  if (oc.isDictionary()) { const n = oc.get("Name"); if (n.isString() && WATERMARK_NAME.test(n.asString())) return true; }
  return false;
}

// ---------- medida de um trecho de conteúdo ----------

/** Retângulo ocupado pelo que o trecho pinta (preenchimentos, texto e imagens; traços finos não contam). */
function measure(tmp: mupdf.PDFDocument, res: mupdf.PDFObject, mediabox: Rect, content: string): { box: Rect | null; page: Rect } {
  const ref = tmp.addPage(mediabox, 0, res, content);
  tmp.insertPage(-1, ref);
  const page = tmp.loadPage(tmp.countPages() - 1);
  let box: Rect | null = null;
  const add = (r: number[]) => {
    if (!r || !isFinite(r[0]) || r[2] < r[0]) return;
    box = box ? [Math.min(box[0], r[0]), Math.min(box[1], r[1]), Math.max(box[2], r[2]), Math.max(box[3], r[3])] : [r[0], r[1], r[2], r[3]];
  };
  const dev = new mupdf.Device({
    fillPath(path, _eo, ctm) { add(path.getBounds(null as unknown as mupdf.StrokeState, ctm)); },
    fillText(text, ctm) { add(text.getBounds(null as unknown as mupdf.StrokeState, ctm)); },
    strokeText(text, _s, ctm) { add(text.getBounds(null as unknown as mupdf.StrokeState, ctm)); },
    fillImage(_img, ctm) { add(mupdf.Rect.transform([0, 0, 1, 1], ctm)); },
    fillImageMask(_img, ctm) { add(mupdf.Rect.transform([0, 0, 1, 1], ctm)); },
  });
  try { page.run(dev, mupdf.Matrix.identity); } catch { /* conteúdo que não roda sozinho: fica sem medida */ }
  dev.close();
  const pb = page.getBounds() as Rect;
  dev.destroy(); page.destroy();
  return { box, page: pb };
}

/** Um trecho de cabeçalho do Word que, pela posição e tamanho, é a marca d'água. */
function looksLikeWatermark(box: Rect | null, page: Rect): boolean {
  if (!box) return false;
  const W = page[2] - page[0], H = page[3] - page[1];
  const bw = box[2] - box[0], bh = box[3] - box[1];
  const cy = (box[1] + box[3]) / 2 - page[1];
  if (bw > 0.9 * W && bh > 0.9 * H) return false; // papel timbrado ou moldura da página inteira
  return cy > 0.2 * H && cy < 0.8 * H && (bw > 0.3 * W || bh > 0.3 * H);
}

// ---------- remoção ----------

const toLatin1 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return s; };
const fromLatin1 = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };

/**
 * Remove (ou só conta, com `dryRun`) as marcas d'água de uma página. Devolve quantas achou.
 * Precisa estar dentro de uma operação do documento (para poder desfazer).
 */
export function removePageWatermarks(doc: mupdf.PDFDocument, index: number, dryRun = false): number {
  const page = doc.loadPage(index);
  let count = 0;
  // anotações de marca d'água
  for (const a of page.getAnnotations()) {
    if (a.getType() === "Watermark") { count++; if (!dryRun) page.deleteAnnotation(a); }
  }
  const pageObj = page.getObject();
  page.destroy();

  const contents = pageObj.get("Contents");
  const parts: mupdf.PDFObject[] = [];
  if (contents.isArray()) contents.forEach((v) => parts.push(v));
  else if (!contents.isNull()) parts.push(contents);
  if (!parts.length) return count;
  let src: string;
  try { src = parts.map((p) => toLatin1(p.readStream().asUint8Array())).join("\n"); } catch { return count; }

  const res = R(pageObj.getInheritable("Resources"));
  const xobjects = res.isDictionary() ? R(res.get("XObject")) : null;
  const mb = R(pageObj.getInheritable("MediaBox"));
  const mediabox: Rect = mb.isArray() && mb.length === 4
    ? [R(mb.get(0)).asNumber(), R(mb.get(1)).asNumber(), R(mb.get(2)).asNumber(), R(mb.get(3)).asNumber()]
    : [0, 0, 612, 792];

  const ops = scanContent(src);
  const cut: [number, number][] = [];
  const stack: { start: number; kind: string; open: number }[] = [];
  const pagination: [number, number][] = []; // cabeçalhos/rodapés para medir
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k];
    if (o.op === "BDC" || o.op === "BMC") {
      stack.push({ start: o.start, kind: o.op === "BDC" ? sectionKind(o.args, res) : "other", open: k });
    } else if (o.op === "EMC") {
      const s = stack.pop();
      if (!s) continue;
      if (stack.some((x) => x.kind === "watermark")) continue; // já sai junto com o de fora
      if (s.kind === "watermark") cut.push([s.start, o.end]);
      else if (s.kind === "pagination" && !stack.some((x) => x.kind === "pagination")) pagination.push([s.start, o.end]);
    } else if (o.op === "Do" && xobjects?.isDictionary() && !stack.some((x) => x.kind === "watermark")) {
      const nm = /\/([^\s\/]+)\s*$/.exec(o.args)?.[1];
      if (nm && xobjectIsWatermark(R(xobjects.get(nm)))) cut.push([o.start, o.end]);
    }
  }

  // cabeçalhos do Word: mede cada um num documento à parte
  if (pagination.length) {
    const tmp = new mupdf.PDFDocument();
    try {
      const tres = res.isDictionary() ? tmp.graftObject(res) : tmp.newDictionary();
      for (const [a, b] of pagination) {
        if (cut.some(([x, y]) => a >= x && b <= y)) continue;
        const body = src.slice(a, b).replace(/^[\s\S]*?\bBDC\b/, "").replace(/\bEMC\s*$/, "");
        const { box, page: pb } = measure(tmp, tres, mediabox, `q\n${body}\nQ`);
        if (looksLikeWatermark(box, pb)) cut.push([a, b]);
      }
    } finally { tmp.destroy(); }
  }

  // marcas d'água de versões antigas do PapyrusPDF (transparência PapiroGS + texto)
  for (const m of src.matchAll(/\/PapiroGS\d+ gs BT[\s\S]*?\bET\b/g)) {
    const a = m.index!, b = a + m[0].length;
    if (!cut.some(([x, y]) => a >= x && b <= y)) cut.push([a, b]);
  }

  if (!cut.length) return count;
  count += cut.length;
  if (dryRun) return count;
  cut.sort((x, y) => x[0] - y[0]);
  let out = "", pos = 0;
  for (const [a, b] of cut) { if (a < pos) continue; out += src.slice(pos, a) + "\n"; pos = b; }
  out += src.slice(pos);
  pageObj.put("Contents", doc.addStream(fromLatin1(out), {}));
  return count;
}
