import { describe, expect, it } from "vitest";
import { diffLineAnchor, parseUnifiedDiff, virtualRange } from "@berry/thread-ui/diff-model";

const RENAMED_DIFF = `diff --git a/src/old.ts b/src/new.ts
similarity index 71%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,2 +1,2 @@
-const answer = oldValue;
+const answer = newValue;
 export { answer };`;

describe("diff model", () => {
  it("parses renames, line numbers, and word-level changes", () => {
    const [file] = parseUnifiedDiff(RENAMED_DIFF);
    expect(file).toMatchObject({ oldPath: "src/old.ts", newPath: "src/new.ts", status: "renamed", additions: 1, deletions: 1, language: "typescript" });
    const removed = file!.lines.find((line) => line.kind === "remove")!;
    const added = file!.lines.find((line) => line.kind === "add")!;
    expect(removed.changed.map((range) => removed.content.slice(range.start, range.end))).toContain("oldValue");
    expect(added.changed.map((range) => added.content.slice(range.start, range.end))).toContain("newValue");
    expect(diffLineAnchor(file!, added)).toMatchObject({ path: "src/new.ts", oldPath: "src/old.ts", side: "new", line: 1 });
    expect(diffLineAnchor(file!, removed)).toMatchObject({ path: "src/new.ts", oldPath: "src/old.ts", side: "old", line: 1 });
  });

  it("windows large fixed-height diffs with overscan", () => {
    expect(virtualRange(1_000, 2_000, 440, 22, 10)).toEqual({ start: 80, end: 121, offsetTop: 1760, offsetBottom: 19338 });
  });

  it("bounds word comparison for adversarially long changed lines", () => {
    const left = Array.from({ length: 300 }, (_, index) => `old${index}`).join(" ");
    const right = Array.from({ length: 300 }, (_, index) => `new${index}`).join(" ");
    const [file] = parseUnifiedDiff(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-${left}\n+${right}`);
    expect(file?.lines.find((line) => line.kind === "remove")?.changed).toEqual([{ start: 0, end: left.length }]);
    expect(file?.lines.find((line) => line.kind === "add")?.changed).toEqual([{ start: 0, end: right.length }]);
  });
});
