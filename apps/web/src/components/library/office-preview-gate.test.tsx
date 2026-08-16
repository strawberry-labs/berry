import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredFile } from "@berry/shared";
import { OfficePreviewGate, useOfficePreviewBytes } from "./office-preview-gate";

const FILE = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "normal.docx",
  originalName: "normal.docx",
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  detectedMediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size: 1024,
  sha256: null,
  origin: "user_upload",
  status: "available",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  taskIds: [],
  roles: [],
  downloadUrl: "/download/normal.xlsx",
  previewUrl: "/preview/normal.docx",
} as unknown as StoredFile;

describe("OfficePreviewGate", () => {
  const previousWorker = globalThis.Worker;
  afterEach(() => {
    vi.useRealTimers();
    if (previousWorker) Object.defineProperty(globalThis, "Worker", { configurable: true, value: previousWorker });
    else delete (globalThis as typeof globalThis & { Worker?: unknown }).Worker;
  });

  it("terminates archive inspection when the preview unmounts", () => {
    const workers: Array<{ terminated: boolean; terminate: () => void }> = [];
    class TestWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      terminated = false;
      constructor() { workers.push(this); }
      postMessage() {}
      terminate() { this.terminated = true; }
    }
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: TestWorker });

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<OfficePreviewGate file={FILE} kind="docx"><span>ready</span></OfficePreviewGate>);
    });
    expect(workers).toHaveLength(1);
    act(() => renderer!.unmount());
    expect(workers[0]!.terminated).toBe(true);
  });

  it("ignores a late ready response after the inspection timeout", () => {
    vi.useFakeTimers();
    const workers: Array<{ terminated: boolean; onmessage: ((event: MessageEvent) => void) | null; terminate: () => void }> = [];
    class TestWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      terminated = false;
      constructor() { workers.push(this); }
      postMessage() {}
      terminate() { this.terminated = true; }
    }
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: TestWorker });

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<OfficePreviewGate file={FILE} kind="docx"><span>ready</span></OfficePreviewGate>);
    });
    act(() => { vi.advanceTimersByTime(15_001); });
    expect(workers[0]!.terminated).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("This file is download-only");

    act(() => {
      workers[0]!.onmessage?.({ data: { type: "ready", entries: 2, expandedBytes: 10, slides: null, pages: null } } as MessageEvent);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("This file is download-only");
  });

  it("terminates the worker when a bounded inspection succeeds", () => {
    const workers: Array<{ terminated: boolean; onmessage: ((event: MessageEvent) => void) | null; terminate: () => void }> = [];
    class TestWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      terminated = false;
      constructor() { workers.push(this); }
      postMessage() {}
      terminate() { this.terminated = true; }
    }
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: TestWorker });

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<OfficePreviewGate file={FILE} kind="docx"><BytesProbe /></OfficePreviewGate>);
    });
    act(() => {
      workers[0]!.onmessage?.({ data: { type: "ready", entries: 2, expandedBytes: 10, slides: null, pages: null, bytes: new ArrayBuffer(4) } } as MessageEvent);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("bytes");
    expect(workers[0]!.terminated).toBe(true);
  });
});

function BytesProbe() {
  return <span>{useOfficePreviewBytes() ? "bytes" : "missing-bytes"}</span>;
}
