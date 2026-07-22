# ADR 0002: Adaptive UI Switch Mode Tool

Status: superseded by the two-profile `conversationKind` design in `docs/modes.md`. Legacy schemas remain readable, but adaptive classification and `switch_mode` are no longer active.

## Context

`plans/berry-platform-product-decisions.md` sections 6 and 7.6 define Chat, Code, and Co-work as Berry's product thesis. Mode must be auditable and replayable rather than inferred from assistant prose.

## Decision

Berry stores UI mode per task and lets the agent request mode changes only through a structured `switch_mode` tool. The tool emits a `mode.changed` stream event and persists the mode when allowed. User-pinned mode always wins. A first-prompt classifier seeds mode for new tasks, using the user's fast configured model with heuristic fallback and an off switch unless founder confirmation changes that default.

## Consequences

- Mode changes become visible transcript events and can be mocked in tests.
- Mode is presentation and tool-exposure only; it never changes permission mode.
- Mid-conversation escalation can render as a suggestion instead of forcing layout churn.
- Phase 3 must add `switch_mode` to every mode toolset and mirror schemas/dev mocks like every renderer-visible host method.
