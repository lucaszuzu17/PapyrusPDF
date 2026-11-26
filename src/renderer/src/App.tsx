import { useEffect, useRef, useState } from "react";
import type { I18nKey } from "../../shared/i18n.ts";
import { Dialogs } from "./Dialogs.tsx";
import { FileBackstage } from "./FileBackstage.tsx";
import { Icon } from "./icons.tsx";
import { Organizer } from "./Organizer.tsx";
import { Ribbon } from "./Ribbon.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { AppProvider, useApp, type Tool } from "./state.tsx";
import { tts, type TtsState } from "./tts.ts";
import { Viewer, Welcome } from "./Viewer.tsx";

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

const HINT_KEY: Record<Tool, I18nKey> = {
  select: "hint.select",
  hand: "hint.hand",
  highlight: "hint.highlight",
  underline: "hint.underline",
  strikeout: "hint.strikeout",
  note: "hint.note",
  freetext: "hint.freetext",
  ink: "hint.ink",
  rect: "hint.rect",
  ellipse: "hint.ellipse",
  line: "hint.line",
  arrow: "hint.arrow",
  signature: "hint.signature",
  stamp: "hint.stamp",
  redact: "hint.redact",
  edittext: "hint.edittext",
  addtext: "hint.addtext",
  overlayimg: "hint.overlayimg",
  measure: "hint.measure",
  link: "hint.link",
  addfield: "hint.addfield",
};

function Shell() {
  const app = useApp();
  const [ttsState, setTtsState] = useState<TtsState>(() => tts.snapshot());
  useEffect(() => tts.subscribe(setTtsState), []);
  useShortcuts();
  const dropping = useFileDrop();
  const prog = app.ocrProgress ?? app.progress;
  const fs = app.fullscreen;
  return (
    <div className={fs ? "app fullscreen" : "app"}>
      {!fs && <Ribbon />}
      {!fs && <TabBar />}
      {!fs && app.recoveryItems.length > 0 && (
        <div className="banner">
          <Icon name="clock" size={18} />
          <span>{app.t("app.recoveryBanner", { n: app.recoveryItems.length, names: app.recoveryItems.map((x) => x.name).join(", ") })}</span>
          <button onClick={() => app.dismissRecovery()}>{app.t("app.discard")}</button>
          <button className="primary" disabled={!!app.busy} onClick={() => app.restoreRecovery()}>{app.t("app.restore")}</button>
        </div>
      )}
      {!fs && ttsState.active && (
        <div className="banner tts-bar">
          <Icon name="speak" size={18} />
          <span>{app.t("app.ttsReading", { n: ttsState.page + 1, paused: ttsState.paused ? app.t("app.ttsPaused") : "" })}</span>
          <label className="scale-pick">
            {app.t("app.ttsSpeed")}
            <select value={String(ttsState.rate)} onChange={(e) => tts.setRate(Number(e.target.value))}>
              {[0.8, 1, 1.25, 1.5, 1.75].map((r) => <option key={r} value={r}>{r}×</option>)}
            </select>
          </label>
          <button onClick={() => tts.togglePause()}><Icon name={ttsState.paused ? "speak" : "pause"} size={14} /> {ttsState.paused ? app.t("app.ttsResume") : app.t("app.ttsPause")}</button>
          <button className="primary" onClick={() => tts.stop()}><Icon name="stop" size={14} /> {app.t("app.ttsStop")}</button>
        </div>
      )}
      {!fs && app.doc && app.scanned.length > 0 && !app.ocrProgress && (
        <div className="banner">
          <Icon name="ocr" size={18} />
          {app.scanned.length === app.doc.info.pageCount
            ? app.t("app.scannedAll")
            : app.t("app.scannedSome", { n: app.scanned.length })}
          <button className="primary" disabled={!!app.busy} onClick={() => app.runOcr("scanned")}>{app.t("app.runOcrBtn")}</button>
        </div>
      )}
      <main className="work">
        {!fs && !app.homeOpen && <Sidebar />}
        {app.homeOpen && !fs ? <div className="viewer home-viewer"><Welcome /></div> : app.view === "organize" && !fs ? <Organizer /> : <Viewer />}
      </main>
      {!fs && <StatusBar />}
      {fs && (
        <button className="fs-exit" title={app.t("app.fsExitTip")} onClick={() => app.toggleFullScreen(false)}>
          <Icon name="close" size={16} /> {app.t("app.fsExit")}
        </button>
      )}
      <FileBackstage />
      <Dialogs />
      {app.busy && (
        <div className="busy" role="status">
          <span className="spinner" />
          {app.busy}
          {prog && prog.total > 1 && <progress value={prog.done} max={prog.total} />}
        </div>
      )}
      {app.toast && <div className="toast" role="status">{app.toast}</div>}
      {dropping && (
        <div className="dropzone">
          <div>
            <Icon name="open" size={40} />
            <b>{app.t("app.dropTitle")}</b>
            <span>{app.t("app.dropSub")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Barra de abas: aba fixa "Página Inicial" + um documento por aba, estilo Foxit. */
function TabBar() {
  const app = useApp();
  if (!app.tabs.length) return null;
  return (
    <nav className="tabbar" role="tablist" aria-label={app.t("app.openDocsAria")}>
      <button
        type="button"
        className={app.homeOpen ? "hometab on" : "hometab"}
        title={app.t("app.homeTab")}
        aria-label={app.t("app.homeTab")}
        onClick={() => app.setHomeOpen(!app.homeOpen)}
      >
        <Icon name="home" size={14} />
      </button>
      {app.tabs.map((x) => {
        const on = !app.homeOpen && x.id === app.doc?.id;
        return (
          <div key={x.id} className={on ? "doctab on" : "doctab"} role="tab" aria-selected={on} title={x.path ?? x.name}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); app.closeTab(x.id); } }}>
            <button className="dt-name" onClick={() => app.switchTab(x.id)}>
              {x.dirty && <span className="dt-dot" aria-label={app.t("app.dirtyAria")}>•</span>}
              {x.name}
            </button>
            <button className="dt-close" title={app.t("app.closeTabTip")} aria-label={app.t("app.closeTabAria", { name: x.name })} onClick={() => app.closeTab(x.id)}>
              <Icon name="close" size={13} />
            </button>
          </div>
        );
      })}
      <button className="dt-new" title={app.t("app.newTabTip")} aria-label={app.t("app.newTabAria")} onClick={() => app.openFile()}>
        <Icon name="plus" size={16} />
      </button>
    </nav>
  );
}

function StatusBar() {
  const app = useApp();
  const [pg, setPg] = useState("1");
  useEffect(() => setPg(String(app.page + 1)), [app.page]);
  if (!app.doc || app.homeOpen) return <footer className="status"><span className="hint">PapyrusPDF — 100% Offline</span></footer>;
  const n = app.doc.info.pageCount;
  const zoomPct = Math.round(app.zoom * 100);
  return (
    <footer className="status">
      <span className="hint">{app.t(HINT_KEY[app.tool])}</span>
      <span className="grow" />
      {app.tool === "measure" && (
        <label className="scale-pick" title={app.t("app.scaleTip")}>
          {app.t("app.scale")}
          <select value={String(app.measureScale)} onChange={(e) => app.setMeasureScale(Number(e.target.value))}>
            {[1, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500].map((s) => <option key={s} value={s}>1:{s}</option>)}
          </select>
        </label>
      )}
      <div className="st-nav">
        <button title={app.t("app.firstPage")} disabled={app.page === 0} onClick={() => app.goTo(0)}><Icon name="firstPage" size={15} /></button>
        <button title={app.t("app.prevPage")} disabled={app.page === 0} onClick={() => app.goTo(app.page - 1)}><Icon name="chevL" size={15} /></button>
        <form onSubmit={(e) => { e.preventDefault(); const p = Number(pg) - 1; if (p >= 0 && p < n) app.goTo(p); }}>
          <input className="pgnum" value={pg} onChange={(e) => setPg(e.target.value)} aria-label={app.t("common.page")} /> / {n}
        </form>
        <button title={app.t("app.nextPage")} disabled={app.page >= n - 1} onClick={() => app.goTo(app.page + 1)}><Icon name="chevR" size={15} /></button>
        <button title={app.t("app.lastPage")} disabled={app.page >= n - 1} onClick={() => app.goTo(n - 1)}><Icon name="lastPage" size={15} /></button>
      </div>
      <span className="st-sep" />
      <button title={app.t("app.onePage")} className={app.layout === "single" ? "on" : ""} onClick={() => app.setLayout("single")}><Icon name="onePage" size={15} /></button>
      <button title={app.t("app.twoPages")} className={app.layout === "double" ? "on" : ""} onClick={() => app.setLayout("double")}><Icon name="twoPages" size={15} /></button>
      <button title={app.t("app.fullscreenTip")} onClick={() => app.toggleFullScreen(true)}><Icon name="fullscreen" size={15} /></button>
      <span className="st-sep" />
      <div className="st-zoom">
        <button title={app.t("cmd.zoomOut")} onClick={() => app.setZoom((z) => z / 1.2)}><Icon name="zoomOut" size={15} /></button>
        <input
          type="range"
          className="zoom-slider"
          min={25}
          max={400}
          step={5}
          value={Math.max(25, Math.min(400, zoomPct))}
          onChange={(e) => app.setZoom(Number(e.target.value) / 100)}
          aria-label="Zoom"
        />
        <button title={app.t("cmd.zoomIn")} onClick={() => app.setZoom((z) => z * 1.2)}><Icon name="zoomIn" size={15} /></button>
        <button type="button" className="zoom" title={app.t("cmd.fit")} onClick={() => app.fitWidth()}>{zoomPct}%</button>
      </div>
    </footer>
  );
}

/** Arquivos arrastados do Explorer para a janela. Devolve se há um arrasto em andamento. */
function useFileDrop(): boolean {
  const app = useApp();
  const [dropping, setDropping] = useState(false);
  const drop = useRef(app.openDropped);
  drop.current = app.openDropped;
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    let depth = 0;
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; setDropping(true); };
    const over = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (depth === 0) setDropping(false); };
    const done = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; setDropping(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) drop.current(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", done);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", done);
    };
  }, []);
  return dropping;
}

function useShortcuts() {
  const app = useApp();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      const k = e.key.toLowerCase();
      // com uma operação em andamento ou um diálogo aberto, os atalhos que mexem no documento esperam
      const free = !app.busy && !app.dialog && !app.printOpen;
      if (e.key === "F11") { e.preventDefault(); if (app.doc || app.fullscreen) app.toggleFullScreen(); return; }
      if (app.fullscreen && !typing && !app.dialog) {
        // em tela cheia, as setas e o Page Up/Down trocam de página
        if (e.key === "Escape") { app.toggleFullScreen(false); return; }
        const n = app.doc?.info.pageCount ?? 0, step = app.layout === "double" ? 2 : 1;
        if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(e.key) && !e.ctrlKey) { e.preventDefault(); app.goTo(Math.min(n - 1, app.page - (app.layout === "double" ? app.page % 2 : 0) + step)); return; }
        if (["ArrowLeft", "ArrowUp", "PageUp"].includes(e.key) && !e.ctrlKey) { e.preventDefault(); app.goTo(Math.max(0, app.page - (app.layout === "double" ? app.page % 2 : 0) - step)); return; }
      }
      if (e.ctrlKey || e.metaKey) {
        if (k === "tab") { e.preventDefault(); app.cycleTab(e.shiftKey ? -1 : 1); }
        else if (k === "pagedown") { e.preventDefault(); app.cycleTab(1); }
        else if (k === "pageup") { e.preventDefault(); app.cycleTab(-1); }
        else if (k === "w") { e.preventDefault(); if (app.doc && free) app.closeTab(app.doc.id); }
        else if (k === "o") { e.preventDefault(); if (free) app.openFile(); }
        else if (k === "s" && app.doc) { e.preventDefault(); if (free) app.save(e.shiftKey); }
        else if (k === "f" && app.doc) { e.preventDefault(); if (!app.dialog) app.setPanel("search"); }
        else if (k === "h" && app.doc) { e.preventDefault(); if (!app.dialog) app.setPanel("search"); }
        else if (k === "p") { e.preventDefault(); if (app.doc && free) app.printDoc(); }
        else if (!typing && k === "z" && app.doc) { e.preventDefault(); if (free) { if (e.shiftKey) app.redo(); else app.undo(); } }
        else if (!typing && k === "y" && app.doc) { e.preventDefault(); if (free) app.redo(); }
        else if (k === "=" || k === "+") { e.preventDefault(); app.setZoom((z) => z * 1.2); }
        else if (k === "-") { e.preventDefault(); app.setZoom((z) => z / 1.2); }
        else if (k === "0") { e.preventDefault(); app.fitWidth(); }
      } else if (!typing && e.key === "Escape") app.setTool("select");
      else if (!typing && e.key === "F3" && app.doc) { e.preventDefault(); app.stepSearch(e.shiftKey ? -1 : 1); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [app]);
}
