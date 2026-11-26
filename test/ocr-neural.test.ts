// Testes do motor de OCR neural (Opção A: PaddleOCR PP-OCRv4/v5 ONNX) +
// pré-processamento avançado (Opção B: remoção local de sombras + auto-orientação 0°/90°/180°/270°).
// node --test test/ocr-neural.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PdfEngine, mupdf } from "../src/engine/core.ts";
import { createRecognizer } from "../src/engine/ocr-node.ts";
import { isPaddleAvailable } from "../src/engine/ocr-paddle.ts";
import { rotatePixels90, type QuarterTurn } from "../src/engine/ocr-prep.ts";

const pageTextFlat = (e: PdfEngine, p = 0) =>
  e.pageText(p).flatMap((b) => b.lines.map((l) => l.text)).join(" ");

function winAnsiHex(text: string): string {
  let hex = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const b = cp === 0x2014 ? 0x97 : cp <= 0xff ? cp : 0x3f;
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Renderiza linhas de texto em um Pixmap RGB e devolve buffer + dimensões. */
function renderLinesRgb(lines: { text: string; x: number; y: number; size: number }[], dpi = 200): { pixels: Uint8Array; w: number; h: number } {
  const doc = new mupdf.PDFDocument();
  const f = doc.newDictionary();
  f.put("Type", doc.newName("Font")); f.put("Subtype", doc.newName("Type1"));
  f.put("BaseFont", doc.newName("Helvetica")); f.put("Encoding", doc.newName("WinAnsiEncoding"));
  const res = doc.newDictionary();
  const fd = doc.newDictionary(); fd.put("F1", doc.addObject(f)); res.put("Font", fd);
  const ops = lines.map((l) => `BT /F1 ${l.size} Tf ${l.x} ${l.y} Td <${winAnsiHex(l.text)}> Tj ET`).join("\n");
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, ops));
  const p = doc.loadPage(0);
  const pix = p.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false, true);
  const out = { pixels: new Uint8Array(pix.getPixels()), w: pix.getWidth(), h: pix.getHeight() };
  pix.destroy(); p.destroy(); doc.destroy();
  return out;
}

function rgbToJpeg(pixels: Uint8Array, w: number, h: number): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  pix.getPixels().set(pixels);
  const jpg = new Uint8Array(pix.asJPEG(88));
  pix.destroy();
  return jpg;
}

test("PaddleOCR neural (PP-OCRv5 Latin) reconhece PT/EN/ES com acentos e tabela multi-coluna", async () => {
  assert.equal(isPaddleAvailable(), true, "modelos ONNX presentes em models/ocr");
  const img = renderLinesRgb([
    { text: "Ação rápida: documentação e aprovação", x: 60, y: 740, size: 15 },
    { text: "Información oficial de España y México", x: 60, y: 710, size: 15 },
    { text: "Invoice #4821 - Total: $1,250.00", x: 60, y: 680, size: 15 },
    { text: "Produto", x: 60, y: 620, size: 13 },
    { text: "Qtd", x: 260, y: 620, size: 13 },
    { text: "Valor", x: 360, y: 620, size: 13 },
    { text: "Licença Offline", x: 60, y: 595, size: 13 },
    { text: "2", x: 260, y: 595, size: 13 },
    { text: "R$ 6.450,90", x: 360, y: 595, size: 13 },
  ], 220);

  const e = new PdfEngine();
  e.imagesToPdf([rgbToJpeg(img.pixels, img.w, img.h)], { page: "A4" }, "multilang");
  assert.equal(e.needsOcr(0), true);

  const rec = await createRecognizer(join(tmpdir(), "papiro-neural-test"), "por", "neural");
  assert.equal(rec.engineKind, "paddle");
  try {
    const r = await e.ocrPage(0, rec.recognize, 240, true);
    assert.ok(r.words >= 18, `esperava >= 18 palavras, veio ${r.words}`);
    assert.equal(r.orientedDeg, 0);
    const txt = pageTextFlat(e, 0);
    assert.match(txt, /Ação/);
    assert.match(txt, /documentação/);
    assert.match(txt, /España/);
    assert.match(txt, /\$1,250\.00/);
    assert.match(txt, /Licença/);
    assert.match(txt, /6\.450,90/);
    assert.ok(e.search("documentação").length >= 1, "busca encontra palavra acentuada");
  } finally {
    await rec.dispose();
  }
});

test("remoção local de sombras corrige foto com gradiente forte de sombra (65% escuro) + OCR neural", async () => {
  const img = renderLinesRgb([
    { text: "LAUDO DE INSPECAO TECNICA 2026", x: 60, y: 720, size: 16 },
    { text: "Aprovado sem ressalvas pela engenharia de Campinas", x: 60, y: 680, size: 14 },
    { text: "Protocolo definitivo: BR-90451-SP", x: 60, y: 645, size: 14 },
  ], 200);

  // Aplica sombra forte progressiva na metade direita (claro 100% → sombra 35%)
  const shadowed = new Uint8Array(img.pixels.length);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const f = 1.0 - 0.65 * (x / img.w);
      const i = (y * img.w + x) * 3;
      shadowed[i] = Math.round(img.pixels[i] * f);
      shadowed[i + 1] = Math.round(img.pixels[i + 1] * f);
      shadowed[i + 2] = Math.round(img.pixels[i + 2] * f);
    }
  }

  const e = new PdfEngine();
  e.imagesToPdf([rgbToJpeg(shadowed, img.w, img.h)], { page: "A4" }, "sombra");
  const rec = await createRecognizer(join(tmpdir(), "papiro-neural-test"), "por", "neural");
  try {
    const r = await e.ocrPage(0, rec.recognize, 240, true);
    assert.equal(r.shadowRemoved, true, "ativou remoção local de sombras");
    assert.equal(r.enhanced, true);
    const txt = pageTextFlat(e, 0);
    assert.match(txt, /Campinas/);
    assert.match(txt, /BR-90451-SP/);
  } finally {
    await rec.dispose();
  }
});

test("auto-orientação neural (180° e 270°) endireita página escaneada de cabeça para baixo e Ctrl+Z desfaz tudo", async () => {
  const img = renderLinesRgb([
    { text: "CONTRATO SOCIAL CONSOLIDADO", x: 60, y: 740, size: 17 },
    { text: "Clausula Primeira: Da denominacao e sede da empresa", x: 60, y: 700, size: 14 },
    { text: "Clausula Segunda: Do objeto social e prazo indeterminado", x: 60, y: 665, size: 14 },
    { text: "Assinado em Sao Paulo aos quinze dias de novembro de 2026", x: 60, y: 630, size: 14 },
  ], 200);

  const rec = await createRecognizer(join(tmpdir(), "papiro-neural-test"), "por", "neural");
  try {
    for (const badRot of [180, 270] as QuarterTurn[]) {
      const rot = rotatePixels90(img.pixels, img.w, img.h, 3, badRot);
      const e = new PdfEngine();
      e.imagesToPdf([rgbToJpeg(rot.pixels, rot.width, rot.height)], { page: "A4" }, `rot_${badRot}`);
      const origRot = e.pageRotation(0);

      const r = await e.ocrPage(0, rec.recognize, 220, true);
      const expectedFix = ((360 - badRot) % 360) as QuarterTurn;
      assert.equal(r.orientedDeg, expectedFix, `página girada ${badRot}° deve ser corrigida em ${expectedFix}°`);
      assert.equal(e.pageRotation(0), (origRot + expectedFix) % 360, "PDF rotacionado para ficar em pé");
      const txt = pageTextFlat(e, 0);
      assert.match(txt, /CONTRATO/);
      assert.match(txt, /Clausula/);

      // Um único Ctrl+Z desfaz tanto a rotação quanto o texto OCR
      e.undo();
      assert.equal(e.pageRotation(0), origRot, "Ctrl+Z restaura rotação original");
      assert.equal(e.needsOcr(0), true, "Ctrl+Z remove a camada de texto OCR");
    }
  } finally {
    await rec.dispose();
  }
});
