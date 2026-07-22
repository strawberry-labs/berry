#!/usr/bin/env node
import { runBerryAcp } from "./index.ts";

const args = process.argv.slice(2);
const socketPath = flag(args, "--socket") ?? process.env.BERRY_HOST_SOCKET;
const tokenPath = flag(args, "--token") ?? process.env.BERRY_HOST_TOKEN;
const dbPath = flag(args, "--db") ?? process.env.BERRY_DESKTOP_DB;

runBerryAcp({
  ...(socketPath ? { socketPath } : {}),
  ...(tokenPath ? { tokenPath } : {}),
  ...(dbPath ? { dbPath } : {}),
}).catch((error) => {
  process.stderr.write(`berry-acp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  return value;
}
