import { z } from "zod";

export const MobileConnectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("berry-account"), apiBaseUrl: z.string().url().default("https://api.berry.test"), sessionToken: z.string().min(1).optional() }),
  z.object({ kind: z.literal("self-hosted"), apiBaseUrl: z.string().url(), sessionToken: z.string().min(1).optional() }),
  z.object({ kind: z.literal("custom-openai"), baseUrl: z.string().url(), apiKey: z.string().optional(), model: z.string().min(1).default("gpt-4.1-mini") }),
  z.object({ kind: z.literal("lan-local"), baseUrl: z.string().url(), model: z.string().min(1).default("llama3.2") }),
]);
export type MobileConnection = z.infer<typeof MobileConnectionSchema>;

export interface ConnectionValidation {
  connection: MobileConnection;
  warnings: string[];
  pushAvailable: boolean;
}

export function validateMobileConnection(input: unknown): ConnectionValidation {
  const connection = MobileConnectionSchema.parse(input);
  const url = new URL("apiBaseUrl" in connection ? connection.apiBaseUrl : connection.baseUrl);
  const warnings: string[] = [];
  if (url.protocol === "http:" && !isLocalNetworkHost(url.hostname)) {
    throw new Error("Plain HTTP is only allowed for localhost and RFC1918 LAN endpoints.");
  }
  if (url.protocol === "http:") {
    warnings.push("Plain HTTP is only allowed for trusted localhost or LAN endpoints. Traffic can be observed on the network.");
  }
  const pushAvailable = connection.kind === "berry-account" || connection.kind === "self-hosted";
  if (!pushAvailable) warnings.push("Direct endpoint mode cannot receive push notifications; approvals poll only while the app is open.");
  return { connection, warnings, pushAvailable };
}

export function isLocalNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 127);
}
