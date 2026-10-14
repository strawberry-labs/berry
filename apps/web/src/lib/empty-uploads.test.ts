import { describe, expect, it } from "vitest";
import { splitEmptyUploads } from "./empty-uploads";

describe("splitEmptyUploads (H-027)", () => {
  it("keeps real files and explains dropped folders", () => {
    const report = new File(["Scope of works"], "scope.pdf", { type: "application/pdf" });
    const folder = new File([], "Drawings");
    const result = splitEmptyUploads([report, folder]);
    expect(result.accepted).toEqual([report]);
    expect(result.message).toContain("Not attached (0 bytes): Drawings");
    expect(result.message).toContain("attach the files inside, or a .zip of the folder");
  });

  it("names empty typed files without calling them folders", () => {
    const result = splitEmptyUploads([new File([], "notes.txt", { type: "text/plain" })]);
    expect(result.accepted).toEqual([]);
    expect(result.message).toBe("Not attached (0 bytes): notes.txt. These files are empty.");
  });

  it("leaves ordinary uploads unchanged", () => {
    const files = [new File(["a"], "a.txt", { type: "text/plain" })];
    expect(splitEmptyUploads(files)).toEqual({ accepted: files, message: null });
  });
});
