import { useEffect, useRef, useState } from "react";
import { Dialogs } from "./Dialogs.tsx";
import { Icon } from "./icons.tsx";
import { Organizer } from "./Organizer.tsx";
import { Ribbon } from "./Ribbon.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { AppProvider, useApp, type Tool } from "./state.tsx";
import { Viewer } from "./Viewer.tsx";

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

const HINT: Partial<Record<Tool, string>> = {
  select: "Arraste sobre o texto para selecionar; clique numa anotação para editá-la ou excluí-la.",
  hand: "Arraste para mover a página.",
  highlight: "Arraste sobre o texto para realçar.",
  underline: "Arraste sobre o texto para sublinhar.",
  strikeout: "Arraste sobre o texto para tachar.",
  note: "Clique onde a nota deve ficar.",
  freetext: "Arraste uma caixa (ou clique) e digite.",
  ink: "Desenhe à mão livre.",
  rect: "Arraste para desenhar um retângulo.",
  ellipse: "Arraste para desenhar uma elipse.",
  line: "Arraste para desenhar uma linha.",
  arrow: "Arraste para desenhar uma seta.",
  signature: "Clique onde a assinatura deve ficar.",
  stamp: "Clique onde o carimbo deve ficar. Para trocar de modelo, use Comentar → Carimbo.",
  redact: "Arraste sobre o que deve ser apagado. Depois use “Aplicar redações”.",
  edittext: "Clique num parágrafo para reescrevê-lo. Ctrl+Enter confirma, Esc cancela.",
  addtext: "Clique em qualquer ponto da página para inserir novo texto. Ctrl+Enter confirma.",
  overlayimg: "Clique ou arraste na página para posicionar e redimensionar a imagem.",
  measure: "Arraste entre dois pontos da página para medir a distância (ajuste a escala na barra inferior).",
};

function Shell() {
  const app = useApp();
  useShortcuts();
  const dropping = useFileDrop();
  const prog = app.ocrProgress ?? app.progress;
  const fs = app.fullscreen;
  return (
    <div className={fs ? "app fullscreen" : "app"}>
      {!fs && <Ribbon />}
      {!fs && <TabBar />}
      {!fs && app.doc && app.scanned.length > 0 && !app.ocrProgress && (
        <div className="banner">
          <Icon name="ocr" size={18} />
          {app.scanned.length === app.doc.info.pageCount
            ? "Este documento parece escaneado: o texto não pode ser pesquisado nem selecionado."
            : `${app.scanned.length} página(s) parecem escaneadas.`}
          <button className="primary" disabled={!!app.busy} onClick={() => app.runOcr("scanned")}>Reconhecer texto (OCR)</button>
        </div>
      )}
      <main className="work">
        {!fs && <Sidebar />}
        {app.view === "organize" && !fs ? <Organizer /> : <Viewer />}
      </main>
      {!fs && <StatusBar />}
      {fs && (
        <button className="fs-exit" title="Sair da tela cheia (Esc)" onClick={() => app.toggleFullScreen(false)}>
          <Icon name="close" size={16} /> Sair da tela cheia
        </button>
      )}
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
            <b>Solte para abrir</b>
            <span>Um PDF abre · vários PDFs são combinados · imagens viram páginas</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Barra de abas: um documento por aba, como num navegador. */
function TabBar() {
  const app = useApp();
  if (!app.tabs.length) return null;
  return (
    <nav className="tabbar" role="tablist" aria-label="Documentos abertos">
      {app.tabs.map((t) => {
        const on = t.id === app.doc?.id;
        return (
          <div key={t.id} className={on ? "doctab on" : "doctab"} role="tab" aria-selected={on} title={t.path ?? t.name}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); app.closeTab(t.id); } }}>
            <button className="dt-name" onClick={() => app.switchTab(t.id)}>
              {t.dirty && <span className="dt-dot" aria-label="alterado">•</span>}
              {t.name}
            </button>
            <button className="dt-close" title="Fechar (Ctrl+W)" aria-label={`Fechar ${t.name}`} onClick={() => app.closeTab(t.id)}>
              <Icon name="close" size={13} />
            </button>
          </div>
        );
      })}
      <button className="dt-new" title="Abrir outro PDF (Ctrl+O)" aria-label="Abrir outro PDF" onClick={() => app.openFile()}>
        <Icon name="plus" size={16} />
      </button>
    </nav>
  );
}

function StatusBar() {
  const app = useApp();
  const [pg, setPg] = useState("1");
  useEffect(() => setPg(String(app.page + 1)), [app.page]);
  if (!app.doc) return <footer className="status" />;
  const n = app.doc.info.pageCount;
  return (
    <footer className="status">
      <span className="hint">{HINT[app.tool]}</span>
      <span className="grow" />
      {app.tool === "measure" && (
        <label className="scale-pick" title="Escala da régua (para plantas e desenhos técnicos)">
          Escala
          <select value={String(app.measureScale)} onChange={(e) => app.setMeasureScale(Number(e.target.value))}>
            {[1, 10, 20, 25, 50, 75, 100, 125, 200, 250, 500].map((s) => <option key={s} value={s}>1:{s}</option>)}
          </select>
        </label>
      )}
      <button title="Página anterior" disabled={app.page === 0} onClick={() => app.goTo(app.page - 1)}><Icon name="chevL" size={16} /></button>
      <form onSubmit={(e) => { e.preventDefault(); const p = Number(pg) - 1; if (p >= 0 && p < n) app.goTo(p); }}>
        <input className="pgnum" value={pg} onChange={(e) => setPg(e.target.value)} aria-label="Página" /> / {n}
      </form>
      <button title="Próxima página" disabled={app.page >= n - 1} onClick={() => app.goTo(app.page + 1)}><Icon name="chevR" size={16} /></button>
      <button title="Uma página" className={app.layout === "single" ? "on" : ""} onClick={() => app.setLayout("single")}><Icon name="onePage" size={16} /></button>
      <button title="Duas páginas" className={app.layout === "double" ? "on" : ""} onClick={() => app.setLayout("double")}><Icon name="twoPages" size={16} /></button>
      <button title="Tela cheia (F11)" onClick={() => app.toggleFullScreen(true)}><Icon name="fullscreen" size={16} /></button>
      <button title="Reduzir" onClick={() => app.setZoom((z) => z / 1.2)}><Icon name="zoomOut" size={16} /></button>
      <span className="zoom">{Math.round(app.zoom * 100)}%</span>
      <button title="Ampliar" onClick={() => app.setZoom((z) => z * 1.2)}><Icon name="zoomIn" size={16} /></button>
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
      const free = !app.busy && !app.dialog;
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
