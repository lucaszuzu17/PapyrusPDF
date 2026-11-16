// Imagens: preparo para virar página de PDF e geração dos carimbos.
import type { Stamp } from "./state.tsx";

/** Orientação EXIF de um JPEG (1 = normal; 0 se não houver). */
export function exifOrientation(b: Uint8Array): number {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 0;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 2;
  while (o + 4 <= b.length) {
    if (v.getUint8(o) !== 0xff) return 0;
    const marker = v.getUint8(o + 1);
    if (marker === 0xda || marker === 0xd9) return 0; // começaram os dados da imagem
    const len = v.getUint16(o + 2);
    if (len < 2) return 0;
    if (marker === 0xe1 && o + 10 <= b.length && v.getUint32(o + 4) === 0x45786966) { // "Exif"
      const t = o + 10; // cabeçalho TIFF
      if (t + 8 > b.length) return 0;
      const le = v.getUint16(t) === 0x4949;
      const ifd = t + v.getUint32(t + 4, le);
      if (ifd + 2 > b.length) return 0;
      const n = v.getUint16(ifd, le);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > b.length) return 0;
        if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le);
      }
      return 0;
    }
    o += 2 + len;
  }
  return 0;
}

const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;

async function viaCanvas(bytes: Uint8Array, type: "image/png" | "image/jpeg"): Promise<Uint8Array> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: "from-image" });
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext("2d")!;
  if (type === "image/jpeg") { g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, type, 0.92));
  if (!blob) throw new Error("não foi possível converter a imagem.");
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Deixa as imagens num formato que o motor entende (PNG ou JPEG), já na
 * orientação certa: fotos de celular com rotação EXIF são redesenhadas em pé,
 * e BMP/GIF/WebP viram PNG. PNG e JPEG comuns passam sem recompressão.
 */
export async function prepareImages(files: { name: string; bytes: Uint8Array }[]): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const f of files) {
    try {
      if (isPng(f.bytes)) out.push(f.bytes);
      else if (isJpeg(f.bytes)) out.push(exifOrientation(f.bytes) > 1 ? await viaCanvas(f.bytes, "image/jpeg") : f.bytes);
      else out.push(await viaCanvas(f.bytes, "image/png"));
    } catch {
      throw new Error(`“${f.name}” não é uma imagem que o PapyrusPDF consiga ler.`);
    }
  }
  return out;
}

// ---------- carimbos ----------

export const STAMP_PRESETS: { id: string; text: string; color: string }[] = [
  { id: "aprovado", text: "APROVADO", color: "#1a7f37" },
  { id: "reprovado", text: "REPROVADO", color: "#c62828" },
  { id: "revisado", text: "REVISADO", color: "#1f5fbf" },
  { id: "confidencial", text: "CONFIDENCIAL", color: "#c62828" },
  { id: "rascunho", text: "RASCUNHO", color: "#5f6b7a" },
  { id: "urgente", text: "URGENTE", color: "#d35400" },
  { id: "pago", text: "PAGO", color: "#1a7f37" },
  { id: "recebido", text: "RECEBIDO", color: "#1f5fbf" },
  { id: "copia", text: "CÓPIA", color: "#5f6b7a" },
  { id: "cancelado", text: "CANCELADO", color: "#c62828" },
];

/** Desenha um carimbo (moldura arredondada, texto em negrito e, se houver, uma segunda linha). */
export function makeStamp(text: string, color: string, sub = ""): Stamp {
  const S = 4; // pixels por ponto: nítido mesmo ampliado
  const big = 26, small = 9.5, padX = 14, padY = 8, gap = 3, border = 2.4;
  const font = (px: number, weight: number) => `${weight} ${px * S}px "Segoe UI", Arial, Helvetica, sans-serif`;
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  g.font = font(big, 800);
  const wBig = g.measureText(text).width / S;
  g.font = font(small, 600);
  const wSub = sub ? g.measureText(sub).width / S : 0;
  const width = Math.ceil(Math.max(wBig, wSub) + padX * 2);
  const height = Math.ceil(padY * 2 + big * 0.82 + (sub ? gap + small : 0));
  c.width = width * S; c.height = height * S;
  g.scale(S, S);
  g.strokeStyle = color; g.fillStyle = color; g.lineWidth = border;
  const r = 7, i = border / 2 + 0.5;
  g.beginPath();
  g.roundRect(i, i, width - 2 * i, height - 2 * i, r);
  g.globalAlpha = 0.07; g.fill();
  g.globalAlpha = 1; g.stroke();
  g.textAlign = "center"; g.textBaseline = "alphabetic";
  g.font = `800 ${big}px "Segoe UI", Arial, Helvetica, sans-serif`;
  g.fillText(text, width / 2, padY + big * 0.78);
  if (sub) {
    g.font = `600 ${small}px "Segoe UI", Arial, Helvetica, sans-serif`;
    g.fillText(sub, width / 2, padY + big * 0.82 + gap + small * 0.8);
  }
  return { png: c.toDataURL("image/png"), width, height, label: text };
}

export const dataUrlBytes = (url: string) => Uint8Array.from(atob(url.split(",")[1]), (ch) => ch.charCodeAt(0));
