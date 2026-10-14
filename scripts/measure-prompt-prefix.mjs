#!/usr/bin/env node
// Offline, deterministic measurement of Berry-side prompt-prefix reuse (H-032).
// It renders the exact upstream request (modelMessages + canonical tools +
// wire serialization) for synthetic multi-turn sessions and reports how much
// of each request is an exact prefix of an earlier one. This is the ceiling a
// provider prefix cache could reach; it is not a provider measurement and makes
// no network calls. Build first: pnpm --filter @berry/worker... build
import { modelMessages, DURABLE_TOOL_DEFINITIONS } from "../apps/worker/dist/turn-runner.js";
import { canonicalToolDefinitions } from "../apps/worker/dist/prompt-cache.js";
import { serializeMessage } from "../packages/router-client/dist/index.js";

const filler = (label, size) => {
  let text = "";
  for (let i = 0; text.length < size; i += 1) text += `${label} line ${i}: measured value ${(i * 37) % 1000} within tolerance.\n`;
  return text.slice(0, size);
};

function runtime(overrides = {}) {
  return {
    capabilityVersion: 1,
    input: "Review the specification",
    providerId: "router",
    provider: {
      id: "router", name: "Router", kind: "openai-compatible", baseUrl: "https://router.invalid/v1",
      defaultModel: "deepseek-v4-flash", apiType: "openai-chat-completions", endpointPath: "/chat/completions",
      authType: "none", models: [],
    },
    model: "deepseek-v4-flash",
    conversationKind: "chat",
    workspacePath: "/workspace",
    workspaceId: "00000000-0000-7000-8000-000000000007",
    permissionMode: "full-access",
    reasoning: "off",
    maxTokens: 8_000,
    contextWindowTokens: 1_000_000,
    modelAcceptsImages: true,
    modelPricing: {},
    builtInTools: [],
    mcpServers: [],
    extraSkills: [],
    attachments: [],
    ...overrides,
  };
}

/** Render one upstream request as a template would order it: system, tools, turns. */
function render(snapshot, tools, additional = []) {
  const messages = modelMessages(snapshot, additional).messages.map(serializeMessage);
  const system = messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m)).join("\n");
  const rest = messages.filter((m) => m.role !== "system").map((m) => JSON.stringify(m)).join("\n");
  return `${system}\n${JSON.stringify(canonicalToolDefinitions(tools))}\n${rest}`;
}

const lcp = (a, b) => { let i = 0; const n = Math.min(a.length, b.length); while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1; return i; };

function simulate({ name, turns = 3, callsPerTurn = 4, groundingSize = 3_000, toolResultSize = 6_000, mutate = () => ({}) }) {
  const entries = [];
  const steps = [];
  const requests = [];
  let sequence = 0;
  const push = (message, extra = {}) => {
    const entryId = `entry-${sequence += 1}`;
    entries.push({ entryId, parentEntryId: entries.at(-1)?.entryId ?? null, entryType: "message", sequence, payload: { type: "message", id: entryId, message, ...extra } });
    return entryId;
  };
  for (let turn = 1; turn <= turns; turn += 1) {
    const requestMessageId = push({ role: "user", content: `Turn ${turn}: check section ${turn} of the spec and summarise risks.` });
    const grounding = { project: filler(`grounding-t${turn}`, groundingSize), retrieval: { degradedReason: null } };
    for (let call = 1; call <= callsPerTurn; call += 1) {
      const change = mutate({ turn, call, steps });
      const snapshot = {
        id: `run-${turn}`, tenantId: "t", sessionId: "s", taskId: "task", workspaceId: "w", userId: "u",
        requestMessageId, state: "calling_model", runtimeRequest: runtime(change.runtime ?? {}), groundingContext: grounding,
        promptManifest: {}, steps: [...steps], entries: [...entries], usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: "0" },
      };
      const tools = [...DURABLE_TOOL_DEFINITIONS, ...(change.extraTools ?? [])];
      const text = render(snapshot, tools, change.additional ?? []);
      const previous = requests.at(-1)?.text ?? "";
      const best = requests.reduce((max, request) => Math.max(max, lcp(request.text, text)), 0);
      requests.push({ turn, call, text, total: text.length, reusedPrevious: lcp(previous, text), reusedBest: best });
      if (call < callsPerTurn) {
        const id = `call-${turn}-${call}`;
        push({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `/workspace/inputs/spec.pdf`, offset: call } }], stopReason: "toolUse" });
        push({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: filler(`spec-t${turn}-c${call}`, toolResultSize) }] });
      } else {
        push({ role: "assistant", content: [{ type: "text", text: filler(`answer-t${turn}`, 1_500) }], stopReason: "stop" });
      }
    }
  }
  const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
  const pct = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;
  const first = requests.filter((r) => r.call === 1 && r.turn > 1);
  const later = requests.filter((r) => r.call > 1);
  return {
    scenario: name,
    requests: requests.length,
    reusableAll: pct(sum(requests, "reusedBest"), sum(requests, "total")),
    reusableLaterCalls: pct(sum(later, "reusedBest"), sum(later, "total")),
    reusableFirstCallOfLaterTurns: pct(sum(first, "reusedBest"), sum(first, "total")),
  };
}

const mcpTools = ["drive_search", "drive_list_children", "drive_read_file"].map((name) => ({
  type: "function", function: { name, description: `${name} for the connected drive`, parameters: { type: "object", properties: { query: { type: "string" } } } },
}));
const pdfSkill = { name: "pdf", description: "Work with PDF files", content: filler("pdf-skill", 2_500), filePath: "/organization-skills/pdf/SKILL.md", disableModelInvocation: false, resources: [] };

const scenarios = [
  simulate({ name: "baseline: stable tools, new grounding each turn" }),
  simulate({
    name: "MCP discovery reveals connector tools at turn 2 call 2",
    mutate: ({ turn, call }) => ({ extraTools: turn > 2 || (turn === 2 && call >= 2) ? mcpTools : [] }),
  }),
  simulate({
    name: "connector import activates the PDF skill guidance mid-run",
    mutate: ({ turn, call, steps }) => {
      if (turn === 1 && call === 3 && !steps.some((step) => step.id === "import")) {
        steps.push({ id: "import", sequence: 99, type: "tool.drive_read_file", state: "completed", input: {}, output: { artifacts: [{ name: "spec.pdf", mediaType: "application/pdf" }] } });
      }
      return { runtime: { extraSkills: [pdfSkill] } };
    },
  }),
  simulate({
    name: "five workspace images re-sent at the tail of every call",
    mutate: ({ call }) => ({
      additional: call > 1 ? Array.from({ length: 5 }, (_, index) => [
        { type: "text", text: `Workspace image ${index + 1}: "/workspace/pages/page-${index + 1}.png"` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(4_000)}${index}` } },
      ]).flat() : [],
    }),
  }),
];
scenarios.push(simulate({
  name: "realistic: 6 turns x 6 calls, 4 KB grounding, 8 KB tool results", turns: 6, callsPerTurn: 6, groundingSize: 4_000, toolResultSize: 8_000,
}));
console.log(JSON.stringify(scenarios, null, 2));
