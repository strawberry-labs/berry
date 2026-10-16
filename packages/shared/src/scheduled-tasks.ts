import { z } from "zod";

export const ScheduleTimezoneSchema = z.string().trim().min(1).max(100).refine((timezone) => {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); return true; }
  catch { return false; }
}, "Use a valid IANA timezone, such as Asia/Dubai");

export const TaskScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expression: z.string().trim().min(1).max(128), timezone: ScheduleTimezoneSchema }).strict(),
  z.object({ kind: z.literal("once"), runAt: z.string().datetime({ offset: true }), timezone: ScheduleTimezoneSchema }).strict(),
]);
export type TaskSchedule = z.infer<typeof TaskScheduleSchema>;

export const TaskScheduleInputSchema = z.union([
  TaskScheduleSchema,
  z.object({ kind: z.literal("delay"), minutes: z.number().int().min(1).max(525_600), timezone: ScheduleTimezoneSchema }).strict(),
]);
export type TaskScheduleInput = z.infer<typeof TaskScheduleInputSchema>;

export const ScheduledTaskCreateSchema = z.object({
  operationId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(32_000),
  schedule: TaskScheduleInputSchema,
  modelProviderId: z.string().trim().min(1).max(200).nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  reasoning: z.enum(["off", "low", "medium", "high", "xhigh"]).optional(),
}).strict();
export type ScheduledTaskCreate = z.infer<typeof ScheduledTaskCreateSchema>;

export const ScheduledTaskUpdateSchema = ScheduledTaskCreateSchema.omit({ operationId: true, workspaceId: true }).partial().extend({
  state: z.enum(["active", "paused"]).optional(),
}).strict().refine((input) => Object.keys(input).length > 0, "Provide at least one change");
export type ScheduledTaskUpdate = z.infer<typeof ScheduledTaskUpdateSchema>;

export const ScheduledTaskSchema = z.object({
  id: z.string().uuid(), tenantId: z.string().uuid(), userId: z.string().uuid(), workspaceId: z.string().uuid(),
  sourceTaskId: z.string().uuid().nullable(), name: z.string(), prompt: z.string(), schedule: TaskScheduleSchema,
  state: z.enum(["active", "paused", "completed"]), nextRunAt: z.string().datetime({ offset: true }).nullable(),
  lastRunAt: z.string().datetime({ offset: true }).nullable(), lastError: z.string().nullable(),
  modelProviderId: z.string().nullable(), model: z.string().nullable(), reasoning: z.enum(["off", "low", "medium", "high", "xhigh"]),
  createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
});
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

export const ScheduledTaskRunSchema = z.object({
  id: z.string().uuid(), scheduleId: z.string().uuid(), scheduledAt: z.string().datetime({ offset: true }),
  trigger: z.enum(["scheduled", "manual"]), state: z.enum(["pending", "dispatching", "admitted", "failed", "skipped"]),
  taskId: z.string().uuid().nullable(), sessionId: z.string().uuid().nullable(), turnId: z.string().uuid().nullable(),
  turnState: z.string().nullable(), error: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }), finishedAt: z.string().datetime({ offset: true }).nullable(),
});
export type ScheduledTaskRun = z.infer<typeof ScheduledTaskRunSchema>;
