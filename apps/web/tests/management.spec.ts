import { expect, test } from "@playwright/test";

test("settings use the shared sidebar contract", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  const workspaceSidebarColor = await page.locator('[data-slot="sidebar-inner"]').evaluate((element) => getComputedStyle(element).backgroundColor);

  await page.goto("/settings/general");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  const sidebar = page.locator('[data-slot="sidebar"]');
  const sidebarContainer = page.locator('[data-slot="sidebar-container"]');
  const sidebarInner = page.locator('[data-slot="sidebar-inner"]');
  await expect(sidebarContainer).toBeVisible();
  await expect(sidebarInner).toBeVisible();
  expect(await sidebarInner.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(workspaceSidebarColor);

  const navigation = page.getByRole("navigation", { name: "Personal settings" });
  const general = navigation.getByRole("button", { name: "General", exact: true });
  await expect(general).toHaveAttribute("data-slot", "sidebar-menu-button");
  await expect(general).toHaveAttribute("data-active", "true");

  let toggle = page.getByRole("button", { name: "Toggle sidebar" });
  await toggle.click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  toggle = page.getByRole("button", { name: "Expand sidebar" });
  await toggle.click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");

  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+b`);
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+b`);
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});

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

test("archived tasks are a final personal setting and stay out of the home composer", async ({ page }) => {
  await page.goto("/settings/archived");
  await expect(page.getByRole("heading", { name: "Archived tasks", exact: true })).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Personal settings" });
  await expect(navigation.getByRole("button", { name: "Archived tasks" })).toBeVisible();
});

test("organization admin routes support direct navigation and validated analytics search", async ({ page }) => {
  await page.goto("/admin/analytics?view=models&from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-21T23%3A59%3A59.999Z");
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Models" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Demo adapter")).toHaveCount(0);
  await page.getByRole("button", { name: "Spend limits" }).click();
  await expect(page).toHaveURL(/\/admin\/spend-limits$/);
  await expect(page.getByRole("heading", { name: "Spend limits" })).toBeVisible();
});

test("organization branding uploads and timezone selection stay usable on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin/profile-domains");
  await expect(page.getByRole("heading", { name: "Organization settings" })).toBeVisible();
  await expect(page.getByText("Organization logo", { exact: true })).toBeVisible();
  await expect(page.getByText("Browser favicon", { exact: true })).toBeVisible();

  await page.getByLabel("Upload organization logo").setInputFiles({
    name: "aesg-logo.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>'),
  });
  await expect(page.getByText("Ready to save")).toBeVisible();

  await page.getByRole("button", { name: "Choose organization timezone" }).click();
  await page.getByPlaceholder("Search city, region, or UTC offset…").fill("UTC+4");
  await page.getByRole("option", { name: /Dubai.*UTC\+4/ }).click();
  await expect(page.getByRole("button", { name: "Choose organization timezone" })).toContainText("Dubai");
  await expect(page.getByRole("button", { name: "Choose organization timezone" })).toContainText("UTC+4");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("management navigation uses the shared mobile sidebar sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/privacy");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("heading", { name: "Privacy & permissions" })).toBeVisible();
  const toggle = page.getByRole("button", { name: "Toggle sidebar" });
  const mobileSidebar = page.locator('[data-slot="sidebar"][data-mobile="true"]');
  await toggle.click();
  await expect(mobileSidebar).toBeVisible();
  await expect(mobileSidebar.getByRole("navigation", { name: "Personal settings" })).toBeVisible();
  await mobileSidebar.getByRole("button", { name: "General", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(mobileSidebar).toHaveCount(0);
  await expect(toggle).toBeFocused();
});

test("platform console remains visually separate and exposes no organization switcher", async ({ page }) => {
  await page.goto("/platform/overview");
  await expect(page.getByText("Platform console")).toBeVisible();
  await expect(page.getByLabel("Active organization")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Overview|Insufficient permission/ })).toBeVisible();
});
