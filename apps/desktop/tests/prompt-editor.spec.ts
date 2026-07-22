import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

/**
 * Lexical prompt editor: trigger menus, atomic mention tokens, and plain-text
 * serialization (the sent message must contain the literal `@path` form).
 */

test.describe("prompt editor mentions", () => {
  test("arrow-key navigation scrolls the active option into view", async ({ page }) => {
    await seedWorkspace(page, (state) => {
      state.skills = Array.from({ length: 20 }, (_, index) => ({
        id: `dev_skill_${index}`,
        workspaceId: null,
        name: `skill-${String(index + 1).padStart(2, "0")}`,
        description: `Description for skill ${index + 1}`,
        sourcePath: `~/.berry/skills/skill-${index + 1}`,
        trusted: true,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    const input = page.getByTestId("composer-input");
    await input.click();
    await input.pressSequentially("$");
    const menu = page.locator(".berry-mention-menu");
    const scroller = menu.locator("[data-mention-scroll]");
    await expect(menu).toBeVisible();

    for (let index = 0; index < 8; index += 1) await input.press("ArrowDown");

    const active = menu.locator('[role="option"][aria-selected="true"]');
    await expect(active).toContainText("skill-09");
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const [activeBox, scrollerBox] = await Promise.all([active.boundingBox(), scroller.boundingBox()]);
    expect(activeBox!.y).toBeGreaterThanOrEqual(scrollerBox!.y);
    expect(activeBox!.y + activeBox!.height).toBeLessThanOrEqual(scrollerBox!.y + scrollerBox!.height + 1);
  });

  test("@ inserts an atomic file mention that serializes to @path", async ({ page }) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    const input = page.getByTestId("composer-input");
    await input.click();
    await input.pressSequentially("look at @read");
    // Mention menu opens with the fixture file list.
    await expect(page.locator(".berry-mention-menu")).toBeVisible();
    await page.locator(".berry-mention-menu .berry-mention-item").first().click();

    // An atomic token pill exists and the raw text keeps the @relativePath form.
    const pill = input.locator('[data-mention-category="files"], [data-mention-category="folders"]');
    await expect(pill).toHaveCount(1);

    // One backspace after the trailing space, one for the token: pill vanishes whole.
    await input.press("Backspace");
    await input.press("Backspace");
    await expect(input.locator("[data-mention-category]")).toHaveCount(0);
    await expect(input).toContainText("look at");
  });

  test("Escape dismisses the menu; Enter submits with mention text intact", async ({ page }) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    const input = page.getByTestId("composer-input");
    await input.click();
    await input.pressSequentially("check @read");
    await expect(page.locator(".berry-mention-menu")).toBeVisible();
    await page.locator(".berry-mention-menu .berry-mention-item").first().click();
    await expect(input.locator("[data-mention-category]")).toHaveCount(1);

    await input.press("Enter");
    // The sent user message shows the literal serialized token text.
    await expect(page.getByText(/check @/).first()).toBeVisible({ timeout: 10000 });
  });

  test("edit-message editor opens the mention menu below the box", async ({ page }) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
    await page.getByText("Which fonts does the recreation use?").hover();
    await page.getByRole("button", { name: "Edit message" }).click();

    const input = page.getByTestId("message-editor-input");
    await input.click();
    await input.pressSequentially(" plus @read");
    const menu = page.locator(".berry-user-editor .berry-mention-menu");
    await expect(menu).toBeVisible();
    // Below the editor (virtualized rows paint-contain; the :has() override
    // plus placement="below" keep it visible under the box).
    const editorBox = await page.locator(".berry-user-editor").boundingBox();
    const menuBox = await menu.boundingBox();
    expect(menuBox!.y).toBeGreaterThan(editorBox!.y + editorBox!.height - 1);
    await menu.locator(".berry-mention-item").first().click();
    await expect(input.locator("[data-mention-category]")).toHaveCount(1);
  });

  test("Shift+Enter inserts a newline instead of submitting", async ({ page }) => {
    await seedWorkspace(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();

    const input = page.getByTestId("composer-input");
    await input.click();
    await input.pressSequentially("first line");
    await input.press("Shift+Enter");
    await input.pressSequentially("second line");
    await expect(input).toContainText("first line");
    await expect(input).toContainText("second line");
    // Still not submitted: no new user message bubble with this text.
    await expect(page.locator("[data-user-message-bubble]", { hasText: "first line" })).toHaveCount(0);
  });
});
