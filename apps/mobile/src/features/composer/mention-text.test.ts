import { describe, expect, it } from "vitest";
import { detectTrigger } from "@berry/client-core/mentions";
import { applyAtomicDeletion, insertMention, segmentText } from "./mention-text";

describe("composer mentions", () => {
  it("styles only whole mention tokens", () => {
    expect(segmentText("use $deep-research now", ["$deep-research"])).toEqual([
      { text: "use ", mention: false },
      { text: "$deep-research", mention: true },
      { text: " now", mention: false },
    ]);
    expect(segmentText("x$deep-research", ["$deep-research"])).toEqual([{ text: "x$deep-research", mention: false }]);
    expect(segmentText("", [])).toEqual([{ text: "", mention: false }]);
  });

  it("removes a whole token when one of its characters is deleted", () => {
    expect(applyAtomicDeletion("run /compact now", "run /compac now", ["/compact"])).toBe("run  now");
    expect(applyAtomicDeletion("run /compact now", "run /compact no", ["/compact"])).toBe("run /compact no");
    expect(applyAtomicDeletion("hello", "hell", [])).toBe("hell");
  });

  it("inserts the same markdown the web editor serializes", () => {
    const text = "ask $dee";
    const trigger = detectTrigger(text)!;
    expect(trigger).toMatchObject({ trigger: "$", query: "dee" });
    expect(insertMention(text, text.length, trigger, "$deep-research")).toEqual({ text: "ask $deep-research ", cursor: 19 });
  });
});
