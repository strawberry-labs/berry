import type { ApprovalRequest, Message, Task } from "@berry/shared";

const now = "2026-07-11T00:00:00.000Z";

export const fixtureTasks: Task[] = [
  {
    id: "task_mobile_1",
    workspaceId: "workspace_mobile",
    title: "Publish release checklist",
    status: "waiting-for-approval",
    activeSessionId: "session_mobile_1",
    conversationKind: "code",
    pinned: true,
    archived: false,
    deletedAt: null,
    unreadAt: now,
    lastReadAt: null,
    worktreePath: null,
    worktreeBranch: "release/mobile",
    worktreeBaseRef: "main",
    worktreeBaseSha: "abc123",
    pullRequestUrl: null,
    pullRequestNumber: null,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "task_mobile_2",
    workspaceId: "workspace_mobile",
    title: "Research routing options",
    status: "running",
    activeSessionId: "session_mobile_2",
    conversationKind: "chat",
    pinned: false,
    archived: false,
    deletedAt: null,
    unreadAt: null,
    lastReadAt: now,
    worktreePath: null,
    worktreeBranch: null,
    worktreeBaseRef: null,
    worktreeBaseSha: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    createdAt: now,
    updatedAt: now,
  },
];

export const fixtureMessages: Message[] = [
  {
    id: "msg_mobile_1",
    sessionId: "session_mobile_1",
    role: "assistant",
    status: "complete",
    parts: [{ id: "part_1", messageId: "msg_mobile_1", kind: "text", content: "I need approval before publishing.", position: 0, createdAt: now }],
    inputTokens: 120,
    outputTokens: 32,
    generationMs: 850,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "msg_mobile_2",
    sessionId: "session_mobile_1",
    role: "tool",
    status: "complete",
    parts: [{ id: "part_2", messageId: "msg_mobile_2", kind: "tool-call", content: { name: "shell", command: "npm publish" }, position: 0, createdAt: now }],
    inputTokens: 0,
    outputTokens: 0,
    generationMs: 0,
    createdAt: now,
    updatedAt: now,
  },
];

export const fixtureApprovals: ApprovalRequest[] = [
  {
    id: "approval_mobile_1",
    taskId: "task_mobile_1",
    toolCallId: "tool_mobile_1",
    kind: "shell",
    status: "pending",
    request: { title: "Run npm publish", detail: "Publishing package from release/mobile" },
    createdAt: now,
    decidedAt: null,
  },
];
