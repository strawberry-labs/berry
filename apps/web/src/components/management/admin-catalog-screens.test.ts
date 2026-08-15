import { describe, expect, it } from "vitest";
import { saveNewTaskDefaultSafely } from "./admin-catalog-screens";

describe("organization model defaults", () => {
  it("turns a rejected task default request into visible feedback", async () => {
    await expect(saveNewTaskDefaultSafely(async () => {
      throw new Error("Provider is unavailable");
    })).resolves.toEqual({ ok: false, error: "Provider is unavailable" });

    await expect(saveNewTaskDefaultSafely(async () => {
      throw new Error("");
    })).resolves.toEqual({
      ok: false,
      error: "Could not save the default model. Try again.",
    });
  });
});
