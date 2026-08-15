# ADR 0002: Adaptive UI Switch Mode Tool

Status: retired. Berry’s web platform now presents one normal task experience;
legacy mode fields remain readable only for desktop and rollback compatibility.

## Context

The former adaptive mode proposal is retained as historical context. It is not a
web product contract and must not reintroduce selectors or mode-specific task
creation paths.

## Decision

Berry creates one normal task and does not expose a mode-switch tool. Existing
mode fields and events remain decodable at compatibility boundaries.

## Consequences

- Programming tools, files, previews, and code-writing remain part of the normal
  task experience.
- Compatibility code must not create a second web presentation or bypass policy.
