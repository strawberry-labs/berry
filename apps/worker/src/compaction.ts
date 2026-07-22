import type { CompactionJobPayload } from "./jobs.js";

export interface CompactionJobResult {
  sessionId: string;
  summary: string;
  tokensBefore: number;
  tokensAfter?: number | undefined;
}

export interface SessionCompactionRunner {
  compactSession(input: CompactionJobPayload): Promise<CompactionJobResult>;
}

export async function processCompactionJob(
  payload: CompactionJobPayload,
  dependencies: { compactor: SessionCompactionRunner },
): Promise<CompactionJobResult> {
  return dependencies.compactor.compactSession(payload);
}
