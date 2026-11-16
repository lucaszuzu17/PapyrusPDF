// Organizador: grade de miniaturas com seleção múltipla e arrastar para reordenar.
import { useState } from "react";
import { engine } from "./api.ts";
import { useApp } from "./state.tsx";
import { Thumb } from "./Thumb.tsx";

// Arrasto de miniatura. Arquivos vindos do Explorer não têm este tipo e passam direto
// para a janela (que os abre), em vez de serem tomados por uma reordenação de páginas.
const PAGE_DRAG = "application/x-papiro-page";
const isPageDrag = (e: React.DragEvent) => [...e.dataTransfer.types].includes(PAGE_DRAG);
const draggedPage = (e: React.DragEvent): number | null => {
  if (!isPageDrag(e)) return null;
  const raw = e.dataTransfer.getData(PAGE_DRAG);
  const v = Number(raw);
  return raw !== "" && Number.isInteger(v) && v >= 0 ? v : null;
};

export function Organizer() {
  const app = useApp();
  const { doc, selectedPages: sel, setSelectedPages: setSel } = app;
  const [anchor, setAnchor] = useState(0);
  const [dropAt, setDropAt] = useState<number | null>(null);
  if (!doc) return null;
  const n = doc.info.pageCount;

  const click = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      setSel(Array.from({ length: b - a + 1 }, (_, k) => a + k));
    } else if (e.ctrlKey || e.metaKey) {
      setSel(sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i]);
      setAnchor(i);
    } else { setSel([i]); setAnchor(i); }
    app.setPage(i);
  };

  const drop = async (target: number, dragged: number) => {
    setDropAt(null);
    if (dragged >= n) return;
    const moving = sel.includes(dragged) ? [...sel].sort((a, b) => a - b) : [dragged];
    const rest = Array.from({ length: n }, (_, i) => i).filter((i) => !moving.includes(i));
    const before = rest.filter((i) => i < target).length;
    const order = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
    if (order.every((v, i) => v === i)) return;
    await app.mutate("Reorganizando…", () => engine.reorderPages(order));
    setSel(moving.map((_, k) => before + k));
  };

  return (
    <div className="organizer" onClick={(e) => { if (e.target === e.currentTarget) setSel([]); }}>
      <p className="org-hint">
        Clique para selecionar (Ctrl/Shift para várias), arraste para mudar a ordem, clique duplo para abrir.
        As ações ficam na aba <b>Organizar</b>. {sel.length > 0 && <b>{sel.length} selecionada(s).</b>}
      </p>
      <div className="org-grid">
        {doc.info.pages.map((p, i) => (
          <div key={i}
            className={`org-item${sel.includes(i) ? " on" : ""}${dropAt === i ? " drop" : ""}`}
            draggable
            onDragStart={(e) => { e.dataTransfer.setData(PAGE_DRAG, String(i)); e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => { if (!isPageDrag(e)) return; e.preventDefault(); setDropAt(i); }}
            onDragLeave={() => setDropAt((d) => (d === i ? null : d))}
            onDrop={(e) => { const from = draggedPage(e); if (from === null) return; e.preventDefault(); drop(i, from); }}
            onClick={(e) => click(i, e)}
            onDoubleClick={() => { app.setView("read"); app.goTo(i); }}>
            <Thumb index={i} info={p} width={150} />
            <span>{p.label}</span>
          </div>
        ))}
        <div className={`org-end${dropAt === n ? " drop" : ""}`}
          onDragOver={(e) => { if (!isPageDrag(e)) return; e.preventDefault(); setDropAt(n); }}
          onDrop={(e) => { const from = draggedPage(e); if (from === null) return; e.preventDefault(); drop(n, from); }}>
          soltar no fim
        </div>
      </div>
    </div>
  );
}
