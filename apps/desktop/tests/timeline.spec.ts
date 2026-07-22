import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

test("task timeline separates file and conversation restore scopes", async ({ page, browserName }) => {
  await seedWorkspace(page, (state) => {
    const now = "2026-07-01T12:04:00.000Z";
    state.messages.dev_session_1 = [
      message("dev_msg_user_one", "user", "First question", "2026-07-01T12:00:00.000Z"),
      message("dev_msg_assistant_one", "assistant", "First answer", "2026-07-01T12:01:00.000Z"),
      message("dev_msg_user_two", "user", "Second question", "2026-07-01T12:02:00.000Z"),
      message("dev_msg_assistant_two", "assistant", "Second answer", "2026-07-01T12:03:00.000Z"),
    ];
    state.gitCheckpoints = [{
      kind: "checkpoint",
      id: "dev_checkpoint_known_good",
      taskId: "dev_task_1",
      sessionId: "dev_session_1",
      entryId: "dev_msg_user_two",
      commitSha: "a1b2c3d4e5f67890123456789012345678901234",
      message: "Known good before dependency update",
      reason: "manual",
      createdAt: now,
    }];
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Task timeline" }).click();

  const dialog = page.getByRole("dialog", { name: "Task timeline" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Known good before dependency update")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Restore files from Known good before dependency update" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Restore conversation from Known good before dependency update" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Restore both from Known good before dependency update" })).toBeVisible();
  await expect(dialog.getByText("Second question")).toBeVisible();
  expect(Number.parseFloat(await dialog.getByRole("button", { name: "Checkpoint now" }).evaluate((element) => getComputedStyle(element).height))).toBeGreaterThanOrEqual(40);
  expect(Number.parseFloat(await dialog.getByRole("button", { name: "Restore files from Known good before dependency update" }).evaluate((element) => getComputedStyle(element).height))).toBeGreaterThanOrEqual(40);
  if (browserName === "chromium") await expect(page).toHaveScreenshot("task-timeline.png");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Restore both from Known good before dependency update" })).toBeVisible();

  await dialog.getByRole("button", { name: "Restore conversation from Second question" }).click();
  await expect(dialog.getByText("Second question")).toHaveCount(0);
  await page.keyboard.press("Escape");
  const messages = page.getByLabel("Messages");
  await expect(messages.getByText("First question")).toBeVisible();
  await expect(messages.getByText("Second question")).toHaveCount(0);
});

test("task timeline creates a persisted checkpoint", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Task timeline" }).click();

  const timeline = page.getByTestId("task-timeline");
  await page.getByRole("button", { name: "Checkpoint now" }).click();
  await expect(timeline.locator('[data-timeline-kind="checkpoint"]')).toHaveCount(1);
  await expect(page.getByText("Checkpoint created")).toBeVisible();
});

function message(id: string, role: "user" | "assistant", content: string, createdAt: string) {
  return {
    id,
    sessionId: "dev_session_1",
    role,
    status: "complete",
    parts: [{ id: `${id}_part`, messageId: id, kind: "text", content, position: 0, createdAt }],
    createdAt,
    updatedAt: createdAt,
  };
}
