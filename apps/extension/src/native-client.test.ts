import { describe, expect, it, vi } from "vitest";
import { NativeHostClient } from "./native-client";

describe("NativeHostClient", () => {
  it("posts validated host requests and resolves matching responses", async () => {
    const port = fakePort();
    const client = new NativeHostClient(() => port as unknown as chrome.runtime.Port);
    const pending = client.call("task.list", { workspaceId: "workspace_1" });
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      method: "task.list",
      params: { workspaceId: "workspace_1" },
    }));
    const request = vi.mocked(port.postMessage).mock.calls[0]![0] as { id: string };
    port.emitMessage({ id: request.id, result: [] });
    await expect(pending).resolves.toEqual([]);
  });

  it("rejects native errors with the host error code", async () => {
    const port = fakePort();
    const client = new NativeHostClient(() => port as unknown as chrome.runtime.Port);
    const pending = client.call("approval.decide", { id: "ap_1", decision: "denied" });
    const request = vi.mocked(port.postMessage).mock.calls[0]![0] as { id: string };
    port.emitMessage({ id: request.id, error: { code: "approval_missing", message: "Approval not found" } });
    await expect(pending).rejects.toMatchObject({ name: "approval_missing" });
  });
});

function fakePort() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
    emitMessage(message: unknown) {
      for (const listener of messageListeners) listener(message);
    },
    emitDisconnect() {
      for (const listener of disconnectListeners) listener();
    },
  };
}
