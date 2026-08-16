import * as XLSX from "xlsx";
import { beforeEach, describe, expect, it, vi } from "vitest";

type WorkerHarness = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
};

describe("spreadsheet parser worker", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("parses a normal XLSX workbook and returns a bounded sheet window", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Name", "Value"], ["Berry", "1"]]), "Sheet1");
    const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
    const harness: WorkerHarness = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", harness);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { status: 200, headers: { "content-length": String(bytes.byteLength) } })));
    await import("./spreadsheet-parser.worker");

    harness.onmessage?.({ data: {
      type: "load",
      url: "/preview/normal.xlsx",
      extension: "xlsx",
      maxSourceBytes: 25 * 1024 * 1024,
      maxSheets: 50,
    } } as MessageEvent);

    await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ready", sheetNames: ["Sheet1"] })));
    const ready = harness.postMessage.mock.calls.find(([message]) => message?.type === "ready")?.[0] as { sheet: { rows: string[][] } };
    expect(ready.sheet.rows.slice(0, 2)).toEqual([["Name", "Value"], ["Berry", "1"]]);
  });

  it("rejects an over-wide CSV before SheetJS parses it", async () => {
    const bytes = new TextEncoder().encode(Array.from({ length: 101 }, () => "x").join(","));
    const harness: WorkerHarness = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", harness);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { status: 200, headers: { "content-length": String(bytes.byteLength) } })));
    await import("./spreadsheet-parser.worker");

    harness.onmessage?.({ data: {
      type: "load",
      url: "/preview/wide.csv",
      extension: "csv",
      maxSourceBytes: 2 * 1024 * 1024,
      maxSheets: 50,
    } } as MessageEvent);

    await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })));
  });

  it("rejects a ZIP payload disguised as legacy XLS", async () => {
    const bytes = new TextEncoder().encode("PK\x03\x04not-a-BIFF-workbook");
    const harness: WorkerHarness = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", harness);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { status: 200, headers: { "content-length": String(bytes.byteLength) } })));
    await import("./spreadsheet-parser.worker");

    harness.onmessage?.({ data: {
      type: "load",
      url: "/preview/disguised.xls",
      extension: "xls",
      maxSourceBytes: 2 * 1024 * 1024,
      maxSheets: 50,
    } } as MessageEvent);

    await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: expect.stringMatching(/ZIP payload/i) })));
  });

  it("rejects a prefixed ZIP payload disguised as legacy XLS", async () => {
    const bytes = new Uint8Array(new TextEncoder().encode("self-extractor\0PK\x03\x04not-a-BIFF-workbook"));
    const harness: WorkerHarness = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("self", harness);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { status: 200, headers: { "content-length": String(bytes.byteLength) } })));
    await import("./spreadsheet-parser.worker");

    harness.onmessage?.({ data: {
      type: "load",
      url: "/preview/prefixed-disguised.xls",
      extension: "xls",
      maxSourceBytes: 2 * 1024 * 1024,
      maxSheets: 50,
    } } as MessageEvent);

    await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: expect.stringMatching(/ZIP payload/i) })));
  });
});
