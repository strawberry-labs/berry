import { expect, test } from "@playwright/test";
import { seedWorkspace } from "./fixtures";

test("model selector pulls an Ollama model with progress and native metadata", async ({ page }) => {
  await seedWorkspace(page, (state) => {
    state.providers.push({
      id: "dev_ollama",
      kind: "ollama",
      name: "Ollama",
      apiType: "openai-chat-completions",
      baseUrl: "http://localhost:11434/v1",
      endpointPath: "/chat/completions",
      modelsPath: "/models",
      defaultModel: "llama3.2",
      credentialRef: null,
      authType: "none",
      enabled: true,
      models: [],
      capabilities: {},
      headers: {},
      source: "preset",
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z",
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /berry\/router-auto/ }).click();
  await page.getByRole("option", { name: "Pull model" }).click();
  const panel = page.getByTestId("ollama-pull-panel");
  await panel.getByLabel("Ollama model name").fill("qwen3:8b");
  await panel.getByRole("button", { name: "Pull model" }).click();
  await expect(panel.getByText("downloading")).toBeVisible();
  await expect(panel.getByText("success")).toBeVisible();
  await expect(page.getByRole("option", { name: /qwen3:8b.*Q4_K_M/ })).toBeVisible();
});

test("model selector downloads, loads, and unloads LM Studio models", async ({ page }) => {
  await seedWorkspace(page, (state) => {
    state.providers.push({
      id: "dev_lm_studio",
      kind: "lm-studio",
      name: "LM Studio",
      apiType: "openai-chat-completions",
      baseUrl: "http://localhost:1234/v1",
      endpointPath: "/chat/completions",
      modelsPath: "/models",
      defaultModel: "google/gemma",
      credentialRef: "lm-studio-api-token",
      authType: "optional-bearer",
      enabled: true,
      models: [
        {
          id: "google/gemma",
          name: "Gemma",
          contextWindow: 131072,
          capabilities: { tools: true, vision: true, reasoning: false, json: true },
          family: "gemma",
          quantization: "Q4_K_M",
          loaded: false,
          loadedInstanceIds: [],
          raw: { engine: "lm-studio", loadedInstances: [] },
        },
      ],
      capabilities: {},
      headers: {},
      source: "preset",
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z",
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /berry\/router-auto/ }).click();
  await page.getByRole("button", { name: "Load google/gemma" }).click();
  await expect(page.getByRole("button", { name: "Unload google/gemma" })).toBeVisible();
  await page.getByRole("button", { name: "Unload google/gemma" }).click();
  await expect(page.getByRole("button", { name: "Load google/gemma" })).toBeVisible();

  await page.getByRole("option", { name: "Download model" }).click();
  const panel = page.getByTestId("ollama-pull-panel");
  await panel.getByLabel("LM Studio model name").fill("ibm/granite");
  await panel.getByRole("button", { name: "Download model" }).click();
  await expect(panel.getByText("downloading")).toBeVisible();
  await expect(panel.getByText("completed")).toBeVisible();
  await expect(page.getByRole("option", { name: /ibm\/granite.*Q4_K_M/ })).toBeVisible();
});

test("LM Studio preset exposes an optional API token", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Model settings", exact: true }).click();
  await page.getByTestId("provider-rail").getByRole("button", { name: "Add provider" }).click();
  await page.getByTestId("provider-gallery").getByRole("button", { name: /^LM Studio/ }).click();
  const setup = page.getByTestId("provider-setup");
  await expect(setup.getByLabel("API key (optional)")).toBeVisible();
  await setup.getByRole("button", { name: "Add provider" }).click();
  await expect(page.getByTestId("provider-rail").getByRole("button", { name: "LM Studio" })).toBeVisible();
});

test("Anthropic and Gemini enterprise presets expose their verified transports", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Model settings", exact: true }).click();
  const rail = page.getByTestId("provider-rail");

  await rail.getByRole("button", { name: "Add provider" }).click();
  await page.getByTestId("provider-gallery").getByRole("button", { name: /^Anthropic/ }).click();
  const setup = page.getByTestId("provider-setup");
  await expect(setup.getByText("Anthropic Messages")).toBeVisible();
  await expect(setup.getByLabel("Default model")).toHaveValue("claude-sonnet-5");

  await setup.getByRole("button", { name: "Back" }).click();
  await page.getByTestId("provider-gallery").getByRole("button", { name: /^Google Gemini/ }).click();
  await expect(setup.getByText("Chat Completions")).toBeVisible();
  await expect(setup.getByText("generativelanguage.googleapis.com")).toBeVisible();
  await expect(setup.getByLabel("Default model")).toHaveValue("gemini-3.5-flash");
});

test("composer blocks image attachments for an explicitly non-vision model", async ({ page }) => {
  await seedWorkspace(page, (state) => {
    state.providers = [{
      id: "dev_text_only",
      kind: "openai-compatible",
      name: "Text only",
      apiType: "openai-chat-completions",
      baseUrl: "https://example.test/v1",
      endpointPath: "/chat/completions",
      modelsPath: "/models",
      defaultModel: "text-only-model",
      credentialRef: null,
      authType: "none",
      enabled: true,
      models: [{ id: "text-only-model", capabilities: { tools: true, vision: true }, capabilityOverrides: { vision: false } }],
      capabilities: {},
      headers: {},
      source: "custom",
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z",
    }];
  });
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles({
    name: "diagram.png",
    mimeType: "image/png",
    buffer: Buffer.from("image fixture"),
  });
  await expect(page.getByText(/text-only-model does not support image input/)).toBeVisible();
  await expect(page.getByText("diagram.png")).toHaveCount(0);
});

test("model settings persist manual capability and cost overrides", async ({ page }) => {
  await seedWorkspace(page, (state) => {
    state.providers.unshift({
      id: "dev_capabilities",
      kind: "openai",
      name: "Capability fixture",
      apiType: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      endpointPath: "/responses",
      modelsPath: "/models",
      defaultModel: "gpt-fixture",
      credentialRef: null,
      authType: "none",
      enabled: true,
      models: [{ id: "gpt-fixture", capabilities: { tools: true, vision: true, reasoning: true } }],
      capabilities: {},
      headers: {},
      source: "custom",
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z",
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Model settings", exact: true }).click();
  await page.getByTestId("provider-rail").getByRole("button", { name: "Capability fixture" }).click();
  const models = page.getByTestId("provider-models");
  await models.getByRole("button", { name: "Edit gpt-fixture" }).click();
  await page.getByLabel("Tool calling").click();
  await page.getByRole("option", { name: "Not supported" }).click();
  await page.getByLabel("Image input").click();
  await page.getByRole("option", { name: "Not supported" }).click();
  await page.getByLabel("Input $ / 1M tokens").fill("0.4");
  await page.getByLabel("Output $ / 1M tokens").fill("1.6");
  await page.getByRole("button", { name: "Save model" }).click();

  await models.getByRole("button", { name: "Edit gpt-fixture" }).click();
  await expect(page.getByLabel("Tool calling")).toContainText("Not supported");
  await expect(page.getByLabel("Image input")).toContainText("Not supported");
  await expect(page.getByLabel("Input $ / 1M tokens")).toHaveValue("0.4");
  await expect(page.getByLabel("Output $ / 1M tokens")).toHaveValue("1.6");
});

test("scheduled provider health surfaces auth, network, and model failures", async ({ page }) => {
  await seedWorkspace(page, (state) => {
    const provider = (id: string, name: string) => ({
      id,
      kind: "openai-compatible",
      name,
      apiType: "openai-chat-completions",
      baseUrl: `https://${id}.example.test/v1`,
      endpointPath: "/chat/completions",
      modelsPath: "/models",
      defaultModel: "fixture-model",
      credentialRef: null,
      authType: "none",
      enabled: true,
      models: [{ id: "fixture-model" }],
      capabilities: {},
      headers: {},
      source: "custom",
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z",
    });
    state.providers = [
      provider("dev_auth_error", "Auth fixture"),
      provider("dev_network_error", "Network fixture"),
      provider("dev_model_missing", "Model fixture"),
    ];
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Model settings", exact: true }).click();
  const health = page.getByTestId("provider-health");
  await expect(health).toContainText("API key was rejected");
  await expect(health).toContainText("12 ms");
  await expect(page.getByTestId("provider-rail").getByRole("button", { name: "Auth fixture" }).locator("span[title]")).toHaveAttribute("title", "The API key was rejected.");

  await page.getByTestId("provider-rail").getByRole("button", { name: "Network fixture" }).click();
  await expect(health).toContainText("could not be reached");
  await page.getByTestId("provider-rail").getByRole("button", { name: "Model fixture" }).click();
  await expect(health).toContainText("configured default model is unavailable");
});

test("task composers prefer the configured default for their conversation kind", async ({ page }) => {
  await seedWorkspace(page, (state) => {
    const task = state.tasks.dev_ws_1?.[0] as Record<string, unknown>;
    task.conversationKind = "chat";
    state.providers = [
      {
        id: "dev_chat_provider",
        kind: "openai-compatible",
        name: "Chat Provider",
        apiType: "openai-chat-completions",
        baseUrl: "https://chat.example.test/v1",
        endpointPath: "/chat/completions",
        modelsPath: "/models",
        defaultModel: "chat-model",
        credentialRef: null,
        authType: "none",
        enabled: true,
        models: [{ id: "chat-model" }],
        capabilities: {},
        headers: {},
        source: "custom",
        createdAt: "2026-07-01T12:00:00.000Z",
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
      {
        id: "dev_code_provider",
        kind: "openai-compatible",
        name: "Code Provider",
        apiType: "openai-chat-completions",
        baseUrl: "https://code.example.test/v1",
        endpointPath: "/chat/completions",
        modelsPath: "/models",
        defaultModel: "code-model",
        credentialRef: null,
        authType: "none",
        enabled: true,
        models: [{ id: "code-model" }],
        capabilities: {},
        headers: {},
        source: "custom",
        createdAt: "2026-07-01T12:00:00.000Z",
        updatedAt: "2026-07-01T12:00:00.000Z",
      },
    ];
    state.settings["model.defaultSelection.chat"] = { providerId: "dev_chat_provider", model: "chat-model" };
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Fonts utilized in recreation/ }).click();
  await expect(page.getByRole("button", { name: /chat-model/ })).toBeVisible();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Model settings", exact: true }).click();
  await expect(page.getByTestId("mode-defaults").getByLabel("Chat default model")).toContainText("Chat Provider · chat-model");
  await page.getByTestId("mode-defaults").getByLabel("Code default model").click();
  await page.getByRole("option", { name: "Code Provider · code-model" }).click();
  await expect(page.getByText("Code default updated")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("berry.dev.host") ?? "{}") as { settings?: Record<string, unknown> };
    return state.settings?.["model.defaultSelection.code"];
  })).toEqual({ providerId: "dev_code_provider", model: "code-model" });
});

test("Berry Router paste-key connect shows account quota and usage attribution", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("menuitem", { name: /Berry Router/ }).click();
  const dialog = page.getByRole("dialog", { name: "Berry Router" });
  await dialog.getByLabel("API key").fill("brry_fixture_key");
  await dialog.getByRole("button", { name: "Save key" }).click();
  const account = dialog.getByTestId("router-account-card");
  await expect(account).toContainText("Berry Developer");
  await expect(account).toContainText("37 USD");
  await expect(account).toContainText("berry/fast");
  await dialog.locator('[data-slot="dialog-footer"]').getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Usage" }).click();
  await expect(page.getByText("served by openai · openai/gpt-4.1-mini")).toBeVisible();
});

test("Berry Router OAuth callback stores the exchanged credential", async ({ page }) => {
  await seedWorkspace(page);
  await page.goto("/");
  await page.evaluate(() => {
    window.open = ((url?: string | URL) => {
      sessionStorage.setItem("berry.oauth.fixture", String(url));
      return null;
    }) as typeof window.open;
  });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("menuitem", { name: /Berry Router/ }).click();
  const dialog = page.getByRole("dialog", { name: "Berry Router" });
  await dialog.getByRole("button", { name: "Sign in with Berry Router" }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("berry.oauth.fixture"))).not.toBeNull();
  const authorizationUrl = await page.evaluate(() => sessionStorage.getItem("berry.oauth.fixture"));
  const state = new URL(String(authorizationUrl)).searchParams.get("state");
  expect(state).toBeTruthy();
  await page.evaluate((oauthState) => {
    window.dispatchEvent(new CustomEvent("berry:deep-link", {
      detail: `berry://router/oauth/callback?code=fixture_code&state=${encodeURIComponent(oauthState)}`,
    }));
  }, state!);
  await expect(dialog.getByTestId("router-account-card")).toContainText("Berry Developer");
});
