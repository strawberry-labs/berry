import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "file-lifecycle.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  webServer: [
    {
      command: "node ../api/scripts/file-lifecycle-e2e-server.mjs",
      url: "http://127.0.0.1:3199/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "corepack pnpm exec vite dev --host 127.0.0.1 --port 3109 --strictPort",
      url: "http://127.0.0.1:3109",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        BERRY_WEB_API_BASE_URL: "http://127.0.0.1:3199",
        BERRY_WEB_DEMO_MODE: "false",
      },
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:3109",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
