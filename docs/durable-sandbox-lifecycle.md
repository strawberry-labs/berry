# Durable sandbox lifecycle

Berry treats sandbox activation as an explicit lifecycle transition. Reading
state, polling jobs, compaction, memory extraction, and other maintenance work
must not start or resume compute.

Metadata-only `activate_skill` calls are also non-lifecycle operations; only an
explicit resource request can trigger skill-package staging in a sandbox.

| Turn condition | Sandbox action |
| --- | --- |
| No sandbox-backed tool has run | No sandbox exists; creation is lazy |
| A sandbox-backed tool or requested sandbox image needs access | Create or explicitly resume |
| Waiting for approval or user input | Snapshot, then pause; destroy after a complete snapshot when pause is unsupported |
| Turn completed, failed, cancelled, or requires recovery | Snapshot, then pause; destroy when pause is unsupported |
| Delayed interval/manual snapshot reaches an inactive or terminal sandbox | No operation |
| A follow-up turn claims the prior session sandbox | Serialize ownership, then explicitly resume |

## Invariants

1. Provider file, exec, and port operations do not implicitly resume a paused
   E2B sandbox. `resume` is the only provider transition that wakes it.
2. Lifecycle transitions for one sandbox are serialized with a PostgreSQL
   advisory transaction lock.
3. Cleanup for an older run stops when a newer run has claimed the same
   sandbox.
4. Terminal cleanup is marked `pause_requested` before its queue job becomes
   visible, and delayed non-terminal snapshot rows are superseded.
5. A follow-up turn reconnects its prior E2B sandbox even when its worker has
   a cached handle with an unexpired lease. Another worker may have paused it
   during terminal cleanup. Resuming a run whose persisted sandbox state is
   inactive also bypasses the cache; active phases retain cheap handle reuse.
6. Read-only workspace state and capture endpoints never create or resume a
   browser workspace. `POST /v1/tasks/:taskId/workspace` is the explicit start
   operation.
