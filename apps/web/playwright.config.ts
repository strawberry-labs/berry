import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "list",
  webServer: {
    command: "corepack pnpm dev",
    url: "http://127.0.0.1:3108",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: "http://127.0.0.1:3108",
    trace: "retain-on-failure",
  },
  // The shared desktop-ui graph is intentionally broad; under the default
  // seven-worker Chromium fan-out, the first TanStack Start hydration can
  // take longer than the library's five-second assertion default.
  expect: {
    timeout: 15_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
