// Gera os PDFs de teste em test/fixtures: node test/fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PdfEngine, mupdf } from "../src/engine/core.ts";

const DIR = join(import.meta.dirname, "fixtures");
mkdirSync(DIR, { recursive: true });

export function sample(pages = 3): Uint8Array {
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "pdf", "");
  const helv = new mupdf.Font("Helvetica");
  const helvB = new mupdf.Font("Helvetica-Bold");
  const times = new mupdf.Font("Times-Roman");
  for (let p = 0; p < pages; p++) {
    const dev = w.beginPage([0, 0, 595, 842]);
    const put = (font: mupdf.Font, size: number, x: number, y: number, s: string, c: [number, number, number] = [0.1, 0.1, 0.2]) => {
      const t = new mupdf.Text();
      t.showString(font, [size, 0, 0, -size, x, y], s);
      dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, c, 1);
    };
    put(helvB, 22, 72, 96, `Relatório mensal — página ${p + 1}`, [0.45, 0.28, 0.08]);
    const para = [
      "Este parágrafo de exemplo serve para testar a edição de texto,",
      "a seleção, o realce e a busca. Ele tem acentuação: ação, coração,",
      "informação, São Paulo e Manaus.",
    ];
    para.forEach((s, i) => put(times, 13, 72, 140 + i * 17, s));
    put(helv, 11, 72, 230, "Segundo bloco, em fonte sem serifa, com números: 1.234,56 e 99%.");
    const path = new mupdf.Path();
    path.rect(72, 270, 523, 420);
    dev.fillPath(path, false, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [0.93, 0.89, 0.8], 1);
    put(helv, 12, 90, 300, "Quadro com fundo: o texto aqui também pode ser editado.");
    w.endPage();
  }
  w.close();
  return new Uint8Array(buf.asUint8Array());
}

export function scanned(): Uint8Array {
  const e = new PdfEngine();
  e.open(sample(1));
  const png = e.renderPng(0, 200 / 72);
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "pdf", "");
  const dev = w.beginPage([0, 0, 595, 842]);
  dev.fillImage(new mupdf.Image(png), [595, 0, 0, 842, 0, 0], 1);
  w.endPage(); w.close();
  return new Uint8Array(buf.asUint8Array());
}

/** Formulário AcroForm escrito à mão (campo de texto, caixa de seleção e lista). */
export function form(): Uint8Array {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R 10 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 6 0 R /ZaDb 11 0 R >> >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R 5 0 R 10 0 R] /Contents 7 0 R /Resources << /Font << /Helv 6 0 R >> >> >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (nome) /TU (Nome completo) /Rect [180 700 480 724] /P 3 0 R /DA (/Helv 12 Tf 0 g) /F 4 /MK << /BC [0 0 0] >> >>",
    "<< /Type /Annot /Subtype /Widget /FT /Btn /T (aceito) /Rect [180 650 198 668] /P 3 0 R /V /Off /AS /Off /F 4 /DA (/ZaDb 0 Tf 0 g) /MK << /CA (4) /BC [0 0 0] >> /AP << /N << /Sim 8 0 R /Off 9 0 R >> >> >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "STREAM:BT /Helv 14 Tf 72 706 Td (Nome:) Tj 0 -50 Td (Aceito os termos) Tj 0 -50 Td (Estado:) Tj ET\n0 0 0 RG 72 760 m 523 760 l S\nBT /Helv 18 Tf 72 780 Td (Ficha de cadastro) Tj ET",
    "STREAM_AP:0 0 0 rg BT /ZaDb 14 Tf 2 3 Td (4) Tj ET",
    "STREAM_AP:",
    "<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (estado) /Rect [180 600 330 624] /P 3 0 R /Opt [(AM) (PA) (SP) (RJ)] /DA (/Helv 12 Tf 0 g) /F 4 /MK << /BC [0 0 0] >> >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>",
  ];
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    let body = o;
    if (o.startsWith("STREAM:")) { const s = o.slice(7); body = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`; }
    if (o.startsWith("STREAM_AP:")) { const s = o.slice(10); body = `<< /Type /XObject /Subtype /Form /BBox [0 0 18 18] /Resources << /Font << /ZaDb 11 0 R >> >> /Length ${s.length} >>\nstream\n${s}\nendstream`; }
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

if (import.meta.main) {
  writeFileSync(join(DIR, "amostra.pdf"), sample(3));
  writeFileSync(join(DIR, "escaneado.pdf"), scanned());
  writeFileSync(join(DIR, "formulario.pdf"), form());
  const f = new PdfEngine(); f.open(form());
  console.log("campos do formulário:", f.fields(0).map((x) => `${x.name}:${x.type}`).join(", "));
  console.log("fixtures em", DIR);
}
