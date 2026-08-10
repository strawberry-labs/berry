import { describe, expect, it } from "vitest";
import { normalizeBrandingAssetFile } from "./organization-profile-screen.tsx";

describe("organization branding upload validation", () => {
  it("infers the ICO media type when the browser leaves it empty", () => {
    const file = new File([new Uint8Array([0, 0, 1, 0])], "favicon.ico");
    expect(normalizeBrandingAssetFile(file, "favicon").type).toBe("image/x-icon");
  });

  it("rejects non-image branding files", () => {
    const file = new File(["not an image"], "notes.txt", { type: "text/plain" });
    expect(() => normalizeBrandingAssetFile(file, "logo")).toThrow("Choose a PNG, JPG, WebP, or SVG logo");
  });

  it("enforces the smaller favicon size limit", () => {
    const file = new File([new Uint8Array(1024 * 1024 + 1)], "favicon.png", { type: "image/png" });
    expect(() => normalizeBrandingAssetFile(file, "favicon")).toThrow("1 MB or smaller");
  });
});
