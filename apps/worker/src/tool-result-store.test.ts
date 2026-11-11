import { describe, expect, it, vi } from "vitest";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { S3ToolResultStore, readStoredToolResult } from "./tool-result-store.js";
import type { DurableTurnSnapshot, DurableTurnStep } from "./turn-runner.js";

describe("durable complete tool results", () => {
  const scope = { tenantId: "tenant-a", sessionId: "session-a" };
  function fixture() {
    const objects = new Map<string, { text: string; metadata?: Record<string, string> }>();
    const send = vi.fn(async (command: PutObjectCommand | GetObjectCommand) => {
      const key = command.input.Key!;
      if (command instanceof PutObjectCommand) {
        objects.set(key, { text: String(command.input.Body), ...(command.input.Metadata ? { metadata: command.input.Metadata } : {}) });
        return {};
      }
      const value = objects.get(key);
      if (!value) throw new Error("NoSuchKey");
      return { Body: { transformToString: async () => value.text }, Metadata: value.metadata };
    });
    return { store: new S3ToolResultStore({ send } as never, "private-bucket", "artifacts"), objects, send };
  }
  const step = (args: Record<string, unknown>) => ({ input: { arguments: args } }) as unknown as DurableTurnStep;

  it("stores the complete Unicode result immutably and pages through the omitted middle", async () => {
    const { store } = fixture();
    const text = JSON.stringify({ head: "x".repeat(160_000), fact: "verified middle evidence 🌍", tail: "y".repeat(160_000) }, null, 2);
    const ref = await store.put(scope, "step-1", text);
    expect(await store.get(scope, ref.id)).toBe(text);
    const found = await readStoredToolResult(store, scope as DurableTurnSnapshot, step({ result_id: ref.id, search: "verified middle", limit: 40 }));
    expect(found.output).toMatchObject({ found: true, offset: text.indexOf("verified middle"), totalCharacters: text.length });
    expect((found.output as { content: string }).content).toContain("verified middle evidence 🌍");
    expect((found.output as { content: string }).content).toContain("nextOffset=");
    expect((await store.put(scope, "step-1", text)).id).toBe(ref.id);
    expect((await store.put(scope, "step-1", text + " changed")).id).not.toBe(ref.id);
  });

  it("keeps browser pixels in private storage while returning searchable text and image metadata", async () => {
    const { store } = fixture();
    const image = { type: "image", mimeType: "image/png", data: "PRIVATE_SCREENSHOT_BASE64" };
    const text = JSON.stringify({ tool: "mcp__BerryCrawl__berrycrawl_browser_screenshot", content: [{ type: "text", text: "Visible report: quarterly results" }, image], details: { raw: [image], structuredContent: { data: { session_id: "bses_fixture" } } } }, null, 2);
    const ref = await store.put(scope, "browser-step", text);
    const read = await readStoredToolResult(store, scope as DurableTurnSnapshot, step({ result_id: ref.id, limit: 32_000 }));
    const output = JSON.stringify(read.output);
    expect(output).toContain("quarterly results");
    expect(output).toContain("image/png");
    expect(output).toContain("binary is omitted from text reads");
    expect(output).toContain("bses_fixture");
    expect(output).not.toContain(image.data);
    expect(await store.get(scope, ref.id)).toBe(text); // Native vision still restores the original pixels.
    const found = await readStoredToolResult(store, scope as DurableTurnSnapshot, step({ result_id: ref.id, search: "quarterly results" }));
    expect(found.output).toMatchObject({ found: true });
  });

  it("cannot read a reference from another tenant or session", async () => {
    const { store } = fixture();
    const ref = await store.put(scope, "step-1", "private result");
    await expect(store.get({ ...scope, tenantId: "tenant-b" }, ref.id)).rejects.toThrow("NoSuchKey");
    await expect(store.get({ ...scope, sessionId: "session-b" }, ref.id)).rejects.toThrow("NoSuchKey");
    await expect(store.get(scope, "../../another-result")).rejects.toThrow("Invalid tool result reference");
  });

  it("lists saved references from the journal even when their messages were compacted", async () => {
    const { store } = fixture();
    const ref = await store.put(scope, "step-1", "complete result");
    const snapshot = { ...scope, checkpointCoveredEntryId: "covered", entries: [{ entryId: "covered", payload: { message: { role: "toolResult", toolName: "mcp__docs__read", storedToolResult: ref } } }] } as unknown as DurableTurnSnapshot;
    const listed = await readStoredToolResult(store, snapshot, step({}));
    expect((listed.output as { content: string }).content).toContain(ref.id);
    const read = await readStoredToolResult(store, snapshot, step({ result_id: ref.id }));
    expect((read.output as { content: string }).content).toContain("complete result");
  });

  it("detects a corrupted object and respects cancellation", async () => {
    const { store, objects } = fixture();
    const ref = await store.put(scope, "step-1", "correct");
    objects.get([...objects.keys()][0]!)!.text = "corrupted";
    await expect(store.get(scope, ref.id)).rejects.toThrow("integrity");
    await expect(store.get(scope, ref.id, AbortSignal.abort())).rejects.toThrow();
  });

  it("bounds reads and supports continuing an exact search from a later offset", async () => {
    const { store } = fixture();
    const text = "fact" + "x".repeat(40_000) + "fact";
    const ref = await store.put(scope, "step-1", text);
    const found = await readStoredToolResult(store, scope as DurableTurnSnapshot, step({ result_id: ref.id, offset: 1, search: "fact" }));
    expect(found.output).toMatchObject({ offset: 40_004, endOffset: 40_008, nextOffset: null });
    const large = await readStoredToolResult(store, scope as DurableTurnSnapshot, step({ result_id: ref.id, limit: 1_000_000 }));
    expect(large.output).toMatchObject({ offset: 0, endOffset: 32_000, nextOffset: 32_000 });
  });
});
