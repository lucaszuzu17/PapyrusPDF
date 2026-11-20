// Roteiro de ponta a ponta. Roda dentro do processo principal (PAPIRO_E2E=test/e2e.mjs)
// usando entradas reais de mouse/teclado e capturas da janela.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUT = join(process.cwd(), "test", "e2e-out");
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log("[e2e]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function run(win, { callEngine, hooks, userData }) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const engine = (m, ...a) => callEngine(m, a);
  const waitFor = async (code, what, timeout = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await js(code).catch(() => null);
      if (v) return v;
      if (Date.now() - t0 > timeout) { await shot("erro"); throw new Error(`tempo esgotado esperando: ${what}`); }
      await sleep(100);
    }
  };
  const expect = (cond, msg) => { if (!cond) throw new Error(`falhou: ${msg}`); log("ok:", msg); };
  const shot = async (name) => { const img = await wc.capturePage(); writeFileSync(join(OUT, `${name}.png`), img.toPNG()); log("captura", name); };
  const mouse = (type, x, y, extra = {}) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, ...extra });
  const click = async (x, y) => { mouse("mouseDown", x, y); await sleep(30); mouse("mouseUp", x, y); await sleep(150); };
  const drag = async (x0, y0, x1, y1, steps = 12) => {
    mouse("mouseDown", x0, y0);
    for (let i = 1; i <= steps; i++) { mouse("mouseMove", x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await sleep(16); }
    mouse("mouseUp", x1, y1);
    await sleep(200);
  };
  // Teclado só chega se a janela de teste estiver com o foco; se outro programa
  // o tomou no meio do roteiro, pega de volta antes de digitar.
  const ensureFocus = () => { if (!win.isFocused()) win.focus(); if (!wc.isFocused()) wc.focus(); };
  const insertText = wc.insertText.bind(wc);
  wc.insertText = (text) => { ensureFocus(); return insertText(text); };
  const key = async (keyCode, modifiers = []) => {
    ensureFocus();
    wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (keyCode === "Enter" && !modifiers.length) wc.sendInputEvent({ type: "char", keyCode: "\r" });
    wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await sleep(120);
  };
  const rectOf = (sel, nth = 0) => js(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const button = async (label, scope = "") => {
    const r = await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!r) throw new Error(`botão não encontrado: ${label}`);
    await click(r.x, r.y);
  };
  /** ponto da página (em pt) → coordenadas da janela */
  const toScreen = async (page, x, y) => {
    const info = await engine("info");
    const p = info.pages[page];
    let r = await rectOf(`.page[data-page="${page}"]`);
    const z = r.w / p.width;
    // rola o leitor para o ponto ficar visível
    const v = await rectOf(".viewer");
    const sy = r.y + (y - p.y) * z;
    if (sy < v.y + 60 || sy > v.y + v.h - 60) {
      await js(`document.querySelector(".viewer").scrollTop += ${Math.round(sy - (v.y + v.h / 2))}`);
      await sleep(250);
      r = await rectOf(`.page[data-page="${page}"]`);
    }
    return [r.x + (x - p.x) * z, r.y + (y - p.y) * z];
  };
  const idle = () => waitFor(`!document.querySelector(".busy")`, "fim da operação", 120000);
  const rendered = (page = 0) => waitFor(`(() => { const p = document.querySelector('.page[data-page="${page}"]'); return p && !p.querySelector('.page-loading'); })()`, `página ${page + 1} renderizada`);

  await js("localStorage.clear()");
  win.setSize(1400, 950);
  await waitFor(`!!document.querySelector(".page")`, "documento aberto", 20000);
  await rendered(0);
  await sleep(400);
  const info = await engine("info");
  log("documento:", info.title, info.pageCount, "páginas");

  if (process.env.PAPIRO_E2E_CASE === "recursos") return featuresCase();
  if (process.env.PAPIRO_E2E_CASE === "abas") return tabsCase();
  if (/escaneado/i.test(info.title)) return ocrCase();
  if (/formulario/i.test(info.title)) return formCase();
  return mainCase();

  async function mainCase() {
    await shot("01-aberto");

    // --- editar texto ---
    await button("Editar", ".ribbon-tabs");
    await button("Editar texto", ".ribbon-body");
    await waitFor(`document.querySelectorAll(".eblock").length > 0`, "blocos de texto");
    const blocks = await engine("pageText", 0);
    const bi = blocks.findIndex((b) => b.lines.some((l) => l.text.includes("Este parágrafo")));
    expect(bi >= 0, "parágrafo de exemplo encontrado");
    const br = await rectOf(".eblock", bi);
    await click(br.x + br.w / 2, br.y + br.h / 2);
    await waitFor(`!!document.querySelector("textarea.editor")`, "editor de parágrafo");
    await js(`document.querySelector("textarea.editor").select()`);
    wc.insertText("Texto reescrito pelo PapyrusPDF: este parágrafo foi editado dentro do PDF, com quebra automática de linha, mantendo fonte e cor originais.");
    await sleep(200);
    await shot("02a-editando");
    await key("Enter", ["control"]);
    await idle();
    let txt = (await engine("pageText", 0)).flatMap((b) => b.lines.map((l) => l.text)).join(" ");
    expect(txt.includes("Texto reescrito pelo PapyrusPDF") && !txt.includes("Este parágrafo de exemplo"), "parágrafo substituído no PDF");
    expect(txt.includes("Segundo bloco"), "resto da página preservado");
    await rendered(0); await sleep(300);
    await shot("02b-editado");

    // --- realçar ---
    await button("Comentar", ".ribbon-tabs");
    await button("Realçar", ".ribbon-body");
    await sleep(300);
    const line = (await engine("pageText", 0)).flatMap((b) => b.lines).find((l) => l.text.includes("Segundo bloco"));
    const a = await toScreen(0, line.bbox[0] + 1, (line.bbox[1] + line.bbox[3]) / 2);
    const b = await toScreen(0, line.bbox[2] - 1, (line.bbox[1] + line.bbox[3]) / 2);
    await drag(a[0], a[1], b[0], b[1]);
    await idle();
    let ann = await engine("annotations", 0);
    expect(ann.some((x) => x.kind === "Highlight"), "realce criado");

    // --- lápis ---
    await button("Lápis", ".ribbon-body");
    const i0 = await toScreen(0, 100, 470), i1 = await toScreen(0, 300, 520);
    await drag(i0[0], i0[1], i1[0], i1[1], 20);
    await idle();
    // --- retângulo ---
    await button("Retângulo", ".ribbon-body");
    const r0 = await toScreen(0, 340, 450), r1 = await toScreen(0, 500, 540);
    await drag(r0[0], r0[1], r1[0], r1[1]);
    await idle();
    // --- nota ---
    await button("Nota", ".ribbon-body");
    const n0 = await toScreen(0, 530, 140);
    await click(n0[0], n0[1]);
    await waitFor(`!!document.querySelector(".modal textarea")`, "diálogo da nota");
    wc.insertText("Revisar este trecho antes de enviar.");
    await key("Enter", ["control"]);
    await idle();
    ann = await engine("annotations", 0);
    await shot("02c-desenhos");
    expect(["Ink", "Square", "Text"].every((k) => ann.some((x) => x.kind === k)), `lápis, retângulo e nota criados (${ann.map((x) => x.kind).join(", ")})`);

    // --- assinatura desenhada ---
    await button("Preencher e assinar", ".ribbon-tabs");
    await button("Nova assinatura", ".ribbon-body");
    await waitFor(`!!document.querySelector(".sigpad")`, "quadro de assinatura");
    const pad = await rectOf(".sigpad");
    const pts = Array.from({ length: 40 }, (_, k) => [pad.x + 60 + k * 11, pad.y + 110 + Math.sin(k / 3) * 35]);
    mouse("mouseDown", ...pts[0]);
    for (const p of pts) { mouse("mouseMove", ...p); await sleep(8); }
    mouse("mouseUp", ...pts[pts.length - 1]);
    await sleep(150);
    await button("Usar assinatura", ".modal");
    await sleep(200);
    const s0 = await toScreen(0, 420, 640);
    await click(s0[0], s0[1]);
    await idle();
    ann = await engine("annotations", 0);
    expect(ann.some((x) => x.kind === "Stamp"), "assinatura aplicada");
    await button("Selecionar", ".ribbon-body").catch(async () => { await button("Início", ".ribbon-tabs"); await button("Selecionar", ".ribbon-body"); });
    await rendered(0); await sleep(400);
    await shot("03-anotacoes");

    // --- busca ---
    await key("F", ["control"]);
    await waitFor(`!!document.querySelector(".search input")`, "painel de busca");
    wc.insertText("Manaus");
    await key("Enter");
    await waitFor(`document.querySelectorAll(".hit").length > 0`, "realces da busca");
    const hits = await engine("search", "Manaus");
    expect(hits.length === 2, `busca encontrou ${hits.length} (páginas 2 e 3; a 1 foi reescrita)`);
    await sleep(300);
    await shot("04-busca");

    // --- organizar ---
    await button("Organizar", ".ribbon-tabs");
    await button("Miniaturas", ".ribbon-body");
    await waitFor(`document.querySelectorAll(".org-item").length === 3`, "grade de miniaturas");
    const t3 = await rectOf(".org-item", 2);
    await click(t3.x + t3.w / 2, t3.y + t3.h / 2);
    await button("Girar →", ".ribbon-body");
    await idle();
    expect((await engine("info")).pages[2].width === 842, "página 3 girada");
    await sleep(800);
    await shot("05-organizar");
    await key("Z", ["control"]);
    await idle();
    expect((await engine("info")).pages[2].width === 595, "desfazer (Ctrl+Z) desfez o giro");

    // --- salvar e reabrir ---
    const bytes = await engine("save");
    writeFileSync(join(OUT, "resultado.pdf"), bytes);
    const check = await engine("open", bytes, "verificacao");
    const kinds = (await engine("annotations", 0)).map((x) => x.kind).sort();
    expect(check.pageCount === 3 && ["Highlight", "Ink", "Square", "Stamp", "Text"].every((k) => kinds.includes(k)), `PDF salvo tem as anotações (${kinds.join(", ")})`);
    log("PASSOU: cenário principal");
  }

  // ---------- recursos da versão 0.2 ----------
  async function featuresCase() {
    const tmp = join(OUT, "recursos");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const tab = (name) => button(name, ".ribbon-tabs");
    const cmd = (name) => button(name, ".ribbon-body");
    const form = (title) => waitFor(`document.querySelector(".modal h2")?.textContent === ${JSON.stringify(title)}`, `diálogo “${title}”`);
    const noModal = () => waitFor(`!document.querySelector(".modal")`, "diálogo fechado");
    const select = (id, value) => js(`(() => { const s = document.querySelector("#f-${id}"); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); return s.value; })()`);
    const type = async (sel, text) => { const r = await rectOf(sel); await click(r.x + r.w / 2, r.y + r.h / 2); wc.insertText(text); await sleep(120); };
    const toast = () => js(`document.querySelector(".toast")?.textContent ?? ""`);
    const waitToast = (re, what) => waitFor(`${re}.test(document.querySelector(".toast")?.textContent ?? "")`, what, 60000);
    const settle = async () => { await sleep(250); await idle(); await sleep(150); };
    const allText = async (p) => (await engine("pageText", p)).flatMap((b) => b.lines.map((l) => l.text)).join("\n");
    const fixture = (n) => resolve("test/fixtures", n);

    // --- numerar páginas ---
    await tab("Editar");
    await cmd("Numerar páginas");
    await form("Numerar páginas");
    await select("fmt", "Página {p} de {n}");
    await button("Numerar", ".modal");
    await noModal(); await settle();
    expect(/Página 2 de 3/.test(await allText(1)), "numeração “Página 2 de 3” escrita na página 2");

    // --- cabeçalho e rodapé (validação + marcadores) ---
    await cmd("Cabeçalho e rodapé");
    await form("Cabeçalho e rodapé");
    await button("Aplicar", ".modal");
    await waitFor(`!!document.querySelector(".form-error")`, "aviso de formulário vazio");
    await type("#f-tr", "{arquivo} — {data}");
    await button("Aplicar", ".modal");
    await noModal(); await settle();
    expect(/amostra — \d{2}\/\d{2}\/\d{4}/.test(await allText(0)), "cabeçalho com nome do arquivo e data");

    // --- marca d'água ---
    await cmd("Marca d'água");
    await form("Marca d'água");
    await button("Aplicar em todas as páginas", ".modal");
    await noModal(); await settle();
    expect((await engine("search", "CONFIDENCIAL")).length === 3, "marca d'água nas 3 páginas");

    // --- carimbo ---
    await tab("Comentar");
    await cmd("Carimbo");
    await form("Carimbo");
    await type("#f-name", "Maria Silva");
    await button("Usar carimbo", ".modal");
    await noModal();
    const sp = await toScreen(0, 430, 700);
    await click(sp[0], sp[1]);
    await settle();
    const stamps = (await engine("annotations", 0)).filter((x) => x.kind === "Stamp");
    expect(stamps.length === 1 && stamps[0].rect[2] - stamps[0].rect[0] > 100, "carimbo colocado na página");
    await tab("Início"); await cmd("Selecionar");
    await rendered(0); await sleep(500);
    await js(`document.querySelector(".viewer").scrollTop = 0`); await sleep(400);
    await shot("08a-cabecalho-marca");
    await toScreen(0, 430, 700); await sleep(500);
    await shot("08b-carimbo-rodape");

    // --- inserir imagem como página ---
    const foto = join(tmp, "foto.png");
    const b64 = await js(`(() => { const c = document.createElement("canvas"); c.width = 2400; c.height = 1600; const g = c.getContext("2d");
      const gr = g.createLinearGradient(0, 0, 2400, 1600); gr.addColorStop(0, "#27496d"); gr.addColorStop(0.5, "#e8a33d"); gr.addColorStop(1, "#7a2e2e"); g.fillStyle = gr; g.fillRect(0, 0, 2400, 1600);
      const d = g.getImageData(0, 0, 2400, 1600); let s = 7; for (let i = 0; i < d.data.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; const n = (s % 31) - 15; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; } g.putImageData(d, 0, 0);
      return c.toDataURL("image/png").split(",")[1]; })()`);
    writeFileSync(foto, Buffer.from(b64, "base64"));
    hooks.open.push([foto]);
    await tab("Organizar");
    await cmd("Inserir imagem");
    await settle();
    let inf = await engine("info");
    expect(inf.pageCount === 4 && Math.round(inf.pages[1].width) === 842, "imagem inserida como página 2 (A4 paisagem)");

    // --- imprimir (nos testes, a janela de impressão vira um PDF) ---
    const printed = join(tmp, "impresso.pdf");
    hooks.printTo = printed;
    await key("P", ["control"]);
    await waitFor(`!!document.querySelector(".busy")`, "preparando impressão").catch(() => {});
    await settle();
    expect(existsSync(printed) && statSync(printed).size > 10000, "impressão gerou as páginas");

    // --- exportar como imagem ---
    const png = join(tmp, "pagina.png");
    hooks.save.push(png);
    await tab("Converter");
    await cmd("Imagem");
    await form("Exportar como imagem");
    await button("Exportar…", ".modal");
    await noModal(); await settle();
    expect(existsSync(png) && readFileSync(png).subarray(1, 4).toString() === "PNG", "página exportada em PNG");
    await tab("Início");

    // --- comprimir ---
    const small = join(tmp, "comprimido.pdf");
    hooks.save.push(small);
    await cmd("Comprimir");
    await form("Comprimir PDF");
    await select("level", "forte");
    await button("Comprimir e salvar…", ".modal");
    await noModal();
    await waitToast("/De .+ para .+ \\(−\\d+%\\)/", "aviso com a redução de tamanho");
    log("  ", await toast());
    expect(existsSync(small) && statSync(small).size < statSync(foto).size, `arquivo comprimido menor que a foto original (${statSync(small).size} < ${statSync(foto).size})`);
    expect((await engine("info")).pageCount === 4, "documento aberto intacto depois de comprimir");

    // --- recentes lembram a página ---
    await js(`(() => { const i = document.querySelector(".pgnum"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "3"); i.dispatchEvent(new Event("input", { bubbles: true })); i.form.requestSubmit(); })()`);
    await sleep(1200);
    const rec = await js(`window.papiro.recentList()`);
    const mine = rec.find((r) => /amostra\.pdf$/i.test(r.path));
    expect(mine && mine.page === 2, `recentes guardam a página 3 de amostra.pdf (${JSON.stringify(rec.map((r) => [r.name, r.page]))})`);
    expect(existsSync(join(userData, "recentes.json")), "lista de recentes gravada no perfil");

    // --- proteger com senha ---
    const locked = join(tmp, "protegido.pdf");
    hooks.save.push(locked);
    await tab("Proteger");
    await cmd("Proteger com senha");
    await form("Proteger com senha");
    await type("#f-pw", "segredo123");
    await type("#f-pw2", "outra");
    await button("Proteger e salvar…", ".modal");
    await waitFor(`/não são iguais/.test(document.querySelector(".form-error")?.textContent ?? "")`, "aviso de senhas diferentes");
    await js(`document.querySelector("#f-pw2").select()`);
    wc.insertText("segredo123");
    await js(`document.querySelector("#f-copy").click()`);
    await button("Proteger e salvar…", ".modal");
    await noModal(); await settle();
    inf = await engine("info");
    expect(existsSync(locked) && inf.encrypted && inf.pageCount === 4 && !inf.dirty, "cópia protegida gravada e aberta no lugar do documento");
    expect(/protegido\.pdf/.test(win.getTitle()), `título mostra o arquivo protegido (${win.getTitle()})`);
    expect(/Página 2 de 3/.test(await allText(2)), "conteúdo do arquivo protegido continua legível");
    expect(await js(`document.querySelector(".pgnum").value`) === "3", "continua na página em que estava");

    // --- remover proteção ---
    const free = join(tmp, "sem-senha.pdf");
    hooks.save.push(free);
    await cmd("Remover proteção");
    await form("Remover proteção");
    await button("Remover e salvar…", ".modal");
    await noModal(); await settle();
    inf = await engine("info");
    expect(existsSync(free) && !inf.encrypted && inf.pageCount === 4, "proteção removida");
    await rendered(2); await sleep(300);

    // --- arrastar e soltar: um PDF abre ---
    const dropFiles = (files) => js(`(async () => {
      const dt = new DataTransfer();
      for (const f of ${JSON.stringify(files)}) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 250));
      const shown = !!document.querySelector(".dropzone");
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      return shown;
    })()`);
    const asDrop = (path, name, type) => ({ name, type, b64: readFileSync(path).toString("base64") });
    const zone = await dropFiles([asDrop(fixture("formulario.pdf"), "formulario.pdf", "application/pdf")]);
    expect(zone, "área “Solte para abrir” aparece ao arrastar");
    await waitFor(`document.querySelectorAll(".page").length === 1 && !document.querySelector(".busy")`, "PDF solto aberto");
    expect(/formulario\.pdf/.test(win.getTitle()), `PDF solto abriu (${win.getTitle()})`);

    // --- arrastar imagens sobre um documento aberto: viram páginas ---
    await dropFiles([asDrop(foto, "a.png", "image/png"), asDrop(foto, "b.png", "image/png")]);
    await waitFor(`document.querySelectorAll(".page").length === 3 && !document.querySelector(".busy")`, "imagens soltas viraram páginas", 30000);
    expect((await engine("info")).dirty, "documento marcado como alterado");

    // --- criar PDF a partir de imagens: abre numa aba nova (o documento alterado continua aberto) ---
    hooks.open.push([foto, foto]);
    await tab("Início");
    await cmd("De imagens");
    await form("Criar PDF a partir de imagens");
    await select("page", "imagem");
    await button("Criar PDF", ".modal");
    await waitFor(`document.querySelectorAll(".page").length === 2 && !document.querySelector(".busy")`, "PDF criado a partir das imagens", 30000);
    expect(await js(`document.querySelectorAll(".doctab").length`) === 3, "PDF novo abriu numa terceira aba");
    inf = await engine("info");
    expect(inf.pageCount === 2 && Math.round(inf.pages[0].width) === 842 && Math.round(inf.pages[0].height) === 561, `páginas do tamanho da imagem (${inf.pages[0].width}×${inf.pages[0].height})`);
    await rendered(0); await sleep(400);
    await shot("09-de-imagens");

    // --- segunda instância: o PDF abre na janela que já existe ---
    const { app } = await import("electron");
    const args = app.isPackaged ? [fixture("amostra.pdf")] : [process.argv[1], fixture("amostra.pdf")];
    const child = spawn(process.execPath, args, { env: process.env, stdio: "ignore" });
    const code = await new Promise((r) => child.on("exit", r));
    expect(code === 0, "a segunda instância encerra sozinha");
    await waitFor(`document.querySelectorAll(".page").length === 3 && !document.querySelector(".busy")`, "PDF da segunda instância aberto", 30000);
    expect(await js(`document.querySelectorAll(".doctab").length`) === 4, "PDF da segunda instância abriu numa aba nova");
    expect(/amostra\.pdf/.test(win.getTitle()), `segunda instância entregou o arquivo (${win.getTitle()})`);
    expect(await js(`document.querySelector(".pgnum").value`) === "3", "reabriu na página 3, onde tinha ficado");

    // --- conferências finais nos arquivos gravados ---
    let chk = await engine("open", new Uint8Array(readFileSync(locked)), "conferencia");
    expect(chk.pageCount === 0 && (await engine("needsPassword")), "arquivo protegido pede senha");
    let wrong = false;
    try { await engine("unlock", "errada"); } catch { wrong = true; }
    expect(wrong, "senha errada é recusada");
    chk = await engine("unlock", "segredo123");
    expect(chk.pageCount === 4 && chk.encrypted, "senha certa abre o arquivo protegido");
    chk = await engine("open", new Uint8Array(readFileSync(printed)), "impresso");
    expect(chk.pageCount === 4, `impressão tem uma folha por página, sem folhas em branco (${chk.pageCount})`);
    expect(chk.pages.every((p) => p.height > p.width), "páginas deitadas são giradas para a folha em pé");
    const px = await engine("render", 1, 0.2);
    let ink = 0;
    for (let i = 0; i < px.rgba.length; i += 4) if (px.rgba[i] < 200 || px.rgba[i + 1] < 200) ink++;
    expect(ink > (px.rgba.length / 4) * 0.5, "a folha impressa da foto está preenchida");
    chk = await engine("open", new Uint8Array(readFileSync(small)), "comprimido");
    expect(chk.pageCount === 4 && (await engine("search", "CONFIDENCIAL")).length === 3, "arquivo comprimido mantém páginas e texto");
    log("PASSOU: recursos 0.2");
  }

  // ---------- versão 0.4: abas, duas páginas, tela cheia, converter, fonte original e OCR ----------
  async function tabsCase() {
    const tmp = join(OUT, "abas");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const tab = (name) => button(name, ".ribbon-tabs");
    const cmd = (name) => button(name, ".ribbon-body");
    const fixture = (n) => resolve("test/fixtures", n);
    const tabs = () => js(`[...document.querySelectorAll(".doctab")].map((t) => t.querySelector(".dt-name").textContent.replace(/^•/, ""))`);
    const activeTab = () => js(`(document.querySelector(".doctab.on .dt-name")?.textContent ?? "").replace(/^•/, "")`);
    const settle = async () => { await sleep(250); await idle(); await sleep(150); };
    const openViaDialog = async (path) => { hooks.open.push([path]); await key("O", ["control"]); await settle(); };
    const toast = () => js(`document.querySelector(".toast")?.textContent ?? ""`);
    const clickSel = async (sel) => { const r = await rectOf(sel); if (!r) throw new Error(`não achei ${sel}`); await click(r.x + r.w / 2, r.y + r.h / 2); };
    const goPage = (n) => js(`(() => { const i = document.querySelector(".pgnum"); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "${n}"); i.dispatchEvent(new Event("input", { bubbles: true })); i.form.requestSubmit(); })()`);

    // --- abas: abrir outro PDF não fecha o primeiro ---
    expect((await tabs()).length === 1, "começa com uma aba");
    await openViaDialog(fixture("formulario.pdf"));
    expect(JSON.stringify(await tabs()) === JSON.stringify(["amostra.pdf", "formulario.pdf"]), `duas abas (${await tabs()})`);
    expect(await activeTab() === "formulario.pdf" && (await engine("info")).pageCount === 1, "a aba nova fica na frente");
    // a primeira aba guarda a página em que estava
    await button("amostra.pdf", ".tabbar");
    await waitFor(`document.querySelectorAll(".page").length === 3`, "amostra de volta");
    await goPage(3);
    await sleep(500);
    await key("Tab", ["control"]);
    await waitFor(`document.querySelectorAll(".page").length === 1`, "Ctrl+Tab foi para o formulário");
    await key("Tab", ["control"]);
    await waitFor(`document.querySelectorAll(".page").length === 3`, "Ctrl+Tab voltou para a amostra");
    await sleep(400);
    expect(await js(`document.querySelector(".pgnum").value`) === "3", "a aba voltou na página 3, onde estava");
    // abrir de novo um arquivo já aberto só troca de aba
    await openViaDialog(fixture("formulario.pdf"));
    expect((await tabs()).length === 2 && await activeTab() === "formulario.pdf", "arquivo já aberto não cria aba repetida");
    // fechar uma aba alterada pede confirmação
    await tab("Organizar");
    await cmd("Girar →");
    await settle();
    expect(await js(`!!document.querySelector(".doctab.on .dt-dot")`), "aba alterada mostra o ponto");
    await key("W", ["control"]);
    await waitFor(`document.querySelector(".modal h2")?.textContent === "Alterações não salvas"`, "confirmação ao fechar aba alterada");
    await button("Fechar sem salvar", ".modal");
    await settle();
    expect(JSON.stringify(await tabs()) === JSON.stringify(["amostra.pdf"]), "aba fechada; a outra continua");
    expect((await engine("info")).pageCount === 3, "o motor voltou para a amostra");

    // --- duas páginas ---
    await openViaDialog(fixture("escaneado.pdf"));
    await button("amostra.pdf", ".tabbar");
    await waitFor(`document.querySelectorAll(".page").length === 3`, "amostra de volta");
    await clickSel('.status button[title="Duas páginas"]');
    await waitFor(`document.querySelectorAll(".spread").length === 2`, "páginas em pares");
    const p0 = await rectOf('.page[data-page="0"]'), p1 = await rectOf('.page[data-page="1"]');
    expect(Math.abs(p0.y - p1.y) < 2 && p1.x > p0.x + p0.w, "páginas 1 e 2 lado a lado");
    await goPage(1);
    await key("0", ["control"]);
    await rendered(0); await rendered(1); await sleep(600);
    await shot("10-abas-duas-paginas");
    expect(await js(`localStorage.getItem("papiro.layout")`) === "double", "a escolha fica guardada");

    // --- tela cheia ---
    await key("F11");
    await waitFor(`!document.querySelector(".ribbon") && !!document.querySelector(".fs-exit")`, "tela cheia sem barras");
    await sleep(800);
    expect(win.isFullScreen(), "janela em tela cheia");
    await key("Right");
    await sleep(500);
    expect(await js(`document.querySelector(".pgnum") === null && document.querySelector('.page[data-page="2"]').getBoundingClientRect().top < 120`), "seta para a direita avança para o próximo par");
    await shot("11-tela-cheia");
    await key("Escape");
    await waitFor(`!!document.querySelector(".ribbon")`, "Esc sai da tela cheia");
    await sleep(800);
    expect(!win.isFullScreen(), "janela saiu da tela cheia");
    await clickSel('.status button[title="Uma página"]');
    await waitFor(`document.querySelectorAll(".spread").length === 0`, "de volta a uma página");

    // --- converter para Word e para texto ---
    const docx = join(tmp, "amostra.docx"), txt = join(tmp, "amostra.txt");
    hooks.save.push(docx);
    await tab("Converter");
    await cmd("Word");
    await waitFor(`/Documento do Word salvo/.test(document.querySelector(".toast")?.textContent ?? "")`, "aviso do Word", 60000);
    const zipBytes = readFileSync(docx);
    expect(zipBytes.subarray(0, 2).toString() === "PK" && zipBytes.length > 2000, `arquivo .docx gravado (${zipBytes.length} bytes)`);
    expect(zipBytes.includes(Buffer.from("word/document.xml")), "o .docx tem o documento do Word");
    hooks.save.push(txt);
    await cmd("Texto");
    await waitFor(`/Texto salvo/.test(document.querySelector(".toast")?.textContent ?? "")`, "aviso do texto", 60000);
    expect(/Relatório mensal — página 3/.test(readFileSync(txt, "utf8")), "arquivo .txt com o texto das páginas");
    await shot("12-converter");

    // --- editar texto mantendo a fonte embutida ---
    if (existsSync(fixture("fontes.pdf"))) {
      await openViaDialog(fixture("fontes.pdf"));
      await rendered(0);
      await tab("Editar");
      await cmd("Editar texto");
      await waitFor(`document.querySelectorAll(".eblock").length > 0`, "blocos de texto");
      const blocks = await engine("pageText", 0);
      const bi = blocks.findIndex((b) => b.lines.some((l) => l.text.includes("Este relatório")));
      const br = await rectOf(".eblock", bi);
      await click(br.x + br.w / 2, br.y + br.h / 2);
      await waitFor(`!!document.querySelector("textarea.editor")`, "editor de parágrafo");
      expect(/Calibri/.test(await js(`getComputedStyle(document.querySelector("textarea.editor")).fontFamily`)), "o editor mostra o texto em Calibri");
      await js(`document.querySelector("textarea.editor").select()`);
      wc.insertText("Este relatório foi revisado pelo PapyrusPDF. Kátia e Zé conferiram o quadro QGBT.");
      await sleep(200);
      await key("Enter", ["control"]);
      await idle();
      const line = (await engine("pageText", 0)).flatMap((b) => b.lines).find((l) => l.text.includes("revisado"));
      expect(line && line.font === "ABCDEF+Calibri", `texto novo na fonte embutida do documento (${line?.font})`);
      expect(/Windows/.test(await toast()), `aviso de que letras vieram da fonte do Windows (${await toast()})`);
      await tab("Início"); await cmd("Selecionar");
      await rendered(0); await sleep(500);
      await shot("13-fonte-original");
    } else log("fontes.pdf ausente (Calibri não instalada): edição com fonte original não testada");

    // --- OCR em outro idioma ---
    await button("escaneado.pdf", ".tabbar");
    await waitFor(`!!document.querySelector(".banner")`, "aviso de escaneado na aba");
    await tab("Reconhecer texto");
    await js(`(() => { const s = document.querySelector(".ocrlang select"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "por+eng"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await sleep(300);
    expect(await js(`localStorage.getItem("papiro.ocrLang")`) === "por+eng", "idioma do OCR guardado");
    await shot("14-ocr-idioma");
    await cmd("Esta página");
    await waitFor(`!document.querySelector(".busy")`, "OCR em português + inglês", 180000);
    expect((await engine("search", "Manaus")).length >= 1, "OCR com dois idiomas reconheceu o texto");
    // --- remover marca d'água ---
    await button("amostra.pdf", ".tabbar");
    await waitFor(`document.querySelectorAll(".page").length === 3 && !document.querySelector(".busy")`, "amostra de volta");
    await tab("Editar");
    await cmd("Marca d'água");
    await waitFor(`document.querySelector(".modal h2")?.textContent === "Marca d'água"`, "formulário da marca d'água");
    await button("Aplicar em todas as páginas", ".modal");
    await settle();
    expect((await engine("search", "CONFIDENCIAL")).length === 3, "marca d'água aplicada nas 3 páginas");
    await cmd("Remover marca d'água");
    await waitFor(`/Marca d'água removida de 3 página/.test(document.querySelector(".toast")?.textContent ?? "")`, "aviso da remoção");
    expect((await engine("search", "CONFIDENCIAL")).length === 0, "marca d'água removida das 3 páginas");
    expect((await engine("search", "Manaus")).length === 3, "o texto das páginas continua");
    await key("Z", ["control"]);
    await settle();
    expect((await engine("search", "CONFIDENCIAL")).length === 3, "Ctrl+Z traz a marca de volta");
    await key("Z", ["control"]);
    await settle();

    // --- proteger: senha gerada, cópia para destinatário e páginas como imagem ---
    const copia = join(tmp, "amostra_Joao_Silva.pdf");
    hooks.save.push(copia);
    await tab("Proteger");
    await cmd("Proteger com senha");
    await waitFor(`document.querySelector(".modal h2")?.textContent === "Proteger com senha"`, "formulário de proteger");
    await clickSel(".fld-action");
    await sleep(200);
    const pw = await js(`document.querySelector("#f-pw").value`);
    expect(/^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}$/.test(pw) && await js(`document.querySelector("#f-pw2").value`) === pw, `senha forte gerada e repetida (${pw})`);
    expect(await js(`document.querySelector("#f-pw").type`) === "text", "senha gerada fica visível");
    expect(/Muito forte/.test(await js(`document.querySelector(".fld-note")?.textContent ?? ""`)), "medidor mostra Muito forte");
    const rr = await rectOf("#f-recipient");
    await click(rr.x + rr.w / 2, rr.y + rr.h / 2);
    wc.insertText("João Silva");
    await js(`(() => { const s = document.querySelector("#f-img"); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(s, "150"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await sleep(300);
    await shot("15-proteger");
    await button("Proteger e salvar…", ".modal");
    await waitFor(`/Cópia para João Silva salva/.test(document.querySelector(".toast")?.textContent ?? "")`, "aviso da cópia", 60000);
    expect(await activeTab() === "amostra.pdf" && (await engine("search", "Manaus")).length === 3, "o documento aberto continua o mesmo");
    const chk = await callEngine("open", [new Uint8Array(readFileSync(copia)), "copia"], 999);
    expect(chk.pageCount === 0 && await callEngine("needsPassword", [], 999), "a cópia pede senha");
    const ok = await callEngine("unlock", [pw], 999);
    const words = (await callEngine("pageText", [0], 999)).length;
    expect(ok.pageCount === 3 && words === 0, "a senha gerada abre a cópia, que virou imagem (sem texto)");
    await callEngine("dispose", [], 999);

    log("PASSOU: abas, duas páginas, tela cheia, converter, fonte original, OCR, marca d'água e proteção");
  }

  async function formCase() {
    await shot("06a-formulario");
    await waitFor(`document.querySelectorAll(".field").length === 3`, "campos do formulário");
    const f = await rectOf("input.field");
    await click(f.x + 10, f.y + f.h / 2);
    wc.insertText("Maria Silva");
    await key("Tab");
    await idle();
    const cb = await rectOf("input.field.check");
    await click(cb.x + cb.w / 2, cb.y + cb.h / 2);
    await idle();
    await js(`(() => { const s = document.querySelector("select.field"); s.value = "SP"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await idle();
    await sleep(300);
    const fields = await engine("fields", 0);
    const v = Object.fromEntries(fields.map((x) => [x.name, x.value]));
    expect(v.nome === "Maria Silva", `campo nome = ${v.nome}`);
    expect(v.aceito !== "Off" && v.aceito !== "", `caixa marcada (${v.aceito})`);
    expect(v.estado === "SP", `lista = ${v.estado}`);
    await rendered(0); await sleep(400);
    await shot("06b-formulario-preenchido");
    log("PASSOU: formulário");
  }

  async function ocrCase() {
    await waitFor(`!!document.querySelector(".banner")`, "aviso de documento escaneado");
    await shot("07a-escaneado");
    expect((await engine("search", "Manaus")).length === 0, "antes do OCR a busca não encontra nada");
    await button("Reconhecer texto (OCR)", ".banner");
    await waitFor(`!document.querySelector(".banner") && !document.querySelector(".busy")`, "OCR concluído", 180000);
    const hits = await engine("search", "Manaus");
    expect(hits.length >= 1, "depois do OCR a busca encontra o texto");
    await key("F", ["control"]);
    await waitFor(`!!document.querySelector(".search input")`, "painel de busca");
    wc.insertText("coração");
    await key("Enter");
    await waitFor(`document.querySelectorAll(".hit").length > 0`, "realce da busca no escaneado");
    await sleep(300);
    await shot("07b-ocr-busca");
    log("PASSOU: OCR");
  }
}
