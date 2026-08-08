import { expect, test } from "@playwright/test";

const WEB_URL = "http://127.0.0.1:3109";
const API_URL = "http://127.0.0.1:3199";

test.skip(process.env.BERRY_FILE_LIFECYCLE_E2E_REAL !== "true", "requires the PostgreSQL + MinIO lifecycle fixture server");

test("conversation images survive real Library removal and unavailable assets fail cleanly", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const otherContext = await browser.newContext();
  await ownerContext.addCookies([{ name: "berry-e2e-user", value: "owner", url: API_URL }]);
  await otherContext.addCookies([{ name: "berry-e2e-user", value: "other", url: API_URL }]);
  const ownerPage = await ownerContext.newPage();
  const otherPage = await otherContext.newPage();

  try {
    const reset = await ownerContext.request.post(`${API_URL}/__e2e/reset`);
    expect(reset.ok()).toBe(true);
    await ownerPage.goto(`${WEB_URL}/tasks/task_chat`);
    await expect(ownerPage.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
    const conversationImage = ownerPage.getByAltText("Berry orchard at dusk");
    await expect(conversationImage).toBeVisible();
    await expect.poll(() => conversationImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    await ownerPage.getByRole("button", { name: "Open library" }).click();
    await expect(ownerPage).toHaveURL(`${WEB_URL}/library/all`);
    await expect(ownerPage.getByAltText("berry-orchard.svg")).toBeVisible();
    await ownerPage.getByRole("button", { name: "Remove berry-orchard.svg from Library" }).click();
    await ownerPage.getByRole("button", { name: "Remove from Library" }).click();
    await expect(ownerPage.getByAltText("berry-orchard.svg")).toHaveCount(0);
    await expect(ownerPage.getByText("No files yet")).toBeVisible();

    const firstStateResponse = await ownerContext.request.get(`${API_URL}/__e2e/state`);
    expect(firstStateResponse.ok()).toBe(true);
    const firstState = await firstStateResponse.json() as Record<string, unknown>;
    expect(firstState).toMatchObject({
      file_live: true,
      file_status: "available",
      blob_live: true,
      association_count: 1,
      owner_memberships: 0,
      other_memberships: 1,
      pending_physical_deletions: 0,
    });

    const fileId = String(firstState.file_id);
    const repeatedRemoval = await ownerContext.request.delete(`${API_URL}/v1/files/${fileId}`);
    expect(repeatedRemoval.ok()).toBe(true);
    const preservedDownload = await ownerContext.request.get(`${API_URL}/v1/files/${fileId}/content?download=1`);
    expect(preservedDownload.ok()).toBe(true);
    expect((await preservedDownload.body()).byteLength).toBeGreaterThan(0);

    await otherPage.goto(`${WEB_URL}/library/all`);
    await expect(otherPage.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated", "true");
    await expect(otherPage.getByAltText("berry-orchard.svg")).toBeVisible();

    const softDelete = await ownerContext.request.post(`${API_URL}/__e2e/task/soft-delete`);
    expect(softDelete.ok()).toBe(true);
    const otherRemoval = await otherContext.request.delete(`${API_URL}/v1/files/${fileId}`);
    expect(otherRemoval.ok()).toBe(true);
    const softDeletedState = await (await ownerContext.request.get(`${API_URL}/__e2e/state`)).json() as Record<string, unknown>;
    expect(softDeletedState).toMatchObject({
      file_live: true,
      blob_live: true,
      association_count: 1,
      owner_memberships: 0,
      other_memberships: 0,
      pending_physical_deletions: 0,
      task_soft_deleted: true,
    });
    const whileSoftDeleted = await ownerContext.request.get(`${API_URL}/v1/files/${fileId}/content?download=1`);
    expect(whileSoftDeleted.ok()).toBe(true);
    const restore = await ownerContext.request.post(`${API_URL}/__e2e/task/restore`);
    expect(restore.ok()).toBe(true);

    await ownerPage.goto(`${WEB_URL}/tasks/task_chat`);
    await expect(ownerPage.getByAltText("Berry orchard at dusk")).toBeVisible();
    await expect.poll(() => ownerPage.getByAltText("Berry orchard at dusk").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await ownerPage.reload();
    await expect(ownerPage.getByAltText("Berry orchard at dusk")).toBeVisible();
    await expect.poll(() => ownerPage.getByAltText("Berry orchard at dusk").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    await ownerPage.getByRole("button", { name: "Image 2 of 2" }).click();
    const unavailable = ownerPage.getByRole("status", { name: "Unavailable archive image: Image unavailable" });
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toContainText("This image was deleted or you no longer have access.");
    await expect(ownerPage.getByAltText("Unavailable archive image")).toHaveCount(0);
    await expect(ownerPage.getByRole("button", { name: "Open Unavailable archive image" })).toHaveCount(0);
    await expect(ownerPage.getByRole("button", { name: "Edit image" })).toHaveCount(0);
    await expect(ownerPage.getByRole("link", { name: "Save" })).toHaveCount(0);

    const finalState = await (await ownerContext.request.get(`${API_URL}/__e2e/state`)).json() as Record<string, unknown>;
    expect(finalState).toMatchObject({
      file_live: true,
      blob_live: true,
      owner_memberships: 0,
      other_memberships: 0,
      pending_physical_deletions: 0,
      task_soft_deleted: false,
    });
  } finally {
    await ownerContext.request.post(`${API_URL}/__e2e/cleanup`).catch(() => undefined);
    await Promise.all([ownerContext.close(), otherContext.close()]);
  }
});
