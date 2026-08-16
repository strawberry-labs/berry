#!/usr/bin/env node

import { access, copyFile, readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

const webDist = resolve(import.meta.dirname, "../apps/web/dist");
const serverDir = resolve(webDist, "server");
const clientDir = resolve(webDist, "client");
const cssReferencePattern = /\/assets\/styles-[A-Za-z0-9_-]+\.css/g;
const rootJavascriptBudget = {
  // Deployment branding and auth-mode discovery add a small amount to the
  // shared shell. The onboarding wizard remains a lazy chunk. Retain tight raw
  // and compressed guards with less than 1% headroom over the previous budgets.
  rawBytes: 1_510_000,
  encodedBytes: 200_000,
  gzipBytes: 455_000,
};
const forbiddenRootPreloadPrefixes = [
  "management-experience-",
  "management-primitives-",
];
const taskOnlyAssetPrefixes = [
  "web-composer-",
  "web-task-view-",
  "task-route-state-",
  "message-history-benchmark-",
];
const routeBudgets = {
  home: { route: "/", variants: [{ name: "home", directPrefixes: [] }], rawBytes: 1_500_000, encodedBytes: 450_000, gzipBytes: 500_000, requestCount: 65 },
  task: { route: "/tasks/$taskId", variants: [{ name: "task", directPrefixes: [] }], rawBytes: 2_200_000, encodedBytes: 650_000, gzipBytes: 700_000, requestCount: 75 },
  settings: {
    route: "/settings/$tab",
    variants: [
      { name: "general", directPrefixes: ["general-settings-screen-"] },
      { name: "account", directPrefixes: ["account-settings-screen-"] },
      { name: "personalization", directPrefixes: ["personalization-settings-screen-"] },
      { name: "connectors", directPrefixes: ["personal-connectors-screen-"] },
      { name: "skills", directPrefixes: ["personal-skills-screen-"] },
      { name: "mcp", directPrefixes: ["personal-mcp-screen-"] },
      { name: "usage", directPrefixes: ["personal-usage-screen-"] },
      { name: "archived", directPrefixes: ["archived-chats-screen-"] },
    ],
    rawBytes: 2_100_000,
    encodedBytes: 600_000,
    gzipBytes: 700_000,
    requestCount: 85,
  },
  platform: {
    route: "/platform/$tab",
    variants: [
      { name: "overview", directPrefixes: ["platform-overview-screen-", "management-charts-"] },
      { name: "organizations", directPrefixes: ["platform-organizations-screen-"] },
      { name: "feature-rollout", directPrefixes: ["platform-rollout-screen-"] },
      { name: "router-health", directPrefixes: ["platform-router-health-screen-"] },
      { name: "billing-operations", directPrefixes: ["platform-billing-operations-screen-"] },
    ],
    rawBytes: 1_800_000,
    encodedBytes: 500_000,
    gzipBytes: 550_000,
    requestCount: 65,
  },
  admin: {
    route: "/admin/$tab",
    variants: [
      { name: "overview", directPrefixes: ["admin-overview-screen-"] },
      { name: "members", directPrefixes: ["admin-members-screen-"] },
      { name: "departments", directPrefixes: ["admin-departments-screen-"] },
      { name: "analytics", directPrefixes: ["analytics-screen-"] },
      { name: "spend-limits", directPrefixes: ["admin-spend-limits-screen-"] },
      { name: "credits-billing", directPrefixes: ["admin-billing-screen-"] },
      { name: "reports", directPrefixes: ["reports-alerts-screen-"] },
      { name: "policy", directPrefixes: ["admin-policy-screen-"] },
      { name: "service-accounts", directPrefixes: ["admin-service-accounts-screen-"] },
      { name: "roles", directPrefixes: ["admin-roles-screen-"] },
      { name: "resource-access", directPrefixes: ["admin-resource-access-screen-"] },
      { name: "providers", directPrefixes: ["admin-providers-screen-"] },
      { name: "models", directPrefixes: ["admin-models-screen-"] },
      { name: "skills-mcp", directPrefixes: ["admin-skills-mcp-screen-"] },
      { name: "feature-access", directPrefixes: ["admin-feature-access-screen-"] },
      { name: "sso-scim", directPrefixes: ["admin-sso-scim-screen-"] },
      { name: "managed-policy", directPrefixes: ["admin-managed-policy-screen-"] },
      { name: "audit-log", directPrefixes: ["admin-audit-log-screen-"] },
      { name: "connectors", directPrefixes: ["admin-connectors-screen-"] },
      { name: "organization", directPrefixes: ["organization-profile-screen-"] },
    ],
    rawBytes: 1_900_000,
    encodedBytes: 525_000,
    gzipBytes: 575_000,
    requestCount: 70,
  },
};

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.name.endsWith(".js") ? [path] : [];
  }));
  return files.flat();
}

function extractAssetNames(source) {
  return [...source.matchAll(/["']\/assets\/([^"']+\.js)["']/g)].map((match) => match[1]);
}

function extractStaticImports(source) {
  return [...source.matchAll(/(?:from\s*|import\s*)["']\.\/([^"']+\.js)["']/g)].map((match) => match[1]);
}

function extractDynamicImports(source) {
  return [...source.matchAll(/import\(\s*["'`]\.\/([^"'`]+\.js)["'`]\s*\)/g)].map((match) => match[1]);
}

function routePreloads(manifest, routeId) {
  const marker = routeId === "__root__" ? "__root__: {" : `${JSON.stringify(routeId)}: {`;
  const routeStart = manifest.indexOf(marker);
  if (routeStart < 0) throw new Error(`Web build manifest is missing route ${routeId}.`);
  const preloadStart = manifest.indexOf("preloads: [", routeStart);
  if (preloadStart < 0) throw new Error(`Web build manifest is missing preloads for ${routeId}.`);
  const preloadEnd = manifest.indexOf("]", preloadStart);
  if (preloadEnd < 0) throw new Error(`Web build manifest has malformed preloads for ${routeId}.`);
  return extractAssetNames(manifest.slice(preloadStart, preloadEnd));
}

async function readClientAsset(name) {
  return readFile(resolve(clientDir, "assets", name));
}

async function collectStaticClosure(initialNames) {
  const assets = new Set(initialNames);
  const queue = [...assets];
  while (queue.length > 0) {
    const name = queue.pop();
    const source = (await readClientAsset(name)).toString("utf8");
    for (const dependency of extractStaticImports(source)) {
      if (!assets.has(dependency)) {
        assets.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return assets;
}

async function criticalRouteAssets(manifest, route, variant) {
  const rootPreloads = routePreloads(manifest, "__root__");
  const routePreloadNames = routePreloads(manifest, route.route);
  const initial = new Set([...rootPreloads, ...routePreloadNames]);

  // AppShell is a root-level lazy module and is requested on every
  // authenticated route. The root index also contains lazy route declarations
  // for every URL; those are not requested for the current route and must not
  // inflate every route's critical graph.
  for (const name of rootPreloads) {
    const source = (await readClientAsset(name)).toString("utf8");
    for (const dependency of extractDynamicImports(source)) {
      if (dependency.startsWith("app-shell-")) initial.add(dependency);
    }
  }
  if (![...initial].some((name) => name.startsWith("app-shell-"))) {
    throw new Error(`The ${route.route} route is missing the AppShell lazy chunk.`);
  }

  // A route module can select a tab-specific screen through a dynamic import.
  // Include only the selected branch. Measuring every branch separately keeps
  // wildcard routes honest without charging users for tabs they did not open.
  for (const name of routePreloadNames) {
    const source = (await readClientAsset(name)).toString("utf8");
    for (const dependency of extractDynamicImports(source)) {
      if (variant.directPrefixes.some((prefix) => dependency.startsWith(prefix))) initial.add(dependency);
    }
  }

  const taskHints = route.route === "/tasks/$taskId"
    ? ["web-composer-", "web-task-view-", "task-route-state-"]
    : route.route === "/"
      ? ["web-composer-"]
      : [];
  if (taskHints.length > 0) {
    const appShellNames = [...initial].filter((name) => name.startsWith("app-shell-"));
    const matchedTaskHints = new Set();
    for (const name of appShellNames) {
      const source = (await readClientAsset(name)).toString("utf8");
      for (const dependency of extractDynamicImports(source)) {
        const matchedHint = taskHints.find((hint) => dependency.startsWith(hint));
        if (!matchedHint) continue;
        matchedTaskHints.add(matchedHint);
        initial.add(dependency);
      }
    }
    const missingTaskHints = taskHints.filter((hint) => !matchedTaskHints.has(hint));
    if (missingTaskHints.length > 0) throw new Error(`${route.route}/${variant.name} is missing task surface chunks: ${missingTaskHints.join(", ")}`);
  }
  let assets = await collectStaticClosure(initial);
  if (variant.directPrefixes.length > 0) {
    const matchedPrefixes = new Set(variant.directPrefixes.filter((prefix) => [...assets].some((name) => name.startsWith(prefix))));
    for (const name of assets) {
      const source = (await readClientAsset(name)).toString("utf8");
      for (const dependency of extractDynamicImports(source)) {
        const matchedPrefix = variant.directPrefixes.find((prefix) => dependency.startsWith(prefix));
        if (!matchedPrefix) continue;
        matchedPrefixes.add(matchedPrefix);
        initial.add(dependency);
      }
    }
    const missingPrefixes = variant.directPrefixes.filter((prefix) => !matchedPrefixes.has(prefix));
    if (missingPrefixes.length > 0) throw new Error(`${route.route}/${variant.name} is missing lazy chunks: ${missingPrefixes.join(", ")}`);
    assets = await collectStaticClosure(initial);
  }
  return assets;
}

async function measureRoute(manifest, route) {
  const measurements = [];
  for (const variant of route.variants) {
    const assets = await criticalRouteAssets(manifest, route, variant);
    if (route.route !== "/" && !route.route.startsWith("/tasks/")) {
      const taskOnly = [...assets].filter((name) => taskOnlyAssetPrefixes.some((prefix) => name.startsWith(prefix)));
      if (taskOnly.length > 0) {
        throw new Error(`${route.route}/${variant.name} includes task-only assets: ${taskOnly.join(", ")}`);
      }
    }
    let rawBytes = 0;
    let encodedBytes = 0;
    let gzipBytes = 0;
    for (const name of assets) {
      const source = await readClientAsset(name);
      rawBytes += source.byteLength;
      encodedBytes += brotliCompressSync(source).byteLength;
      gzipBytes += gzipSync(source).byteLength;
    }
    measurements.push({ variant: variant.name, assets, rawBytes, encodedBytes, gzipBytes, requestCount: assets.size });
  }
  return measurements;
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
let rootEncodedBytes = 0;
let rootGzipBytes = 0;
for (const name of rootJavascript) {
  const source = await readFile(resolve(clientDir, "assets", name));
  rootRawBytes += source.byteLength;
  rootEncodedBytes += brotliCompressSync(source).byteLength;
  rootGzipBytes += gzipSync(source).byteLength;
}

if (rootRawBytes > rootJavascriptBudget.rawBytes) {
  throw new Error(`Root JavaScript is ${rootRawBytes} bytes; budget is ${rootJavascriptBudget.rawBytes}.`);
}
if (rootEncodedBytes > rootJavascriptBudget.encodedBytes) {
  throw new Error(`Root JavaScript is ${rootEncodedBytes} Brotli bytes; budget is ${rootJavascriptBudget.encodedBytes}.`);
}
if (rootGzipBytes > rootJavascriptBudget.gzipBytes) {
  throw new Error(`Root JavaScript is ${rootGzipBytes} gzip bytes; budget is ${rootJavascriptBudget.gzipBytes}.`);
}

console.log(
  `[web-build] root JavaScript ${rootJavascript.length} files, ${rootRawBytes} raw, ${rootEncodedBytes} Brotli, ${rootGzipBytes} gzip`,
);
console.log(`[web-build] verified ${references.size} server stylesheet reference${references.size === 1 ? "" : "s"}`);

for (const [name, budget] of Object.entries(routeBudgets)) {
  const measurements = await measureRoute(startManifest, budget);
  for (const measured of measurements) {
    if (measured.rawBytes > budget.rawBytes) throw new Error(`${name}/${measured.variant} route is ${measured.rawBytes} raw bytes; budget is ${budget.rawBytes}.`);
    if (measured.encodedBytes > budget.encodedBytes) throw new Error(`${name}/${measured.variant} route is ${measured.encodedBytes} Brotli bytes; budget is ${budget.encodedBytes}.`);
    if (measured.gzipBytes > budget.gzipBytes) throw new Error(`${name}/${measured.variant} route is ${measured.gzipBytes} gzip bytes; budget is ${budget.gzipBytes}.`);
    if (measured.requestCount > budget.requestCount) throw new Error(`${name}/${measured.variant} route requests ${measured.requestCount} JavaScript assets; budget is ${budget.requestCount}.`);
  }
  const worst = measurements.reduce((current, candidate) => candidate.rawBytes > current.rawBytes ? candidate : current);
  console.log(`[web-build] ${name} worst=${worst.variant} ${worst.requestCount} files, ${worst.rawBytes} raw, ${worst.encodedBytes} Brotli, ${worst.gzipBytes} gzip`);
}
