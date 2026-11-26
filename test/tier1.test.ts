// Testes dos recursos Tier 1 (100% offline):
// redação inteligente (LGPD + overlay), auditoria de espaço + otimizador avançado,
// numeração Bates, rótulos de página (/PageLabels), resumo de comentários (MD/CSV/PDF),
// anexos embutidos, camadas (OCG), links e geração automática de marcadores.
// node --test test/tier1.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PdfEngine, mupdf } from "../src/engine/core.ts";
import { findSystemFont } from "../src/main/system-fonts.ts";
import { sample } from "./fixtures.ts";

const allText = (e: PdfEngine, p = 0) => e.pageText(p).flatMap((b) => b.lines.map((l) => l.text)).join("\n");

function makeTextPdf(pages: { lines: { text: string; size?: number; bold?: boolean; x?: number; y?: number }[] }[]): Uint8Array {
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "pdf", "");
  const fReg = new mupdf.Font("Helvetica");
  const fBold = new mupdf.Font("Helvetica-Bold");
  for (const pg of pages) {
    const dev = w.beginPage([0, 0, 595, 842]);
    let y = 80;
    for (const ln of pg.lines) {
      const sz = ln.size ?? 11;
      const ly = ln.y ?? y;
      const lx = ln.x ?? 60;
      const t = new mupdf.Text();
      t.showString(ln.bold ? fBold : fReg, [sz, 0, 0, -sz, lx, ly], ln.text);
      dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
      y = ly + sz * 1.8;
    }
    w.endPage();
  }
  w.close();
  return new Uint8Array(buf.asUint8Array());
}

test("redação inteligente LGPD detecta CPF/CNPJ/e-mail válidos, ignora inválidos e aplica texto sobre a tarja", () => {
  // CPF válido: 529.982.247-25 · CPF inválido: 123.456.789-00 · CNPJ válido: 11.222.333/0001-81
  const pdf = makeTextPdf([{
    lines: [
      { text: "Cliente: Maria Silva" },
      { text: "CPF valido: 529.982.247-25 e invalido: 123.456.789-00" },
      { text: "CNPJ: 11.222.333/0001-81" },
      { text: "Contato: maria.silva@exemplo.com.br" },
      { text: "CEP: 01310-100" },
    ],
  }]);
  const e = new PdfEngine({ fonts: findSystemFont });
  e.open(pdf);
  const res = e.redactByPatterns({
    patterns: ["cpf", "cnpj", "email", "cep"],
    overlayText: "LGPD",
  });
  assert.equal(res.marked, 4, `esperava 4 ocorrências válidas, veio ${res.marked}`);
  assert.equal(res.byLabel.CPF, 1);
  assert.equal(res.byLabel.CNPJ, 1);
  assert.equal(res.byLabel["E-mail"], 1);
  assert.equal(res.byLabel.CEP, 1);

  const applied = e.applyAllRedactions();
  assert.equal(applied.pages, 1);
  const txt = allText(e, 0);
  assert.doesNotMatch(txt, /529\.982\.247-25/, "CPF removido de verdade");
  assert.doesNotMatch(txt, /11\.222\.333\/0001-81/, "CNPJ removido de verdade");
  assert.doesNotMatch(txt, /maria\.silva@exemplo\.com\.br/, "e-mail removido de verdade");
  assert.doesNotMatch(txt, /01310-100/, "CEP removido de verdade");
  assert.match(txt, /123\.456\.789-00/, "número com dígitos inválidos não foi falso positivo");
  assert.match(txt, /LGPD/, "texto de sobreposição gravado sobre a tarja");

  e.undo();
  assert.match(allText(e, 0), /529\.982\.247-25/, "Ctrl+Z desfaz aplicação da redação");
});

test("auditoria de espaço e otimizador avançado (deduplicação, metadados, anexos, JavaScript)", () => {
  const e = new PdfEngine();
  e.open(sample(2));
  e.addAttachment("dados.txt", new TextEncoder().encode("conteudo secreto ".repeat(200)), "text/plain");
  const audit = e.auditSpace();
  assert.ok(audit.totalBytes > 0);
  assert.equal(audit.attachmentCount, 1);
  assert.ok(audit.attachments > 0);
  assert.equal(e.info().canUndo, true, "auditSpace não apaga histórico de desfazer");

  const opt = e.exportOptimized({
    level: "media",
    subsetFonts: true,
    deduplicate: true,
    stripMetadata: true,
    stripAttachments: true,
    stripThumbnails: true,
    stripJavaScript: true,
  });
  assert.ok(opt.after < opt.before, `esperava reduzir após remover anexo, antes=${opt.before} depois=${opt.after}`);
  const e2 = new PdfEngine();
  e2.open(opt.bytes);
  assert.equal(e2.attachments().length, 0, "anexos removidos na cópia otimizada");
  assert.equal(e.attachments().length, 1, "documento aberto não foi alterado");
});

test("numeração Bates sequencial e rótulos de página (/PageLabels)", () => {
  const e = new PdfEngine({ fonts: findSystemFont });
  e.open(sample(3));
  const b = e.addBatesNumbering({ prefix: "PROC-", startNumber: 42, digits: 6, suffix: "/26", pos: "br" });
  assert.equal(b.nextNumber, 45);
  assert.match(allText(e, 0), /PROC-000042\/26/);
  assert.match(allText(e, 1), /PROC-000043\/26/);
  assert.match(allText(e, 2), /PROC-000044\/26/);
  e.undo();
  assert.doesNotMatch(allText(e, 0), /PROC-000042\/26/);

  const info = e.setPageLabelRules([
    { startPage: 0, style: "r", prefix: "", startAt: 1 },
    { startPage: 1, style: "D", prefix: "A-", startAt: 1 },
  ]);
  assert.equal(info.pages[0].label, "i");
  assert.equal(info.pages[1].label, "A-1");
  assert.equal(info.pages[2].label, "A-2");

  const cleared = e.clearPageLabels();
  assert.equal(cleared.pages[0].label, "1");
  assert.equal(cleared.pages[1].label, "2");
});

test("resumo de comentários extrai trecho realçado e exporta em Markdown, CSV e PDF", () => {
  const e = new PdfEngine();
  e.open(sample(2));
  const hit = e.search("Manaus")[0];
  assert.ok(hit, "achou Manaus no documento de amostra");
  e.addAnnotation(0, { kind: "Highlight", quads: hit.quads, color: [1, 0.9, 0] }, "Lucas");
  e.addAnnotation(0, { kind: "Text", at: [100, 120], contents: "Conferir endereço da filial" }, "Lucas");

  const sum = e.commentsSummary();
  assert.equal(sum.length, 2);
  assert.ok(sum.some((s) => s.kind === "Highlight" && s.quote.includes("Manaus")), "trecho destacado capturado");
  assert.ok(sum.some((s) => s.kind === "Text" && s.contents.includes("Conferir endereço")));

  const md = new TextDecoder().decode(e.exportCommentsSummary("md"));
  assert.match(md, /# Resumo de comentários/);
  assert.match(md, /Manaus/);
  assert.match(md, /Conferir endereço/);

  const csv = new TextDecoder().decode(e.exportCommentsSummary("csv"));
  assert.match(csv, /Página;Tipo;Autor;Trecho marcado;Comentário/);
  assert.match(csv, /Manaus/);

  const pdfBytes = e.exportCommentsSummary("pdf");
  const eSum = new PdfEngine();
  eSum.open(pdfBytes);
  assert.ok(eSum.info().pageCount >= 1);
  assert.match(allText(eSum, 0), /Resumo de comentários/);
  assert.match(allText(eSum, 0), /Conferir endereço/);
});

test("anexos embutidos: anexar, listar, extrair, persistir e remover", () => {
  const e = new PdfEngine();
  e.open(sample(1));
  assert.equal(e.attachments().length, 0);
  const payload = new TextEncoder().encode("XML da nota fiscal de teste");
  e.addAttachment("nfe-123.xml", payload, "application/xml");
  const list = e.attachments();
  assert.equal(list.length, 1);
  assert.equal(list[0].filename, "nfe-123.xml");
  assert.equal(list[0].size, payload.length);
  assert.equal(new TextDecoder().decode(e.getAttachmentData(list[0].key)), "XML da nota fiscal de teste");

  // Persiste após salvar e reabrir
  const e2 = new PdfEngine();
  e2.open(e.save());
  assert.equal(e2.attachments().length, 1);
  assert.equal(e2.attachments()[0].filename, "nfe-123.xml");

  e2.deleteAttachment(e2.attachments()[0].key);
  assert.equal(e2.attachments().length, 0);
});

test("camadas (OCG): listar e alternar visibilidade afeta a renderização", () => {
  const doc = new mupdf.PDFDocument();
  const ocg = doc.newDictionary();
  ocg.put("Type", doc.newName("OCG"));
  ocg.put("Name", doc.newString("Desenho Vermelho"));
  const ocgRef = doc.addObject(ocg);

  const ocgs = doc.newArray(); ocgs.push(ocgRef);
  const onArr = doc.newArray(); onArr.push(ocgRef);
  const dDict = doc.newDictionary();
  dDict.put("BaseState", doc.newName("ON"));
  dDict.put("ON", onArr);
  dDict.put("Order", ocgs);
  const ocProps = doc.newDictionary();
  ocProps.put("OCGs", ocgs);
  ocProps.put("D", dDict);
  doc.getTrailer().get("Root").resolve().put("OCProperties", ocProps);

  const props = doc.newDictionary(); props.put("L0", ocgRef);
  const res = doc.newDictionary(); res.put("Properties", props);
  doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, res, "/OC /L0 BDC 1 0 0 rg 20 20 160 160 re f EMC"));
  const bytes = new Uint8Array(doc.saveToBuffer("compress").asUint8Array());
  doc.destroy();

  const e = new PdfEngine();
  e.open(bytes);
  const layers = e.layers();
  assert.equal(layers.length, 1);
  assert.equal(layers[0].name, "Desenho Vermelho");
  assert.equal(layers[0].visible, true);

  const pxOn = e.render(0, 1);
  const mid = (100 * pxOn.width + 100) * 4;
  assert.ok(pxOn.rgba[mid] > 200 && pxOn.rgba[mid + 1] < 50, "camada visível desenha vermelho");

  const updated = e.setLayerVisibility(0, false);
  assert.equal(updated[0].visible, false);
  const pxOff = e.render(0, 1);
  assert.ok(pxOff.rgba[mid] > 240 && pxOff.rgba[mid + 1] > 240, "camada oculta some na renderização");
});

test("links (interno e externo) e geração automática de marcadores por títulos", () => {
  const pdf = makeTextPdf([
    {
      lines: [
        { text: "1. Introdução ao Projeto", size: 18, bold: true },
        { text: "Este parágrafo apresenta o contexto geral do documento em corpo normal.", size: 10 },
        { text: "1.1 Escopo Técnico", size: 14, bold: true },
        { text: "Detalhes do escopo técnico com texto contínuo em tamanho padrão.", size: 10 },
      ],
    },
    {
      lines: [
        { text: "2. Conclusão e Próximos Passos", size: 18, bold: true },
        { text: "Texto final da conclusão com recomendações práticas.", size: 10 },
      ],
    },
  ]);

  const e = new PdfEngine();
  e.open(pdf);

  // Links interno e externo
  e.addLink(0, [60, 60, 240, 90], { page: 1 });
  e.addLink(0, [60, 100, 240, 120], { uri: "https://example.org" });
  const links = e.links(0);
  assert.equal(links.length, 2);
  assert.ok(links.some((l) => !l.isExternal && l.targetPage === 1), "link interno aponta para página 2");
  assert.ok(links.some((l) => l.isExternal && l.uri === "https://example.org"), "link externo preservado");

  e.deleteLink(0, 1);
  assert.equal(e.links(0).length, 1);

  // Geração automática de marcadores
  const auto = e.autoOutline();
  assert.equal(auto.count, 3);
  assert.equal(auto.info.outline.length, 2, "dois títulos principais H1");
  assert.equal(auto.info.outline[0].title, "1. Introdução ao Projeto");
  assert.equal(auto.info.outline[0].children[0].title, "1.1 Escopo Técnico");
  assert.equal(auto.info.outline[1].title, "2. Conclusão e Próximos Passos");
  assert.equal(auto.info.outline[1].page, 1);
});
