// Núcleo do editor: tudo o que mexe no PDF passa por aqui.
// Não depende de Electron nem de interface — pode ser testado direto no Node.
import * as mupdf from "mupdf";
import { compareDocuments } from "./compare.ts";
import { buildDocx, type DocxImage, type DocxPage, type DocxPara, type DocxRun } from "./docx.ts";
import { fontStyle, genericFontCategory, isSymbolicFont, stripSubset } from "./fontname.ts";
import { normalizePdfText, originalSource, type GlyphSource } from "./fonts.ts";
import { addFormField, detectCandidateFields, removeFormField } from "./forms.ts";
import { preprocessPixelsForOcr, rotatePixels90, unrotateOcrBox, type QuarterTurn } from "./ocr-prep.ts";
import { inspectPfx, signPdfBytes, verifyPdfSignatures } from "./sign.ts";
import { buildCsv } from "./tables.ts";
import {
  buildCommentsSummaryPdf, detectHeadingOutline, extractTextInRect, findPatternMatches,
  formatCommentsCsv, formatCommentsMarkdown,
} from "./tier1.ts";
import {
  pageType3Fonts, recoverType3Font, repairType3FontBBoxes, type3FontObjNum,
  type Type3FontInfo, type Type3Recovered,
} from "./type3.ts";
import { removePageWatermarks } from "./watermarks.ts";
import type {
  AnnotInfo, AttachmentInfo, BatesSpec, CommentSummaryItem, CompareReport, CreateFieldSpec, CropMargins,
  DigitalSignOptions, DocInfo, EditTextRequest, EditTextResult, FieldInfo, LayerInfo, LinkInfo, NewAnnot,
  OptimizeOptions, OptimizeResult, OutlineNode, PageLabelRule, PfxCertInfo, Point, Quad, Rect, RGB,
  SearchHit, SignatureVerifyInfo, SmartRedactRequest, SmartRedactResult, SpaceAudit, TextBlock, TextLine,
} from "./types.ts";

export interface OcrSymbol { text: string; bbox: Rect; confidence: number }
export interface OcrWord { text: string; bbox: Rect; confidence?: number; symbols?: OcrSymbol[] } // bbox em pixels da imagem enviada
export type Recognizer = ((png: Uint8Array) => Promise<OcrWord[]>) & {
  recognizeRgb?: (rgb: Uint8Array | Uint8ClampedArray, width: number, height: number, comps?: number) => Promise<OcrWord[]>;
  detectOrientation?: (rgb: Uint8Array | Uint8ClampedArray, width: number, height: number, comps?: number) => Promise<{
    angle: QuarterTurn;
    fixCwDeg: QuarterTurn;
    confidence: number;
  }>;
};
/** Procura no sistema uma fonte equivalente à do PDF (usada quando a fonte embutida não tem alguma letra). */
export type FontProvider = (pdfFontName: string) => { data: Uint8Array; subfont?: number; file?: string } | null;

const FONT_KEY = "PapiroF";
// "objstms" mantém os objetos em fluxos compactados: sem ele, PDFs do Word/Chrome crescem várias vezes ao salvar.
const SAVE_OPTIONS = "garbage,compress,objstms";

export class PdfEngine {
  private doc: mupdf.PDFDocument | null = null;
  private title = "";
  private password = "";   // senha usada para abrir (para reabrir depois de salvar)
  private modified = false; // alterações desde o último "Salvar"
  private pending: { doc: mupdf.PDFDocument; title: string } | null = null; // aguardando a senha de abertura
  private encrypted = false; // tem senha de abertura e/ou restrições
  private fontRefs = new Map<string, mupdf.PDFObject>();
  private gsRefs = new Map<string, mupdf.PDFObject>();
  private sysFonts = new Map<string, { font: mupdf.Font; ref: mupdf.PDFObject; label: string }>();
  private type3Info = new Map<number, Type3FontInfo>();
  private type3Cache = new Map<string, Type3Recovered>();
  private readonly fontProvider: FontProvider | null;
  // Histórico de snapshots através de "Salvar" (Ctrl+Z sobrevive ao salvamento, limitado a ~40 MB)
  private baselineBytes: Uint8Array | null = null;
  private saveUndoStack: Uint8Array[] = [];
  private saveRedoStack: Uint8Array[] = [];

  constructor(opts: { fonts?: FontProvider } = {}) {
    this.fontProvider = opts.fonts ?? null;
  }

  // ---------- documento ----------

  /**
   * Abre um PDF. Se ele pedir senha e nenhuma for dada, fica "pendente": o
   * documento atual continua aberto até `unlock` dar certo (ou `cancelOpen`).
   */
  open(bytes: Uint8Array, title = "", password = ""): DocInfo {
    let doc: mupdf.PDFDocument | null = null;
    try { doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF(); } catch { /* tratado abaixo */ }
    if (!doc) throw new Error("O arquivo não é um PDF válido ou está corrompido.");
    this.cancelOpen();
    // needsPassword() só pode ser consultado ANTES de autenticar: no MuPDF ele
    // testa a senha vazia e, com isso, descarta a chave já calculada.
    const needsPw = doc.needsPassword();
    if (needsPw && !password) {
      // Não toca em nenhum objeto antes da senha: o MuPDF guardaria em cache o
      // conteúdo ainda cifrado e o documento ficaria ilegível.
      this.pending = { doc, title };
      return { pageCount: 0, pages: [], outline: [], title, canUndo: false, canRedo: false, dirty: false, encrypted: true };
    }
    if (needsPw && !doc.authenticatePassword(password)) { doc.destroy(); throw new Error("Senha incorreta."); }
    this.adopt(doc, title, needsPw ? password : "");
    this.baselineBytes = bytes.length <= 15_000_000 ? new Uint8Array(bytes) : null;
    this.saveUndoStack = [];
    this.saveRedoStack = [];
    return this.info();
  }

  /** Reabre internamente mantendo a pilha de desfazer entre salvamentos. */
  private openKeepingSaveHistory(bytes: Uint8Array, title: string, password: string): void {
    const u = this.saveUndoStack;
    const r = this.saveRedoStack;
    const b = this.baselineBytes;
    const pending = this.pending;
    this.pending = null;
    try {
      this.open(bytes, title, password);
    } finally {
      this.pending = pending;
      this.saveUndoStack = u;
      this.saveRedoStack = r;
      this.baselineBytes = b;
    }
  }

  /** Há um documento esperando a senha de abertura? */
  needsPassword(): boolean {
    return this.pending !== null;
  }

  unlock(password: string): DocInfo {
    const p = this.pending;
    if (!p) throw new Error("Nenhum documento aguardando senha.");
    if (!p.doc.authenticatePassword(password)) throw new Error("Senha incorreta.");
    this.pending = null;
    this.adopt(p.doc, p.title, password);
    return this.info();
  }

  /** Desiste do documento que esperava senha; o documento atual não muda. */
  cancelOpen(): void {
    this.pending?.doc.destroy();
    this.pending = null;
  }

  private adopt(doc: mupdf.PDFDocument, title: string, password: string): void {
    this.doc?.destroy();
    this.doc = doc;
    this.title = title;
    this.password = password;
    this.modified = false;
    this.encrypted = !doc.getTrailer().get("Encrypt").isNull();
    this.forgetRefs();
    // Repara /FontBBox invertido em fontes Type 3 ANTES de habilitar o histórico de desfazer.
    this.type3Info = repairType3FontBBoxes(doc);
    doc.enableJournal();
  }

  close(): void {
    this.cancelOpen();
    this.doc?.destroy();
    this.doc = null;
    this.type3Info.clear();
    this.type3Cache.clear();
    this.baselineBytes = null;
    this.saveUndoStack = [];
    this.saveRedoStack = [];
  }

  info(): DocInfo {
    const doc = this.d();
    const n = doc.countPages();
    const pages = [];
    for (let i = 0; i < n; i++) {
      const p = doc.loadPage(i);
      const [x0, y0, x1, y1] = p.getBounds();
      pages.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, label: p.getLabel() || String(i + 1) });
      p.destroy();
    }
    return {
      pageCount: n,
      pages,
      outline: this.outline(),
      title: doc.getMetaData("info:Title") || this.title,
      canUndo: doc.canUndo() || this.saveUndoStack.length > 0,
      canRedo: doc.canRedo() || this.saveRedoStack.length > 0,
      dirty: this.modified,
      encrypted: this.encrypted,
    };
  }

  private outline(): OutlineNode[] {
    const walk = (items: any[] | null | undefined): OutlineNode[] =>
      (items ?? []).map((it) => ({
        title: it.title ?? "",
        page: typeof it.page === "number" ? it.page : -1,
        children: walk(it.down),
      }));
    try {
      return walk(this.d().loadOutline());
    } catch {
      return [];
    }
  }

  /**
   * Salva e guarda um snapshot anterior na pilha de desfazer, permitindo `Ctrl+Z` mesmo após salvar.
   */
  save(): Uint8Array {
    if (this.modified && this.baselineBytes && this.baselineBytes.length <= 15_000_000) {
      this.pushSaveSnapshot(this.saveUndoStack, this.baselineBytes);
      this.saveRedoStack = [];
    }
    const out = this.serialize();
    this.baselineBytes = out.length <= 15_000_000 ? out : null;
    this.modified = false;
    return out;
  }

  /** Serializa uma cópia instantânea dos bytes atuais SEM alterar o estado ou histórico (para auto-recuperação e verificação). */
  peekBytes(options = SAVE_OPTIONS): Uint8Array {
    const buf = this.d().saveToBuffer(options);
    const out = new Uint8Array(buf.asUint8Array());
    buf.destroy();
    return out;
  }

  private pushSaveSnapshot(stack: Uint8Array[], bytes: Uint8Array): void {
    stack.push(bytes);
    const maxBytes = 40_000_000;
    let total = stack.reduce((s, b) => s + b.length, 0);
    while (stack.length > 6 || (stack.length > 1 && total > maxBytes)) {
      total -= stack.shift()!.length;
    }
  }

  /** Bytes do documento atual. Reabre a partir deles, preservando senha, estado e snapshots entre salvamentos. */
  private serialize(options = SAVE_OPTIONS): Uint8Array {
    const out = this.peekBytes(options);
    const { title, password, modified } = this;
    this.openKeepingSaveHistory(out, title, password);
    this.modified = modified;
    return out;
  }

  /**
   * Abre bytes que o próprio Papiro acabou de gravar (cópia protegida, comprimida…).
   * Sem senha informada, usa a do documento atual.
   */
  reopen(bytes: Uint8Array, title: string, password?: string): DocInfo {
    const info = this.open(bytes, title, password ?? this.password);
    if (this.pending) { this.cancelOpen(); throw new Error("Senha incorreta."); }
    return info;
  }

  /** Abre bytes num documento separado (para exportações que não mexem no documento atual). */
  private scratch(bytes: Uint8Array): mupdf.PDFDocument {
    const d = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
    if (d.needsPassword() && this.password) d.authenticatePassword(this.password);
    return d;
  }

  /**
   * Cópia protegida por senha. A senha de abertura é opcional; as permissões
   * valem quando há senha de proprietário (gerada automaticamente se faltar).
   */
  exportProtected(opts: ProtectOptions): Uint8Array {
    for (const p of [opts.userPassword, opts.ownerPassword]) {
      if (p && /[,=]/.test(p)) throw new Error("A senha não pode conter vírgula nem sinal de igual.");
    }
    // Nunca igual à senha de abertura: quem abre com ela viraria "proprietário" e as restrições não valeriam.
    const owner = opts.ownerPassword && opts.ownerPassword !== opts.userPassword ? opts.ownerPassword : randomPassword();
    const perm = opts.permissions;
    let P = 0xfffff0c0; // bits reservados ligados (PDF 1.7, tabela 22)
    if (perm.print) P |= 4 | 2048;
    if (perm.edit) P |= 8 | 1024;
    if (perm.copy) P |= 16 | 512;
    if (perm.annotate) P |= 32 | 256;
    const pSigned = P | 0; // inteiro de 32 bits com sinal
    let base = this.serialize();
    if (opts.recipient?.trim() || opts.imageOnly) base = this.recipientCopy(base, opts.recipient?.trim() ?? "", opts.imageOnly ?? 0);
    const src = this.scratch(base);
    let o = `${SAVE_OPTIONS},encrypt=aes-256,owner-password=${owner},permissions=${pSigned}`;
    if (opts.userPassword) o += `,user-password=${opts.userPassword}`;
    const buf = src.saveToBuffer(o);
    const out = new Uint8Array(buf.asUint8Array());
    buf.destroy(); src.destroy();
    return out;
  }

  /**
   * Bytes de uma cópia com o nome do destinatário (marca d'água no meio e rodapé em todas as páginas)
   * e/ou com as páginas viradas imagem (`imageOnly` = resolução em dpi). O documento aberto não muda.
   */
  private recipientCopy(bytes: Uint8Array, recipient: string, imageOnly: number): Uint8Array {
    const tmp = new PdfEngine();
    try {
      tmp.open(bytes, this.title, this.password);
      if (recipient) {
        const today = new Date().toLocaleDateString("pt-BR");
        tmp.addWatermark({ text: `Cópia de ${recipient}`.slice(0, 80), opacity: 0.13, removable: false });
        tmp.addHeaderFooter({ items: [{ pos: "bc", text: `Cópia exclusiva de ${recipient} — ${today} — não redistribuir` }], size: 7, margin: 14, color: [0.45, 0.45, 0.45] });
      }
      return imageOnly ? tmp.rasterize(imageOnly) : tmp.save();
    } finally { tmp.close(); }
  }

  /**
   * PDF novo em que cada página é uma imagem (JPEG) da página original, do mesmo tamanho.
   * Texto, anotações e campos viram parte da imagem: não dá para copiar, pesquisar nem editar o texto.
   */
  rasterize(dpi = 150): Uint8Array {
    const src = this.d();
    const out = new mupdf.PDFDocument();
    const n = src.countPages();
    for (let i = 0; i < n; i++) {
      const page = src.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      const pix = page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false, true);
      const jpg = pix.asJPEG(85);
      pix.destroy(); page.destroy();
      const img = new mupdf.Image(jpg);
      const w = x1 - x0, h = y1 - y0;
      const res = out.newDictionary();
      const xo = out.newDictionary();
      xo.put("Im0", out.addImage(img));
      res.put("XObject", xo);
      out.insertPage(-1, out.addPage([0, 0, w, h], 0, res, `q ${n3(w)} 0 0 ${n3(h)} 0 0 cm /Im0 Do Q`));
      img.destroy();
    }
    const title = src.getMetaData("info:Title");
    if (title) out.setMetaData("info:Title", title);
    const buf = out.saveToBuffer(SAVE_OPTIONS);
    const bytes = new Uint8Array(buf.asUint8Array());
    buf.destroy(); out.destroy();
    return bytes;
  }

  /**
   * Remove as marcas d'água de todas as páginas (as marcadas como tal pelo Acrobat, Foxit e PapyrusPDF,
   * camadas de marca d'água e a do Word). Pode ser desfeito.
   */
  removeWatermarks(): { removed: number; pages: number; info: DocInfo } {
    const doc = this.d();
    const n = doc.countPages();
    const hit = Array.from({ length: n }, (_, i) => i).filter((i) => removePageWatermarks(doc, i, true) > 0);
    let removed = 0;
    if (hit.length) this.op("Remover marca d'água", () => { for (const i of hit) removed += removePageWatermarks(doc, i); });
    return { removed, pages: hit.length, info: this.info() };
  }

  /** Cópia sem senha nem restrições (o documento precisa estar desbloqueado). */
  exportUnprotected(): Uint8Array {
    const src = this.scratch(this.serialize());
    const buf = src.saveToBuffer(`${SAVE_OPTIONS},encrypt=none`);
    const out = new Uint8Array(buf.asUint8Array());
    buf.destroy(); src.destroy();
    return out;
  }

  /** O documento aberto tem criptografia (senha de abertura e/ou restrições)? */
  isEncrypted(): boolean {
    this.d();
    return this.encrypted;
  }

  /** Volta a marcar o documento como alterado (ex.: a gravação em disco falhou depois de `save`). */
  markModified(): DocInfo {
    this.modified = true;
    return this.info();
  }

  /** Nome do documento (usado no marcador {arquivo}); muda em "Salvar como". */
  setTitle(title: string): void {
    this.title = title;
  }

  /**
   * Cópia comprimida: reduz imagens grandes (JPEG) e compacta o arquivo.
   * Não altera o documento aberto.
   */
  exportCompressed(level: "leve" | "media" | "forte"): { bytes: Uint8Array; before: number; after: number; images: number } {
    const r = this.exportOptimized({ level });
    return { bytes: r.bytes, before: r.before, after: r.after, images: r.images };
  }

  /** Auditoria offline de espaço: mostra quanto cada categoria (imagens, fontes, fluxos, anexos…) ocupa no PDF. */
  auditSpace(): SpaceAudit {
    const doc = this.d();
    const buf = doc.saveToBuffer(SAVE_OPTIONS);
    const totalBytes = buf.getLength();
    buf.destroy();

    let images = 0, fonts = 0, streams = 0, metadata = 0, attachments = 0;
    let imageCount = 0, fontCount = 0, attachmentCount = 0;
    const fontStreamNums = new Set<number>();

    const n = doc.countObjects();
    for (let num = 1; num < n; num++) {
      let obj: mupdf.PDFObject;
      try { obj = doc.newIndirect(num); } catch { continue; }
      if (obj.isDictionary()) {
        const typ = obj.get("Type").isName() ? obj.get("Type").asName() : "";
        if (typ === "FontDescriptor") {
          for (const fk of ["FontFile", "FontFile2", "FontFile3"]) {
            const ref = obj.get(fk);
            if (ref.isIndirect()) fontStreamNums.add(ref.asIndirect());
          }
        }
      }
    }

    const pageContentNums = new Set<number>();
    const pc = doc.countPages();
    for (let i = 0; i < pc; i++) {
      const c = doc.findPage(i).get("Contents");
      if (c.isIndirect()) pageContentNums.add(c.asIndirect());
      else if (c.isArray()) c.forEach((v) => { if (v.isIndirect()) pageContentNums.add(v.asIndirect()); });
    }

    for (let num = 1; num < n; num++) {
      let obj: mupdf.PDFObject;
      try { obj = doc.newIndirect(num); if (!obj.isStream()) continue; } catch { continue; }
      let len = 0;
      try {
        const raw = obj.readRawStream();
        len = raw.getLength();
        raw.destroy();
      } catch { continue; }
      const typ = obj.get("Type").isName() ? obj.get("Type").asName() : "";
      const sub = obj.get("Subtype").isName() ? obj.get("Subtype").asName() : "";
      if (sub === "Image") { images += len; imageCount++; }
      else if (fontStreamNums.has(num) || typ === "Font" || sub === "Type1C" || sub === "CIDFontType0C" || sub === "OpenType") { fonts += len; fontCount++; }
      else if (typ === "EmbeddedFile") { attachments += len; attachmentCount++; }
      else if (typ === "Metadata") { metadata += len; }
      else if (pageContentNums.has(num) || sub === "Form") { streams += len; }
      else { streams += len; }
    }

    const accounted = images + fonts + streams + metadata + attachments;
    return {
      totalBytes,
      images,
      fonts,
      streams,
      metadata,
      attachments,
      other: Math.max(0, totalBytes - accounted),
      imageCount,
      fontCount,
      attachmentCount,
    };
  }

  /**
   * Otimizador avançado offline: redução de imagens, subconjunto de fontes, linearização (Fast Web View)
   * e remoção seletiva de metadados, anexos, marcadores, miniaturas e JavaScript. Não altera o documento aberto.
   */
  exportOptimized(opts: OptimizeOptions): OptimizeResult {
    const buf0 = this.d().saveToBuffer(SAVE_OPTIONS);
    const original = new Uint8Array(buf0.asUint8Array());
    buf0.destroy();
    const d = this.scratch(original);
    let images = 0;

    try {
      if (opts.level !== "nenhuma") {
        const cfg = { leve: { px: 2600, q: 85 }, media: { px: 1800, q: 72 }, forte: { px: 1200, q: 55 } }[opts.level];
        const n = d.countObjects();
        for (let num = 1; num < n; num++) {
          let obj: mupdf.PDFObject;
          try { obj = d.newIndirect(num); if (!obj.isStream()) continue; } catch { continue; }
          const sub = obj.get("Subtype");
          if (sub.isNull() || sub.asName() !== "Image") continue;
          if (obj.get("ImageMask").isBoolean() && obj.get("ImageMask").asBoolean()) continue;
          if (obj.get("Mask").isArray()) continue;
          let img: mupdf.Image | undefined, p0: mupdf.Pixmap | undefined, p1: mupdf.Pixmap | undefined, p2: mupdf.Pixmap | undefined;
          try {
            const w = obj.get("Width").asNumber(), h = obj.get("Height").asNumber();
            const raw = obj.readRawStream();
            const rawLen = raw.getLength();
            raw.destroy();
            if (rawLen < 60_000) continue;
            img = d.loadImage(obj);
            p0 = img.toPixmap();
            const gray = p0.getColorSpace()?.isGray() === true;
            p1 = p0.convertToColorSpace(gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, false);
            p0.destroy(); p0 = undefined;
            const big = Math.max(w, h);
            let nw = w, nh = h;
            if (big > cfg.px) {
              const s = cfg.px / big;
              nw = Math.max(1, Math.round(w * s)); nh = Math.max(1, Math.round(h * s));
              p2 = p1.warp([[0, 0], [w, 0], [w, h], [0, h]], nw, nh);
            }
            const jpg = (p2 ?? p1).asJPEG(cfg.q);
            if (jpg.length >= rawLen * 0.9) continue;
            obj.writeRawStream(jpg);
            obj.put("Filter", d.newName("DCTDecode"));
            obj.delete("DecodeParms");
            obj.delete("Decode");
            obj.put("Width", nw);
            obj.put("Height", nh);
            obj.put("ColorSpace", d.newName(gray ? "DeviceGray" : "DeviceRGB"));
            obj.put("BitsPerComponent", 8);
            images++;
          } catch { /* imagem em formato não suportado: fica como está */ }
          finally { p2?.destroy(); p1?.destroy(); p0?.destroy(); img?.destroy(); }
        }
      }

      if (opts.subsetFonts) {
        try { d.subsetFonts(); } catch { /* segue sem subconjunto se alguma fonte falhar */ }
      }

      const trailer = d.getTrailer();
      const root = trailer.get("Root").resolve();
      const pc = d.countPages();

      if (opts.stripMetadata) {
        trailer.delete("Info");
        if (root.isDictionary()) root.delete("Metadata");
        for (let i = 0; i < pc; i++) d.findPage(i).delete("Metadata");
      }
      if (opts.stripAttachments) {
        try {
          for (const key of Object.keys(d.getEmbeddedFiles())) d.deleteEmbeddedFile(key);
        } catch { /* sem anexos */ }
        if (root.isDictionary()) root.delete("AF");
        for (let i = 0; i < pc; i++) d.findPage(i).delete("AF");
      }
      if (opts.stripBookmarks && root.isDictionary()) {
        root.delete("Outlines");
      }
      if (opts.stripThumbnails) {
        for (let i = 0; i < pc; i++) d.findPage(i).delete("Thumb");
      }
      if (opts.stripJavaScript) {
        if (root.isDictionary()) {
          const names = root.get("Names");
          if (names.isDictionary()) names.delete("JavaScript");
          root.delete("OpenAction");
          root.delete("AA");
        }
        for (let i = 0; i < pc; i++) d.findPage(i).delete("AA");
      }

      const garbage = opts.deduplicate ? "garbage=deduplicate" : "garbage=compact";
      const saveOpts = `${garbage},compress,compress-fonts,compress-images,objstms`;
      let buf: mupdf.Buffer;
      try { buf = d.saveToBuffer(saveOpts); }
      catch { buf = d.saveToBuffer(SAVE_OPTIONS); }
      let bytes: Uint8Array = new Uint8Array(buf.asUint8Array());
      buf.destroy();
      const structural = !!(opts.stripMetadata || opts.stripAttachments || opts.stripBookmarks || opts.stripThumbnails || opts.stripJavaScript);
      if (!structural && bytes.length >= original.length) bytes = original;
      return { bytes, before: original.length, after: bytes.length, images };
    } finally {
      d.destroy();
    }
  }

  undo(): DocInfo {
    if (this.d().canUndo()) {
      this.d().undo();
      this.modified = true;
      this.forgetRefs();
      return this.info();
    }
    if (this.saveUndoStack.length > 0) {
      const cur = this.peekBytes();
      if (cur.length <= 15_000_000) this.pushSaveSnapshot(this.saveRedoStack, cur);
      const prev = this.saveUndoStack.pop()!;
      this.openKeepingSaveHistory(prev, this.title, this.password);
      this.baselineBytes = prev;
      this.modified = true;
    }
    return this.info();
  }

  redo(): DocInfo {
    if (this.d().canRedo()) {
      this.d().redo();
      this.modified = true;
      this.forgetRefs();
      return this.info();
    }
    if (this.saveRedoStack.length > 0) {
      const cur = this.peekBytes();
      if (cur.length <= 15_000_000) this.pushSaveSnapshot(this.saveUndoStack, cur);
      const next = this.saveRedoStack.pop()!;
      this.openKeepingSaveHistory(next, this.title, this.password);
      this.baselineBytes = next;
      this.modified = true;
    }
    return this.info();
  }

  /** Desfazer pode ter apagado os objetos de fonte/transparência criados antes: não reaproveita nenhum. */
  private forgetRefs(): void {
    this.fontRefs.clear();
    this.gsRefs.clear();
    for (const f of this.sysFonts.values()) f.font.destroy();
    this.sysFonts.clear();
  }

  // ---------- visualização ----------

  /** Renderiza a página em RGBA (fundo branco). */
  render(index: number, scale: number): { width: number; height: number; rgba: Uint8ClampedArray } {
    const page = this.d().loadPage(index);
    const m = mupdf.Matrix.scale(scale, scale);
    const bbox = mupdf.Rect.transform(page.getBounds(), m);
    const ibox: Rect = [Math.floor(bbox[0]), Math.floor(bbox[1]), Math.ceil(bbox[2]), Math.ceil(bbox[3])];
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, ibox, true);
    pix.clear(255);
    const dev = new mupdf.DrawDevice(m, pix);
    page.run(dev, mupdf.Matrix.identity);
    dev.close();
    const out = { width: pix.getWidth(), height: pix.getHeight(), rgba: new Uint8ClampedArray(pix.getPixels()) };
    dev.destroy(); pix.destroy(); page.destroy();
    return out;
  }

  renderPng(index: number, scale: number): Uint8Array {
    const page = this.d().loadPage(index);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    const png = new Uint8Array(pix.asPNG());
    pix.destroy(); page.destroy();
    return png;
  }

  /** Alguma fonte Type 3 sem /ToUnicode ainda precisa de reconhecimento automático? */
  hasUnmappedType3(page?: number): boolean {
    if (!this.doc || !this.type3Info.size) return false;
    const infos = page !== undefined
      ? pageType3Fonts(this.doc.findPage(page)).map((f) => this.type3Info.get(f.objNum) ?? f)
      : [...this.type3Info.values()];
    return infos.some((f) => f.needsRecovery && !this.type3Cache.has(f.fingerprint));
  }

  /**
   * Recupera o mapa Unicode (e negrito) das fontes Type 3 sem /ToUnicode usando o reconhecedor OCR.
   * O resultado fica em cache pela assinatura dos vetores da fonte (sobrevive ao salvamento).
   */
  async recoverType3(recognize: Recognizer, page?: number): Promise<number> {
    const doc = this.d();
    if (!this.type3Info.size) return 0;
    const infos = page !== undefined
      ? pageType3Fonts(doc.findPage(page)).map((f) => this.type3Info.get(f.objNum) ?? f)
      : [...this.type3Info.values()];
    let count = 0;
    const done = new Set<string>();
    for (const info of infos) {
      if (!info.needsRecovery || this.type3Cache.has(info.fingerprint) || done.has(info.fingerprint)) continue;
      done.add(info.fingerprint);
      const rec = await recoverType3Font(doc, info, recognize);
      if (this.doc !== doc) return count; // documento foi trocado durante o reconhecimento
      this.type3Cache.set(info.fingerprint, rec);
      count++;
    }
    return count;
  }

  private type3ForFont(fontName: string): { info: Type3FontInfo; rec?: Type3Recovered } | null {
    const objNum = type3FontObjNum(fontName);
    if (objNum === null) return null;
    const info = this.type3Info.get(objNum);
    if (!info) return null;
    return { info, rec: this.type3Cache.get(info.fingerprint) };
  }

  private pageHasRecoveredType3(index: number): boolean {
    if (!this.type3Cache.size || !this.doc) return false;
    return pageType3Fonts(this.doc.findPage(index)).some((f) => this.type3Cache.has(f.fingerprint));
  }

  /** Texto da página em blocos → linhas → caracteres, com fonte, tamanho e cor predominantes. */
  pageText(index: number): TextBlock[] {
    const page = this.d().loadPage(index);
    const st = page.toStructuredText("preserve-whitespace");
    const blocks: TextBlock[] = [];
    let block: TextBlock | null = null;
    type RawChar = { c: string; quad: Quad; empty?: boolean };
    let line: (Omit<TextLine, "chars"> & { chars: RawChar[]; trimmed?: boolean }) | null = null;
    type StyleCount = { font: string; size: number; color: RGB; count: number; symbolic: boolean };
    let styles: Map<string, StyleCount> | null = null;
    st.walk({
      beginTextBlock(bbox) { block = { bbox: bbox as Rect, lines: [] }; },
      beginLine(bbox) {
        line = { bbox: bbox as Rect, text: "", font: "", size: 0, color: [0, 0, 0], origin: [0, 0], chars: [] };
        styles = new Map();
      },
      onChar: (c, origin, font, size, quad, color) => {
        if (!line || !styles) return;
        const rawFname = font.getName();
        const t3 = this.type3ForFont(rawFname);
        let ch = c;
        let fname = rawFname;
        if (t3) {
          const cp0 = c.codePointAt(0) ?? 0;
          const isEmpty = cp0 === 0xfffd || t3.info.emptyCodes.has(cp0)
            || (t3.info.needsRecovery && !t3.info.codeToGlyphName.has(cp0));
          if (isEmpty) {
            line.chars.push({ c: " ", quad: quad as Quad, empty: true });
            line.trimmed = true;
            return;
          }
          ch = t3.rec?.codeToChar.get(cp0) ?? c;
          fname = t3.rec?.boldCodes.has(cp0) ? "Helvetica-Bold" : "Helvetica";
        }
        const rgb = toRGB(color as number[]);
        if (!line.font) {
          line.font = fname;
          line.size = size;
          line.origin = [origin[0], origin[1]];
          line.color = rgb;
        }
        // Conta o estilo predominante da linha (ignora espaços e caracteres de área privada como bullets do Word)
        const cp = ch.codePointAt(0) ?? 0;
        const isPua = cp >= 0xe000 && cp <= 0xf8ff;
        if (ch.trim() && !isPua) {
          const sym = isSymbolicFont(fname);
          const k = `${fname}|${Math.round(size * 10)}|${rgb.map((v) => Math.round(v * 100)).join(",")}`;
          const prev = styles.get(k);
          if (prev) prev.count++;
          else styles.set(k, { font: fname, size, color: rgb, count: 1, symbolic: sym });
        }
        line.chars.push({ c: ch, quad: quad as Quad });
      },
      endLine() {
        if (block && line && line.chars.length) {
          // Remove glifos vazios (.notdef de fontes Type 3) nas pontas e junta espaços repetidos no meio.
          let raw = line.chars;
          if (line.trimmed) {
            let a = 0, b = raw.length - 1;
            while (a <= b && raw[a].empty) a++;
            while (b >= a && raw[b].empty) b--;
            const compacted: RawChar[] = [];
            for (let k = a; k <= b; k++) {
              if (raw[k].empty && compacted.length && compacted[compacted.length - 1].empty) continue;
              compacted.push(raw[k]);
            }
            raw = compacted;
          }
          if (raw.length && raw.some((x) => !x.empty)) {
            const list = styles ? [...styles.values()] : [];
            const nonSym = list.filter((s) => !s.symbolic);
            const pool = nonSym.length ? nonSym : list;
            if (pool.length) {
              pool.sort((a, b) => b.count - a.count);
              line.font = pool[0].font;
              line.size = pool[0].size;
              line.color = pool[0].color;
            }
            const cleanChars = raw.map(({ c: cc, quad: q }) => ({ c: cc, quad: q }));
            const bbox = line.trimmed ? quadsBounds(raw.filter((x) => !x.empty).map((x) => x.quad)) : line.bbox;
            block.lines.push({
              bbox,
              text: cleanChars.map((x) => x.c).join(""),
              font: line.font,
              size: line.size,
              color: line.color,
              origin: line.origin,
              chars: cleanChars,
            });
          }
        }
        line = null;
        styles = null;
      },
      endTextBlock() { if (block && block.lines.length) blocks.push(block); block = null; },
    });
    st.destroy(); page.destroy();
    return splitTextBlocks(blocks);
  }

  search(needle: string): SearchHit[] {
    const hits: SearchHit[] = [];
    const q = needle.trim();
    if (!q) return hits;
    const qLower = q.toLowerCase();
    const n = this.d().countPages();
    for (let i = 0; i < n; i++) {
      if (this.pageHasRecoveredType3(i)) {
        for (const b of this.pageText(i)) {
          for (const l of b.lines) {
            const lower = l.text.toLowerCase();
            let pos = 0;
            while ((pos = lower.indexOf(qLower, pos)) >= 0) {
              const slice = l.chars.slice(pos, pos + qLower.length);
              if (slice.length) hits.push({ page: i, quads: [mergeQuads(slice.map((ch) => ch.quad))] });
              pos += qLower.length;
            }
          }
        }
        continue;
      }
      const page = this.d().loadPage(i);
      for (const hit of page.search(needle, null)) hits.push({ page: i, quads: hit as Quad[] });
      page.destroy();
    }
    return hits;
  }

  // ---------- anotações ----------

  annotations(index: number): AnnotInfo[] {
    const page = this.d().loadPage(index);
    const out = page.getAnnotations().map((a) => ({
      id: a.getObject().asIndirect(),
      kind: a.getType(),
      rect: (a.hasRect() ? a.getRect() : a.getBounds()) as Rect,
      contents: a.getContents(),
      author: a.hasAuthor() ? a.getAuthor() : "",
      color: [...a.getColor()],
    }));
    page.destroy();
    return out;
  }

  /** Anotações de todas as páginas (painel de comentários), sem links nem campos. */
  allAnnotations(): (AnnotInfo & { page: number })[] {
    const out: (AnnotInfo & { page: number })[] = [];
    const n = this.d().countPages();
    for (let i = 0; i < n; i++) {
      for (const a of this.annotations(i)) if (a.kind !== "Link" && a.kind !== "Widget") out.push({ ...a, page: i });
    }
    return out;
  }

  /** Aplica todas as marcas de redação do documento (incluindo códigos de sobreposição LGPD). */
  applyAllRedactions(): { pages: number; info: DocInfo } {
    const pages = [...new Set(this.allAnnotations().filter((a) => a.kind === "Redact").map((a) => a.page))];
    if (pages.length) {
      this.op("Aplicar redações", () => {
        for (const i of pages) this.applyPageRedactionsInner(i);
      });
    }
    return { pages: pages.length, info: this.info() };
  }

  private applyPageRedactionsInner(index: number): void {
    const page = this.d().loadPage(index);
    const overlays: { rect: Rect; text: string }[] = [];
    for (const a of page.getAnnotations()) {
      if (a.getType() !== "Redact") continue;
      const txt = (a.getContents() ?? "").trim();
      if (txt) overlays.push({ rect: (a.hasRect() ? a.getRect() : a.getBounds()) as Rect, text: txt });
    }
    page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS,
      mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
    page.destroy();

    if (overlays.length) {
      const fonts: Record<string, mupdf.PDFObject> = {};
      let ops = "BT\n1 1 1 rg\n";
      for (const ov of overlays) {
        const w = Math.max(1, ov.rect[2] - ov.rect[0]);
        const h = Math.max(1, ov.rect[3] - ov.rect[1]);
        let sz = Math.max(5, Math.min(9.5, h * 0.65));
        let enc = this.encodeLineOps(ov.text, "Helvetica-Bold", sz, fonts);
        if (enc.width > w - 3 && enc.width > 0) {
          sz = Math.max(4, sz * ((w - 3) / enc.width));
          enc = this.encodeLineOps(ov.text, "Helvetica-Bold", sz, fonts);
        }
        const x = ov.rect[0] + Math.max(1, (w - enc.width) / 2);
        const y = ov.rect[1] + h / 2 + sz * 0.34;
        ops += `1 0 0 -1 ${n3(x)} ${n3(y)} Tm ${enc.ops}\n`;
      }
      ops += "ET";
      this.appendContent(index, ops, fonts);
    }
  }

  /** Localiza e marca automaticamente dados sensíveis (CPF, CNPJ, e-mail, telefone, CEP, RG, cartão ou termo/regex) para redação. */
  redactByPatterns(req: SmartRedactRequest): SmartRedactResult {
    const total = this.d().countPages();
    const targetPages = req.pages?.length ? req.pages : Array.from({ length: total }, (_, i) => i);
    const byPage: { page: number; matches: { rect: Rect; label: string }[] }[] = [];
    const byLabel: Record<string, number> = {};
    let marked = 0;

    for (const pi of targetPages) {
      if (pi < 0 || pi >= total) continue;
      const found = findPatternMatches(this.pageText(pi), req);
      if (!found.length) continue;
      byPage.push({ page: pi, matches: found });
      for (const m of found) {
        marked++;
        byLabel[m.label] = (byLabel[m.label] ?? 0) + 1;
      }
    }

    if (marked > 0) {
      const tpl = req.overlayText?.trim() ?? "";
      this.op("Marcar redação inteligente", () => {
        for (const entry of byPage) {
          const page = this.d().loadPage(entry.page);
          for (const m of entry.matches) {
            const a = page.createAnnotation("Redact");
            a.setRect(m.rect);
            if (tpl) a.setContents(tpl.replaceAll("{tipo}", m.label));
            a.update();
          }
          page.destroy();
        }
      });
    }
    return { marked, pages: byPage.length, byLabel, info: this.info() };
  }

  addAnnotation(index: number, spec: NewAnnot, author = ""): DocInfo {
    this.op(`Anotar (${spec.kind})`, () => {
      const page = this.d().loadPage(index);
      const a = page.createAnnotation(spec.kind);
      if (author && a.hasAuthor()) a.setAuthor(author);
      switch (spec.kind) {
        case "Highlight": case "Underline": case "StrikeOut": case "Squiggly":
          a.setQuadPoints(spec.quads);
          a.setColor(spec.color ?? (spec.kind === "Highlight" ? [1, 0.9, 0] : [0.85, 0, 0]));
          break;
        case "Text":
          a.setRect([spec.at[0], spec.at[1], spec.at[0] + 20, spec.at[1] + 20]);
          a.setContents(spec.contents);
          a.setColor(spec.color ?? [1, 0.85, 0.2]);
          break;
        case "FreeText":
          a.setRect(spec.rect);
          a.setContents(spec.contents);
          a.setDefaultAppearance("Helv", spec.size ?? 12, spec.color ?? [0, 0, 0]);
          break;
        case "Ink":
          a.setInkList(spec.strokes);
          a.setColor(spec.color ?? [0, 0.3, 0.8]);
          a.setBorderWidth(spec.width ?? 2);
          break;
        case "Square": case "Circle":
          a.setRect(spec.rect);
          a.setColor(spec.color ?? [0.85, 0, 0]);
          a.setBorderWidth(spec.width ?? 2);
          break;
        case "Line":
          a.setLine(spec.from, spec.to);
          a.setColor(spec.color ?? [0.85, 0, 0]);
          a.setBorderWidth(spec.width ?? 2);
          if (spec.arrow) a.setLineEndingStyles("None", "ClosedArrow");
          break;
        case "Stamp": {
          a.setRect(spec.rect);
          const doc = this.d();
          const img = new mupdf.Image(spec.png);
          const res = doc.newDictionary();
          const xo = doc.newDictionary();
          xo.put("I", liveImage(doc, img));
          res.put("XObject", xo);
          img.destroy();
          // A aparência é desenhada no espaço da página sem rotação: gira junto com a
          // página para o carimbo ficar em pé na tela e no papel.
          const rotObj = page.getObject().getInheritable("Rotate");
          const rot = rotObj.isNull() ? 0 : ((rotObj.asNumber() % 360) + 360) % 360;
          const c = Math.round(Math.cos((rot * Math.PI) / 180)), s = Math.round(Math.sin((rot * Math.PI) / 180));
          const w = spec.rect[2] - spec.rect[0], h = spec.rect[3] - spec.rect[1];
          a.setAppearance(null, null, [c, s, -s, c, 0, 0], [0, 0, w, h], res, `q ${n3(w)} 0 0 ${n3(h)} 0 0 cm /I Do Q`);
          break;
        }
        case "Redact":
          a.setRect(spec.rect);
          if (spec.overlayText?.trim()) a.setContents(spec.overlayText.trim());
          break;
      }
      a.update();
      page.destroy();
    });
    return this.info();
  }

  deleteAnnotation(index: number, id: number): DocInfo {
    this.op("Excluir anotação", () => {
      const page = this.d().loadPage(index);
      const a = page.getAnnotations().find((x) => x.getObject().asIndirect() === id);
      if (a) page.deleteAnnotation(a);
      page.destroy();
    });
    return this.info();
  }

  setAnnotationContents(index: number, id: number, text: string): DocInfo {
    this.op("Editar comentário", () => {
      const page = this.d().loadPage(index);
      const a = page.getAnnotations().find((x) => x.getObject().asIndirect() === id);
      if (a) { a.setContents(text); a.update(); }
      page.destroy();
    });
    return this.info();
  }

  /** Aplica de verdade as redações pendentes da página (remove o conteúdo coberto). */
  applyRedactions(index: number): DocInfo {
    this.op("Aplicar redação", () => {
      this.applyPageRedactionsInner(index);
    });
    return this.info();
  }

  // ---------- resumo de comentários ----------

  /** Lista todas as anotações com o trecho de texto marcado sob realces/sublinhados/redações. */
  commentsSummary(): CommentSummaryItem[] {
    const doc = this.d();
    const n = doc.countPages();
    const out: CommentSummaryItem[] = [];
    const markupKinds = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly", "Redact"]);
    for (let i = 0; i < n; i++) {
      const anns = this.annotations(i).filter((a) => a.kind !== "Link" && a.kind !== "Widget");
      if (!anns.length) continue;
      const p = doc.loadPage(i);
      const pageLabel = p.getLabel() || String(i + 1);
      p.destroy();
      const blocks = anns.some((a) => markupKinds.has(a.kind)) ? this.pageText(i) : null;
      for (const a of anns) {
        const quote = blocks && markupKinds.has(a.kind) ? extractTextInRect(blocks, a.rect) : "";
        out.push({
          page: i,
          pageLabel,
          kind: a.kind,
          author: a.author,
          contents: a.contents,
          quote,
          color: a.color,
        });
      }
    }
    return out;
  }

  /** Exporta o resumo de comentários em Markdown, CSV ou PDF A4. */
  exportCommentsSummary(format: "md" | "csv" | "pdf"): Uint8Array {
    const items = this.commentsSummary();
    const title = this.d().getMetaData("info:Title") || this.title;
    if (format === "pdf") return buildCommentsSummaryPdf(items, title);
    const text = format === "csv" ? formatCommentsCsv(items) : formatCommentsMarkdown(items, title);
    return new TextEncoder().encode(text);
  }

  // ---------- anexos embutidos ----------

  attachments(): AttachmentInfo[] {
    const doc = this.d();
    let files: Record<string, mupdf.PDFObject>;
    try { files = doc.getEmbeddedFiles(); } catch { return []; }
    const out: AttachmentInfo[] = [];
    for (const [key, ref] of Object.entries(files)) {
      let filename = key;
      let mimetype = "application/octet-stream";
      let size = 0;
      try {
        const params = doc.getFilespecParams(ref);
        if (params.filename) filename = params.filename;
        if (params.mimetype) mimetype = params.mimetype;
      } catch { /* fallback abaixo */ }
      try {
        const buf = doc.getEmbeddedFileContents(ref);
        if (buf) { size = buf.getLength(); buf.destroy(); }
      } catch { /* tamanho desconhecido */ }
      out.push({ key, filename, mimetype, size });
    }
    return out.sort((a, b) => a.filename.localeCompare(b.filename, "pt-BR"));
  }

  getAttachmentData(key: string): Uint8Array {
    const doc = this.d();
    const files = doc.getEmbeddedFiles();
    const ref = files[key];
    if (!ref) throw new Error(`Anexo não encontrado: ${key}`);
    const buf = doc.getEmbeddedFileContents(ref);
    if (!buf) throw new Error(`Não foi possível ler o anexo: ${key}`);
    const bytes = new Uint8Array(buf.asUint8Array());
    buf.destroy();
    return bytes;
  }

  addAttachment(filename: string, bytes: Uint8Array, mimetype = "application/octet-stream"): DocInfo {
    const cleanName = filename.trim() || "anexo.bin";
    this.op("Anexar arquivo", () => {
      const doc = this.d();
      const efDict = doc.newDictionary();
      efDict.put("Type", doc.newName("EmbeddedFile"));
      efDict.put("Subtype", doc.newName(mimetype));
      const params = doc.newDictionary();
      params.put("Size", bytes.length);
      efDict.put("Params", params);
      const efRef = doc.addStream(bytes, efDict);

      const ef = doc.newDictionary();
      ef.put("F", efRef);
      ef.put("UF", efRef);
      const fs = doc.newDictionary();
      fs.put("Type", doc.newName("Filespec"));
      fs.put("F", doc.newString(cleanName));
      fs.put("UF", pdfUnicodeString(doc, cleanName));
      fs.put("EF", ef);
      const fsRef = doc.addObject(fs);
      doc.insertEmbeddedFile(cleanName, fsRef);
    });
    return this.info();
  }

  deleteAttachment(key: string): DocInfo {
    this.op("Remover anexo", () => {
      this.d().deleteEmbeddedFile(key);
    });
    return this.info();
  }

  // ---------- camadas (OCG) ----------

  layers(): LayerInfo[] {
    const doc = this.d();
    let n = 0;
    try { n = doc.countLayers(); } catch { return []; }
    const out: LayerInfo[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        index: i,
        name: doc.getLayerName(i) || `Camada ${i + 1}`,
        visible: doc.isLayerVisible(i),
      });
    }
    return out;
  }

  setLayerVisibility(index: number, visible: boolean): LayerInfo[] {
    const doc = this.d();
    const n = doc.countLayers();
    if (index >= 0 && index < n) doc.setLayerVisible(index, visible);
    return this.layers();
  }

  // ---------- links e marcadores automáticos ----------

  links(index: number): LinkInfo[] {
    const doc = this.d();
    const n = doc.countPages();
    const page = doc.loadPage(index);
    const out: LinkInfo[] = [];
    try {
      const list = page.getLinks();
      list.forEach((l, i) => {
        const uri = l.getURI() || "";
        const isExternal = /^(https?:|mailto:)/i.test(uri);
        let targetPage = -1;
        if (!isExternal && uri) {
          try {
            const p = doc.resolveLink(uri);
            if (typeof p === "number" && p >= 0 && p < n) targetPage = p;
          } catch { /* destino interno inválido */ }
        }
        out.push({ index: i, rect: l.getBounds() as Rect, uri, isExternal, targetPage });
      });
    } finally {
      page.destroy();
    }
    return out;
  }

  addLink(index: number, rect: Rect, target: { page: number } | { uri: string }): DocInfo {
    const doc = this.d();
    const n = doc.countPages();
    let uri: string;
    if ("uri" in target) {
      const u = target.uri.trim();
      if (!/^(https?:\/\/|mailto:)/i.test(u)) throw new Error("Informe um endereço começando com https://, http:// ou mailto:.");
      uri = u;
    } else {
      const p = Math.max(0, Math.min(n - 1, Math.floor(target.page)));
      try { uri = doc.formatLinkURI(new mupdf.LinkDestination(0, p, "Fit")); }
      catch { uri = `#page=${p + 1}`; }
    }
    this.op("Inserir link", () => {
      const page = doc.loadPage(index);
      page.createLink(rect, uri);
      page.destroy();
    });
    return this.info();
  }

  deleteLink(index: number, linkIndex: number): DocInfo {
    this.op("Excluir link", () => {
      const page = this.d().loadPage(index);
      const list = page.getLinks();
      if (linkIndex >= 0 && linkIndex < list.length) page.deleteLink(list[linkIndex]);
      page.destroy();
    });
    return this.info();
  }

  /** Gera a árvore de marcadores automaticamente a partir dos títulos detectados no texto. */
  autoOutline(): { count: number; info: DocInfo } {
    const n = this.d().countPages();
    const pages: TextBlock[][] = [];
    for (let i = 0; i < n; i++) pages.push(this.pageText(i));
    const nodes = detectHeadingOutline(pages);
    const countNodes = (list: OutlineNode[]): number => list.reduce((s, x) => s + 1 + countNodes(x.children), 0);
    const count = countNodes(nodes);
    if (count > 0) this.setOutline(nodes);
    return { count, info: this.info() };
  }

  // ---------- numeração Bates e rótulos de página ----------

  /**
   * Numeração Bates sequencial (ex.: PROC-000001). Devolve o próximo número livre
   * para encadear automaticamente vários arquivos em lote.
   */
  addBatesNumbering(spec: BatesSpec): { nextNumber: number; info: DocInfo } {
    const total = this.d().countPages();
    const pages = spec.pages?.length ? spec.pages : Array.from({ length: total }, (_, i) => i);
    const prefix = spec.prefix ?? "";
    const suffix = spec.suffix ?? "";
    const digits = Math.max(1, Math.min(12, Math.floor(spec.digits ?? 6)));
    const pos = spec.pos ?? "br";
    const size = spec.size ?? 10;
    const margin = spec.margin ?? 24;
    const color = spec.color ?? [0.15, 0.15, 0.15];
    let num = Math.max(0, Math.floor(spec.startNumber));

    this.op("Numeração Bates", () => {
      for (const index of pages) {
        if (index < 0 || index >= total) continue;
        const text = `${prefix}${String(num++).padStart(digits, "0")}${suffix}`;
        const page = this.d().loadPage(index);
        const [x0, y0, x1, y1] = page.getBounds();
        page.destroy();
        const fonts: Record<string, mupdf.PDFObject> = {};
        const enc = this.encodeLineOps(text, "Helvetica", size, fonts);
        const x = pos[1] === "l" ? x0 + margin : pos[1] === "r" ? x1 - margin - enc.width : (x0 + x1 - enc.width) / 2;
        const y = pos[0] === "t" ? y0 + margin + size * 0.75 : y1 - margin;
        const ops = `BT\n${rg(color)}\n1 0 0 -1 ${n3(x)} ${n3(y)} Tm ${enc.ops}\nET`;
        this.appendContent(index, ops, fonts);
      }
    });
    return { nextNumber: num, info: this.info() };
  }

  /** Define intervalos de rótulos de página (/PageLabels), ex.: algarismos romanos na capa/sumário e arábicos no corpo. */
  setPageLabelRules(rules: PageLabelRule[]): DocInfo {
    const total = this.d().countPages();
    const sorted = [...rules]
      .filter((r) => Number.isInteger(r.startPage) && r.startPage >= 0 && r.startPage < total)
      .sort((a, b) => a.startPage - b.startPage);
    this.op("Rótulos de página", () => {
      const doc = this.d();
      const root = doc.getTrailer().get("Root").resolve();
      if (root.isDictionary()) root.delete("PageLabels");
      for (const r of sorted) {
        const style = r.style === "none" ? mupdf.PDFDocument.PAGE_LABEL_NONE : r.style;
        doc.setPageLabels(r.startPage, style, r.prefix ?? "", Math.max(1, Math.floor(r.startAt ?? 1)));
      }
    });
    return this.info();
  }

  clearPageLabels(): DocInfo {
    this.op("Limpar rótulos de página", () => {
      const root = this.d().getTrailer().get("Root").resolve();
      if (root.isDictionary()) root.delete("PageLabels");
    });
    return this.info();
  }

  // ---------- formulários ----------

  fields(index: number): FieldInfo[] {
    const page = this.d().loadPage(index);
    const out = page.getWidgets().map((w) => ({
      id: w.getObject().asIndirect(),
      type: w.getFieldType(),
      name: w.getName(),
      value: w.getValue(),
      options: w.isChoice() ? w.getOptions() : [],
      rect: w.getRect() as Rect,
      readOnly: w.isReadOnly(),
      multiline: w.isText() && w.isMultiline(),
    }));
    page.destroy();
    return out;
  }

  setField(index: number, id: number, value: string | boolean): DocInfo {
    this.op("Preencher campo", () => {
      const page = this.d().loadPage(index);
      const w = page.getWidgets().find((x) => x.getObject().asIndirect() === id);
      if (w) {
        if (w.isText()) w.setTextValue(String(value));
        else if (w.isChoice()) w.setChoiceValue(String(value));
        else if (w.isCheckbox() || w.isRadioButton()) {
          const on = w.getValue() !== "Off" && w.getValue() !== "";
          if (on !== Boolean(value)) w.toggle();
        }
        w.update();
      }
      page.destroy();
    });
    return this.info();
  }

  /** Cria um campo de formulário interativo (texto, caixa de seleção, lista ou assinatura). */
  createField(spec: CreateFieldSpec): { id: number; info: DocInfo } {
    let id = 0;
    this.op("Criar campo de formulário", () => {
      id = addFormField(this.d(), spec);
    });
    return { id, info: this.info() };
  }

  /** Remove um campo de formulário da página e do AcroForm. */
  deleteField(pageIndex: number, id: number): DocInfo {
    this.op("Remover campo de formulário", () => {
      removeFormField(this.d(), pageIndex, id);
    });
    return this.info();
  }

  /** Detecta e cria automaticamente campos de formulário (linhas, caixas [ ] e rótulos com :) na página. */
  autoDetectFields(pageIndex: number): { created: number; info: DocInfo } {
    const page = this.d().loadPage(pageIndex);
    const bounds = page.getBounds() as Rect;
    page.destroy();
    const existing = this.fields(pageIndex).map((f) => f.rect);
    const blocks = this.pageText(pageIndex);
    const specs = detectCandidateFields(pageIndex, bounds, blocks, existing);
    if (specs.length) {
      this.op("Detectar campos de formulário", () => {
        for (const s of specs) addFormField(this.d(), s);
      });
    }
    return { created: specs.length, info: this.info() };
  }

  // ---------- assinatura digital criptográfica (ICP-Brasil A1 .pfx/.p12) ----------

  inspectPfx(pfxBytes: Uint8Array, password: string): PfxCertInfo {
    return inspectPfx(pfxBytes, password);
  }

  /** Gera uma cópia assinada digitalmente com certificado A1 (.pfx/.p12) no padrão adbe.pkcs7.detached. */
  signDigital(opts: DigitalSignOptions): { bytes: Uint8Array; cert: PfxCertInfo } {
    const current = this.peekBytes();
    return signPdfBytes(current, opts, this.password);
  }

  /** Verifica offline todas as assinaturas digitais PKCS#7/CMS presentes nos bytes informados (ou no documento aberto). */
  verifySignatures(rawBytes?: Uint8Array): SignatureVerifyInfo[] {
    const bytes = rawBytes ?? this.baselineBytes ?? this.peekBytes();
    return verifyPdfSignatures(bytes, this.password);
  }

  // ---------- organizar páginas ----------

  rotatePages(indices: number[], degrees: number): DocInfo {
    this.op("Girar páginas", () => {
      for (const i of indices) {
        const obj = this.d().findPage(i);
        const cur = obj.getInheritable("Rotate");
        const val = cur.isNull() ? 0 : cur.asNumber();
        obj.put("Rotate", (((val + degrees) % 360) + 360) % 360);
      }
    });
    return this.info();
  }

  /** Rotação atual da página (0, 90, 180 ou 270 graus). */
  pageRotation(index: number): number {
    const r = this.d().findPage(index).getInheritable("Rotate");
    return r.isNull() ? 0 : ((r.asNumber() % 360) + 360) % 360;
  }

  deletePages(indices: number[]): DocInfo {
    const n = this.d().countPages();
    if (new Set(indices).size >= n) throw new Error("Não é possível excluir todas as páginas.");
    this.op("Excluir páginas", () => {
      for (const i of [...new Set(indices)].sort((a, b) => b - a)) this.d().deletePage(i);
    });
    return this.info();
  }

  /** Nova ordem: lista de índices antigos (pode repetir para duplicar). */
  reorderPages(order: number[]): DocInfo {
    this.op("Reorganizar páginas", () => this.d().rearrangePages(order));
    return this.info();
  }

  insertBlankPage(at: number, size: [number, number] = [595, 842]): DocInfo {
    this.op("Inserir página em branco", () => {
      const obj = this.d().addPage([0, 0, size[0], size[1]], 0, {}, "");
      this.d().insertPage(at, obj);
    });
    return this.info();
  }

  /** Insere todas as páginas de outro PDF a partir da posição `at` (-1 = fim). */
  insertFromPdf(bytes: Uint8Array, at: number): DocInfo {
    let src: mupdf.PDFDocument | null = null;
    try { src = mupdf.Document.openDocument(bytes, "application/pdf").asPDF(); } catch { /* tratado abaixo */ }
    if (!src) throw new Error("O arquivo inserido não é um PDF válido.");
    if (src.needsPassword()) { src.destroy(); throw new Error("O arquivo inserido é protegido por senha. Abra-o e remova a proteção antes."); }
    const from = src;
    try {
      this.op("Inserir páginas de arquivo", () => {
        const map = this.d().newGraftMap();
        const n = from.countPages();
        const base = at < 0 ? this.d().countPages() : at;
        for (let i = 0; i < n; i++) map.graftPage(base + i, from, i);
      });
    } finally { from.destroy(); }
    return this.info();
  }

  /** Cria um PDF novo só com as páginas indicadas. */
  extractPages(indices: number[]): Uint8Array {
    const out = new mupdf.PDFDocument();
    const map = out.newGraftMap();
    for (const i of indices) map.graftPage(-1, this.d(), i);
    const buf = out.saveToBuffer(SAVE_OPTIONS);
    const bytes = new Uint8Array(buf.asUint8Array());
    buf.destroy(); out.destroy();
    return bytes;
  }

  /** Divide em partes de `every` páginas. */
  split(every: number): Uint8Array[] {
    const n = this.d().countPages();
    const parts: Uint8Array[] = [];
    for (let s = 0; s < n; s += every) {
      parts.push(this.extractPages(Array.from({ length: Math.min(every, n - s) }, (_, k) => s + k)));
    }
    return parts;
  }

  // ---------- editar texto ----------

  /**
   * Substitui o texto de uma área (ou insere texto novo quando `erase === false`):
   * remove só os glifos de texto da área (imagens e vetores ficam) e escreve o texto novo.
   * Cada letra sai, nesta ordem de preferência:
   * 1. na própria fonte embutida no PDF, quando ela tem o glifo confirmado (o trecho continua igual ao resto);
   * 2. na mesma fonte instalada no Windows, embutida no PDF (só quando faltou alguma letra);
   * 3. numa das 14 fontes padrão do PDF (WinAnsi), parecida com a original;
   * 4. numa fonte Unicode genérica do Windows (Segoe UI / Segoe UI Symbol / Cambria Math) para símbolos fora de WinAnsi.
   */
  editText(req: EditTextRequest): EditTextResult {
    const used = { original: null as string | null, system: null as string | null, fallback: false, substituted: 0 };
    this.op(req.erase === false ? "Inserir texto" : "Editar texto", () => {
      this.applyTextEdit(req, used);
    });
    return { info: this.info(), fonts: used };
  }

  /** Implementação interna de edição/inserção de texto (pode ser chamada em lote dentro de uma única `this.op`). */
  private applyTextEdit(
    req: EditTextRequest,
    used: { original: string | null; system: string | null; fallback: boolean; substituted: number },
  ): void {
    const page = this.d().loadPage(req.page);
    const text = normalizePdfText(req.text);
    const want = text.replace(/\n/g, "");
    const hasLatin = /[A-Za-zÀ-ÿ0-9]/.test(want);
    const symbolic = isSymbolicFont(req.font) && hasLatin;
    const effFont = symbolic ? "Helvetica" : req.font;

    // A fonte original é escolhida antes da redação, que pode tirar dos recursos da página
    // uma fonte que só esse trecho usava (o objeto continua no documento).
    const seen = this.charsByFont(page).get(req.font) ?? new Set<string>();
    const orig = symbolic || req.erase === false ? null : originalSource(page.getObject(), req.font, want, seen);

    const targets = req.erase !== false
      ? (req.areas?.length ? req.areas.map((a) => pad(a, 0.2)) : [pad(req.area, 0.35)])
      : [];
    const cropScale = 2;
    const cropMargin = 2.5;
    const snapRegion = (p: mupdf.PDFPage, r: Rect) => {
      const [bx0, by0, bx1, by1] = p.getBounds();
      const x0 = Math.max(bx0, r[0] - cropMargin);
      const y0 = Math.max(by0, r[1] - cropMargin);
      const x1 = Math.min(bx1, r[2] + cropMargin);
      const y1 = Math.min(by1, r[3] + cropMargin);
      const w = Math.max(1, Math.min(1200, Math.ceil((x1 - x0) * cropScale)));
      const h = Math.max(1, Math.min(400, Math.ceil((y1 - y0) * cropScale)));
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
      pix.clear(255);
      const m = mupdf.Matrix.concat(mupdf.Matrix.translate(-x0, -y0), mupdf.Matrix.scale(cropScale, cropScale));
      const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
      try {
        p.run(dev, m);
        dev.close();
        return { w, h, rgb: new Uint8Array(pix.getPixels()) };
      } finally {
        pix.destroy();
      }
    };

    const beforeSnaps = targets.map((r) => snapRegion(page, r));

    if (req.erase !== false) {
      // Se foram informados os retângulos linha a linha, redige cada linha separadamente para
      // não apagar texto de colunas ou células vizinhas.
      for (const r of targets) {
        const red = page.createAnnotation("Redact");
        red.setRect(r);
        red.update();
        red.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE,
          mupdf.PDFPage.REDACT_TEXT_REMOVE);
      }
    }
    page.destroy();

    // Em PDFs escaneados / rasterizados com camada OCR invisível (3 Tr), REDACT_TEXT_REMOVE
    // remove o texto invisível mas os pixels originais da imagem ficam intactos por baixo.
    // Detectamos isso comparando antes/depois e cobrimos a linha com a cor local do fundo da página.
    const covers: { rect: Rect; bg: RGB }[] = [];
    let drawColor: RGB = req.color;
    if (targets.length) {
      const pageAfter = this.d().loadPage(req.page);
      try {
        const median = (arr: number[]) => {
          if (!arr.length) return 255;
          arr.sort((a, b) => a - b);
          return arr[arr.length >> 1];
        };
        const padPx = Math.round(cropMargin * cropScale);
        targets.forEach((r, idx) => {
          const bef = beforeSnaps[idx];
          const aft = snapRegion(pageAfter, r);
          if (bef.w !== aft.w || bef.h !== aft.h) return;
          const ix0 = Math.min(bef.w - 1, padPx);
          const iy0 = Math.min(bef.h - 1, padPx);
          const ix1 = Math.max(ix0 + 1, bef.w - padPx);
          const iy1 = Math.max(iy0 + 1, bef.h - padPx);
          let changed = 0;
          for (let y = iy0; y < iy1; y++) {
            for (let x = ix0; x < ix1; x++) {
              const o = (y * bef.w + x) * 3;
              if (Math.abs(bef.rgb[o] - aft.rgb[o]) + Math.abs(bef.rgb[o + 1] - aft.rgb[o + 1]) + Math.abs(bef.rgb[o + 2] - aft.rgb[o + 2]) > 24) {
                changed++;
              }
            }
          }
          if (changed > 0) return; // texto vetorial foi efetivamente apagado: não cobre o fundo

          // Amostra o anel externo (borda de 2 px) para descobrir a cor exata do fundo local
          const rs: number[] = [], gs: number[] = [], bs: number[] = [];
          for (let y = 0; y < aft.h; y++) {
            for (let x = 0; x < aft.w; x++) {
              if (x >= ix0 && x < ix1 && y >= iy0 && y < iy1) continue;
              const o = (y * aft.w + x) * 3;
              rs.push(aft.rgb[o]); gs.push(aft.rgb[o + 1]); bs.push(aft.rgb[o + 2]);
            }
          }
          const bgR = median(rs), bgG = median(gs), bgB = median(bs);
          const bg: RGB = [bgR / 255, bgG / 255, bgB / 255];
          // Folga horizontal um pouco maior (2 pt) para cobrir eventual borda direita de caixas OCR
          covers.push({ rect: [r[0] - 1.5, r[1] - 0.9, r[2] + 2.2, r[3] + 0.9], bg });

          // Se o texto OCR veio com cor padrão preta sobre um fundo escuro (ex.: cabeçalho roxo da Vivo),
          // usa a cor de maior contraste dentro da área (tipicamente branco).
          const bgLum = (0.299 * bgR + 0.587 * bgG + 0.114 * bgB) / 255;
          if (idx === 0 && bgLum < 0.45 && req.color[0] === 0 && req.color[1] === 0 && req.color[2] === 0) {
            let bestDist = 0, bestRgb: RGB = [1, 1, 1];
            for (let y = iy0; y < iy1; y++) {
              for (let x = ix0; x < ix1; x++) {
                const o = (y * aft.w + x) * 3;
                const d = Math.abs(aft.rgb[o] - bgR) + Math.abs(aft.rgb[o + 1] - bgG) + Math.abs(aft.rgb[o + 2] - bgB);
                if (d > bestDist) {
                  bestDist = d;
                  bestRgb = [aft.rgb[o] / 255, aft.rgb[o + 1] / 255, aft.rgb[o + 2] / 255];
                }
              }
            }
            if (bestDist > 120) drawColor = bestRgb;
            else drawColor = [1, 1, 1];
          }
        });
      } finally {
        pageAfter.destroy();
      }
    }

    const b14 = this.base14Source(base14For(effFont));
    const sources: GlyphSource[] = orig ? [orig] : [];
    const missing = [...new Set(want)].filter((ch) => !orig?.glyph(ch));
    // Arial, Times e Courier têm equivalentes entre as fontes padrão: não vale embutir a do Windows por elas
    const standard = ["Arial", "Times New Roman", "Courier New"].includes(fontStyle(effFont).family);
    if (missing.length && !(standard && missing.every((ch) => b14.glyph(ch)))) {
      const sys = this.systemSource(effFont);
      if (sys && missing.some((ch) => sys.glyph(ch))) sources.push(sys);
    }
    sources.push(b14);
    // Para caracteres ainda ausentes (símbolos Unicode fora de WinAnsi como ✓, →, ≤, ▪, Ω),
    // recorre a fontes Unicode amplas do Windows em vez de substituir por "?".
    this.appendUnicodeFallbacks(sources, want, effFont);

    const pick = (ch: string) => {
      for (const s of sources) { const g = s.glyph(ch); if (g) return { s, g, sub: false }; }
      return { s: b14, g: b14.glyph("?")!, sub: true };
    };
    const measure = (t: string) => ([...t].reduce((w, ch) => w + pick(ch).g.w, 0) / 1000) * req.size;
    const lines = wrapMeasured(text, measure, req.maxWidth);
    const lh = req.lineHeight ?? req.size * 1.2;
    const boxW = req.maxWidth ?? Math.max(0, req.area[2] - req.area[0]);
    const align = req.align ?? "left";
    const fonts: Record<string, mupdf.PDFObject> = {};
    let ops = "";
    for (const c of covers) {
      const [x0, y0, x1, y1] = c.rect;
      ops += `${rg(c.bg)}\n${n3(x0)} ${n3(y0)} ${n3(x1 - x0)} ${n3(y1 - y0)} re f\n`;
    }
    const hasText = lines.some((ln) => ln.trim().length > 0);
    if (hasText) {
      ops += `BT\n${rg(drawColor)}\n`;
      lines.forEach((ln, k) => {
        const lw = measure(ln);
        const dx = align === "center" && boxW > lw ? (boxW - lw) / 2
          : align === "right" && boxW > lw ? boxW - lw : 0;
        ops += `1 0 0 -1 ${n3(req.origin[0] + dx)} ${n3(req.origin[1] + k * lh)} Tm\n`;
        let cur: GlyphSource | null = null, hex = "";
        const flush = () => { if (cur && hex) ops += `/${cur.key} ${n3(req.size)} Tf <${hex}> Tj\n`; hex = ""; };
        for (const ch of ln) {
          const { s, g, sub } = pick(ch);
          if (s !== cur) { flush(); cur = s; }
          hex += g.code.toString(16).padStart(s.twoByte ? 4 : 2, "0");
          fonts[s.key] = s.ref;
          if (!ch.trim()) continue;
          if (sub) { used.substituted++; used.fallback = true; }
          else if (s.kind === "original") used.original = s.label;
          else if (s.kind === "system") used.system ??= s.label;
          else used.fallback = true;
        }
        flush();
      });
      ops += "ET";
    }
    if (ops) this.appendContent(req.page, ops, fonts);
  }

  /**
   * Localizar e substituir texto no documento inteiro (ou numa única página), em um único "Desfazer".
   * Preserva fonte, tamanho, cor e posição originais usando o mesmo motor Unicode de `editText`.
   */
  replaceText(
    needle: string,
    replacement: string,
    opts: { page?: number; matchCase?: boolean } = {},
  ): { count: number; pages: number; info: DocInfo } {
    if (!needle) return { count: 0, pages: 0, info: this.info() };
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(esc, opts.matchCase ? "g" : "gi");
    const n = this.d().countPages();
    const targetPages = opts.page !== undefined ? [opts.page] : Array.from({ length: n }, (_, i) => i);
    const edits: EditTextRequest[] = [];
    let count = 0;
    const touchedPages = new Set<number>();

    for (const pi of targetPages) {
      if (pi < 0 || pi >= n) continue;
      for (const b of this.pageText(pi)) {
        for (const l of b.lines) {
          const norm = normalizePdfText(l.text);
          const matches = norm.match(re);
          if (!matches?.length) continue;
          const next = norm.replace(re, () => replacement);
          if (next === norm) continue;
          count += matches.length;
          touchedPages.add(pi);
          edits.push({
            page: pi,
            area: l.bbox,
            areas: [l.bbox],
            text: next,
            origin: l.origin,
            size: l.size,
            color: l.color,
            font: l.font,
          });
        }
      }
    }

    if (edits.length) {
      const used = { original: null as string | null, system: null as string | null, fallback: false, substituted: 0 };
      this.op("Substituir texto", () => {
        for (const req of edits) this.applyTextEdit(req, used);
      });
    }
    return { count, pages: touchedPages.size, info: this.info() };
  }

  /** Cola uma imagem (logotipo, foto, selo) diretamente sobre o conteúdo de uma página. */
  addImageToPage(index: number, rect: Rect, imageBytes: Uint8Array): DocInfo {
    this.op("Inserir imagem na página", () => {
      const doc = this.d();
      const img = new mupdf.Image(imageBytes);
      let ref: mupdf.PDFObject;
      try { ref = liveImage(doc, img); } finally { img.destroy(); }
      const key = `PapiroIm${ref.asIndirect()}`;
      const [x0, y0, x1, y1] = rect;
      const w = Math.max(4, x1 - x0), h = Math.max(4, y1 - y0);
      // No espaço de página (y para baixo), a matriz [w 0 0 -h x0 y1] desenha a imagem em pé dentro de rect.
      const ops = `q ${n3(w)} 0 0 ${n3(-h)} ${n3(x0)} ${n3(y1)} cm /${key} Do Q`;
      this.appendContent(index, ops, {}, {}, false, { [key]: ref });
    });
    return this.info();
  }

  /** Recorta as margens visuais das páginas indicadas (em pontos; 1 mm ≈ 2,835 pt). Pode ser desfeito. */
  cropPages(indices: number[], margins: CropMargins): DocInfo {
    const top = Math.max(0, margins.top), right = Math.max(0, margins.right);
    const bottom = Math.max(0, margins.bottom), left = Math.max(0, margins.left);
    if (!top && !right && !bottom && !left) return this.info();
    this.op("Recortar páginas", () => {
      for (const i of indices) {
        const page = this.d().loadPage(i);
        const obj = page.getObject();
        const boxObj = obj.getInheritable("CropBox").isArray() ? obj.getInheritable("CropBox") : obj.getInheritable("MediaBox");
        const box: Rect = [
          boxObj.get(0).asNumber(), boxObj.get(1).asNumber(),
          boxObj.get(2).asNumber(), boxObj.get(3).asNumber(),
        ];
        const rotObj = obj.getInheritable("Rotate");
        const rot = rotObj.isNull() ? 0 : ((rotObj.asNumber() % 360) + 360) % 360;
        // Converte margens visuais (topo/direita/base/esquerda) para o espaço sem rotação do PDF (y para cima)
        const [mL, mB, mR, mT] = rot === 90
          ? [top, left, bottom, right]
          : rot === 180
            ? [right, top, left, bottom]
            : rot === 270
              ? [bottom, right, top, left]
              : [left, bottom, right, top];
        const x0 = box[0] + mL, y0 = box[1] + mB, x1 = box[2] - mR, y1 = box[3] - mT;
        if (x1 - x0 < 36 || y1 - y0 < 36) { page.destroy(); throw new Error("O recorte é grande demais para o tamanho da página."); }
        page.setPageBox("CropBox", [x0, y0, x1, y1]);
        page.destroy();
      }
    });
    return this.info();
  }

  /** Padroniza o tamanho das páginas para A4 ou Carta (mantendo retrato/paisagem e centralizando o conteúdo). */
  normalizePageSizes(indices: number[], target: "A4" | "Carta"): DocInfo {
    const [shortSide, longSide] = target === "Carta" ? [612, 792] : [595, 842];
    this.op(`Padronizar páginas (${target})`, () => {
      const doc = this.d();
      for (const i of indices) {
        const pageObj = doc.findPage(i);
        const boxObj = pageObj.getInheritable("CropBox").isArray() ? pageObj.getInheritable("CropBox") : pageObj.getInheritable("MediaBox");
        const x0 = boxObj.get(0).asNumber(), y0 = boxObj.get(1).asNumber();
        const x1 = boxObj.get(2).asNumber(), y1 = boxObj.get(3).asNumber();
        const w = x1 - x0, h = y1 - y0;
        if (!(w > 0 && h > 0)) continue;
        const [tw, th] = w > h ? [longSide, shortSide] : [shortSide, longSide];
        if (Math.abs(w - tw) < 1 && Math.abs(h - th) < 1 && Math.abs(x0) < 1 && Math.abs(y0) < 1) continue;
        const s = Math.min(tw / w, th / h);
        const tx = (tw - w * s) / 2 - x0 * s;
        const ty = (th - h * s) / 2 - y0 * s;
        const old = pageObj.get("Contents");
        const oldParts: mupdf.PDFObject[] = [];
        if (old.isArray()) old.forEach((v) => oldParts.push(v));
        else if (!old.isNull()) oldParts.push(old);
        let open = 0;
        try { open = openStates(oldParts.map((v) => (v.isStream() ? v.readStream().asString() : "")).join("\n")); } catch { /* assume equilibrado */ }
        const arr = doc.newArray();
        arr.push(doc.addStream(`q ${n3(s)} 0 0 ${n3(s)} ${n3(tx)} ${n3(ty)} cm\n`, {}));
        for (const v of oldParts) arr.push(v);
        arr.push(doc.addStream(`\n${"Q\n".repeat(open + 1)}`, {}));
        pageObj.put("Contents", arr);
        const nb = doc.newArray();
        nb.push(0); nb.push(0); nb.push(tw); nb.push(th);
        pageObj.put("MediaBox", nb);
        pageObj.put("CropBox", nb);
      }
    });
    return this.info();
  }

  /** Achata todas as anotações, assinaturas, carimbos e campos preenchidos diretamente no conteúdo das páginas. */
  flatten(): { count: number; info: DocInfo } {
    const doc = this.d();
    const n = doc.countPages();
    let count = 0;
    for (let i = 0; i < n; i++) {
      const p = doc.loadPage(i);
      count += p.getAnnotations().filter((a) => a.getType() !== "Link").length;
      p.destroy();
    }
    if (count > 0) {
      this.op("Achatar PDF", () => {
        this.d().bake(true, true);
      });
    }
    return { count, info: this.info() };
  }

  /** Remove metadados ocultos (Info: Autor, Criador, Produtor, datas e fluxos XMP /Metadata). */
  sanitizeMetadata(): { removed: number; info: DocInfo } {
    let removed = 0;
    const keys = ["Author", "Creator", "Producer", "Subject", "Keywords", "CreationDate", "ModDate", "Title", "Trapped"];
    this.op("Limpar metadados", () => {
      const doc = this.d();
      const trailer = doc.getTrailer();
      const infoObj = trailer.get("Info");
      if (!infoObj.isNull()) {
        const resolved = infoObj.isIndirect() ? infoObj.resolve() : infoObj;
        if (resolved.isDictionary()) {
          for (const k of keys) {
            if (!resolved.get(k).isNull()) { resolved.delete(k); removed++; }
          }
        }
        trailer.delete("Info");
      }
      const root = trailer.get("Root").resolve();
      if (root.isDictionary() && !root.get("Metadata").isNull()) {
        root.delete("Metadata");
        removed++;
      }
      const n = doc.countPages();
      for (let i = 0; i < n; i++) {
        const p = doc.findPage(i);
        if (!p.get("Metadata").isNull()) { p.delete("Metadata"); removed++; }
      }
    });
    return { removed, info: this.info() };
  }

  /** Grava a árvore de marcadores (Sumário / Outlines) no documento. Pode ser desfeito. */
  setOutline(nodes: OutlineNode[]): DocInfo {
    this.op("Editar marcadores", () => {
      const doc = this.d();
      const root = doc.getTrailer().get("Root").resolve();
      if (!nodes.length) {
        root.delete("Outlines");
        return;
      }
      const pageCount = doc.countPages();
      const outRootDict = doc.newDictionary();
      outRootDict.put("Type", doc.newName("Outlines"));
      const outRootRef = doc.addObject(outRootDict);

      const buildLevel = (items: OutlineNode[], parentRef: mupdf.PDFObject): { first: mupdf.PDFObject; last: mupdf.PDFObject; count: number } | null => {
        if (!items.length) return null;
        const refs: mupdf.PDFObject[] = [];
        const dicts: mupdf.PDFObject[] = [];
        let total = 0;
        for (const item of items) {
          const d = doc.newDictionary();
          d.put("Title", pdfUnicodeString(doc, item.title || "(sem título)"));
          d.put("Parent", parentRef);
          const pIdx = Math.max(0, Math.min(pageCount - 1, item.page));
          if (item.page >= 0 && pageCount > 0) {
            const dest = doc.newArray();
            dest.push(doc.findPage(pIdx));
            dest.push(doc.newName("Fit"));
            d.put("Dest", dest);
          }
          const ref = doc.addObject(d);
          refs.push(ref);
          dicts.push(d);
          total++;
          if (item.children?.length) {
            const sub = buildLevel(item.children, ref);
            if (sub) {
              d.put("First", sub.first);
              d.put("Last", sub.last);
              d.put("Count", sub.count);
              total += sub.count;
            }
          }
        }
        for (let i = 0; i < refs.length; i++) {
          if (i > 0) dicts[i].put("Prev", refs[i - 1]);
          if (i + 1 < refs.length) dicts[i].put("Next", refs[i + 1]);
        }
        return { first: refs[0], last: refs[refs.length - 1], count: total };
      };

      const top = buildLevel(nodes, outRootRef);
      if (top) {
        outRootDict.put("First", top.first);
        outRootDict.put("Last", top.last);
        outRootDict.put("Count", top.count);
        root.put("Outlines", outRootRef);
      } else {
        root.delete("Outlines");
      }
    });
    return this.info();
  }

  /** Extrai tabelas/dados tabulares de todas as páginas em CSV (separador `;`, compatível com Excel). */
  exportCsv(): string {
    const n = this.d().countPages();
    const pages: TextBlock[][] = [];
    for (let i = 0; i < n; i++) pages.push(this.pageText(i));
    return buildCsv(pages);
  }

  /** Compara o documento aberto com outro PDF (texto linha a linha + mapa visual de diferenças). */
  comparePdf(otherBytes: Uint8Array, otherName = "Outro PDF"): CompareReport {
    let other: mupdf.PDFDocument | null = null;
    try { other = mupdf.Document.openDocument(otherBytes, "application/pdf").asPDF(); } catch { /* tratado abaixo */ }
    if (!other) throw new Error("O arquivo escolhido para comparação não é um PDF válido.");
    if (other.needsPassword()) { other.destroy(); throw new Error("O arquivo escolhido para comparação é protegido por senha."); }
    try {
      return compareDocuments(this.d(), other, this.title || "Documento atual", otherName);
    } finally {
      other.destroy();
    }
  }

  /** Acrescenta fontes Unicode genéricas do sistema só para os caracteres que nenhuma fonte anterior cobriu. */
  private appendUnicodeFallbacks(sources: GlyphSource[], text: string, refFont: string): void {
    if (!this.fontProvider) return;
    let remaining = [...new Set(text)].filter((ch) => ch.trim() && !sources.some((s) => s.glyph(ch)));
    if (!remaining.length) return;
    const cat = genericFontCategory(refFont);
    const { bold, italic } = fontStyle(refFont);
    const suf = bold && italic ? " Bold Italic" : bold ? " Bold" : italic ? " Italic" : "";
    const candidates = cat === "serif"
      ? [`Cambria${suf}`, `Times New Roman${suf}`, "Segoe UI Symbol", "Cambria Math", "Segoe UI", "Arial"]
      : cat === "mono"
        ? [`Consolas${suf}`, `Courier New${suf}`, "Segoe UI Symbol", "Cambria Math", "Segoe UI", "Arial"]
        : [`Segoe UI${suf}`, `Arial${suf}`, "Segoe UI Symbol", "Cambria Math", "Times New Roman"];
    for (const cand of candidates) {
      if (!remaining.length) break;
      const sys = this.systemSource(cand);
      if (!sys || sources.some((s) => s.key === sys.key)) continue;
      if (!remaining.some((ch) => sys.glyph(ch))) continue;
      sources.push(sys);
      remaining = remaining.filter((ch) => !sys.glyph(ch));
    }
  }

  /**
   * Codifica uma linha de texto com a fonte Base-14 indicada, recorrendo a fontes Unicode do sistema
   * só se houver caracteres fora da WinAnsi (evita "?" em cabeçalhos, rodapés, marcas d'água e OCR).
   */
  private encodeLineOps(
    text: string,
    base: string,
    size: number,
    fonts: Record<string, mupdf.PDFObject>,
  ): { ops: string; width: number } {
    const clean = normalizePdfText(text).replace(/\n/g, " ");
    const b14 = this.base14Source(base);
    const sources: GlyphSource[] = [b14];
    this.appendUnicodeFallbacks(sources, clean, base);
    const pick = (ch: string) => {
      for (const s of sources) { const g = s.glyph(ch); if (g) return { s, g }; }
      return { s: b14, g: b14.glyph("?")! };
    };
    let ops = "", cur: GlyphSource | null = null, hex = "", wUnits = 0;
    const flush = () => { if (cur && hex) ops += `/${cur.key} ${n3(size)} Tf <${hex}> Tj `; hex = ""; };
    for (const ch of clean) {
      const { s, g } = pick(ch);
      if (s !== cur) { flush(); cur = s; }
      hex += g.code.toString(16).padStart(s.twoByte ? 4 : 2, "0");
      wUnits += g.w;
      fonts[s.key] = s.ref;
    }
    flush();
    return { ops: ops.trimEnd(), width: (wUnits / 1000) * size };
  }

  /** Caracteres que a página desenha com cada fonte (pelo nome da fonte). */
  private charsByFont(page: mupdf.PDFPage): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const st = page.toStructuredText("preserve-whitespace");
    st.walk({
      onChar(c, _o, font) {
        const n = font.getName();
        let set = out.get(n);
        if (!set) out.set(n, (set = new Set()));
        set.add(c);
      },
    });
    st.destroy();
    return out;
  }

  /** Uma das 14 fontes padrão do PDF (WinAnsi; não precisa ser embutida). */
  private base14Source(base: string): GlyphSource {
    const font = base14Font(base);
    return {
      kind: "base14", key: this.fontKey(base), ref: this.base14Ref(base), twoByte: false, label: base,
      glyph: (ch) => {
        const b = winAnsiByte(ch);
        return b === null ? null : { code: b, w: font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)!), 0) * 1000 };
      },
    };
  }

  /** A fonte do Windows equivalente à do PDF, embutida no documento (uma vez por fonte). */
  private systemSource(fontName: string): GlyphSource | null {
    if (!this.fontProvider) return null;
    let found: ReturnType<FontProvider>;
    try { found = this.fontProvider(fontName); } catch { found = null; }
    if (!found) return null;
    const id = `${found.file ?? stripSubset(fontName)}#${found.subfont ?? 0}`;
    let e = this.sysFonts.get(id);
    if (!e) {
      let font: mupdf.Font;
      try { font = new mupdf.Font(stripSubset(fontName), found.data, found.subfont ?? 0); } catch { return null; }
      // por um documento temporário: doc.addFont guarda um cache que sobrevive ao desfazer
      const tmp = new mupdf.PDFDocument();
      let ref: mupdf.PDFObject;
      try { ref = this.d().graftObject(tmp.addFont(font)); } finally { tmp.destroy(); }
      e = { font, ref, label: fontStyle(fontName).family };
      this.sysFonts.set(id, e);
    }
    const { font, ref, label } = e;
    return {
      kind: "system", key: `PapiroS${ref.asIndirect()}`, ref, twoByte: true, label,
      glyph: (ch) => {
        const gid = font.encodeCharacter(ch.codePointAt(0)!);
        return gid > 0 ? { code: gid, w: font.advanceGlyph(gid, 0) * 1000 } : null;
      },
    };
  }

  // ---------- converter ----------

  /** Texto de todas as páginas (para "Converter → Texto"). */
  exportText(): string {
    const n = this.d().countPages();
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      if (this.pageHasRecoveredType3(i)) {
        const t = this.pageText(i).map((b) => b.lines.map((l) => l.text.trimEnd()).join("\n")).join("\n\n");
        parts.push(t.trimEnd());
        continue;
      }
      const page = this.d().loadPage(i);
      const st = page.toStructuredText("preserve-whitespace");
      parts.push(st.asText().replace(/[ \t]+\n/g, "\n").trimEnd());
      st.destroy(); page.destroy();
    }
    return parts.join("\n\n").replace(/\r?\n/g, "\r\n") + "\r\n";
  }

  /** Documento do Word (.docx) com o texto, a formatação básica e as imagens de cada página. */
  exportDocx(progress?: (done: number, total: number) => void): Uint8Array {
    const n = this.d().countPages();
    const pages: DocxPage[] = [];
    for (let i = 0; i < n; i++) {
      progress?.(i, n);
      pages.push(this.docxPage(i));
    }
    progress?.(n, n);
    return buildDocx(pages, this.d().getMetaData("info:Title") || this.title);
  }

  private docxPage(index: number): DocxPage {
    const page = this.d().loadPage(index);
    const [px0, py0, px1, py1] = page.getBounds();
    const W = px1 - px0, H = py1 - py0;
    type Ch = { c: string; font: string; bold: boolean; italic: boolean; size: number; color: RGB };
    type Ln = { bbox: Rect; chars: Ch[] };
    type Blk = { bbox: Rect; lines: Ln[] };
    type Img = { bbox: Rect; data: Uint8Array; ext: "png" | "jpeg" };
    const texts: Blk[] = [];
    const images: Img[] = [];
    let block: Blk | null = null;
    let line: Ln | null = null;
    const st = page.toStructuredText("preserve-whitespace,preserve-images");
    st.walk({
      onImageBlock(bbox, _m, image) {
        const r = bbox as Rect;
        if (r[2] - r[0] < 6 || r[3] - r[1] < 6) return;
        const out = imageForDocx(image);
        if (out) images.push({ bbox: r, ...out });
      },
      beginTextBlock(bbox) { block = { bbox: bbox as Rect, lines: [] }; },
      beginLine(bbox) { line = { bbox: bbox as Rect, chars: [] }; },
      onChar: (c, _o, font, size, _q, color) => {
        if (!line) return;
        const rawFname = font.getName();
        const t3 = this.type3ForFont(rawFname);
        let ch = c, fname = rawFname, bold = font.isBold();
        if (t3) {
          const cp0 = c.codePointAt(0) ?? 0;
          const isEmpty = cp0 === 0xfffd || t3.info.emptyCodes.has(cp0)
            || (t3.info.needsRecovery && !t3.info.codeToGlyphName.has(cp0));
          if (isEmpty) {
            if (line.chars.length && line.chars[line.chars.length - 1].c !== " ") {
              line.chars.push({ c: " ", font: "Helvetica", bold: false, italic: false, size, color: toRGB(color as number[]) });
            }
            return;
          }
          ch = t3.rec?.codeToChar.get(cp0) ?? c;
          bold = t3.rec?.boldCodes.has(cp0) ?? false;
          fname = bold ? "Helvetica-Bold" : "Helvetica";
        }
        line.chars.push({ c: ch, font: fname, bold, italic: font.isItalic(), size, color: toRGB(color as number[]) });
      },
      endLine() {
        if (block && line) {
          while (line.chars.length && line.chars[line.chars.length - 1].c === " ") line.chars.pop();
          if (line.chars.some((x) => x.c.trim())) block.lines.push(line);
        }
        line = null;
      },
      endTextBlock() { if (block && block.lines.length) texts.push(block); block = null; },
    });
    st.destroy(); page.destroy();

    const all = [...texts.map((t) => t.bbox), ...images.map((i) => i.bbox)];
    const clamp = (v: number) => Math.min(90, Math.max(18, v));
    const margins = all.length
      ? { left: clamp(Math.min(...all.map((b) => b[0])) - px0), top: clamp(Math.min(...all.map((b) => b[1])) - py0), right: clamp(px1 - Math.max(...all.map((b) => b[2]))), bottom: 36 }
      : { left: 72, top: 72, right: 72, bottom: 72 };
    const contentW = Math.max(72, W - margins.left - margins.right);
    const left = px0 + margins.left;
    const centerX = left + contentW / 2;

    // as imagens entram no fluxo antes do primeiro bloco de texto que começa abaixo delas
    type Item = { kind: "t"; b: Blk } | { kind: "i"; b: Img };
    const flow: Item[] = texts.map((b) => ({ kind: "t" as const, b }));
    for (const img of [...images].sort((a, b) => a.bbox[1] - b.bbox[1])) {
      const at = flow.findIndex((it) => it.b.bbox[1] > img.bbox[1] + 1);
      flow.splice(at < 0 ? flow.length : at, 0, { kind: "i", b: img });
    }

    const items: (DocxPara | DocxImage)[] = [];
    let bottom = py0 + margins.top;
    for (const it of flow) {
      const r = it.b.bbox;
      const spaceBefore = Math.min(144, Math.max(0, r[1] - bottom));
      const indent = Math.max(0, r[0] - left);
      bottom = Math.max(bottom, r[3]);
      if (it.kind === "i") {
        let w = r[2] - r[0], h = r[3] - r[1];
        if (w > contentW) { h *= contentW / w; w = contentW; }
        const maxH = H - margins.top - margins.bottom - 24;
        if (h > maxH) { w *= maxH / h; h = maxH; }
        items.push({ kind: "img", data: it.b.data, ext: it.b.ext, width: w, height: h, indent: Math.max(0, Math.min(indent, contentW - w)), spaceBefore });
        continue;
      }
      const lines = it.b.lines;
      const runs: DocxRun[] = [];
      const push = (c: Ch, text: string) => {
        const fs = fontStyle(c.font);
        const run: DocxRun = { text, family: fs.family, size: Math.round(c.size * 2) / 2, color: c.color, bold: c.bold || fs.bold, italic: c.italic || fs.italic };
        const last = runs[runs.length - 1];
        if (last && last.family === run.family && last.size === run.size && last.bold === run.bold && last.italic === run.italic && last.color.join() === run.color.join()) last.text += text;
        else runs.push(run);
      };
      lines.forEach((ln, k) => {
        for (const c of ln.chars) push(c, c.c);
        if (k === lines.length - 1) return;
        // linha curta termina o parágrafo do PDF ali (quebra); linha cheia continua na seguinte
        const last = ln.chars[ln.chars.length - 1];
        const text = ln.chars.map((c) => c.c).join("");
        if (r[2] - ln.bbox[2] > (ln.chars[0].size || 10) * 3) push(last, "\n");
        else if (!/[\s-]$/.test(text)) push(last, " ");
      });
      const tail = runs[runs.length - 1];
      if (tail) tail.text = tail.text.replace(/\s+$/, "");
      const align = alignOf(lines.map((l) => l.bbox), r, centerX, contentW, left);
      items.push({ kind: "p", runs: runs.filter((x) => x.text), indent: align === "left" || align === "both" ? indent : 0, spaceBefore, align });
    }
    return { width: W, height: H, margins, items };
  }

  // ---------- cabeçalho, rodapé, numeração e marca d'água ----------

  /**
   * Escreve textos nas margens das páginas. Marcadores: {p} página, {n} total,
   * {data} data de hoje, {arquivo} nome do documento.
   */
  addHeaderFooter(spec: HeaderFooterSpec): DocInfo {
    const items = spec.items.filter((it) => it.text.trim());
    if (!items.length) return this.info();
    const total = this.d().countPages();
    const pages = spec.pages?.length ? spec.pages : Array.from({ length: total }, (_, i) => i);
    const size = spec.size ?? 10;
    const margin = spec.margin ?? 28;
    const color = spec.color ?? [0.2, 0.2, 0.2];
    const today = new Date().toLocaleDateString("pt-BR");
    const start = spec.startAt ?? 1;
    this.op("Cabeçalho e rodapé", () => {
      pages.forEach((index, k) => {
        const page = this.d().loadPage(index);
        const [x0, y0, x1, y1] = page.getBounds();
        page.destroy();
        const fonts: Record<string, mupdf.PDFObject> = {};
        let ops = `BT\n${rg(color)}\n`;
        for (const it of items) {
          const text = it.text
            .replaceAll("{p}", String(start + k))
            .replaceAll("{n}", String(start + pages.length - 1))
            .replaceAll("{total}", String(total))
            .replaceAll("{data}", today)
            .replaceAll("{arquivo}", this.title);
          const enc = this.encodeLineOps(text, "Helvetica", size, fonts);
          const x = it.pos[1] === "l" ? x0 + margin : it.pos[1] === "r" ? x1 - margin - enc.width : (x0 + x1 - enc.width) / 2;
          const y = it.pos[0] === "t" ? y0 + margin + size * 0.75 : y1 - margin;
          ops += `1 0 0 -1 ${n3(x)} ${n3(y)} Tm ${enc.ops}\n`;
        }
        ops += "ET";
        this.appendContent(index, ops, fonts);
      });
    });
    return this.info();
  }

  /** Texto grande, transparente e girado no centro das páginas. */
  addWatermark(spec: WatermarkSpec): DocInfo {
    if (!spec.text.trim()) return this.info();
    const total = this.d().countPages();
    const pages = spec.pages?.length ? spec.pages : Array.from({ length: total }, (_, i) => i);
    const base = "Helvetica-Bold";
    const opacity = Math.min(1, Math.max(0.05, spec.opacity ?? 0.18));
    // A marca comum é marcada como marca d'água (o comando "Remover marca d'água" a encontra, como
    // as do Acrobat e do Foxit). A marca de destinatário não leva essa etiqueta nem o nome PapiroGS.
    const removable = spec.removable ?? true;
    const gs = `${removable ? "PapiroGS" : "PapiroGR"}${Math.round(opacity * 100)}`;
    const ang = ((spec.angle ?? 45) * Math.PI) / 180;
    const c = Math.cos(ang), s = Math.sin(ang);
    this.op("Marca d'água", () => {
      for (const index of pages) {
        const page = this.d().loadPage(index);
        const [x0, y0, x1, y1] = page.getBounds();
        page.destroy();
        const probeFonts: Record<string, mupdf.PDFObject> = {};
        const unit = this.encodeLineOps(spec.text, base, 1, probeFonts);
        // tamanho automático: a caixa do texto, já girada, cabe em 85% da página
        const k = Math.max(0.5, unit.width), ac = Math.abs(c), as = Math.abs(s);
        const size = spec.size ?? Math.max(8, Math.min(140,
          (0.85 * (x1 - x0)) / (k * ac + 0.7 * as), (0.85 * (y1 - y0)) / (k * as + 0.7 * ac)));
        const fonts: Record<string, mupdf.PDFObject> = {};
        const enc = this.encodeLineOps(spec.text, base, size, fonts);
        const w = enc.width, h = size * 0.7;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const x = cx - (w / 2) * c + (h / 2) * s;
        const y = cy + (w / 2) * s + (h / 2) * c;
        let ops = `/${gs} gs BT ${rg(spec.color ?? [0.6, 0.6, 0.6])} ` +
          `${n3(c)} ${n3(-s)} ${n3(-s)} ${n3(-c)} ${n3(x)} ${n3(y)} Tm ${enc.ops} ET`;
        if (removable) ops = `/Artifact <</Type /Pagination /Subtype /Watermark>> BDC q ${ops} Q EMC`;
        this.appendContent(index, ops, fonts, { [gs]: opacity }, spec.behind ?? false);
      }
    });
    return this.info();
  }

  // ---------- imagens ----------

  /** Cria um PDF novo a partir de imagens (uma por página) e o abre. */
  imagesToPdf(images: Uint8Array[], opts: ImagePageOptions = {}, title = "Imagens"): DocInfo {
    const doc = new mupdf.PDFDocument();
    for (const bytes of images) doc.insertPage(-1, imagePage(doc, bytes, opts));
    const buf = doc.saveToBuffer(SAVE_OPTIONS);
    const out = new Uint8Array(buf.asUint8Array());
    buf.destroy(); doc.destroy();
    const info = this.open(out, title);
    this.modified = true;
    return { ...info, dirty: true };
  }

  /** Insere imagens como páginas novas a partir da posição `at` (-1 = fim). */
  insertImages(images: Uint8Array[], at: number, opts: ImagePageOptions = {}): DocInfo {
    this.op("Inserir imagens", () => {
      const doc = this.d();
      let pos = at < 0 ? doc.countPages() : at;
      for (const bytes of images) doc.insertPage(pos++, imagePage(doc, bytes, opts));
    });
    return this.info();
  }

  /** Página como imagem PNG ou JPEG. */
  pageImage(index: number, dpi: number, format: "png" | "jpg"): Uint8Array {
    const page = this.d().loadPage(index);
    const pix = page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false, true);
    pix.setResolution(dpi, dpi);
    const out = new Uint8Array(format === "png" ? pix.asPNG() : pix.asJPEG(90));
    pix.destroy(); page.destroy();
    return out;
  }

  /** Página para impressão vetorial (SVG). Por padrão gira páginas deitadas 90° para caber em retrato; pode ser controlado via `opts`. */
  printSvg(
    index: number,
    maxBytes = 8_000_000,
    opts?: { autoRotate?: boolean; includeAnnots?: boolean },
  ): string | null {
    const autoRotate = opts?.autoRotate ?? true;
    const includeAnnots = opts?.includeAnnots ?? true;
    const page = this.d().loadPage(index);
    const [x0, y0, x1, y1] = page.getBounds();
    const w = x1 - x0, h = y1 - y0;
    const rotate = autoRotate && w > h;
    const outW = rotate ? h : w;
    const outH = rotate ? w : h;
    let m: mupdf.Matrix = mupdf.Matrix.translate(-x0, -y0);
    if (rotate) m = mupdf.Matrix.concat(m, mupdf.Matrix.concat(mupdf.Matrix.rotate(90), mupdf.Matrix.translate(h, 0)));
    const buf = new mupdf.Buffer();
    const writer = new mupdf.DocumentWriter(buf, "svg", "");
    try {
      const dev = writer.beginPage([0, 0, outW, outH]);
      if (includeAnnots) page.run(dev, m);
      else page.runPageContents(dev, m);
      writer.endPage();
      writer.close();
      if (buf.getLength() > maxBytes) return null;
      return buf.asString();
    } catch {
      return null;
    } finally {
      buf.destroy();
      page.destroy();
    }
  }

  /** Página para impressão em PNG. Por padrão gira páginas deitadas 90°; pode ser controlado via `opts`. */
  printImage(
    index: number,
    dpi: number,
    opts?: { autoRotate?: boolean; includeAnnots?: boolean; grayscale?: boolean },
  ): Uint8Array {
    const autoRotate = opts?.autoRotate ?? true;
    const includeAnnots = opts?.includeAnnots ?? true;
    const cs = opts?.grayscale ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
    const page = this.d().loadPage(index);
    const [x0, y0, x1, y1] = page.getBounds();
    let m = mupdf.Matrix.scale(dpi / 72, dpi / 72);
    if (autoRotate && x1 - x0 > y1 - y0) m = mupdf.Matrix.concat(m, mupdf.Matrix.rotate(90));
    const pix = page.toPixmap(m, cs, false, includeAnnots);
    const out = new Uint8Array(pix.asPNG());
    pix.destroy(); page.destroy();
    return out;
  }

  // ---------- OCR ----------

  /** Página parece escaneada? (quase sem texto extraível) */
  needsOcr(index: number): boolean {
    const chars = this.pageText(index).reduce((s, b) => s + b.lines.reduce((t, l) => t + l.chars.length, 0), 0);
    return chars < 20;
  }

  /**
   * Reconhece a página (com pré-processamento opcional: auto-orientação 0°/90°/180°/270°,
   * remoção local de sombras, contraste e endireitamento fino ±6°) e acrescenta texto invisível pesquisável.
   */
  async ocrPage(
    index: number,
    recognize: Recognizer,
    dpi = 300,
    cleanup = true,
  ): Promise<{ words: number; deskewDeg: number; enhanced: boolean; shadowRemoved: boolean; orientedDeg: QuarterTurn; info: DocInfo }> {
    const scale = dpi / 72;
    const doc = this.d();
    const page = doc.loadPage(index);
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    let rawRgb: Uint8Array;
    let imgW = pix.getWidth();
    let imgH = pix.getHeight();
    let png: Uint8Array | null = null;
    try {
      rawRgb = new Uint8Array(pix.getPixels());
      if (!cleanup && !recognize.recognizeRgb) png = new Uint8Array(pix.asPNG());
    } finally {
      pix.destroy();
      page.destroy();
    }

    let orientedDeg: QuarterTurn = 0;
    let deskewDeg = 0;
    let enhanced = false;
    let shadowRemoved = false;
    let ocrBuf: Uint8Array = rawRgb;
    let ocrComps = 3;

    if (cleanup) {
      // 1. Auto-orientação neural (0°/90°/180°/270°) quando o motor suporta
      if (recognize.detectOrientation) {
        const ori = await recognize.detectOrientation(rawRgb, imgW, imgH, 3);
        if (ori.fixCwDeg !== 0 && ori.confidence >= 0.70) {
          const rot = rotatePixels90(rawRgb, imgW, imgH, 3, ori.fixCwDeg);
          rawRgb = rot.pixels;
          imgW = rot.width;
          imgH = rot.height;
          orientedDeg = ori.fixCwDeg;
        }
      }
      // 2. Remoção local de sombras + contraste adaptativo + deskew fino ±6°
      const prep = preprocessPixelsForOcr(rawRgb, imgW, imgH, 3);
      png = prep.png;
      ocrBuf = prep.gray;
      ocrComps = 1;
      imgW = prep.width;
      imgH = prep.height;
      deskewDeg = prep.deskewDeg;
      enhanced = prep.enhanced;
      shadowRemoved = prep.shadowRemoved;
    }

    const recognized = recognize.recognizeRgb
      ? await recognize.recognizeRgb(ocrBuf, imgW, imgH, ocrComps)
      : await recognize(png!);
    const rawWords = recognized.filter((w) => w.text.trim() && (w.confidence ?? 100) >= 30);
    const words = Math.abs(deskewDeg) >= 0.25
      ? rawWords.map((w) => ({ ...w, bbox: unrotateOcrBox(w.bbox, imgW, imgH, deskewDeg) }))
      : rawWords;
    // o reconhecimento leva segundos: se outro documento foi aberto nesse meio-tempo, não escreve nele
    if (this.doc !== doc) throw new Error("O documento foi trocado durante o reconhecimento de texto.");
    if (!words.length && orientedDeg === 0) {
      return { words: 0, deskewDeg, enhanced, shadowRemoved, orientedDeg, info: this.info() };
    }

    this.op("OCR", () => {
      if (orientedDeg !== 0) {
        const obj = doc.findPage(index);
        const cur = obj.getInheritable("Rotate");
        const val = cur.isNull() ? 0 : cur.asNumber();
        obj.put("Rotate", (((val + orientedDeg) % 360) + 360) % 360);
      }
      if (!words.length) return;
      const pNow = doc.loadPage(index);
      const [bx0, by0] = pNow.getBounds();
      pNow.destroy();
      const fonts: Record<string, mupdf.PDFObject> = {};
      let ops = "BT\n3 Tr\n";
      for (const w of words) {
        const x0 = w.bbox[0] / scale + bx0, y0 = w.bbox[1] / scale + by0;
        const x1 = w.bbox[2] / scale + bx0, y1 = w.bbox[3] / scale + by0;
        const h = y1 - y0;
        const size = Math.max(4, h * 0.95);
        const enc = this.encodeLineOps(w.text, "Helvetica", size, fonts);
        const tz = enc.width > 0 ? (100 * (x1 - x0)) / enc.width : 100;
        ops += `${n3(tz)} Tz\n1 0 0 -1 ${n3(x0)} ${n3(y1 - h * 0.2)} Tm ${enc.ops}\n`;
      }
      ops += "ET";
      this.appendContent(index, ops, fonts);
    });
    return { words: words.length, deskewDeg, enhanced, shadowRemoved, orientedDeg, info: this.info() };
  }

  // ---------- internos ----------

  private d(): mupdf.PDFDocument {
    if (!this.doc) throw new Error("Nenhum documento aberto.");
    return this.doc;
  }

  private op(name: string, fn: () => void): void {
    const doc = this.d();
    doc.beginOperation(name);
    try {
      fn();
      doc.endOperation();
      this.modified = true;
      this.saveRedoStack = [];
    } catch (e) {
      doc.abandonOperation();
      this.forgetRefs();
      throw e;
    }
  }

  private fontKey(base: string): string {
    return FONT_KEY + base.replace(/[^A-Za-z]/g, "");
  }

  /** Objeto de uma fonte padrão (Base-14) neste documento, criado na primeira vez. */
  private base14Ref(base: string): mupdf.PDFObject {
    let ref = this.fontRefs.get(base);
    if (!ref) {
      // Montada à mão: doc.addSimpleFont guarda a fonte num cache do MuPDF que sobrevive
      // ao desfazer e devolveria a referência de um objeto já apagado.
      const doc = this.d();
      const f = doc.newDictionary();
      f.put("Type", doc.newName("Font"));
      f.put("Subtype", doc.newName("Type1"));
      f.put("BaseFont", doc.newName(base));
      f.put("Encoding", doc.newName("WinAnsiEncoding"));
      ref = doc.addObject(f);
      this.fontRefs.set(base, ref);
    }
    return ref;
  }

  /** Recursos de fonte para `appendContent` com uma fonte padrão. */
  private b14(base: string): Record<string, mupdf.PDFObject> {
    return { [this.fontKey(base)]: this.base14Ref(base) };
  }

  /**
   * Acrescenta operadores ao fim do conteúdo da página. O conteúdo original
   * fica isolado em q/Q, e o novo é desenhado no espaço de página do MuPDF
   * (y para baixo) graças à matriz inversa da transformação da página.
   */
  private appendContent(
    index: number,
    ops: string,
    fonts: Record<string, mupdf.PDFObject>,
    gstates: Record<string, number> = {},
    behind = false,
    xobjects: Record<string, mupdf.PDFObject> = {},
  ): void {
    const doc = this.d();
    const page = doc.loadPage(index);
    const pageObj = page.getObject();
    const inv = mupdf.Matrix.invert(page.getTransform());
    page.destroy();

    let res = pageObj.getInheritable("Resources");
    if (res.isNull()) { pageObj.put("Resources", doc.newDictionary()); res = pageObj.get("Resources"); }
    if (Object.keys(fonts).length) {
      if (res.get("Font").isNull()) res.put("Font", doc.newDictionary());
      const fontDict = res.get("Font");
      for (const [key, ref] of Object.entries(fonts)) fontDict.put(key, ref);
    }
    if (Object.keys(xobjects).length) {
      if (res.get("XObject").isNull()) res.put("XObject", doc.newDictionary());
      const xoDict = res.get("XObject");
      for (const [key, ref] of Object.entries(xobjects)) xoDict.put(key, ref);
    }
    if (Object.keys(gstates).length) {
      if (res.get("ExtGState").isNull()) res.put("ExtGState", doc.newDictionary());
      const gsDict = res.get("ExtGState");
      for (const [name, alpha] of Object.entries(gstates)) {
        let ref = this.gsRefs.get(name);
        if (!ref) {
          const gs = doc.newDictionary();
          gs.put("Type", doc.newName("ExtGState"));
          gs.put("ca", alpha);
          gs.put("CA", alpha);
          ref = doc.addObject(gs);
          this.gsRefs.set(name, ref);
        }
        gsDict.put(name, ref);
      }
    }

    const ours = `q\n${inv.map(n3).join(" ")} cm\n${ops}\nQ\n`;
    const arr = doc.newArray();
    const old = pageObj.get("Contents");
    const oldParts: mupdf.PDFObject[] = [];
    if (old.isArray()) old.forEach((v) => oldParts.push(v));
    else if (!old.isNull()) oldParts.push(old);
    if (behind) {
      // desenha antes do conteúdo original (fica por baixo)
      arr.push(doc.addStream(ours, {}));
      for (const v of oldParts) arr.push(v);
    } else {
      // Conteúdo mal formado pode deixar estados gráficos abertos (mais "q" que "Q");
      // fecha todos, senão a matriz que sobrou deslocaria e redimensionaria o que escrevemos.
      let open = 0;
      try { open = openStates(oldParts.map((v) => (v.isStream() ? v.readStream().asString() : "")).join("\n")); } catch { /* fluxo ilegível: assume equilibrado */ }
      arr.push(doc.addStream("q\n", {}));
      for (const v of oldParts) arr.push(v);
      arr.push(doc.addStream(`${"Q\n".repeat(open + 1)}${ours}`, {}));
    }
    pageObj.put("Contents", arr);
  }
}

// ---------- opções dos recursos ----------

export interface ProtectOptions {
  userPassword?: string;  // pedida para abrir (opcional)
  ownerPassword?: string; // libera as permissões
  permissions: { print: boolean; copy: boolean; edit: boolean; annotate: boolean };
  /** Nome de quem vai receber: vira marca d'água e rodapé na cópia (o documento aberto não muda). */
  recipient?: string;
  /** Páginas viram imagem nesta resolução (dpi): dificulta copiar e editar o texto. 0 = não. */
  imageOnly?: number;
}

export type MarginPos = "tl" | "tc" | "tr" | "bl" | "bc" | "br";
export interface HeaderFooterSpec {
  items: { pos: MarginPos; text: string }[];
  pages?: number[];
  size?: number;
  margin?: number;
  color?: RGB;
  startAt?: number;
}

export interface WatermarkSpec {
  text: string;
  /** Marcada como marca d'água, para "Remover marca d'água" achar (padrão). Falso na marca de destinatário. */
  removable?: boolean;
  pages?: number[];
  size?: number; // automático se omitido
  opacity?: number;
  angle?: number;
  color?: RGB;
  behind?: boolean;
}

export interface ImagePageOptions {
  page?: "A4" | "Carta" | "imagem";
  margin?: number;
}

/** Monta uma página com a imagem centralizada (retrato/paisagem conforme a imagem). */
function imagePage(doc: mupdf.PDFDocument, bytes: Uint8Array, opts: ImagePageOptions): mupdf.PDFObject {
  const img = new mupdf.Image(bytes);
  const w = img.getWidth(), h = img.getHeight();
  const kind = opts.page ?? "A4";
  const margin = kind === "imagem" ? 0 : opts.margin ?? 24;
  let pw: number, ph: number;
  if (kind === "imagem") { const s = 842 / Math.max(w, h); pw = w * s; ph = h * s; }
  else {
    const [a, b] = kind === "Carta" ? [612, 792] : [595, 842];
    [pw, ph] = w > h ? [b, a] : [a, b];
  }
  const s = Math.min((pw - 2 * margin) / w, (ph - 2 * margin) / h);
  const iw = w * s, ih = h * s, x = (pw - iw) / 2, y = (ph - ih) / 2;
  const ref = liveImage(doc, img);
  const res = doc.newDictionary();
  const xo = doc.newDictionary();
  xo.put("Im0", ref);
  res.put("XObject", xo);
  const page = doc.addPage([0, 0, pw, ph], 0, res, `q ${n3(iw)} 0 0 ${n3(ih)} ${n3(x)} ${n3(y)} cm /Im0 Do Q`);
  img.destroy();
  return page;
}

/**
 * Acrescenta a imagem ao documento por meio de um documento temporário. `doc.addImage`
 * usa um cache do MuPDF que sobrevive ao desfazer: inserir, desfazer e inserir a mesma
 * imagem de novo devolveria a referência de um objeto já apagado (página em branco).
 */
function liveImage(doc: mupdf.PDFDocument, img: mupdf.Image): mupdf.PDFObject {
  const tmp = new mupdf.PDFDocument();
  try { return doc.graftObject(tmp.addImage(img)); } finally { tmp.destroy(); }
}

/** Quantos "q" o conteúdo deixa sem o "Q" correspondente (ignora textos, comentários e imagens embutidas). */
export function openStates(src: string): number {
  const delim = (ch: string) => ch === undefined || /[\s()<>\[\]{}\/%]/.test(ch);
  let depth = 0, i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "%") { while (i < n && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
    if (ch === "(") { // texto literal, com parênteses aninhados e escapes
      let level = 1; i++;
      while (i < n && level > 0) { if (src[i] === "\\") i++; else if (src[i] === "(") level++; else if (src[i] === ")") level--; i++; }
      continue;
    }
    if (ch === "<" && src[i + 1] !== "<") { while (i < n && src[i] !== ">") i++; i++; continue; } // texto em hexadecimal
    if (delim(ch)) { i++; continue; }
    let j = i;
    while (j < n && !delim(src[j])) j++;
    const tok = src.slice(i, j);
    i = j;
    if (tok === "q") depth++;
    else if (tok === "Q") depth = Math.max(0, depth - 1);
    else if (tok === "BI") { // imagem embutida: pula os dados binários até o EI
      const id = src.indexOf("ID", i);
      const m = id < 0 ? null : /\sEI(?=[\s\/\[<(]|$)/.exec(src.slice(id));
      i = m ? id + m.index + m[0].length : n;
    }
  }
  return depth;
}

function randomPassword(): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from({ length: 24 }, () => a[Math.floor(Math.random() * a.length)]).join("");
}

// ---------- utilitários ----------

function quadsBounds(quads: Quad[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of quads) {
    for (let i = 0; i < 8; i += 2) {
      if (q[i] < x0) x0 = q[i];
      if (q[i] > x1) x1 = q[i];
      if (q[i + 1] < y0) y0 = q[i + 1];
      if (q[i + 1] > y1) y1 = q[i + 1];
    }
  }
  return x0 < Infinity ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

function mergeQuads(quads: Quad[]): Quad {
  const [x0, y0, x1, y1] = quadsBounds(quads);
  return [x0, y0, x1, y0, x0, y1, x1, y1];
}

function linesBounds(lines: TextLine[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) {
    if (l.bbox[0] < x0) x0 = l.bbox[0];
    if (l.bbox[1] < y0) y0 = l.bbox[1];
    if (l.bbox[2] > x1) x1 = l.bbox[2];
    if (l.bbox[3] > y1) y1 = l.bbox[3];
  }
  return x0 < Infinity ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

/**
 * Divide blocos de texto que o MuPDF juntou indevidamente (ex.: campos de formulário/tabelas
 * ligados por espaçadores vazios, colunas paralelas sem sobreposição horizontal ou rótulo pequeno
 * colado em valor maior/negrito). Mantém parágrafos contínuos intactos.
 */
function splitTextBlocks(blocks: TextBlock[]): TextBlock[] {
  const out: TextBlock[] = [];
  for (const b of blocks) {
    if (!b.lines.length) continue;
    let cur: TextLine[] = [b.lines[0]];
    for (let i = 1; i < b.lines.length; i++) {
      const prev = cur[cur.length - 1];
      const next = b.lines[i];
      const maxSz = Math.max(prev.size, next.size, 1);
      const minSz = Math.max(Math.min(prev.size, next.size), 1);
      const vGap = next.bbox[1] - prev.bbox[3];
      const backJump = next.bbox[3] < prev.bbox[1];
      const hOverlap = Math.min(prev.bbox[2], next.bbox[2]) >= Math.max(prev.bbox[0], next.bbox[0]) - 2;
      const sizeJump = maxSz / minSz > 1.22;
      const weightChanged = fontStyle(prev.font).bold !== fontStyle(next.font).bold;
      if (vGap > maxSz * 0.85 || backJump || !hOverlap || sizeJump || weightChanged) {
        out.push({ bbox: linesBounds(cur), lines: cur });
        cur = [next];
      } else {
        cur.push(next);
      }
    }
    out.push({ bbox: linesBounds(cur), lines: cur });
  }
  return out;
}

function toRGB(c: number[]): RGB {
  if (!c || c.length === 0) return [0, 0, 0];
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 4) { // CMYK aproximado
    const [C, M, Y, K] = c;
    return [(1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)];
  }
  return [c[0], c[1], c[2]];
}

const n3 = (v: number) => (Math.round(v * 1000) / 1000).toString();
const rg = (c: RGB) => `${n3(c[0])} ${n3(c[1])} ${n3(c[2])} rg`;
const pad = (r: Rect, p: number): Rect => [r[0] - p, r[1] - p, r[2] + p, r[3] + p];

export function base14For(fontName: string): string {
  // Nomes "Nimbus" são as Base-14 embutidas no MuPDF (NimbusRoman = Times etc.).
  const n = fontName.toLowerCase().replace(/nimbusroman/, "times").replace(/nimbussans/, "helvetica");
  const bold = /bold|black|heavy|semibold|demi/.test(n);
  const italic = /italic|oblique/.test(n);
  if (/courier|mono|consol/.test(n)) return "Courier" + (bold ? (italic ? "-BoldOblique" : "-Bold") : italic ? "-Oblique" : "");
  if (/times|serif|roman|georgia|garamond|cambria|book/.test(n) && !/sans/.test(n)) {
    return bold ? (italic ? "Times-BoldItalic" : "Times-Bold") : italic ? "Times-Italic" : "Times-Roman";
  }
  return "Helvetica" + (bold ? (italic ? "-BoldOblique" : "-Bold") : italic ? "-Oblique" : "");
}

export function textWidth(s: string, font: mupdf.Font, size: number): number {
  let w = 0;
  for (const ch of s) w += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)!), 0);
  return w * size;
}

function wrapMeasured(text: string, measure: (s: string) => number, maxWidth?: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!maxWidth) { out.push(para); continue; }
    let cur = "";
    for (const word of para.split(/(\s+)/)) {
      const next = cur + word;
      if (cur && measure(next.trimEnd()) > maxWidth) { out.push(cur.trimEnd()); cur = word.trimStart(); }
      else cur = next;
    }
    out.push(cur);
  }
  return out;
}

/** Alinhamento de um bloco de texto (para o .docx). */
function alignOf(lines: Rect[], block: Rect, centerX: number, contentW: number, left: number): DocxPara["align"] {
  if (!lines.length) return "left";
  const bw = block[2] - block[0];
  const mids = lines.map((l) => (l[0] + l[2]) / 2), rights = lines.map((l) => l[2]), lefts = lines.map((l) => l[0]);
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
  if (bw < contentW * 0.8 && spread(mids) < 3 && Math.abs((block[0] + block[2]) / 2 - centerX) < 15 && (lines.length > 1 || block[0] - left > 20)) return "center";
  if (lines.length > 1 && spread(rights) < 2 && spread(lefts) > 6 && block[2] > left + contentW - 15) return "right";
  if (lines.length >= 3 && spread(rights.slice(0, -1)) < 1.5 && bw > contentW * 0.6) return "both";
  return "left";
}

const base14Fonts = new Map<string, mupdf.Font>();
function base14Font(base: string): mupdf.Font {
  let f = base14Fonts.get(base);
  if (!f) base14Fonts.set(base, (f = new mupdf.Font(base)));
  return f;
}

/** Imagem de um bloco do texto estruturado → PNG (com transparência ou preto e branco) ou JPEG, com no máximo 2400 px. */
function imageForDocx(image: mupdf.Image): { data: Uint8Array; ext: "png" | "jpeg" } | null {
  if (image.getImageMask()) return null;
  let p0: mupdf.Pixmap | undefined, p1: mupdf.Pixmap | undefined, p2: mupdf.Pixmap | undefined;
  try {
    p0 = image.toPixmap();
    const alpha = p0.getAlpha() > 0;
    const gray = p0.getColorSpace()?.isGray() === true;
    p1 = p0.convertToColorSpace(gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, alpha);
    const w = p1.getWidth(), h = p1.getHeight(), big = Math.max(w, h);
    if (big > 2400) {
      const s = 2400 / big;
      p2 = p1.warp([[0, 0], [w, 0], [w, h], [0, h]], Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
    }
    const px = p2 ?? p1;
    const png = alpha || image.getBitsPerComponent() === 1;
    return { data: new Uint8Array(png ? px.asPNG() : px.asJPEG(85)), ext: png ? "png" : "jpeg" };
  } catch {
    return null;
  } finally { p2?.destroy(); p1?.destroy(); p0?.destroy(); }
}

// Unicode → Windows-1252 (WinAnsiEncoding), em hexadecimal para o operador Tj.
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Byte Windows-1252 do caractere, ou null se ele não existe nessa codificação. */
export function winAnsiByte(ch: string): number | null {
  const u = ch.codePointAt(0)!;
  if ((u >= 0x20 && u <= 0x7e) || (u >= 0xa0 && u <= 0xff)) return u;
  if (CP1252[u] !== undefined) return CP1252[u];
  if (u === 0x09) return 0x20;
  return null;
}

export function winAnsiHex(s: string): string {
  let hex = "";
  for (const ch of s) {
    const u = ch.codePointAt(0)!;
    let b: number;
    if ((u >= 0x20 && u <= 0x7e) || (u >= 0xa0 && u <= 0xff)) b = u;
    else if (CP1252[u] !== undefined) b = CP1252[u];
    else if (u === 0x09) b = 0x20;
    else b = 0x3f; // '?'
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

function pdfUnicodeString(doc: mupdf.PDFDocument, s: string): mupdf.PDFObject {
  if (/^[\x20-\x7e]*$/.test(s)) return doc.newString(s);
  const bytes = new Uint8Array(2 + s.length * 2);
  bytes[0] = 0xfe; bytes[1] = 0xff;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    bytes[2 + i * 2] = (code >> 8) & 0xff;
    bytes[3 + i * 2] = code & 0xff;
  }
  return doc.newByteString(bytes);
}

export { mupdf };
export type { Point };
