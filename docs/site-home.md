# Berry Documentation

Berry is a local-first agent workspace with a desktop app, CLI, host protocol, managed policy hooks, and extension catalogs for plugins, skills, and MCP servers.

Use this documentation as the v1 operator and developer reference. The quickstarts get a local or hosted model connected, the reference pages are generated from code where possible, and the operating guides describe what administrators must configure before a release goes live.

## First paths

- Start local inference with [Ollama in 5 minutes](quickstarts/ollama.html) or [LM Studio](quickstarts/lm-studio.html).
- Connect hosted models with [OpenRouter and Berry Router](quickstarts/openrouter-router.html).
- Run the platform services with [self-host Compose](quickstarts/self-host-compose.html) or [Helm](quickstarts/helm.html).
- Use the generated [CLI reference](reference/cli.html) and generated [host protocol reference](reference/host-protocol.html) when scripting against Berry.
- Review [policy and admin operations](operate/policy-admin.html) before enrolling a managed team.

## Release guardrails

The docs site is built from committed Markdown in `docs/` and generated references. `pnpm check` verifies that:

- `docs/reference/cli.md` matches `apps/cli/src/command-reference.ts`.
- `docs/protocol/host-methods.md` matches the shared host method catalog.
- Required quickstarts, admin, authoring, and migration pages exist.
- The static HTML site builds into `apps/docs/dist`.

## External validation

The code and docs are ready for a tester outside the project to run a quickstart end to end. That final outside-team validation is tracked in `plans/human-blockers.md` because it requires a human with a fresh machine and real provider account or local model setup.
