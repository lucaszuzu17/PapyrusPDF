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

const STYLE = /(bold|black|heavy|semibold|demibold|demi|light|medium|thin|italic|oblique|regular|condensed|narrow)/gi;

export interface FontStyle { family: string; bold: boolean; italic: boolean }

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
  const generic = /times|roman|serif|georgia|garamond|cambria|book/i.test(family) && !/sans/i.test(family)
    ? "serif" : /courier|mono|consol/i.test(family) ? "monospace" : "sans-serif";
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
