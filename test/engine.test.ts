// Testa o motor sem interface: node --test test/engine.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PdfEngine, mupdf } from "../src/engine/core.ts";
import { createRecognizer } from "../src/engine/ocr-node.ts";

const OUT = join(import.meta.dirname, "out");
mkdirSync(OUT, { recursive: true });

/** PDF de amostra com texto em duas fontes, gerado pelo próprio MuPDF. */
function samplePdf(pages = 3): Uint8Array {
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "pdf", "");
  const helv = new mupdf.Font("Helvetica");
  const times = new mupdf.Font("Times-Roman");
  for (let p = 0; p < pages; p++) {
    const dev = w.beginPage([0, 0, 595, 842]);
    const lines: [mupdf.Font, number, string][] = [
      [helv, 24, `Relatório de teste — página ${p + 1}`],
      [times, 14, "O motor deve permitir editar este parágrafo com acentuação."],
      [times, 14, "Ação, coração, informação: São Paulo e Manaus."],
    ];
    lines.forEach(([font, size, s], i) => {
      const t = new mupdf.Text();
      t.showString(font, [size, 0, 0, -size, 72, 100 + i * 40], s);
      dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0.1, 0.1, 0.4], 1);
    });
    const path = new mupdf.Path();
    path.rect(72, 300, 300, 400);
    dev.fillPath(path, false, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0.8, 0.9, 1], 1);
    w.endPage();
  }
  w.close();
  return new Uint8Array(buf.asUint8Array());
}

/** PDF "escaneado": só uma imagem da página, sem texto. */
function scannedPdf(): Uint8Array {
  const eng = new PdfEngine();
  eng.open(samplePdf(1));
  const png = eng.renderPng(0, 200 / 72);
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "pdf", "");
  const dev = w.beginPage([0, 0, 595, 842]);
  dev.fillImage(new mupdf.Image(png), [595, 0, 0, 842, 0, 0], 1);
  w.endPage(); w.close();
  return new Uint8Array(buf.asUint8Array());
}

const allText = (e: PdfEngine, i: number) => e.pageText(i).flatMap((b) => b.lines.map((l) => l.text)).join("\n");

test("abre, renderiza e extrai texto com fonte e posição", () => {
  const e = new PdfEngine();
  const info = e.open(samplePdf());
  assert.equal(info.pageCount, 3);
  const r = e.render(0, 1);
  assert.equal(r.width, 595);
  assert.equal(r.rgba.length, r.width * r.height * 4);
  const lines = e.pageText(0).flatMap((b) => b.lines);
  assert.match(lines[0].text, /Relatório de teste/);
  assert.match(lines[1].font, /Times|NimbusRoman/);
  assert.ok(Math.abs(lines[1].size - 14) < 0.1);
  assert.equal(e.search("coração").length, 3);
});

test("edita texto preservando o resto e com acentos", () => {
  const e = new PdfEngine();
  e.open(samplePdf(1));
  const line = e.pageText(0).flatMap((b) => b.lines)[1];
  e.editText({
    page: 0, area: line.bbox, text: "Parágrafo editado pelo PapyrusPDF: ç, ã, é, €.",
    origin: line.origin, size: line.size, color: line.color, font: line.font,
  });
  const txt = allText(e, 0);
  assert.match(txt, /Parágrafo editado pelo PapyrusPDF: ç, ã, é, €\./);
  assert.doesNotMatch(txt, /O motor deve permitir/);
  assert.match(txt, /Relatório de teste/);
  assert.match(txt, /Ação, coração/);
  // desfazer volta ao original; refazer reaplica
  e.undo();
  assert.match(allText(e, 0), /O motor deve permitir/);
  e.redo();
  const saved = e.save();
  writeFileSync(join(OUT, "editado.pdf"), saved);
  const e2 = new PdfEngine(); e2.open(saved);
  assert.match(allText(e2, 0), /Parágrafo editado/);
  // depois de salvar o desfazer continua disponível (Tier 2) e o documento continua íntegro
  assert.equal(e.info().canUndo, true);
  assert.match(allText(e, 0), /Parágrafo editado/);
});

test("anotações, redação e organização de páginas", () => {
  const e = new PdfEngine();
  e.open(samplePdf(3));
  const line = e.pageText(0).flatMap((b) => b.lines)[2];
  e.addAnnotation(0, { kind: "Highlight", quads: line.chars.map((c) => c.quad) });
  e.addAnnotation(0, { kind: "Text", at: [500, 80], contents: "Comentário" });
  e.addAnnotation(0, { kind: "Ink", strokes: [[[80, 500], [120, 540], [160, 500]]] });
  e.addAnnotation(0, { kind: "FreeText", rect: [72, 600, 300, 630], contents: "Caixa de texto" });
  assert.deepEqual(e.annotations(0).map((a) => a.kind).sort(), ["FreeText", "Highlight", "Ink", "Text"]);

  const target = e.pageText(1).flatMap((b) => b.lines)[1];
  e.addAnnotation(1, { kind: "Redact", rect: target.bbox });
  e.applyRedactions(1);
  assert.doesNotMatch(allText(e, 1), /O motor deve permitir/);

  e.rotatePages([2], 90);
  assert.equal(e.info().pages[2].width, 842);
  e.reorderPages([2, 0, 1]);
  assert.match(allText(e, 1), /página 1/);
  e.insertBlankPage(0);
  assert.equal(e.info().pageCount, 4);
  e.deletePages([0]);
  e.insertFromPdf(samplePdf(2), -1);
  assert.equal(e.info().pageCount, 5);
  const part = new PdfEngine(); part.open(e.extractPages([3, 4]));
  assert.equal(part.info().pageCount, 2);
  assert.equal(e.split(2).length, 3);
  writeFileSync(join(OUT, "anotado.pdf"), e.save());
});

test("OCR em PDF escaneado cria texto pesquisável", { timeout: 180_000 }, async () => {
  const e = new PdfEngine();
  e.open(scannedPdf());
  assert.ok(e.needsOcr(0));
  const ocr = await createRecognizer(join(tmpdir(), "papiro-ocr"));
  try {
    const { words } = await e.ocrPage(0, ocr.recognize, 300);
    assert.ok(words > 10, `poucas palavras: ${words}`);
  } finally { await ocr.dispose(); }
  assert.ok(!e.needsOcr(0));
  assert.ok(e.search("Manaus").length >= 1, allText(e, 0));
  writeFileSync(join(OUT, "ocr.pdf"), e.save());
});
