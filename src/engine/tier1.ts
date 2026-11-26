// Algoritmos auxiliares dos recursos Tier 1 (100% offline):
// redação inteligente por padrões (LGPD), detecção automática de marcadores
// e exportação de resumo de comentários (Markdown, CSV e PDF).
import * as mupdf from "mupdf";
import { fontStyle } from "./fontname.ts";
import type {
  CommentSummaryItem, OutlineNode, Quad, Rect, RedactPatternId, SmartRedactRequest, TextBlock, TextLine,
} from "./types.ts";

// ---------- redação inteligente (LGPD e padrões) ----------

interface PatternDef {
  id: RedactPatternId;
  label: string;
  re: RegExp;
  validate?: (match: string) => boolean;
}

function validCpf(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(d[i]) * (10 - i);
  let r = (s * 10) % 11;
  if (r === 10) r = 0;
  if (r !== Number(d[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += Number(d[i]) * (11 - i);
  r = (s * 10) % 11;
  if (r === 10) r = 0;
  return r === Number(d[10]);
}

function validCnpj(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len: number) => {
    const weights = len === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(d[i]) * weights[i];
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

function validLuhn(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export const REDACT_PATTERNS: Record<RedactPatternId, PatternDef> = {
  cpf: {
    id: "cpf",
    label: "CPF",
    re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
    validate: validCpf,
  },
  cnpj: {
    id: "cnpj",
    label: "CNPJ",
    re: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,
    validate: validCnpj,
  },
  email: {
    id: "email",
    label: "E-mail",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  phone: {
    id: "phone",
    label: "Telefone",
    re: /(?:\+55\s?)?(?:\(\d{2}\)|\b\d{2}\b)[\s.-]?(?:9\d{4}|\d{4})[\s.-]?\d{4}\b/g,
  },
  cep: {
    id: "cep",
    label: "CEP",
    re: /\b\d{2}\.?\d{3}-\d{3}\b/g,
  },
  rg: {
    id: "rg",
    label: "RG",
    re: /\b\d{1,2}\.\d{3}\.\d{3}-[\dXx]\b/g,
  },
  card: {
    id: "card",
    label: "Cartão",
    re: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
    validate: validLuhn,
  },
};

export interface PatternMatch {
  rect: Rect;
  label: string;
  text: string;
}

function quadsRect(quads: Quad[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of quads) {
    for (let i = 0; i < 8; i += 2) {
      if (q[i] < x0) x0 = q[i];
      if (q[i] > x1) x1 = q[i];
      if (q[i + 1] < y0) y0 = q[i + 1];
      if (q[i + 1] > y1) y1 = q[i + 1];
    }
  }
  return [x0, y0, x1, y1];
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return false;
  const areaA = Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
  const areaB = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  return (ix * iy) / Math.min(areaA, areaB) > 0.65;
}

/** Localiza ocorrências de padrões LGPD ou termo/regex personalizado nos blocos de texto de uma página. */
export function findPatternMatches(blocks: TextBlock[], req: Pick<SmartRedactRequest, "patterns" | "customQuery" | "isRegex">): PatternMatch[] {
  const matchers: { label: string; re: RegExp; validate?: (m: string) => boolean }[] = [];
  for (const id of req.patterns) {
    const def = REDACT_PATTERNS[id];
    if (def) matchers.push({ label: def.label, re: new RegExp(def.re.source, def.re.flags), validate: def.validate });
  }
  const q = req.customQuery?.trim();
  if (q) {
    try {
      const re = req.isRegex ? new RegExp(q, "gi") : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      matchers.push({ label: "Personalizado", re });
    } catch {
      throw new Error(`Expressão regular inválida: ${q}`);
    }
  }
  if (!matchers.length) return [];

  const out: PatternMatch[] = [];
  for (const b of blocks) {
    for (const l of b.lines) {
      if (!l.chars.length || !l.text.trim()) continue;
      for (const m of matchers) {
        m.re.lastIndex = 0;
        let hit: RegExpExecArray | null;
        while ((hit = m.re.exec(l.text)) !== null) {
          const val = hit[0];
          if (!val) { m.re.lastIndex++; continue; }
          if (m.validate && !m.validate(val)) continue;
          const start = hit.index;
          const end = Math.min(l.chars.length, start + val.length);
          const slice = l.chars.slice(start, end);
          if (!slice.length) continue;
          const r = quadsRect(slice.map((ch) => ch.quad));
          const padded: Rect = [r[0] - 1, r[1] - 1, r[2] + 1, r[3] + 1];
          if (!out.some((prev) => rectsOverlap(prev.rect, padded))) {
            out.push({ rect: padded, label: m.label, text: val });
          }
        }
      }
    }
  }
  return out;
}

// ---------- extração de trecho sob anotação (resumo de comentários) ----------

/** Recupera o texto da página que cai dentro do retângulo de uma anotação (realce, sublinhado, tachado…). */
export function extractTextInRect(blocks: TextBlock[], rect: Rect): string {
  const lines: string[] = [];
  const [rx0, ry0, rx1, ry1] = rect;
  for (const b of blocks) {
    for (const l of b.lines) {
      if (l.bbox[2] < rx0 - 2 || l.bbox[0] > rx1 + 2 || l.bbox[3] < ry0 - 2 || l.bbox[1] > ry1 + 2) continue;
      let buf = "";
      for (const ch of l.chars) {
        const q = ch.quad;
        const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
        const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
        if (cx >= rx0 - 2 && cx <= rx1 + 2 && cy >= ry0 - 2 && cy <= ry1 + 2) buf += ch.c;
      }
      const clean = buf.replace(/\s+/g, " ").trim();
      if (clean) lines.push(clean);
    }
  }
  return lines.join(" ").trim();
}

// ---------- geração automática de marcadores (sumário) ----------

const HEADING_PREFIX_RE = /^(?:cap[ií]tulo|se[çc][ãa]o|parte|anexo|ap[êe]ndice|art\.?\s*\d+|t[ií]tulo|\d+(?:\.\d+){0,3}[.)]?\s+\S)/i;

/** Detecta títulos prováveis por tamanho de fonte e peso e monta uma árvore de marcadores. */
export function detectHeadingOutline(pages: TextBlock[][]): OutlineNode[] {
  const sizeWeights = new Map<number, number>();
  const allLines: { page: number; line: TextLine; bold: boolean }[] = [];

  pages.forEach((blocks, page) => {
    for (const b of blocks) {
      for (const l of b.lines) {
        const clean = l.text.replace(/\s+/g, " ").trim();
        if (!clean) continue;
        const rounded = Math.round(l.size * 2) / 2;
        sizeWeights.set(rounded, (sizeWeights.get(rounded) ?? 0) + clean.length);
        allLines.push({ page, line: l, bold: fontStyle(l.font).bold });
      }
    }
  });

  if (!allLines.length) return [];

  // Tamanho predominante do corpo de texto (moda ponderada por caracteres)
  let bodySize = 10;
  let bestWeight = -1;
  for (const [sz, w] of sizeWeights) {
    if (w > bestWeight) { bestWeight = w; bodySize = sz; }
  }

  interface Candidate { page: number; title: string; size: number; bold: boolean; y: number }
  const cands: Candidate[] = [];
  const seenKey = new Set<string>();

  for (const { page, line, bold } of allLines) {
    const title = line.text.replace(/\s+/g, " ").trim();
    if (title.length < 3 || title.length > 110) continue;
    if (/^\d+$/.test(title) || /^p[áa]gina\s+\d+/i.test(title)) continue;
    if (/[;,.]$/.test(title) && title.length > 55) continue;

    const bigger = line.size >= bodySize * 1.18;
    const numberedBold = bold && line.size >= bodySize * 0.98 && HEADING_PREFIX_RE.test(title);
    const shortBoldUpper = bold && line.size >= bodySize * 1.05 && title.length <= 65 && title === title.toLocaleUpperCase("pt-BR") && /[A-ZÀ-Ý]{3}/.test(title);
    if (!bigger && !numberedBold && !shortBoldUpper) continue;

    const key = `${page}:${title.toLowerCase()}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    cands.push({ page, title, size: Math.round(line.size * 2) / 2, bold, y: line.bbox[1] });
  }

  if (!cands.length) return [];

  // Remove textos repetidos no topo/rodapé de 3+ páginas (cabeçalhos recorrentes)
  const titleFreq = new Map<string, number>();
  for (const c of cands) titleFreq.set(c.title.toLowerCase(), (titleFreq.get(c.title.toLowerCase()) ?? 0) + 1);
  const filtered = cands.filter((c) => pages.length < 3 || (titleFreq.get(c.title.toLowerCase()) ?? 0) < Math.max(3, Math.ceil(pages.length * 0.6)));
  if (!filtered.length) return [];

  // Agrupa níveis: maior tamanho = nível 1, menores = nível 2
  const distinctSizes = [...new Set(filtered.map((c) => c.size))].sort((a, b) => b - a);
  const topThreshold = distinctSizes.length > 1 ? distinctSizes[0] - 0.5 : 0;

  const root: OutlineNode[] = [];
  let lastH1: OutlineNode | null = null;
  for (const c of filtered.slice(0, 200)) {
    const node: OutlineNode = { title: c.title, page: c.page, children: [] };
    const isH1 = distinctSizes.length === 1 || c.size >= topThreshold;
    if (isH1 || !lastH1) {
      root.push(node);
      lastH1 = node;
    } else {
      lastH1.children.push(node);
    }
  }
  return root;
}

// ---------- exportação de resumo de comentários ----------

const KIND_PT: Record<string, string> = {
  Highlight: "Realce",
  Underline: "Sublinhado",
  StrikeOut: "Tachado",
  Squiggly: "Ondulado",
  Text: "Nota",
  FreeText: "Caixa de texto",
  Ink: "Desenho",
  Square: "Retângulo",
  Circle: "Elipse",
  Line: "Linha",
  Stamp: "Carimbo",
  Redact: "Redação pendente",
};

export function commentKindLabel(kind: string): string {
  return KIND_PT[kind] ?? kind;
}

export function formatCommentsMarkdown(items: CommentSummaryItem[], title: string): string {
  const lines: string[] = [
    `# Resumo de comentários — ${title || "Documento"}`,
    "",
    `Total: ${items.length} anotação(ões) · Gerado em ${new Date().toLocaleDateString("pt-BR")}`,
    "",
  ];
  let curPage = -1;
  for (const it of items) {
    if (it.page !== curPage) {
      curPage = it.page;
      lines.push(`## Página ${it.pageLabel || it.page + 1}`, "");
    }
    const meta = [commentKindLabel(it.kind), it.author].filter(Boolean).join(" · ");
    lines.push(`- **${meta}**`);
    if (it.quote) lines.push(`  > ${it.quote.replace(/\r?\n/g, " ")}`);
    if (it.contents) lines.push(`  ${it.contents.replace(/\r?\n/g, "  \n  ")}`);
    lines.push("");
  }
  return lines.join("\r\n");
}

function csvCell(s: string): string {
  const clean = s.replace(/\r?\n/g, " ").trim();
  return /[;"\r\n]/.test(clean) ? `"${clean.replace(/"/g, '""')}"` : clean;
}

export function formatCommentsCsv(items: CommentSummaryItem[]): string {
  const rows = ["Página;Tipo;Autor;Trecho marcado;Comentário"];
  for (const it of items) {
    rows.push([
      it.pageLabel || String(it.page + 1),
      commentKindLabel(it.kind),
      it.author,
      it.quote,
      it.contents,
    ].map(csvCell).join(";"));
  }
  return "\ufeff" + rows.join("\r\n") + "\r\n";
}

function winAnsiSafeHex(s: string): string {
  const CP1252: Record<number, number> = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
    0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
    0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
    0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
  };
  let hex = "";
  for (const ch of s) {
    const u = ch.codePointAt(0)!;
    const b = (u >= 0x20 && u <= 0x7e) || (u >= 0xa0 && u <= 0xff) ? u : CP1252[u] ?? (u === 9 ? 0x20 : 0x3f);
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

function wrapChars(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let cur = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (!cur) cur = word;
      else if (cur.length + 1 + word.length <= maxChars) cur += " " + word;
      else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [""];
}

/** Gera um PDF A4 limpo com o resumo organizado de todos os comentários e marcações. */
export function buildCommentsSummaryPdf(items: CommentSummaryItem[], title: string): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const fReg = doc.newDictionary();
  fReg.put("Type", doc.newName("Font")); fReg.put("Subtype", doc.newName("Type1"));
  fReg.put("BaseFont", doc.newName("Helvetica")); fReg.put("Encoding", doc.newName("WinAnsiEncoding"));
  const fRegRef = doc.addObject(fReg);
  const fBold = doc.newDictionary();
  fBold.put("Type", doc.newName("Font")); fBold.put("Subtype", doc.newName("Type1"));
  fBold.put("BaseFont", doc.newName("Helvetica-Bold")); fBold.put("Encoding", doc.newName("WinAnsiEncoding"));
  const fBoldRef = doc.addObject(fBold);

  const W = 595, H = 842, M = 48;
  const pagesOps: string[] = [];
  let ops = "";
  let y = H - M;

  const newPage = () => {
    if (ops) pagesOps.push(ops);
    ops = "";
    y = H - M;
  };
  const ensure = (need: number) => { if (y - need < M) newPage(); };
  const drawLine = (text: string, size: number, bold: boolean, x: number, gray = 0.12) => {
    ensure(size + 6);
    ops += `BT ${gray.toFixed(2)} g /${bold ? "FB" : "FR"} ${size} Tf 1 0 0 1 ${x} ${y.toFixed(1)} Tm <${winAnsiSafeHex(text)}> Tj ET\n`;
    y -= size * 1.4;
  };

  drawLine(`Resumo de comentários — ${title || "Documento"}`, 15, true, M, 0.1);
  drawLine(`Total: ${items.length} anotação(ões) · ${new Date().toLocaleDateString("pt-BR")}`, 9.5, false, M, 0.4);
  y -= 8;

  if (!items.length) {
    drawLine("Nenhuma anotação encontrada neste documento.", 11, false, M, 0.35);
  } else {
    let curPage = -1;
    for (const it of items) {
      if (it.page !== curPage) {
        curPage = it.page;
        ensure(36);
        y -= 6;
        ops += `0.85 G 0.7 w ${M} ${(y + 10).toFixed(1)} m ${W - M} ${(y + 10).toFixed(1)} l S\n`;
        drawLine(`Página ${it.pageLabel || it.page + 1}`, 12, true, M, 0.15);
      }
      const meta = [commentKindLabel(it.kind), it.author].filter(Boolean).join(" · ");
      drawLine(`• ${meta}`, 10, true, M + 4, 0.15);
      if (it.quote) {
        for (const ln of wrapChars(`“${it.quote}”`, 82)) drawLine(ln, 9.5, false, M + 16, 0.32);
      }
      if (it.contents) {
        for (const ln of wrapChars(it.contents, 84)) drawLine(ln, 10, false, M + 16, 0.1);
      }
      y -= 4;
    }
  }
  if (ops) pagesOps.push(ops);

  for (const content of pagesOps) {
    const res = doc.newDictionary();
    const fd = doc.newDictionary();
    fd.put("FR", fRegRef); fd.put("FB", fBoldRef);
    res.put("Font", fd);
    doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, res, content));
  }
  doc.setMetaData("info:Title", `Resumo de comentários — ${title || "Documento"}`);
  const buf = doc.saveToBuffer("garbage,compress,objstms");
  const out = new Uint8Array(buf.asUint8Array());
  buf.destroy(); doc.destroy();
  return out;
}
