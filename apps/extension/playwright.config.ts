import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  reporter: [["list"]],
  use: {
    viewport: { width: 390, height: 780 },
    colorScheme: "dark",
  },
});
