import { PROTOCOL_VERSION, isHostMethod, validateHostParams, validateHostResult, type HostMethod, type HostMethodParams, type HostMethodResult, type JsonValue } from "@berry/shared";

export const BERRY_NATIVE_HOST = "com.berry.desktop_host";

export interface NativeRequest {
  id: string;
  method: string;
  params?: JsonValue;
}

export interface NativeResponse {
  id: string;
  result?: JsonValue;
  error?: { code: string; message: string; details?: JsonValue };
}

export class NativeHostError extends Error {
  constructor(readonly code: string, message: string, readonly details?: JsonValue) {
    super(message);
    this.name = code;
  }
}

export class NativeHostClient {
  readonly #port: chrome.runtime.Port;
  readonly #pending = new Map<string, { resolve: (value: JsonValue | undefined) => void; reject: (error: Error) => void }>();

  constructor(connectNative: (name: string) => chrome.runtime.Port = chrome.runtime.connectNative) {
    this.#port = connectNative(BERRY_NATIVE_HOST);
    this.#port.onMessage.addListener((message: NativeResponse) => this.#handleMessage(message));
    this.#port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message ?? "Berry desktop native host disconnected";
      for (const pending of this.#pending.values()) pending.reject(new NativeHostError("native_disconnected", message));
      this.#pending.clear();
    });
  }

  async handshake(): Promise<void> {
    await this.call("host.handshake", { protocolVersion: PROTOCOL_VERSION });
  }

  async call<TMethod extends HostMethod>(method: TMethod, params?: HostMethodParams<TMethod>): Promise<HostMethodResult<TMethod>>;
  async call<T = JsonValue>(method: string, params?: JsonValue): Promise<T>;
  async call<T = JsonValue>(method: string, params?: JsonValue): Promise<T> {
    const typedMethod = method as HostMethod;
    const typedParams = isHostMethod(method) ? validateHostParams(typedMethod, params) : params;
    const result = await this.#request(method, typedParams as JsonValue | undefined);
    return (isHostMethod(method) ? validateHostResult(typedMethod, result) : result) as T;
  }

  disconnect(): void {
    this.#port.disconnect();
  }

  #request(method: string, params?: JsonValue): Promise<JsonValue | undefined> {
    const id = crypto.randomUUID();
    const request: NativeRequest = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#port.postMessage(request);
    });
  }

  #handleMessage(message: NativeResponse): void {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(new NativeHostError(message.error.code, message.error.message, message.error.details));
    } else {
      pending.resolve(message.result);
    }
  }
}
