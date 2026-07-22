import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

test("MCP settings add streamable HTTP, review imports, show health, and expose OAuth re-auth", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "MCP Servers", exact: true }).click();

  await page.getByRole("button", { name: "Add server" }).click();
  await page.getByLabel("Name").fill("Remote docs");
  await page.getByLabel("Transport").click();
  await page.getByRole("option", { name: "streamable-http" }).click();
  await page.getByLabel("URL").fill("https://mcp.example.test/mcp");
  await page.getByLabel("Authentication").click();
  await page.getByRole("option", { name: "Bearer API key" }).click();
  await page.getByLabel("API key", { exact: true }).fill("mcp-test-key");
  await page.getByRole("button", { name: "Add server" }).last().click();

  await expect(page.getByText("Remote docs", { exact: true })).toBeVisible();
  await expect(page.getByText("Untrusted").first()).toBeVisible();

  await page.getByRole("switch", { name: "Trust Remote docs" }).click();
  await page.getByRole("button", { name: "Reconnect Remote docs" }).click();
  await expect(page.getByText("3 tools")).toBeVisible();

  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.getByText("~/.codex/config.toml")).toBeVisible();
  await page.getByRole("button", { name: "Import 1" }).click();
  await expect(page.getByText("docs", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Add server" }).click();
  await page.getByLabel("Name").fill("OAuth connector");
  await page.getByLabel("Transport").click();
  await page.getByRole("option", { name: "streamable-http" }).click();
  await page.getByLabel("URL").fill("https://oauth-mcp.example.test/mcp");
  await page.getByLabel("Authentication").click();
  await page.getByRole("option", { name: "OAuth authorization code" }).click();
  await page.getByLabel("OAuth client ID").fill("berry-desktop");
  await page.getByLabel("Authorization URL").fill("https://auth.example.test/authorize");
  await page.getByLabel("Token URL").fill("https://auth.example.test/token");
  await page.getByRole("button", { name: "Add server", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Authorize" })).toBeVisible();

  await page.getByLabel("MCP tool deferral threshold").fill("55");
  await page.getByLabel("MCP tool deferral threshold").blur();
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem("berry.dev.host") ?? "{}").settings);
  expect(settings["mcp.toolDeferral.threshold"]).toBe(55);
});
