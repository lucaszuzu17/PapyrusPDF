// Caixas de diálogo: texto, senha, confirmação, formulário e assinatura.
import { useEffect, useRef, useState } from "react";
import { useApp, type FormValues } from "./state.tsx";

export function Dialogs() {
  const { dialog, closeDialog } = useApp();
  if (!dialog) return null;
  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) closeDialog(null); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={dialog.title}>
        <h2>{dialog.title}</h2>
        {dialog.kind === "signature" ? <SignaturePad onDone={closeDialog} /> : dialog.kind === "form" ? <Form /> : <Basic />}
      </div>
    </div>
  );
}

function Basic() {
  const { dialog, closeDialog } = useApp();
  const d = dialog!;
  const [v, setV] = useState(d.value ?? "");
  const ok = () => closeDialog(d.kind === "confirm" ? "ok" : v);
  return (
    <form onSubmit={(e) => { e.preventDefault(); ok(); }}
      onKeyDown={(e) => { if (e.key === "Escape") closeDialog(null); if (e.key === "Enter" && e.ctrlKey) ok(); }}>
      {d.message && <p>{d.message}</p>}
      {d.kind === "prompt" && (d.multiline
        ? <textarea autoFocus rows={5} value={v} onChange={(e) => setV(e.target.value)} />
        : <input autoFocus value={v} onChange={(e) => setV(e.target.value)} />)}
      {d.kind === "password" && <input autoFocus type="password" value={v} onChange={(e) => setV(e.target.value)} />}
      <div className="modal-actions">
        <button type="button" onClick={() => closeDialog(null)}>Cancelar</button>
        <button type="submit" className="primary" autoFocus={d.kind === "confirm"}>{d.okLabel ?? (d.kind === "confirm" ? "Confirmar" : "OK")}</button>
      </div>
    </form>
  );
}

/** Formulário genérico: campos numa grade de 6 colunas, com validação antes de confirmar. */
function Form() {
  const { dialog, closeDialog } = useApp();
  const d = dialog!;
  const fields = d.fields ?? [];
  const [v, setV] = useState<FormValues>(() => Object.fromEntries(fields.map((f) => [f.id, f.value])));
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false); // senhas visíveis (depois de gerar uma)
  const set = (id: string, val: string | boolean) => { setV((old) => ({ ...old, [id]: val })); setError(null); };
  const ok = () => {
    const e = d.validate?.(v) ?? null;
    if (e) { setError(e); return; }
    closeDialog(JSON.stringify(v));
  };
  const shown = fields.filter((f) => !f.showIf || f.showIf(v));
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); ok(); }}
      onKeyDown={(e) => { if (e.key === "Escape") closeDialog(null); }}>
      {d.message && <p>{d.message}</p>}
      <div className="form-grid">
        {shown.map((f, i) => {
          const common = { id: `f-${f.id}`, autoFocus: i === 0 && f.type !== "checkbox" };
          return (
            <div key={f.id} className={f.type === "checkbox" ? "fld check" : "fld"} style={{ gridColumn: `span ${f.span ?? 6}` }}>
              {f.type === "checkbox" ? (
                <label><input type="checkbox" id={`f-${f.id}`} checked={!!v[f.id]} onChange={(e) => set(f.id, e.target.checked)} /> {f.label}</label>
              ) : (
                <>
                  <div className="fld-head">
                    <label htmlFor={`f-${f.id}`}>{f.label}</label>
                    {f.action && (
                      <button type="button" className="fld-action" onClick={() => { setV(f.action!.run(v)); setError(null); if (f.action!.reveal) setReveal(true); }}>
                        {f.action.label}
                      </button>
                    )}
                  </div>
                  {f.type === "select" ? (
                    <select {...common} value={String(v[f.id])} onChange={(e) => set(f.id, e.target.value)}>
                      {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input {...common} type={f.type === "password" && !reveal ? "password" : "text"} inputMode={f.type === "number" ? "numeric" : undefined}
                      placeholder={f.placeholder} value={String(v[f.id])} onChange={(e) => set(f.id, e.target.value)} />
                  )}
                  {(() => {
                    const n = f.note?.(v);
                    if (!n) return null;
                    return (
                      <div className="fld-note" data-level={n.level ?? ""}>
                        {n.level !== undefined && <span className="meter"><i style={{ width: `${(n.level + 1) * 20}%` }} /></span>}
                        <span>{n.text}</span>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" onClick={() => closeDialog(null)}>Cancelar</button>
        <button type="submit" className="primary">{d.okLabel ?? "OK"}</button>
      </div>
    </form>
  );
}

/** Desenhe a assinatura (ou importe uma imagem). Devolve PNG transparente recortado. */
function SignaturePad({ onDone }: { onDone: (v: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  const W = 560, H = 200;

  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.lineWidth = 2.4; g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = "#102a6b";
  }, []);

  const pos = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const clear = () => { const c = ref.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); setEmpty(true); };

  const importImage = async () => {
    const [f] = await window.papiro.openDialog({ title: "Imagem da assinatura", images: true });
    if (!f) return;
    const url = URL.createObjectURL(new Blob([f.bytes as BlobPart]));
    const img = new Image(); img.src = url; await img.decode();
    clear();
    const s = Math.min(W / img.width, H / img.height);
    ref.current!.getContext("2d")!.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
    URL.revokeObjectURL(url);
    setEmpty(false);
  };

  const finish = () => {
    const c = ref.current!;
    const g = c.getContext("2d")!;
    const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return onDone(null);
    const pad = 6;
    const out = document.createElement("canvas");
    out.width = x1 - x0 + pad * 2; out.height = y1 - y0 + pad * 2;
    out.getContext("2d")!.drawImage(c, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
    onDone(out.toDataURL("image/png"));
  };

  return (
    <div>
      <p>Desenhe sua assinatura no quadro abaixo. Ela fica salva neste computador para os próximos documentos.</p>
      <canvas ref={ref} className="sigpad" style={{ width: W, height: H }}
        onPointerDown={(e) => { drawing.current = true; ref.current!.setPointerCapture(e.pointerId); const [x, y] = pos(e); const g = ref.current!.getContext("2d")!; g.beginPath(); g.moveTo(x, y); }}
        onPointerMove={(e) => { if (!drawing.current) return; const [x, y] = pos(e); const g = ref.current!.getContext("2d")!; g.lineTo(x, y); g.stroke(); setEmpty(false); }}
        onPointerUp={() => { drawing.current = false; }} />
      <div className="modal-actions">
        <button onClick={clear}>Limpar</button>
        <button onClick={importImage}>Importar imagem…</button>
        <span className="grow" />
        <button onClick={() => onDone(null)}>Cancelar</button>
        <button className="primary" disabled={empty} onClick={finish}>Usar assinatura</button>
      </div>
    </div>
  );
}
