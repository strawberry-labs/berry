import { describe, expect, it, vi } from "vitest";
import { BerryMobileClient } from "./mobile-client";
import { fixtureApprovals, fixtureMessages, fixtureTasks } from "./fixtures";

describe("BerryMobileClient", () => {
  it("uses the typed API client for tasks, thread, approvals, and device registration", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init?.headers).toBeInstanceOf(Headers);
      if (url.endsWith("/v1/tasks")) return json(fixtureTasks);
      if (url.endsWith("/v1/sessions/session_mobile_1/messages")) return json(fixtureMessages);
      if (url.endsWith("/v1/approvals")) return json(fixtureApprovals);
      if (url.endsWith("/v1/approvals/approval_mobile_1/decision")) return json({ ok: true });
      if (url.endsWith("/v1/devices")) {
        return json({
          id: "device_reg_1",
          tenantId: "tenant_1",
          userId: "user_1",
          deviceId: "ios-device-1",
          platform: "ios",
          pushProvider: "apns",
          pushTokenLast4: "1234",
          endpointMode: "berry-account",
          appVersion: "0.1.0",
          capabilities: ["approvals", "chat", "tasks", "push"],
          status: "active",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z",
          lastSeenAt: "2026-07-11T00:00:00.000Z",
        });
      }
      return json({});
    });
    const client = new BerryMobileClient({ baseUrl: "https://api.berry.test", sessionToken: "session", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.listTasks()).resolves.toHaveLength(2);
    await expect(client.listMessages("session_mobile_1")).resolves.toHaveLength(2);
    await expect(client.listApprovals()).resolves.toHaveLength(1);
    await expect(client.approve("approval_mobile_1")).resolves.toEqual({ ok: true });
    await expect(client.deny("approval_mobile_1")).resolves.toEqual({ ok: true });
    await expect(client.registerDevice({
      deviceId: "ios-device-1",
      platform: "ios",
      pushProvider: "apns",
      pushToken: "apns-token-1234",
      endpointMode: "berry-account",
      appVersion: "0.1.0",
      capabilities: ["approvals", "chat", "tasks", "push"],
    })).resolves.toMatchObject({ pushTokenLast4: "1234" });
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
