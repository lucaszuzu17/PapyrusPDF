import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import createEngineWorker from "./engine-worker.ts?nodeWorker";
import { markdownToHtml } from "./markdown.ts";
import { resolveLang, translate, type I18nKey, type LangPref, type UiLang } from "../shared/i18n.ts";

let uiLangPref: LangPref = "auto";
const curLang = (): UiLang => resolveLang(uiLangPref, app.getLocale());
const mt = (key: I18nKey, vars?: Record<string, string | number>) => translate(curLang(), key, vars);

const here = dirname(fileURLToPath(import.meta.url));

// Testes de ponta a ponta: só quando PAPIRO_E2E aponta para um roteiro (nunca em uso normal).
// No app instalado exige também PAPIRO_E2E_PACKAGED=1, para testar o próprio build.
const e2eScript = process.env.PAPIRO_E2E && (!app.isPackaged || process.env.PAPIRO_E2E_PACKAGED === "1") ? process.env.PAPIRO_E2E : null;
// Os testes usam um perfil próprio: não mexem nos recentes nem na assinatura do usuário,
// e não disputam a trava de instância única com um Papiro que esteja aberto.
if (e2eScript) app.setPath("userData", join(tmpdir(), "papiro-e2e-perfil"));
else {
  // O programa se chamava "Papiro PDF": na primeira abertura com o nome novo, traz o perfil antigo
  // (recentes, assinatura salva, preferências). Tem de ser antes da trava de instância, que cria a pasta.
  const now = app.getPath("userData"), old = join(app.getPath("appData"), "Papiro PDF");
  try {
    if (!existsSync(now) && existsSync(old)) {
      cpSync(old, now, { recursive: true, filter: (src) => !/[\\/](lockfile|SingletonLock|SingletonCookie|SingletonSocket)$/.test(src) });
    }
  } catch (e) { console.error("[perfil]", e); }
}

/** Respostas prontas para os diálogos nativos e para a impressão (só nos testes). */
const hooks = {
  open: [] as string[][],
  save: [] as (string | null)[],
  folder: [] as (string | null)[],
  printTo: null as string | null,
};

const pdfArg = (argv: string[], cwd = process.cwd()): string | null => {
  const a = argv.slice(1).find((x) => !x.startsWith("--") && extname(x).toLowerCase() === ".pdf");
  return a ? resolve(cwd, a) : null;
};

let win: BrowserWindow | null = null;
let dirty = false;
let pendingPath: string | null = pdfArg(process.argv);
let rendererReady = false; // a interface já está escutando "open-path"?

// Uma janela só: abrir outro PDF pelo Explorer reaproveita o Papiro que já está aberto.
const first = app.requestSingleInstanceLock();
if (!first) app.quit();
app.on("second-instance", (_e, argv, cwd) => {
  const p = pdfArg(argv, cwd);
  if (!win) {
    // ainda iniciando (ou sem janela): o arquivo fica guardado para quando a interface pedir
    if (p) pendingPath = p;
    if (app.isReady()) createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (!p) return;
  if (rendererReady) win.webContents.send("open-path", p);
  else pendingPath = p; // a interface ainda está carregando: ela busca o arquivo ao ficar pronta
});

// ---------- thread do motor ----------
const worker = first ? createEngineWorker({ workerData: { ocrCache: join(app.getPath("userData"), "ocr-cache") } }) : null;
let seq = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
worker?.on("message", (msg: any) => {
  if (msg.event) { win?.webContents.send(msg.event, msg.data); return; }
  const w = waiting.get(msg.id);
  if (!w) return;
  waiting.delete(msg.id);
  if (msg.error) w.reject(new Error(msg.error)); else w.resolve(msg.result);
});
// Se a thread do motor cair, quem esperava resposta é avisado (em vez de girar para sempre).
let engineDead: string | null = null;
const engineFailed = (why: unknown) => {
  if (why) console.error("[motor]", why);
  engineDead = mt("main.engineDead");
  for (const w of waiting.values()) w.reject(new Error(engineDead));
  waiting.clear();
};
worker?.on("error", engineFailed);
worker?.on("exit", () => engineFailed(null));
/** Aba em primeiro plano (a interface avisa a cada troca); é o documento padrão das chamadas. */
let activeDoc = 0;
const callEngine = (method: string, args: unknown[], doc = activeDoc) =>
  new Promise((resolve, reject) => {
    if (!worker) return reject(new Error(mt("main.engineUnavailable")));
    if (engineDead) return reject(new Error(engineDead));
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, doc, method, args });
  });

// ---------- arquivos recentes ----------
interface Recent { path: string; name: string; page: number; when: number }
const recentFile = () => join(app.getPath("userData"), "recentes.json");
let recents: Recent[] | null = null;
const loadRecents = (): Recent[] => {
  if (recents) return recents;
  try {
    const raw = JSON.parse(readFileSync(recentFile(), "utf8"));
    recents = Array.isArray(raw) ? raw.filter((r) => r && typeof r.path === "string") : [];
  } catch { recents = []; }
  return recents!;
};
const saveRecents = () => {
  try { writeFileSync(recentFile(), JSON.stringify(recents ?? [], null, 1)); } catch (e) { console.error("[recentes]", e); }
};
const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
// cada execução de teste começa sem recentes (senão o arquivo reabriria na página da execução anterior)
if (e2eScript && first) rmSync(recentFile(), { force: true });

// ---------- janela ----------
function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "PapyrusPDF",
    backgroundColor: "#1f2329",
    show: false,
    webPreferences: {
      preload: join(here, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload em ESM
    },
  });
  Menu.setApplicationMenu(null);
  win.once("ready-to-show", () => win?.show());
  win.on("close", (e) => {
    if (!dirty || !win || e2eScript) return;
    const r = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: [mt("main.quitBtnLeave"), mt("main.quitBtnCancel")],
      defaultId: 1,
      cancelId: 1,
      message: mt("main.quitMessage"),
      detail: mt("main.quitDetail"),
    });
    if (r === 1) e.preventDefault();
  });
  // tela cheia: a interface esconde as barras; sair pelo Esc ou pelo Windows também avisa
  win.on("enter-full-screen", () => win?.webContents.send("fullscreen", true));
  win.on("leave-full-screen", () => win?.webContents.send("fullscreen", false));
  win.on("closed", () => { win = null; rendererReady = false; });
  win.webContents.on("did-start-loading", () => { rendererReady = false; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Soltar um arquivo na janela não pode trocar a interface pelo arquivo.
  win.webContents.on("will-navigate", (e, url) => { if (url !== win?.webContents.getURL()) e.preventDefault(); });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(here, "../renderer/index.html"));

  if (e2eScript) {
    win.webContents.once("did-finish-load", async () => {
      try {
        const mod = await import(pathToFileURL(e2eScript).href);
        await mod.default(win!, { callEngine, hooks, userData: app.getPath("userData") });
      } catch (err) {
        console.error("[e2e] FALHOU:", err);
        process.exitCode = 1;
      }
      app.exit(Number(process.exitCode ?? 0));
    });
  }
}

// ---------- IPC ----------
ipcMain.handle("engine", (_e, doc: number, method: string, args: unknown[]) => callEngine(method, args, doc));

const IMAGE_EXT = ["png", "jpg", "jpeg", "bmp", "gif", "webp"];
const fileData = async (p: string) => ({ path: p, name: basename(p), bytes: new Uint8Array(await readFile(p)) });

ipcMain.handle("get-locale", () => app.getLocale());
ipcMain.handle("set-lang", (_e, pref: LangPref) => {
  uiLangPref = pref === "pt" || pref === "en" || pref === "es" ? pref : "auto";
});

ipcMain.handle("open-dialog", async (_e, opts: { title?: string; images?: boolean; multi?: boolean; anyFile?: boolean; pfx?: boolean; webDoc?: boolean }) => {
  if (e2eScript && hooks.open.length) return Promise.all(hooks.open.shift()!.map(fileData));
  const filters = opts?.pfx
    ? [{ name: mt("main.filterPfx"), extensions: ["pfx", "p12"] }]
    : opts?.webDoc
      ? [{ name: mt("main.filterWebDoc"), extensions: ["html", "htm", "md", "markdown"] }]
      : opts?.anyFile
        ? [{ name: mt("main.filterAny"), extensions: ["*"] }]
        : opts?.images
          ? [{ name: mt("main.filterImages"), extensions: IMAGE_EXT }]
          : [{ name: mt("main.filterPdf"), extensions: ["pdf"] }];
  const r = await dialog.showOpenDialog(win!, {
    title: opts?.title ?? mt("main.openTitle"),
    properties: opts?.multi ? ["openFile", "multiSelections"] : ["openFile"],
    filters,
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(fileData));
});

ipcMain.handle("read-file", (_e, path: string) => fileData(path));

const saveFilter = (kind: string): Electron.FileFilter => {
  const map: Record<string, Electron.FileFilter> = {
    pdf: { name: mt("main.filterPdf"), extensions: ["pdf"] },
    png: { name: mt("main.filterPng"), extensions: ["png"] },
    jpg: { name: mt("main.filterJpg"), extensions: ["jpg"] },
    docx: { name: mt("main.filterDocx"), extensions: ["docx"] },
    txt: { name: mt("main.filterTxt"), extensions: ["txt"] },
    csv: { name: mt("main.filterCsv"), extensions: ["csv"] },
    md: { name: mt("main.filterMd"), extensions: ["md"] },
    any: { name: mt("main.filterAny"), extensions: ["*"] },
  };
  return map[kind] ?? map.pdf;
};
const saveTitle = (kind: string): string => {
  const map: Record<string, I18nKey> = {
    pdf: "main.saveTitlePdf", png: "main.saveTitleImg", jpg: "main.saveTitleImg",
    docx: "main.saveTitleDocx", txt: "main.saveTitleTxt", csv: "main.saveTitleCsv",
    md: "main.saveTitleMd", any: "main.saveTitleAny",
  };
  return mt(map[kind] ?? "main.saveTitleDefault");
};

ipcMain.handle("save-dialog", async (_e, suggested: string, kind = "pdf") => {
  if (e2eScript && hooks.save.length) return hooks.save.shift()!;
  const r = await dialog.showSaveDialog(win!, {
    title: saveTitle(kind),
    defaultPath: suggested,
    filters: [saveFilter(kind)],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle("folder-dialog", async () => {
  if (e2eScript && hooks.folder.length) return hooks.folder.shift()!;
  const r = await dialog.showOpenDialog(win!, { title: mt("main.folderTitle"), properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("check-writable", async (_e, path: string) => {
  if (existsSync(path)) {
    const fh = await open(path, "r+");
    await fh.close();
    return true;
  }
  const probe = `${path}.papiro-${process.pid}-${Date.now()}.probe`;
  await writeFile(probe, new Uint8Array());
  await rm(probe, { force: true }).catch(() => {});
  return true;
});

ipcMain.handle("write-file", async (_e, path: string, bytes: Uint8Array) => {
  // Gravação atômica via arquivo temporário na mesma pasta para nunca corromper o PDF em caso de falha
  const tmp = `${path}.papiro-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, path);
    return true;
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
});

ipcMain.handle("join-path", (_e, ...parts: string[]) => join(...parts));

ipcMain.on("state", (_e, s: { dirty: boolean; title: string; doc: number }) => {
  dirty = s.dirty;
  activeDoc = s.doc;
  win?.setTitle(s.title);
});

ipcMain.handle("set-fullscreen", (_e, on: boolean) => { win?.setFullScreen(!!on); return win?.isFullScreen() ?? false; });

// A interface chama isto logo depois de começar a escutar "open-path".
ipcMain.handle("take-pending-path", () => { rendererReady = true; const p = pendingPath; pendingPath = null; return p; });

ipcMain.handle("show-in-folder", (_e, path: string) => { shell.showItemInFolder(path); });
ipcMain.handle("open-external", (_e, url: string) => {
  if (/^(https?:\/\/|mailto:)/i.test(url)) return shell.openExternal(url);
  return false;
});

// --- recentes ---
// Não confere se os arquivos existem: um caminho de rede fora do ar travaria a abertura do
// aplicativo por vários segundos, e um pendrive desconectado perderia a página lembrada.
// Arquivo que sumiu é tratado quando o usuário clica nele.
ipcMain.handle("recent-list", () => loadRecents());
ipcMain.handle("recent-add", (_e, path: string) => {
  const list = loadRecents();
  const old = list.find((r) => samePath(r.path, path));
  recents = [{ path, name: basename(path), page: old?.page ?? 0, when: Date.now() }, ...list.filter((r) => r !== old)].slice(0, 12);
  saveRecents();
  if (!e2eScript) app.addRecentDocument(path);
  return recents[0].page;
});
ipcMain.on("recent-page", (_e, path: string, page: number) => {
  const r = loadRecents().find((x) => samePath(x.path, path));
  if (r && r.page !== page && Number.isInteger(page) && page >= 0) { r.page = page; saveRecents(); }
});
ipcMain.handle("recent-remove", (_e, path: string) => {
  recents = loadRecents().filter((r) => !samePath(r.path, path));
  saveRecents();
  return recents;
});
ipcMain.handle("recent-clear", () => {
  recents = [];
  saveRecents();
  if (!e2eScript) app.clearRecentDocuments();
  return recents;
});

// --- HTML / Markdown → PDF (100% offline via Chromium embutido do Electron) ---
ipcMain.handle("convert-to-pdf", async (_e, opts: { path: string; pageSize?: "A4" | "Letter"; landscape?: boolean }) => {
  const srcPath = opts.path;
  const ext = extname(srcPath).toLowerCase();
  const baseName = basename(srcPath, ext);
  const dir = await mkdtemp(join(tmpdir(), "papiro-html2pdf-"));
  let bw: BrowserWindow | null = null;
  try {
    const offSes = session.fromPartition(`papiro-offline-${Date.now()}`, { cache: false });
    // Bloqueia absolutamente qualquer requisição externa (http/https/ws) para manter 100% offline
    offSes.webRequest.onBeforeRequest((details, cb) => {
      if (/^(https?|wss?):/i.test(details.url)) cb({ cancel: true });
      else cb({});
    });
    bw = new BrowserWindow({
      show: false,
      webPreferences: { session: offSes, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
    });
    if (ext === ".md" || ext === ".markdown") {
      const md = await readFile(srcPath, "utf8");
      const htmlPath = join(dir, "doc.html");
      await writeFile(htmlPath, markdownToHtml(md, baseName), "utf8");
      await bw.loadFile(htmlPath);
    } else {
      await bw.loadFile(srcPath);
    }
    const pdfBuf = await bw.webContents.printToPDF({
      pageSize: opts.pageSize ?? "A4",
      landscape: !!opts.landscape,
      printBackground: true,
    });
    return { name: `${baseName}.pdf`, bytes: new Uint8Array(pdfBuf) };
  } finally {
    if (bw && !bw.isDestroyed()) bw.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// --- recuperação de sessão após falha (auto-save offline) ---
interface RecoveryEntry { id: string; name: string; origPath: string | null; savedAt: number; file: string }
const recoveryDir = () => join(app.getPath("userData"), "recovery");
const recoveryIndex = () => join(recoveryDir(), "index.json");
const readRecoveryList = (): RecoveryEntry[] => {
  try {
    const raw = JSON.parse(readFileSync(recoveryIndex(), "utf8"));
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.file === "string" && existsSync(join(recoveryDir(), e.file))) : [];
  } catch { return []; }
};
const writeRecoveryList = (list: RecoveryEntry[]) => {
  try {
    mkdirSync(recoveryDir(), { recursive: true });
    writeFileSync(recoveryIndex(), JSON.stringify(list, null, 1));
  } catch { /* ignora erro de disco */ }
};

ipcMain.handle("recovery-list", () => {
  if (e2eScript) return [];
  return readRecoveryList().map(({ id, name, origPath, savedAt }) => ({ id, name, origPath, savedAt }));
});
ipcMain.handle("recovery-save", async (_e, entry: { id: string; name: string; origPath: string | null; bytes: Uint8Array }) => {
  if (e2eScript) return false;
  mkdirSync(recoveryDir(), { recursive: true });
  const safe = entry.id.replace(/[^A-Za-z0-9_-]/g, "_");
  const file = `${safe}.pdf`;
  const target = join(recoveryDir(), file);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, entry.bytes);
  await rename(tmp, target);
  const list = readRecoveryList().filter((x) => x.id !== entry.id);
  list.push({ id: entry.id, name: entry.name, origPath: entry.origPath, savedAt: Date.now(), file });
  writeRecoveryList(list);
  return true;
});
ipcMain.handle("recovery-load", async (_e, id: string) => {
  const item = readRecoveryList().find((x) => x.id === id);
  if (!item) return null;
  const bytes = new Uint8Array(await readFile(join(recoveryDir(), item.file)));
  return { name: item.name, origPath: item.origPath, bytes };
});
ipcMain.handle("recovery-delete", (_e, id: string) => {
  const list = readRecoveryList();
  const hit = list.find((x) => x.id === id);
  if (hit) rmSync(join(recoveryDir(), hit.file), { force: true });
  writeRecoveryList(list.filter((x) => x.id !== id));
  return true;
});
ipcMain.handle("recovery-clear", () => {
  rmSync(recoveryDir(), { recursive: true, force: true });
  return true;
});

// --- impressão ---
// As páginas viram SVG vetorial (ou PNG para scans gigantes) numa janela oculta e o Chromium abre o diálogo de impressão.
const printDirs = new Set<string>(); // pastas temporárias de impressões em andamento
ipcMain.handle("print", async (_e, doc: number, pages?: number[]) => {
  const dir = await mkdtemp(join(tmpdir(), "papiro-print-"));
  printDirs.add(dir);
  let pw: BrowserWindow | null = null;
  try {
    const total = pages?.length ?? ((await callEngine("info", [], doc)) as { pageCount: number }).pageCount;
    const dpi = total > 80 ? 150 : 200;
    const sheets = (await callEngine("printFiles", [dir, dpi, pages], doc)) as { name: string; w: number; h: number; vector?: boolean }[];
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>PapyrusPDF</title><style>
html, body { height: 100%; margin: 0; padding: 0; background: #fff; }
.p { height: 100%; width: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; break-after: page; break-inside: avoid; }
.p:last-child { break-after: auto; }
img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
</style></head><body>${sheets.map((s) =>
      // tamanho real da página; SVG preserva vetores e texto nítidos na impressora
      `<div class="p"><img src="${s.name}" style="width:${s.w.toFixed(3)}in;height:${s.h.toFixed(3)}in"></div>`).join("")}</body></html>`;
    await writeFile(join(dir, "index.html"), html);
    // filha da janela principal: fechar o Papiro encerra a impressão, em vez de deixar um processo invisível
    pw = new BrowserWindow({ show: false, parent: win ?? undefined, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await pw.loadFile(join(dir, "index.html"));
    if (e2eScript && hooks.printTo) {
      const m = 0.2; // polegadas, parecido com a área imprimível de uma impressora comum
      const pdf = await pw.webContents.printToPDF({ pageSize: "A4", printBackground: true, margins: { top: m, bottom: m, left: m, right: m } });
      await writeFile(hooks.printTo, pdf);
      return { ok: true, pages: sheets.length };
    }
    const r = await new Promise<{ ok: boolean; reason?: string }>((done) =>
      pw!.webContents.print({ silent: false, printBackground: true, margins: { marginType: "printableArea" } },
        (ok, reason) => done({ ok, reason })));
    return { ...r, pages: sheets.length };
  } finally {
    // quando o retorno chega o trabalho já foi entregue ao Windows: as imagens das páginas
    // (que podem ser de um documento protegido) saem do disco na hora
    if (pw && !pw.isDestroyed()) pw.destroy();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    printDirs.delete(dir);
  }
});
app.on("will-quit", () => {
  for (const d of printDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* fica para a limpeza da próxima abertura */ } }
});

/** Remove sobras de impressões antigas (se o app fechou antes da limpeza). */
function cleanPrintLeftovers(): void {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith("papiro-print-")) continue;
      const p = join(tmpdir(), name);
      if (Date.now() - statSync(p).mtimeMs > 3_600_000) rmSync(p, { recursive: true, force: true });
    }
  } catch { /* pasta temporária indisponível: nada a limpar */ }
}

if (first) {
  app.whenReady().then(() => {
    // Sem corretor ortográfico: sem ele o Electron baixaria um dicionário da internet quando o
    // Windows não tem corretor para o idioma. Assim o programa não faz nenhuma conexão.
    session.defaultSession.setSpellCheckerEnabled(false);
    session.defaultSession.setSpellCheckerLanguages([]);
    createWindow();
    cleanPrintLeftovers();
  });
  app.on("window-all-closed", () => {
    // Encerramento limpo: descarta rascunhos de recuperação automática
    if (!e2eScript) rmSync(recoveryDir(), { recursive: true, force: true });
    worker?.terminate();
    app.quit();
  });
}
