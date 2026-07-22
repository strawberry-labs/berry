import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type {
  ApprovalDecisionKind,
  RuntimeContextStatsOptions,
  SessionHost,
  StartTurnOptions,
  ToolGuardRequest,
} from "@berry/local-agent";

export const SESSION_HOST_DRIVER = Symbol("SESSION_HOST_DRIVER");

@Injectable()
export class SessionHostService implements SessionHost, OnApplicationShutdown {
  readonly #driver: SessionHost;
  #disposePromise: Promise<void> | null = null;

  constructor(@Inject(SESSION_HOST_DRIVER) driver: SessionHost) {
    this.#driver = driver;
  }

  startTurn(options: StartTurnOptions) { return this.#driver.startTurn(options); }
  resolveQuestion(questionId: string, answer: Parameters<SessionHost["resolveQuestion"]>[1]) { return this.#driver.resolveQuestion(questionId, answer); }
  resolveApproval(approvalId: string, decision: boolean | ApprovalDecisionKind) { return this.#driver.resolveApproval(approvalId, decision); }
  recordApprovalGrant(request: ToolGuardRequest, decision: ApprovalDecisionKind) { this.#driver.recordApprovalGrant(request, decision); }
  pendingApprovalIds() { return this.#driver.pendingApprovalIds(); }
  pendingApprovals() { return this.#driver.pendingApprovals?.() ?? []; }
  pendingQuestionIds() { return this.#driver.pendingQuestionIds(); }
  cancel(sessionId: string) { return this.#driver.cancel(sessionId); }
  turnState(sessionId: string) { return this.#driver.turnState(sessionId); }
  contextStats(sessionId: string, options?: RuntimeContextStatsOptions) { return this.#driver.contextStats(sessionId, options); }
  steer(sessionId: string, input: string, images?: Parameters<SessionHost["steer"]>[2], attachments?: Parameters<SessionHost["steer"]>[3]) { return this.#driver.steer(sessionId, input, images, attachments); }
  followUp(sessionId: string, input: string, images?: Parameters<SessionHost["followUp"]>[2], attachments?: Parameters<SessionHost["followUp"]>[3]) { return this.#driver.followUp(sessionId, input, images, attachments); }
  fork(sessionId: string, options?: Parameters<SessionHost["fork"]>[1]) { return this.#driver.fork(sessionId, options); }
  rewind(sessionId: string, entryId: string, options?: Parameters<SessionHost["rewind"]>[2]) { return this.#driver.rewind(sessionId, entryId, options); }
  rewindForEdit(sessionId: string, userOrdinal: number) { return this.#driver.rewindForEdit(sessionId, userOrdinal); }
  compact(sessionId: string, options?: Parameters<SessionHost["compact"]>[1]) { return this.#driver.compact(sessionId, options); }
  listLoadedSkills(sessionId?: string) { return this.#driver.listLoadedSkills(sessionId); }

  dispose(): Promise<void> {
    if (!this.#disposePromise) this.#disposePromise = this.#driver.dispose();
    return this.#disposePromise;
  }

  onApplicationShutdown(): Promise<void> {
    return this.dispose();
  }
}
