import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonValue } from "@berry/shared";

export interface RpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: JsonValue;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: JsonValue;
}

export interface RpcError {
  code: string;
  message: string;
  details?: JsonValue;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: JsonValue;
  error?: RpcError;
}

export type RpcFrame = RpcRequest | RpcNotification | RpcResponse;
export type RpcHandler = (method: string, params: JsonValue | undefined) => Promise<JsonValue | undefined>;

export function encodeFrame(frame: RpcFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function decodeFrame(line: string): RpcFrame {
  const parsed = JSON.parse(line) as RpcFrame;
  if (typeof parsed !== "object" || parsed === null || parsed.jsonrpc !== "2.0") {
    throw new Error("Invalid JSON-RPC frame");
  }
  return parsed;
}

export interface JsonlRpcPeerOptions {
  requestTimeoutMs?: number;
  onNotification?: (method: string, params: JsonValue | undefined) => void;
  onError?: (error: Error) => void;
}

interface PendingRequest {
  resolve: (value: JsonValue | undefined) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ResolvedJsonlRpcPeerOptions {
  requestTimeoutMs: number;
  onNotification?: (method: string, params: JsonValue | undefined) => void;
  onError?: (error: Error) => void;
}

export class JsonlRpcPeer {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #handler: RpcHandler | undefined;
  readonly #options: ResolvedJsonlRpcPeerOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #started = false;

  constructor(input: Readable, output: Writable, handler?: RpcHandler, options: JsonlRpcPeerOptions = {}) {
    this.#input = input;
    this.#output = output;
    this.#handler = handler;
    const resolved: ResolvedJsonlRpcPeerOptions = { requestTimeoutMs: options.requestTimeoutMs ?? 60000 };
    if (options.onNotification) resolved.onNotification = options.onNotification;
    if (options.onError) resolved.onError = options.onError;
    this.#options = resolved;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const lines = createInterface({ input: this.#input, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      void this.#handleLine(line);
    });
    lines.on("error", (error) => this.#options.onError?.(error));
  }

  request(method: string, params?: JsonValue, timeoutMs = this.#options.requestTimeoutMs): Promise<JsonValue | undefined> {
    const id = crypto.randomUUID();
    const frame: RpcRequest = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write(frame);
    });
  }

  notify(method: string, params?: JsonValue): void {
    const frame: RpcNotification = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    this.#write(frame);
  }

  async #handleLine(line: string): Promise<void> {
    if (line.trim().length === 0) return;
    try {
      const frame = decodeFrame(line);
      if ("id" in frame && ("result" in frame || "error" in frame)) {
        this.#handleResponse(frame);
        return;
      }
      if ("method" in frame && "id" in frame) {
        await this.#handleRequest(frame);
        return;
      }
      if ("method" in frame) {
        this.#options.onNotification?.(frame.method, frame.params);
      }
    } catch (error) {
      this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #handleResponse(frame: RpcResponse): void {
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(frame.id);
    if (frame.error) {
      const error = new Error(frame.error.message);
      error.name = frame.error.code;
      if (frame.error.details !== undefined) (error as Error & { details?: JsonValue }).details = frame.error.details;
      pending.reject(error);
    } else {
      pending.resolve(frame.result);
    }
  }

  async #handleRequest(frame: RpcRequest): Promise<void> {
    if (!this.#handler) {
      this.#write({ jsonrpc: "2.0", id: frame.id, error: { code: "method_not_found", message: frame.method } });
      return;
    }
    try {
      const result = await this.#handler(frame.method, frame.params);
      const response: RpcResponse = result === undefined ? { jsonrpc: "2.0", id: frame.id } : { jsonrpc: "2.0", id: frame.id, result };
      this.#write(response);
    } catch (error) {
      this.#write({
        jsonrpc: "2.0",
        id: frame.id,
        error: {
          code: error instanceof Error ? error.name : "error",
          message: error instanceof Error ? error.message : String(error),
          ...((error as { details?: JsonValue })?.details !== undefined ? { details: (error as { details: JsonValue }).details } : {}),
        },
      });
    }
  }

  #write(frame: RpcFrame): void {
    this.#output.write(encodeFrame(frame));
  }
}
