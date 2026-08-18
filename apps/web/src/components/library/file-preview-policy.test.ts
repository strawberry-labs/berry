import { PASSIVE_INLINE_FILE_MEDIA_TYPES } from "@berry/shared";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { fileExtension, filePreviewDecision, filePreviewKind, isPassiveInlineImageFile, PREVIEW_LIMITS } from "./file-preview-policy";
import { safeArchivePath, validateArchivePreview } from "./archive-preview";
import { readZipEntries, validateZipPayload } from "./zip-preview";
import { assertDelimitedBounds, assertWorkbookCellBounds } from "./spreadsheet-preview-bounds";
import { countDocxPages, countPptxSlideIds, hasExternalMediaRelationship, hasRequiredOfficeEntries, hasUnsafeDocxMarkup, hasUnboundedEmbeddedMediaRelationship } from "./office-preview-bounds";
import { assertImagePreviewBounds } from "./image-preview-bounds";
import * as XLSX from "xlsx";

describe("browser file preview policy", () => {
  it.each(PASSIVE_INLINE_FILE_MEDIA_TYPES)("keeps signature-validated %s images previewable", (mediaType) => {
    const file = { name: `preview.${mediaType.split("/").at(-1)}`, mediaType, detectedMediaType: mediaType };
    expect(isPassiveInlineImageFile(file)).toBe(true);
    expect(filePreviewKind(file)).toBe("image");
  });

  it.each([
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
    expect(filePreviewKind({ name: "report.pdf", mediaType: "application/pdf" })).toBe("pdf");
    expect(filePreviewDecision({ name: "report.pdf", mediaType: "application/pdf", size: 4_000 })).toMatchObject({ kind: "pdf", allowed: true, maxSourceBytes: PREVIEW_LIMITS.pdfBytes });
    expect(filePreviewDecision({ name: "large.pdf", mediaType: "application/pdf", size: PREVIEW_LIMITS.pdfBytes + 1 }).allowed).toBe(false);
    expect(filePreviewDecision({ name: "renamed.bin", mediaType: "application/pdf", size: 4_000 }).allowed).toBe(false);
    expect(filePreviewKind({ name: "data.csv", mediaType: "text/csv" })).toBe("spreadsheet");
    expect(filePreviewKind({ name: "notes.md", mediaType: "text/markdown" })).toBe("code");
    expect(filePreviewDecision({ name: "report.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4_000 })).toMatchObject({ kind: "docx", allowed: true });
    expect(filePreviewDecision({ name: "large.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: PREVIEW_LIMITS.docxBytes + 1 }).allowed).toBe(false);
    expect(filePreviewDecision({ name: "deck.pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 4_000 })).toMatchObject({ kind: "pptx", allowed: true });
    expect(filePreviewDecision({ name: "legacy.xls", mediaType: "application/vnd.ms-excel", size: 4_000 }).allowed).toBe(false);
    expect(filePreviewDecision({ name: "misleading.xls", mediaType: "text/plain", declaredMediaType: "text/plain", detectedMediaType: "text/plain", size: 4_000 })).toMatchObject({ kind: "unsupported", allowed: false });
    expect(filePreviewDecision({ name: "uploaded.docx", mediaType: "application/zip", declaredMediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", detectedMediaType: "application/zip", size: 4_000 })).toMatchObject({ kind: "docx", allowed: true });
    expect(filePreviewDecision({ name: "renamed.docx", mediaType: "application/zip", declaredMediaType: "text/plain", detectedMediaType: "application/zip", size: 4_000 }).allowed).toBe(false);
    expect(filePreviewDecision({ name: "legacy-upload.xls", mediaType: "application/octet-stream", declaredMediaType: "application/vnd.ms-excel", detectedMediaType: "application/octet-stream", size: 4_000 })).toMatchObject({ kind: "spreadsheet", allowed: true });
    expect(filePreviewDecision({ name: "huge-legacy.xls", mediaType: "application/vnd.ms-excel", size: PREVIEW_LIMITS.legacySpreadsheetBytes + 1 }).allowed).toBe(false);
    expect(filePreviewDecision({ name: "uploaded.csv", mediaType: "text/plain", declaredMediaType: "text/csv", detectedMediaType: "text/plain", size: 4_000 })).toMatchObject({ kind: "spreadsheet", allowed: true });
    expect(filePreviewDecision({ name: "uploaded.md", mediaType: "text/plain", declaredMediaType: "text/markdown", detectedMediaType: "text/plain", size: 4_000 })).toMatchObject({ kind: "code", allowed: true });
    expect(filePreviewDecision({ name: "uploaded.json", mediaType: "text/plain", declaredMediaType: "application/json", detectedMediaType: "text/plain", size: 4_000 })).toMatchObject({ kind: "code", allowed: true });
  });

  it("falls back before downloading an oversized or misleading preview", () => {
    expect(filePreviewDecision({ name: "huge.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: PREVIEW_LIMITS.spreadsheetBytes + 1 }).allowed).toBe(false);
    expect(filePreviewDecision({ name: "fake.docx", mediaType: "text/plain", detectedMediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4_000 }).allowed).toBe(false);
    expect(filePreviewDecision({ name: "photo.png", mediaType: "image/png", detectedMediaType: "image/svg+xml", size: 4_000 }).allowed).toBe(false);
    expect(filePreviewDecision({ name: "unknown.png", mediaType: "image/png", detectedMediaType: null, size: 4_000 }).allowed).toBe(true);
    expect(isPassiveInlineImageFile({ name: "photo.jpg", mediaType: "image/png" })).toBe(false);
    expect(isPassiveInlineImageFile({ name: "legacy.png", mediaType: "image/png", detectedMediaType: null, size: 4_000 })).toBe(true);
    expect(filePreviewDecision({ name: "legacy.png", mediaType: "image/png", detectedMediaType: null, size: 4_000 })).toMatchObject({ kind: "image", allowed: true });
    expect(isPassiveInlineImageFile({ name: "huge.jpg", mediaType: "image/jpeg", detectedMediaType: "image/jpeg", size: PREVIEW_LIMITS.imageBytes + 1 })).toBe(false);
    expect(isPassiveInlineImageFile({ name: "spoofed.png", mediaType: "image/png", declaredMediaType: "text/html", detectedMediaType: "image/png", size: 4_000 })).toBe(false);
  });

  it("normalizes filename extensions before applying preview gates", () => {
    expect(fileExtension("report.XLSX ")).toBe("xlsx");
    expect(filePreviewKind({ name: "report.xlsx ", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBe("spreadsheet");
    expect(filePreviewDecision({
      name: "legacy.xls ",
      mediaType: "application/vnd.ms-excel",
      detectedMediaType: "application/octet-stream",
      size: PREVIEW_LIMITS.legacySpreadsheetBytes + 1,
    }).allowed).toBe(false);
    expect(filePreviewDecision({ name: "uploaded.csv ", mediaType: "text/plain", declaredMediaType: "text/csv", detectedMediaType: "text/plain", size: 4_000 }).allowed).toBe(true);
  });
});

describe("image decode bounds", () => {
  it("accepts bounded PNG headers and rejects extreme dimensions before decode", () => {
    const normal = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 4, 0, 8, 6, 0, 0, 0]);
    expect(() => assertImagePreviewBounds(normal, "image/png")).not.toThrow();
    const huge = normal.slice();
    huge[16] = 0xff;
    huge[17] = 0xff;
    huge[18] = 0xff;
    huge[19] = 0xff;
    expect(() => assertImagePreviewBounds(huge, "image/png")).toThrow(/dimensions/i);
  });

  it("bounds AVIF and lossy WebP headers without decoding them", () => {
    const avif = new Uint8Array(36);
    avif.set([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70], 0);
    avif.set([0x69, 0x73, 0x70, 0x65], 16);
    avif.set([0, 0, 4, 0], 24);
    avif.set([0, 0, 4, 0], 28);
    expect(() => assertImagePreviewBounds(avif, "image/avif")).not.toThrow();

    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0, 4, 0, 4]);
    expect(() => assertImagePreviewBounds(webp, "image/webp")).not.toThrow();
  });

  it("reads little-endian GIF and ICO dimensions", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x04, 0x00, 0x03]);
    expect(() => assertImagePreviewBounds(gif, "image/gif")).not.toThrow();
    const ico = new Uint8Array(62);
    ico.set([0, 0, 1, 0, 1, 0, 0x04, 0x03, 0x04, 0x03, 0, 0, 1, 0, 40, 0, 0, 0, 22, 0, 0, 0]);
    ico.set([40, 0, 0, 0, 4, 0, 0, 0, 8, 0, 0, 0], 22);
    expect(() => assertImagePreviewBounds(ico, "image/x-icon")).not.toThrow();
    expect(() => assertImagePreviewBounds(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 0, 4, 0, 4]), "image/jpg")).not.toThrow();
  });

  it("rejects oversized dimensions hidden inside ICO and AVIF metadata", () => {
    const ico = new Uint8Array(46);
    ico.set([0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0, 24, 0, 0, 0, 22, 0, 0, 0]);
    ico.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 1], 22);
    expect(() => assertImagePreviewBounds(ico, "image/x-icon")).toThrow(/dimensions/i);

    const avif = new Uint8Array(56);
    avif.set([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70], 0);
    avif.set([0x69, 0x73, 0x70, 0x65], 16);
    avif.set([0, 0, 4, 0], 24);
    avif.set([0, 0, 4, 0], 28);
    avif.set([0x69, 0x73, 0x70, 0x65], 36);
    avif.set([0xff, 0xff, 0xff, 0xff], 44);
    avif.set([0, 0, 0, 1], 48);
    expect(() => assertImagePreviewBounds(avif, "image/avif")).toThrow(/dimensions/i);
  });

  it("fails closed when animated/image metadata is beyond the synchronous scan budget", () => {
    const avif = new Uint8Array(1_048_577);
    avif.set([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70], 0);
    avif.set([0x69, 0x73, 0x70, 0x65], 16);
    avif.set([0, 0, 4, 0], 24);
    avif.set([0, 0, 4, 0], 28);
    expect(() => assertImagePreviewBounds(avif, "image/avif")).toThrow(/safely|format/i);
  });
});

describe("office archive preview limits", () => {
  const limits = { sourceBytes: 100, expandedBytes: 1_000, entryCount: 3, entryBytes: 600, expansionRatio: 100 };

  it("rejects unsafe paths, encrypted entries, expansion bombs, and entry floods", () => {
    expect(safeArchivePath("../word/document.xml")).toBe(false);
    expect(safeArchivePath("word/document.xml")).toBe(true);
    expect(validateArchivePreview(10, [{ name: "word/document.xml", compressedBytes: 1, expandedBytes: 200, encrypted: true }], limits).ok).toBe(false);
    expect(validateArchivePreview(10, [{ name: "word/document.xml", compressedBytes: 1, expandedBytes: 200 }], limits).ok).toBe(false);
    expect(validateArchivePreview(10, Array.from({ length: 4 }, (_, index) => ({ name: `word/${index}.xml`, compressedBytes: 10, expandedBytes: 10 })), limits).ok).toBe(false);
    expect(validateArchivePreview(10, [{ name: "word/document.xml", compressedBytes: 1, expandedBytes: 1_000 }], limits).ok).toBe(false);
  });

  it("accepts a normal bounded office archive", () => {
    expect(validateArchivePreview(10, [
      { name: "[Content_Types].xml", compressedBytes: 20, expandedBytes: 400 },
      { name: "word/document.xml", compressedBytes: 10, expandedBytes: 500 },
    ], limits)).toEqual({ ok: true, expandedBytes: 900, entries: 2 });
  });

  it("reads a normal OOXML-shaped archive from an actual ZIP fixture", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("xl/workbook.xml", "<workbook/>");
    zip.file("xl/worksheets/sheet1.xml", "<worksheet/>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const entries = readZipEntries(bytes);
    expect(entries.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "[Content_Types].xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]));
    expect(validateArchivePreview(bytes.byteLength, entries, {
      sourceBytes: PREVIEW_LIMITS.spreadsheetBytes,
      expandedBytes: PREVIEW_LIMITS.spreadsheetExpandedBytes,
      entryCount: PREVIEW_LIMITS.archiveEntryCount,
      entryBytes: PREVIEW_LIMITS.spreadsheetEntryBytes,
      expansionRatio: 100,
    }).ok).toBe(true);
    await expect(validateZipPayload(bytes, {
      sourceBytes: PREVIEW_LIMITS.spreadsheetBytes,
      expandedBytes: PREVIEW_LIMITS.spreadsheetExpandedBytes,
      entryCount: PREVIEW_LIMITS.archiveEntryCount,
      entryBytes: PREVIEW_LIMITS.spreadsheetEntryBytes,
      expansionRatio: 100,
    }, entries)).resolves.toMatchObject({ entries: entries.length });
  });

  it("rejects central-directory entries hidden behind a forged EOCD count", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("xl/workbook.xml", "<workbook/>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        eocd = offset;
        break;
      }
    }
    expect(eocd).toBeGreaterThanOrEqual(0);
    view.setUint16(eocd + 8, 1, true);
    view.setUint16(eocd + 10, 1, true);

    expect(() => readZipEntries(bytes)).toThrow(/directory/i);
  });

  it("rejects actual deflate output that exceeds the compression ratio budget", async () => {
    const zip = new JSZip();
    zip.file("xl/workbook.xml", "x".repeat(20_000), { compression: "DEFLATE", compressionOptions: { level: 9 } });
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    await expect(validateZipPayload(bytes, {
      sourceBytes: PREVIEW_LIMITS.spreadsheetBytes,
      expandedBytes: PREVIEW_LIMITS.archiveExpandedBytes,
      entryCount: PREVIEW_LIMITS.archiveEntryCount,
      entryBytes: PREVIEW_LIMITS.archiveEntryBytes,
      expansionRatio: 2,
    })).rejects.toThrow(/compression ratio|expansion ratio|expanded archive/i);
  });
});

describe("spreadsheet worker bounds", () => {
  it("rejects wide and cell-flooded delimited input before SheetJS", () => {
    expect(() => assertDelimitedBounds(new TextEncoder().encode(Array.from({ length: 101 }, () => "x").join(",")), ",")).toThrow(/columns/i);
    const row = Array.from({ length: 100 }, () => "x").join(",");
    expect(() => assertDelimitedBounds(new TextEncoder().encode(`${row}\n`.repeat(2_001)), ",")).toThrow(/cells/i);
    expect(() => assertDelimitedBounds(new TextEncoder().encode('"a,b",c\n'), ",")).not.toThrow();
    const wideFields = ["a".repeat(200_000), "b".repeat(200_000)].join(",");
    expect(() => assertDelimitedBounds(new TextEncoder().encode(`${wideFields}\r\n`), ",")).not.toThrow();
  });

  it("rejects an oversized workbook window before cloning rows", () => {
    const normal = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(normal, XLSX.utils.aoa_to_sheet([["ok"]]), "Sheet1");
    expect(() => assertWorkbookCellBounds(normal)).not.toThrow();
    const huge = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(huge, XLSX.utils.aoa_to_sheet(Array.from({ length: 501 }, () => Array.from({ length: 401 }, () => "x"))), "Sheet1");
    expect(() => assertWorkbookCellBounds(huge)).toThrow(/cells/i);
  });
});

describe("office worker bounds", () => {
  it("requires the OOXML marker entries before rendering", () => {
    expect(hasRequiredOfficeEntries("docx", new Set(["[Content_Types].xml", "word/document.xml"]))).toBe(true);
    expect(hasRequiredOfficeEntries("pptx", new Set(["[Content_Types].xml", "ppt/presentation.xml"]))).toBe(true);
    expect(hasRequiredOfficeEntries("spreadsheet", new Set(["[Content_Types].xml", "word/document.xml"]))).toBe(false);
    expect(hasExternalMediaRelationship('<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.test/a.png" TargetMode="External"/>')).toBe(true);
    expect(hasExternalMediaRelationship('<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.test/a.png" TargetMode="&#x45;xternal"/>')).toBe(true);
    expect(hasExternalMediaRelationship('<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test" TargetMode="External"/>')).toBe(false);
    expect(hasExternalMediaRelationship('<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/media" TargetMode="External"/>')).toBe(false);
    expect(hasExternalMediaRelationship('<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/image.png" TargetMode="External"/>')).toBe(false);
    expect(hasExternalMediaRelationship('<Relationship Id="rId1" Type="urn:custom" Target="https://example.test/image" TargetMode="External"/>', '<a:blip r:link="rId1"/>')).toBe(true);
    expect(hasExternalMediaRelationship('<Relationship Id="rId1" Type="urn:custom" Target="https://example.test/image" TargetMode="External"/>', '<a:blip r:link="&#x72;Id1"/>')).toBe(true);
    expect(hasExternalMediaRelationship('<Relationship Id="r&#x49;d1" Type="urn:custom" Target="https://example.test" TargetMode="External"/>', '<a:blip r:link="rId1"/>')).toBe(true);
    expect(hasExternalMediaRelationship('<Relationship Id="rId1" Type="urn:custom" Target="https://example.test" TargetMode="External"/>', '<a:blip link="rId1"/>')).toBe(true);
    expect(hasExternalMediaRelationship('<Relationship Id="rId1" Type="urn:custom" Target="https://example.test" TargetMode="External"/>', '<a:blip r:embed="rId1"/>')).toBe(true);
    expect(hasExternalMediaRelationship('<Relationship Id="rId1" Type="urn:custom" Target="https://example.test" TargetMode="External"/>', '<v:imagedata r:id="rId1"/>')).toBe(true);
    expect(hasExternalMediaRelationship('<x:Relationship Id="rId1" Type="urn:custom" Target="https://example.test" TargetMode="External"/>', '<a:blip x:embed="rId1"/>')).toBe(true);
    expect(hasUnboundedEmbeddedMediaRelationship('<Relationship Id="rId1" Type="urn:custom" Target="word/custom/blob.bin"/>', '<a:blip x:embed="rId1"/>')).toBe(true);
    expect(hasUnboundedEmbeddedMediaRelationship('<Relationship Id="rId1" Type=".../hyperlink" Target="word/custom/blob.bin"/>', '<a:blip r:embed="rId1"/>')).toBe(true);
    expect(hasUnboundedEmbeddedMediaRelationship('<Relationship Id="rId1" Type=".../hyperlink" Target="https://example.test" TargetMode="External"/>', '<a:hlinkClick r:id="rId1"/>')).toBe(false);
    expect(hasUnsafeDocxMarkup('<w:pict><v:shape style="background:url(https://example.test)"/></w:pict>')).toBe(true);
    expect(hasUnsafeDocxMarkup('<x:pict><m:shape style="background:url(https://example.test)"/></x:pict>')).toBe(true);
    expect(hasUnsafeDocxMarkup('<w:pict><v:shape style="background:url&#x28;https://example.test&#x29;"/></w:pict>')).toBe(true);
    expect(hasUnsafeDocxMarkup('<w:document><w:body><w:p><w:r><w:t>Safe</w:t></w:r></w:p></w:body></w:document>')).toBe(false);
  });

  it("counts relationship-driven slide IDs and bounded DOCX page estimates", () => {
    expect(countPptxSlideIds("<p:presentation><p:sldIdLst><p:sldId r:id=\"r1\"/><p:sldId r:id=\"r2\"/></p:sldIdLst></p:presentation>", 2)).toBe(2);
    expect(countPptxSlideIds("<p:sldId id=\"1\"/><p:sldId id=\"2\"/><p:sldId id=\"3\"/>", 2)).toBe(3);
    expect(countDocxPages("<w:document><w:br w:type=\"page\"/></w:document>", 2)).toBe(2);
    expect(countDocxPages("<w:document><w:br w:type=\"page\"/><w:br w:type=\"page\"/></w:document>", 1)).toBe(2);
    expect(countDocxPages("<w:document><w:br w:type=\"&#112;age\"/><w:br w:type=\"&#112;age\"/></w:document>", 1)).toBe(2);
    expect(countDocxPages("<x:document><x:br x:type=\"page\"/><x:lastRenderedPageBreak/></x:document>", 1)).toBe(2);
    expect(countDocxPages(`<w:document>${"<w:p/>".repeat(801)}</w:document>`, 20)).toBe(21);
    expect(countDocxPages(`<w:document><w:p>${"<w:r><w:t>x</w:t></w:r>".repeat(8_001)}</w:p></w:document>`, 20)).toBe(21);
  });

  it("rejects ICO entry floods before scanning embedded headers", () => {
    const bytes = new Uint8Array(6 + 65 * 16);
    bytes.set([0, 0, 1, 0, 65, 0]);
    expect(() => assertImagePreviewBounds(bytes, "image/x-icon")).toThrow(/format|safely/i);
  });
});
