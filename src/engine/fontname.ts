// Nomes de fonte de PDF → família legível. Sem dependências: usado pelo motor e pela interface.

/** Tira o prefixo de subconjunto ("ABCDEF+Calibri" → "Calibri"). */
export const stripSubset = (name: string) => name.replace(/^[A-Z]{6}\+/, "");

/** A fonte do PDF é um subconjunto (só traz as letras que o documento usava)? */
export const isSubset = (name: string) => /^[A-Z]{6}\+/.test(name);

// As fontes padrão do PDF aparecem no MuPDF com os nomes das equivalentes livres (Nimbus).
const ALIASES: [RegExp, string][] = [
  [/^(nimbussans|helvetica|arial|liberationsans)$/i, "Arial"],
  [/^(nimbusroman|times|liberationserif)$/i, "Times New Roman"],
  [/^(nimbusmono|courier|liberationmono)$/i, "Courier New"],
];

const STYLE = /(bold|black|heavy|semibold|demibold|demi|extrabold|ultrabold|light|extralight|ultralight|semilight|medium|thin|italic|oblique|regular|book|roman|condensed|narrow)/gi;

const SYMBOLIC = /^(symbol|wingdings\d*|webdings|zapfdingbats|dingbats|marlett|mtextra|opensymbol|applesymbols|fontawesome|materialicons|icomoon|glyphicons)$/i;

export interface FontStyle { family: string; bold: boolean; italic: boolean }

/** A fonte é de símbolos/ícones (não serve para texto latino comum)? */
export function isSymbolicFont(pdfName: string): boolean {
  const clean = stripSubset(pdfName).replace(/(PSMT|PS|MT)(?=$|[-,])/g, "").split(/[-,]/)[0].replace(/[^a-z0-9]/gi, "");
  return SYMBOLIC.test(clean);
}

/** Categoria tipográfica genérica da fonte ("sans", "serif" ou "mono"). */
export function genericFontCategory(pdfName: string): "sans" | "serif" | "mono" {
  const { family } = fontStyle(pdfName);
  if (/courier|mono|consol|menlo|fira\s*code|jetbrains/i.test(family)) return "mono";
  if (/times|roman|serif|georgia|garamond|cambria|book|palatino|baskerville|didot/i.test(family) && !/sans/i.test(family)) return "serif";
  return "sans";
}

/**
 * Família e estilo a partir do nome PostScript do PDF:
 * "BCDGEE+TimesNewRomanPS-BoldItalicMT" → Times New Roman, negrito, itálico.
 */
export function fontStyle(pdfName: string): FontStyle {
  const name = stripSubset(pdfName);
  const [rawFamily, ...rest] = name.split(/[-,]/);
  const styleText = rest.join(" ");
  const bold = /bold|black|heavy|semibold|demi/i.test(name);
  const italic = /italic|oblique|-it$|,it$/i.test(name);
  let family = rawFamily.replace(/(PSMT|PS|MT)$/, "");
  for (const [re, real] of ALIASES) if (re.test(family)) return { family: real, bold, italic };
  // "TimesNewRoman" → "Times New Roman"; "SegoeUI" → "Segoe UI"
  family = family.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").trim();
  // estilo grudado na família sem hífen ("CalibriBold") vira estilo
  if (!styleText) family = family.replace(new RegExp(`\\s*${STYLE.source}$`, "i"), "").trim() || family;
  return { family: family || "Arial", bold, italic };
}

/** Pilha de fontes CSS para mostrar o texto parecido com o do PDF. */
export function cssFontFamily(pdfName: string): string {
  const { family } = fontStyle(pdfName);
  const cat = genericFontCategory(pdfName);
  const generic = cat === "serif" ? "serif" : cat === "mono" ? "monospace" : "sans-serif";
  return `"${family.replace(/"/g, "")}", ${generic}`;
}

/** Chave para comparar nomes de fonte ("Times New Roman Bold" e "TimesNewRomanPS-BoldMT" → "timesnewromanbold"). */
export function fontKey(name: string): string {
  return stripSubset(name)
    .replace(/(PSMT|PS|MT)(?=$|[-,])/g, "")
    .replace(/PS(?=-)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(mt|psmt)$/, "");
}

// Símbolos de área privada (PUA) gravados por Word/Symbol/Wingdings em PDFs → Unicode padrão.
const PUA_MAP: Record<string, string> = {
  "\uF0B7": "•", "\uF09F": "•", "\uF06C": "•",
  "\uF0A7": "▪", "\uF06E": "■", "\uF06F": "□",
  "\uF076": "❖", "\uF0D8": "➢", "\uF0FC": "✓", "\uF0FB": "✗",
  "\uF0A8": "☐", "\uF0FE": "☑", "\uF0B0": "°", "\uF0B1": "±",
  "\uF0A3": "≤", "\uF0B3": "≥", "\uF0B9": "≠",
  "\uF0AE": "→", "\uF0AC": "←", "\uF0E0": "⇒",
  "\uF020": " ", "\uF02D": "-",
};

// Ligaduras de apresentação latina extraídas de PDFs (LaTeX/Word) → letras normais editáveis.
const LIGATURES: Record<string, string> = {
  "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl",
  "\uFB03": "ffi", "\uFB04": "ffl", "\uFB05": "st", "\uFB06": "st",
};

/**
 * Normaliza texto extraído ou digitado antes de editar/gravar no PDF:
 * - junta acentos decompostos (NFD → NFC) para não virarem "a?";
 * - converte marcadores PUA (Symbol/Wingdings do Word) e ligaduras em Unicode padrão;
 * - troca espaços exóticos por espaço comum e remove caracteres invisíveis sem glifo.
 */
export function normalizePdfText(text: string): string {
  let out = text.replace(/\r\n?/g, "\n").normalize("NFC");
  out = out.replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "");
  out = out.replace(/[\u00A0\u2000-\u200A\u202F\u205F]/g, " ");
  out = out.replace(/[\uF020-\uF0FF\uFB00-\uFB06]/g, (ch) => PUA_MAP[ch] ?? LIGATURES[ch] ?? ch);
  return out;
}
