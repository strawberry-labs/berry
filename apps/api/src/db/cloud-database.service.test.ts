import { Test } from "@nestjs/testing";
import { CLOUD_INITIAL_MIGRATION, SELF_HOST_TENANT_ID } from "@berry/db";
import { describe, expect, it } from "vitest";
import { CloudDatabaseModule } from "./cloud-database.module.js";
import { CloudDatabaseService, type SqlExecutor } from "./cloud-database.service.js";

class FakeExecutor implements SqlExecutor {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  appliedIds: number[] = [];
  transactionCount = 0;

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.calls.push({ sql, params });
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
    this.calls.push({ sql, params });
    if (sql.includes("SELECT id FROM schema_migrations")) {
      return this.appliedIds.map((id) => ({ id }) as T);
    }
    return [];
  }

  async transaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    return callback(this);
  }
}

describe("CloudDatabaseService", () => {
  it("runs unapplied cloud migrations and exposes the self-host tenant default", async () => {
    const executor = new FakeExecutor();
    const moduleRef = await Test.createTestingModule({
      imports: [CloudDatabaseModule.register({ useValue: executor })],
    }).compile();
    const service = moduleRef.get(CloudDatabaseService);

    await service.migrate();

    expect(service.selfHostTenantId).toBe(SELF_HOST_TENANT_ID);
    expect(executor.calls.map((call) => call.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CREATE TABLE IF NOT EXISTS schema_migrations"),
        expect.stringContaining("pg_advisory_xact_lock"),
        "SELECT id FROM schema_migrations",
        CLOUD_INITIAL_MIGRATION,
        "INSERT INTO schema_migrations (id, name) VALUES ($1, $2)",
      ]),
    );
    expect(executor.transactionCount).toBe(1);
  });

  it("skips already-applied migrations", async () => {
    const executor = new FakeExecutor();
    executor.appliedIds = [1];
    const moduleRef = await Test.createTestingModule({
      imports: [CloudDatabaseModule.register({ useValue: executor })],
    }).compile();

    await moduleRef.get(CloudDatabaseService).migrate();

    expect(executor.calls.map((call) => call.sql)).not.toContain(CLOUD_INITIAL_MIGRATION);
  });

  it("sets the tenant GUC inside the transaction before tenant-scoped work", async () => {
    const executor = new FakeExecutor();
    const moduleRef = await Test.createTestingModule({
      imports: [CloudDatabaseModule.register({ useValue: executor })],
    }).compile();

    const result = await moduleRef.get(CloudDatabaseService).withTenant(SELF_HOST_TENANT_ID, async (tenantExecutor) => {
      await tenantExecutor.execute("SELECT * FROM tasks");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(executor.transactionCount).toBe(1);
    expect(executor.calls[0]).toEqual({ sql: "SELECT berry_set_tenant_id($1::uuid)", params: [SELF_HOST_TENANT_ID] });
    expect(executor.calls[1]?.sql).toBe("SELECT * FROM tasks");
  });

  it("rejects invalid tenant ids before entering tenant-scoped work", async () => {
    const executor = new FakeExecutor();
    const moduleRef = await Test.createTestingModule({
      imports: [CloudDatabaseModule.register({ useValue: executor })],
    }).compile();

    await expect(moduleRef.get(CloudDatabaseService).withTenant("not-a-uuid", async () => "bad")).rejects.toThrow("Invalid tenant id");
    expect(executor.calls).toEqual([]);
  });
});
