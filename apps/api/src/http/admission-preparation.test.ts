import { describe, expect, it } from "vitest";
import { resolveOptionalAdmissionPreparation } from "./agent-api.controller.js";

describe("optional admission preparation at the deadline (H-050)", () => {
  it("keeps a result that was ready before the deadline even when it is read afterwards", async () => {
    const ready = Promise.resolve({ status: "fulfilled" as const, value: ["inspect_images"] });
    await ready;
    await expect(resolveOptionalAdmissionPreparation(ready, [], Date.now() - 1, "vision")).resolves.toEqual(["inspect_images"]);
  });

  it("still falls back for work that is pending at the deadline", async () => {
    const pending = new Promise<never>(() => undefined);
    await expect(resolveOptionalAdmissionPreparation(pending, ["fallback"], Date.now() - 1, "vision")).resolves.toEqual(["fallback"]);
  });

  it("falls back for work that failed", async () => {
    const failed = Promise.resolve({ status: "rejected" as const, reason: new Error("lookup failed") });
    await expect(resolveOptionalAdmissionPreparation(failed, ["fallback"], Date.now() + 1_000, "vision")).resolves.toEqual(["fallback"]);
  });
});
