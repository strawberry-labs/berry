import { expect, test, chromium } from "@playwright/test";
import { resolve } from "node:path";

test("MV3 side panel loads from the unpacked extension", async () => {
  const extensionPath = resolve(import.meta.dirname, "../dist");
  const context = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/side-panel.html`);
    await expect(page.getByText("Berry", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Selection/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Full page/i })).toBeVisible();
  } finally {
    await context.close();
  }
});
