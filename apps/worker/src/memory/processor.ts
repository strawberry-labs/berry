import type { MemoryExtractJobPayload } from "../jobs.js";
import type { MemoryOperationGenerator } from "./generator.js";
import { SqlWorkerMemoryRepository } from "./repository.js";

export class MemoryProcessor {
  constructor(
    private readonly repository: SqlWorkerMemoryRepository,
    private readonly generator: MemoryOperationGenerator | null,
  ) {}

  async process(payload: MemoryExtractJobPayload): Promise<{ applied: number; noops: number; degraded?: boolean }> {
    if (!this.generator) return { applied: 0, noops: 0, degraded: true };
    const operations = await this.generator.generate(payload);
    return this.repository.apply(payload, operations);
  }
}
