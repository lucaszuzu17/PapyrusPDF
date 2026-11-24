// Comandos com formulário: proteger, comprimir, cabeçalho/rodapé, numeração,
// marca d'água, carimbos e exportação de imagens.
import { engine, type BatchAction, type MarginPos, type RGB } from "./api.ts";
import { makeStamp, prepareImages, STAMP_PRESETS } from "./images.ts";
import { generatePassword, passwordStrength } from "./password.ts";
import { OCR_LANGS, type ReadMode, type useApp } from "./state.tsx";

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
      { id: "pw", label: "Senha para abrir (em branco = não pede)", type: "password", value: "", span: 3,
        action: {
          label: "Gerar senha forte", reveal: true,
          run: (cur) => {
            const g = generatePassword();
            navigator.clipboard.writeText(g).catch(() => {});
            return { ...cur, pw: g, pw2: g, gen: g };
          },
        },
        note: (cur) => {
          const pw = String(cur.pw);
          if (!pw) return null;
          const st = passwordStrength(pw);
          return { text: `${st.label}. ${st.hint}`, level: st.score };
        } },
      { id: "pw2", label: "Repita a senha", type: "password", value: "", span: 3,
        note: (cur) => (cur.gen && cur.gen === cur.pw && cur.pw === cur.pw2
          ? { text: "Senha gerada e copiada para a área de transferência: guarde-a num lugar seguro." } : null) },
      { id: "print", label: "Permitir imprimir", type: "checkbox", value: true, span: 3 },
      { id: "copy", label: "Permitir copiar texto e imagens", type: "checkbox", value: true, span: 3 },
      { id: "edit", label: "Permitir alterar o conteúdo", type: "checkbox", value: true, span: 3 },
      { id: "annotate", label: "Permitir comentar e preencher", type: "checkbox", value: true, span: 3 },
      { id: "recipient", label: "Cópia para (opcional): o nome vira marca d'água e rodapé em todas as páginas", type: "text", value: "",
        placeholder: "Ex.: João Silva — Construtora Exemplo",
        note: (cur) => (String(cur.recipient).trim() ? { text: "Grava uma cópia marcada; o documento aberto continua sem a marca." } : null) },
      { id: "img", label: "Páginas como imagem", type: "select", value: "0", options: [
        { value: "0", label: "Não — o texto continua selecionável e pesquisável" },
        { value: "150", label: "Sim, 150 dpi — dificulta copiar e editar o texto" },
        { value: "200", label: "Sim, 200 dpi — idem, com melhor qualidade de impressão" },
      ], note: (cur) => (cur.img !== "0" ? { text: "Na cópia, o texto vira parte da imagem: não dá mais para selecionar, pesquisar nem editar. A marca do destinatário também fica presa na imagem." } : null) },
    ],
    validate: (f) => {
      const pw = String(f.pw);
      if (pw !== String(f.pw2)) return "As duas senhas não são iguais.";
      if (/[,=]/.test(pw)) return "A senha não pode ter vírgula nem sinal de igual.";
      if (pw.length > 100) return "A senha pode ter no máximo 100 caracteres.";
      const copy = String(f.recipient).trim() || f.img !== "0";
      if (!pw && !copy && f.print && f.copy && f.edit && f.annotate) return "Defina uma senha ou desmarque pelo menos uma permissão.";
      if (String(f.recipient).length > 60) return "O nome do destinatário pode ter no máximo 60 caracteres.";
      return null;
    },
  });
  if (!v) return;
  const pw = String(v.pw);
  const recipient = String(v.recipient).trim();
  const imageOnly = Number(v.img) || 0;
  const copyOnly = !!recipient || imageOnly > 0;
  const slug = recipient.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  const suggested = copyOnly ? `${base(a)}_${slug || "imagem"}.pdf` : a.doc!.path ?? `${base(a)}_protegido.pdf`;
  const path = await window.papiro.saveDialog(suggested);
  if (!path) return;
  if (copyOnly && samePath(a.doc!.path, path)) { a.notify("Escolha outro nome: a cópia não pode substituir o arquivo aberto."); return; }
  await a.task(copyOnly ? "Gerando a cópia…" : "Protegendo…", async () => {
    const bytes = await engine.exportProtected({
      userPassword: pw || undefined,
      permissions: { print: !!v.print, copy: !!v.copy, edit: !!v.edit, annotate: !!v.annotate },
      recipient: recipient || undefined,
      imageOnly,
    });
    try { await window.papiro.writeFile(path, bytes); } finally { await a.refresh(); }
    if (copyOnly) {
      // cópia para outra pessoa: o original continua aberto, sem a marca
      a.notify(`${recipient ? `Cópia para ${recipient}` : "Cópia em imagem"} salva em ${path}${pw ? " (com senha)" : ""}. O documento aberto não mudou.`);
      return;
    }
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

// ---------- converter ----------

/** Converte o documento para Word (.docx): texto com fonte, tamanho e cor, parágrafos e imagens. */
export async function toWord(a: App): Promise<void> {
  if (a.scanned.length === a.doc!.info.pageCount) {
    const ok = await a.ask({
      kind: "confirm", title: "Converter para Word", okLabel: "Converter assim mesmo",
      message: "Este documento parece escaneado: no Word, cada página vira uma imagem. Para ter texto editável, use antes Reconhecer texto (OCR).",
    });
    if (ok === null) return;
  }
  const path = await window.papiro.saveDialog(`${base(a)}.docx`, "docx");
  if (!path) return;
  await a.task("Convertendo para Word…", async () => {
    const bytes = await engine.saveDocx(path);
    a.notify(`Documento do Word salvo em ${path} (${size(bytes)}).`);
  });
}

/** Converte o documento para texto puro (.txt). */
export async function toText(a: App): Promise<void> {
  const path = await window.papiro.saveDialog(`${base(a)}.txt`, "txt");
  if (!path) return;
  await a.task("Convertendo para texto…", async () => {
    const chars = await engine.saveText(path);
    a.notify(chars > 2 ? `Texto salvo em ${path}.` : `Arquivo salvo em ${path}, mas o documento quase não tem texto (é escaneado? use o OCR antes).`);
  });
}

// ---------- remover marca d'água ----------

/** Tira as marcas d'água reconhecidas de todas as páginas (dá para desfazer). */
export async function removeWatermarks(a: App): Promise<void> {
  const r = await a.task("Procurando marcas d'água…", () => engine.removeWatermarks());
  if (!r) return;
  if (!r.removed) {
    a.notify("Nenhuma marca d'água reconhecida. Se for um carimbo, clique nele com Selecionar e exclua; se fizer parte de uma página escaneada, cubra com a redação.");
    return;
  }
  await a.mutate("…", async () => r.info);
  a.notify(`Marca d'água removida de ${r.pages} página(s). Ctrl+Z desfaz.`);
}

// ---------- planilha CSV ----------

/** Extrai tabelas e dados tabulares para CSV (separador `;`, pronto para abrir no Excel). */
export async function toCsv(a: App): Promise<void> {
  const path = await window.papiro.saveDialog(`${base(a)}.csv`, "csv");
  if (!path) return;
  await a.task("Extraindo planilha…", async () => {
    const chars = await engine.saveCsv(path);
    a.notify(chars > 2 ? `Planilha CSV salva em ${path}.` : `Arquivo salvo em ${path}, mas quase não há texto (use OCR antes se for escaneado).`);
  });
}

// ---------- imagem sobre a página ----------

/** Escolhe uma imagem (logo, foto, selo) para colar diretamente sobre uma página existente. */
export async function chooseOverlayImage(a: App): Promise<void> {
  const [f] = await window.papiro.openDialog({ title: "Escolher imagem para inserir na página", images: true });
  if (!f) return;
  await a.task("Preparando imagem…", async () => {
    const [bytes] = await prepareImages([f]);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const img = new Image();
    img.src = url;
    try { await img.decode(); } finally { URL.revokeObjectURL(url); }
    a.setOverlayImg({ bytes, width: img.naturalWidth || 200, height: img.naturalHeight || 200, name: f.name });
    a.setView("read");
    a.setTool("overlayimg");
    a.notify(`Imagem “${f.name}” pronta: clique ou arraste na página para posicionar.`);
  });
}

// ---------- recortar e padronizar páginas ----------

const MM_TO_PT = 72 / 25.4;

export async function cropPages(a: App): Promise<void> {
  const sel = a.view === "organize" && a.selectedPages.length ? [...a.selectedPages].sort((x, y) => x - y) : null;
  const n = a.doc!.info.pageCount;
  const v = await a.askForm({
    title: "Recortar margens da página", okLabel: "Recortar",
    message: "Informe quanto cortar de cada borda (em milímetros). Ideal para remover bordas pretas de digitalizações. Ctrl+Z desfaz.",
    fields: [
      { id: "which", label: "Aplicar em", type: "select", value: sel ? "sel" : "cur", options: [
        { value: "cur", label: `Página atual (${a.page + 1})` },
        ...(sel ? [{ value: "sel", label: `Páginas selecionadas (${sel.length})` }] : []),
        ...(n > 1 ? [{ value: "all", label: `Todas as ${n} páginas` }] : []),
      ] },
      { id: "top", label: "Topo (mm)", type: "number", value: "10", span: 3 },
      { id: "bottom", label: "Base (mm)", type: "number", value: "10", span: 3 },
      { id: "left", label: "Esquerda (mm)", type: "number", value: "10", span: 3 },
      { id: "right", label: "Direita (mm)", type: "number", value: "10", span: 3 },
    ],
    validate: (f) => {
      const vals = ["top", "bottom", "left", "right"].map((k) => Number(String(f[k]).replace(",", ".")));
      if (vals.some((x) => Number.isNaN(x) || x < 0 || x > 200)) return "Informe valores entre 0 e 200 mm.";
      if (vals.every((x) => x === 0)) return "Informe pelo menos uma margem maior que zero.";
      return null;
    },
  });
  if (!v) return;
  const pages = v.which === "all" ? allPages(a) : v.which === "sel" && sel ? sel : [a.page];
  const mm = (k: string) => Number(String(v[k]).replace(",", ".")) * MM_TO_PT;
  const ok = await a.mutate("Recortando…", () => engine.cropPages(pages, {
    top: mm("top"), right: mm("right"), bottom: mm("bottom"), left: mm("left"),
  }));
  if (ok) a.notify(`Recorte aplicado em ${pages.length} página(s). Ctrl+Z desfaz.`);
}

export async function normalizeSizes(a: App): Promise<void> {
  const sel = a.view === "organize" && a.selectedPages.length ? [...a.selectedPages].sort((x, y) => x - y) : null;
  const n = a.doc!.info.pageCount;
  const v = await a.askForm({
    title: "Padronizar tamanho das páginas", okLabel: "Padronizar",
    message: "Ajusta e centraliza o conteúdo mantendo a orientação (retrato ou paisagem) de cada página.",
    fields: [
      { id: "target", label: "Tamanho padrão", type: "select", value: "A4", span: 3, options: [
        { value: "A4", label: "A4 (210 × 297 mm)" },
        { value: "Carta", label: "Carta (216 × 279 mm)" },
      ] },
      { id: "which", label: "Aplicar em", type: "select", value: "all", span: 3, options: [
        { value: "all", label: `Todas as ${n} páginas` },
        ...(sel ? [{ value: "sel", label: `Selecionadas (${sel.length})` }] : []),
        { value: "cur", label: `Apenas página ${a.page + 1}` },
      ] },
    ],
  });
  if (!v) return;
  const pages = v.which === "cur" ? [a.page] : v.which === "sel" && sel ? sel : allPages(a);
  const target = v.target as "A4" | "Carta";
  const ok = await a.mutate("Padronizando páginas…", () => engine.normalizePageSizes(pages, target));
  if (ok) a.notify(`${pages.length} página(s) padronizada(s) para ${target}. Ctrl+Z desfaz.`);
}

// ---------- achatar e limpar metadados ----------

export async function flattenPdf(a: App): Promise<void> {
  const ok = await a.ask({
    kind: "confirm", title: "Achatar PDF", okLabel: "Achatar",
    message: "Transforma todas as anotações, assinaturas, carimbos e campos preenchidos em conteúdo fixo da página. Eles não poderão mais ser movidos ou editados como anotações (Ctrl+Z desfaz antes de salvar).",
  });
  if (ok === null) return;
  const r = await a.task("Achatando PDF…", () => engine.flatten());
  if (!r) return;
  if (!r.count) { a.notify("Não há anotações nem campos de formulário para achatar."); return; }
  await a.mutate("…", async () => r.info);
  a.notify(`${r.count} anotação(ões)/campo(s) achatado(s) no conteúdo da página.`);
}

export async function sanitizeMetadata(a: App): Promise<void> {
  const ok = await a.ask({
    kind: "confirm", title: "Limpar metadados ocultos", okLabel: "Limpar metadados",
    message: "Remove autor, programa criador, datas, assunto, palavras-chave e fluxos XML (XMP) ocultos do PDF antes de compartilhar.",
  });
  if (ok === null) return;
  const r = await a.task("Limpando metadados…", () => engine.sanitizeMetadata());
  if (!r) return;
  await a.mutate("…", async () => r.info);
  a.notify(r.removed ? `${r.removed} item(ns) de metadados removidos. Salve para gravar o arquivo limpo.` : "O documento já não continha metadados ocultos.");
}

// ---------- comparar dois PDFs ----------

export async function comparePdf(a: App): Promise<void> {
  const [f] = await window.papiro.openDialog({ title: "Escolher o segundo PDF para comparar" });
  if (!f) return;
  const report = await a.task(`Comparando com ${f.name}…`, () => engine.comparePdf(f.bytes, f.name));
  if (report) a.setCompareReport(report);
}

// ---------- ações em lote ----------

export async function batchProcess(a: App): Promise<void> {
  const files = await window.papiro.openDialog({ title: "Escolher os PDFs para processar em lote", multi: true });
  if (!files.length) return;
  const paths = files.map((f) => f.path).filter((p): p is string => !!p);
  if (!paths.length) { a.notify("Selecione arquivos PDF salvos no disco."); return; }
  const v = await a.askForm({
    title: `Ações em lote (${paths.length} arquivo${paths.length > 1 ? "s" : ""})`,
    okLabel: "Escolher pasta e executar…",
    message: "Os arquivos originais não são sobrescritos: cada PDF processado será salvo na pasta de destino escolhida.",
    fields: [
      { id: "kind", label: "Ação", type: "select", value: "compress", options: [
        { value: "compress", label: "Comprimir PDFs" },
        { value: "watermark", label: "Adicionar marca d'água" },
        { value: "number", label: "Numerar páginas" },
        { value: "sanitize", label: "Limpar metadados ocultos" },
        { value: "flatten", label: "Achatar anotações e formulários" },
        { value: "ocr", label: "Reconhecer texto (OCR nas páginas escaneadas)" },
      ] },
      { id: "level", label: "Nível de compressão", type: "select", value: "media", showIf: (f) => f.kind === "compress", options: [
        { value: "leve", label: "Leve" }, { value: "media", label: "Média" }, { value: "forte", label: "Forte" },
      ] },
      { id: "wmText", label: "Texto da marca d'água", type: "text", value: "CONFIDENCIAL", showIf: (f) => f.kind === "watermark" },
      { id: "numFmt", label: "Formato da numeração", type: "select", value: "Página {p} de {n}", showIf: (f) => f.kind === "number", options: [
        { value: "{p}", label: "1" }, { value: "Página {p}", label: "Página 1" }, { value: "Página {p} de {n}", label: "Página 1 de 10" },
      ] },
      { id: "langs", label: "Idioma do OCR", type: "select", value: a.ocrLang, showIf: (f) => f.kind === "ocr", options: OCR_LANGS },
    ],
    validate: (f) => (f.kind === "watermark" && !String(f.wmText).trim() ? "Digite o texto da marca d'água." : null),
  });
  if (!v) return;
  const outDir = await window.papiro.folderDialog();
  if (!outDir) return;
  let action: BatchAction;
  switch (v.kind) {
    case "compress": action = { kind: "compress", level: v.level as "leve" | "media" | "forte" }; break;
    case "watermark": action = { kind: "watermark", text: String(v.wmText).trim() }; break;
    case "number": action = { kind: "number", fmt: String(v.numFmt), pos: "bc" }; break;
    case "sanitize": action = { kind: "sanitize" }; break;
    case "flatten": action = { kind: "flatten" }; break;
    default: action = { kind: "ocr", langs: String(v.langs) }; break;
  }
  const r = await a.task(`Processando ${paths.length} arquivo(s)…`, () => engine.batchProcess(paths, outDir, action));
  if (!r) return;
  const errNote = r.failed.length ? ` (${r.failed.length} falhou: ${r.failed[0].file} — ${r.failed[0].error})` : "";
  a.notify(`Lote concluído: ${r.processed}/${paths.length} arquivo(s) gravado(s) em ${outDir}${errNote}.`);
}

// ---------- modo leitura ----------

const MODES: ReadMode[] = ["normal", "sepia", "dark"];
const MODE_LABEL: Record<ReadMode, string> = { normal: "Normal", sepia: "Sépia", dark: "Noturno" };

export function cycleReadMode(a: App): void {
  const next = MODES[(MODES.indexOf(a.readMode) + 1) % MODES.length];
  a.setReadMode(next);
  a.notify(`Modo leitura: ${MODE_LABEL[next]}.`);
}
