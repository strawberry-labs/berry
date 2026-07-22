# Berry

Berry is a self-hosted AI assistant and workspace for enterprises. It combines
chat, file work, tools, skills, MCP servers, managed sandboxes, organization
policy, usage controls, and administration in one web platform.

The current product priority is the web stack:

- `apps/web`: browser application
- `apps/api`: authentication, conversations, files, policy, and agent APIs
- `apps/worker`: background jobs, reporting, and usage processing
- `packages/*`: shared runtime, UI, database, sandbox, and protocol packages
- `deploy/`: Docker Compose, Caddy, and Helm deployment assets

Desktop, CLI, mobile, and extension packages remain in the monorepo, but they
do not block the web build or production deployment path.

## Local web setup

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @berry/web... typecheck
corepack pnpm --filter @berry/web... build
```

Run the web application:

```sh
corepack pnpm --filter @berry/web dev
```

Run focused platform checks:

```sh
corepack pnpm --filter @berry/api... typecheck
corepack pnpm --filter @berry/worker... typecheck
```

## Self-hosting

```sh
cp deploy/.env.production.example deploy/.env.production
# Fill the production values, then:
./deploy/production-up.sh
```

`deploy/.env.production` is intentionally ignored. Git-based deployments update
code and containers without replacing that file or the persistent Docker
volumes.

For a manual Git-based update, SSH to the host and run:

```sh
cd /opt/berry
./deploy/server-deploy.sh origin/main
```

The deployment script pulls public `main`, rebuilds only affected web-platform
services, and leaves `deploy/.env.production` and persistent volumes unchanged.

## License

Berry is licensed under the MIT License. Required third-party attributions are
listed in `NOTICE` and `THIRD_PARTY_NOTICES.md`.
