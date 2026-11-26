// Diálogo de impressão estilo Foxit com prévia interativa ao vivo.
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDecimal } from "../../shared/i18n.ts";
import {
  computeBookletSpreads, computeScalePct, computeTileGrid, defaultPrintOptions, multipleGrid,
  PAPER_MM, PT_TO_MM, resolvePaperMm, resolvePrintPages,
  type BookletBinding, type BookletSubset, type MultipleOrder, type PaperSizeId,
  type PrinterInfo, type PrintHandlingMode, type PrintJobOptions, type PrintOrientation,
  type PrintRangeMode, type PrintScaleMode, type PrintSubset, type PrintWhat,
} from "../../shared/print-types.ts";
import { engine } from "./api.ts";
import { Icon } from "./icons.tsx";
import { useApp } from "./state.tsx";

const PAPER_ORDER: PaperSizeId[] = ["A4", "Letter", "A3", "Legal", "A5"];

export function PrintDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const doc = app.doc!;
  const total = doc.info.pageCount;

  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [opts, setOpts] = useState<PrintJobOptions>(() => defaultPrintOptions(app.page, ""));
  const [previewIdx, setPreviewIdx] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  // Carrega impressoras reais instaladas no Windows
  useEffect(() => {
    window.papiro.getPrinters().then((list) => {
      setPrinters(list);
      const def = list.find((p) => p.isDefault) ?? list[0];
      if (def) setOpts((o) => (o.printer ? o : { ...o, printer: def.name }));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !printing) onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, printing]);

  const set = <K extends keyof PrintJobOptions>(key: K, val: PrintJobOptions[K]) => {
    setOpts((old) => ({ ...old, [key]: val }));
    setErr(null);
  };

  // Páginas efetivamente selecionadas
  const pages = useMemo(() => resolvePrintPages(opts, total), [opts, total]);

  // Quantidade de folhas de prévia (depende do modo: páginas, folhas N-up ou pares do livreto)
  const bookletSpreads = useMemo(
    () => (opts.handling === "booklet" ? computeBookletSpreads(pages, opts.bookletBinding, opts.bookletSubset) : []),
    [opts.handling, opts.bookletBinding, opts.bookletSubset, pages],
  );

  const firstPageInfo = doc.info.pages[pages[0] ?? app.page] ?? doc.info.pages[0];
  const firstDocWmm = (firstPageInfo?.width ?? 595) * PT_TO_MM;
  const firstDocHmm = (firstPageInfo?.height ?? 842) * PT_TO_MM;

  const firstPaper = useMemo(
    () => resolvePaperMm(
      opts.paperSize,
      opts.handling === "booklet" ? "landscape" : opts.orientation,
      opts.handling === "booklet" ? false : opts.autoRotate,
      firstDocWmm,
      firstDocHmm,
      opts.handling === "scale" && opts.choosePaperByPdfSize,
    ),
    [opts.paperSize, opts.handling, opts.orientation, opts.autoRotate, opts.choosePaperByPdfSize, firstDocWmm, firstDocHmm],
  );

  const nupLayout = useMemo(() => {
    const g = multipleGrid(opts.pagesPerSheet, firstPaper.landscape);
    return { ...g, per: g.cols * g.rows };
  }, [opts.pagesPerSheet, firstPaper.landscape]);

  const previewCount = useMemo(() => {
    if (!pages.length) return 0;
    if (opts.handling === "multiple") return Math.ceil(pages.length / nupLayout.per);
    if (opts.handling === "booklet") return bookletSpreads.length;
    return pages.length;
  }, [pages.length, opts.handling, nupLayout.per, bookletSpreads.length]);

  useEffect(() => {
    setPreviewIdx((i) => Math.max(0, Math.min(i, Math.max(0, previewCount - 1))));
  }, [previewCount]);

  // Página ou conjunto de páginas exibidos na prévia atual
  const curPageIdx = opts.handling === "scale" || opts.handling === "poster"
    ? (pages[previewIdx] ?? pages[0] ?? app.page)
    : (pages[0] ?? app.page);
  const curPageInfo = doc.info.pages[curPageIdx] ?? doc.info.pages[0];
  const curDocWmm = (curPageInfo?.width ?? 595) * PT_TO_MM;
  const curDocHmm = (curPageInfo?.height ?? 842) * PT_TO_MM;

  const curPaper = useMemo(
    () => resolvePaperMm(
      opts.paperSize,
      opts.handling === "booklet" ? "landscape" : opts.orientation,
      opts.handling === "booklet" ? false : opts.autoRotate,
      curDocWmm,
      curDocHmm,
      opts.handling === "scale" && opts.choosePaperByPdfSize,
    ),
    [opts.paperSize, opts.handling, opts.orientation, opts.autoRotate, opts.choosePaperByPdfSize, curDocWmm, curDocHmm],
  );

  const effectiveZoom = useMemo(() => {
    if (opts.handling === "poster") return Math.max(10, Math.min(400, opts.tileScale || 100));
    if (opts.handling === "multiple") {
      const cellW = (curPaper.w - 10 - (nupLayout.cols - 1) * 3) / nupLayout.cols;
      const cellH = (curPaper.h - 10 - (nupLayout.rows - 1) * 3) / nupLayout.rows;
      return Math.min(cellW / curDocWmm, cellH / curDocHmm) * 100;
    }
    if (opts.handling === "booklet") {
      const cellW = (curPaper.w - 13) / 2;
      const cellH = curPaper.h - 10;
      return Math.min(cellW / curDocWmm, cellH / curDocHmm) * 100;
    }
    return computeScalePct(curDocWmm, curDocHmm, curPaper.w, curPaper.h, opts.scaleMode, opts.customScale, 5);
  }, [opts.handling, opts.tileScale, opts.scaleMode, opts.customScale, curDocWmm, curDocHmm, curPaper, nupLayout]);

  const tileGrid = useMemo(
    () => (opts.handling === "poster"
      ? computeTileGrid(curDocWmm, curDocHmm, curPaper.w, curPaper.h, opts.tileScale, opts.tileOverlapMm, 6)
      : null),
    [opts.handling, curDocWmm, curDocHmm, curPaper, opts.tileScale, opts.tileOverlapMm],
  );

  // Quais páginas precisam estar renderizadas para a prévia atual
  const previewPagesNeeded = useMemo(() => {
    if (!pages.length) return [] as (number | null)[];
    if (opts.handling === "scale" || opts.handling === "poster") return [pages[previewIdx] ?? pages[0]];
    if (opts.handling === "booklet") {
      const sp = bookletSpreads[previewIdx] ?? [null, null];
      return [sp[0], sp[1]];
    }
    const start = previewIdx * nupLayout.per;
    const chunk = pages.slice(start, start + nupLayout.per);
    const ordered: (number | null)[] = Array(nupLayout.per).fill(null);
    chunk.forEach((p, idx) => {
      if (opts.multipleOrder === "horizontal") ordered[idx] = p;
      else if (opts.multipleOrder === "horizontalRev") {
        const row = Math.floor(idx / nupLayout.cols), col = nupLayout.cols - 1 - (idx % nupLayout.cols);
        ordered[row * nupLayout.cols + col] = p;
      } else {
        const col = Math.floor(idx / nupLayout.rows), row = idx % nupLayout.rows;
        ordered[row * nupLayout.cols + col] = p;
      }
    });
    return ordered;
  }, [pages, opts.handling, opts.multipleOrder, previewIdx, bookletSpreads, nupLayout]);

  const cm = (mm: number) => formatDecimal(mm / 10, 1, app.lang);
  const pctStr = `${formatDecimal(effectiveZoom, 2, app.lang)}%`;

  const doPrint = async (systemDialog = false) => {
    if (!pages.length) {
      setErr(app.t("print.invalidRange"));
      return;
    }
    setPrinting(true);
    try {
      const r = await app.executePrint({ ...opts, systemDialog });
      if (r?.ok) {
        app.notify(app.t("print.sent", { n: r.pages }));
        onClose();
      }
    } finally {
      setPrinting(false);
    }
  };

  const summarizeComments = async () => {
    const path = await window.papiro.saveDialog(`${doc.name.replace(/\.pdf$/i, "")}_comentarios.pdf`, "pdf");
    if (!path) return;
    await app.task(`${app.t("print.summarizeComments")}…`, async () => {
      await engine.saveCommentsSummary(path, "pdf");
      app.notify(app.t("state.savedIn", { target: path }));
    });
  };

  const paperAspect = curPaper.w / Math.max(1, curPaper.h);
  // Cabe confortavelmente no quadro de prévia 280×290
  const maxBoxW = 276, maxBoxH = 264;
  const sheetW = paperAspect >= maxBoxW / maxBoxH ? maxBoxW : maxBoxH * paperAspect;
  const sheetH = sheetW / paperAspect;

  const isSheetMode = opts.handling === "multiple" || opts.handling === "booklet";
  const rangePlaceholder = `1-${total}`;

  return (
    <div className="modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget && !printing) onClose(); }}>
      <div className="modal print-modal" role="dialog" aria-modal="true" aria-label={app.t("print.title")}>
        <header className="pm-head">
          <div className="pm-title">
            <Icon name="print" size={18} />
            <h2>{app.t("print.title")}</h2>
          </div>
          <button type="button" className="pm-close" onClick={onClose} disabled={printing} aria-label={app.t("common.close")}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="pm-body">
          {/* Coluna Esquerda + Meio (controles Foxit) */}
          <div className="pm-controls">
            {/* Faixa superior: Impressora + Cópias + Opções rápidas */}
            <section className="pm-top">
              <div className="pm-row">
                <label className="pm-lbl" htmlFor="pm-printer">{app.t("print.printerName")}</label>
                <select id="pm-printer" className="pm-printer-sel" value={opts.printer} onChange={(e) => set("printer", e.target.value)}>
                  {printers.length === 0 && <option value="">{app.t("print.defaultPrinter")}</option>}
                  {printers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.displayName}{p.isDefault ? " ★" : ""}
                    </option>
                  ))}
                </select>
                <button type="button" className="pm-sec-btn" disabled={printing} onClick={() => doPrint(true)}>
                  {app.t("print.properties")}
                </button>
              </div>

              <div className="pm-row pm-quick">
                <label className="pm-lbl" htmlFor="pm-copies">{app.t("print.copies")}</label>
                <input
                  id="pm-copies"
                  type="number"
                  min={1}
                  max={99}
                  className="pm-num"
                  value={opts.copies}
                  onChange={(e) => set("copies", Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
                />
                <label className="pm-chk">
                  <input type="checkbox" checked={opts.collate} disabled={opts.copies <= 1} onChange={(e) => set("collate", e.target.checked)} />
                  {app.t("print.collate")}
                </label>
                <label className="pm-chk">
                  <input type="checkbox" checked={opts.grayscale} onChange={(e) => set("grayscale", e.target.checked)} />
                  {app.t("print.grayscale")}
                </label>
                <label className="pm-chk">
                  <input type="checkbox" checked={opts.printAsImage} onChange={(e) => set("printAsImage", e.target.checked)} />
                  {app.t("print.asImage")}
                </label>
                <label className="pm-chk">
                  <input type="checkbox" checked={opts.showBorder} onChange={(e) => set("showBorder", e.target.checked)} />
                  {app.t("print.showBorder")}
                </label>
              </div>
            </section>

            {/* Grade 2 colunas: Intervalo + Frente/Verso; Manipulação + Orientação/Papel/O Quê */}
            <div className="pm-grid">
              {/* Intervalo de Impressão */}
              <fieldset className="pm-box">
                <legend>{app.t("print.rangeGroup")}</legend>
                {(
                  [
                    ["view", "print.rangeView"],
                    ["current", "print.rangeCurrent"],
                    ["all", "print.rangeAll"],
                  ] as [PrintRangeMode, Parameters<typeof app.t>[0]][]
                ).map(([val, k]) => (
                  <label key={val} className="pm-radio">
                    <input type="radio" name="pm-range" checked={opts.rangeMode === val} onChange={() => set("rangeMode", val)} />
                    <span>{app.t(k)}</span>
                  </label>
                ))}
                <div className="pm-custom-range">
                  <label className="pm-radio">
                    <input type="radio" name="pm-range" checked={opts.rangeMode === "custom"} onChange={() => set("rangeMode", "custom")} />
                    <span>{app.t("print.rangeCustom")}</span>
                  </label>
                  <input
                    type="text"
                    value={opts.customRange}
                    placeholder={rangePlaceholder}
                    onFocus={() => set("rangeMode", "custom")}
                    onChange={(e) => setOpts((o) => ({ ...o, rangeMode: "custom", customRange: e.target.value }))}
                  />
                  <span className="pm-muted">/ {total}</span>
                </div>
                <small className="pm-hint">{app.t("print.rangeExample")}</small>
                <div className="pm-inline-fld">
                  <label htmlFor="pm-subset">{app.t("print.subset")}</label>
                  <select id="pm-subset" value={opts.subset} onChange={(e) => set("subset", e.target.value as PrintSubset)}>
                    <option value="all">{app.t("print.subsetAll")}</option>
                    <option value="odd">{app.t("print.subsetOdd")}</option>
                    <option value="even">{app.t("print.subsetEven")}</option>
                  </select>
                </div>
                <label className="pm-chk">
                  <input type="checkbox" checked={opts.reverse} onChange={(e) => set("reverse", e.target.checked)} />
                  {app.t("print.reverse")}
                </label>
              </fieldset>

              {/* Frente e Verso + Auto-rotação + Centralizar */}
              <fieldset className="pm-box">
                <label className="pm-chk">
                  <input type="checkbox" checked={opts.duplex} onChange={(e) => set("duplex", e.target.checked)} />
                  {app.t("print.duplex")}
                </label>
                <div className="pm-indent">
                  <label className={opts.duplex ? "pm-radio" : "pm-radio dis"}>
                    <input type="radio" name="pm-duplex" disabled={!opts.duplex} checked={opts.duplexEdge === "long"} onChange={() => set("duplexEdge", "long")} />
                    <span>{app.t("print.duplexLong")}</span>
                  </label>
                  <label className={opts.duplex ? "pm-radio" : "pm-radio dis"}>
                    <input type="radio" name="pm-duplex" disabled={!opts.duplex} checked={opts.duplexEdge === "short"} onChange={() => set("duplexEdge", "short")} />
                    <span>{app.t("print.duplexShort")}</span>
                  </label>
                </div>
                <div className="pm-sep" />
                <label className="pm-chk">
                  <input type="checkbox" checked={opts.autoRotate} disabled={opts.handling === "booklet"} onChange={(e) => set("autoRotate", e.target.checked)} />
                  {app.t("print.autoRotate")}
                </label>
                <label className="pm-chk">
                  <input type="checkbox" checked={opts.autoCenter} disabled={opts.handling !== "scale"} onChange={(e) => set("autoCenter", e.target.checked)} />
                  {app.t("print.autoCenter")}
                </label>
              </fieldset>

              {/* Manipulação de Impressão (4 abas Foxit!) */}
              <fieldset className="pm-box pm-handling">
                <legend>{app.t("print.handlingGroup")}</legend>
                <div className="pm-mode-tabs" role="tablist">
                  {(
                    [
                      ["scale", "print.modeScale"],
                      ["poster", "print.modePoster"],
                      ["multiple", "print.modeMultiple"],
                      ["booklet", "print.modeBooklet"],
                    ] as [PrintHandlingMode, Parameters<typeof app.t>[0]][]
                  ).map(([m, k]) => (
                    <button
                      key={m}
                      type="button"
                      role="tab"
                      aria-selected={opts.handling === m}
                      className={opts.handling === m ? "pm-mtab on" : "pm-mtab"}
                      onClick={() => set("handling", m)}
                    >
                      {app.t(k)}
                    </button>
                  ))}
                </div>

                {opts.handling === "scale" && (
                  <div className="pm-mode-body">
                    {(
                      [
                        ["none", "print.scaleNone"],
                        ["fit", "print.scaleFit"],
                        ["shrink", "print.scaleShrink"],
                      ] as [PrintScaleMode, Parameters<typeof app.t>[0]][]
                    ).map(([m, k]) => (
                      <label key={m} className="pm-radio">
                        <input type="radio" name="pm-scale" checked={opts.scaleMode === m} onChange={() => set("scaleMode", m)} />
                        <span>{app.t(k)}</span>
                      </label>
                    ))}
                    <div className="pm-custom-scale">
                      <label className="pm-radio">
                        <input type="radio" name="pm-scale" checked={opts.scaleMode === "custom"} onChange={() => set("scaleMode", "custom")} />
                        <span>{app.t("print.scaleCustom")}</span>
                      </label>
                      <input
                        type="number"
                        min={10}
                        max={400}
                        className="pm-num"
                        value={opts.customScale}
                        onFocus={() => set("scaleMode", "custom")}
                        onChange={(e) => setOpts((o) => ({ ...o, scaleMode: "custom", customScale: Math.max(10, Math.min(400, Number(e.target.value) || 100)) }))}
                      />
                      <span className="pm-muted">%</span>
                    </div>
                    <label className="pm-chk">
                      <input type="checkbox" checked={opts.choosePaperByPdfSize} onChange={(e) => set("choosePaperByPdfSize", e.target.checked)} />
                      {app.t("print.choosePaperByPdf")}
                    </label>
                  </div>
                )}

                {opts.handling === "poster" && (
                  <div className="pm-mode-body">
                    <div className="pm-inline-fld">
                      <label htmlFor="pm-tscale">{app.t("print.tileScale")}</label>
                      <input
                        id="pm-tscale"
                        type="number"
                        min={25}
                        max={400}
                        className="pm-num"
                        value={opts.tileScale}
                        onChange={(e) => set("tileScale", Math.max(25, Math.min(400, Number(e.target.value) || 100)))}
                      />
                    </div>
                    <div className="pm-inline-fld">
                      <label htmlFor="pm-tover">{app.t("print.tileOverlap")}</label>
                      <input
                        id="pm-tover"
                        type="number"
                        min={0}
                        max={50}
                        className="pm-num"
                        value={opts.tileOverlapMm}
                        onChange={(e) => set("tileOverlapMm", Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
                      />
                    </div>
                    <label className="pm-chk">
                      <input type="checkbox" checked={opts.tileCutMarks} onChange={(e) => set("tileCutMarks", e.target.checked)} />
                      {app.t("print.tileCutMarks")}
                    </label>
                  </div>
                )}

                {opts.handling === "multiple" && (
                  <div className="pm-mode-body">
                    <div className="pm-inline-fld">
                      <label htmlFor="pm-pps">{app.t("print.pagesPerSheet")}</label>
                      <select
                        id="pm-pps"
                        value={String(opts.pagesPerSheet)}
                        onChange={(e) => set("pagesPerSheet", Number(e.target.value) as 2 | 4 | 6 | 9 | 16)}
                      >
                        {[2, 4, 6, 9, 16].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </div>
                    <div className="pm-inline-fld">
                      <label htmlFor="pm-mord">{app.t("print.pageOrder")}</label>
                      <select id="pm-mord" value={opts.multipleOrder} onChange={(e) => set("multipleOrder", e.target.value as MultipleOrder)}>
                        <option value="horizontal">{app.t("print.orderH")}</option>
                        <option value="horizontalRev">{app.t("print.orderHRev")}</option>
                        <option value="vertical">{app.t("print.orderV")}</option>
                      </select>
                    </div>
                    <label className="pm-chk">
                      <input type="checkbox" checked={opts.multipleBorder} onChange={(e) => set("multipleBorder", e.target.checked)} />
                      {app.t("print.pageBorder")}
                    </label>
                  </div>
                )}

                {opts.handling === "booklet" && (
                  <div className="pm-mode-body">
                    <div className="pm-inline-fld">
                      <label htmlFor="pm-bsub">{app.t("print.bookletSubset")}</label>
                      <select id="pm-bsub" value={opts.bookletSubset} onChange={(e) => set("bookletSubset", e.target.value as BookletSubset)}>
                        <option value="both">{app.t("print.bookletBoth")}</option>
                        <option value="front">{app.t("print.bookletFront")}</option>
                        <option value="back">{app.t("print.bookletBack")}</option>
                      </select>
                    </div>
                    <div className="pm-inline-fld">
                      <label htmlFor="pm-bbind">{app.t("print.bookletBinding")}</label>
                      <select id="pm-bbind" value={opts.bookletBinding} onChange={(e) => set("bookletBinding", e.target.value as BookletBinding)}>
                        <option value="left">{app.t("print.bindingLeft")}</option>
                        <option value="right">{app.t("print.bindingRight")}</option>
                      </select>
                    </div>
                  </div>
                )}
              </fieldset>

              {/* Coluna do meio inferior: Orientação + Papel + Imprimir o Quê */}
              <div className="pm-stack">
                <fieldset className="pm-box">
                  <legend>{app.t("print.orientationGroup")}</legend>
                  <select
                    value={opts.handling === "booklet" ? "landscape" : opts.orientation}
                    disabled={opts.handling === "booklet"}
                    onChange={(e) => set("orientation", e.target.value as PrintOrientation)}
                  >
                    <option value="auto">{app.t("print.orientAuto")}</option>
                    <option value="portrait">{app.t("print.orientPortrait")}</option>
                    <option value="landscape">{app.t("print.orientLandscape")}</option>
                  </select>
                </fieldset>

                <fieldset className="pm-box">
                  <legend>{app.t("print.paperSizeGroup")}</legend>
                  <select
                    value={opts.paperSize}
                    disabled={opts.handling === "scale" && opts.choosePaperByPdfSize}
                    onChange={(e) => set("paperSize", e.target.value as PaperSizeId)}
                  >
                    {PAPER_ORDER.map((id) => <option key={id} value={id}>{PAPER_MM[id].label}</option>)}
                  </select>
                </fieldset>

                <fieldset className="pm-box">
                  <legend>{app.t("print.whatGroup")}</legend>
                  <select value={opts.printWhat} onChange={(e) => set("printWhat", e.target.value as PrintWhat)}>
                    <option value="docAndAnnots">{app.t("print.whatDocAnnots")}</option>
                    <option value="docOnly">{app.t("print.whatDocOnly")}</option>
                  </select>
                  <button type="button" className="pm-sec-btn pm-full" onClick={summarizeComments}>
                    {app.t("print.summarizeComments")}
                  </button>
                </fieldset>
              </div>
            </div>
          </div>

          {/* Coluna Direita: Visualizar (Prévia ao Vivo estilo Foxit!) */}
          <fieldset className="pm-box pm-preview-col">
            <legend>{app.t("print.previewGroup")}</legend>
            <div className="pm-metrics">
              <div><span>{app.t("print.previewZoom")}</span> <b>{pctStr}</b></div>
              <div className="pm-dims">
                <span>{app.t("print.previewDoc")} <b>{cm(curDocWmm)} × {cm(curDocHmm)} cm</b></span>
                <span>{app.t("print.previewPaper")} <b>{cm(curPaper.w)} × {cm(curPaper.h)} cm</b></span>
              </div>
              {tileGrid && (
                <div className="pm-tile-badge">
                  {app.t("print.previewTilesInfo", { cols: tileGrid.cols, rows: tileGrid.rows, n: tileGrid.cols * tileGrid.rows })}
                </div>
              )}
            </div>

            <div className="pm-stage">
              {pages.length === 0 ? (
                <p className="empty">{app.t("print.invalidRange")}</p>
              ) : (
                <div
                  className={opts.grayscale ? "pm-sheet gray" : "pm-sheet"}
                  style={{ width: sheetW, height: sheetH }}
                >
                  {opts.handling === "scale" && (
                    <div
                      className="pm-sheet-scale"
                      style={{
                        alignItems: opts.autoCenter ? "center" : "flex-start",
                        justifyContent: opts.autoCenter ? "center" : "flex-start",
                      }}
                    >
                      <PreviewThumb
                        page={previewPagesNeeded[0]}
                        style={{
                          width: `${((curDocWmm * effectiveZoom) / 100 / curPaper.w) * 100}%`,
                          height: `${((curDocHmm * effectiveZoom) / 100 / curPaper.h) * 100}%`,
                          outline: opts.showBorder ? "1px solid #333" : undefined,
                        }}
                      />
                    </div>
                  )}

                  {opts.handling === "poster" && tileGrid && (
                    <div className="pm-sheet-poster">
                      <PreviewThumb page={previewPagesNeeded[0]} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                      <div
                        className="pm-tile-grid"
                        style={{
                          gridTemplateColumns: `repeat(${tileGrid.cols}, 1fr)`,
                          gridTemplateRows: `repeat(${tileGrid.rows}, 1fr)`,
                        }}
                      >
                        {Array.from({ length: tileGrid.cols * tileGrid.rows }, (_, k) => (
                          <span key={k} className="pm-tile-cell">{k + 1}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {opts.handling === "multiple" && (
                    <div
                      className="pm-sheet-nup"
                      style={{
                        gridTemplateColumns: `repeat(${nupLayout.cols}, 1fr)`,
                        gridTemplateRows: `repeat(${nupLayout.rows}, 1fr)`,
                      }}
                    >
                      {previewPagesNeeded.map((p, idx) => (
                        <div key={idx} className={opts.multipleBorder || opts.showBorder ? "pm-nup-cell bordered" : "pm-nup-cell"}>
                          {p !== null && <PreviewThumb page={p} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />}
                        </div>
                      ))}
                    </div>
                  )}

                  {opts.handling === "booklet" && (
                    <div className="pm-sheet-nup" style={{ gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr" }}>
                      {previewPagesNeeded.map((p, idx) => (
                        <div key={idx} className={opts.showBorder ? "pm-nup-cell bordered" : "pm-nup-cell"}>
                          {p !== null && <PreviewThumb page={p} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="pm-nav">
              <button type="button" disabled={previewIdx <= 0} onClick={() => setPreviewIdx((i) => Math.max(0, i - 1))} aria-label={app.t("app.prevPage")}>
                <Icon name="chevL" size={14} />
              </button>
              <input
                type="range"
                min={0}
                max={Math.max(0, previewCount - 1)}
                value={previewIdx}
                disabled={previewCount <= 1}
                onChange={(e) => setPreviewIdx(Number(e.target.value))}
              />
              <button type="button" disabled={previewIdx >= previewCount - 1} onClick={() => setPreviewIdx((i) => Math.min(previewCount - 1, i + 1))} aria-label={app.t("app.nextPage")}>
                <Icon name="chevR" size={14} />
              </button>
              <span className="pm-pgcount">
                {previewCount > 0
                  ? app.t(isSheetMode ? "print.previewSheetOf" : "print.previewPageOf", { cur: previewIdx + 1, total: previewCount })
                  : "0 / 0"}
              </span>
            </div>
          </fieldset>
        </div>

        {err && <p className="form-error pm-err" role="alert">{err}</p>}

        <footer className="pm-foot">
          <button type="button" className="pm-sec-btn" disabled={printing} onClick={() => doPrint(true)}>
            {app.t("print.systemDialog")}
          </button>
          <span className="grow" />
          <button type="button" className="primary" disabled={printing || pages.length === 0} onClick={() => doPrint(false)}>
            {app.t("print.okBtn")}
          </button>
          <button type="button" className="pm-sec-btn" disabled={printing} onClick={onClose}>
            {app.t("common.cancel")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Miniatura renderizada via MuPDF com cache local durante o diálogo de impressão. */
function PreviewThumb({ page, style }: { page: number | null; style?: React.CSSProperties }) {
  const { doc } = useApp();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (page === null || !doc) return;
    let dead = false;
    const p = doc.info.pages[page];
    if (!p) return;
    const scale = Math.min(480 / Math.max(1, p.width), 480 / Math.max(1, p.height));
    engine.render(page, Math.max(0.2, Math.min(1.5, scale))).then((img) => {
      if (dead || !ref.current) return;
      ref.current.width = img.width;
      ref.current.height = img.height;
      ref.current.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
    }).catch(() => {});
    return () => { dead = true; };
  }, [page, doc?.id, doc?.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  if (page === null) return null;
  return <canvas ref={ref} className="pm-canvas" style={style} />;
}
