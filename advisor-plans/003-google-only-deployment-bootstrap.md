# Plan 003: Add a resumable Google-only deployment bootstrap

> **Executor instructions**: Follow this plan step by step. Preserve strict
> tenant isolation and never return stored client secrets. Run each verification
> command before moving on.

## Status

- **Priority**: P1
- **Effort**: L (2–3 working days)
- **Risk**: HIGH
- **Depends on**: `advisor-plans/002-aws-ec2-production-profile.md`
- **Category**: security / architecture
- **Planned at**: commit `11ac0b5`, 2026-08-08

## Why this matters

Berry currently creates the first owner through one public setup form and a
local password. Google SSO can only be configured later by an authenticated
owner. That creates the wrong bootstrap order for a deployment where Google
Workspace must be the only login method.

This plan adds an explicit, resumable setup state machine. A deployment setup
token unlocks organization and OAuth configuration. The designated owner is
created only after Google verifies the exact configured Workspace account.

## Current state

- `apps/web/src/components/shell/auth-boundary.tsx:93-175` mixes first-owner
  setup, password login, signup, and Google login in one component.
- `apps/api/src/auth/auth-runtime.ts:76-82` requires a password during setup.
- `apps/api/src/auth/auth-runtime.ts:360-398` creates a credential account and
  marks setup complete in one transaction.
- `apps/api/src/auth/auth-runtime.ts:119-130` hardcodes `appName: "Berry"` and
  enables email/password.
- `apps/api/src/identity/identity.controller.ts:221-266` only permits an
  authenticated administrator to configure SSO.
- `packages/db/src/index.ts` has tenant settings and SSO tables but no typed,
  resumable deployment-setup record.
- `AuthenticationPolicy.allowedLoginMethods` is stored but not enforced by
  the authentication runtime.

Keep two separate Google OAuth clients: identity-only SSO and the connector
client. Reuse the repository's encrypted secret envelopes and
`BERRY_CONNECTOR_ENCRYPTION_KEY`.

## Commands

| Purpose | Command | Expected result |
|---|---|---|
| Shared types | `pnpm --filter @berry/shared... typecheck` | exit 0 |
| Database | `pnpm --filter @berry/db... typecheck` | exit 0 |
| API tests | `pnpm --filter @berry/api test -- auth-runtime.test.ts identity.controller.test.ts setup` | all pass |
| API types | `pnpm --filter @berry/api... typecheck` | exit 0 |

## Scope

**In scope**:

- setup schemas in `packages/shared/src/index.ts`
- setup migration/schema in `packages/db/src/index.ts`
- a new `apps/api/src/setup/` NestJS module, service, controller, and tests
- `apps/api/src/auth/auth-runtime.ts` and auth tests
- identity and connector repository reuse needed by setup
- API composition in `apps/api/src/main.ts`

**Out of scope**:

- SAML, Entra, Okta, SCIM, or domain-wide delegation
- Password, magic-link, or local-owner onboarding for AESG
- Browser UI implementation
- Accepting infrastructure secrets through the web UI

## State model

Persist one tenant-scoped setup record with these phases:

1. `environment_blocked`
2. `organization_pending`
3. `identity_pending`
4. `connectors_pending`
5. `owner_claim_pending`
6. `complete`

Store `setupVersion`, completed steps, non-secret draft values, timestamps,
and the expected owner email. Do not store the setup token. Derive completion
from this record plus an active owner membership; never use local storage.

## Steps

### Step 1: Add typed setup state and readiness

Add shared schemas for redacted readiness checks, branding draft, Google SSO
draft, connector draft, setup phase, and setup status. Create the database
record and migration. Initialization must be idempotent for existing tenants:
an existing active owner maps to `complete`; a fresh seeded tenant starts at
the first incomplete phase.

Readiness checks cover database, Redis, S3 artifacts, S3 audit export,
connector encryption, public URL, worker heartbeat, and model availability.
Responses contain status and remediation text, never secret values or
credential-bearing URLs.

**Verify**: schema/migration tests cover fresh, partially configured, existing,
and completed tenants.

### Step 2: Exchange the setup token for a short setup session

Add a rate-limited public endpoint that compares the supplied setup token with
`BERRY_SETUP_TOKEN` using constant-time hashing and validates the configured
`BERRY_SETUP_OWNER_EMAIL`. On success, issue a short-lived `HttpOnly`,
`Secure`, `SameSite=Strict` setup cookie scoped to setup endpoints. Sign it
with a dedicated derived key; do not expose the raw token after exchange.

All setup mutations require this cookie, same-origin validation, an incomplete
setup record, and the expected tenant. Completed setup permanently rejects
further setup-token mutations even if the environment token remains present.

**Verify**: tests cover wrong token, expiry, replay after completion, origin
rejection, rate limiting, and redacted errors.

### Step 3: Add idempotent setup mutations

Add endpoints for:

- organization profile and typed application branding;
- restricted logo upload to private S3 (PNG/JPEG/WebP, maximum 2 MB);
- Google Workspace SSO client, hosted domain, and JIT policy;
- separate Google connector client, Picker settings, and enabled services;
- transition to `owner_claim_pending` after required checks pass.

Use existing encrypted secret storage. Secret fields are write-only and status
responses expose only `configured: true`. Repeated requests with the same data
must be safe. Record audit events with actor source `deployment_setup` and no
secret material.

**Verify**: controller/service tests cover save, resume, rotation, validation,
redaction, and cross-tenant denial.

### Step 4: Make the first owner a Google claim

Add `BERRY_AUTH_LOGIN_METHODS=google` for AESG. When set:

- Better Auth email/password is disabled server-side.
- signup and password endpoints cannot be used, even if called directly.
- the login configuration exposes only the configured Google provider.
- the exact `BERRY_SETUP_OWNER_EMAIL` and signed Google `hd` domain must match
  during first-owner claim.

Under an advisory database lock, the first valid Google callback creates or
links the user, adds the `owner` membership with source `setup_google`, claims
the default workspace, creates initial budgets, and sets setup to `complete`
in one transaction. A concurrent callback must not create two owners. Ordinary
Google users remain blocked until this transaction completes; afterward JIT
creates members only.

**Verify**: tests cover correct owner, wrong email, wrong hosted domain,
personal Gmail, duplicate callback, concurrent callback, and post-setup JIT.

### Step 5: Enforce the authentication policy

Make runtime login availability agree with the persisted authentication policy
and deployment login methods. For AESG initialize `allowedLoginMethods` to
`["oidc"]` and `emergencyLocalOwnerEnabled` to `false`. Prevent administrators
from disabling the last usable SSO connection or enabling Google-only mode
without a verified connection and active Google-linked owner.

Add an SSO-native administrator assignment path. An owner can enter an email
such as `it2@aesg.com` and choose `admin`; Berry stores a pending membership
without creating a credential account or temporary password. On that person's
first verified Google sign-in, match the normalized email, bind the Google
subject, and activate the pending role. If the person already joined through
JIT as a member, the owner can promote the existing membership to admin.

All other verified `aesg.com` users join through JIT with the fixed default
role `member`. JIT must never create an admin or owner, and an email suffix by
itself is not sufficient proof of Workspace membership.

**Verify**: policy and auth integration tests prove password routes stay closed
and lockout-producing changes are rejected.

## Done criteria

- [ ] No local credential account is created during AESG setup.
- [ ] Setup resumes from persisted server state after restart.
- [ ] Secrets are encrypted, write-only, and absent from audit/error output.
- [ ] Only the configured Google Workspace owner can complete setup.
- [ ] Owner creation, workspace claim, budgets, and completion are atomic.
- [ ] Google is the only interactive login method after setup.
- [ ] Pending SSO administrators activate without a local password.
- [ ] JIT users always receive the member role unless an owner explicitly
  preassigned or promoted them.

## STOP conditions

- Better Auth cannot reliably distinguish a verified Google callback from a
  generic account creation context.
- The owner claim cannot be made atomic with membership/workspace/budget writes.
- A setup response or audit event would contain a client secret or setup token.
- Disabling password auth breaks service-account or platform-token auth.

## Maintenance notes

Future identity providers must implement the same verified-domain and atomic
owner-claim contract. Do not reopen the generic public signup path to add them.
