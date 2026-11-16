import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      // mupdf e tesseract.js carregam WASM/arquivos de dados do node_modules em tempo de execução
      externalizeDeps: true,
    },
  },
  preload: {
    build: { externalizeDeps: true },
  },
  renderer: {
    root: resolve("src/renderer"),
    build: {
      rollupOptions: { input: resolve("src/renderer/index.html") },
    },
    plugins: [react()],
  },
});
