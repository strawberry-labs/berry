import { createHash } from "node:crypto";
import {
  operationToPersonalMemoryInput,
  type PersonalMemoryProvider,
} from "@berry/personal-memory";
import {
  MemoryOperationSchema,
  normalizeMemoryStableKey,
} from "@berry/shared";
import type { ChatContentPart, ChatToolDefinition } from "@berry/router-client";
import { z } from "zod";
import type {
  DurableToolPolicy,
  DurableTurnSnapshot,
  DurableTurnStep,
  DurableTurnToolExecutor,
  TurnToolResult,
} from "../turn-runner.js";
import type { SqlWorkerMemoryRepository } from "./repository.js";

const RememberMemoryInputSchema = z.object({
  kind: z.string().trim().min(1).max(80),
  stable_key: z.string().trim().min(1).max(240).optional(),
  content: z.string().trim().min(1).max(20_000),
  value: z.record(z.unknown()).optional(),
  expires_at: z.string().datetime().nullable().optional(),
}).strict();

const ForgetMemoryInputSchema = z.object({
  memory_id: z.string().trim().min(1).optional(),
  stable_key: z.string().trim().min(1).max(240).optional(),
}).strict().refine(
  (input) => Boolean(input.memory_id || input.stable_key),
  "forget_memory requires memory_id or stable_key",
);

const PERSONAL_MEMORY_TOOL_DEFINITIONS: readonly ChatToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "remember_memory",
      description: "Store a durable personal fact or preference for this user across chats. Use this when the user explicitly asks you to remember something. Never store credentials, secrets, copied documents, or temporary task details.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "content"],
        properties: {
          kind: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description: "A short category such as profile, preference, relationship, or accessibility.",
          },
          stable_key: {
            type: "string",
            minLength: 1,
            maxLength: 240,
            description: "A stable semantic key for later updates, such as profile:company-role.",
          },
          content: { type: "string", minLength: 1, maxLength: 20_000 },
          value: { type: "object", additionalProperties: true },
          expires_at: {
            type: "string",
            format: "date-time",
            description: "Optional expiry time for a non-permanent memory. Omit this field for no expiry.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_memory",
      description: "Forget one durable personal memory for this user. Use a memory id when known, otherwise use its exact stable key.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          memory_id: { type: "string", minLength: 1 },
          stable_key: { type: "string", minLength: 1, maxLength: 240 },
        },
        anyOf: [
          { required: ["memory_id"] },
          { required: ["stable_key"] },
        ],
      },
    },
  },
];

export class DurablePersonalMemoryToolExecutor implements DurableTurnToolExecutor {
  constructor(
    private readonly base: DurableTurnToolExecutor,
    private readonly repository: SqlWorkerMemoryRepository,
    private readonly personalMemory: PersonalMemoryProvider | null,
    private readonly globallyEnabled = true,
  ) {}

  async definitions(snapshot: DurableTurnSnapshot): Promise<readonly ChatToolDefinition[]> {
    const inherited = await this.base.definitions?.(snapshot) ?? [];
    return await this.enabled(snapshot)
      ? [...inherited, ...PERSONAL_MEMORY_TOOL_DEFINITIONS]
      : inherited;
  }

  async modelContent(
    snapshot: DurableTurnSnapshot,
    signal?: AbortSignal,
    reportProgress?: () => void,
  ): Promise<readonly ChatContentPart[]> {
    return this.base.modelContent?.(snapshot, signal, reportProgress) ?? [];
  }

  async stageAssociatedInputFiles(
    snapshot: DurableTurnSnapshot,
    fileIds: readonly string[],
    options?: { signal?: AbortSignal | undefined; reportProgress?: (() => void) | undefined },
  ) {
    return this.base.stageAssociatedInputFiles?.(snapshot, fileIds, options) ?? [];
  }

  readSkillPackage(snapshot: DurableTurnSnapshot, path: string) {
    if (!this.base.readSkillPackage) throw new Error("Skill package workspace access is unavailable");
    return this.base.readSkillPackage(snapshot, path);
  }

  stageSkillPackage(
    snapshot: DurableTurnSnapshot,
    packageId: string,
    files: Parameters<NonNullable<DurableTurnToolExecutor["stageSkillPackage"]>>[2],
    options?: Parameters<NonNullable<DurableTurnToolExecutor["stageSkillPackage"]>>[3],
  ) {
    if (!this.base.stageSkillPackage) throw new Error("Skill package workspace access is unavailable");
    return this.base.stageSkillPackage(snapshot, packageId, files, options);
  }

  async finalize(snapshot: DurableTurnSnapshot): Promise<readonly TurnToolResult[]> {
    return this.base.finalize?.(snapshot) ?? [];
  }

  policy(
    snapshot: DurableTurnSnapshot,
    toolName: string,
    permissionMode: string,
  ): DurableToolPolicy | undefined {
    if (toolName === "remember_memory" || toolName === "forget_memory") {
      return {
        retryClass: "idempotent_with_key",
        repeatPolicy: "block_after_success",
        requiresApproval: false,
        approvalKind: "file-edit",
      };
    }
    return this.base.policy?.(snapshot, toolName, permissionMode);
  }

  supportsAbort(snapshot: DurableTurnSnapshot, step: DurableTurnStep): boolean {
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName === "remember_memory" || toolName === "forget_memory") return false;
    return this.base.supportsAbort?.(snapshot, step) === true;
  }

  async execute(
    snapshot: DurableTurnSnapshot,
    step: DurableTurnStep,
    signal?: AbortSignal,
    reportProgress?: () => void,
  ): Promise<TurnToolResult> {
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName !== "remember_memory" && toolName !== "forget_memory") {
      return signal || reportProgress
        ? this.base.execute(snapshot, step, signal, reportProgress)
        : this.base.execute(snapshot, step);
    }
    if (!await this.enabled(snapshot)) {
      throw new Error("Personal memory is disabled for this user");
    }
    if (!this.personalMemory) {
      throw new Error("The personal memory provider is not configured");
    }
    if (toolName === "remember_memory") {
      return this.remember(snapshot, step);
    }
    return this.forget(snapshot, step);
  }

  private async enabled(snapshot: DurableTurnSnapshot): Promise<boolean> {
    if (!this.globallyEnabled || !this.personalMemory) return false;
    const settings = await this.repository.settings(snapshot.tenantId, snapshot.userId);
    return settings.memoryEnabled;
  }

  private async remember(
    snapshot: DurableTurnSnapshot,
    step: DurableTurnStep,
  ): Promise<TurnToolResult> {
    const input = RememberMemoryInputSchema.parse(step.input.arguments ?? {});
    const operation = MemoryOperationSchema.parse({
      operation: "ADD",
      stableKey: normalizedOrDerivedKey(input.stable_key, input.kind, input.content),
      kind: input.kind,
      content: input.content,
      value: input.value ?? {},
      confidence: 1,
      salience: 0.9,
      explicit: true,
      targetItemId: null,
      expiresAt: input.expires_at ?? null,
      reason: "explicit_user_memory",
    });
    const result = await this.personalMemory!.remember(operationToPersonalMemoryInput(
      { tenantId: snapshot.tenantId, userId: snapshot.userId },
      operation,
      {
        actorUserId: snapshot.userId,
        taskId: snapshot.taskId,
        sessionId: snapshot.sessionId,
        messageId: snapshot.requestMessageId,
        extractorVersion: "explicit-v1",
      },
    ));
    return {
      output: {
        operation: result.operation,
        reason: result.reason,
        memoryId: result.item?.id ?? null,
        stored: result.operation !== "NOOP" || result.item !== null,
      },
      summary: result.item
        ? `Personal memory ${result.operation.toLocaleLowerCase()}`
        : "Personal memory was not stored",
    };
  }

  private async forget(
    snapshot: DurableTurnSnapshot,
    step: DurableTurnStep,
  ): Promise<TurnToolResult> {
    const input = ForgetMemoryInputSchema.parse(step.input.arguments ?? {});
    const memoryId = input.memory_id ?? await this.memoryIdForStableKey(snapshot, input.stable_key!);
    if (!memoryId) {
      return {
        output: { forgotten: false, memoryId: null },
        summary: "No active matching personal memory was found",
      };
    }
    const forgotten = await this.personalMemory!.forget(
      { tenantId: snapshot.tenantId, userId: snapshot.userId },
      memoryId,
    );
    return {
      output: { forgotten: Boolean(forgotten), memoryId: forgotten?.id ?? null },
      summary: forgotten
        ? "Personal memory forgotten"
        : "No active matching personal memory was found",
    };
  }

  private async memoryIdForStableKey(
    snapshot: DurableTurnSnapshot,
    stableKey: string,
  ): Promise<string | null> {
    const normalized = normalizeMemoryStableKey(stableKey);
    let cursor: string | undefined;
    do {
      const page = await this.personalMemory!.list({
        tenantId: snapshot.tenantId,
        userId: snapshot.userId,
        status: "active",
        search: normalized,
        ...(cursor ? { cursor } : {}),
        limit: 100,
      });
      const match = page.items.find((item) => item.stableKey === normalized);
      if (match) return match.id;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return null;
  }
}

function normalizedOrDerivedKey(value: string | undefined, kind: string, content: string): string {
  const normalized = normalizeMemoryStableKey(value ?? "");
  if (normalized) return normalized;
  const hash = createHash("sha256").update(content.trim().toLocaleLowerCase()).digest("hex");
  return `${normalizeMemoryStableKey(kind) || "memory"}:${hash.slice(0, 24)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
