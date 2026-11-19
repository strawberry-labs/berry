import type { JsonValue, Message, Task } from "@berry/shared";

export const FIXED_NOW = "2026-07-10T00:00:00.000Z";

export function fixtureTasks(): Task[] {
  return [
    task("task_cloud", "Cloud sandbox smoke", "running", "session_cloud"),
    task("task_launch", "Launch plan review", "completed", "session_launch"),
    task("task_chat", "Quick model question", "completed", "session_chat"),
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
  if (sessionId !== "session_cloud") {
    return [
      message("msg_user_1", sessionId, "user", "Run a sandboxed task and summarize the result."),
      assistant,
    ];
  }
  return [
    message("msg_user_1", sessionId, "user", "Run a sandboxed task and summarize the result."),
    assistant,
    message("msg_user_2", sessionId, "user", "Pull October's EMEA spend from the finance workbook, reconcile it against Salesforce closed-won deals, and flag anything more than 5% off."),
    reconciliationTurn(sessionId),
    message("msg_user_3", sessionId, "user", DEMO_LIVE_PROMPT),
  ];
}

/** The follow-up the demo live turn answers (see demo-live-turn.ts). */
export const DEMO_LIVE_PROMPT = "Draft the summary email to the finance team and attach the workbook.";

type FixtureTool = {
  id: string;
  name: string;
  title?: string;
  args?: Record<string, JsonValue>;
  status?: "completed" | "failed" | "denied";
  durationMs?: number;
  output?: string;
  children?: Array<Record<string, JsonValue>>;
};

/**
 * A settled turn that exercises every activity row Berry draws: reasoning,
 * a todo list, an explore group with a routine failed probe, a connector
 * call, a skill, a failed command and its retry, a sub-agent with its own
 * tool calls, file writes, a saved artifact and a memory note.
 */
function reconciliationTurn(sessionId: string): Message {
  const id = "msg_assistant_2";
  const answer = [
    "October EMEA spend reconciles to Salesforce within 5% for 135 of 142 deals. Seven are off by more than 5%, worth **€184,200** of the €2.41M total.",
    "",
    "| Deal | Account | Workbook | Salesforce | Off by |",
    "| --- | --- | ---: | ---: | ---: |",
    "| DL-20931 | Nordwind Logistik | €212,000 | €184,500 | 14.9% |",
    "| DL-20877 | Calder & Rowe | €96,400 | €88,100 | 9.4% |",
    "| DL-20954 | Atelier Ferrand | €41,750 | €38,900 | 7.3% |",
    "",
    "Four of the seven are FX timing: the workbook converted GBP at the 1 October rate while Salesforce used the close date. The other three have a discount applied in Salesforce that never reached the workbook.",
    "",
    "The full list, with the FX check for each deal, is in **emea-reconciliation-oct.xlsx**.",
  ].join("\n");
  const tools: FixtureTool[] = [
    {
      id: "t_todo", name: "todo_write", durationMs: 40,
      args: { todos: [
        { content: "Read the October EMEA workbook", status: "completed" },
        { content: "Pull closed-won deals from Salesforce", status: "completed" },
        { content: "Join on deal ID and compute variance", status: "completed" },
        { content: "Check FX on flagged deals", status: "completed" },
        { content: "Write the reconciliation workbook", status: "completed" },
      ] },
    },
    { id: "t_ls", name: "ls", args: { path: "/workspace/finance" }, durationMs: 120, output: "october-emea.xlsx\nseptember-emea.xlsx\nfx-rates/\nREADME.md" },
    { id: "t_read1", name: "read", args: { path: "/workspace/finance/october-emea.xlsx" }, durationMs: 640, output: "Sheet 'Spend': 142 rows · columns deal_id, account, amount_eur, booked_on" },
    { id: "t_read2", name: "read", args: { path: "/workspace/finance/fx-rates/2026-10.csv" }, status: "failed", durationMs: 30, output: "ENOENT: no such file or directory" },
    { id: "t_find", name: "find", args: { pattern: "*.csv", path: "/workspace/finance/fx-rates" }, durationMs: 90, output: "fx-rates/2026-09.csv\nfx-rates/2026-q3.csv" },
    { id: "t_grep", name: "grep", args: { pattern: "deal_id", path: "/workspace/finance" }, durationMs: 210, output: "3 files" },
    {
      id: "t_sf", name: "use_tool", title: "Query closed-won opportunities",
      args: { connector: "salesforce", tool: "soql_query", query: "SELECT Id, Deal_ID__c, Amount, CloseDate FROM Opportunity WHERE StageName = 'Closed Won' AND CloseDate = LAST_MONTH AND Region__c = 'EMEA'" },
      durationMs: 2_310, output: "142 records",
    },
    { id: "t_skill", name: "activate_skill", args: { name: "spreadsheet-analysis" }, durationMs: 180, output: "Loaded spreadsheet-analysis" },
    {
      id: "t_py1", name: "bash", args: { command: "python reconcile.py --month 2026-10 --region EMEA" }, status: "failed", durationMs: 1_140,
      output: "Traceback (most recent call last):\n  File \"reconcile.py\", line 3, in <module>\n    import openpyxl\nModuleNotFoundError: No module named 'openpyxl'",
    },
    { id: "t_pip", name: "bash", args: { command: "pip install openpyxl" }, durationMs: 4_820, output: "Successfully installed et-xmlfile-1.1.0 openpyxl-3.1.5" },
    {
      id: "t_py2", name: "bash", args: { command: "python reconcile.py --month 2026-10 --region EMEA" }, durationMs: 2_960,
      output: "Matched 142/142 deals on deal_id\nWithin 5%: 135\nOver 5%: 7 (€184,200)\nWrote /workspace/outputs/emea-reconciliation-oct.xlsx",
    },
    {
      id: "t_task", name: "task", durationMs: 18_400,
      args: { description: "Check FX on the 7 flagged deals", subagent_type: "general-purpose", prompt: "For each flagged deal, compare the GBP→EUR rate on 1 October with the rate on its close date and say whether FX explains the variance." },
      output: "FX explains 4 of 7 (DL-20931, DL-20877, DL-20902, DL-20966). The other 3 carry a Salesforce discount the workbook lacks.",
      children: [
        { toolCallId: "t_task_ws", name: "web_search", args: { query: "ECB euro reference rate GBP October 2026" }, status: "completed", durationMs: 1_900, output: "5 results" },
        { toolCallId: "t_task_wf", name: "web_fetch", args: { url: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip" }, status: "completed", durationMs: 3_200, output: "Fetched 31 days of rates" },
        { toolCallId: "t_task_py", name: "bash", args: { command: "python fx_check.py flagged.csv" }, status: "completed", durationMs: 2_400, output: "4 of 7 explained by FX" },
      ],
    },
    { id: "t_edit", name: "edit", args: { path: "/workspace/reconcile.py" }, durationMs: 60, output: "Added an fx_source column" },
    { id: "t_write", name: "write", args: { path: "/workspace/outputs/emea-reconciliation-oct.xlsx" }, durationMs: 380 },
    { id: "t_artifact", name: "persist_artifact", title: "emea-reconciliation-oct.xlsx", args: { path: "/workspace/outputs/emea-reconciliation-oct.xlsx" }, durationMs: 520, output: "Saved to the task's files" },
    { id: "t_mem", name: "remember_memory", title: "Finance flags variances above 5%", args: { memory: "Finance flags reconciliation variances above 5%." }, durationMs: 90 },
  ];
  const parts: Message["parts"] = [
    { id: `${id}_reasoning`, messageId: id, kind: "reasoning", content: "Read the workbook first, then pull the same month from Salesforce, join on deal ID and compute the variance. Anything over 5% gets an FX check, since EMEA books in GBP and EUR.", position: 0, createdAt: FIXED_NOW },
  ];
  for (const tool of tools) {
    parts.push({
      id: `${id}_${tool.id}`,
      messageId: id,
      kind: "tool-result",
      content: {
        toolCallId: tool.id,
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.args ? { arguments: tool.args } : {}),
        status: tool.status ?? "completed",
        ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
        ...(tool.output ? { output: tool.output } : {}),
        ...(tool.children ? { children: tool.children } : {}),
      },
      position: parts.length,
      createdAt: FIXED_NOW,
    });
  }
  parts.push({ id: `${id}_text`, messageId: id, kind: "text", content: answer, position: parts.length, createdAt: FIXED_NOW });
  return { ...message(id, sessionId, "assistant", ""), parts, generationMs: 74_000, inputTokens: 182_400, outputTokens: 6_120 };
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

function task(id: string, title: string, status: Task["status"], activeSessionId: string): Task {
  return {
    id,
    workspaceId: "self-host",
    title,
    status,
    activeSessionId,
    conversationKind: "chat",
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
