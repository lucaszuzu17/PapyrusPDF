import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import createEngineWorker from "./engine-worker.ts?nodeWorker";

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
  engineDead = "O motor de PDF parou de funcionar. Feche o PapyrusPDF e abra o arquivo de novo; o que não tinha sido salvo se perdeu.";
  for (const w of waiting.values()) w.reject(new Error(engineDead));
  waiting.clear();
};
worker?.on("error", engineFailed);
worker?.on("exit", () => engineFailed(null));
/** Aba em primeiro plano (a interface avisa a cada troca); é o documento padrão das chamadas. */
let activeDoc = 0;
const callEngine = (method: string, args: unknown[], doc = activeDoc) =>
  new Promise((resolve, reject) => {
    if (!worker) return reject(new Error("Motor indisponível."));
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
      buttons: ["Sair sem salvar", "Cancelar"],
      defaultId: 1,
      cancelId: 1,
      message: "Há documentos com alterações não salvas.",
      detail: "Se sair agora, as alterações feitas desde o último salvamento serão perdidas.",
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

ipcMain.handle("open-dialog", async (_e, opts: { title?: string; images?: boolean; multi?: boolean }) => {
  if (e2eScript && hooks.open.length) return Promise.all(hooks.open.shift()!.map(fileData));
  const r = await dialog.showOpenDialog(win!, {
    title: opts?.title ?? "Abrir PDF",
    properties: opts?.multi ? ["openFile", "multiSelections"] : ["openFile"],
    filters: opts?.images
      ? [{ name: "Imagens", extensions: IMAGE_EXT }]
      : [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(fileData));
});

ipcMain.handle("read-file", (_e, path: string) => fileData(path));

const SAVE_FILTERS: Record<string, Electron.FileFilter> = {
  pdf: { name: "PDF", extensions: ["pdf"] },
  png: { name: "Imagem PNG", extensions: ["png"] },
  jpg: { name: "Imagem JPEG", extensions: ["jpg"] },
  docx: { name: "Documento do Word", extensions: ["docx"] },
  txt: { name: "Texto", extensions: ["txt"] },
};
const SAVE_TITLES: Record<string, string> = { pdf: "Salvar PDF", png: "Salvar imagem", jpg: "Salvar imagem", docx: "Salvar como Word", txt: "Salvar como texto" };

ipcMain.handle("save-dialog", async (_e, suggested: string, kind = "pdf") => {
  if (e2eScript && hooks.save.length) return hooks.save.shift()!;
  const r = await dialog.showSaveDialog(win!, {
    title: SAVE_TITLES[kind] ?? "Salvar",
    defaultPath: suggested,
    filters: [SAVE_FILTERS[kind] ?? SAVE_FILTERS.pdf],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle("folder-dialog", async () => {
  if (e2eScript && hooks.folder.length) return hooks.folder.shift()!;
  const r = await dialog.showOpenDialog(win!, { title: "Escolher pasta", properties: ["openDirectory", "createDirectory"] });
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

// --- impressão ---
// As páginas viram imagens numa janela oculta e o Chromium abre o diálogo de impressão do Windows.
const printDirs = new Set<string>(); // pastas temporárias de impressões em andamento
ipcMain.handle("print", async (_e, doc: number, pages?: number[]) => {
  const dir = await mkdtemp(join(tmpdir(), "papiro-print-"));
  printDirs.add(dir);
  let pw: BrowserWindow | null = null;
  try {
    const total = pages?.length ?? ((await callEngine("info", [], doc)) as { pageCount: number }).pageCount;
    const dpi = total > 80 ? 150 : 200;
    const sheets = (await callEngine("printFiles", [dir, dpi, pages], doc)) as { name: string; w: number; h: number }[];
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>PapyrusPDF</title><style>
html, body { height: 100%; margin: 0; padding: 0; background: #fff; }
.p { height: 100%; width: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; break-after: page; break-inside: avoid; }
.p:last-child { break-after: auto; }
img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
</style></head><body>${sheets.map((s) =>
      // tamanho real da página; se não couber na folha, encolhe mantendo a proporção
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
  app.on("window-all-closed", () => { worker?.terminate(); app.quit(); });
}
