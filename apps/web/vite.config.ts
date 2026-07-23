import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // Keep Vite's tiny dynamic-import helper independent. Without this
        // boundary Rolldown co-locates it with an optional renderer chunk,
        // which makes the root bundle import that chunk on every refresh.
        manualChunks(id) {
          if (id.includes("vite/preload-helper")) return "vite-preload-helper";
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 3108,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
    // recharts is transpiled from the @berry/desktop-ui source graph; pin a
    // single React copy so its hooks share the app's renderer instance.
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: ["recharts"],
  },
  plugins: [
    tanstackStart(),
    viteReact(),
    tailwindcss(),
  ],
});
