import type { Page } from "@playwright/test";

/** Seeds the dev host mock so screens render deterministic content. */
export async function seedWorkspace(
  page: Page,
  mutate?: (state: {
    workspaces: unknown[];
    tasks: Record<string, unknown[]>;
    messages: Record<string, unknown[]>;
    sessionTargets: Record<string, unknown>;
    taskGroups: Record<string, unknown[]>;
    settings: Record<string, unknown>;
    providers: unknown[];
    terminals: unknown[];
    terminalEvents: Record<string, unknown[]>;
    browsers: unknown[];
    mcpServers: unknown[];
    skills: unknown[];
    commands: unknown[];
    logs: unknown[];
    usage: unknown[];
    gitChangedFiles: unknown[];
    gitCheckpoints: unknown[];
  }) => void,
): Promise<void> {
  const now = "2026-07-01T12:00:00.000Z";
  const state = {
    workspaces: [
      {
        id: "dev_ws_1",
        path: "/Users/dev/berry-chat",
        name: "berry-chat",
        workspaceKind: "project",
        ownerUserId: null,
        trustState: "trusted",
        lastOpenedAt: now,
        indexedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "dev_ws_2",
        path: "/Users/dev/sandbox",
        name: "sandbox",
        workspaceKind: "project",
        ownerUserId: null,
        trustState: "trusted",
        lastOpenedAt: now,
        indexedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    tasks: {
      dev_ws_1: [
        {
          id: "dev_task_1",
          workspaceId: "dev_ws_1",
          title: "Fonts utilized in recreation",
          status: "complete",
          activeSessionId: "dev_session_1",
          conversationKind: "chat",
          pinned: false,
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_task_pinned",
          workspaceId: "dev_ws_1",
          title: "Polish sidebar density",
          status: "complete",
          activeSessionId: "dev_session_pinned",
          conversationKind: "chat",
          pinned: true,
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
      ],
      dev_ws_2: [],
    },
    sessionTargets: {},
    taskGroups: {},
    messages: {
      dev_session_1: [
        {
          id: "dev_msg_user",
          sessionId: "dev_session_1",
          role: "user",
          status: "complete",
          parts: [
            {
              id: "p1",
              messageId: "dev_msg_user",
              kind: "text",
              content: "Which fonts does the recreation use?",
              position: 0,
              createdAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "dev_msg_assistant",
          sessionId: "dev_session_1",
          role: "assistant",
          status: "complete",
          parts: [
            {
              id: "p2",
              messageId: "dev_msg_assistant",
              kind: "text",
              content:
                "The recreation uses three families:\n\n| Font | Role |\n| --- | --- |\n| Source Serif 4 | AI messages and the logo |\n| Open Sans | UI chrome |\n| JetBrains Mono | Code and terminal |\n\nSo `font-ai-message` does double duty: it is both the conversational face and the logo face.",
              position: 0,
              createdAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    settings: { "permission.mode": "ask" },
    providers: [
      {
        id: "dev_provider_1",
        kind: "berry-router",
        name: "Berry Router",
        apiType: "openai-chat-completions",
        baseUrl: "https://router.berry.me/v1/",
        endpointPath: "/chat/completions",
        modelsPath: "/models",
        defaultModel: "berry/router-auto",
        credentialRef: "berry-router",
        authType: "bearer",
        enabled: true,
        models: [],
        capabilities: {},
        headers: {},
        source: "preset",
        createdAt: now,
        updatedAt: now,
      },
    ],
    terminals: [],
    terminalEvents: {},
    browsers: [],
    mcpServers: [],
    skills: [
      {
        id: "dev_skill_1",
        workspaceId: null,
        name: "frontend-design",
        description: "Distinctive production-grade UI work",
        sourcePath: "~/.berry/skills/frontend-design",
        trusted: true,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    commands: [],
    logs: [],
    usage: [],
    gitChangedFiles: [
      { path: "apps/desktop/src/components/composer.tsx", indexStatus: "M", worktreeStatus: " ", staged: true, unstaged: false, untracked: false },
      { path: "apps/desktop/src/components/thread.tsx", indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, untracked: false },
      { path: "apps/desktop/src/components/work-pane.tsx", indexStatus: "?", worktreeStatus: "?", staged: false, unstaged: false, untracked: true },
    ],
    gitCheckpoints: [],
  };
  mutate?.(state);
  await page.addInitScript(
    ([key, value]) => {
      if (localStorage.getItem(key!) === null) localStorage.setItem(key!, value!);
      localStorage.setItem("berry.activeWorkspace", "dev_ws_1");
    },
    ["berry.dev.host", JSON.stringify(state)],
  );
}
