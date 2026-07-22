# Self-host Compose

Use this path for a single-machine or staging Berry platform stack.

## Prerequisites

- Docker with Compose v2.
- A shell with access to this repository.
- Local ports `3001`, `3108`, `5432`, and `6379` available, or edited service ports in the Compose file.

## Steps

```sh
cp deploy/.env.example deploy/.env
```

Edit `deploy/.env` and set production-grade secrets before using the stack outside local development. The default fixture values are for tests only.

Start the stack:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

Open:

- Platform API health: `http://localhost:3001/health`
- Web console: `http://localhost:3108`

## Connect Berry desktop

Use `http://localhost:3001` as the platform base URL during `berry login` or in the desktop platform settings. Use the policy public key generated for the environment if managed policy is enabled.

## Confirm it works

```sh
curl http://localhost:3001/health
berry login --base-url http://localhost:3001
```

- The API health check returns ok.
- The web console opens at `localhost:3108`.
- Berry can start OAuth login against the local platform.

## Move beyond local staging

Replace fixture secrets, configure TLS at the ingress or reverse proxy, use managed Postgres/Redis storage, and publish a real router/provider allowlist before connecting non-test users.
