import { z } from "zod";

export interface DirectChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DirectChatOptions {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

const OpenAiChatResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().default("") }) })).default([]),
});

export async function runDirectEndpointChat(options: DirectChatOptions, messages: DirectChatMessage[]): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json" });
  if (options.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: options.model, messages, stream: false }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Direct endpoint failed with ${response.status}`);
  return OpenAiChatResponseSchema.parse(body).choices[0]?.message.content ?? "";
}

export function directEndpointLimitations(): string[] {
  return [
    "Direct endpoint mode supports chat streaming only.",
    "Tools, terminals, files, approvals, and hosted task sync require a Berry account or self-hosted Berry API.",
  ];
}
