// Uma página: imagem renderizada pelo motor + camada de interação por cima.
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPE } from "react";
import { engine, type AnnotInfo, type EditTextResult, type FieldInfo, type PageInfo, type Point, type Quad, type Rect, type TextBlock, type TextLine } from "./api.ts";
import { useApp, type RGB, type Tool } from "./state.tsx";
import { Icon } from "./icons.tsx";
import { dataUrlBytes } from "./images.ts";
import { cssFontFamily, fontStyle } from "../../engine/fontname.ts";

const TEXT_TOOLS: Tool[] = ["select", "highlight", "underline", "strikeout", "edittext"];
const DRAG_TOOLS: Tool[] = ["freetext", "rect", "ellipse", "line", "arrow", "redact"];

interface FlatChar { c: string; quad: Quad; line: TextLine }

export function PageView({ index, info, visible }: { index: number; info: PageInfo; visible: boolean }) {
  const app = useApp();
  const { zoom, tool, doc } = app;
  const rev = doc?.rev ?? 0;
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState<{ rev: number; zoom: number } | null>(null);
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null);
  const [annots, setAnnots] = useState<AnnotInfo[]>([]);
  const [fields, setFields] = useState<FieldInfo[]>([]);
  const [drag, setDrag] = useState<{ a: Point; b: Point } | null>(null);
  const [ink, setInk] = useState<Point[] | null>(null);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [selAnnot, setSelAnnot] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ block: TextBlock; text: string } | null>(null);
  const [freeText, setFreeText] = useState<{ rect: Rect; text: string } | null>(null);
  const moved = useRef(false);

  const W = info.width * zoom, H = info.height * zoom;
  const toPx = (x: number, y: number) => [(x - info.x) * zoom, (y - info.y) * zoom] as const;
  const toPt = (e: { clientX: number; clientY: number }): Point => {
    const r = overlay.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / zoom + info.x, (e.clientY - r.top) / zoom + info.y];
  };

  // ---------- carregamento ----------
  useEffect(() => {
    if (!visible || !doc) return;
    if (rendered && rendered.rev === rev && rendered.zoom === zoom) return;
    let dead = false;
    const t = window.setTimeout(async () => {
      const dpr = window.devicePixelRatio || 1;
      try {
        const img = await engine.render(index, zoom * dpr);
        if (dead || !canvas.current) return;
        const c = canvas.current;
        c.width = img.width; c.height = img.height;
        c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
        setRendered({ rev, zoom });
      } catch { /* documento trocado no meio do caminho */ }
    }, rendered ? 120 : 0);
    return () => { dead = true; window.clearTimeout(t); };
  }, [visible, rev, zoom, index, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!visible || !doc) return;
    let dead = false;
    engine.annotations(index).then((a) => !dead && setAnnots(a.filter((x) => x.kind !== "Widget" && x.kind !== "Link"))).catch(() => {});
    engine.fields(index).then((f) => !dead && setFields(f)).catch(() => {});
    return () => { dead = true; };
  }, [visible, rev, index, doc]);

  const needsText = TEXT_TOOLS.includes(tool);
  useEffect(() => { setBlocks(null); setSel(null); }, [rev]);
  useEffect(() => {
    if (!visible || !needsText || blocks) return;
    let dead = false;
    engine.pageText(index).then((b) => !dead && setBlocks(b)).catch(() => {});
    return () => { dead = true; };
  }, [visible, needsText, blocks, index, rev]);
  useEffect(() => { setSel(null); setSelAnnot(null); setEditing(null); setFreeText(null); }, [tool]);

  const flat = useMemo<FlatChar[]>(() =>
    (blocks ?? []).flatMap((b) => b.lines.flatMap((l) => l.chars.map((ch) => ({ c: ch.c, quad: ch.quad, line: l })))), [blocks]);

  // ---------- seleção de texto ----------
  const nearest = (p: Point) => {
    let best = -1, bd = Infinity;
    flat.forEach((f, i) => {
      const [x0, y0, x1, y1] = qbox(f.quad);
      const dx = p[0] < x0 ? x0 - p[0] : p[0] > x1 ? p[0] - x1 : 0;
      const dy = p[1] < y0 ? y0 - p[1] : p[1] > y1 ? p[1] - y1 : 0;
      const d = dx + dy * 4;
      if (d < bd) { bd = d; best = i; }
    });
    return bd < 40 ? best : -1;
  };
  const range = sel ? flat.slice(Math.min(...sel), Math.max(...sel) + 1) : [];
  const lineQuads = (chars: FlatChar[]): Quad[] => {
    const out: Quad[] = [];
    let cur: FlatChar[] = [];
    const flush = () => {
      if (!cur.length) return;
      const a = cur[0].quad, b = cur[cur.length - 1].quad;
      out.push([a[0], a[1], b[2], b[3], a[4], a[5], b[6], b[7]]);
      cur = [];
    };
    for (const ch of chars) { if (cur.length && cur[0].line !== ch.line) flush(); cur.push(ch); }
    flush();
    return out;
  };
  const selectedText = () => {
    let s = "", prev: TextLine | null = null;
    for (const ch of range) { if (prev && prev !== ch.line) s += "\n"; s += ch.c; prev = ch.line; }
    return s.replace(/[ \t]+\n/g, "\n").trim();
  };
  const markSelection = async (kind: "Highlight" | "Underline" | "StrikeOut", color: RGB) => {
    const quads = lineQuads(range.filter((c) => c.c.trim()));
    setSel(null);
    if (quads.length) await app.mutate("Anotando…", () => engine.addAnnotation(index, { kind, quads, color }));
  };

  // ---------- ponteiro ----------
  const onDown = (e: RPE) => {
    if (e.button !== 0 || tool === "hand" || editing || freeText) return;
    const p = toPt(e);
    moved.current = false;
    overlay.current?.setPointerCapture(e.pointerId);
    if (tool === "ink") { setInk([p]); return; }
    if (TEXT_TOOLS.includes(tool) && tool !== "edittext") {
      const i = nearest(p);
      setSel(i >= 0 ? [i, i] : null);
    }
    setDrag({ a: p, b: p });
  };
  const onMove = (e: RPE) => {
    if (!drag && !ink) return;
    const p = toPt(e);
    if (ink) { setInk([...ink, p]); return; }
    if (drag) {
      if (Math.hypot(p[0] - drag.a[0], p[1] - drag.a[1]) * zoom > 3) moved.current = true;
      setDrag({ a: drag.a, b: p });
      if (sel && moved.current) { const i = nearest(p); if (i >= 0) setSel([sel[0], i]); }
    }
  };
  const onUp = async (e: RPE) => {
    const p = toPt(e);
    if (ink) {
      const pts = ink; setInk(null);
      if (pts.length > 1) await app.mutate("Desenhando…", () => engine.addAnnotation(index, { kind: "Ink", strokes: [pts], color: app.color }));
      return;
    }
    const d = drag; setDrag(null);
    if (!d) return;
    const r = norm(d.a, p);
    const big = (r[2] - r[0]) * zoom > 6 && (r[3] - r[1]) * zoom > 6;
    switch (tool) {
      case "select":
        if (!moved.current) {
          setSel(null);
          const hit = annots.filter((a) => inside(p, a.rect)).sort((x, y) => area(x.rect) - area(y.rect))[0];
          setSelAnnot(hit ? hit.id : null);
        }
        break;
      case "highlight": case "underline": case "strikeout":
        if (sel && moved.current) await markSelection(tool === "highlight" ? "Highlight" : tool === "underline" ? "Underline" : "StrikeOut", app.color);
        else setSel(null);
        break;
      case "note": {
        const text = await app.ask({ kind: "prompt", title: "Nova nota", message: "Texto do comentário:", multiline: true, value: "" });
        if (text) await app.mutate("Anotando…", () => engine.addAnnotation(index, { kind: "Text", at: [p[0] - 10, p[1] - 10], contents: text, color: app.color }));
        break;
      }
      case "freetext":
        setFreeText({ rect: big ? r : [p[0], p[1], p[0] + 200, p[1] + 28], text: "" });
        break;
      case "rect": case "ellipse":
        if (big) await app.mutate("Desenhando…", () => engine.addAnnotation(index, { kind: tool === "rect" ? "Square" : "Circle", rect: r, color: app.color }));
        break;
      case "line": case "arrow":
        if (moved.current) await app.mutate("Desenhando…", () => engine.addAnnotation(index, { kind: "Line", from: d.a, to: p, arrow: tool === "arrow", color: app.color }));
        break;
      case "redact":
        if (big) await app.mutate("Marcando…", () => engine.addAnnotation(index, { kind: "Redact", rect: r }));
        break;
      case "signature": await placeSignature(p); break;
      case "stamp": await placeStamp(p); break;
      case "edittext": {
        const b = (blocks ?? []).find((bl) => inside(p, bl.bbox));
        if (b) setEditing({ block: b, text: blockText(b) });
        break;
      }
    }
  };

  const placeSignature = async (p: Point) => {
    let sig = app.signature;
    if (!sig) {
      sig = await app.ask({ kind: "signature", title: "Criar assinatura" });
      if (!sig) return;
      app.setSignature(sig);
    }
    const img = new Image();
    img.src = sig;
    await img.decode();
    const w = 160, h = (w * img.naturalHeight) / img.naturalWidth;
    const png = Uint8Array.from(atob(sig.split(",")[1]), (c) => c.charCodeAt(0));
    await app.mutate("Assinando…", () => engine.addAnnotation(index, { kind: "Stamp", rect: [p[0] - w / 2, p[1] - h / 2, p[0] + w / 2, p[1] + h / 2], png }));
  };

  const placeStamp = async (p: Point) => {
    const st = app.stamp;
    if (!st) { app.notify("Escolha um carimbo em Comentar → Carimbo."); return; }
    // mantém o carimbo inteiro dentro da página
    const w = Math.min(st.width, info.width - 8), h = (w * st.height) / st.width;
    const x = Math.min(Math.max(p[0] - w / 2, info.x + 4), info.x + info.width - w - 4);
    const y = Math.min(Math.max(p[1] - h / 2, info.y + 4), info.y + info.height - h - 4);
    await app.mutate("Carimbando…", () => engine.addAnnotation(index, { kind: "Stamp", rect: [x, y, x + w, y + h], png: dataUrlBytes(st.png) }));
  };

  const commitEdit = async () => {
    if (!editing) return;
    const { block, text } = editing;
    setEditing(null);
    if (text === blockText(block)) return;
    const l0 = block.lines[0];
    const lh = block.lines.length > 1 ? block.lines[1].origin[1] - l0.origin[1] : l0.size * 1.2;
    const out: { fonts: EditTextResult["fonts"] | null } = { fonts: null };
    const ok = await app.mutate("Editando texto…", async () => {
      const r = await engine.editText({
        page: index, area: block.bbox, text, origin: l0.origin, size: l0.size, color: l0.color, font: l0.font,
        maxWidth: block.bbox[2] - block.bbox[0] + 2, lineHeight: lh > 0 ? lh : l0.size * 1.2,
      });
      out.fonts = r.fonts;
      return r;
    });
    // só avisa quando o texto novo não saiu todo na fonte do próprio documento
    const f = out.fonts;
    if (ok && f && (f.system || f.fallback)) {
      const name = fontStyle(l0.font).family;
      if (f.system && !f.fallback) app.notify(`Algumas letras não estavam na fonte embutida no PDF; vieram da ${f.system} instalada no Windows, que foi incorporada ao arquivo (ele fica maior).`);
      else if (f.original || f.system) app.notify(`Algumas letras não existem na fonte ${name} nem no Windows e saíram numa fonte padrão do PDF.`);
      else app.notify(`A fonte ${name} não pôde ser reaproveitada neste PDF; o texto saiu numa fonte padrão parecida.`);
    }
  };

  const commitFreeText = async () => {
    if (!freeText) return;
    const ft = freeText; setFreeText(null);
    if (ft.text.trim()) await app.mutate("Anotando…", () => engine.addAnnotation(index, { kind: "FreeText", rect: ft.rect, contents: ft.text, size: 12, color: app.color }));
  };

  // apagar anotação selecionada com Delete
  useEffect(() => {
    if (selAnnot === null) return;
    const h = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        const id = selAnnot; setSelAnnot(null);
        app.mutate("Excluindo…", () => engine.deleteAnnotation(index, id));
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selAnnot, index, app]);

  // Ctrl+C copia a seleção
  useEffect(() => {
    if (!range.length) return;
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") navigator.clipboard.writeText(selectedText()); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const hits = app.search.hits.map((h, i) => ({ ...h, i })).filter((h) => h.page === index);
  const box = (r: Rect, extra: Record<string, string | number> = {}) => {
    const [x, y] = toPx(r[0], r[1]);
    return { left: x, top: y, width: (r[2] - r[0]) * zoom, height: (r[3] - r[1]) * zoom, ...extra };
  };
  const selAnn = annots.find((a) => a.id === selAnnot);
  const cursor = { select: "text", hand: "grab", edittext: "default", signature: "copy", stamp: "copy" }[tool as string] ?? "crosshair";

  return (
    <div className="page" style={{ width: W, height: H }} data-page={index}>
      <canvas ref={canvas} style={{ width: W, height: H }} />
      {!rendered && <div className="page-loading">Carregando página {index + 1}…</div>}
      <div ref={overlay} className="overlay" style={{ cursor }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        {hits.flatMap((h) => h.quads.map((q, k) => (
          <div key={`${h.i}-${k}`} className={h.i === app.search.active ? "hit active" : "hit"} style={box(qbox(q))} />
        )))}
        {lineQuads(range).map((q, k) => <div key={k} className="tsel" style={box(qbox(q))} />)}
        {tool === "edittext" && !editing && (blocks ?? []).map((b, k) => <div key={k} className="eblock" style={box(b.bbox)} />)}
        {tool === "redact" && annots.filter((a) => a.kind === "Redact").map((a) => <div key={a.id} className="redmark" style={box(a.rect)} />)}
        {selAnn && (
          <div className="asel" style={box(selAnn.rect)}>
            <div className="mini" onPointerDown={(e) => e.stopPropagation()}>
              {(selAnn.kind === "Text" || selAnn.kind === "FreeText") && (
                <button onClick={async () => {
                  const t = await app.ask({ kind: "prompt", title: "Editar comentário", value: selAnn.contents, multiline: true });
                  if (t !== null) await app.mutate("Editando…", () => engine.setAnnotationContents(index, selAnn.id, t));
                }}>Editar</button>
              )}
              <button onClick={() => { setSelAnnot(null); app.mutate("Excluindo…", () => engine.deleteAnnotation(index, selAnn.id)); }}>
                <Icon name="trash" size={14} /> Excluir
              </button>
            </div>
          </div>
        )}
        {fields.filter((f) => !f.readOnly).map((f) => <Field key={f.id} f={f} index={index} style={box(f.rect)} zoom={zoom} />)}
        {range.length > 0 && !drag && tool === "select" && (() => {
          const last = qbox(range[range.length - 1].quad);
          const [x, y] = toPx(last[2], last[3]);
          return (
            <div className="mini floating" style={{ left: Math.min(x, W - 260), top: y + 6 }} onPointerDown={(e) => e.stopPropagation()}>
              <button onClick={() => { navigator.clipboard.writeText(selectedText()); app.notify("Texto copiado."); }}><Icon name="copy" size={14} /> Copiar</button>
              <button onClick={() => markSelection("Highlight", app.color)}>Realçar</button>
              <button onClick={() => markSelection("Underline", app.color)}>Sublinhar</button>
              <button onClick={() => markSelection("StrikeOut", [0.85, 0, 0])}>Tachar</button>
            </div>
          );
        })()}
        {(drag && DRAG_TOOLS.includes(tool)) || ink ? (
          <svg className="preview" width={W} height={H}>
            {drag && (tool === "line" || tool === "arrow")
              ? <line x1={toPx(...drag.a)[0]} y1={toPx(...drag.a)[1]} x2={toPx(...drag.b)[0]} y2={toPx(...drag.b)[1]} />
              : drag && tool === "ellipse"
                ? (() => { const r = norm(drag.a, drag.b); const [x, y] = toPx(r[0], r[1]); const w = (r[2] - r[0]) * zoom, h = (r[3] - r[1]) * zoom; return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} />; })()
                : drag && (() => { const r = norm(drag.a, drag.b); const [x, y] = toPx(r[0], r[1]); return <rect x={x} y={y} width={(r[2] - r[0]) * zoom} height={(r[3] - r[1]) * zoom} className={tool === "redact" ? "red" : ""} />; })()}
            {ink && <polyline points={ink.map((p) => toPx(...p).join(",")).join(" ")} />}
          </svg>
        ) : null}
        {editing && (() => {
          const l0 = editing.block.lines[0];
          const lh = editing.block.lines.length > 1 ? editing.block.lines[1].origin[1] - l0.origin[1] : l0.size * 1.2;
          const r = editing.block.bbox;
          return (
            <textarea className="editor" autoFocus value={editing.text}
              style={{ ...box([r[0] - 2, r[1] - 2, Math.max(r[2], r[0] + 120) + 2, r[3] + l0.size * 2]), fontSize: l0.size * zoom, lineHeight: `${lh * zoom}px`,
                fontFamily: cssFontFamily(l0.font), fontWeight: fontStyle(l0.font).bold ? 700 : 400, fontStyle: fontStyle(l0.font).italic ? "italic" : "normal", color: rgbCss(l0.color) }}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); if (e.key === "Enter" && e.ctrlKey) commitEdit(); }}
              onBlur={commitEdit} />
          );
        })()}
        {freeText && (
          <textarea className="editor ft" autoFocus value={freeText.text} placeholder="Digite e clique fora para confirmar"
            style={{ ...box(freeText.rect), fontSize: 12 * zoom, color: rgbCss(app.color) }}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setFreeText({ ...freeText, text: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Escape") setFreeText(null); }}
            onBlur={commitFreeText} />
        )}
      </div>
    </div>
  );
}

function Field({ f, index, style, zoom }: { f: FieldInfo; index: number; style: Record<string, number | string>; zoom: number }) {
  const app = useApp();
  const [v, setV] = useState(f.value);
  useEffect(() => setV(f.value), [f.value]);
  const set = (val: string | boolean) => app.mutate("Preenchendo…", () => engine.setField(index, f.id, val));
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const fs = Math.max(9, Math.min(14, (Number(style.height) / zoom) * 0.65)) * zoom;
  if (f.type === "checkbox" || f.type === "radiobutton") {
    const on = f.value !== "Off" && f.value !== "";
    return <input type="checkbox" className="field check" title={f.name} style={style} checked={on} onPointerDown={stop} onChange={() => set(!on)} />;
  }
  if (f.type === "combobox" || f.type === "listbox") {
    return (
      <select className="field" title={f.name} style={{ ...style, fontSize: fs }} value={v} onPointerDown={stop} onChange={(e) => { setV(e.target.value); set(e.target.value); }}>
        <option value="" />
        {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (f.type !== "text") return null;
  const props = {
    className: "field", title: f.name, value: v, style: { ...style, fontSize: fs },
    onPointerDown: stop, onChange: (e: { target: { value: string } }) => setV(e.target.value),
    onBlur: () => { if (v !== f.value) set(v); },
  };
  return f.multiline ? <textarea {...props} /> : <input {...props} />;
}

// ---------- geometria ----------
export function qbox(q: Quad): Rect {
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const norm = (a: Point, b: Point): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
const inside = (p: Point, r: Rect) => p[0] >= r[0] - 2 && p[0] <= r[2] + 2 && p[1] >= r[1] - 2 && p[1] <= r[3] + 2;
const area = (r: Rect) => (r[2] - r[0]) * (r[3] - r[1]);
const rgbCss = (c: number[]) => `rgb(${c.slice(0, 3).map((v) => Math.round(v * 255)).join(",")})`;

/** Texto do bloco: linhas curtas viram quebra de linha; linhas cheias continuam o parágrafo. */
function blockText(b: TextBlock): string {
  const right = b.bbox[2];
  return b.lines.map((l, i) => {
    const t = l.text.replace(/\s+$/, "");
    if (i === b.lines.length - 1) return t;
    const short = right - l.bbox[2] > l.size * 3;
    return t + (short ? "\n" : " ");
  }).join("");
}
