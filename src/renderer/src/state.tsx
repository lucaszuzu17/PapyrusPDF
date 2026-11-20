// Estado global do aplicativo e as ações que mexem no documento.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { disposeDoc, engine, engineAt, engineDoc, setEngineDoc, type DocInfo, type SearchHit } from "./api.ts";
import { prepareImages } from "./images.ts";

export type Tool =
  | "select" | "hand" | "highlight" | "underline" | "strikeout" | "note" | "freetext"
  | "ink" | "rect" | "ellipse" | "line" | "arrow" | "signature" | "stamp" | "redact" | "edittext";

export type Panel = "pages" | "outline" | "comments" | "search" | null;
export type RGB = [number, number, number];
export type View = "read" | "organize";
/** Uma página por vez (rolagem contínua) ou duas lado a lado. */
export type Layout = "single" | "double";

export interface OpenDoc {
  id: number;  // documento no motor (um por aba)
  path: string | null;
  name: string;
  info: DocInfo;
  rev: number; // muda a cada alteração → páginas e listas recarregam (nunca se repete, nem entre documentos)
  gen: number; // muda a cada documento aberto → as páginas na tela são recriadas do zero
}

/** Aba na barra de abas. */
export interface TabItem { id: number; name: string; path: string | null; dirty: boolean }

interface SearchState { query: string; hits: SearchHit[]; active: number }

/** O que cada aba lembra enquanto outra está na frente. */
interface TabSnap {
  doc: OpenDoc; page: number; zoom: number; search: SearchState;
  scanned: number[]; selectedPages: number[]; view: View;
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
  /** Aviso embaixo do campo, recalculado a cada digitação (ex.: força da senha; level 0–4 colore a barra). */
  note?: (v: FormValues) => { text: string; level?: number } | null;
  /** Botão ao lado do rótulo que preenche campos (ex.: gerar senha). `reveal` mostra as senhas digitadas. */
  action?: { label: string; run: (v: FormValues) => FormValues; reveal?: boolean };
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

/** Idiomas de OCR que acompanham o programa (códigos do Tesseract; "+" combina). */
export const OCR_LANGS: { value: string; label: string }[] = [
  { value: "por", label: "Português" },
  { value: "eng", label: "Inglês" },
  { value: "spa", label: "Espanhol" },
  { value: "por+eng", label: "Português + inglês" },
  { value: "por+spa", label: "Português + espanhol" },
];

interface Ctx {
  doc: OpenDoc | null;
  tabs: TabItem[];
  switchTab: (id: number) => void;
  closeTab: (id: number) => Promise<void>;
  cycleTab: (d: number) => void;
  tool: Tool; setTool: (t: Tool) => void;
  color: RGB; setColor: (c: RGB) => void;
  zoom: number; setZoom: (z: number | ((z: number) => number)) => void;
  page: number; setPage: (p: number) => void;
  goTo: (p: number) => void; gotoSignal: { page: number; n: number };
  view: View; setView: (v: View) => void;
  layout: Layout; setLayout: (l: Layout) => void;
  fullscreen: boolean; toggleFullScreen: (on?: boolean) => void;
  panel: Panel; setPanel: (p: Panel) => void;
  selectedPages: number[]; setSelectedPages: (p: number[]) => void;
  search: SearchState;
  runSearch: (q: string) => Promise<void>; stepSearch: (d: number) => void;
  signature: string | null; setSignature: (s: string | null) => void;
  stamp: Stamp | null; setStamp: (s: Stamp | null) => void;
  ocrLang: string; setOcrLang: (l: string) => void;
  busy: string | null; toast: string | null; notify: (m: string) => void;
  progress: { done: number; total: number } | null;
  scanned: number[]; ocrProgress: { done: number; total: number } | null;
  dialog: Dialog | null; closeDialog: (v: string | null) => void;
  ask: (d: Omit<Dialog, "resolve">) => Promise<string | null>;
  askForm: (d: { title: string; message?: string; okLabel?: string; fields: FormField[]; validate?: (v: FormValues) => string | null }) => Promise<FormValues | null>;
  // ações
  openFile: (path?: string) => Promise<void>;
  openData: (f: InFile) => Promise<void>;
  /** Passa a trabalhar num arquivo que o Papiro acabou de gravar (ex.: cópia protegida), na mesma aba. */
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
const LAYOUT_KEY = "papiro.layout";
const OCR_KEY = "papiro.ocrLang";
const IMAGE_RE = /\.(png|jpe?g|bmp|gif|webp)$/i;
const baseName = (name: string) => name.replace(/\.pdf$/i, "");
const samePath = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, v); } catch { /* sem armazenamento */ }
};
/** Mensagem de erro sem o prefixo que o Electron acrescenta nas chamadas ao processo principal. */
export const errText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function AppProvider({ children }: { children: ReactNode }) {
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [tabs, setTabs] = useState<TabItem[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<RGB>([1, 0.85, 0]);
  const [zoom, setZoomRaw] = useState(1);
  const [page, setPage] = useState(0);
  const [gotoSignal, setGotoSignal] = useState({ page: 0, n: 0 });
  const [view, setView] = useState<View>("read");
  const [layout, setLayoutRaw] = useState<Layout>(() => (stored(LAYOUT_KEY) === "double" ? "double" : "single"));
  const [fullscreen, setFullscreen] = useState(false);
  const [panel, setPanel] = useState<Panel>("pages");
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [search, setSearch] = useState<SearchState>({ query: "", hits: [], active: -1 });
  const [signature, setSignatureRaw] = useState<string | null>(() => stored(SIG_KEY));
  const [stamp, setStamp] = useState<Stamp | null>(null);
  const [ocrLang, setOcrLangRaw] = useState<string>(() => {
    const v = stored(OCR_KEY);
    return OCR_LANGS.some((l) => l.value === v) ? v! : "por";
  });
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
  const tabsRef = useRef<TabItem[]>([]);
  tabsRef.current = tabs;
  // o estado da aba da frente, para guardar ao trocar de aba
  const cur = useRef<Omit<TabSnap, "doc">>({ page, zoom, search, scanned, selectedPages, view });
  cur.current = { page, zoom, search, scanned, selectedPages, view };
  const snaps = useRef(new Map<number, TabSnap>()); // abas que não estão na frente
  const nextId = useRef(1);
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

  const setSignature = (s: string | null) => { setSignatureRaw(s); store(SIG_KEY, s); };
  const setOcrLang = (l: string) => { setOcrLangRaw(l); store(OCR_KEY, l); };
  const setLayout = (l: Layout) => { setLayoutRaw(l); store(LAYOUT_KEY, l); };

  const toggleFullScreen = useCallback((on?: boolean) => {
    const want = on ?? !fullscreen;
    setFullscreen(want);
    window.papiro.setFullScreen(want).catch(() => {});
  }, [fullscreen]);
  useEffect(() => window.papiro.onFullScreen((on) => setFullscreen(on)), []);

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
    const pages = doc?.info.pages ?? [];
    const w = pages[page]?.width ?? 612;
    // em duas páginas, cabe o par inteiro (a página da esquerda é a de índice par)
    const pair = layout === "double" ? (pages[page - (page % 2)]?.width ?? w) + (pages[page - (page % 2) + 1]?.width ?? w) + 16 : w;
    setZoom((viewportWidth.current - 64) / pair);
  }, [doc, page, layout, setZoom]);

  // ---------- abas ----------

  /** Mostra uma aba guardada (ou a que acabou de abrir). */
  const show = useCallback((s: TabSnap) => {
    setEngineDoc(s.doc.id);
    setDoc(s.doc); setPage(s.page); setZoomRaw(s.zoom); setSearch(s.search);
    setScanned(s.scanned); setSelectedPages(s.selectedPages); setView(s.view);
    setGotoSignal((g) => ({ page: s.page, n: g.n + 1 }));
  }, []);

  /** Guarda o estado da aba da frente antes de outra ocupar o lugar. */
  const stash = useCallback(() => {
    const d = docRef.current;
    if (d) snaps.current.set(d.id, { doc: d, ...cur.current });
  }, []);

  const switchTab = useCallback((id: number) => {
    if (docRef.current?.id === id) return;
    if (occupied()) { notify("Termine a operação em andamento antes de trocar de aba."); return; }
    const s = snaps.current.get(id);
    if (!s) return;
    stash();
    snaps.current.delete(id);
    show(s);
  }, [notify, stash, show]);

  const cycleTab = useCallback((d: number) => {
    const list = tabsRef.current;
    if (list.length < 2 || !docRef.current) return;
    const i = list.findIndex((t) => t.id === docRef.current!.id);
    switchTab(list[(i + d + list.length) % list.length].id);
  }, [switchTab]);

  const closeTab = useCallback(async (id: number) => {
    if (occupied()) { notify("Termine a operação em andamento antes de fechar a aba."); return; }
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    const dirty = docRef.current?.id === id ? docRef.current.info.dirty : t.dirty;
    if (dirty && (await ask({
      kind: "confirm", title: "Alterações não salvas", okLabel: "Fechar sem salvar",
      message: `“${t.name}” tem alterações que ainda não foram salvas. Fechar e perder essas alterações?`,
    })) === null) return;
    const list = tabsRef.current;
    const i = list.findIndex((x) => x.id === id);
    const rest = list.filter((x) => x.id !== id);
    setTabs(rest);
    snaps.current.delete(id);
    if (docRef.current?.id === id) {
      const next = rest[Math.min(i, rest.length - 1)];
      const s = next ? snaps.current.get(next.id) : undefined;
      if (s) { snaps.current.delete(next!.id); show(s); }
      else {
        setEngineDoc(0);
        setDoc(null); setSearch({ query: "", hits: [], active: -1 }); setScanned([]); setSelectedPages([]); setView("read");
      }
    }
    disposeDoc(id).catch(() => {});
  }, [ask, notify, show]);

  /** O documento já está aberto no motor (`id`): mostra numa aba (nova ou a mesma, no caso de `adoptFile`). */
  const loaded = useCallback(async (id: number, name: string, path: string | null, info: DocInfo, keepPage?: number) => {
    // arquivos do disco entram nos recentes e reabrem na página em que estavam
    const last = path ? await window.papiro.recentAdd(path).catch(() => 0) : 0;
    const start = Math.max(0, Math.min(keepPage ?? last, info.pageCount - 1));
    if (docRef.current?.id !== id) stash();
    setTabs((ts) => ts.some((t) => t.id === id)
      ? ts.map((t) => (t.id === id ? { id, name, path, dirty: info.dirty } : t))
      : [...ts, { id, name, path, dirty: info.dirty }]);
    const first = info.pages[start];
    const z = first && keepPage === undefined ? Math.min(1.6, Math.max(0.5, (viewportWidth.current - 64) / first.width)) : cur.current.zoom;
    const sc = await engineAt(id).scannedPages().catch(() => [] as number[]);
    show({
      doc: { id, path, name, info, rev: ++revSeq.current, gen: ++revSeq.current },
      page: start, zoom: z, search: { query: "", hits: [], active: -1 }, scanned: sc, selectedPages: [], view: "read",
    });
    setTool((t) => (t === "hand" ? t : "select"));
  }, [stash, show]);

  /** Abre bytes numa aba nova (pedindo a senha, se for o caso). Devolve o id da aba ou null se desistiu. */
  const openInNewTab = useCallback(async (f: InFile): Promise<number | null> => {
    const id = nextId.current++;
    const e = engineAt(id);
    try {
      let info = await e.open(f.bytes, baseName(f.name));
      if (await e.needsPassword()) {
        for (;;) {
          const pw = await ask({ kind: "password", title: "Documento protegido", message: `Digite a senha para abrir “${f.name}”.` });
          if (pw === null) { disposeDoc(id).catch(() => {}); return null; }
          try { info = await e.unlock(pw); break; } catch { notify("Senha incorreta."); }
        }
      }
      await loaded(id, f.name, f.path, info);
      return id;
    } catch (err) {
      disposeDoc(id).catch(() => {});
      throw err;
    }
  }, [ask, notify, loaded]);

  const openData = useCallback(async (f: InFile) => {
    // o mesmo arquivo já aberto: só traz a aba para a frente
    const open = tabsRef.current.find((t) => samePath(t.path, f.path));
    if (open) { switchTab(open.id); return; }
    await task("Abrindo…", () => openInNewTab(f));
  }, [task, openInNewTab, switchTab]);

  const openFile = useCallback(async (path?: string) => {
    if (path) {
      const open = tabsRef.current.find((t) => samePath(t.path, path));
      if (open) { switchTab(open.id); return; }
    }
    let f: InFile | undefined;
    try { f = path ? await window.papiro.readFile(path) : (await window.papiro.openDialog())[0]; }
    catch { notify(`Não foi possível ler ${path ?? "o arquivo"}.`); if (path) window.papiro.recentRemove(path).catch(() => {}); return; }
    if (f) await openData(f);
  }, [openData, notify, switchTab]);

  const adoptFile = useCallback(async (path: string, bytes: Uint8Array, password?: string) => {
    const d = docRef.current;
    if (!d) return;
    const name = path.split(/[\\/]/).pop()!;
    // sem senha informada, o motor usa a do documento atual (ex.: cópia comprimida de um PDF protegido)
    const info = await engine.reopen(bytes, baseName(name), password);
    await loaded(d.id, name, path, info, Math.max(0, page));
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
    await task("Combinando…", async () => {
      const id = nextId.current++;
      const e = engineAt(id);
      let info = await e.open(files[0].bytes, "Combinado");
      if (await e.needsPassword()) {
        disposeDoc(id).catch(() => {});
        throw new Error(`“${files[0].name}” é protegido por senha. Abra-o e use Proteger → Remover proteção antes de combinar.`);
      }
      try {
        for (const f of files.slice(1)) {
          try { info = await e.insertFromPdf(f.bytes, -1); }
          catch (err) { throw new Error(`“${f.name}”: ${errText(err)}`); }
        }
      } finally {
        // mesmo se um arquivo falhar, a aba nova mostra o que o motor tem aberto
        info = await e.info();
        await loaded(id, "Combinado.pdf", null, info);
      }
      notify(`${files.length} arquivos combinados (${info.pageCount} páginas). Use Salvar para gravar.`);
    });
  }, [task, loaded, notify]);

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
    if (!v) return;
    await task("Criando PDF…", async () => {
      const imgs = await prepareImages(files);
      const id = nextId.current++;
      try {
        const info = await engineAt(id).imagesToPdf(imgs, { page: v.page as "A4" | "Carta" | "imagem" }, "Imagens");
        await loaded(id, "Imagens.pdf", null, info);
        notify(`PDF criado com ${info.pageCount} página(s). Use Salvar para gravar.`);
      } catch (err) { disposeDoc(id).catch(() => {}); throw err; }
    });
  }, [askForm, task, loaded, notify]);

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
    const id = engineDoc();
    const r = await task("Preparando impressão…", () => window.papiro.print(id));
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
    const lang = OCR_LANGS.find((l) => l.value === ocrLang)?.label ?? ocrLang;
    setOcrProgress({ done: 0, total: pages.length });
    const off = window.papiro.onOcrProgress((p) => setOcrProgress({ done: p.done, total: p.total }));
    try {
      const r = await task(`Reconhecendo texto em ${lang.toLowerCase()} (OCR) em ${pages.length} página(s)…`, () => engine.ocrPages(pages, ocrLang));
      if (r) {
        apply(r.info);
        notify(`OCR concluído: ${r.words} palavras reconhecidas. O texto agora pode ser pesquisado e selecionado.`);
      } else if (docRef.current) {
        // falhou no meio: parte das páginas pode ter sido reconhecida; a tela volta a refletir o motor
        try { apply(await engine.info()); } catch { /* documento fechado */ }
      }
      await refreshScanned();
    } finally { off(); setOcrProgress(null); }
  }, [task, apply, notify, refreshScanned, ocrLang]);

  // a aba da frente mostra na barra o nome e se há alterações
  useEffect(() => {
    if (!doc) return;
    setTabs((ts) => {
      const t = ts.find((x) => x.id === doc.id);
      if (!t || (t.name === doc.name && t.path === doc.path && t.dirty === doc.info.dirty)) return ts;
      return ts.map((x) => (x.id === doc.id ? { ...x, name: doc.name, path: doc.path, dirty: doc.info.dirty } : x));
    });
  }, [doc]);

  // título da janela e aviso de alterações não salvas (de qualquer aba)
  useEffect(() => {
    const anyDirty = !!doc?.info.dirty || tabs.some((t) => t.dirty && t.id !== doc?.id);
    window.papiro.setState({
      dirty: anyDirty,
      doc: doc?.id ?? 0,
      title: doc ? `${doc.info.dirty ? "• " : ""}${doc.name} — PapyrusPDF` : "PapyrusPDF",
    });
  }, [doc, tabs]);

  // lembra a página em que cada arquivo ficou
  const docPath = doc?.path ?? null;
  useEffect(() => {
    if (!docPath) return;
    const t = window.setTimeout(() => window.papiro.recentPage(docPath, page), 600);
    return () => window.clearTimeout(t);
  }, [docPath, page]);

  // andamento de operações longas do motor (impressão, exportações)
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
    doc, tabs, switchTab, closeTab, cycleTab, tool, setTool, color, setColor, zoom, setZoom, page, setPage, goTo, gotoSignal,
    view, setView, layout, setLayout, fullscreen, toggleFullScreen,
    panel, setPanel, selectedPages, setSelectedPages, search, runSearch, stepSearch, signature, setSignature,
    stamp, setStamp, ocrLang, setOcrLang, busy, toast, notify, progress, scanned, ocrProgress, dialog, closeDialog, ask, askForm,
    openFile, openData, adoptFile, openDropped, save, mergeFiles, newFromImages, insertImages, printDoc, refresh,
    undo, redo, mutate, task, runOcr, fitWidth, viewportWidth,
  }), [doc, tabs, switchTab, closeTab, cycleTab, tool, color, zoom, setZoom, page, goTo, gotoSignal, view, layout, fullscreen,
    toggleFullScreen, panel, selectedPages, search, runSearch, stepSearch, signature, stamp, ocrLang, busy, toast, notify,
    progress, scanned, ocrProgress, dialog, ask, askForm, openFile, openData, adoptFile, openDropped, save, mergeFiles,
    newFromImages, insertImages, printDoc, refresh, undo, redo, mutate, task, runOcr, fitWidth]); // eslint-disable-line react-hooks/exhaustive-deps

  return <C.Provider value={value}>{children}</C.Provider>;
}
