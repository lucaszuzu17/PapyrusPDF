// Testes dos recursos Tier 2 (100% offline):
// assinatura digital A1 (.pfx) + verificação/detecção de adulteração,
// criador e detector automático de formulários, desfazer através de salvar,
// pré-processamento OCR (deskew + contraste) com modelo best, SVG vetorial e Markdown→HTML.
// node --test test/tier2.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PdfEngine, mupdf } from "../src/engine/core.ts";
import { createRecognizer } from "../src/engine/ocr-node.ts";
import { generateTestPfx } from "../src/engine/sign.ts";
import { markdownToHtml } from "../src/main/markdown.ts";
import { sample } from "./fixtures.ts";

const allText = (e: PdfEngine, p = 0) => e.pageText(p).flatMap((b) => b.lines.map((l) => l.text)).join("\n");

test("assinatura digital A1 (.pfx): assina, verifica integridade e detecta adulteração", () => {
  const pfx = generateTestPfx("Lucas Silva:12345678901", "segredo-a1");
  const e = new PdfEngine();
  e.open(sample(1), "contrato");

  const cert = e.inspectPfx(pfx, "segredo-a1");
  assert.equal(cert.commonName, "Lucas Silva:12345678901");
  assert.equal(cert.expired, false);
  assert.throws(() => e.inspectPfx(pfx, "senha-errada"), /Senha do certificado incorreta/i);

  const signed = e.signDigital({
    pfxBytes: pfx,
    password: "segredo-a1",
    reason: "Aprovação contratual",
    location: "São Paulo, BR",
    visible: { page: 0, rect: [350, 720, 560, 790] },
  });
  assert.ok(signed.bytes.length > 20000);

  const e2 = new PdfEngine();
  e2.open(signed.bytes, "contrato_assinado");
  const verified = e2.verifySignatures();
  assert.equal(verified.length, 1);
  assert.equal(verified[0].status, "valid");
  assert.equal(verified[0].integrityValid, true);
  assert.equal(verified[0].coversWholeDocument, true);
  assert.equal(verified[0].signerName, "Lucas Silva:12345678901");
  assert.equal(verified[0].reason, "Aprovação contratual");

  // Adultera 1 byte fora de /Contents e confirma que a verificação detecta alteração
  const tampered = new Uint8Array(signed.bytes);
  tampered[tampered.length - 12] ^= 0x01;
  const checkTampered = e2.verifySignatures(tampered);
  assert.equal(checkTampered.length, 1);
  assert.equal(checkTampered[0].integrityValid, false);
  assert.equal(checkTampered[0].status, "tampered");
});

test("criador de formulário interativo (texto, checkbox, lista, assinatura) e detecção automática", () => {
  const e = new PdfEngine();
  e.open(sample(1));
  assert.equal(e.fields(0).length, 0);

  const f1 = e.createField({ page: 0, kind: "text", name: "NomeCliente", rect: [80, 500, 300, 524] });
  e.createField({ page: 0, kind: "checkbox", name: "AceitoTermos", rect: [80, 540, 96, 556] });
  e.createField({ page: 0, kind: "combobox", name: "Estado", rect: [80, 570, 220, 594], options: ["SP", "RJ", "MG"] });
  assert.equal(e.fields(0).length, 3);

  // Preenche o campo criado e persiste após salvar
  e.setField(0, f1.id, "Maria Souza");
  const e2 = new PdfEngine();
  e2.open(e.save());
  assert.equal(e2.fields(0).length, 3);
  assert.equal(e2.fields(0).find((f) => f.name === "NomeCliente")?.value, "Maria Souza");

  // Remove um campo e desfaz
  const toDel = e2.fields(0).find((f) => f.name === "Estado")!;
  e2.deleteField(0, toDel.id);
  assert.equal(e2.fields(0).length, 2);
  e2.undo();
  assert.equal(e2.fields(0).length, 3);

  // Detecção automática em formulário estático com linhas ____, [ ] e rótulo com :
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "pdf", "");
  const dev = w.beginPage([0, 0, 595, 842]);
  const f = new mupdf.Font("Helvetica");
  const put = (x: number, y: number, s: string) => {
    const t = new mupdf.Text();
    t.showString(f, [11, 0, 0, -11, x, y], s);
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
  };
  put(60, 100, "Nome completo: ________________________");
  put(60, 140, "CPF:");
  put(60, 180, "[ ] Concordo com os termos");
  w.endPage(); w.close();

  const e3 = new PdfEngine();
  e3.open(new Uint8Array(buf.asUint8Array()));
  const det = e3.autoDetectFields(0);
  assert.ok(det.created >= 3, `esperava detectar >= 3 campos, detectou ${det.created}`);
  const kinds = e3.fields(0).map((x) => x.type);
  assert.ok(kinds.includes("text"));
  assert.ok(kinds.includes("checkbox"));
});

test("desfazer (Ctrl+Z) e refazer (Ctrl+Y) sobrevivem ao salvamento", () => {
  const e = new PdfEngine();
  e.open(sample(1));
  const original = allText(e, 0);

  e.addHeaderFooter({ items: [{ pos: "bc", text: "RODAPE-V1" }] });
  e.save();
  assert.equal(e.info().dirty, false);
  assert.equal(e.info().canUndo, true, "pode desfazer mesmo imediatamente após salvar");
  assert.match(allText(e, 0), /RODAPE-V1/);

  e.undo();
  assert.doesNotMatch(allText(e, 0), /RODAPE-V1/, "Ctrl+Z voltou para antes do salvamento");
  assert.equal(allText(e, 0), original);
  assert.equal(e.info().canRedo, true);

  e.redo();
  assert.match(allText(e, 0), /RODAPE-V1/, "Ctrl+Y refez para a versão salva");
});

test("pré-processamento OCR (endireitamento + contraste) e modelo best em página torta e escura", async () => {
  // Cria uma página escaneada torta (+3.2°) com fundo cinza escuro e baixo contraste
  const srcDoc = new mupdf.PDFDocument();
  const f = srcDoc.newDictionary();
  f.put("Type", srcDoc.newName("Font")); f.put("Subtype", srcDoc.newName("Type1"));
  f.put("BaseFont", srcDoc.newName("Helvetica-Bold")); f.put("Encoding", srcDoc.newName("WinAnsiEncoding"));
  const res = srcDoc.newDictionary();
  const fd = srcDoc.newDictionary(); fd.put("F1", srcDoc.addObject(f)); res.put("Font", fd);
  const rad = (3.2 * Math.PI) / 180;
  const c = Math.cos(rad).toFixed(5), s = Math.sin(rad).toFixed(5);
  const ops = [
    "0.76 0.75 0.72 rg 0 0 595 842 re f", // fundo cinza escuro simulando foto sem luz
    "0.32 0.32 0.32 rg", // texto lavado / baixo contraste
    `q ${c} ${s} ${(-Number(s)).toFixed(5)} ${c} 50 40 cm`,
    "BT /F1 16 Tf 1 0 0 1 60 660 Tm (RELATORIO FINANCEIRO DE SETEMBRO) Tj ET",
    "BT /F1 13 Tf 1 0 0 1 60 620 Tm (Total faturado na filial de Curitiba: R$ 48.500,00) Tj ET",
    "BT /F1 13 Tf 1 0 0 1 60 585 Tm (Responsavel tecnico: Joao Pedro Oliveira) Tj ET",
    "BT /F1 13 Tf 1 0 0 1 60 550 Tm (Documento revisado e aprovado para protocolo.) Tj ET",
    "Q",
  ].join("\n");
  srcDoc.insertPage(-1, srcDoc.addPage([0, 0, 595, 842], 0, res, ops));
  const p = srcDoc.loadPage(0);
  const pix = p.toPixmap(mupdf.Matrix.scale(200 / 72, 200 / 72), mupdf.ColorSpace.DeviceRGB, false, true);
  const jpg = new Uint8Array(pix.asJPEG(85));
  pix.destroy(); p.destroy(); srcDoc.destroy();

  const e = new PdfEngine();
  e.imagesToPdf([jpg], { page: "A4" }, "scan_torto");
  assert.equal(e.needsOcr(0), true);

  const rec = await createRecognizer(join(tmpdir(), "papiro-tier2-ocr-cache"), "por", "best");
  try {
    const r = await e.ocrPage(0, rec.recognize, 300, true);
    assert.equal(r.enhanced, true, "normalizou o contraste da foto escura");
    assert.ok(Math.abs(r.deskewDeg) >= 2.0, `detectou inclinação (~3.2°), veio ${r.deskewDeg}°`);
    const txt = allText(e, 0);
    assert.match(txt, /RELATORIO|FINANCEIRO/i);
    assert.match(txt, /Curitiba/i);
    assert.match(txt, /protocolo/i);
  } finally {
    await rec.dispose();
  }
});

test("impressão vetorial SVG (com rotação de paisagem) e conversão Markdown → HTML offline", () => {
  const e = new PdfEngine();
  e.open(sample(1));
  // Insere página paisagem (842×595)
  e.insertBlankPage(1, [842, 595]);
  const svg0 = e.printSvg(0);
  const svg1 = e.printSvg(1);
  assert.ok(svg0 && svg0.includes("<svg"));
  assert.ok(svg1 && svg1.includes("<svg") && /width="595/.test(svg1), "página paisagem girada para retrato no SVG");

  const html = markdownToHtml("# Título Principal\n\nTexto **negrito** e `código`.\n\n| Item | Valor |\n|---|---|\n| A | 10 |\n\n- Ponto 1\n- Ponto 2", "Nota");
  assert.match(html, /<h1>Título Principal<\/h1>/);
  assert.match(html, /<strong>negrito<\/strong>/);
  assert.match(html, /<code>código<\/code>/);
  assert.match(html, /<table><thead><tr><th>Item<\/th><th>Valor<\/th><\/tr><\/thead>/);
  assert.match(html, /<ul>\n<li>Ponto 1<\/li>/);
});
