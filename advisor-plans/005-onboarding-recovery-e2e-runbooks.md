# Plan 005: Add recovery, end-to-end checks, and operator runbooks

> **Executor instructions**: Treat recovery commands as privileged production
> operations. They must require explicit confirmation, redact secrets, and be
> safe to retry.

## Status

- **Priority**: P1
- **Effort**: M (1–2 working days)
- **Risk**: MED
- **Depends on**: Plans 002, 003, and 004
- **Category**: tests / docs / operations
- **Planned at**: commit `11ac0b5`, 2026-08-08

## Why this matters

A production onboarding flow is incomplete without repeatable fresh-install
tests and a recovery path for a lost Google owner. Operators should not need
to edit Postgres manually or re-enable password login to regain access.

## Scope

**In scope**:

- setup/auth browser tests under `apps/web`
- API setup/auth integration tests
- deployment smoke scripts under `deploy/`
- an operator-only Google owner recovery command
- AWS, SSO, connector, backup, and go-live runbooks

**Out of scope**:

- Automatic disaster-recovery orchestration
- Password-based break-glass access
- Destructive reset of an active tenant

## Steps

### Step 1: Add a fresh-deployment end-to-end fixture

Create an isolated test profile with Postgres, Redis, S3-compatible test
storage, worker, API, and web. Stub only Google's external OAuth boundary; keep
Berry's setup, database, encryption, cookies, and callback code real.

Cover preflight, setup unlock, all wizard steps, Google owner claim, automatic
wizard removal, Google-only login, connector configuration, one file upload,
and one worker job.

**Verify**: the E2E command passes twice against the same fixture, proving
idempotency and completed-state behavior.

### Step 2: Add failure and race coverage

Test invalid/expired setup sessions, wrong owner, wrong Workspace domain,
personal Gmail, secret rotation, API restart mid-setup, two concurrent owner
callbacks, S3 denial, worker outage, and incomplete model configuration.

Assertions must verify safe messages and absence of secrets in responses and
logs.

**Verify**: all setup/auth API and web tests pass with no flaky timing waits.

### Step 3: Add Google-only owner recovery

Add an operator command that prepares a new designated Google owner claim. It
must run through SSM/host access, require the tenant ID, new Workspace email,
reason, and explicit confirmation, then use a database transaction and audit
record. It must never create a password account or silently demote the existing
owner.

Default behavior adds a second owner after verified Google sign-in. Ownership
transfer/removal remains a separate authenticated admin action.

**Verify**: command tests cover dry run, confirmation, invalid domain, active
pending recovery, idempotent retry, audit record, and successful Google claim.

### Step 4: Write the operator runbooks

Create one ordered launch runbook with four boundaries:

1. AWS infrastructure and DNS
2. environment/secrets and preflight
3. application deployment and onboarding
4. go-live verification and cleanup

Include exact Google SSO and connector redirect URIs, the instruction to clear
the setup token after completion, S3/RDS backup checks, and direct-EIP versus
ALB differences. Link existing detailed Google documents rather than copying
them.

**Verify**: docs and launch-check commands pass.

### Step 5: Add a redacted go-live report

Add a command that outputs pass/fail for containers, `/healthz`, `/readyz`,
TLS, setup completion, Google-only auth, S3 access, RDS migrations, worker
heartbeat, backups, and connectors. It must be safe to attach to an IT ticket.

**Verify**: a snapshot test confirms the report contains no credential-bearing
URLs, tokens, client secrets, cookies, or environment values.

## Done criteria

- [ ] A fresh deployment can be tested end to end with one command.
- [ ] Setup is safe under restart, retry, invalid input, and concurrent claims.
- [ ] Lost owner access can be recovered through Google without passwords.
- [ ] One launch runbook covers direct Elastic IP and ALB deployments.
- [ ] The go-live report is useful and safe to share with IT.

## STOP conditions

- Recovery requires direct, undocumented database edits.
- The E2E fixture bypasses Berry's real setup transaction or secret storage.
- A report or log includes a secret, setup token, cookie, or credential URL.
