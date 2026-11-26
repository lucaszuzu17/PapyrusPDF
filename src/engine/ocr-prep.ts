// Pré-processamento offline de imagem para OCR (Opção B):
// 1. Remoção local de sombras e iluminação desigual (mapa de fundo por dilatação em bloco + integral image);
// 2. Normalização adaptativa de contraste (tinta 0,1% vs moda do papel);
// 3. Rotações exatas 90°/180°/270° (sem borramento) para auto-orientação;
// 4. Endireitamento fino (deskew ±6°) via variância de perfil de projeção horizontal.
import * as mupdf from "mupdf";
import type { Rect } from "./types.ts";

export type QuarterTurn = 0 | 90 | 180 | 270;

export interface OcrPrepResult {
  png: Uint8Array;
  gray: Uint8Array;
  width: number;
  height: number;
  deskewDeg: number;
  enhanced: boolean;
  shadowRemoved: boolean;
}

/**
 * Limpa uma página renderizada em RGB antes de enviar ao motor de OCR:
 * 1. Converte para escala de cinza;
 * 2. Estima o mapa de iluminação local (fundo do papel) e corrige sombras/gradientes desiguais;
 * 3. Aplica normalização adaptativa de contraste quando há baixo contraste ou papel escurecido;
 * 4. Detecta inclinação fina entre -6° e +6° e endireita se |ângulo| >= 0.25°.
 */
export function preprocessPixmapForOcr(pix: mupdf.Pixmap, skipDeskew = false): OcrPrepResult {
  const w = pix.getWidth();
  const h = pix.getHeight();
  const comps = pix.getNumberOfComponents();
  const src = pix.getPixels();
  return preprocessPixelsForOcr(src, w, h, comps, skipDeskew);
}

/** Versão sobre buffers brutos (RGB ou Gray), reutilizada após auto-orientação 90°/180°/270°. */
export function preprocessPixelsForOcr(
  src: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  comps: number,
  skipDeskew = false,
): OcrPrepResult {
  const n = w * h;

  // 1. Escala de cinza
  const gray = new Uint8Array(n);
  if (comps >= 3) {
    for (let i = 0, p = 0; i < n; i++, p += comps) {
      gray[i] = (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;
    }
  } else {
    for (let i = 0, p = 0; i < n; i++, p += comps) gray[i] = src[p];
  }

  // 2. Remoção de sombras / iluminação desigual (divisão pelo mapa de fundo local)
  let shadowRemoved = false;
  let work: Uint8Array = gray;
  const bgFixed = removeUnevenIllumination(gray, w, h);
  if (bgFixed) {
    work = bgFixed;
    shadowRemoved = true;
  }

  // 3. Histograma e normalização adaptativa de contraste
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[work[i]]++;

  // Percentil 0,1% (tinta real — páginas com pouco texto têm <1% de tinta) e moda do papel (fundo)
  const lowTarget = Math.max(1, Math.floor(n * 0.001));
  let acc = 0, pLow = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= lowTarget) { pLow = v; break; }
  }
  let paperPeak = 255, paperCount = 0;
  for (let v = 140; v <= 250; v++) {
    if (hist[v] > paperCount) { paperCount = hist[v]; paperPeak = v; }
  }
  const pHigh = paperCount > n * 0.15 ? paperPeak : 255;

  let enhanced = shadowRemoved;
  if (pHigh - pLow > 18 && (pLow > 18 || pHigh < 242)) {
    enhanced = true;
    const out = new Uint8Array(n);
    const hi = Math.max(pLow + 18, pHigh - 6);
    const span = Math.max(1, hi - pLow);
    for (let i = 0; i < n; i++) {
      let v = ((work[i] - pLow) * 255) / span;
      if (v < 0) v = 0;
      else if (v > 255) v = 255;
      const t = v / 255;
      const curved = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
      out[i] = Math.round((v * 0.65) + (curved * 255 * 0.35));
    }
    work = out;
  }

  // 4. Detecção de inclinação fina (deskew ±6°) por variância da projeção horizontal
  const deskewDeg = skipDeskew ? 0 : detectSkewAngle(work, w, h);
  if (Math.abs(deskewDeg) >= 0.25) {
    work = rotateGrayBilinear(work, w, h, -deskewDeg);
  }

  // Empacota de volta num Pixmap Gray do MuPDF → PNG
  const outPix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, w, h], false);
  outPix.getPixels().set(work);
  const png = new Uint8Array(outPix.asPNG());
  outPix.destroy();
  return { png, gray: work, width: w, height: h, deskewDeg, enhanced, shadowRemoved };
}

/**
 * Estima o brilho local do papel ignorando traços de tinta (máximo por bloco 8×8 + suavização
 * por imagem integral em janela ~6% da página). Se houver gradiente forte de sombra
 * (diferença >= 28 entre regiões de papel), divide a imagem pelo mapa de fundo.
 */
function removeUnevenIllumination(gray: Uint8Array, w: number, h: number): Uint8Array | null {
  if (w < 120 || h < 120) return null;
  const cell = Math.max(8, Math.min(16, Math.round(Math.min(w, h) / 160)));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  if (gw < 12 || gh < 12) return null;

  // 1. Dilatação por bloco: pega o 2º maior valor (ou máximo) em cada bloco cell×cell para pular tinta
  const coarse = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = gy * cell;
    const y1 = Math.min(h, y0 + cell);
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gx * cell;
      const x1 = Math.min(w, x0 + cell);
      let max1 = 0, max2 = 0;
      for (let y = y0; y < y1; y += 2) {
        const row = y * w;
        for (let x = x0; x < x1; x += 2) {
          const v = gray[row + x];
          if (v >= max1) { max2 = max1; max1 = v; }
          else if (v > max2) { max2 = v; }
        }
      }
      coarse[gy * gw + gx] = max2 || max1;
    }
  }

  // 2. Imagem integral 2D na grade reduzida para suavizar com raio grande (~8% da largura)
  const iw = gw + 1;
  const integral = new Float64Array(iw * (gh + 1));
  for (let y = 0; y < gh; y++) {
    let rowSum = 0;
    const iRow = (y + 1) * iw;
    const prevRow = y * iw;
    const cRow = y * gw;
    for (let x = 0; x < gw; x++) {
      rowSum += coarse[cRow + x];
      integral[iRow + x + 1] = integral[prevRow + x + 1] + rowSum;
    }
  }

  const rad = Math.max(4, Math.min(18, Math.round(Math.max(gw, gh) * 0.06)));
  const bg = new Float32Array(gw * gh);
  let bgMin = 255, bgMax = 0;
  // Avalia variação ignorando a borda extrema (2 células) para não disparar por margem preta fina
  const pad = Math.min(2, Math.floor(Math.min(gw, gh) / 6));
  for (let y = 0; y < gh; y++) {
    const ya = Math.max(0, y - rad);
    const yb = Math.min(gh, y + rad + 1);
    for (let x = 0; x < gw; x++) {
      const xa = Math.max(0, x - rad);
      const xb = Math.min(gw, x + rad + 1);
      const sum = integral[yb * iw + xb] - integral[ya * iw + xb] - integral[yb * iw + xa] + integral[ya * iw + xa];
      const mean = sum / ((xb - xa) * (yb - ya));
      bg[y * gw + x] = mean;
      if (x >= pad && x < gw - pad && y >= pad && y < gh - pad) {
        if (mean < bgMin) bgMin = mean;
        if (mean > bgMax) bgMax = mean;
      }
    }
  }

  // Sem gradiente relevante de sombra (página já tem iluminação uniforme): não altera
  if (bgMax - bgMin < 24 || bgMin < 30) return null;

  // 3. Divide cada pixel pelo fundo interpolado bilinearmente → papel uniforme em ~248
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / cell - 0.5;
    const y0 = Math.max(0, Math.min(gh - 1, Math.floor(fy)));
    const y1 = Math.min(gh - 1, y0 + 1);
    const ty = Math.max(0, Math.min(1, fy - y0));
    const row = y * w;
    const bgR0 = y0 * gw;
    const bgR1 = y1 * gw;
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / cell - 0.5;
      const x0 = Math.max(0, Math.min(gw - 1, Math.floor(fx)));
      const x1 = Math.min(gw - 1, x0 + 1);
      const tx = Math.max(0, Math.min(1, fx - x0));
      const b0 = bg[bgR0 + x0] + (bg[bgR0 + x1] - bg[bgR0 + x0]) * tx;
      const b1 = bg[bgR1 + x0] + (bg[bgR1 + x1] - bg[bgR1 + x0]) * tx;
      const localBg = Math.max(36, b0 + (b1 - b0) * ty);
      const v = (gray[row + x] * 248) / localBg;
      out[row + x] = v >= 255 ? 255 : v <= 0 ? 0 : Math.round(v);
    }
  }
  return out;
}

/** Rotação exata em múltiplos de 90° (horário) sobre buffer RGB ou Gray (sem interpolação). */
export function rotatePixels90(
  src: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  comps: number,
  cwDeg: QuarterTurn,
): { pixels: Uint8Array; width: number; height: number } {
  if (cwDeg === 0) {
    return { pixels: new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice(), width: w, height: h };
  }
  const outW = cwDeg === 180 ? w : h;
  const outH = cwDeg === 180 ? h : w;
  const out = new Uint8Array(outW * outH * comps);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number, ny: number;
      if (cwDeg === 90) { nx = h - 1 - y; ny = x; }
      else if (cwDeg === 180) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      const si = (y * w + x) * comps;
      const di = (ny * outW + nx) * comps;
      for (let c = 0; c < comps; c++) out[di + c] = src[si + c];
    }
  }
  return { pixels: out, width: outW, height: outH };
}

function detectSkewAngle(gray: Uint8Array, w: number, h: number): number {
  const step = Math.max(2, Math.floor(Math.max(w, h) / 480));
  const sw = Math.floor(w / step);
  const sh = Math.floor(h / step);
  if (sw < 40 || sh < 40) return 0;

  // Coleta blocos escuros (mínimo por célula step×step preserva traços finos de texto em 300 dpi)
  const ptsX: number[] = [];
  const ptsY: number[] = [];
  const cx = sw / 2, cy = sh / 2;
  for (let by = 0; by < sh; by++) {
    const y0 = by * step;
    for (let bx = 0; bx < sw; bx++) {
      const x0 = bx * step;
      let dark = false;
      for (let dy = 0; dy < step && !dark; dy += 2) {
        const row = (y0 + dy) * w + x0;
        for (let dx = 0; dx < step; dx += 2) {
          if (gray[row + dx] < 175) { dark = true; break; }
        }
      }
      if (dark) {
        ptsX.push(bx - cx);
        ptsY.push(by - cy);
      }
    }
  }
  if (ptsX.length < 60) return 0;

  const scoreAngle = (deg: number): number => {
    const rad = (deg * Math.PI) / 180;
    const sin = Math.sin(rad), cos = Math.cos(rad);
    const bins = new Int32Array(sh + 4);
    for (let i = 0; i < ptsX.length; i++) {
      const ry = Math.round(ptsX[i] * sin + ptsY[i] * cos + cy);
      if (ry >= 0 && ry < sh) bins[ry]++;
    }
    let sumSq = 0;
    for (let y = 0; y < sh; y++) sumSq += bins[y] * bins[y];
    return sumSq;
  };

  let bestDeg = 0;
  let bestScore = scoreAngle(0);
  for (let deg = -6; deg <= 6; deg += 0.5) {
    if (deg === 0) continue;
    const sc = scoreAngle(deg);
    if (sc > bestScore) { bestScore = sc; bestDeg = deg; }
  }
  const coarse = bestDeg;
  for (let deg = coarse - 0.6; deg <= coarse + 0.601; deg += 0.1) {
    const d = Math.round(deg * 10) / 10;
    const sc = scoreAngle(d);
    if (sc > bestScore) { bestScore = sc; bestDeg = d; }
  }
  const zeroScore = scoreAngle(0);
  if (bestScore < zeroScore * 1.02) return 0;
  return -bestDeg;
}

function rotateGrayBilinear(gray: Uint8Array, w: number, h: number, deg: number): Uint8Array {
  const out = new Uint8Array(w * h);
  out.fill(255);
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const sx = dx * cos + dy * sin + cx;
      const sy = -dx * sin + dy * cos + cy;
      const ix = Math.floor(sx), iy = Math.floor(sy);
      if (ix < 0 || iy < 0 || ix >= w - 1 || iy >= h - 1) continue;
      const fx = sx - ix, fy = sy - iy;
      const idx = iy * w + ix;
      const v00 = gray[idx], v10 = gray[idx + 1];
      const v01 = gray[idx + w], v11 = gray[idx + w + 1];
      const top = v00 + (v10 - v00) * fx;
      const bot = v01 + (v11 - v01) * fx;
      out[row + x] = Math.round(top + (bot - top) * fy);
    }
  }
  return out;
}

/** Mapeia a caixa de uma palavra reconhecida na imagem endireitada de volta para as coordenadas originais. */
export function unrotateOcrBox(bbox: Rect, width: number, height: number, deskewDeg: number): Rect {
  if (Math.abs(deskewDeg) < 0.25) return bbox;
  const rad = (deskewDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = width / 2, cy = height / 2;
  const corners: [number, number][] = [
    [bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]],
  ];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of corners) {
    const dx = px - cx, dy = py - cy;
    const ox = dx * cos - dy * sin + cx;
    const oy = dx * sin + dy * cos + cy;
    if (ox < x0) x0 = ox;
    if (ox > x1) x1 = ox;
    if (oy < y0) y0 = oy;
    if (oy > y1) y1 = oy;
  }
  return [x0, y0, x1, y1];
}
