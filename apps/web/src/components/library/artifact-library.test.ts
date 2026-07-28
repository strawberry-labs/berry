import { describe, expect, it } from "vitest";
import { knowledgeStatusView } from "./artifact-library";

describe("knowledgeStatusView", () => {
  it("distinguishes indexed, in-progress, failed, and pending sources", () => {
    expect(knowledgeStatusView("indexed")).toEqual({ label: "Indexed", tone: "good" });
    expect(knowledgeStatusView("embedding")).toEqual({ label: "Embedding", tone: "warning" });
    expect(knowledgeStatusView("failed")).toEqual({ label: "Failed", tone: "danger" });
    expect(knowledgeStatusView("pending")).toEqual({ label: "Pending", tone: "neutral" });
  });
});
