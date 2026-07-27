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
  if (sessionId === "session_launch") return writingBlockFixtureMessages(sessionId);
  if (sessionId === "session_chat") return imageGenerationFixtureMessages(sessionId);
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

function writingBlockFixtureMessages(sessionId: string): Message[] {
  const assistant = message("msg_assistant_draft", sessionId, "assistant", "");
  const draft = {
    id: "launch-update-email",
    kind: "email" as const,
    summaryTitle: "Project update",
    variants: [
      {
        label: "Professional",
        subject: "Project update",
        body: [
          "Hi team,",
          "",
          "**Current status**",
          "",
          "The project remains **on track for Friday**.",
          "",
          "**Recent accomplishments**",
          "",
          "- Infrastructure review completed",
          "- Final rollout checklist started",
          "",
          "**Decision needed**",
          "",
          "Please confirm the production access approver by Wednesday so we can keep the timeline intact.",
          "",
          "Best,",
          "Chirag",
        ].join("\n"),
        active: true,
      },
      {
        label: "Warm",
        subject: "A quick launch update",
        body: [
          "Hi team,",
          "",
          "A quick update: the infrastructure review is complete, and we’re down to the final rollout checklist.",
          "",
          "We’re still on track for Friday. Could you help confirm the production access approver by Wednesday?",
          "",
          "Thanks,",
          "Chirag",
        ].join("\n"),
      },
      {
        label: "Executive",
        subject: "Launch status: on track",
        body: [
          "Team,",
          "",
          "Status: On track for Friday.",
          "",
          "Complete: Infrastructure review.",
          "In progress: Final rollout checklist.",
          "Decision needed: Confirm the production access approver by Wednesday.",
          "",
          "Chirag",
        ].join("\n"),
      },
    ],
  };
  const revisedDraft = {
    ...draft,
    summaryTitle: "Shorter project update",
    variants: [
      {
        label: "Professional",
        subject: "Project update — condensed",
        body: [
          "Hi team,",
          "",
          "**Status:** On track for Friday.",
          "",
          "- Infrastructure review: complete",
          "- Rollout checklist: in progress",
          "- Needed by Wednesday: production access approver",
          "",
          "Best,",
          "Chirag",
        ].join("\n"),
        active: true,
      },
      {
        label: "Warm",
        subject: "Quick launch update",
        body: "Hi team,\n\nWe’re **on track for Friday**. Please confirm the production access approver by Wednesday.\n\nThanks,\nChirag",
      },
      {
        label: "Executive",
        subject: "Launch status: on track",
        body: "**On track for Friday.**\n\nDecision needed by Wednesday: confirm the production access approver.",
      },
    ],
  };
  const revisedAssistant = message("msg_assistant_draft_revision", sessionId, "assistant", "");
  assistant.parts = [
    {
      id: "msg_assistant_draft_call",
      messageId: assistant.id,
      kind: "tool-call",
      content: { toolCallId: "compose_launch_update", name: "compose_message", arguments: draft },
      position: 0,
      createdAt: FIXED_NOW,
    },
    {
      id: "msg_assistant_draft_result",
      messageId: assistant.id,
      kind: "tool-result",
      content: {
        toolCallId: "compose_launch_update",
        name: "compose_message",
        status: "completed",
        output: { text: "Prepared 3 email drafts in an editable writing block.", draft },
      },
      position: 1,
      createdAt: FIXED_NOW,
    },
  ];
  revisedAssistant.parts = [
    {
      id: "msg_assistant_draft_revision_call",
      messageId: revisedAssistant.id,
      kind: "tool-call",
      content: { toolCallId: "compose_launch_update_revision", name: "compose_message", arguments: revisedDraft },
      position: 0,
      createdAt: FIXED_NOW,
    },
    {
      id: "msg_assistant_draft_revision_result",
      messageId: revisedAssistant.id,
      kind: "tool-result",
      content: {
        toolCallId: "compose_launch_update_revision",
        name: "compose_message",
        status: "completed",
        output: { text: "Prepared a shorter revision in a new writing block.", draft: revisedDraft },
      },
      position: 1,
      createdAt: FIXED_NOW,
    },
  ];
  return [
    message("msg_user_draft", sessionId, "user", "Draft a project update email with professional, warm, and executive options."),
    assistant,
    message("msg_user_draft_revision", sessionId, "user", "Make it shorter and easier to scan."),
    revisedAssistant,
  ];
}

function imageGenerationFixtureMessages(sessionId: string): Message[] {
  const assistant = message("msg_assistant_images", sessionId, "assistant", "");
  const images = [
    {
      title: "Berry orchard at dusk",
      prompt: "A cinematic berry orchard at blue hour with glowing rows of fruit and distant mountains.",
      aspectRatio: "16:9" as const,
      width: 1536,
      height: 864,
      src: fixtureImageSvg("1536", "864", "#251044", "#ff4f91", "BERRY ORCHARD", "BLUE HOUR"),
    },
    {
      title: "Berry greenhouse study",
      prompt: "An editorial greenhouse study with saturated berry leaves, soft daylight, and glass reflections.",
      aspectRatio: "4:3" as const,
      width: 1280,
      height: 960,
      src: fixtureImageSvg("1280", "960", "#0f382e", "#e9ff78", "GREENHOUSE", "DAYLIGHT STUDY"),
    },
  ];
  assistant.parts = images.map((image, index) => ({
    id: `msg_assistant_images_${index + 1}`,
    messageId: assistant.id,
    kind: "image" as const,
    content: {
      ...image,
      mimeType: "image/png" as const,
      sizeBytes: 0,
      transparentBackground: false,
      generationId: `demo_generation_${index + 1}`,
      parentGenerationId: null,
    },
    position: index,
    createdAt: FIXED_NOW,
  }));
  return [
    message("msg_user_images", sessionId, "user", "Create image\nA cinematic berry orchard at dusk, with two distinct compositions."),
    assistant,
  ];
}

function fixtureImageSvg(
  width: string,
  height: string,
  background: string,
  accent: string,
  title: string,
  subtitle: string,
): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <radialGradient id="glow" cx="70%" cy="20%" r="75%">
        <stop offset="0" stop-color="${accent}" stop-opacity=".9"/>
        <stop offset=".48" stop-color="${background}" stop-opacity=".32"/>
        <stop offset="1" stop-color="${background}"/>
      </radialGradient>
      <filter id="blur"><feGaussianBlur stdDeviation="42"/></filter>
    </defs>
    <rect width="100%" height="100%" fill="url(#glow)"/>
    <circle cx="76%" cy="18%" r="19%" fill="${accent}" opacity=".42" filter="url(#blur)"/>
    <path d="M0 ${Number(height) * 0.72} Q ${Number(width) * 0.22} ${Number(height) * 0.5}, ${Number(width) * 0.5} ${Number(height) * 0.7} T ${width} ${Number(height) * 0.6} V ${height} H0Z" fill="#050508" opacity=".72"/>
    <g fill="none" stroke="${accent}" stroke-width="10" opacity=".72">
      <path d="M0 ${Number(height) * 0.9} L ${Number(width) * 0.42} ${Number(height) * 0.58}"/>
      <path d="M${width} ${Number(height) * 0.94} L ${Number(width) * 0.58} ${Number(height) * 0.57}"/>
    </g>
    <text x="7%" y="78%" fill="white" font-family="ui-sans-serif, system-ui" font-size="${Number(height) * 0.075}" font-weight="700" letter-spacing="8">${title}</text>
    <text x="7%" y="86%" fill="white" fill-opacity=".7" font-family="ui-sans-serif, system-ui" font-size="${Number(height) * 0.026}" letter-spacing="5">${subtitle}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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
