// Testes dos novos recursos: inserir texto/alinhamento, localizar e substituir, imagem na página,
// recortar e padronizar páginas, achatar PDF, limpar metadados, editor de marcadores, CSV e comparar PDFs.
// node --test test/new-features.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PdfEngine, mupdf } from "../src/engine/core.ts";
import { findSystemFont } from "../src/main/system-fonts.ts";
import { sample } from "./fixtures.ts";

const allText = (e: PdfEngine, p = 0) => e.pageText(p).flatMap((b) => b.lines.map((l) => l.text)).join("\n");

function solidPng(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels();
  for (let i = 0; i < px.length; i += 3) { px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; }
  const out = new Uint8Array(pix.asPNG());
  pix.destroy();
  return out;
}

test("inserir texto novo (erase=false) com alinhamento centralizado e desfazer", () => {
  const e = new PdfEngine({ fonts: findSystemFont });
  e.open(sample(1));
  const before = allText(e, 0);
  const r = e.editText({
    page: 0, area: [72, 500, 523, 540], text: "Observação técnica — Aprovado",
    origin: [72, 514], size: 12, color: [0.1, 0.25, 0.7], font: "Helvetica-Bold",
    maxWidth: 451, align: "center", erase: false,
  });
  assert.equal(r.fonts.substituted, 0);
  const after = allText(e, 0);
  assert.match(after, /Observação técnica — Aprovado/);
  assert.ok(after.includes("Relatório mensal"), "conteúdo original preservado");
  // Linha centralizada: centro horizontal perto de (72 + 523) / 2 = 297.5
  const ln = e.pageText(0).flatMap((b) => b.lines).find((l) => l.text.includes("Observação técnica"))!;
  const mid = (ln.bbox[0] + ln.bbox[2]) / 2;
  assert.ok(Math.abs(mid - 297.5) < 12, `esperava centro perto de 297.5, veio ${mid}`);
  e.undo();
  assert.equal(allText(e, 0), before);
});

test("localizar e substituir em todas as páginas (com um único Ctrl+Z)", () => {
  const e = new PdfEngine({ fonts: findSystemFont });
  e.open(sample(3));
  const r = e.replaceText("Manaus", "Curitiba");
  assert.equal(r.count, 3);
  assert.equal(r.pages, 3);
  for (let p = 0; p < 3; p++) {
    assert.match(allText(e, p), /Curitiba/);
    assert.doesNotMatch(allText(e, p), /Manaus/);
  }
  e.undo();
  for (let p = 0; p < 3; p++) assert.match(allText(e, p), /Manaus/);
});

test("inserir imagem diretamente sobre uma página existente e desfazer", () => {
  const e = new PdfEngine();
  e.open(sample(1));
  const img = solidPng(80, 40, [220, 20, 30]);
  e.addImageToPage(0, [100, 500, 220, 560], img);
  const rendered = e.render(0, 1);
  const mid = (530 * rendered.width + 160) * 4;
  assert.ok(rendered.rgba[mid] > 200 && rendered.rgba[mid + 1] < 50, "pixel vermelho desenhado na página");
  e.undo();
  const afterUndo = e.render(0, 1);
  assert.ok(afterUndo.rgba[mid] > 240 && afterUndo.rgba[mid + 1] > 240, "desfazer removeu a imagem");
});

test("recortar margens (cropPages) e padronizar tamanho (normalizePageSizes)", () => {
  const e = new PdfEngine();
  e.open(sample(1));
  const origW = e.info().pages[0].width, origH = e.info().pages[0].height;
  e.cropPages([0], { top: 20, right: 30, bottom: 20, left: 30 });
  assert.ok(Math.abs(e.info().pages[0].width - (origW - 60)) < 1);
  assert.ok(Math.abs(e.info().pages[0].height - (origH - 40)) < 1);
  e.undo();
  assert.ok(Math.abs(e.info().pages[0].width - origW) < 1);

  // Cria página fora do padrão (400×600) e padroniza para A4 (595×842)
  e.insertBlankPage(1, [400, 600]);
  assert.equal(Math.round(e.info().pages[1].width), 400);
  e.normalizePageSizes([1], "A4");
  assert.equal(Math.round(e.info().pages[1].width), 595);
  assert.equal(Math.round(e.info().pages[1].height), 842);
  e.undo();
  assert.equal(Math.round(e.info().pages[1].width), 400);
});

test("achatar PDF (flatten) fixa anotações no conteúdo e permite desfazer", () => {
  const e = new PdfEngine();
  e.open(sample(1));
  e.addAnnotation(0, { kind: "Square", rect: [100, 500, 220, 560], color: [0.9, 0.1, 0.1], width: 3 });
  assert.equal(e.annotations(0).length, 1);
  const r = e.flatten();
  assert.equal(r.count, 1);
  assert.equal(e.annotations(0).length, 0, "anotação virou conteúdo da página");
  // Retângulo vermelho continua visível na renderização
  const px = e.render(0, 1);
  let redPixels = 0;
  for (let y = 495; y <= 565; y++) for (let x = 95; x <= 225; x++) {
    const i = (y * px.width + x) * 4;
    if (px.rgba[i] > 180 && px.rgba[i + 1] < 80 && px.rgba[i + 2] < 80) redPixels++;
  }
  assert.ok(redPixels > 50, `esperava pixels vermelhos achatados, contou ${redPixels}`);
  e.undo();
  assert.equal(e.annotations(0).length, 1);
});

test("limpar metadados ocultos remove Info e XMP Metadata", () => {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, {}, ""));
  doc.setMetaData("info:Author", "Autor Secreto");
  doc.setMetaData("info:Creator", "Ferramenta Interna");
  doc.setMetaData("info:Title", "Relatório Confidencial");
  const root = doc.getTrailer().get("Root").resolve();
  root.put("Metadata", doc.addStream("<x:xmpmeta>dados ocultos</x:xmpmeta>", { Type: doc.newName("Metadata"), Subtype: doc.newName("XML") }));
  const raw = new Uint8Array(doc.saveToBuffer("compress").asUint8Array());
  doc.destroy();

  const e = new PdfEngine();
  e.open(raw, "limpo");
  const r = e.sanitizeMetadata();
  assert.ok(r.removed >= 3, `esperava remover >= 3 itens, removeu ${r.removed}`);
  const saved = e.save();
  const check = mupdf.Document.openDocument(saved, "application/pdf").asPDF()!;
  assert.equal(check.getMetaData("info:Author") || "", "");
  assert.equal(check.getMetaData("info:Creator") || "", "");
  assert.equal(check.getTrailer().get("Root").resolve().get("Metadata").isNull(), true);
  check.destroy();
});

test("editor de marcadores (setOutline) grava e lê sumário com acentos e subitens", () => {
  const e = new PdfEngine();
  e.open(sample(3));
  assert.equal(e.info().outline.length, 0);
  const info = e.setOutline([
    { title: "Introdução e Escopo", page: 0, children: [{ title: "Seção 1.1 — Inspeção", page: 1, children: [] }] },
    { title: "Conclusão", page: 2, children: [] },
  ]);
  assert.equal(info.outline.length, 2);
  assert.equal(info.outline[0].title, "Introdução e Escopo");
  assert.equal(info.outline[0].page, 0);
  assert.equal(info.outline[0].children[0].title, "Seção 1.1 — Inspeção");
  assert.equal(info.outline[0].children[0].page, 1);
  assert.equal(info.outline[1].title, "Conclusão");
  assert.equal(info.outline[1].page, 2);

  // Persiste ao salvar e reabrir
  const e2 = new PdfEngine();
  const info2 = e2.open(e.save());
  assert.equal(info2.outline.length, 2);
  assert.equal(info2.outline[0].title, "Introdução e Escopo");
  assert.equal(info2.outline[0].children[0].page, 1);
});

test("exportCsv extrai tabela com múltiplas colunas separadas por ponto e vírgula", () => {
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "pdf", "");
  const dev = w.beginPage([0, 0, 595, 842]);
  const f = new mupdf.Font("Helvetica");
  const put = (x: number, y: number, s: string) => {
    const t = new mupdf.Text();
    t.showString(f, [11, 0, 0, -11, x, y], s);
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
  };
  put(60, 100, "Item"); put(220, 100, "Unidade"); put(360, 100, "Valor");
  put(60, 120, "Cabo 10mm"); put(220, 120, "m"); put(360, 120, "125,50");
  put(60, 140, "Disjuntor"); put(220, 140, "un"); put(360, 140, "89,90");
  w.endPage(); w.close();

  const e = new PdfEngine();
  e.open(new Uint8Array(buf.asUint8Array()));
  const csv = e.exportCsv();
  assert.match(csv, /Item;Unidade;Valor/);
  assert.match(csv, /Cabo 10mm;m;125,50/);
  assert.match(csv, /Disjuntor;un;89,90/);
});

test("comparePdf identifica páginas idênticas, alteradas (texto + visual) e páginas extras", () => {
  const pdfA = sample(2);
  const eB = new PdfEngine();
  eB.open(sample(3));
  eB.replaceText("Manaus", "Recife", { page: 1 });
  const pdfB = eB.save();

  const eA = new PdfEngine();
  eA.open(pdfA, "v1.pdf");
  const rep = eA.comparePdf(pdfB, "v2.pdf");
  assert.equal(rep.pagesA, 2);
  assert.equal(rep.pagesB, 3);
  assert.equal(rep.same, 1, "página 1 idêntica");
  assert.equal(rep.changed, 1, "página 2 alterada");
  assert.equal(rep.onlyB, 1, "página 3 só na v2");
  assert.equal(rep.pages[0].status, "same");
  assert.equal(rep.pages[1].status, "changed");
  assert.ok(rep.pages[1].diffPng && rep.pages[1].diffPng.length > 100, "gerou mapa visual PNG");
  assert.ok(rep.pages[1].removed.some((l) => l.includes("Manaus")));
  assert.ok(rep.pages[1].added.some((l) => l.includes("Recife")));
  assert.equal(rep.pages[2].status, "onlyB");
});
