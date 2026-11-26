// Testes das regras de impressão estilo Foxit (intervalos, subconjunto, livreto, pôster e escala).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeBookletSpreads, computeScalePct, computeTileGrid, defaultPrintOptions,
  multipleGrid, parsePageRanges, resolvePaperMm, resolvePrintPages,
} from "../src/shared/print-types.ts";

test("parsePageRanges interpreta páginas avulsas, intervalos e remove duplicatas", () => {
  assert.deepEqual(parsePageRanges("1, 3-5, 9, 4", 10), [0, 2, 3, 4, 8]);
  assert.deepEqual(parsePageRanges("5-3", 10), [4, 3, 2]);
  assert.deepEqual(parsePageRanges("99, 0, abc", 5), []);
});

test("resolvePrintPages aplica intervalo, ímpares/pares e ordem inversa", () => {
  const base = defaultPrintOptions(2);
  assert.deepEqual(resolvePrintPages(base, 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(resolvePrintPages({ ...base, rangeMode: "current" }, 5), [2]);
  assert.deepEqual(resolvePrintPages({ ...base, subset: "odd" }, 6), [0, 2, 4]);
  assert.deepEqual(resolvePrintPages({ ...base, subset: "even", reverse: true }, 6), [5, 3, 1]);
});

test("computeScalePct e resolvePaperMm calculam escala real e auto-rotação", () => {
  const landPaper = resolvePaperMm("A4", "auto", true, 297, 210);
  assert.equal(landPaper.landscape, true);
  assert.equal(landPaper.w, 297);
  assert.equal(landPaper.h, 210);

  const fit = computeScalePct(297, 210, 297, 210, "fit", 100, 5);
  assert.ok(fit > 95 && fit < 96, `esperado ~95.24%, obtido ${fit}`);
  assert.equal(computeScalePct(297, 210, 297, 210, "none", 100), 100);
  assert.equal(computeScalePct(100, 100, 297, 210, "shrink", 100), 100);
});

test("computeTileGrid divide plantas grandes (A2/A3) em folhas A4 com sobreposição", () => {
  const g = computeTileGrid(420, 297, 297, 210, 100, 5, 6);
  assert.equal(g.cols, 2);
  assert.equal(g.rows, 2);
});

test("computeBookletSpreads e multipleGrid organizam livreto e N-up corretamente", () => {
  // 4 páginas → frente [4, 1], verso [2, 3]
  assert.deepEqual(computeBookletSpreads([0, 1, 2, 3], "left", "both"), [[3, 0], [1, 2]]);
  assert.deepEqual(computeBookletSpreads([0, 1, 2], "left", "front"), [[null, 0]]);
  assert.deepEqual(multipleGrid(6, true), { cols: 3, rows: 2 });
  assert.deepEqual(multipleGrid(6, false), { cols: 2, rows: 3 });
});
