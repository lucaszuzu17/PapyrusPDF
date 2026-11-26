// Conversor leve e 100% offline de Markdown para HTML estilizado pronto para impressão em PDF.
const esc = (s: string) => s
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function inlineMd(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

export function markdownToHtml(md: string, title = "Documento"): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let inList: "ul" | "ol" | null = null;
  let inTable = false;

  const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };
  const closeTable = () => { if (inTable) { out.push("</tbody></table>"); inTable = false; } };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trimStart().startsWith("```")) {
      closeList(); closeTable();
      if (inCode) {
        out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = []; inCode = false;
      } else { inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(ln); continue; }

    if (!ln.trim()) { closeList(); closeTable(); continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(ln);
    if (h) { closeList(); closeTable(); out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); continue; }

    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(ln.trim())) { closeList(); closeTable(); out.push("<hr>"); continue; }

    const bq = /^>\s?(.*)$/.exec(ln);
    if (bq) { closeList(); closeTable(); out.push(`<blockquote>${inlineMd(bq[1])}</blockquote>`); continue; }

    // Tabela Markdown simples (| a | b |)
    if (ln.trim().startsWith("|") && ln.trim().endsWith("|")) {
      const cells = ln.trim().slice(1, -1).split("|").map((c) => c.trim());
      if (!inTable && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        closeList();
        inTable = true;
        out.push(`<table><thead><tr>${cells.map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead><tbody>`);
        i++; // pula separador
        continue;
      }
      if (inTable) {
        out.push(`<tr>${cells.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`);
        continue;
      }
    } else {
      closeTable();
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(ln);
    if (ul) {
      if (inList !== "ul") { closeList(); out.push("<ul>"); inList = "ul"; }
      out.push(`<li>${inlineMd(ul[1])}</li>`);
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(ln);
    if (ol) {
      if (inList !== "ol") { closeList(); out.push("<ol>"); inList = "ol"; }
      out.push(`<li>${inlineMd(ol[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inlineMd(ln)}</p>`);
  }
  closeList(); closeTable();
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { margin: 18mm; }
    body { font: 11pt/1.55 "Segoe UI", system-ui, sans-serif; color: #1f2328; margin: 0; }
    h1, h2, h3, h4 { color: #111; margin: 1.1em 0 0.4em; line-height: 1.25; break-after: avoid; }
    h1 { font-size: 20pt; border-bottom: 1.5px solid #d0d7de; padding-bottom: 4px; }
    h2 { font-size: 15pt; border-bottom: 1px solid #eaeef2; padding-bottom: 3px; }
    h3 { font-size: 12.5pt; }
    p { margin: 0.45em 0; }
    ul, ol { margin: 0.4em 0 0.6em; padding-left: 1.6em; }
    li { margin: 0.2em 0; }
    blockquote { margin: 0.6em 0; padding: 6px 12px; border-left: 3px solid #b5762a; background: #faf7f0; color: #444; }
    code { font: 9.5pt Consolas, "Courier New", monospace; background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
    pre { background: #f6f8fa; padding: 10px 12px; border-radius: 6px; border: 1px solid #e1e4e8; overflow-x: auto; break-inside: avoid; }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; width: 100%; margin: 0.8em 0; break-inside: avoid; }
    th, td { border: 1px solid #d0d7de; padding: 6px 9px; text-align: left; }
    th { background: #f4f1ea; font-weight: 600; }
    hr { border: 0; border-top: 1px solid #d0d7de; margin: 1em 0; }
    a { color: #0969da; text-decoration: none; }
  </style></head><body>${out.join("\n")}</body></html>`;
}
