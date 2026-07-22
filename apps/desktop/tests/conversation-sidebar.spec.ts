import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

test.describe("shared conversation sidebar", () => {
  test("filters kinds and resets a project's five-row expansion after disclosure", async ({ page }) => {
    await seedWorkspace(page, (state) => {
      const now = "2026-07-20T12:00:00.000Z";
      state.tasks.dev_ws_1 = Array.from({ length: 106 }, (_, index) => ({
        id: `chat_${index}`,
        workspaceId: "dev_ws_1",
        title: `Chat ${index + 1}`,
        status: "completed",
        activeSessionId: `session_chat_${index}`,
        conversationKind: "chat",
        pinned: false,
        archived: false,
        deletedAt: null,
        createdAt: now,
        updatedAt: new Date(Date.parse(now) - index * 1_000).toISOString(),
      }));
      state.tasks.dev_ws_1.push({
        id: "code_1",
        workspaceId: "dev_ws_1",
        title: "Code conversation",
        status: "running",
        activeSessionId: "session_code_1",
        conversationKind: "code",
        pinned: false,
        archived: false,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    });

    await page.goto("/");
    await expect(page.getByRole("button", { name: "Show 101 more conversations" })).toBeVisible();
    await expect(page.locator(".berry-sidebar-task-row")).toHaveCount(5);
    const showMore = page.getByRole("button", { name: "Show 101 more conversations" });
    await showMore.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".berry-sidebar-task-row").filter({ hasText: /^Chat / })).toHaveCount(106);

    const project = page.getByRole("button", { name: /berry-chat/ }).first();
    await project.focus();
    await page.keyboard.press("Enter");
    await expect(project).toBeFocused();
    await expect(project).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(project).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: "Show 101 more conversations" })).toBeVisible();

    const code = page.getByRole("button", { name: "Code", exact: true });
    await code.focus();
    await page.keyboard.press("Enter");
    await expect(code).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /Code conversation/ })).toBeVisible();
    await expect(page.locator(".berry-sidebar-task-row").filter({ hasText: /^Chat [1-6]/ })).toHaveCount(0);
  });

  test("home selection changes only the next-conversation default", async ({ page }) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.getByRole("button", { name: "Code", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("berry.conversationKind"))).toBe("code");
    await expect(page.getByTestId("composer-input")).toBeVisible();
  });
});
