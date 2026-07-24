# Plan 001: Make the agent runtime safe and reusable for app runs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report—do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 483c817..HEAD -- packages/local-agent/src/runtime.ts packages/local-agent/src/runtime.test.ts apps/api/src/http/agent-api.controller.ts apps/api/src/http/agent-api.controller.test.ts apps/api/src/http/agent-api.module.ts apps/api/src/http/agent-turn.service.ts apps/api/src/http/agent-turn.service.test.ts apps/api/src/http/image-generation.service.ts apps/api/src/http/image-generation.service.test.ts`
>
> Also run:
> `git status --short -- packages/local-agent/src apps/api/src/http`
>
> If a listed in-scope file has changed since this plan was written, compare
> the "Current state" excerpts against the live code before proceeding. If an
> uncommitted change overlaps a line this plan needs, stop and report rather
> than overwriting it.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `483c817`, 2026-07-23

## Why this matters

Berry already has the correct governed execution path, but it is embedded in
`AgentApiController.startTurn` and cannot safely be reused by an Apps service.
The runtime also accepts arbitrary constructed tools and a replacement system
prompt, but has no parent-supplied tool allowlist or append-only prompt
extension. App execution must close both gaps before any packaged workflow is
allowed to run.

After this plan, chat and Apps can call one injectable turn service; app
instructions can be appended without removing Berry's safety prompt; and the
runtime can prove that the model never sees a tool outside the app allowlist.

## Current state

- `packages/local-agent/src/runtime.ts:116-163` defines `StartTurnOptions`.
  It has `extraSkills` and `systemPrompt`, but no `allowedTools` or
  `additionalSystemPrompt`.

  ```ts
  extraSkills?: AgentSkill[];
  excludedSkillPaths?: string[];
  projectTrusted?: boolean;
  // ...
  systemPrompt?: string;
  onEvent: (event: AgentStreamEvent) => void;
  ```

- `packages/local-agent/src/runtime.ts:597-687` starts a turn. An input
  beginning with `$skill-name` uses `state.harness.skill(...)`, which gives
  Apps a deterministic way to activate exactly the versioned skill.

  ```ts
  const explicitSkill = options.continueInterruptedTurn
    ? undefined
    : explicitSkillInvocation(options.input);
  // ...
  skill
    ? await state.harness.skill(skill.name, skill.instructions)
    : await state.harness.prompt(promptInput);
  ```

- `packages/local-agent/src/runtime.ts:930-965` assembles tools and builds the
  prompt. `systemPrompt` replaces the default instead of extending it.

  ```ts
  const tools = allTools;
  const systemPrompt = () => {
    const base = options.systemPrompt?.trim() || buildDefaultSystemPrompt(...);
  ```

- `packages/local-agent/src/tools.ts:168-197` is the current source of
  built-in tool names and risk classes. Exact names include `read_file`,
  `read_attachment`, `write_file`, `edit_file`, `apply_patch`, `bash`,
  `persist_artifact`, browser tools, `web_search`, `fetch_url`,
  `image_generation`, `tool_search`, and `task`. MCP names begin `mcp__`.

- `apps/api/src/http/agent-api.controller.ts:453-680` currently owns the
  complete turn orchestration: ownership checks, organization capabilities,
  model governance, budget reservation/reconciliation, attachment
  materialization, session-host callbacks, file output registration, task
  status, usage, and event streaming.

- `apps/api/src/http/agent-api.controller.ts:168-224` owns image generation
  budget and usage handling, while the turn method calls
  `this.generateImage(...)` to construct the `image_generation` bridge. This
  coupling must be removed when turn logic becomes a service.

- `apps/api/src/http/agent-api.module.ts:69-79` wires the controller and runtime
  providers. Follow its dynamic-module injection style.

- Repo convention: use Zod at trust boundaries, Nest dependency injection in
  the API, Vitest colocated `*.test.ts` files, and conventional commit messages
  such as `feat(chat): polish queue and conversation navigation`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Runtime tests | `pnpm --filter @berry/local-agent test` | exit 0; all runtime tests pass |
| API tests | `pnpm --filter @berry/api test` | exit 0; all API tests pass |
| Runtime typecheck | `pnpm --filter @berry/local-agent typecheck` | exit 0; no TypeScript errors |
| API typecheck | `pnpm --filter @berry/api... typecheck` | exit 0; no TypeScript errors |

## Scope

**In scope**:

- `packages/local-agent/src/runtime.ts`
- `packages/local-agent/src/runtime.test.ts`
- `apps/api/src/http/agent-api.controller.ts`
- `apps/api/src/http/agent-api.controller.test.ts`
- `apps/api/src/http/agent-api.module.ts`
- `apps/api/src/http/agent-turn.service.ts` (create)
- `apps/api/src/http/agent-turn.service.test.ts` (create)
- `apps/api/src/http/image-generation.service.ts` (create only if needed to
  remove the controller coupling)
- `apps/api/src/http/image-generation.service.test.ts` (create with the service)
- `plans/README.md` (update only the Plan 001 status row)

**Out of scope**:

- App schemas, database tables, endpoints, and web UI; Plans 002 and 003 own
  them.
- Changing permission semantics in `ToolGuard`.
- Treating Agent Skill `allowed-tools` frontmatter as an enforceable policy.
- Moving execution into `apps/worker`.
- Desktop, mobile, and extension behavior.
- The currently modified prompt-editor/composer files shown by `git status`.

## Git workflow

- Branch: `codex/001-app-runtime-foundations`
- Commit logical units with conventional messages. Suggested commits:
  `feat(agent): enforce host tool allowlists` and
  `refactor(api): extract governed agent turn service`.
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 1: Add append-only prompt extensions to the runtime

In `StartTurnOptions`, add:

```ts
additionalSystemPrompt?: string;
```

Keep `systemPrompt` for existing callers. In the system-prompt factory:

1. Build `base` exactly as today: a supplied `systemPrompt` or Berry's default.
2. Trim `additionalSystemPrompt`; if present, append it to `base` with two
   newlines.
3. Append activated-skill and conversation-profile fragments after that,
   preserving existing ordering and compaction behavior.

Do not allow Apps to use `systemPrompt`; Plan 002 will use only
`additionalSystemPrompt`. Add tests proving:

- Default Berry prompt markers remain when an additional prompt is supplied.
- The additional text appears exactly once.
- Existing custom `systemPrompt` behavior remains compatible.
- Empty/whitespace additional text changes nothing.

**Verify**:
`pnpm --filter @berry/local-agent test -- runtime` → exit 0; the four new
prompt-extension cases and all existing runtime cases pass.

### Step 2: Enforce a host-level exact tool allowlist

Add to `StartTurnOptions`:

```ts
allowedTools?: string[];
```

Implement a small exported or unit-testable helper in `runtime.ts` that:

- Treats `undefined` as unrestricted to preserve chat behavior.
- Treats `[]` as no model-visible tools.
- Matches exact tool names only; do not introduce glob semantics.
- Deduplicates the allowlist.
- Filters built-in, browser, web, image, MCP, and dynamically discovered MCP
  tools before they are passed to `AgentHarness`.
- Applies the same predicate inside MCP deferred-tool search callbacks, so a
  disallowed tool cannot appear later after the initial harness construction.
- Includes `tool_search` itself only when named in the allowlist.
- Does not implicitly add `task`, `bash`, browser, network, or MCP tools.

An explicitly invoked skill does not require `activate_skill`, because
`state.harness.skill(...)` activates it outside the model tool list.

Before starting the model, fail with a stable `tool_unavailable` error listing
any requested exact tool that is not present in the assembled runtime. This is
especially important for optional `persist_artifact` and
`image_generation`. Do not leak credentials or MCP configuration in the
error.

Add tests for:

- `undefined` preserves the existing tool list.
- `[]` exposes no tools.
- A small allowlist exposes exactly those tools.
- `task`, `bash`, web, browser, and MCP tools stay hidden unless named.
- Deferred MCP discovery cannot add a disallowed result.
- An unavailable optional tool fails before the provider is called.
- Explicit `$skill-name` activation still works when `activate_skill` is not
  allowed.

**Verify**:
`pnpm --filter @berry/local-agent test -- runtime` → exit 0; all tool filtering
and explicit-skill cases pass.

### Step 3: Extract image generation from the controller if required

If moving the turn method would make `AgentTurnService` call a controller
method, create an injectable `ImageGenerationService` and move the current
`generateImage` body plus its pure response helpers into it. Keep
`AgentApiController.generateImage` as a thin route adapter that parses the
body and delegates.

The service must retain:

- image-specific budget reservation and reconciliation;
- usage event recording;
- the existing remote image download timeout and MIME handling;
- current error mapping.

Do not duplicate image cost accounting inside `AgentTurnService`.

**Verify**:
`pnpm --filter @berry/api test -- agent-api.controller image-generation` →
exit 0; existing image endpoint cases and new service cases pass.

### Step 4: Extract `AgentTurnService`

Create `apps/api/src/http/agent-turn.service.ts`. Move the orchestration
currently inside `AgentApiController.startTurn` into an injectable service.
The controller route must keep its public request/response behavior and become:

1. parse `StartTurnRequestSchema`;
2. call `AgentTurnService.startAuthenticatedTurn(...)`;
3. return `{ turnId, sessionId }`.

Use a typed input similar to:

```ts
interface AgentTurnOverrides {
  feature?: string;
  metadata?: Record<string, JsonValue>;
  extraSkills?: AgentSkill[];
  allowedTools?: string[];
  additionalSystemPrompt?: string;
  permissionMode?: PermissionMode;
  networkPolicy?: NetworkPolicy;
  sandboxPolicy?: SandboxPolicy;
}

interface StartAuthenticatedTurnInput {
  request: AuthenticatedRequest;
  sessionId: string;
  body: StartTurnRequest;
  overrides?: AgentTurnOverrides;
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
}
```

Names may vary, but these behaviors may not:

- The service performs the existing owned-session/tenant checks rather than
  trusting caller-supplied tenant, task, or user IDs.
- Organization skills/MCP, model governance, budgets, attachment ownership,
  artifact registration, task status, usage, and event streaming still run
  exactly once.
- `overrides.extraSkills` are appended after resolved organization skills.
- Runtime restrictions are intersections, never privilege expansion:
  an override may narrow tools/network/sandbox/permission but may not widen
  organization policy.
- Budget and usage `feature` defaults to the current `"model"` value; Apps can
  set `"app.run"`.
- Override metadata is merged with existing mode/workspace metadata and must
  be JSON-safe.
- `onEvent` observes the already parsed event after normal persistence/event
  publication. An observer failure is logged/contained and cannot corrupt
  the turn.
- The existing projection-write queue moves with the turn service or is
  factored into a shared injectable collaborator; there must not be two
  independent queues writing the same session.
- The service exposes enough result data for Plan 002 to record the resolved
  `turnId`, `taskId`, `sessionId`, provider, and model without reaching into
  private controller state.

Keep unrelated session, terminal, approval, event-stream, and task endpoints
in the controller.

**Verify**:
`pnpm --filter @berry/api test -- agent-turn agent-api.controller` → exit 0;
all existing turn tests pass through the thin controller and new direct service
tests pass.

### Step 5: Add regression tests for restricted app-like turns

In `agent-turn.service.test.ts`, construct an app-like override with:

- one `extraSkills` entry whose `disableModelInvocation` is `true`;
- input beginning with `$<skill-name>`;
- an allowlist such as `read_attachment`, `write_file`, and
  `persist_artifact`;
- an `additionalSystemPrompt` containing a test output contract;
- feature `app.run` and IDs in metadata;
- network egress `off`.

Assert:

- the skill is explicitly activated;
- default system instructions remain present;
- only named tools reach the model;
- the budget reservation and usage record use `app.run`;
- organization governance still runs;
- output artifact callbacks still call `registerSandboxOutput`;
- `approval.request` and `turn.end` events reach the observer;
- a foreign attachment ID is rejected before the model starts.

**Verify**:
`pnpm --filter @berry/api test -- agent-turn` → exit 0; restricted-turn
integration cases all pass.

### Step 6: Wire and typecheck the module

Register and export `AgentTurnService` from `AgentApiModule`. Register
`ImageGenerationService` if created. Ensure a future Apps module can inject
the turn service through the Nest module graph without constructing it
manually.

Run the focused repository checks required by `AGENTS.md`.

**Verify**:

- `pnpm --filter @berry/local-agent typecheck` → exit 0.
- `pnpm --filter @berry/api... typecheck` → exit 0.
- `pnpm --filter @berry/api test` → exit 0.
- `git diff --check` → exit 0; no whitespace errors.

## Test plan

New runtime tests in `packages/local-agent/src/runtime.test.ts`:

- append-only system prompt behavior;
- exact allowlist semantics;
- no implicit high-risk tools;
- deferred MCP filtering;
- unavailable optional tools;
- explicit skill invocation without `activate_skill`.

New API tests in `agent-turn.service.test.ts`:

- unchanged normal chat orchestration;
- app-style restricted orchestration;
- governance and budget failure propagation;
- attachment ownership rejection;
- observer isolation;
- approval and completion events.

Use `apps/api/src/http/agent-api.controller.test.ts` as the dependency-fixture
pattern, but move reusable turn fixtures into the new service test rather than
copying a large controller constructor setup.

## Done criteria

- [ ] `StartTurnOptions` supports `additionalSystemPrompt` and exact
  `allowedTools`.
- [ ] Berry's default prompt is retained for app-style turns.
- [ ] The model cannot see a tool omitted from `allowedTools`, including a
  deferred MCP tool.
- [ ] `AgentApiController.startTurn` is a thin adapter to one injectable
  `AgentTurnService`.
- [ ] Chat endpoint behavior and response shape are unchanged.
- [ ] App-style turns retain model governance, budget, usage, task, file,
  artifact, approval, and audit-adjacent event behavior.
- [ ] Runtime and API tests/typechecks pass.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` Plan 001 row is updated.

## STOP conditions

Stop and report if:

- Current turn orchestration differs materially from the excerpts above.
- Implementing the allowlist would require weakening `ToolGuard`.
- An MCP deferred-tool path can still bypass the predicate after two
  reasonable attempts.
- Extracting the turn service would duplicate budget reconciliation, file
  registration, or projection writes rather than centralizing them.
- A change is required in one of the user's existing dirty prompt-editor,
  composer, or `web-shell.spec.ts` files.
- Any verification command fails twice after a focused fix.

## Maintenance notes

- The allowlist is a host policy, not a promise that a listed optional tool
  exists. App publish validation and run-time unavailable-tool errors must both
  remain.
- Future tool registries must pass through the same allowlist predicate,
  including plugin and deferred tools.
- Reviewers should scrutinize privilege intersections, budget reconciliation
  on every error path, observer error isolation, and the ordering of default
  versus additional system prompts.
- Durable worker-owned inference remains deferred.
