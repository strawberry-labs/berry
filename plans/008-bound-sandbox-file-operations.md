# Plan 008: Bound sandbox file operations with native cancellation

> **Executor instructions**: Follow this plan in order. Run every verification
> command and confirm the expected result before moving on. Preserve unrelated
> changes. Do not commit, push, deploy, or open a PR. When finished, leave the
> verified diff in the working tree, mark this plan `IN REVIEW` in
> `plans/README.md`, and wait for a reviewer. If a STOP condition occurs, report
> it and do not improvise.
>
> **Drift check (run first)**:
> `git diff --stat b36c77d3dc91f4c35454dbbefef54648e6877659..HEAD -- packages/sandbox-contract/src apps/worker/src/turn-runner.ts apps/worker/src/sandbox-continuity.ts apps/worker/src/personal-skills/tools.ts apps/worker/src/memory/tools.ts apps/worker/src/vision-tools.ts`
>
> If an in-scope file changed, compare the current-state excerpts below with
> live code. A behavioral mismatch is a STOP condition until the plan is
> reconciled.

## Status

- **Priority**: P1
- **Effort**: M (about one focused engineering day)
- **Risk**: MED
- **Depends on**: none
- **Category**: bug, reliability, tech-debt
- **Planned at**: commit `b36c77d`, 2026-08-17

## Why this matters

Berry's turn runner already creates an `AbortSignal`, and E2B SDK 2.33.1 already
accepts `signal` and `requestTimeoutMs` on filesystem requests. Berry currently
drops both before calling E2B. A stalled manifest read or batch upload therefore
continues until the outer 120-second idle limit plus a 15-second cleanup wait.

The fix is intentionally small: pass one operation-control object down the
existing call chain and use E2B's native cancellation. Do not add another
`Promise.race`, retry loop, watchdog, or file-operation timer.

## Current state

- `packages/sandbox-contract/src/provider.ts:41-53` accepts a signal for
  `read`, `write`, and `list`, but not `writeBytes` or `writeManyBytes`.

  ```ts
  read(input, options?: { signal?: AbortSignal }): Promise<...>;
  writeBytes?(input): Promise<...>;
  writeManyBytes?(input): Promise<...>;
  ```

- `packages/sandbox-contract/src/e2b-provider.ts:80-104` defines local E2B
  filesystem types without `signal` or `requestTimeoutMs`; lines 195-200 then
  discard the provider options:

  ```ts
  readonly files: SandboxFileApi = {
    read: (input) => this.readFile(input),
    writeManyBytes: (input) => this.writeManyFileBytes(input),
  };
  ```

- The installed SDK proves no custom timeout layer is needed. In
  `node_modules/.pnpm/e2b@2.33.1/node_modules/e2b/dist/index.d.ts`,
  `FilesystemRequestOpts` includes `requestTimeoutMs` and `signal`; `read`,
  `write`, `list`, `getInfo`, command requests, and `Sandbox.setTimeout` accept
  those options.

- `packages/sandbox-contract/src/docker-provider.ts` has a command executor
  that already accepts `signal`, but file methods do not forward it.
  `packages/sandbox-contract/src/router-provider.ts:#request` already accepts a
  fetch signal, but file methods do not forward it. The fixture can fail fast
  with `signal.throwIfAborted()`.

- `apps/worker/src/personal-skills/tools.ts:69-83` receives a signal but calls
  `activateSkill` and hidden resource materialization without it.

- `apps/worker/src/sandbox-continuity.ts:628-738` performs the skill manifest
  read, byte loading, batch write, fallback writes, and manifest write without
  a signal. `readSkillStageManifest` catches every exception, so an abort would
  currently be mistaken for a cache miss.

- Commit `2276f09` added the outer timeout and the partial file API signal. The
  omission is in Berry's forwarding, not a limitation in E2B.

## Design contract

1. The turn runner owns user-visible idle and wall deadlines.
2. The provider's configured `requestTimeoutMs` is the transport ceiling.
3. The same `AbortSignal` must reach every file request and mode-adjustment
   command started for one tool call.
4. Aborting must reject the provider promise; abort is never converted into a
   cache miss or ordinary not-found result.
5. No provider-specific timer or retry is added in this plan.
6. Lifecycle operations remain explicit. File operations must not resume a
   paused sandbox; preserve `docs/durable-sandbox-lifecycle.md`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Sandbox tests | `pnpm --filter @berry/sandbox-contract test -- e2b-provider docker-provider router-provider` | exit 0; all selected tests pass |
| Sandbox typecheck | `pnpm --filter @berry/sandbox-contract typecheck` | exit 0, no TypeScript errors |
| Worker tests | `pnpm --filter @berry/worker test -- personal-skills/tools sandbox-continuity` | exit 0; all selected tests pass |
| Worker typecheck | `pnpm --filter @berry/worker typecheck` | exit 0, no TypeScript errors |

## Scope

**In scope**:

- `packages/sandbox-contract/src/provider.ts`
- `packages/sandbox-contract/src/e2b-provider.ts`
- `packages/sandbox-contract/src/e2b-provider.test.ts`
- `packages/sandbox-contract/src/docker-provider.ts`
- `packages/sandbox-contract/src/docker-provider.test.ts`
- `packages/sandbox-contract/src/router-provider.ts`
- `packages/sandbox-contract/src/router-provider.test.ts`
- `packages/sandbox-contract/src/fixture-provider.ts`
- `apps/worker/src/turn-runner.ts` only for the skill-stage options contract
- `apps/worker/src/sandbox-continuity.ts`
- `apps/worker/src/sandbox-continuity.test.ts`
- `apps/worker/src/personal-skills/tools.ts`
- `apps/worker/src/personal-skills/tools.test.ts`
- `apps/worker/src/memory/tools.ts` and `apps/worker/src/vision-tools.ts` only
  if their forwarding signatures require a mechanical update
- `plans/README.md` status row

**Out of scope**:

- Changing E2B templates, baking organization skills into an image, or changing
  dynamic skill storage.
- Changing the 120-second tool idle limit or 15-second cleanup grace; Plan 010
  owns runner timeout semantics.
- Adding retries, circuit breakers, polling, or a second timeout wrapper.
- Changing sandbox pause/resume policy, API/DB schemas, or production secrets.
- Committing, pushing, deploying, or using AWS SSM.

## Git workflow

- Work on the current branch and preserve unrelated changes.
- Do not create a commit. Do not push or deploy.
- End with a clean test run and an uncommitted diff ready for review.

## Steps

### Step 1: Complete the provider-neutral file-operation contract

In `packages/sandbox-contract/src/provider.ts`, add one named type such as:

```ts
export interface SandboxOperationOptions {
  signal?: AbortSignal;
}
```

Use it consistently on `read`, `write`, `writeBytes`, `writeManyBytes`, and
`list`. Do not put E2B's `requestTimeoutMs` into the provider-neutral public
contract; that value belongs to provider configuration.

Update Docker, Router, and Fixture adapters:

- Docker passes `options.signal` to every `#executor.run` used by that file
  operation, including `chmod`.
- Router passes the signal through `#jsonRequest` to `#request`/`fetch`.
- Fixture calls `options.signal?.throwIfAborted()` before touching state.

**Verify**:
`pnpm --filter @berry/sandbox-contract typecheck` -> exit 0.

### Step 2: Use E2B's native request options

In `packages/sandbox-contract/src/e2b-provider.ts`:

1. Extend the local E2B-like types to match SDK 2.33.1 for filesystem,
   foreground command, `setTimeout`, client connection, and info calls.
2. Make the public `files` adapter forward its second argument.
3. Accept operation options in `readFile`, `writeFile`, `writeFileBytes`,
   `writeManyFileBytes`, and `listFiles`.
4. Build a small private request-options value containing only present fields:
   `requestTimeoutMs: this.#requestTimeoutMs` and `signal: options.signal`.
5. Pass it to `#sandbox`/reconnect/refresh, `files.getInfo`, `files.read`,
   `files.write`, `files.list`, and any `runForeground` chmod call started by
   that file operation.
6. Check `signal.throwIfAborted()` before starting the next sub-operation, so an
   abort between `getInfo` and `read`, or between upload and chmod, stops work.

Do not implement a `Promise.race`. Do not retry an aborted or timed-out request.
Preserve the configured 60-second production request timeout; this plan only
makes filesystem calls actually use it.

**Verify**:
`pnpm --filter @berry/sandbox-contract test -- e2b-provider` -> exit 0.

### Step 3: Propagate control through skill staging

In `apps/worker/src/turn-runner.ts`, extend
`DurableSkillPackageStageOptions` with `signal?: AbortSignal` and
`reportProgress?: () => void`.

In `apps/worker/src/personal-skills/tools.ts`:

- Pass `signal` and `reportProgress` into `activateSkill`.
- Until Plan 009 removes hidden materialization, pass the same control into that
  path too.
- Forward both values in the `stageSkillPackage` options.

In `apps/worker/src/sandbox-continuity.ts`:

- Pass the signal to the manifest read, batch write, byte-write fallback, text
  fallback, and manifest write.
- If `readSkillStageManifest` catches an error while `signal.aborted` is true,
  rethrow the abort reason/error. Only genuine missing/corrupt manifests are
  cache misses.
- Call `reportProgress` only after a completed unit of work: sandbox ensured,
  resource bytes loaded, batch/fallback write completed, and manifest write
  completed. Never emit synthetic progress while an E2B request is stalled.

Do not refactor the manifest here; Plan 009 removes it after cancellation is
safe.

**Verify**:
`pnpm --filter @berry/worker test -- personal-skills/tools sandbox-continuity`
-> exit 0.

### Step 4: Add cancellation regression tests

Add deterministic tests with deferred promises; do not call real E2B.

In `e2b-provider.test.ts`, cover:

1. `read` forwards the exact signal and configured request timeout to both
   `getInfo` and `read`.
2. `writeManyBytes` forwards both values to the SDK batch write.
3. Aborting a blocked read and blocked batch write rejects promptly.
4. A mode-changing write forwards cancellation to its foreground chmod.

In Docker and Router tests, assert the exact signal reaches the command executor
and fetch respectively. In worker tests, block the manifest read and batch write,
abort the controller, and assert no later staging operation starts.

Use fake timers only around Berry timers. For AbortSignal propagation, prefer a
deferred promise that rejects from an `abort` listener.

**Verify**:

1. `pnpm --filter @berry/sandbox-contract test -- e2b-provider docker-provider router-provider` -> exit 0.
2. `pnpm --filter @berry/worker test -- personal-skills/tools sandbox-continuity` -> exit 0.
3. Both package typechecks exit 0.

## Test plan

- Happy path: text read/write/list and binary batch write still satisfy the
  provider contract.
- Regression: E2B file calls receive `requestTimeoutMs` and the turn signal.
- Abort edge: an abort is propagated and prevents subsequent file/chmod work.
- Compatibility: Docker, Router, and Fixture implement the completed contract.
- Worker edge: an aborted manifest read is not swallowed as a cache miss.

## Done criteria

- [ ] All five `SandboxFileApi` operations accept one shared options type.
- [ ] E2B filesystem and file-related chmod calls receive native signal and
      request-timeout options.
- [ ] No new `Promise.race`, retry loop, or timer exists in the E2B provider.
- [ ] Skill-stage manifest and write calls receive the outer turn signal.
- [ ] `rg -n "writeBytes\?\(input: SandboxFileWriteBytesInput\):|writeManyBytes\?\(input: SandboxFileWriteManyBytesInput\):" packages/sandbox-contract/src/provider.ts` returns no matches.
- [ ] Focused tests and typechecks pass.
- [ ] Only in-scope files plus the plan status row are modified.
- [ ] No commit, push, or deployment was performed.

## STOP conditions

Stop and report if:

- Installed E2B is no longer 2.33.1 or its filesystem API does not accept both
  `requestTimeoutMs` and `signal`.
- Native E2B-style cancellation cannot make a blocked fake operation reject
  without adding a custom race/timer.
- Correct propagation requires changing sandbox lifecycle semantics or resuming
  a paused sandbox implicitly.
- An in-scope file has drifted behaviorally from the current-state excerpts.
- A verification command fails twice after a reasonable, scoped correction.

## Review and maintenance notes

The reviewer should trace one `AbortSignal` from `DurableTurnRunner` through
`DurablePersonalSkillToolExecutor`, `stageSkillPackage`, and the E2B fake. Pay
special attention to catch blocks: none may swallow an abort. The configured E2B
request timeout must remain a transport bound, not a replacement for the turn's
idle/wall deadlines.
