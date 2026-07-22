import { describe, expect, it } from "vitest";
import { filesFromDataTransfer } from "./web-composer.tsx";

const file = { name: "project-brief.pdf", size: 128, type: "application/pdf" } as File;

describe("filesFromDataTransfer", () => {
  it("reads files exposed directly by Finder drag and clipboard payloads", () => {
    const files = filesFromDataTransfer({
      files: [file] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
    });

    expect(files).toEqual([file]);
  });

  it("falls back to file clipboard items when the files list is empty", () => {
    const files = filesFromDataTransfer({
      files: [] as unknown as FileList,
      items: [{ kind: "file", getAsFile: () => file }] as unknown as DataTransferItemList,
    });

    expect(files).toEqual([file]);
  });

  it("leaves ordinary text paste untouched", () => {
    const files = filesFromDataTransfer({
      files: [] as unknown as FileList,
      items: [{ kind: "string", getAsFile: () => null }] as unknown as DataTransferItemList,
    });

    expect(files).toEqual([]);
  });
});
