import { describe, expect, it } from "vitest";
import { InMemoryManagementRepository } from "../management/management.service.ts";
import { organizationNetworkPolicy } from "./execution-network-policy.ts";

describe("organization network policy", () => {
  const fallback = { egress: "on" as const, allowedDomains: ["deployment.example.com"] };
  it("uses deployment defaults only until an organization policy is saved", async () => {
    const repo = new InMemoryManagementRepository();
    expect(organizationNetworkPolicy(await repo.getConfiguredExecution("tenant"), fallback)).toEqual(fallback);
    const policy = await repo.getExecution("tenant");
    await repo.setExecution("tenant", { ...policy, allowedDomains: ["connect.aesg.com", "s3.eu-west-1.amazonaws.com"] });
    expect(organizationNetworkPolicy(await repo.getConfiguredExecution("tenant"), fallback)).toEqual({ egress: "on", allowedDomains: ["connect.aesg.com", "s3.eu-west-1.amazonaws.com"] });
    expect(await repo.getConfiguredExecution("another-tenant")).toBeNull();
  });
  it("enforces blocked mode, empty allowlists, and explicit denials", async () => {
    const policy = await new InMemoryManagementRepository().getExecution("tenant");
    expect(organizationNetworkPolicy(policy, fallback)).toEqual({ egress: "off", allowedDomains: [] });
    expect(organizationNetworkPolicy({ ...policy, outboundNetwork: "blocked", allowedDomains: ["connect.aesg.com"] }, fallback)?.egress).toBe("off");
    expect(organizationNetworkPolicy({ ...policy, allowedDomains: ["a.example.com", "b.example.com"], blockedDomains: ["a.example.com"] }, fallback)).toEqual({ egress: "on", allowedDomains: ["b.example.com"] });
    expect(organizationNetworkPolicy({ ...policy, outboundNetwork: "unrestricted" }, fallback)).toEqual({ egress: "unrestricted", allowedDomains: [] });
  });
  it("rejects exclusions that the sandbox cannot enforce instead of widening access", async () => {
    const policy = await new InMemoryManagementRepository().getExecution("tenant");
    expect(() => organizationNetworkPolicy({ ...policy, allowedDomains: ["*.example.com"], blockedDomains: ["private.example.com"] }, fallback)).toThrow("Use explicit allowed hosts");
    expect(() => organizationNetworkPolicy({ ...policy, outboundNetwork: "unrestricted", blockedDomains: ["private.example.com"] }, fallback)).toThrow("Blocked domains require allowlist mode");
  });
});
