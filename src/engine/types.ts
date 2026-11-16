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
  | { kind: "Redact"; rect: Rect };

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
  text: string;      // texto novo; "\n" quebra linha
  origin: Point;     // linha de base da primeira linha
  size: number;
  color: RGB;
  font: string;      // nome da fonte original (mapeado para uma Base-14)
  maxWidth?: number; // quebra automática de linha
  lineHeight?: number;
}

export interface OcrProgress {
  page: number;
  done: number;
  total: number;
}
