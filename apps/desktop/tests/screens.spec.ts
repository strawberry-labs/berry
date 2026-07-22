import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function expectChromiumScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options?: { maxDiffPixelRatio?: number },
) {
  if (testInfo.project.name === "chromium") {
    await expect(page).toHaveScreenshot(name, options);
  }
}

test.describe("workbench", () => {
  test("onboarding shows when no workspace exists", async ({ page }, testInfo) => {
    await page.goto("/");
    await expect(page.getByPlaceholder("/path/to/project")).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "onboarding.png");
  });

  test("workspace empty state", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await expect(page.getByText("berry-chat").first()).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "workspace-home.png");
  });

  test("permission mode selector", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Ask before changes" }).click();
    await expect(page.getByText("Plan mode")).toBeVisible();
    await expect(page.getByText("Full access")).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "mode-selector.png");
  });

  test("model selector", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /berry\/router-auto/ }).click();
    await expect(page.getByPlaceholder("Search models...")).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage models" })).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "model-selector.png");
  });

  test("model selector groups cached models by provider", async ({ page }, testInfo) => {
    await seedWorkspace(page, (state) => {
      state.providers = [
        ...state.providers,
        {
          id: "dev_provider_fireworks",
          kind: "openai-compatible",
          name: "Fireworks",
          apiType: "openai-chat-completions",
          baseUrl: "https://api.fireworks.ai/inference/v1",
          endpointPath: "/chat/completions",
          modelsPath: "/models",
          defaultModel: "accounts/fireworks/routers/auto",
          credentialRef: "fireworks-api-key",
          authType: "bearer",
          enabled: true,
          models: [
            { id: "accounts/fireworks/models/kimi-k2", name: "Kimi K2" },
            { id: "accounts/fireworks/models/qwen3-coder", name: "Qwen3 Coder" },
          ],
          capabilities: {},
          headers: {},
          source: "custom",
          createdAt: "2026-07-01T12:00:00.000Z",
          updatedAt: "2026-07-01T12:00:00.000Z",
        },
      ];
    });
    await page.goto("/");
    await page.getByRole("button", { name: /berry\/router-auto/ }).click();

    await expect(page.locator("[cmdk-group-heading]").filter({ hasText: /^Berry Router$/ })).toBeVisible();
    await expect(page.locator("[cmdk-group-heading]").filter({ hasText: /^Fireworks$/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /accounts\/fireworks\/models\/kimi-k2/ })).toBeVisible();
    await page.getByPlaceholder("Search models...").fill("qwen");
    await expect(page.getByRole("option", { name: /accounts\/fireworks\/models\/qwen3-coder/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /berry\/router-auto/ })).toHaveCount(0);
  });

  test("composer add-context menu", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Add context" }).click();
    await expect(page.getByText("Add attachment")).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "add-context.png");
  });

  test("image attachment stays visible from composer through streaming turn", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4AWP4z8DwHwwZGBgYBQEAK3kD/VtWg5QAAAAASUVORK5CYII=",
      "base64",
    );

    await page.locator('input[type="file"]').setInputFiles({
      name: "codex-prompt.png",
      mimeType: "image/png",
      buffer: png,
    });

    const composerPreview = page.locator('[data-attachment-preview="image"]').first();
    await expect(composerPreview).toBeVisible();
    await expect(composerPreview).toHaveAttribute("data-state", "done");
    const previewBox = await composerPreview.boundingBox();
    expect(previewBox).not.toBeNull();
    expect(Math.abs(previewBox!.width - previewBox!.height)).toBeLessThanOrEqual(2);

    await page.getByTestId("composer-input").fill("What's the text in this image?");
    await page.keyboard.press("Enter");

    await expect(page.getByText("Thinking").first()).toBeVisible({ timeout: 10000 });
    const submittedImage = page.locator("[data-user-attachment-image]").first();
    await expect(submittedImage).toBeVisible();
    const submittedBox = await submittedImage.boundingBox();
    expect(submittedBox).not.toBeNull();
    expect(Math.abs(submittedBox!.width - submittedBox!.height)).toBeLessThanOrEqual(2);
    await expect(page.locator('[data-attachment-preview="image"]')).toHaveCount(0);
  });

  test("task thread renders history and streams a turn", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
    await expect(page.getByText("Source Serif 4").first()).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "task-thread.png");

    await page.getByTestId("composer-input").fill("And the terminal font?");
    await page.keyboard.press("Enter");
    // Dev mock streams a canned reply; the grouped tool timeline shows the row.
    await expect(page.getByText("Exploring workspace").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Want me to make the change?")).toBeVisible({ timeout: 15000 });
  });

  test("markdown code blocks use Shiki and code preview settings", async ({ page }, testInfo) => {
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

  test("task titlebar controls do not overlap content", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 960, height: 680 });
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    const headerBox = await page.locator("header").first().boundingBox();
    const mainBox = await page.locator("[data-slot='sidebar-inset']").boundingBox();
    const navBoxes = await page.locator(".berry-window-nav button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    );
    expect(headerBox && mainBox ? headerBox.x >= mainBox.x : false).toBe(true);
    expect(navBoxes.every((box) => headerBox ? !overlaps(headerBox, box) : false)).toBe(true);
    await expectChromiumScreenshot(page, testInfo, "task-compact-titlebar.png");
  });

  test("collapsed sidebar keeps the task header clear of the titlebar controls", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1200, height: 760 });
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
    await expect(page.locator(".berry-task-header")).toBeVisible();

    // Collapse the sidebar; the floating controls now overlay the main panel's
    // top-left, so the header must reserve a leading lane for them.
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(page.locator("[data-slot='sidebar'][data-state='collapsed']")).toBeVisible();

    // Right edge of the floating titlebar controls (toggle/back/forward/new).
    const navRight = await page.locator(".berry-window-nav button").evaluateAll((buttons) =>
      Math.max(...buttons.map((button) => button.getBoundingClientRect().right)),
    );
    // Left edge of the first piece of header content (the task title leads now).
    const contentLeft = await page.evaluate(() => {
      const target = document.querySelector<HTMLElement>(".berry-task-title-input");
      return target ? Math.round(target.getBoundingClientRect().x) : null;
    });
    expect(contentLeft).not.toBeNull();
    expect(contentLeft!).toBeGreaterThan(navRight);
    await expectChromiumScreenshot(page, testInfo, "task-collapsed-titlebar.png");
  });

  test("workspace switcher searches, switches, opens a folder, and removes", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");

    // The switcher opens from the workspace pill in the home composer.
    await page.getByRole("button", { name: "Switch workspace" }).click();

    // Popover lists both workspaces with an active check, an Open folder action,
    // and no "Remote connection" entry.
    await expect(page.getByPlaceholder("Search workspaces")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open folder" })).toBeVisible();
    await expect(page.getByText(/remote connection/i)).toHaveCount(0);
    const items = page.locator(".berry-workspace-switcher-item");
    await expect(items).toHaveCount(3); // berry-chat, sandbox, Open folder
    await expectChromiumScreenshot(page, testInfo, "workspace-switcher.png");

    // Search filters the popover list (other "berry-chat" labels in the sidebar
    // tree and pill are unaffected, so scope the assertion to switcher items).
    await page.getByPlaceholder("Search workspaces").fill("sand");
    await expect(items.filter({ hasText: "sandbox" })).toHaveCount(1);
    await expect(items.filter({ hasText: "berry-chat" })).toHaveCount(0);

    // Open folder with no native picker falls back to manual path entry.
    await page.getByPlaceholder("Search workspaces").fill("");
    await page.getByRole("button", { name: "Open folder" }).click();
    const openDialog = page.getByRole("dialog");
    await expect(openDialog.getByText("Open folder")).toBeVisible();
    await expect(openDialog.getByPlaceholder("/path/to/project")).toBeVisible();
    await openDialog.getByRole("button", { name: "Cancel" }).click();

    // Remove the sandbox workspace via its row menu, confirming the alert.
    const sandboxRow = page.locator(".berry-sidebar-workspace-row", { hasText: "sandbox" });
    await sandboxRow.hover();
    await page.getByRole("button", { name: "Actions for sandbox" }).click({ force: true });
    await page.getByRole("menuitem", { name: "Remove" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByText(/removes the workspace and its tasks/)).toBeVisible();
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(page.locator(".berry-sidebar-workspace-row", { hasText: "sandbox" })).toHaveCount(0);
  });

  test("task header rename and pin toggle", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    // Rename via clicking the title, typing, and pressing Enter.
    const titleButton = page.locator("button[title='Rename task']");
    await titleButton.click();
    await page.getByLabel("Rename task").fill("Renamed workspace fonts");
    await page.keyboard.press("Enter");
    await expect(titleButton).toHaveText("Renamed workspace fonts");

    // Pin via the header pin button, then unpin.
    await page.getByRole("button", { name: "Pin task" }).click();
    await expect(page.getByRole("button", { name: "Unpin task" })).toBeVisible();
    await page.getByRole("button", { name: "Unpin task" }).click();
    await expect(page.getByRole("button", { name: "Pin task" })).toBeVisible();
  });

  test("task header dropdown lists pin, rename, archive, open in finder", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Rename task" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Pin task" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Archive task" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Open in Finder" })).toBeVisible();
  });

  test("streaming reasoning and tool accordions render statuses", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const original = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        original(handler, typeof timeout === "number" && timeout >= 3260 ? timeout + 1000 : timeout, ...args)) as typeof window.setTimeout;
    });
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
    await page.getByTestId("composer-input").fill("Show the reasoning and tool states");
    await page.keyboard.press("Enter");

    await expect(page.getByText("Thinking")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/compared the current UI/)).toBeVisible({ timeout: 10000 });
    // Grouped tool timeline: each tool renders as a rail row with its status.
    await expect(page.getByText("Exploring workspace").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Checking command policy").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Running focused check").first()).toBeVisible({ timeout: 10000 });
    await expectChromiumScreenshot(page, testInfo, "reasoning-tool-accordions.png");
  });

  test("command palette", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.keyboard.press("Meta+k");
    await expect(page.getByPlaceholder(/Search actions/)).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "command-palette.png");
  });

  test("command palette file search uses the workspace index", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.keyboard.press("Meta+k");
    await page.getByPlaceholder(/Search actions/).fill("composer");
    await expect(page.getByText("src/components/composer.tsx", { exact: true })).toBeVisible();
    await expect(page.getByText("Development index match for src/components/composer.tsx")).toBeVisible();
  });

  test("collapsed sidebar keeps a visible reopen control", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");

    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "collapsed-sidebar-titlebar.png");

    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(page.getByRole("button", { name: /Search/ })).toBeVisible();
  });

  test("terminal side pane toggles", async ({ page }, testInfo) => {
    await seedWorkspace(page, (state) => { (state.tasks.dev_ws_1[0] as Record<string, unknown>).conversationKind = "code"; });
    await page.goto("/");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
    await page.getByRole("button", { name: "Toggle terminal" }).click();
    await expect(page.getByRole("button", { name: "New terminal" }).first()).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "task-terminal.png");
  });

  test("right work pane tabs switch and run mock actions", async ({ page }, testInfo) => {
    await seedWorkspace(page, (state) => { (state.tasks.dev_ws_1[0] as Record<string, unknown>).conversationKind = "code"; });
    await page.goto("/");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
    await page.getByRole("button", { name: "Toggle side pane" }).click();

    await expect(page.getByRole("tab", { name: "Terminal" })).toBeVisible();
    await page.getByRole("tab", { name: "Browser" }).click();
    await page.getByLabel("Browser URL").fill("https://example.com");
    await page.getByRole("button", { name: "Snapshot" }).click();
    await expect(page.getByText("@e1 [heading] Berry Preview")).toBeVisible();
    await page.getByRole("button", { name: "Screenshot" }).click();
    await expect(page.getByAltText("Browser screenshot")).toBeVisible();
    await page.getByRole("button", { name: "Attach" }).click();
    await expect(page.locator('[data-attachment-preview="image"]')).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "task-right-pane-browser.png");

    await page.getByRole("tab", { name: "Review" }).click();
    await expect(page.getByText("apps/desktop/src/components/composer.tsx").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Unstage" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Unstage" }).first().click();
    await expect(page.getByRole("button", { name: "Stage" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Stage" }).first().click();
    await expect(page.getByRole("button", { name: "Unstage" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Toggle diff for apps/desktop/src/components/composer.tsx" }).click();
    await expect(page.getByText("berry-composer-shell")).toBeHidden();
    await page.getByRole("button", { name: "Toggle diff for apps/desktop/src/components/composer.tsx" }).click();
    await expect(page.getByText("berry-composer-shell")).toBeVisible();
    await expect(page.locator('[data-highlight-status="highlighted"]').first()).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "task-right-pane-review.png");
    await page.getByRole("button", { name: "Checkpoint" }).click();
    await expect(page.getByText("Checkpoint created")).toBeVisible();

    await page.getByRole("tab", { name: "Files" }).click();
    await page.getByLabel("Search files").fill("work-pane");
    await expect(page.getByText("work-pane.tsx")).toBeVisible();
  });

  test("long model names stay contained in the composer", async ({ page }, testInfo) => {
    await seedWorkspace(page, (state) => {
      state.providers = [
        {
          id: "dev_provider_long",
          kind: "openai-compatible",
          name: "Fireworks",
          apiType: "openai-chat-completions",
          baseUrl: "https://api.fireworks.ai/inference/v1",
          endpointPath: "/chat/completions",
          modelsPath: "/models",
          defaultModel: "accounts/fireworks/routers/glm-5p2-fast-preview-really-long-router-name",
          credentialRef: "fireworks-api-key",
          authType: "bearer",
          enabled: true,
          models: [],
          capabilities: {},
          headers: {},
          source: "custom",
          createdAt: "2026-07-01T12:00:00.000Z",
          updatedAt: "2026-07-01T12:00:00.000Z",
        },
        ...state.providers,
      ];
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: /accounts\/firewor/ })).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "long-model-name.png");
  });

  test("prompt submit persists assistant response", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByTestId("composer-input").fill("Summarize this workspace");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Want me to make the change?")).toBeVisible({ timeout: 15000 });
    await expectChromiumScreenshot(page, testInfo, "prompt-submit-response.png");
  });
});

test.describe("settings", () => {
  const pages = [
    ["general", "General"],
    ["code-preview", "Code preview"],
    ["models", "Model settings"],
    ["skills", "Skills"],
    ["mcp", "MCP Servers"],
    ["commands", "Commands"],
    ["security", "Security"],
    ["indexing", "Indexing"],
    ["usage", "Usage"],
  ] as const;
  const smokePages = ["Plugins"] as const;

  test("navigates every implemented settings page", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.keyboard.press("Meta+,");
    await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
    // Subagents stay hidden until fully implemented.
    await expect(page.getByText("Subagents")).toHaveCount(0);

    for (const [key, label] of pages) {
      await page.getByRole("navigation").getByRole("button", { name: label, exact: true }).click();
      await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
      if (key === "security") {
        await expect(page.getByText("Managed by Acme", { exact: true })).toBeVisible();
        await expectChromiumScreenshot(page, testInfo, `settings-${key}.png`, { maxDiffPixelRatio: 0 });
      } else {
        await expectChromiumScreenshot(page, testInfo, `settings-${key}.png`);
      }
    }
    for (const label of smokePages) {
      await page.getByRole("navigation").getByRole("button", { name: label, exact: true }).click();
      await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
    }
  });

  async function openModelSettings(page: Page) {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await page.getByRole("navigation").getByRole("button", { name: "Model settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Model settings", exact: true })).toBeVisible();
  }

  /** Opens the add-provider gallery from the rail. */
  async function openGallery(page: Page) {
    await page.getByTestId("provider-rail").getByRole("button", { name: "Add provider" }).click();
    await expect(page.getByTestId("provider-gallery")).toBeVisible();
  }

  test("custom providers can be edited after they are added", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await openModelSettings(page);
    await openGallery(page);

    await page.getByTestId("provider-gallery").getByRole("button", { name: /Custom endpoint/ }).click();
    const setup = page.getByTestId("provider-setup");
    await setup.getByLabel("Name").fill("Fireworks");
    await setup.getByLabel("Base URL", { exact: true }).fill("https://api.fireworks.ai/inference/v1/chat/completions");
    await setup.getByLabel("Authentication").click();
    await page.getByRole("option", { name: "Bearer token" }).click();
    await setup.getByLabel("API key (optional)").fill("dev-secret");
    await setup.getByLabel("Default model").fill("accounts/fireworks/routers/glm-5p2-fast");
    await setup.getByRole("button", { name: "Add provider" }).click();
    await expect(page.getByTestId("provider-rail").getByRole("button", { name: "Fireworks" })).toBeVisible();

    const detail = page.getByTestId("provider-detail");
    await detail.getByLabel("Name").fill("Fireworks Edited");
    await detail.getByLabel("Base URL").fill("https://api.fireworks.ai/inference/v1");
    await detail.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("provider-rail").getByRole("button", { name: "Fireworks Edited" })).toBeVisible();
  });

  test("provider connection test, model add/remove, and provider delete work", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await openModelSettings(page);
    await openGallery(page);

    await page.getByTestId("provider-gallery").getByRole("button", { name: /Custom endpoint/ }).click();
    const setup = page.getByTestId("provider-setup");
    await setup.getByLabel("Name").fill("Catalog Test");
    await setup.getByLabel("Base URL", { exact: true }).fill("https://models.example.test/v1");
    await setup.getByLabel("Authentication").click();
    await page.getByRole("option", { name: "No API key" }).click();
    await setup.getByLabel("Default model").fill("catalog/default");
    await setup.getByRole("button", { name: "Add provider" }).click();

    await expect(page.getByTestId("provider-rail").getByRole("button", { name: "Catalog Test" })).toBeVisible();
    const detail = page.getByTestId("provider-detail");
    await detail.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByLabel("Notifications alt+T").getByText(/Connection OK.*5 models/)).toBeVisible();

    const models = page.getByTestId("provider-models");
    await models.getByRole("button", { name: "Add model" }).click();
    await page.getByLabel("Model ID").fill("catalog/manual");
    await page.getByLabel("Display name (optional)").fill("Manual catalog model");
    await page.getByLabel("Context window").fill("64000");
    await page.getByLabel("Tool calling").click();
    await page.getByRole("option", { name: "Not supported" }).click();
    await page.getByLabel("Image input").click();
    await page.getByRole("option", { name: "Supported", exact: true }).click();
    await page.getByLabel("Reasoning").click();
    await page.getByRole("option", { name: "Supported", exact: true }).click();
    await page.getByLabel("Input $ / 1M tokens").fill("0.25");
    await page.getByLabel("Output $ / 1M tokens").fill("1.5");
    await page.getByRole("button", { name: "Add model" }).click();
    await expect(models.getByText("Manual catalog model")).toBeVisible();
    await expect(models.getByText("64k")).toBeVisible();
    await expect(models.getByText("Vision")).toBeVisible();
    await expect(models.getByText("Reasoning")).toBeVisible();

    await models.getByRole("button", { name: "Edit catalog/manual" }).click();
    await expect(page.getByLabel("Tool calling")).toContainText("Not supported");
    await expect(page.getByLabel("Image input")).toContainText("Supported");
    await expect(page.getByLabel("Input $ / 1M tokens")).toHaveValue("0.25");
    await page.getByRole("button", { name: "Cancel" }).click();

    await models.getByRole("button", { name: "Remove catalog/manual" }).click();
    await expect(models.getByText("Manual catalog model")).toHaveCount(0);

    await detail.getByRole("button", { name: "Remove Catalog Test" }).click();
    await expect(page.getByTestId("provider-rail").getByRole("button", { name: "Catalog Test" })).toHaveCount(0);
  });

  test("local providers save without an API key and fetch models keylessly", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await openModelSettings(page);
    await openGallery(page);

    await page.getByTestId("provider-gallery").getByRole("button", { name: /^Ollama/ }).click();
    const setup = page.getByTestId("provider-setup");
    // Keyless preset: no API key field, just an explanatory notice.
    await expect(setup.getByText(/No API key needed/)).toBeVisible();
    await expect(setup.getByLabel("API key", { exact: true })).toHaveCount(0);
    await setup.getByLabel("Default model").fill("llama3");
    await setup.getByRole("button", { name: "Add provider" }).click();
    await expect(page.getByTestId("provider-rail").getByRole("button", { name: "Ollama" })).toBeVisible();

    // Fetching models must work with no key present (auth type "none").
    await page.getByTestId("provider-models").getByRole("button", { name: "Fetch" }).click();
    await expect(page.getByText(/Fetched \d+ models/)).toBeVisible();
    await expect(page.getByTestId("provider-models").getByText("openai/gpt-4.1-mini")).toBeVisible();
  });

  test("Anthropic and OpenAI Responses presets carry their API types", async ({ page }, testInfo) => {
    await seedWorkspace(page);
    await openModelSettings(page);
    const rail = page.getByTestId("provider-rail");

    await openGallery(page);
    await page.getByTestId("provider-gallery").getByRole("button", { name: /^Anthropic/ }).click();
    const setup = page.getByTestId("provider-setup");
    await expect(setup.getByText("Anthropic Messages")).toBeVisible();
    await setup.getByLabel("API key", { exact: true }).fill("ak-test");
    await setup.getByRole("button", { name: "Add provider" }).click();
    await expect(rail.getByRole("button", { name: "Anthropic" })).toBeVisible();

    await openGallery(page);
    await page.getByTestId("provider-gallery").getByRole("button", { name: /OpenAI Responses API/ }).click();
    await expect(setup.getByText("OpenAI Responses")).toBeVisible();
    await setup.getByLabel("API key", { exact: true }).fill("sk-test");
    await setup.getByRole("button", { name: "Add provider" }).click();
    await expect(rail.getByRole("button", { name: "OpenAI", exact: true })).toBeVisible();
  });

  test("long model names stay contained in the model settings detail", async ({ page }, testInfo) => {
    await seedWorkspace(page, (state) => {
      state.providers = [
        {
          id: "dev_provider_long",
          kind: "openai-compatible",
          name: "Fireworks",
          apiType: "openai-chat-completions",
          baseUrl: "https://api.fireworks.ai/inference/v1",
          endpointPath: "/chat/completions",
          modelsPath: "/models",
          defaultModel: "accounts/fireworks/routers/glm-5p2-fast-preview-really-long-router-name",
          credentialRef: "fireworks-api-key",
          authType: "bearer",
          enabled: true,
          models: [{ id: "accounts/fireworks/models/an-extremely-long-model-identifier-that-should-not-overflow-the-panel" }],
          capabilities: {},
          headers: {},
          source: "custom",
          createdAt: "2026-07-01T12:00:00.000Z",
          updatedAt: "2026-07-01T12:00:00.000Z",
        },
        ...state.providers,
      ];
    });
    await openModelSettings(page);
    await page.getByTestId("provider-rail").getByRole("button", { name: "Fireworks" }).click();
    await expect(page.getByTestId("provider-models")).toBeVisible();
    await expectChromiumScreenshot(page, testInfo, "settings-models-long-names.png");
  });
});
