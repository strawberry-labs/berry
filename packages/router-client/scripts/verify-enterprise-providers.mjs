import { MODEL_PROVIDER_PRESETS } from "@berry/shared";
import { AnthropicMessagesClient, listProviderModels, OpenAIChatCompletionsClient } from "../dist/index.js";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live provider matrix`);
  return value;
}

function preset(id) {
  const value = MODEL_PROVIDER_PRESETS.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`Missing ${id} preset`);
  return value;
}

const anthropic = preset("anthropic");
const anthropicKey = requiredEnv("ANTHROPIC_API_KEY");
const anthropicModels = await listProviderModels({ provider: anthropic, apiKey: anthropicKey });
if (!anthropicModels.some((model) => model.id === anthropic.defaultModel)) {
  throw new Error(`Anthropic did not return preset default ${anthropic.defaultModel}`);
}
let anthropicStopped = false;
for await (const event of new AnthropicMessagesClient({ provider: anthropic, apiKey: anthropicKey }).streamEvents({
  model: anthropic.defaultModel,
  max_tokens: 16,
  messages: [{ role: "user", content: [{ type: "text", text: "Reply with: live matrix ok" }] }],
})) {
  if (event.type === "message_stop") anthropicStopped = true;
}
if (!anthropicStopped) throw new Error("Anthropic stream did not reach message_stop");

const gemini = preset("gemini");
const geminiKey = process.env.GEMINI_API_KEY?.trim() || requiredEnv("GOOGLE_API_KEY");
const geminiModels = await listProviderModels({ provider: gemini, apiKey: geminiKey });
if (!geminiModels.some((model) => model.id === gemini.defaultModel)) {
  throw new Error(`Gemini did not return preset default ${gemini.defaultModel}`);
}
const geminiResult = await new OpenAIChatCompletionsClient({ provider: gemini, apiKey: geminiKey }).complete({
  messages: [{ role: "user", content: "Reply with: live matrix ok" }],
  maxTokens: 16,
});
if (!geminiResult.content.trim()) throw new Error("Gemini returned an empty completion");

console.log(JSON.stringify({
  anthropic: { model: anthropic.defaultModel, modelCount: anthropicModels.length, streamed: true },
  gemini: { model: gemini.defaultModel, modelCount: geminiModels.length, completion: true },
}, null, 2));
