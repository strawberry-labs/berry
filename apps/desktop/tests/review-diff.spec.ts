import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

async function openReview(page: import("@playwright/test").Page) {
  await seedWorkspace(page, (state) => { (state.tasks.dev_ws_1[0] as Record<string, unknown>).conversationKind = "code"; });
  await page.goto("/");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await page.getByRole("button", { name: "Toggle side pane" }).click();
  await page.getByRole("tab", { name: "Review" }).click();
}

test("review diff highlights words, syntax, and virtualizes large files", async ({ page }, testInfo) => {
  await openReview(page);

  const composer = page.locator('[data-diff-file="apps/desktop/src/components/composer.tsx"]');
  await expect(composer.getByText("berry-composer-shell", { exact: false })).toBeVisible();
  await expect(composer.locator('[data-word-change="true"]')).not.toHaveCount(0);
  await expect(composer.locator("[data-shiki-token]")).not.toHaveCount(0);

  await page.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByText("Review started")).toBeVisible();
  await page.getByRole("button", { name: "AI review" }).click();
  await expect(page.getByText("AI review verified")).toBeVisible();
  await expect(page.getByText("Composer shell loses its focus boundary")).toBeVisible();
  await page.getByRole("button", { name: "Add as comment" }).click();
  await expect(page.getByText("Composer shell loses its focus boundary").last()).toBeVisible();
  await page.getByRole("button", { name: "Apply suggestion" }).click();
  await expect(page.getByText("Suggestion applied")).toBeVisible();
  await expect(page.getByRole("button", { name: "Applied" })).toBeDisabled();
  await composer.getByRole("button", { name: "Comment on line 1" }).last().click();
  await page.getByLabel("Review comment").fill("Keep the shell class covered by a layout test.");
  await page.getByRole("button", { name: "Add comment" }).click();
  const manualThread = page.getByText("Keep the shell class covered by a layout test.").locator("..");
  await expect(manualThread).toBeVisible();
  await manualThread.getByRole("button", { name: "Resolve" }).click();
  await expect(manualThread.getByRole("button", { name: "Reopen" })).toBeVisible();
  await manualThread.getByRole("button", { name: "Reopen" }).click();
  await expect(manualThread.getByRole("button", { name: "Resolve" })).toBeVisible();
  if (testInfo.project.name === "chromium") await expect(page).toHaveScreenshot("review-comment-thread.png");

  await page.getByRole("button", { name: "Toggle diff for apps/desktop/src/components/composer.tsx" }).click();
  await expect(composer.getByText("berry-composer-shell", { exact: false })).toBeHidden();
  await page.getByRole("button", { name: "Toggle diff for apps/desktop/src/components/composer.tsx" }).click();

  await page.getByTitle("apps/desktop/src/components/work-pane.tsx").click();
  const largeFile = page.locator('[data-diff-file="apps/desktop/src/components/work-pane.tsx"]');
  const viewport = largeFile.locator('[data-virtualized="true"]');
  await expect(viewport).toHaveAttribute("data-line-count", "241");
  await expect(largeFile.getByText("reviewRow000", { exact: false })).toBeVisible();
  await expect(largeFile.getByText("reviewRow239", { exact: false })).toHaveCount(0);
  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
  await expect(largeFile.getByText("reviewRow239", { exact: false })).toBeVisible();
  await expect(largeFile.getByText("reviewRow000", { exact: false })).toHaveCount(0);

  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await expect(page.getByText("Review completed")).toBeVisible();
  await expect(page.getByLabel("Review comment")).toHaveCount(0);
});
