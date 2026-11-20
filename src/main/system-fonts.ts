// Fontes instaladas no Windows, procuradas pelo nome PostScript que aparece no PDF.
// Usado na edição de texto quando a fonte embutida no documento não tem alguma letra.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fontKey, fontStyle } from "../engine/fontname.ts";

interface Entry { key: string; family: string; bold: boolean; italic: boolean; file: string; subfont: number }

const KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
  "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
];

let entries: Entry[] | null = null;

function load(): Entry[] {
  if (entries) return entries;
  entries = [];
  const fontsDir = join(process.env.WINDIR ?? "C:\\Windows", "Fonts");
  for (const key of KEYS) {
    let out = "";
    try { out = execFileSync("reg", ["query", key], { encoding: "utf8", windowsHide: true, timeout: 5000 }); } catch { continue; }
    for (const line of out.split(/\r?\n/)) {
      // "    Arial Bold (TrueType)    REG_SZ    arialbd.ttf"
      const m = /^\s{2,}(.+?)\s+REG_SZ\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const file = isAbsolute(m[2]) ? m[2] : join(fontsDir, m[2]);
      if (!/\.(ttf|otf|ttc)$/i.test(file)) continue;
      const names = m[1].replace(/\s*\((TrueType|OpenType)\)\s*$/i, "").split(/\s+&\s+/);
      names.forEach((n, subfont) => {
        const bold = /bold|black|heavy|semibold|demi/i.test(n), italic = /italic|oblique/i.test(n);
        const family = n.replace(/\s+(bold|italic|oblique|regular|semibold|black|light|demibold)\b.*$/i, "").trim();
        entries!.push({ key: fontKey(n), family: family.toLowerCase(), bold, italic, file, subfont });
      });
    }
  }
  return entries;
}

const cache = new Map<string, { data: Uint8Array; subfont: number; file: string } | null>();

/**
 * Arquivo de uma fonte do Windows equivalente à do PDF ("BCDEEE+Calibri-Bold" → calibrib.ttf).
 * Procura primeiro o nome completo com estilo; depois a família com o mesmo negrito e itálico.
 */
export function findSystemFont(pdfName: string): { data: Uint8Array; subfont: number; file: string } | null {
  if (process.platform !== "win32") return null;
  if (cache.has(pdfName)) return cache.get(pdfName)!;
  const list = load();
  const key = fontKey(pdfName);
  const st = fontStyle(pdfName);
  const fam = st.family.toLowerCase();
  const hit = list.find((e) => e.key === key)
    ?? list.find((e) => e.family === fam && e.bold === st.bold && e.italic === st.italic)
    ?? list.find((e) => e.family.replace(/\s/g, "") === fam.replace(/\s/g, "") && e.bold === st.bold && e.italic === st.italic);
  let found: { data: Uint8Array; subfont: number; file: string } | null = null;
  if (hit && existsSync(hit.file)) {
    try { found = { data: new Uint8Array(readFileSync(hit.file)), subfont: hit.subfont, file: hit.file }; } catch { found = null; }
  }
  cache.set(pdfName, found);
  return found;
}
