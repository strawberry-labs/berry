import { Inject, Injectable } from "@nestjs/common";
import { AgentStreamEventSchema, HostPushEventSchema, normalizeTaskForWeb, type AgentStreamEvent, type HostPushEvent, type Task } from "@berry/shared";
import { Observable, Subject } from "rxjs";
import { createHash } from "node:crypto";
import { DurableTurnService, parseEventCursor } from "../runtime/durable-turn.service.js";

// Keep active text visibly live, then back off quickly while a turn is quiet
// (for example during a long tool call). Recursive scheduling also guarantees
// that one slow query cannot overlap the next database read.
export const DURABLE_EVENT_POLL_MS = 100;
export const DURABLE_EVENT_IDLE_POLL_MS = 1_000;
export const LEGACY_EVENT_SESSION_CAP = 256;
export const LEGACY_EVENT_TTL_MS = 15 * 60 * 1_000;
/** Global replay identity budget, including sessions with live subscribers. */
export const LEGACY_EVENT_GLOBAL_ENTRY_CAP = 32_768;

@Injectable()
export class ApiEventStreamService {
  readonly #subjects = new Map<string, Subject<MessageEvent<AgentStreamEvent>>>();
  readonly #taskSubjects = new Map<string, Subject<MessageEvent<HostPushEvent>>>();
  // Replay state keeps only fixed-size identity metadata. The full event is
  // delivered live or supplied by the host replay buffer; retaining image
  // base64/tool payloads here would make a small event-count cap meaningless.
  readonly #legacyEvents = new Map<string, Array<{ sequence: number; fingerprint: string; runKey?: string }>>();
  readonly #legacyNextSequence = new Map<string, number>();
  readonly #legacyCurrentRuns = new Map<string, string>();
  readonly #legacyLastActivity = new Map<string, number>();

  constructor(@Inject(DurableTurnService) private readonly durableTurns?: DurableTurnService) {}

  publish(sessionId: string, event: AgentStreamEvent): AgentStreamEvent {
    const parsed = AgentStreamEventSchema.parse(event);
    this.#cleanupLegacyState();
    if (parsed.kind === "turn.start") this.#legacyCurrentRuns.set(sessionId, parsed.turnId);
    const entry = this.#appendLegacyEvent(sessionId, parsed, this.#legacyCurrentRuns.get(sessionId));
    if (parsed.kind === "turn.end") this.#legacyCurrentRuns.delete(sessionId);
    this.#subjects.get(sessionId)?.next({ id: `legacy:${entry.sequence}`, data: parsed } as unknown as MessageEvent<AgentStreamEvent>);
    return parsed;
  }

  stream(sessionId: string, replay: AgentStreamEvent[] = [], lastEventId?: string | null, replayRunKey?: string | null): Observable<MessageEvent<AgentStreamEvent>> {
    return new Observable((subscriber) => {
      this.#cleanupLegacyState();
      const subject = this.#subject(sessionId);
      const afterSequence = parseLegacyEventId(lastEventId);
      if (afterSequence !== null && !this.#legacyNextSequence.has(sessionId)) {
        // The replay window is intentionally expirable, but a reconnect after
        // expiry must not receive a new id lower than Last-Event-ID.
        this.#legacyNextSequence.set(sessionId, afterSequence);
      }
      const subscription = subject.subscribe(subscriber);
      this.#legacyLastActivity.set(sessionId, Date.now());
      const replaySequences = new Set<number>();
      let previousReplaySequence = 0;
      for (const event of replay) {
        const parsed = AgentStreamEventSchema.parse(event);
        const entry = this.#ensureLegacyReplayEvent(sessionId, parsed, replaySequences, previousReplaySequence, replayRunKey ?? this.#legacyCurrentRuns.get(sessionId), afterSequence);
        replaySequences.add(entry.sequence);
        previousReplaySequence = entry.sequence;
        if (afterSequence !== null && entry.sequence <= afterSequence) continue;
        subscriber.next({ id: `legacy:${entry.sequence}`, data: parsed } as unknown as MessageEvent<AgentStreamEvent>);
      }
      return () => {
        subscription.unsubscribe();
        if (subject.observed === false) this.#subjects.delete(sessionId);
        this.#cleanupLegacyState();
      };
    });
  }

  async streamDurable(
    tenantId: string,
    sessionId: string,
    cursor?: string | null,
  ): Promise<Observable<MessageEvent<AgentStreamEvent>>> {
    if (!this.durableTurns) throw new Error("Durable event storage is not configured");
    const durableTurns = this.durableTurns;
    // A no-cursor connection is opened before POST /turns so it cannot use an
    // old terminal event as its replay boundary. Keep polling from the
    // connection timestamp until the newly admitted run emits its first event.
    const normalizedCursor = parseEventCursor(cursor) ? cursor : null;
    const connectedAt = normalizedCursor ? undefined : new Date();
    let initial = await durableTurns.eventsAfter(tenantId, sessionId, normalizedCursor, 500, connectedAt);
    return new Observable((subscriber) => {
      let closed = false;
      let lastCursor = normalizedCursor;
      let pollDelay = DURABLE_EVENT_POLL_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const seen = new Set<string>();
      const seenOrder: string[] = [];
      const emit = (envelope: typeof initial[number]) => {
        if (seen.has(envelope.id)) return;
        seen.add(envelope.id);
        seenOrder.push(envelope.id);
        if (seenOrder.length > 2_048) {
          seen.delete(seenOrder.shift()!);
        }
        lastCursor = envelope.id;
        subscriber.next({
          id: envelope.id,
          data: envelope.event,
        } as unknown as MessageEvent<AgentStreamEvent>);
      };
      for (const envelope of initial) emit(envelope);
      initial = [];
      const poll = async () => {
        if (closed) return;
        try {
          const events = await durableTurns.eventsAfter(
            tenantId,
            sessionId,
            lastCursor,
            500,
            lastCursor ? undefined : connectedAt,
          );
          for (const envelope of events) emit(envelope);
          pollDelay = events.length > 0
            ? DURABLE_EVENT_POLL_MS
            : Math.min(DURABLE_EVENT_IDLE_POLL_MS, pollDelay * 2);
        } catch (error) {
          if (!closed) {
            closed = true;
            subscriber.error(error);
          }
        } finally {
          if (!closed) schedule();
        }
      };
      const schedule = () => {
        timer = setTimeout(() => void poll(), pollDelay);
        timer.unref?.();
      };
      schedule();
      return () => {
        closed = true;
        if (timer) clearTimeout(timer);
      };
    });
  }

  publishTask(task: Task): HostPushEvent {
    const event = HostPushEventSchema.parse({ type: "task.updated", task: normalizeTaskForWeb(task) });
    this.#taskSubjects.get(task.id)?.next({ data: event } as MessageEvent<HostPushEvent>);
    return event;
  }

  taskStream(taskId: string): Observable<MessageEvent<HostPushEvent>> {
    return new Observable((subscriber) => {
      let subject = this.#taskSubjects.get(taskId);
      if (!subject) {
        subject = new Subject<MessageEvent<HostPushEvent>>();
        this.#taskSubjects.set(taskId, subject);
      }
      const subscription = subject.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        if (subject?.observed === false) this.#taskSubjects.delete(taskId);
      };
    });
  }

  #subject(sessionId: string): Subject<MessageEvent<AgentStreamEvent>> {
    let subject = this.#subjects.get(sessionId);
    if (!subject) {
      subject = new Subject<MessageEvent<AgentStreamEvent>>();
      this.#subjects.set(sessionId, subject);
    }
    return subject;
  }

  #appendLegacyEvent(sessionId: string, event: AgentStreamEvent, runKey?: string) {
    const sequence = (this.#legacyNextSequence.get(sessionId) ?? 0) + 1;
    this.#legacyNextSequence.set(sessionId, sequence);
    const entries = this.#legacyEvents.get(sessionId) ?? [];
    const entry = { sequence, fingerprint: legacyEventFingerprint(event), ...(runKey ? { runKey } : {}) };
    entries.push(entry);
    if (entries.length > 2_048) entries.splice(0, entries.length - 2_048);
    this.#legacyEvents.set(sessionId, entries);
    this.#legacyLastActivity.set(sessionId, Date.now());
    return entry;
  }

  #cleanupLegacyState(now = Date.now()) {
    // A legacy turn can terminate without publishing turn.end (for example if
    // the host process crashes). Do not let that orphaned run pin its replay
    // buffer outside the normal TTL/session cap cleanup forever. Active live
    // streams still receive events through their Subject; only the replay
    // identity is expired after a long period without activity.
    for (const [sessionId] of this.#legacyCurrentRuns) {
      const lastActivity = this.#legacyLastActivity.get(sessionId);
      if (lastActivity !== undefined && now - lastActivity >= LEGACY_EVENT_TTL_MS) {
        this.#legacyCurrentRuns.delete(sessionId);
      }
    }
    const remove = (sessionId: string) => {
      if (this.#subjects.has(sessionId) || this.#legacyCurrentRuns.has(sessionId)) return false;
      this.#legacyEvents.delete(sessionId);
      this.#legacyNextSequence.delete(sessionId);
      this.#legacyLastActivity.delete(sessionId);
      return true;
    };
    for (const [sessionId, lastActivity] of this.#legacyLastActivity) {
      if (now - lastActivity >= LEGACY_EVENT_TTL_MS) remove(sessionId);
    }
    const stateSessions = () => new Set([
      ...this.#legacyEvents.keys(),
      ...this.#legacyNextSequence.keys(),
      ...this.#legacyLastActivity.keys(),
    ]);
    if (stateSessions().size > LEGACY_EVENT_SESSION_CAP) {
      const oldest = [...stateSessions()]
        .sort((left, right) => (this.#legacyLastActivity.get(left) ?? 0) - (this.#legacyLastActivity.get(right) ?? 0));
      for (const sessionId of oldest) {
        if (stateSessions().size <= LEGACY_EVENT_SESSION_CAP) break;
        remove(sessionId);
      }
    }

    // A live Subject is intentionally not torn down by replay cleanup, but it
    // must not exempt that session's fingerprints from the global memory
    // budget. Trim the oldest replay identities while preserving each
    // session's monotonic next sequence for connected clients.
    let replayEntries = [...this.#legacyEvents.values()].reduce((total, entries) => total + entries.length, 0);
    if (replayEntries <= LEGACY_EVENT_GLOBAL_ENTRY_CAP) return;
    const replaySessions = [...this.#legacyEvents.keys()]
      .sort((left, right) => (this.#legacyLastActivity.get(left) ?? 0) - (this.#legacyLastActivity.get(right) ?? 0));
    for (const sessionId of replaySessions) {
      const entries = this.#legacyEvents.get(sessionId);
      if (!entries) continue;
      const removeCount = Math.min(entries.length, replayEntries - LEGACY_EVENT_GLOBAL_ENTRY_CAP);
      entries.splice(0, removeCount);
      replayEntries -= removeCount;
      if (entries.length === 0) this.#legacyEvents.delete(sessionId);
      if (replayEntries <= LEGACY_EVENT_GLOBAL_ENTRY_CAP) break;
    }
  }

  #ensureLegacyReplayEvent(
    sessionId: string,
    event: AgentStreamEvent,
    usedSequences: ReadonlySet<number>,
    previousReplaySequence: number,
    replayRunKey?: string,
    afterSequence?: number | null,
  ) {
    const fingerprint = legacyEventFingerprint(event);
    const entries = this.#legacyEvents.get(sessionId) ?? [];
    const candidates = entries.filter((candidate) => (
      candidate.fingerprint === fingerprint
      && candidate.sequence > previousReplaySequence
      && !usedSequences.has(candidate.sequence)
      && (!replayRunKey || candidate.runKey === replayRunKey)
    ));
    // A reconnect may receive only a suffix of a run's replay buffer. When
    // identical events exist, prefer the first matching sequence after the
    // client's cursor; full-buffer replays still fall back to their original
    // earlier entries and remain suppressed by the cursor check below.
    const entry = (afterSequence === null || afterSequence === undefined
      ? undefined
      : candidates.find((candidate) => candidate.sequence > afterSequence)) ?? candidates[0];
    if (entry) return entry;
    return this.#appendLegacyEvent(sessionId, event, replayRunKey);
  }
}

function legacyEventFingerprint(event: AgentStreamEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function parseLegacyEventId(value: string | null | undefined): number | null {
  const match = /^legacy:(\d+)$/.exec(value ?? "");
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}
