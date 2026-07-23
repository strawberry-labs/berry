import { expect, test, type Page } from "@playwright/test";

async function openTask(page: Page, taskId = "task_cloud", title = "Cloud sandbox smoke") {
  await page.goto(`/tasks/${taskId}`);
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

test("web uses the native ChatGPT-style typography stack", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");

  const typography = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const buttonStyle = getComputedStyle(document.querySelector("button")!);
    return {
      stack: rootStyle.getPropertyValue("--font-sans"),
      bodyFamily: bodyStyle.fontFamily,
      bodyWeight: bodyStyle.fontWeight,
      bodyLineHeight: bodyStyle.lineHeight,
      bodySynthesis: bodyStyle.fontSynthesis,
      buttonFamily: buttonStyle.fontFamily,
    };
  });

  expect(typography.stack).toContain("-apple-system-body");
  expect(typography.stack).toContain("ui-sans-serif");
  expect(typography.stack).toContain('"Segoe UI"');
  expect(typography.bodyFamily).toContain("-apple-system-body");
  expect(typography.bodyWeight).toBe("400");
  expect(typography.bodyLineHeight).toBe("21px");
  expect(typography.bodySynthesis).toBe("none");
  expect(typography.buttonFamily).toBe(typography.bodyFamily);
});

test("dark mode uses the approved surfaces and neutral menu highlights", async ({ page }) => {
  await openTask(page);

  const surfaces = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      mainToken: rootStyle.getPropertyValue("--berry-main-bg").trim(),
      sidebarToken: rootStyle.getPropertyValue("--berry-sidebar-bg").trim(),
      controlToken: rootStyle.getPropertyValue("--berry-control-bg").trim(),
      interactionToken: rootStyle.getPropertyValue("--accent").trim(),
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
    interactionToken: "#ffffff0d",
    main: "rgb(24, 24, 24)",
    sidebar: "rgb(36, 36, 36)",
    composer: "rgb(45, 45, 45)",
    userMessage: "rgb(36, 36, 36)",
    composerMonoOverrides: 0,
  });

  await page.getByRole("button", { name: "Permission mode" }).click();
  const fullAccess = page.getByRole("menuitem", { name: /Full access/ });
  await fullAccess.focus();
  await expect(fullAccess).toHaveCSS("background-color", "rgba(255, 255, 255, 0.05)");
});

test("hard refresh applies dark, light, and system themes before hydration", async ({ page }) => {
  const assertTheme = async (
    preference: "dark" | "light" | "system",
    expected: { dark: boolean; background: string; foreground: string },
  ) => {
    await page.evaluate((value) => localStorage.setItem("berry.web.theme", value), preference);
    await page.reload();
    await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");

    const appearance = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      scheme: document.documentElement.style.colorScheme,
      background: getComputedStyle(document.body).backgroundColor,
      foreground: getComputedStyle(document.body).color,
      stylesheets: [...document.styleSheets].map((sheet) => sheet.href).filter(Boolean),
    }));

    expect(appearance).toMatchObject({
      dark: expected.dark,
      scheme: expected.dark ? "dark" : "light",
      background: expected.background,
      foreground: expected.foreground,
    });
    expect(new Set(appearance.stylesheets).size).toBe(appearance.stylesheets.length);
  };

  await page.goto("/");
  await assertTheme("dark", {
    dark: true,
    background: "rgb(24, 24, 24)",
    foreground: "rgb(252, 252, 252)",
  });
  await assertTheme("light", {
    dark: false,
    background: "rgb(255, 255, 255)",
    foreground: "rgb(13, 13, 13)",
  });

  await page.emulateMedia({ colorScheme: "dark" });
  await assertTheme("system", {
    dark: true,
    background: "rgb(24, 24, 24)",
    foreground: "rgb(252, 252, 252)",
  });
  await page.emulateMedia({ colorScheme: "light" });
  await assertTheme("system", {
    dark: false,
    background: "rgb(255, 255, 255)",
    foreground: "rgb(13, 13, 13)",
  });
});

test("shared sidebar filters Chat and Code without replacing the active task", async ({ page }) => {
  await openTask(page);
  await expect(page.getByRole("button", { name: "Code", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".berry-sidebar-task-row").filter({ hasText: "Cloud sandbox smoke" })).toBeVisible();

  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Cloud sandbox smoke" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Quick model question/ })).toBeVisible();
  await expect(page.locator(".berry-sidebar-task-row").filter({ hasText: "Cloud sandbox smoke" })).toContainText("Cloud sandbox smoke");

  const chatsDisclosure = page.getByRole("button", { name: "Chats" });
  await chatsDisclosure.focus();
  await page.keyboard.press("Enter");
  await expect(chatsDisclosure).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL("/");
});

test("web Code mounts a functional sandbox workspace while Chat hides it", async ({ page }) => {
  await openTask(page);
  const workspace = page.getByTestId("web-code-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  await workspace.getByRole("button", { name: "README.md" }).click();
  await expect(workspace.getByRole("textbox", { name: "File contents" })).toHaveValue(/Berry web workspace/);

  await workspace.getByRole("tab", { name: "Terminal" }).click();
  await workspace.getByRole("textbox", { name: "Terminal command" }).fill("pwd");
  await workspace.getByRole("button", { name: "Run" }).click();
  await expect(workspace.getByText("/workspace")).toBeVisible();

  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(workspace).toHaveCount(0);
  await expect(page.getByTestId("web-thread")).toHaveAttribute("data-mode", "chat");
});

test("search and command-K open one cross-kind command palette", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Search Berry" })).toBeVisible();
  await page.getByPlaceholder("Search conversations and actions…").fill("Quick model question");
  await page.getByRole("option", { name: /Quick model question/ }).click();
  await expect(page).toHaveURL(/\/tasks\/task_chat$/);
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
  await expect(page.getByRole("dialog", { name: "Search Berry" })).toBeVisible();
});

test("task deep links and invalid routes remain durable", async ({ page }) => {
  await openTask(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Cloud sandbox smoke" })).toBeVisible();
  await expect(page).toHaveURL(/\/tasks\/task_cloud$/);

  await page.goto("/tasks/missing-task");
  await expect(page.getByRole("heading", { name: "Conversation not found" })).toBeVisible();
  await expect(page.getByTestId("composer-input")).toHaveCount(0);
});

test("web shell sends a fixture-backed chat turn", async ({ page }) => {
  await openTask(page);
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("What is ready?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("What is ready?")).toBeVisible();
  await expect(page.getByText(/Fixture sandbox ready/).first()).toBeVisible();
  await expect(page.getByText(/run it through the Phase 8 API\/SSE surface/)).toBeVisible();
});

test("recognized slash commands invoke handlers instead of becoming model text", async ({ page }) => {
  await openTask(page);
  await page.getByTestId("composer-input").fill("/compact");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("alert")).toContainText("/compact is not available");
  await expect(page.locator("[data-user-message-bubble]").filter({ hasText: "/compact" })).toHaveCount(0);

  await page.getByTestId("composer-input").fill("/pr");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("alert")).toContainText("/pr is not available");
  await expect(page.locator("[data-user-message-bubble]").filter({ hasText: "/pr" })).toHaveCount(0);
});

test("web thread uses the desktop conversation presentation", async ({ page }) => {
  await openTask(page);
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  const userBubble = page.locator("[data-user-message-bubble]").first();
  const assistant = page.locator(".berry-assistant-message").first();
  await expect(userBubble).toBeVisible();
  await expect(assistant).toBeVisible();
  await expect(page.getByTestId("turn-activity").first()).toContainText("Worked for 3s");
  await page.getByTestId("turn-activity").first().click();
  const thought = page.getByRole("button", { name: /Thought for a few seconds/ }).first();
  await expect(thought).toHaveAttribute("aria-expanded", "false");
  await thought.click();
  await expect(page.getByText(/checked the sandbox contract/).first()).toBeVisible();
  const tool = page.getByRole("button", { name: /Ran sandbox task/ });
  await tool.click();
  await expect(page.getByText("Sandbox ready", { exact: true }).last()).toBeVisible();

  const metrics = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".berry-thread-content")!;
    const composer = document.querySelector<HTMLElement>(".berry-thread-composer-wrap")!;
    const threadPane = document.querySelector<HTMLElement>(".thread-pane")!;
    const bubble = document.querySelector<HTMLElement>(".berry-user-message")!;
    const reply = document.querySelector<HTMLElement>(".berry-assistant-message")!;
    const replyProse = reply.firstElementChild as HTMLElement;
    const prompt = document.querySelector<HTMLElement>("[data-testid='composer-input']")!;
    const placeholder = document.querySelector<HTMLElement>(".berry-prompt-placeholder")!;
    const sidebar = document.querySelector<HTMLElement>("[data-slot='sidebar-container']")!;
    const contentStyle = getComputedStyle(content);
    const bubbleStyle = getComputedStyle(bubble);
    const proseStyle = getComputedStyle(replyProse);
    const promptStyle = getComputedStyle(prompt);
    return {
      contentWidth: content.getBoundingClientRect().width,
      composerWidth: composer.getBoundingClientRect().width,
      composerBottomGap: threadPane.getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom,
      contentGap: contentStyle.gap,
      contentPaddingTop: contentStyle.paddingTop,
      sidebarWidth: sidebar.getBoundingClientRect().width,
      bubbleRadius: bubbleStyle.borderRadius,
      bubbleFontSize: bubbleStyle.fontSize,
      bubbleLineHeight: bubbleStyle.lineHeight,
      bubblePadding: `${bubbleStyle.paddingTop} ${bubbleStyle.paddingRight} ${bubbleStyle.paddingBottom} ${bubbleStyle.paddingLeft}`,
      assistantFontSize: proseStyle.fontSize,
      assistantLineHeight: proseStyle.lineHeight,
      assistantTracking: proseStyle.letterSpacing,
      promptFontSize: promptStyle.fontSize,
      promptLineHeight: promptStyle.lineHeight,
      promptPadding: `${promptStyle.paddingTop} ${promptStyle.paddingRight} ${promptStyle.paddingBottom} ${promptStyle.paddingLeft}`,
      promptMinHeight: promptStyle.minHeight,
      placeholderPosition: getComputedStyle(placeholder).position,
      placeholderTopInset: placeholder.getBoundingClientRect().top - prompt.getBoundingClientRect().top,
      placeholderLeftInset: placeholder.getBoundingClientRect().left - prompt.getBoundingClientRect().left,
      replyBackground: getComputedStyle(reply).backgroundColor,
    };
  });
  expect(Math.abs(metrics.contentWidth - metrics.composerWidth)).toBeLessThan(2);
  expect(metrics.contentWidth).toBeGreaterThanOrEqual(750);
  expect(metrics.contentWidth).toBeLessThanOrEqual(780);
  expect(metrics.composerBottomGap).toBeLessThan(24);
  expect(metrics.sidebarWidth).toBe(288);
  expect(metrics.contentGap).toBe("20px");
  expect(metrics.contentPaddingTop).toBe("40px");
  expect(metrics.bubbleRadius).toBe("18px");
  expect(metrics.bubbleFontSize).toBe("16px");
  expect(metrics.bubbleLineHeight).toBe("24px");
  expect(metrics.bubblePadding).toBe("12px 16px 12px 16px");
  expect(metrics.assistantFontSize).toBe("13px");
  expect(metrics.assistantLineHeight).toBe("22.75px");
  expect(metrics.assistantTracking).toBe("0.325px");
  expect(metrics.promptFontSize).toBe("16px");
  expect(metrics.promptLineHeight).toBe("24px");
  expect(metrics.promptPadding).toBe("12px 16px 8px 16px");
  expect(metrics.promptMinHeight).toBe("44px");
  expect(metrics.placeholderPosition).toBe("absolute");
  expect(metrics.placeholderTopInset).toBe(12);
  expect(metrics.placeholderLeftInset).toBe(16);
  expect(metrics.replyBackground).toBe("rgba(0, 0, 0, 0)");
});

test("turn presentation remains scoped to its session while navigating between tasks", async ({ page }) => {
  await openTask(page);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const uniquePrompt = `Navigation-safe turn ${Date.now()}`;

  await page.getByTestId("composer-input").fill(uniquePrompt);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: /Launch plan review/ }).click();
  await expect(page.getByRole("heading", { name: "Launch plan review" })).toBeVisible();
  await expect(page.getByText(uniquePrompt)).toHaveCount(0);

  await page.getByRole("button", { name: /Cloud sandbox smoke/ }).click();
  await expect(page.getByText(uniquePrompt)).toBeVisible();
  await expect(page.getByText(/Fixture sandbox ready/).last()).toBeVisible();
});

test("home route opens the centered new-chat composer without creating a thread", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("button", { name: "New chat", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByText(/Ask Berry anything/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "New cloud task" })).toHaveCount(0);
  const centered = await page.locator(".berry-home-composer-wrap").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const main = document.querySelector<HTMLElement>(".berry-web-main")!.getBoundingClientRect();
    return Math.abs((rect.left + rect.width / 2) - (main.left + main.width / 2));
  });
  expect(centered).toBeLessThan(2);
});

test("composer keyboard: Enter submits while idle", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  const prompt = `Enter shortcut ${Date.now()}`;

  await page.getByTestId("composer-input").fill(prompt);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/tasks\//);
  await expect(page.getByTestId("web-thread").getByText(prompt, { exact: true })).toBeVisible();
});

for (const shortcut of ["Meta+Enter", "Control+Enter"] as const) {
  test(`composer keyboard: ${shortcut} does not submit while idle`, async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
    const prompt = `${shortcut} shortcut ${Date.now()}`;
    const editor = page.getByTestId("composer-input");

    await editor.fill(prompt);
    await page.keyboard.press(shortcut);
    await expect(page).toHaveURL(/\/$/);
    await expect(editor).toContainText(prompt);
  });
}

test("web shell exposes provider, MCP HTTP, and skills settings", async ({ page }) => {
  await openTask(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Organization").selectOption({ label: "Acme Dedicated" });
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByText("Berry Router")).toBeVisible();
  await page.getByRole("button", { name: "MCP servers" }).click();
  await expect(page.getByText("Docs MCP")).toBeVisible();
  await expect(page.getByRole("table", { name: "MCP servers" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add server" })).toBeDisabled();
  await expect(page.getByRole("table", { name: "MCP servers" })).not.toContainText("stdio");
  await page.getByRole("button", { name: "Skills" }).click();
  await expect(page.getByText("$review")).toBeVisible();
  await expect(page.getByRole("button", { name: "Import skill" })).toBeDisabled();
  await page.getByRole("button", { name: "Open admin console" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.getByRole("button", { name: "SSO & SCIM" }).click();
  await expect(page.getByText("Okta Workforce")).toBeVisible();
  await page.getByRole("button", { name: "Managed policy" }).click();
  await expect(page.getByRole("heading", { name: "Managed policy" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Policy versions" })).toContainText("acme-2026");
  await page.getByRole("button", { name: "Audit log" }).click();
  await expect(page.getByRole("table", { name: "Audit events" })).toContainText("models.policy-upserted");
  await expect(page.getByRole("navigation", { name: "Platform administration" })).toHaveCount(0);
});

test("Lexical composer opens static mention results", async ({ page }) => {
  await openTask(page);
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("$res");
  await expect(page.getByTestId("mention-menu")).toBeVisible();
  await expect(page.getByRole("option", { name: /research/ })).toBeVisible();
});

test("file mentions create indexed workspace context", async ({ page }) => {
  await openTask(page);
  await page.getByTestId("composer-input").fill("@README");
  await page.getByRole("option", { name: /README.md/ }).click();
  await expect(page.locator("[data-slot='attachment-title']", { hasText: "README.md" })).toBeVisible();
  await expect(page.getByText("1 KB", { exact: true })).toBeVisible();
});

test("desktop-style settings navigation replaces the task surface and returns", async ({ page }) => {
  await openTask(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  const settings = page.getByRole("region", { name: "Personal settings" });
  await expect(settings).toBeVisible();
  await page.getByRole("button", { name: "Prompts & commands", exact: true }).click();
  await expect(settings.getByRole("textbox", { name: "Prompt" })).toBeVisible();
  await page.getByRole("button", { name: "Privacy & permissions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Privacy & permissions" })).toBeVisible();
  await page.getByRole("button", { name: "My usage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My usage" })).toBeVisible();
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(settings.getByText("$review")).toBeVisible();
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cloud sandbox smoke" })).toBeVisible();
});

test("saved prompts insert into the Lexical composer", async ({ page }) => {
  await openTask(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Prompts & commands", exact: true }).click();
  await page.getByRole("textbox", { name: "Prompt" }).fill("Review the current task for regressions.");
  await page.getByRole("button", { name: "Use in composer" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("composer-input")).toContainText("Review the current task for regressions.");
});

test("visible browser settings persist and apply after reload", async ({ page }) => {
  await openTask(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const queue = page.getByRole("checkbox", { name: /Queued follow-ups/ });
  await queue.uncheck();
  await page.locator("label").filter({ hasText: "Theme" }).getByRole("combobox").selectOption("light");
  await page.locator("label").filter({ hasText: "Language" }).getByRole("combobox").selectOption("en");
  await page.reload();
  await expect(queue).not.toBeChecked();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("conversation kind changes in place without changing permission mode", async ({ page }) => {
  await openTask(page);
  await expect(page.getByRole("button", { name: "Permission mode" })).toContainText("Edit automatically");
  const permissionTrigger = page.getByRole("button", { name: "Permission mode" });
  const triggerBox = await permissionTrigger.boundingBox();
  await permissionTrigger.click();
  const permissionMenu = page.getByRole("menu");
  await expect(permissionMenu).toBeVisible();
  const menuBox = await permissionMenu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.y).toBeLessThan(triggerBox!.y);
  expect(Math.abs((menuBox!.y + menuBox!.height) - triggerBox!.y)).toBeLessThan(5);
  await page.getByRole("menuitem", { name: /Full access/ }).click();
  await expect(page.getByRole("button", { name: "Permission mode" })).toContainText("Full access");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/task_cloud$/);
  await expect(page.getByTestId("web-thread")).toHaveAttribute("data-mode", "chat");
  await expect(page.getByRole("button", { name: "Permission mode" })).toContainText("Full access");
  await expect(page.locator(".mode-tabs")).toHaveCount(0);
  await expect(page.getByTestId("code-workbench")).toHaveCount(0);
});

test("user message hover actions expose edit and resubmit on web", async ({ page }) => {
  await openTask(page);
  const bubble = page.locator("[data-user-message-bubble]").first();
  await bubble.hover();
  await expect(page.getByRole("button", { name: "Edit message" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy message" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Edit message" }).first().click();
  const editor = page.getByTestId("message-editor-input");
  await expect(editor).toBeVisible();
  await editor.fill("Run the edited sandbox task and summarize it.");
  await page.getByRole("button", { name: "Send edited message" }).click();
  await expect(page.getByText("Run the edited sandbox task and summarize it.")).toBeVisible();
  await expect(page.getByText("Run a sandboxed task and summarize the result.")).toHaveCount(0);
});

test("web task chrome keeps desktop navigation, title editing, and action menus", async ({ page }) => {
  await openTask(page);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("button", { name: /Launch plan review/ })).toBeVisible();
  await page.getByRole("button", { name: /Launch plan review/ }).click();
  await expect(page.getByRole("heading", { name: "Launch plan review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back" })).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Cloud sandbox smoke" })).toBeVisible();
  await page.getByRole("button", { name: "Forward" }).click();
  await expect(page.getByRole("heading", { name: "Launch plan review" })).toBeVisible();

  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename task" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Pin task|Unpin task/ })).toBeVisible();
  await page.getByRole("menuitem", { name: "Rename task" }).click();
  await page.getByRole("textbox", { name: "Rename task" }).fill("Launch plan polished");
  await page.getByRole("textbox", { name: "Rename task" }).press("Enter");
  await expect(page.getByRole("heading", { name: "Launch plan polished" })).toBeVisible();
});

test("archived and deleted conversations can be restored", async ({ page }) => {
  await openTask(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Archive task" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText(/Archived and deleted|Deleted \(1\)/)).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Archived chats", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Archived chats" })).toBeVisible();
  await expect(page.getByText("Cloud sandbox smoke")).toBeVisible();
  await page.getByRole("button", { name: "Unarchive" }).click();
  await expect(page.getByText("No archived chats")).toBeVisible();

  await openTask(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete task" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByText(/Archived and deleted|Deleted \(1\)/)).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Archived chats", exact: true }).click();
  await page.getByLabel("Archive state").selectOption("deleted");
  await expect(page.getByText("Cloud sandbox smoke")).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("No recently deleted chats")).toBeVisible();
});

test("web composer keeps model and reasoning controls and opens the mobile sidebar sheet", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("button", { name: "Kimi 2.6" })).toBeVisible();
  const reasoningButton = page.getByRole("button", { name: "Reasoning level" });
  const highReasoning = page.getByRole("menuitem", { name: "High" });
  await reasoningButton.click();
  await expect(highReasoning).toBeVisible();
  await highReasoning.click();
  await expect(page.getByRole("button", { name: "Reasoning level" })).toContainText("High");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForFunction(() => window.matchMedia("(max-width: 767px)").matches);
  const sidebarTrigger = page.getByRole("button", { name: "Toggle Sidebar" });
  await sidebarTrigger.click();
  await expect(page.getByRole("dialog", { name: "Sidebar" })).toBeVisible();
  await expect(page.getByRole("button", { name: /New (code )?chat/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Sidebar" })).toHaveCount(0);
  await expect(sidebarTrigger).toBeFocused();
});

test("primary shell workflows and Code workspace are keyboard reachable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");

  const search = page.getByRole("button", { name: "Search", exact: true });
  await search.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Search Berry" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();

  const code = page.getByRole("button", { name: "Code", exact: true });
  await code.focus();
  await page.keyboard.press("Enter");
  await expect(code).toHaveAttribute("aria-pressed", "true");

  await openTask(page);
  const terminal = page.getByTestId("web-code-workspace").getByRole("tab", { name: "Terminal" });
  await terminal.focus();
  await page.keyboard.press("Enter");
  await expect(terminal).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  const privacy = page.getByRole("button", { name: "Privacy & permissions", exact: true });
  await privacy.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Privacy & permissions" })).toBeVisible();
});

test("composer controls stay reachable across supported viewport sizes", async ({ page }) => {
  const viewports = [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 820, height: 640 },
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
    const controls = [
      page.getByRole("button", { name: "Add context" }),
      page.getByRole("button", { name: "Permission mode" }),
      page.getByRole("button", { name: "Kimi 2.6" }),
      page.getByRole("button", { name: "Reasoning level" }),
      page.getByRole("button", { name: "Send" }),
    ];
    for (const control of controls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    }
  }
});

test("reduced motion, forced colors, themes, and offline state remain usable", async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce", forcedColors: "active" });
  await page.goto("/");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("composer-input")).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByText("Offline", { exact: true })).toHaveAttribute("role", "status");
  await context.setOffline(false);
  await expect(page.getByText("Offline", { exact: true })).toHaveCount(0);

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference", forcedColors: "none" });
  await page.reload();
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("help exposes browser-safe support actions and diagnostics", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  await page.getByRole("button", { name: "Help" }).click();
  await expect(page.getByRole("menuitem", { name: "Documentation" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Report an issue" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Request a feature" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Community" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download diagnostics" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^berry-diagnostics-\d+\.json$/);
});

test("captures the rebuilt settings and administration references", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Pixel references are Chromium-only");

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/settings/general");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("management-settings-desktop.png");

  await page.goto("/admin/overview");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  // The Recharts trend renders with sub-pixel variance between runs; mask it so
  // the snapshot asserts layout/IA, not the chart's internal rasterization.
  await expect(page).toHaveScreenshot("management-admin-desktop.png", { mask: [page.locator(".mgmt-chart")] });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/general");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("management-settings-mobile.png");
});
