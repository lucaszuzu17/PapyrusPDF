// Comandos com formulário: proteger, comprimir, cabeçalho/rodapé, numeração,
// marca d'água, carimbos, exportação, lote, LGPD, Bates, PageLabels, A1 e formulários.
import { formatBytes, localeTag, type I18nKey } from "../../shared/i18n.ts";
import {
  engine, type BatchAction, type MarginPos, type OptimizeOptions, type PageLabelRule,
  type PageLabelStyle, type RedactPatternId, type RGB,
} from "./api.ts";
import { makeStamp, prepareImages, stampPresets } from "./images.ts";
import { generatePassword, passwordStrength } from "./password.ts";
import { ocrLangOptions, type ReadMode, type useApp } from "./state.tsx";

type App = ReturnType<typeof useApp>;

const base = (a: App) => a.doc!.name.replace(/\.pdf$/i, "");
const fileName = (path: string) => path.split(/[\\/]/).pop()!;
const size = (n: number, a: App) => formatBytes(n, a.lang);
const samePath = (a: string | null, b: string) => !!a && a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
const allPages = (a: App) => Array.from({ length: a.doc!.info.pageCount }, (_, i) => i);

// ---------- proteger ----------

export async function protect(a: App): Promise<void> {
  const { t, lang } = a;
  const v = await a.askForm({
    title: t("feat.protectTitle"), okLabel: t("feat.protectOk"),
    message: t("feat.protectMsg"),
    fields: [
      { id: "pw", label: t("feat.protectPw"), type: "password", value: "", span: 3,
        action: {
          label: t("feat.protectGenBtn"), reveal: true,
          run: (cur) => {
            const g = generatePassword();
            navigator.clipboard.writeText(g).catch(() => {});
            return { ...cur, pw: g, pw2: g, gen: g };
          },
        },
        note: (cur) => {
          const pw = String(cur.pw);
          if (!pw) return null;
          const st = passwordStrength(pw, lang);
          return { text: `${st.label}. ${st.hint}`, level: st.score };
        } },
      { id: "pw2", label: t("feat.protectPw2"), type: "password", value: "", span: 3,
        note: (cur) => (cur.gen && cur.gen === cur.pw && cur.pw === cur.pw2
          ? { text: t("feat.protectGenNote") } : null) },
      { id: "print", label: t("feat.protectAllowPrint"), type: "checkbox", value: true, span: 3 },
      { id: "copy", label: t("feat.protectAllowCopy"), type: "checkbox", value: true, span: 3 },
      { id: "edit", label: t("feat.protectAllowEdit"), type: "checkbox", value: true, span: 3 },
      { id: "annotate", label: t("feat.protectAllowAnnot"), type: "checkbox", value: true, span: 3 },
      { id: "recipient", label: t("feat.protectRecipient"), type: "text", value: "",
        placeholder: t("feat.protectRecipientPh"),
        note: (cur) => (String(cur.recipient).trim() ? { text: t("feat.protectRecipientNote") } : null) },
      { id: "img", label: t("feat.protectImg"), type: "select", value: "0", options: [
        { value: "0", label: t("feat.protectImg0") },
        { value: "150", label: t("feat.protectImg150") },
        { value: "200", label: t("feat.protectImg200") },
      ], note: (cur) => (cur.img !== "0" ? { text: t("feat.protectImgNote") } : null) },
    ],
    validate: (f) => {
      const pw = String(f.pw);
      if (pw !== String(f.pw2)) return t("feat.protectErrMismatch");
      if (/[,=]/.test(pw)) return t("feat.protectErrChars");
      if (pw.length > 100) return t("feat.protectErrLen");
      const copy = String(f.recipient).trim() || f.img !== "0";
      if (!pw && !copy && f.print && f.copy && f.edit && f.annotate) return t("feat.protectErrEmpty");
      if (String(f.recipient).length > 60) return t("feat.protectErrRecipLen");
      return null;
    },
  });
  if (!v) return;
  const pw = String(v.pw);
  const recipient = String(v.recipient).trim();
  const imageOnly = Number(v.img) || 0;
  const copyOnly = !!recipient || imageOnly > 0;
  const slug = recipient.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  const suggested = copyOnly ? `${base(a)}_${slug || t("feat.protectImgSuffix")}.pdf` : a.doc!.path ?? `${base(a)}_${t("feat.protectSuffix")}.pdf`;
  const path = await window.papiro.saveDialog(suggested);
  if (!path) return;
  if (copyOnly && samePath(a.doc!.path, path)) { a.notify(t("feat.protectSamePath")); return; }
  await a.task(copyOnly ? t("feat.protectBusyCopy") : t("feat.protectBusy"), async () => {
    const bytes = await engine.exportProtected({
      userPassword: pw || undefined,
      permissions: { print: !!v.print, copy: !!v.copy, edit: !!v.edit, annotate: !!v.annotate },
      recipient: recipient || undefined,
      imageOnly,
    });
    try { await window.papiro.writeFile(path, bytes); } finally { await a.refresh(); }
    if (copyOnly) {
      const what = recipient ? t("feat.protectCopyRecip", { recipient }) : t("feat.protectCopyImg");
      a.notify(t("feat.protectCopyDone", { what, path, pw: pw ? t("feat.protectWithPw") : "" }));
      return;
    }
    await a.adoptFile(path, bytes, pw);
    a.notify(pw ? t("feat.protectDonePw", { path }) : t("feat.protectDonePerm", { path }));
  });
}

export async function unprotect(a: App): Promise<void> {
  const { t } = a;
  const ok = await a.ask({
    kind: "confirm", title: t("feat.unprotectTitle"), okLabel: t("feat.unprotectOk"),
    message: t("feat.unprotectMsg"),
  });
  if (ok === null) return;
  const path = await window.papiro.saveDialog(a.doc!.path ?? `${base(a)}_${t("feat.unprotectSuffix")}.pdf`);
  if (!path) return;
  await a.task(t("feat.unprotectBusy"), async () => {
    const bytes = await engine.exportUnprotected();
    try { await window.papiro.writeFile(path, bytes); } finally { await a.refresh(); }
    await a.adoptFile(path, bytes);
    a.notify(t("feat.unprotectDone", { path }));
  });
}

// ---------- otimizar / comprimir + auditoria de espaço ----------

export async function compress(a: App): Promise<void> {
  const { t } = a;
  const audit = await a.task(t("feat.auditBusy"), () => engine.auditSpace());
  const pctOf = (v: number) => (audit && audit.totalBytes > 0 ? Math.round((v / audit.totalBytes) * 100) : 0);
  const auditText = audit
    ? t("feat.auditSummary", {
      total: size(audit.totalBytes, a),
      img: size(audit.images, a), imgPct: pctOf(audit.images), imgCount: audit.imageCount,
      font: size(audit.fonts, a), fontPct: pctOf(audit.fonts), fontCount: audit.fontCount,
      streams: size(audit.streams, a), streamsPct: pctOf(audit.streams),
      attach: audit.attachments ? t("feat.auditAttach", { size: size(audit.attachments, a), count: audit.attachmentCount }) : "",
      meta: audit.metadata ? t("feat.auditMeta", { size: size(audit.metadata, a) }) : "",
    })
    : t("feat.compressFallbackMsg");

  const v = await a.askForm({
    title: t("feat.compressTitle"), okLabel: t("feat.compressOk"),
    message: auditText,
    fields: [
      { id: "level", label: t("feat.compressLevel"), type: "select", value: "media", options: [
        { value: "nenhuma", label: t("feat.compressNone") },
        { value: "leve", label: t("feat.compressLight") },
        { value: "media", label: t("feat.compressMed") },
        { value: "forte", label: t("feat.compressStrong") },
      ] },
      { id: "subsetFonts", label: t("feat.compressSubset"), type: "checkbox", value: true, span: 3 },
      { id: "deduplicate", label: t("feat.compressDedup"), type: "checkbox", value: true, span: 3 },
      { id: "stripThumbnails", label: t("feat.compressThumbs"), type: "checkbox", value: true, span: 3 },
      { id: "stripMetadata", label: t("feat.compressMeta"), type: "checkbox", value: false, span: 3 },
      { id: "stripAttachments", label: t("feat.compressAttach"), type: "checkbox", value: false, span: 3 },
      { id: "stripJavaScript", label: t("feat.compressJs"), type: "checkbox", value: false, span: 3 },
    ],
  });
  if (!v) return;
  const opts: OptimizeOptions = {
    level: v.level as OptimizeOptions["level"],
    subsetFonts: !!v.subsetFonts,
    deduplicate: !!v.deduplicate,
    stripThumbnails: !!v.stripThumbnails,
    stripMetadata: !!v.stripMetadata,
    stripAttachments: !!v.stripAttachments,
    stripJavaScript: !!v.stripJavaScript,
  };
  const r = await a.task(t("feat.compressBusy"), () => engine.exportOptimized(opts));
  if (!r) return;
  const structural = !!(opts.stripMetadata || opts.stripAttachments || opts.stripJavaScript);
  if (!structural && r.after >= r.before) { a.notify(t("feat.compressAlready", { size: size(r.before, a) })); return; }
  const pct = Math.round((1 - r.after / r.before) * 100);
  const path = await window.papiro.saveDialog(`${base(a)}_${t("feat.compressSuffix")}.pdf`);
  if (!path) return;
  await a.task(t("common.saving"), async () => {
    await window.papiro.writeFile(path, r.bytes);
    if (samePath(a.doc!.path, path)) await a.adoptFile(path, r.bytes);
    const delta = pct >= 0 ? `−${pct}%` : `+${Math.abs(pct)}%`;
    a.notify(t("feat.compressDone", { before: size(r.before, a), after: size(r.after, a), delta, path }));
  });
}

// ---------- cabeçalho, rodapé e numeração ----------

const SIZES = ["8", "9", "10", "11", "12", "14"].map((s) => ({ value: s, label: `${s} pt` }));

export async function headerFooter(a: App): Promise<void> {
  const { t } = a;
  const cell = (id: MarginPos, label: string) => ({ id, label, type: "text" as const, value: "", span: 2 as const });
  const v = await a.askForm({
    title: t("feat.hfTitle"), okLabel: t("feat.hfOk"), message: t("feat.hfTokens"),
    fields: [
      cell("tl", t("feat.hfTl")), cell("tc", t("feat.hfTc")), cell("tr", t("feat.hfTr")),
      cell("bl", t("feat.hfBl")), cell("bc", t("feat.hfBc")), cell("br", t("feat.hfBr")),
      { id: "size", label: t("feat.fontSize"), type: "select", value: "10", options: SIZES, span: 3 },
      { id: "skip", label: t("feat.hfSkipCover"), type: "checkbox", value: false, span: 3 },
    ],
    validate: (f) => ((["tl", "tc", "tr", "bl", "bc", "br"] as const).some((k) => String(f[k]).trim()) ? null : t("feat.hfNeedOne")),
  });
  if (!v) return;
  const items = (["tl", "tc", "tr", "bl", "bc", "br"] as MarginPos[]).map((pos) => ({ pos, text: String(v[pos]) })).filter((it) => it.text.trim());
  const skip = !!v.skip && a.doc!.info.pageCount > 1;
  await a.mutate(t("common.applying"), () => engine.addHeaderFooter({
    items, size: Number(v.size), pages: skip ? allPages(a).slice(1) : undefined, startAt: skip ? 2 : 1,
  }));
}

export async function numberPages(a: App): Promise<void> {
  const { t } = a;
  const v = await a.askForm({
    title: t("feat.numTitle"), okLabel: t("feat.numOk"),
    fields: [
      { id: "pos", label: t("feat.pos"), type: "select", value: "bc", span: 3, options: [
        { value: "bc", label: t("feat.posBc") }, { value: "br", label: t("feat.posBr") }, { value: "bl", label: t("feat.posBl") },
        { value: "tc", label: t("feat.posTc") }, { value: "tr", label: t("feat.posTr") }, { value: "tl", label: t("feat.posTl") },
      ] },
      { id: "fmt", label: t("feat.format"), type: "select", value: "{p}", span: 3, options: [
        { value: "{p}", label: "1" }, { value: t("feat.numFmtPage"), label: t("feat.numFmtPageLbl") },
        { value: "{p} / {n}", label: "1 / 10" }, { value: t("feat.numFmtOf"), label: t("feat.numFmtOfLbl") },
      ] },
      { id: "start", label: t("feat.startNum"), type: "number", value: "1", span: 2 },
      { id: "size", label: t("feat.fontSize"), type: "select", value: "10", options: SIZES, span: 2 },
      { id: "skip", label: t("feat.skipCover"), type: "checkbox", value: false, span: 2 },
    ],
    validate: (f) => (/^\d{1,6}$/.test(String(f.start).trim()) ? null : t("feat.startNumErr")),
  });
  if (!v) return;
  const skip = !!v.skip && a.doc!.info.pageCount > 1;
  const start = Number(String(v.start).trim());
  await a.mutate(t("feat.numbering"), () => engine.addHeaderFooter({
    items: [{ pos: v.pos as MarginPos, text: String(v.fmt) }], size: Number(v.size),
    pages: skip ? allPages(a).slice(1) : undefined, startAt: skip ? start + 1 : start,
  }));
}

// ---------- marca d'água ----------

const WM_COLORS: Record<string, RGB> = { cinza: [0.55, 0.55, 0.55], vermelho: [0.85, 0.1, 0.1], azul: [0.1, 0.3, 0.8] };

export async function watermark(a: App): Promise<void> {
  const { t } = a;
  const v = await a.askForm({
    title: t("feat.wmTitle"), okLabel: t("feat.wmOk"),
    fields: [
      { id: "text", label: t("feat.wmText"), type: "text", value: t("feat.wmDefault") },
      { id: "angle", label: t("feat.wmDir"), type: "select", value: "45", span: 3, options: [{ value: "45", label: t("feat.wmDiag") }, { value: "0", label: t("feat.wmHoriz") }] },
      { id: "opacity", label: t("feat.wmOpacity"), type: "select", value: "0.18", span: 3, options: [
        { value: "0.1", label: t("feat.wmOp01") }, { value: "0.18", label: t("feat.wmOp018") }, { value: "0.3", label: t("feat.wmOp03") }, { value: "0.5", label: t("feat.wmOp05") },
      ] },
      { id: "color", label: t("feat.color"), type: "select", value: "cinza", span: 3, options: [
        { value: "cinza", label: t("feat.colorGray") }, { value: "vermelho", label: t("feat.colorRed") }, { value: "azul", label: t("feat.colorBlue") },
      ] },
      { id: "layer", label: t("feat.wmLayer"), type: "select", value: "over", span: 3, options: [
        { value: "over", label: t("feat.wmOver") }, { value: "behind", label: t("feat.wmBehind") },
      ] },
    ],
    validate: (f) => (String(f.text).trim() ? null : t("feat.wmTextErr")),
  });
  if (!v) return;
  await a.mutate(t("feat.wmBusy"), () => engine.addWatermark({
    text: String(v.text).trim(), angle: Number(v.angle), opacity: Number(v.opacity),
    color: WM_COLORS[String(v.color)] ?? WM_COLORS.cinza, behind: v.layer === "behind",
  }));
}

// ---------- carimbos ----------

const STAMP_NAME = "papiro.stampName";

export async function chooseStamp(a: App): Promise<void> {
  const { t, lang } = a;
  const presets = stampPresets(lang);
  let name = "";
  try { name = localStorage.getItem(STAMP_NAME) ?? ""; } catch { /* sem armazenamento */ }
  const v = await a.askForm({
    title: t("feat.stampTitle"), okLabel: t("feat.stampOk"),
    message: t("feat.stampMsg"),
    fields: [
      { id: "preset", label: t("feat.stampModel"), type: "select", value: "aprovado", span: 3,
        options: [...presets.map((p) => ({ value: p.id, label: p.text })), { value: "custom", label: t("feat.otherText") }] },
      { id: "custom", label: t("feat.stampCustom"), type: "text", value: "", span: 3, showIf: (f) => f.preset === "custom" },
      { id: "date", label: t("feat.stampDate"), type: "checkbox", value: true, span: 3 },
      { id: "name", label: t("feat.stampName"), type: "text", value: name, span: 3, placeholder: t("feat.stampNamePh") },
    ],
    validate: (f) => (f.preset === "custom" && !String(f.custom).trim() ? t("feat.stampErr") : null),
  });
  if (!v) return;
  const preset = presets.find((p) => p.id === v.preset);
  const tag = localeTag(lang);
  const text = (preset?.text ?? String(v.custom).trim()).toLocaleUpperCase(tag).slice(0, 40);
  const who = String(v.name).trim();
  try { localStorage.setItem(STAMP_NAME, who); } catch { /* sem armazenamento */ }
  const sub = [v.date ? new Date().toLocaleDateString(tag) : "", who].filter(Boolean).join(" · ");
  a.setStamp(makeStamp(text, preset?.color ?? "#1f5fbf", sub));
  a.setView("read");
  a.setTool("stamp");
}

// ---------- exportar páginas como imagem ----------

export async function exportImages(a: App): Promise<void> {
  const { t } = a;
  const n = a.doc!.info.pageCount;
  const sel = a.view === "organize" && a.selectedPages.length ? [...a.selectedPages].sort((x, y) => x - y) : null;
  const v = await a.askForm({
    title: t("feat.expImgTitle"), okLabel: t("feat.expImgOk"),
    fields: [
      { id: "which", label: t("feat.whichPages"), type: "select", value: sel ? "sel" : "cur", options: [
        { value: "cur", label: t("feat.curPage", { n: a.page + 1 }) },
        ...(sel ? [{ value: "sel", label: t("feat.selPages", { n: sel.length }) }] : []),
        ...(n > 1 ? [{ value: "all", label: t("feat.allPagesFiles", { n }) }] : []),
      ] },
      { id: "fmt", label: t("feat.format"), type: "select", value: "png", span: 3, options: [
        { value: "png", label: t("feat.fmtPng") }, { value: "jpg", label: t("feat.fmtJpg") },
      ] },
      { id: "dpi", label: t("feat.dpi"), type: "select", value: "150", span: 3, options: [
        { value: "96", label: t("feat.dpi96") }, { value: "150", label: t("feat.dpi150") }, { value: "300", label: t("feat.dpi300") },
      ] },
    ],
  });
  if (!v) return;
  const fmt = v.fmt as "png" | "jpg", dpi = Number(v.dpi);
  const pages = v.which === "all" ? allPages(a) : v.which === "sel" && sel ? sel : [a.page];
  if (pages.length === 1) {
    const path = await window.papiro.saveDialog(`${base(a)}_p${pages[0] + 1}.${fmt}`, fmt);
    if (!path) return;
    await a.task(t("feat.exporting"), async () => {
      await window.papiro.writeFile(path, await engine.pageImage(pages[0], dpi, fmt));
      a.notify(t("feat.expImgOneDone", { n: pages[0] + 1, path }));
    });
    return;
  }
  const dir = await window.papiro.folderDialog();
  if (!dir) return;
  await a.task(t("feat.expImgManyBusy"), async () => {
    const out = await engine.exportImages(dir, base(a), pages, dpi, fmt);
    a.notify(t("feat.expImgManyDone", { n: out.length, dir, first: fileName(out[0]) }));
  });
}

// ---------- converter ----------

export async function toWord(a: App): Promise<void> {
  const { t } = a;
  if (a.scanned.length === a.doc!.info.pageCount) {
    const ok = await a.ask({
      kind: "confirm", title: t("feat.toWordTitle"), okLabel: t("feat.toWordOk"),
      message: t("feat.toWordScanMsg"),
    });
    if (ok === null) return;
  }
  const path = await window.papiro.saveDialog(`${base(a)}.docx`, "docx");
  if (!path) return;
  await a.task(t("feat.toWordBusy"), async () => {
    const bytes = await engine.saveDocx(path);
    a.notify(t("feat.toWordDone", { path, size: size(bytes, a) }));
  });
}

export async function toText(a: App): Promise<void> {
  const { t } = a;
  const path = await window.papiro.saveDialog(`${base(a)}.txt`, "txt");
  if (!path) return;
  await a.task(t("feat.toTextBusy"), async () => {
    const chars = await engine.saveText(path);
    a.notify(chars > 2 ? t("feat.toTextDone", { path }) : t("feat.toTextEmpty", { path }));
  });
}

// ---------- remover marca d'água ----------

export async function removeWatermarks(a: App): Promise<void> {
  const { t } = a;
  const r = await a.task(t("feat.remWmBusy"), () => engine.removeWatermarks());
  if (!r) return;
  if (!r.removed) { a.notify(t("feat.remWmNone")); return; }
  await a.mutate("…", async () => r.info);
  a.notify(t("feat.remWmDone", { n: r.pages }));
}

// ---------- planilha CSV ----------

export async function toCsv(a: App): Promise<void> {
  const { t } = a;
  const path = await window.papiro.saveDialog(`${base(a)}.csv`, "csv");
  if (!path) return;
  await a.task(t("feat.toCsvBusy"), async () => {
    const chars = await engine.saveCsv(path);
    a.notify(chars > 2 ? t("feat.toCsvDone", { path }) : t("feat.toCsvEmpty", { path }));
  });
}

// ---------- imagem sobre a página ----------

export async function chooseOverlayImage(a: App): Promise<void> {
  const { t } = a;
  const [f] = await window.papiro.openDialog({ title: t("feat.overlayTitle"), images: true });
  if (!f) return;
  await a.task(t("feat.overlayBusy"), async () => {
    const [bytes] = await prepareImages([f], a.lang);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const img = new Image();
    img.src = url;
    try { await img.decode(); } finally { URL.revokeObjectURL(url); }
    a.setOverlayImg({ bytes, width: img.naturalWidth || 200, height: img.naturalHeight || 200, name: f.name });
    a.setView("read");
    a.setTool("overlayimg");
    a.notify(t("feat.overlayReady", { name: f.name }));
  });
}

// ---------- recortar e padronizar páginas ----------

const MM_TO_PT = 72 / 25.4;

export async function cropPages(a: App): Promise<void> {
  const { t } = a;
  const sel = a.view === "organize" && a.selectedPages.length ? [...a.selectedPages].sort((x, y) => x - y) : null;
  const n = a.doc!.info.pageCount;
  const v = await a.askForm({
    title: t("feat.cropTitle"), okLabel: t("feat.cropOk"),
    message: t("feat.cropMsg"),
    fields: [
      { id: "which", label: t("feat.applyTo"), type: "select", value: sel ? "sel" : "cur", options: [
        { value: "cur", label: t("feat.curPage", { n: a.page + 1 }) },
        ...(sel ? [{ value: "sel", label: t("feat.selPages", { n: sel.length }) }] : []),
        ...(n > 1 ? [{ value: "all", label: t("feat.allPagesSimple", { n }) }] : []),
      ] },
      { id: "top", label: t("feat.cropTop"), type: "number", value: "10", span: 3 },
      { id: "bottom", label: t("feat.cropBottom"), type: "number", value: "10", span: 3 },
      { id: "left", label: t("feat.cropLeft"), type: "number", value: "10", span: 3 },
      { id: "right", label: t("feat.cropRight"), type: "number", value: "10", span: 3 },
    ],
    validate: (f) => {
      const vals = ["top", "bottom", "left", "right"].map((k) => Number(String(f[k]).replace(",", ".")));
      if (vals.some((x) => Number.isNaN(x) || x < 0 || x > 200)) return t("feat.cropErrRange");
      if (vals.every((x) => x === 0)) return t("feat.cropErrZero");
      return null;
    },
  });
  if (!v) return;
  const pages = v.which === "all" ? allPages(a) : v.which === "sel" && sel ? sel : [a.page];
  const mm = (k: string) => Number(String(v[k]).replace(",", ".")) * MM_TO_PT;
  const ok = await a.mutate(t("feat.cropBusy"), () => engine.cropPages(pages, {
    top: mm("top"), right: mm("right"), bottom: mm("bottom"), left: mm("left"),
  }));
  if (ok) a.notify(t("feat.cropDone", { n: pages.length }));
}

export async function normalizeSizes(a: App): Promise<void> {
  const { t } = a;
  const sel = a.view === "organize" && a.selectedPages.length ? [...a.selectedPages].sort((x, y) => x - y) : null;
  const n = a.doc!.info.pageCount;
  const v = await a.askForm({
    title: t("feat.normTitle"), okLabel: t("feat.normOk"),
    message: t("feat.normMsg"),
    fields: [
      { id: "target", label: t("feat.normTarget"), type: "select", value: "A4", span: 3, options: [
        { value: "A4", label: t("feat.sizeA4") },
        { value: "Carta", label: t("feat.sizeLetter") },
      ] },
      { id: "which", label: t("feat.applyTo"), type: "select", value: "all", span: 3, options: [
        { value: "all", label: t("feat.allPagesSimple", { n }) },
        ...(sel ? [{ value: "sel", label: t("feat.selShort", { n: sel.length }) }] : []),
        { value: "cur", label: t("feat.onlyPage", { n: a.page + 1 }) },
      ] },
    ],
  });
  if (!v) return;
  const pages = v.which === "cur" ? [a.page] : v.which === "sel" && sel ? sel : allPages(a);
  const target = v.target as "A4" | "Carta";
  const ok = await a.mutate(t("feat.normBusy"), () => engine.normalizePageSizes(pages, target));
  if (ok) a.notify(t("feat.normDone", { n: pages.length, target: target === "A4" ? "A4" : t("state.imgOptLetter") }));
}

// ---------- achatar e limpar metadados ----------

export async function flattenPdf(a: App): Promise<void> {
  const { t } = a;
  const ok = await a.ask({
    kind: "confirm", title: t("feat.flatTitle"), okLabel: t("feat.flatOk"),
    message: t("feat.flatMsg"),
  });
  if (ok === null) return;
  const r = await a.task(t("feat.flatBusy"), () => engine.flatten());
  if (!r) return;
  if (!r.count) { a.notify(t("feat.flatNone")); return; }
  await a.mutate("…", async () => r.info);
  a.notify(t("feat.flatDone", { n: r.count }));
}

export async function sanitizeMetadata(a: App): Promise<void> {
  const { t } = a;
  const ok = await a.ask({
    kind: "confirm", title: t("feat.sanitTitle"), okLabel: t("feat.sanitOk"),
    message: t("feat.sanitMsg"),
  });
  if (ok === null) return;
  const r = await a.task(t("feat.sanitBusy"), () => engine.sanitizeMetadata());
  if (!r) return;
  await a.mutate("…", async () => r.info);
  a.notify(r.removed ? t("feat.sanitDone", { n: r.removed }) : t("feat.sanitNone"));
}

// ---------- comparar dois PDFs ----------

export async function comparePdf(a: App): Promise<void> {
  const { t } = a;
  const [f] = await window.papiro.openDialog({ title: t("feat.compareOpen") });
  if (!f) return;
  const report = await a.task(t("feat.compareBusy", { name: f.name }), () => engine.comparePdf(f.bytes, f.name));
  if (report) a.setCompareReport(report);
}

// ---------- ações em lote (pipeline multi-etapas / Assistente de Ações) ----------

export async function batchProcess(a: App): Promise<void> {
  const { t } = a;
  const files = await window.papiro.openDialog({ title: t("feat.batchOpen"), multi: true });
  if (!files.length) return;
  const paths = files.map((f) => f.path).filter((p): p is string => !!p);
  if (!paths.length) { a.notify(t("feat.batchNeedDisk")); return; }
  const v = await a.askForm({
    title: t("feat.batchTitle", { n: paths.length }),
    okLabel: t("feat.batchOk"),
    message: t("feat.batchMsg"),
    fields: [
      { id: "preset", label: t("feat.batchPreset"), type: "select", value: "custom", options: [
        { value: "custom", label: t("feat.batchPresetCustom") },
        { value: "send", label: t("feat.batchPresetSend") },
        { value: "protocol", label: t("feat.batchPresetProtocol") },
        { value: "lgpd", label: t("feat.batchPresetLgpd") },
      ] },
      { id: "doOcr", label: t("feat.batchStep1"), type: "checkbox", value: false, span: 3, showIf: (f) => f.preset === "custom" },
      { id: "doNorm", label: t("feat.batchStep2"), type: "checkbox", value: false, span: 3, showIf: (f) => f.preset === "custom" },
      { id: "doLgpd", label: t("feat.batchStep3"), type: "checkbox", value: false, span: 3, showIf: (f) => f.preset === "custom" },
      { id: "doSanitize", label: t("feat.batchStep4"), type: "checkbox", value: false, span: 3, showIf: (f) => f.preset === "custom" },
      { id: "doFlatten", label: t("feat.batchStep5"), type: "checkbox", value: false, span: 3, showIf: (f) => f.preset === "custom" },
      { id: "doWm", label: t("feat.batchStep6"), type: "checkbox", value: false, span: 3, showIf: (f) => f.preset === "custom" },
      { id: "doNum", label: t("feat.batchStep7"), type: "checkbox", value: false, span: 3, showIf: (f) => f.preset === "custom" },
      { id: "doBates", label: t("feat.batchStep8"), type: "checkbox", value: false, span: 3, showIf: (f) => f.preset === "custom" },
      { id: "doCompress", label: t("feat.batchStep9"), type: "checkbox", value: true, span: 6, showIf: (f) => f.preset === "custom" },
      { id: "langs", label: t("feat.batchOcrLang"), type: "select", value: a.ocrLang, span: 3,
        showIf: (f) => f.preset === "protocol" || (f.preset === "custom" && !!f.doOcr), options: ocrLangOptions(a.lang) },
      { id: "batesPrefix", label: t("feat.batchBatesPrefix"), type: "text", value: "PROC-", span: 3,
        showIf: (f) => f.preset === "protocol" || (f.preset === "custom" && !!f.doBates) },
      { id: "batesStart", label: t("feat.batchBatesStart"), type: "number", value: "1", span: 3,
        showIf: (f) => f.preset === "protocol" || (f.preset === "custom" && !!f.doBates) },
      { id: "wmText", label: t("feat.batchWmText"), type: "text", value: t("feat.wmDefault"), span: 3,
        showIf: (f) => f.preset === "custom" && !!f.doWm },
      { id: "numFmt", label: t("feat.batchNumFmt"), type: "select", value: t("feat.numFmtOf"), span: 3,
        showIf: (f) => f.preset === "custom" && !!f.doNum, options: [
          { value: "{p}", label: "1" }, { value: t("feat.numFmtPage"), label: t("feat.numFmtPageLbl") }, { value: t("feat.numFmtOf"), label: t("feat.numFmtOfLbl") },
        ] },
      { id: "level", label: t("feat.batchLevel"), type: "select", value: "media", span: 3,
        showIf: (f) => f.preset !== "custom" || !!f.doCompress, options: [
          { value: "leve", label: t("feat.lvlLight") }, { value: "media", label: t("feat.lvlMed") }, { value: "forte", label: t("feat.lvlStrong") },
        ] },
    ],
    validate: (f) => {
      if (f.preset === "custom") {
        const any = !!(f.doOcr || f.doNorm || f.doLgpd || f.doSanitize || f.doFlatten || f.doWm || f.doNum || f.doBates || f.doCompress);
        if (!any) return t("feat.batchErrNoStep");
        if (f.doWm && !String(f.wmText).trim()) return t("feat.wmTextErr");
      }
      if ((f.preset === "protocol" || (f.preset === "custom" && f.doBates)) && !/^\d{1,9}$/.test(String(f.batesStart).trim())) {
        return t("feat.batchErrBates");
      }
      return null;
    },
  });
  if (!v) return;
  const outDir = await window.papiro.folderDialog();
  if (!outDir) return;

  const actions: BatchAction[] = [];
  const lvl = v.level as "leve" | "media" | "forte";
  if (v.preset === "send") {
    actions.push({ kind: "sanitize" }, { kind: "flatten" }, { kind: "compress", level: lvl });
  } else if (v.preset === "protocol") {
    actions.push(
      { kind: "ocr", langs: String(v.langs) },
      { kind: "normalize", target: "A4" },
      { kind: "bates", prefix: String(v.batesPrefix), startNumber: Number(String(v.batesStart).trim()), digits: 6, pos: "br", continuous: true },
      { kind: "compress", level: lvl },
    );
  } else if (v.preset === "lgpd") {
    actions.push(
      { kind: "redactPatterns", patterns: ["cpf", "cnpj", "email"], overlayText: "LGPD" },
      { kind: "sanitize" },
      { kind: "compress", level: lvl },
    );
  } else {
    if (v.doOcr) actions.push({ kind: "ocr", langs: String(v.langs) });
    if (v.doNorm) actions.push({ kind: "normalize", target: "A4" });
    if (v.doLgpd) actions.push({ kind: "redactPatterns", patterns: ["cpf", "cnpj", "email"], overlayText: "LGPD" });
    if (v.doSanitize) actions.push({ kind: "sanitize" });
    if (v.doFlatten) actions.push({ kind: "flatten" });
    if (v.doWm) actions.push({ kind: "watermark", text: String(v.wmText).trim() });
    if (v.doNum) actions.push({ kind: "number", fmt: String(v.numFmt), pos: "bc" });
    if (v.doBates) actions.push({ kind: "bates", prefix: String(v.batesPrefix), startNumber: Number(String(v.batesStart).trim()), digits: 6, pos: "br", continuous: true });
    if (v.doCompress) actions.push({ kind: "compress", level: lvl });
  }

  const r = await a.task(t("feat.batchBusy", { steps: actions.length, files: paths.length }), () => engine.batchProcess(paths, outDir, actions));
  if (!r) return;
  const bates = r.batesEnd !== undefined ? t("feat.batchBatesNote", { end: r.batesEnd }) : "";
  const err = r.failed.length ? t("feat.batchErrNote", { n: r.failed.length, file: r.failed[0].file, err: r.failed[0].error }) : "";
  a.notify(t("feat.batchDone", { ok: r.processed, total: paths.length, dir: outDir, bates, err }));
}

// ---------- redação inteligente (LGPD e padrões) ----------

export async function smartRedact(a: App): Promise<void> {
  const { t } = a;
  const v = await a.askForm({
    title: t("feat.sredTitle"), okLabel: t("feat.sredOk"),
    message: t("feat.sredMsg"),
    fields: [
      { id: "cpf", label: "CPF", type: "checkbox", value: true, span: 2 },
      { id: "cnpj", label: "CNPJ", type: "checkbox", value: true, span: 2 },
      { id: "email", label: t("feat.sredEmail"), type: "checkbox", value: true, span: 2 },
      { id: "phone", label: t("feat.sredPhone"), type: "checkbox", value: false, span: 2 },
      { id: "cep", label: "CEP", type: "checkbox", value: false, span: 2 },
      { id: "rg", label: "RG", type: "checkbox", value: false, span: 2 },
      { id: "card", label: t("feat.sredCard"), type: "checkbox", value: false, span: 3 },
      { id: "applyNow", label: t("feat.sredApplyNow"), type: "checkbox", value: false, span: 3 },
      { id: "custom", label: t("feat.sredCustom"), type: "text", value: "", span: 3, placeholder: t("feat.sredCustomPh") },
      { id: "isRegex", label: t("feat.sredRegex"), type: "checkbox", value: false, span: 3 },
      { id: "overlayPreset", label: t("feat.sredOverlay"), type: "select", value: "LGPD", span: 3, options: [
        { value: "", label: t("feat.sredOverlayNone") },
        { value: "LGPD", label: "LGPD" },
        { value: "{tipo}", label: t("feat.sredOverlayType") },
        { value: t("feat.wmDefault"), label: t("feat.wmDefault") },
        { value: "custom", label: t("feat.otherText") },
      ] },
      { id: "overlayCustom", label: t("feat.sredOverlayCustom"), type: "text", value: "", span: 3,
        showIf: (f) => f.overlayPreset === "custom", placeholder: t("feat.sredOverlayCustomPh") },
    ],
    validate: (f) => {
      const anyPat = !!(f.cpf || f.cnpj || f.email || f.phone || f.cep || f.rg || f.card);
      if (!anyPat && !String(f.custom).trim()) return t("feat.sredErrEmpty");
      return null;
    },
  });
  if (!v) return;
  const patterns = (["cpf", "cnpj", "email", "phone", "cep", "rg", "card"] as RedactPatternId[]).filter((k) => !!v[k]);
  const overlayText = v.overlayPreset === "custom" ? String(v.overlayCustom).trim() : String(v.overlayPreset);
  const res = await a.task(t("feat.sredBusy"), () => engine.redactByPatterns({
    patterns,
    customQuery: String(v.custom).trim() || undefined,
    isRegex: !!v.isRegex,
    overlayText: overlayText || undefined,
  }));
  if (!res) return;
  if (!res.marked) { a.notify(t("feat.sredNone")); return; }
  await a.mutate("…", async () => res.info);
  const summary = Object.entries(res.byLabel).map(([k, n]) => `${k}: ${n}`).join(" · ");
  if (v.applyNow) {
    const applied = await a.task(t("feat.sredApplying"), () => engine.applyAllRedactions());
    if (applied) {
      await a.mutate("…", async () => applied.info);
      a.notify(t("feat.sredApplied", { marked: res.marked, pages: applied.pages, summary }));
    }
    return;
  }
  a.setView("read");
  a.setTool("redact");
  a.notify(t("feat.sredMarked", { marked: res.marked, pages: res.pages, summary }));
}

// ---------- numeração Bates ----------

export async function batesNumbering(a: App): Promise<void> {
  const { t } = a;
  const v = await a.askForm({
    title: t("feat.batesTitle"), okLabel: t("feat.batesOk"),
    message: t("feat.batesMsg"),
    fields: [
      { id: "prefix", label: t("feat.batesPrefix"), type: "text", value: "PROC-", span: 2, placeholder: t("feat.batesPrefixPh") },
      { id: "start", label: t("feat.batesStart"), type: "number", value: "1", span: 2 },
      { id: "digits", label: t("feat.batesDigits"), type: "select", value: "6", span: 2, options: [
        { value: "4", label: "4 (0001)" }, { value: "5", label: "5 (00001)" },
        { value: "6", label: "6 (000001)" }, { value: "8", label: "8 (00000001)" },
      ] },
      { id: "suffix", label: t("feat.batesSuffix"), type: "text", value: "", span: 3, placeholder: t("feat.batesSuffixPh") },
      { id: "pos", label: t("feat.pos"), type: "select", value: "br", span: 3, options: [
        { value: "br", label: t("feat.posBr") }, { value: "bc", label: t("feat.posBc") }, { value: "bl", label: t("feat.posBl") },
        { value: "tr", label: t("feat.posTr") }, { value: "tc", label: t("feat.posTc") }, { value: "tl", label: t("feat.posTl") },
      ] },
      { id: "size", label: t("feat.size"), type: "select", value: "10", options: SIZES, span: 3 },
      { id: "skip", label: t("feat.batesSkipCover"), type: "checkbox", value: false, span: 3 },
    ],
    validate: (f) => (/^\d{1,9}$/.test(String(f.start).trim()) ? null : t("feat.batesStartErr")),
  });
  if (!v) return;
  const skip = !!v.skip && a.doc!.info.pageCount > 1;
  const start = Number(String(v.start).trim());
  const digits = Number(v.digits);
  const res = await a.task(t("feat.batesBusy"), () => engine.addBatesNumbering({
    prefix: String(v.prefix),
    suffix: String(v.suffix),
    startNumber: start,
    digits,
    pos: v.pos as MarginPos,
    size: Number(v.size),
    pages: skip ? allPages(a).slice(1) : undefined,
  }));
  if (!res) return;
  await a.mutate("…", async () => res.info);
  const first = `${v.prefix}${String(start).padStart(digits, "0")}${v.suffix}`;
  const last = `${v.prefix}${String(res.nextNumber - 1).padStart(digits, "0")}${v.suffix}`;
  a.notify(t("feat.batesDone", { first, last }));
}

// ---------- rótulos de página (/PageLabels) ----------

function labelStyles(a: App): { value: PageLabelStyle; label: string }[] {
  const { t } = a;
  return [
    { value: "D", label: t("feat.plblStyleD") },
    { value: "r", label: t("feat.plblStyler") },
    { value: "R", label: t("feat.plblStyleR") },
    { value: "a", label: t("feat.plblStylea") },
    { value: "A", label: t("feat.plblStyleA") },
    { value: "none", label: t("feat.plblStyleNone") },
  ];
}

export async function pageLabels(a: App): Promise<void> {
  const { t } = a;
  const total = a.doc!.info.pageCount;
  const styles = labelStyles(a);
  const v = await a.askForm({
    title: t("feat.plblTitle"), okLabel: t("feat.plblOk"),
    message: t("feat.plblMsg"),
    fields: [
      { id: "mode", label: t("feat.plblScheme"), type: "select", value: "front", options: [
        { value: "front", label: t("feat.plblFrontBody") },
        { value: "single", label: t("feat.plblSingle") },
        { value: "clear", label: t("feat.plblClear") },
      ] },
      { id: "frontStyle", label: t("feat.plblFrontStyle"), type: "select", value: "r", span: 3,
        showIf: (f) => f.mode !== "clear", options: styles },
      { id: "frontPrefix", label: t("feat.plblFrontPrefix"), type: "text", value: "", span: 3,
        showIf: (f) => f.mode !== "clear", placeholder: t("feat.plblFrontPrefixPh") },
      { id: "bodyPage", label: t("feat.plblBodyPage"), type: "number", value: String(Math.min(2, total)), span: 2,
        showIf: (f) => f.mode === "front" },
      { id: "bodyStyle", label: t("feat.plblBodyStyle"), type: "select", value: "D", span: 2,
        showIf: (f) => f.mode === "front", options: styles },
      { id: "bodyStart", label: t("feat.plblBodyStart"), type: "number", value: "1", span: 2,
        showIf: (f) => f.mode === "front" },
      { id: "bodyPrefix", label: t("feat.plblBodyPrefix"), type: "text", value: "", span: 6,
        showIf: (f) => f.mode === "front", placeholder: t("feat.plblBodyPrefixPh") },
    ],
    validate: (f) => {
      if (f.mode === "front") {
        const bp = Number(String(f.bodyPage).trim());
        if (!Number.isInteger(bp) || bp < 2 || bp > total) return t("feat.plblErrPage", { total });
        const bs = Number(String(f.bodyStart).trim());
        if (!Number.isInteger(bs) || bs < 1) return t("feat.plblErrStart");
      }
      return null;
    },
  });
  if (!v) return;
  if (v.mode === "clear") {
    const ok = await a.mutate(t("feat.plblClearing"), () => engine.clearPageLabels());
    if (ok) a.notify(t("feat.plblCleared"));
    return;
  }
  const rules: PageLabelRule[] = [
    { startPage: 0, style: v.frontStyle as PageLabelStyle, prefix: String(v.frontPrefix), startAt: 1 },
  ];
  if (v.mode === "front") {
    rules.push({
      startPage: Number(String(v.bodyPage).trim()) - 1,
      style: v.bodyStyle as PageLabelStyle,
      prefix: String(v.bodyPrefix),
      startAt: Number(String(v.bodyStart).trim()),
    });
  }
  const ok = await a.mutate(t("feat.plblBusy"), () => engine.setPageLabelRules(rules));
  if (ok) a.notify(t("feat.plblDone"));
}

// ---------- exportar resumo de comentários ----------

export async function exportComments(a: App): Promise<void> {
  const { t } = a;
  const v = await a.askForm({
    title: t("feat.expComTitle"), okLabel: t("feat.expImgOk"),
    message: t("feat.expComMsg"),
    fields: [
      { id: "fmt", label: t("feat.format"), type: "select", value: "pdf", options: [
        { value: "pdf", label: t("feat.expComPdf") },
        { value: "md", label: t("feat.expComMd") },
        { value: "csv", label: t("feat.expComCsv") },
      ] },
    ],
  });
  if (!v) return;
  const fmt = v.fmt as "pdf" | "md" | "csv";
  const path = await window.papiro.saveDialog(`${base(a)}_${t("feat.expComSuffix")}.${fmt}`, fmt);
  if (!path) return;
  await a.task(t("feat.expComBusy"), async () => {
    const bytes = await engine.saveCommentsSummary(path, fmt);
    a.notify(t("feat.expComDone", { path, size: size(bytes, a) }));
  });
}

// ---------- modo leitura ----------

const MODES: ReadMode[] = ["normal", "sepia", "dark"];
const MODE_KEY: Record<ReadMode, I18nKey> = { normal: "feat.readNormal", sepia: "feat.readSepia", dark: "feat.readDark" };

export function cycleReadMode(a: App): void {
  const next = MODES[(MODES.indexOf(a.readMode) + 1) % MODES.length];
  a.setReadMode(next);
  a.notify(a.t("feat.readNotify", { mode: a.t(MODE_KEY[next]) }));
}

// ---------- Tier 2: HTML/Markdown → PDF, Certificado A1, Verificar assinaturas, Detectar campos ----------

export async function fromHtmlOrMarkdown(a: App): Promise<void> {
  const { t } = a;
  const [f] = await window.papiro.openDialog({ title: t("feat.htmlOpen"), webDoc: true });
  if (!f?.path) return;
  const v = await a.askForm({
    title: t("feat.htmlTitle"), okLabel: t("feat.htmlOk"),
    message: t("feat.htmlMsg", { name: f.name }),
    fields: [
      { id: "pageSize", label: t("feat.htmlPageSize"), type: "select", value: "A4", span: 3, options: [
        { value: "A4", label: t("feat.sizeA4") },
        { value: "Letter", label: t("feat.sizeLetter") },
      ] },
      { id: "landscape", label: t("feat.htmlLandscape"), type: "checkbox", value: false, span: 3 },
    ],
  });
  if (!v) return;
  const out = await a.task(t("feat.htmlBusy"), () =>
    window.papiro.convertToPdf({ path: f.path!, pageSize: v.pageSize as "A4" | "Letter", landscape: !!v.landscape }),
  );
  if (!out) return;
  await a.openData({ path: null, name: out.name, bytes: out.bytes });
  a.notify(t("feat.htmlDone", { name: out.name }));
}

export async function signWithA1(a: App): Promise<void> {
  const { t, lang } = a;
  const [pfx] = await window.papiro.openDialog({ title: t("feat.signOpen"), pfx: true });
  if (!pfx) return;
  const v = await a.askForm({
    title: t("feat.signTitle", { name: pfx.name }), okLabel: t("feat.signOk"),
    message: t("feat.signMsg"),
    fields: [
      { id: "pw", label: t("feat.signPw"), type: "password", value: "", span: 6 },
      { id: "reason", label: t("feat.signReason"), type: "text", value: "", span: 3, placeholder: t("feat.signReasonPh") },
      { id: "location", label: t("feat.signLoc"), type: "text", value: "", span: 3, placeholder: t("feat.signLocPh") },
      { id: "visible", label: t("feat.signVisible", { n: a.page + 1 }), type: "checkbox", value: true, span: 6 },
    ],
    validate: (f) => (String(f.pw).length ? null : t("feat.signPwErr")),
  });
  if (!v) return;

  const certInfo = await a.task(t("feat.signValidating"), () => engine.inspectPfx(pfx.bytes, String(v.pw)));
  if (!certInfo) return;
  const tag = localeTag(lang);
  if (certInfo.expired) {
    const ok = await a.ask({
      kind: "confirm", title: t("feat.signExpiredTitle"), okLabel: t("feat.signExpiredOk"),
      message: t("feat.signExpiredMsg", {
        cn: certInfo.commonName,
        from: new Date(certInfo.validFrom).toLocaleDateString(tag),
        to: new Date(certInfo.validTo).toLocaleDateString(tag),
      }),
    });
    if (ok === null) return;
  }

  const path = await window.papiro.saveDialog(`${base(a)}_${t("feat.signSuffix")}.pdf`);
  if (!path) return;

  const pg = a.doc!.info.pages[a.page];
  const visible = v.visible && pg
    ? { page: a.page, rect: [pg.x + pg.width - 230, pg.y + pg.height - 92, pg.x + pg.width - 24, pg.y + pg.height - 24] as [number, number, number, number] }
    : undefined;

  await a.task(t("feat.signBusy"), async () => {
    const res = await engine.signDigital({
      pfxBytes: pfx.bytes,
      password: String(v.pw),
      reason: String(v.reason).trim() || undefined,
      location: String(v.location).trim() || undefined,
      visible,
    });
    await window.papiro.writeFile(path, res.bytes);
    await a.adoptFile(path, res.bytes);
    a.notify(t("feat.signDone", { cn: res.cert.commonName, path }));
  });
}

export async function verifySignatures(a: App): Promise<void> {
  const { t, lang } = a;
  const sigs = await a.task(t("feat.verifyBusy"), () => engine.verifySignatures());
  if (!sigs) return;
  if (!sigs.length) {
    a.notify(t("feat.verifyNone"));
    return;
  }
  const STATUS: Record<string, string> = {
    valid: t("feat.verifyValid"),
    tampered: t("feat.verifyTampered"),
    invalid: t("feat.verifyInvalid"),
  };
  const tag = localeTag(lang);
  const lines = sigs.map((s, idx) => [
    `${idx + 1}. ${s.signerName} — ${STATUS[s.status] ?? s.status}`,
    s.issuer ? t("feat.verifyIssuer", { v: s.issuer }) : "",
    s.validTo ? t("feat.verifyValidity", { from: new Date(s.validFrom).toLocaleDateString(tag), to: new Date(s.validTo).toLocaleDateString(tag) }) : "",
    s.reason ? t("feat.verifyReason", { v: s.reason }) : "",
    s.location ? t("feat.verifyLocation", { v: s.location }) : "",
    `   ${s.note}`,
  ].filter(Boolean).join("\n"));
  await a.ask({
    kind: "confirm",
    title: t("feat.verifyTitle", { n: sigs.length }),
    okLabel: t("common.close"),
    message: lines.join("\n\n"),
  });
}

export async function autoDetectFields(a: App): Promise<void> {
  const { t } = a;
  const r = await a.task(t("feat.autoFldBusy", { n: a.page + 1 }), () => engine.autoDetectFields(a.page));
  if (!r) return;
  if (!r.created) {
    a.notify(t("feat.autoFldNone"));
    return;
  }
  await a.mutate("…", async () => r.info);
  a.notify(t("feat.autoFldDone", { count: r.created, page: a.page + 1 }));
}
