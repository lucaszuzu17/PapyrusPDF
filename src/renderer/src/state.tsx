// Estado global do aplicativo e as ações que mexem no documento.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  defaultOcrLang, localeTag, resolveLang, translate,
  type I18nKey, type LangPref, type UiLang,
} from "../../shared/i18n.ts";
import type { PrintJobOptions } from "../../shared/print-types.ts";
import { disposeDoc, engine, engineAt, engineDoc, setEngineDoc, type CompareReport, type DocInfo, type OutlineNode, type SearchHit } from "./api.ts";
import { prepareImages } from "./images.ts";
import { tts } from "./tts.ts";

export type Tool =
  | "select" | "hand" | "highlight" | "underline" | "strikeout" | "note" | "freetext"
  | "ink" | "rect" | "ellipse" | "line" | "arrow" | "signature" | "stamp" | "redact"
  | "edittext" | "addtext" | "overlayimg" | "measure" | "link" | "addfield";

export type Panel = "pages" | "outline" | "comments" | "attachments" | "layers" | "search" | null;
export type RGB = [number, number, number];
export type View = "read" | "organize";
/** Uma página por vez (rolagem contínua) ou duas lado a lado. */
export type Layout = "single" | "double";
/** Filtro visual da página para leitura confortável (não altera o PDF). */
export type ReadMode = "normal" | "sepia" | "dark";
export type ThemePref = "auto" | "light" | "dark";

export interface OverlayImage {
  bytes: Uint8Array;
  width: number;
  height: number;
  name: string;
}

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

/** Códigos de idiomas de OCR que acompanham o programa (códigos do Tesseract; "+" combina). */
const OCR_LANG_VALUES = ["por", "eng", "spa", "por+eng", "por+spa", "eng+spa"] as const;
export function ocrLangOptions(lang: UiLang): { value: string; label: string }[] {
  return OCR_LANG_VALUES.map((value) => ({ value, label: translate(lang, `ocrLang.${value}` as I18nKey) }));
}

interface Ctx {
  uiLangPref: LangPref;
  lang: UiLang;
  systemLang: UiLang;
  setUiLang: (p: LangPref) => void;
  t: (key: I18nKey, vars?: Record<string, string | number>) => string;
  theme: ThemePref;
  setTheme: (th: ThemePref) => void;
  fileMenuOpen: boolean;
  setFileMenuOpen: (on: boolean) => void;
  printOpen: boolean;
  setPrintOpen: (on: boolean) => void;
  homeOpen: boolean;
  setHomeOpen: (on: boolean) => void;
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
  readMode: ReadMode; setReadMode: (m: ReadMode) => void;
  measureScale: number; setMeasureScale: (s: number) => void;
  overlayImg: OverlayImage | null; setOverlayImg: (img: OverlayImage | null) => void;
  compareReport: CompareReport | null; setCompareReport: (r: CompareReport | null) => void;
  fullscreen: boolean; toggleFullScreen: (on?: boolean) => void;
  panel: Panel; setPanel: (p: Panel) => void;
  selectedPages: number[]; setSelectedPages: (p: number[]) => void;
  search: SearchState;
  runSearch: (q: string) => Promise<void>; stepSearch: (d: number) => void;
  signature: string | null; setSignature: (s: string | null) => void;
  stamp: Stamp | null; setStamp: (s: Stamp | null) => void;
  ocrLang: string; setOcrLang: (l: string) => void;
  ocrQuality: "neural" | "best" | "fast"; setOcrQuality: (q: "neural" | "best" | "fast") => void;
  ocrCleanup: boolean; setOcrCleanup: (on: boolean) => void;
  recoveryItems: { id: string; name: string; origPath: string | null; savedAt: number }[];
  restoreRecovery: () => Promise<void>;
  dismissRecovery: () => Promise<void>;
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
  executePrint: (opts: PrintJobOptions) => Promise<{ ok: boolean; reason?: string; pages: number } | undefined>;
  refresh: () => Promise<void>;
  rerender: () => void;
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
const READMODE_KEY = "papiro.readMode";
const OCR_KEY = "papiro.ocrLang";
const LANG_KEY = "papiro.uiLang";
const THEME_KEY = "papiro.theme";
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
  const [uiLangPref, setUiLangPrefRaw] = useState<LangPref>(() => {
    const v = stored(LANG_KEY);
    return v === "pt" || v === "en" || v === "es" ? v : "auto";
  });
  const [systemLocale, setSystemLocale] = useState<string>(() => (typeof navigator !== "undefined" ? navigator.language : "en-US"));
  const systemLang = useMemo(() => resolveLang("auto", systemLocale), [systemLocale]);
  const lang = useMemo(() => resolveLang(uiLangPref, systemLocale), [uiLangPref, systemLocale]);
  const t = useCallback((key: I18nKey, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
  const langRef = useRef<UiLang>(lang);
  langRef.current = lang;
  const tRef = useRef(t);
  tRef.current = t;

  const setUiLang = useCallback((pref: LangPref) => {
    setUiLangPrefRaw(pref);
    store(LANG_KEY, pref);
  }, []);

  useEffect(() => {
    window.papiro.getSystemLocale().then((loc) => {
      if (loc) setSystemLocale(loc);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.lang = localeTag(lang);
    window.papiro.setUiLang(uiLangPref).catch(() => {});
  }, [lang, uiLangPref]);

  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [tabs, setTabs] = useState<TabItem[]>([]);
  const [theme, setThemeRaw] = useState<ThemePref>(() => {
    const v = stored(THEME_KEY);
    return v === "light" || v === "dark" ? v : "auto";
  });
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [homeOpen, setHomeOpen] = useState(false);
  const setTheme = useCallback((th: ThemePref) => {
    setThemeRaw(th);
    store(THEME_KEY, th);
  }, []);
  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<RGB>([1, 0.85, 0]);
  const [zoom, setZoomRaw] = useState(1);
  const [page, setPage] = useState(0);
  const [gotoSignal, setGotoSignal] = useState({ page: 0, n: 0 });
  const [view, setView] = useState<View>("read");
  const [layout, setLayoutRaw] = useState<Layout>(() => (stored(LAYOUT_KEY) === "double" ? "double" : "single"));
  const [readMode, setReadModeRaw] = useState<ReadMode>(() => {
    const v = stored(READMODE_KEY);
    return v === "sepia" || v === "dark" ? v : "normal";
  });
  const [measureScale, setMeasureScale] = useState(1);
  const [overlayImg, setOverlayImg] = useState<OverlayImage | null>(null);
  const [compareReport, setCompareReport] = useState<CompareReport | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [panel, setPanel] = useState<Panel>("pages");
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [search, setSearch] = useState<SearchState>({ query: "", hits: [], active: -1 });
  const [signature, setSignatureRaw] = useState<string | null>(() => stored(SIG_KEY));
  const [stamp, setStamp] = useState<Stamp | null>(null);
  const [ocrLang, setOcrLangRaw] = useState<string>(() => {
    const v = stored(OCR_KEY);
    return v && (OCR_LANG_VALUES as readonly string[]).includes(v) ? v : defaultOcrLang(lang);
  });
  // Se o usuário ainda não escolheu manualmente um idioma de OCR, acompanha o idioma resolvido do sistema
  useEffect(() => {
    if (!stored(OCR_KEY)) setOcrLangRaw(defaultOcrLang(lang));
  }, [lang]);

  const [ocrQuality, setOcrQualityRaw] = useState<"neural" | "best" | "fast">(() => {
    const v = stored("papiro.ocrQuality");
    return v === "best" || v === "fast" ? v : "neural";
  });
  const [ocrCleanup, setOcrCleanupRaw] = useState<boolean>(() => stored("papiro.ocrCleanup") !== "0");
  const [recoveryItems, setRecoveryItems] = useState<{ id: string; name: string; origPath: string | null; savedAt: number }[]>([]);
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
  const setOcrQuality = (q: "neural" | "best" | "fast") => { setOcrQualityRaw(q); store("papiro.ocrQuality", q); };
  const setOcrCleanup = (on: boolean) => { setOcrCleanupRaw(on); store("papiro.ocrCleanup", on ? "1" : "0"); };
  const setLayout = (l: Layout) => { setLayoutRaw(l); store(LAYOUT_KEY, l); };
  const setReadMode = (m: ReadMode) => { setReadModeRaw(m); store(READMODE_KEY, m); };

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
    catch (e) { notify(tRef.current("common.errorPrefix", { msg: errText(e) })); return undefined; }
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

  /** Força a re-renderização das páginas visíveis (ex.: ao alternar camadas OCG). */
  const rerender = useCallback(() => {
    setDoc((d) => (d ? { ...d, rev: ++revSeq.current } : d));
  }, []);

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
    setHomeOpen(false);
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
    setHomeOpen(false);
    if (docRef.current?.id === id) return;
    if (occupied()) { notify(tRef.current("state.busySwitchTab")); return; }
    const s = snaps.current.get(id);
    if (!s) return;
    tts.stop();
    stash();
    snaps.current.delete(id);
    show(s);
  }, [notify, stash, show]);

  const cycleTab = useCallback((d: number) => {
    const list = tabsRef.current;
    if (list.length < 2 || !docRef.current) return;
    const i = list.findIndex((x) => x.id === docRef.current!.id);
    switchTab(list[(i + d + list.length) % list.length].id);
  }, [switchTab]);

  const closeTab = useCallback(async (id: number) => {
    if (occupied()) { notify(tRef.current("state.busyCloseTab")); return; }
    const tab = tabsRef.current.find((x) => x.id === id);
    if (!tab) return;
    const dirty = docRef.current?.id === id ? docRef.current.info.dirty : tab.dirty;
    if (dirty && (await ask({
      kind: "confirm", title: tRef.current("state.unsavedTitle"), okLabel: tRef.current("state.unsavedOk"),
      message: tRef.current("state.unsavedMsg", { name: tab.name }),
    })) === null) return;
    const list = tabsRef.current;
    const i = list.findIndex((x) => x.id === id);
    const rest = list.filter((x) => x.id !== id);
    setTabs(rest);
    snaps.current.delete(id);
    if (docRef.current?.id === id) {
      tts.stop();
      const next = rest[Math.min(i, rest.length - 1)];
      const s = next ? snaps.current.get(next.id) : undefined;
      if (s) { snaps.current.delete(next!.id); show(s); }
      else {
        setEngineDoc(0);
        setDoc(null); setSearch({ query: "", hits: [], active: -1 }); setScanned([]); setSelectedPages([]); setView("read");
      }
    }
    disposeDoc(id).catch(() => {});
    window.papiro.recoveryDelete(`tab_${id}`).catch(() => {});
  }, [ask, notify, show]);

  /** O documento já está aberto no motor (`id`): mostra numa aba (nova ou a mesma, no caso de `adoptFile`). */
  const loaded = useCallback(async (id: number, name: string, path: string | null, info: DocInfo, keepPage?: number) => {
    // arquivos do disco entram nos recentes e reabrem na página em que estavam
    const last = path ? await window.papiro.recentAdd(path).catch(() => 0) : 0;
    const start = Math.max(0, Math.min(keepPage ?? last, info.pageCount - 1));
    if (docRef.current?.id !== id) stash();
    setTabs((ts) => ts.some((x) => x.id === id)
      ? ts.map((x) => (x.id === id ? { id, name, path, dirty: info.dirty } : x))
      : [...ts, { id, name, path, dirty: info.dirty }]);
    const first = info.pages[start];
    const z = first && keepPage === undefined ? Math.min(1.6, Math.max(0.5, (viewportWidth.current - 64) / first.width)) : cur.current.zoom;
    const sc = await engineAt(id).scannedPages().catch(() => [] as number[]);
    show({
      doc: { id, path, name, info, rev: ++revSeq.current, gen: ++revSeq.current },
      page: start, zoom: z, search: { query: "", hits: [], active: -1 }, scanned: sc, selectedPages: [], view: "read",
    });
    setTool((tl) => (tl === "hand" ? tl : "select"));
  }, [stash, show]);

  /** Abre bytes numa aba nova (pedindo a senha, se for o caso). Devolve o id da aba ou null se desistiu. */
  const openInNewTab = useCallback(async (f: InFile): Promise<number | null> => {
    const id = nextId.current++;
    const e = engineAt(id);
    try {
      let info = await e.open(f.bytes, baseName(f.name));
      if (await e.needsPassword()) {
        for (;;) {
          const pw = await ask({
            kind: "password",
            title: tRef.current("state.protectedTitle"),
            message: tRef.current("state.protectedMsg", { name: f.name }),
          });
          if (pw === null) { disposeDoc(id).catch(() => {}); return null; }
          try { info = await e.unlock(pw); break; } catch { notify(tRef.current("state.wrongPassword")); }
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
    const open = tabsRef.current.find((x) => samePath(x.path, f.path));
    if (open) { switchTab(open.id); return; }
    await task(tRef.current("state.opening"), () => openInNewTab(f));
  }, [task, openInNewTab, switchTab]);

  const openFile = useCallback(async (path?: string) => {
    if (path) {
      const open = tabsRef.current.find((x) => samePath(x.path, path));
      if (open) { switchTab(open.id); return; }
    }
    let f: InFile | undefined;
    try { f = path ? await window.papiro.readFile(path) : (await window.papiro.openDialog())[0]; }
    catch {
      notify(tRef.current("state.readErr", { target: path ?? tRef.current("state.theFile") }));
      if (path) window.papiro.recentRemove(path).catch(() => {});
      return;
    }
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
    await task(tRef.current("common.saving"), async () => {
      // Confere se o destino pode ser gravado ANTES de chamar engine.save()
      try { await window.papiro.checkWritable(target); }
      catch (e) {
        throw new Error(tRef.current("state.writeErr", { target, err: errText(e) }));
      }
      const bytes = await engine.save();
      const name = target.split(/[\\/]/).pop()!;
      try { await window.papiro.writeFile(target, bytes); }
      catch (e) {
        apply(await engine.markModified());
        throw new Error(tRef.current("state.writeErr", { target, err: errText(e) }));
      }
      await engine.setTitle(baseName(name));
      const info = await engine.info();
      setDoc((d) => (d ? { ...d, path: target, name, info, rev: ++revSeq.current } : d));
      await window.papiro.recentAdd(target).catch(() => 0);
      window.papiro.recentPage(target, page);
      window.papiro.recoveryDelete(`tab_${doc.id}`).catch(() => {});
      notify(tRef.current("state.savedIn", { target }));
    });
  }, [doc, task, notify, page, apply]);

  const mergeFiles = useCallback(async (given?: InFile[]) => {
    const files = given ?? await window.papiro.openDialog({ title: tRef.current("state.mergeTitle"), multi: true });
    if (files.length < 2) { if (files.length) notify(tRef.current("state.mergeNeedTwo")); return; }
    await task(tRef.current("state.merging"), async () => {
      const id = nextId.current++;
      const e = engineAt(id);
      const mergedName = tRef.current("state.mergedName");
      let info = await e.open(files[0].bytes, mergedName);
      if (await e.needsPassword()) {
        disposeDoc(id).catch(() => {});
        throw new Error(tRef.current("state.mergeProtectedErr", { name: files[0].name }));
      }
      const bookmarks: OutlineNode[] = [{ title: baseName(files[0].name), page: 0, children: [] }];
      try {
        for (const f of files.slice(1)) {
          const startPage = info.pageCount;
          try { info = await e.insertFromPdf(f.bytes, -1); }
          catch (err) { throw new Error(`“${f.name}”: ${errText(err)}`); }
          bookmarks.push({ title: baseName(f.name), page: startPage, children: [] });
        }
        if (bookmarks.length > 1) info = await e.setOutline(bookmarks);
      } finally {
        info = await e.info();
        await loaded(id, `${mergedName}.pdf`, null, info);
      }
      notify(tRef.current("state.mergedDone", { files: files.length, pages: info.pageCount }));
    });
  }, [task, loaded, notify]);

  const pickImages = async (given: InFile[] | undefined, title: string) =>
    given ?? await window.papiro.openDialog({ title, images: true, multi: true });

  const newFromImages = useCallback(async (given?: InFile[]) => {
    const files = await pickImages(given, tRef.current("state.imgOpenTitle"));
    if (!files.length) return;
    const v = await askForm({
      title: tRef.current("state.imgFormTitle"), okLabel: tRef.current("state.imgFormOk"),
      message: tRef.current("state.imgFormMsg", { n: files.length }),
      fields: [{ id: "page", label: tRef.current("state.imgPageSize"), type: "select", value: "A4", options: [
        { value: "A4", label: tRef.current("state.imgOptA4") },
        { value: "Carta", label: tRef.current("state.imgOptLetter") },
        { value: "imagem", label: tRef.current("state.imgOptOriginal") },
      ] }],
    });
    if (!v) return;
    await task(tRef.current("state.creatingPdf"), async () => {
      const imgs = await prepareImages(files, langRef.current);
      const id = nextId.current++;
      const imgTitle = tRef.current("state.imagesName");
      try {
        const info = await engineAt(id).imagesToPdf(imgs, { page: v.page as "A4" | "Carta" | "imagem" }, imgTitle);
        await loaded(id, `${imgTitle}.pdf`, null, info);
        notify(tRef.current("state.imgCreated", { n: info.pageCount }));
      } catch (err) { disposeDoc(id).catch(() => {}); throw err; }
    });
  }, [askForm, task, loaded, notify]);

  const insertImages = useCallback(async (given?: InFile[]) => {
    const d = docRef.current;
    if (!d) return;
    const files = await pickImages(given, tRef.current("state.insImgTitle"));
    if (!files.length) return;
    const at = given ? -1 : page + 1;
    const ok = await mutate(tRef.current("state.insertingImgs"), async () => engine.insertImages(await prepareImages(files, langRef.current), at, { page: "A4" }));
    if (ok) {
      notify(at < 0
        ? tRef.current("state.imgInsertedEnd", { n: files.length })
        : tRef.current("state.imgInsertedAfter", { n: files.length, page: page + 1 }));
    }
  }, [mutate, notify, page]);

  const openDropped = useCallback(async (dropped: File[]) => {
    if (occupied()) { notify(tRef.current("state.busyDrop")); return; }
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
      } else notify(tRef.current("state.dropInvalid"));
    } catch { notify(tRef.current("state.dropReadErr")); }
  }, [openData, mergeFiles, insertImages, newFromImages, notify]);

  const executePrint = useCallback(async (opts: PrintJobOptions) => {
    if (!docRef.current) return undefined;
    const id = engineDoc();
    const r = await task(tRef.current("state.printing"), () => window.papiro.print(id, opts));
    if (r && !r.ok && r.reason && !/cancel/i.test(r.reason)) notify(tRef.current("state.printErr", { reason: r.reason }));
    return r;
  }, [task, notify]);

  const printDoc = useCallback(async () => {
    if (!docRef.current) return;
    if (await window.papiro.isE2e().catch(() => false)) {
      const id = engineDoc();
      const r = await task(tRef.current("state.printing"), () => window.papiro.print(id));
      if (r && !r.ok && r.reason && !/cancel/i.test(r.reason)) notify(tRef.current("state.printErr", { reason: r.reason }));
      return;
    }
    setFileMenuOpen(false);
    setPrintOpen(true);
  }, [task, notify]);

  const undo = useCallback(() => mutate(tRef.current("state.undoing"), engine.undo), [mutate]);
  const redo = useCallback(() => mutate(tRef.current("state.redoing"), engine.redo), [mutate]);

  const runSearch = useCallback(async (q: string) => {
    if (!doc) return;
    const hits = (await task(tRef.current("state.searching"), () => engine.search(q))) ?? [];
    setSearch({ query: q, hits, active: hits.length ? 0 : -1 });
    if (hits.length) goTo(hits[0].page);
    else if (q.trim()) notify(tRef.current("state.noResults"));
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
      pages = await engine.scannedPages().catch(() => [] as number[]);
      setScanned(pages);
      if (!pages.length) { notify(tRef.current("state.noScanned")); return; }
    } else {
      const n = docRef.current.info.pageCount;
      pages = which.filter((p) => p >= 0 && p < n);
    }
    if (!pages.length) return;
    const opts = ocrLangOptions(langRef.current);
    const ocrLabel = opts.find((l) => l.value === ocrLang)?.label ?? ocrLang;
    setOcrProgress({ done: 0, total: pages.length });
    const off = window.papiro.onOcrProgress((p) => setOcrProgress({ done: p.done, total: p.total }));
    try {
      const quality = tRef.current(
        ocrQuality === "neural" ? "state.ocrQualNeural" : ocrQuality === "best" ? "state.ocrQualBest" : "state.ocrQualFast",
      );
      const r = await task(
        tRef.current("state.ocrTask", { lang: ocrLabel.toLowerCase(), quality, n: pages.length }),
        () => engine.ocrPages(pages, ocrLang, 300, ocrQuality, ocrCleanup),
      );
      if (r) {
        apply(r.info);
        const extrasList = [
          r.oriented ? tRef.current("state.ocrOriented", { n: r.oriented }) : "",
          r.deskewed ? tRef.current("state.ocrDeskewed", { n: r.deskewed }) : "",
          r.enhanced ? tRef.current("state.ocrEnhanced", { n: r.enhanced }) : "",
        ].filter(Boolean).join(", ");
        notify(tRef.current("state.ocrDone", { words: r.words, extras: extrasList ? ` (${extrasList})` : "" }));
      } else if (docRef.current) {
        try { apply(await engine.info()); } catch { /* documento fechado */ }
      }
      await refreshScanned();
    } finally { off(); setOcrProgress(null); }
  }, [task, apply, notify, refreshScanned, ocrLang, ocrQuality, ocrCleanup]);

  // a aba da frente mostra na barra o nome e se há alterações
  useEffect(() => {
    if (!doc) return;
    setTabs((ts) => {
      const tab = ts.find((x) => x.id === doc.id);
      if (!tab || (tab.name === doc.name && tab.path === doc.path && tab.dirty === doc.info.dirty)) return ts;
      return ts.map((x) => (x.id === doc.id ? { ...x, name: doc.name, path: doc.path, dirty: doc.info.dirty } : x));
    });
  }, [doc]);

  // título da janela e aviso de alterações não salvas (de qualquer aba)
  useEffect(() => {
    const anyDirty = !!doc?.info.dirty || tabs.some((x) => x.dirty && x.id !== doc?.id);
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
    const tm = window.setTimeout(() => window.papiro.recentPage(docPath, page), 600);
    return () => window.clearTimeout(tm);
  }, [docPath, page]);

  // andamento de operações longas do motor (impressão, exportações)
  useEffect(() => window.papiro.onProgress((p) => setProgress({ done: p.done, total: p.total })), []);

  // arquivo passado na linha de comando, e PDFs abertos pelo Explorer com o Papiro já aberto
  const openRef = useRef(openFile);
  openRef.current = openFile;
  useEffect(() => {
    window.papiro.takePendingPath().then((p) => { if (p) openRef.current(p); });
    return window.papiro.onOpenPath((p) => {
      if (occupied()) { notify(tRef.current("state.busyOpenExternal", { name: p.split(/[\\/]/).pop() ?? p })); return; }
      openRef.current(p);
    });
  }, [notify]);

  // verificação inicial de rascunhos de recuperação (após falha inesperada)
  useEffect(() => {
    window.papiro.recoveryList().then((list) => { if (list.length) setRecoveryItems(list); }).catch(() => {});
  }, []);

  // auto-save offline periódico (a cada 45s) para documentos com alterações não salvas
  useEffect(() => {
    if (!doc?.info.dirty) return;
    const tm = window.setInterval(async () => {
      const d = docRef.current;
      if (!d || !d.info.dirty || busyRef.current > 0) return;
      try {
        const bytes = await engineAt(d.id).peekBytes();
        if (bytes.length <= 25_000_000) {
          await window.papiro.recoverySave({ id: `tab_${d.id}`, name: d.name, origPath: d.path, bytes });
        }
      } catch { /* ignora erro pontual de auto-save */ }
    }, 45_000);
    return () => window.clearInterval(tm);
  }, [doc?.id, doc?.info.dirty]);

  const restoreRecovery = useCallback(async () => {
    const list = recoveryItems;
    setRecoveryItems([]);
    for (const item of list) {
      const data = await window.papiro.recoveryLoad(item.id).catch(() => null);
      if (data) await openData({ path: null, name: data.name, bytes: data.bytes });
    }
    await window.papiro.recoveryClear().catch(() => {});
    notify(tRef.current("state.recoveryRestored", { n: list.length }));
  }, [recoveryItems, openData, notify]);

  const dismissRecovery = useCallback(async () => {
    setRecoveryItems([]);
    await window.papiro.recoveryClear().catch(() => {});
  }, []);

  const value = useMemo<Ctx>(() => ({
    uiLangPref, lang, systemLang, setUiLang, t,
    theme, setTheme, fileMenuOpen, setFileMenuOpen, printOpen, setPrintOpen, homeOpen, setHomeOpen,
    doc, tabs, switchTab, closeTab, cycleTab, tool, setTool, color, setColor, zoom, setZoom, page, setPage, goTo, gotoSignal,
    view, setView, layout, setLayout, readMode, setReadMode, measureScale, setMeasureScale,
    overlayImg, setOverlayImg, compareReport, setCompareReport, fullscreen, toggleFullScreen,
    panel, setPanel, selectedPages, setSelectedPages, search, runSearch, stepSearch, signature, setSignature,
    stamp, setStamp, ocrLang, setOcrLang, ocrQuality, setOcrQuality, ocrCleanup, setOcrCleanup,
    recoveryItems, restoreRecovery, dismissRecovery, busy, toast, notify, progress, scanned, ocrProgress, dialog, closeDialog, ask, askForm,
    openFile, openData, adoptFile, openDropped, save, mergeFiles, newFromImages, insertImages, printDoc, executePrint, refresh, rerender,
    undo, redo, mutate, task, runOcr, fitWidth, viewportWidth,
  }), [uiLangPref, lang, systemLang, setUiLang, t, theme, setTheme, fileMenuOpen, printOpen, homeOpen, doc, tabs, switchTab, closeTab, cycleTab, tool, color, zoom, setZoom, page, goTo, gotoSignal, view, layout,
    readMode, measureScale, overlayImg, compareReport, fullscreen,
    toggleFullScreen, panel, selectedPages, search, runSearch, stepSearch, signature, stamp, ocrLang, ocrQuality, ocrCleanup,
    recoveryItems, restoreRecovery, dismissRecovery, busy, toast, notify,
    progress, scanned, ocrProgress, dialog, ask, askForm, openFile, openData, adoptFile, openDropped, save, mergeFiles,
    newFromImages, insertImages, printDoc, executePrint, refresh, rerender, undo, redo, mutate, task, runOcr, fitWidth]); // eslint-disable-line react-hooks/exhaustive-deps

  return <C.Provider value={value}>{children}</C.Provider>;
}
