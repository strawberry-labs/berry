import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BullMqBerryQueueClient, createBerryQueue } from "./bullmq.js";
import {
  ContextBackfillJobPayloadSchema,
  RetentionCleanupJobPayloadSchema,
} from "./jobs.js";
import { PgSqlExecutor } from "./pg-executor.js";

const UuidSchema = z.string().uuid();

export async function runMaintenanceCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const tenantId = UuidSchema.parse(required(args, "tenant"));
  if (command === "status" || command === "cancel") {
    const runId = UuidSchema.parse(required(args, "run"));
    const databaseUrl = env.BERRY_DATABASE_URL ?? env.DATABASE_URL;
    if (!databaseUrl) throw new Error("BERRY_DATABASE_URL or DATABASE_URL is required");
    const executor = PgSqlExecutor.fromConnectionString(databaseUrl);
    try {
      if (command === "cancel") {
        await executor.transaction!(async (transaction) => {
          await transaction.execute("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
          await transaction.execute(`
            UPDATE maintenance_runs
            SET status = 'cancelled', completed_at = now(), updated_at = now()
            WHERE tenant_id = $1::uuid AND id = $2::uuid
              AND status NOT IN ('completed','cancelled')
          `, [tenantId, runId]);
        });
      }
      const rows = await executor.transaction!(async (transaction) => {
        await transaction.execute("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
        return transaction.query<Record<string, unknown>>(`
          SELECT id, kind, status, cursor, scanned_count, changed_count,
                 enqueued_count, failure_count, last_error,
                 started_at, completed_at, updated_at
          FROM maintenance_runs
          WHERE tenant_id = $1::uuid AND id = $2::uuid
        `, [tenantId, runId]);
      });
      if (!rows[0]) throw new Error("Maintenance run not found");
      console.log(JSON.stringify(rows[0], null, 2));
    } finally {
      await executor.close();
    }
    return;
  }
  if (command !== "backfill" && command !== "verify_file_blobs" && command !== "cleanup") {
    throw new Error("Usage: maintenance <backfill|verify_file_blobs|cleanup|status|cancel> --tenant <uuid> [--run <uuid>] [--batch <10-500>]");
  }
  const runId = UuidSchema.parse(args.run ?? randomUUID());
  const batchSize = numberArg(args.batch, 100);
  const requestedByUserId = args["requested-by"] ? UuidSchema.parse(args["requested-by"]) : undefined;
  const redisUrl = env.BERRY_REDIS_URL ?? env.REDIS_URL;
  const queue = new BullMqBerryQueueClient(createBerryQueue(redisUrl ? { redisUrl } : {}));
  try {
    if (command === "backfill" || command === "verify_file_blobs") {
      const payload = ContextBackfillJobPayloadSchema.parse({
        tenantId,
        runId,
        generation: 0,
        batchSize,
        ...(command === "verify_file_blobs" ? { phase: "verify_file_blobs" } : {}),
        ...(requestedByUserId ? { requestedByUserId } : {}),
      });
      await queue.enqueue("context.backfill", payload);
    } else {
      const payload = RetentionCleanupJobPayloadSchema.parse({
        tenantId,
        runId,
        generation: 0,
        batchSize,
        eventRetentionDays: numberArg(args["event-days"], 30),
        diagnosticRetentionDays: numberArg(args["diagnostic-days"], 30),
        outboxRetentionDays: numberArg(args["outbox-days"], 7),
        ...(requestedByUserId ? { requestedByUserId } : {}),
      });
      await queue.enqueue("context.cleanup", payload);
    }
    console.log(JSON.stringify({ runId, tenantId, command, status: "queued" }));
  } finally {
    await queue.close();
  }
}

function parseArgs(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${token ?? ""}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    result[token.slice(2)] = value;
    index += 1;
  }
  return result;
}

function required(args: Record<string, string>, key: string): string {
  const value = args[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function numberArg(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected an integer, received ${value}`);
  return parsed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMaintenanceCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
