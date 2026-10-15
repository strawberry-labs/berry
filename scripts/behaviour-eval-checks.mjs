// Deterministic checks for scripts/eval-behaviour.mjs (kept separate so they can
// be tested against known good and bad answers without any model calls).
const matches = (text, pattern) => new RegExp(pattern, "i").test(text);

/** Share of words written in a right-to-left script, ignoring code and URLs. */
export function rtlWordShare(text) {
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/\b(?:https?|ftp):\/\/\S+/g, " ");
  let rtl = 0;
  let ltr = 0;
  let previous = null;
  for (const char of prose) {
    const kind = /\p{L}/u.test(char) ? (/[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(char) ? "rtl" : "ltr") : /\p{M}/u.test(char) ? previous : null;
    if (kind && kind !== previous) { if (kind === "rtl") rtl += 1; else ltr += 1; }
    previous = kind;
  }
  return rtl + ltr === 0 ? 0 : rtl / (rtl + ltr);
}

/** Tools whose call is itself the reply (a drafted message or a question), not a step towards one. */
export const REPLY_TOOLS = new Set(["compose_message", "ask_user_question"]);

/** What the evaluation returns for every other tool call: nothing is executed. */
export const SIMULATED_TOOL_RESULT = "Tool not run: this evaluation cannot execute tools. Answer from the conversation and your own reasoning, and say plainly what you could not check.";

/**
 * The next request's messages after a reply that called tools, each answered
 * with SIMULATED_TOOL_RESULT, or null when the reply is final (no tool calls,
 * or only reply tools). Reasoning fields are passed back for providers that
 * require them within a tool-calling turn.
 */
export function continueAfterTools(messages, response) {
  const message = response.choices?.[0]?.message ?? {};
  const toolCalls = message.tool_calls ?? [];
  if (toolCalls.length === 0 || toolCalls.every((call) => REPLY_TOOLS.has(call.function?.name))) return null;
  const reasoning = Object.fromEntries(["reasoning", "reasoning_content", "reasoning_details"].filter((key) => message[key] !== undefined).map((key) => [key, message[key]]));
  return [
    ...messages,
    { role: "assistant", content: message.content ?? null, tool_calls: toolCalls, ...reasoning },
    ...toolCalls.map((call) => ({ role: "tool", tool_call_id: call.id, content: SIMULATED_TOOL_RESULT })),
  ];
}

/**
 * Checks the final chat completion of a case against its expectations.
 * earlierCalls are the tool calls of previous rounds of the same conversation.
 */
export function checkResponse(item, response, earlierCalls = []) {
  const message = response.choices?.[0]?.message ?? {};
  const toolCalls = [...earlierCalls, ...(message.tool_calls ?? [])];
  const calls = toolCalls.map((call) => call.function?.name).filter(Boolean);
  const drafts = toolCalls.filter((call) => call.function?.name === "compose_message").flatMap((call) => {
    try { return (JSON.parse(call.function.arguments).variants ?? []).map((variant) => [variant.subject, variant.body].filter(Boolean).join("\n")); } catch { return []; }
  });
  const answer = [message.content ?? "", ...drafts].join("\n").trim();
  const failures = [];
  const c = item.checks;
  // A blank reply never passes a case that judges the answer, unless the
  // expected behaviour was to start with one of the named tools.
  const judgesAnswer = Boolean(c.answerIncludes?.length || c.answerExcludes?.length || c.singleParagraph || c.minRtlWordShare !== undefined);
  const startedWithTool = Boolean(c.toolsAny && calls.some((name) => c.toolsAny.includes(name)));
  if (judgesAnswer && !answer && !startedWithTool) failures.push("no answer");
  for (const pattern of c.answerIncludes ?? []) if (!matches(answer, pattern)) failures.push(`missing /${pattern}/`);
  for (const pattern of c.answerExcludes ?? []) if (matches(answer, pattern)) failures.push(`contains /${pattern}/`);
  if (c.toolsNone && calls.length > 0) failures.push(`called ${calls.join(", ")}`);
  if (c.toolsAny && !calls.some((name) => c.toolsAny.includes(name))) failures.push(`expected one of ${c.toolsAny.join(", ")}; got ${calls.join(", ") || "no tools"}`);
  for (const name of c.toolsExclude ?? []) if (calls.includes(name)) failures.push(`called ${name}`);
  if (c.singleParagraph && answer.split(/\n\s*\n/).filter((part) => part.trim()).length !== 1) failures.push("not a single paragraph");
  if (c.minRtlWordShare !== undefined && rtlWordShare(answer) < c.minRtlWordShare) failures.push(`right-to-left word share ${rtlWordShare(answer).toFixed(2)} < ${c.minRtlWordShare}`);
  return { pass: failures.length === 0, failures, calls, answer };
}

/**
 * Separates a failed check into what it says about behaviour. The harness never
 * executes tools, so a final reply that still only calls tools, or that hit the
 * token limit before answering, is inconclusive rather than a behaviour
 * failure. Tool-expectation failures always count.
 * @returns "passed" | "failed" | "tool_pending" | "token_limited"
 */
export function responseOutcome(response, checked) {
  if (checked.pass) return "passed";
  if (checked.failures.some((failure) => failure.startsWith("called ") || failure.startsWith("expected one of"))) return "failed";
  if (checked.answer.trim()) return "failed";
  const finish = String(response.choices?.[0]?.finish_reason ?? "").toLowerCase();
  if (finish === "length" || finish === "max_tokens") return "token_limited";
  const pending = (response.choices?.[0]?.message?.tool_calls ?? []).some((call) => !REPLY_TOOLS.has(call.function?.name));
  if (pending) return "tool_pending";
  return "failed";
}

/** Builds a minimal completion for tests and for re-checking saved answers. */
export function completion(content, toolCalls = [], finishReason = toolCalls.length ? "tool_calls" : "stop") {
  return { choices: [{ finish_reason: finishReason, message: { content, tool_calls: toolCalls.map((name, index) => ({ id: `call-${index}`, type: "function", function: { name, arguments: "{}" } })) } }] };
}
