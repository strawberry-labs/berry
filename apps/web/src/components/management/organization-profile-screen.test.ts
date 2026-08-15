import { describe, expect, it } from "vitest";
import { FILE_RESPONSE_SECURITY_VERSION } from "@berry/shared";
import { brandingAssetUrl, normalizeBrandingAssetFile } from "./organization-profile-screen.tsx";

describe("organization branding upload validation", () => {
  it("uses the shared response security version in immutable branding URLs", () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    expect(brandingAssetUrl("https://api.example.test", "logo", fileId))
      .toBe(`https://api.example.test/v1/branding/logo?v=${fileId}&sv=${FILE_RESPONSE_SECURITY_VERSION}`);
  });

  it("infers the ICO media type when the browser leaves it empty", () => {
    const file = new File([new Uint8Array([0, 0, 1, 0])], "favicon.ico");
    expect(normalizeBrandingAssetFile(file, "favicon").type).toBe("image/x-icon");
  });

  it("rejects non-image branding files", () => {
    const file = new File(["not an image"], "notes.txt", { type: "text/plain" });
    expect(() => normalizeBrandingAssetFile(file, "logo")).toThrow("Choose a PNG, JPG, or WebP logo");
  });

  it("rejects active SVG branding files", () => {
    const file = new File(["<svg onload=\"alert(1)\"></svg>"], "logo.svg", { type: "image/svg+xml" });
    expect(() => normalizeBrandingAssetFile(file, "logo")).toThrow("Choose a PNG, JPG, or WebP logo");
  });

  it("enforces the smaller favicon size limit", () => {
    const file = new File([new Uint8Array(1024 * 1024 + 1)], "favicon.png", { type: "image/png" });
    expect(() => normalizeBrandingAssetFile(file, "favicon")).toThrow("1 MB or smaller");
  });
});
