// Regressões dos defeitos encontrados na revisão da versão 0.2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PdfEngine, mupdf, openStates } from "../src/engine/core.ts";

function samplePdf(pages = 2, options = ""): Uint8Array {
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "pdf", options);
  const helv = new mupdf.Font("Helvetica");
  for (let p = 0; p < pages; p++) {
    const dev = w.beginPage([0, 0, 595, 842]);
    const t = new mupdf.Text();
    t.showString(helv, [16, 0, 0, -16, 72, 120], `Texto da folha ${p + 1}`);
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
    w.endPage();
  }
  w.close();
  return new Uint8Array(buf.asUint8Array());
}

/** Imagem com a metade esquerda vermelha e a direita azul. */
function redBlue(w = 200, h = 50): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    px[i] = x < w / 2 ? 255 : 0; px[i + 1] = 0; px[i + 2] = x < w / 2 ? 0 : 255;
  }
  const png = new Uint8Array(pix.asPNG());
  pix.destroy();
  return png;
}

const lines = (e: PdfEngine, i: number) => e.pageText(i).flatMap((b) => b.lines);
const reopened = (e: PdfEngine) => { const r = new PdfEngine(); r.open(e.save()); return r; };
/** Cor média de um retângulo da página (em pontos). */
function avg(e: PdfEngine, page: number, r: [number, number, number, number]): [number, number, number] {
  const img = e.render(page, 1);
  let R = 0, G = 0, B = 0, n = 0;
  for (let y = Math.floor(r[1]); y < r[3]; y++) for (let x = Math.floor(r[0]); x < r[2]; x++) {
    const i = (y * img.width + x) * 4;
    R += img.rgba[i]; G += img.rgba[i + 1]; B += img.rgba[i + 2]; n++;
  }
  return [R / n, G / n, B / n];
}
const nonWhite = (e: PdfEngine, page: number) => {
  const img = e.render(page, 0.5);
  let n = 0;
  for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i] < 245 || img.rgba[i + 1] < 245 || img.rgba[i + 2] < 245) n++;
  return n;
};

test("desfazer e repetir cabeçalho/marca d'água não deixa fonte nem transparência órfãs", () => {
  const e = new PdfEngine();
  e.open(samplePdf(1));
  e.addWatermark({ text: "RASCUNHO", color: [0, 0, 0], opacity: 0.18 });
  e.undo();
  e.addWatermark({ text: "RASCUNHO", color: [0, 0, 0], opacity: 0.18 });
  e.addHeaderFooter({ items: [{ pos: "bc", text: "Rodapé" }] });
  e.undo();
  e.addHeaderFooter({ items: [{ pos: "bc", text: "Rodapé" }] });
  for (const d of [e, reopened(e)]) {
    const foot = lines(d, 0).find((l) => /Rodapé/.test(l.text))!;
    assert.match(foot.font, /Helvetica|NimbusSans/, `fonte do rodapé: “${foot.font}”`);
    const img = d.render(0, 0.5);
    let darkest = 255;
    // fora da linha de texto preta: a marca continua transparente (clara)
    for (let y = Math.floor(img.height * 0.3); y < img.height * 0.7; y++) for (let x = 0; x < img.width; x++) {
      darkest = Math.min(darkest, img.rgba[(y * img.width + x) * 4]);
    }
    assert.ok(darkest > 180, `marca d'água ficou opaca: ${darkest}`);
    assert.equal(d.search("RASCUNHO").length, 1);
  }
  // refazer depois de desfazer também continua íntegro
  e.undo(); e.redo();
  assert.match(lines(reopened(e), 0).find((l) => /Rodapé/.test(l.text))!.font, /Helvetica|NimbusSans/);
});

test("inserir imagem ou carimbo, desfazer e repetir a mesma imagem", () => {
  const png = redBlue(600, 400);
  const e = new PdfEngine();
  e.open(samplePdf(1));
  e.insertImages([png], -1, { page: "A4" });
  const first = nonWhite(e, 1);
  e.undo();
  e.insertImages([png], -1, { page: "A4" });
  assert.ok(nonWhite(e, 1) > first * 0.9, "página da imagem ficou em branco depois de desfazer e repetir");
  assert.ok(nonWhite(reopened(e), 1) > first * 0.9, "…e depois de salvar e reabrir");

  const stamp = redBlue();
  e.addAnnotation(0, { kind: "Stamp", rect: [300, 600, 500, 650], png: stamp });
  e.undo();
  e.addAnnotation(0, { kind: "Stamp", rect: [300, 600, 500, 650], png: stamp });
  for (const d of [e, reopened(e)]) {
    const [r, , b] = avg(d, 0, [305, 605, 395, 645]);
    assert.ok(r > 200 && b < 60, `carimbo sumiu depois de desfazer e repetir (${r}, ${b})`);
  }
});

test("carimbo fica em pé em páginas giradas", () => {
  for (const rot of [0, 90, 180, 270]) {
    const e = new PdfEngine();
    e.open(samplePdf(1));
    if (rot) e.rotatePages([0], rot);
    const { width, height } = e.info().pages[0];
    const x = width / 2 - 100, y = height / 2 - 25;
    e.addAnnotation(0, { kind: "Stamp", rect: [x, y, x + 200, y + 50], png: redBlue() });
    for (const d of [e, reopened(e)]) {
      const left = avg(d, 0, [x + 10, y + 8, x + 90, y + 42]);
      const right = avg(d, 0, [x + 110, y + 8, x + 190, y + 42]);
      assert.ok(left[0] > 200 && left[2] < 60, `rotação ${rot}: metade esquerda deveria ser vermelha (${left.map(Math.round)})`);
      assert.ok(right[2] > 200 && right[0] < 60, `rotação ${rot}: metade direita deveria ser azul (${right.map(Math.round)})`);
      const a = d.annotations(0).find((k) => k.kind === "Stamp")!;
      assert.ok(Math.abs(a.rect[0] - x) < 1 && Math.abs(a.rect[2] - (x + 200)) < 1, `rotação ${rot}: retângulo ${a.rect}`);
    }
  }
});

test("senha de abertura não libera as permissões restritas", () => {
  const e = new PdfEngine();
  e.open(samplePdf(1));
  const prot = e.exportProtected({ userPassword: "abre123", permissions: { print: false, copy: false, edit: true, annotate: true } });
  const d = mupdf.Document.openDocument(prot, "application/pdf").asPDF()!;
  assert.equal(d.needsPassword(), true);
  assert.equal(d.authenticatePassword("abre123"), 2, "a senha de abertura deve autenticar só como usuário");
  assert.equal(d.hasPermission("copy"), false);
  assert.equal(d.hasPermission("print"), false);
  assert.equal(d.hasPermission("edit"), true);
});

test("salvar e comprimir não incham PDFs com fluxos de objetos", () => {
  // muitas páginas pequenas: sem "objstms" cada objeto iria solto e o arquivo cresceria várias vezes
  const src = new PdfEngine();
  src.open(samplePdf(60));
  const compact = src.save();
  const e = new PdfEngine();
  e.open(compact);
  e.addAnnotation(0, { kind: "Text", at: [100, 100], contents: "x" });
  const saved = e.save();
  assert.ok(saved.length < compact.length * 1.25, `salvar inchou o arquivo: ${compact.length} → ${saved.length}`);
  const r = e.exportCompressed("media");
  assert.ok(r.after <= r.before && r.after <= saved.length, `comprimir piorou: ${saved.length} → ${r.after}`);
  const c = new PdfEngine();
  assert.equal(c.open(r.bytes).pageCount, 60);
  assert.equal(c.search("Texto da folha 60").length, 1);
});

test("documento esperando senha sobrevive a um salvamento; unlock sem pendente falha", () => {
  const p = new PdfEngine();
  p.open(samplePdf(1));
  const locked = p.exportProtected({ userPassword: "s3nha", permissions: { print: true, copy: true, edit: true, annotate: true } });

  const e = new PdfEngine();
  e.open(samplePdf(3));
  e.addAnnotation(0, { kind: "Text", at: [100, 100], contents: "x" });
  e.open(locked, "protegido");
  assert.equal(e.needsPassword(), true);
  assert.equal(e.info().pageCount, 3, "o documento atual continua aberto enquanto a senha não vem");
  e.save();
  assert.equal(e.needsPassword(), true, "salvar não pode descartar o documento que espera senha");
  assert.throws(() => e.unlock("errada"), /Senha incorreta/);
  assert.equal(e.unlock("s3nha").pageCount, 1);
  assert.throws(() => e.unlock("qualquer"), /aguardando senha/);
  // reabrir bytes gravados usa a senha que o motor já tem
  const again = e.save();
  assert.equal(e.reopen(again, "protegido").pageCount, 1);
  assert.equal(e.info().encrypted, true);
  const other = new PdfEngine();
  other.open(samplePdf(2));
  assert.throws(() => other.reopen(again, "x"), /Senha incorreta/);
  assert.equal(other.info().pageCount, 2, "falha ao reabrir não troca o documento");
});

test("conteúdo com q sem Q não desloca cabeçalho e rodapé", () => {
  assert.equal(openStates("q 1 0 0 1 0 0 cm q BT (a q ( b ) \\) q) Tj ET Q"), 1);
  assert.equal(openStates("q % q q q\n<71 71> Tj Q Q Q"), 0);
  assert.equal(openStates("q BI /W 1 /H 1 ID q q q\x00 EI q"), 2);
  assert.equal(openStates("/q gs q /Q Do"), 1);

  const doc = new mupdf.PDFDocument();
  const page = doc.addPage([0, 0, 612, 792], 0, doc.newDictionary(),
    "q 0.5 0 0 0.5 100 100 cm q 1 0 0 1 50 50 cm 0 0 10 10 re f");
  doc.insertPage(-1, page);
  const e = new PdfEngine();
  e.open(new Uint8Array(doc.saveToBuffer("").asUint8Array()));
  e.addHeaderFooter({ items: [{ pos: "bc", text: "Rodapé no lugar" }, { pos: "tl", text: "Topo" }] });
  const foot = lines(e, 0).find((l) => /Rodapé/.test(l.text))!;
  assert.ok(Math.abs(foot.size - 10) < 0.2, `tamanho ${foot.size}`);
  assert.ok(Math.abs((foot.bbox[0] + foot.bbox[2]) / 2 - 306) < 2 && foot.bbox[3] > 750, `posição ${foot.bbox}`);
  const top = lines(e, 0).find((l) => /Topo/.test(l.text))!;
  assert.ok(Math.abs(top.bbox[0] - 28) < 2 && top.bbox[1] < 40, `topo ${top.bbox}`);
});

test("OCR não escreve em outro documento aberto no meio do reconhecimento", async () => {
  const e = new PdfEngine();
  e.open(samplePdf(1), "A");
  const other = samplePdf(2);
  await assert.rejects(
    e.ocrPage(0, async () => { e.open(other, "B"); return [{ text: "TEXTO-DO-A", bbox: [10, 10, 200, 40] }]; }),
    /trocado durante/,
  );
  assert.equal(e.info().pageCount, 2);
  assert.equal(e.info().dirty, false);
  assert.equal(e.search("TEXTO-DO-A").length, 0);
});

test("comprimir muitas imagens grandes não esgota a memória", () => {
  // 12 fotos de 2400×3400: sem liberar os pixmaps a cada volta seriam centenas de MB retidos
  const w = 2400, h = 3400;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels();
  let s = 3;
  for (let i = 0; i < px.length; i += 3) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const x = (i / 3) % w, n = s % 20;
    px[i] = (x / w) * 200 + n; px[i + 1] = 90 + n; px[i + 2] = 200 - (x / w) * 150 + n;
  }
  const jpg = new Uint8Array(pix.asJPEG(92));
  pix.destroy();
  const e = new PdfEngine();
  e.imagesToPdf(Array.from({ length: 12 }, () => jpg), { page: "A4" }, "scan");
  // cada página tem a sua cópia da imagem (como num escaneado de verdade)? garante 12 objetos distintos
  const before = process.memoryUsage().rss;
  const r = e.exportCompressed("media");
  const grew = (process.memoryUsage().rss - before) / 1048576;
  assert.ok(r.images >= 1 && r.after < r.before, `${r.images} imagens, ${r.before} → ${r.after}`);
  assert.equal(e.info().pageCount, 12);
  assert.ok(e.save().length > 0, "o documento aberto continua podendo ser salvo");
  assert.ok(grew < 600, `memória cresceu ${Math.round(grew)} MB`);
});
