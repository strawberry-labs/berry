import { describe, expect, it } from "vitest";

import { decidedDirection, directedLines, markdownDirection, messageDirection, scriptWords, type ScriptWords } from "./text-direction.js";

describe("text direction for mixed Arabic/English text (H-047)", () => {
  it("counts words by script, splitting words that change script", () => {
    expect(scriptWords("Berry Workspace هو المكان الذي تُحفظ فيه ملفات المشروع.")).toEqual({ rtl: 7, ltr: 2, first: "ltr" });
    expect(scriptWords("يدعم ملفات PDF وDOCX وXLSX")).toEqual({ rtl: 4, ltr: 3, first: "rtl" });
  });

  it("ignores code spans, URLs, e-mail addresses and paths", () => {
    expect(scriptWords("شارك الرابط https://ai.example.com/tasks/123 مع الفريق")).toEqual({ rtl: 4, ltr: 0, first: "rtl" });
    expect(scriptWords("استخدم `persist_artifact` أو راسل ops@example.com واحفظ outputs/report.docx")).toEqual({ rtl: 4, ltr: 0, first: "rtl" });
  });

  it("settles a block only on a clear majority", () => {
    const words = (rtl: number, ltr: number): ScriptWords => ({ rtl, ltr, first: null });
    expect(decidedDirection(words(5, 2))).toBe("rtl");
    expect(decidedDirection(words(1, 11))).toBe("ltr");
    expect(decidedDirection(words(2, 3))).toBeNull();
    expect(decidedDirection(words(0, 0))).toBeNull();
  });

  it("gives a mixed message the direction of its first word", () => {
    expect(messageDirection(scriptWords("اختر Connectors ثم Google Drive"))).toBe("rtl");
    expect(messageDirection(scriptWords("Owner: محمد عبدالله"))).toBe("ltr");
    expect(messageDirection(scriptWords("2026-10-14"))).toBe("ltr");
  });

  it("directs lines, keeps fenced code left-to-right and lets mixed lines follow the message", () => {
    const { direction, lines } = directedLines([
      "تعمل منصة Berry مع Microsoft 365 لتلخيص الملفات.",
      "اختر Connectors ثم Google Drive",
      "This English line stays left-to-right.",
      "```python",
      "total = price * 2  # مجموع مجموع مجموع",
      "```",
      "",
    ].join("\n"));
    expect(direction).toBe("rtl");
    expect(lines.map((line) => line.dir)).toEqual([undefined, undefined, "ltr", "ltr", "ltr", "ltr", undefined]);
  });

  it("reuses counts for finished lines only", () => {
    const cache = new Map<string, ScriptWords>();
    directedLines("سطر كامل\nسطر لم", cache);
    expect([...cache.keys()]).toEqual(["سطر كامل"]);
  });

  it("reads Markdown direction without counting fenced code", () => {
    expect(markdownDirection("```js\nconst first = 'English code dominates here';\n```\nمرحبا بكم في Berry")).toBe("rtl");
    expect(markdownDirection("Plain English answer.")).toBe("ltr");
  });
});
