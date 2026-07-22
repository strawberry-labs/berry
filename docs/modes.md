# Conversation presentation profiles

Berry has two user-selected conversation profiles, persisted as `conversationKind`:

- `chat` is thread-first. It can use the full authorized tool registry, including files, MCP, skills, browser tools, subagents, approvals, questions, goals, and artifacts, while keeping developer workspace panes hidden.
- `code` uses the same task, session harness, tools, permissions, and sandbox policy while revealing Git, terminal, files, changes/review, and preview workspace surfaces.

Changing the profile updates the existing task in place. It never creates a replacement task, restarts or cancels a turn, changes the model or reasoning selection, grants permissions, or changes sandbox and network policy. The model, classifier, and tools cannot select a profile.

Legacy `ui_mode`, Co-work, group records, and `mode.changed` events remain decodable so old databases and event streams can open safely. They are not active product controls or runtime policy inputs. The CLI accepts `--ui-mode` for one compatibility window, maps `cowork` to `chat`, and emits a deprecation warning; new usage should pass `--kind chat|code`.

## Capability and policy behavior

Conversation kind is never a security boundary. Chat can read and modify files
inside the same authorized project or scratch-workspace boundaries as Code, and
the runtime tool registry is identical in both profiles. Permission mode,
approvals, organization policy, sandboxing, and network rules remain independent.

Organization Skills and MCP resolve in this order: blocked policy wins; required
items are enabled and locked; default-on items begin enabled but may be disabled
when policy permits; available items are user-selected. Personal additions are
accepted only when organization policy allows them. Managed capability metadata
and integrity hashes may sync to desktop, but organization credentials remain in
server or in-memory credential channels and never enter browser storage or the
desktop database.
