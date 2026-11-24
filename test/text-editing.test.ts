// Regressões de edição de texto: subconjuntos Type0 (quadradinhos .notdef), fallback Unicode ("???"),
// blocos com bullet em Symbol, normalização NFD/PUA/ligaduras e redação por linha.
// node --test test/text-editing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { PdfEngine, mupdf } from "../src/engine/core.ts";
import { isSymbolicFont, normalizePdfText } from "../src/engine/fontname.ts";
import { originalSource } from "../src/engine/fonts.ts";
import { findSystemFont } from "../src/main/system-fonts.ts";
import { CALIBRI, embeddedFont, sample } from "./fixtures.ts";

const allText = (e: PdfEngine, page = 0) =>
  e.pageText(page).flatMap((b) => b.lines.map((l) => l.text)).join("\n");

function fontRuns(bytes: Uint8Array, page = 0): string {
  const d = mupdf.Document.openDocument(bytes, "application/pdf");
  const st = d.loadPage(page).toStructuredText("preserve-whitespace");
  let cur = "", t = "";
  st.walk({ onChar(c, _o, f) { if (f.getName() !== cur) { cur = f.getName(); t += `[${cur}]`; } t += c; }, endLine() { t += "\n"; } });
  st.destroy();
  d.destroy();
  return t;
}

test("normalizePdfText: NFD → NFC, PUA do Word, ligaduras e caracteres invisíveis", () => {
  // NFD decomposto ("a" + til combinante, "c" + cedilha, "e" + agudo) → NFC
  const nfd = "ac\u0327a\u0303o e\u0301 o\u0301timo";
  assert.equal(normalizePdfText(nfd), "ação é ótimo");
  // PUA do Symbol/Wingdings (bullets e setas do Word) + ligaduras + ZWSP/NBSP/soft-hyphen
  const dirty = "\uF0B7\u00A0A\uFB01rmac\u0327a\u0303o\u200B com \uFB02uxo \uF0AE OK\u00AD \uF0FC\r\nLinha\uFEFF 2";
  assert.equal(normalizePdfText(dirty), "• Afirmação com fluxo → OK ✓\nLinha 2");
  assert.equal(isSymbolicFont("ABCDEF+Symbol"), true);
  assert.equal(isSymbolicFont("BCDGEE+Wingdings-Regular"), true);
  assert.equal(isSymbolicFont("ABCDEF+Calibri"), false);
});

test("subconjunto Type0 com bfrange amplo no ToUnicode não emite glifos ausentes (.notdef)", { skip: !existsSync(CALIBRI) && "Calibri não instalada" }, () => {
  // Baseado no embeddedFont(), mas com um beginbfrange amplo (como Word/Chrome/PDFBox às vezes gravam)
  // que inclui letras nunca desenhadas na página (K, w, z, X).
  const base = embeddedFont()!;
  const doc = mupdf.Document.openDocument(base, "application/pdf").asPDF()!;
  const font = new mupdf.Font("Calibri", new Uint8Array(readFileSync(CALIBRI)));
  const extraChars = ["K", "w", "y", "X"];
  const extraEntries = extraChars.map((ch) =>
    `<${font.encodeCharacter(ch.codePointAt(0)!).toString(16).padStart(4, "0")}> <${ch.charCodeAt(0).toString(16).padStart(4, "0")}>`
  );
  doc.findPage(0).get("Resources").get("Font").forEach((ref) => {
    const f = ref.resolve();
    if (f.get("Subtype").asName() !== "Type0") return;
    const oldTu = f.get("ToUnicode").readStream().asString();
    const patched = oldTu.replace("endbfchar", `endbfchar\n${extraEntries.length} beginbfchar\n${extraEntries.join("\n")}\nendbfchar`);
    f.put("ToUnicode", doc.addStream(patched, {}));
  });
  const pdf = new Uint8Array(doc.saveToBuffer("garbage,compress,objstms").asUint8Array());
  doc.destroy();

  const e = new PdfEngine({ fonts: findSystemFont });
  e.open(pdf, "subset-bfrange");
  const b = e.pageText(0).find((bl) => bl.lines.some((l) => l.text.includes("Laudo")))!;
  const l0 = b.lines[0];
  const r = e.editText({
    page: 0, area: b.bbox, areas: b.lines.map((l) => l.bbox), text: "Kwy X Laudo",
    origin: l0.origin, size: l0.size, color: l0.color, font: l0.font,
    maxWidth: b.bbox[2] - b.bbox[0] + 40, lineHeight: l0.size * 1.2,
  });
  assert.equal(r.fonts.substituted, 0);
  assert.equal(r.fonts.system, "Calibri", "K, w, y, X devem vir da fonte do Windows, não do subconjunto ABCDEF+Calibri");
  const saved = e.save();
  const runs = fontRuns(saved);
  // As letras K, w, y, X NÃO podem sair em [ABCDEF+Calibri] (onde poderiam ser .notdef/quadradinho)
  assert.doesNotMatch(runs, /\[ABCDEF\+Calibri\][^[\n]*[KwyX]/, runs);
  assert.match(runs.replace(/\[[^\]]*\]/g, ""), /Kwy X Laudo/);
});

test("Type0 com CIDToGIDMap apontando CID para GID 0 rejeita o glifo em vez de gerar quadradinho", () => {
  const doc = new mupdf.PDFDocument();
  const f = doc.newDictionary();
  f.put("Type", doc.newName("Font"));
  f.put("Subtype", doc.newName("Type0"));
  f.put("BaseFont", doc.newName("FakeFont"));
  f.put("Encoding", doc.newName("Identity-H"));
  const tu = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange\n" +
    "2 beginbfchar\n<0001> <0041>\n<0002> <0042>\nendbfchar\nendcmap end end";
  f.put("ToUnicode", doc.addStream(tu, {}));
  const desc = doc.newDictionary();
  desc.put("Type", doc.newName("Font"));
  desc.put("Subtype", doc.newName("CIDFontType2"));
  desc.put("BaseFont", doc.newName("FakeFont"));
  desc.put("DW", 600);
  // CID 0 -> GID 0, CID 1 -> GID 10 (presente), CID 2 -> GID 0 (.notdef!)
  const mapBytes = new Uint8Array([0, 0, 0, 10, 0, 0]);
  desc.put("CIDToGIDMap", doc.addStream(mapBytes, {}));
  const arr = doc.newArray();
  arr.push(doc.addObject(desc));
  f.put("DescendantFonts", arr);
  const fref = doc.addObject(f);
  const res = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", fref);
  res.put("Font", fonts);
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, "BT /F1 12 Tf 72 700 Td <0001> Tj ET"));

  const src = originalSource(doc.findPage(0), "FakeFont", "AB", new Set(["A"]));
  assert.ok(src, "deve reconhecer a fonte");
  assert.ok(src.glyph("A"), "CID 1 tem GID 10 > 0");
  assert.equal(src.glyph("B"), null, "CID 2 tem GID 0 (.notdef) e precisa ser recusado");
  doc.destroy();
});

test("fonte simbólica sem /Encoding não assume ASCII 1:1", () => {
  const doc = new mupdf.PDFDocument();
  const fd = doc.newDictionary();
  fd.put("Type", doc.newName("FontDescriptor"));
  fd.put("FontName", doc.newName("CustomSymbols"));
  fd.put("Flags", 4); // bit Symbolic
  const f = doc.newDictionary();
  f.put("Type", doc.newName("Font"));
  f.put("Subtype", doc.newName("Type1"));
  f.put("BaseFont", doc.newName("CustomSymbols"));
  f.put("FirstChar", 32);
  f.put("LastChar", 122);
  const w = doc.newArray();
  for (let i = 32; i <= 122; i++) w.push(500);
  f.put("Widths", w);
  f.put("FontDescriptor", doc.addObject(fd));
  const fref = doc.addObject(f);
  const res = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", fref);
  res.put("Font", fonts);
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, ""));

  assert.equal(originalSource(doc.findPage(0), "CustomSymbols", "ABC", new Set(["A"])), null);
  doc.destroy();
});

test("linha iniciada por marcador em Symbol usa a fonte predominante do texto ao editar", { skip: process.platform !== "win32" && "somente Windows" }, () => {
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "pdf", "");
  const dev = w.beginPage([0, 0, 595, 842]);
  const sym = new mupdf.Font("Symbol");
  const times = new mupdf.Font("Times-Roman");
  const t = new mupdf.Text();
  t.showString(sym, [12, 0, 0, -12, 72, 120], "•");
  t.showString(times, [12, 0, 0, -12, 84, 120], " Item principal com acentuação");
  dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
  w.endPage(); w.close();

  const e = new PdfEngine({ fonts: findSystemFont });
  e.open(new Uint8Array(buf.asUint8Array()));
  const b = e.pageText(0)[0];
  assert.ok(b && b.lines.length >= 1);
  assert.doesNotMatch(b.lines[0].font, /symbol/i, `não deve herdar fonte Symbol: ${b.lines[0].font}`);

  const l0 = b.lines[0];
  const r = e.editText({
    page: 0, area: b.bbox, areas: b.lines.map((l) => l.bbox),
    text: "• Item editado com ação e coração",
    origin: l0.origin, size: l0.size, color: l0.color, font: l0.font,
  });
  assert.equal(r.fonts.substituted, 0);
  const out = allText(e, 0);
  assert.match(out, /Item editado com ação e coração/, out);
  assert.doesNotMatch(out, /\?/, out);
});

test("símbolos Unicode fora de WinAnsi e acentos NFD não viram ? no Windows", { skip: process.platform !== "win32" && "somente Windows" }, () => {
  const e = new PdfEngine({ fonts: findSystemFont });
  e.open(sample(1));
  const b = e.pageText(0).find((bl) => bl.lines.some((l) => l.text.includes("Este parágrafo")))!;
  const l0 = b.lines[0];
  // Mistura acentos NFD, PUA do Word, ligadura e símbolos fora de CP1252 (✓, →, ≤, ≥, ≠, ▪, Ω, α)
  const input = "\uF0B7 Verificac\u0327a\u0303o: \uFB01nal ✓ → x ≤ 10 ≥ 2 ≠ 0 ▪ Ω α";
  const r = e.editText({
    page: 0, area: b.bbox, areas: b.lines.map((l) => l.bbox), text: input,
    origin: l0.origin, size: l0.size, color: l0.color, font: l0.font,
    maxWidth: 460, lineHeight: l0.size * 1.25,
  });
  assert.equal(r.fonts.substituted, 0, "nenhum símbolo deve virar '?'");

  const saved = e.save();
  const e2 = new PdfEngine({ fonts: findSystemFont });
  e2.open(saved);
  const txt = allText(e2, 0).replace(/\s+/g, " ");
  for (const expected of ["•", "Verificação:", "final", "✓", "→", "≤", "≥", "≠", "▪", "Ω", "α"]) {
    assert.ok(txt.includes(expected), `faltou "${expected}" no texto extraído: ${txt}`);
  }
  assert.doesNotMatch(txt, /\?/, `não deve haver '?' no texto: ${txt}`);

  // Cabeçalho e marca d'água também aceitam símbolos Unicode sem virar '?'
  e2.addHeaderFooter({ items: [{ pos: "bc", text: "Aprovado ✓ — x ≤ 5 → OK" }] });
  e2.addWatermark({ text: "REVISÃO ✓" });
  const txt2 = allText(e2, 0);
  assert.ok(txt2.includes("Aprovado ✓ — x ≤ 5 → OK"), txt2);
  assert.ok(txt2.includes("REVISÃO ✓"), txt2);
});

test("redação por linha (areas) preserva coluna vizinha próxima", () => {
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "pdf", "");
  const dev = w.beginPage([0, 0, 595, 842]);
  const helv = new mupdf.Font("Helvetica");
  const put = (x: number, y: number, s: string) => {
    const t = new mupdf.Text();
    t.showString(helv, [12, 0, 0, -12, x, y], s);
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
  };
  // Linha 1 longa e linha 2 curta na coluna esquerda; coluna direita logo ao lado da linha 2
  put(72, 120, "Linha longa da coluna esquerda aqui");
  put(72, 138, "Curta");
  put(140, 138, "COLUNA_DIREITA");
  w.endPage(); w.close();

  const e = new PdfEngine();
  e.open(new Uint8Array(buf.asUint8Array()));
  const lines = e.pageText(0).flatMap((b) => b.lines);
  const l1 = lines.find((l) => l.text.includes("Linha longa"))!;
  const l2 = lines.find((l) => l.text.includes("Curta"))!;
  // Com areas por linha, o retângulo vazio à direita de "Curta" não é redigido → COLUNA_DIREITA sobrevive
  const union: [number, number, number, number] = [
    Math.min(l1.bbox[0], l2.bbox[0]), Math.min(l1.bbox[1], l2.bbox[1]),
    Math.max(l1.bbox[2], l2.bbox[2]), Math.max(l1.bbox[3], l2.bbox[3]),
  ];
  e.editText({
    page: 0, area: union, areas: [l1.bbox, l2.bbox], text: "Editado\nOk",
    origin: l1.origin, size: l1.size, color: l1.color, font: l1.font,
  });
  const txt = allText(e, 0);
  assert.match(txt, /Editado/);
  assert.match(txt, /COLUNA_DIREITA/, `coluna vizinha não deve ser apagada: ${txt}`);
});

test("relata substituted quando realmente não há fonte para o caractere", { skip: !existsSync(CALIBRI) && "Calibri não instalada" }, () => {
  const e = new PdfEngine(); // sem provedor de fontes do Windows
  e.open(embeddedFont()!, "fontes");
  const b = e.pageText(0).find((bl) => bl.lines.some((l) => l.text.includes("Laudo")))!;
  const l0 = b.lines[0];
  const r = e.editText({
    page: 0, area: b.bbox, text: "Laudo ✓ →",
    origin: l0.origin, size: l0.size, color: l0.color, font: l0.font,
  });
  assert.equal(r.fonts.substituted, 2);
});
