import { cpSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = resolve(import.meta.dirname);

export default defineConfig({
  plugins: [
    react(),
    {
      name: "berry-extension-assets",
      closeBundle() {
        cpSync(resolve(root, "src/manifest.json"), resolve(root, "dist/manifest.json"));
        cpSync(resolve(root, "src/icons"), resolve(root, "dist/icons"), { recursive: true });
      },
    },
  ],
  build: {
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        "side-panel": resolve(root, "side-panel.html"),
        background: resolve(root, "src/background.ts"),
        "content-script": resolve(root, "src/content-script.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
