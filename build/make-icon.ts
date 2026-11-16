// Desenha os ícones em vetor com o próprio MuPDF: node build/make-icon.ts
//   build/icon.ico  programa (bloco escuro, "P" que enrola em âmbar, "EDITOR" embaixo)
//   build/file.ico  arquivo .pdf (folha escura com faixa âmbar "PDF")
//   build/icon.png  512 px, para referência e para o Electron em desenvolvimento
// Nos tamanhos pequenos (até 32 px) o texto some e o desenho engrossa, para continuar legível.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mupdf } from "../src/engine/core.ts";

const INK = "#2a2620", AMBER = "#e0a24f", CREAM = "#f3e3c8", EDGE = "#5a5145";
const K = 0.5523; // constante da curva de Bézier que aproxima um quarto de círculo
const rgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

/** Tela de desenho numa grade de 72 unidades, renderizada em `size` pixels. */
function canvas(size: number) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, size, size], true);
  pix.clear(); // sem argumento = totalmente transparente (clear(0) deixaria preto opaco)
  const m = mupdf.Matrix.scale(size / 72, size / 72);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const bold = new mupdf.Font("Helvetica-Bold");
  return {
    pix,
    fill: (p: mupdf.Path, c: string) => dev.fillPath(p, false, m, mupdf.ColorSpace.DeviceRGB, rgb(c), 1),
    stroke: (p: mupdf.Path, c: string, w: number, cap: "Round" | "Butt" = "Round") =>
      dev.strokePath(p, new mupdf.StrokeState({ lineCap: cap, lineJoin: "Round", lineWidth: w, miterLimit: 4 }), m, mupdf.ColorSpace.DeviceRGB, rgb(c), 1),
    /** Texto em negrito centralizado em `cx`, com espaçamento extra entre letras. */
    text(s: string, cx: number, baseline: number, px: number, c: string, tracking = 0) {
      const adv = [...s].map((ch) => bold.advanceGlyph(bold.encodeCharacter(ch.codePointAt(0)!), 0) * px);
      let x = cx - (adv.reduce((a, b) => a + b, 0) + tracking * (s.length - 1)) / 2;
      const t = new mupdf.Text();
      [...s].forEach((ch, i) => { t.showString(bold, [px, 0, 0, -px, x, baseline], ch); x += adv[i] + tracking; });
      dev.fillText(t, m, mupdf.ColorSpace.DeviceRGB, rgb(c), 1);
    },
    done: () => { dev.close(); return pix; },
  };
}

function rounded(x: number, y: number, w: number, h: number, r: number) {
  const p = new mupdf.Path(), k = r * K;
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y); p.curveTo(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
  p.lineTo(x + w, y + h - r); p.curveTo(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
  p.lineTo(x + r, y + h); p.curveTo(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
  p.lineTo(x, y + r); p.curveTo(x, y + r - k, x + r - k, y, x + r, y);
  p.closePath();
  return p;
}

/**
 * "P" de um traço só cujo pé enrola como a ponta de um papiro.
 * x = haste, top = topo, r = raio da barriga, foot = fim da haste, hook = raio do enrolado.
 */
function scrollP(x: number, top: number, r: number, foot: number, hook: number) {
  const p = new mupdf.Path();
  const bx = x + r * 0.9, cy = top + r, k = r * K, h = hook * K;
  p.moveTo(x, top); p.lineTo(bx, top);
  p.curveTo(bx + k, top, bx + r, cy - k, bx + r, cy);
  p.curveTo(bx + r, cy + k, bx + k, cy + r, bx, cy + r);
  p.lineTo(x, cy + r);
  p.moveTo(x, top); p.lineTo(x, foot);
  p.curveTo(x, foot + h, x - hook + h, foot + hook, x - hook, foot + hook);
  p.curveTo(x - hook - h, foot + hook, x - 2 * hook, foot + h, x - 2 * hook, foot);
  return p;
}

function appIcon(size: number): mupdf.Pixmap {
  const c = canvas(size);
  c.fill(rounded(0, 0, 72, 72, 16), INK);
  if (size >= 32) c.stroke(rounded(0.8, 0.8, 70.4, 70.4, 15.4), EDGE, 1.6); // contorno: destaca em barra de tarefas escura
  if (size >= 48) {
    c.stroke(scrollP(32.5, 11, 9, 37.5, 5), AMBER, 5.6);
    c.text("EDITOR", 36, 61.5, 10.2, CREAM, 1.15);
  } else {
    c.stroke(scrollP(31.5, 16, 11.5, 48, 6.5), AMBER, size <= 16 ? 9 : 7.6);
  }
  return c.done();
}

function fileIcon(size: number): mupdf.Pixmap {
  const c = canvas(size);
  const page = new mupdf.Path();
  page.moveTo(15, 5); page.lineTo(43, 5); page.lineTo(57, 19); page.lineTo(57, 67); page.lineTo(15, 67); page.closePath();
  c.fill(page, INK);
  c.stroke(page, EDGE, size <= 24 ? 3 : 1.6, "Butt");
  const fold = new mupdf.Path();
  fold.moveTo(43, 5); fold.lineTo(43, 19); fold.lineTo(57, 19); fold.closePath();
  c.fill(fold, EDGE);
  const band = new mupdf.Path();
  if (size >= 48) {
    band.rect(15, 39, 57, 56);
    c.fill(band, AMBER);
    c.text("PDF", 36, 52.2, 12.5, INK, 0.6);
  } else {
    band.rect(15, 36, 57, 54); // sem texto: só a faixa, mais alta
    c.fill(band, AMBER);
  }
  return c.done();
}

// ---------- arquivo .ico ----------

/** Entrada de 256 px em PNG; as menores em bitmap de 32 bits (formato que todo programa aceita). */
function icoEntry(pix: mupdf.Pixmap): Buffer {
  const w = pix.getWidth(), h = pix.getHeight();
  if (w >= 256) return Buffer.from(pix.asPNG());
  const src = pix.getPixels(); // RGBA com cor pré-multiplicada pela transparência
  const maskRow = Math.ceil(w / 32) * 4;
  const out = Buffer.alloc(40 + w * h * 4 + maskRow * h);
  out.writeUInt32LE(40, 0); out.writeInt32LE(w, 4); out.writeInt32LE(h * 2, 8);
  out.writeUInt16LE(1, 12); out.writeUInt16LE(32, 14); out.writeUInt32LE(w * h * 4, 20);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, d = 40 + ((h - 1 - y) * w + x) * 4, a = src[s + 3];
    const un = (v: number) => (a ? Math.min(255, Math.round((v * 255) / a)) : 0);
    out[d] = un(src[s + 2]); out[d + 1] = un(src[s + 1]); out[d + 2] = un(src[s]); out[d + 3] = a;
  }
  return out;
}

function ico(draw: (size: number) => mupdf.Pixmap, sizes = [256, 128, 64, 48, 40, 32, 24, 20, 16]): Buffer {
  const entries = sizes.map((s) => ({ s, data: icoEntry(draw(s)) }));
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach((e, i) => {
    const o = 6 + i * 16;
    head[o] = e.s >= 256 ? 0 : e.s; head[o + 1] = e.s >= 256 ? 0 : e.s;
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(e.data.length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.data)]);
}

const here = import.meta.dirname;
writeFileSync(join(here, "icon.ico"), ico(appIcon));
writeFileSync(join(here, "file.ico"), ico(fileIcon));
writeFileSync(join(here, "icon.png"), appIcon(512).asPNG());
// prévias para conferir a olho (não entram no instalador)
for (const s of [256, 48, 32, 16]) {
  writeFileSync(join(here, `preview-app-${s}.png`), appIcon(s).asPNG());
  writeFileSync(join(here, `preview-file-${s}.png`), fileIcon(s).asPNG());
}
console.log("build/icon.ico, build/file.ico, build/icon.png e prévias gerados");
