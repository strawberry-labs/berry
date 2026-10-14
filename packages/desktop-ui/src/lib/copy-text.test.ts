import { afterEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { copyText } from "./copy-text";

describe("copyText (H-044)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    toast.success.mockReset();
    toast.error.mockReset();
  });

  it("reports success only after the clipboard write resolves", async () => {
    let finishWrite: () => void = () => undefined;
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(() => new Promise<void>((resolve) => { finishWrite = resolve; })) } });
    copyText("Thanks for the update.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toast.success).not.toHaveBeenCalled();
    finishWrite();
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Copied"));
  });

  it("reports denied or missing clipboard access instead of Copied", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => { throw new Error("NotAllowedError"); }) } });
    copyText("Thanks for the update.");
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    vi.stubGlobal("navigator", {});
    copyText("Thanks for the update.");
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
