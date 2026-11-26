// Tipos e cálculos puros do diálogo de impressão (estilo Foxit).

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
  description?: string;
}

export type PaperSizeId = "A4" | "Letter" | "A3" | "Legal" | "A5";
export type PrintRangeMode = "all" | "current" | "view" | "custom";
export type PrintSubset = "all" | "odd" | "even";
export type PrintHandlingMode = "scale" | "poster" | "multiple" | "booklet";
export type PrintScaleMode = "none" | "fit" | "shrink" | "custom";
export type PrintOrientation = "auto" | "portrait" | "landscape";
export type PrintWhat = "docAndAnnots" | "docOnly";
export type MultipleOrder = "horizontal" | "horizontalRev" | "vertical";
export type BookletSubset = "both" | "front" | "back";
export type BookletBinding = "left" | "right";

export interface PrintJobOptions {
  printer: string; // "" = impressora padrão do sistema
  copies: number;
  collate: boolean;
  grayscale: boolean;
  printAsImage: boolean;
  showBorder: boolean;

  rangeMode: PrintRangeMode;
  customRange: string;
  subset: PrintSubset;
  reverse: boolean;
  currentPage: number;

  handling: PrintHandlingMode;
  // Dimensionar
  scaleMode: PrintScaleMode;
  customScale: number; // % (10..400)
  choosePaperByPdfSize: boolean;
  // Lado a lado (pôster)
  tileScale: number; // % (10..400)
  tileOverlapMm: number; // mm (0..50)
  tileCutMarks: boolean;
  // Várias páginas por folha (N-up)
  pagesPerSheet: 2 | 4 | 6 | 9 | 16;
  multipleOrder: MultipleOrder;
  multipleBorder: boolean;
  // Livreto
  bookletSubset: BookletSubset;
  bookletBinding: BookletBinding;

  // Papel & orientação
  duplex: boolean;
  duplexEdge: "long" | "short";
  autoRotate: boolean;
  autoCenter: boolean;
  orientation: PrintOrientation;
  paperSize: PaperSizeId;
  printWhat: PrintWhat;

  /** Quando true, abre o diálogo nativo de impressão do Windows (Propriedades / sistema). */
  systemDialog?: boolean;
}

/** Dimensões em milímetros (retrato: largura <= altura). */
export const PAPER_MM: Record<PaperSizeId, { w: number; h: number; label: string }> = {
  A4: { w: 210, h: 297, label: "A4 (21,0 × 29,7 cm)" },
  Letter: { w: 215.9, h: 279.4, label: "Carta / Letter (21,6 × 27,9 cm)" },
  A3: { w: 297, h: 420, label: "A3 (29,7 × 42,0 cm)" },
  Legal: { w: 215.9, h: 355.6, label: "Ofício / Legal (21,6 × 35,6 cm)" },
  A5: { w: 148, h: 210, label: "A5 (14,8 × 21,0 cm)" },
};

export const PT_TO_MM = 25.4 / 72;

export function defaultPrintOptions(currentPage = 0, printer = ""): PrintJobOptions {
  return {
    printer,
    copies: 1,
    collate: true,
    grayscale: false,
    printAsImage: false,
    showBorder: false,
    rangeMode: "all",
    customRange: "",
    subset: "all",
    reverse: false,
    currentPage,
    handling: "scale",
    scaleMode: "fit",
    customScale: 100,
    choosePaperByPdfSize: false,
    tileScale: 100,
    tileOverlapMm: 5,
    tileCutMarks: true,
    pagesPerSheet: 2,
    multipleOrder: "horizontal",
    multipleBorder: true,
    bookletSubset: "both",
    bookletBinding: "left",
    duplex: false,
    duplexEdge: "long",
    autoRotate: true,
    autoCenter: true,
    orientation: "auto",
    paperSize: "A4",
    printWhat: "docAndAnnots",
    systemDialog: false,
  };
}

/** Interpreta faixas como "1, 3-5, 9" em índices base-0 válidos dentro de [0, total - 1]. */
export function parsePageRanges(spec: string, total: number): number[] {
  if (total <= 0) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of spec.split(/[,;]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Math.max(1, Math.min(total, Number(m[1])));
      const b = Math.max(1, Math.min(total, Number(m[2])));
      const step = a <= b ? 1 : -1;
      for (let p = a; step > 0 ? p <= b : p >= b; p += step) {
        const idx = p - 1;
        if (!seen.has(idx)) { seen.add(idx); out.push(idx); }
      }
    } else if (/^\d+$/.test(part)) {
      const p = Number(part);
      if (p >= 1 && p <= total) {
        const idx = p - 1;
        if (!seen.has(idx)) { seen.add(idx); out.push(idx); }
      }
    }
  }
  return out;
}

/** Resolve a lista ordenada final de páginas (base-0) a imprimir. */
export function resolvePrintPages(
  opts: Pick<PrintJobOptions, "rangeMode" | "customRange" | "subset" | "reverse" | "currentPage">,
  total: number,
): number[] {
  if (total <= 0) return [];
  let pages: number[];
  if (opts.rangeMode === "current" || opts.rangeMode === "view") {
    const p = Math.max(0, Math.min(total - 1, opts.currentPage));
    pages = [p];
  } else if (opts.rangeMode === "custom") {
    pages = parsePageRanges(opts.customRange, total);
  } else {
    pages = Array.from({ length: total }, (_, i) => i);
  }
  if (opts.subset === "odd") pages = pages.filter((p) => p % 2 === 0); // página 1 = índice 0
  else if (opts.subset === "even") pages = pages.filter((p) => p % 2 === 1);
  if (opts.reverse) pages = [...pages].reverse();
  return pages;
}

/** Resolve as dimensões da folha em mm levando em conta orientação e auto-rotação. */
export function resolvePaperMm(
  paperSize: PaperSizeId,
  orientation: PrintOrientation,
  autoRotate: boolean,
  docWmm: number,
  docHmm: number,
  chooseByPdfSize = false,
): { w: number; h: number; landscape: boolean } {
  if (chooseByPdfSize && docWmm > 10 && docHmm > 10) {
    return { w: docWmm, h: docHmm, landscape: docWmm > docHmm };
  }
  const base = PAPER_MM[paperSize] ?? PAPER_MM.A4;
  const docIsLandscape = docWmm > docHmm;
  let landscape: boolean;
  if (orientation === "landscape") landscape = true;
  else if (orientation === "portrait") landscape = false;
  else landscape = autoRotate ? docIsLandscape : false;
  return landscape
    ? { w: Math.max(base.w, base.h), h: Math.min(base.w, base.h), landscape: true }
    : { w: Math.min(base.w, base.h), h: Math.max(base.w, base.h), landscape: false };
}

/** Calcula a escala efetiva (em %, ex.: 95.52) no modo Dimensionar considerando margem imprimível padrão (5 mm). */
export function computeScalePct(
  docWmm: number,
  docHmm: number,
  paperWmm: number,
  paperHmm: number,
  scaleMode: PrintScaleMode,
  customScale: number,
  marginMm = 5,
): number {
  if (docWmm <= 0 || docHmm <= 0) return 100;
  if (scaleMode === "none") return 100;
  if (scaleMode === "custom") return Math.max(10, Math.min(400, Number.isFinite(customScale) ? customScale : 100));
  const availW = Math.max(10, paperWmm - marginMm * 2);
  const availH = Math.max(10, paperHmm - marginMm * 2);
  const fit = Math.min(availW / docWmm, availH / docHmm) * 100;
  if (scaleMode === "shrink") return Math.min(100, fit);
  return fit;
}

/** Calcula grade (colunas × linhas) no modo Páginas Grandes Lado a Lado (pôster). */
export function computeTileGrid(
  docWmm: number,
  docHmm: number,
  paperWmm: number,
  paperHmm: number,
  tileScalePct: number,
  overlapMm: number,
  marginMm = 6,
): { cols: number; rows: number; scaledW: number; scaledH: number; tileW: number; tileH: number; stepX: number; stepY: number } {
  const s = Math.max(10, Math.min(400, tileScalePct || 100)) / 100;
  const scaledW = docWmm * s;
  const scaledH = docHmm * s;
  const tileW = Math.max(20, paperWmm - marginMm * 2);
  const tileH = Math.max(20, paperHmm - marginMm * 2);
  const ov = Math.max(0, Math.min(Math.min(tileW, tileH) * 0.4, overlapMm || 0));
  const stepX = Math.max(10, tileW - ov);
  const stepY = Math.max(10, tileH - ov);
  const cols = Math.max(1, scaledW <= tileW + 0.5 ? 1 : Math.ceil((scaledW - ov) / stepX));
  const rows = Math.max(1, scaledH <= tileH + 0.5 ? 1 : Math.ceil((scaledH - ov) / stepY));
  return { cols, rows, scaledW, scaledH, tileW, tileH, stepX, stepY };
}

/** Grade (colunas × linhas) para Várias Páginas Por Folha (N-up). */
export function multipleGrid(perSheet: 2 | 4 | 6 | 9 | 16, sheetLandscape: boolean): { cols: number; rows: number } {
  switch (perSheet) {
    case 2: return sheetLandscape ? { cols: 2, rows: 1 } : { cols: 1, rows: 2 };
    case 4: return { cols: 2, rows: 2 };
    case 6: return sheetLandscape ? { cols: 3, rows: 2 } : { cols: 2, rows: 3 };
    case 9: return { cols: 3, rows: 3 };
    case 16: return { cols: 4, rows: 4 };
  }
}

/** Gera pares [esquerda, direita] de páginas (null = verso em branco) para impressão em Livreto. */
export function computeBookletSpreads(
  pages: number[],
  binding: BookletBinding,
  subset: BookletSubset,
): [number | null, number | null][] {
  if (!pages.length) return [];
  const padded = Math.ceil(pages.length / 4) * 4;
  const slots: (number | null)[] = Array.from({ length: padded }, (_, i) => (i < pages.length ? pages[i] : null));
  const spreads: [number | null, number | null][] = [];
  const sheets = padded / 4;
  for (let s = 0; s < sheets; s++) {
    // frente da folha: [última, primeira]; verso da folha: [segunda, penúltima]
    const fLeft = slots[padded - 1 - 2 * s];
    const fRight = slots[2 * s];
    const bLeft = slots[2 * s + 1];
    const bRight = slots[padded - 2 - 2 * s];
    const front: [number | null, number | null] = binding === "right" ? [fRight, fLeft] : [fLeft, fRight];
    const back: [number | null, number | null] = binding === "right" ? [bRight, bLeft] : [bLeft, bRight];
    if (subset === "both" || subset === "front") spreads.push(front);
    if (subset === "both" || subset === "back") spreads.push(back);
  }
  return spreads;
}
