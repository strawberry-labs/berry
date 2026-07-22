import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

test("Review guides GitHub CLI installation and authentication", async ({ page, browserName }) => {
  await seedWorkspace(page, (state) => {
    (state.tasks.dev_ws_1[0] as Record<string, unknown>).conversationKind = "code";
    state.settings["git.pr.status"] = {
      installed: false,
      authenticated: false,
      version: null,
      hostname: "github.com",
      account: null,
      error: "GitHub CLI was not found on PATH.",
      setupCommands: ["brew install gh", "gh auth login --hostname github.com"],
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await page.getByTestId("composer-input").fill("/pr ");
  await page.keyboard.press("Enter");

  const setup = page.getByRole("region", { name: "GitHub CLI setup" });
  await expect(setup).toContainText("Not installed");
  await expect(setup).toContainText("brew install gh");
  await expect(setup).toContainText("gh auth login --hostname github.com");
  if (browserName === "chromium") {
    await page.waitForTimeout(300);
    await expect(setup).toHaveScreenshot("github-cli-setup.png");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await setup.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
});

test("Review generates an editable draft and creates a linked pull request", async ({ page, browserName }) => {
  await seedWorkspace(page, (state) => {
    const task = state.tasks.dev_ws_1?.[0] as Record<string, unknown> | undefined;
    if (!task) throw new Error("fixture task missing");
    task.worktreePath = "/Users/dev/.berry/worktrees/dev_task_1";
    task.worktreeBranch = "berry/pr-task";
    task.worktreeBaseRef = "main";
    task.worktreeBaseSha = "1".repeat(40);
    task.conversationKind = "code";
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await page.getByTestId("composer-input").fill("/pr ");
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Create pull request" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Title")).toHaveValue("Fonts utilized in recreation");
  await expect(dialog.getByLabel("Description")).toHaveValue(/## Summary/);
  await dialog.getByLabel("Title").fill("Edited PR title");
  await dialog.getByLabel("Description").fill("Edited body");
  await dialog.getByRole("switch", { name: "Create as draft" }).click();
  if (browserName === "chromium") {
    await page.waitForTimeout(300);
    await expect(dialog).toHaveScreenshot("create-pr-dialog.png");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await dialog.getByRole("button", { name: "Create PR" }).click();

  await expect(page.getByText("Pull request #42 created")).toBeVisible();
  const linkedPullRequest = page.getByRole("region", { name: "Task pull request" });
  await expect(linkedPullRequest).toContainText("https://github.com/berry-chat/berry/pull/42");
  await expect(linkedPullRequest.getByRole("button", { name: "Refresh pull request" })).toBeVisible();
  await expect(linkedPullRequest.getByRole("button", { name: "Open" })).toBeVisible();
  const linkedBounds = await linkedPullRequest.boundingBox();
  expect(linkedBounds).not.toBeNull();
  expect(linkedBounds!.x + linkedBounds!.width).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.getByTestId("composer-input").fill("/pr ");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Pull request #42 refreshed")).toBeVisible();
  const remoteThread = page.getByText("Keep the focus boundary when replacing this shell.").locator("..");
  await expect(remoteThread).toContainText("octo-reviewer");
  await expect(page.getByText("Outdated", { exact: true })).toBeVisible();
  await remoteThread.getByRole("button", { name: "Reply" }).click();
  await remoteThread.getByLabel("Reply to octo-reviewer").fill("Reply from Berry");
  await remoteThread.locator("form").getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByText("Reply from Berry")).toBeVisible();

  await page.getByRole("button", { name: "Comment on line 1" }).last().click();
  await page.getByLabel("Review comment").fill("New PR line comment");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByText("New PR line comment")).toBeVisible();
  if (browserName === "chromium") await expect(page.getByTestId("review-threads").first()).toHaveScreenshot("github-review-thread.png");
});
