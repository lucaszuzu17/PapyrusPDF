// Criador de formulários interativos (AcroForm) e detector heurístico offline de campos.
import * as mupdf from "mupdf";
import type { CreateFieldSpec, Rect, TextBlock } from "./types.ts";

function ensureAcroForm(doc: mupdf.PDFDocument): { acro: mupdf.PDFObject; fields: mupdf.PDFObject } {
  const root = doc.getTrailer().get("Root").resolve();
  let acro = root.get("AcroForm");
  if (!acro.isDictionary()) {
    acro = doc.newDictionary();
    root.put("AcroForm", acro);
  }
  let fields = acro.get("Fields");
  if (!fields.isArray()) {
    fields = doc.newArray();
    acro.put("Fields", fields);
  }
  // Garante /DR com Helvetica (/Helv) para que qualquer leitor renderize campos de texto
  let dr = acro.get("DR");
  if (!dr.isDictionary()) { dr = doc.newDictionary(); acro.put("DR", dr); }
  let fonts = dr.get("Font");
  if (!fonts.isDictionary()) { fonts = doc.newDictionary(); dr.put("Font", fonts); }
  if (fonts.get("Helv").isNull()) {
    const f = doc.newDictionary();
    f.put("Type", doc.newName("Font"));
    f.put("Subtype", doc.newName("Type1"));
    f.put("BaseFont", doc.newName("Helvetica"));
    f.put("Encoding", doc.newName("WinAnsiEncoding"));
    fonts.put("Helv", doc.addObject(f));
  }
  if (acro.get("DA").isNull()) acro.put("DA", doc.newString("/Helv 11 Tf 0 g"));
  acro.put("NeedAppearances", true);
  return { acro, fields };
}

function pdfRectFromPageRect(doc: mupdf.PDFDocument, pageIndex: number, rect: Rect): mupdf.PDFObject {
  const page = doc.loadPage(pageIndex);
  const inv = mupdf.Matrix.invert(page.getTransform());
  page.destroy();
  const [x0, y0, x1, y1] = mupdf.Rect.transform(rect, inv);
  const arr = doc.newArray();
  arr.push(Math.min(x0, x1));
  arr.push(Math.min(y0, y1));
  arr.push(Math.max(x0, x1));
  arr.push(Math.max(y0, y1));
  return arr;
}

/** Cria um novo campo de formulário interativo (AcroForm Widget) diretamente na página. */
export function addFormField(doc: mupdf.PDFDocument, spec: CreateFieldSpec): number {
  const { fields } = ensureAcroForm(doc);
  const pageObj = doc.findPage(spec.page);

  const w = doc.newDictionary();
  w.put("Type", doc.newName("Annot"));
  w.put("Subtype", doc.newName("Widget"));
  w.put("P", pageObj);
  w.put("T", doc.newString(spec.name.trim() || `Campo_${Date.now()}`));
  w.put("Rect", pdfRectFromPageRect(doc, spec.page, spec.rect));
  w.put("F", 4); // Print

  const bs = doc.newDictionary();
  bs.put("W", 1);
  bs.put("S", doc.newName("S"));
  w.put("BS", bs);

  const mk = doc.newDictionary();
  const bc = doc.newArray(); bc.push(0.25); bc.push(0.45); bc.push(0.75);
  const bg = doc.newArray(); bg.push(0.94); bg.push(0.97); bg.push(1.0);
  mk.put("BC", bc);
  mk.put("BG", bg);
  w.put("MK", mk);

  switch (spec.kind) {
    case "text":
      w.put("FT", doc.newName("Tx"));
      w.put("DA", doc.newString("/Helv 11 Tf 0 g"));
      if (spec.multiline) w.put("Ff", 4096); // Multiline
      if (spec.defaultValue) w.put("V", doc.newString(spec.defaultValue));
      break;
    case "checkbox":
      w.put("FT", doc.newName("Btn"));
      w.put("V", doc.newName("Off"));
      w.put("AS", doc.newName("Off"));
      break;
    case "combobox": {
      w.put("FT", doc.newName("Ch"));
      w.put("Ff", 131072); // Combo
      w.put("DA", doc.newString("/Helv 11 Tf 0 g"));
      const opt = doc.newArray();
      for (const item of spec.options?.length ? spec.options : ["Opção 1", "Opção 2"]) {
        opt.push(doc.newString(item));
      }
      w.put("Opt", opt);
      break;
    }
    case "signature":
      w.put("FT", doc.newName("Sig"));
      break;
  }

  const ref = doc.addObject(w);
  let annots = pageObj.get("Annots");
  if (!annots.isArray()) { annots = doc.newArray(); pageObj.put("Annots", annots); }
  annots.push(ref);
  fields.push(ref);
  return ref.asIndirect();
}

/** Remove um campo de formulário da página e do /AcroForm/Fields. */
export function removeFormField(doc: mupdf.PDFDocument, pageIndex: number, id: number): boolean {
  let removed = false;
  const pageObj = doc.findPage(pageIndex);
  const annots = pageObj.get("Annots");
  if (annots.isArray()) {
    for (let i = annots.length - 1; i >= 0; i--) {
      if (annots.get(i).isIndirect() && annots.get(i).asIndirect() === id) {
        annots.delete(i);
        removed = true;
      }
    }
  }
  const root = doc.getTrailer().get("Root").resolve();
  const acro = root.get("AcroForm");
  if (acro.isDictionary()) {
    const fields = acro.get("Fields");
    if (fields.isArray()) {
      for (let i = fields.length - 1; i >= 0; i--) {
        if (fields.get(i).isIndirect() && fields.get(i).asIndirect() === id) {
          fields.delete(i);
          removed = true;
        }
      }
    }
  }
  return removed;
}

function overlapsAny(r: Rect, list: Rect[]): boolean {
  for (const b of list) {
    const ix = Math.min(r[2], b[2]) - Math.max(r[0], b[0]);
    const iy = Math.min(r[3], b[3]) - Math.max(r[1], b[1]);
    if (ix > 2 && iy > 2) return true;
  }
  return false;
}

function slugFieldName(label: string, idx: number): string {
  const clean = label
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 28);
  return clean ? `${clean}_${idx}` : `Campo_${idx}`;
}

/**
 * Detecta automaticamente prováveis campos de formulário numa página estática:
 * - Linhas sublinhadas / pontilhadas (`______`, `......`) → campo de texto
 * - Caixinhas de marcação (`[ ]`, `( )`, `☐`) → caixa de seleção
 * - Rótulos terminados com `:` seguidos de espaço livre na mesma linha → campo de texto
 */
export function detectCandidateFields(
  pageIndex: number,
  pageBounds: Rect,
  blocks: TextBlock[],
  existingRects: Rect[],
): CreateFieldSpec[] {
  const found: CreateFieldSpec[] = [];
  const occupied: Rect[] = [...existingRects];
  let seq = 1;

  for (const b of blocks) {
    for (const l of b.lines) {
      const text = l.text;
      // 1. Caixas de seleção: [ ] ou ☐
      const chkRe = /\[\s*\]|\(\s*\)|☐/g;
      let m: RegExpExecArray | null;
      while ((m = chkRe.exec(text)) !== null) {
        const slice = l.chars.slice(m.index, m.index + m[0].length);
        if (!slice.length) continue;
        const x0 = Math.min(...slice.map((c) => Math.min(c.quad[0], c.quad[4])));
        const y0 = Math.min(...slice.map((c) => Math.min(c.quad[1], c.quad[3])));
        const h = Math.max(11, Math.min(18, l.bbox[3] - l.bbox[1]));
        const r: Rect = [x0, y0, x0 + h, y0 + h];
        if (!overlapsAny(r, occupied)) {
          occupied.push(r);
          const after = text.slice(m.index + m[0].length).trim().slice(0, 24);
          found.push({ page: pageIndex, kind: "checkbox", name: slugFieldName(after || "Opcao", seq++), rect: r });
        }
      }

      // 2. Linhas sublinhadas ou pontilhadas: _____ ou .....
      const lineRe = /_{4,}|\.{5,}/g;
      while ((m = lineRe.exec(text)) !== null) {
        const slice = l.chars.slice(m.index, m.index + m[0].length);
        if (!slice.length) continue;
        const x0 = Math.min(...slice.map((c) => Math.min(c.quad[0], c.quad[4])));
        const x1 = Math.max(...slice.map((c) => Math.max(c.quad[2], c.quad[6])));
        const y1 = l.bbox[3] + 1;
        const h = Math.max(14, Math.min(22, l.size * 1.45));
        const r: Rect = [x0, Math.max(pageBounds[1] + 4, y1 - h), x1, y1];
        if (x1 - x0 >= 30 && !overlapsAny(r, occupied)) {
          occupied.push(r);
          const before = text.slice(0, m.index).replace(/[:\s]+$/, "").trim();
          found.push({ page: pageIndex, kind: "text", name: slugFieldName(before || "Campo", seq++), rect: r });
        }
      }

      // 3. Rótulo terminado com ":" seguido de espaço livre à direita na mesma linha
      const trimmed = text.trim();
      if (/^[A-Za-zÀ-ÿ0-9\s/().-]{2,36}:$/.test(trimmed)) {
        const fx0 = l.bbox[2] + 6;
        // Procura se há algum outro texto na mesma linha à direita
        let rightLim = pageBounds[2] - 36;
        for (const ob of blocks) {
          for (const ol of ob.lines) {
            if (ol === l) continue;
            if (ol.bbox[1] < l.bbox[3] - 1 && ol.bbox[3] > l.bbox[1] + 1 && ol.bbox[0] > fx0) {
              rightLim = Math.min(rightLim, ol.bbox[0] - 8);
            }
          }
        }
        const w = Math.min(240, rightLim - fx0);
        const h = Math.max(15, Math.min(22, (l.bbox[3] - l.bbox[1]) + 4));
        const r: Rect = [fx0, l.bbox[1] - 2, fx0 + w, l.bbox[1] - 2 + h];
        if (w >= 65 && !overlapsAny(r, occupied)) {
          occupied.push(r);
          found.push({ page: pageIndex, kind: "text", name: slugFieldName(trimmed.slice(0, -1), seq++), rect: r });
        }
      }
    }
  }
  return found;
}
