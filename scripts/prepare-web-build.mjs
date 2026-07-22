#!/usr/bin/env node

import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const outputDir = resolve(import.meta.dirname, "../apps/web/dist");

await rm(outputDir, { recursive: true, force: true });
console.log(`[web-build] cleared ${outputDir}`);
