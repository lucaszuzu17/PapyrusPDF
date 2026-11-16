// Acesso tipado ao motor (que roda numa thread do processo principal).
import type {
  AnnotInfo, DocInfo, EditTextRequest, FieldInfo, NewAnnot, SearchHit, TextBlock,
} from "../../engine/types.ts";

import type { HeaderFooterSpec, ImagePageOptions, ProtectOptions, WatermarkSpec } from "../../engine/core.ts";

export type * from "../../engine/types.ts";
export type { HeaderFooterSpec, ImagePageOptions, MarginPos, ProtectOptions, WatermarkSpec } from "../../engine/core.ts";

const call = <T,>(method: string, ...args: unknown[]) => window.papiro.engine<T>(method, ...args);

export const engine = {
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
  editText: (req: EditTextRequest) => call<DocInfo>("editText", req),
  scannedPages: () => call<number[]>("scannedPages"),
  ocrPages: (pages: number[], dpi = 300) => call<{ words: number; info: DocInfo }>("ocrPages", pages, dpi),
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
};
