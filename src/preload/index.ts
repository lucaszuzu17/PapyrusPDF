import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { PrinterInfo, PrintJobOptions } from "../shared/print-types.ts";

export interface FileData { path: string; name: string; bytes: Uint8Array }
export interface Recent { path: string; name: string; page: number; when: number }
export interface Progress { label: string; done: number; total: number }
export interface RecoveryMeta { id: string; name: string; origPath: string | null; savedAt: number }
export type { PrinterInfo, PrintJobOptions };

const on = <T,>(channel: string, cb: (v: T) => void) => {
  const h = (_: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => { ipcRenderer.removeListener(channel, h); };
};

const api = {
  /** Chamada ao motor do documento `doc` (cada aba tem o seu). */
  engine: <T = any>(doc: number, method: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke("engine", doc, method, args),
  openDialog: (opts?: { title?: string; images?: boolean; multi?: boolean; anyFile?: boolean; pfx?: boolean; webDoc?: boolean }): Promise<FileData[]> =>
    ipcRenderer.invoke("open-dialog", opts ?? {}),
  readFile: (path: string): Promise<FileData> => ipcRenderer.invoke("read-file", path),
  saveDialog: (suggested: string, kind: "pdf" | "png" | "jpg" | "docx" | "txt" | "csv" | "md" | "any" = "pdf"): Promise<string | null> =>
    ipcRenderer.invoke("save-dialog", suggested, kind),
  folderDialog: (): Promise<string | null> => ipcRenderer.invoke("folder-dialog"),
  writeFile: (path: string, bytes: Uint8Array): Promise<boolean> => ipcRenderer.invoke("write-file", path, bytes),
  checkWritable: (path: string): Promise<boolean> => ipcRenderer.invoke("check-writable", path),
  joinPath: (...parts: string[]): Promise<string> => ipcRenderer.invoke("join-path", ...parts),
  showInFolder: (path: string): Promise<void> => ipcRenderer.invoke("show-in-folder", path),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("open-external", url),
  convertToPdf: (opts: { path: string; pageSize?: "A4" | "Letter"; landscape?: boolean }): Promise<{ name: string; bytes: Uint8Array }> =>
    ipcRenderer.invoke("convert-to-pdf", opts),
  recoveryList: (): Promise<RecoveryMeta[]> => ipcRenderer.invoke("recovery-list"),
  recoverySave: (entry: { id: string; name: string; origPath: string | null; bytes: Uint8Array }): Promise<boolean> =>
    ipcRenderer.invoke("recovery-save", entry),
  recoveryLoad: (id: string): Promise<{ name: string; origPath: string | null; bytes: Uint8Array } | null> =>
    ipcRenderer.invoke("recovery-load", id),
  recoveryDelete: (id: string): Promise<boolean> => ipcRenderer.invoke("recovery-delete", id),
  recoveryClear: (): Promise<boolean> => ipcRenderer.invoke("recovery-clear"),
  setState: (s: { dirty: boolean; title: string; doc: number }) => ipcRenderer.send("state", s),
  setFullScreen: (on: boolean): Promise<boolean> => ipcRenderer.invoke("set-fullscreen", on),
  onFullScreen: (cb: (on: boolean) => void) => on("fullscreen", cb),
  winMinimize: (): Promise<void> => ipcRenderer.invoke("win-minimize"),
  winMaximize: (): Promise<boolean> => ipcRenderer.invoke("win-maximize"),
  winClose: (): Promise<void> => ipcRenderer.invoke("win-close"),
  winIsMaximized: (): Promise<boolean> => ipcRenderer.invoke("win-is-maximized"),
  onWinMaximized: (cb: (max: boolean) => void) => on("win-maximized", cb),
  takePendingPath: (): Promise<string | null> => ipcRenderer.invoke("take-pending-path"),
  /** Caminho no disco de um arquivo arrastado para a janela ("" se não vier do disco). */
  pathForFile: (file: File): string => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
  print: (doc: number, optsOrPages?: number[] | PrintJobOptions): Promise<{ ok: boolean; reason?: string; pages: number }> =>
    ipcRenderer.invoke("print", doc, optsOrPages),
  getPrinters: (): Promise<PrinterInfo[]> => ipcRenderer.invoke("get-printers"),
  openDefaultApps: (): Promise<void> => ipcRenderer.invoke("open-default-apps"),
  isE2e: (): Promise<boolean> => ipcRenderer.invoke("is-e2e"),
  recentList: (): Promise<Recent[]> => ipcRenderer.invoke("recent-list"),
  /** Registra o arquivo como recente e devolve a página em que ele estava da última vez. */
  recentAdd: (path: string): Promise<number> => ipcRenderer.invoke("recent-add", path),
  recentPage: (path: string, page: number) => ipcRenderer.send("recent-page", path, page),
  recentRemove: (path: string): Promise<Recent[]> => ipcRenderer.invoke("recent-remove", path),
  recentClear: (): Promise<Recent[]> => ipcRenderer.invoke("recent-clear"),
  onOcrProgress: (cb: (p: { page: number; done: number; total: number }) => void) => on("ocr-progress", cb),
  onProgress: (cb: (p: Progress) => void) => on("progress", cb),
  /** Outro PDF aberto pelo Explorer enquanto o Papiro já estava aberto. */
  onOpenPath: (cb: (path: string) => void) => on("open-path", cb),
  getSystemLocale: (): Promise<string> => ipcRenderer.invoke("get-locale"),
  setUiLang: (pref: "auto" | "pt" | "en" | "es"): Promise<void> => ipcRenderer.invoke("set-lang", pref),
};

contextBridge.exposeInMainWorld("papiro", api);
export type PapiroApi = typeof api;
