# Organization identity roadmap

Status: **DEFERRED — approved product direction, not part of the current implementation**
Owner: Identity and platform administration
Last updated: 2026-08-04

## Decision

Berry will support four progressively managed identity modes:

1. **No SSO** — local Berry accounts and administrator-managed memberships.
2. **SSO only** — an external identity provider authenticates a Berry membership that already exists.
3. **SSO + JIT provisioning** — an approved identity creates a conservative Berry membership on first sign-in.
4. **SSO + directory sync** — Google Workspace Directory sync or SCIM manages user and group lifecycle; SSO performs authentication.

The phrase “GIT provisioning” from the product discussion is interpreted as
**JIT (just-in-time) provisioning**. Git repositories are not an identity
source.

The current release remains in **No SSO** mode. The administration UI may
explain the future modes, but it must not imply that an incomplete SSO or SCIM
path is production-ready.

## Why this is deferred

The repository contains partial SSO and SCIM concepts, but it does not yet have
the complete security lifecycle required for an enterprise release. In
particular, a production implementation needs a complete callback flow,
per-organization credentials, secure secret storage, account linking,
certificate rotation, lockout recovery, and auditable directory reconciliation.
Those requirements should ship together instead of exposing a configuration
screen that cannot safely complete sign-in.

## Product model

### Mode 1 — No SSO

This is the current mode.

- Organization owners create members or issue invitations.
- Berry owns password authentication, password reset, session revocation, and
  optional multi-factor authentication.
- Owners can activate, suspend, or offboard a member.
- A member has one primary department for budgets and AI policy, plus optional
  secondary departments for resource access.
- Allowances, model access, feature access, and roles are managed in Berry.
- Removing a user from an external directory has no effect because no directory
  is connected.

### Mode 2 — SSO only

- OIDC or SAML authenticates a member.
- An administrator must create or invite the membership before first sign-in.
- Berry links the IdP subject to exactly one membership after verifying the
  configured issuer, tenant, audience, domain, and email requirements.
- The IdP does not create, update, suspend, or delete memberships.
- Roles, departments, allowances, and AI access stay Berry-managed.
- Owners retain a protected break-glass login that cannot be disabled by the
  SSO policy.

Use this mode when a company wants centralized authentication but is not ready
to let a directory manage Berry membership.

### Mode 3 — SSO + JIT provisioning

- Authentication follows the SSO-only flow.
- On a member's first successful sign-in, Berry may create the membership when
  the identity matches an approved domain and the JIT policy.
- New JIT members receive a least-privilege role, a configured primary
  department or “Unassigned,” a default allowance profile, and the
  organization's baseline AI access.
- JIT never grants administrator roles from an email-domain match alone.
- Attribute updates may refresh safe profile fields such as name and avatar,
  but do not silently elevate roles or allowances.
- JIT does not reliably offboard inactive employees. A directory sync is still
  required for authoritative lifecycle management.

### Mode 4 — SSO + directory sync

Berry will support two provisioning transports with the same internal
reconciliation engine:

- **Google Workspace Directory sync**: Berry periodically pulls users and
  groups through the Google Admin SDK using a delegated, least-privilege
  service identity.
- **SCIM 2.0**: an identity provider pushes Users and Groups into a
  tenant-specific Berry endpoint using a rotatable bearer credential.

For either transport:

- The directory is authoritative for linked user identity and active status.
- Directory groups can map to Berry departments and, optionally, Berry roles.
- Berry remains authoritative for allowances and AI access unless an explicit
  mapping policy says otherwise.
- Deprovisioning suspends access and revokes sessions immediately; it does not
  erase usage, audit, task, or billing history.
- Reprovisioning restores the same membership identity when it is safe to do so.

## Administration experience

Identity configuration belongs under **Identity & security** with these tabs:

1. **Sign-in** — identity mode, local login policy, MFA, session duration, and
   break-glass accounts.
2. **SSO connection** — OIDC or SAML metadata, verified domains, attribute
   mapping, certificate state, and a test connection flow.
3. **Provisioning** — JIT policy, Google Directory sync, or SCIM credentials.
4. **Mappings** — groups to departments, groups to roles, default primary
   department, and unmatched-user behavior.
5. **Sync activity** — last successful sync, pending changes, failures,
   quarantined identities, and manual retry.

Changing identity mode must use an explicit review dialog that shows who could
lose access. Enabling SSO enforcement requires a recently successful test and
at least two verified recovery owners.

## Required domain model

### Organization identity policy

- `tenantId`
- `mode`: `local | sso | sso_jit | sso_directory`
- `protocol`: `oidc | saml | null`
- `localLoginAllowed`
- `enforcementState`: `draft | tested | enforced | suspended`
- `defaultRoleId`
- `defaultPrimaryDepartmentId`
- `allowedDomains[]`
- `createdBy`, `updatedBy`, timestamps

### Identity connection

- Issuer/entity ID, audience, authorization and token endpoints
- SAML metadata URL/XML or OIDC discovery URL
- Encrypted client secret or private key reference
- Current and next signing certificates with expiry timestamps
- Claim mapping for subject, email, name, and groups
- Last test result and last successful sign-in

Secrets must use a server-side secret store or encrypted envelope service. They
must never be returned by read APIs or stored as plaintext configuration.

### External identity link

- `tenantId`, `membershipId`
- Provider connection ID
- Immutable issuer + subject tuple
- External directory object ID
- Last observed email, profile attributes, and active state
- Provisioning source: manual, JIT, Google, or SCIM
- First linked and last synced timestamps

Issuer + subject, not email alone, is the stable authentication identity.

### Directory connection and sync state

- Provider type and tenant-specific credential reference
- Cursor/page token and synchronization watermark
- Scheduled interval, last attempt, last success, and next run
- Dry-run state and reconciliation summary
- Per-object sync result with retry and quarantine reason

### Group mappings

- External group ID and display name
- Target department ID and optional role ID
- Membership behavior: authoritative or additive
- Whether it may set the primary department
- Precedence when a user belongs to several mapped groups

## API and worker boundaries

### Authentication API

- Start login without requiring an existing Berry session.
- Store and validate signed state, nonce, PKCE verifier, return path, tenant,
  and connection ID.
- Process OIDC or SAML callbacks with strict issuer, audience, signature,
  timestamp, and replay validation.
- Resolve or create the membership according to the active identity mode.
- Issue a normal Berry session, record the authentication method, and audit the
  result without logging assertions or tokens.

### Identity administration API

- CRUD draft connections and attribute mappings.
- Test a connection without enabling enforcement.
- Preview the impact of a mode change.
- Enforce or roll back a tested policy.
- Rotate credentials and certificates.
- List external links and resolve account-link conflicts.

### Provisioning API

- Tenant-specific SCIM base URL and bearer tokens.
- SCIM Users, Groups, PATCH, filtering, pagination, and idempotency behavior.
- Google connection authorization and manual sync trigger.
- Dry-run reconciliation preview before the first authoritative sync.

### Worker

- Scheduled Google Directory incremental sync.
- Retryable reconciliation jobs with tenant isolation and idempotency keys.
- Session revocation and downstream membership-policy refresh after suspension.
- Certificate and credential expiry notifications.

## Reconciliation rules

1. Match an existing external object ID first.
2. Match an existing verified membership email only during an administrator-
   approved initial linking window.
3. Never merge two existing memberships automatically.
4. Create new memberships with the configured least-privilege defaults.
5. Apply group mappings deterministically and record the winning primary
   department mapping.
6. Suspend a directory-managed membership when the authoritative source marks
   it inactive or removes it after the configured grace period.
7. Preserve historical ownership and audit references after suspension.
8. Treat roles, allowances, and AI policy as Berry-owned unless a mapping is
   explicitly configured to manage that field.

## Security requirements

- Per-tenant secrets, tokens, issuers, and signing material.
- Hashed SCIM bearer tokens at rest and one-time plaintext display.
- SAML signature validation and XML hardening; no placeholder request payloads.
- OIDC discovery pinning, PKCE, state, nonce, and replay protection.
- Strict redirect URI allowlist.
- Domain verification before domain-based JIT.
- Rate limits for login, callback, SCIM, and connection tests.
- Audit events for configuration, tests, sign-ins, linking, provisioning,
  suspension, reactivation, and token rotation.
- Redacted operational logs; assertions, access tokens, and secrets are never
  logged.
- Two recovery owners and a tested break-glass path before SSO-only enforcement.

## Delivery phases

### Phase 0 — Identity foundation

- Add primary-department membership semantics and suspend/reactivate APIs.
- Add session revocation by membership.
- Add secure tenant secret storage.
- Make authentication method and identity-source fields auditable.

Exit gate: local account lifecycle is complete and tested independently of SSO.

### Phase 1 — SSO only

- Implement OIDC first, followed by SAML.
- Build test, preview, enforce, and rollback flows.
- Implement safe account linking and break-glass recovery.
- Add IdP-specific end-to-end fixtures.

Exit gate: a pre-provisioned member can sign in, a non-member cannot, and an
owner can recover from a broken connection without database access.

### Phase 2 — JIT provisioning

- Add verified domains and conservative default policies.
- Add a first-login preview/audit record.
- Add conflict and quarantine resolution screens.

Exit gate: an approved user is created exactly once with the expected role,
department, allowance, and model access; an unapproved identity is denied.

### Phase 3 — SCIM 2.0

- Implement tenant tokens, Users, Groups, PATCH, filters, pagination, and
  idempotent bulk-friendly behavior.
- Certify against at least Okta and Microsoft Entra test tenants.

Exit gate: create, update, group change, suspend, restore, retry, and token
rotation all pass end-to-end tests.

### Phase 4 — Google Workspace Directory sync

- Implement delegated authorization, incremental pull, group mapping, dry run,
  scheduling, retry, and activity views.
- Document the required Google Workspace scopes and setup.

Exit gate: an administrator can preview and complete a directory reconciliation
without over-granting Berry roles or AI access.

## Verification matrix

- Unit tests for policy precedence, claims, mappings, and reconciliation.
- Protocol conformance tests for OIDC, SAML, and SCIM.
- Integration tests for callback replay, invalid signatures, expired
  certificates, token rotation, duplicate email, and cross-tenant access.
- End-to-end tests for every mode transition and recovery path.
- Load tests for directory sync and SCIM bursts.
- Security review before enabling SSO enforcement in production.

## Rollout and rollback

- Ship every connection in draft state.
- Require a successful test within 24 hours before enforcement.
- Allow a staged pilot group before organization-wide enforcement.
- Keep local recovery owners active during the rollout window.
- Rollback changes the sign-in enforcement mode; it does not delete external
  links or sync history.
- Directory deprovisioning starts in dry-run mode, then warning mode, before it
  is allowed to suspend accounts automatically.

## Definition of done

This roadmap is complete only when all four modes behave end to end, UI state
matches runtime state, every identity is tenant-scoped and auditable, secrets
are protected, automated provisioning is idempotent, and recovery has been
tested without direct database access.
