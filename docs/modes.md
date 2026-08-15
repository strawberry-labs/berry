# Task experience

Berry’s web platform has one user-facing work unit: a task inside a project (or
the private general-task workspace). Every task uses the same assistant, model
governance, permissions, tools, files, and streaming behavior. Programming work,
code blocks, syntax highlighting, sandbox files, terminals, and previews remain
available inside that normal task experience; they are not a separate mode.

Legacy `conversationKind`, `ui_mode`, Co-work, and `mode.changed` records remain
decodable for desktop and rollback compatibility. Web task responses normalize
those values to the normal task presentation, and new web requests omit them.

## Capability and policy behavior

Task presentation is never a security boundary. Permission mode, approvals,
organization policy, sandboxing, and network rules remain enforced independently
of the task’s legacy persisted fields.

Organization Skills and MCP resolve in this order: blocked policy wins; required
items are enabled and locked; default-on items begin enabled but may be disabled
when policy permits; available items are user-selected. Personal additions are
accepted only when organization policy allows them. Managed capability metadata
and integrity hashes may sync to desktop, but organization credentials remain in
server or in-memory credential channels and never enter browser storage or the
desktop database.
