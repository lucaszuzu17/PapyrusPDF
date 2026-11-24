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

  const saveOutline = (next: OutlineNode[]) => app.mutate("Atualizando marcadores…", () => engine.setOutline(next));

  const addHere = async () => {
    const t = await app.ask({
      kind: "prompt", title: "Novo marcador",
      message: `Título do marcador para a página ${app.page + 1}:`,
      value: `Página ${app.page + 1}`,
    });
    if (!t?.trim()) return;
    await saveOutline([...nodes, { title: t.trim(), page: app.page, children: [] }]);
  };

  const updateAt = (list: OutlineNode[], path: number[], fn: (n: OutlineNode) => OutlineNode | null): OutlineNode[] => {
    const [head, ...rest] = path;
    const out: OutlineNode[] = [];
    list.forEach((item, idx) => {
      if (idx !== head) { out.push(item); return; }
      if (rest.length === 0) {
        const res = fn(item);
        if (res) out.push(res);
      } else {
        out.push({ ...item, children: updateAt(item.children, rest, fn) });
      }
    });
    return out;
  };

  const renameAt = async (path: number[], curTitle: string) => {
    const t = await app.ask({ kind: "prompt", title: "Renomear marcador", message: "Novo título:", value: curTitle });
    if (t === null || !t.trim()) return;
    await saveOutline(updateAt(nodes, path, (n) => ({ ...n, title: t.trim() })));
  };

  const removeAt = async (path: number[]) => {
    await saveOutline(updateAt(nodes, path, () => null));
  };

  const Tree = ({ items, prefix }: { items: OutlineNode[]; prefix: number[] }) => (
    <ul className="tree">
      {items.map((n, i) => {
        const path = [...prefix, i];
        return (
          <li key={i}>
            <div className="tree-row">
              <button className="tree-go" disabled={n.page < 0} onClick={() => app.goTo(n.page)}>
                <span>{n.title || "(sem título)"}</span>
                {n.page >= 0 && <small>p. {n.page + 1}</small>}
              </button>
              <button className="tree-act" title="Renomear" onClick={() => renameAt(path, n.title)}>✎</button>
              <button className="tree-act" title="Remover" onClick={() => removeAt(path)}><Icon name="trash" size={13} /></button>
            </div>
            {n.children.length > 0 && <Tree items={n.children} prefix={path} />}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="outline-wrap">
      <button className="outline-add" disabled={!!app.busy} onClick={addHere}>
        <Icon name="plus" size={14} /> Marcar página {app.page + 1}
      </button>
      {nodes.length ? <Tree items={nodes} prefix={[]} /> : <p className="empty">Este documento não tem marcadores.</p>}
    </div>
  );
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
  const [rep, setRep] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const byPage = new Map<number, number>();
  app.search.hits.forEach((h) => byPage.set(h.page, (byPage.get(h.page) ?? 0) + 1));

  const doReplace = async (scope: "page" | "all") => {
    const needle = (input.current?.value ?? q).trim();
    if (!needle) { app.notify("Digite o texto a procurar."); return; }
    let res: { count: number; pages: number } | null = null;
    const ok = await app.mutate("Substituindo texto…", async () => {
      const r = await engine.replaceText(needle, rep, {
        page: scope === "page" ? app.page : undefined,
        matchCase,
      });
      res = { count: r.count, pages: r.pages };
      return r;
    });
    if (ok && res) {
      const { count, pages } = res as { count: number; pages: number };
      if (!count) app.notify("Nenhuma ocorrência encontrada para substituir.");
      else {
        app.notify(`${count} ocorrência(s) substituída(s) em ${pages} página(s). Ctrl+Z desfaz.`);
        if (app.search.query) app.runSearch(needle);
      }
    }
  };

  return (
    <div className="search">
      <form onSubmit={(e) => {
        e.preventDefault();
        const v = input.current?.value ?? q; // valor atual do campo, mesmo se o estado ainda não atualizou
        if (v === app.search.query && app.search.hits.length) app.stepSearch(1); else app.runSearch(v);
      }}>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar no documento" />
        <button type="submit" title="Buscar"><Icon name="search" size={16} /></button>
      </form>
      <div className="replace-box">
        <input value={rep} onChange={(e) => setRep(e.target.value)} placeholder="Substituir por…" />
        <label className="rep-case">
          <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Maiúsculas/minúsculas
        </label>
        <div className="rep-btns">
          <button type="button" disabled={!!app.busy || !q.trim()} onClick={() => doReplace("page")}>Nesta página</button>
          <button type="button" className="primary" disabled={!!app.busy || !q.trim()} onClick={() => doReplace("all")}>Substituir tudo</button>
        </div>
      </div>
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
