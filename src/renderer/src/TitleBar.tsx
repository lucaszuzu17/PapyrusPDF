// Barra superior estilo Foxit (nas cores do ícone PapyrusPDF):
// Ícone + Acesso Rápido + Iniciar | Pesquisa global | Tema 1-clique + Idioma + Controles da janela.
import { useEffect, useState } from "react";
import type { LangPref } from "../../shared/i18n.ts";
import { PapyrusLogo } from "./BrandMark.tsx";
import { Icon } from "./icons.tsx";
import { useApp } from "./state.tsx";

export function TitleBar() {
  const a = useApp();
  const [maximized, setMaximized] = useState(false);
  const [q, setQ] = useState(a.search.query);

  useEffect(() => {
    window.papiro.winIsMaximized().then(setMaximized).catch(() => {});
    return window.papiro.onWinMaximized(setMaximized);
  }, []);

  useEffect(() => {
    setQ(a.search.query);
  }, [a.search.query]);

  const sysLangLabel = a.systemLang.toUpperCase();
  const isHand = a.tool === "hand";
  const hasHits = !!a.doc && a.search.hits.length > 0 && q.trim() !== "" && q === a.search.query;

  const submitSearch = (reverse = false) => {
    if (!a.doc) return;
    const term = q.trim();
    if (!term) {
      if (a.search.query) a.runSearch("");
      return;
    }
    a.setFileMenuOpen(false);
    a.setHomeOpen(false);
    if (term === a.search.query && a.search.hits.length > 0) {
      a.stepSearch(reverse ? -1 : 1);
    } else {
      a.runSearch(term);
    }
  };

  return (
    <div className="titlebar" role="banner">
      <div className="tb-left">
        <button
          type="button"
          className="tb-brand"
          title="PapyrusPDF"
          onClick={() => { a.setFileMenuOpen(false); a.setHomeOpen(true); }}
        >
          <PapyrusLogo size={18} />
        </button>

        <span className="tb-sep" aria-hidden="true" />

        <div className="tb-qat" role="toolbar" aria-label="Acesso rápido">
          <button type="button" className="tb-btn" title={a.t("cmd.open.tip")} disabled={!!a.busy} onClick={() => a.openFile()}>
            <Icon name="open" size={14} />
          </button>
          <button type="button" className="tb-btn" title={a.t("cmd.save.tip")} disabled={!a.doc || !!a.busy} onClick={() => a.save()}>
            <Icon name="save" size={14} />
          </button>
          <button type="button" className="tb-btn" title={a.t("cmd.print.tip")} disabled={!a.doc || !!a.busy} onClick={() => a.printDoc()}>
            <Icon name="print" size={14} />
          </button>
          <button type="button" className="tb-btn" title={a.t("cmd.saveAs.tip")} disabled={!a.doc || !!a.busy} onClick={() => a.save(true)}>
            <Icon name="saveAs" size={14} />
          </button>
          <button type="button" className="tb-btn" title={a.t("cmd.merge.tip")} disabled={!!a.busy} onClick={() => a.mergeFiles()}>
            <Icon name="merge" size={14} />
          </button>
          <button type="button" className="tb-btn" title={a.t("cmd.undo.tip")} disabled={!a.doc?.info.canUndo || !!a.busy} onClick={() => a.undo()}>
            <Icon name="undo" size={14} />
          </button>
          <button type="button" className="tb-btn" title={a.t("cmd.redo.tip")} disabled={!a.doc?.info.canRedo || !!a.busy} onClick={() => a.redo()}>
            <Icon name="redo" size={14} />
          </button>
          <button
            type="button"
            className={isHand ? "tb-btn on" : "tb-btn"}
            title={a.t(isHand ? "titlebar.switchSelect" : "titlebar.switchHand")}
            disabled={!a.doc || !!a.busy}
            onClick={() => { a.setHomeOpen(false); a.setView("read"); a.setTool(isHand ? "select" : "hand"); }}
          >
            <Icon name={isHand ? "hand" : "select"} size={14} />
          </button>
        </div>

        <span className="tb-sep" aria-hidden="true" />

        <button
          type="button"
          className={a.homeOpen || !a.doc ? "tb-start on" : "tb-start"}
          title={a.t("titlebar.startTip")}
          onClick={() => {
            a.setFileMenuOpen(false);
            if (a.doc) a.setHomeOpen(!a.homeOpen);
            else a.setHomeOpen(true);
          }}
        >
          <Icon name="home" size={13} />
          <span>{a.t("titlebar.start")}</span>
        </button>
      </div>

      <div className="tb-center">
        <form
          className="tb-search"
          onSubmit={(e) => { e.preventDefault(); submitSearch(false); }}
        >
          <Icon name="search" size={14} />
          <input
            type="text"
            value={q}
            disabled={!a.doc}
            placeholder={a.t("titlebar.searchPlaceholder")}
            title={a.t("titlebar.searchDocTip")}
            aria-label={a.t("titlebar.searchPlaceholder")}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                submitSearch(true);
              } else if (e.key === "Escape") {
                setQ("");
                if (a.search.query) a.runSearch("");
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          {hasHits && (
            <span className="tb-search-nav">
              <span className="tb-search-count">{a.search.active + 1}/{a.search.hits.length}</span>
              <button type="button" title={a.t("app.prevPage")} onClick={() => a.stepSearch(-1)}>
                <Icon name="chevL" size={12} />
              </button>
              <button type="button" title={a.t("app.nextPage")} onClick={() => a.stepSearch(1)}>
                <Icon name="chevR" size={12} />
              </button>
            </span>
          )}
          {q && a.doc && (
            <button
              type="button"
              className="tb-search-clear"
              aria-label={a.t("common.close")}
              onClick={() => { setQ(""); if (a.search.query) a.runSearch(""); }}
            >
              <Icon name="close" size={11} />
            </button>
          )}
        </form>
      </div>

      <div className="tb-right">
        <button
          type="button"
          className="tb-btn tb-theme"
          title={a.t(a.resolvedTheme === "dark" ? "theme.toLight" : "theme.toDark")}
          aria-label={a.t(a.resolvedTheme === "dark" ? "theme.toLight" : "theme.toDark")}
          onClick={() => a.toggleTheme()}
        >
          <Icon name={a.resolvedTheme === "dark" ? "moon" : "sun"} size={14} />
        </button>

        <label className="tb-lang" title={a.t("lang.label")}>
          <Icon name="language" size={13} />
          <select aria-label={a.t("lang.label")} value={a.uiLangPref} onChange={(e) => a.setUiLang(e.target.value as LangPref)}>
            <option value="auto">{a.t("lang.auto", { lang: sysLangLabel })}</option>
            <option value="pt">{a.t("lang.pt")}</option>
            <option value="en">{a.t("lang.en")}</option>
            <option value="es">{a.t("lang.es")}</option>
          </select>
        </label>

        <span className="tb-sep" aria-hidden="true" />

        <div className="tb-win">
          <button
            type="button"
            className="tb-wbtn"
            title={a.t("titlebar.minimize")}
            aria-label={a.t("titlebar.minimize")}
            onClick={() => window.papiro.winMinimize()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1 5.5h8" stroke="currentColor" strokeWidth="1.15" />
            </svg>
          </button>
          <button
            type="button"
            className="tb-wbtn"
            title={a.t(maximized ? "titlebar.restore" : "titlebar.maximize")}
            aria-label={a.t(maximized ? "titlebar.restore" : "titlebar.maximize")}
            onClick={() => window.papiro.winMaximize().then(setMaximized).catch(() => {})}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path d="M3 1.5h5.5V7" stroke="currentColor" strokeWidth="1.1" />
                <rect x="1.5" y="3" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.1" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1.1" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="tb-wbtn tb-close"
            title={a.t("titlebar.close")}
            aria-label={a.t("titlebar.close")}
            onClick={() => window.papiro.winClose()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
