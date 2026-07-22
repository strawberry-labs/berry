import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

test("task header shows sandbox enforcement and settings control workspace egress", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

  const sandboxBadge = page.getByText("Workspace sandbox", { exact: true });
  await expect(sandboxBadge).toBeVisible();
  await expect(sandboxBadge, "sandbox badge should identify enforced network-off policy").toHaveAttribute("title", /seatbelt enforcement; network off/);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "General", exact: true }).click();
  const network = page.getByRole("switch", { name: "Workspace sandbox network" });
  await expect(network).not.toBeChecked();
  await network.click();
  await expect(network).toBeChecked();
  const allowlist = page.getByLabel("Network domain allowlist");
  await allowlist.fill("api.example.com,*.docs.example.com");
  await allowlist.press("Enter");
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem("berry.dev.host") ?? "{}").settings);
  expect(settings["sandbox.workspaceWrite.network"]).toBe(true);
  expect(settings["network.domainAllowlist"]).toBe("api.example.com,*.docs.example.com");
});
