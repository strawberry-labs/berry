import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

test("plugins install from git, confirm unsigned capabilities, review updates, and uninstall", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Plugins", exact: true }).click();

  await page.getByLabel("Plugin source type").click();
  await page.getByRole("option", { name: "Git" }).click();
  await page.getByLabel("Plugin git URL").fill("https://example.test/berry-plugin.git");
  await page.getByRole("button", { name: "Install", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Trust unsigned plugin?" })).toBeVisible();
  await expect(page.getByText("command: plugin-command", { exact: true })).toBeVisible();
  await expect(page.getByText("skill: plugin-skill", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Trust plugin" }).click();

  await expect(page.getByText("Git tools", { exact: true })).toBeVisible();
  await expect(page.getByText("01234567", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Check update" }).click();
  await expect(page.getByRole("heading", { name: "Review plugin update" })).toBeVisible();
  await expect(page.getByText("+ mcp:new-connector", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply update" }).click();

  await expect(page.getByText("2.0.0", { exact: true })).toBeVisible();
  await expect(page.getByText("1 MCP", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove Git tools" }).click();
  await expect(page.getByText("Git tools", { exact: true })).toHaveCount(0);
});
