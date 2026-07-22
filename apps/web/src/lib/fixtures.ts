import type { ConversationKind, Message, Task } from "@berry/shared";

export const FIXED_NOW = "2026-07-10T00:00:00.000Z";

export function fixtureTasks(): Task[] {
  return [
    task("task_cloud", "Cloud sandbox smoke", "running", "session_cloud", "code"),
    task("task_launch", "Launch plan review", "completed", "session_launch", "chat"),
    task("task_chat", "Quick model question", "completed", "session_chat", "chat"),
  ];
}

export function fixtureMessages(sessionId: string): Message[] {
  const assistant = message(
    "msg_assistant_1",
    sessionId,
    "assistant",
    "I created the cloud task shell and kept execution behind the sandbox contract. The browser client is ready to connect to the Phase 8 API when `BERRY_WEB_API_BASE_URL` is supplied.",
  );
  assistant.parts = [
    {
      id: "msg_assistant_1_reasoning",
      messageId: assistant.id,
      kind: "reasoning",
      content: "I checked the sandbox contract and the web execution boundary before returning the result.",
      position: 0,
      createdAt: FIXED_NOW,
    },
    {
      id: "msg_assistant_1_tool_call",
      messageId: assistant.id,
      kind: "tool-call",
      content: { toolCallId: "tool_fixture", name: "sandbox.exec", title: "Ran sandbox task", status: "completed", durationMs: 820 },
      position: 1,
      createdAt: FIXED_NOW,
    },
    {
      id: "msg_assistant_1_tool_result",
      messageId: assistant.id,
      kind: "tool-result",
      content: { toolCallId: "tool_fixture", name: "sandbox.exec", status: "completed", summary: "Sandbox ready" },
      position: 2,
      createdAt: FIXED_NOW,
    },
    { ...assistant.parts[0]!, position: 3 },
  ];
  assistant.generationMs = 2_740;
  return [
    message("msg_user_1", sessionId, "user", "Run a sandboxed task and summarize the result."),
    assistant,
  ];
}

function task(id: string, title: string, status: Task["status"], activeSessionId: string, conversationKind: ConversationKind): Task {
  return {
    id,
    workspaceId: "self-host",
    title,
    status,
    activeSessionId,
    conversationKind,
    pinned: id === "task_cloud",
    archived: false,
    deletedAt: null,
    unreadAt: null,
    lastReadAt: null,
    worktreePath: null,
    worktreeBranch: null,
    worktreeBaseRef: null,
    worktreeBaseSha: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

export function message(id: string, sessionId: string, role: Message["role"], text: string): Message {
  return {
    id,
    sessionId,
    role,
    status: "complete",
    parts: [
      {
        id: `${id}_part`,
        messageId: id,
        kind: "text",
        content: text,
        position: 0,
        createdAt: FIXED_NOW,
      },
    ],
    inputTokens: 0,
    outputTokens: 0,
    generationMs: 0,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}
