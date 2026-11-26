// Desenha os ícones em vetor com o próprio MuPDF: node build/make-icon.ts
//   build/icon.ico  programa (bloco escuro, monograma "P" dobrado em creme e âmbar)
//   build/file.ico  arquivo .pdf (folha creme com etiqueta lateral âmbar "PDF" e monograma "P")
//   build/icon.png  512 px, para referência, README e Electron em desenvolvimento
// Nos tamanhos pequenos (até 24 px) os detalhes simplificam e os traços engrossam para manter legibilidade.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mupdf } from "../src/engine/core.ts";

const INK = "#2a2620";
const AMBER = "#e0a24f";
const AMBER_MID = "#c48433";
const AMBER_DARK = "#8f5b1c";
const CREAM = "#f3e3c8";
const CREAM_SHADE = "#dfd0b4";
const EDGE = "#5a5145";

const K = 0.5523; // constante da curva de Bézier que aproxima um quarto de círculo
const rgb = (h: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

type DrawCanvas = ReturnType<typeof canvas>;

/** Tela de desenho numa grade de 72 unidades, renderizada em `size` pixels. */
function canvas(size: number) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, size, size], true);
  pix.clear(); // sem argumento = totalmente transparente (clear(0) deixaria preto opaco)
  const m = mupdf.Matrix.scale(size / 72, size / 72);
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const bold = new mupdf.Font("Helvetica-Bold");
  return {
    pix,
    fill: (p: mupdf.Path, c: string, alpha = 1) =>
      dev.fillPath(p, false, m, mupdf.ColorSpace.DeviceRGB, rgb(c), alpha),
    stroke: (
      p: mupdf.Path,
      c: string,
      w: number,
      cap: "Round" | "Butt" = "Round",
      join: "Round" | "Miter" = "Round",
    ) =>
      dev.strokePath(
        p,
        new mupdf.StrokeState({ lineCap: cap, lineJoin: join, lineWidth: w, miterLimit: 4 }),
        m,
        mupdf.ColorSpace.DeviceRGB,
        rgb(c),
        1,
      ),
    /** Texto em negrito centralizado em `cx`, com espaçamento extra entre letras. */
    text(s: string, cx: number, baseline: number, px: number, c: string, tracking = 0) {
      const adv = [...s].map((ch) => bold.advanceGlyph(bold.encodeCharacter(ch.codePointAt(0)!), 0) * px);
      let x = cx - (adv.reduce((a, b) => a + b, 0) + tracking * (s.length - 1)) / 2;
      const t = new mupdf.Text();
      [...s].forEach((ch, i) => {
        t.showString(bold, [px, 0, 0, -px, x, baseline], ch);
        x += adv[i] + tracking;
      });
      dev.fillText(t, m, mupdf.ColorSpace.DeviceRGB, rgb(c), 1);
    },
    done: () => {
      dev.close();
      return pix;
    },
  };
}

function rounded(x: number, y: number, w: number, h: number, r: number) {
  const p = new mupdf.Path();
  const k = r * K;
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.curveTo(x + w - r + k, y, x + w, y + r - k, x + w, y + r);
  p.lineTo(x + w, y + h - r);
  p.curveTo(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h);
  p.lineTo(x + r, y + h);
  p.curveTo(x + r - k, y + h, x, y + h - r + k, x, y + h - r);
  p.lineTo(x, y + r);
  p.curveTo(x, y + r - k, x + r - k, y, x + r, y);
  p.closePath();
  return p;
}

/** Retângulo com raios individuais por canto: topo-esq, topo-dir, baixo-dir, baixo-esq. */
function roundedCorners(
  x: number,
  y: number,
  w: number,
  h: number,
  rtl: number,
  rtr: number,
  rbr: number,
  rbl: number,
) {
  const p = new mupdf.Path();
  p.moveTo(x + rtl, y);
  p.lineTo(x + w - rtr, y);
  if (rtr > 0) p.curveTo(x + w - rtr + rtr * K, y, x + w, y + rtr - rtr * K, x + w, y + rtr);
  p.lineTo(x + w, y + h - rbr);
  if (rbr > 0) p.curveTo(x + w, y + h - rbr + rbr * K, x + w - rbr + rbr * K, y + h, x + w - rbr, y + h);
  p.lineTo(x + rbl, y + h);
  if (rbl > 0) p.curveTo(x + rbl - rbl * K, y + h, x, y + h - rbl + rbl * K, x, y + h - rbl);
  p.lineTo(x, y + rtl);
  if (rtl > 0) p.curveTo(x, y + rtl - rtl * K, x + rtl - rtl * K, y, x + rtl, y);
  p.closePath();
  return p;
}

/**
 * Desenha o monograma "P" dobrado (fita de papel / papiro enrolado) dentro de uma caixa local 42×52,
 * posicionado em (ox, oy) com fator de escala `s`.
 * `main` = face frontal da fita (CREAM no fundo escuro; INK no fundo claro).
 */
function drawFoldedP(
  c: DrawCanvas,
  ox: number,
  oy: number,
  s: number,
  main: string,
  creaseShade: string | null,
) {
  const px = (x: number) => ox + x * s;
  const py = (y: number) => oy + y * s;
  const poly = (pts: [number, number][]) => {
    const p = new mupdf.Path();
    p.moveTo(px(pts[0][0]), py(pts[0][1]));
    for (let i = 1; i < pts.length; i++) p.lineTo(px(pts[i][0]), py(pts[i][1]));
    p.closePath();
    return p;
  };

  // 1. Face interna âmbar do rolo (curva traseira contínua do "P")
  // Contorno externo direito contínuo de (38.8, 11.4) até (39.6, 23.6) sem degrau
  const curlBack = new mupdf.Path();
  curlBack.moveTo(px(26.2), py(11.4));
  curlBack.lineTo(px(38.8), py(11.4));
  curlBack.curveTo(px(41.4), py(15.4), px(41.6), py(20.6), px(39.4), py(24.8));
  curlBack.lineTo(px(26.6), py(26.4));
  curlBack.curveTo(px(29.0), py(22.0), px(28.8), py(15.6), px(26.2), py(11.4));
  curlBack.closePath();
  c.fill(curlBack, AMBER_MID);

  // Sombra superior suave sob a aba horizontal (mesmas tangentes esquerda/direita de curlBack)
  const curlTopShade = new mupdf.Path();
  curlTopShade.moveTo(px(26.2), py(11.4));
  curlTopShade.lineTo(px(38.8), py(11.4));
  curlTopShade.curveTo(px(39.7), py(12.8), px(40.3), py(14.3), px(40.6), py(15.8));
  curlTopShade.curveTo(px(36.2), py(14.4), px(31.4), py(14.4), px(27.8), py(15.6));
  curlTopShade.curveTo(px(27.3), py(14.0), px(26.8), py(12.6), px(26.2), py(11.4));
  curlTopShade.closePath();
  c.fill(curlTopShade, AMBER_DARK);

  // Sombra inferior suave onde o rolo frontal se encaixa na curva âmbar
  const curlBotShade = new mupdf.Path();
  curlBotShade.moveTo(px(27.9), py(22.8));
  curlBotShade.curveTo(px(32.8), py(23.8), px(37.2), py(23.0), px(40.4), py(20.6));
  curlBotShade.curveTo(px(40.1), py(22.4), px(39.6), py(24.0), px(38.8), py(25.4));
  curlBotShade.lineTo(px(26.6), py(26.4));
  curlBotShade.curveTo(px(27.2), py(25.3), px(27.6), py(24.0), px(27.9), py(22.8));
  curlBotShade.closePath();
  c.fill(curlBotShade, AMBER_DARK);

  // 2. Miolo arredondado em âmbar do espiral do papiro (sem corte reto)
  const spiralCore = new mupdf.Path();
  spiralCore.moveTo(px(22.8), py(17.8));
  spiralCore.curveTo(px(19.6), py(17.8), px(18.0), py(20.4), px(19.0), py(23.2));
  spiralCore.curveTo(px(19.9), py(25.4), px(23.2), py(25.6), px(25.2), py(24.2));
  spiralCore.curveTo(px(25.9), py(23.6), px(25.9), py(22.2), px(25.4), py(20.4));
  spiralCore.curveTo(px(25.0), py(18.8), px(24.2), py(17.8), px(22.8), py(17.8));
  spiralCore.closePath();
  c.fill(spiralCore, AMBER);

  // 3. Aba frontal enrolada (base da barriga do "P" fluindo sem quina até a tangente externa)
  const curlFront = new mupdf.Path();
  curlFront.moveTo(px(23.8), py(17.8));
  curlFront.curveTo(px(19.4), py(17.8), px(15.6), py(20.6), px(15.4), py(25.8));
  curlFront.curveTo(px(15.2), py(32.0), px(20.4), py(36.4), px(27.2), py(36.0));
  curlFront.curveTo(px(34.6), py(35.6), px(40.2), py(30.4), px(40.7), py(21.4));
  curlFront.curveTo(px(38.6), py(24.8), px(34.4), py(26.4), px(28.4), py(26.4));
  curlFront.curveTo(px(24.2), py(26.4), px(21.4), py(25.2), px(21.4), py(22.4));
  curlFront.curveTo(px(21.4), py(20.4), px(22.5), py(19.2), px(23.8), py(19.2));
  curlFront.curveTo(px(24.6), py(19.2), px(24.6), py(17.8), px(23.8), py(17.8));
  curlFront.closePath();
  c.fill(curlFront, main);

  // 4. Barra superior horizontal com ombro arredondado contínuo até (38.8, 11.8)
  const topBar = new mupdf.Path();
  topBar.moveTo(px(11.8), py(0.0));
  topBar.lineTo(px(25.2), py(0.0));
  topBar.curveTo(px(30.6), py(0.0), px(35.2), py(3.8), px(39.0), py(11.8));
  topBar.lineTo(px(11.8), py(11.8));
  topBar.closePath();
  c.fill(topBar, main);

  // Vinco sutil vertical no encontro da barra superior com a dobra do topo
  if (creaseShade) {
    c.fill(
      poly([
        [11.8, 0.0],
        [14.8, 11.8],
        [11.8, 11.8],
      ]),
      creaseShade,
    );
  }

  // 5. Haste vertical principal (com chanfros 45° no topo e na base)
  c.fill(
    poly([
      [0.0, 11.8],
      [11.8, 11.8],
      [11.8, 40.2],
      [0.0, 52.0],
    ]),
    main,
  );

  // Vinco sutil sob a dobra triangular do topo-esquerdo
  if (creaseShade) {
    c.fill(
      poly([
        [0.0, 11.8],
        [11.8, 11.8],
        [11.8, 15.2],
      ]),
      creaseShade,
    );
  }

  // 6. Dobra triangular superior-esquerda em âmbar
  c.fill(
    poly([
      [0.0, 11.8],
      [11.8, 0.0],
      [11.8, 11.8],
    ]),
    AMBER,
  );

  // 7. Dobra triangular inferior-direita da haste em âmbar
  c.fill(
    poly([
      [0.0, 52.0],
      [11.8, 40.2],
      [11.8, 52.0],
    ]),
    AMBER,
  );
}

function appIcon(size: number): mupdf.Pixmap {
  const c = canvas(size);
  c.fill(rounded(0, 0, 72, 72, 16), INK);
  // Contorno sutil: garante recorte limpo em barra de tarefas escura
  c.stroke(rounded(1.1, 1.1, 69.8, 69.8, 15.0), EDGE, size <= 24 ? 2.6 : 1.9);

  if (size <= 24) {
    // Em 16–24 px, amplia o monograma para máxima leitura sem detalhes frágeis
    drawFoldedP(c, 13.5, 8.0, 1.07, CREAM, null);
  } else {
    drawFoldedP(c, 15.8, 10.0, 1.0, CREAM, CREAM_SHADE);
  }
  return c.done();
}

function fileIcon(size: number): mupdf.Pixmap {
  const c = canvas(size);
  const small = size <= 24;

  // 1. Folha vertical creme com canto superior direito dobrado (dog-ear)
  const px = 16;
  const py = 4;
  const pw = 48;
  const ph = 64;
  const fold = 15;
  const r = 4.6;
  const rk = r * K;

  const page = new mupdf.Path();
  page.moveTo(px + r, py);
  page.lineTo(px + pw - fold, py);
  page.lineTo(px + pw, py + fold);
  page.lineTo(px + pw, py + ph - r);
  page.curveTo(px + pw, py + ph - r + rk, px + pw - r + rk, py + ph, px + pw - r, py + ph);
  page.lineTo(px + r, py + ph);
  page.curveTo(px + r - rk, py + ph, px, py + ph - r + rk, px, py + ph - r);
  page.lineTo(px, py + r);
  page.curveTo(px, py + r - rk, px + r - rk, py, px + r, py);
  page.closePath();
  c.fill(page, CREAM);

  // Sombra sutil sob a dobra superior direita
  if (!small) {
    const foldShadow = new mupdf.Path();
    foldShadow.moveTo(px + pw - fold, py + fold);
    foldShadow.lineTo(px + pw, py + fold);
    foldShadow.lineTo(px + pw, py + fold + 8.5);
    foldShadow.closePath();
    c.fill(foldShadow, CREAM_SHADE);
  }

  // Dobra do canto superior direito em âmbar
  const corner = new mupdf.Path();
  const cr = 2.4;
  const crk = cr * K;
  const fx = px + pw - fold;
  const fy = py + fold;
  corner.moveTo(fx, py);
  corner.lineTo(fx, fy - cr);
  corner.curveTo(fx, fy - cr + crk, fx + cr - crk, fy, fx + cr, fy);
  corner.lineTo(px + pw, fy);
  corner.closePath();
  c.fill(corner, AMBER);

  // Contorno da folha (contraste tanto no Explorer claro quanto no escuro)
  c.stroke(page, EDGE, small ? 2.6 : 1.8, "Round", "Round");

  // 2. Monograma "P" dobrado no canto inferior direito da folha
  if (small) {
    drawFoldedP(c, 32.0, 38.0, 0.54, INK, null);
  } else {
    drawFoldedP(c, 36.2, 37.2, 0.51, INK, null);
  }

  // 3. Dobra traseira da etiqueta lateral (envoltório atrás da borda esquerda da folha)
  const tagX = small ? 5.5 : 7.0;
  const tagY = small ? 16.5 : 18.5;
  const tagW = small ? 42.0 : 38.5;
  const tagH = small ? 16.5 : 17.0;

  const wrap = new mupdf.Path();
  wrap.moveTo(tagX + 0.4, tagY + tagH);
  wrap.lineTo(px, tagY + tagH);
  wrap.lineTo(px, tagY + tagH + (small ? 5.5 : 7.0));
  wrap.closePath();
  c.fill(wrap, AMBER_DARK);

  // 4. Etiqueta lateral âmbar "PDF" projetada à esquerda
  c.fill(roundedCorners(tagX, tagY, tagW, tagH, 1.4, 2.8, 2.8, 0.6), AMBER);

  // Em tamanhos >= 32 px exibe "PDF"; nos menores (16–24 px) fica só a faixa âmbar limpa
  if (size >= 32) {
    c.text("PDF", tagX + tagW / 2 + 0.3, tagY + 12.6, 11.4, INK, 0.65);
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
