# October 2026 security release

This release starts from freshly fetched main 0cb991e1b02fe20ffd915c6cf187c1d00a2aefcb. It pins all production Node stages to 22.23.4 with the official Bookworm image digest. All nine Node application containers must be replaced: API, web, Mem0, one background worker and five foreground workers.

Vite is pinned to patched 8.1.6/7.3.7 branches and the workspace Vitest suite to 4.1.12. The production MCP integration is a client; SDK 1.32.0 fixes its OAuth/redirect issues. Its test fixtures are stdio servers, not public MCP HTTP endpoints. TanStack Start 1.168.60, matching Router 1.170.41, Seroval 1.7.0, proxy-addr 2.0.8 and compatible middleware/parser patches also remove older critical/high findings.

Validation passed on Node 22.23.4: all four production service dependency builds; web/API/worker/Mem0 dependency typechecks; 2,452 source tests across 16 workspaces; Compose, Docker-context and deployment-impact checks. Source tests exclude generated dist copies, whose TypeScript-path mocks cannot run after compilation. Existing opt-in integration skips remain recorded by the runner. Generated route changes were ordering-only and were excluded from the commit.

The final whole-repository production dependency audit has zero critical, four high, twelve moderate and one low findings. Three high findings are in mobile-only Expo tooling (image-size and node-forge); the other is unpatched braces in Mem0's transitive Jest type/test dependency. These findings are tracked, not represented as fixed. Desktop/mobile packaging is outside this web production deployment.

Production's dirty checkout and stale deployment marker must not be overwritten. Preserve a private source archive, binary working-tree patch, runtime configuration, environment fingerprint and previous image IDs. Build the merged main commit in a separate server checkout, preserve every existing runtime setting and the production environment file, and add current-main defaults only for new keys. The latest main contains additive scheduled-task database tables, so verify an encrypted RDS snapshot before running migrations and role grants. Pause queues, allow active jobs to finish, switch application services with readiness checks, and restore each queue's prior pause state. Keep the database, Redis, inference services, monitoring and proxy containers in place. An image rollback retains the additive schema.

Record the deployed main commit and separate release directory with the production evidence. Validate all nine Node versions, container health, replica counts, public health and login response, environment preservation and unchanged infrastructure identities after deployment. No model request, email or customer payment is required for these checks.

Sources:

- https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
- https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453
- https://github.com/TanStack/router/security/advisories/GHSA-qx66-fv34-fjm8
- https://github.com/lxsmnsyc/seroval/security/advisories/GHSA-p6vx-979v-rg4c
