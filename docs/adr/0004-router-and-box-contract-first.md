# ADR 0004: Router And Box Contract First

Status: accepted provisionally, pending founder confirmation in `plans/human-blockers.md`.

## Context

`plans/berry-platform-product-decisions.md` sections 5, 7.2, 10.5, 11.1, and 11.2 distinguish Berry the harness from Berry Router and Berry Box. The app must remain useful without Berry services, and this repo must not quietly become the Router product.

## Decision

Berry consumes Router and Box through typed contracts. The desktop/local harness supports direct providers and local runtimes without any Berry account. Router integration adds aliases, quotas, usage metadata, and hosted provider reach when configured. Berry Box is represented by a sandbox contract first; Phase 8 fulfills it with Docker plus one wrapped commercial provider unless the founder chooses a separate infrastructure build.

## Consequences

- `packages/router-client` remains a client/contract layer, not a mini-router.
- Phase 4 app work uses recorded fixtures when Router endpoints are not available.
- Phase 8 cloud execution targets `packages/sandbox-contract`; provider swaps must pass the same tests.
- Router and Box real-state confirmations remain human blockers before scope is claimed as complete.
