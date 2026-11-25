// Análise, reparo de geometria e recuperação de texto para fontes Type 3 sem mapa /ToUnicode.
// Muitos PDFs gerados por conversores PDF/A (iText, Ghostscript, etc.) convertem fontes em
// vetores Type 3 com nomes de glifo numéricos (/1, /2, ...) e /FontBBox invertido ([0 0 1 -1]).
import * as mupdf from "mupdf";
import type { OcrWord, Recognizer } from "./core.ts";
import type { Rect } from "./types.ts";

export interface GlyphBox {
  empty: boolean;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Type3FontInfo {
  objNum: number;
  ref: mupdf.PDFObject;
  fingerprint: string;
  codeToGlyphName: Map<number, string>;
  glyphBoxes: Map<string, GlyphBox>;
  emptyCodes: Set<number>;
  actualBBox: Rect | null;
  hasToUnicode: boolean;
  needsRecovery: boolean;
}

export interface Type3Recovered {
  fingerprint: string;
  codeToChar: Map<number, string>;
  boldCodes: Set<number>;
  emptyCodes: Set<number>;
}

const R = (o: mupdf.PDFObject) => (o.isIndirect() ? o.resolve() : o);

// Nomes de glifos padrão (WinAnsi / Adobe Glyph List básicos) que o MuPDF já decodifica sem OCR.
const STD_GLYPH_NAMES = new Set([
  "space", "exclam", "quotedbl", "numbersign", "dollar", "percent", "ampersand", "quotesingle",
  "parenleft", "parenright", "asterisk", "plus", "comma", "hyphen", "period", "slash",
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "colon", "semicolon", "less", "equal", "greater", "question", "at",
  "bracketleft", "backslash", "bracketright", "asciicircum", "underscore", "grave",
  "braceleft", "bar", "braceright", "asciitilde",
  "Agrave", "Aacute", "Acircumflex", "Atilde", "Adieresis", "Aring", "AE", "Ccedilla",
  "Egrave", "Eacute", "Ecircumflex", "Edieresis", "Igrave", "Iacute", "Icircumflex", "Idieresis",
  "Eth", "Ntilde", "Ograve", "Oacute", "Ocircumflex", "Otilde", "Odieresis", "Oslash",
  "Ugrave", "Uacute", "Ucircumflex", "Udieresis", "Yacute", "Thorn", "germandbls",
  "agrave", "aacute", "acircumflex", "atilde", "adieresis", "aring", "ae", "ccedilla",
  "egrave", "eacute", "ecircumflex", "edieresis", "igrave", "iacute", "icircumflex", "idieresis",
  "eth", "ntilde", "ograve", "oacute", "ocircumflex", "otilde", "odieresis", "oslash",
  "ugrave", "uacute", "ucircumflex", "udieresis", "yacute", "thorn", "ydieresis",
  "Euro", "bullet", "endash", "emdash", "quoteleft", "quoteright", "quotedblleft", "quotedblright",
  "degree", "section", "copyright", "registered", "ordfeminine", "ordmasculine", "mu", "multiply", "divide",
]);

function isStandardGlyphName(name: string): boolean {
  if (!name || name === ".notdef") return true;
  if (/^[A-Za-z]$/.test(name)) return true;
  if (STD_GLYPH_NAMES.has(name)) return true;
  if (/^uni[0-9A-Fa-f]{4}$/.test(name) || /^u[0-9A-Fa-f]{4,6}$/.test(name)) return true;
  return false;
}

/** Extrai o número de objeto indireto do nome que o MuPDF atribui a uma fonte Type 3 ("Type3 (8 0 R)"). */
export function type3FontObjNum(fontName: string): number | null {
  const m = /^Type3\s*\((\d+)\s+\d+\s+R\)$/.exec(fontName);
  return m ? Number(m[1]) : null;
}

type Mat6 = [number, number, number, number, number, number];
const mulMat = (a: Mat6, b: Mat6): Mat6 => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

/** Analisa um stream de CharProc de fonte Type 3 e calcula o retângulo real do desenho no espaço do glifo. */
export function parseCharProcBounds(src: string): GlyphBox {
  const hasDraw = /\b(f|F|f\*|S|s|B|B\*|b|b\*|Do|BI|sh)\b/.test(src);
  if (!hasDraw) return { empty: true, minX: 0, minY: 0, maxX: 0, maxY: 0 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let ctm: Mat6 = [1, 0, 0, 1, 0, 0];
  const stack: Mat6[] = [];
  const nums: number[] = [];

  const addPt = (x: number, y: number) => {
    const tx = ctm[0] * x + ctm[2] * y + ctm[4];
    const ty = ctm[1] * x + ctm[3] * y + ctm[5];
    if (tx < minX) minX = tx;
    if (tx > maxX) maxX = tx;
    if (ty < minY) minY = ty;
    if (ty > maxY) maxY = ty;
  };

  // Tokenização leve de operadores PDF (ignora comentários e strings; só precisa de números e operadores gráficos).
  const clean = src.replace(/%[^\r\n]*/g, " ");
  const tokens = clean.match(/[+-]?(?:\d+\.?\d*|\.\d+)|[A-Za-z*]+/g) ?? [];
  for (const tok of tokens) {
    if (/^[+-]?(?:\d|\.)/.test(tok)) {
      const v = Number(tok);
      if (Number.isFinite(v)) nums.push(v);
      continue;
    }
    switch (tok) {
      case "q":
        stack.push([...ctm]);
        nums.length = 0;
        break;
      case "Q":
        if (stack.length) ctm = stack.pop()!;
        nums.length = 0;
        break;
      case "cm":
        if (nums.length >= 6) {
          const m = nums.slice(-6) as Mat6;
          ctm = mulMat(m, ctm);
        }
        nums.length = 0;
        break;
      case "m":
      case "l":
        if (nums.length >= 2) addPt(nums[nums.length - 2], nums[nums.length - 1]);
        nums.length = 0;
        break;
      case "c":
        if (nums.length >= 6) {
          const n = nums.length;
          addPt(nums[n - 6], nums[n - 5]);
          addPt(nums[n - 4], nums[n - 3]);
          addPt(nums[n - 2], nums[n - 1]);
        }
        nums.length = 0;
        break;
      case "v":
      case "y":
        if (nums.length >= 4) {
          const n = nums.length;
          addPt(nums[n - 4], nums[n - 3]);
          addPt(nums[n - 2], nums[n - 1]);
        }
        nums.length = 0;
        break;
      case "re":
        if (nums.length >= 4) {
          const n = nums.length;
          const x = nums[n - 4], y = nums[n - 3], w = nums[n - 2], h = nums[n - 1];
          addPt(x, y);
          addPt(x + w, y);
          addPt(x, y + h);
          addPt(x + w, y + h);
        }
        nums.length = 0;
        break;
      case "Do":
      case "BI":
        // XObject / imagem embutida desenha no quadrado unitário transformado pela CTM atual
        addPt(0, 0); addPt(1, 0); addPt(0, 1); addPt(1, 1);
        nums.length = 0;
        break;
      default:
        nums.length = 0;
        break;
    }
  }

  if (minX === Infinity) return { empty: true, minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { empty: false, minX, minY, maxX, maxY };
}

/** Hash FNV-1a rápido para identificar a fonte Type 3 mesmo depois de renumeração de objetos ao salvar. */
function hashString(parts: string[]): string {
  let h = 0x811c9dc5;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h ^= p.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Inspeciona uma fonte `/Subtype /Type3`. */
export function inspectType3Font(ref: mupdf.PDFObject): Type3FontInfo | null {
  if (!ref.isIndirect()) return null;
  const f = R(ref);
  if (!f.isDictionary()) return null;
  const sub = R(f.get("Subtype"));
  if (!sub.isName() || sub.asName() !== "Type3") return null;

  const objNum = ref.asIndirect();
  const codeToGlyphName = new Map<number, string>();
  const enc = R(f.get("Encoding"));
  if (enc.isDictionary()) {
    const diff = R(enc.get("Differences"));
    if (diff.isArray()) {
      let code = 0;
      diff.forEach((v) => {
        if (v.isNumber()) code = v.asNumber();
        else if (v.isName()) { codeToGlyphName.set(code, v.asName()); code++; }
      });
    }
  }

  const glyphBoxes = new Map<string, GlyphBox>();
  const cp = R(f.get("CharProcs"));
  let fMinX = Infinity, fMinY = Infinity, fMaxX = -Infinity, fMaxY = -Infinity;
  const sigParts: string[] = [];

  if (cp.isDictionary()) {
    const entries: [string, mupdf.PDFObject][] = [];
    cp.forEach((v, k) => entries.push([String(k), v]));
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [k, v] of entries) {
      if (!v.isStream()) continue;
      let src = "";
      try {
        const buf = v.readStream();
        src = buf.asString();
        buf.destroy();
      } catch { continue; }
      const gb = parseCharProcBounds(src);
      glyphBoxes.set(k, gb);
      sigParts.push(`${k}:${src.length}:${src.slice(0, 64)}`);
      if (!gb.empty) {
        if (gb.minX < fMinX) fMinX = gb.minX;
        if (gb.maxX > fMaxX) fMaxX = gb.maxX;
        if (gb.minY < fMinY) fMinY = gb.minY;
        if (gb.maxY > fMaxY) fMaxY = gb.maxY;
      }
    }
  }

  const emptyCodes = new Set<number>();
  let totalNonEmpty = 0, stdNonEmpty = 0;
  for (const [code, gname] of codeToGlyphName) {
    const gb = glyphBoxes.get(gname);
    if (!gb || gb.empty || gname === ".notdef" || gname === "space") {
      emptyCodes.add(code);
    } else {
      totalNonEmpty++;
      if (isStandardGlyphName(gname)) stdNonEmpty++;
    }
  }

  const tu = f.get("ToUnicode");
  const hasToUnicode = !tu.isNull() && tu.isStream();
  const actualBBox: Rect | null = fMinX < Infinity ? [fMinX, fMinY, fMaxX, fMaxY] : null;
  const needsRecovery = !hasToUnicode && totalNonEmpty > 0 && stdNonEmpty / totalNonEmpty < 0.5;

  return {
    objNum,
    ref,
    fingerprint: hashString(sigParts),
    codeToGlyphName,
    glyphBoxes,
    emptyCodes,
    actualBBox,
    hasToUnicode,
    needsRecovery,
  };
}

/** Percorre os recursos de uma página (e seus Form XObjects) e devolve todas as fontes Type 3 encontradas. */
export function pageType3Fonts(pageObj: mupdf.PDFObject): Type3FontInfo[] {
  const seenFonts = new Set<number>();
  const seenForms = new Set<number>();
  const out: Type3FontInfo[] = [];
  const walk = (res: mupdf.PDFObject, depth: number) => {
    if (!res.isDictionary() || depth > 5) return;
    const fonts = R(res.get("Font"));
    if (fonts.isDictionary()) {
      fonts.forEach((v) => {
        if (!v.isIndirect() || seenFonts.has(v.asIndirect())) return;
        seenFonts.add(v.asIndirect());
        const info = inspectType3Font(v);
        if (info) out.push(info);
      });
    }
    const xo = R(res.get("XObject"));
    if (xo.isDictionary()) {
      xo.forEach((v) => {
        if (!v.isIndirect() || seenForms.has(v.asIndirect())) return;
        seenForms.add(v.asIndirect());
        const r = R(v);
        if (r.get("Subtype").isName() && r.get("Subtype").asName() === "Form") {
          walk(R(r.get("Resources")), depth + 1);
        }
      });
    }
  };
  walk(R(pageObj.getInheritable("Resources")), 0);
  return out;
}

/**
 * Repara `/FontBBox` invertido ou degenerado (como `[0 0 1 -1]`) nas fontes Type 3 do documento.
 * Deve ser chamado em `adopt()` ANTES de `doc.enableJournal()`, para não marcar o documento como
 * alterado e manter o histórico de Desfazer intacto. Não altera a renderização visual dos glifos.
 */
export function repairType3FontBBoxes(doc: mupdf.PDFDocument): Map<number, Type3FontInfo> {
  const all = new Map<number, Type3FontInfo>();
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    let pageObj: mupdf.PDFObject;
    try { pageObj = doc.findPage(i); } catch { continue; }
    for (const info of pageType3Fonts(pageObj)) {
      if (all.has(info.objNum)) continue;
      all.set(info.objNum, info);
      if (!info.actualBBox) continue;
      const f = R(info.ref);
      const fb = R(f.get("FontBBox"));
      let broken = true;
      if (fb.isArray() && fb.length >= 4) {
        const bx0 = fb.get(0).asNumber(), by0 = fb.get(1).asNumber();
        const bx1 = fb.get(2).asNumber(), by1 = fb.get(3).asNumber();
        const [ax0, ay0, ax1, ay1] = info.actualBBox;
        broken = by1 < by0 || bx1 < bx0 || (bx0 === 0 && by0 === 0 && bx1 === 0 && by1 === 0)
          || (by1 <= 0 && ay1 > 0.05) || (bx1 <= 0 && ax1 > 0.05)
          || Math.abs(by1 - by0) < 0.001 || (ay0 < by0 - 0.5 && ay1 > by1 + 0.5);
      }
      if (broken) {
        const arr = doc.newArray();
        for (const v of info.actualBBox) arr.push(Math.round(v * 10000) / 10000);
        f.put("FontBBox", arr);
      }
    }
  }
  return all;
}

interface RawType3Line {
  size: number;
  chars: { code: number; isEmpty: boolean; originX: number }[];
}

interface SyntheticChar {
  code: number;
  x: number;
  visX0: number;
  visX1: number;
}

interface SyntheticLine {
  yBaseline: number;
  chars: SyntheticChar[];
}

/**
 * Reconhece o mapeamento `código → Unicode` (e quais códigos são negrito) de uma fonte Type 3
 * sem `/ToUnicode`, montando uma folha sintética limpa (sem bordas nem imagens) com as linhas
 * que usam a fonte e votando cada código por maioria entre todas as ocorrências.
 */
export async function recoverType3Font(
  doc: mupdf.PDFDocument,
  info: Type3FontInfo,
  recognize: Recognizer,
  existing?: Type3Recovered,
): Promise<Type3Recovered> {
  const codeToChar = new Map<number, string>(existing?.codeToChar);
  const boldCodes = new Set<number>(existing?.boldCodes);
  const emptyCodes = new Set<number>(info.emptyCodes);

  // Coleta linhas de todas as páginas que usam esta fonte Type 3 (até 80 linhas distintas bastam para cobrir todos os códigos).
  const rawLines: RawType3Line[] = [];
  const seenCodes = new Set<number>();
  const targetName = `Type3 (${info.objNum} 0 R)`;
  const pageCount = doc.countPages();

  for (let pi = 0; pi < pageCount && rawLines.length < 160; pi++) {
    const page = doc.loadPage(pi);
    const st = page.toStructuredText("preserve-whitespace");
    let cur: RawType3Line | null = null;
    st.walk({
      beginLine() { cur = { size: 0, chars: [] }; },
      onChar(c, origin, font, size) {
        if (!cur || font.getName() !== targetName) return;
        const cp = c.codePointAt(0) ?? 0;
        const isEmpty = cp === 0xfffd || emptyCodes.has(cp) || !info.codeToGlyphName.has(cp);
        if (!cur.size) cur.size = size;
        cur.chars.push({ code: cp, isEmpty, originX: origin[0] });
        if (!isEmpty) seenCodes.add(cp);
      },
      endLine() {
        if (!cur) return;
        while (cur.chars.length && cur.chars[0].isEmpty) cur.chars.shift();
        while (cur.chars.length && cur.chars[cur.chars.length - 1].isEmpty) cur.chars.pop();
        if (cur.chars.some((ch) => !ch.isEmpty)) rawLines.push(cur);
        cur = null;
      },
    });
    st.destroy();
    page.destroy();
  }

  // Se todos os códigos já estavam no cache, nada a reconhecer.
  const unresolvedBefore = [...seenCodes].filter((c) => !codeToChar.has(c));
  if (!unresolvedBefore.length || !rawLines.length) {
    return { fingerprint: info.fingerprint, codeToChar, boldCodes, emptyCodes };
  }

  // Se houver muitas linhas, prioriza as que cobrem códigos ainda desconhecidos + amostra para votação.
  const selectedLines: RawType3Line[] = [];
  const covered = new Map<number, number>();
  for (const ln of rawLines) {
    const codes = ln.chars.filter((c) => !c.isEmpty).map((c) => c.code);
    const needed = codes.some((c) => (covered.get(c) ?? 0) < 4);
    if (needed || selectedLines.length < 70) {
      selectedLines.push(ln);
      for (const c of codes) covered.set(c, (covered.get(c) ?? 0) + 1);
      if (selectedLines.length >= 120) break;
    }
  }

  // Monta um PDF temporário limpo com as linhas em 18pt sobre fundo branco puro.
  const fontSize = 18;
  const lineGap = 32;
  const marginX = 36;
  const marginY = 36;
  let maxLineW = 400;
  const layout: SyntheticLine[] = [];

  for (let i = 0; i < selectedLines.length; i++) {
    const ln = selectedLines[i];
    const scale = fontSize / Math.max(1, ln.size);
    const xStart = ln.chars[0].originX;
    const chars: SyntheticChar[] = [];
    const yBaseline = marginY + (i + 1) * lineGap;
    for (const ch of ln.chars) {
      if (ch.isEmpty) continue;
      const x = marginX + (ch.originX - xStart) * scale;
      const gname = info.codeToGlyphName.get(ch.code);
      const gb = gname ? info.glyphBoxes.get(gname) : undefined;
      const visX0 = x + (gb && !gb.empty ? gb.minX * fontSize : 0);
      const visX1 = x + (gb && !gb.empty ? gb.maxX * fontSize : fontSize * 0.5);
      chars.push({ code: ch.code, x, visX0, visX1 });
      if (visX1 + marginX > maxLineW) maxLineW = visX1 + marginX;
    }
    if (chars.length) layout.push({ yBaseline, chars });
  }

  const synH = marginY * 2 + (layout.length + 1) * lineGap;
  const synW = Math.ceil(maxLineW);
  const dpi = 200;
  const dpiScale = dpi / 72;

  const scratch = new mupdf.PDFDocument();
  let png: Uint8Array;
  let pixW = 0, pixH = 0;
  let pixBytes: Uint8Array;
  try {
    const grafted = scratch.graftObject(info.ref);
    let ops = `0 0 0 rg\nBT\n/F0 ${fontSize} Tf\n`;
    for (const ll of layout) {
      const pdfY = synH - ll.yBaseline;
      for (const ch of ll.chars) {
        const hex = ch.code.toString(16).padStart(2, "0");
        ops += `1 0 0 1 ${ch.x.toFixed(2)} ${pdfY.toFixed(2)} Tm <${hex}> Tj\n`;
      }
    }
    ops += "ET\n";
    const res = scratch.newDictionary();
    const fdict = scratch.newDictionary();
    fdict.put("F0", grafted);
    res.put("Font", fdict);
    scratch.insertPage(-1, scratch.addPage([0, 0, synW, synH], 0, res, ops));
    const sp = scratch.loadPage(0);
    const pix = sp.toPixmap(mupdf.Matrix.scale(dpiScale, dpiScale), mupdf.ColorSpace.DeviceRGB, false, true);
    pixW = pix.getWidth();
    pixH = pix.getHeight();
    pixBytes = new Uint8Array(pix.getPixels());
    png = new Uint8Array(pix.asPNG());
    pix.destroy();
    sp.destroy();
  } finally {
    scratch.destroy();
  }

  // Estima quais códigos são negrito medindo a espessura da haste vertical na folha renderizada.
  detectBoldCodes(layout, pixBytes, pixW, pixH, fontSize, dpiScale, boldCodes);

  // Pass 1: OCR na folha limpa + votação por código (palavras exatas têm peso alto; símbolos servem de reforço).
  const words = await recognize(png);
  const votes = new Map<number, Map<string, number>>();
  const strongCodes = new Set<number>();
  const addVote = (code: number, ch: string, weight: number, strong: boolean) => {
    if (!ch || [...ch].length !== 1 || ch === "\uFFFD") return;
    let m = votes.get(code);
    if (!m) votes.set(code, (m = new Map()));
    m.set(ch, (m.get(ch) ?? 0) + weight);
    if (strong) strongCodes.add(code);
  };

  for (const w of words) {
    const wyMid = ((w.bbox[1] + w.bbox[3]) / 2) / dpiScale;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < layout.length; i++) {
      const d = Math.abs(wyMid - (layout[i].yBaseline - fontSize * 0.35));
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0 || bestD >= lineGap * 0.45) continue;
    const ll = layout[best];
    const wx0 = w.bbox[0] / dpiScale, wx1 = w.bbox[2] / dpiScale;
    const chars = ll.chars.filter((c) => {
      const cx = (c.visX0 + c.visX1) / 2;
      return cx >= wx0 - 1.5 && cx <= wx1 + 1.5;
    });
    const wChars = [...w.text];
    const conf = w.confidence ?? 60;
    if (conf >= 45 && chars.length === wChars.length) {
      for (let k = 0; k < chars.length; k++) {
        const symConf = w.symbols?.[k]?.confidence ?? conf;
        addVote(chars[k].code, wChars[k], symConf >= 70 ? 4 : 2, symConf >= 75);
      }
    } else if (w.symbols?.length) {
      for (const sym of w.symbols) {
        if (!sym.text || [...sym.text].length !== 1) continue;
        const sxMid = ((sym.bbox[0] + sym.bbox[2]) / 2) / dpiScale;
        let bc: SyntheticChar | null = null, bd = Infinity;
        for (const c of ll.chars) {
          const cx = (c.visX0 + c.visX1) / 2;
          const d = Math.abs(sxMid - cx);
          if (d < bd) { bd = d; bc = c; }
        }
        if (bc && bd < fontSize * 0.4) {
          addVote(bc.code, sym.text, sym.confidence >= 80 ? 2 : 1, sym.confidence >= 85);
        }
      }
    }
  }

  for (const [code, m] of votes) {
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    codeToChar.set(code, sorted[0][0]);
  }

  // Detecta colisões suspeitas: um código raro (<=2 ocorrências) que caiu na mesma letra de outro código
  // bem mais frequente e com o mesmo peso (ex.: "@" lido como "G" em um e-mail todo em maiúsculas).
  const seenCounts = new Map<number, number>();
  for (const ll of layout) for (const ch of ll.chars) seenCounts.set(ch.code, (seenCounts.get(ch.code) ?? 0) + 1);
  const topByCharWeight = new Map<string, { code: number; weight: number }>();
  for (const [code, ch] of codeToChar) {
    const key = `${ch}|${boldCodes.has(code) ? "B" : "R"}`;
    const w = votes.get(code)?.get(ch) ?? 0;
    const prev = topByCharWeight.get(key);
    if (!prev || w > prev.weight) topByCharWeight.set(key, { code, weight: w });
  }
  const collisions = new Set<number>();
  for (const [code, ch] of codeToChar) {
    if ((seenCounts.get(code) ?? 0) > 2) continue;
    const key = `${ch}|${boldCodes.has(code) ? "B" : "R"}`;
    const top = topByCharWeight.get(key);
    if (top && top.code !== code && top.weight >= 8) collisions.add(code);
  }

  // Pass 2 (rápido, ~30 ms): verifica códigos ausentes, fracos ou em colisão (ex.: "*", "@")
  // usando sondas curtas em contexto ("5<glifo>5" e "a<glifo>b").
  const owned = new Set<string>();
  for (const [key, top] of topByCharWeight) if (top.weight >= 8) owned.add(key);
  const needProbe = [...seenCodes].filter((c) => !codeToChar.has(c) || !strongCodes.has(c) || collisions.has(c));
  if (needProbe.length > 0 && needProbe.length <= 40) {
    await probeWeakCodes(info, needProbe, recognize, codeToChar, votes, strongCodes, collisions, boldCodes, owned);
  }

  return { fingerprint: info.fingerprint, codeToChar, boldCodes, emptyCodes };
}

/** Mede a largura mediana das hastes escuras por linha/código para distinguir negrito de regular. */
function detectBoldCodes(
  layout: SyntheticLine[],
  pixBytes: Uint8Array,
  pixW: number,
  pixH: number,
  fontSize: number,
  dpiScale: number,
  boldCodes: Set<number>,
): void {
  const codeSamples = new Map<number, number[]>();
  const pxFont = fontSize * dpiScale;
  for (const ll of layout) {
    const y0 = Math.max(0, Math.floor((ll.yBaseline - fontSize * 0.85) * dpiScale));
    const y1 = Math.min(pixH - 1, Math.ceil((ll.yBaseline + fontSize * 0.1) * dpiScale));
    const x0 = Math.max(0, Math.floor((ll.chars[0].visX0 - 2) * dpiScale));
    const x1 = Math.min(pixW - 1, Math.ceil((ll.chars[ll.chars.length - 1].visX1 + 2) * dpiScale));
    const runs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      let run = 0;
      for (let x = x0; x <= x1; x++) {
        const dark = pixBytes[(y * pixW + x) * 3] < 160;
        if (dark) run++;
        else if (run > 0) { runs.push(run); run = 0; }
      }
      if (run > 0) runs.push(run);
    }
    if (runs.length < 8) continue;
    runs.sort((a, b) => a - b);
    const ratio = runs[Math.floor(runs.length * 0.4)] / pxFont;
    for (const ch of ll.chars) {
      let arr = codeSamples.get(ch.code);
      if (!arr) codeSamples.set(ch.code, (arr = []));
      arr.push(ratio);
    }
  }
  for (const [code, arr] of codeSamples) {
    arr.sort((a, b) => a - b);
    const med = arr[Math.floor(arr.length / 2)];
    if (med >= 0.125) boldCodes.add(code);
  }
}

/** Sonda rápida para glifos isolados ou símbolos raros ("*", "@") que o OCR em frase perdeu ou confundiu. */
async function probeWeakCodes(
  info: Type3FontInfo,
  codes: number[],
  recognize: Recognizer,
  codeToChar: Map<number, string>,
  votes: Map<number, Map<string, number>>,
  strongCodes: Set<number>,
  collisions: Set<number>,
  boldCodes: Set<number>,
  owned: Set<string>,
): Promise<void> {
  const fsz = 24;
  const rowH = 42;
  const dpi = 200;
  const dpiScale = dpi / 72;
  const h = 36 + codes.length * rowH;
  const w = 320;

  const s = new mupdf.PDFDocument();
  let png: Uint8Array;
  const probes: { code: number; yBase: number; left: string; right: string; x0: number; x1: number }[] = [];
  try {
    const gf = s.graftObject(info.ref);
    const hDict = s.newDictionary();
    hDict.put("Type", s.newName("Font"));
    hDict.put("Subtype", s.newName("Type1"));
    hDict.put("BaseFont", s.newName("Helvetica"));
    hDict.put("Encoding", s.newName("WinAnsiEncoding"));
    const hRef = s.addObject(hDict);

    let ops = "0 0 0 rg\nBT\n";
    codes.forEach((code, idx) => {
      const yBase = 34 + idx * rowH;
      const pdfY = h - yBase;
      const gname = info.codeToGlyphName.get(code);
      const gb = gname ? info.glyphBoxes.get(gname) : undefined;
      const gw = gb && !gb.empty ? Math.max(0.25, gb.maxX - Math.min(0, gb.minX)) * fsz : fsz * 0.55;
      const hex = code.toString(16).padStart(2, "0");

      // Sonda 1: 5<glifo>5 (boa para símbolos e dígitos)
      const ax1 = 24, agx = ax1 + fsz * 0.65, ax2 = agx + gw + 2;
      ops += `/FH ${fsz} Tf 1 0 0 1 ${ax1.toFixed(1)} ${pdfY.toFixed(1)} Tm (5) Tj\n`;
      ops += `/F0 ${fsz} Tf 1 0 0 1 ${agx.toFixed(1)} ${pdfY.toFixed(1)} Tm <${hex}> Tj\n`;
      ops += `/FH ${fsz} Tf 1 0 0 1 ${ax2.toFixed(1)} ${pdfY.toFixed(1)} Tm (5) Tj\n`;
      probes.push({ code, yBase, left: "5", right: "5", x0: ax1 - 6, x1: ax2 + fsz });

      // Sonda 2: a<glifo>b (boa para "@", letras e pontuação)
      const bx1 = 170, bgx = bx1 + fsz * 0.65, bx2 = bgx + gw + 2;
      ops += `/FH ${fsz} Tf 1 0 0 1 ${bx1.toFixed(1)} ${pdfY.toFixed(1)} Tm (a) Tj\n`;
      ops += `/F0 ${fsz} Tf 1 0 0 1 ${bgx.toFixed(1)} ${pdfY.toFixed(1)} Tm <${hex}> Tj\n`;
      ops += `/FH ${fsz} Tf 1 0 0 1 ${bx2.toFixed(1)} ${pdfY.toFixed(1)} Tm (b) Tj\n`;
      probes.push({ code, yBase, left: "a", right: "b", x0: bx1 - 6, x1: bx2 + fsz });
    });
    ops += "ET\n";

    const res = s.newDictionary();
    const fdict = s.newDictionary();
    fdict.put("F0", gf);
    fdict.put("FH", hRef);
    res.put("Font", fdict);
    s.insertPage(-1, s.addPage([0, 0, w, h], 0, res, ops));
    const p = s.loadPage(0);
    const pix = p.toPixmap(mupdf.Matrix.scale(dpiScale, dpiScale), mupdf.ColorSpace.DeviceRGB, false, true);
    png = new Uint8Array(pix.asPNG());
    pix.destroy();
    p.destroy();
  } finally {
    s.destroy();
  }

  const words: OcrWord[] = await recognize(png);
  const probeHits = new Map<number, { ch: string; conf: number }[]>();
  for (const word of words) {
    const t = word.text.trim();
    const chars = [...t];
    if (chars.length !== 3) continue;
    const wxMid = ((word.bbox[0] + word.bbox[2]) / 2) / dpiScale;
    const wyMid = ((word.bbox[1] + word.bbox[3]) / 2) / dpiScale;
    const match = probes.find((pr) =>
      chars[0] === pr.left && chars[2] === pr.right
      && wxMid >= pr.x0 && wxMid <= pr.x1
      && Math.abs(wyMid - (pr.yBase - fsz * 0.35)) < rowH * 0.45);
    if (!match) continue;
    const midConf = word.symbols?.[1]?.confidence ?? word.confidence ?? 50;
    let list = probeHits.get(match.code);
    if (!list) probeHits.set(match.code, (list = []));
    list.push({ ch: chars[1], conf: midConf });
  }

  for (const [code, hits] of probeHits) {
    if (!hits.length) continue;
    const wt = boldCodes.has(code) ? "B" : "R";
    // Prefere candidatos que ainda não pertencem com alta confiança a outro glifo do mesmo peso
    hits.sort((a, b) => {
      const aOwned = owned.has(`${a.ch}|${wt}`) ? 1 : 0;
      const bOwned = owned.has(`${b.ch}|${wt}`) ? 1 : 0;
      if (aOwned !== bOwned) return aOwned - bOwned;
      return b.conf - a.conf;
    });
    const best = hits[0];
    const bestOwned = owned.has(`${best.ch}|${wt}`);
    // Se ainda não tinha mapeamento, houve colisão suspeita, ou as sondas concordam sobre um voto fraco
    const bothAgree = hits.length >= 2 && hits[0].ch === hits[1].ch;
    const prevVotes = votes.get(code);
    const prevTopWeight = prevVotes ? Math.max(...prevVotes.values()) : 0;
    const isCollision = collisions.has(code) && !bestOwned && best.ch !== codeToChar.get(code) && (bothAgree || best.conf >= 55);
    if (!codeToChar.has(code) || isCollision || (!strongCodes.has(code) && (bothAgree || (best.conf >= 75 && prevTopWeight <= 2)))) {
      codeToChar.set(code, best.ch);
    }
  }
}
