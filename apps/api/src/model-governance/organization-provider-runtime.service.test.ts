import { describe, expect, it, vi } from "vitest";
import {
  InMemoryModelGovernanceRepository,
  ModelGovernanceService,
} from "./model-governance.service.ts";
import {
  DefaultOrganizationProviderRuntime,
  OrganizationProviderHealthCheckError,
} from "./organization-provider-runtime.service.ts";

const tenantId = "00000000-0000-7000-8000-000000000001";

describe("organization provider runtime", () => {
  it("activates an allowlisted provider after a successful authenticated health check", async () => {
    const models = await configuredModels();
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    const runtime = new DefaultOrganizationProviderRuntime(models, {
      BERRY_ORGANIZATION_PROVIDER_ALLOWED_HOSTS: "router.example.test",
      BERRY_ORGANIZATION_PROVIDER_CREDENTIALS_JSON: JSON.stringify({
        BERRY_TEST_PROVIDER_KEY: "provider-secret",
      }),
    }, request);

    await expect(runtime.resolve(tenantId, { providerId: "organization-router" }))
      .rejects.toThrow("is not active");
    await expect(runtime.testAndActivate(tenantId, "organization-router"))
      .resolves.toMatchObject({ status: "active" });
    await expect(runtime.resolve(tenantId, { providerId: "organization-router" }))
      .resolves.toMatchObject({
        apiKey: "provider-secret",
        provider: {
          id: "organization-router",
          baseUrl: "https://router.example.test/v1",
          defaultModel: "test-model",
          models: [{ id: "test-model" }],
        },
      });
    expect(request).toHaveBeenCalledWith("https://router.example.test/v1/models", expect.objectContaining({
      method: "GET",
      headers: { authorization: "Bearer provider-secret" },
      redirect: "error",
    }));
  });

  it("rejects a destination outside the deployment allowlist without making a request", async () => {
    const models = await configuredModels();
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    const runtime = new DefaultOrganizationProviderRuntime(models, {
      BERRY_ORGANIZATION_PROVIDER_ALLOWED_HOSTS: "approved.example.test",
      BERRY_TEST_PROVIDER_KEY: "provider-secret",
    }, request);

    await expect(runtime.testAndActivate(tenantId, "organization-router"))
      .rejects.toBeInstanceOf(OrganizationProviderHealthCheckError);
    expect(request).not.toHaveBeenCalled();
    await expect(models.listProviders(tenantId)).resolves.toEqual([
      expect.objectContaining({ status: "error" }),
    ]);
  });

  it("fails closed when the credential reference is unavailable", async () => {
    const models = await configuredModels();
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    const runtime = new DefaultOrganizationProviderRuntime(models, {
      BERRY_ORGANIZATION_PROVIDER_ALLOWED_HOSTS: "router.example.test",
    }, request);

    await expect(runtime.testAndActivate(tenantId, "organization-router"))
      .rejects.toMatchObject({ message: "Credential reference env:BERRY_TEST_PROVIDER_KEY is not available" });
    expect(request).not.toHaveBeenCalled();
  });
});

async function configuredModels(): Promise<ModelGovernanceService> {
  const models = new ModelGovernanceService(new InMemoryModelGovernanceRepository(false));
  await models.upsertProvider(tenantId, {
    providerId: "organization-router",
    displayName: "Organization router",
    kind: "openai-compatible",
    apiType: "openai-chat-completions",
    baseUrl: "https://router.example.test/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    authType: "bearer",
    credentialRef: "env:BERRY_TEST_PROVIDER_KEY",
    defaultModel: "test-model",
    enabled: true,
  });
  await models.upsertPolicy({
    tenantId,
    providerId: "organization-router",
    model: "test-model",
    displayName: "Test model",
    capabilities: { tools: true, vision: true },
  });
  return models;
}
