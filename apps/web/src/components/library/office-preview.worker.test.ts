import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

type WorkerHarness = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
};

describe("office preview worker", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("accepts a bounded normal DOCX-shaped archive through the worker entrypoint", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<w:document><w:body><w:p>Normal document</w:p></w:body></w:document>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const harness: WorkerHarness = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", harness);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { status: 200, headers: { "content-length": String(bytes.byteLength) } })));
    await import("./office-preview.worker");

    harness.onmessage?.({ data: {
      type: "inspect",
      url: "/preview/normal.docx",
      kind: "docx",
      sourceBytes: bytes.byteLength,
      maxSourceBytes: 2 * 1024 * 1024,
      maxExpandedBytes: 10 * 1024 * 1024,
      maxEntryCount: 5_000,
      maxEntryBytes: 4 * 1024 * 1024,
      maxSlides: 200,
      maxPages: 50,
    } } as MessageEvent);

    await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ready", pages: 1 }), expect.any(Array)));
  });

  it("rejects a misleading ZIP before an Office renderer can open it", async () => {
    const zip = new JSZip();
    zip.file("payload.bin", "not an OOXML package");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const harness: WorkerHarness = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", harness);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { status: 200, headers: { "content-length": String(bytes.byteLength) } })));
    await import("./office-preview.worker");

    harness.onmessage?.({ data: {
      type: "inspect",
      url: "/preview/misleading.docx",
      kind: "docx",
      sourceBytes: bytes.byteLength,
      maxSourceBytes: 2 * 1024 * 1024,
      maxExpandedBytes: 10 * 1024 * 1024,
      maxEntryCount: 5_000,
      maxEntryBytes: 4 * 1024 * 1024,
      maxSlides: 200,
      maxPages: 50,
    } } as MessageEvent);

    await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }), expect.any(Array)));
  });

  it("rejects DOCX legacy VML markup before main-thread rendering", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", '<w:document><w:body><w:pict><v:shape style="background:url(https://example.test)"/></w:pict></w:body></w:document>');
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const harness: WorkerHarness = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", harness);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { status: 200, headers: { "content-length": String(bytes.byteLength) } })));
    await import("./office-preview.worker");

    harness.onmessage?.({ data: {
      type: "inspect",
      url: "/preview/vml.docx",
      kind: "docx",
      sourceBytes: bytes.byteLength,
      maxSourceBytes: 2 * 1024 * 1024,
      maxExpandedBytes: 10 * 1024 * 1024,
      maxEntryCount: 5_000,
      maxEntryBytes: 4 * 1024 * 1024,
      maxSlides: 200,
      maxPages: 50,
    } } as MessageEvent);

    await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: expect.stringMatching(/legacy active markup/i) }), expect.any(Array)));
  });

  it("rejects legacy VML markup in rendered DOCX headers", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>Safe</w:t></w:r></w:p></w:body></w:document>");
    zip.file("word/header1.xml", '<w:hdr><w:pict><v:shape style="background:url(https://example.test)"/></w:pict></w:hdr>');
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const harness: WorkerHarness = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", harness);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { status: 200, headers: { "content-length": String(bytes.byteLength) } })));
    await import("./office-preview.worker");

    harness.onmessage?.({ data: {
      type: "inspect",
      url: "/preview/header-vml.docx",
      kind: "docx",
      sourceBytes: bytes.byteLength,
      maxSourceBytes: 2 * 1024 * 1024,
      maxExpandedBytes: 10 * 1024 * 1024,
      maxEntryCount: 5_000,
      maxEntryBytes: 4 * 1024 * 1024,
      maxSlides: 200,
      maxPages: 50,
    } } as MessageEvent);

    await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: expect.stringMatching(/legacy active markup/i) }), expect.any(Array)));
  });

  it("rejects an embedded image whose decoded dimensions exceed the image budget", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>Safe</w:t></w:r></w:p></w:body></w:document>");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 1]);
    // The image is deliberately outside word/media to exercise relationship
    // target/path-independent package scanning.
    zip.file("word/custom/image1.png", png);
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const harness: WorkerHarness = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", harness);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { status: 200, headers: { "content-length": String(bytes.byteLength) } })));
    await import("./office-preview.worker");

    harness.onmessage?.({ data: {
      type: "inspect",
      url: "/preview/huge-image.docx",
      kind: "docx",
      sourceBytes: bytes.byteLength,
      maxSourceBytes: 2 * 1024 * 1024,
      maxExpandedBytes: 10 * 1024 * 1024,
      maxEntryCount: 5_000,
      maxEntryBytes: 4 * 1024 * 1024,
      maxSlides: 200,
      maxPages: 50,
    } } as MessageEvent);

    await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: expect.stringMatching(/dimensions/i) }), expect.any(Array)));
  });

  it("rejects relationship-targeted media with an unbounded package extension", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", '<w:document><w:body><a:blip r:embed="rId1"/></w:body></w:document>');
    zip.file("word/_rels/document.xml.rels", '<Relationships><Relationship Id="rId1" Type="urn:custom" Target="custom/blob.bin"/></Relationships>');
    zip.file("word/custom/blob.bin", "unbounded image bytes");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const harness: WorkerHarness = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", harness);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { status: 200, headers: { "content-length": String(bytes.byteLength) } })));
    await import("./office-preview.worker");

    harness.onmessage?.({ data: {
      type: "inspect",
      url: "/preview/custom-media.docx",
      kind: "docx",
      sourceBytes: bytes.byteLength,
      maxSourceBytes: 2 * 1024 * 1024,
      maxExpandedBytes: 10 * 1024 * 1024,
      maxEntryCount: 5_000,
      maxEntryBytes: 4 * 1024 * 1024,
      maxSlides: 200,
      maxPages: 50,
    } } as MessageEvent);

    await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: expect.stringMatching(/media/i) }), expect.any(Array)));
  });

  it("rejects PPTX external media relationships", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("ppt/presentation.xml", "<p:presentation><p:sldIdLst><p:sldId r:id=\"rId1\"/></p:sldIdLst></p:presentation>");
    zip.file("ppt/_rels/presentation.xml.rels", "<Relationships><Relationship Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"https://example.test/image.png\" TargetMode=\"External\"/></Relationships>");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const harness: WorkerHarness = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", harness);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { status: 200, headers: { "content-length": String(bytes.byteLength) } })));
    await import("./office-preview.worker");

    harness.onmessage?.({ data: {
      type: "inspect",
      url: "/preview/external-media.pptx",
      kind: "pptx",
      sourceBytes: bytes.byteLength,
      maxSourceBytes: 2 * 1024 * 1024,
      maxExpandedBytes: 10 * 1024 * 1024,
      maxEntryCount: 5_000,
      maxEntryBytes: 4 * 1024 * 1024,
      maxSlides: 200,
      maxPages: 20,
    } } as MessageEvent);

    await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: expect.stringMatching(/external media/i) }), expect.any(Array)));
  });
});
