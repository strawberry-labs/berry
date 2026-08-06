#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const workspaces = new Map();

for (const group of ["apps", "packages"]) {
  const groupDir = resolve(root, group);
  for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const directory = resolve(groupDir, entry.name);
    const manifestPath = resolve(directory, "package.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const workspacePath = relative(root, directory).split(sep).join("/");
    assert(manifest.name, `${workspacePath}/package.json must declare a package name`);
    assert(!workspaces.has(manifest.name), `Duplicate workspace package name: ${manifest.name}`);
    workspaces.set(manifest.name, { manifest, workspacePath });
  }
}

for (const { manifest, workspacePath } of workspaces.values()) {
  assert(
    dockerfile.includes(`COPY ${workspacePath}/package.json`),
    `Dockerfile dependency layer is missing ${workspacePath}/package.json`,
  );

  for (const dependency of dependencyNames(manifest)) {
    if (!dependency.startsWith("@berry/")) continue;
    assert(workspaces.has(dependency), `${workspacePath} depends on unknown workspace ${dependency}`);
  }
}

for (const [service, packageName] of [
  ["api", "@berry/api"],
  ["worker", "@berry/worker"],
  ["mem0", "@berry/mem0"],
  ["web", "@berry/web"],
]) {
  const section = buildSection(service);
  for (const dependency of internalClosure(packageName)) {
    const { workspacePath } = workspaces.get(dependency);
    assert(
      section.includes(`COPY ${workspacePath} ./${workspacePath}`),
      `Dockerfile build-${service} is missing ${workspacePath} required by ${packageName}`,
    );
  }
}

console.log("[docker] production build contexts match the workspace dependency graph");

function dependencyNames(manifest) {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.devDependencies,
  });
}

function internalClosure(packageName, found = new Set()) {
  if (found.has(packageName)) return found;
  const workspace = workspaces.get(packageName);
  assert(workspace, `Missing production workspace ${packageName}`);

  found.add(packageName);
  for (const dependency of dependencyNames(workspace.manifest)) {
    if (workspaces.has(dependency)) internalClosure(dependency, found);
  }
  return found;
}

function buildSection(service) {
  const marker = `FROM workspace AS build-${service}`;
  const start = dockerfile.indexOf(marker);
  assert(start >= 0, `Dockerfile is missing ${marker}`);

  const remainder = dockerfile.slice(start + marker.length);
  const nextStage = remainder.search(/\nFROM /);
  return nextStage >= 0 ? remainder.slice(0, nextStage) : remainder;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
