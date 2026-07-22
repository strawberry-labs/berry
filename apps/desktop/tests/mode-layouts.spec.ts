import { expect, test, type Page } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

async function openTask(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await expect(page.getByRole("button", { name: "Fonts utilized in recreation", exact: true }).last()).toBeVisible();
}

test.describe("conversation presentation profiles", () => {
  test("Chat → Code → Chat keeps one task and restores retained Code pane state", async ({ page }) => {
    await seedWorkspace(page, (state) => {
      const task = state.tasks.dev_ws_1?.[0] as Record<string, unknown>;
      task.conversationKind = "chat";
    });
    await openTask(page);

    const before = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem("berry.dev.host") ?? "{}");
      const task = state.tasks.dev_ws_1[0];
      return { taskId: task.id, sessionId: task.activeSessionId, messageIds: state.messages[task.activeSessionId].map((message: { id: string }) => message.id) };
    });
    const permission = await page.getByRole("button", { name: /Ask before changes/ }).innerText();
    const model = await page.getByRole("button", { name: /berry\/router-auto/ }).innerText();

    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.locator('[data-conversation-kind="code"]')).toBeVisible();
    await page.getByRole("button", { name: "Toggle side pane" }).click();
    await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();
    await page.getByRole("tab", { name: "Review" }).click();

    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.locator('[data-conversation-kind="chat"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Toggle side pane" })).toHaveCount(0);
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Review", selected: true })).toBeVisible();

    await expect(page.getByRole("button", { name: /Ask before changes/ })).toContainText(permission.trim());
    await expect(page.getByRole("button", { name: /berry\/router-auto/ })).toContainText(model.trim());
    const after = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem("berry.dev.host") ?? "{}");
      const task = state.tasks.dev_ws_1[0];
      return { taskId: task.id, sessionId: task.activeSessionId, conversationKind: task.conversationKind, messageIds: state.messages[task.activeSessionId].map((message: { id: string }) => message.id) };
    });
    expect(after).toEqual({ ...before, conversationKind: "code" });
  });

  test("switching presentation during a running turn does not cancel or replace it", async ({ page }) => {
    await seedWorkspace(page);
    await openTask(page);
    const prompt = `Keep this turn alive ${Date.now()}`;
    await page.getByTestId("composer-input").fill(prompt);
    await page.keyboard.press("Enter");
    await expect(page.getByText(prompt)).toBeVisible();
    await expect(page.getByText(/Exploring workspace/).first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.locator('[data-conversation-kind="code"]')).toBeVisible();
    await expect(page.getByText(/Want me to make the change/).last()).toBeVisible({ timeout: 15_000 });
    const persisted = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem("berry.dev.host") ?? "{}");
      const task = state.tasks.dev_ws_1[0];
      return { id: task.id, sessionId: task.activeSessionId, kind: task.conversationKind, userTurns: state.messages[task.activeSessionId].filter((message: { role: string }) => message.role === "user").length };
    });
    expect(persisted).toMatchObject({ id: "dev_task_1", sessionId: "dev_session_1", kind: "code" });
    expect(persisted.userTurns).toBeGreaterThan(1);
  });

  test("Chat keeps goal and artifact work in the thread without mounting Code panes", async ({ page }) => {
    await seedWorkspace(page, (state) => {
      state.sessionTargets.dev_session_1 = {
        sessionId: "dev_session_1",
        goalText: "Finish the simplification",
        status: "active",
        createdAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:00:00.000Z",
      };
      (state.messages.dev_session_1 as Array<Record<string, unknown>>).push({
        id: "artifact_message",
        sessionId: "dev_session_1",
        role: "assistant",
        status: "complete",
        parts: [{
          id: "artifact_part",
          messageId: "artifact_message",
          kind: "tool-call",
          content: { toolCallId: "write_report", name: "write_file", arguments: { path: "plans/report.md" }, status: "completed" },
          position: 0,
          createdAt: "2026-07-20T12:00:00.000Z",
        }],
        createdAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:00:00.000Z",
      });
    });
    await openTask(page);
    await expect(page.getByTestId("session-goal-card")).toContainText("Finish the simplification");
    await expect(page.getByText("report.md").last()).toBeVisible();
    await expect(page.getByRole("button", { name: "Toggle side pane" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Toggle terminal" })).toHaveCount(0);
  });

  test("General Chats creates Chat and Code conversations in the scratch workspace", async ({ page }) => {
    await seedWorkspace(page, (state) => {
      state.workspaces.push({
        id: "dev_ws_general",
        path: "/Users/dev/Library/Application Support/Berry/General",
        name: "Chats",
        workspaceKind: "general",
        ownerUserId: null,
        trustState: "trusted",
        lastOpenedAt: "2026-07-20T12:00:00.000Z",
        indexedAt: null,
        createdAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:00:00.000Z",
      });
      state.tasks.dev_ws_general = [];
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Chats" }).click();
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByTestId("composer-input").fill("Create a scratch code conversation");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-conversation-kind="code"]')).toBeVisible();
    await page.getByRole("button", { name: "Chats" }).click();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByTestId("composer-input").fill("Create a scratch chat conversation");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-conversation-kind="chat"]')).toBeVisible();
    const created = await page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem("berry.dev.host") ?? "{}");
      return state.tasks.dev_ws_general.map((task: { workspaceId: string; conversationKind: string }) => ({
        workspaceId: task.workspaceId,
        conversationKind: task.conversationKind,
      }));
    });
    expect(created).toEqual(expect.arrayContaining([
      { workspaceId: "dev_ws_general", conversationKind: "code" },
      { workspaceId: "dev_ws_general", conversationKind: "chat" },
    ]));
  });
});
