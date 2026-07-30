import { describe, expect, it } from "vitest";
import { durableAttachmentPath, durableAttachmentPrompt } from "./durable-attachments.js";

describe("durable attachments", () => {
  it("uses a deterministic sandbox path and strips path traversal from names", () => {
    expect(durableAttachmentPath({
      fileId: "00000000-0000-7000-8000-000000000001",
      name: "../../project brief.pdf",
    })).toBe("/workspace/inputs/00000000-0000-7000-8000-000000000001/project brief.pdf");
  });

  it("tells the model exactly where an uploaded file is staged", () => {
    expect(durableAttachmentPrompt({
      fileId: "00000000-0000-7000-8000-000000000001",
      name: "project brief.pdf",
      mediaType: "application/pdf",
      size: 2048,
    })).toContain(
      "Sandbox path: /workspace/inputs/00000000-0000-7000-8000-000000000001/project brief.pdf",
    );
  });
});
