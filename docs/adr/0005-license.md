# ADR 0005: License

Status: accepted provisionally, pending founder confirmation in `plans/human-blockers.md`.

## Context

`plans/berry-platform-product-decisions.md` sections 7.5, 8.3, 10.1, and 11.4 call out license posture as a product trust decision. Existing specs describe an MIT core with commercial managed hosting/support.

## Decision

Berry core remains permissive under MIT. Required MIT and Apache-2.0 third-party notices must be preserved in distributions that include those components.

## Consequences

- A root `LICENSE` file is still required before public release.
- Phase 11 must run a license/NOTICE audit before launch artifacts.
- Enterprise features stay available in the self-hosted build; the business is hosting, support, dedicated instances, Router, and Box usage.
- Any future attempt to add branding clauses, CLA surprises, or enterprise feature ransoming requires a new explicit ADR.
