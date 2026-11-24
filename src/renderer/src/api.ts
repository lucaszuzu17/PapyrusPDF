// Acesso tipado ao motor (que roda numa thread do processo principal).
import type {
  AnnotInfo, BatchAction, BatchResult, CompareReport, CropMargins, DocInfo, EditTextRequest, EditTextResult,
  FieldInfo, NewAnnot, OutlineNode, Rect, SearchHit, TextBlock,
} from "../../engine/types.ts";

import type { HeaderFooterSpec, ImagePageOptions, ProtectOptions, WatermarkSpec } from "../../engine/core.ts";

export type * from "../../engine/types.ts";
export type { HeaderFooterSpec, ImagePageOptions, MarginPos, ProtectOptions, WatermarkSpec } from "../../engine/core.ts";

// Cada aba tem um documento próprio no motor. As chamadas vão para a aba ativa no momento em que
// são feitas: uma resposta que chega depois de trocar de aba continua sendo do documento certo.
let activeDoc = 0;
export const setEngineDoc = (id: number) => { activeDoc = id; };
export const engineDoc = () => activeDoc;
/** Libera o documento de uma aba fechada. */
export const disposeDoc = (id: number) => window.papiro.engine<boolean>(id, "dispose");

/** Métodos do motor para o documento que `doc()` indicar na hora de cada chamada. */
function engineFor(doc: () => number) {
  const call = <T,>(method: string, ...args: unknown[]) => window.papiro.engine<T>(doc(), method, ...args);
  return {
    open: (bytes: Uint8Array, name: string) => call<DocInfo>("open", bytes, name),
    needsPassword: () => call<boolean>("needsPassword"),
    unlock: (pw: string) => call<DocInfo>("unlock", pw),
    cancelOpen: () => call<void>("cancelOpen"),
    /** Abre bytes que o Papiro acabou de gravar; sem senha informada, usa a do documento atual. */
    reopen: (bytes: Uint8Array, title: string, password?: string) => call<DocInfo>("reopen", bytes, title, password),
    markModified: () => call<DocInfo>("markModified"),
    info: () => call<DocInfo>("info"),
    save: () => call<Uint8Array>("save"),
    undo: () => call<DocInfo>("undo"),
    redo: () => call<DocInfo>("redo"),
    render: (page: number, scale: number) => call<{ width: number; height: number; rgba: Uint8ClampedArray }>("render", page, scale),
    pageText: (page: number) => call<TextBlock[]>("pageText", page),
    search: (q: string) => call<SearchHit[]>("search", q),
    annotations: (page: number) => call<AnnotInfo[]>("annotations", page),
    allAnnotations: () => call<(AnnotInfo & { page: number })[]>("allAnnotations"),
    addAnnotation: (page: number, spec: NewAnnot, author = "") => call<DocInfo>("addAnnotation", page, spec, author),
    deleteAnnotation: (page: number, id: number) => call<DocInfo>("deleteAnnotation", page, id),
    setAnnotationContents: (page: number, id: number, text: string) => call<DocInfo>("setAnnotationContents", page, id, text),
    applyAllRedactions: () => call<{ pages: number; info: DocInfo }>("applyAllRedactions"),
    fields: (page: number) => call<FieldInfo[]>("fields", page),
    setField: (page: number, id: number, value: string | boolean) => call<DocInfo>("setField", page, id, value),
    rotatePages: (pages: number[], deg: number) => call<DocInfo>("rotatePages", pages, deg),
    deletePages: (pages: number[]) => call<DocInfo>("deletePages", pages),
    reorderPages: (order: number[]) => call<DocInfo>("reorderPages", order),
    insertBlankPage: (at: number) => call<DocInfo>("insertBlankPage", at),
    insertFromPdf: (bytes: Uint8Array, at: number) => call<DocInfo>("insertFromPdf", bytes, at),
    extractPages: (pages: number[]) => call<Uint8Array>("extractPages", pages),
    split: (every: number) => call<Uint8Array[]>("split", every),
    editText: (req: EditTextRequest) => call<EditTextResult>("editText", req),
    scannedPages: () => call<number[]>("scannedPages"),
    ocrPages: (pages: number[], langs = "por", dpi = 300) => call<{ words: number; info: DocInfo }>("ocrPages", pages, dpi, langs),
    setTitle: (title: string) => call<void>("setTitle", title),
    exportProtected: (opts: ProtectOptions) => call<Uint8Array>("exportProtected", opts),
    exportUnprotected: () => call<Uint8Array>("exportUnprotected"),
    exportCompressed: (level: "leve" | "media" | "forte") =>
      call<{ bytes: Uint8Array; before: number; after: number; images: number }>("exportCompressed", level),
    addHeaderFooter: (spec: HeaderFooterSpec) => call<DocInfo>("addHeaderFooter", spec),
    addWatermark: (spec: WatermarkSpec) => call<DocInfo>("addWatermark", spec),
    imagesToPdf: (images: Uint8Array[], opts: ImagePageOptions, title: string) => call<DocInfo>("imagesToPdf", images, opts, title),
    insertImages: (images: Uint8Array[], at: number, opts: ImagePageOptions) => call<DocInfo>("insertImages", images, at, opts),
    pageImage: (page: number, dpi: number, format: "png" | "jpg") => call<Uint8Array>("pageImage", page, dpi, format),
    exportImages: (dir: string, base: string, pages: number[], dpi: number, format: "png" | "jpg") =>
      call<string[]>("exportImages", dir, base, pages, dpi, format),
    saveDocx: (path: string) => call<number>("saveDocx", path),
    saveText: (path: string) => call<number>("saveText", path),
    saveCsv: (path: string) => call<number>("saveCsv", path),
    removeWatermarks: () => call<{ removed: number; pages: number; info: DocInfo }>("removeWatermarks"),
    replaceText: (needle: string, replacement: string, opts?: { page?: number; matchCase?: boolean }) =>
      call<{ count: number; pages: number; info: DocInfo }>("replaceText", needle, replacement, opts ?? {}),
    addImageToPage: (page: number, rect: Rect, bytes: Uint8Array) => call<DocInfo>("addImageToPage", page, rect, bytes),
    cropPages: (pages: number[], margins: CropMargins) => call<DocInfo>("cropPages", pages, margins),
    normalizePageSizes: (pages: number[], target: "A4" | "Carta") => call<DocInfo>("normalizePageSizes", pages, target),
    flatten: () => call<{ count: number; info: DocInfo }>("flatten"),
    sanitizeMetadata: () => call<{ removed: number; info: DocInfo }>("sanitizeMetadata"),
    setOutline: (nodes: OutlineNode[]) => call<DocInfo>("setOutline", nodes),
    comparePdf: (otherBytes: Uint8Array, otherName: string) => call<CompareReport>("comparePdf", otherBytes, otherName),
    batchProcess: (paths: string[], outDir: string, action: BatchAction) => call<BatchResult>("batchProcess", paths, outDir, action),
  };
}

/** Motor da aba ativa. */
export const engine = engineFor(() => activeDoc);
/** Motor de uma aba específica (ex.: um documento sendo aberto numa aba nova). */
export const engineAt = (id: number) => engineFor(() => id);
