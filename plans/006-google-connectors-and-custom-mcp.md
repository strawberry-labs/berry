# Plan 006: Native Google connectors and administrator-published MCP servers

Status: **IMPLEMENTED AND VERIFIED**
Owner: Connectors, platform administration, and agent runtime
Last updated: 2026-08-07

## Outcome

Berry will have one **Connectors** area with two connector families:

1. **Native apps** maintained in this repository:
   - Google Workspace: Drive, Docs, Sheets, Slides, and Forms
   - Gmail
   - Google Calendar
2. **Custom MCP servers** published by an organization administrator:
   - users connect their own account, or
   - an explicitly labelled shared organization credential is used.

An administrator controls whether a connector is visible and the maximum
access Berry may request. Enabling a connector does not give Berry access to
any user's Google account. Each member completes their own Google OAuth flow.

The production public origin is `https://ai.aesg.com`. The Google OAuth web
client redirect URI is therefore:

```text
https://ai.aesg.com/v1/connectors/google/callback
```

Local-password authentication remains independent of connector OAuth. Google
connector OAuth is authorization to data; it is not Berry SSO.

## Research decision

Berry will wrap the stable Google REST APIs as its own typed agent tools. It
will not depend on Google's Google Workspace MCP servers for the first
production release.

Google now provides official Workspace MCP servers and documents connecting
them to Claude. They are useful references, but they remain Developer Preview,
do not cover Google Forms, and intentionally expose a narrower tool set (for
example Gmail drafts but not sending). A self-hosted enterprise product needs
stable APIs, explicit confirmation rules, tenant policy, audit events, and
predictable availability. Native wrappers provide those controls.

The native wrappers will be exposed to Berry's agent runtime through an
internal stateless MCP transport. This reuses the existing local and durable
MCP execution paths while keeping Google tokens and REST calls inside Berry's
API service.

## Product rules

### Administrator policy

For each native app, an owner or administrator sets:

- `disabled`: hidden from members; existing connections are not admitted to
  new turns.
- `read`: members may connect only with the read bundle.
- `full`: members may choose read or full, up to the administrator's maximum.

The organization policy is a ceiling, not an authorization grant. A user still
sees Google's consent screen and can deny individual permissions. Berry stores
the scopes actually granted and exposes only tools covered by them.

Downgrading `full` to `read` immediately removes write tools from subsequent
turns. Berry must also re-authorize or revoke scopes no longer needed; hiding a
button alone is insufficient.

### Workspace access modes

Workspace has two deliberately different read experiences:

1. **Selected files**: `drive.file` plus Google Picker. The user chooses which
   files Berry can access. This is the default safer mode and avoids restricted
   all-Drive access.
2. **Search my Workspace**: `drive.readonly`. Berry can search and read all
   files the user can access, subject to Drive capabilities, DLP, IRM, client-
   side encryption, malware, and organization policy. This is a restricted
   scope and must be separately allowed by the AESG Workspace administrator.

The initial UI must name these modes accurately. It must not label
`drive.file` as “all Workspace files.”

### Connection ownership

- Google tokens are always per user in v1.
- Google Domain-Wide Delegation is out of scope. It is an administrator
  impersonation mechanism and is unnecessary for interactive user tools.
- A member can disconnect at any time. Disconnect deletes that connector's
  local encrypted credentials and makes its tools unavailable. Because Google
  revocation removes all scopes granted to an app, Berry calls Google's remote
  revocation endpoint only when this is the user's final Google connector.
- Disabling a connector organization-wide stops admission immediately. It does
  not silently revoke every user's Google grant. Bulk remote revocation is a
  separate incident-response workflow because it destroys every member's
  connection and is intentionally not part of the initial UI.

### Action confirmation

Agent tool availability and user confirmation are separate controls.

- Pure reads do not require confirmation.
- Reversible drafts may run without confirmation, but the result must be shown
  to the user.
- Sending email, inviting attendees, responding to invitations, modifying
  existing content, moving/trashing files, publishing forms, or deleting
  events requires a user confirmation for the exact action.
- Permanent deletion, Drive permission changes, ownership transfers, Gmail
  forwarding/delegation/settings, bulk mail, and `acknowledgeAbuse` are not
  exposed in v1.

The confirmation view shows the connector, account, action, target, and a
human-readable diff or preview. Tool arguments alone are not a safe review UI.

## Google Cloud and Workspace boundary

AESG should create a dedicated Google Cloud project under its Google Cloud
Organization, not under an employee's personal project. The OAuth consent
audience should be **Internal**. This keeps the app limited to AESG Workspace
accounts and avoids the public restricted-scope verification path, while still
requiring compliance with Google API user-data and security policies.

The project enables these APIs:

```text
drive.googleapis.com
docs.googleapis.com
sheets.googleapis.com
slides.googleapis.com
forms.googleapis.com
gmail.googleapis.com
calendar-json.googleapis.com
picker.googleapis.com                    # only for Selected files mode
```

Berry does not need the Google Workspace MCP API service IDs because it calls
the stable REST APIs directly.

In Workspace Admin Console, configure the exact Berry OAuth client ID under:

```text
Security > Access and data control > API controls > Manage App Access
```

Use **Specific Google data** with the exact scopes AESG intends to permit.
Avoid **Trusted**, because Trusted allows all current and future Google scopes
requested by that OAuth client. Apply the rule to the top-level organization
unit if all AESG users should see it, or to selected OUs for staged rollout.

Do not enable the blanket “Trust internal apps” control. If Context-Aware
Access API controls are in use, add the Berry OAuth client to the appropriate
access rule or exemption.

## OAuth design

### One Google Cloud OAuth client, three Berry apps

Google Workspace, Gmail, and Calendar appear as separate Berry apps, but they
use one organization-owned Google OAuth web client. Berry requests scopes
incrementally when the user connects or upgrades a specific app.

The administrator stores in Berry:

- Google OAuth client ID
- encrypted Google OAuth client secret
- optional Google Picker API key and Cloud project number
- allowed hosted domain, normally AESG's Workspace domain
- configuration test status and timestamp

These values are database configuration, not one environment variable per
app. The database remains the source of tenant-specific connector settings.

### Authorization request

The server creates the authorization URL. It uses:

- authorization code flow
- exact registered redirect URI
- PKCE with `S256`
- random, single-use state
- `access_type=offline`
- `include_granted_scopes=true`
- incremental scopes for the selected connector and level
- `prompt=consent` only when a new refresh token or upgraded permission is
  required
- optional `hd` as an account-picker hint, never as the security check

The state record contains tenant ID, user ID, connector, requested level,
return path, creation/expiry time, and the encrypted PKCE verifier. It expires
after ten minutes and is consumed exactly once.

After callback, Berry validates state, exchanges the code server-side, checks
the returned identity/domain when available, stores the exact granted scopes,
and refuses to mark capabilities connected when required scopes are missing.

### Token lifecycle

- Access and refresh tokens are encrypted at rest.
- Access tokens are refreshed server-side just before use, with a small expiry
  safety window.
- A rotated refresh token replaces the previous encrypted token atomically.
- `invalid_grant`, `admin_policy_enforced`, or persistent authorization errors
  mark the connection `reauth_required` and remove it from runtime admission.
- Expected invalidation causes include user revocation, six months of
  inactivity, password changes when Gmail scopes are present, Google account
  token limits, testing-mode token expiry, and a later Workspace admin policy
  restriction.
- Disconnect always deletes the selected connector's local token. It calls
  Google's revocation endpoint only when no other Google connector remains for
  that user because Google revocation removes all scopes granted to the app.

Cross-Account Protection is not relied on because its current event coverage
does not include Workspace accounts.

## Secret storage

Connector client secrets, user OAuth tokens, and shared MCP credentials live in
PostgreSQL only as authenticated ciphertext.

The root key is supplied to the API as:

```text
BERRY_CONNECTOR_ENCRYPTION_KEY=<base64-encoded 32-byte random key>
```

There is no fallback to another application secret. Production must provide
this dedicated key before connector credentials can be stored or read.

Encryption requirements:

- AES-256-GCM
- fresh 96-bit random IV per encryption
- versioned envelope
- record-bound additional authenticated data containing tenant ID, record ID,
  provider, and credential purpose
- no plaintext secret in API responses, logs, audit data, exceptions, or turn
  runtime payloads
- configuration responses use `configured: true`, never a masked secret that
  could be mistaken for an editable value

Connector storage uses its own envelope v2 with additional authenticated data
and a key ID rather than weakening record binding to fit another envelope.
Multiple configured v2 root keys support a bounded rotation window.

The envelope contains a non-secret key ID. This permits a safe rotation:

1. deploy a new primary key while retaining the old decryption key;
2. rewrap connector credentials in bounded batches;
3. verify no envelopes reference the old key ID;
4. remove the old key from deployment configuration.

Production operators should ultimately source the root key from AWS Secrets
Manager or KMS-injected task secrets. It still arrives to Berry as an
environment variable; it is never stored in Berry's database.

## Google scope contract

Berry uses scope bundles as code-owned constants. Administrators cannot enter
arbitrary Google scopes.

### Google Workspace

Selected-files read:

```text
https://www.googleapis.com/auth/drive.file
```

Search-everything read:

```text
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/forms.responses.readonly
```

Selected-files Full still requests only `drive.file`. Google documents that
this per-file scope is supported by the Drive, Docs, Sheets, Slides, and Forms
APIs for reading and writing the files a user explicitly opens with the app.

Search-everything Full adds typed editor scopes while deliberately avoiding
broad `drive` full access:

```text
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/drive.readonly        # only in search mode
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/presentations
https://www.googleapis.com/auth/forms.body
https://www.googleapis.com/auth/forms.responses.readonly
```

This permits content editing through the Docs, Sheets, Slides, and Forms APIs.
It does not grant global Drive sharing, ownership transfer, or arbitrary
permanent deletion.

### Gmail

Read:

```text
https://www.googleapis.com/auth/gmail.readonly
```

Full:

```text
https://www.googleapis.com/auth/gmail.modify
```

`gmail.modify` already covers reading, composing, sending, labelling, and
trash/untrash. Do not redundantly request compose/send scopes. Do not request
`mail.google.com`, settings, forwarding, or delegation scopes.

### Google Calendar

Read:

```text
https://www.googleapis.com/auth/calendar.events.readonly
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events.freebusy
```

Full replaces the first scope with:

```text
https://www.googleapis.com/auth/calendar.events
```

The broad `calendar` scope is intentionally excluded because it can manage and
delete calendars and sharing settings. The dedicated free/busy scope remains
required; the events scope alone does not authorize `freebusy.query`.

## Native tool catalog

Tool inputs use explicit schemas, bounded list sizes, and safe defaults. The
model never receives a generic “call any Google endpoint” tool.

### Drive tools

Read:

- `drive_search_files`
- `drive_list_recent_files`
- `drive_get_file_metadata`
- `drive_read_file`
- `drive_list_children`
- `drive_list_permissions` (read-only visibility)

Full:

- `drive_create_folder`
- `drive_upload_file`
- `drive_copy_file`
- `drive_move_file`
- `drive_rename_file`
- `drive_trash_file`
- `drive_restore_file`

Drive behavior:

- support My Drive and shared drives with `supportsAllDrives=true` and
  `includeItemsFromAllDrives=true` where applicable;
- use `corpora=user` by default and a specific `driveId`/`corpora=drive` for a
  selected shared drive; avoid `allDrives` incomplete searches;
- inspect `capabilities.canAccessViaGenAi` before any content is passed to the
  agent, and filter ineligible search results;
- inspect `canDownload`, `canEdit`, `canCopy`, content restrictions, effective
  download restrictions, trash state, malware/abuse state, and encryption
  state before the operation;
- reject client-side encrypted content that Berry cannot decrypt;
- never set `acknowledgeAbuse` automatically;
- use multipart upload at or below 5 MB and resumable upload above 5 MB;
- use native export for Google file types, respecting the normal 10 MB export
  limit, and expose clear errors for unsupported/folder downloads.

Drive permission mutation, sharing links, ownership transfer, and permanent
deletion are explicitly absent from v1.

### Docs tools

Read:

- `docs_read_document`

Full:

- `docs_create_document`
- `docs_append_text`
- `docs_replace_text`
- `docs_insert_text`
- `docs_apply_text_style`
- `docs_insert_table`

Read all tabs with `includeTabsContent=true`. Writes use typed operations that
compile to one atomic `batchUpdate`. Use `writeControl` and the latest revision
ID to detect conflicting edits. Revision IDs are opaque, user-specific, and
normally valid for about 24 hours; they are not persisted as durable identity.

### Sheets tools

Read:

- `sheets_get_spreadsheet`
- `sheets_get_values`
- `sheets_batch_get_values`

Full:

- `sheets_create_spreadsheet`
- `sheets_update_values`
- `sheets_append_values`
- `sheets_clear_values`
- `sheets_add_sheet`
- `sheets_format_range`
- `sheets_insert_dimension`

Use bounded ranges; never download a large entire workbook by default. Batch
reads and writes when possible. Batch writes are atomic and count as one API
request. Keep payloads near or below Google's recommended 2 MB size. Scopes
cover the whole spreadsheet, not an individual sheet tab.

### Slides tools

Read:

- `slides_read_presentation`
- `slides_get_page_thumbnail`

Full:

- `slides_create_presentation`
- `slides_add_slide`
- `slides_add_text`
- `slides_replace_text`
- `slides_add_image`
- `slides_delete_object`

Compile typed operations to an atomic `batchUpdate` with write control. Berry
generates unique object IDs. Images must satisfy Google's public-URL, supported
format, size, resolution, and URL-length restrictions. Thumbnail URLs are
temporary and are not stored as durable attachments.

### Forms tools

Read:

- `forms_get_form`
- `forms_list_responses`
- `forms_get_response`

Full:

- `forms_create_form`
- `forms_add_question`
- `forms_update_question`
- `forms_move_item`
- `forms_delete_item`
- `forms_set_publish_state`

Form creation first creates the title and then adds items through an atomic
`batchUpdate`. Writes use revision control. Publishing requires consistent
`isPublished` and `isAcceptingResponses` values. Response-list filters support
only timestamp bounds, and page size is capped at 5,000 by Google; Berry uses a
smaller safe default.

Forms watches require Pub/Sub and expire after seven days. They are excluded
from on-demand v1 tools and belong in a later background-indexing phase.

### Gmail tools

Read:

- `gmail_search_threads`
- `gmail_search_messages`
- `gmail_get_thread`
- `gmail_get_message`
- `gmail_get_attachment`
- `gmail_list_labels`
- `gmail_list_drafts`
- `gmail_get_draft`

Full:

- `gmail_create_draft`
- `gmail_update_draft`
- `gmail_send_draft`
- `gmail_send_message`
- `gmail_reply_to_thread`
- `gmail_apply_labels`
- `gmail_remove_labels`
- `gmail_mark_read`
- `gmail_mark_unread`
- `gmail_trash_message`
- `gmail_untrash_message`

Messages are built as valid RFC 2822 MIME and base64url encoded. Thread replies
include `threadId`, matching Subject, `In-Reply-To`, and `References`. Sending
always requires confirmation and is bounded to normal person-to-person use;
Berry is not a bulk-mail system. The Gmail API's success response does not
guarantee downstream delivery.

Gmail search syntax resembles the Gmail UI, but API alias expansion differs;
the tool description must not promise byte-for-byte UI search behavior.

### Calendar tools

Read:

- `google_calendar_list_calendars`
- `google_calendar_list_events`
- `google_calendar_get_event`
- `google_calendar_query_freebusy`
- `google_calendar_suggest_times`

Full:

- `google_calendar_create_event`
- `google_calendar_update_event`
- `google_calendar_respond_to_event`
- `google_calendar_delete_event`

Create uses a caller-provided idempotency key converted to a valid event ID.
Invitation email behavior (`all`, `externalOnly`, or none) is explicit in the
confirmation. Meet creation uses `conferenceDataVersion=1` and a unique
conference request ID.

Avoid Calendar `patch` by default: it costs three quota units and replaces
whole array fields. Read the current event, merge a typed update, and send
`update`. Recurring-event tools support one occurrence or the whole series.
“This and following” requires a two-request split and is rejected in v1 until
implemented with a dedicated review flow.

Free/busy queries are batched within Google's limits of 50 calendars and 100
expanded group members.

## Quotas and reliability

Google quota errors use truncated exponential backoff with jitter for 403 rate
limits, 429, and retryable 5xx responses. Retries are bounded and honor the
remaining agent-turn deadline. Mutating operations require idempotency or a
safe read-after-write check before retry.

Important current limits considered by the implementation:

- Drive: 1,000,000 quota units/minute/project; 325,000/user/project; 1 TB
  egress/day/project. Method costs vary substantially.
- Docs: 3,000 reads/minute/project, 300 reads/user; 600 writes/project, 60
  writes/user.
- Sheets: 300 reads and writes/minute/project, 60/user for each class.
- Slides: 3,000 reads/minute/project, 600 reads/user; expensive thumbnail reads
  300/project and 60/user; 600 writes/project, 60/user.
- Forms: 975 reads/minute/project, 390/user; expensive response lists 450 and
  180; writes 375 and 150.
- Gmail: 1,200,000 quota units/minute/project and 6,000/user. Sending is 100
  units, message get 20, thread get 40, list operations 5–10.
- Calendar: 10,000 requests/minute/project, 600/user.

As of May 1, 2026, Google applies revised quotas to new agent projects. Google
also states that later in 2026 quota increases will require billing and usage
above standard thresholds will become billable after notice. AESG should
enable Cloud billing and a budget alert even if expected usage remains within
the no-cost standard tier.

API clients use:

- per-user and per-project concurrency limits;
- bounded page sizes and maximum pages per tool call;
- timeouts and abort signals;
- structured safe errors without response bodies or tokens;
- metrics by API, method, status class, latency, retry, and quota error;
- no email bodies, document content, queries, tokens, or MIME payloads in logs.

## AI data handling

Google Workspace API data may support user-facing productivity and generative
AI summaries. It must not be used to train or improve a generalized model.

Berry will:

- send only the content required for the current user request to the selected
  model provider;
- disclose the model provider and purpose immediately before Google consent;
- avoid creating a second durable corpus of raw Workspace content;
- keep transient tool outputs within the normal conversation retention policy;
- never use Workspace data for ads, credit decisions, sale, or unrelated
  analytics;
- provide a privacy policy, help page, disconnect flow, deletion explanation,
  and Google API Services User Data Policy “Limited Use” statement;
- enforce Drive's `canAccessViaGenAi` signal before content reaches an agent.

Indirect prompt injection is treated as untrusted content, not instructions.
Google data is clearly delimited in the agent context. Content cannot expand
tool permissions or bypass confirmations.

## Custom MCP contract

### Publication

Only an organization owner or administrator can create, test, publish, update,
disable, or delete a custom MCP definition. Members see only enabled published
definitions.

Definition fields:

- name, description, icon, and administrator-owned stable ID
- Streamable HTTP URL and optional legacy SSE fallback URL
- authentication mode
- credential ownership: `per_user` or `shared_organization`
- requested OAuth scopes, when discovered from the server
- discovered tool snapshot and schema hashes
- administrator allow/deny list
- risk classification and confirmation policy per tool
- enabled state and publication version
- website, privacy-policy URL, and author
- last successful discovery/test and last error summary

### Authentication modes

1. `none`
2. `static_bearer`
   - per-user bearer entered by each user, or
   - encrypted shared organization bearer entered by an administrator
3. `oauth`
   - standards-compliant MCP authorization discovery and OAuth 2.1 flow

MCP OAuth follows the current authorization specification:

- Protected Resource Metadata discovery (RFC 9728)
- authorization-server metadata or OIDC discovery
- PKCE `S256`
- resource indicators and token audience binding
- Client ID Metadata Documents where supported
- Dynamic Client Registration only when advertised

Berry will not invent authorization endpoints by appending `/authorize`, and
will never pass through a token issued for Berry or another resource.

### Shared credential warning

A shared organization credential means every admitted user acts as the same
external identity. The admin UI must say this plainly, show the affected user
population, require a confirmation, and recommend a least-privilege service
account. Tool calls remain attributable to the Berry user in Berry's audit log,
even if the upstream server sees one shared identity.

### MCP network security

Remote MCP URLs are server-side request targets and require SSRF controls:

- HTTPS only in production;
- reject userinfo, fragments, nonstandard schemes, localhost, private/link-
  local/reserved IP ranges, and cloud metadata endpoints;
- resolve and validate every address before connection;
- revalidate every redirect and protect against DNS rebinding;
- restrict ports and response sizes;
- use an egress proxy or network policy in production;
- redact authorization headers, environment variables, URLs containing
  credentials, and tool payloads from logs.

Admin publication performs initialize + tool discovery in a bounded sandbox.
Berry stores the tool name, description, input schema, annotations, and hash.
If a later discovery changes tools or schemas, newly added or materially
changed tools are disabled until an administrator approves the diff.

Tool annotations are useful signals, not trusted enforcement. Berry's admin
policy and confirmation layer decide whether a call may run.

## Persistence model

All tenant tables enable and force RLS using the repository's existing tenant
context helper. Proposed tables:

### `connector_provider_credentials`

One Google provider configuration per tenant and provider:

- tenant ID, provider, client ID
- encrypted client secret envelope
- Picker API key envelope and Cloud project number when configured
- hosted-domain restriction
- configuration status/test metadata
- created/updated by and timestamps

Unique `(tenant_id, provider)`.

### `organization_connectors`

One row per native connector or custom MCP publication:

- tenant ID, stable ID, kind, provider/slug
- display metadata
- enabled state and maximum access
- Workspace access mode
- custom MCP transport/auth/credential-owner configuration
- encrypted shared credential envelope when applicable
- discovered tool snapshot and policy
- version, created/updated by and timestamps

Unique native `(tenant_id, provider, slug)` and custom stable IDs.

### `connector_connections`

One member connection per organization connector:

- tenant ID, connector ID, user ID
- encrypted credential/token envelope
- exact granted scopes
- external account subject/email/display name
- requested/effective access level
- state: `connected | reauth_required | error | revoked`
- token expiry and last successful use
- last safe error code and timestamps

Unique `(tenant_id, connector_id, user_id)`.

### `connector_oauth_states`

Short-lived, single-use OAuth state:

- state digest, tenant/user/connector
- requested access and return path
- encrypted PKCE verifier
- created, expires, consumed timestamps

Store a digest of state rather than the bearer state value itself. Expired and
consumed states are deleted opportunistically when a new OAuth flow begins and
after a callback is consumed.

### `connector_audit_events`

Prefer the existing append-only audit service rather than a competing table.
Events contain connector IDs, action, actor, target metadata, result, and safe
error code—never credentials or Google/MCP content.

## API surface

Member:

```text
GET    /v1/connectors
POST   /v1/connectors/:connectorId/oauth/start
GET    /v1/connectors/google/callback
POST   /v1/connectors/:connectorId/credentials
GET    /v1/connectors/:connectorId/google-picker
DELETE /v1/connectors/:connectorId/connection
```

Administrator:

```text
GET    /v1/orgs/:tenantId/connectors
PUT    /v1/orgs/:tenantId/connectors/google/configuration
POST   /v1/orgs/:tenantId/connectors/google/configuration/test
PATCH  /v1/orgs/:tenantId/connectors/google/:connectorKey
POST   /v1/orgs/:tenantId/connectors/custom
PUT    /v1/orgs/:tenantId/connectors/custom/:connectorId
POST   /v1/orgs/:tenantId/connectors/custom/:connectorId/oauth/start
POST   /v1/orgs/:tenantId/connectors/custom/:connectorId/discover
POST   /v1/orgs/:tenantId/connectors/custom/:connectorId/publish
DELETE /v1/orgs/:tenantId/connectors/custom/:connectorId
```

OAuth start accepts a connector ID, requested level/mode, and safe internal
return path. It returns an HTTPS Google authorization URL. The callback always
redirects to the configured Berry public origin; it never accepts an arbitrary
external return URL.

The internal Google MCP endpoint is server-authenticated and not a public
general-purpose proxy. It resolves the Berry user/tenant connection from a
short-lived, audience-bound runtime admission credential.

## Runtime admission

At turn start Berry computes the intersection:

```text
organization connector enabled
AND admin maximum access
AND user connection effective access
AND exact granted OAuth scopes
AND per-tool policy
AND current account/file capabilities
```

Only that intersection reaches the model as tools. The model never receives a
refresh token, access token, client secret, or shared MCP bearer.

Native Google REST calls run in the API service through the internal MCP
adapter. Durable turns receive only a short-lived admission reference or an
encrypted, audience-bound envelope that the approved runtime can redeem. The
long-lived refresh token remains server-side.

## Web experience

### Member Connectors

`Settings > Connectors` contains:

- search
- tabs: Apps and Custom MCP
- cards for Workspace, Gmail, Calendar, and published custom MCP servers
- status: available, connected account, reauthorization needed, admin disabled
- access label: selected files, read, or full
- connect/manage/disconnect actions

Opening a native app shows its purpose, exact capabilities, example prompts,
data disclosure, access choices allowed by the administrator, connected
account, and confirmation behavior.

Workspace configuration shows Drive, Docs, Sheets, Slides, and Forms as
services. It does not fake independently grantable access when a Google scope
actually covers multiple services or a whole file. Scope consequences are
explained beside the control.

### Administrator Connectors

Organization settings contains:

- Google Cloud credential setup and test
- native connector enable/maximum-access policy
- Workspace selected-files vs search-everything policy
- connection counts and reauthorization errors
- custom MCP create/test/discover/publish flow
- shared credential warning and affected users
- tool allow/deny and confirmation policy
- revoke-all and disable controls with explicit impact review

Secrets use write-only fields. Editing unrelated metadata cannot erase an
existing secret.

## Audit events

At minimum:

- provider configuration created/updated/tested
- connector enabled/disabled/access changed
- custom MCP created/discovered/published/tool diff accepted
- user connected/upgraded/reauthorization required/disconnected
- shared credential created/rotated/removed
- destructive or external action requested/approved/denied/executed/failed

Log metadata, never content or credentials.

## Implementation sequence

### Phase 1 — Correct the draft contract — complete

- Reconcile the existing uncommitted connector migration and schemas with this
  plan.
- Add the v2 connector secret envelope with AAD and key ID.
- Add native connector constants, scope bundles, capability requirements, and
  tests.
- Add permissions for connector administration using existing role defaults.

Exit gate: migrations are RLS-safe; secrets cannot be swapped across tenant or
purpose; scope-bundle tests prove no dangerous scope is included.

### Phase 2 — Provider configuration and OAuth — complete

- Implement admin Google configuration/test APIs.
- Implement state digest, PKCE, callback, exact-scope persistence, refresh,
  revocation, and reauthorization state.
- Add connector mutation and connection audit events; use the existing API
  authentication/rate-limit boundary.

Exit gate: two users can independently connect; state replay/cross-user use is
rejected; missing scopes disable only affected tools; disconnect revokes and
deletes tokens.

### Phase 3 — Native Google tools — complete

- Implement the typed catalog above.
- Add Drive AI eligibility and safety preflight.
- Add retries, pagination bounds, payload limits, idempotency, and safe errors.
- Add confirmation metadata for all writes.
- Expose through the internal MCP adapter and both runtime paths.

Exit gate: read/full scope tests, fixture API tests, prompt-injection boundary
tests, confirmation tests, and durable runtime tests all pass.

### Phase 4 — Custom MCP — complete

- Implement admin CRUD, safe URL/DNS validation, bounded discovery, tool
  snapshot, exact allowlist, draft quarantine after edits, and publication.
- Implement no-auth, static bearer, and specification-compliant OAuth.
- Implement per-user and shared-organization credential modes.
- Admit only approved tools and enforce confirmation policy.

Exit gate: application validation rejects private/reserved targets and redirects
remain manual; production egress controls are still required to close DNS
rebinding/TOCTOU; token passthrough is impossible; edits return to draft.

### Phase 5 — Web UI — complete

- Build member Connectors and detail/configuration dialogs.
- Build admin provider, policy, Custom MCP, discovery diff, and connection
  status screens.
- Add disclosures, scope explanations, confirmations, and accessible focus/
  error states using the existing `--berry-*` variables and compact type scale.

Exit gate: keyboard and reduced-motion behavior pass; users can distinguish
admin availability from their own connected state; secrets never round-trip.

### Phase 6 — Operations and documentation — complete

- Add environment/Compose/Helm configuration for connector encryption and
  public callback origin.
- Add provider reachability testing, OAuth-state cleanup, deployment settings,
  and an operator/troubleshooting runbook.
- Write the exact Google Cloud and Workspace Admin setup guide for
  `https://ai.aesg.com`.
- Add privacy disclosure and Limited Use checklist.

Exit gate: a clean AESG self-hosted deployment can follow the guide, configure
Google once in the UI, connect a non-admin user, and successfully exercise one
read and one confirmed write per native app.

## Verification matrix

### Security

- OAuth state entropy, expiry, digest storage, single use, and tenant/user bind
- PKCE S256 and exact redirect URI
- granular-consent missing-scope handling
- token refresh rotation and invalidation
- encrypted secret AAD swap rejection and key rotation
- RLS across every connector table
- redaction snapshots for errors/logs/audit
- runtime admission ceiling after admin downgrade/disable
- Drive `canAccessViaGenAi`, DLP/IRM, CSE, abuse, and capability checks
- confirmation enforcement independent of model output
- MCP SSRF, redirect, DNS rebinding, schema diff, and token audience tests

### Functional

- selected-file and search-everything Workspace paths
- My Drive and shared-drive reads/writes
- Docs tabs and conflicting revisions
- bounded Sheets ranges and atomic batch writes
- Slides image limits and temporary thumbnails
- Forms publishing and paginated responses
- Gmail MIME attachments, replies, drafts, send, labels, and trash
- Calendar free/busy, Meet, invitations, recurrence boundaries, and idempotency
- multiple connected members with isolated accounts
- user disconnect and organization-wide disable
- per-user and shared custom MCP authentication

### Repository checks

```sh
pnpm --filter @berry/web... typecheck
pnpm --filter @berry/web... build
pnpm --filter @berry/api... typecheck
pnpm --filter @berry/worker... typecheck
```

Run focused unit/integration tests for every changed package and migration.
Broader tests are required only when shared runtime code affects another
surface.

## Deferred by design

- Google SSO, JIT provisioning, Google Directory sync, and SCIM
- Domain-Wide Delegation
- background Drive/Gmail/Calendar/Form indexing and push notifications
- Apps Script, Google Chat, Google People, Tasks, Keep, Admin SDK, or Vault
- Drive sharing/ownership changes and permanent deletion
- Gmail settings/forwarding/delegation and bulk campaigns
- Calendar creation/deletion/sharing
- arbitrary raw Google API calls
- trusting tool annotations without Berry policy
- one-click bulk remote credential revocation

These are separate security and lifecycle projects. They do not block native
interactive connectors.

## Official sources reviewed

Google OAuth and administration:

- <https://developers.google.com/workspace/guides/configure-oauth-consent>
- <https://developers.google.com/identity/protocols/oauth2/web-server>
- <https://developers.google.com/identity/protocols/oauth2/resources/best-practices>
- <https://developers.google.com/identity/protocols/oauth2/policies>
- <https://support.google.com/a/answer/7281227>
- <https://developers.google.com/identity/protocols/oauth2/service-account>
- <https://developers.google.com/workspace/guides/auth-overview>
- <https://developers.google.com/workspace/guides/create-credentials>
- <https://developers.google.com/workspace/workspace-api-user-data-developer-policy>
- <https://developers.google.com/workspace/tools-safety>
- <https://developers.google.com/workspace/guides/enable-apis>

Google Workspace MCP:

- <https://developers.google.com/workspace/guides/configure-mcp-servers>

Drive and Picker:

- <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- <https://developers.google.com/workspace/drive/api/guides/search-files>
- <https://developers.google.com/workspace/drive/api/guides/enable-shareddrives>
- <https://developers.google.com/workspace/drive/api/guides/manage-downloads>
- <https://developers.google.com/workspace/drive/api/guides/manage-uploads>
- <https://developers.google.com/workspace/drive/picker/guides/web-picker>

Docs, Sheets, Slides, and Forms:

- <https://developers.google.com/workspace/docs/api/reference/rest>
- <https://developers.google.com/workspace/docs/api/limits>
- <https://developers.google.com/workspace/sheets/api/scopes>
- <https://developers.google.com/workspace/sheets/api/limits>
- <https://developers.google.com/workspace/slides/api/reference/rest>
- <https://developers.google.com/workspace/slides/api/limits>
- <https://developers.google.com/workspace/forms/api/reference/rest>
- <https://developers.google.com/workspace/forms/api/limits>

Gmail and Calendar:

- <https://developers.google.com/workspace/gmail/api/auth/scopes>
- <https://developers.google.com/workspace/gmail/api/reference/rest>
- <https://developers.google.com/workspace/gmail/api/reference/quota>
- <https://developers.google.com/workspace/calendar/api/auth>
- <https://developers.google.com/workspace/calendar/api/reference/rest>
- <https://developers.google.com/calendar/api/guides/quota>

MCP:

- <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>
- <https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices>
