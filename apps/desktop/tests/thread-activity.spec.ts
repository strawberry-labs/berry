import { expect, test, type Page } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

/**
 * Turn activity accordion (Codex `IO`/`LO`/`RO` semantics) driven end-to-end
 * through the dev-host stream simulator: pinned open while working, collapses
 * exactly once when the final answer starts, manual choice wins and survives
 * the live → persisted handoff, cancellation pins the block open, and a turn
 * always renders exactly one "Worked" block (no live/persisted duplicate).
 */

async function openThreadAndSend(page: Page, input: string): Promise<void> {
  await seedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await page.getByTestId("composer-input").fill(input);
  await page.keyboard.press("Enter");
}

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(String(error)));
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

test("dark mode uses the approved sidebar, canvas, and prompt surfaces", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

  const surfaces = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      mainToken: rootStyle.getPropertyValue("--berry-main-bg").trim(),
      sidebarToken: rootStyle.getPropertyValue("--berry-sidebar-bg").trim(),
      controlToken: rootStyle.getPropertyValue("--berry-control-bg").trim(),
      main: getComputedStyle(document.querySelector<HTMLElement>(".berry-main-panel")!).backgroundColor,
      sidebar: getComputedStyle(document.querySelector<HTMLElement>('[data-slot="sidebar-inner"]')!).backgroundColor,
      composer: getComputedStyle(document.querySelector<HTMLElement>(".berry-composer-card")!).backgroundColor,
      userMessage: getComputedStyle(document.querySelector<HTMLElement>(".berry-user-message")!).backgroundColor,
      composerMonoOverrides: document.querySelector<HTMLElement>(".berry-composer-root")!.querySelectorAll(".font-mono").length,
      modelFamily: getComputedStyle(document.querySelector<HTMLElement>(".berry-composer-model-label")!).fontFamily,
      permissionFamily: getComputedStyle(document.querySelector<HTMLElement>(".berry-composer-permission-label")!).fontFamily,
      modelWeight: getComputedStyle(document.querySelector<HTMLElement>(".berry-composer-model-label")!).fontWeight,
      permissionWeight: getComputedStyle(document.querySelector<HTMLElement>(".berry-composer-permission-label")!).fontWeight,
    };
  });

  expect(surfaces.modelFamily).toBe(surfaces.permissionFamily);
  expect(surfaces.modelWeight).toBe(surfaces.permissionWeight);
  expect(surfaces).toMatchObject({
    mainToken: "#181818",
    sidebarToken: "#242424",
    controlToken: "#2d2d2d",
    main: "rgb(24, 24, 24)",
    sidebar: "rgb(36, 36, 36)",
    composer: "rgb(45, 45, 45)",
    userMessage: "rgb(36, 36, 36)",
    composerMonoOverrides: 0,
  });
});

test("chat rows expose pin and archive actions on hover", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");

  const chat = page.locator(".berry-sidebar-task-row", { hasText: "Fonts utilized in recreation" });
  await expect(page.getByLabel("Code conversation")).toHaveCount(0);
  await expect(page.getByLabel("Chat conversation")).toHaveCount(0);
  await expect(chat.locator(".berry-sidebar-row-title")).not.toHaveCSS("mask-image", "none");
  await expect(chat).toHaveCSS("padding-right", "10px");
  await chat.hover();
  await expect(chat).toHaveCSS("padding-right", "64px");
  await expect(page.getByRole("button", { name: "Pin Fonts utilized in recreation" })).toBeVisible();
  const archive = page.getByRole("button", { name: "Archive Fonts utilized in recreation" });
  await expect(archive).toBeVisible();
  await archive.hover();
  await expect(chat).toHaveCSS("padding-right", "64px");
  await expect(chat.locator(".berry-sidebar-task-meta")).toHaveCSS("opacity", "0");
  await expect(page.getByRole("button", { name: "New chat in berry-chat" })).toHaveCSS("opacity", "0");
  await expect(page.getByRole("button", { name: "Actions for berry-chat" })).toHaveCSS("opacity", "0");

  await page.getByRole("button", { name: "Pin Fonts utilized in recreation" }).click();
  await expect(page.getByRole("button", { name: "Unpin Fonts utilized in recreation" })).toBeAttached();

  await chat.hover();
  await archive.click();
  await expect(chat).toHaveCount(0);
});

test("project rows expose new-chat and project management actions", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");

  const project = page.locator(".berry-sidebar-workspace-row", { hasText: "berry-chat" });
  await project.hover();
  await expect(page.getByRole("button", { name: "New chat in berry-chat" })).toBeVisible();
  await page.getByRole("button", { name: "Actions for berry-chat" }).click();
  await expect(page.getByRole("menuitem", { name: "Pin project" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Reveal in Finder" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Rename project" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Archive chats" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove" })).toBeVisible();

  await page.getByRole("menuitem", { name: "Pin project" }).click();
  await project.hover();
  await page.getByRole("button", { name: "Actions for berry-chat" }).click();
  await page.getByRole("menuitem", { name: "Rename project" }).click();
  await page.getByLabel("Project name").fill("Berry renamed");
  await page.keyboard.press("Enter");
  await expect(page.locator(".berry-sidebar-workspace-row", { hasText: "Berry renamed" })).toBeVisible();
});

test.describe("turn activity accordion", () => {
  test("open with full activity for the whole run, collapses once at completion", async ({ page }) => {
    await openThreadAndSend(page, "Trace the accordion behavior");

    const header = page.getByTestId("turn-activity");
    // The entire live run stays open: every parent-level row is visible while
    // tools stream (Berry), including while the answer decodes below.
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Exploring workspace").first()).toBeVisible({ timeout: 10000 });
    await expect(header).toHaveAttribute("aria-expanded", "true");

    // Settled: collapses exactly once, one "Worked for Xs" block, tools hidden.
    await expect(page.getByText("Want me to make the change?")).toBeVisible({ timeout: 15000 });
    await expect(header).toHaveAttribute("aria-expanded", "false", { timeout: 10000 });
    await expect(page.getByText(/^Worked for /)).toHaveCount(1);
    await expect(page.getByText("Exploring workspace")).toBeHidden();

    // Expanding a settled turn reveals the activity again (rows retained).
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Exploring workspace").first()).toBeVisible();
  });

  test("manual collapse mid-run rolls the latest action; re-expand survives completion", async ({ page }) => {
    await openThreadAndSend(page, "Check manual toggle persistence");

    const header = page.getByTestId("turn-activity");
    await expect(page.getByText("Exploring workspace").first()).toBeVisible({ timeout: 10000 });

    // Collapsing a running turn keeps progress visible: the latest tool
    // action rolls on its own line under the divider.
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("turn-activity-live-action")).toBeVisible();

    // Re-expanding records the user's choice, which must beat the settled
    // default (collapsed) across the live → persisted handoff.
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("Want me to make the change?")).toBeVisible({ timeout: 15000 });
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(/^Worked for /)).toHaveCount(1);
    await expect(page.getByText("Exploring workspace").first()).toBeVisible();
  });

  test("explore group header rolls the newest child action while running", async ({ page }) => {
    await openThreadAndSend(page, "Roll the explore summary");

    // The two dev-sim reads fold into one Explore group; while it runs, its
    // collapsed header shows the newest child action (Berry aZ)...
    const roll = page.locator(".berry-roll-enter").first();
    await expect(roll).toContainText("package.json", { timeout: 10000 });
    // ...and rolls to the next action when it arrives (paced ≥800ms/item).
    await expect(roll).toContainText("README.md", { timeout: 10000 });

    // Settled: expanding the turn shows the group's static counts summary.
    await expect(page.getByText("Want me to make the change?")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("turn-activity").click();
    await expect(page.getByRole("button", { name: /Explore · 2 files/ })).toBeVisible();
  });

  test("batched explore reads still show the first action before rolling to the newest", async ({ page }) => {
    await page.addInitScript(() => {
      const originalSetTimeout = window.setTimeout.bind(window);
      const batched: Array<() => void> = [];
      let batchId: number | null = null;
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        const run = () => {
          if (typeof handler === "function") handler(...args);
          else originalSetTimeout(handler, 0);
        };
        if (timeout === 200 || timeout === 1250) {
          batched.push(run);
          if (batchId == null) {
            batchId = originalSetTimeout(() => {
              const queue = batched.splice(0);
              batchId = null;
              for (const item of queue) item();
            }, 200);
          }
          return batchId;
        }
        if (timeout === 380) return originalSetTimeout(handler, 230, ...args);
        if (timeout === 1450) return originalSetTimeout(handler, 260, ...args);
        return originalSetTimeout(handler, timeout, ...args);
      }) as typeof window.setTimeout;
    });
    await openThreadAndSend(page, "Batch the explore reads");

    const roll = page.locator(".berry-roll-enter").first();
    await expect(roll).toContainText("package.json", { timeout: 10000 });
    await expect(roll).toContainText("README.md", { timeout: 10000 });
  });

  test("toggling the explore group open and closed never crashes the renderer", async ({ page }) => {
    // Regression: RollingSummary once called a hook behind a short-circuit,
    // so flipping `enabled` on toggle changed the hook order and gray-screened.
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));

    await openThreadAndSend(page, "Toggle the explore group");
    await expect(page.getByText("Want me to make the change?")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("turn-activity").click();
    await page.getByRole("button", { name: /Explore · 2 files/ }).click();
    await expect(page.getByText("package.json").first()).toBeVisible();
    await page.getByText("Explore", { exact: true }).click();
    await expect(page.getByText("package.json")).toBeHidden();
    const closedExplore = page.getByRole("button", { name: /Explore.*2 files/ });
    await expect(closedExplore).toHaveAttribute("aria-expanded", "false");
    await expect(closedExplore.locator(".berry-roll-enter")).toHaveCount(0);

    expect(errors).toEqual([]);
    await expect(page.getByTestId("turn-activity")).toBeVisible();
  });

  test("active reasoning keeps the Thinking label shimmering after text appears", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      const original = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        original(handler, typeof timeout === "number" && timeout >= 3260 ? timeout + 1000 : timeout, ...args)) as typeof window.setTimeout;
    });

    await openThreadAndSend(page, "Hold reasoning open for shimmer");
    await expect(page.getByText(/I checked the workspace shape/)).toBeVisible({ timeout: 10000 });

    const thought = page.locator("div.flex.w-full.flex-col").filter({ has: page.getByText(/I checked the workspace shape/) }).first();
    await expect(thought.locator(".berry-shimmer").filter({ hasText: "Thinking" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("thread reasoning setting opens settled thought rows", async ({ page }) => {
    await seedWorkspace(page, (state) => {
      const now = "2026-07-01T12:00:00.000Z";
      state.settings["thread.showReasoning"] = true;
      state.messages.dev_session_1 = [
        {
          id: "dev_msg_user_reasoning",
          sessionId: "dev_session_1",
          role: "user",
          status: "complete",
          parts: [
            {
              id: "reasoning_user_text",
              messageId: "dev_msg_user_reasoning",
              kind: "text",
              content: "Show the reasoning setting",
              position: 0,
              createdAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_msg_assistant_reasoning",
          sessionId: "dev_session_1",
          role: "assistant",
          status: "complete",
          parts: [
            {
              id: "reasoning_part",
              messageId: "dev_msg_assistant_reasoning",
              kind: "reasoning",
              content: "I inspected the reasoning settings path.",
              position: 0,
              createdAt: now,
            },
            {
              id: "reasoning_answer",
              messageId: "dev_msg_assistant_reasoning",
              kind: "text",
              content: "Reasoning display is enabled.",
              position: 1,
              createdAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
      ];
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    await page.getByTestId("turn-activity").click();
    const thought = page.getByRole("button", { name: /Thought for a few seconds/ });
    await expect(thought).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("I inspected the reasoning settings path.")).toBeVisible();
  });

  test("settled markdown code blocks honor code preview settings", async ({ page }) => {
    await seedWorkspace(page, (state) => {
      const now = "2026-07-01T12:00:00.000Z";
      state.settings["codePreview.lightTheme"] = "github-light";
      state.settings["codePreview.darkTheme"] = "github-light";
      state.settings["codePreview.fontSize"] = 17;
      state.settings["codePreview.lineNumbers"] = false;
      state.settings["codePreview.wordWrap"] = true;
      state.messages.dev_session_1 = [
        {
          id: "dev_msg_user_code",
          sessionId: "dev_session_1",
          role: "user",
          status: "complete",
          parts: [{ id: "code_user_text", messageId: "dev_msg_user_code", kind: "text", content: "Show code", position: 0, createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_msg_assistant_code",
          sessionId: "dev_session_1",
          role: "assistant",
          status: "complete",
          parts: [
            {
              id: "code_answer",
              messageId: "dev_msg_assistant_code",
              kind: "text",
              content: "```ts\nconst total = items.length;\nreturn total;\n```",
              position: 0,
              createdAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
      ];
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    const block = page.locator('[data-language="ts"]').first();
    await expect(block).toHaveAttribute("data-highlight-status", "highlighted", { timeout: 10000 });
    const code = block.locator("pre");
    await expect(code).toHaveAttribute("data-code-theme", "github-light");
    await expect(code).toHaveCSS("font-size", "17px");
    await expect(block.locator("[data-shiki-token]").first()).toHaveCSS("color", /rgb\(/);
    await expect(block.locator("span[aria-hidden]")).toHaveCount(0);
  });

  test("edit-and-resubmit rewinds the dev-host message projection", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    await page.getByRole("button", { name: "Edit message" }).click();
    await page.getByTestId("message-editor-input").fill("Which fonts after edit?");
    await page.getByRole("button", { name: "Send edited message" }).click();

    await expect(page.getByText("Want me to make the change?")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("The recreation uses three families")).toHaveCount(0);
    await expect(page.getByText("Which fonts does the recreation use?")).toHaveCount(0);
    await expect(page.getByText(/Which fonts after edit/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("deleting a user message removes that turn and later responses", async ({ page }) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    await page.getByRole("button", { name: "Delete message and later responses" }).click();

    await expect(page.getByText("Which fonts does the recreation use?")).toHaveCount(0);
    await expect(page.getByText("The recreation uses three families")).toHaveCount(0);
    await expect(page.getByText("Message and later responses deleted")).toBeVisible();
  });

  test("edit-and-resubmit keeps image attachments", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4AWP4z8DwHwwZGBgYBQEAK3kD/VtWg5QAAAAASUVORK5CYII=";
    await seedWorkspace(page, (state) => {
      const now = "2026-07-01T12:00:00.000Z";
      state.messages.dev_session_1 = [
        {
          id: "dev_msg_user_image",
          sessionId: "dev_session_1",
          role: "user",
          status: "complete",
          parts: [
            { id: "image_user_text", messageId: "dev_msg_user_image", kind: "text", content: "Read this image", position: 0, createdAt: now },
            { id: "image_user_part", messageId: "dev_msg_user_image", kind: "image", content: imageDataUrl, position: 1, createdAt: now },
          ],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_msg_assistant_image",
          sessionId: "dev_session_1",
          role: "assistant",
          status: "complete",
          parts: [{ id: "image_assistant_text", messageId: "dev_msg_assistant_image", kind: "text", content: "I can see it.", position: 0, createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
      ];
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    await expect(page.locator("[data-user-attachment-image]")).toBeVisible();
    await page.getByRole("button", { name: "Edit message" }).click();
    await expect(page.locator('[data-attachment-preview="image"]')).toBeVisible();
    await page.getByTestId("message-editor-input").fill("Read this edited image");
    await page.getByRole("button", { name: "Send edited message" }).click();

    await expect(page.getByText("Want me to make the change?")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("I can see it.")).toHaveCount(0);
    await expect(page.getByText("Read this edited image").first()).toBeVisible();
    await expect(page.locator("[data-user-attachment-image]")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("unknown tool rows expose both raw args and output", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await seedWorkspace(page, (state) => {
      const now = "2026-07-01T12:00:00.000Z";
      state.messages.dev_session_1 = [
        {
          id: "dev_msg_user_unknown",
          sessionId: "dev_session_1",
          role: "user",
          status: "complete",
          parts: [{ id: "unknown_user_text", messageId: "dev_msg_user_unknown", kind: "text", content: "Use an MCP tool", position: 0, createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_msg_assistant_unknown",
          sessionId: "dev_session_1",
          role: "assistant",
          status: "complete",
          parts: [
            {
              id: "unknown_tool_part",
              messageId: "dev_msg_assistant_unknown",
              kind: "tool-call",
              content: {
                toolCallId: "tool_unknown",
                name: "mcp.lookup",
                title: "Lookup docs",
                arguments: { query: "assistant-message", limit: 3 },
                output: "Tool output body",
                status: "completed",
              },
              position: 0,
              createdAt: now,
            },
            { id: "unknown_final_text", messageId: "dev_msg_assistant_unknown", kind: "text", content: "Done.", position: 1, createdAt: now },
          ],
          createdAt: now,
          updatedAt: now,
        },
      ];
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    await page.getByTestId("turn-activity").click();
    await page.locator('[data-tool-call-id="tool_unknown"]').getByText("Mcp Lookup").click();

    await expect(page.getByText('"query": "assistant-message"')).toBeVisible();
    await expect(page.getByText("Tool output body")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("specialized tool rows render skill question goal and session context metadata", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await seedWorkspace(page, (state) => {
      const now = "2026-07-01T12:00:00.000Z";
      state.messages.dev_session_1 = [
        {
          id: "dev_msg_user_special_rows",
          sessionId: "dev_session_1",
          role: "user",
          status: "complete",
          parts: [{ id: "special_user_text", messageId: "dev_msg_user_special_rows", kind: "text", content: "Show specialized rows", position: 0, createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_msg_assistant_special_rows",
          sessionId: "dev_session_1",
          role: "assistant",
          status: "complete",
          parts: [
            {
              id: "special_skill_part",
              messageId: "dev_msg_assistant_special_rows",
              kind: "tool-call",
              content: {
                toolCallId: "tool_skill",
                name: "skill.invoke",
                arguments: { skill: "repo-audit", truncated: true },
                output: "Skill loaded with repo rules.",
                status: "completed",
                durationMs: 1280,
              },
              position: 0,
              createdAt: now,
            },
            {
              id: "special_question_part",
              messageId: "dev_msg_assistant_special_rows",
              kind: "tool-call",
              content: {
                toolCallId: "tool_question",
                name: "ask_user_question",
                arguments: {
                  question: "Which release channel should I use?",
                  options: [
                    { label: "Stable", description: "Use production defaults" },
                    { label: "Beta", description: "Use prerelease defaults" },
                  ],
                },
                output: "Stable",
                status: "completed",
                durationMs: 320,
              },
              position: 1,
              createdAt: now,
            },
            {
              id: "special_goal_part",
              messageId: "dev_msg_assistant_special_rows",
              kind: "tool-call",
              content: {
                toolCallId: "tool_goal",
                name: "goal.update",
                arguments: { goal: "Ship local parity", status: "active" },
                output: "Goal is pinned under the task header.",
                status: "completed",
                durationMs: 95,
              },
              position: 2,
              createdAt: now,
            },
            {
              id: "special_context_part",
              messageId: "dev_msg_assistant_special_rows",
              kind: "tool-call",
              content: {
                toolCallId: "tool_context",
                name: "session-context",
                arguments: { query: "Recent branch summary" },
                output: "The user asked for strict phase ordering.",
                status: "completed",
                durationMs: 211,
              },
              position: 3,
              createdAt: now,
            },
            { id: "special_final_text", messageId: "dev_msg_assistant_special_rows", kind: "text", content: "Rows rendered.", position: 4, createdAt: now },
          ],
          createdAt: now,
          updatedAt: now,
        },
      ];
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    await page.getByTestId("turn-activity").click();
    await expect(page.getByRole("button", { name: /Skill.*repo-audit.*1.3s.*truncated/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Question.*Which release channel should I use.*320ms/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Goal.*Ship local parity.*active.*95ms/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Session context.*Recent branch summary.*211ms/ })).toBeVisible();

    await page.locator('[data-tool-call-id="tool_question"]').getByText("Question").click();
    await expect(page.getByText("Stable", { exact: true })).toBeVisible();
    await expect(page.getByText("Use prerelease defaults")).toBeVisible();
    await page.locator('[data-tool-call-id="tool_context"]').getByText("Session context").click();
    await expect(page.getByText("The user asked for strict phase ordering.")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("goal slash command pins a session goal card", async ({ page }) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    await page.getByTestId("composer-input").fill("/goal Finish browser parity");
    await page.keyboard.press("Enter");

    const card = page.getByTestId("session-goal-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Finish browser parity");
    await expect(card).toContainText("active");

    await card.getByRole("button", { name: "Pause" }).click();
    await expect(card).toContainText("paused");
    await card.getByRole("button", { name: "Resume" }).click();
    await expect(card).toContainText("active");
    await card.getByRole("button", { name: "Clear" }).click();
    await expect(card).toHaveCount(0);
  });

  test("image slash command shows the generation state and renders the result", async ({ page }) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).first().click();

    await page.getByTestId("composer-input").fill("/image a tiny berry floating in space");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Generating image", { exact: true })).toBeVisible();
    await expect(page.locator("img[data-user-attachment-image]").last()).toBeVisible();
  });

  test("queued follow-up mode shows a pending chip and marker row", async ({ page }) => {
    await seedWorkspace(page, (state) => {
      state.settings["composer.queueMessages"] = true;
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    await page.getByTestId("composer-input").fill("Start a long follow-up target");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    await page.getByTestId("composer-input").fill("Queue this after the turn");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("queued-followups")).toContainText("Queue this after the turn");
    await expect(page.locator('[data-session-note="followed-up"]')).toContainText("Queued follow-up");
  });

  test("streaming enter steers the active turn when queueing is off", async ({ page }) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    await page.getByTestId("composer-input").fill("Start a steering target");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    await page.getByTestId("composer-input").fill("Focus on the WebKit checks");
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("queued-followups")).toHaveCount(0);
    await expect(page.locator('[data-session-note="steered"]')).toContainText("Steered current turn");
  });

  test("assistant message fork opens a boundary-limited fork", async ({ page }) => {
    await seedWorkspace(page, (state) => {
      const now = "2026-07-01T12:00:00.000Z";
      state.messages.dev_session_1 = [
        {
          id: "dev_msg_user_one",
          sessionId: "dev_session_1",
          role: "user",
          status: "complete",
          parts: [{ id: "fork_user_one", messageId: "dev_msg_user_one", kind: "text", content: "First question", position: 0, createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_msg_assistant_one",
          sessionId: "dev_session_1",
          role: "assistant",
          status: "complete",
          parts: [{ id: "fork_assistant_one", messageId: "dev_msg_assistant_one", kind: "text", content: "First answer", position: 0, createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_msg_user_two",
          sessionId: "dev_session_1",
          role: "user",
          status: "complete",
          parts: [{ id: "fork_user_two", messageId: "dev_msg_user_two", kind: "text", content: "Second question", position: 0, createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_msg_assistant_two",
          sessionId: "dev_session_1",
          role: "assistant",
          status: "complete",
          parts: [{ id: "fork_assistant_two", messageId: "dev_msg_assistant_two", kind: "text", content: "Second answer", position: 0, createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
      ];
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    await page.getByRole("button", { name: "Fork conversation" }).first().click();
    await expect(page.getByText("First question")).toBeVisible();
    await expect(page.getByText("First answer")).toBeVisible();
    await expect(page.getByText("Second question")).toHaveCount(0);
  });

  test("task menu rewinds to a selected user message", async ({ page }) => {
    await seedWorkspace(page, (state) => {
      const now = "2026-07-01T12:00:00.000Z";
      state.messages.dev_session_1 = [
        {
          id: "dev_msg_user_one",
          sessionId: "dev_session_1",
          role: "user",
          status: "complete",
          parts: [{ id: "rewind_user_one", messageId: "dev_msg_user_one", kind: "text", content: "First question", position: 0, createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_msg_assistant_one",
          sessionId: "dev_session_1",
          role: "assistant",
          status: "complete",
          parts: [{ id: "rewind_assistant_one", messageId: "dev_msg_assistant_one", kind: "text", content: "First answer", position: 0, createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_msg_user_two",
          sessionId: "dev_session_1",
          role: "user",
          status: "complete",
          parts: [{ id: "rewind_user_two", messageId: "dev_msg_user_two", kind: "text", content: "Second question", position: 0, createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_msg_assistant_two",
          sessionId: "dev_session_1",
          role: "assistant",
          status: "complete",
          parts: [{ id: "rewind_assistant_two", messageId: "dev_msg_assistant_two", kind: "text", content: "Second answer", position: 0, createdAt: now }],
          createdAt: now,
          updatedAt: now,
        },
      ];
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Task timeline" }).click();
    await page.getByRole("dialog", { name: "Task timeline" })
      .getByRole("button", { name: "Restore conversation from Second question" })
      .click();
    await page.keyboard.press("Escape");

    const messages = page.getByLabel("Messages");
    await expect(messages.getByText("First question")).toBeVisible();
    await expect(messages.getByText("Second question")).toHaveCount(0);
    await expect(page.locator('[data-session-note="rewound"]')).toBeVisible();
  });

  test("task menu compact renders a compaction marker row", async ({ page }) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Compact conversation" }).click();

    await expect(page.locator('[data-session-note="compacted"]')).toContainText("Compacted 420 tokens into a summary");
  });

  test("cancelled turn renders bare, expanded activity with no Worked header", async ({ page }) => {
    await openThreadAndSend(page, "Cancel this run midway");

    // Working phase: the divider exists once the first work item lands.
    await expect(page.getByTestId("turn-activity")).toBeVisible();
    await expect(page.getByText("Exploring workspace").first()).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Stop" }).click();

    // Codex: a cancelled turn has no worked-for divider at all — its activity
    // renders bare and expanded, from persisted data, exactly once.
    await expect(page.getByTestId("turn-activity")).toHaveCount(0);
    await expect(page.getByText(/^Work(ed|ing)/)).toHaveCount(0);
    await expect(page.getByText("Exploring workspace")).toHaveCount(1);
    await expect(page.getByText("Exploring workspace")).toBeVisible();
    // The final answer never arrived and the live block must not linger as a
    // duplicate: no assistant prose below the activity.
    await expect(page.getByText("Want me to make the change?")).toBeHidden();

    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Want me to make the change?")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Cancel this run midway")).toHaveCount(1);
  });

  test("approval card shows canonical command, raw disclosure, diff, and MCP risk hints", async ({ page, browserName }) => {
    await openThreadAndSend(page, "Show approval evidence");
    await expect(page.getByText("apply_patch", { exact: true })).toBeVisible();
    await expect(page.getByText("npm test", { exact: true })).toBeVisible();
    await expect(page.getByText("Destructive", { exact: true })).toBeVisible();
    await expect(page.getByText("Open world", { exact: true })).toBeVisible();
    await expect(page.getByText("Proposed changes", { exact: true })).toBeVisible();
    await expect(page.getByText("-old value", { exact: true })).toBeVisible();
    await expect(page.getByText("+new value", { exact: true })).toBeVisible();
    await expect(page.getByText("FOO=1 /usr/bin/npm test", { exact: true })).toBeHidden();
    await page.getByText("Raw command", { exact: true }).click();
    await expect(page.getByText("FOO=1 /usr/bin/npm test", { exact: true })).toBeVisible();
    if (browserName === "chromium") await expect(page).toHaveScreenshot("approval-evidence.png");
  });
});
