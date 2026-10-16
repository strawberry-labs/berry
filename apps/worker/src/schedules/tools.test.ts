import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlScheduledTaskRepository } from "@berry/db";
import type { ScheduledTask } from "@berry/shared";
import { DURABLE_TOOL_DEFINITIONS, type DurableTurnSnapshot, type DurableTurnStep } from "../turn-runner.ts";
import { DurableScheduledTaskToolExecutor, scheduledTaskToolDefinitions } from "./tools.ts";

// Google's FunctionDeclaration.parameters uses this Schema field set:
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/Schema
const googleSchemaFields = new Set([
  "type", "format", "title", "description", "nullable", "default", "items",
  "minItems", "maxItems", "enum", "properties", "propertyOrdering", "required",
  "minProperties", "maxProperties", "minimum", "maximum", "minLength", "maxLength",
  "pattern", "example", "anyOf", "additionalProperties", "ref", "defs",
]);

function expectGoogleSchema(schema: Record<string, unknown>): void {
  expect(Object.keys(schema).filter((key) => !googleSchemaFields.has(key))).toEqual([]);
  for (const key of ["properties", "defs"]) {
    const children = schema[key] as Record<string, Record<string, unknown>> | undefined;
    for (const child of Object.values(children ?? {})) expectGoogleSchema(child);
  }
  for (const key of ["items", "additionalProperties"]) {
    const child = schema[key];
    if (child && typeof child === "object") expectGoogleSchema(child as Record<string, unknown>);
  }
  for (const child of (schema.anyOf ?? []) as Record<string, unknown>[]) expectGoogleSchema(child);
}

const snapshot = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  workspaceId: "00000000-0000-4000-8000-000000000003",
  taskId: "00000000-0000-4000-8000-000000000004",
  runtimeRequest: {},
} as DurableTurnSnapshot;
const scheduleId = "00000000-0000-4000-8000-000000000005";
const timezone = "Asia/Dubai";
const validSchedules = [
  { kind: "cron", timezone, expression: "0 9 * * 1-5" },
  { kind: "once", timezone, runAt: "2099-01-01T09:00:00+04:00" },
  { kind: "delay", timezone, minutes: 20 },
];
const invalidSchedules = [
  { kind: "cron", timezone },
  { kind: "once", timezone, runAt: "tomorrow" },
  { kind: "delay", timezone, minutes: 0 },
  { kind: "cron", timezone, expression: "0 9 * * *", runAt: "2099-01-01T09:00:00+04:00" },
  { kind: "once", timezone, runAt: "2099-01-01T09:00:00+04:00", minutes: 20 },
  { kind: "delay", timezone, minutes: 20, expression: "0 9 * * *" },
  { kind: "cron", timezone: "Not/A-Timezone", expression: "0 9 * * *" },
];
const saved: ScheduledTask = {
  id: scheduleId, tenantId: snapshot.tenantId, userId: snapshot.userId,
  workspaceId: snapshot.workspaceId, sourceTaskId: snapshot.taskId,
  name: "Daily news", prompt: "Find today's news",
  schedule: { kind: "cron", timezone, expression: "0 9 * * 1-5" },
  state: "active", nextRunAt: "2099-01-01T05:00:00.000Z", lastRunAt: null,
  lastError: null, modelProviderId: null, model: null, reasoning: "off",
  createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.000Z",
};

function fixture(name: string, args: Record<string, unknown>) {
  const sql = { execute: vi.fn(async () => undefined), query: vi.fn(async () => []) };
  const base = { execute: vi.fn(async () => ({ output: {}, summary: "base" })) };
  const executor = new DurableScheduledTaskToolExecutor(base, sql);
  const step: DurableTurnStep = {
    id: "00000000-0000-4000-8000-000000000006",
    sequence: 1,
    type: `tool.${name}`,
    state: "pending",
    input: { toolName: name, arguments: args },
    output: null,
    retryClass: null,
    idempotencyKey: null,
    attempt: 0,
    error: null,
  };
  return { executor, sql, base, step };
}

afterEach(() => vi.restoreAllMocks());

describe("built-in tool Google compatibility", () => {
  it.each(DURABLE_TOOL_DEFINITIONS)("$function.name uses only Google Schema fields", (definition) => {
    expectGoogleSchema(definition.function.parameters as Record<string, unknown>);
  });
});

describe("scheduled task tool schemas", () => {
  it.each(scheduledTaskToolDefinitions(timezone))("$function.name uses only Google Schema fields", (definition) => {
    expectGoogleSchema(definition.function.parameters as Record<string, unknown>);
  });

  for (const name of ["create_scheduled_task", "update_scheduled_task"]) {
    const args = (schedule: Record<string, unknown>) => name === "create_scheduled_task"
      ? { name: "Daily news", prompt: "Find today's news", schedule }
      : { id: scheduleId, changes: { schedule } };

    it.each(validSchedules)(`${name} accepts valid $kind schedules with server validation`, async (schedule) => {
      const create = vi.spyOn(SqlScheduledTaskRepository.prototype, "create").mockResolvedValue(saved);
      const update = vi.spyOn(SqlScheduledTaskRepository.prototype, "update").mockResolvedValue(saved);
      const { executor, step } = fixture(name, args(schedule));
      await expect(executor.execute(snapshot, step)).resolves.toMatchObject({ output: { scheduledTask: saved } });
      const scope = { tenantId: snapshot.tenantId, userId: snapshot.userId };
      if (name === "create_scheduled_task") {
        expect(create).toHaveBeenCalledWith(scope, expect.objectContaining({ schedule, operationId: step.id, workspaceId: snapshot.workspaceId }), snapshot.taskId);
        expect(update).not.toHaveBeenCalled();
      } else {
        expect(update).toHaveBeenCalledWith(scope, scheduleId, { schedule }, step.id);
        expect(create).not.toHaveBeenCalled();
      }
    });

    it.each(invalidSchedules)(`${name} rejects invalid $kind schedules before accessing storage`, async (schedule) => {
      const { executor, step, sql, base } = fixture(name, args(schedule));
      await expect(executor.execute(snapshot, step)).rejects.toMatchObject({ name: "ZodError" });
      expect(sql.execute).not.toHaveBeenCalled();
      expect(sql.query).not.toHaveBeenCalled();
      expect(base.execute).not.toHaveBeenCalled();
    });
  }
});
