// Leitor em rolagem contínua, com renderização só das páginas visíveis.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import { PageView } from "./PageView.tsx";
import { useApp } from "./state.tsx";

export function Viewer() {
  const app = useApp();
  const { doc, zoom, gotoSignal, tool } = app;
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
  }, [doc?.info.pageCount, doc?.rev, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // página atual = a que ocupa o topo da área visível
  const onScroll = () => {
    const el = box.current!;
    const mid = el.scrollTop + el.clientHeight * 0.3;
    let cur = 0;
    el.querySelectorAll<HTMLElement>(".page").forEach((p) => { if (p.offsetTop <= mid) cur = Number(p.dataset.page); });
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
      <div className="pages">
        {doc.info.pages.map((p, i) => <PageView key={`${doc.gen}-${i}`} index={i} info={p} visible={visible.has(i)} />)}
      </div>
    </div>
  );
}

type RecentItem = Awaited<ReturnType<typeof window.papiro.recentList>>[number];

function Welcome() {
  const app = useApp();
  const [recent, setRecent] = useState<RecentItem[]>([]);
  useEffect(() => { window.papiro.recentList().then(setRecent).catch(() => {}); }, []);
  const when = (t: number) => {
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86_400_000);
    return days <= 0 ? "hoje" : days === 1 ? "ontem" : days < 7 ? `há ${days} dias` : new Date(t).toLocaleDateString("pt-BR");
  };
  return (
    <div className="welcome">
      <h1>PapyrusPDF</h1>
      <p>Abra um PDF para ler, anotar, preencher, organizar, editar texto ou reconhecer texto (OCR).</p>
      <div className="welcome-actions">
        <button className="primary" onClick={() => app.openFile()}>Abrir PDF…</button>
        <button onClick={() => app.mergeFiles()}>Combinar PDFs…</button>
        <button onClick={() => app.newFromImages()}>Criar a partir de imagens…</button>
      </div>
      <p className="hint">Dica: arraste um PDF ou imagens para esta janela. Ctrl+O abre, Ctrl+S salva, Ctrl+P imprime, Ctrl+F busca.</p>
      {recent.length > 0 && (
        <section className="recent" aria-label="Arquivos recentes">
          <header>
            <h2><Icon name="clock" size={15} /> Recentes</h2>
            <button onClick={() => window.papiro.recentClear().then(setRecent)}>Limpar lista</button>
          </header>
          <ul>
            {recent.map((r) => (
              <li key={r.path}>
                <button className="ritem" title={r.path} onClick={() => app.openFile(r.path)}>
                  <b>{r.name}</b>
                  <small>{r.path.replace(/[\\/][^\\/]*$/, "")}</small>
                  <span>{when(r.when)}{r.page > 0 ? ` · pág. ${r.page + 1}` : ""}</span>
                </button>
                <button className="rdel" title="Tirar da lista" aria-label={`Tirar ${r.name} da lista`}
                  onClick={() => window.papiro.recentRemove(r.path).then(setRecent)}><Icon name="close" size={14} /></button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
