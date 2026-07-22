import { describe, expect, it, vi } from "vitest";
import { AuditService, InMemoryAuditRepository, S3AuditExportDispatcher } from "./audit.service.ts";

describe("AuditService", () => {
  it("exports audit events to an S3-compatible drop with deterministic metadata", async () => {
    const send = vi.fn(async () => ({}));
    const repository = new InMemoryAuditRepository();
    const service = new AuditService(repository, new S3AuditExportDispatcher({ send }, { bucket: "berry-audit", prefix: "siem" }));
    const tenantId = "00000000-0000-7000-8000-000000000001";

    await service.append({ tenantId, category: "policy", action: "published", targetType: "policy_version", targetId: "1", metadata: { ok: true } });
    const config = await service.upsertExportConfig(tenantId, "00000000-0000-7000-8000-000000000201", {
      kind: "s3",
      destination: "s3://berry-audit/siem",
      format: "json",
    });
    const { result } = await service.export(tenantId, { format: "json", configId: config.id });

    expect(result).toMatchObject({ kind: "s3", delivered: true, chainValid: true, destination: expect.stringContaining("s3://berry-audit/siem/") });
    expect(send).toHaveBeenCalledTimes(1);
    const calls = send.mock.calls as unknown[][];
    const command = calls[0]?.[0] as { input?: { Bucket?: string; Key?: string; Metadata?: Record<string, string> } };
    expect(command.input).toMatchObject({
      Bucket: "berry-audit",
      Metadata: { tenant_id: tenantId, audit_export_config_id: config.id },
    });
    expect(command.input?.Key).toMatch(/^siem\/00000000-0000-7000-8000-000000000001\//);
  });
});
