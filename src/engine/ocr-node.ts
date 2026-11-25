// OCR offline com tesseract.js no Node, usando os modelos de idioma empacotados com o programa.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createWorker, type Worker } from "tesseract.js";
import type { OcrWord, Recognizer } from "./core.ts";

const req = createRequire(import.meta.url);

/** Idiomas de OCR que acompanham o programa (código do Tesseract → nome). */
export const OCR_LANGUAGES = { por: "Português", eng: "Inglês", spa: "Espanhol" } as const;
export type OcrLang = keyof typeof OCR_LANGUAGES;

/** Arquivo do modelo de um idioma dentro do pacote @tesseract.js-data/<idioma>. */
export function modelPath(lang: OcrLang): string {
  return join(dirname(req.resolve(`@tesseract.js-data/${lang}/package.json`)), "4.0.0", `${lang}.traineddata.gz`);
}

/** "por+eng" → ["por", "eng"], recusando idiomas que não vêm com o programa. */
export function parseLangs(langs: string): OcrLang[] {
  const list = langs.split("+").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error("Nenhum idioma de OCR escolhido.");
  for (const l of list) if (!(l in OCR_LANGUAGES)) throw new Error(`Idioma de OCR não disponível: ${l}`);
  return list as OcrLang[];
}

export async function createRecognizer(cachePath: string, langs = "por"): Promise<{ recognize: Recognizer; dispose: () => Promise<void> }> {
  const list = parseLangs(langs);
  // O tesseract.js procura primeiro o modelo na pasta de cache, e só depois em `langPath`
  // (que aceita uma pasta só). Cada idioma está num pacote diferente: os modelos são copiados
  // para o cache, onde ele os encontra sem rede. Ele aceita o arquivo ainda compactado.
  mkdirSync(cachePath, { recursive: true });
  for (const l of list) {
    const target = join(cachePath, `${l}.traineddata`);
    if (!existsSync(target)) copyFileSync(modelPath(l), target);
  }
  const worker: Worker = await createWorker(list.join("+"), 1, {
    langPath: dirname(modelPath(list[0])),
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
  return { recognize, dispose: async () => { await worker.terminate(); } };
}
