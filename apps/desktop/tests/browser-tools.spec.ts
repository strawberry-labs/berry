import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

test("agent-driven browser sessions appear live in the work pane", async ({ page }) => {
  await seedWorkspace(page, (state) => { (state.tasks.dev_ws_1[0] as Record<string, unknown>).conversationKind = "code"; });
  await page.goto("/");
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await page.getByRole("button", { name: "Toggle side pane" }).click();
  await page.getByRole("tab", { name: "Browser" }).click();
  await expect(page.getByText("No browser tabs")).toBeVisible();

  await page.getByTestId("composer-input").fill("Run the agent browser live fixture");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("tab", { name: "example.test" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel("Browser URL")).toHaveValue("https://example.test/agent-driven");
});

test("browser screenshot tool-call parts appear in the artifact strip", async ({ page }) => {
  await seedWorkspace(page, (state) => {
    const task = state.tasks.dev_ws_1[0] as Record<string, unknown>;
    task.conversationKind = "chat";
    const messages = state.messages.dev_session_1 as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message.role === "assistant")!;
    const parts = assistant.parts as unknown[];
    parts.push({
      id: "browser_screenshot_part",
      messageId: assistant.id,
      kind: "tool-call",
      content: {
        toolCallId: "call_browser_screenshot",
        name: "browser_screenshot",
        arguments: { session_id: "browser_1", url: "https://example.test" },
        status: "completed",
        output: {
          text: "Saved browser screenshot artifact",
          artifact: { kind: "browser-screenshot", path: "artifacts/browser/shot.png" },
        },
      },
      position: 2,
      createdAt: "2026-07-01T12:00:00.000Z",
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await expect(page.getByTitle("artifacts/browser/shot.png")).toBeVisible();
});
