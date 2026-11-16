// Thread do motor: mantém o documento aberto e responde às chamadas da interface.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { PdfEngine, type Recognizer } from "../engine/core.ts";
import { createRecognizer } from "../engine/ocr-node.ts";

type Call = { id: number; method: string; args: unknown[] };

const engine = new PdfEngine();
let ocr: { recognize: Recognizer; dispose: () => Promise<void> } | null = null;

async function recognizer(): Promise<Recognizer> {
  if (!ocr) ocr = await createRecognizer(workerData.ocrCache as string);
  return ocr.recognize;
}

const progress = (label: string, done: number, total: number) =>
  parentPort!.postMessage({ event: "progress", data: { label, done, total } });

const special: Record<string, (...a: any[]) => unknown> = {
  async ocrPages(pages: number[], dpi = 300) {
    const rec = await recognizer();
    let words = 0;
    let info = engine.info();
    for (let k = 0; k < pages.length; k++) {
      parentPort!.postMessage({ event: "ocr-progress", data: { page: pages[k], done: k, total: pages.length } });
      const r = await engine.ocrPage(pages[k], rec, dpi);
      words += r.words;
      info = r.info;
    }
    parentPort!.postMessage({ event: "ocr-progress", data: { page: -1, done: pages.length, total: pages.length } });
    return { words, info };
  },
  scannedPages() {
    const n = engine.info().pageCount;
    return Array.from({ length: n }, (_, i) => i).filter((i) => engine.needsOcr(i));
  },
  /**
   * Grava cada página como PNG em `dir` (para a janela de impressão). Devolve o arquivo e o
   * tamanho real de cada folha, em polegadas e já em pé.
   */
  printFiles(dir: string, dpi: number, pages?: number[]) {
    const info = engine.info();
    const list = pages ?? Array.from({ length: info.pageCount }, (_, i) => i);
    const out: { name: string; w: number; h: number }[] = [];
    list.forEach((index, k) => {
      progress("Preparando impressão", k, list.length);
      const p = info.pages[index];
      const short = Math.min(p.width, p.height) / 72, long = Math.max(p.width, p.height) / 72;
      // no máximo ~3500 px no lado maior: uma prancha A0 não precisa de 9000 px para sair numa folha A4/A3
      const eff = Math.min(dpi, 3500 / long);
      const name = `p${String(k + 1).padStart(5, "0")}.png`;
      writeFileSync(join(dir, name), engine.printImage(index, eff));
      out.push({ name, w: short, h: long });
    });
    progress("Preparando impressão", list.length, list.length);
    return out;
  },
  /** Grava páginas como imagens em `dir`. Devolve os caminhos gravados. */
  exportImages(dir: string, base: string, pages: number[], dpi: number, format: "png" | "jpg") {
    const digits = Math.max(3, String(engine.info().pageCount).length);
    const out: string[] = [];
    pages.forEach((index, k) => {
      progress("Exportando imagens", k, pages.length);
      const path = join(dir, `${base}_p${String(index + 1).padStart(digits, "0")}.${format}`);
      writeFileSync(path, engine.pageImage(index, dpi, format));
      out.push(path);
    });
    progress("Exportando imagens", pages.length, pages.length);
    return out;
  },
};

parentPort!.on("message", async ({ id, method, args }: Call) => {
  try {
    const fn = special[method] ?? (engine as any)[method];
    if (typeof fn !== "function" || method.startsWith("_")) throw new Error(`Método desconhecido: ${method}`);
    const result = await fn.apply(special[method] ? special : engine, args);
    const transfer: ArrayBuffer[] = [];
    if (result && (result as any).rgba instanceof Uint8ClampedArray) transfer.push((result as any).rgba.buffer);
    parentPort!.postMessage({ id, result }, transfer);
  } catch (e) {
    parentPort!.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
