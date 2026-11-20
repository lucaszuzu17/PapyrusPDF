// Remover marca d'água, cópia por destinatário, páginas como imagem e força de senha.
// node --test test/protecao.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PdfEngine, mupdf } from "../src/engine/core.ts";
import { scanContent } from "../src/engine/watermarks.ts";
import { generatePassword, passwordStrength } from "../src/renderer/src/password.ts";
import { sample } from "./fixtures.ts";

/** PDF de uma página com o conteúdo dado; `extra` monta recursos a mais (Properties, XObject…). */
function pdf(content: string, extra?: (doc: mupdf.PDFDocument, res: mupdf.PDFObject) => void): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const res = doc.newDictionary();
  const fonts = doc.newDictionary();
  const f = doc.newDictionary();
  f.put("Type", doc.newName("Font")); f.put("Subtype", doc.newName("Type1"));
  f.put("BaseFont", doc.newName("Helvetica")); f.put("Encoding", doc.newName("WinAnsiEncoding"));
  fonts.put("F1", doc.addObject(f));
  res.put("Font", fonts);
  extra?.(doc, res);
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, content));
  const buf = doc.saveToBuffer("compress");
  return new Uint8Array(buf.asUint8Array());
}

const BODY = "BT /F1 12 Tf 72 700 Td (Texto normal do laudo) Tj ET";
const BIG = "BT /F1 90 Tf 0.7 0.7 0.7 rg 1 0 0 1 90 380 Tm (RASCUNHO) Tj ET";
const text = (e: PdfEngine) => e.pageText(0).flatMap((b) => b.lines.map((l) => l.text)).join(" | ");

function removeFrom(bytes: Uint8Array) {
  const e = new PdfEngine();
  e.open(bytes);
  const r = e.removeWatermarks();
  return { e, r };
}

test("leitura do conteúdo: textos com parênteses, dicionários e imagem embutida", () => {
  const ops = scanContent("/Artifact <</Subtype /Watermark /X (a ) EMC b)>> BDC q (EMC (dentro)) Tj BI /W 1 /H 1 ID \x00EMC\x01 EI Q EMC");
  assert.deepEqual(ops.map((o) => o.op), ["BDC", "q", "Tj", "BI", "Q", "EMC"]);
  assert.match(ops[0].args, /^\/Artifact <<\/Subtype \/Watermark/);
});

test("remove marca d'água marcada (Acrobat/Foxit), mantém o resto e desfaz", () => {
  const { e, r } = removeFrom(pdf(`${BODY}\n/Artifact <</Type /Pagination /Subtype /Watermark>> BDC q ${BIG} Q EMC`));
  assert.equal(r.removed, 1);
  assert.equal(r.pages, 1);
  assert.equal(text(e), "Texto normal do laudo");
  assert.ok(r.info.dirty);
  e.undo();
  assert.match(text(e), /RASCUNHO/);
});

test("remove marca d'água em /Properties, em camada (OCG) e em XObject do Acrobat", () => {
  // propriedades por nome
  let res = removeFrom(pdf(`${BODY} /Artifact /MC0 BDC ${BIG} EMC`, (doc, r) => {
    const props = doc.newDictionary(); const d = doc.newDictionary();
    d.put("Type", doc.newName("Pagination")); d.put("Subtype", doc.newName("Watermark"));
    props.put("MC0", doc.addObject(d)); r.put("Properties", props);
  }));
  assert.equal(res.r.removed, 1); assert.equal(text(res.e), "Texto normal do laudo");
  // camada chamada "Watermark"
  res = removeFrom(pdf(`${BODY} /OC /oc1 BDC ${BIG} EMC`, (doc, r) => {
    const props = doc.newDictionary(); const ocg = doc.newDictionary();
    ocg.put("Type", doc.newName("OCG")); ocg.put("Name", doc.newString("Watermark"));
    props.put("oc1", doc.addObject(ocg)); r.put("Properties", props);
  }));
  assert.equal(res.r.removed, 1); assert.equal(text(res.e), "Texto normal do laudo");
  // formulário com /PieceInfo … /Private /Watermark (como o Acrobat grava)
  res = removeFrom(pdf(`${BODY} q /Fm0 Do Q`, (doc, r) => {
    const fres = doc.newDictionary(); fres.put("Font", r.get("Font"));
    const form = doc.addStream(BIG, { Type: doc.newName("XObject"), Subtype: doc.newName("Form"), BBox: [0, 0, 595, 842] });
    form.put("Resources", fres);
    const pi = doc.newDictionary(); const cmp = doc.newDictionary();
    cmp.put("Private", doc.newName("Watermark")); pi.put("ADBE_CompoundType", cmp);
    form.put("PieceInfo", pi);
    const xo = doc.newDictionary(); xo.put("Fm0", form); r.put("XObject", xo);
  }));
  assert.equal(res.r.removed, 1); assert.equal(text(res.e), "Texto normal do laudo");
});

test("anotação de marca d'água sai", () => {
  const e = new PdfEngine();
  e.open(pdf(BODY));
  const bytes = (() => {
    const d = mupdf.Document.openDocument(e.save(), "application/pdf").asPDF()!;
    const page = d.loadPage(0) as mupdf.PDFPage;
    const a = page.createAnnotation("Square"); a.setRect([100, 300, 400, 500]); a.update();
    a.getObject().put("Subtype", d.newName("Watermark"));
    return new Uint8Array(d.saveToBuffer("compress").asUint8Array());
  })();
  const { e: e2, r } = removeFrom(bytes);
  assert.equal(r.removed, 1);
  assert.equal(e2.annotations(0).filter((x) => x.kind === "Watermark").length, 0);
});

test("marca do Word (no cabeçalho, no meio da página) sai; cabeçalho e timbrado ficam", () => {
  const header = "/Artifact <</Attached [/Top]/Type/Pagination/Subtype/Header>> BDC BT /F1 10 Tf 72 800 Td (Cabecalho da empresa) Tj ET EMC";
  const wordMark = `/Artifact <</Attached [/Top]/Type/Pagination/Subtype/Header>> BDC 0.75 g 120 250 m 480 620 l 500 600 l 140 230 l h f EMC`;
  const timbrado = "/Artifact <</Type/Pagination/Subtype/Header>> BDC 0.95 g 0 0 595 842 re f EMC";
  const { e, r } = removeFrom(pdf(`${timbrado}\n${header}\n${wordMark}\n${BODY}`));
  assert.equal(r.removed, 1, "só o desenho grande do meio");
  assert.match(text(e), /Cabecalho da empresa/);
  assert.match(text(e), /Texto normal do laudo/);
  // o fundo de página inteira (papel timbrado) continua: a página não fica branca
  const px = e.render(0, 0.1);
  assert.ok(px.rgba[0] < 250, "fundo do timbrado mantido");
});

test("marca do PapyrusPDF sai (nova e de versões antigas); a de destinatário não", () => {
  const e = new PdfEngine();
  e.open(sample(1));
  e.addWatermark({ text: "CONFIDENCIAL" });
  e.addWatermark({ text: "Cópia de Fulano", removable: false });
  const r = e.removeWatermarks();
  assert.equal(r.removed, 1);
  const t = text(e);
  assert.ok(!/CONFIDENCIAL/.test(t) && /Cópia de Fulano/.test(t), t);
  // conteúdo como o das versões 0.2–0.4, sem a marcação
  const old = removeFrom(pdf(`${BODY}\nq /PapiroGS18 gs BT 0.6 0.6 0.6 rg /F1 60 Tf 0.707 -0.707 -0.707 -0.707 100 600 Tm (RASCUNHO) Tj ET Q`, (doc, r) => {
    const gs = doc.newDictionary(); const g = doc.newDictionary(); g.put("ca", 0.18); gs.put("PapiroGS18", doc.addObject(g)); r.put("ExtGState", gs);
  }));
  assert.equal(old.r.removed, 1);
  assert.equal(text(old.e), "Texto normal do laudo");
});

test("sem marca d'água: nada muda e o documento não fica alterado", () => {
  const { e, r } = removeFrom(sample(2));
  assert.equal(r.removed, 0);
  assert.equal(r.info.dirty, false);
  assert.equal(e.info().canUndo, false);
});

test("cópia para destinatário e páginas como imagem não mudam o documento aberto", () => {
  const e = new PdfEngine();
  e.open(sample(2), "laudo");
  const marked = e.exportProtected({ userPassword: "Teste-Forte-2026", permissions: { print: true, copy: false, edit: false, annotate: true }, recipient: "João Silva" });
  assert.ok(!/João Silva/.test(text(e)), "o original continua sem a marca");
  const c = new PdfEngine();
  c.open(marked, "c", "Teste-Forte-2026");
  assert.equal(c.info().pageCount, 2);
  assert.match(text(c), /Cópia de João Silva/);
  assert.match(text(c), /Cópia exclusiva de João Silva — \d{2}\/\d{2}\/\d{4}/);
  assert.equal(c.removeWatermarks().removed, 0, "a marca de destinatário não sai com o comando");

  const img = e.exportProtected({ permissions: { print: true, copy: true, edit: true, annotate: true }, recipient: "Maria", imageOnly: 120 });
  const ci = new PdfEngine();
  ci.open(img, "i");
  assert.equal(ci.info().pageCount, 2);
  assert.equal(text(ci), "", "sem texto: virou imagem");
  assert.equal(Math.round(ci.info().pages[0].width), 595);
  assert.ok(ci.needsOcr(0));
});

test("força da senha e gerador", () => {
  assert.equal(passwordStrength("123456").score, 0);
  assert.equal(passwordStrength("senha123").score, 0);
  assert.ok(passwordStrength("18/05/1992").score <= 1);
  assert.ok(passwordStrength("aaaaaaaaaaaa").score <= 1);
  assert.ok(passwordStrength("Laudo2026").score <= 2);
  assert.ok(passwordStrength("cavalo-correto-bateria-grampo").score >= 3);
  const g = generatePassword();
  assert.match(g, /^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}$/);
  assert.ok(!/[lO01,=]/.test(g));
  assert.equal(passwordStrength(g).score, 4);
  assert.notEqual(generatePassword(), generatePassword());
});
