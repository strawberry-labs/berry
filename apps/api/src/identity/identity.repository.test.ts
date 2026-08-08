import { SELF_HOST_TENANT_ID } from "@berry/db";
import { ConnectorSecretEnvelopeSchema, openConnectorSecret } from "@berry/shared";
import { describe, expect, it, vi } from "vitest";
import { PostgresEnterpriseIdentityRepository } from "./identity.repository.ts";

describe("PostgresEnterpriseIdentityRepository SSO secrets", () => {
  it("binds encrypted Google credentials to the canonical upserted connection ID", async () => {
    const rootKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    const canonicalId = "00000000-0000-7000-8000-000000000799";
    let insertParams: unknown[] = [];
    let updateParams: unknown[] = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO sso_connections")) {
        insertParams = params;
        return [{
          id: canonicalId,
          tenant_id: params[1],
          kind: params[2],
          provider: params[3],
          slug: params[4],
          display_name: params[5],
          status: params[6],
          issuer: params[7],
          sso_url: params[8],
          metadata_url: params[9],
          entity_id: params[10],
          client_id: params[11],
          client_secret_ref: null,
          client_secret_envelope: null,
          domains: JSON.parse(String(params[12])),
          jit_provisioning: params[13],
          default_role: params[14],
          scim_enabled: params[15],
          last_tested_at: null,
          last_error_code: null,
          created_at: new Date("2026-08-08T00:00:00.000Z"),
          updated_at: new Date("2026-08-08T00:00:00.000Z"),
        }];
      }
      if (sql.includes("UPDATE sso_connections")) {
        updateParams = params;
        return [{
          id: canonicalId,
          tenant_id: params[0],
          kind: "oidc",
          provider: "google",
          slug: "google-workspace",
          display_name: "Google Workspace",
          status: "enabled",
          issuer: "https://accounts.google.com",
          sso_url: null,
          metadata_url: null,
          entity_id: null,
          client_id: "berry.apps.googleusercontent.com",
          client_secret_ref: "encrypted-db",
          client_secret_envelope: JSON.parse(String(params[2])),
          domains: ["aesg.com"],
          jit_provisioning: true,
          default_role: "member",
          scim_enabled: false,
          last_tested_at: null,
          last_error_code: null,
          created_at: new Date("2026-08-08T00:00:00.000Z"),
          updated_at: new Date("2026-08-08T00:00:00.000Z"),
        }];
      }
      return [];
    });
    const database = {
      withTenant: vi.fn(async (_tenantId: string, callback: (executor: { query: typeof query }) => Promise<unknown>) => callback({ query })),
    };
    const repository = new PostgresEnterpriseIdentityRepository(database as never, 10, {
      BERRY_CONNECTOR_ENCRYPTION_KEY: rootKey,
    });

    const connection = await repository.createSsoConnection({
      tenantId: SELF_HOST_TENANT_ID,
      kind: "oidc",
      provider: "google",
      slug: "google-workspace",
      displayName: "Google Workspace",
      status: "enabled",
      issuer: "https://accounts.google.com",
      clientId: "berry.apps.googleusercontent.com",
      clientSecret: "GOCSPX-plaintext-must-not-survive",
      domains: ["aesg.com"],
      jitProvisioning: true,
      defaultRole: "member",
    });

    expect(connection.clientSecretConfigured).toBe(true);
    expect(connection).not.toHaveProperty("clientSecret");
    expect(connection.id).toBe(canonicalId);
    expect(updateParams[1]).toBe(canonicalId);
    expect(JSON.stringify([insertParams, updateParams])).not.toContain("GOCSPX-plaintext-must-not-survive");

    const envelope = ConnectorSecretEnvelopeSchema.parse(JSON.parse(String(updateParams[2])));
    await expect(openConnectorSecret(
      envelope,
      rootKey,
      `${SELF_HOST_TENANT_ID}:sso:${canonicalId}:client-secret`,
    )).resolves.toBe("GOCSPX-plaintext-must-not-survive");
  });
});
