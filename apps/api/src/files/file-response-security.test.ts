import { describe, expect, it, vi } from "vitest";
import {
  FILE_RESPONSE_CSP,
  bufferBodyPrefix,
  contentDisposition,
  detectMediaType,
  fileResponsePolicy,
  normalizeMediaType,
  setUntrustedFileResponseHeaders,
} from "./file-response-security.ts";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe("untrusted file response security", () => {
  it("detects active HTML, SVG, and XML from bytes rather than client metadata", () => {
    expect(detectMediaType(Buffer.from("<!doctype html><script>top.pwned=true</script>"))).toBe("text/html");
    expect(detectMediaType(Buffer.from("<?xml version=\"1.0\"?><svg onload=\"top.pwned=true\"></svg>"))).toBe("image/svg+xml");
    expect(detectMediaType(Buffer.from("<?xml version=\"1.0\"?><document/>"))).toBe("application/xml");
  });

  it("permits inline rendering only when a passive signature matches the declared type", () => {
    expect(fileResponsePolicy({
      declaredMediaType: "image/png",
      detectedMediaType: detectMediaType(PNG_BYTES),
      allowInline: true,
    })).toMatchObject({ contentType: "image/png", disposition: "inline", mediaTypeMatches: true });

    expect(fileResponsePolicy({
      declaredMediaType: "image/png",
      detectedMediaType: detectMediaType(Buffer.from("<html>spoofed image</html>")),
      allowInline: true,
    })).toMatchObject({ contentType: "application/octet-stream", disposition: "attachment", mediaTypeMatches: false });
  });

  it("fails closed for missing, malformed, active, and forced-download MIME information", () => {
    expect(normalizeMediaType("image/png\r\nX-Evil: yes")).toBeNull();
    for (const input of [
      { declaredMediaType: undefined, detectedMediaType: "image/png", allowInline: true },
      { declaredMediaType: "text/html", detectedMediaType: "text/html", allowInline: true },
      { declaredMediaType: "image/svg+xml", detectedMediaType: "image/svg+xml", allowInline: true },
      { declaredMediaType: "image/png", detectedMediaType: "image/png", allowInline: false },
    ]) {
      expect(fileResponsePolicy(input)).toMatchObject({ contentType: "application/octet-stream", disposition: "attachment" });
    }
  });

  it("sanitizes response filenames without allowing header injection", () => {
    const header = contentDisposition("attachment", "quarterly\r\nX-Evil: yes\u202ereport.html");
    expect(header).toMatch(/^attachment; filename=/);
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
    expect(header).not.toContain("\u202e");
    expect(header).toContain("filename*=UTF-8''");
  });

  it("does not split astral characters or retain lone surrogates at the filename limit", () => {
    const boundary = `${"a".repeat(179)}😀`;
    expect(() => contentDisposition("attachment", boundary)).not.toThrow();
    expect(contentDisposition("attachment", boundary)).toContain("%F0%9F%98%80");
    expect(() => contentDisposition("attachment", `broken-\ud83d-name.png`)).not.toThrow();
  });

  it("sets the complete defense-in-depth header set", () => {
    const response = { setHeader: vi.fn() };
    setUntrustedFileResponseHeaders(response as never, {
      fileName: "report.html",
      policy: { contentType: "application/octet-stream", disposition: "attachment" },
    });
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "application/octet-stream");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Security-Policy", FILE_RESPONSE_CSP);
    expect(response.setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
    expect(response.setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
    expect(response.setHeader).toHaveBeenCalledWith("Cross-Origin-Resource-Policy", "same-site");
  });

  it("allows a passive preview from the supported sibling web and API origins", () => {
    const response = { setHeader: vi.fn() };
    setUntrustedFileResponseHeaders(response as never, {
      fileName: "preview.png",
      policy: fileResponsePolicy({
        declaredMediaType: "image/png",
        detectedMediaType: "image/png",
        allowInline: true,
      }),
    });

    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
    expect(response.setHeader).toHaveBeenCalledWith("Cross-Origin-Resource-Policy", "same-site");
  });

  it("inspects a bounded prefix and replays every byte exactly once", async () => {
    const source = {
      async *[Symbol.asyncIterator]() {
        yield Uint8Array.from([1, 2, 3]);
        yield Uint8Array.from([4, 5, 6]);
      },
    };
    const inspected = await bufferBodyPrefix(source, 4);
    expect([...inspected.sample]).toEqual([1, 2, 3, 4]);
    const replayed: number[] = [];
    for await (const chunk of inspected.body) replayed.push(...chunk);
    expect(replayed).toEqual([1, 2, 3, 4, 5, 6]);
    await expect(async () => {
      for await (const _chunk of inspected.body) void _chunk;
    }).rejects.toThrow("only be consumed once");
  });
});
