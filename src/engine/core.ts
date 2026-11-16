// Núcleo do editor: tudo o que mexe no PDF passa por aqui.
// Não depende de Electron nem de interface — pode ser testado direto no Node.
import * as mupdf from "mupdf";
import type {
  AnnotInfo, DocInfo, EditTextRequest, FieldInfo, NewAnnot, OutlineNode,
  Point, Quad, Rect, RGB, SearchHit, TextBlock, TextLine,
} from "./types.ts";

export interface OcrWord { text: string; bbox: Rect } // bbox em pixels da imagem enviada
export type Recognizer = (png: Uint8Array) => Promise<OcrWord[]>;

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
    return this.info();
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
    this.fontRefs.clear();
    this.gsRefs.clear();
    doc.enableJournal();
  }

  close(): void {
    this.cancelOpen();
    this.doc?.destroy();
    this.doc = null;
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
      canUndo: doc.canUndo(),
      canRedo: doc.canRedo(),
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
   * Salva e reabre a partir dos bytes salvos. Salvar invalida o histórico do
   * MuPDF (desfazer passaria a restaurar objetos errados), então o histórico
   * recomeça a cada salvamento — desfazer vale até o último "Salvar".
   */
  save(): Uint8Array {
    const out = this.serialize();
    this.modified = false;
    return out;
  }

  /** Bytes do documento atual. Reabre a partir deles (o histórico recomeça), preservando senha e estado. */
  private serialize(options = SAVE_OPTIONS): Uint8Array {
    const buf = this.d().saveToBuffer(options);
    const out = new Uint8Array(buf.asUint8Array()); // copia para fora da memória WASM
    buf.destroy();
    const { title, password, modified } = this;
    // um documento que espera senha (abertura em andamento) sobrevive ao salvamento do atual
    const pending = this.pending;
    this.pending = null;
    try { this.open(out, title, password); } finally { this.pending = pending; }
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
    const src = this.scratch(this.serialize());
    let o = `${SAVE_OPTIONS},encrypt=aes-256,owner-password=${owner},permissions=${pSigned}`;
    if (opts.userPassword) o += `,user-password=${opts.userPassword}`;
    const buf = src.saveToBuffer(o);
    const out = new Uint8Array(buf.asUint8Array());
    buf.destroy(); src.destroy();
    return out;
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
    const cfg = { leve: { px: 2600, q: 85 }, media: { px: 1800, q: 72 }, forte: { px: 1200, q: 55 } }[level];
    const original = this.serialize();
    const d = this.scratch(original);
    let images = 0;
    const n = d.countObjects();
    for (let num = 1; num < n; num++) {
      let obj: mupdf.PDFObject;
      try { obj = d.newIndirect(num); if (!obj.isStream()) continue; } catch { continue; }
      const sub = obj.get("Subtype");
      if (sub.isNull() || sub.asName() !== "Image") continue;
      if (obj.get("ImageMask").isBoolean() && obj.get("ImageMask").asBoolean()) continue;
      if (obj.get("Mask").isArray()) continue; // máscara por cor-chave não sobrevive ao JPEG
      // Cada imagem decodificada ocupa dezenas de MB na memória do MuPDF: libera tudo a cada volta
      // (o coletor de lixo não roda no meio deste laço).
      let img: mupdf.Image | undefined, p0: mupdf.Pixmap | undefined, p1: mupdf.Pixmap | undefined, p2: mupdf.Pixmap | undefined;
      try {
        const w = obj.get("Width").asNumber(), h = obj.get("Height").asNumber();
        const raw = obj.readRawStream();
        const rawLen = raw.getLength();
        raw.destroy();
        if (rawLen < 60_000) continue; // pequena demais para valer a pena
        img = d.loadImage(obj);
        p0 = img.toPixmap();
        // só é cinza o que está num espaço de cor cinza (tinta especial de 1 canal vira RGB, não cinza)
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
    let buf: mupdf.Buffer;
    try { buf = d.saveToBuffer("garbage=compact,compress,compress-fonts,compress-images,objstms"); }
    catch { buf = d.saveToBuffer(SAVE_OPTIONS); }
    let bytes: Uint8Array = new Uint8Array(buf.asUint8Array());
    buf.destroy(); d.destroy();
    if (bytes.length >= original.length) bytes = original; // nunca piora
    return { bytes, before: original.length, after: bytes.length, images };
  }

  undo(): DocInfo { if (this.d().canUndo()) { this.d().undo(); this.modified = true; this.forgetRefs(); } return this.info(); }
  redo(): DocInfo { if (this.d().canRedo()) { this.d().redo(); this.modified = true; this.forgetRefs(); } return this.info(); }

  /** Desfazer pode ter apagado os objetos de fonte/transparência criados antes: não reaproveita nenhum. */
  private forgetRefs(): void {
    this.fontRefs.clear();
    this.gsRefs.clear();
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

  /** Texto da página em blocos → linhas → caracteres, com fonte, tamanho e cor. */
  pageText(index: number): TextBlock[] {
    const page = this.d().loadPage(index);
    const st = page.toStructuredText("preserve-whitespace");
    const blocks: TextBlock[] = [];
    let block: TextBlock | null = null;
    let line: TextLine | null = null;
    st.walk({
      beginTextBlock(bbox) { block = { bbox: bbox as Rect, lines: [] }; },
      beginLine(bbox) {
        line = { bbox: bbox as Rect, text: "", font: "", size: 0, color: [0, 0, 0], origin: [0, 0], chars: [] };
      },
      onChar(c, origin, font, size, quad, color) {
        if (!line) return;
        if (line.chars.length === 0) {
          line.font = font.getName();
          line.size = size;
          line.origin = [origin[0], origin[1]];
          line.color = toRGB(color as number[]);
        }
        line.text += c;
        line.chars.push({ c, quad: quad as Quad });
      },
      endLine() { if (block && line && line.chars.length) block.lines.push(line); line = null; },
      endTextBlock() { if (block && block.lines.length) blocks.push(block); block = null; },
    });
    st.destroy(); page.destroy();
    return blocks;
  }

  search(needle: string): SearchHit[] {
    const hits: SearchHit[] = [];
    if (!needle.trim()) return hits;
    const n = this.d().countPages();
    for (let i = 0; i < n; i++) {
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

  /** Aplica todas as marcas de redação do documento. Retorna quantas páginas mudaram. */
  applyAllRedactions(): { pages: number; info: DocInfo } {
    const pages = [...new Set(this.allAnnotations().filter((a) => a.kind === "Redact").map((a) => a.page))];
    if (pages.length) {
      this.op("Aplicar redações", () => {
        for (const i of pages) {
          const page = this.d().loadPage(i);
          page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS,
            mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
          page.destroy();
        }
      });
    }
    return { pages: pages.length, info: this.info() };
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
      const page = this.d().loadPage(index);
      page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS,
        mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      page.destroy();
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
   * Substitui o texto de uma área: remove só os glifos de texto da área
   * (imagens e vetores ficam) e escreve o texto novo numa fonte Base-14 parecida.
   */
  editText(req: EditTextRequest): DocInfo {
    this.op("Editar texto", () => {
      const page = this.d().loadPage(req.page);
      const red = page.createAnnotation("Redact");
      red.setRect(pad(req.area, 0.5));
      red.update();
      red.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE,
        mupdf.PDFPage.REDACT_TEXT_REMOVE);
      page.destroy();

      const base = base14For(req.font);
      const font = new mupdf.Font(base);
      const lines = wrap(req.text, font, req.size, req.maxWidth);
      const lh = req.lineHeight ?? req.size * 1.2;
      let ops = `BT\n${rg(req.color)}\n`;
      lines.forEach((ln, k) => {
        ops += `/${this.fontKey(base)} ${n3(req.size)} Tf\n`;
        ops += `1 0 0 -1 ${n3(req.origin[0])} ${n3(req.origin[1] + k * lh)} Tm\n<${winAnsiHex(ln)}> Tj\n`;
      });
      ops += "ET";
      this.appendContent(req.page, ops, [base]);
      font.destroy();
    });
    return this.info();
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
    const font = new mupdf.Font("Helvetica");
    const today = new Date().toLocaleDateString("pt-BR");
    const start = spec.startAt ?? 1;
    this.op("Cabeçalho e rodapé", () => {
      pages.forEach((index, k) => {
        const page = this.d().loadPage(index);
        const [x0, y0, x1, y1] = page.getBounds();
        page.destroy();
        let ops = `BT\n${rg(color)}\n`;
        for (const it of items) {
          const text = it.text
            .replaceAll("{p}", String(start + k))
            .replaceAll("{n}", String(start + pages.length - 1))
            .replaceAll("{total}", String(total))
            .replaceAll("{data}", today)
            .replaceAll("{arquivo}", this.title);
          const w = textWidth(text, font, size);
          const x = it.pos[1] === "l" ? x0 + margin : it.pos[1] === "r" ? x1 - margin - w : (x0 + x1 - w) / 2;
          const y = it.pos[0] === "t" ? y0 + margin + size * 0.75 : y1 - margin;
          ops += `/${this.fontKey("Helvetica")} ${n3(size)} Tf 1 0 0 -1 ${n3(x)} ${n3(y)} Tm <${winAnsiHex(text)}> Tj\n`;
        }
        ops += "ET";
        this.appendContent(index, ops, ["Helvetica"]);
      });
    });
    font.destroy();
    return this.info();
  }

  /** Texto grande, transparente e girado no centro das páginas. */
  addWatermark(spec: WatermarkSpec): DocInfo {
    if (!spec.text.trim()) return this.info();
    const total = this.d().countPages();
    const pages = spec.pages?.length ? spec.pages : Array.from({ length: total }, (_, i) => i);
    const base = "Helvetica-Bold";
    const font = new mupdf.Font(base);
    const opacity = Math.min(1, Math.max(0.05, spec.opacity ?? 0.18));
    const gs = `PapiroGS${Math.round(opacity * 100)}`;
    const ang = ((spec.angle ?? 45) * Math.PI) / 180;
    const c = Math.cos(ang), s = Math.sin(ang);
    this.op("Marca d'água", () => {
      for (const index of pages) {
        const page = this.d().loadPage(index);
        const [x0, y0, x1, y1] = page.getBounds();
        page.destroy();
        // tamanho automático: a caixa do texto, já girada, cabe em 85% da página
        const k = Math.max(0.5, textWidth(spec.text, font, 1)), ac = Math.abs(c), as = Math.abs(s);
        const size = spec.size ?? Math.max(8, Math.min(140,
          (0.85 * (x1 - x0)) / (k * ac + 0.7 * as), (0.85 * (y1 - y0)) / (k * as + 0.7 * ac)));
        const w = textWidth(spec.text, font, size), h = size * 0.7;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const x = cx - (w / 2) * c + (h / 2) * s;
        const y = cy + (w / 2) * s + (h / 2) * c;
        const ops = `/${gs} gs BT ${rg(spec.color ?? [0.6, 0.6, 0.6])} /${this.fontKey(base)} ${n3(size)} Tf ` +
          `${n3(c)} ${n3(-s)} ${n3(-s)} ${n3(-c)} ${n3(x)} ${n3(y)} Tm <${winAnsiHex(spec.text)}> Tj ET`;
        this.appendContent(index, ops, [base], { [gs]: opacity }, spec.behind ?? false);
      }
    });
    font.destroy();
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

  /** Página para impressão: PNG em pé (páginas deitadas são giradas 90° para aproveitar a folha). */
  printImage(index: number, dpi: number): Uint8Array {
    const page = this.d().loadPage(index);
    const [x0, y0, x1, y1] = page.getBounds();
    let m = mupdf.Matrix.scale(dpi / 72, dpi / 72);
    if (x1 - x0 > y1 - y0) m = mupdf.Matrix.concat(m, mupdf.Matrix.rotate(90));
    const pix = page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false, true);
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

  /** Reconhece a página e acrescenta uma camada de texto invisível, pesquisável. */
  async ocrPage(index: number, recognize: Recognizer, dpi = 300): Promise<{ words: number; info: DocInfo }> {
    const scale = dpi / 72;
    const doc = this.d();
    const page = doc.loadPage(index);
    const [bx0, by0] = page.getBounds();
    page.destroy();
    const words = (await recognize(this.renderPng(index, scale))).filter((w) => w.text.trim());
    // o reconhecimento leva segundos: se outro documento foi aberto nesse meio-tempo, não escreve nele
    if (this.doc !== doc) throw new Error("O documento foi trocado durante o reconhecimento de texto.");
    if (!words.length) return { words: 0, info: this.info() };

    const font = new mupdf.Font("Helvetica");
    let ops = "BT\n3 Tr\n";
    for (const w of words) {
      const x0 = w.bbox[0] / scale + bx0, y0 = w.bbox[1] / scale + by0;
      const x1 = w.bbox[2] / scale + bx0, y1 = w.bbox[3] / scale + by0;
      const h = y1 - y0;
      const size = Math.max(4, h * 0.95);
      const natural = textWidth(w.text, font, size);
      const tz = natural > 0 ? (100 * (x1 - x0)) / natural : 100;
      ops += `/${this.fontKey("Helvetica")} ${n3(size)} Tf ${n3(tz)} Tz\n`;
      ops += `1 0 0 -1 ${n3(x0)} ${n3(y1 - h * 0.2)} Tm <${winAnsiHex(w.text)}> Tj\n`;
    }
    ops += "ET";
    font.destroy();
    this.op("OCR", () => this.appendContent(index, ops, ["Helvetica"]));
    return { words: words.length, info: this.info() };
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
    } catch (e) {
      doc.abandonOperation();
      this.forgetRefs();
      throw e;
    }
  }

  private fontKey(base: string): string {
    return FONT_KEY + base.replace(/[^A-Za-z]/g, "");
  }

  /**
   * Acrescenta operadores ao fim do conteúdo da página. O conteúdo original
   * fica isolado em q/Q, e o novo é desenhado no espaço de página do MuPDF
   * (y para baixo) graças à matriz inversa da transformação da página.
   */
  private appendContent(index: number, ops: string, fonts: string[], gstates: Record<string, number> = {}, behind = false): void {
    const doc = this.d();
    const page = doc.loadPage(index);
    const pageObj = page.getObject();
    const inv = mupdf.Matrix.invert(page.getTransform());
    page.destroy();

    let res = pageObj.getInheritable("Resources");
    if (res.isNull()) { pageObj.put("Resources", doc.newDictionary()); res = pageObj.get("Resources"); }
    if (res.get("Font").isNull()) res.put("Font", doc.newDictionary());
    const fontDict = res.get("Font");
    for (const base of fonts) {
      let ref = this.fontRefs.get(base);
      if (!ref) {
        // Montada à mão: doc.addSimpleFont guarda a fonte num cache do MuPDF que sobrevive
        // ao desfazer e devolveria a referência de um objeto já apagado.
        const f = doc.newDictionary();
        f.put("Type", doc.newName("Font"));
        f.put("Subtype", doc.newName("Type1"));
        f.put("BaseFont", doc.newName(base));
        f.put("Encoding", doc.newName("WinAnsiEncoding"));
        ref = doc.addObject(f);
        this.fontRefs.set(base, ref);
      }
      fontDict.put(this.fontKey(base), ref);
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

function wrap(text: string, font: mupdf.Font, size: number, maxWidth?: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!maxWidth) { out.push(para); continue; }
    let cur = "";
    for (const word of para.split(/(\s+)/)) {
      const next = cur + word;
      if (cur && textWidth(next.trimEnd(), font, size) > maxWidth) { out.push(cur.trimEnd()); cur = word.trimStart(); }
      else cur = next;
    }
    out.push(cur);
  }
  return out;
}

// Unicode → Windows-1252 (WinAnsiEncoding), em hexadecimal para o operador Tj.
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

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

export { mupdf };
export type { Point };
