import { PASSIVE_INLINE_FILE_MEDIA_TYPES } from "@berry/shared";
import { describe, expect, it } from "vitest";
import { filePreviewKind, isPassiveInlineImageFile } from "./file-preview-policy";

describe("browser file preview policy", () => {
  it.each(PASSIVE_INLINE_FILE_MEDIA_TYPES)("keeps signature-validated %s images previewable", (mediaType) => {
    const file = { name: `preview.${mediaType.split("/").at(-1)}`, mediaType };
    expect(isPassiveInlineImageFile(file)).toBe(true);
    expect(filePreviewKind(file)).toBe("image");
  });

  it.each([
    ["report.pdf", "application/pdf"],
    ["active.svg", "image/svg+xml"],
    ["scan.bmp", "image/bmp"],
    ["photo.heic", "image/heic"],
    ["archive.tiff", "image/tiff"],
    ["spoofed.svg", "application/octet-stream"],
  ])("uses the download fallback for %s", (name, mediaType) => {
    expect(isPassiveInlineImageFile({ name, mediaType })).toBe(false);
    expect(filePreviewKind({ name, mediaType })).toBe("unsupported");
  });

  it("keeps non-embedding document viewers available", () => {
    expect(filePreviewKind({ name: "data.csv", mediaType: "text/csv" })).toBe("spreadsheet");
    expect(filePreviewKind({ name: "notes.md", mediaType: "text/markdown" })).toBe("code");
  });
});
