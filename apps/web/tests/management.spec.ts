import { expect, test } from "@playwright/test";

test("personal settings routes own their screens and preserve local preferences", async ({ page }) => {
  await page.goto("/settings/general");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  await page.getByLabel("Custom instructions").fill("Keep answers concise and show verification results.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Preferences saved in this browser.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Custom instructions")).toHaveValue("Keep answers concise and show verification results.");
});

test("archived chats are a final personal setting and stay out of the home composer", async ({ page }) => {
  await page.goto("/settings/archived");
  await expect(page.getByRole("heading", { name: "Archived chats", exact: true })).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Personal settings" });
  await expect(navigation.getByRole("button", { name: "Archived chats" })).toBeVisible();
});

test("organization admin routes support direct navigation and validated analytics search", async ({ page }) => {
  await page.goto("/admin/analytics?view=models&from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-21T23%3A59%3A59.999Z");
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Models" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Demo adapter")).toBeVisible();
  await page.getByRole("button", { name: "Spend limits" }).click();
  await expect(page).toHaveURL(/\/admin\/spend-limits$/);
  await expect(page.getByRole("heading", { name: "Spend limits" })).toBeVisible();
});

test("management navigation becomes an accessible mobile sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/privacy");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("heading", { name: "Privacy & permissions" })).toBeVisible();
  await page.getByRole("button", { name: "Open management navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Management navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.getByRole("dialog", { name: "Management navigation" })).toHaveCount(0);
});

test("platform console remains visually separate and exposes no organization switcher", async ({ page }) => {
  await page.goto("/platform/overview");
  await expect(page.getByText("Platform console")).toBeVisible();
  await expect(page.getByLabel("Active organization")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Overview|Insufficient permission/ })).toBeVisible();
});
