// OCR offline no Node: PaddleOCR neural (PP-OCRv4/v5 ONNX + auto-orientação) como padrão,
// com Tesseract 4.0 (best / fast) empacotado como alternativa e fallback.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createWorker, type Worker } from "tesseract.js";
import type { OcrWord, Recognizer } from "./core.ts";
import { createPaddleEngine, isPaddleAvailable } from "./ocr-paddle.ts";

const req = createRequire(import.meta.url);

/** Idiomas de OCR que acompanham o programa (código do Tesseract → nome). */
export const OCR_LANGUAGES = { por: "Português", eng: "Inglês", spa: "Espanhol" } as const;
export type OcrLang = keyof typeof OCR_LANGUAGES;
export type OcrQuality = "neural" | "best" | "fast";

/** Arquivo do modelo de um idioma dentro do pacote @tesseract.js-data/<idioma>. */
export function modelPath(lang: OcrLang, quality: "best" | "fast" = "best"): string {
  const pkgDir = dirname(req.resolve(`@tesseract.js-data/${lang}/package.json`));
  const best = join(pkgDir, "4.0.0_best_int", `${lang}.traineddata.gz`);
  if (quality === "best" && existsSync(best)) return best;
  return join(pkgDir, "4.0.0", `${lang}.traineddata.gz`);
}

/** "por+eng" → ["por", "eng"], recusando idiomas que não vêm com o programa. */
export function parseLangs(langs: string): OcrLang[] {
  const list = langs.split("+").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error("Nenhum idioma de OCR escolhido.");
  for (const l of list) if (!(l in OCR_LANGUAGES)) throw new Error(`Idioma de OCR não disponível: ${l}`);
  return list as OcrLang[];
}

export async function createRecognizer(
  cachePath: string,
  langs = "por",
  quality: OcrQuality = "neural",
): Promise<{ recognize: Recognizer; engineKind: "paddle" | "tesseract"; dispose: () => Promise<void> }> {
  const list = parseLangs(langs);

  // Modo padrão "neural": PaddleOCR PP-OCRv4 Det + PP-OCRv5 Latin Rec (PT/EN/ES simultâneo) + DocOri 0°/90°/180°/270°
  if (quality === "neural" && isPaddleAvailable()) {
    const paddle = await createPaddleEngine();
    const recognize: Recognizer = Object.assign(
      (png: Uint8Array) => paddle.recognize(png),
      {
        recognizeRgb: paddle.recognizeRgb,
        detectOrientation: paddle.detectOrientation,
      },
    );
    return { recognize, engineKind: "paddle", dispose: paddle.dispose };
  }

  // Tesseract ("best" ou "fast", ou fallback automático se os arquivos ONNX não estiverem presentes)
  const tessQuality: "best" | "fast" = quality === "fast" ? "fast" : "best";
  const dir = join(cachePath, tessQuality);
  mkdirSync(dir, { recursive: true });
  for (const l of list) {
    const target = join(dir, `${l}.traineddata`);
    if (!existsSync(target)) copyFileSync(modelPath(l, tessQuality), target);
  }
  const worker: Worker = await createWorker(list.join("+"), 1, {
    langPath: dirname(modelPath(list[0], tessQuality)),
    cachePath: dir,
    gzip: true,
    errorHandler: () => {},
  });
  await worker.setParameters({
    user_defined_dpi: "300",
    preserve_interword_spaces: "1",
  });
  const recognize: Recognizer = async (png) => {
    const { data } = await worker.recognize(Buffer.from(png), {}, { blocks: true, text: false });
    const words: OcrWord[] = [];
    for (const b of data.blocks ?? []) {
      for (const p of b.paragraphs) {
        for (const l of p.lines) {
          for (const w of l.words) {
            if (!w.text.trim()) continue;
            const symbols = (w.symbols ?? []).map((s) => ({
              text: s.text,
              bbox: [s.bbox.x0, s.bbox.y0, s.bbox.x1, s.bbox.y1] as [number, number, number, number],
              confidence: s.confidence,
            }));
            words.push({
              text: w.text,
              bbox: [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1],
              confidence: w.confidence,
              symbols,
            });
          }
        }
      }
    }
    return words;
  };
  return { recognize, engineKind: "tesseract", dispose: async () => { await worker.terminate(); } };
}
