import { Inject, Injectable } from "@nestjs/common";
import { AgentStreamEventSchema, HostPushEventSchema, type AgentStreamEvent, type HostPushEvent, type Task } from "@berry/shared";
import { Observable, Subject } from "rxjs";
import { DurableTurnService, parseEventCursor } from "../runtime/durable-turn.service.js";

// Keep active text visibly live, then back off quickly while a turn is quiet
// (for example during a long tool call). Recursive scheduling also guarantees
// that one slow query cannot overlap the next database read.
export const DURABLE_EVENT_POLL_MS = 100;
export const DURABLE_EVENT_IDLE_POLL_MS = 1_000;

@Injectable()
export class ApiEventStreamService {
  readonly #subjects = new Map<string, Subject<MessageEvent<AgentStreamEvent>>>();
  readonly #taskSubjects = new Map<string, Subject<MessageEvent<HostPushEvent>>>();

  constructor(@Inject(DurableTurnService) private readonly durableTurns?: DurableTurnService) {}

  publish(sessionId: string, event: AgentStreamEvent): AgentStreamEvent {
    const parsed = AgentStreamEventSchema.parse(event);
    this.#subjects.get(sessionId)?.next({ data: parsed } as MessageEvent<AgentStreamEvent>);
    return parsed;
  }

  stream(sessionId: string, replay: AgentStreamEvent[] = []): Observable<MessageEvent<AgentStreamEvent>> {
    return new Observable((subscriber) => {
      for (const event of replay) {
        const parsed = AgentStreamEventSchema.parse(event);
        subscriber.next({ data: parsed } as MessageEvent<AgentStreamEvent>);
      }
      const subject = this.#subject(sessionId);
      const subscription = subject.subscribe(subscriber);
      return () => {
        subscription.unsubscribe();
        if (subject.observed === false) this.#subjects.delete(sessionId);
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
    const event = HostPushEventSchema.parse({ type: "task.updated", task });
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
}
