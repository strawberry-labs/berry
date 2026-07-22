import type { ApprovalRequest, Message, Task } from "@berry/shared";

export type ExtensionConnectionKind = "local" | "platform";

export interface ExtensionConnectionConfig {
  kind: ExtensionConnectionKind;
  platformBaseUrl: string;
  platformToken: string;
  workspaceId: string;
}

export interface CapturedPageContext {
  url: string;
  title: string;
  selection: string;
  text: string;
  capturedAt: string;
}

export interface BerryExtensionClient {
  readonly label: string;
  listTasks(): Promise<Task[]>;
  createTask(title: string): Promise<{ task: Task; sessionId: string }>;
  listMessages(sessionId: string): Promise<Message[]>;
  sendMessage(input: { task: Task; sessionId: string; text: string; page?: CapturedPageContext | null }): Promise<void>;
  listApprovals(): Promise<ApprovalRequest[]>;
  decideApproval(approvalId: string, decision: "approved_once" | "denied"): Promise<void>;
}

