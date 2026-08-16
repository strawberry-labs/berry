import { describe, expect, it } from "vitest";
import { permissionFor } from "./admin-screens";

describe("admin tab permissions", () => {
  it("keeps extracted catalog tabs behind their read domains", () => {
    expect(Object.fromEntries([
      "overview",
      "members",
      "departments",
      "roles",
      "resource-access",
      "providers",
      "models",
      "skills-mcp",
      "analytics",
      "spend-limits",
      "credits-billing",
      "reports-alerts",
      "execution-network",
      "authentication",
      "data-governance",
      "service-accounts",
      "connectors",
      "profile-domains",
      "feature-access",
      "sso-scim",
      "managed-policy",
      "audit-log",
    ].map((tab) => [tab, permissionFor(tab)]))).toEqual({
      overview: "org:read",
      members: "members:read",
      departments: "departments:read",
      roles: "rbac:read",
      "resource-access": "acl:read",
      providers: "models:read",
      models: "models:read",
      "skills-mcp": "org:read",
      analytics: "usage:read",
      "spend-limits": "budgets:read",
      "credits-billing": "billing:read",
      "reports-alerts": "reports:read",
      "execution-network": "guardrails:read",
      authentication: "auth_policy:read",
      "data-governance": "data_policy:read",
      "service-accounts": "service_accounts:read",
      connectors: "mcp:read",
      "profile-domains": "org_settings:read",
      "feature-access": "feature_flags:read",
      "sso-scim": "sso:read",
      "managed-policy": "policy:read",
      "audit-log": "audit:read",
    });
  });
});
