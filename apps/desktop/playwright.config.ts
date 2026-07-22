import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  // Keep pre-projects snapshot names (name-darwin.png) so existing baselines
  // stay valid; only chromium takes screenshots, so names can't collide.
  snapshotPathTemplate: "{testDir}/{testFileDir}/{testFileName}-snapshots/{arg}-{platform}{ext}",
  use: {
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1280, height: 860 },
    colorScheme: "dark",
    timezoneId: "America/New_York",
  },
  // The shipped app runs in WKWebView (Tauri), not Chromium, so every
  // functional spec runs on both engines. Pixel snapshots stay chromium-only
  // to keep one baseline set per OS.
  // Only browserName per project — device presets would override the shared
  // viewport above and invalidate the screenshot baselines.
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "webkit",
      use: { browserName: "webkit" },
    },
  ],
  expect: {
    toHaveScreenshot: {
      // Fonts and shimmer animations produce minor pixel drift between runs.
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
    },
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    timeout: 60000,
  },
});
