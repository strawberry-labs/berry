import type { AgentStreamEvent } from "@berry/shared";

/**
 * Demo mode only: replays a believable in-progress turn for the demo task so
 * the "working" UI (live header, rolling action, running rows, a sub-agent,
 * streaming command output, a routine failed probe) can be seen without an
 * API. It ends on a step that keeps running, so the task stays "working".
 */

type Step = { at: number; event: AgentStreamEvent };

const TURN = "turn_demo_live";
const REASONING = "msg_demo_live_reasoning";

function steps(): Step[] {
  const out: Step[] = [];
  let at = 0;
  const push = (delay: number, event: AgentStreamEvent) => {
    at += delay;
    out.push({ at, event });
  };
  const start = (delay: number, toolCallId: string, name: string, args: Record<string, unknown>, extra: { title?: string; parentToolCallId?: string } = {}) =>
    push(delay, { kind: "tool.start", toolCallId, name, args: args as never, ...extra });
  const end = (delay: number, toolCallId: string, durationMs: number, extra: { status?: "completed" | "failed"; summary?: string; parentToolCallId?: string } = {}) =>
    push(delay, { kind: "tool.end", toolCallId, status: extra.status ?? "completed", durationMs, ...(extra.summary ? { summary: extra.summary } : {}), ...(extra.parentToolCallId ? { parentToolCallId: extra.parentToolCallId } : {}) });

  push(0, { kind: "turn.start", turnId: TURN });
  push(300, { kind: "message.start", messageId: REASONING, role: "assistant" });
  for (const chunk of [
    "The finance team wants the variance and the cause, ",
    "not the method. I'll reuse the reconciliation numbers, ",
    "check how earlier updates to finance-team@ were worded, ",
    "then draft the email with the workbook attached.",
  ]) push(450, { kind: "message.delta", messageId: REASONING, delta: chunk, channel: "reasoning" });

  start(700, "live_read", "read", { path: "/workspace/outputs/emea-reconciliation-oct.xlsx" });
  end(900, "live_read", 820, { summary: "142 rows, 7 flagged" });
  start(200, "live_read_notes", "read", { path: "/workspace/finance/october-notes.md" });
  end(300, "live_read_notes", 40, { status: "failed", summary: "No such file" });
  start(200, "live_grep", "grep", { pattern: "finance-team@", path: "/workspace" });
  end(700, "live_grep", 610, { summary: "2 files" });

  start(500, "live_gmail", "use_tool", { connector: "gmail", tool: "search_threads", query: "to:finance-team@ subject:reconciliation" }, { title: "Search earlier finance threads" });
  end(2200, "live_gmail", 2140, { summary: "3 threads" });

  start(500, "live_py", "bash", { command: "python summarize.py emea-reconciliation-oct.xlsx --top 7" });
  for (const line of ["Loading workbook…", "Grouping 7 flagged deals by cause", "FX timing: 4 deals, €121,300", "Missing discount: 3 deals, €62,900"]) {
    push(700, { kind: "tool.update", toolCallId: "live_py", detail: line });
  }
  end(600, "live_py", 3_100, { summary: "FX timing: 4 deals · Missing discount: 3 deals" });

  start(500, "live_task", "task", {
    description: "Double-check the 3 discount deals in Salesforce",
    subagent_type: "general-purpose",
    prompt: "For DL-20954, DL-20918 and DL-20940, confirm the discount on the Salesforce opportunity and whether it was approved.",
  });
  start(700, "live_task_sf", "use_tool", { connector: "salesforce", tool: "get_record", id: "DL-20954" }, { title: "Get opportunity DL-20954", parentToolCallId: "live_task" });
  end(1600, "live_task_sf", 1_520, { parentToolCallId: "live_task", summary: "Discount 7%, approved 14 Oct" });
  start(300, "live_task_sf2", "use_tool", { connector: "salesforce", tool: "get_record", id: "DL-20918" }, { title: "Get opportunity DL-20918", parentToolCallId: "live_task" });
  end(1400, "live_task_sf2", 1_310, { parentToolCallId: "live_task", summary: "Discount 5%, approved 9 Oct" });
  // The last sub-agent step keeps running so the task stays visibly working.
  start(300, "live_task_sf3", "use_tool", { connector: "salesforce", tool: "get_record", id: "DL-20940" }, { title: "Get opportunity DL-20940", parentToolCallId: "live_task" });
  return out;
}

/** Starts the replay; returns a function that stops it. */
export function startDemoLiveTurn(
  sessionId: string,
  apply: (sessionId: string, event: AgentStreamEvent) => void,
  reset: (sessionId: string) => void,
): () => void {
  // Automated browsers (Playwright) get a settled thread so tests stay deterministic.
  if (typeof navigator !== "undefined" && navigator.webdriver) return () => {};
  reset(sessionId);
  const timers = steps().map(({ at, event }) => setTimeout(() => apply(sessionId, event), at));
  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}
