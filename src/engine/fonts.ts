// Fontes para a edição de texto: reaproveita a fonte embutida no próprio PDF sempre que ela
// tem as letras do texto novo. Assim o trecho editado continua com a mesma fonte do documento.
import * as mupdf from "mupdf";
import { fontStyle, isSubset, isSymbolicFont, normalizePdfText, stripSubset } from "./fontname.ts";

export { normalizePdfText };

/** Como escrever caracteres numa fonte que está (ou vai estar) nos recursos da página. */
export interface GlyphSource {
  kind: "original" | "system" | "base14";
  key: string;              // nome do recurso na página (/Key size Tf)
  ref: mupdf.PDFObject;     // objeto da fonte
  twoByte: boolean;         // códigos de 2 bytes (Type0 Identity-H) ou de 1 byte
  label: string;            // nome para avisos
  /** Código e largura (em milésimos do tamanho) do caractere, ou null se a fonte não o tem. */
  glyph(ch: string): { code: number; w: number } | null;
}

// ---------- ToUnicode ----------

const utf16 = (hex: string) => {
  const h = hex.replace(/\s+/g, "");
  const units: number[] = [];
  for (let i = 0; i + 4 <= h.length; i += 4) units.push(parseInt(h.slice(i, i + 4), 16));
  if (h.length === 2) units.push(parseInt(h, 16)); // alguns geradores gravam um byte só
  return String.fromCharCode(...units);
};
const single = (s: string) => [...s].length === 1;

/**
 * Lê o CMap ToUnicode e devolve o caminho inverso: caractere → código na fonte.
 * Só entram caracteres simples (ligaduras como "fi" ficam de fora). Vale o primeiro código de cada
 * caractere, menos o código 0: é o glifo vazio (.notdef), que o Word também associa ao espaço.
 */
export function parseToUnicode(src: string): { map: Map<string, number>; bytes: number } {
  const map = new Map<string, number>();
  let bytes = 1;
  const put = (ch: string, code: number) => {
    if (!single(ch) || ch === "\u0000" || ch === "\uFFFD") return;
    if (!map.has(ch) || map.get(ch) === 0) map.set(ch, code);
  };
  for (const sec of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const toks = [...sec[1].matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((m) => m[1].replace(/\s+/g, ""));
    for (let i = 0; i + 1 < toks.length; i += 2) {
      bytes = Math.max(bytes, Math.ceil(toks[i].length / 2));
      put(utf16(toks[i + 1]), parseInt(toks[i], 16));
    }
  }
  for (const sec of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9A-Fa-f\s]*)>|\[|\]/g;
    const toks: (string | "[" | "]")[] = [];
    for (const m of sec[1].matchAll(re)) toks.push(m[0] === "[" || m[0] === "]" ? m[0] : m[1].replace(/\s+/g, ""));
    let i = 0;
    while (i + 2 < toks.length) {
      const lo = toks[i] as string, hi = toks[i + 1] as string;
      bytes = Math.max(bytes, Math.ceil(lo.length / 2));
      const a = parseInt(lo, 16), b = parseInt(hi, 16);
      if (!(b >= a) || b - a > 0xffff) { i += 3; continue; }
      if (toks[i + 2] === "[") {
        let k = i + 3, code = a;
        while (k < toks.length && toks[k] !== "]") { if (code <= b) put(utf16(toks[k] as string), code); code++; k++; }
        i = k + 1;
      } else {
        const base = utf16(toks[i + 2] as string);
        if (base.length) {
          const head = base.slice(0, -1), last = base.charCodeAt(base.length - 1);
          for (let code = a; code <= b; code++) put(head + String.fromCharCode(last + code - a), code);
        }
        i += 3;
      }
    }
  }
  return { map, bytes };
}

// ---------- codificações das fontes simples ----------

// Nomes de glifo da WinAnsiEncoding, de 0x20 a 0xFF ("" = posição vazia).
const WINANSI_NAMES = (
  "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash " +
  "zero one two three four five six seven eight nine colon semicolon less equal greater question at " +
  "A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave " +
  "a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde - " +
  "Euro - quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE - Zcaron - " +
  "- quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe - zcaron Ydieresis " +
  "nbspace exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot sfthyphen registered macron " +
  "degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown " +
  "Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis " +
  "Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls " +
  "agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis " +
  "eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis"
).split(" ");

// Bytes 0x80–0x9F da Windows-1252 → Unicode.
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
const winAnsiChar = (code: number) => String.fromCodePoint(CP1252_HIGH[code] ?? code);

/** Nome de glifo → caractere (a lista da WinAnsi cobre o português; "uniXXXX" também). */
const GLYPH_CHAR = new Map<string, string>();
WINANSI_NAMES.forEach((n, i) => { if (n !== "-" && !GLYPH_CHAR.has(n)) GLYPH_CHAR.set(n, winAnsiChar(0x20 + i)); });
GLYPH_CHAR.set("space", " ");
function glyphChar(name: string): string | null {
  const g = GLYPH_CHAR.get(name);
  if (g) return g;
  const m = /^uni([0-9A-Fa-f]{4})$/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  return m ? String.fromCodePoint(parseInt(m[1], 16)) : null;
}

/** Caractere → código de uma fonte simples, pela /Encoding (sem ToUnicode). */
function simpleEncoding(font: mupdf.PDFObject, name: string): Map<string, number> {
  const map = new Map<string, number>();
  const enc = R(font.get("Encoding"));
  const fd = R(font.get("FontDescriptor"));
  const flags = fd.isDictionary() ? num(R(fd.get("Flags")), 0) : 0;
  const symbolic = (flags & 4) !== 0 || isSymbolicFont(name);
  const baseName = enc.isName() ? enc.asName() : enc.isDictionary() && R(enc.get("BaseEncoding")).isName() ? R(enc.get("BaseEncoding")).asName() : "";
  // Fonte simbólica sem /Encoding explícita não mapeia ASCII 1:1 (geraria glifos errados ou quadradinhos)
  if (symbolic && !baseName && !(enc.isDictionary() && R(enc.get("Differences")).isArray())) return map;
  const byCode = new Map<number, string>();
  if (baseName === "WinAnsiEncoding") for (let c = 0x20; c <= 0xff; c++) { if (WINANSI_NAMES[c - 0x20] !== "-") byCode.set(c, winAnsiChar(c)); }
  else if (!symbolic) {
    // StandardEncoding e MacRomanEncoding só coincidem com a WinAnsi no ASCII (menos as aspas simples)
    for (let c = 0x20; c <= 0x7e; c++) if (c !== 0x27 && c !== 0x60) byCode.set(c, String.fromCharCode(c));
  }
  if (enc.isDictionary()) {
    const diff = R(enc.get("Differences"));
    if (diff.isArray()) {
      let code = 0;
      diff.forEach((v) => {
        if (v.isNumber()) code = v.asNumber();
        else if (v.isName()) { const ch = glyphChar(v.asName()); if (ch) byCode.set(code, ch); else byCode.delete(code); code++; }
      });
    }
  }
  for (const [code, ch] of byCode) if (!map.has(ch)) map.set(ch, code);
  return map;
}

// ---------- larguras ----------

/** Resolve referências indiretas sem quebrar em objetos nulos (chave ausente). */
const R = (o: mupdf.PDFObject) => (o.isIndirect() ? o.resolve() : o);

const num = (o: mupdf.PDFObject, dflt: number) => (o.isNumber() ? o.asNumber() : dflt);

function cidWidths(desc: mupdf.PDFObject): { width: (cid: number) => number; hasW: boolean; hasDW: boolean; known: Set<number> } {
  const dwObj = R(desc.get("DW"));
  const hasDW = dwObj.isNumber();
  const dw = hasDW ? dwObj.asNumber() : 1000;
  const table = new Map<number, number>();
  const w = R(desc.get("W"));
  if (w.isArray()) {
    const items: mupdf.PDFObject[] = [];
    w.forEach((v) => items.push(R(v)));
    let i = 0;
    while (i < items.length) {
      const first = items[i];
      if (!first.isNumber()) { i++; continue; }
      const c = first.asNumber();
      const next = items[i + 1];
      if (next?.isArray()) {
        let k = 0;
        next.forEach((v) => { table.set(c + k, num(R(v), dw)); k++; });
        i += 2;
      } else if (next?.isNumber() && items[i + 2]?.isNumber()) {
        const last = next.asNumber(), width = items[i + 2].asNumber();
        for (let x = c; x <= last && x - c < 65536; x++) table.set(x, width);
        i += 3;
      } else i++;
    }
  }
  return { width: (cid) => table.get(cid) ?? dw, hasW: table.size > 0, hasDW, known: new Set(table.keys()) };
}

/** Verifica se um CID tem GID diferente de 0 no fluxo /CIDToGIDMap (quando presente). */
function cidToGidChecker(desc: mupdf.PDFObject): ((cid: number) => boolean) | null {
  const m = desc.get("CIDToGIDMap");
  if (!m.isStream()) return null;
  let bytes: Uint8Array;
  try {
    const buf = m.readStream();
    bytes = new Uint8Array(buf.asUint8Array());
    buf.destroy();
  } catch { return null; }
  return (cid: number) => {
    const off = cid * 2;
    if (off + 1 >= bytes.length) return false;
    return ((bytes[off] << 8) | bytes[off + 1]) > 0;
  };
}

/** Verifica se um CID está marcado como presente no fluxo /CIDSet do FontDescriptor (quando presente). */
function cidSetChecker(fd: mupdf.PDFObject): ((cid: number) => boolean) | null {
  if (!fd.isDictionary()) return null;
  const cs = fd.get("CIDSet");
  if (!cs.isStream()) return null;
  let bytes: Uint8Array;
  try {
    const buf = cs.readStream();
    bytes = new Uint8Array(buf.asUint8Array());
    buf.destroy();
  } catch { return null; }
  if (!bytes.length) return null;
  return (cid: number) => {
    const idx = cid >> 3;
    if (idx >= bytes.length) return false;
    return (bytes[idx] & (0x80 >> (cid & 7))) !== 0;
  };
}

function simpleWidths(font: mupdf.PDFObject): { first: number; last: number; width: (code: number) => number } {
  const first = num(font.get("FirstChar"), 0), last = num(font.get("LastChar"), 255);
  const list: number[] = [];
  const ws = R(font.get("Widths"));
  if (ws.isArray()) ws.forEach((v) => list.push(num(R(v), 0)));
  const missing = num(R(font.get("FontDescriptor")).get("MissingWidth"), 0);
  return { first, last, width: (code) => list[code - first] ?? missing };
}

// ---------- fonte original do documento ----------

/** Todas as fontes (por referência) nos recursos da página e dos formulários (XObjects) dela. */
function pageFonts(pageObj: mupdf.PDFObject): mupdf.PDFObject[] {
  const out: mupdf.PDFObject[] = [];
  const seenForms = new Set<number>();
  const walk = (res: mupdf.PDFObject, depth: number) => {
    if (!res.isDictionary() || depth > 5) return;
    const fonts = R(res.get("Font"));
    if (fonts.isDictionary()) fonts.forEach((v) => { if (v.isIndirect()) out.push(v); });
    const xo = R(res.get("XObject"));
    if (xo.isDictionary()) xo.forEach((v) => {
      if (!v.isIndirect() || seenForms.has(v.asIndirect())) return;
      seenForms.add(v.asIndirect());
      const r = R(v);
      if (r.get("Subtype").isName() && r.get("Subtype").asName() === "Form") walk(R(r.get("Resources")), depth + 1);
    });
  };
  walk(R(pageObj.getInheritable("Resources")), 0);
  return out;
}

const baseFontName = (f: mupdf.PDFObject) => { const b = R(f).get("BaseFont"); return b.isName() ? b.asName() : ""; };

/**
 * Nomes pelos quais a fonte pode aparecer no texto extraído: o /BaseFont, o da fonte descendente
 * (Type0) e o /FontName do descritor. O MuPDF, por exemplo, grava "Times-Roman" no /BaseFont e
 * "NimbusRoman-Regular" na descendente, e é este que o texto extraído mostra.
 */
function fontNames(ref: mupdf.PDFObject): string[] {
  const f = R(ref);
  const names = [baseFontName(f)];
  const fd = R(f.get("FontDescriptor"));
  if (fd.isDictionary() && fd.get("FontName").isName()) names.push(fd.get("FontName").asName());
  const df = R(f.get("DescendantFonts"));
  if (df.isArray() && df.length > 0) {
    const d = R(df.get(0));
    names.push(baseFontName(d));
    const dfd = R(d.get("FontDescriptor"));
    if (dfd.isDictionary() && dfd.get("FontName").isName()) names.push(dfd.get("FontName").asName());
  }
  return names.filter(Boolean);
}

/** Monta a fonte de glifos a partir de uma fonte do PDF; null se o tipo não é suportado. */
function sourceFromFont(ref: mupdf.PDFObject, seen: Set<string>): GlyphSource | null {
  const f = R(ref);
  const subObj = R(f.get("Subtype"));
  const sub = subObj.isName() ? subObj.asName() : "";
  const names = fontNames(ref);
  const name = baseFontName(ref) || names[0] || "";
  const subset = names.some(isSubset);
  const label = fontStyle(name).family;
  const key = `PapiroO${ref.asIndirect()}`;
  // o MuPDF só lê o conteúdo de um fluxo pela referência indireta (não pelo objeto já resolvido)
  const tu = f.get("ToUnicode");
  if (sub === "Type0") {
    const enc = R(f.get("Encoding"));
    if (!enc.isName() || enc.asName() !== "Identity-H" || !tu.isStream()) return null;
    const desc = R(f.get("DescendantFonts"));
    if (!desc.isArray() || desc.length < 1) return null;
    let parsed: { map: Map<string, number>; bytes: number };
    try { parsed = parseToUnicode(tu.readStream().asString()); } catch { return null; }
    if (parsed.bytes > 2 || !parsed.map.size) return null;
    const descObj = R(desc.get(0));
    const fd = R(descObj.get("FontDescriptor"));
    const hasCid = cidSetChecker(fd);
    const hasGid = cidToGidChecker(descObj);
    const { width, hasW, hasDW, known } = cidWidths(descObj);
    const isSub = subset || hasCid !== null;
    return {
      kind: "original", key, ref, twoByte: true, label,
      glyph: (ch) => {
        const code = parsed.map.get(ch);
        if (code === undefined || code === 0) return null;
        // Em subconjunto (ex.: ABCDEF+Calibri do Word/Chrome), o ToUnicode pode conter faixas
        // amplas cujos glifos foram removidos do FontFile2 — sem esta checagem sairia quadradinho (.notdef).
        if (isSub && !seen.has(ch)) return null;
        if (hasCid && !hasCid(code)) return null;
        if (hasGid && !hasGid(code)) return null;
        // Se a fonte tem tabela /W explícita sem /DW e o código nem aparece nela, não arrisca .notdef
        if (hasW && !hasDW && !known.has(code) && !seen.has(ch)) return null;
        const w = width(code);
        if (!(w > 0) && ch !== " ") return null;
        return { code, w };
      },
    };
  }
  if (sub === "TrueType" || sub === "Type1" || sub === "MMType1") {
    const fd = R(f.get("FontDescriptor"));
    const hasCharSet = fd.isDictionary() && !fd.get("CharSet").isNull();
    const isSub = subset || hasCharSet;
    let map: Map<string, number>;
    if (tu.isStream()) {
      try { const p = parseToUnicode(tu.readStream().asString()); if (p.bytes > 2) return null; map = p.map; } catch { return null; }
    } else map = simpleEncoding(f, name);
    if (!map.size) return null;
    const { first, last, width } = simpleWidths(f);
    return {
      kind: "original", key, ref, twoByte: false, label,
      glyph: (ch) => {
        const code = map.get(ch);
        if (code === undefined || code < first || code > last || code > 255) return null;
        const w = width(code);
        // Num subconjunto só é seguro usar o que o documento já desenha com essa fonte:
        // as outras letras podem não ter sido embutidas (sairiam em branco/quadradinho).
        if ((!(w > 0) && ch !== " ") || (isSub && !seen.has(ch))) return null;
        return { code, w };
      },
    };
  }
  return null; // Type3 e outros: o texto novo usa outra fonte
}

/**
 * Fonte original para o texto `want`: a fonte da página com esse nome que tem mais letras do texto novo.
 * `seen` = caracteres que a página já desenha com essa fonte.
 */
export function originalSource(pageObj: mupdf.PDFObject, fontName: string, want: string, seen: Set<string>): GlyphSource | null {
  const plain = stripSubset(fontName);
  const fonts = pageFonts(pageObj).map((ref) => ({ ref, names: fontNames(ref) }));
  let found = fonts.filter((f) => f.names.includes(fontName));
  if (!found.length) found = fonts.filter((f) => f.names.some((n) => stripSubset(n) === plain));
  const cands = found.map((f) => f.ref);
  const chars = [...new Set(want)].filter((c) => c !== "\n");
  let best: GlyphSource | null = null, bestScore = -1;
  for (const ref of cands) {
    const src = sourceFromFont(ref, seen);
    if (!src) continue;
    const score = chars.filter((c) => src.glyph(c)).length;
    if (score > bestScore) { best = src; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}
