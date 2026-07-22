# ADR 0003: Sandbox Tiers And Execpolicy

Status: accepted provisionally, pending founder confirmation in `plans/human-blockers.md`.

## Context

`plans/berry-platform-product-decisions.md` sections 7.5, 10.4, and spec 10 require Berry to move from approval-only safety to enforced local safety before aggressive coding workflows and platform scale.

## Decision

Berry implements three sandbox tiers: `read-only`, `workspace-write` with explicit writable roots and network toggle, and `danger-full-access`. Desktop enforcement is OS-backed where available: macOS Seatbelt first, Linux bubblewrap/seccomp next, Windows initially labeled approval-only unless restricted-token enforcement lands in Phase 11. A TypeScript `packages/execpolicy` engine classifies commands before execution using layered declarative rules where the strictest safety decision wins.

Phase 11 decision: Windows launches approval-only for v1. The runtime keeps execpolicy, prompts, grants, protected-path checks, audit records, and visible sandbox labels, but it does not claim restricted-token or job-object containment until a Windows implementation and CI proof exist.

## Consequences

- Phase 2 must unify command execution so Phase 6 has one enforcement insertion point.
- Approval grants become rules evaluated by the same engine, not a separate bypass.
- Every consequential action records a decision trace and local audit event.
- Windows launch posture must be explicit if enforcement is not complete.
