import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "duplicate-submit.spec.ts",
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:3111", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    { command: "node ../../scripts/duplicate-submit-browser-server.mjs", url: "http://127.0.0.1:3199/__e2e/state", reuseExistingServer: false, timeout: 30_000 },
    {
      command: "BERRY_WEB_API_BASE_URL=http://127.0.0.1:3199 BERRY_WEB_DEMO_MODE=false corepack pnpm exec vite dev --host 127.0.0.1 --port 3111 --strictPort",
      url: "http://127.0.0.1:3111",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  expect: { timeout: 15_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
