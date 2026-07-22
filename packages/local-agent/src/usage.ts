import type { BerryDatabase } from "@berry/desktop-db";
import { createId, nowIso } from "@berry/shared";

export interface UsageRecordInput {
  providerId?: string;
  taskId?: string;
  sessionId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export function recordUsage(db: BerryDatabase, input: UsageRecordInput): void {
  const taskId = input.taskId && db.tasks().getTask(input.taskId) ? input.taskId : null;
  const sessionId = input.sessionId && db.tasks().getSession(input.sessionId) ? input.sessionId : null;
  db.db
    .prepare(
      `INSERT INTO usage_records (id, provider_id, task_id, session_id, model, input_tokens, output_tokens, cost_micros, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      createId("usage"),
      input.providerId ?? null,
      taskId,
      sessionId,
      input.model,
      Math.round(input.inputTokens),
      Math.round(input.outputTokens),
      nowIso(),
    );
}

export interface UsageSummary {
  days: Array<{ date: string; tokens: number; turns: number }>;
  models: Array<{ model: string; inputTokens: number; outputTokens: number; requests: number }>;
  tools: Array<{ name: string; calls: number; denied: number }>;
}

export function summarizeUsage(db: BerryDatabase): UsageSummary {
  const days = (
    db.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS date,
                SUM(input_tokens + output_tokens) AS tokens,
                COUNT(*) AS turns
         FROM usage_records GROUP BY date ORDER BY date ASC`,
      )
      .all() as Array<{ date: string; tokens: number; turns: number }>
  ).map((row) => ({ date: row.date, tokens: Number(row.tokens), turns: Number(row.turns) }));
  const models = (
    db.db
      .prepare(
        `SELECT model,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                COUNT(*) AS requests
         FROM usage_records GROUP BY model ORDER BY requests DESC`,
      )
      .all() as Array<{ model: string; input_tokens: number; output_tokens: number; requests: number }>
  ).map((row) => ({
    model: row.model,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    requests: Number(row.requests),
  }));
  const tools = (
    db.db
      .prepare("SELECT tool_name AS name, COUNT(*) AS calls, SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) AS denied FROM tool_calls GROUP BY tool_name ORDER BY calls DESC")
      .all() as Array<{
      name: string;
      calls: number;
      denied: number;
    }>
  ).map((row) => ({ name: row.name, calls: Number(row.calls), denied: Number(row.denied) }));
  return { days, models, tools };
}
