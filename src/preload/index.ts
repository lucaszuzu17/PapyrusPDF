import { contextBridge, ipcRenderer, webUtils } from "electron";

export interface FileData { path: string; name: string; bytes: Uint8Array }
export interface Recent { path: string; name: string; page: number; when: number }
export interface Progress { label: string; done: number; total: number }

const on = <T,>(channel: string, cb: (v: T) => void) => {
  const h = (_: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => { ipcRenderer.removeListener(channel, h); };
};

const api = {
  /** Chamada ao motor do documento `doc` (cada aba tem o seu). */
  engine: <T = any>(doc: number, method: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke("engine", doc, method, args),
  openDialog: (opts?: { title?: string; images?: boolean; multi?: boolean }): Promise<FileData[]> =>
    ipcRenderer.invoke("open-dialog", opts ?? {}),
  readFile: (path: string): Promise<FileData> => ipcRenderer.invoke("read-file", path),
  saveDialog: (suggested: string, kind: "pdf" | "png" | "jpg" | "docx" | "txt" | "csv" = "pdf"): Promise<string | null> =>
    ipcRenderer.invoke("save-dialog", suggested, kind),
  folderDialog: (): Promise<string | null> => ipcRenderer.invoke("folder-dialog"),
  writeFile: (path: string, bytes: Uint8Array): Promise<boolean> => ipcRenderer.invoke("write-file", path, bytes),
  checkWritable: (path: string): Promise<boolean> => ipcRenderer.invoke("check-writable", path),
  joinPath: (...parts: string[]): Promise<string> => ipcRenderer.invoke("join-path", ...parts),
  showInFolder: (path: string): Promise<void> => ipcRenderer.invoke("show-in-folder", path),
  setState: (s: { dirty: boolean; title: string; doc: number }) => ipcRenderer.send("state", s),
  setFullScreen: (on: boolean): Promise<boolean> => ipcRenderer.invoke("set-fullscreen", on),
  onFullScreen: (cb: (on: boolean) => void) => on("fullscreen", cb),
  takePendingPath: (): Promise<string | null> => ipcRenderer.invoke("take-pending-path"),
  /** Caminho no disco de um arquivo arrastado para a janela ("" se não vier do disco). */
  pathForFile: (file: File): string => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
  print: (doc: number, pages?: number[]): Promise<{ ok: boolean; reason?: string; pages: number }> => ipcRenderer.invoke("print", doc, pages),
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
};

contextBridge.exposeInMainWorld("papiro", api);
export type PapiroApi = typeof api;
