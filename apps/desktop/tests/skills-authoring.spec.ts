import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

test("skills default to project scope and import reviewed .skill packages", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Skills", exact: true }).click();

  await page.getByRole("button", { name: "New skill" }).click();
  await page.getByLabel("Name").fill("release-notes");
  await page.getByLabel("Description").fill("Draft release notes from merged work");
  await page.getByLabel("Version").fill("1.0.0");
  await page.getByRole("button", { name: "Create skill" }).click();
  await expect(page.getByText("release-notes", { exact: true })).toBeVisible();
  await expect(page.getByText("v1.0.0")).toBeVisible();
  await expect(page.getByText("Project", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Import skill" }).click();
  await page.getByLabel("Path").fill("/tmp/report-skill.skill");
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Install report-skill" })).toBeVisible();
  await expect(page.getByText("Current project", { exact: false })).toBeVisible();
  await expect(page.getByText("Contains 1 executable-script resource", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Install skill" }).click();
  await expect(page.getByRole("heading", { name: "report-skill is ready" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open skill" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use $report-skill" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("report-skill", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Import skill" }).click();
  await page.getByLabel("Path").fill("/tmp/report-skill.skill");
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.getByText("A project skill with this name already exists.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Install skill" })).toBeDisabled();
  await page.getByRole("button", { name: "Replace" }).click();
  await page.getByRole("button", { name: "Install skill" }).click();
  await expect(page.getByRole("heading", { name: "report-skill is ready" })).toBeVisible();
});
