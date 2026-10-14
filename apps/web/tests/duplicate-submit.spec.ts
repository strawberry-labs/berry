import { expect, test } from "@playwright/test";

const api = "http://127.0.0.1:3199";

test("a second Enter while the first task is being created does not create a duplicate (H-035)", async ({ page, request }) => {
  await request.post(`${api}/__e2e/reset`);
  await page.goto("/");
  await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill("Summarise the tender package");
  await editor.press("Enter");
  // The fake API holds task creation for 1.2 s; press again inside that window.
  await page.waitForTimeout(150);
  await editor.press("Enter");
  await expect.poll(async () => (await (await request.get(`${api}/__e2e/state`)).json()).calls.filter((call: string) => call === "start-turn").length).toBe(1);
  await page.waitForTimeout(1_500);
  const state = await (await request.get(`${api}/__e2e/state`)).json();
  expect(state.calls.filter((call: string) => call === "create-task")).toHaveLength(1);
  expect(state.tasks).toEqual(["Summarise the tender package"]);
});
