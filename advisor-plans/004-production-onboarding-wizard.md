# Plan 004: Build the production onboarding wizard and live branding

> **Executor instructions**: Implement against the setup API from Plan 003.
> Use existing `--berry-*` tokens, compact typography, accessible focus states,
> and reduced-motion behavior. Do not persist secrets in browser storage.

## Status

- **Priority**: P1
- **Effort**: L (2–3 working days)
- **Risk**: MED
- **Depends on**: `advisor-plans/003-google-only-deployment-bootstrap.md`
- **Category**: direction / UI
- **Planned at**: commit `11ac0b5`, 2026-08-08

## Why this matters

The existing first-run experience is one password form inside
`AuthBoundary`. Branding, SSO, and connectors are separate admin screens, and
the application name/logo remain hardcoded. Operators cannot see whether RDS,
Redis, S3, the worker, or encryption are ready.

The new flow gives a fresh deployment one resumable path from infrastructure
checks to Google owner sign-in. It borrows Feedboard's strongest patterns:
server-derived first-run gating, a full-screen wizard, bounded steps, review
before commit, and automatic disappearance after authoritative completion.

## Experience design

Use a refined, technical setup surface consistent with Berry rather than a
marketing page. Desktop gets a narrow progress rail and one focused form card;
mobile gets a compact step header. Keep body text at 14 px, secondary text at
12 px, restrained borders, and one accent color preview. Use short opacity and
vertical transitions that stop immediately under reduced motion.

The five screens are:

1. **System check**: database, Redis, S3, worker, model, public URL, encryption.
2. **Identity**: organization name, application name, logo, accent, contacts.
3. **Google sign-in**: SSO client, secret, Workspace domain, redirect URI.
4. **Google apps**: connector client, Picker details, Drive/Gmail/Calendar.
5. **Review and claim**: redacted summary followed by “Continue with Google”.

Required blocked checks prevent progress. Warnings explain what feature will
remain unavailable. Completed steps save to the server and resume after a
refresh. No secret is restored into an input after saving.

## Current state

- `apps/web/src/components/shell/auth-boundary.tsx` contains the entire current
  setup and authentication UI.
- `apps/web/src/components/management/admin-catalog-screens.tsx:1900-2100`
  already has the Google SSO form language and API client patterns.
- `apps/web/src/components/management/connectors-screen.tsx:200-340` already
  has connector configuration and secret-redaction behavior.
- `apps/web/src/components/management/organization-profile-screen.tsx` edits
  profile fields but does not upload a logo or drive application branding.
- `apps/web/src/components/management/admin-screens.tsx:577-679` creates local
  accounts and temporary passwords; Google-only deployments need pending SSO
  memberships instead.
- `apps/web/src/routes/__root.tsx:17-21`, `AuthBrand`, app-shell navigation, and
  the workspace home logo hardcode Berry branding.
- Feedboard's `apps/dashboard/src/app/workspace-context.tsx:87-93` gates the
  application from authoritative membership state, and
  `components/onboarding/create-org.tsx` keeps a three-step wizard mounted
  through its final atomic commit.

## Commands

| Purpose | Command | Expected result |
|---|---|---|
| Web tests | `pnpm --filter @berry/web test -- onboarding auth-boundary` | all pass |
| Web types | `pnpm --filter @berry/web... typecheck` | exit 0 |
| Web build | `pnpm --filter @berry/web... build` | exit 0 |
| API types | `pnpm --filter @berry/api... typecheck` | exit 0 |

## Scope

**In scope**:

- a new `apps/web/src/components/onboarding/` feature folder and tests
- a setup route and root/setup gating
- `apps/web/src/components/shell/auth-boundary.tsx`
- reuse/refactor of existing SSO, connector, and profile form primitives
- the Members screen's add/promote flow for Google-only deployments
- public branding context and application-shell integration
- `apps/web/src/styles.css` using existing Berry variables

**Out of scope**:

- Infrastructure-secret entry through the browser
- New identity providers
- A generic form-builder framework
- Replacing Berry's main information architecture

## Steps

### Step 1: Add setup gating and resumable state

Load redacted setup status before normal auth routing. An incomplete deployment
always renders the setup route; a completed deployment cannot render it. Keep
the wizard mounted while the Google callback completes, matching Feedboard's
guard against live data switching the UI early.

Exchange the URL-fragment setup token once for the secure setup cookie, then
remove the fragment immediately. Store ordinary non-secret form drafts on the
server. Refreshing or restarting must return to the first incomplete step.

**Verify**: component tests cover incomplete, blocked, resumed, owner-claim,
and complete states.

### Step 2: Build the five screens

Build each screen as a small component with a shared wizard shell, progress
rail, error summary, Back/Continue actions, and per-field validation. Copyable
OAuth redirect URIs come from the server response, never string literals.

The system check screen has Retry and shows redacted remediation. The identity
screen previews name, logo, and accent. SSO is mandatory. Connector services
may be individually disabled, but saved credentials remain write-only. Review
shows `Configured`, not secret values.

**Verify**: tests cover keyboard navigation, focus after step changes, blocked
Continue, server errors, secret redaction, and reduced motion.

### Step 3: Complete setup through Google

The final action starts Google sign-in with a callback back to setup. While the
callback is pending, show a stable waiting state. After the API reports
`complete` and the session resolves, replace the setup route with `/` and do
not leave it in browser history.

Wrong-domain and wrong-owner errors must return to the final step with a clear
message and keep saved configuration intact.

**Verify**: mocked integration tests cover success, cancellation, Google error,
wrong account, retry, and browser refresh during the callback.

### Step 4: Apply live organization branding

Expose a redacted public branding payload through web bootstrap. Replace the
hardcoded login label, document title, favicon, navigation mark, and workspace
home logo with the configured application name/logo, falling back to Berry.
Serve the private-S3 logo through the API's public branding asset endpoint with
safe content types and caching.

Keep product/legal references to Berry where they identify the software; only
tenant-facing application identity is configurable.

**Verify**: branding tests cover configured values, missing logo, failed image,
fallback, title/favicon updates, and no cross-tenant data.

### Step 5: Add the post-setup launch checklist

After the first owner lands, show a compact launch checklist on the admin
overview. Required items derive from live status: owner claim, Google-only
login, model availability, S3 access, worker heartbeat, and connector policy.
Optional items can be dismissed. Required items cannot be dismissed and the
checklist disappears automatically when all required checks pass.

Every item links to the existing settings screen that owns it. Do not duplicate
the full settings form inside the checklist.

In Google-only mode, replace “Create local account” and password-based CSV
import with “Add administrator” and optional SSO preassignment. The owner enters
an `aesg.com` email and selects `admin`; Berry shows `Pending first Google
sign-in` until the identity is linked. Ordinary employees require no invite and
appear as members after JIT sign-in. Existing members can be promoted without
creating another user.

**Verify**: tests prove automatic completion/disappearance and correct deep
links for incomplete items.

## Done criteria

- [ ] A fresh deployment enters a five-screen wizard automatically.
- [ ] Progress survives refresh/restart without storing secrets in the browser.
- [ ] The wizard disappears only after the Google owner claim commits.
- [ ] Login contains only “Continue with Google” for AESG.
- [ ] Application name/logo appear consistently with a safe Berry fallback.
- [ ] The admin checklist disappears automatically when required checks pass.
- [ ] The People screen never asks for or generates passwords in Google-only
  mode.
- [ ] Focused web tests, typecheck, and build pass.

## STOP conditions

- The UI needs the raw setup token after the cookie exchange.
- Any API response returns a saved OAuth secret or Picker key.
- Branding requires a public S3 bucket.
- Root-route changes cause authenticated pages to render before setup state is
  known.

## Maintenance notes

Keep onboarding fields owned by their canonical admin modules. When SSO,
connectors, branding, or readiness contracts change, update the shared form
primitive and wizard consumer together rather than creating another copy.
