import { describe, expect, it } from "vitest";
import type { AttachmentInput } from "@berry/shared";
import type { QueuedFollowUp } from "@/lib/queued-follow-ups";
import {
  filesFromDataTransfer,
  PASTED_TEXT_ATTACHMENT_THRESHOLD,
  PASTED_TEXT_INLINE_LIMIT,
  pastedTextMode,
  prunePastedTextPresentations,
  reasoningLevelsForModel,
} from "./web-composer.tsx";

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

describe("pastedTextMode", () => {
  it("keeps short paste native, collapses long paste, and files oversized paste", () => {
    expect(pastedTextMode("a".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD - 1))).toBe("native");
    expect(pastedTextMode("a".repeat(PASTED_TEXT_ATTACHMENT_THRESHOLD))).toBe("inline");
    expect(pastedTextMode("a".repeat(PASTED_TEXT_INLINE_LIMIT))).toBe("inline");
    expect(pastedTextMode("a".repeat(PASTED_TEXT_INLINE_LIMIT + 1))).toBe("file");
  });
});

describe("prunePastedTextPresentations", () => {
  const presentations = {
    active: { text: "active", title: "Active", mode: "inline" as const },
    queued: { text: "queued", title: "Queued", mode: "file" as const },
    removed: { text: "removed", title: "Removed", mode: "inline" as const },
  };

  it("retains only composer and queued-follow-up attachment metadata", () => {
    expect(prunePastedTextPresentations(
      presentations,
      [{ id: "active" } as AttachmentInput],
      [{ attachments: [{ id: "queued" } as AttachmentInput] } as QueuedFollowUp],
    )).toEqual({ active: presentations.active, queued: presentations.queued });
  });

  it("preserves object identity when no metadata is stale", () => {
    const current = { active: presentations.active };
    expect(prunePastedTextPresentations(
      current,
      [{ id: "active" } as AttachmentInput],
      [],
    )).toBe(current);
  });
});

describe("reasoningLevelsForModel", () => {
  it("uses declared model capabilities and recognizes the GLM 5.2 fallback", () => {
    expect(reasoningLevelsForModel({ id: "custom", capabilities: { reasoning: true, reasoningEfforts: ["low", "high"] } })).toEqual(["low", "high"]);
    expect(reasoningLevelsForModel({ id: "glm-5.2" })).toEqual(["high", "xhigh"]);
    expect(reasoningLevelsForModel({ id: "no-reasoning", capabilities: { reasoning: false } })).toEqual(["off"]);
  });
});
