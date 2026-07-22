# CLI packaging benchmark

Measured 2026-07-09T20:04:27.373Z on darwin/arm64 (`aarch64-apple-darwin`). Times are medians of five cold process launches on this machine.

| Packager | Binary size | `--version` | `doctor --json` | SQLite migration |
|---|---:|---:|---:|---|
| Node SEA | 111.8 MiB | 92.8 ms | 99.3 ms | pass |
| Bun compile | 67.2 MiB | 91.0 ms | 97.4 ms | pass |

Node SEA is the release default because it runs the same Node runtime and `node:sqlite` implementation as the desktop host. Bun is retained as a CI-built fallback. Its build aliases `node:sqlite` to Bun's native `bun:sqlite`; the doctor smoke must pass before a Bun artifact can be promoted.

Reproduce with:

```sh
node scripts/build-sidecars.mjs --cli-only
node scripts/build-cli-bun.mjs
node scripts/benchmark-cli-packagers.mjs --write-doc
```
