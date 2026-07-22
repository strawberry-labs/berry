import { describe, expect, it, vi } from "vitest";
import { captureCurrentPage, pageContextToAttachment, type CaptureChromeApi } from "./page-capture";

describe("page capture", () => {
  it("captures selection without requesting broad origin access", async () => {
    const api = {
      tabs: { query: vi.fn(async () => [{ id: 7, url: "https://docs.example.test/a", title: "Docs" }]) },
      permissions: {
        contains: vi.fn(),
        request: vi.fn(),
      },
      scripting: {
        executeScript: vi.fn(async () => [{ result: { title: "Docs", selection: "selected text", text: "" } }]),
      },
    };

    await expect(captureCurrentPage(api as unknown as CaptureChromeApi, { fullText: false })).resolves.toMatchObject({
      url: "https://docs.example.test/a",
      title: "Docs",
      selection: "selected text",
      text: "",
    });
    expect(api.permissions.request).not.toHaveBeenCalled();
  });

  it("requests per-origin access before full-page text capture", async () => {
    const api = {
      tabs: { query: vi.fn(async () => [{ id: 11, url: "https://news.example.test/story", title: "News" }]) },
      permissions: {
        contains: vi.fn(async () => false),
        request: vi.fn(async () => true),
      },
      scripting: {
        executeScript: vi.fn(async () => [{ result: { title: "News", selection: "", text: "full page" } }]),
      },
    };

    await expect(captureCurrentPage(api as unknown as CaptureChromeApi, { fullText: true })).resolves.toMatchObject({ text: "full page" });
    expect(api.permissions.request).toHaveBeenCalledWith({ origins: ["https://news.example.test/*"] });
  });

  it("turns page context into an attachment part", () => {
    const attachment = pageContextToAttachment({
      url: "https://example.test",
      title: "Example Page",
      selection: "quote",
      text: "body",
      capturedAt: "2026-07-11T00:00:00.000Z",
    });
    expect(attachment).toMatchObject({
      kind: "attachment",
      content: {
        name: "example-page.md",
        mediaType: "text/markdown",
        sourceKind: "browser-page",
      },
    });
    expect(String(attachment.content.textContent)).toContain("URL: https://example.test");
  });
});
