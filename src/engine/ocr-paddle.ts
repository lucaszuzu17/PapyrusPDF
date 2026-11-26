// Motor de OCR neural 100% offline baseado em PaddleOCR (PP-OCRv4 Det + PP-OCRv5 Latin Rec + PP-LCNet DocOri)
// rodando localmente via onnxruntime-node + MuPDF (zero nuvem, zero OpenCV, Apache-2.0).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import * as ort from "onnxruntime-node";
import type { OcrWord, Recognizer } from "./core.ts";
import type { QuarterTurn } from "./ocr-prep.ts";

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
const REC_HEIGHT = 48;

export interface PaddleModelPaths {
  dir: string;
  det: string;
  rec: string;
  dict: string;
  docOri: string;
}

/** Localiza a pasta models/ocr em dev, testes no Node e build empacotado do Electron. */
export function resolvePaddleModels(explicitDir?: string): PaddleModelPaths | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicitDir,
    process.env.PAPIRO_OCR_MODELS,
    (process as { resourcesPath?: string }).resourcesPath
      ? join((process as { resourcesPath?: string }).resourcesPath!, "models", "ocr")
      : undefined,
    resolve(here, "../../models/ocr"),
    resolve(here, "../../../models/ocr"),
    resolve(process.cwd(), "models/ocr"),
  ].filter((p): p is string => !!p);

  for (const dir of candidates) {
    const det = join(dir, "det.onnx");
    const rec = join(dir, "rec_latin.onnx");
    const dict = join(dir, "dict_latin.txt");
    const docOri = join(dir, "doc_ori.onnx");
    if (existsSync(det) && existsSync(rec) && existsSync(dict)) {
      return { dir, det, rec, dict, docOri };
    }
  }
  return null;
}

export function isPaddleAvailable(explicitDir?: string): boolean {
  return resolvePaddleModels(explicitDir) !== null;
}

export interface OrientationResult {
  /** Ângulo detectado do conteúdo da página (0, 90, 180 ou 270 graus). */
  angle: QuarterTurn;
  /** Rotação horária necessária para deixar a página em pé. */
  fixCwDeg: QuarterTurn;
  confidence: number;
}

export interface PaddleEngine {
  recognize: Recognizer;
  recognizeRgb: (rgb: Uint8Array | Uint8ClampedArray, width: number, height: number, comps?: number) => Promise<OcrWord[]>;
  detectOrientation: (rgb: Uint8Array | Uint8ClampedArray, width: number, height: number, comps?: number) => Promise<OrientationResult>;
  dispose: () => Promise<void>;
}

/** Carrega as sessões ONNX locais (Det + Latin Rec + DocOri opcional) numa única instância reutilizável. */
export async function createPaddleEngine(explicitDir?: string): Promise<PaddleEngine> {
  const paths = resolvePaddleModels(explicitDir);
  if (!paths) throw new Error("Modelos ONNX do PaddleOCR (models/ocr) não encontrados.");

  const sessOpts: ort.InferenceSession.SessionOptions = {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  };
  const detSession = await ort.InferenceSession.create(paths.det, sessOpts);
  const recSession = await ort.InferenceSession.create(paths.rec, sessOpts);
  const oriSession = existsSync(paths.docOri)
    ? await ort.InferenceSession.create(paths.docOri, sessOpts)
    : null;

  // Dicionário CTC: índice 0 = blank, índices 1..N = linhas de dict_latin.txt, índice N+1 = espaço (" ")
  const rawLines = readFileSync(paths.dict, "utf8").split(/\r?\n/);
  while (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const dict: string[] = ["", ...rawLines, " "];

  const detectOrientation = async (
    rgb: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    comps = 3,
  ): Promise<OrientationResult> => {
    if (!oriSession) return { angle: 0, fixCwDeg: 0, confidence: 1 };
    const S = 224;
    const data = new Float32Array(3 * S * S);
    const plane = S * S;
    for (let y = 0; y < S; y++) {
      const sy = Math.min(height - 1, Math.floor((y * height) / S));
      for (let x = 0; x < S; x++) {
        const sx = Math.min(width - 1, Math.floor((x * width) / S));
        const idx = (sy * width + sx) * comps;
        const r = rgb[idx] / 255;
        const g = (comps >= 3 ? rgb[idx + 1] : rgb[idx]) / 255;
        const b = (comps >= 3 ? rgb[idx + 2] : rgb[idx]) / 255;
        const p = y * S + x;
        // Ordem BGR com média/desvio ImageNet (padrão PP-LCNet / PaddleX)
        data[p] = (b - DET_MEAN[2]) / DET_STD[2];
        data[plane + p] = (g - DET_MEAN[1]) / DET_STD[1];
        data[2 * plane + p] = (r - DET_MEAN[0]) / DET_STD[0];
      }
    }
    const tensor = new ort.Tensor("float32", data, [1, 3, S, S]);
    const out = await oriSession.run({ [oriSession.inputNames[0]]: tensor });
    const logits = out[oriSession.outputNames[0]].data as Float32Array;
    const probs = softmax4(logits);
    let best = 0;
    for (let i = 1; i < 4; i++) if (probs[i] > probs[best]) best = i;
    const angles: QuarterTurn[] = [0, 90, 180, 270];
    const angle = angles[best];
    // Se o documento foi rotacionado 90° CCW (ou 90° CW), fixCwDeg será validado; por convenção PaddleX:
    // label 0=0°, 1=90° (girado 90° sentido horário → girar 270° CW / 90° CCW corrige),
    // 2=180° (girar 180° corrige), 3=270° (girar 90° CW corrige).
    const fixCwDeg = ((360 - angle) % 360) as QuarterTurn;
    return { angle, fixCwDeg, confidence: probs[best] };
  };

  const recognizeRgb = async (
    rgb: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    comps = 3,
  ): Promise<OcrWord[]> => {
    if (width < 8 || height < 8) return [];
    const boxes = await detectTextBoxes(detSession, rgb, width, height, comps);
    if (!boxes.length) return [];
    return recognizeBoxes(recSession, dict, rgb, width, height, comps, boxes);
  };

  const recognize: Recognizer = async (png: Uint8Array) => {
    const img = new mupdf.Image(png);
    const pix = img.toPixmap();
    try {
      const w = pix.getWidth();
      const h = pix.getHeight();
      const comps = pix.getNumberOfComponents();
      const pixels = pix.getPixels();
      return await recognizeRgb(pixels, w, h, comps);
    } finally {
      pix.destroy();
      img.destroy();
    }
  };

  const dispose = async () => {
    await detSession.release().catch(() => {});
    await recSession.release().catch(() => {});
    if (oriSession) await oriSession.release().catch(() => {});
  };

  return { recognize, recognizeRgb, detectOrientation, dispose };
}

function softmax4(v: Float32Array): number[] {
  // Se o modelo já devolve probabilidades [0..1] somando ~1, devolve direto; senão aplica softmax
  let sum = 0, inUnit = true;
  for (let i = 0; i < 4; i++) {
    if (v[i] < 0 || v[i] > 1.001) inUnit = false;
    sum += v[i];
  }
  if (inUnit && Math.abs(sum - 1) < 0.02) return [v[0], v[1], v[2], v[3]];
  const mx = Math.max(v[0], v[1], v[2], v[3]);
  const ex = [Math.exp(v[0] - mx), Math.exp(v[1] - mx), Math.exp(v[2] - mx), Math.exp(v[3] - mx)];
  const s = ex[0] + ex[1] + ex[2] + ex[3];
  return ex.map((e) => e / s);
}

interface TextBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
}

/** Etapa 1: DBNet++ detecta todas as linhas/regiões de texto na página. */
async function detectTextBoxes(
  session: ort.InferenceSession,
  src: Uint8Array | Uint8ClampedArray,
  srcW: number,
  srcH: number,
  comps: number,
): Promise<TextBox[]> {
  // Mantém alta resolução (até 1280px no maior lado) para preservar letras pequenas (8–9 pt)
  const maxSide = 1280;
  let ratio = 1;
  if (Math.max(srcW, srcH) > maxSide) ratio = maxSide / Math.max(srcW, srcH);
  const dstW = Math.max(32, Math.round((srcW * ratio) / 32) * 32);
  const dstH = Math.max(32, Math.round((srcH * ratio) / 32) * 32);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  const data = new Float32Array(3 * dstW * dstH);
  const plane = dstW * dstH;
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, (y + 0.5) * scaleY - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = Math.max(0, sy - y0);
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, (x + 0.5) * scaleX - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = Math.max(0, sx - x0);
      const i00 = (y0 * srcW + x0) * comps;
      const i10 = (y0 * srcW + x1) * comps;
      const i01 = (y1 * srcW + x0) * comps;
      const i11 = (y1 * srcW + x1) * comps;

      let r: number, g: number, b: number;
      if (comps >= 3) {
        r = bilerp(src[i00], src[i10], src[i01], src[i11], fx, fy) / 255;
        g = bilerp(src[i00 + 1], src[i10 + 1], src[i01 + 1], src[i11 + 1], fx, fy) / 255;
        b = bilerp(src[i00 + 2], src[i10 + 2], src[i01 + 2], src[i11 + 2], fx, fy) / 255;
      } else {
        const v = bilerp(src[i00], src[i10], src[i01], src[i11], fx, fy) / 255;
        r = g = b = v;
      }
      const p = y * dstW + x;
      // PaddleOCR det usa ordem BGR com média/std ImageNet
      data[p] = (b - DET_MEAN[2]) / DET_STD[2];
      data[plane + p] = (g - DET_MEAN[1]) / DET_STD[1];
      data[2 * plane + p] = (r - DET_MEAN[0]) / DET_STD[0];
    }
  }

  const tensor = new ort.Tensor("float32", data, [1, 3, dstH, dstW]);
  const out = await session.run({ [session.inputNames[0]]: tensor });
  const prob = out[session.outputNames[0]].data as Float32Array;

  // Extrai componentes conectados acima de thresh = 0.30
  const thresh = 0.30;
  const visited = new Uint8Array(dstW * dstH);
  const queue = new Int32Array(dstW * dstH);
  const boxes: TextBox[] = [];

  for (let y = 0; y < dstH; y++) {
    const row = y * dstW;
    for (let x = 0; x < dstW; x++) {
      const start = row + x;
      if (visited[start] || prob[start] < thresh) continue;
      let head = 0, tail = 0;
      queue[tail++] = start;
      visited[start] = 1;
      let minX = x, maxX = x, minY = y, maxY = y;
      let count = 0;
      let probSum = 0;

      while (head < tail) {
        const cur = queue[head++];
        const cy = (cur / dstW) | 0;
        const cx = cur - cy * dstW;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        count++;
        probSum += prob[cur];

        // 8-vizinhança (conecta traços diagonais e letras próximas da mesma linha)
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= dstH) continue;
          const nRow = ny * dstW;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= dstW) continue;
            const ni = nRow + nx;
            if (!visited[ni] && prob[ni] >= thresh) {
              visited[ni] = 1;
              queue[tail++] = ni;
            }
          }
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (bw < 3 || bh < 3 || count < 8) continue;
      const score = probSum / count;
      if (score < 0.50) continue;

      // Expansão unclip (DBNet): o mapa prevê o miolo encolhido da linha de texto
      const area = bw * bh;
      const perim = 2 * (bw + bh);
      const unclip = (area * 1.55) / Math.max(1, perim);
      // Limita expansão vertical para não engolir linhas vizinhas e dá pequena margem lateral
      const expY = Math.min(unclip, bh * 0.55 + 2);
      const expX = Math.min(unclip * 1.15, Math.max(bh * 0.65, 5));

      const x0 = Math.max(0, Math.floor((minX - expX) * scaleX));
      const y0 = Math.max(0, Math.floor((minY - expY) * scaleY));
      const x1 = Math.min(srcW, Math.ceil((maxX + 1 + expX) * scaleX));
      const y1 = Math.min(srcH, Math.ceil((maxY + 1 + expY) * scaleY));
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      boxes.push({ x0, y0, x1, y1, score });
    }
  }

  // Ordena em ordem de leitura (linhas de cima para baixo, esquerda para direita)
  boxes.sort((a, b) => {
    const midA = (a.y0 + a.y1) / 2;
    const midB = (b.y0 + b.y1) / 2;
    const hRef = Math.min(a.y1 - a.y0, b.y1 - b.y0);
    if (Math.abs(midA - midB) < hRef * 0.55) return a.x0 - b.x0;
    return midA - midB;
  });
  return boxes;
}

/** Etapa 2: Recorta cada caixa detectada, redimensiona para altura 48 e decodifica CTC em palavras com posição exata. */
async function recognizeBoxes(
  session: ort.InferenceSession,
  dict: string[],
  src: Uint8Array | Uint8ClampedArray,
  srcW: number,
  srcH: number,
  comps: number,
  boxes: TextBox[],
): Promise<OcrWord[]> {
  // Ordena por largura alvo para minimizar padding dentro de cada lote (mantendo o índice original)
  const indexed = boxes.map((box, origIdx) => {
    const bw = Math.max(1, box.x1 - box.x0);
    const bh = Math.max(1, box.y1 - box.y0);
    const targetW = Math.max(16, Math.min(1920, Math.ceil((bw / bh) * REC_HEIGHT)));
    return { box, origIdx, targetW };
  });
  const byWidth = [...indexed].sort((a, b) => a.targetW - b.targetW);

  const perBoxWords: OcrWord[][] = new Array(boxes.length);
  const BATCH = 8;

  for (let start = 0; start < byWidth.length; start += BATCH) {
    const chunk = byWidth.slice(start, start + BATCH);
    const maxW = Math.max(32, Math.ceil(chunk[chunk.length - 1].targetW / 4) * 4);
    const B = chunk.length;
    const plane = REC_HEIGHT * maxW;
    const batchData = new Float32Array(B * 3 * plane); // preenchimento com 0.0 (= cinza médio após (px/255-0.5)/0.5)

    for (let bi = 0; bi < B; bi++) {
      const { box, targetW } = chunk[bi];
      const bw = box.x1 - box.x0;
      const bh = box.y1 - box.y0;
      const baseOff = bi * 3 * plane;

      for (let y = 0; y < REC_HEIGHT; y++) {
        const sy = box.y0 + ((y + 0.5) * bh) / REC_HEIGHT - 0.5;
        const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(sy)));
        const y1 = Math.min(srcH - 1, y0 + 1);
        const fy = Math.max(0, Math.min(1, sy - y0));
        const rowOff = y * maxW;

        for (let x = 0; x < targetW; x++) {
          const sx = box.x0 + ((x + 0.5) * bw) / targetW - 0.5;
          const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(sx)));
          const x1 = Math.min(srcW - 1, x0 + 1);
          const fx = Math.max(0, Math.min(1, sx - x0));

          const i00 = (y0 * srcW + x0) * comps;
          const i10 = (y0 * srcW + x1) * comps;
          const i01 = (y1 * srcW + x0) * comps;
          const i11 = (y1 * srcW + x1) * comps;

          let r: number, g: number, b: number;
          if (comps >= 3) {
            r = bilerp(src[i00], src[i10], src[i01], src[i11], fx, fy);
            g = bilerp(src[i00 + 1], src[i10 + 1], src[i01 + 1], src[i11 + 1], fx, fy);
            b = bilerp(src[i00 + 2], src[i10 + 2], src[i01 + 2], src[i11 + 2], fx, fy);
          } else {
            const v = bilerp(src[i00], src[i10], src[i01], src[i11], fx, fy);
            r = g = b = v;
          }
          const p = rowOff + x;
          // PaddleOCR rec normaliza para [-1, 1] em ordem BGR
          batchData[baseOff + p] = b / 127.5 - 1;
          batchData[baseOff + plane + p] = g / 127.5 - 1;
          batchData[baseOff + 2 * plane + p] = r / 127.5 - 1;
        }
      }
    }

    const tensor = new ort.Tensor("float32", batchData, [B, 3, REC_HEIGHT, maxW]);
    const out = await session.run({ [session.inputNames[0]]: tensor });
    const outTensor = out[session.outputNames[0]];
    const [outB, seqLen, numClasses] = outTensor.dims;
    const logits = outTensor.data as Float32Array;

    for (let bi = 0; bi < outB; bi++) {
      const { box, origIdx, targetW } = chunk[bi];
      const validSteps = Math.max(1, Math.min(seqLen, Math.round((targetW / maxW) * seqLen)));
      perBoxWords[origIdx] = decodeCtcToWords(logits, bi, seqLen, validSteps, numClasses, dict, box);
    }
  }

  return perBoxWords.flat();
}

/** Decodifica CTC guloso e divide a linha em palavras individuais com caixas proporcionais aos passos CTC. */
function decodeCtcToWords(
  data: Float32Array,
  batchIdx: number,
  seqLen: number,
  validSteps: number,
  numClasses: number,
  dict: string[],
  box: TextBox,
): OcrWord[] {
  const base = batchIdx * seqLen * numClasses;
  const tokens: { ch: string; step: number; prob: number }[] = [];
  let prevIdx = 0;

  for (let t = 0; t < validSteps; t++) {
    const off = base + t * numClasses;
    let bestIdx = 0;
    let bestVal = data[off];
    for (let c = 1; c < numClasses; c++) {
      const v = data[off + c];
      if (v > bestVal) { bestVal = v; bestIdx = c; }
    }
    if (bestIdx !== 0 && bestIdx !== prevIdx) {
      const ch = dict[bestIdx] ?? "";
      if (ch) tokens.push({ ch, step: t, prob: bestVal });
    }
    prevIdx = bestIdx;
  }

  if (!tokens.length) return [];

  // Agrupa caracteres consecutivos em palavras separadas por espaço, preservando coordenadas X exatas
  const words: OcrWord[] = [];
  const bw = box.x1 - box.x0;
  let cur: typeof tokens = [];

  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((x) => x.ch).join("").trim();
    if (text) {
      const conf = (cur.reduce((s, x) => s + Math.min(1, Math.max(0, x.prob)), 0) / cur.length) * 100;
      const firstStep = cur[0].step;
      const lastStep = cur[cur.length - 1].step;
      const wx0 = box.x0 + (firstStep / validSteps) * bw;
      const wx1 = box.x0 + (Math.min(validSteps, lastStep + 1.2) / validSteps) * bw;
      words.push({
        text,
        bbox: [wx0, box.y0, Math.max(wx0 + 2, wx1), box.y1],
        confidence: conf,
      });
    }
    cur = [];
  };

  for (const tok of tokens) {
    if (tok.ch === " ") flush();
    else cur.push(tok);
  }
  flush();
  return words;
}

function bilerp(v00: number, v10: number, v01: number, v11: number, fx: number, fy: number): number {
  const top = v00 + (v10 - v00) * fx;
  const bot = v01 + (v11 - v01) * fx;
  return top + (bot - top) * fy;
}
