import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { FileResponseTransfer } from "./file-response-transfer.ts";

function response(writable = true) {
  return Object.assign(new EventEmitter(), { destroyed: false, flushHeaders: vi.fn(), write: vi.fn(() => writable), end: vi.fn() });
}

describe("download connection lifetime", () => {
  it("releases an S3 body when the browser disconnects while waiting for drain", async () => {
    const res = response(false);
    const body = Readable.from([Buffer.alloc(32768), Buffer.alloc(32768)]);
    const transfer = new FileResponseTransfer(res as never);
    transfer.track(body);
    const result = transfer.stream(body);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await new Promise(resolve => setImmediate(resolve));
    expect(res.write).toHaveBeenCalledOnce();
    res.emit("close");
    await rejected;
    expect(body.destroyed).toBe(true);
    expect(transfer.signal.aborted).toBe(true);
    transfer.dispose();
    expect(res.listenerCount("drain")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });
  it("aborts queued storage acquisition when the client disconnects", () => {
    const res = response(); const transfer = new FileResponseTransfer(res as never);
    res.emit("close");
    expect(transfer.signal.aborted).toBe(true);
    const body = Readable.from([Buffer.from("late response")]);
    expect(() => transfer.track(body)).toThrow("connection closed");
    expect(body.destroyed).toBe(true); transfer.dispose();
  });
  it("bounds the idle wait for a storage connection", async () => {
    const res = response(); const transfer = new FileResponseTransfer(res as never, 10);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(transfer.signal.aborted).toBe(true);
    expect(transfer.signal.reason.getStatus()).toBe(504); transfer.dispose();
  });
  it("flushes response headers and finishes successful transfers", async () => {
    const res = response(); const body = Readable.from([Buffer.from("zip")]);
    const transfer = new FileResponseTransfer(res as never); transfer.track(body);
    await transfer.stream(body); transfer.dispose();
    expect(res.flushHeaders).toHaveBeenCalledOnce();
    expect(res.write).toHaveBeenCalledWith(Buffer.from("zip"));
    expect(res.end).toHaveBeenCalledOnce(); expect(res.listenerCount("close")).toBe(0);
  });
});
