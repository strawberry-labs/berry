import type {
  SandboxCreateInput,
  SandboxDestroyInput,
  SandboxDestroyResult,
  SandboxExecEvent,
  SandboxExecInput,
  SandboxExposePortInput,
  SandboxExposePortResult,
  SandboxFileApi,
  SandboxFileListInput,
  SandboxFileListResult,
  SandboxFileReadInput,
  SandboxFileReadResult,
  SandboxFileWriteInput,
  SandboxFileWriteResult,
  SandboxHandle,
  SandboxProvider,
  SandboxUsageEvent,
} from "@berry/sandbox-contract";
import type { JsonValue } from "@berry/shared";
import type { BudgetService } from "./budget.service.ts";

type BudgetEstimateMicros = bigint | number | string;

export type BudgetedSandboxProviderOptions = {
  provider: SandboxProvider;
  budgets: BudgetService;
  estimates?: {
    createMicros?: BudgetEstimateMicros | undefined;
    execMicros?: BudgetEstimateMicros | undefined;
    fileMicros?: BudgetEstimateMicros | undefined;
    portMicros?: BudgetEstimateMicros | undefined;
  } | undefined;
};

export class BudgetedSandboxProvider implements SandboxProvider {
  readonly kind: SandboxProvider["kind"];
  readonly files: SandboxFileApi;
  readonly #provider: SandboxProvider;
  readonly #budgets: BudgetService;
  readonly #estimates: {
    createMicros: BudgetEstimateMicros;
    execMicros: BudgetEstimateMicros;
    fileMicros: BudgetEstimateMicros;
    portMicros: BudgetEstimateMicros;
  };
  readonly #sandboxes = new Map<string, { tenantId: string; taskId: string | null; sessionId: string | null; provider: string }>();

  constructor(options: BudgetedSandboxProviderOptions) {
    this.#provider = options.provider;
    this.#budgets = options.budgets;
    this.kind = options.provider.kind;
    this.#estimates = {
      createMicros: options.estimates?.createMicros ?? 50,
      execMicros: options.estimates?.execMicros ?? 25,
      fileMicros: options.estimates?.fileMicros ?? 5,
      portMicros: options.estimates?.portMicros ?? 5,
    };
    this.files = {
      read: (input) => this.#budgetFile("sandbox.file.read", input.sandbox_id, input, () => this.#provider.files.read(input)),
      write: (input) => this.#budgetFile("sandbox.file.write", input.sandbox_id, input, () => this.#provider.files.write(input)),
      list: (input) => this.#budgetFile("sandbox.file.list", input.sandbox_id, input, () => this.#provider.files.list(input)),
    };
  }

  async create(input: SandboxCreateInput): Promise<SandboxHandle> {
    const requestId = `sandbox_create_${input.request_id}`;
    const estimatedCostMicros = toMicros(this.#estimates.createMicros);
    await this.#budgets.reserve({
      tenantId: input.tenant_id,
      requestId,
      userId: null,
      departmentId: null,
      taskId: input.task_id ?? null,
      sessionId: input.session_id ?? null,
      feature: "sandbox.create",
      provider: this.#provider.kind,
      model: input.image,
      estimatedCostMicros,
      estimatedSandboxMinutes: 1,
      metadata: { image: input.image, ttlSeconds: input.ttl_seconds ?? null },
    });
    try {
      const sandbox = await this.#provider.create(input);
      this.#sandboxes.set(sandbox.sandbox_id, {
        tenantId: sandbox.tenant_id,
        taskId: input.task_id ?? null,
        sessionId: input.session_id ?? null,
        provider: sandbox.provider,
      });
      await this.#budgets.reconcile({ tenantId: input.tenant_id, requestId, actualCostMicros: estimatedCostMicros });
      return sandbox;
    } catch (error) {
      await this.#budgets.reconcile({ tenantId: input.tenant_id, requestId, actualCostMicros: 0n });
      throw error;
    }
  }

  async *exec(input: SandboxExecInput, options: { signal?: AbortSignal | undefined } = {}): AsyncIterable<SandboxExecEvent> {
    const sandbox = this.#sandboxes.get(input.sandbox_id);
    const requestId = `sandbox_exec_${input.request_id}`;
    const tenantId = sandbox?.tenantId;
    const estimatedCostMicros = toMicros(this.#estimates.execMicros);
    let actualCostMicros = estimatedCostMicros;
    if (tenantId) {
      await this.#budgets.reserve({
        tenantId,
        requestId,
        userId: null,
        departmentId: null,
        taskId: sandbox.taskId,
        sessionId: sandbox.sessionId,
        feature: "sandbox.exec",
        provider: sandbox.provider,
        model: null,
        estimatedCostMicros,
        estimatedSandboxMinutes: 1,
        metadata: { command: input.command ?? null, language: input.language ?? null },
      });
    }
    try {
      for await (const event of this.#provider.exec(input, options)) {
        if (event.kind === "usage") actualCostMicros = sandboxUsageCostMicros(event.event, actualCostMicros);
        yield event;
      }
    } catch (error) {
      actualCostMicros = 0n;
      throw error;
    } finally {
      if (tenantId) {
        await this.#budgets.reconcile({ tenantId, requestId, actualCostMicros });
      }
    }
  }

  async exposePort(input: SandboxExposePortInput): Promise<SandboxExposePortResult> {
    return this.#budgetFile("sandbox.expose_port", input.sandbox_id, input, () => this.#provider.exposePort(input), this.#estimates.portMicros);
  }

  async suspend(input: SandboxDestroyInput): Promise<SandboxDestroyResult> {
    try {
      return this.#provider.suspend ? await this.#provider.suspend(input) : await this.#provider.destroy(input);
    } finally {
      this.#sandboxes.delete(input.sandbox_id);
    }
  }

  async destroy(input: SandboxDestroyInput): Promise<SandboxDestroyResult> {
    try {
      return await this.#provider.destroy(input);
    } finally {
      this.#sandboxes.delete(input.sandbox_id);
    }
  }

  async dispose(): Promise<void> {
    await this.#provider.dispose?.();
  }

  async #budgetFile<T>(feature: string, sandboxId: string, input: unknown, run: () => Promise<T>, estimate = this.#estimates.fileMicros): Promise<T> {
    const sandbox = this.#sandboxes.get(sandboxId);
    if (!sandbox) return run();
    const requestId = `${feature.replaceAll(".", "_")}_${sandboxId}_${Date.now()}`;
    const estimatedCostMicros = toMicros(estimate);
    await this.#budgets.reserve({
      tenantId: sandbox.tenantId,
      requestId,
      userId: null,
      departmentId: null,
      taskId: sandbox.taskId,
      sessionId: sandbox.sessionId,
      feature,
      provider: sandbox.provider,
      model: null,
      estimatedCostMicros,
      estimatedSandboxMinutes: 1,
      metadata: jsonMetadata(input),
    });
    try {
      const result = await run();
      await this.#budgets.reconcile({ tenantId: sandbox.tenantId, requestId, actualCostMicros: estimatedCostMicros });
      return result;
    } catch (error) {
      await this.#budgets.reconcile({ tenantId: sandbox.tenantId, requestId, actualCostMicros: 0n });
      throw error;
    }
  }
}

function sandboxUsageCostMicros(event: SandboxUsageEvent, fallback: bigint): bigint {
  const minimum = event.provider_minimum_charge;
  if (!minimum) return fallback;
  if (/^\d+$/.test(minimum)) return BigInt(minimum);
  const numeric = Number(minimum);
  return Number.isFinite(numeric) && numeric >= 0 ? BigInt(Math.round(numeric * 1_000_000)) : fallback;
}

function toMicros(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.max(0, Math.trunc(value)));
  return BigInt(value);
}

function jsonMetadata(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as JsonValue;
}
