# Runtime shutdown contract

`BerryHostService.shutdown()` is idempotent and begins by publishing `host.shutting_down`. It then rejects new `agent.turn` and `terminal.create` calls and stops the shared process executor from spawning children.

Shutdown order:

1. Cancel active agent turns and wait for turn-end persistence.
2. Mark active terminal rows `killed`, ask `berry-pty` to shut down, and terminate fallback shells.
3. Send SIGTERM to tracked process groups, wait 750 ms, then SIGKILL survivors. The Rust PTY sidecar has its own 3-second grace and signals both the PTY process group and descendants that moved into another group.
4. Close workspace watchers and sockets owned by the calling transport.
5. checkpoint SQLite WAL state and close the database.

If the host dies without this path, the next initialization marks persisted running turns and terminals `lost`. Turn replay receives a synthetic error plus failed `turn.end`; the task is marked failed and can be resumed from its persisted session.

`LocalProcessExecutor` is the only local child-process owner for agent shell commands, terminal fallback shells, and the PTY sidecar. Phase 6 can add sandbox and execpolicy hooks at this module without maintaining separate launch paths.
