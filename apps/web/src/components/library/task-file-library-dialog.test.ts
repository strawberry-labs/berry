import { describe, expect, it } from "vitest";
import { downloadFilesIndividually, mergeItemsById, uniqueDownloadName } from "./task-file-library-dialog";

describe("task file downloads", () => {
  it("keeps duplicate files distinct without allowing download paths", () => {
    const used = new Set<string>();

    expect(uniqueDownloadName("reports/annual.pdf", used)).toBe("reports-annual.pdf");
    expect(uniqueDownloadName("reports\\annual.pdf", used)).toBe("reports-annual (2).pdf");
    expect(uniqueDownloadName("REPORTS/ANNUAL.PDF", used)).toBe("REPORTS-ANNUAL (3).PDF");
  });

  it("provides a stable fallback for an empty file name", () => {
    expect(uniqueDownloadName("  ", new Set())).toBe("file");
    expect(uniqueDownloadName("..", new Set())).toBe("file");
  });

  it("appends a page without retaining duplicate cursor-boundary items", () => {
    expect(mergeItemsById(
      [{ id: "one", name: "one" }, { id: "two", name: "two" }],
      [{ id: "two", name: "duplicate" }, { id: "three", name: "three" }],
    )).toEqual([
      { id: "one", name: "one" },
      { id: "two", name: "two" },
      { id: "three", name: "three" },
    ]);
  });

  it("downloads one file at a time and continues after an individual failure", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const controller = new AbortController();

    const result = await downloadFilesIndividually({
      files: [
        { id: "one", name: "report.pdf" },
        { id: "two", name: "broken.pdf" },
        { id: "three", name: "report.pdf" },
      ],
      signal: controller.signal,
      download: async (fileId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${fileId}`);
        await Promise.resolve();
        active -= 1;
        if (fileId === "two") throw new Error("failed");
        return new Blob([fileId]);
      },
      save: (_blob, name) => events.push(`save:${name}`),
    });

    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "start:one",
      "save:report.pdf",
      "start:two",
      "start:three",
      "save:report (2).pdf",
    ]);
    expect(result).toEqual({
      downloaded: 2,
      failed: [{ fileId: "two", name: "broken.pdf" }],
    });
  });
});
