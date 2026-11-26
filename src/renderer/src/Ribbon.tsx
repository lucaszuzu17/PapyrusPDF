// Faixa de opções estilo Foxit (nas cores do ícone PapyrusPDF): Arquivo (Backstage) + QAT + Abas → Grupos → Comandos.
import { useEffect, useState } from "react";
import type { I18nKey, LangPref } from "../../shared/i18n.ts";
import { engine } from "./api.ts";
import { PapyrusLogo } from "./BrandMark.tsx";
import * as feat from "./features.ts";
import { Icon } from "./icons.tsx";
import { ocrLangOptions, useApp, type RGB, type Tool } from "./state.tsx";
import { tts, type TtsState } from "./tts.ts";

type App = ReturnType<typeof useApp>;

interface Cmd {
  id: string;
  labelKey: I18nKey;
  icon: string;
  tool?: Tool;
  run?: (a: App) => unknown;
  needsDoc?: boolean;
  enabled?: (a: App) => boolean;
  /** Botão de liga/desliga: aparece marcado quando devolve true. */
  on?: (a: App) => boolean;
  titleKey?: I18nKey;
}
interface Group { labelKey: I18nKey; cmds: (Cmd | "color" | "ocrlang" | "ocropts")[] }
interface Tab { id: string; labelKey: I18nKey; groups: Group[] }

/** Páginas-alvo das ações de organizar: seleção do organizador, senão a página atual. */
const targets = (a: App) => (a.view === "organize" && a.selectedPages.length ? a.selectedPages : [a.page]);

const TABS: Tab[] = [
  {
    id: "home", labelKey: "tab.home", groups: [
      { labelKey: "grp.file", cmds: [
        { id: "open", labelKey: "cmd.open", icon: "open", run: (a) => a.openFile(), titleKey: "cmd.open.tip" },
        { id: "save", labelKey: "cmd.save", icon: "save", needsDoc: true, run: (a) => a.save(), titleKey: "cmd.save.tip" },
        { id: "saveAs", labelKey: "cmd.saveAs", icon: "saveAs", needsDoc: true, run: (a) => a.save(true), titleKey: "cmd.saveAs.tip" },
        { id: "print", labelKey: "cmd.print", icon: "print", needsDoc: true, run: (a) => a.printDoc(), titleKey: "cmd.print.tip" },
      ] },
      { labelKey: "grp.create", cmds: [
        { id: "merge", labelKey: "cmd.merge", icon: "merge", run: (a) => a.mergeFiles(), titleKey: "cmd.merge.tip" },
        { id: "fromImg", labelKey: "cmd.fromImg", icon: "image", run: (a) => a.newFromImages(), titleKey: "cmd.fromImg.tip" },
        { id: "fromHtml", labelKey: "cmd.fromHtml", icon: "htmlPdf", run: feat.fromHtmlOrMarkdown, titleKey: "cmd.fromHtml.tip" },
      ] },
      { labelKey: "grp.export", cmds: [
        { id: "compress", labelKey: "cmd.compress", icon: "compress", needsDoc: true, run: feat.compress, titleKey: "cmd.compress.tip" },
        { id: "compare", labelKey: "cmd.compare", icon: "compare", needsDoc: true, run: feat.comparePdf, titleKey: "cmd.compare.tip" },
        { id: "batch", labelKey: "cmd.batch", icon: "batch", run: feat.batchProcess, titleKey: "cmd.batch.tip" },
      ] },
      { labelKey: "grp.tools", cmds: [
        { id: "select", labelKey: "cmd.select", icon: "select", tool: "select", needsDoc: true },
        { id: "hand", labelKey: "cmd.hand", icon: "hand", tool: "hand", needsDoc: true },
      ] },
      { labelKey: "grp.view", cmds: [
        { id: "zoomOut", labelKey: "cmd.zoomOut", icon: "zoomOut", needsDoc: true, run: (a) => a.setZoom((z) => z / 1.2) },
        { id: "zoomIn", labelKey: "cmd.zoomIn", icon: "zoomIn", needsDoc: true, run: (a) => a.setZoom((z) => z * 1.2) },
        { id: "fit", labelKey: "cmd.fit", icon: "fitWidth", needsDoc: true, run: (a) => a.fitWidth() },
        { id: "two", labelKey: "cmd.two", icon: "twoPages", needsDoc: true, on: (a) => a.layout === "double",
          run: (a) => a.setLayout(a.layout === "double" ? "single" : "double"), titleKey: "cmd.two.tip" },
        { id: "readMode", labelKey: "cmd.readMode", icon: "readMode", needsDoc: true, on: (a) => a.readMode !== "normal",
          run: feat.cycleReadMode, titleKey: "cmd.readMode.tip" },
        { id: "tts", labelKey: "cmd.tts", icon: "speak", needsDoc: true, on: () => tts.snapshot().active,
          run: (a) => {
            if (tts.snapshot().active) tts.stop();
            else tts.start(a.page, a.doc!.info.pageCount, a.goTo, a.lang);
          }, titleKey: "cmd.tts.tip" },
        { id: "full", labelKey: "cmd.full", icon: "fullscreen", needsDoc: true, run: (a) => a.toggleFullScreen(true), titleKey: "cmd.full.tip" },
      ] },
      { labelKey: "grp.history", cmds: [
        { id: "undo", labelKey: "cmd.undo", icon: "undo", needsDoc: true, enabled: (a) => !!a.doc?.info.canUndo, run: (a) => a.undo(), titleKey: "cmd.undo.tip" },
        { id: "redo", labelKey: "cmd.redo", icon: "redo", needsDoc: true, enabled: (a) => !!a.doc?.info.canRedo, run: (a) => a.redo(), titleKey: "cmd.redo.tip" },
      ] },
    ],
  },
  {
    id: "convert", labelKey: "tab.convert", groups: [
      { labelKey: "grp.fromPdf", cmds: [
        { id: "toWord", labelKey: "cmd.toWord", icon: "toWord", needsDoc: true, run: feat.toWord, titleKey: "cmd.toWord.tip" },
        { id: "toCsv", labelKey: "cmd.toCsv", icon: "csv", needsDoc: true, run: feat.toCsv, titleKey: "cmd.toCsv.tip" },
        { id: "toText", labelKey: "cmd.toText", icon: "toText", needsDoc: true, run: feat.toText, titleKey: "cmd.toText.tip" },
        { id: "toImg2", labelKey: "cmd.toImg", icon: "imageOut", needsDoc: true, run: feat.exportImages, titleKey: "cmd.toImg.tip" },
      ] },
      { labelKey: "grp.toPdf", cmds: [
        { id: "fromImg2", labelKey: "cmd.fromImg", icon: "image", run: (a) => a.newFromImages(), titleKey: "cmd.fromImg.tip" },
        { id: "fromHtml2", labelKey: "cmd.fromHtml", icon: "htmlPdf", run: feat.fromHtmlOrMarkdown, titleKey: "cmd.fromHtml.tip" },
        { id: "merge2", labelKey: "cmd.merge", icon: "merge", run: (a) => a.mergeFiles(), titleKey: "cmd.merge.tip" },
      ] },
    ],
  },
  {
    id: "comment", labelKey: "tab.comment", groups: [
      { labelKey: "grp.markup", cmds: [
        { id: "hl", labelKey: "cmd.hl", icon: "highlight", tool: "highlight", needsDoc: true },
        { id: "ul", labelKey: "cmd.ul", icon: "underline", tool: "underline", needsDoc: true },
        { id: "so", labelKey: "cmd.so", icon: "strike", tool: "strikeout", needsDoc: true },
      ] },
      { labelKey: "grp.notes", cmds: [
        { id: "note", labelKey: "cmd.note", icon: "note", tool: "note", needsDoc: true },
        { id: "ft", labelKey: "cmd.ft", icon: "freetext", tool: "freetext", needsDoc: true },
      ] },
      { labelKey: "grp.draw", cmds: [
        { id: "ink", labelKey: "cmd.ink", icon: "ink", tool: "ink", needsDoc: true },
        { id: "rect", labelKey: "cmd.rect", icon: "rect", tool: "rect", needsDoc: true },
        { id: "ell", labelKey: "cmd.ell", icon: "ellipse", tool: "ellipse", needsDoc: true },
        { id: "line", labelKey: "cmd.line", icon: "line", tool: "line", needsDoc: true },
        { id: "arrow", labelKey: "cmd.arrow", icon: "arrow", tool: "arrow", needsDoc: true },
      ] },
      { labelKey: "grp.stampMeasure", cmds: [
        { id: "stamp", labelKey: "cmd.stamp", icon: "stamp", needsDoc: true, run: feat.chooseStamp, titleKey: "cmd.stamp.tip" },
        { id: "measure", labelKey: "cmd.measure", icon: "ruler", tool: "measure", needsDoc: true, titleKey: "cmd.measure.tip" },
      ] },
      { labelKey: "grp.color", cmds: ["color"] },
    ],
  },
  {
    id: "edit", labelKey: "tab.edit", groups: [
      { labelKey: "grp.content", cmds: [
        { id: "et", labelKey: "cmd.et", icon: "editText", tool: "edittext", needsDoc: true, titleKey: "cmd.et.tip" },
        { id: "at", labelKey: "cmd.at", icon: "addText", tool: "addtext", needsDoc: true, titleKey: "cmd.at.tip" },
        { id: "oimg", labelKey: "cmd.oimg", icon: "overlayImg", needsDoc: true, run: feat.chooseOverlayImage, titleKey: "cmd.oimg.tip" },
        { id: "lnk", labelKey: "cmd.lnk", icon: "link", tool: "link", needsDoc: true, titleKey: "cmd.lnk.tip" },
        { id: "repl", labelKey: "cmd.repl", icon: "replace", needsDoc: true, run: (a) => a.setPanel("search"), titleKey: "cmd.repl.tip" },
      ] },
      { labelKey: "grp.allPages", cmds: [
        { id: "hf", labelKey: "cmd.hf", icon: "header", needsDoc: true, run: feat.headerFooter, titleKey: "cmd.hf.tip" },
        { id: "num", labelKey: "cmd.num", icon: "number", needsDoc: true, run: feat.numberPages },
        { id: "bates", labelKey: "cmd.bates", icon: "bates", needsDoc: true, run: feat.batesNumbering, titleKey: "cmd.bates.tip" },
        { id: "wm", labelKey: "cmd.wm", icon: "watermark", needsDoc: true, run: feat.watermark, titleKey: "cmd.wm.tip" },
        { id: "wmOff", labelKey: "cmd.wmOff", icon: "watermarkOff", needsDoc: true, run: feat.removeWatermarks, titleKey: "cmd.wmOff.tip" },
      ] },
      { labelKey: "grp.history", cmds: [
        { id: "undo2", labelKey: "cmd.undo", icon: "undo", needsDoc: true, enabled: (a) => !!a.doc?.info.canUndo, run: (a) => a.undo() },
        { id: "redo2", labelKey: "cmd.redo", icon: "redo", needsDoc: true, enabled: (a) => !!a.doc?.info.canRedo, run: (a) => a.redo() },
      ] },
    ],
  },
  {
    id: "organize", labelKey: "tab.organize", groups: [
      { labelKey: "grp.display", cmds: [
        { id: "grid", labelKey: "cmd.grid", icon: "grid", needsDoc: true, run: (a) => a.setView(a.view === "organize" ? "read" : "organize") },
      ] },
      { labelKey: "grp.pages", cmds: [
        { id: "rl", labelKey: "cmd.rl", icon: "rotateCcw", needsDoc: true, run: (a) => a.mutate(a.t("ribbon.rotating"), () => engine.rotatePages(targets(a), -90)) },
        { id: "rr", labelKey: "cmd.rr", icon: "rotateCw", needsDoc: true, run: (a) => a.mutate(a.t("ribbon.rotating"), () => engine.rotatePages(targets(a), 90)) },
        { id: "del", labelKey: "cmd.del", icon: "trash", needsDoc: true, run: async (a) => {
          const tgt = targets(a);
          const ok = await a.ask({
            kind: "confirm",
            title: a.t("ribbon.delPagesTitle"),
            message: tgt.length === 1 ? a.t("ribbon.delPageOne", { n: tgt[0] + 1 }) : a.t("ribbon.delPageMany", { n: tgt.length }),
          });
          if (ok !== null) { await a.mutate(a.t("common.deleting"), () => engine.deletePages(tgt)); a.setSelectedPages([]); }
        } },
        { id: "blank", labelKey: "cmd.blank", icon: "blank", needsDoc: true, run: (a) => a.mutate(a.t("common.inserting"), () => engine.insertBlankPage(Math.max(...targets(a)) + 1)) },
        { id: "crop", labelKey: "cmd.crop", icon: "crop", needsDoc: true, run: feat.cropPages, titleKey: "cmd.crop.tip" },
        { id: "norm", labelKey: "cmd.norm", icon: "pageSize", needsDoc: true, run: feat.normalizeSizes, titleKey: "cmd.norm.tip" },
        { id: "plbl", labelKey: "cmd.plbl", icon: "pageLabel", needsDoc: true, run: feat.pageLabels, titleKey: "cmd.plbl.tip" },
      ] },
      { labelKey: "grp.files", cmds: [
        { id: "insf", labelKey: "cmd.insf", icon: "insertFile", needsDoc: true, run: async (a) => {
          const [f] = await window.papiro.openDialog({ title: a.t("ribbon.insertPdfTitle") });
          if (f) await a.mutate(a.t("common.inserting"), () => engine.insertFromPdf(f.bytes, Math.max(...targets(a)) + 1));
        } },
        { id: "insImg", labelKey: "cmd.insImg", icon: "image", needsDoc: true, run: (a) => a.insertImages(), titleKey: "cmd.insImg.tip" },
        { id: "ext", labelKey: "cmd.ext", icon: "extract", needsDoc: true, run: async (a) => {
          const tgt = [...targets(a)].sort((x, y) => x - y);
          const path = await window.papiro.saveDialog(`${a.doc!.name.replace(/\.pdf$/i, "")}_${a.t("ribbon.pagesSuffix")}_${tgt.map((p) => p + 1).join("-")}.pdf`);
          if (!path) return;
          await a.task(a.t("ribbon.extracting"), async () => {
            await window.papiro.writeFile(path, await engine.extractPages(tgt));
            a.notify(a.t("ribbon.extractedMsg", { n: tgt.length, path }));
          });
        } },
        { id: "split", labelKey: "cmd.split", icon: "split", needsDoc: true, run: async (a) => {
          const v = await a.ask({ kind: "prompt", title: a.t("ribbon.splitTitle"), message: a.t("ribbon.splitMsg"), value: "1" });
          const every = Number(v);
          if (!v || !Number.isInteger(every) || every < 1) return;
          const dir = await window.papiro.folderDialog();
          if (!dir) return;
          await a.task(a.t("ribbon.splitting"), async () => {
            const parts = await engine.split(every);
            const base = a.doc!.name.replace(/\.pdf$/i, "");
            const suffix = a.t("ribbon.splitSuffix");
            for (let i = 0; i < parts.length; i++) await window.papiro.writeFile(await window.papiro.joinPath(dir, `${base}_${suffix}${i + 1}.pdf`), parts[i]);
            a.notify(a.t("ribbon.splitDone", { n: parts.length, dir }));
          });
        } },
      ] },
    ],
  },
  {
    id: "view", labelKey: "tab.view", groups: [
      { labelKey: "grp.viewLayout", cmds: [
        { id: "vOne", labelKey: "app.onePage", icon: "onePage", needsDoc: true, on: (a) => a.layout === "single",
          run: (a) => a.setLayout("single") },
        { id: "vTwo", labelKey: "cmd.two", icon: "twoPages", needsDoc: true, on: (a) => a.layout === "double",
          run: (a) => a.setLayout("double"), titleKey: "cmd.two.tip" },
        { id: "vFull", labelKey: "cmd.full", icon: "fullscreen", needsDoc: true, run: (a) => a.toggleFullScreen(true), titleKey: "cmd.full.tip" },
      ] },
      { labelKey: "grp.viewZoom", cmds: [
        { id: "vZOut", labelKey: "cmd.zoomOut", icon: "zoomOut", needsDoc: true, run: (a) => a.setZoom((z) => z / 1.2) },
        { id: "vZIn", labelKey: "cmd.zoomIn", icon: "zoomIn", needsDoc: true, run: (a) => a.setZoom((z) => z * 1.2) },
        { id: "vFit", labelKey: "cmd.fit", icon: "fitWidth", needsDoc: true, run: (a) => a.fitWidth() },
      ] },
      { labelKey: "grp.viewRead", cmds: [
        { id: "vRead", labelKey: "cmd.readMode", icon: "readMode", needsDoc: true, on: (a) => a.readMode !== "normal",
          run: feat.cycleReadMode, titleKey: "cmd.readMode.tip" },
        { id: "vTts", labelKey: "cmd.tts", icon: "speak", needsDoc: true, on: () => tts.snapshot().active,
          run: (a) => {
            if (tts.snapshot().active) tts.stop();
            else tts.start(a.page, a.doc!.info.pageCount, a.goTo, a.lang);
          }, titleKey: "cmd.tts.tip" },
      ] },
      { labelKey: "grp.viewCompare", cmds: [
        { id: "vCmp", labelKey: "cmd.compare", icon: "compare", needsDoc: true, run: feat.comparePdf, titleKey: "cmd.compare.tip" },
      ] },
    ],
  },
  {
    id: "fill", labelKey: "tab.fill", groups: [
      { labelKey: "grp.signature", cmds: [
        { id: "sig", labelKey: "cmd.sig", icon: "sign", tool: "signature", needsDoc: true, titleKey: "cmd.sig.tip" },
        { id: "sigNew", labelKey: "cmd.sigNew", icon: "ink", run: async (a) => { const s = await a.ask({ kind: "signature", title: a.t("ribbon.newSigTitle") }); if (s) { a.setSignature(s); a.setTool("signature"); } } },
        { id: "sigClr", labelKey: "cmd.sigClr", icon: "clear", enabled: (a) => !!a.signature, run: (a) => { a.setSignature(null); a.notify(a.t("ribbon.sigRemoved")); } },
      ] },
      { labelKey: "grp.freeText", cmds: [
        { id: "ft2", labelKey: "cmd.ft2", icon: "freetext", tool: "freetext", needsDoc: true, titleKey: "cmd.ft2.tip" },
      ] },
      { labelKey: "grp.createForm", cmds: [
        { id: "addFld", labelKey: "cmd.addFld", icon: "formField", tool: "addfield", needsDoc: true, titleKey: "cmd.addFld.tip" },
        { id: "autoFld", labelKey: "cmd.autoFld", icon: "autoForm", needsDoc: true, run: feat.autoDetectFields, titleKey: "cmd.autoFld.tip" },
      ] },
      { labelKey: "grp.certA1", cmds: [
        { id: "certSign", labelKey: "cmd.certSign", icon: "certSign", needsDoc: true, run: feat.signWithA1, titleKey: "cmd.certSign.tip" },
        { id: "certVerify", labelKey: "cmd.certVerify", icon: "certVerify", needsDoc: true, run: feat.verifySignatures, titleKey: "cmd.certVerify.tip" },
      ] },
    ],
  },
  {
    id: "protect", labelKey: "tab.protect", groups: [
      { labelKey: "grp.password", cmds: [
        { id: "lock", labelKey: "cmd.lock", icon: "lock", needsDoc: true, run: feat.protect, titleKey: "cmd.lock.tip" },
        { id: "unlock", labelKey: "cmd.unlock", icon: "unlock", needsDoc: true, enabled: (a) => !!a.doc?.info.encrypted, run: feat.unprotect, titleKey: "cmd.unlock.tip" },
      ] },
      { labelKey: "grp.integrity", cmds: [
        { id: "flat", labelKey: "cmd.flat", icon: "flatten", needsDoc: true, run: feat.flattenPdf, titleKey: "cmd.flat.tip" },
        { id: "sanit", labelKey: "cmd.sanit", icon: "sanitize", needsDoc: true, run: feat.sanitizeMetadata, titleKey: "cmd.sanit.tip" },
      ] },
      { labelKey: "grp.redaction", cmds: [
        { id: "red", labelKey: "cmd.red", icon: "redact", tool: "redact", needsDoc: true, titleKey: "cmd.red.tip" },
        { id: "sred", labelKey: "cmd.sred", icon: "smartRedact", needsDoc: true, run: feat.smartRedact, titleKey: "cmd.sred.tip" },
        { id: "redApply", labelKey: "cmd.redApply", icon: "apply", needsDoc: true, run: async (a) => {
          const ok = await a.ask({ kind: "confirm", title: a.t("ribbon.applyRedTitle"), message: a.t("ribbon.applyRedMsg") });
          if (ok === null) return;
          const r = await a.task(a.t("common.applying"), () => engine.applyAllRedactions());
          if (r) {
            await a.mutate("…", async () => r.info);
            a.notify(r.pages ? a.t("ribbon.applyRedDone", { n: r.pages }) : a.t("ribbon.applyRedNone"));
          }
        } },
      ] },
    ],
  },
  {
    id: "ocr", labelKey: "tab.ocr", groups: [
      { labelKey: "grp.ocrLangPrec", cmds: ["ocrlang", "ocropts"] },
      { labelKey: "grp.ocrRun", cmds: [
        { id: "ocr1", labelKey: "cmd.ocr1", icon: "ocr", needsDoc: true, run: (a) => a.runOcr([a.page]) },
        { id: "ocrScan", labelKey: "cmd.ocrScan", icon: "ocrAll", needsDoc: true, enabled: (a) => a.scanned.length > 0,
          run: (a) => a.runOcr("scanned"), titleKey: "cmd.ocrScan.tip" },
        { id: "ocrAll", labelKey: "cmd.ocrAll", icon: "ocrAll", needsDoc: true,
          run: (a) => a.runOcr(Array.from({ length: a.doc!.info.pageCount }, (_, i) => i)) },
      ] },
    ],
  },
];

const SWATCHES: RGB[] = [[1, 0.85, 0], [0.4, 0.85, 0.3], [0.3, 0.7, 1], [1, 0.45, 0.6], [0.85, 0, 0], [0, 0.3, 0.8], [0, 0, 0]];
const css = (c: RGB) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;

export function Ribbon() {
  const a = useApp();
  const [tab, setTab] = useState("home");
  const [collapsed, setCollapsed] = useState(false);
  const [, setTtsTick] = useState<TtsState>(() => tts.snapshot());
  useEffect(() => tts.subscribe(setTtsTick), []);
  const active = TABS.find((x) => x.id === tab)!;
  const ocrOpts = ocrLangOptions(a.lang);
  const sysLangLabel = a.systemLang.toUpperCase();
  const nextTheme = () => {
    const order: ("auto" | "light" | "dark")[] = ["auto", "light", "dark"];
    a.setTheme(order[(order.indexOf(a.theme) + 1) % order.length]);
  };
  return (
    <header className={collapsed ? "ribbon collapsed" : "ribbon"}>
      <nav className="ribbon-tabs" role="tablist">
        <div className="ribbon-brand-qat">
          <button type="button" className="brand-btn" title="PapyrusPDF" onClick={() => a.setHomeOpen(true)}>
            <PapyrusLogo size={20} />
            <span className="brand">PapyrusPDF</span>
          </button>
          <div className="qat" aria-label="Acesso rápido">
            <button type="button" title={a.t("cmd.save.tip")} disabled={!a.doc || !!a.busy} onClick={() => a.save()}>
              <Icon name="save" size={14} />
            </button>
            <button type="button" title={a.t("cmd.undo.tip")} disabled={!a.doc?.info.canUndo || !!a.busy} onClick={() => a.undo()}>
              <Icon name="undo" size={14} />
            </button>
            <button type="button" title={a.t("cmd.redo.tip")} disabled={!a.doc?.info.canRedo || !!a.busy} onClick={() => a.redo()}>
              <Icon name="redo" size={14} />
            </button>
            <button type="button" title={a.t("cmd.print.tip")} disabled={!a.doc || !!a.busy} onClick={() => a.printDoc()}>
              <Icon name="print" size={14} />
            </button>
          </div>
        </div>

        <button
          type="button"
          className={a.fileMenuOpen ? "file-tab on" : "file-tab"}
          onClick={() => a.setFileMenuOpen(!a.fileMenuOpen)}
        >
          {a.t("tab.file")}
        </button>

        {TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={x.id === tab && !a.fileMenuOpen}
            className={x.id === tab && !a.fileMenuOpen ? "on" : ""}
            onClick={() => { a.setFileMenuOpen(false); setTab(x.id); if (collapsed) setCollapsed(false); }}
          >
            {a.t(x.labelKey)}
          </button>
        ))}

        <div className="ribbon-right">
          <button
            type="button"
            className="theme-btn"
            title={`${a.t("theme.label")}: ${a.t(a.theme === "dark" ? "theme.dark" : a.theme === "light" ? "theme.light" : "theme.auto")}`}
            onClick={nextTheme}
          >
            <Icon name={a.theme === "dark" ? "moon" : "sun"} size={14} />
          </button>
          <label className="lang-pick" title={a.t("lang.label")}>
            <Icon name="language" size={14} />
            <select aria-label={a.t("lang.label")} value={a.uiLangPref} onChange={(e) => a.setUiLang(e.target.value as LangPref)}>
              <option value="auto">{a.t("lang.auto", { lang: sysLangLabel })}</option>
              <option value="pt">{a.t("lang.pt")}</option>
              <option value="en">{a.t("lang.en")}</option>
              <option value="es">{a.t("lang.es")}</option>
            </select>
          </label>
          <button
            type="button"
            className="collapse-btn"
            title={a.t(collapsed ? "ribbon.expand" : "ribbon.collapse")}
            onClick={() => setCollapsed((v) => !v)}
          >
            <Icon name={collapsed ? "chevDown" : "chevUp"} size={14} />
          </button>
        </div>
      </nav>

      {!collapsed && (
        <div className="ribbon-body" role="toolbar">
          {active.groups.map((g) => (
            <section key={g.labelKey} className="rgroup">
              <div className="rgroup-cmds">
                {g.cmds.map((c) =>
                  c === "ocrlang" ? (
                    <label key="ocrlang" className="ocrlang">
                      <Icon name="language" size={20} />
                      <select aria-label={a.t("ribbon.ocrLangAria")} value={a.ocrLang} disabled={!!a.busy} onChange={(e) => a.setOcrLang(e.target.value)}>
                        {ocrOpts.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                      </select>
                    </label>
                  ) : c === "ocropts" ? (
                    <div key="ocropts" className="ocropts">
                      <select aria-label={a.t("ribbon.ocrQualAria")} value={a.ocrQuality} disabled={!!a.busy} onChange={(e) => a.setOcrQuality(e.target.value as "neural" | "best" | "fast")}>
                        <option value="neural">{a.t("ribbon.ocrNeural")}</option>
                        <option value="best">{a.t("ribbon.ocrBest")}</option>
                        <option value="fast">{a.t("ribbon.ocrFast")}</option>
                      </select>
                      <label title={a.t("ribbon.ocrCleanupTip")}>
                        <input type="checkbox" checked={a.ocrCleanup} disabled={!!a.busy} onChange={(e) => a.setOcrCleanup(e.target.checked)} />
                        {a.t("ribbon.ocrCleanup")}
                      </label>
                    </div>
                  ) : c === "color" ? (
                    <div key="color" className="swatches">
                      {SWATCHES.map((s) => (
                        <button key={s.join()} title={a.t("ribbon.swatchTip")} className={s.join() === a.color.join() ? "sw on" : "sw"}
                          style={{ background: css(s) }} onClick={() => a.setColor(s)} />
                      ))}
                    </div>
                  ) : (
                    <button key={c.id} className={(c.tool && a.tool === c.tool) || c.on?.(a) ? "rbtn on" : "rbtn"}
                      title={c.titleKey ? a.t(c.titleKey) : a.t(c.labelKey)}
                      aria-pressed={c.on ? !!c.on(a) : undefined}
                      disabled={(c.needsDoc && !a.doc) || (c.enabled ? !c.enabled(a) : false) || !!a.busy}
                      onClick={() => { if (c.tool) { a.setHomeOpen(false); a.setTool(c.tool); a.setView("read"); } c.run?.(a); }}>
                      <Icon name={c.icon} size={22} />
                      <span>{a.t(c.labelKey)}</span>
                    </button>
                  ),
                )}
              </div>
              <div className="rgroup-label">{a.t(g.labelKey)}</div>
            </section>
          ))}
        </div>
      )}
    </header>
  );
}
