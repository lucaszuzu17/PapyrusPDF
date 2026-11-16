// OCR offline com tesseract.js no Node, usando o modelo de português empacotado.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createWorker, type Worker } from "tesseract.js";
import type { OcrWord, Recognizer } from "./core.ts";

const req = createRequire(import.meta.url);

export function portugueseLangPath(): string {
  return join(dirname(req.resolve("@tesseract.js-data/por/package.json")), "4.0.0");
}

export async function createRecognizer(cachePath: string, langs = "por"): Promise<{ recognize: Recognizer; dispose: () => Promise<void> }> {
  const worker: Worker = await createWorker(langs, 1, {
    langPath: portugueseLangPath(),
    cachePath,
    gzip: true,
    // Sem isto o tesseract.js lança a falha de um trabalho fora de qualquer try/catch e derruba
    // a thread do motor; com ele, o erro volta só pela promessa rejeitada de recognize().
    errorHandler: () => {},
  });
  const recognize: Recognizer = async (png) => {
    const { data } = await worker.recognize(Buffer.from(png), {}, { blocks: true, text: false });
    const words: OcrWord[] = [];
    for (const b of data.blocks ?? []) {
      for (const p of b.paragraphs) {
        for (const l of p.lines) {
          for (const w of l.words) {
            if (w.confidence < 30) continue;
            words.push({ text: w.text, bbox: [w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1] });
          }
        }
      }
    }
    return words;
  };
  return { recognize, dispose: async () => { await worker.terminate(); } };
}
