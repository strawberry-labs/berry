import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

test("associated worktree branch appears on the task row", async ({ page }) => {
  await seedWorkspace(page, (state) => {
    const task = state.tasks.dev_ws_1?.[0] as Record<string, unknown> | undefined;
    if (!task) throw new Error("fixture task missing");
    task.worktreePath = "/Users/dev/.berry/worktrees/dev_task_1";
    task.worktreeBranch = "berry/parallel-fix";
    task.worktreeBaseRef = "main";
    task.worktreeBaseSha = "1".repeat(40);
  });
  await page.goto("/");

  const taskRow = page.getByRole("button", { name: /Fonts utilized in recreation/ });
  const branchIcon = taskRow.getByLabel("Worktree berry/parallel-fix");
  await expect(branchIcon).toBeVisible();
  await expect(branchIcon.locator("..")).toHaveAttribute("title", "Worktree: berry/parallel-fix");
});

test("worktree changes preview, prepare as a branch, and apply back", async ({ page, browserName }) => {
  await seedWorkspace(page, (state) => {
    const task = state.tasks.dev_ws_1?.[0] as Record<string, unknown> | undefined;
    if (!task) throw new Error("fixture task missing");
    task.worktreePath = "/Users/dev/.berry/worktrees/dev_task_1";
    task.worktreeBranch = "berry/parallel-fix";
    task.worktreeBaseRef = "main";
    task.worktreeBaseSha = "1".repeat(40);
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Merge worktree changes" }).click();

  const dialog = page.getByRole("dialog", { name: "Merge worktree changes" });
  await expect(dialog).toContainText("Applies cleanly");
  await expect(dialog).toContainText("1 file");
  await expect(dialog).toContainText("src/example.ts");
  if (browserName === "chromium") {
    await page.waitForTimeout(300);
    await expect(dialog).toHaveScreenshot("worktree-merge.png");
  }

  await dialog.getByRole("button", { name: "Prepare branch for PR" }).click();
  await expect(page.getByText("Branch berry/parallel-fix is ready for a pull request")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole("button", { name: "Apply to main" })).toBeVisible();
  const mobileBounds = await dialog.boundingBox();
  expect(mobileBounds).not.toBeNull();
  expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
  expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(390);
  await dialog.getByRole("button", { name: "Apply to main" }).click();
  await expect(page.getByText(/Applied \d+ files? to the main workspace/)).toBeVisible();
  await expect(dialog).toBeHidden();
});

test("home composer starts a task in an isolated worktree", async ({ page, browserName }) => {
  await seedWorkspace(page);
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Worktree" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  if (browserName === "chromium") await expect(page).toHaveScreenshot("new-worktree-task.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toggle).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.getByTestId("composer-input").fill("Implement isolated task routing");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByRole("button", { name: /Implement isolated task routing/ }).getByLabel(/^Worktree berry\/task-/)).toBeVisible();
});

test("command palette primes a new worktree task", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.keyboard.press("Meta+k");
  await page.getByPlaceholder(/Search actions/).fill("New code chat in worktree");
  await page.getByText("New code chat in worktree", { exact: true }).click();

  await expect(page.getByRole("button", { name: "Worktree" })).toHaveAttribute("aria-pressed", "true");
});

test("archiving a clean worktree can remove it", async ({ page }) => {
  await seedWorkspace(page, (state) => {
    const task = state.tasks.dev_ws_1?.[0] as Record<string, unknown> | undefined;
    if (!task) throw new Error("fixture task missing");
    task.worktreePath = "/Users/dev/.berry/worktrees/dev_task_1";
    task.worktreeBranch = "berry/parallel-fix";
    task.worktreeBaseRef = "main";
    task.worktreeBaseSha = "1".repeat(40);
    state.gitChangedFiles.splice(0);
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Archive task" }).click();

  const dialog = page.getByRole("alertdialog", { name: "Archive worktree task?" });
  await expect(dialog).toContainText("The worktree is clean");
  await dialog.getByRole("button", { name: "Remove and archive" }).click();
  await expect(page.getByText("Worktree removed and task archived")).toBeVisible();
  await expect(dialog).toBeHidden();
});

test("archiving a dirty worktree keeps it by default", async ({ page }) => {
  await seedWorkspace(page, (state) => {
    const task = state.tasks.dev_ws_1?.[0] as Record<string, unknown> | undefined;
    if (!task) throw new Error("fixture task missing");
    task.worktreePath = "/Users/dev/.berry/worktrees/dev_task_1";
    task.worktreeBranch = "berry/parallel-fix";
    task.worktreeBaseRef = "main";
    task.worktreeBaseSha = "1".repeat(40);
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Archive task" }).click();

  const dialog = page.getByRole("alertdialog", { name: "Archive worktree task?" });
  await expect(dialog).toContainText("uncommitted changes");
  await expect(dialog.getByRole("button", { name: "Remove and archive" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Keep and archive" }).click();
  await expect(page.getByText("Task archived; worktree kept")).toBeVisible();
});
