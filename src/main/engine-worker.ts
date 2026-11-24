// Thread do motor: mantém os documentos abertos (um por aba) e responde às chamadas da interface.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { PdfEngine, type Recognizer } from "../engine/core.ts";
import { createRecognizer } from "../engine/ocr-node.ts";
import type { BatchAction, BatchResult } from "../engine/types.ts";
import { findSystemFont } from "./system-fonts.ts";

type Call = { id: number; doc: number; method: string; args: unknown[] };

/** Um motor por aba. A aba 0 existe desde o início (usada antes de qualquer documento abrir). */
const engines = new Map<number, PdfEngine>();
const engineFor = (doc: number) => {
  let e = engines.get(doc);
  if (!e) engines.set(doc, (e = new PdfEngine({ fonts: findSystemFont })));
  return e;
};

// Um reconhecedor por combinação de idiomas; trocar de idioma encerra o anterior (cada um ocupa centenas de MB).
let ocr: { langs: string; recognize: Recognizer; dispose: () => Promise<void> } | null = null;
async function recognizer(langs: string): Promise<Recognizer> {
  if (ocr && ocr.langs !== langs) { await ocr.dispose().catch(() => {}); ocr = null; }
  if (!ocr) ocr = { langs, ...(await createRecognizer(workerData.ocrCache as string, langs)) };
  return ocr.recognize;
}

const progress = (label: string, done: number, total: number) =>
  parentPort!.postMessage({ event: "progress", data: { label, done, total } });

/** Chamadas que precisam de mais do que o motor (OCR, arquivos, andamento). `this` é o motor da aba. */
const special: Record<string, (this: PdfEngine, ...a: any[]) => unknown> = {
  async ocrPages(pages: number[], dpi = 300, langs = "por") {
    const rec = await recognizer(langs);
    let words = 0;
    let info = this.info();
    for (let k = 0; k < pages.length; k++) {
      parentPort!.postMessage({ event: "ocr-progress", data: { page: pages[k], done: k, total: pages.length } });
      const r = await this.ocrPage(pages[k], rec, dpi);
      words += r.words;
      info = r.info;
    }
    parentPort!.postMessage({ event: "ocr-progress", data: { page: -1, done: pages.length, total: pages.length } });
    return { words, info };
  },
  scannedPages() {
    const n = this.info().pageCount;
    return Array.from({ length: n }, (_, i) => i).filter((i) => this.needsOcr(i));
  },
  /**
   * Grava cada página como PNG em `dir` (para a janela de impressão). Devolve o arquivo e o
   * tamanho real de cada folha, em polegadas e já em pé.
   */
  printFiles(dir: string, dpi: number, pages?: number[]) {
    const info = this.info();
    const list = pages ?? Array.from({ length: info.pageCount }, (_, i) => i);
    const out: { name: string; w: number; h: number }[] = [];
    list.forEach((index, k) => {
      progress("Preparando impressão", k, list.length);
      const p = info.pages[index];
      const short = Math.min(p.width, p.height) / 72, long = Math.max(p.width, p.height) / 72;
      // no máximo ~3500 px no lado maior: uma prancha A0 não precisa de 9000 px para sair numa folha A4/A3
      const eff = Math.min(dpi, 3500 / long);
      const name = `p${String(k + 1).padStart(5, "0")}.png`;
      writeFileSync(join(dir, name), this.printImage(index, eff));
      out.push({ name, w: short, h: long });
    });
    progress("Preparando impressão", list.length, list.length);
    return out;
  },
  /** Grava páginas como imagens em `dir`. Devolve os caminhos gravados. */
  exportImages(dir: string, base: string, pages: number[], dpi: number, format: "png" | "jpg") {
    const digits = Math.max(3, String(this.info().pageCount).length);
    const out: string[] = [];
    pages.forEach((index, k) => {
      progress("Exportando imagens", k, pages.length);
      const path = join(dir, `${base}_p${String(index + 1).padStart(digits, "0")}.${format}`);
      writeFileSync(path, this.pageImage(index, dpi, format));
      out.push(path);
    });
    progress("Exportando imagens", pages.length, pages.length);
    return out;
  },
  /** Converte para Word e grava em `path`. */
  saveDocx(path: string) {
    const bytes = this.exportDocx((done, total) => progress("Convertendo para Word", done, total));
    writeFileSync(path, bytes);
    return bytes.length;
  },
  /** Converte para texto (UTF-8 com BOM, que o Bloco de Notas reconhece) e grava em `path`. */
  saveText(path: string) {
    const text = this.exportText();
    writeFileSync(path, "\ufeff" + text, "utf8");
    return text.length;
  },
  /** Extrai tabelas/dados tabulares em CSV (UTF-8 com BOM e `;`, compatível com Excel pt-BR). */
  saveCsv(path: string) {
    const csv = this.exportCsv();
    writeFileSync(path, "\ufeff" + csv, "utf8");
    return csv.length;
  },
  /** Executa uma ação em lote sobre vários arquivos PDF e grava os resultados em `outDir`. */
  async batchProcess(paths: string[], outDir: string, action: BatchAction): Promise<BatchResult> {
    const failed: { file: string; error: string }[] = [];
    let processed = 0;
    const rec = action.kind === "ocr" ? await recognizer(action.langs) : null;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const name = basename(p);
      progress(`Lote (${i + 1}/${paths.length}): ${name}`, i, paths.length);
      const eng = new PdfEngine({ fonts: findSystemFont });
      try {
        const bytes = new Uint8Array(readFileSync(p));
        eng.open(bytes, name.replace(/\.pdf$/i, ""));
        if (eng.needsPassword()) throw new Error("Arquivo protegido por senha.");
        let outBytes: Uint8Array;
        switch (action.kind) {
          case "compress":
            outBytes = eng.exportCompressed(action.level).bytes;
            break;
          case "watermark":
            eng.addWatermark({ text: action.text, opacity: action.opacity ?? 0.18, angle: action.angle ?? 45, color: action.color });
            outBytes = eng.save();
            break;
          case "number":
            eng.addHeaderFooter({ items: [{ pos: action.pos, text: action.fmt }] });
            outBytes = eng.save();
            break;
          case "sanitize":
            eng.sanitizeMetadata();
            outBytes = eng.save();
            break;
          case "flatten":
            eng.flatten();
            outBytes = eng.save();
            break;
          case "ocr": {
            const total = eng.info().pageCount;
            for (let pg = 0; pg < total; pg++) {
              if (eng.needsOcr(pg)) await eng.ocrPage(pg, rec!, 300);
            }
            outBytes = eng.save();
            break;
          }
        }
        const outPath = join(outDir, name);
        writeFileSync(outPath, outBytes);
        processed++;
      } catch (e) {
        failed.push({ file: name, error: e instanceof Error ? e.message : String(e) });
      } finally {
        eng.close();
      }
    }
    progress("Lote concluído", paths.length, paths.length);
    return { processed, failed };
  },
};

parentPort!.on("message", async ({ id, doc, method, args }: Call) => {
  try {
    // fechar uma aba libera a memória do documento dela
    if (method === "dispose") {
      engines.get(doc)?.close();
      engines.delete(doc);
      parentPort!.postMessage({ id, result: true });
      return;
    }
    const engine = engineFor(doc);
    const fn = special[method] ?? (engine as any)[method];
    if (typeof fn !== "function" || method.startsWith("_") || method === "constructor") throw new Error(`Método desconhecido: ${method}`);
    const result = await fn.apply(engine, args);
    const transfer: ArrayBuffer[] = [];
    if (result && (result as any).rgba instanceof Uint8ClampedArray) transfer.push((result as any).rgba.buffer);
    parentPort!.postMessage({ id, result }, transfer);
  } catch (e) {
    parentPort!.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
