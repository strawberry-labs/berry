import { z } from "zod";

/** Host-issued receipts only. Never store live URLs or browser credentials here. */
export const BrowserSessionReceiptSchema = z.object({
  sessionId: z.string().regex(/^bses_[A-Za-z0-9_-]{1,120}$/),
  serverId: z.string().min(1).max(200),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  closed: z.boolean().default(false),
});
export type BrowserSessionReceipt = z.infer<typeof BrowserSessionReceiptSchema>;
export const BrowserHandoffSchema = z.object({
  id: z.string().uuid(),
  sessionId: BrowserSessionReceiptSchema.shape.sessionId,
  serverId: z.string(),
  state: z.enum(["requested", "ready", "resumed"]),
  reason: z.string().max(2000),
  requestedAt: z.string().datetime({ offset: true }),
  requestedBy: z.string(),
  resumeState: z.enum(["calling_model", "executing_tool"]).optional(),
});
export type BrowserHandoff = z.infer<typeof BrowserHandoffSchema>;
export const BrowserControlStateSchema = z.object({
  runId: z.string().nullable(), active: z.boolean(),
  sessions: z.array(BrowserSessionReceiptSchema),
  handoff: BrowserHandoffSchema.nullable(),
});
export type BrowserControlState = z.infer<typeof BrowserControlStateSchema>;
export const BrowserConnectionSchema = z.object({
  url: z.string().url(), expiresAt: z.string().datetime({ offset: true }),
});
export type BrowserConnection = z.infer<typeof BrowserConnectionSchema>;

export const BROWSER_HANDOFF_TOOL = "request_browser_handoff";
export const BrowserHandoffArgumentsSchema = z.object({
  session_id: BrowserSessionReceiptSchema.shape.sessionId,
  reason: z.string().trim().min(1).max(2000),
}).strict();

export function browserSessionsFromSteps(steps: readonly { state: string; output?: unknown }[]): BrowserSessionReceipt[] {
  const sessions = new Map<string, BrowserSessionReceipt>();
  for (const step of steps) {
    if (step.state !== "completed" || !step.output || typeof step.output !== "object") continue;
    const parsed = BrowserSessionReceiptSchema.safeParse((step.output as Record<string, unknown>)._berryBrowserSession);
    if (parsed.success) sessions.set(`${parsed.data.serverId}:${parsed.data.sessionId}`, parsed.data);
  }
  return [...sessions.values()].filter((session) => !session.closed);
}
