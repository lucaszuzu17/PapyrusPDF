// Recursos da versão 0.2: senha, compressão, cabeçalho/rodapé, marca d'água, imagens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PdfEngine, mupdf } from "../src/engine/core.ts";

const OUT = join(import.meta.dirname, "out");
mkdirSync(OUT, { recursive: true });

function samplePdf(pages = 3): Uint8Array {
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "pdf", "");
  const helv = new mupdf.Font("Helvetica");
  for (let p = 0; p < pages; p++) {
    const dev = w.beginPage([0, 0, 595, 842]);
    const t = new mupdf.Text();
    t.showString(helv, [16, 0, 0, -16, 72, 120], `Documento confidencial, folha ${p + 1}`);
    dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
    w.endPage();
  }
  w.close();
  return new Uint8Array(buf.asUint8Array());
}

/** Imagem parecida com foto: degradê suave com ruído leve (PNG grande, comprime bem em JPEG). */
function photo(w: number, h: number, seed = 1): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels();
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3, n = rnd() * 24;
    px[i] = (x / w) * 200 + n; px[i + 1] = (y / h) * 200 + n; px[i + 2] = 120 + 60 * Math.sin((x + y) / 90) + n;
  }
  const png = new Uint8Array(pix.asPNG());
  pix.destroy();
  return png;
}

const text = (e: PdfEngine, i: number) => e.pageText(i).flatMap((b) => b.lines.map((l) => l.text)).join("\n");
const lines = (e: PdfEngine, i: number) => e.pageText(i).flatMap((b) => b.lines);

test("proteger com senha: abertura, permissões e remoção", () => {
  const e = new PdfEngine();
  e.open(samplePdf(2), "contrato");
  e.addAnnotation(0, { kind: "Text", at: [300, 300], contents: "nota" });
  const prot = e.exportProtected({ userPassword: "abre123", ownerPassword: "dono456", permissions: { print: true, copy: false, edit: false, annotate: false } });
  writeFileSync(join(OUT, "protegido.pdf"), prot);
  // o documento aberto continua utilizável e com as alterações pendentes
  assert.equal(e.info().dirty, true);
  assert.equal(e.isEncrypted(), false);
  assert.equal(e.annotations(0).length, 1);

  const raw = mupdf.Document.openDocument(prot, "application/pdf").asPDF()!;
  assert.equal(raw.needsPassword(), true);
  assert.equal(raw.authenticatePassword("errada"), 0);
  assert.ok(raw.authenticatePassword("abre123") > 0);
  assert.equal(raw.hasPermission("print"), true);
  assert.equal(raw.hasPermission("copy"), false);
  assert.equal(raw.hasPermission("edit"), false);
  assert.equal(raw.hasPermission("annotate"), false);

  // abrir pelo motor: pede senha, recusa a errada, aceita a certa
  const p = new PdfEngine();
  p.open(prot, "protegido");
  assert.equal(p.needsPassword(), true);
  assert.throws(() => p.unlock("errada"), /Senha incorreta/);
  p.unlock("abre123");
  assert.equal(p.needsPassword(), false);
  assert.equal(p.isEncrypted(), true);
  assert.match(text(p, 0), /Documento confidencial/);
  // editar e salvar um documento protegido: continua protegido e legível
  p.addHeaderFooter({ items: [{ pos: "bc", text: "{p}/{total}" }] });
  const saved = p.save();
  assert.match(text(p, 1), /2\/2/);
  const again = new PdfEngine();
  again.open(saved, "x");
  assert.equal(again.needsPassword(), true);
  again.unlock("abre123");
  assert.match(text(again, 1), /2\/2/);
  // remover a proteção
  const open = again.exportUnprotected();
  const free = new PdfEngine();
  free.open(open, "livre");
  assert.equal(free.needsPassword(), false);
  assert.equal(free.isEncrypted(), false);
  assert.match(text(free, 0), /Documento confidencial/);

  // só restrições (sem senha de abertura): abre direto, mas não deixa copiar
  const restr = e.exportProtected({ permissions: { print: true, copy: false, edit: false, annotate: true } });
  const r2 = mupdf.Document.openDocument(restr, "application/pdf").asPDF()!;
  assert.equal(r2.needsPassword(), false);
  assert.equal(r2.hasPermission("copy"), false);
  assert.equal(r2.hasPermission("annotate"), true);
  const r3 = new PdfEngine();
  r3.open(restr, "restrito");
  assert.equal(r3.needsPassword(), false);
  assert.equal(r3.isEncrypted(), true);
  assert.match(text(r3, 0), /Documento confidencial/);

  assert.throws(() => e.exportProtected({ userPassword: "a,b", permissions: { print: true, copy: true, edit: true, annotate: true } }), /vírgula/);
});

test("comprimir reduz imagens grandes sem estragar o documento", () => {
  const e = new PdfEngine();
  e.imagesToPdf([photo(3000, 2000, 1), photo(2000, 3000, 2)], { page: "A4" }, "fotos");
  const before = e.save();
  const r = e.exportCompressed("media");
  writeFileSync(join(OUT, "fotos.pdf"), before);
  writeFileSync(join(OUT, "fotos-comprimido.pdf"), r.bytes);
  assert.equal(r.images, 2);
  assert.ok(r.after < r.before * 0.5, `esperava menos da metade: ${r.before} → ${r.after}`);
  const c = new PdfEngine();
  const info = c.open(r.bytes);
  assert.equal(info.pageCount, 2);
  // a página continua com a mesma aparência geral
  const a = e.render(0, 0.2), b = c.render(0, 0.2);
  assert.equal(a.width, b.width);
  let diff = 0;
  for (let i = 0; i < a.rgba.length; i++) diff += Math.abs(a.rgba[i] - b.rgba[i]);
  assert.ok(diff / a.rgba.length < 6, `imagem mudou demais: ${diff / a.rgba.length}`);
  // níveis: forte <= média <= leve
  const forte = e.exportCompressed("forte"), leve = e.exportCompressed("leve");
  assert.ok(forte.after <= r.after && r.after <= leve.after, `${forte.after} ${r.after} ${leve.after}`);
  // documento só com texto: nunca fica maior
  const t = new PdfEngine();
  t.open(samplePdf(3));
  const rt = t.exportCompressed("forte");
  assert.ok(rt.after <= rt.before);
  assert.equal(rt.images, 0);
});

test("cabeçalho, rodapé e numeração", () => {
  const e = new PdfEngine();
  e.open(samplePdf(3), "relatorio");
  e.addHeaderFooter({ items: [
    { pos: "tl", text: "{arquivo}" }, { pos: "tr", text: "Emitido em {data}" },
    { pos: "bc", text: "Página {p} de {total}" }, { pos: "br", text: "Ação — nº 1" },
  ] });
  for (let i = 0; i < 3; i++) {
    const t = text(e, i);
    assert.match(t, new RegExp(`Página ${i + 1} de 3`));
    assert.match(t, /relatorio/);
    assert.match(t, /Emitido em \d{2}\/\d{2}\/\d{4}/);
    assert.match(t, /Ação — nº 1/);
    assert.match(t, /Documento confidencial/);
  }
  // posições: rodapé central no meio e embaixo; cabeçalho direito encostado na margem
  const ls = lines(e, 0);
  const foot = ls.find((l) => /Página 1 de 3/.test(l.text))!;
  assert.ok(Math.abs((foot.bbox[0] + foot.bbox[2]) / 2 - 297.5) < 2, `centro ${foot.bbox}`);
  assert.ok(foot.bbox[3] > 800 && foot.bbox[3] < 842);
  const right = ls.find((l) => /Emitido/.test(l.text))!;
  assert.ok(Math.abs(right.bbox[2] - (595 - 28)) < 2, `direita ${right.bbox}`);
  assert.ok(right.bbox[1] > 20 && right.bbox[3] < 50, `topo ${right.bbox}`);
  // um único desfazer remove tudo
  e.undo();
  assert.doesNotMatch(text(e, 0), /Página 1 de 3/);
  e.redo();
  // só algumas páginas, começando do 5
  const n = new PdfEngine();
  n.open(samplePdf(4));
  n.addHeaderFooter({ items: [{ pos: "bc", text: "{p}" }], pages: [1, 2, 3], startAt: 5 });
  assert.doesNotMatch(text(n, 0), /^5$/m);
  assert.match(text(n, 1), /^5$/m);
  assert.match(text(n, 3), /^7$/m);
  // página girada: o rodapé fica na base visível
  const g = new PdfEngine();
  g.open(samplePdf(1));
  g.rotatePages([0], 90);
  g.addHeaderFooter({ items: [{ pos: "bc", text: "Rodapé girado" }] });
  const gl = lines(g, 0).find((l) => /Rodapé girado/.test(l.text))!;
  assert.ok(gl.bbox[3] > 560 && gl.bbox[3] < 595, `girada ${gl.bbox}`);
  assert.ok(Math.abs((gl.bbox[0] + gl.bbox[2]) / 2 - 421) < 2);
  writeFileSync(join(OUT, "cabecalho.pdf"), e.save());
});

test("marca d'água transparente e centralizada", () => {
  const e = new PdfEngine();
  e.open(samplePdf(2));
  const before = e.render(0, 0.5);
  e.addWatermark({ text: "CONFIDENCIAL" });
  assert.equal(e.search("CONFIDENCIAL").length, 2);
  assert.match(text(e, 0), /Documento confidencial/);
  const after = e.render(0, 0.5);
  // a página mudou, mas pouco (transparente): nenhum pixel alterado fica escuro
  let changed = 0, darkest = 255;
  for (let i = 0; i < after.rgba.length; i += 4) {
    if (after.rgba[i] !== before.rgba[i]) { changed++; darkest = Math.min(darkest, after.rgba[i]); }
  }
  assert.ok(changed > 2000, `poucos pixels mudaram: ${changed}`);
  assert.ok(darkest > 150, `marca escura demais: ${darkest}`);
  // centro da caixa do texto no centro da página
  const hit = e.search("CONFIDENCIAL")[0].quads[0];
  const xs = [hit[0], hit[2], hit[4], hit[6]], ys = [hit[1], hit[3], hit[5], hit[7]];
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  assert.ok(Math.abs(cx - 297.5) < 25 && Math.abs(cy - 421) < 25, `centro ${cx}, ${cy}`);
  // sobe da esquerda para a direita (45°)
  assert.ok(Math.max(...ys) - Math.min(...ys) > 200, `inclinação ${hit}`);
  // por baixo do conteúdo e horizontal
  const b = new PdfEngine();
  b.open(samplePdf(1));
  b.addWatermark({ text: "RASCUNHO", angle: 0, behind: true, opacity: 0.3, color: [1, 0, 0] });
  const q = b.search("RASCUNHO")[0].quads[0];
  assert.ok(Math.abs(q[1] - q[3]) < 0.5, "horizontal");
  writeFileSync(join(OUT, "marca.pdf"), e.save());
  const re = new PdfEngine(); re.open(e.save());
  assert.equal(re.search("CONFIDENCIAL").length, 2);
});

test("imagens → PDF, inserir imagem e página → imagem", () => {
  const land = photo(800, 500, 3), port = photo(500, 800, 4);
  const e = new PdfEngine();
  let info = e.imagesToPdf([land, port], { page: "A4" }, "digitalizacao");
  assert.equal(info.pageCount, 2);
  assert.equal(info.dirty, true);
  assert.deepEqual([Math.round(info.pages[0].width), Math.round(info.pages[0].height)], [842, 595]);
  assert.deepEqual([Math.round(info.pages[1].width), Math.round(info.pages[1].height)], [595, 842]);
  info = e.insertImages([port], 1, { page: "imagem" });
  assert.equal(info.pageCount, 3);
  assert.deepEqual([Math.round(info.pages[1].width), Math.round(info.pages[1].height)], [526, 842]);
  e.undo();
  assert.equal(e.info().pageCount, 2);
  // a imagem ocupa a página (centro não é branco)
  const r = e.render(0, 0.25);
  const mid = (Math.floor(r.height / 2) * r.width + Math.floor(r.width / 2)) * 4;
  assert.ok(r.rgba[mid] < 250 || r.rgba[mid + 1] < 250);
  // página → imagem, e JPEG também entra como página
  const jpg = e.pageImage(0, 72, "jpg");
  assert.deepEqual([...jpg.slice(0, 3)], [0xff, 0xd8, 0xff]);
  const png = e.pageImage(1, 150, "png");
  assert.deepEqual([...png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const dim = new mupdf.Image(png);
  assert.ok(Math.abs(dim.getWidth() - (595 * 150) / 72) <= 1, `largura ${dim.getWidth()}`);
  const j = new PdfEngine();
  assert.equal(j.imagesToPdf([jpg], { page: "Carta" }).pageCount, 1);
  // falha ao criar não derruba o documento que estava aberto
  assert.throws(() => j.imagesToPdf([new Uint8Array([1, 2, 3, 4])]));
  assert.equal(j.info().pageCount, 1);
});
