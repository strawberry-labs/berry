import { describe, expect, it, vi } from "vitest";
import { BerryApiError, type StartTurnRequest } from "@berry/api-client";
import { parseCloudShellLocation } from "@/lib/cloud-shell-state";
import { PERSONAL_NAV, visibleAdministrationGroups } from "./management/management-navigation";
import { activeTurnStateAfterConflict, clearDurableEventReplayBoundary, durableTurnPhase, existingChatTurnModelOverride, hydratedExistingChatModel, initialCloudContent, isInterruptedTurnAvailable, newChatModelOverride, preferredNewChatModel, prepareTurnCancellation, reduceDurableTurnState, replayDurableStreamState, retryTurnAdmission, revokeAuthSession, shouldConfirmTurnAdmission, shouldRefreshAdministration, shouldShowComposerProjectSwitcher, type ShellData } from "./app-shell";
import { accountAvatarInitial, allowanceProgress, formatAllowanceResetDate } from "./shell/web-sidebar";

describe("cloud shell bootstrap", () => {
  it("uses the account name and then email for the sidebar avatar fallback", () => {
    expect(accountAvatarInitial({ name: " strawberry", email: "user@example.com" })).toBe("S");
    expect(accountAvatarInitial({ name: "", email: "user@example.com" })).toBe("U");
  });

  it("does not issue live requests for fixture task and session identifiers", () => {
    const fixture = {
      config: { demoMode: false },
      tasks: [{ id: "task_cloud", activeSessionId: "session_cloud" }],
      messages: [{ id: "message_cloud" }],
    } as unknown as ShellData;

    expect(initialCloudContent(fixture)).toEqual({ tasks: [], messages: [] });
  });

  it("keeps fixture content in explicit demo mode", () => {
    const fixture = {
      config: { demoMode: true },
      tasks: [{ id: "task_cloud" }],
      messages: [{ id: "message_cloud" }],
    } as unknown as ShellData;

    expect(initialCloudContent(fixture)).toEqual({ tasks: fixture.tasks, messages: fixture.messages });
  });

  it("does not load organization administration data for ordinary members", () => {
    expect(shouldRefreshAdministration(["org:read", "departments:read", "sso:read"])).toBe(false);
    expect(shouldRefreshAdministration(["org:read", "org:admin"])).toBe(true);
  });

  it("prefers a valid browser model for new chats and otherwise uses the organization default", () => {
    const organization = { providerId: "router", model: "default-model" };
    expect(preferredNewChatModel(
      { providerId: "router", model: "browser-model" },
      organization,
      [{ id: "default-model" }, { id: "browser-model" }],
    )).toEqual({ providerId: "router", model: "browser-model", source: "user" });
    expect(preferredNewChatModel(
      { providerId: "router", model: "retired-model" },
      organization,
      [{ id: "default-model" }],
    )).toEqual({ ...organization, source: "organization" });
    expect(preferredNewChatModel(
      { providerId: "retired-provider", model: "default-model" },
      organization,
      [{ id: "default-model" }],
    )).toEqual({ providerId: "retired-provider", model: "default-model", source: "user" });
    expect(preferredNewChatModel(
      { providerId: "router", model: "browser-model" },
      organization,
      [],
    )).toEqual({ providerId: "router", model: "browser-model", source: "user" });
  });

  it("never leaks a cached new-chat model into an existing chat while its session snapshot loads", async () => {
    let finishLoading!: (selection: { providerId: string; model: string }) => void;
    const delayedSessionModel = new Promise<{ providerId: string; model: string }>((resolve) => {
      finishLoading = resolve;
    });

    expect(existingChatTurnModelOverride(null)).toEqual({});
    const hydrated = hydratedExistingChatModel(delayedSessionModel, () => null);
    finishLoading({ providerId: "session-provider", model: "session-model" });
    await expect(hydrated).resolves.toEqual({
      providerId: "session-provider",
      model: "session-model",
      source: "session",
    });
    expect(existingChatTurnModelOverride(null)).toEqual({});
  });

  it("keeps an explicit in-session model change when delayed hydration completes", async () => {
    let explicit: { providerId: string; model: string } | null = null;
    let finishLoading!: (selection: { providerId: string; model: string }) => void;
    const delayedSessionModel = new Promise<{ providerId: string; model: string }>((resolve) => {
      finishLoading = resolve;
    });
    const hydrated = hydratedExistingChatModel(delayedSessionModel, () => explicit);
    explicit = { providerId: "failover-provider", model: "selected-model" };
    finishLoading({ providerId: "original-provider", model: "original-model" });

    await expect(hydrated).resolves.toEqual({
      ...explicit,
      source: "user",
    });
    expect(existingChatTurnModelOverride(explicit)).toEqual({
      provider: { id: "failover-provider" },
      model: "selected-model",
    });
  });

  it("sends only a browser override when creating a chat", () => {
    expect(newChatModelOverride("user", "router", "browser-model")).toEqual({
      modelProviderId: "router",
      model: "browser-model",
    });
    expect(newChatModelOverride("organization", "router", "default-model")).toEqual({});
    expect(newChatModelOverride("session", "router", "previous-task-model")).toEqual({});
  });

  it("aborts and scopes interruption cancellation to a pending admission", () => {
    const controller = new AbortController();
    const pending = {
      operationId: "00000000-0000-7000-8000-000000000001",
      controller,
      cancelRequested: false,
    };

    expect(prepareTurnCancellation(pending)).toEqual({ operationId: pending.operationId });
    expect(pending.cancelRequested).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(prepareTurnCancellation(undefined)).toEqual({});
  });

  it("checks durable state after network and retryable gateway failures", () => {
    expect(shouldConfirmTurnAdmission(new TypeError("connection reset"))).toBe(true);
    expect(shouldConfirmTurnAdmission(new BerryApiError("gateway timeout", 504, null))).toBe(true);
    expect(shouldConfirmTurnAdmission(new BerryApiError("invalid request", 400, null))).toBe(false);
    expect(shouldConfirmTurnAdmission(new BerryApiError("different active turn", 409, null))).toBe(false);
  });

  it("rehydrates a genuinely active turn after an admission conflict", async () => {
    const state = {
      active: true,
      turnId: "turn_existing",
      bufferedEvents: [],
      replayOnly: false,
      runState: "calling_model",
    } as const;
    const client = { turnState: vi.fn(async () => state) };

    await expect(activeTurnStateAfterConflict(
      client as never,
      "session_1",
      new BerryApiError("active", 409, null),
    )).resolves.toEqual(state);
    expect(client.turnState).toHaveBeenCalledWith("session_1");
    await expect(activeTurnStateAfterConflict(
      client as never,
      "session_1",
      new BerryApiError("invalid", 400, null),
    )).resolves.toBeNull();
  });

  it("clears the cancelled run replay boundary before a replacement turn", () => {
    const cursors = new Map([["session_1", "turn_cancelled:42"], ["session_2", "turn_other:3"]]);
    const sequences = new Map([
      ["session_1", { turn_cancelled: 42 }],
      ["session_2", { turn_other: 3 }],
    ]);

    clearDurableEventReplayBoundary("session_1", cursors, sequences);

    expect(cursors).toEqual(new Map([["session_2", "turn_other:3"]]));
    expect(sequences).toEqual(new Map([["session_2", { turn_other: 3 }]]));
  });

  it("confirms a response-lost admission even when the run already completed", async () => {
    const request = {
      operationId: "00000000-0000-7000-8000-000000000001",
      input: "Run the task",
      workspacePath: "/workspace",
      provider: { id: "provider" },
    } satisfies StartTurnRequest;
    const client = {
      startTurn: vi.fn(async () => ({ turnId: "turn_completed", sessionId: "session_1" })),
      turnState: vi.fn(async () => ({
        active: false,
        turnId: "turn_completed",
        bufferedEvents: [],
        replayOnly: false,
        owner: null,
        runState: "completed" as const,
        waitingReason: null,
        nextAction: null,
        error: null,
      })),
    };

    await expect(retryTurnAdmission(client, "session_1", request)).resolves.toMatchObject({
      started: { turnId: "turn_completed" },
      state: { active: false, turnId: "turn_completed", runState: "completed" },
    });
    expect(client.startTurn).toHaveBeenCalledWith("session_1", request);
  });

  it("retries server session revocation and requires a successful response", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 204 });

    await expect(revokeAuthSession("https://api.example.test", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelaysMs: [0, 0, 0],
    })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenLastCalledWith("https://api.example.test/v1/auth/sign-out", {
      method: "POST",
      credentials: "include",
    });
  });

  it("hides organization administration from non-admin members", () => {
    expect(visibleAdministrationGroups(["org:read", "models:read", "skills:read"])).toEqual([]);
  });

  it("shows only permitted administration screens to organization admins", () => {
    const visible = visibleAdministrationGroups(["org:admin", "org:read", "members:read"]);
    expect(visible.flatMap((group) => group.items.map((item) => item.id))).toEqual(["overview", "people", "ai-tools"]);
  });

  it("shows AI & tools navigation to an MCP-only organization administrator", () => {
    const visible = visibleAdministrationGroups(["org:admin", "mcp:read"]);

    expect(visible.flatMap((group) => group.items.map((item) => item.id))).toEqual(["ai-tools"]);
  });

  it("redirects legacy memory navigation into personalization", () => {
    expect(parseCloudShellLocation("/settings/memory")).toEqual({ kind: "settings", tab: "personalization" });
  });

  it("keeps personal settings flat and ordered by user intent", () => {
    expect(PERSONAL_NAV.map((group) => ({
      label: group.label,
      items: group.items.map((item) => [item.id, item.label]),
    }))).toEqual([
      { label: "", items: [["general", "General"], ["account", "Account"], ["personalization", "Personalization"], ["connectors", "Connectors"], ["skills", "Skills"], ["mcp", "MCP servers"], ["usage", "Usage"], ["archived", "Archived chats"]] },
    ]);
  });

  it("shows bounded allowance progress and a human-readable reset date", () => {
    const allowance = {
      effectiveLimitMicros: "100000000",
      usedMicros: "1250000",
      reservedMicros: "250000",
    };
    expect(allowanceProgress(allowance as Parameters<typeof allowanceProgress>[0])).toBe(1.5);
    expect(formatAllowanceResetDate("2026-08-31T00:00:00.000Z")).toBe(
      new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" })
        .format(new Date("2026-08-31T00:00:00.000Z")),
    );

    expect(allowanceProgress({ ...allowance, usedMicros: "999000000" } as Parameters<typeof allowanceProgress>[0])).toBe(100);
  });

  it("shows the composer project switcher only when the transcript is empty", () => {
    expect(shouldShowComposerProjectSwitcher([])).toBe(true);
    expect(shouldShowComposerProjectSwitcher([{ role: "user" }])).toBe(false);
    expect(shouldShowComposerProjectSwitcher([{ role: "assistant" }])).toBe(false);
  });

  it("clears durable activity for manually terminated turns", () => {
    const active = reduceDurableTurnState(undefined, { kind: "turn.start", turnId: "turn_1" });
    expect(active).toMatchObject({ active: true, runState: "queued" });

    const cancelled = reduceDurableTurnState(
      active ?? undefined,
      { kind: "turn.end", turnId: "turn_1", status: "cancelled" },
    );
    expect(cancelled).toMatchObject({
      active: false,
      runState: "cancelled",
      waitingReason: null,
      nextAction: null,
    });
  });

  it("labels each durable phase without treating total elapsed time as assignment latency", () => {
    const active = (runState: "queued" | "assembling_context" | "calling_model" | "executing_tool", nextAction: string | null = null) => ({
      active: true,
      turnId: "turn_1",
      bufferedEvents: [],
      replayOnly: false,
      runState,
      nextAction,
    });
    expect(durableTurnPhase(active("queued", "Submitting the turn"))).toBe("Submitting");
    expect(durableTurnPhase(active("assembling_context"))).toBe("Preparing context");
    expect(durableTurnPhase(active("queued"))).toBe("Waiting for worker");
    expect(durableTurnPhase(active("calling_model"))).toBe("Calling model");
    expect(durableTurnPhase(active("executing_tool"))).toBe("Running tool");
  });

  it("hydrates the elapsed timer from the durable run start", () => {
    const startedAt = "2026-08-05T13:42:15.000Z";
    const stream = replayDurableStreamState({
      active: true,
      turnId: "turn_1",
      startedAt,
      bufferedEvents: [{ kind: "turn.start", turnId: "turn_1" }],
      replayOnly: false,
    });

    expect(stream.turnStartedAt).toBe(Date.parse(startedAt));
  });

  it("offers composer continuation for failed, cancelled, and recoverable turns", () => {
    expect(isInterruptedTurnAvailable("failed", undefined, [])).toBe(true);
    expect(isInterruptedTurnAvailable("cancelled", undefined, [])).toBe(true);
    expect(isInterruptedTurnAvailable(null, "recovery_required", [])).toBe(true);
  });

  it("does not revive a stale failed message after a newer turn completed", () => {
    const staleFailure = [{ role: "assistant", status: "failed" }] as unknown as ShellData["messages"];
    expect(isInterruptedTurnAvailable("completed", "completed", staleFailure)).toBe(false);
    expect(isInterruptedTurnAvailable(null, undefined, staleFailure)).toBe(true);
  });
});
