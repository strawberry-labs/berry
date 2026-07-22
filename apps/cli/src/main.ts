#!/usr/bin/env node
import { runCli } from "./runner.ts";

runCli({ argv: process.argv.slice(2) })
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
