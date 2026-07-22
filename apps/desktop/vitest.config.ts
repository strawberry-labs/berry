import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Playwright owns ./tests; vitest only runs unit tests colocated in src.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: true,
  },
});
