import { describe, expect, it } from "vitest";
import {
  SandboxCreateInputSchema,
  SandboxExecInputSchema,
  SandboxUsageEventSchema,
} from "./schemas.js";

const tenantId = "00000000-0000-7000-8000-000000000001";

describe("sandbox contract schemas", () => {
  it("normalizes create inputs with self-host-safe defaults", () => {
    expect(SandboxCreateInputSchema.parse({
      request_id: "req_1",
      tenant_id: tenantId,
      image: "berry/python:latest",
    })).toMatchObject({
      request_id: "req_1",
      tenant_id: tenantId,
      image: "berry/python:latest",
      cwd: "/workspace",
      ttl_seconds: 3600,
      network_policy: { egress: "off", allowedDomains: [] },
      writable_roots: ["/workspace"],
      mounts: [],
      resources: { cpuCount: 1, memoryMiB: 2048, storageMiB: 10_240 },
    });
  });

  it("requires exec inputs to provide exactly one command mode", () => {
    expect(() => SandboxExecInputSchema.parse({
      sandbox_id: "sandbox_1",
      request_id: "req_1",
      command: ["echo", "ok"],
      code: "print('ok')",
    })).toThrow("exactly one");
    expect(SandboxExecInputSchema.parse({
      sandbox_id: "sandbox_1",
      request_id: "req_1",
      code: "print('ok')",
      language: "python",
    })).toMatchObject({ code: "print('ok')", language: "python", timeout_ms: 120_000 });
  });

  it("locks the normalized signed usage fields from spec 04 section 6", () => {
    const event = SandboxUsageEventSchema.parse({
      request_id: "req_1",
      sandbox_id: "sandbox_1",
      tenant_id: tenantId,
      provider: "berry_box",
      status: "completed",
      price_version: "sandbox-prices-2026-07",
      runtime_ms: 1500,
      vcpu_seconds: 3,
      memory_gib_seconds: 6,
      storage_gib_seconds: 15,
      gpu_seconds: 0,
      windows_vcpu_seconds: 0,
      cpu_count: 2,
      cpu_used_pct: 25,
      mem_used_bytes: 128,
      mem_total_bytes: 256,
      disk_used_bytes: 512,
      disk_total_bytes: 1024,
      bytes_in: 10,
      bytes_out: 20,
      network_bytes: 30,
      provider_minimum_charge: "0.0001",
      ts: "2026-07-10T00:00:00.000Z",
    });

    expect(Object.keys(event)).toEqual(expect.arrayContaining([
      "runtime_ms",
      "vcpu_seconds",
      "memory_gib_seconds",
      "storage_gib_seconds",
      "gpu_seconds",
      "windows_vcpu_seconds",
      "cpu_count",
      "cpu_used_pct",
      "mem_used_bytes",
      "mem_total_bytes",
      "disk_used_bytes",
      "disk_total_bytes",
      "bytes_in",
      "bytes_out",
      "network_bytes",
      "provider_minimum_charge",
    ]));
  });
});
