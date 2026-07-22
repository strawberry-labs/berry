import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@berry/desktop-ui": fileURLToPath(new URL("../../packages/desktop-ui/src", import.meta.url)),
    },
  },
  server: {
    strictPort: true,
  },
  build: {
    target: "es2022",
    manifest: true,
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (id.includes("node_modules/recharts")) return "vendor-recharts";
          if (id.includes("node_modules/@xterm")) return "vendor-xterm";
          if (id.includes("node_modules/shiki") || id.includes("node_modules/@shikijs")) return "vendor-shiki";
          return undefined;
        },
      },
    },
  },
});
