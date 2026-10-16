import { SqlScheduledTaskRepository, type ScheduledTaskSqlExecutor } from "@berry/db";
import { DurableTurnRuntimeRequestSchema, ScheduledTaskCreateSchema, ScheduledTaskUpdateSchema, type JsonValue } from "@berry/shared";
import type { ChatToolDefinition } from "@berry/router-client";
import { z } from "zod";
import type { DurableTurnSnapshot, DurableTurnStep, DurableTurnToolExecutor, DurableToolPolicy, TurnToolResult } from "../turn-runner.ts";

const IdInput = z.object({ id: z.string().uuid() }).strict();
const CreateInput = ScheduledTaskCreateSchema.omit({ operationId: true, workspaceId: true });
const UpdateInput = z.object({ id: z.string().uuid(), changes: ScheduledTaskUpdateSchema }).strict();
const TOOL_NAMES = new Set(["create_scheduled_task", "list_scheduled_tasks", "update_scheduled_task", "delete_scheduled_task"]);
const scheduleProperties = {
  kind: { type: "string", enum: ["cron", "once", "delay"] },
  timezone: { type: "string", description: "IANA timezone, e.g. Asia/Dubai. Interpret cron in this timezone; never convert it to UTC." },
  expression: { type: "string", description: "Five-field cron for recurring work, e.g. 0 9 * * 1-5 for weekdays at 09:00. Only for kind=cron." },
  runAt: { type: "string", description: "Future ISO timestamp with an explicit UTC offset for kind=once." },
  minutes: { type: "integer", minimum: 1, maximum: 525600, description: "Delay from the real server clock for kind=delay. For 'in 20 minutes' use 20; never calculate a clock time yourself." },
};
const scheduleParameter = {
  type: "object", additionalProperties: false, required: ["kind", "timezone"], properties: scheduleProperties,
  oneOf: [
    { properties: { kind: { const: "cron" } }, required: ["expression"], not: { anyOf: [{ required: ["runAt"] }, { required: ["minutes"] }] } },
    { properties: { kind: { const: "once" } }, required: ["runAt"], not: { anyOf: [{ required: ["expression"] }, { required: ["minutes"] }] } },
    { properties: { kind: { const: "delay" } }, required: ["minutes"], not: { anyOf: [{ required: ["expression"] }, { required: ["runAt"] }] } },
  ],
};
const taskProperties = {
  name: { type: "string", maxLength: 120, description: "Concise name describing the recurring work." },
  prompt: { type: "string", maxLength: 32000, description: "Complete instructions to execute in a new chat on each run. Include the needed context, sources, and desired output. Describe the actual work, without instructions to schedule it again." },
  schedule: scheduleParameter,
};

/** The same owner-scoped repository powers chat tools and the schedule UI. */
export class DurableScheduledTaskToolExecutor implements DurableTurnToolExecutor {
  private readonly repository: SqlScheduledTaskRepository;
  constructor(private readonly base: DurableTurnToolExecutor, executor: ScheduledTaskSqlExecutor) {
    this.repository = new SqlScheduledTaskRepository(executor);
  }
  async definitions(snapshot: DurableTurnSnapshot): Promise<readonly ChatToolDefinition[]> {
    const inherited = await this.base.definitions?.(snapshot) ?? [];
    const runtime = DurableTurnRuntimeRequestSchema.safeParse(snapshot.runtimeRequest);
    const timezone = runtime.success ? runtime.data.timezone : undefined;
    return [...inherited, ...scheduledTaskToolDefinitions(timezone)];
  }
  modelContent(...args: Parameters<NonNullable<DurableTurnToolExecutor["modelContent"]>>) { return this.base.modelContent?.(...args) ?? Promise.resolve([]); }
  stageAssociatedInputFiles(...args: Parameters<NonNullable<DurableTurnToolExecutor["stageAssociatedInputFiles"]>>) { return this.base.stageAssociatedInputFiles?.(...args) ?? Promise.resolve([]); }
  readSkillPackage(...args: Parameters<NonNullable<DurableTurnToolExecutor["readSkillPackage"]>>) {
    if (!this.base.readSkillPackage) throw new Error("Skill package access is unavailable");
    return this.base.readSkillPackage(...args);
  }
  stageSkillPackage(...args: Parameters<NonNullable<DurableTurnToolExecutor["stageSkillPackage"]>>) {
    if (!this.base.stageSkillPackage) throw new Error("Skill package access is unavailable");
    return this.base.stageSkillPackage(...args);
  }
  release(snapshot: DurableTurnSnapshot) { return this.base.release?.(snapshot) ?? Promise.resolve(); }
  finalize(snapshot: DurableTurnSnapshot) { return this.base.finalize?.(snapshot) ?? Promise.resolve([]); }
  supportsModelPreparationAbort(snapshot: DurableTurnSnapshot) { return this.base.supportsModelPreparationAbort?.(snapshot) === true; }
  supportsAbort(snapshot: DurableTurnSnapshot, step: DurableTurnStep) {
    return TOOL_NAMES.has(toolName(step)) ? false : this.base.supportsAbort?.(snapshot, step) === true;
  }
  policy(snapshot: DurableTurnSnapshot, name: string, permissionMode: string): DurableToolPolicy | undefined {
    if (!TOOL_NAMES.has(name)) return this.base.policy?.(snapshot, name, permissionMode);
    return { retryClass: name === "list_scheduled_tasks" ? "read_only" : "idempotent_with_key",
      repeatPolicy: name === "list_scheduled_tasks" ? "compare_result" : "block_after_success", requiresApproval: false, approvalKind: "file-edit" };
  }
  async execute(snapshot: DurableTurnSnapshot, step: DurableTurnStep, signal?: AbortSignal, reportProgress?: () => void): Promise<TurnToolResult> {
    const name = toolName(step);
    if (!TOOL_NAMES.has(name)) return this.base.execute(snapshot, step, signal, reportProgress);
    const scope = { tenantId: snapshot.tenantId, userId: snapshot.userId };
    const args = step.input.arguments ?? {};
    if (name === "list_scheduled_tasks") {
      z.object({}).strict().parse(args);
      const schedules = await this.repository.list(scope);
      return result({ schedules }, `Found ${schedules.length} scheduled task${schedules.length === 1 ? "" : "s"}`);
    }
    if (name === "create_scheduled_task") {
      const input = CreateInput.parse(args);
      const runtime = DurableTurnRuntimeRequestSchema.safeParse(snapshot.runtimeRequest);
      const task = await this.repository.create(scope, {
        ...input, operationId: step.id, workspaceId: snapshot.workspaceId,
        modelProviderId: input.modelProviderId ?? (runtime.success ? runtime.data.providerId : null),
        model: input.model ?? (runtime.success ? runtime.data.model : null),
        reasoning: input.reasoning ?? (runtime.success && ["off", "low", "medium", "high", "xhigh"].includes(runtime.data.reasoning)
          ? runtime.data.reasoning as "off" | "low" | "medium" | "high" | "xhigh" : "off"),
      }, snapshot.taskId);
      return result({ scheduledTask: task, url: "/settings/schedules" }, `Scheduled “${task.name}” for ${task.nextRunAt} (${task.schedule.timezone})`);
    }
    if (name === "update_scheduled_task") {
      const input = UpdateInput.parse(args);
      const task = await this.repository.update(scope, input.id, input.changes, step.id);
      return result({ scheduledTask: task, url: "/settings/schedules" }, `${task.state === "paused" ? "Paused" : "Updated"} “${task.name}”`);
    }
    const input = IdInput.parse(args);
    return result(await this.repository.remove(scope, input.id, step.id), "Deleted scheduled task");
  }
}
export function scheduledTaskToolDefinitions(timezone?: string): ChatToolDefinition[] {
  return [
    { type: "function", function: { name: "create_scheduled_task",
      description: `Create a persistent scheduled task when the user asks for a reminder, a future task, monitoring, or recurring work. The server wakes the agent even with the browser closed and creates a fresh chat for each run. Use relative delay for 'in N minutes'. ${timezone ? `The current user's timezone is ${timezone}.` : "Ask for the user's timezone before setting a local recurring time if it is not known."} Explain the saved schedule and next run after success.`,
      parameters: { type: "object", additionalProperties: false, required: ["name", "prompt", "schedule"], properties: taskProperties } } },
    { type: "function", function: { name: "list_scheduled_tasks", description: "List the signed-in user's scheduled tasks before inspecting, updating, pausing, or deleting one. Never invent a schedule ID.", parameters: { type: "object", additionalProperties: false, properties: {} } } },
    { type: "function", function: { name: "update_scheduled_task", description: "Edit, pause, or resume an existing scheduled task when the user requests it. Use its ID from list_scheduled_tasks. Changes affect future runs; already dispatched chats continue. A completed one-time task needs a new future schedule to restart.",
      parameters: { type: "object", additionalProperties: false, required: ["id", "changes"], properties: { id: { type: "string", format: "uuid" }, changes: { type: "object", additionalProperties: false, properties: { ...taskProperties, state: { type: "string", enum: ["active", "paused"] } } } } } } },
    { type: "function", function: { name: "delete_scheduled_task", description: "Delete an existing schedule only when the user asks. Existing chats and results remain available.", parameters: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", format: "uuid" } } } } },
  ];
}
function toolName(step: DurableTurnStep): string { return typeof step.input.toolName === "string" ? step.input.toolName : step.type.slice(5); }
function result(output: unknown, summary: string): TurnToolResult { return { output: output as JsonValue, summary }; }
