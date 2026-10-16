#!/usr/bin/env node
// Behaviour evaluation for model-quality issues (H-002, H-012, H-017, H-019,
// H-020, H-022, H-025, H-026, H-029, H-034). Each case is assembled with the
// worker's real prompt and tool schemas (modelMessages + built-in tools), sent
// to an OpenAI-compatible endpoint, and checked deterministically. Tools are
// never executed: a tool call is answered "tool not run" for up to
// --tool-rounds rounds (a case's "rounds" overrides), so the model still has to
// give a final answer from what it has.
//
// Build first:  pnpm --filter @berry/worker... build
// Offline check: node scripts/eval-behaviour.mjs --dry-run
// Live run:      BERRY_EVAL_API_KEY=... node scripts/eval-behaviour.mjs \
//                  --base-url https://openrouter.ai/api/v1 --model z-ai/glm-5.3-flash
// Options: --suite <cases.json> --only H-022,H-002 --candidate <variant.json>
//          --samples <n> --temperature <t> --max-tokens <n> --tool-rounds <n>
//          --out <report.json> --concurrency <n>
// Reasoning models spend completion tokens before answering, so the default
// --max-tokens is 8000; at 2000 many replies were cut off before any text.
// The key is read from BERRY_EVAL_API_KEY only and is never printed. Cases are
// synthetic; nothing here reads production data.
import { readFile, writeFile } from "node:fs/promises";
import { modelMessages, durableBuiltInToolDefinitions } from "../apps/worker/dist/turn-runner.js";
import { serializeMessage } from "../packages/router-client/dist/index.js";
import { DURABLE_BASE_BUILT_IN_TOOLS } from "../packages/shared/dist/index.js";
import { checkResponse, continueAfterTools, responseOutcome } from "./behaviour-eval-checks.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : "true"]);
  return pairs;
}, []));
const suitePath = args.suite ?? new URL("./behaviour-eval-cases.json", import.meta.url).pathname;
const only = args.only ? new Set(args.only.split(",")) : null;
const samples = Math.max(1, Number(args.samples ?? 1));
const concurrency = Math.max(1, Number(args.concurrency ?? 4));
const temperature = Number(args.temperature ?? 0);
const maxTokens = Math.max(256, Number(args["max-tokens"] ?? 8_000));
const toolRounds = Math.max(1, Number(args["tool-rounds"] ?? 3));
const dryRun = args["dry-run"] === "true";
const candidate = args.candidate ? JSON.parse(await readFile(args.candidate, "utf8")) : null;
// systemReplaceFile swaps the stable system prompt (keeping the per-run runtime
// section); systemAppend adds rules after it.
const replacement = candidate?.systemReplaceFile ? await readFile(new URL(`../${candidate.systemReplaceFile}`, import.meta.url), "utf8") : null;
const cases = JSON.parse(await readFile(suitePath, "utf8")).filter((item) => !only || only.has(item.issue));
const startedAt = "2026-10-14T08:00:00.000Z";

function snapshotFor(item) {
  const entries = [];
  let sequence = 0;
  for (const turn of item.history) {
    const entryId = `entry-${sequence += 1}`;
    const message = turn.role === "toolResult"
      ? { role: "toolResult", toolCallId: turn.toolCallId, toolName: turn.toolName, content: [{ type: "text", text: turn.content }] }
      : turn.role === "assistant" && turn.toolCalls
        ? { role: "assistant", content: [...(turn.content ? [{ type: "text", text: turn.content }] : []), ...turn.toolCalls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments }))], stopReason: "toolUse" }
        : turn.role === "assistant"
          ? { role: "assistant", content: [{ type: "text", text: turn.content }], stopReason: "stop" }
          : { role: "user", content: turn.content };
    entries.push({ entryId, parentEntryId: entries.at(-1)?.entryId ?? null, entryType: "message", sequence, payload: { type: "message", id: entryId, message } });
  }
  const lastUser = [...entries].reverse().find((entry) => entry.payload.message.role === "user");
  const builtInTools = [...DURABLE_BASE_BUILT_IN_TOOLS, "ask_user_question", "compose_message", "persist_artifact", ...(item.extraTools ?? [])];
  return {
    id: `run-${item.id}`, tenantId: "00000000-0000-7000-8000-0000000000e1", sessionId: "s", taskId: "t", workspaceId: "w", userId: "u",
    createdAt: item.startedAt ?? startedAt, requestMessageId: lastUser?.entryId ?? null, state: "calling_model",
    runtimeRequest: {
      capabilityVersion: 1, input: lastUser?.payload.message.content ?? "", providerId: "router",
      provider: { id: "router", name: "Router", kind: "openai-compatible", baseUrl: "https://router.invalid/v1", defaultModel: "eval", apiType: "openai-chat-completions", endpointPath: "/chat/completions", authType: "none", models: [] },
      model: "eval", conversationKind: "chat", workspacePath: "/workspace", workspaceId: "00000000-0000-7000-8000-0000000000e2",
      permissionMode: "full-access", reasoning: "off", maxTokens: 4_000, contextWindowTokens: 128_000, modelAcceptsImages: false,
      modelPricing: {}, builtInTools, mcpServers: [], extraSkills: item.skills ?? [], attachments: item.attachments ?? [],
    },
    groundingContext: item.grounding ?? {}, promptManifest: {}, steps: [], entries,
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: "0" },
  };
}

function requestFor(item) {
  const snapshot = snapshotFor(item);
  const assembled = modelMessages(snapshot);
  const messages = assembled.messages.map(serializeMessage);
  if (replacement) messages[0] = { ...messages[0], content: `${replacement.trim()}${messages[0].content.slice(assembled.stableSystemPrompt.length)}` };
  if (candidate?.systemAppend) messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${candidate.systemAppend}` };
  return { messages, tools: durableBuiltInToolDefinitions(snapshot) };
}

async function call(request) {
  const key = process.env.BERRY_EVAL_API_KEY;
  if (!key || !args["base-url"] || !args.model) throw new Error("Set BERRY_EVAL_API_KEY and pass --base-url and --model (or use --dry-run)");
  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    const response = await fetch(`${args["base-url"].replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: args.model, messages: request.messages, tools: request.tools, tool_choice: "auto", temperature, max_tokens: maxTokens, stream: false }),
      signal: AbortSignal.timeout(120_000),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) { await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt)); continue; }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return { body, latencyMs: Date.now() - started };
  }
}

/** Runs one case, answering tool calls with "tool not run" until a final reply or the round limit. */
async function converse(item, request) {
  let messages = request.messages;
  const earlierCalls = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const limit = Math.max(1, Number(item.rounds ?? toolRounds));
  let latencyMs = 0;
  for (let round = 1; ; round += 1) {
    const { body, latencyMs: elapsed } = await call({ messages, tools: request.tools });
    latencyMs += elapsed;
    usage.prompt_tokens += body.usage?.prompt_tokens ?? 0;
    usage.completion_tokens += body.usage?.completion_tokens ?? 0;
    const next = round < limit ? continueAfterTools(messages, body) : null;
    if (!next) return { body, earlierCalls, rounds: round, latencyMs, usage };
    earlierCalls.push(...(body.choices?.[0]?.message?.tool_calls ?? []));
    messages = next;
  }
}

const jobs = cases.flatMap((item) => Array.from({ length: samples }, (_, sample) => ({ item, sample })));
const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (next < jobs.length) {
    const { item, sample } = jobs[next++];
    const request = requestFor(item);
    if (dryRun) {
      results.push({ id: item.id, issue: item.issue, sample, dryRun: true, messages: request.messages.length, tools: request.tools.length, characters: JSON.stringify(request).length });
      continue;
    }
    try {
      const { body, earlierCalls, rounds, latencyMs, usage } = await converse(item, request);
      const checked = checkResponse(item, body, earlierCalls);
      results.push({ id: item.id, issue: item.issue, sample, pass: checked.pass, outcome: responseOutcome(body, checked), failures: checked.failures, calls: checked.calls, rounds, finishReason: body.choices?.[0]?.finish_reason ?? null, latencyMs, usage, servedModel: body.model ?? null, answer: checked.answer.slice(0, 1_200) });
    } catch (error) {
      results.push({ id: item.id, issue: item.issue, sample, pass: false, outcome: "api_error", error: error.message });
    }
  }
}));

results.sort((left, right) => left.id.localeCompare(right.id) || left.sample - right.sample);
// "evaluated" counts completed answers only; inconclusive outcomes are kept apart.
const byIssue = {};
for (const result of results) {
  const bucket = byIssue[result.issue] ??= { cases: 0, evaluated: 0, passed: 0, failed: 0, toolPending: 0, tokenLimited: 0, errors: 0 };
  bucket.cases += 1;
  if (result.outcome === "passed") { bucket.passed += 1; bucket.evaluated += 1; }
  if (result.outcome === "failed") { bucket.failed += 1; bucket.evaluated += 1; }
  if (result.outcome === "tool_pending") bucket.toolPending += 1;
  if (result.outcome === "token_limited") bucket.tokenLimited += 1;
  if (result.outcome === "api_error") bucket.errors += 1;
}
const usage = results.reduce((total, result) => ({
  prompt: total.prompt + (result.usage?.prompt_tokens ?? 0),
  completion: total.completion + (result.usage?.completion_tokens ?? 0),
}), { prompt: 0, completion: 0 });
const report = { model: args.model ?? null, baseHost: args["base-url"] ? new URL(args["base-url"]).host : null, variant: args.candidate ?? "baseline", dryRun, settings: { samples, temperature, maxTokens, toolRounds }, byIssue, usage, results };
if (args.out) await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ model: report.model, variant: report.variant, dryRun, byIssue, usage }, null, 2));
if (!dryRun) for (const result of results.filter((item) => !item.pass)) console.log(`${result.outcome.toUpperCase()} ${result.id}#${result.sample}: ${result.error ?? result.failures.join("; ")}`);
