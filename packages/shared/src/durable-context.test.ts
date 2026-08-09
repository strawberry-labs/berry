import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_INPUT_MAX_BYTES,
  DURABLE_BASE_BUILT_IN_TOOLS,
  DurableTurnRuntimeRequestSchema,
  durableContextConfigFromEnv,
  isConnectorEncryptionKeyValid,
  openConnectorSecret,
  openDurableSecret,
  sealConnectorSecret,
  sealDurableSecret,
} from "./durable-context.js";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("durable capability contract", () => {
  it("accepts only connector keys that decode to exactly 32 bytes", () => {
    expect(isConnectorEncryptionKeyValid(key)).toBe(true);
    expect(isConnectorEncryptionKeyValid("connector-encryption-key")).toBe(false);
    expect(isConnectorEncryptionKeyValid(Buffer.from("too-short").toString("base64"))).toBe(false);
    expect(isConnectorEncryptionKeyValid(undefined)).toBe(false);
  });

  it("allows files up to 350 MiB to be staged into a sandbox by default", () => {
    expect(durableContextConfigFromEnv({}).sandboxInputMaxBytes)
      .toBe(DEFAULT_SANDBOX_INPUT_MAX_BYTES);
  });

  it("round-trips admitted secrets without storing plaintext", async () => {
    const sealed = await sealDurableSecret("provider-secret", key);
    expect(JSON.stringify(sealed)).not.toContain("provider-secret");
    await expect(openDurableSecret(sealed, key)).resolves.toBe("provider-secret");
  });

  it("binds long-lived connector ciphertext to its tenant and record", async () => {
    const sealed = await sealConnectorSecret("google-refresh-token", key, "tenant-a:connector-a:user-a");
    expect(JSON.stringify(sealed)).not.toContain("google-refresh-token");
    await expect(openConnectorSecret(sealed, key, "tenant-a:connector-a:user-a")).resolves.toBe("google-refresh-token");
    await expect(openConnectorSecret(sealed, key, "tenant-b:connector-a:user-a")).rejects.toThrow("authentication failed");
  });

  it("supports connector root-key rotation without trying unrelated keys", async () => {
    const oldKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
    const nextKey = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
    const sealed = await sealConnectorSecret("shared-mcp-token", oldKey, "tenant:connector:shared");
    await expect(openConnectorSecret(sealed, [nextKey, oldKey], "tenant:connector:shared")).resolves.toBe("shared-mcp-token");
    await expect(openConnectorSecret(sealed, nextKey, "tenant:connector:shared")).rejects.toThrow("is not configured");
  });

  it("keeps explicit image intent paired with its admitted durable capability", () => {
    const parsed = DurableTurnRuntimeRequestSchema.parse({
      capabilityVersion: 1,
      input: "hello",
      intent: "image_generation",
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
      builtInTools: [...DURABLE_BASE_BUILT_IN_TOOLS, "create_image"],
      imageGeneration: { providerId: "router", model: "openai/gpt-image-2", costMicros: "10" },
    });
    expect(parsed).toMatchObject({
      intent: "image_generation",
      imageGeneration: { providerId: "router", model: "openai/gpt-image-2" },
    });
    expect(parsed.builtInTools).toEqual([...DURABLE_BASE_BUILT_IN_TOOLS, "create_image"]);
  });

  it("rejects image intent if durable admission drops the image tool", () => {
    expect(() => DurableTurnRuntimeRequestSchema.parse({
      capabilityVersion: 1,
      input: "hello",
      intent: "image_generation",
      providerId: "provider",
      provider: { id: "provider", name: "Provider", kind: "openai", baseUrl: "https://provider.example/v1", defaultModel: "model" },
      model: "model",
      workspacePath: "/workspace",
      workspaceId: "workspace",
      permissionMode: "auto-edit",
      reasoning: "medium",
      maxTokens: 8_000,
      contextWindowTokens: 128_000,
      builtInTools: DURABLE_BASE_BUILT_IN_TOOLS,
    })).toThrow("Image intent requires the create_image tool");
  });
});
