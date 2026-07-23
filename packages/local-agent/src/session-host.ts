import type { AgentStreamEvent, ApprovalKind } from "@berry/shared";
import type { ImageContent } from "@earendil-works/pi-ai";

import type { ApprovalDecisionKind, ToolGuardRequest } from "./guard.ts";
import {
  BerryAgentRuntime,
  type BerryAgentRuntimeOptions,
  type RuntimeAttachment,
  type RuntimeContextStats,
  type RuntimeContextStatsOptions,
  type StartTurnOptions,
} from "./runtime.ts";
import type { AgentSkill } from "./skills.ts";
import type { AskUserQuestionAnswer } from "./tools.ts";

export interface SessionHost {
  startTurn(options: StartTurnOptions): { turnId: string };
  resolveQuestion(questionId: string, answer: AskUserQuestionAnswer): boolean;
  resolveApproval(approvalId: string, decision: boolean | ApprovalDecisionKind): boolean;
  recordApprovalGrant(request: ToolGuardRequest, decision: ApprovalDecisionKind): void;
  pendingApprovalIds(): string[];
  pendingApprovals?(): Array<{ id: string; sessionId: string; kind: ApprovalKind; title: string; detail: string }>;
  pendingQuestionIds(): string[];
  cancel(sessionId: string): Promise<boolean>;
  turnState(sessionId: string): { active: boolean; turnId: string | null; bufferedEvents: AgentStreamEvent[] };
  contextStats(sessionId: string, options?: RuntimeContextStatsOptions): Promise<RuntimeContextStats>;
  steer(sessionId: string, input: string, images?: ImageContent[], attachments?: RuntimeAttachment[]): Promise<{ queued: true }>;
  followUp(sessionId: string, input: string, images?: ImageContent[], attachments?: RuntimeAttachment[]): Promise<{ queued: true }>;
  fork(sessionId: string, options?: { entryId?: string; newSessionId?: string; onEvent?: (event: AgentStreamEvent) => void }): Promise<{ sessionId: string }>;
  rewind(sessionId: string, entryId: string, options?: { onEvent?: (event: AgentStreamEvent) => void }): Promise<void>;
  rewindForEdit(sessionId: string, userOrdinal: number): Promise<void>;
  compact(sessionId: string, options?: { customInstructions?: string; onEvent?: (event: AgentStreamEvent) => void; sessionOptions?: Omit<StartTurnOptions, "sessionId" | "input" | "onEvent"> }): Promise<{ summary: string; tokensBefore: number }>;
  listLoadedSkills(sessionId?: string): AgentSkill[];
  dispose(): Promise<void>;
}

export class RuntimeSessionHost implements SessionHost {
  readonly #runtime: BerryAgentRuntime;

  constructor(runtime: BerryAgentRuntime) {
    this.#runtime = runtime;
  }

  static create(options: BerryAgentRuntimeOptions): RuntimeSessionHost {
    return new RuntimeSessionHost(new BerryAgentRuntime(options));
  }

  startTurn(options: StartTurnOptions) { return this.#runtime.startTurn(options); }
  resolveQuestion(questionId: string, answer: AskUserQuestionAnswer) { return this.#runtime.resolveQuestion(questionId, answer); }
  resolveApproval(approvalId: string, decision: boolean | ApprovalDecisionKind) { return this.#runtime.resolveApproval(approvalId, decision); }
  recordApprovalGrant(request: ToolGuardRequest, decision: ApprovalDecisionKind) { this.#runtime.recordApprovalGrant(request, decision); }
  pendingApprovalIds() { return this.#runtime.pendingApprovalIds(); }
  pendingApprovals() { return this.#runtime.pendingApprovals(); }
  pendingQuestionIds() { return this.#runtime.pendingQuestionIds(); }
  cancel(sessionId: string) { return this.#runtime.cancel(sessionId); }
  turnState(sessionId: string) { return this.#runtime.turnState(sessionId); }
  contextStats(sessionId: string, options?: RuntimeContextStatsOptions) { return this.#runtime.contextStats(sessionId, options); }
  steer(sessionId: string, input: string, images?: ImageContent[], attachments?: RuntimeAttachment[]) { return this.#runtime.steer(sessionId, input, images, attachments); }
  followUp(sessionId: string, input: string, images?: ImageContent[], attachments?: RuntimeAttachment[]) { return this.#runtime.followUp(sessionId, input, images, attachments); }
  fork(sessionId: string, options?: { entryId?: string; newSessionId?: string; onEvent?: (event: AgentStreamEvent) => void }) { return this.#runtime.fork(sessionId, options); }
  rewind(sessionId: string, entryId: string, options?: { onEvent?: (event: AgentStreamEvent) => void }) { return this.#runtime.rewind(sessionId, entryId, options); }
  rewindForEdit(sessionId: string, userOrdinal: number) { return this.#runtime.rewindForEdit(sessionId, userOrdinal); }
  compact(sessionId: string, options?: { customInstructions?: string; onEvent?: (event: AgentStreamEvent) => void; sessionOptions?: Omit<StartTurnOptions, "sessionId" | "input" | "onEvent"> }) { return this.#runtime.compact(sessionId, options); }
  listLoadedSkills(sessionId?: string) { return this.#runtime.listLoadedSkills(sessionId); }
  dispose() { return this.#runtime.dispose(); }
}
