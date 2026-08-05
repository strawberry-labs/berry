import { describe, expect, it } from "vitest";
import {
  DURABLE_BASE_BUILT_IN_TOOLS,
  DurableTurnRuntimeRequestSchema,
  openDurableSecret,
  sealDurableSecret,
} from "./durable-context.js";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("durable capability contract", () => {
  it("round-trips admitted secrets without storing plaintext", async () => {
    const sealed = await sealDurableSecret("provider-secret", key);
    expect(JSON.stringify(sealed)).not.toContain("provider-secret");
    await expect(openDurableSecret(sealed, key)).resolves.toBe("provider-secret");
  });

  it("keeps the complete base tool catalog in the versioned request", () => {
    const parsed = DurableTurnRuntimeRequestSchema.parse({
      capabilityVersion: 1,
      input: "hello",
      providerId: "provider",
      provider: {
        id: "provider",
        name: "Provider",
        kind: "openai",
        baseUrl: "https://provider.example/v1",
        defaultModel: "model",
      },
      model: "model",
      workspacePath: "/workspace",
      workspaceId: "workspace",
      permissionMode: "auto-edit",
      reasoning: "medium",
      maxTokens: 8_000,
      contextWindowTokens: 128_000,
      builtInTools: DURABLE_BASE_BUILT_IN_TOOLS,
    });
    expect(parsed.builtInTools).toEqual(DURABLE_BASE_BUILT_IN_TOOLS);
  });
});
