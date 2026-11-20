// Testes da versão 0.4: fonte original na edição, Word/texto, OCR em outros idiomas e nomes de fonte.
// node --test test/pacote-a.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PdfEngine, mupdf, type FontProvider } from "../src/engine/core.ts";
import { unzip } from "../src/engine/docx.ts";
import { cssFontFamily, fontKey, fontStyle } from "../src/engine/fontname.ts";
import { parseToUnicode } from "../src/engine/fonts.ts";
import { createRecognizer, parseLangs } from "../src/engine/ocr-node.ts";
import { CALIBRI, embeddedFont, sample } from "./fixtures.ts";

const OUT = join(import.meta.dirname, "out");
mkdirSync(OUT, { recursive: true });

/** Fonte de cada caractere do texto da página: "[fonte]texto[outra]texto". */
function fontRuns(bytes: Uint8Array, page = 0): string {
  const d = mupdf.Document.openDocument(bytes, "application/pdf");
  const st = d.loadPage(page).toStructuredText("preserve-whitespace");
  let cur = "", t = "";
  st.walk({ onChar(c, _o, f) { if (f.getName() !== cur) { cur = f.getName(); t += `[${cur}]`; } t += c; }, endLine() { t += "\n"; } });
  return t;
}

const blockWith = (e: PdfEngine, needle: string, page = 0) =>
  e.pageText(page).find((b) => b.lines.some((l) => l.text.includes(needle)))!;

function edit(e: PdfEngine, needle: string, text: string) {
  const b = blockWith(e, needle);
  const l0 = b.lines[0];
  return e.editText({
    page: 0, area: b.bbox, text, origin: l0.origin, size: l0.size, color: l0.color, font: l0.font,
    maxWidth: b.bbox[2] - b.bbox[0] + 2, lineHeight: l0.size * 1.2,
  });
}

const calibri: FontProvider = (name) => (/calibri/i.test(name) && existsSync(CALIBRI) ? { data: new Uint8Array(readFileSync(CALIBRI)), file: CALIBRI } : null);

test("ToUnicode: bfchar, faixas, faixas com lista e código 0 do Word", () => {
  const cmap = `1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar
<0003> <0020>
<0010> <00E7>
endbfchar
2 beginbfrange
<0000> <0002> [<0020> <0052> <0065>]
<0020> <0022> <0061>
endbfrange`;
  const { map, bytes } = parseToUnicode(cmap);
  assert.equal(bytes, 2);
  assert.equal(map.get(" "), 3, "o espaço usa o código 3, não o 0 (glifo vazio)");
  assert.equal(map.get("ç"), 0x10);
  assert.equal(map.get("R"), 1);
  assert.equal(map.get("e"), 2);
  assert.equal(map.get("a"), 0x20);
  assert.equal(map.get("c"), 0x22);
});

test("nomes de fonte do PDF viram família e estilo", () => {
  assert.deepEqual(fontStyle("BCDGEE+TimesNewRomanPS-BoldItalicMT"), { family: "Times New Roman", bold: true, italic: true });
  assert.deepEqual(fontStyle("ABCDEF+Calibri"), { family: "Calibri", bold: false, italic: false });
  assert.equal(fontStyle("NimbusSans-Regular").family, "Arial");
  assert.equal(fontStyle("SegoeUI-Semibold").family, "Segoe UI");
  assert.equal(fontKey("Arial-BoldMT"), fontKey("Arial Bold"));
  assert.equal(fontKey("TimesNewRomanPSMT"), fontKey("Times New Roman"));
  assert.match(cssFontFamily("ABCDEF+Cambria"), /^"Cambria", serif$/);
});

test("editar texto mantém a fonte embutida no documento", { skip: !existsSync(CALIBRI) && "Calibri não instalada" }, () => {
  const e = new PdfEngine({ fonts: calibri });
  e.open(embeddedFont()!, "fontes");
  // só letras que o subconjunto tem
  const r = edit(e, "Laudo", "Laudo de inspeção revisado");
  assert.equal(r.fonts.original, "Calibri");
  assert.equal(r.fonts.system, null, "não precisou da fonte do Windows");
  assert.equal(r.fonts.fallback, false);
  const saved = e.save();
  const runs = fontRuns(saved);
  assert.equal((runs.match(/\[/g) ?? []).length, 1, `uma fonte só no texto todo: ${runs}`);
  assert.match(runs.replace(/\n/g, " "), /Laudo de inspeção revisado/, runs);
  assert.ok(saved.length < embeddedFont()!.length * 1.05, "não embutiu outra fonte");
  writeFileSync(join(OUT, "fonte-original.pdf"), saved);
});

test("letras fora do subconjunto vêm da mesma fonte do Windows", { skip: !existsSync(CALIBRI) && "Calibri não instalada" }, () => {
  const e = new PdfEngine({ fonts: calibri });
  e.open(embeddedFont()!, "fontes");
  // "K", "z", "w" e "Ç" não aparecem no texto original
  const r = edit(e, "Laudo", "Kwanza Ç Laudo");
  assert.equal(r.fonts.original, "Calibri");
  assert.equal(r.fonts.system, "Calibri");
  const runs = fontRuns(e.save());
  assert.match(runs, /\[Calibri\]K/, runs);
  assert.match(runs, /\[ABCDEF\+Calibri\]a/, runs);
  assert.ok(!/Helvetica|Nimbus/.test(runs), `nenhuma letra em fonte padrão: ${runs}`);
});

test("sem a fonte no Windows, a letra que falta sai numa fonte padrão (e emoji vira ?)", { skip: !existsSync(CALIBRI) && "Calibri não instalada" }, () => {
  const e = new PdfEngine(); // sem provedor de fontes
  e.open(embeddedFont()!, "fontes");
  const r = edit(e, "Laudo", "Kilo 😀 Laudo");
  assert.equal(r.fonts.original, "Calibri");
  assert.equal(r.fonts.system, null);
  assert.equal(r.fonts.fallback, true);
  const txt = e.pageText(0).flatMap((b) => b.lines.map((l) => l.text)).join("\n");
  assert.match(txt, /Kilo \? Laudo/, txt);
});

test("editar, desfazer e editar de novo com a fonte do Windows", { skip: !existsSync(CALIBRI) && "Calibri não instalada" }, () => {
  const e = new PdfEngine({ fonts: calibri });
  e.open(embeddedFont()!, "fontes");
  edit(e, "Laudo", "Kappa Laudo");
  e.undo();
  const r = edit(e, "Laudo", "Kappa de novo");
  assert.equal(r.fonts.system, "Calibri");
  const bytes = e.save();
  assert.match(fontRuns(bytes).replace(/\[[^\]]*\]/g, ""), /Kappa de novo/);
  // a fonte do Windows foi embutida de novo depois do desfazer (com o arquivo da fonte junto)
  const d = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  let embedded = 0;
  d.findPage(0).get("Resources").get("Font").forEach((ref) => {
    const f = ref.resolve();
    if (f.get("BaseFont").asName() !== "Calibri") return;
    const fd = f.get("DescendantFonts").get(0).resolve().get("FontDescriptor");
    const ff = fd.get("FontFile2");
    if (ff.isStream()) embedded = ff.readStream().getLength();
  });
  assert.ok(embedded > 100_000, `fonte do Windows embutida (${embedded} bytes)`);
});

test("PDF com fontes padrão continua editando como antes", () => {
  const e = new PdfEngine();
  e.open(sample(1));
  const r = edit(e, "Este parágrafo", "Texto novo com ação e coração.");
  assert.ok(r.fonts.original, "a fonte Times do documento foi reaproveitada");
  assert.equal(r.fonts.fallback, false);
  assert.match(e.pageText(0).flatMap((b) => b.lines.map((l) => l.text)).join(" "), /Texto novo com ação e coração\./);
});

test("converte para Word: texto, formatação, imagens e uma seção por página", async () => {
  const e = new PdfEngine();
  e.open(sample(2));
  // uma imagem na página 1
  const png = (() => {
    const p = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 120, 80], false);
    p.clear(200);
    const b = p.asPNG(); p.destroy(); return new Uint8Array(b);
  })();
  e.insertImages([png], 1, { page: "A4" });
  const docx = e.exportDocx();
  writeFileSync(join(OUT, "convertido.docx"), docx);
  const files = await unzip(docx);
  for (const f of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/_rels/document.xml.rels"]) {
    assert.ok(files.has(f), `falta ${f}`);
  }
  const xml = new TextDecoder().decode(files.get("word/document.xml"));
  assert.match(xml, /Relatório mensal — página 1/);
  assert.match(xml, /informação, São Paulo e Manaus\./);
  assert.match(xml, /<w:b\/>/, "título em negrito");
  assert.match(xml, /w:ascii="Times New Roman"/);
  assert.equal((xml.match(/<w:sectPr>/g) ?? []).length, 3, "uma seção por página (3 páginas)");
  assert.ok([...files.keys()].some((k) => /^word\/media\/imagem1\.(png|jpeg)$/.test(k)), "imagem incluída");
  assert.match(xml, /r:embed="rIdImg1"/);
  // XML sem caracteres proibidos e com as tags fechadas na ordem
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml));
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)(w:[a-zA-Z]+)(?:\s[^>]*?)?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `tag ${m[2]} fechada fora de ordem`);
    else stack.push(m[2]);
  }
  assert.equal(stack.length, 0);
});

test("converte para texto", () => {
  const e = new PdfEngine();
  e.open(sample(2));
  const t = e.exportText();
  assert.match(t, /Relatório mensal — página 1/);
  assert.match(t, /Relatório mensal — página 2/);
  assert.ok(t.includes("\r\n"), "quebras de linha do Windows");
});

test("idiomas do OCR: lista válida e reconhecimento em inglês", { timeout: 180_000 }, async () => {
  assert.deepEqual(parseLangs("por+eng"), ["por", "eng"]);
  assert.throws(() => parseLangs("klingon"), /não disponível/);
  // página em inglês, renderizada como imagem
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "pdf", "");
  const dev = w.beginPage([0, 0, 595, 842]);
  const t = new mupdf.Text();
  t.showString(new mupdf.Font("Helvetica"), [22, 0, 0, -22, 60, 140], "The quick brown fox jumps over the lazy dog");
  dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
  w.endPage(); w.close();
  const e = new PdfEngine();
  e.open(new Uint8Array(buf.asUint8Array()));
  const ocr = await createRecognizer(join(tmpdir(), "papiro-ocr-eng"), "eng");
  try {
    const words = await ocr.recognize(e.renderPng(0, 200 / 72));
    const text = words.map((x) => x.text).join(" ");
    assert.match(text, /quick brown fox/i, text);
  } finally { await ocr.dispose(); }
});
