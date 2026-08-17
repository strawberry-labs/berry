# Plan 010: Make tool timeout and abort settlement truthful

> **Executor instructions**: Complete Plans 008 and 009 first. Follow this plan
> exactly, run every verification command, and preserve unrelated changes. Do
> not remove lease heartbeats or the distinction between abort-aware and
> non-abort-aware side effects. Do not commit, push, deploy, or open a PR. Leave
> the final verified diff uncommitted, mark this plan `IN REVIEW`, and wait for
> a human/AI code review.
>
> **Drift check (run first)**:
> `git diff --stat b36c77d3dc91f4c35454dbbefef54648e6877659..HEAD -- apps/worker/src/turn-runner.ts apps/worker/src/turn-runner.test.ts apps/worker/src/sandbox-continuity.ts apps/worker/src/personal-skills/tools.ts apps/worker/src/mcp-tools.ts apps/worker/src/memory/tools.ts apps/worker/src/vision-tools.ts`
>
> Accept changes required by Plans 008 and 009. Any unrelated behavioral drift
> is a STOP condition until this plan is reconciled.

## Status

- **Priority**: P1
- **Effort**: M (about one focused engineering day)
- **Risk**: HIGH
- **Depends on**: `plans/008-bound-sandbox-file-operations.md`, `plans/009-simplify-dynamic-skill-activation.md`
- **Category**: bug, reliability, tests
- **Planned at**: commit `b36c77d`, 2026-08-17

## Why this matters

The runner currently infers cancellation support from JavaScript function
arity. The personal-skill wrapper has four parameters, so Berry labels
`activate_skill` abortable even though its problematic path ignored the signal.
After 120 seconds the runner races the operation, waits a fixed 15 seconds, and
then persists `abortAcknowledged: true` based on capability rather than actual
settlement. This created the repeated 135-second signature and false audit data.

The durable runner itself is not unnecessary complexity: lease heartbeats,
idle/wall deadlines, and protection against overlapping external mutations must
remain. Simplify only the faulty seams: declare cancellation explicitly, record
whether the promise actually settled, and use a short cleanup grace now that
native E2B cancellation is wired.

## Current state

- `apps/worker/src/turn-runner.ts:1611` says:

  ```ts
  const toolAbortable = step.retryClass === "read_only"
    && this.tools.execute.length >= 3;
  ```

- The parallel read-only path at approximately line 1934 uses the same arity
  inference for a whole batch.
- `withHeartbeat` maintains the lease and both idle and wall timers. For an
  abortable operation it races the operation against the controller signal,
  then calls `waitForPromiseSettlement` with a default 15,000 ms.
- `waitForPromiseSettlement` returns `void`, so callers cannot distinguish
  actual settlement from expiry of the cleanup grace.
- The timeout catch persists `abortAcknowledged: toolAbortable`, which means
  "we thought this function could abort," not "it stopped."
- Commit `2276f09` added these bounds. It exposed the E2B hang and prevented an
  infinite wait, but it did not cause the underlying remote stall.

## Target semantics

| Condition | Abort signal sent? | Wait policy | Persisted `abortAcknowledged` |
|---|---|---|---|
| Explicitly abort-aware read-only tool | Yes | Race, then wait up to cleanup grace | `true` only if operation promise settled |
| Tool does not declare abort support | No timeout race | Keep lease until it settles | `false` |
| Abort-aware operation ignores signal | Yes | Stop waiting after cleanup grace | `false` |
| Non-idempotent/manual mutation | No speculative replay | Existing recovery path | Existing unknown-outcome handling |
| Parallel read-only batch | Yes only if every step declares support | One controlled batch | Derived from actual batch settlement |

For read-only timeouts, `outcomeCertainty: "known"` may remain because the tool
contract has no external mutation. That is separate from whether its underlying
promise acknowledged cancellation.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Runner tests | `pnpm --filter @berry/worker test -- turn-runner` | exit 0; all runner tests pass |
| Decorator tests | `pnpm --filter @berry/worker test -- personal-skills/tools mcp-tools memory/tools vision-tools` | exit 0 |
| Worker typecheck | `pnpm --filter @berry/worker typecheck` | exit 0, no TypeScript errors |
| Worker build | `pnpm --filter @berry/worker build` | exit 0 |

## Scope

**In scope**:

- `apps/worker/src/turn-runner.ts`
- `apps/worker/src/turn-runner.test.ts`
- `apps/worker/src/sandbox-continuity.ts`
- `apps/worker/src/sandbox-continuity.test.ts` only for capability coverage
- `apps/worker/src/personal-skills/tools.ts`
- `apps/worker/src/personal-skills/tools.test.ts`
- `apps/worker/src/mcp-tools.ts`, `apps/worker/src/mcp-tools.test.ts`
- `apps/worker/src/memory/tools.ts`, `apps/worker/src/memory/tools.test.ts`
- `apps/worker/src/vision-tools.ts`, `apps/worker/src/vision-tools.test.ts`
- `plans/README.md` status row

**Out of scope**:

- Removing heartbeat/lease protection, idle deadlines, wall deadlines, durable
  step markers, or recovery-required handling.
- Changing database columns or event schemas.
- Making non-idempotent external mutations abortable or automatically retryable.
- Adding provider-specific timeout races; Plan 008 uses native E2B cancellation.
- Tuning model-provider or compaction timeouts beyond the shared settlement
  helper's truthful result.
- API/web work, production secrets, deployment, and commits.

## Git workflow

- Work on the current branch and preserve the prior plans' uncommitted diff.
- Do not commit, push, deploy, or open a PR.
- End only after focused tests, typecheck, and build pass; request review.

## Steps

### Step 1: Replace arity inference with an explicit capability

Add an optional method to `DurableTurnToolExecutor`, with a simple boolean
contract such as:

```ts
supportsAbort?(snapshot: DurableTurnSnapshot, step: DurableTurnStep): boolean;
```

Rules:

- Missing method means `false`. Never inspect `Function.length`.
- `SandboxContinuityManager` returns true only for core operations whose entire
  path uses the signal after Plan 008.
- `DurablePersonalSkillToolExecutor` returns true for `activate_skill` after
  Plans 008/009; `save_personal_skill` remains false; all other tools delegate.
- MCP returns true for its own tools only where the connector execution receives
  the signal; `tool_search` remains false unless its full path is signal-aware.
- Memory returns false for its own DB/provider mutations and delegates others.
- Vision declares support only if the complete inspection path forwards and
  observes the signal; otherwise false.
- Every decorator delegates unknown tools to its base capability method.

In the runner, a single tool is abortable only when it is read-only and the
method returns true. A parallel batch is abortable only when every step is
read-only and every step returns true.

**Verify**:

1. `rg -n "execute\.length" apps/worker/src` -> no matches.
2. `pnpm --filter @berry/worker typecheck` -> exit 0.

### Step 2: Return actual settlement from the cleanup helper

Change `waitForPromiseSettlement` to return `Promise<boolean>`:

- `true` when the operation fulfills or rejects before the grace expires;
- `false` when the grace timer wins.

Carry this result on `DurableToolTimeoutError`, for example with a readonly
`abortAcknowledged`/`abortSettled` field that defaults to false. When
`withHeartbeat` aborts an operation, throw a timeout error containing the actual
settlement result. Preserve the original phase (`idle` or `wall`) and operation
kind.

Do not interpret an `AbortController.abort()` call itself as acknowledgment.
Acknowledgment requires the original operation promise to settle.

**Verify**:
`pnpm --filter @berry/worker test -- turn-runner` -> exit 0.

### Step 3: Persist truthful timeout state

In the single-tool timeout catch:

- Set `timedOut: true` as today.
- Keep `outcomeCertainty: "known"` for read-only tools.
- Set `abortAcknowledged` from the timeout error's actual settlement field, not
  from `supportsAbort`.
- Preserve the existing unknown-outcome/recovery behavior for manual
  non-idempotent operations.

For a parallel read-only batch, ensure a timeout is handled as a batch timeout;
do not mark individual steps acknowledged merely because the batch declared
support. If the current persistence shape cannot represent per-operation
settlement, persist false unless the whole `Promise.allSettled` operation
settled after abort.

**Verify**:
`pnpm --filter @berry/worker test -- turn-runner` -> exit 0.

### Step 4: Shorten, do not remove, the cleanup grace

Introduce a named default constant of 2,000 ms for abort settlement, while
preserving `options.abortCleanupTimeoutMs` for tests and controlled overrides.
The grace is not a second execution timeout; it only gives an already-aborted
promise time to run `finally` cleanup.

Do not reduce it to zero. Do not remove the wait entirely. Do not change the
rule that non-abort-aware side-effecting operations keep the lease until they
settle.

With Plan 008, native E2B abort should settle promptly and the 2-second ceiling
should rarely be consumed. A 120-second idle timeout must no longer produce a
systematic 135-second result.

**Verify**:
`pnpm --filter @berry/worker test -- turn-runner` -> exit 0.

### Step 5: Add failure-path tests that prove the distinction

In `turn-runner.test.ts`, add or update deterministic tests for:

1. A declared signal-aware read rejects on abort: timed out, known outcome,
   `abortAcknowledged: true`, and no 15-second wait.
2. A declared signal-aware read ignores abort: timed out, known outcome,
   `abortAcknowledged: false`, and return after the configured cleanup grace.
3. A function with three/four parameters but no capability declaration is not
   treated as abort-aware.
4. A capability-declared function is treated as abort-aware regardless of
   function arity.
5. A parallel batch is abortable only when all steps declare support.
6. A non-abort-aware mutation still holds the lease until settlement and uses
   the existing recovery-required path when its result is ambiguous.
7. External cancellation and idle timeout remain distinguishable.

Use small injected millisecond limits; never make the test sleep for production
durations. Update decorator tests to prove capability delegation and special-
tool overrides.

**Verify**:

1. `pnpm --filter @berry/worker test -- turn-runner personal-skills/tools mcp-tools memory/tools vision-tools` -> exit 0.
2. `pnpm --filter @berry/worker typecheck` -> exit 0.
3. `pnpm --filter @berry/worker build` -> exit 0.

## Test plan

- Capability declaration independent of JavaScript arity.
- Signal-aware operation settles vs ignores signal.
- Truthful persisted acknowledgment in both cases.
- Parallel all-aware and mixed-capability batches.
- Existing lease protection for side effects.
- Existing cancellation, idle deadline, wall deadline, repair, and recovery
  behaviors remain covered.

## Done criteria

- [ ] `rg -n "execute\.length" apps/worker/src` returns no matches.
- [ ] Abort support is explicit and delegated through every tool wrapper.
- [ ] Settlement helper returns a boolean and timeout errors carry it.
- [ ] `abortAcknowledged` is true only after the original promise settles.
- [ ] Default cleanup grace is named and no longer 15 seconds.
- [ ] Heartbeats, deadlines, and non-idempotent recovery remain intact.
- [ ] Focused tests, worker typecheck, and worker build pass.
- [ ] No commit, push, or deployment was performed.

## STOP conditions

Stop and report if:

- Any tool is marked abort-aware while one of its awaited sub-operations still
  drops the signal.
- A change would release the lease while a non-abort-aware external mutation is
  still running.
- Correctness appears to require removing durable running markers or retry
  classification.
- Plans 008/009 are incomplete or their tests do not pass.
- An in-scope behavior has drifted or a verification fails twice.

## Mandatory final review handoff

After every command passes:

1. Run `git status --short` and `git diff --stat`; report every modified file.
2. Run `git diff --check`; expected: no output and exit 0.
3. Do **not** stage or commit files.
4. Ask the reviewer to verify:
   - zero sandbox calls for instructions-only activation;
   - no staging manifest or hidden direct-file materialization;
   - native E2B signal/request timeout reaches every file call;
   - abort acknowledgment is based on settlement, not capability;
   - no lease/recovery safety was removed.
5. Wait for explicit operator approval. Only after review may the operator ask
   for a commit or deployment.
