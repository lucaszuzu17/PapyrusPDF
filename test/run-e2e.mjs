// Roda os cenários de ponta a ponta (npm run e2e).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import electron from "electron";

import { resolve } from "node:path";

// --packaged testa o build empacotado (dist/win-unpacked), idêntico ao que o instalador copia.
const packaged = process.argv.includes("--packaged");
const exe = packaged ? resolve("dist/win-unpacked/PapyrusPDF.exe") : electron;
if (packaged && !existsSync(exe)) { console.error(`Não achei ${exe}. Rode "npm run dist" antes.`); process.exit(1); }
if (!existsSync("test/fixtures/amostra.pdf") || !existsSync("test/fixtures/formulario.pdf")) spawnSync(process.execPath, ["test/fixtures.ts"], { stdio: "inherit" });
let failed = 0;
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
for (const [f, scenario] of [["amostra", ""], ["formulario", ""], ["escaneado", ""], ["amostra", "recursos"], ["amostra", "abas"]]) {
  if (only && only !== (scenario || f)) continue;
  const pdf = resolve(`test/fixtures/${f}.pdf`);
  const r = spawnSync(exe, packaged ? [pdf] : ["out/main/index.js", pdf], {
    env: { ...process.env, PAPIRO_E2E: resolve("test/e2e.mjs"), PAPIRO_E2E_PACKAGED: "1", PAPIRO_E2E_CASE: scenario }, encoding: "utf8", timeout: 300_000,
  });
  const lines = `${r.stdout}${r.stderr}`.split("\n").filter((l) => l.includes("[e2e]"));
  console.log(lines.join("\n"));
  if (r.status !== 0 || !lines.some((l) => l.includes("PASSOU"))) failed++;
}
console.log(failed ? `\n${failed} cenário(s) falharam.` : "\nTodos os cenários passaram. Capturas em test/e2e-out/");
process.exit(failed ? 1 : 0);
