// Tipos compartilhados entre o motor (MuPDF) e a interface.
// Todas as coordenadas de página estão no "espaço de página" do MuPDF:
// pontos (1/72"), origem no canto superior esquerdo, y para baixo.

export type Rect = [number, number, number, number];
export type Quad = [number, number, number, number, number, number, number, number];
export type Point = [number, number];
export type RGB = [number, number, number];

export interface PageInfo {
  x: number; // origem da página (pode não ser 0 quando há CropBox)
  y: number;
  width: number;
  height: number;
  label: string;
}

export interface OutlineNode {
  title: string;
  page: number;
  children: OutlineNode[];
}

export interface DocInfo {
  pageCount: number;
  pages: PageInfo[];
  outline: OutlineNode[];
  title: string;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  encrypted: boolean; // tem senha de abertura e/ou restrições
}

export interface TextChar {
  c: string;
  quad: Quad;
}

export interface TextLine {
  bbox: Rect;
  text: string;
  font: string;
  size: number;
  color: RGB;
  origin: Point; // linha de base do primeiro caractere
  chars: TextChar[];
}

export interface TextBlock {
  bbox: Rect;
  lines: TextLine[];
}

export type AnnotKind =
  | "Highlight" | "Underline" | "StrikeOut" | "Squiggly"
  | "Text" | "FreeText" | "Ink" | "Square" | "Circle" | "Line"
  | "Stamp" | "Redact";

export interface AnnotInfo {
  id: number; // número do objeto PDF (estável enquanto o documento está aberto)
  kind: string;
  rect: Rect;
  contents: string;
  author: string;
  color: number[];
}

export type NewAnnot =
  | { kind: "Highlight" | "Underline" | "StrikeOut" | "Squiggly"; quads: Quad[]; color?: RGB }
  | { kind: "Text"; at: Point; contents: string; color?: RGB }
  | { kind: "FreeText"; rect: Rect; contents: string; size?: number; color?: RGB }
  | { kind: "Ink"; strokes: Point[][]; color?: RGB; width?: number }
  | { kind: "Square" | "Circle"; rect: Rect; color?: RGB; width?: number }
  | { kind: "Line"; from: Point; to: Point; arrow?: boolean; color?: RGB; width?: number }
  | { kind: "Stamp"; rect: Rect; png: Uint8Array }
  | { kind: "Redact"; rect: Rect; overlayText?: string };

export interface FieldInfo {
  id: number;
  type: string; // text | checkbox | radiobutton | combobox | listbox | button | signature
  name: string;
  value: string;
  options: string[];
  rect: Rect;
  readOnly: boolean;
  multiline: boolean;
}

export interface SearchHit {
  page: number;
  quads: Quad[];
}

export interface EditTextRequest {
  page: number;
  area: Rect;        // região do texto original (removido)
  areas?: Rect[];    // retângulos por linha (evita apagar texto vizinho em tabelas/colunas)
  text: string;      // texto novo; "\n" quebra linha
  origin: Point;     // linha de base da primeira linha
  size: number;
  color: RGB;
  font: string;      // nome da fonte original (mapeado para uma Base-14)
  maxWidth?: number; // quebra automática de linha
  lineHeight?: number;
  align?: "left" | "center" | "right";
  erase?: boolean;   // padrão true; false = apenas inserir texto novo sem redigir área
}

/** Resultado da edição de texto: quais fontes foram usadas no trecho novo. */
export interface EditTextResult {
  info: DocInfo;
  fonts: {
    original: string | null; // fonte embutida no próprio documento
    system: string | null;   // fonte do Windows embutida porque faltavam letras na original
    fallback: boolean;       // alguma letra saiu numa fonte padrão do PDF
    substituted?: number;    // caracteres que não existiam em nenhuma fonte e viraram "?"
  };
}

export interface CropMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ComparePageDiff {
  page: number;
  status: "same" | "changed" | "onlyA" | "onlyB";
  visualDiffPct: number;
  added: string[];
  removed: string[];
  diffPng: Uint8Array | null;
}

export interface CompareReport {
  nameA: string;
  nameB: string;
  pagesA: number;
  pagesB: number;
  same: number;
  changed: number;
  onlyA: number;
  onlyB: number;
  pages: ComparePageDiff[];
}

// ---------- Tier 1: Redação inteligente, Otimizador, Bates, Rótulos, Comentários, Anexos, Camadas, Links ----------

export type RedactPatternId = "cpf" | "cnpj" | "email" | "phone" | "cep" | "rg" | "card";

export interface SmartRedactRequest {
  patterns: RedactPatternId[];
  customQuery?: string;
  isRegex?: boolean;
  overlayText?: string;
  pages?: number[];
}

export interface SmartRedactResult {
  marked: number;
  pages: number;
  byLabel: Record<string, number>;
  info: DocInfo;
}

export interface SpaceAudit {
  totalBytes: number;
  images: number;
  fonts: number;
  streams: number;
  metadata: number;
  attachments: number;
  other: number;
  imageCount: number;
  fontCount: number;
  attachmentCount: number;
}

export interface OptimizeOptions {
  level: "nenhuma" | "leve" | "media" | "forte";
  subsetFonts?: boolean;
  deduplicate?: boolean;
  stripMetadata?: boolean;
  stripAttachments?: boolean;
  stripBookmarks?: boolean;
  stripThumbnails?: boolean;
  stripJavaScript?: boolean;
}

export interface OptimizeResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  images: number;
}

export interface BatesSpec {
  prefix?: string;
  suffix?: string;
  startNumber: number;
  digits?: number;
  pos?: "tl" | "tc" | "tr" | "bl" | "bc" | "br";
  size?: number;
  margin?: number;
  color?: RGB;
  pages?: number[];
}

export type PageLabelStyle = "D" | "R" | "r" | "A" | "a" | "none";

export interface PageLabelRule {
  startPage: number; // índice 0-based
  style: PageLabelStyle;
  prefix?: string;
  startAt?: number;
}

export interface CommentSummaryItem {
  page: number;
  pageLabel: string;
  kind: string;
  author: string;
  contents: string;
  quote: string;
  color: number[];
}

export interface AttachmentInfo {
  key: string;
  filename: string;
  mimetype: string;
  size: number;
}

export interface LayerInfo {
  index: number;
  name: string;
  visible: boolean;
}

export interface LinkInfo {
  index: number;
  rect: Rect;
  uri: string;
  isExternal: boolean;
  targetPage: number; // >= 0 para link interno, -1 para externo ou sem destino
}

export type BatchAction =
  | { kind: "compress"; level: "leve" | "media" | "forte"; optimize?: OptimizeOptions }
  | { kind: "watermark"; text: string; opacity?: number; angle?: number; color?: RGB }
  | { kind: "number"; fmt: string; pos: "bc" | "br" | "bl" | "tc" | "tr" | "tl" }
  | { kind: "bates"; prefix?: string; suffix?: string; startNumber: number; digits?: number; pos?: "tl" | "tc" | "tr" | "bl" | "bc" | "br"; size?: number; continuous?: boolean }
  | { kind: "normalize"; target: "A4" | "Carta" }
  | { kind: "sanitize" }
  | { kind: "flatten" }
  | { kind: "redactPatterns"; patterns: RedactPatternId[]; customQuery?: string; isRegex?: boolean; overlayText?: string }
  | { kind: "ocr"; langs: string };

export interface BatchResult {
  processed: number;
  failed: { file: string; error: string }[];
  batesEnd?: number;
}

export interface OcrProgress {
  page: number;
  done: number;
  total: number;
}

// ---------- Tier 2: Assinatura Digital A1, Criador de Formulários, Pre-OCR ----------

export interface PfxCertInfo {
  commonName: string;
  issuer: string;
  serial: string;
  validFrom: string;
  validTo: string;
  expired: boolean;
}

export interface DigitalSignOptions {
  pfxBytes: Uint8Array;
  password: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** Retângulo visível da assinatura (omitir = assinatura invisível). */
  visible?: { page: number; rect: Rect };
}

export interface SignatureVerifyInfo {
  fieldName: string;
  signerName: string;
  issuer: string;
  serial: string;
  validFrom: string;
  validTo: string;
  signingTime: string;
  reason: string;
  location: string;
  subFilter: string;
  /** Integridade criptográfica do ByteRange e assinatura válida pela chave pública do certificado embutido. */
  integrityValid: boolean;
  /** O ByteRange cobre todo o arquivo (nenhum dado acrescentado fora da assinatura). */
  coversWholeDocument: boolean;
  status: "valid" | "tampered" | "invalid";
  note: string;
}

export type NewFieldKind = "text" | "checkbox" | "combobox" | "signature";

export interface CreateFieldSpec {
  page: number;
  kind: NewFieldKind;
  name: string;
  rect: Rect;
  multiline?: boolean;
  options?: string[];
  defaultValue?: string;
}

export interface OcrOptions {
  dpi?: number;
  langs?: string;
  quality?: "fast" | "best";
  cleanup?: boolean;
}

