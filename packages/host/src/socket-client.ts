import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { JsonlRpcPeer } from "@berry/local-agent-protocol";
import { isProtocolCompatible, PROTOCOL_VERSION, type HostPushEvent, type JsonValue } from "@berry/shared";
import { defaultHostSocketPath, hostSocketTokenPath } from "./socket-server.ts";

export interface HostRpcEndpoint {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  handle(method: string, params: JsonValue | undefined): Promise<JsonValue | undefined>;
  setPublisher(publisher: (event: HostPushEvent) => void): void;
}

export interface HostSocketClientOptions {
  socketPath?: string;
  tokenPath?: string;
  protocolVersion?: number;
}

export class HostSocketClient implements HostRpcEndpoint {
  readonly #socketPath: string;
  readonly #tokenPath: string;
  readonly #protocolVersion: number;
  #peer: JsonlRpcPeer | null = null;
  #socket: Socket | null = null;
  #publisher: ((event: HostPushEvent) => void) | undefined;

  constructor(options: HostSocketClientOptions = {}) {
    this.#socketPath = options.socketPath ?? defaultHostSocketPath();
    this.#tokenPath = options.tokenPath ?? hostSocketTokenPath(this.#socketPath);
    this.#protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  }

  async initialize(): Promise<void> {
    if (this.#peer) return;
    const token = readFileSync(this.#tokenPath, "utf8").trim();
    const socket = createConnection(this.#socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    this.#socket = socket;
    this.#peer = new JsonlRpcPeer(socket, socket, undefined, {
      onNotification: (method, params) => {
        if (method === "host.event") this.#publisher?.(params as unknown as HostPushEvent);
      },
    });
    this.#peer.start();
    try {
      const handshake = recordParam(await this.handle("host.handshake", { token, protocolVersion: this.#protocolVersion }));
      const hostVersion = handshake.protocolVersion;
      if (typeof hostVersion !== "number" || !isProtocolCompatible(hostVersion)) {
        throw new Error(`Host protocol version ${String(hostVersion)} is incompatible with client protocol ${this.#protocolVersion}`);
      }
    } catch (error) {
      await this.shutdown();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.#socket?.destroy();
    this.#socket = null;
    this.#peer = null;
  }

  async handle(method: string, params: JsonValue | undefined): Promise<JsonValue | undefined> {
    if (!this.#peer) throw new Error("Socket host is not connected");
    return this.#peer.request(method, params);
  }

  setPublisher(publisher: (event: HostPushEvent) => void): void {
    this.#publisher = publisher;
  }
}

function recordParam(value: JsonValue | undefined): Record<string, JsonValue | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue | undefined>) : {};
}
