# CLI distribution

## Local builds

`node scripts/build-sidecars.mjs` now builds the desktop sidecars and the Node SEA CLI. The CLI artifacts are written to `artifacts/cli/berry-<rust-target>[.exe]` with adjacent SHA-256 files. Use `--cli-only` when desktop sidecars are not needed.

```sh
node scripts/build-sidecars.mjs --cli-only
node scripts/build-cli-bun.mjs
node scripts/benchmark-cli-packagers.mjs
```

Node SEA is the release format. The Bun build is a checked fallback and must continue to pass the SQLite-backed doctor smoke. Current measurements are in `docs/cli-packaging-benchmark.md`.

## Release contract

GitHub Actions release automation is not configured. CLI releases are built and published manually for macOS arm64/x64, Linux arm64/x64, and Windows x64. Each release must include the raw binary, checksum, rendered `install-berry.sh`, and rendered Homebrew formula.

The committed install script deliberately contains repository and version placeholders because the public repository name is still a founder decision. Fill both placeholders before publishing. A local or self-hosted distribution can bypass GitHub with `BERRY_DOWNLOAD_BASE_URL` and `BERRY_VERSION`.

```sh
BERRY_GITHUB_REPOSITORY=owner/repo sh scripts/install-berry.sh
# or
BERRY_DOWNLOAD_BASE_URL=https://downloads.example.test/cli-v0.1.0 sh scripts/install-berry.sh
```

`distribution/homebrew/berry.rb.template` is filled from release checksums by `scripts/render-homebrew-formula.mjs`. Commit the result to the Homebrew tap as a manual release step.

`packages/cli-npm` is a small npm launcher. Its postinstall downloads the same release binary, verifies SHA-256, and places it under `vendor/`; its `berry` bin forwards arguments and exit status. The workspace checkout skips the download. Set the final package name, version, and GitHub repository immediately before `npm publish`.

## Versioning

The CLI package, npm shim, release tag, and `CLI_VERSION` currently use `0.1.0`. A release bump must update `apps/cli/package.json`, `packages/cli-npm/package.json`, and `CLI_VERSION` together before creating `cli-v<version>`.
