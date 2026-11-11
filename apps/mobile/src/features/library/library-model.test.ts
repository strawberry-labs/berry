import { describe, expect, it } from "vitest";
import type { StoredFile, StoredFilePage, Workspace } from "@berry/shared";
import {
  downloadErrorMessage,
  downloadPercent,
  fileGlyphKind,
  fileMetaLine,
  fileTypeLabel,
  flattenLibraryPages,
  formatBytes,
  isImageFile,
  libraryItemsForTab,
  libraryTabCounts,
  parseLibraryTab,
  projectFilterWorkspaces,
  removeFileFromPages,
  safeLocalFileName,
} from "./library-model";

const file = (id: string, name: string, mediaType: string, detectedMediaType: string | null = mediaType, size = 1024) =>
  ({ id, name, mediaType, detectedMediaType, size, createdAt: "2026-10-09T08:00:00.000Z" }) as StoredFile;

const workspace = (id: string, workspaceKind: Workspace["workspaceKind"]) => ({ id, name: id, workspaceKind }) as Workspace;

describe("library model", () => {
  it("formats sizes and type labels like the web cards", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024 + 1)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
    expect(fileTypeLabel({ name: "report.pdf", mediaType: "application/pdf" })).toBe("PDF");
    expect(fileTypeLabel({ name: "photo", mediaType: "image/png" })).toBe("Image");
    expect(fileTypeLabel({ name: "notes", mediaType: "text/plain" })).toBe("Text");
    expect(fileTypeLabel({ name: "blob.verylongextension", mediaType: "application/octet-stream" })).toBe("File");
    expect(fileMetaLine(file("a", "a.png", "image/png"), "en-US")).toBe("PNG · 1 KB · 10/9/2026");
  });

  it("only treats signature-validated raster images as images", () => {
    expect(isImageFile(file("png", "image.png", "image/png"))).toBe(true);
    expect(isImageFile(file("jpg", "image.JPG", "image/jpg", "image/jpeg"))).toBe(true);
    expect(isImageFile(file("svg", "vector.svg", "image/svg+xml"))).toBe(false);
    expect(isImageFile(file("mismatch", "image.png", "image/png", "image/gif"))).toBe(false);
    expect(isImageFile(file("ext", "image.gif", "image/png"))).toBe(false);
    expect(isImageFile(file("huge", "huge.png", "image/png", "image/png", 26 * 1024 * 1024))).toBe(false);
  });

  it("splits tabs in API order and counts loaded files", () => {
    const files = [file("doc", "doc.pdf", "application/pdf"), file("img", "img.png", "image/png"), file("svg", "a.svg", "image/svg+xml")];
    expect(libraryItemsForTab(files, "all").map((item) => item.id)).toEqual(["doc", "img", "svg"]);
    expect(libraryItemsForTab(files, "images").map((item) => item.id)).toEqual(["img"]);
    expect(libraryItemsForTab(files, "documents").map((item) => item.id)).toEqual(["doc", "svg"]);
    expect(libraryTabCounts(files)).toEqual({ all: 3, images: 1, documents: 2 });
    expect(parseLibraryTab("images")).toBe("images");
    expect(parseLibraryTab("nope")).toBe("all");
    expect(parseLibraryTab(undefined)).toBe("all");
  });

  it("offers only project workspaces in the project filter", () => {
    expect(projectFilterWorkspaces([workspace("p", "project"), workspace("g", "general")]).map((item) => item.id)).toEqual(["p"]);
  });

  it("merges pages without duplicates and removes files from every page", () => {
    const pages: StoredFilePage[] = [
      { items: [file("1", "a.pdf", "application/pdf"), file("2", "b.pdf", "application/pdf")], nextCursor: "c" },
      { items: [file("2", "b.pdf", "application/pdf"), file("3", "c.pdf", "application/pdf")], nextCursor: null },
    ];
    expect(flattenLibraryPages(pages).map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(flattenLibraryPages(undefined)).toEqual([]);
    const removed = removeFileFromPages({ pages, pageParams: [null, "c"] }, "2");
    expect(flattenLibraryPages(removed?.pages).map((item) => item.id)).toEqual(["1", "3"]);
    expect(removed?.pageParams).toEqual([null, "c"]);
    expect(removeFileFromPages(undefined, "2")).toBeUndefined();
  });

  it("picks a glyph by extension, then media type", () => {
    expect(fileGlyphKind({ name: "deck.pptx", mediaType: "application/zip" })).toBe("slides");
    expect(fileGlyphKind({ name: "data.csv", mediaType: "text/csv" })).toBe("csv");
    expect(fileGlyphKind({ name: "main.ts", mediaType: "text/plain" })).toBe("code");
    expect(fileGlyphKind({ name: "research.skill", mediaType: "application/zip" })).toBe("archive");
    expect(fileGlyphKind({ name: "scan", mediaType: "application/pdf" })).toBe("pdf");
    expect(fileGlyphKind({ name: "clip", mediaType: "video/mp4" })).toBe("video");
    expect(fileGlyphKind({ name: "blob", mediaType: "application/octet-stream" })).toBe("file");
  });

  it("makes cache-safe file names", () => {
    expect(safeLocalFileName("report.pdf")).toBe("report.pdf");
    expect(safeLocalFileName("../../etc/passwd")).toBe("etc-passwd");
    expect(safeLocalFileName("a:b*c?.txt")).toBe("a-b-c-.txt");
    expect(safeLocalFileName("...")).toBe("file");
  });

  it("explains native download failures with the web's wording", () => {
    expect(downloadErrorMessage(new Error("Unable to download file: response has status code 403"))).toBe("This file is unavailable or you no longer have access to it.");
    expect(downloadErrorMessage(new Error("status code 401"))).toBe("You've been signed out of this server.");
    expect(downloadErrorMessage(new Error("The Internet connection appears to be offline."))).toBe("Couldn't reach the server. Check your connection and try again.");
    expect(downloadErrorMessage(new Error("status code 500"))).toBe("Download failed. Please retry.");
  });

  it("reports download progress only when the total is known", () => {
    expect(downloadPercent(50, 200)).toBe(25);
    expect(downloadPercent(300, 200)).toBe(100);
    expect(downloadPercent(10, null)).toBeNull();
    expect(downloadPercent(10, -1)).toBeNull();
  });
});
