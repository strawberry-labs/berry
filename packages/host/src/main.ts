#!/usr/bin/env node
import { JsonlRpcPeer } from "@berry/local-agent-protocol";
import type { JsonValue } from "@berry/shared";
import { BerryHostService } from "./service.ts";
import { startHostSocketServer, type HostSocketServer } from "./socket-server.ts";

// No top-level await: the Node SEA build bundles this entry as CommonJS.
async function main(): Promise<void> {
  const expectedNonce = process.env.BERRY_HOST_NONCE;
  const dbPath = process.env.BERRY_DESKTOP_DB;
  const host = new BerryHostService({
    ...(dbPath ? { dbPath } : {}),
    ...(expectedNonce ? { expectedNonce } : {}),
  });
  await host.initialize();
  let socketServer: HostSocketServer | null = null;

  const peer = new JsonlRpcPeer(
    process.stdin,
    process.stdout,
    async (method, params) => host.handle(method, params),
    {
      onError(error) {
        host.log("error", "jsonl-rpc", error.message);
      },
    },
  );

  const socketPath = process.env.BERRY_HOST_SOCKET;
  if (socketPath) {
    try {
      socketServer = await startHostSocketServer({
        host,
        socketPath,
        ...(expectedNonce ? { expectedNonce } : {}),
        log: (message) => host.log("error", "socket-rpc", message),
      });
    } catch (error) {
      host.log("warn", "socket-rpc", `Desktop host discovery socket unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  host.setPublisher((event) => {
    peer.notify("host.event", event as JsonValue);
    socketServer?.publish(event);
  });

  peer.start();

  let shuttingDown = false;
  const shutdown = async (exit: boolean) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const hostShutdown = host.shutdown();
    await socketServer?.close();
    await hostShutdown;
    if (exit) process.exit(0);
  };
  process.stdin.once("end", () => void shutdown(false));
  process.on("SIGTERM", () => void shutdown(true));
  process.on("SIGINT", () => void shutdown(true));
}

main().catch((error) => {
  console.error("berry-host failed to start:", error);
  process.exit(1);
});
