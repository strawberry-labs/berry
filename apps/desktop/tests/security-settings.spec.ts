import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

test("security settings manage grants, rules, sandbox defaults, and audit exports", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Security", exact: true }).click();

  await expect(page.getByText("Managed by Acme", { exact: true })).toBeVisible();
  await expect(page.getByTestId("managed-policy-provenance").getByText("models", { exact: true })).toBeVisible();
  await expect(page.getByText("mcp:docs:search", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Revoke mcp:docs:search" }).click();
  await expect(page.getByText("No persistent grants", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Execpolicy" }).click();
  await expect(page.getByText("Managed safety baseline", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit sudo" })).toBeDisabled();
  await page.getByRole("button", { name: "Add rule" }).click();
  await page.getByLabel("Layer").click();
  await page.getByRole("option", { name: "Workspace" }).click();
  await page.getByLabel("Pattern").fill('["pnpm","lint"]');
  await page.getByLabel("Description").fill("Allow workspace lint");
  await page.getByRole("button", { name: "Add rule", exact: true }).last().click();
  await expect(page.getByText("Allow workspace lint", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Sandbox" }).click();
  await page.getByRole("switch", { name: "Network egress" }).click();
  await page.getByLabel("Domain allowlist").fill("api.example.com");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await page.getByRole("tab", { name: "Browser extension" }).click();
  await expect(page.getByText("Chrome side panel bridge", { exact: true })).toBeVisible();
  await page.getByPlaceholder("Chrome extension id, 32 chars a-p").fill("abcdefghijklmnopabcdefghijklmnop");
  await page.getByRole("button", { name: "Enable" }).click();
  await expect(page.getByText("Browser extension bridge enabled")).toBeVisible();
  await expect(page.getByText("com.berry.desktop_host", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Audit" }).click();
  await expect(page.getByText("rule-created", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  await expect(page.getByText(/audit events exported/)).toBeVisible();
});
