import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, JsonlRpcPeer } from "./index.ts";

describe("JSONL RPC", () => {
  it("encodes and decodes frames", () => {
    const frame = { jsonrpc: "2.0" as const, id: "1", method: "ping", params: { ok: true } };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("round-trips requests between peers", async () => {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const a = new JsonlRpcPeer(bToA, aToB);
    const b = new JsonlRpcPeer(aToB, bToA, async (method, params) => ({ method, params: params ?? null }));
    a.start();
    b.start();
    await expect(a.request("echo", { value: "berry" })).resolves.toEqual({
      method: "echo",
      params: { value: "berry" },
    });
  });

  it("preserves structured error details", async () => {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const a = new JsonlRpcPeer(bToA, aToB);
    const b = new JsonlRpcPeer(aToB, bToA, async () => {
      const error = new Error("Approval required");
      error.name = "approval_required";
      (error as Error & { details: unknown }).details = { approvalId: "approval_1" };
      throw error;
    });
    const frames: string[] = [];
    bToA.on("data", (chunk) => frames.push(String(chunk)));
    a.start();
    b.start();
    await expect(a.request("needsApproval")).rejects.toThrow("Approval required");
    expect(frames.join("")).toContain('"details":{"approvalId":"approval_1"}');
  });
});
