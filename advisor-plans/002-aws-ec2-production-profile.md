# Plan 002: Add a first-class AWS EC2 production profile

> **Executor instructions**: Follow this plan step by step. Run each
> verification command before continuing. Do not copy live secret values into
> source, tests, logs, or documentation. Stop on any condition listed below.

## Status

- **Priority**: P1
- **Effort**: L (2–3 working days)
- **Risk**: MED
- **Depends on**: none
- **Category**: migration / DX
- **Planned at**: commit `11ac0b5`, 2026-08-08

## Why this matters

The production launcher currently requires two hostnames, starts local
Postgres and MinIO, and only accepts `minio` or `r2`. API and worker storage
clients require static access keys and force path-style requests. That blocks
the intended Ireland deployment: one EC2 application host, private RDS,
private AWS S3, a local Redis container, and an EC2 IAM role.

The result of this plan is one documented AWS profile that supports either a
direct Elastic IP with Caddy TLS or a later ALB without changing application
containers or tenant setup.

## Current state

- `deploy/up.sh:48-56` requires `BERRY_DOMAIN` and `BERRY_FILES_DOMAIN`.
- `deploy/up.sh:108-135` accepts only `r2` and `minio` storage modes.
- `deploy/compose.yaml` starts local Postgres and optionally MinIO.
- `deploy/Caddyfile:53-60` exposes MinIO through the files hostname.
- `apps/api/src/files/file-platform.module.ts:13-27` requires explicit S3 keys
  and forces path-style requests.
- `apps/api/src/main.ts:345-381` repeats the same S3 assumptions.
- `apps/worker/src/knowledge/services.ts`, `file-blobs.ts`,
  `file-deletion.ts`, and `sandbox-continuity.ts` repeat them in the worker.

Production secrets remain only in untracked `deploy/.env.production` per
`AGENTS.md`. Never replace that file from deployment automation.

## Commands

| Purpose | Command | Expected result |
|---|---|---|
| API types | `pnpm --filter @berry/api... typecheck` | exit 0 |
| Worker types | `pnpm --filter @berry/worker... typecheck` | exit 0 |
| Deploy checks | `pnpm check:compose && pnpm check:deploy` | exit 0 |
| Focused tests | `pnpm --filter @berry/api test -- deploy-config.test.ts` | all pass |

## Scope

**In scope**:

- `deploy/up.sh`, `deploy/production-up.sh`, `deploy/server-deploy.sh`
- `deploy/compose.yaml` and a new AWS EC2 Compose override
- `deploy/Caddyfile` plus direct-edge and ALB-edge variants if needed
- `deploy/.env.production.example`, `deploy/PRODUCTION.md`
- API and worker S3 client construction named above
- deployment configuration tests

**Out of scope**:

- Creating live AWS resources or changing GoDaddy DNS
- Kubernetes/Helm behavior
- Multi-instance API scaling
- Storing OAuth secrets in environment variables

## Steps

### Step 1: Define the AWS production contract

Add `BERRY_DEPLOYMENT_PROFILE=aws-ec2` and
`BERRY_OBJECT_STORAGE_MODE=s3`. For this mode:

- `BERRY_DOMAIN` is required; `BERRY_FILES_DOMAIN` is forbidden or ignored.
- `BERRY_DATABASE_URL` points to RDS and no application Postgres container
  starts.
- Redis remains a private local container for this single-node profile.
- artifact and audit bucket names plus `eu-west-1` are required.
- S3 endpoint and access-key variables are optional.
- the AWS SDK default credential chain supplies the EC2 instance-role
  credentials.

Document two edge modes: `direct` exposes Caddy on 80/443 and obtains TLS;
`alb` exposes internal HTTP only and trusts the ALB health check/proxy headers.
The selected mode must not change API, worker, database, or S3 configuration.

**Verify**: deployment config tests reject a missing RDS URL or bucket and
accept an AWS profile without a files hostname or static AWS keys.

### Step 2: Make AWS S3 behavior native

For every API and worker S3 client:

- omit `credentials` when keys are absent;
- omit `endpoint` when using AWS S3;
- set `forcePathStyle` only for explicit S3-compatible endpoints;
- keep presigned upload/download behavior and private buckets;
- never generate a public bucket URL.

Extract small package-local helpers so API constructors agree with each other
and worker constructors agree with each other. Add unit tests for AWS IAM mode
and explicit endpoint mode.

**Verify**: API and worker typechecks pass; tests assert no static credentials
or path-style endpoint are required in AWS mode.

### Step 3: Add the EC2 Compose profile

Create an override that runs web, API, worker, Mem0, Tika, embeddings, Redis,
and the selected edge container. Do not start local Postgres or MinIO. Keep
Redis data on an encrypted EBS-backed Docker volume with persistence enabled.
Pass RDS and S3 configuration to only the services that need it.

Keep `/healthz` for liveness and `/readyz` for dependency readiness. Direct
edge mode publishes only ports 80/443. ALB mode publishes only the application
HTTP target port to the EC2 security group.

**Verify**: `docker compose ... config --quiet` succeeds for direct and ALB
fixtures and contains no `postgres`, `mem0-postgres`, or `minio` service.

### Step 4: Add an operator preflight

Add a non-secret-printing preflight command that checks:

- required environment variable names and placeholder values;
- RDS connectivity and required extensions/migrations;
- Redis connectivity;
- S3 artifact/audit bucket access using the runtime identity;
- public hostname and edge-mode consistency.

Return one line per check with `ready`, `warning`, or `blocked`. Exit non-zero
when any required check is blocked. Never print URLs containing credentials,
tokens, access keys, or secrets.

**Verify**: fixture tests cover missing values, direct mode, ALB mode, and
redaction.

### Step 5: Update the deployment runbook

Document the exact order: provision AWS, create `.env.production`, run
preflight, deploy containers, verify `/readyz`, then open the one-time setup
URL. Include the single GoDaddy `A ai -> Elastic IP` record for direct mode and
the `CNAME/Alias -> ALB hostname` difference for ALB mode.

**Verify**: `pnpm check:deploy` and `pnpm check:docs` pass.

## Done criteria

- [ ] AWS mode starts without MinIO, local Postgres, a files hostname, or
  static AWS keys.
- [ ] EC2 instance-role credentials work for API and worker S3 operations.
- [ ] Direct Elastic IP and ALB edge modes use the same application profile.
- [ ] Preflight fails safely and never prints secret values.
- [ ] Focused API, worker, Compose, deployment, and docs checks pass.

## STOP conditions

- AWS SDK behavior requires making the bucket public.
- Existing file URLs cannot remain compatible without a data migration.
- The Compose override would expose RDS, Redis, Tika, or Mem0 publicly.
- Implementing ALB support requires changing application request semantics
  rather than proxy/trusted-header configuration.

## Maintenance notes

Review every future object-storage constructor against both AWS IAM mode and
explicit-endpoint mode. Horizontal API scaling remains out of scope because
runtime SQLite and in-memory event-stream state still need separate work.
