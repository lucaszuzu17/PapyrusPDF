// Faixa de opções declarativa: abas → grupos → comandos.
import { useState } from "react";
import { engine } from "./api.ts";
import * as feat from "./features.ts";
import { Icon } from "./icons.tsx";
import { OCR_LANGS, useApp, type RGB, type Tool } from "./state.tsx";

type App = ReturnType<typeof useApp>;

interface Cmd {
  id: string;
  label: string;
  icon: string;
  tool?: Tool;
  run?: (a: App) => unknown;
  needsDoc?: boolean;
  enabled?: (a: App) => boolean;
  /** Botão de liga/desliga: aparece marcado quando devolve true. */
  on?: (a: App) => boolean;
  title?: string;
}
interface Group { label: string; cmds: (Cmd | "color" | "ocrlang")[] }
interface Tab { id: string; label: string; groups: Group[] }

/** Páginas-alvo das ações de organizar: seleção do organizador, senão a página atual. */
const targets = (a: App) => (a.view === "organize" && a.selectedPages.length ? a.selectedPages : [a.page]);

const TABS: Tab[] = [
  {
    id: "home", label: "Início", groups: [
      { label: "Arquivo", cmds: [
        { id: "open", label: "Abrir", icon: "open", run: (a) => a.openFile(), title: "Abrir PDF (Ctrl+O)" },
        { id: "save", label: "Salvar", icon: "save", needsDoc: true, run: (a) => a.save(), title: "Salvar (Ctrl+S)" },
        { id: "saveAs", label: "Salvar como", icon: "saveAs", needsDoc: true, run: (a) => a.save(true), title: "Salvar como (Ctrl+Shift+S)" },
        { id: "print", label: "Imprimir", icon: "print", needsDoc: true, run: (a) => a.printDoc(), title: "Imprimir (Ctrl+P)" },
      ] },
      { label: "Criar", cmds: [
        { id: "merge", label: "Combinar", icon: "merge", run: (a) => a.mergeFiles(), title: "Combinar vários PDFs em um" },
        { id: "fromImg", label: "De imagens", icon: "image", run: (a) => a.newFromImages(), title: "Criar um PDF a partir de fotos ou imagens" },
      ] },
      { label: "Exportar", cmds: [
        { id: "compress", label: "Comprimir", icon: "compress", needsDoc: true, run: feat.compress, title: "Gravar uma cópia menor (reduz as imagens)" },
      ] },
      { label: "Ferramentas", cmds: [
        { id: "select", label: "Selecionar", icon: "select", tool: "select", needsDoc: true },
        { id: "hand", label: "Mão", icon: "hand", tool: "hand", needsDoc: true },
      ] },
      { label: "Exibir", cmds: [
        { id: "zoomOut", label: "Reduzir", icon: "zoomOut", needsDoc: true, run: (a) => a.setZoom((z) => z / 1.2) },
        { id: "zoomIn", label: "Ampliar", icon: "zoomIn", needsDoc: true, run: (a) => a.setZoom((z) => z * 1.2) },
        { id: "fit", label: "Ajustar largura", icon: "fitWidth", needsDoc: true, run: (a) => a.fitWidth() },
        { id: "two", label: "Duas páginas", icon: "twoPages", needsDoc: true, on: (a) => a.layout === "double",
          run: (a) => a.setLayout(a.layout === "double" ? "single" : "double"), title: "Mostrar duas páginas lado a lado" },
        { id: "full", label: "Tela cheia", icon: "fullscreen", needsDoc: true, run: (a) => a.toggleFullScreen(true), title: "Só o documento na tela (F11; Esc sai)" },
      ] },
      { label: "Histórico", cmds: [
        { id: "undo", label: "Desfazer", icon: "undo", needsDoc: true, enabled: (a) => !!a.doc?.info.canUndo, run: (a) => a.undo(), title: "Desfazer (Ctrl+Z)" },
        { id: "redo", label: "Refazer", icon: "redo", needsDoc: true, enabled: (a) => !!a.doc?.info.canRedo, run: (a) => a.redo(), title: "Refazer (Ctrl+Y)" },
      ] },
    ],
  },
  {
    id: "convert", label: "Converter", groups: [
      { label: "Do PDF para", cmds: [
        { id: "toWord", label: "Word", icon: "toWord", needsDoc: true, run: feat.toWord, title: "Documento do Word (.docx) com texto, formatação e imagens" },
        { id: "toText", label: "Texto", icon: "toText", needsDoc: true, run: feat.toText, title: "Arquivo de texto (.txt) com o texto de todas as páginas" },
        { id: "toImg2", label: "Imagem", icon: "imageOut", needsDoc: true, run: feat.exportImages, title: "Salvar páginas como PNG ou JPEG" },
      ] },
      { label: "Para PDF", cmds: [
        { id: "fromImg2", label: "De imagens", icon: "image", run: (a) => a.newFromImages(), title: "Criar um PDF a partir de fotos ou imagens" },
        { id: "merge2", label: "Combinar", icon: "merge", run: (a) => a.mergeFiles(), title: "Combinar vários PDFs em um" },
      ] },
    ],
  },
  {
    id: "comment", label: "Comentar", groups: [
      { label: "Marcar texto", cmds: [
        { id: "hl", label: "Realçar", icon: "highlight", tool: "highlight", needsDoc: true },
        { id: "ul", label: "Sublinhar", icon: "underline", tool: "underline", needsDoc: true },
        { id: "so", label: "Tachar", icon: "strike", tool: "strikeout", needsDoc: true },
      ] },
      { label: "Notas", cmds: [
        { id: "note", label: "Nota", icon: "note", tool: "note", needsDoc: true },
        { id: "ft", label: "Caixa de texto", icon: "freetext", tool: "freetext", needsDoc: true },
      ] },
      { label: "Desenho", cmds: [
        { id: "ink", label: "Lápis", icon: "ink", tool: "ink", needsDoc: true },
        { id: "rect", label: "Retângulo", icon: "rect", tool: "rect", needsDoc: true },
        { id: "ell", label: "Elipse", icon: "ellipse", tool: "ellipse", needsDoc: true },
        { id: "line", label: "Linha", icon: "line", tool: "line", needsDoc: true },
        { id: "arrow", label: "Seta", icon: "arrow", tool: "arrow", needsDoc: true },
      ] },
      { label: "Carimbo", cmds: [
        { id: "stamp", label: "Carimbo", icon: "stamp", needsDoc: true, run: feat.chooseStamp, title: "Aprovado, Confidencial, Pago… com data e nome" },
      ] },
      { label: "Cor", cmds: ["color"] },
    ],
  },
  {
    id: "edit", label: "Editar", groups: [
      { label: "Conteúdo", cmds: [
        { id: "et", label: "Editar texto", icon: "editText", tool: "edittext", needsDoc: true,
          title: "Clique num parágrafo para reescrevê-lo" },
      ] },
      { label: "Em todas as páginas", cmds: [
        { id: "hf", label: "Cabeçalho e rodapé", icon: "header", needsDoc: true, run: feat.headerFooter, title: "Texto nas margens de todas as páginas" },
        { id: "num", label: "Numerar páginas", icon: "number", needsDoc: true, run: feat.numberPages },
        { id: "wm", label: "Marca d'água", icon: "watermark", needsDoc: true, run: feat.watermark, title: "Texto grande e transparente no meio das páginas" },
        { id: "wmOff", label: "Remover marca d'água", icon: "watermarkOff", needsDoc: true, run: feat.removeWatermarks,
          title: "Tira as marcas d'água do Word, Acrobat, Foxit e PapyrusPDF de todas as páginas" },
      ] },
      { label: "Histórico", cmds: [
        { id: "undo2", label: "Desfazer", icon: "undo", needsDoc: true, enabled: (a) => !!a.doc?.info.canUndo, run: (a) => a.undo() },
        { id: "redo2", label: "Refazer", icon: "redo", needsDoc: true, enabled: (a) => !!a.doc?.info.canRedo, run: (a) => a.redo() },
      ] },
    ],
  },
  {
    id: "organize", label: "Organizar", groups: [
      { label: "Exibição", cmds: [
        { id: "grid", label: "Miniaturas", icon: "grid", needsDoc: true, run: (a) => a.setView(a.view === "organize" ? "read" : "organize") },
      ] },
      { label: "Páginas", cmds: [
        { id: "rl", label: "Girar ←", icon: "rotateCcw", needsDoc: true, run: (a) => a.mutate("Girando…", () => engine.rotatePages(targets(a), -90)) },
        { id: "rr", label: "Girar →", icon: "rotateCw", needsDoc: true, run: (a) => a.mutate("Girando…", () => engine.rotatePages(targets(a), 90)) },
        { id: "del", label: "Excluir", icon: "trash", needsDoc: true, run: async (a) => {
          const t = targets(a);
          const ok = await a.ask({ kind: "confirm", title: "Excluir páginas", message: `Excluir ${t.length === 1 ? `a página ${t[0] + 1}` : `${t.length} páginas`}?` });
          if (ok !== null) { await a.mutate("Excluindo…", () => engine.deletePages(t)); a.setSelectedPages([]); }
        } },
        { id: "blank", label: "Em branco", icon: "blank", needsDoc: true, run: (a) => a.mutate("Inserindo…", () => engine.insertBlankPage(Math.max(...targets(a)) + 1)) },
      ] },
      { label: "Arquivos", cmds: [
        { id: "insf", label: "Inserir PDF", icon: "insertFile", needsDoc: true, run: async (a) => {
          const [f] = await window.papiro.openDialog({ title: "Inserir páginas de outro PDF" });
          if (f) await a.mutate("Inserindo…", () => engine.insertFromPdf(f.bytes, Math.max(...targets(a)) + 1));
        } },
        { id: "insImg", label: "Inserir imagem", icon: "image", needsDoc: true, run: (a) => a.insertImages(), title: "Imagens viram páginas depois da página atual" },
        { id: "ext", label: "Extrair", icon: "extract", needsDoc: true, run: async (a) => {
          const t = [...targets(a)].sort((x, y) => x - y);
          const path = await window.papiro.saveDialog(`${a.doc!.name.replace(/\.pdf$/i, "")}_paginas_${t.map((p) => p + 1).join("-")}.pdf`);
          if (!path) return;
          await a.task("Extraindo…", async () => { await window.papiro.writeFile(path, await engine.extractPages(t)); a.notify(`${t.length} página(s) extraída(s) para ${path}`); });
        } },
        { id: "split", label: "Dividir", icon: "split", needsDoc: true, run: async (a) => {
          const v = await a.ask({ kind: "prompt", title: "Dividir documento", message: "Gerar um arquivo a cada quantas páginas?", value: "1" });
          const every = Number(v);
          if (!v || !Number.isInteger(every) || every < 1) return;
          const dir = await window.papiro.folderDialog();
          if (!dir) return;
          await a.task("Dividindo…", async () => {
            const parts = await engine.split(every);
            const base = a.doc!.name.replace(/\.pdf$/i, "");
            for (let i = 0; i < parts.length; i++) await window.papiro.writeFile(await window.papiro.joinPath(dir, `${base}_parte${i + 1}.pdf`), parts[i]);
            a.notify(`${parts.length} arquivos gravados em ${dir}`);
          });
        } },
      ] },
    ],
  },
  {
    id: "fill", label: "Preencher e assinar", groups: [
      { label: "Assinatura", cmds: [
        { id: "sig", label: "Assinar", icon: "sign", tool: "signature", needsDoc: true, title: "Clique na página onde a assinatura deve ficar" },
        { id: "sigNew", label: "Nova assinatura", icon: "ink", run: async (a) => { const s = await a.ask({ kind: "signature", title: "Criar assinatura" }); if (s) { a.setSignature(s); a.setTool("signature"); } } },
        { id: "sigClr", label: "Apagar salva", icon: "clear", enabled: (a) => !!a.signature, run: (a) => { a.setSignature(null); a.notify("Assinatura salva removida."); } },
      ] },
      { label: "Texto livre", cmds: [
        { id: "ft2", label: "Digitar no PDF", icon: "freetext", tool: "freetext", needsDoc: true, title: "Para formulários sem campos: arraste uma caixa e digite" },
      ] },
    ],
  },
  {
    id: "protect", label: "Proteger", groups: [
      { label: "Senha", cmds: [
        { id: "lock", label: "Proteger com senha", icon: "lock", needsDoc: true, run: feat.protect, title: "Senha para abrir e permissões (imprimir, copiar, alterar)" },
        { id: "unlock", label: "Remover proteção", icon: "unlock", needsDoc: true, enabled: (a) => !!a.doc?.info.encrypted, run: feat.unprotect,
          title: "Gravar uma versão sem senha e sem restrições" },
      ] },
      { label: "Redação", cmds: [
        { id: "red", label: "Marcar área", icon: "redact", tool: "redact", needsDoc: true, title: "Arraste sobre o que deve ser apagado" },
        { id: "redApply", label: "Aplicar redações", icon: "apply", needsDoc: true, run: async (a) => {
          const ok = await a.ask({ kind: "confirm", title: "Aplicar redações", message: "O conteúdo sob as marcas será apagado de verdade (texto, imagens e desenhos) e coberto de preto. Isso não pode ser desfeito depois de salvar. Continuar?" });
          if (ok === null) return;
          const r = await a.task("Aplicando…", () => engine.applyAllRedactions());
          if (r) { await a.mutate("…", async () => r.info); a.notify(r.pages ? `Redação aplicada em ${r.pages} página(s).` : "Nenhuma área marcada."); }
        } },
      ] },
    ],
  },
  {
    id: "ocr", label: "Reconhecer texto", groups: [
      { label: "Idioma do texto", cmds: ["ocrlang"] },
      { label: "Reconhecer (OCR)", cmds: [
        { id: "ocr1", label: "Esta página", icon: "ocr", needsDoc: true, run: (a) => a.runOcr([a.page]) },
        { id: "ocrScan", label: "Páginas escaneadas", icon: "ocrAll", needsDoc: true, enabled: (a) => a.scanned.length > 0,
          run: (a) => a.runOcr("scanned"), title: "Só as páginas sem texto" },
        { id: "ocrAll", label: "Documento inteiro", icon: "ocrAll", needsDoc: true,
          run: (a) => a.runOcr(Array.from({ length: a.doc!.info.pageCount }, (_, i) => i)) },
      ] },
    ],
  },
];

const SWATCHES: RGB[] = [[1, 0.85, 0], [0.4, 0.85, 0.3], [0.3, 0.7, 1], [1, 0.45, 0.6], [0.85, 0, 0], [0, 0.3, 0.8], [0, 0, 0]];
const css = (c: RGB) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;

export function Ribbon() {
  const a = useApp();
  const [tab, setTab] = useState("home");
  const active = TABS.find((t) => t.id === tab)!;
  return (
    <header className="ribbon">
      <nav className="ribbon-tabs" role="tablist">
        <span className="brand">PapyrusPDF</span>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab} className={t.id === tab ? "on" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="ribbon-body" role="toolbar">
        {active.groups.map((g) => (
          <section key={g.label} className="rgroup">
            <div className="rgroup-cmds">
              {g.cmds.map((c) =>
                c === "ocrlang" ? (
                  <label key="ocrlang" className="ocrlang">
                    <Icon name="language" size={20} />
                    <select aria-label="Idioma do OCR" value={a.ocrLang} disabled={!!a.busy} onChange={(e) => a.setOcrLang(e.target.value)}>
                      {OCR_LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                    </select>
                  </label>
                ) : c === "color" ? (
                  <div key="color" className="swatches">
                    {SWATCHES.map((s) => (
                      <button key={s.join()} title="Cor das marcações" className={s.join() === a.color.join() ? "sw on" : "sw"}
                        style={{ background: css(s) }} onClick={() => a.setColor(s)} />
                    ))}
                  </div>
                ) : (
                  <button key={c.id} className={(c.tool && a.tool === c.tool) || c.on?.(a) ? "rbtn on" : "rbtn"} title={c.title ?? c.label}
                    aria-pressed={c.on ? !!c.on(a) : undefined}
                    disabled={(c.needsDoc && !a.doc) || (c.enabled ? !c.enabled(a) : false) || !!a.busy}
                    onClick={() => { if (c.tool) { a.setTool(c.tool); a.setView("read"); } c.run?.(a); }}>
                    <Icon name={c.icon} size={22} />
                    <span>{c.label}</span>
                  </button>
                ),
              )}
            </div>
            <div className="rgroup-label">{g.label}</div>
          </section>
        ))}
      </div>
    </header>
  );
}
