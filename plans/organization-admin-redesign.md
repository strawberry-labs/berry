# Organization administration redesign

Status: **IN PROGRESS**
Owner: Web platform and enterprise administration
Last updated: 2026-08-04

## Outcome

Replace the current twenty-item organization sidebar with nine clear product
areas, make organization usage human-readable and filterable, establish
enforceable member allowances, and give administrators one coherent place to
configure AI providers, models, tools, and policy.

The deferred SSO, JIT, Google Directory, and SCIM implementation is specified
separately in `plans/organization-identity-roadmap.md`.

## Approved navigation

| Sidebar item | Tabs | Existing screens absorbed |
| --- | --- | --- |
| Overview | Summary | Overview |
| People | Members, Departments | Members, Departments |
| Access control | Roles & permissions, Resource access | Roles, ACLs |
| AI & tools | Providers, Models, Skills & MCP, Feature access, Execution & network | Models, Skills & MCP, Feature access, Execution & network |
| Usage & billing | Overview, People, Models & providers, Requests, Allowances, Billing, Reports | Analytics, Spend limits, Credits & billing, Reports & alerts |
| Identity & security | Sign-in, Managed policy, Authentication, Service accounts | SSO & SCIM, Managed policy, Authentication, Service accounts |
| Data & privacy | Governance | Data governance |
| Audit log | Events | Audit log |
| Organization | Profile, Domains | Profile & domains |

Identity & security remains visible as the home of local authentication policy,
managed policy, and service accounts. Any deferred SSO controls must be clearly
labelled as planned or unavailable; Berry must not display a false “configured”
state.

## Product rules

### Members and departments

- Every member row shows a human-readable name and email before any internal ID.
- The internal ID remains copyable in the member detail view for support use.
- A member has one **primary department** for allowance and AI-policy
  inheritance.
- Optional secondary departments grant resource access only.
- The members table shows status, role, primary department, cycle allowance,
  cycle spend, remaining balance, and last activity.
- Owners can create/invite, suspend, reactivate, and offboard members. Until an
  email delivery system exists, the UI must distinguish “create account” from
  “send invitation.”

### Usage

Usage is one organization-wide analysis surface with filters, not a separate
screen per person.

Global filters:

- Date/cycle
- Person
- Primary department
- Provider
- Model
- Feature
- Status
- Workspace
- Agent

The selected filters apply to metrics, charts, breakdown tables, and individual
requests. The People tab supplies the high-level view; selecting a person opens
or links to the same usage surface with that person filter applied.

Required metrics:

- Total cost
- Input tokens
- Output tokens
- Cache-read tokens
- Cache-write tokens where available
- Cache hit requests and cache-eligible requests
- Cache hit rate = hit requests / eligible requests
- Request count, failure count, and latency
- Model, provider, feature, workspace, and agent mix

Request rows must show timestamp, person, department, model, provider, feature,
input/output/cache tokens, cost, latency, and status. Request details use the
internal request-row ID; the redacted provider/request identifier is display
data only.

Prompt and response bodies remain unavailable by default. Operational request
metadata must not become a content-surveillance feature.

### Allowances

Berry allowances are internal enforcement limits, not provider-wallet balances.
The provider may reject requests because its own account is out of credit even
when a Berry allowance remains.

#### Cycle

- Organization timezone.
- Configurable monthly anchor day from 1 through 28.
- A cycle runs from the local anchor instant to the next month's local anchor.
- Default: day 1 at 00:00 in the organization timezone.
- This avoids ambiguous 29th–31st behavior and reflects company billing cycles
  better than a rolling thirty-day window.

#### Hierarchy

1. Organization default per-member profile supplies a baseline when a member
   has no more specific assignment.
2. Primary-department profile replaces the organization baseline.
3. User override replaces the inherited baseline.
4. A current-cycle adjustment/top-up is added to that member's effective hard
   and soft limits.
5. Department aggregate guardrails and an optional organization emergency
   circuit breaker remain independent ceilings.

A department aggregate cap is not a per-person allowance. The UI must show
these two ideas separately.

Top-ups are append-only positive adjustments with actor, reason, amount, cycle,
and audit event. Corrections that reduce an allowance require a separate,
explicit limit change or suspension action; they are not represented as a
negative top-up.

#### Member experience

The account control in the main sidebar opens a compact allowance popover:

- Available this cycle
- Used this cycle
- Total effective allowance
- Cycle reset date
- Link to personal usage

The popover does not claim this is cash held by Berry. “Available” is a nominal
remaining internal allowance.

### Provider and model administration

Berry starts successfully with no external provider configured.

Administrators can register:

- Berry Router
- Direct OpenAI-compatible providers
- First-party supported providers
- Local/self-hosted inference endpoints

A provider record contains display name, provider kind, API protocol, base URL,
credential reference, health state, default model, and enabled state. Raw API
keys must not be persisted in ordinary provider tables or returned to the web
client. Runtime secrets use environment or a server-side secret resolver.

Administrators can then add/import models, set identifiers and display names,
enter input/output/cache pricing, declare capabilities and context limits, test
availability, and enable them for the organization.

### AI access precedence

- Organization policy is the ceiling.
- Primary department provides the normal model/feature set.
- A user rule is an explicit exception.
- An organization block cannot be bypassed by department or user allow rules.
- User rules override department defaults when the organization ceiling permits
  them.
- The effective-policy panel explains every winning rule.

The same scope vocabulary will be used for models, skills, MCP, features,
execution, and network policy, even when individual backends are delivered in
separate phases.

## Implementation architecture

### Navigation compatibility

- Sidebar URLs use the consolidated area IDs.
- A shared tab definition maps each area to its tabs and required permissions.
- Existing screen components are composed under the new tabs first; logic is
  refactored only where necessary.
- Legacy URLs such as `/admin/members`, `/admin/models`, and
  `/admin/spend-limits` resolve to the matching new area and tab so bookmarks do
  not fail.
- Tab changes are reflected in the URL for reload and shareability.

### Shared contracts

Extend usage DTOs with optional human-readable identity fields so older stored
events remain compatible:

- breakdown row `name`, `email`, and display `label`
- request summary/detail `userName`, `userEmail`, `departmentName`

Introduce allowance-cycle, adjustment, and balance schemas with integer
micro-dollar amounts. Preserve micro-dollar arithmetic end to end and format
currency only in the client.

Introduce provider configuration and scoped AI-access rule contracts only when
their runtime evaluation path is included in the same phase.

### Identity enrichment

Usage events keep stable user and department UUIDs. The usage API joins the
current organization membership and department views before returning admin
analytics. Deleted or unavailable identities fall back to a shortened ID and
an “Unknown member” label without losing historical records.

### Primary department propagation

- Add an optional primary department to membership contracts and persistence.
- Validate that it belongs to the membership's department list and tenant.
- Existing memberships fall back deterministically to their first department;
  the migration does not guess a primary department when none exists.
- Agent and usage paths resolve primary department once and attach it to budget
  reservations and usage events.

### Allowance enforcement

- Persist tenant cycle settings and append-only member adjustments.
- Compute exact UTC cycle boundaries from the tenant timezone and anchor day.
- Filter committed spend and relevant reservations to the current cycle.
- Add current-cycle member adjustments to member limits during reservation.
- Continue evaluating department aggregate and organization emergency limits.
- Return the same computation as an allowance-balance read model to prevent UI
  and enforcement drift.
- Record rejected reservations, adjustments, and cycle-setting changes in the
  audit log.

### Provider security boundary

- Store credential references, never raw provider secrets, in normal database
  rows.
- Reject loopback/private network provider URLs unless the deployment explicitly
  permits local inference destinations.
- Apply SSRF-safe resolution and egress policy to provider connection tests.
- Do not mark a registered provider as runtime-active until the runtime resolver
  can load its credential and a health check succeeds.

## Execution plan and status

### Phase 1 — Plans, IA, and compatibility shell

Status: **COMPLETE**

- [x] Audit existing navigation, usage, budget, identity, model, provider, and
  SSO/SCIM code paths.
- [x] Record the deferred identity roadmap.
- [x] Record product decisions, hierarchy, security boundaries, and acceptance
  criteria in this plan.
- [x] Replace twenty sidebar links with nine consolidated product areas.
- [x] Add area-level tab navigation and legacy route mapping.
- [x] Preserve per-tab permission checks and useful empty/error states.

Acceptance:

- An administrator sees no duplicate sidebar concepts.
- Every current administration screen remains reachable.
- Opening a legacy URL lands in its equivalent consolidated tab.

### Phase 2 — Human-readable usage and People

Status: **COMPLETE**

- [x] Enrich analytics breakdowns and request rows with member name/email and
  department name.
- [x] Add person, department, provider, model, feature, and status filters.
- [x] Apply filters consistently to analytics and request queries.
- [x] Correct cache hit-rate semantics.
- [x] Fix request-detail lookup to use the internal request record ID.
- [x] Add token and identity columns to the request table/detail.
- [x] Add cycle spend and allowance columns to the members table.
- [x] Make selecting a member open filtered usage.

Acceptance:

- An owner can identify a person's usage without reading a UUID.
- Metrics and request rows agree after applying the same filters.
- A request drawer opens for every visible request row.

### Phase 3 — Allowance cycles and top-ups

Status: **COMPLETE**

- [x] Add organization timezone and anchor-day persistence.
- [x] Add append-only positive allowance adjustments with actor and reason.
- [x] Implement balance endpoints for the current member and administrators.
- [x] Make budget enforcement use the configured cycle and top-ups.
- [x] Propagate primary department into reservation and usage events.
- [x] Add allowance overview, member/department tables, edit, and top-up flows.
- [x] Add the member allowance popover in the main sidebar.
- [x] Audit all mutations.

Acceptance:

- A top-up immediately increases that member's enforceable current-cycle limit.
- The member popover and admin table match the reservation calculation.
- Spend resets at the configured local monthly anchor.
- Department aggregate caps still block requests after a user top-up when the
  department has exhausted its cap.

### Phase 4 — Providers, models, and scoped AI access

Status: **PARTIAL — provider runtime, model catalog, and model-scope enforcement delivered**

- [x] Add provider registry contracts, persistence, administration API, and UI.
- [x] Add provider health checks through the guarded runtime boundary.
- [x] Add model create/edit with pricing and capability metadata.
- [x] Add organization, primary-department, and user model-access rules.
- [x] Enforce effective model policy before provider invocation.
- [ ] Explain effective policy and its source in the member detail panel.
- [ ] Extend the same scope evaluator to features, Skills/MCP, and
  execution/network controls.

Acceptance:

- A fresh self-hosted organization can register a provider and model without
  code changes.
- Disabled or blocked models cannot be invoked through chat, tasks, apps, or
  direct governed API paths.
- A permitted user exception works only below the organization ceiling.

### Phase 5 — Security, data, audit, and polish

Status: **PARTIAL — navigation, member lifecycle, profile fix, and audit detail delivered**

- [x] Consolidate local sign-in, managed policy, authentication, and service
  account screens under Identity & security.
- [x] Remove incomplete SSO/SCIM controls from active navigation and document
  the deferred roadmap.
- [ ] Clarify data-governance retention, export, deletion, and content visibility
  controls.
- [x] Enrich audit rows with actor identity, target and context IDs, retention,
  full chain hashes, and inspectable structured changes.
- [ ] Extend the audit event contract with source IP, request ID, and explicit
  outcome fields; the current event model does not capture them.
- [x] Fix profile/domain error handling and distinguish unavailable API data
  from an empty organization profile.
- [ ] Complete keyboard, screen-reader, reduced-motion, responsive, and dense
  table QA.

Acceptance:

- No administration tab is a blank shell or unexplained error.
- High-risk mutations are attributable and inspectable in the audit log.
- The complete admin experience works at compact desktop and narrow viewport
  widths.

## API surface

Planned additive endpoints (exact module naming may follow existing NestJS
conventions):

- `GET/PUT /v1/orgs/:tenantId/allowances/cycle`
- `GET /v1/orgs/:tenantId/allowances/balances`
- `GET /v1/orgs/:tenantId/allowances/balances/:userId`
- `GET /v1/orgs/:tenantId/allowances/me`
- `POST /v1/orgs/:tenantId/allowances/adjustments`
- `GET/PUT /v1/orgs/:tenantId/providers`
- `POST /v1/orgs/:tenantId/providers/:providerId/test`
- `GET/PUT /v1/orgs/:tenantId/models/access-rules`

All endpoints require tenant membership and the narrow existing permission for
their domain. Cross-tenant identifiers return not found/forbidden without
disclosing existence.

## Persistence changes

Expected additive database changes:

- membership primary department
- allowance cycle settings
- allowance adjustments
- organization model providers
- scoped AI access rules

Every table includes tenant ID, timestamps, useful tenant-scoped indexes, and
foreign keys. Adjustments and audit records are append-only. Migrations must be
safe for existing self-hosted databases and must not require provider or SSO
configuration to start Berry.

## Verification gates

Focused checks after each coherent phase:

```sh
pnpm --filter @berry/web... typecheck
pnpm --filter @berry/web... build
pnpm --filter @berry/api... typecheck
pnpm --filter @berry/worker... typecheck
```

Additional required tests:

- shared schema parsing and backward compatibility
- allowance cycle boundaries across timezones and daylight-saving transitions
- reservation concurrency and top-up enforcement
- primary-department policy resolution
- usage filter and identity enrichment integration tests
- provider URL/secret redaction and tenant isolation
- model/feature access precedence tests
- browser tests for consolidated navigation, member drill-down, request drawer,
  allowance edit/top-up, and account popover

## Rollout and rollback

- Navigation consolidation is client-side and retains legacy URL aliases.
- Shared response fields are optional until all services are deployed.
- Allowance migrations are additive; existing monthly limits keep their current
  behavior until a tenant cycle setting exists, then default to day 1 UTC if no
  organization timezone is configured.
- Provider records remain inactive until validated; no deployment is forced to
  migrate away from environment-based runtime configuration.
- Feature flags may gate new allowance enforcement and provider registry while
  read-only usage improvements ship broadly.

Rollback disables the new enforcement/read paths but preserves append-only
adjustments, usage events, and audit records. It must never silently grant an
unlimited allowance because a new read model is unavailable.

## Stop conditions

Stop and require a product/security decision if implementation would:

- store provider or identity secrets in plaintext;
- expose prompt or response bodies in organization usage by default;
- infer administrator privileges from an external group without an explicit
  mapping;
- allow a user/department rule to bypass an organization block;
- make a top-up visual-only while enforcement continues to reject the member;
- delete historical usage or audit ownership during offboarding; or
- enable incomplete SSO/SCIM controls as if they were production-ready.

## Definition of done

The redesign is complete when the consolidated navigation is the only primary
organization navigation, all absorbed controls remain functional, people and
usage are human-readable and filterable, allowance balances match runtime
enforcement, primary-department policy is applied consistently, provider/model
administration is safe and functional, scoped AI access is enforced across
entry points, and all focused verification gates pass.
