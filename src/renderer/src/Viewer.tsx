// Leitor em rolagem contínua, com renderização só das páginas visíveis + Tela Inicial estilo Foxit.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { localeTag } from "../../shared/i18n.ts";
import { PapyrusLogo, PdfFileBadge } from "./BrandMark.tsx";
import * as feat from "./features.ts";
import { Icon } from "./icons.tsx";
import { PageView } from "./PageView.tsx";
import { useApp } from "./state.tsx";

export function Viewer() {
  const app = useApp();
  const { doc, zoom, gotoSignal, tool, layout } = app;
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<Set<number>>(new Set([0]));
  const prevZoom = useRef(zoom);
  const pan = useRef<{ x: number; y: number; l: number; t: number } | null>(null);

  // largura disponível (para "ajustar largura")
  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => { app.viewportWidth.current = el.clientWidth; });
    ro.observe(el);
    app.viewportWidth.current = el.clientWidth;
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // quais páginas estão perto da área visível
  useEffect(() => {
    const el = box.current;
    if (!el || !doc) return;
    const io = new IntersectionObserver((entries) => {
      setVisible((old) => {
        const s = new Set(old);
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) s.add(i); else s.delete(i);
        }
        return s;
      });
    }, { root: el, rootMargin: "800px 0px" });
    el.querySelectorAll(".page").forEach((p) => io.observe(p));
    return () => io.disconnect();
  }, [doc?.info.pageCount, doc?.rev, doc?.gen, zoom, layout]); // eslint-disable-line react-hooks/exhaustive-deps

  // página atual = a que ocupa o topo da área visível (em duas páginas, a da esquerda)
  const onScroll = () => {
    const el = box.current!;
    const mid = el.scrollTop + el.clientHeight * 0.3;
    let cur = 0, top = -1;
    el.querySelectorAll<HTMLElement>(".page").forEach((p) => {
      if (p.offsetTop <= mid && p.offsetTop > top) { cur = Number(p.dataset.page); top = p.offsetTop; }
    });
    if (cur !== app.page) app.setPage(cur);
  };

  // ir para página (ao voltar do organizador, o leitor reaparece na página atual, não no último "ir para")
  const shown = useRef(false);
  useEffect(() => {
    const target = shown.current ? gotoSignal.page : app.page;
    shown.current = true;
    const el = box.current?.querySelector<HTMLElement>(`.page[data-page="${target}"]`);
    if (el && box.current) box.current.scrollTop = el.offsetTop - 16;
  }, [gotoSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // ao trocar entre uma e duas páginas, continua na mesma página
  const prevLayout = useRef(layout);
  useLayoutEffect(() => {
    if (prevLayout.current === layout) return;
    prevLayout.current = layout;
    const el = box.current?.querySelector<HTMLElement>(`.page[data-page="${app.page}"]`);
    if (el && box.current) box.current.scrollTop = el.offsetTop - 16;
  }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps

  // manter a posição relativa ao mudar o zoom
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || prevZoom.current === zoom) return;
    const ratio = zoom / prevZoom.current;
    el.scrollTop = (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2;
    el.scrollLeft = (el.scrollLeft + el.clientWidth / 2) * ratio - el.clientWidth / 2;
    prevZoom.current = zoom;
  }, [zoom]);

  // Ctrl + roda do mouse = zoom
  useEffect(() => {
    const el = box.current!;
    const h = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      app.setZoom((z) => z * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, [app]);

  if (!doc) return <div className="viewer" ref={box}><Welcome /></div>;

  return (
    <div
      className={tool === "hand" ? "viewer panning" : "viewer"}
      ref={box}
      onScroll={onScroll}
      onPointerDown={(e) => {
        if (tool !== "hand") return;
        pan.current = { x: e.clientX, y: e.clientY, l: box.current!.scrollLeft, t: box.current!.scrollTop };
        box.current!.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!pan.current) return;
        box.current!.scrollLeft = pan.current.l - (e.clientX - pan.current.x);
        box.current!.scrollTop = pan.current.t - (e.clientY - pan.current.y);
      }}
      onPointerUp={() => { pan.current = null; }}
    >
      {layout === "double" ? (
        <div className="pages double">
          {doc.info.pages.filter((_, i) => i % 2 === 0).map((_, k) => (
            <div className="spread" key={`${doc.gen}-s${k}`}>
              {[2 * k, 2 * k + 1].filter((i) => i < doc.info.pageCount).map((i) =>
                <PageView key={`${doc.gen}-${i}`} index={i} info={doc.info.pages[i]} visible={visible.has(i)} />)}
            </div>
          ))}
        </div>
      ) : (
        <div className="pages">
          {doc.info.pages.map((p, i) => <PageView key={`${doc.gen}-${i}`} index={i} info={p} visible={visible.has(i)} />)}
        </div>
      )}
    </div>
  );
}

type RecentItem = Awaited<ReturnType<typeof window.papiro.recentList>>[number];

export function Welcome() {
  const app = useApp();
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<"list" | "grid">("list");

  useEffect(() => { window.papiro.recentList().then(setRecent).catch(() => {}); }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? recent.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : recent;
  }, [recent, filter]);

  const fmtDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.toLocaleDateString(localeTag(app.lang))} ${d.toLocaleTimeString(localeTag(app.lang), { hour: "2-digit", minute: "2-digit" })}`;
  };

  const editPdfNow = async () => {
    await app.openFile();
    app.setTool("edittext");
  };

  return (
    <div className="home-screen">
      {/* Rail lateral estilo Foxit */}
      <aside className="home-rail">
        <div className="home-brand-card">
          <PapyrusLogo size={34} />
          <div>
            <b>PapyrusPDF</b>
            <small>100% Offline</small>
          </div>
        </div>
        <button type="button" className="home-nav-item on">
          <Icon name="home" size={16} /> {app.t("home.navHome")}
        </button>
        <button type="button" className="home-open-btn" onClick={() => app.openFile()}>
          <Icon name="open" size={16} /> {app.t("home.openFile")}
        </button>
        <button type="button" className="home-sec-btn" onClick={() => app.setFileMenuOpen(true)}>
          <Icon name="sun" size={15} /> {app.t("file.appearance")}
        </button>
        <div className="grow" />
        <p className="home-rail-hint">{app.t("welcome.hint")}</p>
      </aside>

      {/* Área principal estilo Foxit: Assistente de Ferramentas + Recentes */}
      <div className="home-main">
        <section className="home-tools">
          <header className="home-sec-head">
            <h2>{app.t("home.toolsHeading")}</h2>
            <span>({app.t("home.toolsSub")})</span>
          </header>

          <div className="home-tools-row">
            <div className="tool-card" onClick={editPdfNow} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") editPdfNow(); }}>
              <span className="tc-icon red"><Icon name="editText" size={22} /></span>
              <div className="tc-body">
                <b>{app.t("home.toolEdit")}</b>
                <p>{app.t("home.toolEditDesc")}</p>
                <span className="tc-link">{app.t("home.useNow")}</span>
              </div>
            </div>

            <div className="tool-card" onClick={() => app.mergeFiles()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") app.mergeFiles(); }}>
              <span className="tc-icon gold"><Icon name="merge" size={22} /></span>
              <div className="tc-body">
                <b>{app.t("home.toolMerge")}</b>
                <p>{app.t("home.toolMergeDesc")}</p>
                <span className="tc-link">{app.t("home.useNow")}</span>
              </div>
            </div>

            <div className="tool-card" onClick={() => app.newFromImages()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") app.newFromImages(); }}>
              <span className="tc-icon ink"><Icon name="image" size={22} /></span>
              <div className="tc-body">
                <b>{app.t("home.toolImages")}</b>
                <p>{app.t("home.toolImagesDesc")}</p>
                <span className="tc-link">{app.t("home.useNow")}</span>
              </div>
            </div>

            <div className="tool-card" onClick={() => feat.batchProcess(app)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") feat.batchProcess(app); }}>
              <span className="tc-icon cream"><Icon name="batch" size={22} /></span>
              <div className="tc-body">
                <b>{app.t("home.toolBatch")}</b>
                <p>{app.t("home.toolBatchDesc")}</p>
                <span className="tc-link">{app.t("home.useNow")}</span>
              </div>
            </div>

            <div className="default-card">
              <b>{app.t("home.defaultTitle")}</b>
              <button type="button" className="default-btn" onClick={() => window.papiro.openDefaultApps()}>
                {app.t("home.defaultBtn")}
              </button>
            </div>
          </div>
        </section>

        <section className="home-recents" aria-label={app.t("welcome.recentAria")}>
          <header className="home-rec-head">
            <h2>{app.t("welcome.recentTitle")}</h2>
            <div className="home-rec-tools">
              <input
                type="search"
                className="home-rec-filter"
                value={filter}
                placeholder={app.t("home.recentSearch")}
                onChange={(e) => setFilter(e.target.value)}
              />
              <button type="button" className={mode === "list" ? "on" : ""} title={app.t("home.viewList")} onClick={() => setMode("list")}>
                <Icon name="list" size={16} />
              </button>
              <button type="button" className={mode === "grid" ? "on" : ""} title={app.t("home.viewGrid")} onClick={() => setMode("grid")}>
                <Icon name="grid" size={16} />
              </button>
              {recent.length > 0 && (
                <button type="button" title={app.t("welcome.clearList")} onClick={() => window.papiro.recentClear().then(setRecent)}>
                  <Icon name="trash" size={16} />
                </button>
              )}
            </div>
          </header>

          {filtered.length === 0 ? (
            <div className="home-rec-empty">
              <PdfFileBadge size={42} />
              <p>{app.t("file.noRecent")}</p>
              <button type="button" className="primary" onClick={() => app.openFile()}>{app.t("welcome.openBtn")}</button>
            </div>
          ) : mode === "list" ? (
            <div className="home-rec-table">
              <div className="hrt-head">
                <span>{app.t("home.colName")}</span>
                <span>{app.t("home.colDate")}</span>
              </div>
              <ul>
                {filtered.map((r) => (
                  <li key={r.path}>
                    <button type="button" className="hrt-row" title={r.path} onClick={() => app.openFile(r.path)}>
                      <PdfFileBadge size={26} />
                      <div className="hrt-name">
                        <b>{r.name}</b>
                        <small>{r.path}</small>
                      </div>
                      <span className="hrt-date">
                        {fmtDate(r.when)}
                        {r.page > 0 && <em>{app.t("welcome.pageTag", { n: r.page + 1 })}</em>}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="rdel"
                      title={app.t("welcome.removeTip")}
                      aria-label={app.t("welcome.removeAria", { name: r.name })}
                      onClick={() => window.papiro.recentRemove(r.path).then(setRecent)}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="home-rec-grid">
              {filtered.map((r) => (
                <div key={r.path} className="hrg-card">
                  <button type="button" className="hrg-open" title={r.path} onClick={() => app.openFile(r.path)}>
                    <PdfFileBadge size={40} />
                    <b>{r.name}</b>
                    <small>{fmtDate(r.when)}</small>
                  </button>
                  <button
                    type="button"
                    className="rdel"
                    title={app.t("welcome.removeTip")}
                    aria-label={app.t("welcome.removeAria", { name: r.name })}
                    onClick={() => window.papiro.recentRemove(r.path).then(setRecent)}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
