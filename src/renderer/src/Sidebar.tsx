// Painel lateral: miniaturas, marcadores, comentários e busca.
import { useEffect, useRef, useState } from "react";
import { engine, type AnnotInfo, type OutlineNode } from "./api.ts";
import { Icon } from "./icons.tsx";
import { useApp, type Panel } from "./state.tsx";
import { Thumb } from "./Thumb.tsx";

const TABS: { id: Exclude<Panel, null>; icon: string; label: string }[] = [
  { id: "pages", icon: "pages", label: "Páginas" },
  { id: "outline", icon: "bookmark", label: "Marcadores" },
  { id: "comments", icon: "comments", label: "Comentários" },
  { id: "search", icon: "search", label: "Buscar" },
];

const KIND: Record<string, string> = {
  Highlight: "Realce", Underline: "Sublinhado", StrikeOut: "Tachado", Squiggly: "Ondulado", Text: "Nota",
  FreeText: "Caixa de texto", Ink: "Desenho", Square: "Retângulo", Circle: "Elipse", Line: "Linha",
  Stamp: "Carimbo/assinatura", Redact: "Redação pendente",
};

export function Sidebar() {
  const app = useApp();
  if (!app.doc) return null;
  return (
    <aside className="sidebar">
      <div className="side-tabs">
        {TABS.map((t) => (
          <button key={t.id} title={t.label} className={app.panel === t.id ? "on" : ""} onClick={() => app.setPanel(app.panel === t.id ? null : t.id)}>
            <Icon name={t.icon} />
          </button>
        ))}
      </div>
      {app.panel && (
        <div className="side-body">
          <h3>{TABS.find((t) => t.id === app.panel)!.label}</h3>
          {app.panel === "pages" && <PagesPanel />}
          {app.panel === "outline" && <OutlinePanel />}
          {app.panel === "comments" && <CommentsPanel />}
          {app.panel === "search" && <SearchPanel />}
        </div>
      )}
    </aside>
  );
}

function PagesPanel() {
  const app = useApp();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(".tp.on")?.scrollIntoView({ block: "nearest" });
  }, [app.page]);
  return (
    <div className="thumbs" ref={list}>
      {app.doc!.info.pages.map((p, i) => (
        <button key={i} className={i === app.page ? "tp on" : "tp"} onClick={() => app.goTo(i)}>
          <Thumb index={i} info={p} width={120} />
          <span>{p.label}</span>
        </button>
      ))}
    </div>
  );
}

function OutlinePanel() {
  const app = useApp();
  const nodes = app.doc!.info.outline;
  if (!nodes.length) return <p className="empty">Este documento não tem marcadores.</p>;
  const Tree = ({ items }: { items: OutlineNode[] }) => (
    <ul className="tree">
      {items.map((n, i) => (
        <li key={i}>
          <button disabled={n.page < 0} onClick={() => app.goTo(n.page)}>{n.title || "(sem título)"}</button>
          {n.children.length > 0 && <Tree items={n.children} />}
        </li>
      ))}
    </ul>
  );
  return <Tree items={nodes} />;
}

function CommentsPanel() {
  const app = useApp();
  const [items, setItems] = useState<(AnnotInfo & { page: number })[] | null>(null);
  useEffect(() => {
    let dead = false;
    engine.allAnnotations().then((a) => !dead && setItems(a)).catch(() => setItems([]));
    return () => { dead = true; };
  }, [app.doc?.rev]);
  if (!items) return <p className="empty">Carregando…</p>;
  if (!items.length) return <p className="empty">Nenhum comentário ou marcação.</p>;
  return (
    <ul className="comments">
      {items.map((a) => (
        <li key={`${a.page}-${a.id}`}>
          <button className="citem" onClick={() => app.goTo(a.page)}>
            <span className="dot" style={{ background: `rgb(${(a.color.length ? a.color : [0.5, 0.5, 0.5]).slice(0, 3).map((v) => Math.round(v * 255)).join(",")})` }} />
            <b>{KIND[a.kind] ?? a.kind}</b> <small>p. {a.page + 1}</small>
            {a.contents && <span className="ctext">{a.contents}</span>}
          </button>
          <button className="cdel" title="Excluir" onClick={() => app.mutate("Excluindo…", () => engine.deleteAnnotation(a.page, a.id))}>
            <Icon name="trash" size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function SearchPanel() {
  const app = useApp();
  const [q, setQ] = useState(app.search.query);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const byPage = new Map<number, number>();
  app.search.hits.forEach((h) => byPage.set(h.page, (byPage.get(h.page) ?? 0) + 1));
  return (
    <div className="search">
      <form onSubmit={(e) => {
        e.preventDefault();
        const v = input.current?.value ?? q; // valor atual do campo, mesmo se o estado ainda não atualizou
        if (v === app.search.query && app.search.hits.length) app.stepSearch(1); else app.runSearch(v);
      }}>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar no documento" />
        <button type="submit"><Icon name="search" size={16} /></button>
      </form>
      {app.search.hits.length > 0 && (
        <>
          <div className="snav">
            <span>{app.search.active + 1} de {app.search.hits.length}</span>
            <button onClick={() => app.stepSearch(-1)}><Icon name="chevL" size={16} /></button>
            <button onClick={() => app.stepSearch(1)}><Icon name="chevR" size={16} /></button>
          </div>
          <ul className="sresults">
            {[...byPage].map(([p, n]) => (
              <li key={p}><button onClick={() => app.goTo(p)}>Página {p + 1} <small>({n})</small></button></li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
