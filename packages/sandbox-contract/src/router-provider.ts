import { Buffer } from "node:buffer";
import {
  SandboxCreateInputSchema,
  SandboxDestroyInputSchema,
  SandboxDestroyResultSchema,
  SandboxExecEventSchema,
  SandboxExecInputSchema,
  SandboxExposePortInputSchema,
  SandboxExposePortResultSchema,
  SandboxFileListInputSchema,
  SandboxFileListResultSchema,
  SandboxFileReadInputSchema,
  SandboxFileReadResultSchema,
  SandboxFileWriteInputSchema,
  SandboxFileWriteResultSchema,
  SandboxHandleSchema,
  type SandboxCreateInput,
  type SandboxDestroyInput,
  type SandboxDestroyResult,
  type SandboxExecEvent,
  type SandboxExecInput,
  type SandboxExposePortInput,
  type SandboxExposePortResult,
  type SandboxFileListInput,
  type SandboxFileListResult,
  type SandboxFileReadInput,
  type SandboxFileReadResult,
  type SandboxFileWriteInput,
  type SandboxFileWriteResult,
  type SandboxHandle,
  type SandboxProviderKind,
} from "./schemas.js";
import type { SandboxFileApi, SandboxProvider } from "./provider.js";

export interface RouterSandboxProviderOptions {
  baseUrl: string;
  serviceToken: string;
  kind?: Extract<SandboxProviderKind, "router" | "commercial"> | undefined;
  providerHint?: string | undefined;
  contractVersion?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  headers?: Record<string, string> | undefined;
}

export class RouterSandboxProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(redactSecret(message));
    this.name = "RouterSandboxProviderError";
  }
}

export class RouterSandboxProvider implements SandboxProvider {
  readonly kind: Extract<SandboxProviderKind, "router" | "commercial">;
  readonly #baseUrl: string;
  readonly #serviceToken: string;
  readonly #providerHint: string | undefined;
  readonly #contractVersion: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  readonly files: SandboxFileApi = {
    read: async (input) => this.readFile(input),
    write: async (input) => this.writeFile(input),
    list: async (input) => this.listFiles(input),
  };

  constructor(options: RouterSandboxProviderOptions) {
    const baseUrl = options.baseUrl.trim();
    const serviceToken = options.serviceToken.trim();
    if (!baseUrl) throw new Error("RouterSandboxProvider requires a Router base URL");
    if (!serviceToken) throw new Error("RouterSandboxProvider requires a service token");
    this.kind = options.kind ?? "router";
    this.#baseUrl = baseUrl;
    this.#serviceToken = serviceToken;
    this.#providerHint = options.providerHint?.trim() || undefined;
    this.#contractVersion = options.contractVersion?.trim() || "2026-06";
    this.#fetch = options.fetchImpl ?? fetch;
    this.#headers = options.headers ?? {};
  }

  async create(input: SandboxCreateInput): Promise<SandboxHandle> {
    const parsed = SandboxCreateInputSchema.parse(input);
    const payload = await this.#jsonRequest("/sandboxes", {
      method: "POST",
      body: {
        ...parsed,
        provider_hint: this.#providerHint,
        contract_version: this.#contractVersion,
      },
    });
    const rawSandbox = unwrapRecord(payload, "sandbox");
    return SandboxHandleSchema.parse({
      ...rawSandbox,
      sandbox_id: stringField(rawSandbox, "sandbox_id") ?? stringField(rawSandbox, "id"),
      request_id: stringField(rawSandbox, "request_id") ?? parsed.request_id,
      tenant_id: stringField(rawSandbox, "tenant_id") ?? parsed.tenant_id,
      provider: stringField(rawSandbox, "provider") ?? this.#providerHint ?? "router",
      provider_kind: this.kind,
      status: stringField(rawSandbox, "status") ?? "running",
      image: stringField(rawSandbox, "image") ?? parsed.image,
      cwd: stringField(rawSandbox, "cwd") ?? parsed.cwd,
      created_at: stringField(rawSandbox, "created_at") ?? new Date().toISOString(),
      expires_at: stringField(rawSandbox, "expires_at") ?? null,
      metadata: rawSandbox.metadata ?? {},
    });
  }

  async *exec(input: SandboxExecInput, options: { signal?: AbortSignal | undefined } = {}): AsyncIterable<SandboxExecEvent> {
    const parsed = SandboxExecInputSchema.parse(input);
    const response = await this.#request(`/sandboxes/${encodeURIComponent(parsed.sandbox_id)}/exec`, {
      method: "POST",
      body: parsed,
      signal: options.signal,
    });
    if (isEventStream(response)) {
      yield* this.#streamExecEvents(response, parsed);
      return;
    }
    const payload = await parseJsonResponse(response);
    const payloadRecord = Array.isArray(payload) ? null : readRecord(payload);
    const rawEvents = payloadRecord === null ? payload : payloadRecord.events;
    const events = Array.isArray(rawEvents) ? rawEvents : [payload];
    for (const event of events) yield normalizeExecEvent(event, parsed);
  }

  async exposePort(input: SandboxExposePortInput): Promise<SandboxExposePortResult> {
    const parsed = SandboxExposePortInputSchema.parse(input);
    const payload = await this.#jsonRequest(`/sandboxes/${encodeURIComponent(parsed.sandbox_id)}/ports`, {
      method: "POST",
      body: parsed,
    });
    const rawPort = unwrapRecord(payload, "port");
    return SandboxExposePortResultSchema.parse({
      ...rawPort,
      sandbox_id: stringField(rawPort, "sandbox_id") ?? parsed.sandbox_id,
      port: numberField(rawPort, "port") ?? parsed.port,
      protocol: stringField(rawPort, "protocol") ?? parsed.protocol,
      url: stringField(rawPort, "url"),
      expires_at: stringField(rawPort, "expires_at") ?? null,
    });
  }

  async destroy(input: SandboxDestroyInput): Promise<SandboxDestroyResult> {
    const parsed = SandboxDestroyInputSchema.parse(input);
    const payload = await this.#jsonRequest(`/sandboxes/${encodeURIComponent(parsed.sandbox_id)}`, {
      method: "DELETE",
      body: parsed,
    });
    const rawDestroy = unwrapRecord(payload, "destroy");
    return SandboxDestroyResultSchema.parse({
      ...rawDestroy,
      sandbox_id: stringField(rawDestroy, "sandbox_id") ?? parsed.sandbox_id,
      destroyed: booleanField(rawDestroy, "destroyed") ?? booleanField(rawDestroy, "deleted") ?? true,
      status: stringField(rawDestroy, "status") ?? "stopped",
    });
  }

  async readFile(input: SandboxFileReadInput): Promise<SandboxFileReadResult> {
    const parsed = SandboxFileReadInputSchema.parse(input);
    const payload = await this.#jsonRequest(filePath(parsed.sandbox_id, parsed.path, { encoding: parsed.encoding }), {
      method: "GET",
    });
    const rawFile = unwrapRecord(payload, "file");
    const content = stringField(rawFile, "content") ?? "";
    return SandboxFileReadResultSchema.parse({
      ...rawFile,
      path: stringField(rawFile, "path") ?? parsed.path,
      encoding: stringField(rawFile, "encoding") ?? parsed.encoding,
      content,
      size_bytes: numberField(rawFile, "size_bytes") ?? Buffer.byteLength(content, parsed.encoding === "base64" ? "base64" : "utf8"),
      mtime: stringField(rawFile, "mtime") ?? null,
    });
  }

  async writeFile(input: SandboxFileWriteInput): Promise<SandboxFileWriteResult> {
    const parsed = SandboxFileWriteInputSchema.parse(input);
    const payload = await this.#jsonRequest(filePath(parsed.sandbox_id, parsed.path), {
      method: "PUT",
      body: {
        encoding: parsed.encoding,
        content: parsed.content,
        mode: parsed.mode,
      },
    });
    const rawFile = unwrapRecord(payload, "file");
    return SandboxFileWriteResultSchema.parse({
      ...rawFile,
      path: stringField(rawFile, "path") ?? parsed.path,
      size_bytes: numberField(rawFile, "size_bytes") ?? Buffer.byteLength(parsed.content, parsed.encoding === "base64" ? "base64" : "utf8"),
      mtime: stringField(rawFile, "mtime") ?? new Date().toISOString(),
    });
  }

  async listFiles(input: SandboxFileListInput): Promise<SandboxFileListResult> {
    const parsed = SandboxFileListInputSchema.parse(input);
    const payload = await this.#jsonRequest(filePath(parsed.sandbox_id, parsed.path, { list: "true", recursive: String(parsed.recursive) }), {
      method: "GET",
    });
    const rawList = unwrapRecord(payload, "list");
    return SandboxFileListResultSchema.parse({
      ...rawList,
      path: stringField(rawList, "path") ?? parsed.path,
      entries: Array.isArray(rawList.entries) ? rawList.entries : [],
    });
  }

  async #jsonRequest(path: string, init: RouterSandboxRequestInit): Promise<unknown> {
    return parseJsonResponse(await this.#request(path, init));
  }

  async #request(path: string, init: RouterSandboxRequestInit): Promise<Response> {
    const request: RequestInit = {
      method: init.method,
      headers: this.#requestHeaders(init.body !== undefined),
    };
    if (init.body !== undefined) request.body = JSON.stringify(init.body);
    if (init.signal !== undefined) request.signal = init.signal;
    const response = await this.#fetch(urlFor(this.#baseUrl, path), request);
    if (!response.ok) {
      throw new RouterSandboxProviderError(
        `Router sandbox request failed with ${response.status}`,
        response.status,
        redactSecret(await response.text()),
      );
    }
    return response;
  }

  #requestHeaders(hasBody: boolean): Headers {
    const headers = new Headers(this.#headers);
    headers.set("Authorization", `Bearer ${this.#serviceToken}`);
    headers.set("Accept", "application/json, text/event-stream");
    headers.set("X-Berry-Router-Contract-Version", this.#contractVersion);
    if (this.#providerHint) headers.set("X-Berry-Sandbox-Provider", this.#providerHint);
    if (hasBody) headers.set("Content-Type", "application/json");
    return headers;
  }

  async *#streamExecEvents(response: Response, parsed: ReturnType<typeof SandboxExecInputSchema.parse>): AsyncIterable<SandboxExecEvent> {
    if (!response.body) {
      const text = await response.text();
      for (const event of parseSseText(text, parsed)) yield event;
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = splitCompleteSseFrames(buffer);
      buffer = frames.remainder;
      for (const frame of frames.complete) {
        const event = parseSseFrame(frame, parsed);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    for (const event of parseSseText(buffer, parsed)) yield event;
  }
}

interface RouterSandboxRequestInit {
  method: "DELETE" | "GET" | "POST" | "PUT";
  body?: unknown;
  signal?: AbortSignal | undefined;
}

function urlFor(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.replace(/^\//, "");
  return new URL(normalizedPath, normalizedBase).toString();
}

function filePath(sandboxId: string, path: string, query: Record<string, string> = {}): string {
  const encodedPath = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const url = new URL(`http://berry.invalid/sandboxes/${encodeURIComponent(sandboxId)}/files/${encodedPath}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RouterSandboxProviderError("Router sandbox response was not valid JSON", response.status, text);
  }
}

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
}

function normalizeExecEvent(value: unknown, parsed: ReturnType<typeof SandboxExecInputSchema.parse>): SandboxExecEvent {
  const record = readRecord(value);
  const kind = stringField(record, "kind") ?? stringField(record, "type") ?? stringField(record, "event");
  if (kind === "started" || kind === "stdout" || kind === "stderr" || kind === "exit" || kind === "error" || kind === "usage") {
    return SandboxExecEventSchema.parse(record);
  }
  if (kind === "output") return SandboxExecEventSchema.parse({ kind: "stdout", data: stringField(record, "data") ?? "" });
  if (kind === "completed") {
    return SandboxExecEventSchema.parse({
      kind: "exit",
      exit_code: numberField(record, "exit_code") ?? numberField(record, "code") ?? 0,
      signal: stringField(record, "signal") ?? null,
    });
  }
  if (kind === "start") {
    return SandboxExecEventSchema.parse({
      kind: "started",
      sandbox_id: stringField(record, "sandbox_id") ?? parsed.sandbox_id,
      request_id: stringField(record, "request_id") ?? parsed.request_id,
      pid: numberField(record, "pid") ?? null,
    });
  }
  return SandboxExecEventSchema.parse({ kind: "stdout", data: JSON.stringify(value) });
}

function parseSseText(text: string, parsed: ReturnType<typeof SandboxExecInputSchema.parse>): SandboxExecEvent[] {
  return splitCompleteSseFrames(text).complete
    .map((frame) => parseSseFrame(frame, parsed))
    .filter((event): event is SandboxExecEvent => event !== null);
}

function splitCompleteSseFrames(text: string): { complete: string[]; remainder: string } {
  const parts = text.split(/\r?\n\r?\n/);
  const remainder = parts.pop() ?? "";
  return { complete: parts.filter((part) => part.trim().length > 0), remainder };
}

function parseSseFrame(frame: string, parsed: ReturnType<typeof SandboxExecInputSchema.parse>): SandboxExecEvent | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  return normalizeExecEvent(JSON.parse(data), parsed);
}

function unwrapRecord(value: unknown, key: string): Record<string, unknown> {
  const record = readRecord(value);
  const nested = record[key];
  return isRecord(nested) ? nested : record;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new RouterSandboxProviderError("Router sandbox response was not an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" ? record[key] : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function redactSecret(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
}
