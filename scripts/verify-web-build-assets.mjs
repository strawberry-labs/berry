#!/usr/bin/env node

import { access, copyFile, readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const webDist = resolve(import.meta.dirname, "../apps/web/dist");
const serverDir = resolve(webDist, "server");
const clientDir = resolve(webDist, "client");
const cssReferencePattern = /\/assets\/styles-[A-Za-z0-9_-]+\.css/g;
const rootJavascriptBudget = {
  rawBytes: 1_500_000,
  gzipBytes: 450_000,
};
const forbiddenRootPreloadPrefixes = [
  "management-experience-",
  "management-primitives-",
];

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.name.endsWith(".js") ? [path] : [];
  }));
  return files.flat();
}

const references = new Set();
for (const file of await javascriptFiles(serverDir)) {
  const source = await readFile(file, "utf8");
  for (const reference of source.match(cssReferencePattern) ?? []) references.add(reference);
}

if (references.size === 0) {
  throw new Error("Web server build did not contain a stylesheet reference.");
}

const clientStylesheets = (await readdir(resolve(clientDir, "assets")))
  .filter((name) => /^styles-[A-Za-z0-9_-]+\.css$/.test(name));

for (const reference of references) {
  const referencedPath = resolve(clientDir, reference.slice(1));
  try {
    await access(referencedPath);
  } catch (error) {
    if (clientStylesheets.length !== 1) throw error;
    const emittedPath = resolve(clientDir, "assets", clientStylesheets[0]);
    await copyFile(emittedPath, referencedPath);
    console.log(`[web-build] created stylesheet alias ${basename(referencedPath)} from ${clientStylesheets[0]}`);
  }
  await access(referencedPath);
}

const serverAssetsDir = resolve(serverDir, "assets");
const startManifestName = (await readdir(serverAssetsDir))
  .find((name) => name.startsWith("_tanstack-start-manifest_v-") && name.endsWith(".js"));
if (!startManifestName) {
  throw new Error("Web server build did not contain a TanStack Start manifest.");
}

const startManifest = await readFile(resolve(serverAssetsDir, startManifestName), "utf8");
const rootPreloadsSource = startManifest.match(
  /__root__:\s*\{[\s\S]*?preloads:\s*\[([\s\S]*?)\],\s*scripts:/,
)?.[1];
if (!rootPreloadsSource) {
  throw new Error("TanStack Start manifest did not contain root preloads.");
}

const rootJavascript = [...rootPreloadsSource.matchAll(/"\/assets\/([^"]+\.js)"/g)]
  .map((match) => match[1]);
if (rootJavascript.length === 0) {
  throw new Error("TanStack Start manifest did not contain root JavaScript.");
}

for (const prefix of forbiddenRootPreloadPrefixes) {
  const match = rootJavascript.find((name) => name.startsWith(prefix));
  if (match) {
    throw new Error(`Optional chunk ${match} must not be preloaded by the root route.`);
  }
}

let rootRawBytes = 0;
let rootGzipBytes = 0;
for (const name of rootJavascript) {
  const source = await readFile(resolve(clientDir, "assets", name));
  rootRawBytes += source.byteLength;
  rootGzipBytes += gzipSync(source).byteLength;
}

if (rootRawBytes > rootJavascriptBudget.rawBytes) {
  throw new Error(`Root JavaScript is ${rootRawBytes} bytes; budget is ${rootJavascriptBudget.rawBytes}.`);
}
if (rootGzipBytes > rootJavascriptBudget.gzipBytes) {
  throw new Error(`Root JavaScript is ${rootGzipBytes} gzip bytes; budget is ${rootJavascriptBudget.gzipBytes}.`);
}

console.log(
  `[web-build] root JavaScript ${rootJavascript.length} files, ${rootRawBytes} bytes raw, ${rootGzipBytes} bytes gzip`,
);
console.log(`[web-build] verified ${references.size} server stylesheet reference${references.size === 1 ? "" : "s"}`);
