#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { JsonlRpcPeer } from "@berry/local-agent-protocol";
import { PROTOCOL_VERSION } from "@berry/shared";

const CONFIG_PATH = process.env.BERRY_EXTENSION_NATIVE_CONFIG ?? defaultConfigPath();
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const token = readFileSync(config.tokenPath, "utf8").trim();
const socket = createConnection(config.socketPath);
const peer = new JsonlRpcPeer(socket, socket, undefined, {
  onNotification(method, params) {
    writeNativeMessage({ type: "event", method, params });
  },
});
peer.start();
await once(socket, "connect");
await peer.request("host.handshake", { token, protocolVersion: PROTOCOL_VERSION });

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < length + 4) return;
    const payload = buffer.subarray(4, length + 4);
    buffer = buffer.subarray(length + 4);
    void handleNativeMessage(payload);
  }
});

process.stdin.on("end", () => {
  socket.destroy();
});

async function handleNativeMessage(payload) {
  let request;
  try {
    request = JSON.parse(payload.toString("utf8"));
    if (!request || typeof request !== "object" || typeof request.id !== "string" || typeof request.method !== "string") {
      throw new Error("Invalid native request");
    }
    const result = await peer.request(request.method, request.params);
    writeNativeMessage({ id: request.id, result });
  } catch (error) {
    writeNativeMessage({
      id: typeof request?.id === "string" ? request.id : "invalid",
      error: {
        code: error instanceof Error ? error.name : "native_error",
        message: error instanceof Error ? error.message : String(error),
        ...(error?.details !== undefined ? { details: error.details } : {}),
      },
    });
  }
}

function writeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once("error", reject);
  });
}

function defaultConfigPath() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (process.platform === "darwin") return `${home}/Library/Application Support/Berry/extension-native-host.json`;
  if (process.platform === "win32") return `${process.env.APPDATA ?? `${home}/AppData/Roaming`}/Berry/extension-native-host.json`;
  return `${process.env.XDG_CONFIG_HOME ?? `${home}/.config`}/berry/extension-native-host.json`;
}
