import { Injectable } from "@nestjs/common";
import { AgentStreamEventSchema, HostPushEventSchema, type AgentStreamEvent, type HostPushEvent, type Task } from "@berry/shared";
import { Observable, Subject } from "rxjs";

@Injectable()
export class ApiEventStreamService {
  readonly #subjects = new Map<string, Subject<MessageEvent<AgentStreamEvent>>>();
  readonly #taskSubjects = new Map<string, Subject<MessageEvent<HostPushEvent>>>();

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
