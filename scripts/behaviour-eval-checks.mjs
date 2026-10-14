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

/** Checks one OpenAI-style chat completion against a case's expectations. */
export function checkResponse(item, response) {
  const message = response.choices?.[0]?.message ?? {};
  const calls = (message.tool_calls ?? []).map((call) => call.function?.name).filter(Boolean);
  const drafts = (message.tool_calls ?? []).filter((call) => call.function?.name === "compose_message").flatMap((call) => {
    try { return (JSON.parse(call.function.arguments).variants ?? []).map((variant) => [variant.subject, variant.body].filter(Boolean).join("\n")); } catch { return []; }
  });
  const answer = [message.content ?? "", ...drafts].join("\n").trim();
  const failures = [];
  const c = item.checks;
  for (const pattern of c.answerIncludes ?? []) if (!matches(answer, pattern)) failures.push(`missing /${pattern}/`);
  for (const pattern of c.answerExcludes ?? []) if (matches(answer, pattern)) failures.push(`contains /${pattern}/`);
  if (c.toolsNone && calls.length > 0) failures.push(`called ${calls.join(", ")}`);
  if (c.toolsAny && !calls.some((name) => c.toolsAny.includes(name))) failures.push(`expected one of ${c.toolsAny.join(", ")}; got ${calls.join(", ") || "no tools"}`);
  for (const name of c.toolsExclude ?? []) if (calls.includes(name)) failures.push(`called ${name}`);
  if (c.singleParagraph && answer.split(/\n\s*\n/).filter((part) => part.trim()).length !== 1) failures.push("not a single paragraph");
  if (c.minRtlWordShare !== undefined && rtlWordShare(answer) < c.minRtlWordShare) failures.push(`right-to-left word share ${rtlWordShare(answer).toFixed(2)} < ${c.minRtlWordShare}`);
  return { pass: failures.length === 0, failures, calls, answer };
}

/** Builds a minimal completion for tests and for re-checking saved answers. */
export function completion(content, toolCalls = []) {
  return { choices: [{ message: { content, tool_calls: toolCalls.map((name, index) => ({ id: `call-${index}`, type: "function", function: { name, arguments: "{}" } })) } }] };
}
