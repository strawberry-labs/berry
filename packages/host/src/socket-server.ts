import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { JsonlRpcPeer } from "@berry/local-agent-protocol";
import type { HostPushEvent, JsonValue } from "@berry/shared";

export interface HostSocketEndpoint {
  handle(method: string, params: JsonValue | undefined): Promise<JsonValue | undefined>;
}

export interface HostSocketServerOptions {
  host: HostSocketEndpoint;
  socketPath?: string;
  expectedNonce?: string;
  log?: (message: string) => void;
}

export interface HostSocketServer {
  readonly socketPath: string;
  readonly tokenPath: string;
  publish(event: HostPushEvent): void;
  close(): Promise<void>;
}

const OWNER_SCOPED_METHODS = new Set([
  "agent.turn",
  "agent.steer",
  "agent.followUp",
  "agent.cancel",
  "agent.takeover",
]);

export function defaultHostSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_RUNTIME_DIR ?? tmpdir(), "berry", "host.sock");
}

export function hostSocketTokenPath(socketPath: string): string {
  return `${socketPath}.token`;
}

export async function startHostSocketServer(options: HostSocketServerOptions): Promise<HostSocketServer> {
  const socketPath = options.socketPath ?? defaultHostSocketPath();
  const tokenPath = hostSocketTokenPath(socketPath);
  const token = crypto.randomUUID();
  const peers = new Set<JsonlRpcPeer>();
  const sockets = new Set<Socket>();
  let closed = false;

  mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer((socket) => {
    const owner = `app-server:${crypto.randomUUID()}`;
    let authenticated = false;
    const peer = new JsonlRpcPeer(
      socket,
      socket,
      async (method, params) => {
        if (method === "host.handshake") {
          const input = recordParam(params);
          if (input.token !== token) throw rpcError("unauthorized", "Invalid app-server token");
          const handshake = { ...input };
          delete handshake.token;
          const result = await options.host.handle("host.handshake", {
            ...handshake,
            ...(options.expectedNonce ? { nonce: options.expectedNonce } : {}),
          });
          authenticated = true;
          return result;
        }
        if (!authenticated) throw rpcError("unauthorized", "App-server token handshake required");
        return options.host.handle(method, OWNER_SCOPED_METHODS.has(method) ? { ...recordParam(params), owner } : params);
      },
      { onError: (error) => options.log?.(error.message) },
    );
    peers.add(peer);
    sockets.add(socket);
    socket.once("close", () => {
      peers.delete(peer);
      sockets.delete(socket);
    });
    peer.start();
  });

  await listenWithStaleRecovery(server, socketPath);
  chmodSync(socketPath, 0o600);
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });

  return {
    socketPath,
    tokenPath,
    publish(event) {
      for (const peer of peers) peer.notify("host.event", event as unknown as JsonValue);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      removeOwnedPath(tokenPath, token);
      if (!existsSync(tokenPath) && existsSync(socketPath)) unlinkSync(socketPath);
    },
  };
}

async function listenWithStaleRecovery(server: Server, socketPath: string): Promise<void> {
  try {
    await listen(server, socketPath);
  } catch (error) {
    if (!isAddressInUse(error) || (await acceptsConnection(socketPath))) throw error;
    if (existsSync(socketPath)) unlinkSync(socketPath);
    await listen(server, socketPath);
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function acceptsConnection(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

function removeOwnedPath(path: string, token: string): void {
  if (!existsSync(path)) return;
  try {
    if (readFileSync(path, "utf8").trim() === token) unlinkSync(path);
  } catch {
    // Another process may have replaced the discovery files during shutdown.
  }
}

function recordParam(value: JsonValue | undefined): Record<string, JsonValue | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue | undefined>) : {};
}

function rpcError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}
