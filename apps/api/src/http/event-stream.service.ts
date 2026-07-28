import { Inject, Injectable } from "@nestjs/common";
import { AgentStreamEventSchema, HostPushEventSchema, type AgentStreamEvent, type HostPushEvent, type Task } from "@berry/shared";
import { Observable, Subject } from "rxjs";
import { DurableTurnService } from "../runtime/durable-turn.service.js";

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
    let initial = await durableTurns.eventsAfter(tenantId, sessionId, cursor);
    return new Observable((subscriber) => {
      let closed = false;
      let polling = false;
      let lastCursor = cursor ?? null;
      const seen = new Set<string>();
      const emit = (envelope: typeof initial[number]) => {
        if (seen.has(envelope.id)) return;
        seen.add(envelope.id);
        lastCursor = envelope.id;
        subscriber.next({
          id: envelope.id,
          data: envelope.event,
        } as unknown as MessageEvent<AgentStreamEvent>);
      };
      for (const envelope of initial) emit(envelope);
      initial = [];
      const poll = async () => {
        if (closed || polling) return;
        polling = true;
        try {
          const events = await durableTurns.eventsAfter(tenantId, sessionId, lastCursor);
          for (const envelope of events) emit(envelope);
        } catch (error) {
          if (!closed) subscriber.error(error);
        } finally {
          polling = false;
        }
      };
      const timer = setInterval(() => void poll(), 500);
      timer.unref?.();
      return () => {
        closed = true;
        clearInterval(timer);
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
