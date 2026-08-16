import { z } from "zod";

/**
 * The durable turn reasons are shared by producers and consumers. Keeping the
 * enum in the shared package prevents an outbox producer from successfully
 * writing a payload that the worker parser cannot accept.
 */
export const TurnExecuteReasonSchema = z.enum([
  "admitted",
  "continue",
  "lease-recovery",
  "approval-resolved",
  "retry",
  "queued-follow-up",
]);
export type TurnExecuteReason = z.infer<typeof TurnExecuteReasonSchema>;

export const TurnResumeReasonSchema = z.enum([
  "approval-resolved",
  "user-input",
  "scheduled-retry",
  "operator-recovery",
]);
export type TurnResumeReason = z.infer<typeof TurnResumeReasonSchema>;
