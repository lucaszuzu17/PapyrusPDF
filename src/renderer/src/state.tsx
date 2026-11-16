// Estado global do aplicativo e as ações que mexem no documento.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { engine, type DocInfo, type SearchHit } from "./api.ts";
import { prepareImages } from "./images.ts";

export type Tool =
  | "select" | "hand" | "highlight" | "underline" | "strikeout" | "note" | "freetext"
  | "ink" | "rect" | "ellipse" | "line" | "arrow" | "signature" | "stamp" | "redact" | "edittext";

export type Panel = "pages" | "outline" | "comments" | "search" | null;
export type RGB = [number, number, number];

export interface OpenDoc {
  path: string | null;
  name: string;
  info: DocInfo;
  rev: number; // muda a cada alteração → páginas e listas recarregam (nunca se repete, nem entre documentos)
  gen: number; // muda a cada documento aberto → as páginas na tela são recriadas do zero
}

/** Arquivo vindo de um diálogo, do disco ou arrastado para a janela. */
export interface InFile { path: string | null; name: string; bytes: Uint8Array }

export interface FormField {
  id: string;
  label: string;
  type: "text" | "password" | "number" | "select" | "checkbox";
  value: string | boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  span?: 2 | 3 | 6; // largura na grade de 6 colunas (padrão 6 = linha inteira)
  showIf?: (v: FormValues) => boolean;
}
export type FormValues = Record<string, string | boolean>;

interface Dialog {
  kind: "prompt" | "password" | "signature" | "confirm" | "form";
  title: string;
  message?: string;
  value?: string;
  multiline?: boolean;
  okLabel?: string;
  fields?: FormField[];
  validate?: (v: FormValues) => string | null;
  resolve: (v: string | null) => void;
}

/** Carimbo pronto para ser colocado na página (PNG transparente). */
export interface Stamp { png: string; width: number; height: number; label: string }

interface Ctx {
  doc: OpenDoc | null;
  tool: Tool; setTool: (t: Tool) => void;
  color: RGB; setColor: (c: RGB) => void;
  zoom: number; setZoom: (z: number | ((z: number) => number)) => void;
  page: number; setPage: (p: number) => void;
  goTo: (p: number) => void; gotoSignal: { page: number; n: number };
  view: "read" | "organize"; setView: (v: "read" | "organize") => void;
  panel: Panel; setPanel: (p: Panel) => void;
  selectedPages: number[]; setSelectedPages: (p: number[]) => void;
  search: { query: string; hits: SearchHit[]; active: number };
  runSearch: (q: string) => Promise<void>; stepSearch: (d: number) => void;
  signature: string | null; setSignature: (s: string | null) => void;
  stamp: Stamp | null; setStamp: (s: Stamp | null) => void;
  busy: string | null; toast: string | null; notify: (m: string) => void;
  progress: { done: number; total: number } | null;
  scanned: number[]; ocrProgress: { done: number; total: number } | null;
  dialog: Dialog | null; closeDialog: (v: string | null) => void;
  ask: (d: Omit<Dialog, "resolve">) => Promise<string | null>;
  askForm: (d: { title: string; message?: string; okLabel?: string; fields: FormField[]; validate?: (v: FormValues) => string | null }) => Promise<FormValues | null>;
  // ações
  openFile: (path?: string) => Promise<void>;
  openData: (f: InFile) => Promise<void>;
  /** Passa a trabalhar num arquivo que o Papiro acabou de gravar (ex.: cópia protegida). */
  adoptFile: (path: string, bytes: Uint8Array, password?: string) => Promise<void>;
  openDropped: (files: File[]) => Promise<void>;
  save: (as?: boolean) => Promise<void>;
  mergeFiles: (files?: InFile[]) => Promise<void>;
  newFromImages: (files?: InFile[]) => Promise<void>;
  insertImages: (files?: InFile[]) => Promise<void>;
  printDoc: () => Promise<void>;
  refresh: () => Promise<void>;
  undo: () => Promise<unknown>; redo: () => Promise<unknown>;
  /** Executa uma alteração no documento. Devolve se deu certo (em caso de erro, o aviso já foi mostrado). */
  mutate: (label: string, fn: () => Promise<DocInfo | { info: DocInfo }>) => Promise<boolean>;
  task: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
  /** "scanned" = as páginas sem texto, conferidas na hora (a lista da tela pode estar defasada). */
  runOcr: (pages: number[] | "scanned") => Promise<void>;
  fitWidth: () => void; viewportWidth: React.MutableRefObject<number>;
}

const C = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(C);

const SIG_KEY = "papiro.signature";
const IMAGE_RE = /\.(png|jpe?g|bmp|gif|webp)$/i;
const baseName = (name: string) => name.replace(/\.pdf$/i, "");
/** Mensagem de erro sem o prefixo que o Electron acrescenta nas chamadas ao processo principal. */
export const errText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function AppProvider({ children }: { children: ReactNode }) {
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<RGB>([1, 0.85, 0]);
  const [zoom, setZoomRaw] = useState(1);
  const [page, setPage] = useState(0);
  const [gotoSignal, setGotoSignal] = useState({ page: 0, n: 0 });
  const [view, setView] = useState<"read" | "organize">("read");
  const [panel, setPanel] = useState<Panel>("pages");
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [search, setSearch] = useState<{ query: string; hits: SearchHit[]; active: number }>({ query: "", hits: [], active: -1 });
  const [signature, setSignatureRaw] = useState<string | null>(() => { try { return localStorage.getItem(SIG_KEY); } catch { return null; } });
  const [stamp, setStamp] = useState<Stamp | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [scanned, setScanned] = useState<number[]>([]);
  const [ocrProgress, setOcrProgress] = useState<{ done: number; total: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const viewportWidth = useRef(1000);
  const toastTimer = useRef<number>(0);
  const docRef = useRef<OpenDoc | null>(null);
  docRef.current = doc;
  const revSeq = useRef(0); // contador único de revisões e de documentos
  const busyRef = useRef(0); // operações em andamento (ações externas esperam terminar)
  const dialogRef = useRef<Dialog | null>(null);
  dialogRef.current = dialog;
  /** Há uma operação ou um diálogo em andamento? (arrastar/abrir de fora espera) */
  const occupied = () => busyRef.current > 0 || dialogRef.current !== null;

  const notify = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
  }, []);

  const setZoom = useCallback((z: number | ((z: number) => number)) =>
    setZoomRaw((old) => Math.min(6, Math.max(0.2, typeof z === "function" ? z(old) : z))), []);

  const setSignature = (s: string | null) => {
    setSignatureRaw(s);
    try { if (s) localStorage.setItem(SIG_KEY, s); else localStorage.removeItem(SIG_KEY); } catch { /* sem armazenamento */ }
  };

  const ask = useCallback((d: Omit<Dialog, "resolve">) => new Promise<string | null>((resolve) => {
    // um diálogo novo por cima de outro: o anterior é respondido como cancelado (ninguém fica esperando para sempre)
    dialogRef.current?.resolve(null);
    const next = { ...d, resolve };
    dialogRef.current = next;
    setDialog(next);
  }), []);
  const closeDialog = (v: string | null) => { dialog?.resolve(v); setDialog(null); };
  const askForm = useCallback<Ctx["askForm"]>(async (d) => {
    const r = await ask({ kind: "form", ...d });
    return r === null ? null : (JSON.parse(r) as FormValues);
  }, [ask]);

  const task = useCallback(async <T,>(label: string, fn: () => Promise<T>) => {
    busyRef.current++;
    setBusy(label);
    try { return await fn(); }
    catch (e) { notify(`Erro: ${errText(e)}`); return undefined; }
    finally { if (--busyRef.current === 0) { setBusy(null); setProgress(null); } }
  }, [notify]);

  const refreshScanned = useCallback(async () => {
    setScanned(await engine.scannedPages().catch(() => [] as number[]));
  }, []);

  const apply = useCallback((info: DocInfo) => {
    // páginas entraram ou saíram: a lista de páginas escaneadas mudou de índices
    if (docRef.current && docRef.current.info.pageCount !== info.pageCount) refreshScanned();
    setDoc((d) => (d ? { ...d, info, rev: ++revSeq.current } : d));
    setPage((p) => Math.max(0, Math.min(p, info.pageCount - 1)));
  }, [refreshScanned]);

  const mutate = useCallback(async (label: string, fn: () => Promise<DocInfo | { info: DocInfo }>) => {
    const r = await task(label, fn);
    if (!r) return false;
    apply("info" in r && !("pageCount" in r) ? r.info : (r as DocInfo));
    return true;
  }, [task, apply]);

  /** Relê o estado do documento (depois de exportações, que reiniciam o histórico de desfazer). */
  const refresh = useCallback(async () => {
    if (!docRef.current) return;
    try { apply(await engine.info()); } catch { /* documento fechado no meio do caminho */ }
  }, [apply]);

  const goTo = useCallback((p: number) => {
    setPage(p);
    setGotoSignal((s) => ({ page: p, n: s.n + 1 }));
  }, []);

  const fitWidth = useCallback(() => {
    const w = doc?.info.pages[page]?.width ?? 612;
    setZoom((viewportWidth.current - 64) / w);
  }, [doc, page, setZoom]);

  /** O documento novo já está aberto no motor: atualiza a interface. */
  const loaded = useCallback(async (name: string, path: string | null, info: DocInfo, keepPage?: number) => {
    // arquivos do disco entram nos recentes e reabrem na página em que estavam
    const last = path ? await window.papiro.recentAdd(path).catch(() => 0) : 0;
    const start = Math.max(0, Math.min(keepPage ?? last, info.pageCount - 1));
    setDoc({ path, name, info, rev: ++revSeq.current, gen: ++revSeq.current });
    setPage(start); setSelectedPages([]); setSearch({ query: "", hits: [], active: -1 }); setView("read");
    setTool((t) => (t === "hand" ? t : "select"));
    setGotoSignal((s) => ({ page: start, n: s.n + 1 }));
    const first = info.pages[start];
    if (first && keepPage === undefined) setZoomRaw(Math.min(1.6, Math.max(0.5, (viewportWidth.current - 64) / first.width)));
    const sc = await engine.scannedPages().catch(() => [] as number[]);
    setScanned(sc);
  }, []);

  /** Antes de trocar de documento: confirma se há alterações não salvas. */
  const confirmDiscard = useCallback(async () => {
    const d = docRef.current;
    if (!d?.info.dirty) return true;
    return (await ask({
      kind: "confirm", title: "Alterações não salvas", okLabel: "Descartar alterações",
      message: `“${d.name}” tem alterações que ainda não foram salvas. Continuar e perder essas alterações?`,
    })) !== null;
  }, [ask]);

  const openData = useCallback(async (f: InFile) => {
    if (!(await confirmDiscard())) return;
    await task("Abrindo…", async () => {
      let info = await engine.open(f.bytes, baseName(f.name));
      if (await engine.needsPassword()) {
        for (;;) {
          const pw = await ask({ kind: "password", title: "Documento protegido", message: `Digite a senha para abrir “${f.name}”.` });
          if (pw === null) { await engine.cancelOpen(); return; }
          try { info = await engine.unlock(pw); break; } catch { notify("Senha incorreta."); }
        }
      }
      await loaded(f.name, f.path, info);
    });
  }, [task, ask, notify, loaded, confirmDiscard]);

  const openFile = useCallback(async (path?: string) => {
    let f: InFile | undefined;
    try { f = path ? await window.papiro.readFile(path) : (await window.papiro.openDialog())[0]; }
    catch { notify(`Não foi possível ler ${path ?? "o arquivo"}.`); if (path) window.papiro.recentRemove(path).catch(() => {}); return; }
    if (f) await openData(f);
  }, [openData, notify]);

  const adoptFile = useCallback(async (path: string, bytes: Uint8Array, password?: string) => {
    const name = path.split(/[\\/]/).pop()!;
    const keep = docRef.current ? Math.max(0, page) : undefined;
    // sem senha informada, o motor usa a do documento atual (ex.: cópia comprimida de um PDF protegido)
    const info = await engine.reopen(bytes, baseName(name), password);
    await loaded(name, path, info, keep);
  }, [loaded, page]);

  const save = useCallback(async (as = false) => {
    if (!doc) return;
    let path = doc.path;
    if (as || !path) path = await window.papiro.saveDialog(doc.path ?? doc.name);
    if (!path) return;
    const target = path;
    await task("Salvando…", async () => {
      const bytes = await engine.save();
      const name = target.split(/[\\/]/).pop()!;
      try { await window.papiro.writeFile(target, bytes); }
      catch (e) {
        // o motor já considera salvo; marca de novo como alterado para não perder o aviso ao sair
        apply(await engine.markModified());
        throw new Error(`não foi possível gravar em ${target} (${errText(e)}). O arquivo pode estar aberto em outro programa.`);
      }
      await engine.setTitle(baseName(name));
      const info = await engine.info();
      setDoc((d) => (d ? { ...d, path: target, name, info, rev: ++revSeq.current } : d));
      await window.papiro.recentAdd(target).catch(() => 0);
      window.papiro.recentPage(target, page);
      notify(`Salvo em ${target}`);
    });
  }, [doc, task, notify, page, apply]);

  const mergeFiles = useCallback(async (given?: InFile[]) => {
    const files = given ?? await window.papiro.openDialog({ title: "Escolha os PDFs para combinar (na ordem desejada)", multi: true });
    if (files.length < 2) { if (files.length) notify("Escolha pelo menos dois arquivos."); return; }
    if (!(await confirmDiscard())) return;
    await task("Combinando…", async () => {
      let info = await engine.open(files[0].bytes, "Combinado");
      if (await engine.needsPassword()) {
        await engine.cancelOpen();
        throw new Error(`“${files[0].name}” é protegido por senha. Abra-o e use Proteger → Remover proteção antes de combinar.`);
      }
      try {
        for (const f of files.slice(1)) {
          try { info = await engine.insertFromPdf(f.bytes, -1); }
          catch (e) { throw new Error(`“${f.name}”: ${errText(e)}`); }
        }
      } finally {
        // mesmo se um arquivo falhar, a interface passa a mostrar o que o motor tem aberto
        info = await engine.info();
        await loaded("Combinado.pdf", null, info);
      }
      notify(`${files.length} arquivos combinados (${info.pageCount} páginas). Use Salvar para gravar.`);
    });
  }, [task, loaded, notify, confirmDiscard]);

  const pickImages = async (given: InFile[] | undefined, title: string) =>
    given ?? await window.papiro.openDialog({ title, images: true, multi: true });

  const newFromImages = useCallback(async (given?: InFile[]) => {
    const files = await pickImages(given, "Escolha as imagens (cada uma vira uma página)");
    if (!files.length) return;
    const v = await askForm({
      title: "Criar PDF a partir de imagens", okLabel: "Criar PDF",
      message: `${files.length} imagem(ns), na ordem em que foram escolhidas.`,
      fields: [{ id: "page", label: "Tamanho da página", type: "select", value: "A4", options: [
        { value: "A4", label: "A4 (retrato ou paisagem conforme a imagem)" },
        { value: "Carta", label: "Carta" },
        { value: "imagem", label: "Do tamanho da imagem (sem margens)" },
      ] }],
    });
    if (!v || !(await confirmDiscard())) return;
    await task("Criando PDF…", async () => {
      const imgs = await prepareImages(files);
      const info = await engine.imagesToPdf(imgs, { page: v.page as "A4" | "Carta" | "imagem" }, "Imagens");
      await loaded("Imagens.pdf", null, info);
      notify(`PDF criado com ${info.pageCount} página(s). Use Salvar para gravar.`);
    });
  }, [askForm, task, loaded, notify, confirmDiscard]);

  const insertImages = useCallback(async (given?: InFile[]) => {
    const d = docRef.current;
    if (!d) return;
    const files = await pickImages(given, "Imagens para inserir como páginas");
    if (!files.length) return;
    const at = given ? -1 : page + 1;
    const ok = await mutate("Inserindo imagens…", async () => engine.insertImages(await prepareImages(files), at, { page: "A4" }));
    if (ok) notify(`${files.length} imagem(ns) inserida(s) ${at < 0 ? "no fim do documento" : `depois da página ${page + 1}`}.`);
  }, [mutate, notify, page]);

  const openDropped = useCallback(async (dropped: File[]) => {
    if (occupied()) { notify("Termine a operação em andamento antes de soltar arquivos."); return; }
    const read = async (f: File): Promise<InFile> =>
      ({ path: window.papiro.pathForFile(f) || null, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    const pdfs = dropped.filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    const imgs = dropped.filter((f) => IMAGE_RE.test(f.name));
    try {
      if (pdfs.length === 1) await openData(await read(pdfs[0]));
      else if (pdfs.length > 1) await mergeFiles(await Promise.all(pdfs.map(read)));
      else if (imgs.length) {
        const files = await Promise.all(imgs.map(read));
        if (docRef.current) await insertImages(files); else await newFromImages(files);
      } else notify("Solte arquivos PDF ou imagens (PNG, JPG, BMP, GIF, WebP).");
    } catch { notify("Não foi possível ler os arquivos soltos."); }
  }, [openData, mergeFiles, insertImages, newFromImages, notify]);

  const printDoc = useCallback(async () => {
    if (!docRef.current) return;
    const r = await task("Preparando impressão…", () => window.papiro.print());
    if (r && !r.ok && r.reason && !/cancel/i.test(r.reason)) notify(`Não foi possível imprimir: ${r.reason}`);
  }, [task, notify]);

  const undo = useCallback(() => mutate("Desfazendo…", engine.undo), [mutate]);
  const redo = useCallback(() => mutate("Refazendo…", engine.redo), [mutate]);

  const runSearch = useCallback(async (q: string) => {
    if (!doc) return;
    const hits = (await task("Buscando…", () => engine.search(q))) ?? [];
    setSearch({ query: q, hits, active: hits.length ? 0 : -1 });
    if (hits.length) goTo(hits[0].page);
    else if (q.trim()) notify("Nenhum resultado.");
  }, [doc, task, goTo, notify]);

  const stepSearch = useCallback((d: number) => {
    setSearch((s) => {
      if (!s.hits.length) return s;
      const active = (s.active + d + s.hits.length) % s.hits.length;
      goTo(s.hits[active].page);
      return { ...s, active };
    });
  }, [goTo]);

  const runOcr = useCallback(async (which: number[] | "scanned") => {
    if (!docRef.current) return;
    let pages: number[];
    if (which === "scanned") {
      // confere na hora: páginas podem ter sido excluídas, reordenadas ou já reconhecidas
      pages = await engine.scannedPages().catch(() => [] as number[]);
      setScanned(pages);
      if (!pages.length) { notify("Não há páginas escaneadas sem texto."); return; }
    } else {
      const n = docRef.current.info.pageCount;
      pages = which.filter((p) => p >= 0 && p < n);
    }
    if (!pages.length) return;
    setOcrProgress({ done: 0, total: pages.length });
    const off = window.papiro.onOcrProgress((p) => setOcrProgress({ done: p.done, total: p.total }));
    try {
      const r = await task(`Reconhecendo texto (OCR) em ${pages.length} página(s)…`, () => engine.ocrPages(pages));
      if (r) {
        apply(r.info);
        notify(`OCR concluído: ${r.words} palavras reconhecidas. O texto agora pode ser pesquisado e selecionado.`);
      } else if (docRef.current) {
        // falhou no meio: parte das páginas pode ter sido reconhecida; a tela volta a refletir o motor
        try { apply(await engine.info()); } catch { /* documento fechado */ }
      }
      await refreshScanned();
    } finally { off(); setOcrProgress(null); }
  }, [task, apply, notify, refreshScanned]);

  // título da janela e aviso de alterações não salvas
  useEffect(() => {
    window.papiro.setState({
      dirty: !!doc?.info.dirty,
      title: doc ? `${doc.info.dirty ? "• " : ""}${doc.name} — PapyrusPDF` : "PapyrusPDF",
    });
  }, [doc]);

  // lembra a página em que cada arquivo ficou
  const docPath = doc?.path ?? null;
  useEffect(() => {
    if (!docPath) return;
    const t = window.setTimeout(() => window.papiro.recentPage(docPath, page), 600);
    return () => window.clearTimeout(t);
  }, [docPath, page]);

  // andamento de operações longas do motor (impressão, exportação de imagens)
  useEffect(() => window.papiro.onProgress((p) => setProgress({ done: p.done, total: p.total })), []);

  // arquivo passado na linha de comando, e PDFs abertos pelo Explorer com o Papiro já aberto
  const openRef = useRef(openFile);
  openRef.current = openFile;
  useEffect(() => {
    window.papiro.takePendingPath().then((p) => { if (p) openRef.current(p); });
    return window.papiro.onOpenPath((p) => {
      if (occupied()) { notify(`Termine a operação em andamento e abra “${p.split(/[\\/]/).pop()}” de novo.`); return; }
      openRef.current(p);
    });
  }, []);

  const value = useMemo<Ctx>(() => ({
    doc, tool, setTool, color, setColor, zoom, setZoom, page, setPage, goTo, gotoSignal, view, setView,
    panel, setPanel, selectedPages, setSelectedPages, search, runSearch, stepSearch, signature, setSignature,
    stamp, setStamp, busy, toast, notify, progress, scanned, ocrProgress, dialog, closeDialog, ask, askForm,
    openFile, openData, adoptFile, openDropped, save, mergeFiles, newFromImages, insertImages, printDoc, refresh,
    undo, redo, mutate, task, runOcr, fitWidth, viewportWidth,
  }), [doc, tool, color, zoom, setZoom, page, goTo, gotoSignal, view, panel, selectedPages, search, runSearch, stepSearch,
    signature, stamp, busy, toast, notify, progress, scanned, ocrProgress, dialog, ask, askForm, openFile, openData,
    adoptFile, openDropped, save, mergeFiles, newFromImages, insertImages, printDoc, refresh, undo, redo, mutate, task,
    runOcr, fitWidth]); // eslint-disable-line react-hooks/exhaustive-deps

  return <C.Provider value={value}>{children}</C.Provider>;
}
