import { describe, expect, it, vi } from "vitest";
import { BerryApiClient } from "./index.ts";

describe("scheduled task API calls", () => {
  it("keeps manual run keys stable and parses the resulting chat linkage", async () => {
    const operationId = "00000000-0000-4000-8000-000000000001";
    const id = "00000000-0000-4000-8000-000000000002";
    const run = { id: operationId, scheduleId: id, scheduledAt: "2026-10-06T13:00:00Z", trigger: "manual", state: "pending", taskId: operationId, sessionId: operationId, turnId: null, turnState: null, error: null, createdAt: "2026-10-06T13:00:00Z", finishedAt: null };
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify(run), { headers: { "Content-Type": "application/json" } }));
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl });
    await expect(client.runScheduledTask(id, operationId)).resolves.toEqual(run);
    expect(fetchImpl).toHaveBeenCalledWith(`https://api.berry.test/v1/scheduled-tasks/${id}/run`, expect.objectContaining({ method: "POST", body: JSON.stringify({ operationId }) }));
  });
  it("does not allow schedule changes while impersonating a support view", async () => {
    const fetchImpl = vi.fn();
    const client = new BerryApiClient({ baseUrl: "https://api.berry.test", fetchImpl,
      supportView: { tenantId: "tenant", userId: "member" },
    });
    await expect(client.deleteScheduledTask("schedule")).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
