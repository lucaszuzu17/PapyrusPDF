// Comparação entre dois PDFs: diferenças de texto (linhas adicionadas/removidas) e visual (mapa de pixels).
import * as mupdf from "mupdf";
import type { ComparePageDiff, CompareReport } from "./types.ts";

function pageLines(doc: mupdf.PDFDocument, index: number): string[] {
  const page = doc.loadPage(index);
  const st = page.toStructuredText("preserve-whitespace");
  const lines = st.asText()
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  st.destroy();
  page.destroy();
  return lines;
}

/** Diff simples por LCS em linhas (limita tabela para documentos gigantes não travarem). */
export function diffLines(a: string[], b: string[]): { added: string[]; removed: string[] } {
  const n = a.length, m = b.length;
  if (n * m > 250_000) {
    const setA = new Set(a), setB = new Set(b);
    return { added: b.filter((l) => !setA.has(l)), removed: a.filter((l) => !setB.has(l)) };
  }
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const added: string[] = [], removed: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { removed.push(a[i++]); }
    else { added.push(b[j++]); }
  }
  while (i < n) removed.push(a[i++]);
  while (j < m) added.push(b[j++]);
  return { added, removed };
}

function renderRgb(doc: mupdf.PDFDocument, index: number, scale: number): { w: number; h: number; data: Uint8Array } {
  const page = doc.loadPage(index);
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const out = { w: pix.getWidth(), h: pix.getHeight(), data: new Uint8Array(pix.getPixels()) };
  pix.destroy();
  page.destroy();
  return out;
}

/** Gera imagem PNG destacando diferenças visuais em vermelho sobre o fundo esmaecido. */
function visualDiff(a: { w: number; h: number; data: Uint8Array }, b: { w: number; h: number; data: Uint8Array }): { pct: number; png: Uint8Array | null } {
  const w = Math.max(a.w, b.w), h = Math.max(a.h, b.h);
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const dst = pix.getPixels();
  let changed = 0;
  const total = Math.max(1, w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const oi = (y * w + x) * 3;
      const inA = x < a.w && y < a.h;
      const inB = x < b.w && y < b.h;
      const ai = (y * a.w + x) * 3;
      const bi = (y * b.w + x) * 3;
      const rA = inA ? a.data[ai] : 255, gA = inA ? a.data[ai + 1] : 255, bA = inA ? a.data[ai + 2] : 255;
      const rB = inB ? b.data[bi] : 255, gB = inB ? b.data[bi + 1] : 255, bB = inB ? b.data[bi + 2] : 255;
      const d = Math.abs(rA - rB) + Math.abs(gA - gB) + Math.abs(bA - bB);
      if (d > 40) {
        changed++;
        // Destaque forte: vermelho para alterado/removido, azul para só no novo
        const darkerInB = (rB + gB + bB) < (rA + gA + bA) - 30;
        dst[oi] = darkerInB ? 20 : 220;
        dst[oi + 1] = darkerInB ? 110 : 35;
        dst[oi + 2] = darkerInB ? 230 : 45;
      } else {
        // Conteúdo igual suavizado para o destaque saltar aos olhos
        const gray = Math.round((rA + gA + bA) / 3);
        const soft = Math.min(255, Math.round(gray * 0.45 + 140));
        dst[oi] = soft; dst[oi + 1] = soft; dst[oi + 2] = soft;
      }
    }
  }
  const pct = Math.round((changed / total) * 10000) / 100;
  const png = changed > 0 ? new Uint8Array(pix.asPNG()) : null;
  pix.destroy();
  return { pct, png };
}

/** Compara dois documentos PDF página a página (texto e aparência). */
export function compareDocuments(docA: mupdf.PDFDocument, docB: mupdf.PDFDocument, nameA: string, nameB: string): CompareReport {
  const nA = docA.countPages();
  const nB = docB.countPages();
  const maxN = Math.max(nA, nB);
  const pages: ComparePageDiff[] = [];
  let same = 0, changed = 0, onlyA = 0, onlyB = 0;

  for (let i = 0; i < maxN; i++) {
    if (i >= nB) {
      onlyA++;
      pages.push({ page: i, status: "onlyA", visualDiffPct: 100, added: [], removed: pageLines(docA, i).slice(0, 60), diffPng: null });
      continue;
    }
    if (i >= nA) {
      onlyB++;
      pages.push({ page: i, status: "onlyB", visualDiffPct: 100, added: pageLines(docB, i).slice(0, 60), removed: [], diffPng: null });
      continue;
    }
    const { added, removed } = diffLines(pageLines(docA, i), pageLines(docB, i));
    const vis = visualDiff(renderRgb(docA, i, 0.75), renderRgb(docB, i, 0.75));
    const isDiff = added.length > 0 || removed.length > 0 || vis.pct >= 0.05;
    if (isDiff) changed++; else same++;
    pages.push({
      page: i,
      status: isDiff ? "changed" : "same",
      visualDiffPct: vis.pct,
      added: added.slice(0, 80),
      removed: removed.slice(0, 80),
      diffPng: isDiff ? vis.png : null,
    });
  }

  return { nameA, nameB, pagesA: nA, pagesB: nB, same, changed, onlyA, onlyB, pages };
}
