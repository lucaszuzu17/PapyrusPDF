// Painel lateral: miniaturas, marcadores, comentários, anexos, camadas e busca.
import { useEffect, useRef, useState } from "react";
import { formatBytes, type I18nKey } from "../../shared/i18n.ts";
import { engine, type AnnotInfo, type AttachmentInfo, type CommentSummaryItem, type LayerInfo, type OutlineNode } from "./api.ts";
import * as feat from "./features.ts";
import { Icon } from "./icons.tsx";
import { useApp, type Panel } from "./state.tsx";
import { Thumb } from "./Thumb.tsx";

const TABS: { id: Exclude<Panel, null>; icon: string; labelKey: I18nKey }[] = [
  { id: "pages", icon: "pages", labelKey: "side.pages" },
  { id: "outline", icon: "bookmark", labelKey: "side.outline" },
  { id: "comments", icon: "comments", labelKey: "side.comments" },
  { id: "attachments", icon: "attachments", labelKey: "side.attachments" },
  { id: "layers", icon: "layers", labelKey: "side.layers" },
  { id: "search", icon: "search", labelKey: "side.search" },
];

const KIND_KEY: Record<string, I18nKey> = {
  Highlight: "kind.Highlight", Underline: "kind.Underline", StrikeOut: "kind.StrikeOut", Squiggly: "kind.Squiggly",
  Text: "kind.Text", FreeText: "kind.FreeText", Ink: "kind.Ink", Square: "kind.Square", Circle: "kind.Circle",
  Line: "kind.Line", Stamp: "kind.Stamp", Redact: "kind.Redact",
};

export function Sidebar() {
  const app = useApp();
  if (!app.doc) return null;
  return (
    <aside className="sidebar">
      <div className="side-tabs">
        {TABS.map((x) => (
          <button key={x.id} title={app.t(x.labelKey)} className={app.panel === x.id ? "on" : ""} onClick={() => app.setPanel(app.panel === x.id ? null : x.id)}>
            <Icon name={x.icon} />
          </button>
        ))}
      </div>
      {app.panel && (
        <div className="side-body">
          <h3>{app.t(TABS.find((x) => x.id === app.panel)!.labelKey)}</h3>
          {app.panel === "pages" && <PagesPanel />}
          {app.panel === "outline" && <OutlinePanel />}
          {app.panel === "comments" && <CommentsPanel />}
          {app.panel === "attachments" && <AttachmentsPanel />}
          {app.panel === "layers" && <LayersPanel />}
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

  const saveOutline = (next: OutlineNode[]) => app.mutate(app.t("side.outlineSaving"), () => engine.setOutline(next));

  const addHere = async () => {
    const title = await app.ask({
      kind: "prompt", title: app.t("side.outlineNewTitle"),
      message: app.t("side.outlineNewMsg", { n: app.page + 1 }),
      value: app.t("side.outlineNewDefault", { n: app.page + 1 }),
    });
    if (!title?.trim()) return;
    await saveOutline([...nodes, { title: title.trim(), page: app.page, children: [] }]);
  };

  const generateAuto = async () => {
    if (nodes.length) {
      const ok = await app.ask({
        kind: "confirm", title: app.t("side.outlineAutoTitle"), okLabel: app.t("side.outlineAutoOk"),
        message: app.t("side.outlineAutoMsg"),
      });
      if (ok === null) return;
    }
    const r = await app.task(app.t("side.outlineDetecting"), () => engine.autoOutline());
    if (!r) return;
    if (!r.count) { app.notify(app.t("side.outlineNoneFound")); return; }
    await app.mutate("…", async () => r.info);
    app.notify(app.t("side.outlineAutoDone", { n: r.count }));
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
    const title = await app.ask({ kind: "prompt", title: app.t("side.outlineRenameTitle"), message: app.t("side.outlineRenameMsg"), value: curTitle });
    if (title === null || !title.trim()) return;
    await saveOutline(updateAt(nodes, path, (n) => ({ ...n, title: title.trim() })));
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
                <span>{n.title || app.t("side.outlineUntitled")}</span>
                {n.page >= 0 && <small>{app.t("common.pageShort")} {n.page + 1}</small>}
              </button>
              <button className="tree-act" title={app.t("side.outlineRenameTip")} onClick={() => renameAt(path, n.title)}>✎</button>
              <button className="tree-act" title={app.t("side.outlineRemoveTip")} onClick={() => removeAt(path)}><Icon name="trash" size={13} /></button>
            </div>
            {n.children.length > 0 && <Tree items={n.children} prefix={path} />}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="outline-wrap">
      <div className="side-tools">
        <button className="outline-add" disabled={!!app.busy} onClick={addHere}>
          <Icon name="plus" size={14} /> {app.t("side.outlineAddHere", { n: app.page + 1 })}
        </button>
        <button className="outline-add" disabled={!!app.busy} title={app.t("side.outlineAutoTip")} onClick={generateAuto}>
          <Icon name="sparkle" size={14} /> {app.t("side.outlineAutoBtn")}
        </button>
      </div>
      {nodes.length ? <Tree items={nodes} prefix={[]} /> : <p className="empty">{app.t("side.outlineEmpty")}</p>}
    </div>
  );
}

function CommentsPanel() {
  const app = useApp();
  const [items, setItems] = useState<(AnnotInfo & { page: number; quote?: string })[] | null>(null);
  const [filterKind, setFilterKind] = useState("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let dead = false;
    Promise.all([engine.allAnnotations(), engine.commentsSummary().catch(() => [] as CommentSummaryItem[])])
      .then(([anns, sum]) => {
        if (dead) return;
        const enriched = anns.map((a, i) => ({ ...a, quote: sum[i]?.quote ?? "" }));
        setItems(enriched);
      })
      .catch(() => !dead && setItems([]));
    return () => { dead = true; };
  }, [app.doc?.rev]);

  const kindLabel = (k: string) => (KIND_KEY[k] ? app.t(KIND_KEY[k]) : k);

  if (!items) return <p className="empty">{app.t("common.loading")}</p>;
  const kinds = [...new Set(items.map((a) => a.kind))];
  const q = query.trim().toLowerCase();
  const shown = items.filter((a) => {
    if (filterKind !== "all" && a.kind !== filterKind) return false;
    if (q && !`${a.contents} ${a.quote ?? ""} ${a.author} ${kindLabel(a.kind)}`.toLowerCase().includes(q)) return false;
    return true;
  });

  return (
    <div className="outline-wrap">
      {items.length > 0 && (
        <>
          <button className="outline-add" disabled={!!app.busy} onClick={() => feat.exportComments(app)}>
            <Icon name="exportSummary" size={14} /> {app.t("side.exportComments")}
          </button>
          <div className="side-filter">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={app.t("side.filterCommentsPh")} />
            <select value={filterKind} onChange={(e) => setFilterKind(e.target.value)} aria-label={app.t("side.filterCommentsAria")}>
              <option value="all">{app.t("side.filterAll", { n: items.length })}</option>
              {kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
            </select>
          </div>
        </>
      )}
      {!shown.length ? (
        <p className="empty">{items.length ? app.t("side.commentsNoMatch") : app.t("side.commentsEmpty")}</p>
      ) : (
        <ul className="comments">
          {shown.map((a) => (
            <li key={`${a.page}-${a.id}`}>
              <button className="citem" onClick={() => app.goTo(a.page)}>
                <span className="dot" style={{ background: `rgb(${(a.color.length ? a.color : [0.5, 0.5, 0.5]).slice(0, 3).map((v) => Math.round(v * 255)).join(",")})` }} />
                <b>{kindLabel(a.kind)}</b> <small>{app.t("common.pageShort")} {a.page + 1}</small>
                {a.quote && <span className="cquote">“{a.quote}”</span>}
                {a.contents && <span className="ctext">{a.contents}</span>}
              </button>
              <button className="cdel" title={app.t("common.delete")} onClick={() => app.mutate(app.t("common.deleting"), () => engine.deleteAnnotation(a.page, a.id))}>
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AttachmentsPanel() {
  const app = useApp();
  const [items, setItems] = useState<AttachmentInfo[] | null>(null);

  useEffect(() => {
    let dead = false;
    engine.attachments().then((list) => !dead && setItems(list)).catch(() => !dead && setItems([]));
    return () => { dead = true; };
  }, [app.doc?.rev]);

  const attachNew = async () => {
    const [f] = await window.papiro.openDialog({ title: app.t("side.attachOpenTitle"), anyFile: true });
    if (!f) return;
    const ok = await app.mutate(app.t("side.attaching"), () => engine.addAttachment(f.name, f.bytes));
    if (ok) app.notify(app.t("side.attachedMsg", { name: f.name }));
  };

  const extractItem = async (att: AttachmentInfo) => {
    const path = await window.papiro.saveDialog(att.filename, "any");
    if (!path) return;
    await app.task(app.t("side.extractingAttach"), async () => {
      const bytes = await engine.getAttachmentData(att.key);
      await window.papiro.writeFile(path, bytes);
      app.notify(app.t("side.attachSaved", { path }));
    });
  };

  const removeItem = async (att: AttachmentInfo) => {
    const ok = await app.ask({ kind: "confirm", title: app.t("side.removeAttachTitle"), message: app.t("side.removeAttachMsg", { name: att.filename }) });
    if (ok === null) return;
    await app.mutate(app.t("side.removingAttach"), () => engine.deleteAttachment(att.key));
  };

  return (
    <div className="outline-wrap">
      <button className="outline-add" disabled={!!app.busy} onClick={attachNew}>
        <Icon name="plus" size={14} /> {app.t("side.attachAddBtn")}
      </button>
      {!items ? (
        <p className="empty">{app.t("common.loading")}</p>
      ) : !items.length ? (
        <p className="empty">{app.t("side.attachEmpty")}</p>
      ) : (
        <ul className="comments">
          {items.map((att) => (
            <li key={att.key} className="attach-row">
              <button className="citem" title={app.t("side.attachSaveTip")} onClick={() => extractItem(att)}>
                <b className="attach-name">{att.filename}</b>
                <small>{formatBytes(att.size, app.lang)}</small>
              </button>
              <button className="cdel" title={app.t("side.attachSaveShort")} onClick={() => extractItem(att)}>
                <Icon name="extract" size={14} />
              </button>
              <button className="cdel" title={app.t("side.removeAttachTitle")} onClick={() => removeItem(att)}>
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LayersPanel() {
  const app = useApp();
  const [items, setItems] = useState<LayerInfo[] | null>(null);

  useEffect(() => {
    let dead = false;
    engine.layers().then((list) => !dead && setItems(list)).catch(() => !dead && setItems([]));
    return () => { dead = true; };
  }, [app.doc?.id, app.doc?.gen]);

  const toggle = async (layer: LayerInfo) => {
    const next = await engine.setLayerVisibility(layer.index, !layer.visible).catch(() => null);
    if (next) {
      setItems(next);
      app.rerender();
    }
  };

  if (!items) return <p className="empty">{app.t("common.loading")}</p>;
  if (!items.length) return <p className="empty">{app.t("side.layersEmpty")}</p>;
  return (
    <ul className="comments">
      {items.map((l) => (
        <li key={l.index} className="layer-row">
          <label>
            <input type="checkbox" checked={l.visible} onChange={() => toggle(l)} />
            <span>{l.name}</span>
          </label>
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
    if (!needle) { app.notify(app.t("side.replaceNeedQuery")); return; }
    let res: { count: number; pages: number } | null = null;
    const ok = await app.mutate(app.t("side.replacing"), async () => {
      const r = await engine.replaceText(needle, rep, {
        page: scope === "page" ? app.page : undefined,
        matchCase,
      });
      res = { count: r.count, pages: r.pages };
      return r;
    });
    if (ok && res) {
      const { count, pages } = res as { count: number; pages: number };
      if (!count) app.notify(app.t("side.replaceNone"));
      else {
        app.notify(app.t("side.replaceDone", { count, pages }));
        if (app.search.query) app.runSearch(needle);
      }
    }
  };

  return (
    <div className="search">
      <form onSubmit={(e) => {
        e.preventDefault();
        const v = input.current?.value ?? q;
        if (v === app.search.query && app.search.hits.length) app.stepSearch(1); else app.runSearch(v);
      }}>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={app.t("side.searchPh")} />
        <button type="submit" title={app.t("side.search")}><Icon name="search" size={16} /></button>
      </form>
      <div className="replace-box">
        <input value={rep} onChange={(e) => setRep(e.target.value)} placeholder={app.t("side.replacePh")} />
        <label className="rep-case">
          <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> {app.t("side.matchCase")}
        </label>
        <div className="rep-btns">
          <button type="button" disabled={!!app.busy || !q.trim()} onClick={() => doReplace("page")}>{app.t("side.replacePage")}</button>
          <button type="button" className="primary" disabled={!!app.busy || !q.trim()} onClick={() => doReplace("all")}>{app.t("side.replaceAll")}</button>
        </div>
      </div>
      {app.search.hits.length > 0 && (
        <>
          <div className="snav">
            <span>{app.t("side.searchCount", { cur: app.search.active + 1, total: app.search.hits.length })}</span>
            <button onClick={() => app.stepSearch(-1)}><Icon name="chevL" size={16} /></button>
            <button onClick={() => app.stepSearch(1)}><Icon name="chevR" size={16} /></button>
          </div>
          <ul className="sresults">
            {[...byPage].map(([p, n]) => (
              <li key={p}><button onClick={() => app.goTo(p)}>{app.t("common.page")} {p + 1} <small>({n})</small></button></li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
