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

  it("uses the provider workspace root when it differs from /workspace", () => {
    const attachment = {
      fileId: "00000000-0000-7000-8000-000000000001",
      name: "Pasted text.txt",
    };

    expect(durableAttachmentPath(attachment, "/home/user/workspace"))
      .toBe("/home/user/workspace/inputs/00000000-0000-7000-8000-000000000001/Pasted text.txt");
    expect(durableAttachmentPrompt(attachment, "/home/user/workspace"))
      .toContain("Sandbox path: /home/user/workspace/inputs/");
  });

  it("routes ZIP attachments through the safe archive reader", () => {
    expect(durableAttachmentPrompt({
      fileId: "00000000-0000-7000-8000-000000000002",
      name: "evidence.zip",
      mediaType: "application/zip",
    })).toContain("Use read on this ZIP path first");
  });

  it("routes Office attachments through the same document reader", () => {
    expect(durableAttachmentPrompt({
      fileId: "00000000-0000-7000-8000-000000000003",
      name: "requirements.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).toContain("Use read on this document path for extracted text");
  });

  it("treats an OOXML document as a document when raw detection reports its ZIP container", () => {
    const prompt = durableAttachmentPrompt({
      fileId: "00000000-0000-7000-8000-000000000004",
      name: "requirements.docx",
      mediaType: "application/zip",
    });

    expect(prompt).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(prompt).toContain("Use read on this document path for extracted text");
    expect(prompt).not.toContain("Use read on this ZIP path first");
  });
});
