// Comandos com formulário: proteger, comprimir, cabeçalho/rodapé, numeração,
// marca d'água, carimbos e exportação de imagens.
import { engine, type MarginPos, type RGB } from "./api.ts";
import { makeStamp, STAMP_PRESETS } from "./images.ts";
import type { useApp } from "./state.tsx";

type App = ReturnType<typeof useApp>;

const base = (a: App) => a.doc!.name.replace(/\.pdf$/i, "");
const fileName = (path: string) => path.split(/[\\/]/).pop()!;
const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const samePath = (a: string | null, b: string) => !!a && a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
const allPages = (a: App) => Array.from({ length: a.doc!.info.pageCount }, (_, i) => i);

// ---------- proteger ----------

export async function protect(a: App): Promise<void> {
  const v = await a.askForm({
    title: "Proteger com senha", okLabel: "Proteger e salvar…",
    message: "A senha passa a ser pedida para abrir o arquivo. As permissões valem para quem abrir o PDF em outros programas.",
    fields: [
      { id: "pw", label: "Senha para abrir (deixe em branco para não pedir)", type: "password", value: "", span: 3 },
      { id: "pw2", label: "Repita a senha", type: "password", value: "", span: 3 },
      { id: "print", label: "Permitir imprimir", type: "checkbox", value: true, span: 3 },
      { id: "copy", label: "Permitir copiar texto e imagens", type: "checkbox", value: true, span: 3 },
      { id: "edit", label: "Permitir alterar o conteúdo", type: "checkbox", value: true, span: 3 },
      { id: "annotate", label: "Permitir comentar e preencher", type: "checkbox", value: true, span: 3 },
    ],
    validate: (f) => {
      const pw = String(f.pw);
      if (pw !== String(f.pw2)) return "As duas senhas não são iguais.";
      if (/[,=]/.test(pw)) return "A senha não pode ter vírgula nem sinal de igual.";
      if (pw.length > 100) return "A senha pode ter no máximo 100 caracteres.";
      if (!pw && f.print && f.copy && f.edit && f.annotate) return "Defina uma senha ou desmarque pelo menos uma permissão.";
      return null;
    },
  });
  if (!v) return;
  const pw = String(v.pw);
  const path = await window.papiro.saveDialog(a.doc!.path ?? `${base(a)}_protegido.pdf`);
  if (!path) return;
  await a.task("Protegendo…", async () => {
    const bytes = await engine.exportProtected({
      userPassword: pw || undefined,
      permissions: { print: !!v.print, copy: !!v.copy, edit: !!v.edit, annotate: !!v.annotate },
    });
    try { await window.papiro.writeFile(path, bytes); } finally { await a.refresh(); }
    await a.adoptFile(path, bytes, pw);
    a.notify(pw ? `Protegido com senha e salvo em ${path}. Guarde a senha: sem ela o arquivo não abre.`
      : `Restrições aplicadas e salvas em ${path}.`);
  });
}

export async function unprotect(a: App): Promise<void> {
  const ok = await a.ask({
    kind: "confirm", title: "Remover proteção", okLabel: "Remover e salvar…",
    message: "Será gravada uma versão sem senha e sem restrições. Qualquer pessoa com o arquivo poderá abri-lo.",
  });
  if (ok === null) return;
  const path = await window.papiro.saveDialog(a.doc!.path ?? `${base(a)}_sem_senha.pdf`);
  if (!path) return;
  await a.task("Removendo proteção…", async () => {
    const bytes = await engine.exportUnprotected();
    try { await window.papiro.writeFile(path, bytes); } finally { await a.refresh(); }
    await a.adoptFile(path, bytes);
    a.notify(`Proteção removida. Salvo em ${path}.`);
  });
}

// ---------- comprimir ----------

export async function compress(a: App): Promise<void> {
  const v = await a.askForm({
    title: "Comprimir PDF", okLabel: "Comprimir e salvar…",
    message: "Reduz o tamanho das imagens e compacta o arquivo. É gravada uma cópia; o documento aberto não muda.",
    fields: [{ id: "level", label: "Compressão", type: "select", value: "media", options: [
      { value: "leve", label: "Leve — qualidade quase igual (boa para imprimir)" },
      { value: "media", label: "Média — bom equilíbrio (e-mail, arquivo)" },
      { value: "forte", label: "Forte — arquivo menor, imagens com menos detalhe" },
    ] }],
  });
  if (!v) return;
  const r = await a.task("Comprimindo…", () => engine.exportCompressed(v.level as "leve" | "media" | "forte"));
  await a.refresh();
  if (!r) return;
  if (r.after >= r.before) { a.notify(`Este PDF já está compacto (${size(r.before)}); não há o que reduzir.`); return; }
  const pct = Math.round((1 - r.after / r.before) * 100);
  const path = await window.papiro.saveDialog(`${base(a)}_comprimido.pdf`);
  if (!path) return;
  await a.task("Salvando…", async () => {
    await window.papiro.writeFile(path, r.bytes);
    // gravou por cima do arquivo aberto: passa a trabalhar na versão comprimida
    if (samePath(a.doc!.path, path)) await a.adoptFile(path, r.bytes);
    a.notify(`De ${size(r.before)} para ${size(r.after)} (−${pct}%). Salvo em ${path}.`);
  });
}

// ---------- cabeçalho, rodapé e numeração ----------

const SIZES = ["8", "9", "10", "11", "12", "14"].map((s) => ({ value: s, label: `${s} pt` }));
const TOKENS = "Marcadores: {p} número da página · {n} último número · {total} total de páginas · {data} data de hoje · {arquivo} nome do arquivo.";

export async function headerFooter(a: App): Promise<void> {
  const cell = (id: MarginPos, label: string) => ({ id, label, type: "text" as const, value: "", span: 2 as const });
  const v = await a.askForm({
    title: "Cabeçalho e rodapé", okLabel: "Aplicar", message: TOKENS,
    fields: [
      cell("tl", "Cabeçalho à esquerda"), cell("tc", "Cabeçalho no centro"), cell("tr", "Cabeçalho à direita"),
      cell("bl", "Rodapé à esquerda"), cell("bc", "Rodapé no centro"), cell("br", "Rodapé à direita"),
      { id: "size", label: "Tamanho da letra", type: "select", value: "10", options: SIZES, span: 3 },
      { id: "skip", label: "Não aplicar na primeira página (capa)", type: "checkbox", value: false, span: 3 },
    ],
    validate: (f) => ((["tl", "tc", "tr", "bl", "bc", "br"] as const).some((k) => String(f[k]).trim()) ? null : "Preencha pelo menos uma posição."),
  });
  if (!v) return;
  const items = (["tl", "tc", "tr", "bl", "bc", "br"] as MarginPos[]).map((pos) => ({ pos, text: String(v[pos]) })).filter((it) => it.text.trim());
  const skip = !!v.skip && a.doc!.info.pageCount > 1;
  await a.mutate("Aplicando…", () => engine.addHeaderFooter({
    items, size: Number(v.size), pages: skip ? allPages(a).slice(1) : undefined, startAt: skip ? 2 : 1,
  }));
}

export async function numberPages(a: App): Promise<void> {
  const v = await a.askForm({
    title: "Numerar páginas", okLabel: "Numerar",
    fields: [
      { id: "pos", label: "Posição", type: "select", value: "bc", span: 3, options: [
        { value: "bc", label: "Rodapé, no centro" }, { value: "br", label: "Rodapé, à direita" }, { value: "bl", label: "Rodapé, à esquerda" },
        { value: "tc", label: "Cabeçalho, no centro" }, { value: "tr", label: "Cabeçalho, à direita" }, { value: "tl", label: "Cabeçalho, à esquerda" },
      ] },
      { id: "fmt", label: "Formato", type: "select", value: "{p}", span: 3, options: [
        { value: "{p}", label: "1" }, { value: "Página {p}", label: "Página 1" },
        { value: "{p} / {n}", label: "1 / 10" }, { value: "Página {p} de {n}", label: "Página 1 de 10" },
      ] },
      { id: "start", label: "Primeiro número", type: "number", value: "1", span: 2 },
      { id: "size", label: "Tamanho da letra", type: "select", value: "10", options: SIZES, span: 2 },
      { id: "skip", label: "Pular a capa", type: "checkbox", value: false, span: 2 },
    ],
    validate: (f) => (/^\d{1,6}$/.test(String(f.start).trim()) ? null : "O primeiro número deve ser um inteiro (0 ou mais)."),
  });
  if (!v) return;
  const skip = !!v.skip && a.doc!.info.pageCount > 1;
  const start = Number(String(v.start).trim());
  await a.mutate("Numerando…", () => engine.addHeaderFooter({
    items: [{ pos: v.pos as MarginPos, text: String(v.fmt) }], size: Number(v.size),
    pages: skip ? allPages(a).slice(1) : undefined, startAt: skip ? start + 1 : start,
  }));
}

// ---------- marca d'água ----------

const WM_COLORS: Record<string, RGB> = { cinza: [0.55, 0.55, 0.55], vermelho: [0.85, 0.1, 0.1], azul: [0.1, 0.3, 0.8] };

export async function watermark(a: App): Promise<void> {
  const v = await a.askForm({
    title: "Marca d'água", okLabel: "Aplicar em todas as páginas",
    fields: [
      { id: "text", label: "Texto", type: "text", value: "CONFIDENCIAL" },
      { id: "angle", label: "Direção", type: "select", value: "45", span: 3, options: [{ value: "45", label: "Diagonal" }, { value: "0", label: "Horizontal" }] },
      { id: "opacity", label: "Intensidade", type: "select", value: "0.18", span: 3, options: [
        { value: "0.1", label: "Bem leve" }, { value: "0.18", label: "Leve" }, { value: "0.3", label: "Média" }, { value: "0.5", label: "Forte" },
      ] },
      { id: "color", label: "Cor", type: "select", value: "cinza", span: 3, options: [
        { value: "cinza", label: "Cinza" }, { value: "vermelho", label: "Vermelho" }, { value: "azul", label: "Azul" },
      ] },
      { id: "layer", label: "Posição", type: "select", value: "over", span: 3, options: [
        { value: "over", label: "Por cima do conteúdo" }, { value: "behind", label: "Por baixo (some sob imagens)" },
      ] },
    ],
    validate: (f) => (String(f.text).trim() ? null : "Digite o texto da marca d'água."),
  });
  if (!v) return;
  await a.mutate("Aplicando marca d'água…", () => engine.addWatermark({
    text: String(v.text).trim(), angle: Number(v.angle), opacity: Number(v.opacity),
    color: WM_COLORS[String(v.color)] ?? WM_COLORS.cinza, behind: v.layer === "behind",
  }));
}

// ---------- carimbos ----------

const STAMP_NAME = "papiro.stampName";

export async function chooseStamp(a: App): Promise<void> {
  let name = "";
  try { name = localStorage.getItem(STAMP_NAME) ?? ""; } catch { /* sem armazenamento */ }
  const v = await a.askForm({
    title: "Carimbo", okLabel: "Usar carimbo",
    message: "Depois de escolher, clique na página onde o carimbo deve ficar.",
    fields: [
      { id: "preset", label: "Modelo", type: "select", value: "aprovado", span: 3,
        options: [...STAMP_PRESETS.map((p) => ({ value: p.id, label: p.text })), { value: "custom", label: "Outro texto…" }] },
      { id: "custom", label: "Texto do carimbo", type: "text", value: "", span: 3, showIf: (f) => f.preset === "custom" },
      { id: "date", label: "Incluir a data de hoje", type: "checkbox", value: true, span: 3 },
      { id: "name", label: "Nome (opcional)", type: "text", value: name, span: 3, placeholder: "ex.: Maria Silva" },
    ],
    validate: (f) => (f.preset === "custom" && !String(f.custom).trim() ? "Digite o texto do carimbo." : null),
  });
  if (!v) return;
  const preset = STAMP_PRESETS.find((p) => p.id === v.preset);
  const text = (preset?.text ?? String(v.custom).trim()).toLocaleUpperCase("pt-BR").slice(0, 40);
  const who = String(v.name).trim();
  try { localStorage.setItem(STAMP_NAME, who); } catch { /* sem armazenamento */ }
  const sub = [v.date ? new Date().toLocaleDateString("pt-BR") : "", who].filter(Boolean).join(" · ");
  a.setStamp(makeStamp(text, preset?.color ?? "#1f5fbf", sub));
  a.setView("read");
  a.setTool("stamp");
}

// ---------- exportar páginas como imagem ----------

export async function exportImages(a: App): Promise<void> {
  const n = a.doc!.info.pageCount;
  const sel = a.view === "organize" && a.selectedPages.length ? [...a.selectedPages].sort((x, y) => x - y) : null;
  const v = await a.askForm({
    title: "Exportar como imagem", okLabel: "Exportar…",
    fields: [
      { id: "which", label: "Páginas", type: "select", value: sel ? "sel" : "cur", options: [
        { value: "cur", label: `Página atual (${a.page + 1})` },
        ...(sel ? [{ value: "sel", label: `Páginas selecionadas (${sel.length})` }] : []),
        ...(n > 1 ? [{ value: "all", label: `Todas as ${n} páginas (um arquivo por página)` }] : []),
      ] },
      { id: "fmt", label: "Formato", type: "select", value: "png", span: 3, options: [
        { value: "png", label: "PNG (texto nítido)" }, { value: "jpg", label: "JPEG (menor, bom para fotos)" },
      ] },
      { id: "dpi", label: "Resolução", type: "select", value: "150", span: 3, options: [
        { value: "96", label: "96 dpi (tela)" }, { value: "150", label: "150 dpi (boa)" }, { value: "300", label: "300 dpi (impressão)" },
      ] },
    ],
  });
  if (!v) return;
  const fmt = v.fmt as "png" | "jpg", dpi = Number(v.dpi);
  const pages = v.which === "all" ? allPages(a) : v.which === "sel" && sel ? sel : [a.page];
  if (pages.length === 1) {
    const path = await window.papiro.saveDialog(`${base(a)}_p${pages[0] + 1}.${fmt}`, fmt);
    if (!path) return;
    await a.task("Exportando…", async () => {
      await window.papiro.writeFile(path, await engine.pageImage(pages[0], dpi, fmt));
      a.notify(`Página ${pages[0] + 1} salva em ${path}`);
    });
    return;
  }
  const dir = await window.papiro.folderDialog();
  if (!dir) return;
  await a.task("Exportando imagens…", async () => {
    const out = await engine.exportImages(dir, base(a), pages, dpi, fmt);
    a.notify(`${out.length} imagens gravadas em ${dir} (${fileName(out[0])} …)`);
  });
}
