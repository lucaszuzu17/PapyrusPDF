// Thread do motor: mantém os documentos abertos (um por aba) e responde às chamadas da interface.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { PdfEngine, type Recognizer } from "../engine/core.ts";
import { createRecognizer, type OcrQuality } from "../engine/ocr-node.ts";
import type { BatchAction, BatchResult, SmartRedactRequest } from "../engine/types.ts";
import { findSystemFont } from "./system-fonts.ts";

type Call = { id: number; doc: number; method: string; args: unknown[] };

/** Um motor por aba. A aba 0 existe desde o início (usada antes de qualquer documento abrir). */
const engines = new Map<number, PdfEngine>();
const engineFor = (doc: number) => {
  let e = engines.get(doc);
  if (!e) engines.set(doc, (e = new PdfEngine({ fonts: findSystemFont })));
  return e;
};

// Um reconhecedor por combinação de idiomas + motor; trocar encerra o anterior.
let ocr: { key: string; recognize: Recognizer; dispose: () => Promise<void> } | null = null;
async function recognizer(langs: string, quality: OcrQuality = "neural"): Promise<Recognizer> {
  // No modo neural (PP-OCRv5 Latin), o mesmo modelo atende PT/EN/ES sem precisar recarregar
  const key = quality === "neural" ? "latin@neural" : `${langs}@${quality}`;
  if (ocr && ocr.key !== key) { await ocr.dispose().catch(() => {}); ocr = null; }
  if (!ocr) ocr = { key, ...(await createRecognizer(workerData.ocrCache as string, langs, quality)) };
  return ocr.recognize;
}

const progress = (label: string, done: number, total: number) =>
  parentPort!.postMessage({ event: "progress", data: { label, done, total } });

const recovering = new WeakMap<PdfEngine, Promise<void>>();

/** Garante que fontes Type 3 sem /ToUnicode tenham o texto recuperado antes de extrair/buscar/exportar. */
async function ensureReadableText(eng: PdfEngine, page?: number): Promise<void> {
  const inflight = recovering.get(eng);
  if (inflight) await inflight;
  if (!eng.hasUnmappedType3(page)) return;
  const job = (async () => {
    const rec = await recognizer("por", "best");
    await eng.recoverType3(rec, page);
  })();
  recovering.set(eng, job);
  try { await job; } finally { if (recovering.get(eng) === job) recovering.delete(eng); }
}

/** Chamadas que precisam de mais do que o motor (OCR, arquivos, andamento). `this` é o motor da aba. */
const special: Record<string, (this: PdfEngine, ...a: any[]) => unknown> = {
  async pageText(index: number) {
    await ensureReadableText(this, index);
    return this.pageText(index);
  },
  async search(needle: string) {
    await ensureReadableText(this);
    return this.search(needle);
  },
  async replaceText(needle: string, replacement: string, opts?: { page?: number; matchCase?: boolean }) {
    await ensureReadableText(this, opts?.page);
    return this.replaceText(needle, replacement, opts);
  },
  async redactByPatterns(req: SmartRedactRequest) {
    await ensureReadableText(this);
    return this.redactByPatterns(req);
  },
  async autoOutline() {
    await ensureReadableText(this);
    return this.autoOutline();
  },
  async commentsSummary() {
    await ensureReadableText(this);
    return this.commentsSummary();
  },
  async saveCommentsSummary(path: string, format: "md" | "csv" | "pdf") {
    await ensureReadableText(this);
    const bytes = this.exportCommentsSummary(format);
    writeFileSync(path, bytes);
    return bytes.length;
  },
  async autoDetectFields(page: number) {
    await ensureReadableText(this, page);
    return this.autoDetectFields(page);
  },
  async ocrPages(pages: number[], dpi = 300, langs = "por", quality: OcrQuality = "neural", cleanup = true) {
    const rec = await recognizer(langs, quality);
    let words = 0;
    let deskewed = 0;
    let enhanced = 0;
    let oriented = 0;
    let info = this.info();
    for (let k = 0; k < pages.length; k++) {
      parentPort!.postMessage({ event: "ocr-progress", data: { page: pages[k], done: k, total: pages.length } });
      const r = await this.ocrPage(pages[k], rec, dpi, cleanup);
      words += r.words;
      if (Math.abs(r.deskewDeg) >= 0.25) deskewed++;
      if (r.enhanced) enhanced++;
      if (r.orientedDeg !== 0) oriented++;
      info = r.info;
    }
    parentPort!.postMessage({ event: "ocr-progress", data: { page: -1, done: pages.length, total: pages.length } });
    return { words, deskewed, enhanced, oriented, info };
  },
  scannedPages() {
    const n = this.info().pageCount;
    return Array.from({ length: n }, (_, i) => i).filter((i) => this.needsOcr(i));
  },
  /**
   * Prepara cada página para impressão: prefere SVG vetorial nítido (texto e linhas sem pixelização)
   * e recorre a PNG em alta resolução para páginas rasterizadas muito pesadas ou quando `forceImage` está ativo.
   */
  printFiles(
    dir: string,
    dpi: number,
    pages?: number[],
    opts?: { forceImage?: boolean; autoRotate?: boolean; includeAnnots?: boolean; grayscale?: boolean },
  ) {
    const info = this.info();
    const list = pages ?? Array.from({ length: info.pageCount }, (_, i) => i);
    const autoRotate = opts?.autoRotate ?? true;
    const includeAnnots = opts?.includeAnnots ?? true;
    const forceImage = !!opts?.forceImage;
    const grayscale = !!opts?.grayscale;
    const out: { name: string; w: number; h: number; wMm: number; hMm: number; pageIndex: number; vector: boolean }[] = [];
    list.forEach((index, k) => {
      progress("Preparando impressão", k, list.length);
      const p = info.pages[index];
      const rotate = autoRotate && p.width > p.height;
      const effWpt = rotate ? p.height : p.width;
      const effHpt = rotate ? p.width : p.height;
      const wIn = effWpt / 72;
      const hIn = effHpt / 72;
      const svg = forceImage ? null : this.printSvg(index, 8_000_000, { autoRotate, includeAnnots });
      if (svg) {
        const name = `p${String(k + 1).padStart(5, "0")}.svg`;
        writeFileSync(join(dir, name), svg, "utf8");
        out.push({ name, w: wIn, h: hIn, wMm: (effWpt * 25.4) / 72, hMm: (effHpt * 25.4) / 72, pageIndex: index, vector: true });
      } else {
        const longIn = Math.max(wIn, hIn);
        const eff = Math.min(dpi, 3500 / Math.max(1, longIn));
        const name = `p${String(k + 1).padStart(5, "0")}.png`;
        writeFileSync(join(dir, name), this.printImage(index, eff, { autoRotate, includeAnnots, grayscale }));
        out.push({ name, w: wIn, h: hIn, wMm: (effWpt * 25.4) / 72, hMm: (effHpt * 25.4) / 72, pageIndex: index, vector: false });
      }
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
  async saveDocx(path: string) {
    await ensureReadableText(this);
    const bytes = this.exportDocx((done, total) => progress("Convertendo para Word", done, total));
    writeFileSync(path, bytes);
    return bytes.length;
  },
  /** Converte para texto (UTF-8 com BOM, que o Bloco de Notas reconhece) e grava em `path`. */
  async saveText(path: string) {
    await ensureReadableText(this);
    const text = this.exportText();
    writeFileSync(path, "\ufeff" + text, "utf8");
    return text.length;
  },
  /** Extrai tabelas/dados tabulares em CSV (UTF-8 com BOM e `;`, compatível com Excel pt-BR). */
  async saveCsv(path: string) {
    await ensureReadableText(this);
    const csv = this.exportCsv();
    writeFileSync(path, "\ufeff" + csv, "utf8");
    return csv.length;
  },
  /** Executa uma ação ou pipeline de ações em lote sobre vários arquivos PDF e grava os resultados em `outDir`. */
  async batchProcess(paths: string[], outDir: string, actionOrActions: BatchAction | BatchAction[]): Promise<BatchResult> {
    const actions = Array.isArray(actionOrActions) ? actionOrActions : [actionOrActions];
    if (!actions.length) return { processed: 0, failed: [] };
    const failed: { file: string; error: string }[] = [];
    let processed = 0;
    const ocrAction = actions.find((a): a is Extract<BatchAction, { kind: "ocr" }> => a.kind === "ocr");
    const rec = ocrAction ? await recognizer(ocrAction.langs) : null;
    const batesCounters = new Map<number, number>();
    let batesEnd: number | undefined;

    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const name = basename(p);
      progress(`Lote (${i + 1}/${paths.length}): ${name}`, i, paths.length);
      const eng = new PdfEngine({ fonts: findSystemFont });
      try {
        const bytes = new Uint8Array(readFileSync(p));
        eng.open(bytes, name.replace(/\.pdf$/i, ""));
        if (eng.needsPassword()) throw new Error("Arquivo protegido por senha.");
        let compressOpt: Extract<BatchAction, { kind: "compress" }> | null = null;
        for (let stepIdx = 0; stepIdx < actions.length; stepIdx++) {
          const action = actions[stepIdx];
          switch (action.kind) {
            case "ocr": {
              const total = eng.info().pageCount;
              for (let pg = 0; pg < total; pg++) {
                if (eng.needsOcr(pg)) await eng.ocrPage(pg, rec!, 300);
              }
              break;
            }
            case "normalize": {
              const total = eng.info().pageCount;
              eng.normalizePageSizes(Array.from({ length: total }, (_, k) => k), action.target);
              break;
            }
            case "redactPatterns": {
              const r = eng.redactByPatterns({
                patterns: action.patterns,
                customQuery: action.customQuery,
                isRegex: action.isRegex,
                overlayText: action.overlayText,
              });
              if (r.marked > 0) eng.applyAllRedactions();
              break;
            }
            case "sanitize":
              eng.sanitizeMetadata();
              break;
            case "flatten":
              eng.flatten();
              break;
            case "watermark":
              eng.addWatermark({ text: action.text, opacity: action.opacity ?? 0.18, angle: action.angle ?? 45, color: action.color });
              break;
            case "number":
              eng.addHeaderFooter({ items: [{ pos: action.pos, text: action.fmt }] });
              break;
            case "bates": {
              const start = action.continuous !== false
                ? (batesCounters.get(stepIdx) ?? action.startNumber)
                : action.startNumber;
              const res = eng.addBatesNumbering({
                prefix: action.prefix,
                suffix: action.suffix,
                startNumber: start,
                digits: action.digits,
                pos: action.pos,
                size: action.size,
              });
              if (action.continuous !== false) {
                batesCounters.set(stepIdx, res.nextNumber);
                batesEnd = res.nextNumber - 1;
              }
              break;
            }
            case "compress":
              compressOpt = action;
              break;
          }
        }
        const outBytes = compressOpt
          ? (compressOpt.optimize ? eng.exportOptimized(compressOpt.optimize).bytes : eng.exportCompressed(compressOpt.level).bytes)
          : eng.save();
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
    return { processed, failed, ...(batesEnd !== undefined ? { batesEnd } : {}) };
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
