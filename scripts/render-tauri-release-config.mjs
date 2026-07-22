#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const inputPath = resolve(root, "apps/desktop/src-tauri/tauri.release.conf.json");
const outputPath = resolve(root, "apps/desktop/src-tauri/target/tauri.release.generated.conf.json");

const publicKey = requiredEnv("TAURI_UPDATER_PUBLIC_KEY", "BERRY_UPDATER_PUBLIC_KEY", "TAURI_SIGNING_PUBLIC_KEY");
const endpoint = requiredEnv("TAURI_UPDATER_ENDPOINT", "BERRY_UPDATER_ENDPOINT");
const config = JSON.parse(readFileSync(inputPath, "utf8"));

config.bundle = {
  ...(config.bundle ?? {}),
  createUpdaterArtifacts: true,
};
config.plugins = {
  ...(config.plugins ?? {}),
  updater: {
    ...((config.plugins ?? {}).updater ?? {}),
    pubkey: publicKey,
    endpoints: [endpoint],
  },
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(outputPath);

function requiredEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
}
