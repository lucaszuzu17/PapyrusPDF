// Fontes instaladas no Windows, procuradas pelo nome PostScript que aparece no PDF.
// Usado na edição de texto quando a fonte embutida no documento não tem alguma letra.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { fontKey, fontStyle, isSymbolicFont } from "../engine/fontname.ts";

interface Entry { key: string; family: string; bold: boolean; italic: boolean; file: string; subfont: number }

const KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
  "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
];

const STYLE_TAIL = /\s+(bold|italic|oblique|regular|semibold|demibold|demi|black|heavy|light|extralight|ultralight|semilight|extrabold|ultrabold|medium|thin|condensed|narrow|book|roman)\b.*$/i;

let entries: Entry[] | null = null;

function pushName(list: Entry[], rawName: string, file: string, subfont: number): void {
  const n = rawName.trim();
  if (!n) return;
  const bold = /bold|black|heavy|semibold|demi/i.test(n);
  const italic = /italic|oblique/i.test(n);
  const family = n.replace(STYLE_TAIL, "").trim() || n;
  list.push({ key: fontKey(n), family: family.toLowerCase(), bold, italic, file, subfont });
}

// Nomes de arquivo curtos do Windows (usados como fallback se o `reg query` falhar/atrasar).
const KNOWN_WIN_FILES: Record<string, string> = {
  arial: "Arial", arialbd: "Arial Bold", ariali: "Arial Italic", arialbi: "Arial Bold Italic",
  calibri: "Calibri", calibrib: "Calibri Bold", calibrii: "Calibri Italic", calibriz: "Calibri Bold Italic",
  cambria: "Cambria", cambriab: "Cambria Bold", cambriai: "Cambria Italic", cambriaz: "Cambria Bold Italic",
  consola: "Consolas", consolab: "Consolas Bold", consolai: "Consolas Italic", consolaz: "Consolas Bold Italic",
  cour: "Courier New", courbd: "Courier New Bold", couri: "Courier New Italic", courbi: "Courier New Bold Italic",
  segoeui: "Segoe UI", segoeuib: "Segoe UI Bold", segoeuii: "Segoe UI Italic", segoeuiz: "Segoe UI Bold Italic",
  seguisym: "Segoe UI Symbol", seguiemj: "Segoe UI Emoji",
  times: "Times New Roman", timesbd: "Times New Roman Bold", timesi: "Times New Roman Italic", timesbi: "Times New Roman Bold Italic",
  verdana: "Verdana", verdanab: "Verdana Bold", verdanai: "Verdana Italic", verdanaz: "Verdana Bold Italic",
  tahoma: "Tahoma", tahomabd: "Tahoma Bold", georgia: "Georgia", georgiab: "Georgia Bold",
  georgiai: "Georgia Italic", georgiaz: "Georgia Bold Italic", symbol: "Symbol",
};

function scanDir(dir: string, knownFiles: Set<string>, list: Entry[], depth = 0): void {
  if (depth > 2 || !existsSync(dir)) return;
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const full = join(dir, it.name);
    if (it.isDirectory()) { scanDir(full, knownFiles, list, depth + 1); continue; }
    if (!/\.(ttf|otf|ttc)$/i.test(it.name)) continue;
    const norm = full.toLowerCase();
    if (knownFiles.has(norm)) continue;
    knownFiles.add(norm);
    const stem = basename(it.name, extname(it.name));
    const knownName = KNOWN_WIN_FILES[stem.toLowerCase()];
    if (knownName) {
      pushName(list, knownName, full, 0);
    } else {
      const st = fontStyle(stem);
      list.push({ key: fontKey(stem), family: st.family.toLowerCase(), bold: st.bold, italic: st.italic, file: full, subfont: 0 });
    }
  }
}

function load(): Entry[] {
  if (entries && entries.length > 0) return entries;
  const list: Entry[] = [];
  const knownFiles = new Set<string>();
  const fontsDir = join(process.env.WINDIR ?? "C:\\Windows", "Fonts");
  for (const key of KEYS) {
    let out = "";
    try { out = execFileSync("reg", ["query", key], { encoding: "utf8", windowsHide: true, timeout: 15000 }); } catch { continue; }
    for (const line of out.split(/\r?\n/)) {
      // "    Arial Bold (TrueType)    REG_SZ    arialbd.ttf"
      const m = /^\s{2,}(.+?)\s+REG_SZ\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const file = isAbsolute(m[2]) ? m[2] : join(fontsDir, m[2]);
      if (!/\.(ttf|otf|ttc)$/i.test(file)) continue;
      knownFiles.add(file.toLowerCase());
      const names = m[1].replace(/\s*\((TrueType|OpenType)\)\s*$/i, "").split(/\s+&\s+/);
      names.forEach((n, subfont) => pushName(list, n, file, subfont));
    }
  }
  scanDir(fontsDir, knownFiles, list, 2);
  const localApp = process.env.LOCALAPPDATA;
  if (localApp) {
    scanDir(join(localApp, "Microsoft", "Windows", "Fonts"), knownFiles, list);
    scanDir(join(localApp, "Microsoft", "FontCache", "4", "CloudFonts"), knownFiles, list);
  }
  if (list.length > 0) entries = list;
  return list;
}

const cache = new Map<string, { data: Uint8Array; subfont: number; file: string } | null>();

/**
 * Arquivo de uma fonte do Windows equivalente à do PDF ("BCDEEE+Calibri-Bold" → calibrib.ttf).
 * Procura primeiro o nome completo com estilo; depois a família com o mesmo negrito e itálico,
 * e por fim outro peso da mesma família antes de desistir.
 */
export function findSystemFont(pdfName: string): { data: Uint8Array; subfont: number; file: string } | null {
  if (process.platform !== "win32") return null;
  if (cache.has(pdfName)) return cache.get(pdfName)!;
  const list = load();
  const key = fontKey(pdfName);
  const st = fontStyle(pdfName);
  const fam = st.family.toLowerCase();
  const famTight = fam.replace(/\s/g, "");
  const wantSym = isSymbolicFont(pdfName);
  const eligible = list.filter((e) => wantSym || !isSymbolicFont(e.family));
  const hit = eligible.find((e) => e.key === key)
    ?? eligible.find((e) => e.family === fam && e.bold === st.bold && e.italic === st.italic)
    ?? eligible.find((e) => e.family.replace(/\s/g, "") === famTight && e.bold === st.bold && e.italic === st.italic)
    ?? eligible.find((e) => e.family === fam && e.bold === st.bold && !e.italic)
    ?? eligible.find((e) => e.family === fam && !e.bold && !e.italic)
    ?? eligible.find((e) => e.family.replace(/\s/g, "") === famTight && !e.bold && !e.italic);
  let found: { data: Uint8Array; subfont: number; file: string } | null = null;
  if (hit && existsSync(hit.file)) {
    try { found = { data: new Uint8Array(readFileSync(hit.file)), subfont: hit.subfont, file: hit.file }; } catch { found = null; }
  }
  cache.set(pdfName, found);
  return found;
}
