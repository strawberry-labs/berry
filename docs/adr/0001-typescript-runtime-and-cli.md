# ADR 0001: TypeScript Runtime And CLI

Status: accepted provisionally, pending founder confirmation in `plans/human-blockers.md`.

## Context

`plans/berry-platform-product-decisions.md` sections 7.1 and 10.1 choose a runtime-first product with a compiled `berry` CLI/app-server, but reject a Go rewrite. The current repo already contains the TypeScript host/runtime (`packages/host`, `packages/local-agent`, `packages/harness`) and Rust seams for Tauri, PTY, credentials, and future sandbox enforcement.

## Decision

Berry keeps the runtime, host, CLI, app-server, ACP adapter, web, and mobile product logic in TypeScript. The CLI ships as a compiled binary using the existing Node SEA sidecar pipeline first, with Bun compile evaluated as a packaging alternative. Rust remains the boundary for Tauri shell integration, `berry-pty`, OS sandboxing, signing, and updater/security primitives. Go is not introduced for v1.

## Consequences

- Phase 2 can extract `apps/cli` without porting the runtime.
- Protocol stability comes from `HostMethodCatalog`, `AgentStreamEventSchema`, generated docs, and `PROTOCOL_VERSION`, not from a language rewrite.
- Native enforcement work lands in Rust where Berry already has platform code.
- Any future language port requires a measured, user-visible performance or distribution failure and a new ADR.
