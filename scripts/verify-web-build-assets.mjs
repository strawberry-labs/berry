#!/usr/bin/env node

import { access, copyFile, cp, readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const webDist = resolve(import.meta.dirname, "../apps/web/dist");
const serverDir = resolve(webDist, "server");
const clientDir = resolve(webDist, "client");
const serverFileViewerDir = resolve(serverDir, "file-viewer");
const clientFileViewerDir = resolve(clientDir, "file-viewer");
const cssReferencePattern = /\/assets\/styles-[A-Za-z0-9_-]+\.css/g;

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

await cp(serverFileViewerDir, clientFileViewerDir, { recursive: true, force: true });
await access(resolve(clientFileViewerDir, "flyfish-viewer-manifest.json"));
console.log("[web-build] published file-viewer runtime assets to the client output");

console.log(`[web-build] verified ${references.size} server stylesheet reference${references.size === 1 ? "" : "s"}`);
