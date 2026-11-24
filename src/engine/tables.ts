// Extração de tabelas/dados tabulares de páginas PDF para CSV compatível com Excel (pt-BR).
import type { Quad, TextBlock } from "./types.ts";

interface Span {
  x0: number;
  x1: number;
  y: number;
  size: number;
  text: string;
}

function quadX(q: Quad): [number, number] {
  const xs = [q[0], q[2], q[4], q[6]];
  return [Math.min(...xs), Math.max(...xs)];
}

/** Quebra linhas de texto em trechos horizontais separados por lacunas maiores que um espaço comum. */
function extractSpans(blocks: TextBlock[]): Span[] {
  const spans: Span[] = [];
  for (const b of blocks) {
    for (const l of b.lines) {
      const gap = Math.max(6, l.size * 0.9);
      let curText = "";
      let x0 = 0;
      let x1 = 0;
      let prevX1 = -Infinity;
      const flush = () => {
        const t = curText.trim();
        if (t) spans.push({ x0, x1, y: l.origin[1], size: l.size || 10, text: t });
        curText = "";
      };
      for (const ch of l.chars) {
        const [cx0, cx1] = quadX(ch.quad);
        if (curText && ch.c.trim() && cx0 - prevX1 > gap) flush();
        if (!curText) {
          if (!ch.c.trim()) { prevX1 = cx1; continue; }
          x0 = cx0;
        }
        curText += ch.c;
        if (ch.c.trim()) x1 = cx1;
        prevX1 = cx1;
      }
      flush();
    }
  }
  return spans;
}

/** Agrupa trechos em linhas visuais (mesma linha de base) e alinha colunas recorrentes na página. */
export function pageRows(blocks: TextBlock[]): string[][] {
  const spans = extractSpans(blocks);
  if (!spans.length) return [];
  spans.sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x0 - b.x0));

  // Agrupa por coordenada Y com tolerância proporcional ao tamanho da fonte
  const rows: { y: number; items: Span[] }[] = [];
  for (const sp of spans) {
    const tol = Math.max(3, sp.size * 0.45);
    const last = rows[rows.length - 1];
    if (last && Math.abs(sp.y - last.y) <= tol) {
      last.items.push(sp);
    } else {
      rows.push({ y: sp.y, items: [sp] });
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x0 - b.x0);

  // Descobre âncoras de coluna (x0) a partir das linhas com 2+ células
  const multi = rows.filter((r) => r.items.length >= 2);
  if (!multi.length) return rows.map((r) => [r.items.map((i) => i.text).join(" ")]);

  const xs = multi.flatMap((r) => r.items.map((i) => i.x0)).sort((a, b) => a - b);
  const cols: number[] = [];
  for (const x of xs) {
    if (!cols.length || x - cols[cols.length - 1] > 18) cols.push(x);
  }

  return rows.map((r) => {
    if (r.items.length === 1) {
      // Linha simples (título/parágrafo): coloca na coluna mais próxima
      const idx = nearestCol(cols, r.items[0].x0);
      const out = Array<string>(idx + 1).fill("");
      out[idx] = r.items[0].text;
      return out;
    }
    const cells = Array<string>(cols.length).fill("");
    for (const it of r.items) {
      const idx = nearestCol(cols, it.x0);
      cells[idx] = cells[idx] ? `${cells[idx]} ${it.text}` : it.text;
    }
    while (cells.length > 1 && !cells[cells.length - 1]) cells.pop();
    return cells;
  });
}

function nearestCol(cols: number[], x: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < cols.length; i++) {
    const d = Math.abs(cols[i] - x);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function csvCell(v: string): string {
  const s = v.replace(/\r?\n/g, " ");
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Gera CSV com separador `;` (padrão Excel pt-BR) a partir das páginas do documento. */
export function buildCsv(pages: TextBlock[][]): string {
  const out: string[] = [];
  pages.forEach((blocks, idx) => {
    const rows = pageRows(blocks);
    if (!rows.length) return;
    if (pages.length > 1) out.push(csvCell(`--- Página ${idx + 1} ---`));
    for (const r of rows) out.push(r.map(csvCell).join(";"));
    if (pages.length > 1) out.push("");
  });
  return out.join("\r\n") + "\r\n";
}
