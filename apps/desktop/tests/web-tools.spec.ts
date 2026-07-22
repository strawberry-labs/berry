import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

test("web search settings persist provider, credential, endpoint, and fetch allowlist", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  await page.getByLabel("Web search provider").click();
  await page.getByRole("option", { name: "Brave Search" }).click();
  await page.getByLabel("Web search API key").fill("brave-test-key");
  await page.getByLabel("Web search API key").press("Enter");
  await expect(page.getByText("An encrypted API key is saved.")).toBeVisible();

  await page.getByLabel("Web search provider").click();
  await page.getByRole("option", { name: "SearXNG" }).click();
  await page.getByLabel("SearXNG instance URL").fill("http://127.0.0.1:8080");
  await page.getByLabel("SearXNG instance URL").press("Enter");
  await page.getByLabel("Private fetch allowlist").fill("docs.internal.test,*.corp.test");
  await page.getByLabel("Private fetch allowlist").press("Enter");

  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem("berry.dev.host") ?? "{}").settings);
  expect(settings).toMatchObject({
    "web.search.provider": "searxng",
    "web.search.searxngUrl": "http://127.0.0.1:8080",
    "web.fetch.privateAllowlist": "docs.internal.test,*.corp.test",
  });
});
