# Google connectors: self-hosting setup

This runbook configures Berry's native **Google Workspace**, **Gmail**, and
**Google Calendar** connectors for the AESG production origin:

```text
https://ai.aesg.com
```

The setup uses one organization-owned Google OAuth web client. The client ID,
encrypted client secret, optional Picker key, connector policy, and each user's
encrypted refresh token are stored in Berry's database. Only Berry's root
connector-encryption key stays in the production environment.

This authorization is separate from sign-in and does not change Berry's login
policy. In the AESG Google-only profile, sign-in still uses the identity OAuth
client while Drive, Gmail, and Calendar consent uses the connector client.
Adding connectors does not enable SCIM, user provisioning, or Domain-Wide
Delegation.

## Decisions to make first

1. Use a dedicated production Google Cloud project inside the AESG Google
   Cloud organization. Keep development in a separate project and OAuth
   client.
2. Set the Google Auth Platform audience to **Internal** if every connecting
   account is managed by the AESG Workspace organization. Use External only if
   accounts outside that organization must connect; External introduces extra
   testing, publishing, and verification obligations.
3. Decide the maximum access shown to members for each connector:
   **Off**, **Read**, or **Full**.
4. For Google Workspace, choose one Drive boundary:
   - **Selected files** uses `drive.file` and Google Picker. This is the
     recommended starting point.
   - **Workspace search** uses restricted `drive.readonly` and can search all
     Drive files the connected user can already access.

An administrator enabling Full access only makes that option available. It
does not connect accounts or grant data access. Each member still completes
Google consent for their own account.

## 1. Configure Berry's production secret

Generate a dedicated 32-byte key once:

```sh
openssl rand -base64 32
```

Put it only in the untracked `deploy/.env.production`:

```dotenv
BERRY_CONNECTOR_ENCRYPTION_KEY=PASTE_THE_BASE64_VALUE
BERRY_CONNECTOR_DECRYPTION_KEYS=
BERRY_WEB_PUBLIC_URL=https://ai.aesg.com
BERRY_AUTH_BASE_URL=https://ai.aesg.com
```

Do not reuse `BETTER_AUTH_SECRET`, the durable capability key, a database
password, or the Google client secret. Losing this key makes saved connector
credentials unreadable. Back it up in the same secret manager used for other
production root secrets.

For rotation, deploy a new primary in `BERRY_CONNECTOR_ENCRYPTION_KEY` and put
the previous base64 key in the comma-separated
`BERRY_CONNECTOR_DECRYPTION_KEYS`. New writes use the primary; old records can
still be decrypted during the rewrap window. Remove an old key only after its
records have been re-encrypted and verified.

## 2. Create the Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Select the AESG Cloud organization.
3. Create a project such as `berry-connectors-production`.
4. Record both the **project ID** and numeric **project number**. Picker uses
   the project number as its app ID.
5. Set a billing budget/alert if the organization requires one. The Workspace
   APIs normally use quota rather than per-call billing, but the project should
   still be owned and monitored like any production integration.

Do not create this production OAuth app in an employee's personal Cloud
project. An Internal OAuth audience is available only to projects associated
with the Workspace/Cloud organization.

## 3. Enable the APIs

In **Google Cloud Console > APIs & Services > Library**, enable:

- Google Drive API — `drive.googleapis.com`
- Google Docs API — `docs.googleapis.com`
- Google Sheets API — `sheets.googleapis.com`
- Google Slides API — `slides.googleapis.com`
- Google Forms API — `forms.googleapis.com`
- Gmail API — `gmail.googleapis.com`
- Google Calendar API — `calendar-json.googleapis.com`
- Google Picker API — `picker.googleapis.com` (needed only for Selected files)

The equivalent command is:

```sh
gcloud services enable \
  drive.googleapis.com \
  docs.googleapis.com \
  sheets.googleapis.com \
  slides.googleapis.com \
  forms.googleapis.com \
  gmail.googleapis.com \
  calendar-json.googleapis.com \
  picker.googleapis.com \
  --project=YOUR_PROJECT_ID
```

## 4. Configure Google Auth Platform

Open **Google Cloud Console > Google Auth Platform**.

### Branding

Configure:

- App name: `Berry`
- User support email: an AESG-managed support address
- App home page: `https://ai.aesg.com`
- Privacy policy: the public privacy-policy URL approved by AESG
- Terms: the public terms URL approved by AESG, if applicable
- Authorized domain: `aesg.com`
- Developer contact: a monitored AESG engineering/security mailbox

The privacy and terms links must be reachable without signing in. The in-app
`/settings/privacy` page is not a substitute for a public OAuth policy page.

### Audience

Choose **Internal** for an AESG-only rollout. Internal apps are limited to
accounts in the associated Workspace organization and avoid the External
testing-user lifecycle. If Google shows `org_internal` for a legitimate AESG
user, verify that the Cloud project belongs to the correct organization and
that the user is in that organization.

### Data Access

Register the scopes Berry may request. Berry requests them incrementally by
connector and chosen access level; it never asks for every scope at once.

Identity scopes used by every Google connection:

```text
openid
email
profile
```

Google Workspace scopes:

```text
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/presentations
https://www.googleapis.com/auth/forms.body
https://www.googleapis.com/auth/forms.responses.readonly
```

Gmail scopes:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.modify
```

Calendar scopes:

```text
https://www.googleapis.com/auth/calendar.events.readonly
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events.freebusy
```

The Workspace bundle is deliberately mode-aware:

| Berry Workspace choice | Scopes requested |
| --- | --- |
| Selected files + Read | `drive.file` |
| Selected files + Full | `drive.file` only; the Docs, Sheets, Slides, and Forms APIs all support this per-file scope |
| Workspace search + Read | `drive.readonly`, `forms.responses.readonly` |
| Workspace search + Full | Both Drive scopes plus `documents`, `spreadsheets`, `presentations`, `forms.body`, and `forms.responses.readonly` |

This is why Selected files is the recommended first rollout. Even its Full
mode remains bound to files created by or explicitly opened with Berry.

Berry deliberately does not request `https://mail.google.com/`, broad
`https://www.googleapis.com/auth/drive`, Gmail settings/delegation scopes,
Directory/Admin SDK scopes, or permanent-delete authority.

### Create the OAuth client

1. Open **Google Auth Platform > Clients**.
2. Choose **Create client > Web application**.
3. Name it `Berry production`.
4. Add this authorized JavaScript origin exactly:

   ```text
   https://ai.aesg.com
   ```

5. Add this authorized redirect URI exactly, with no trailing slash:

   ```text
   https://ai.aesg.com/v1/connectors/google/callback
   ```

6. Create the client and copy its client ID and client secret. The secret is
   entered once in Berry and is not displayed again.

Google compares redirect URIs exactly: scheme, host, case, path, port, and
trailing slash all matter.

## 5. Configure Google Picker

Do this when Google Workspace will use **Selected files**.

1. In **APIs & Services > Credentials**, create an API key.
2. Add an application restriction for websites/HTTP referrers:

   ```text
   https://ai.aesg.com/*
   ```

3. Add an API restriction allowing only **Google Picker API**.
4. Copy the API key.
5. In **IAM & Admin > Settings**, copy the numeric project number. Berry calls
   this the Picker project number/app ID.

Picker receives a short-lived user OAuth access token in the browser so Google
can show files for the correct connected account. Berry returns that token only
from an authenticated, `private, no-store` endpoint. The refresh token and
OAuth client secret never go to the browser.

## 6. Approve the app in Google Workspace Admin

Use a Workspace administrator with the Security settings privilege.

1. Open [Google Admin Console](https://admin.google.com/).
2. Go to **Security > Access and data control > API controls**.
3. Open **Manage App Access**.
4. Choose **Configure new app > OAuth App Name or Client ID**.
5. Paste the complete `...apps.googleusercontent.com` client ID created above.
6. Select the Berry web client, then select the AESG organizational unit(s)
   whose members may connect.
7. Choose **Specific Google data**.
8. Allow only the Google services/scopes from the Data Access list above that
   correspond to the Berry connectors AESG will enable.
9. Confirm and save.

Do not mark Berry **Trusted** merely to make consent work. Trusted gives the
app access to all Google services/scopes it requests. **Specific Google data**
preserves the administrator's service boundary. Google notes that restricting
Drive also restricts Forms, so configure and test those together.

If AESG sets Gmail, Drive, or Calendar to Restricted under **Manage Google
Services**, the Berry client must be configured as Specific Google data (or
Trusted) before users can grant those scopes. Policy can be applied to a pilot
organizational unit first.

## 7. Enter the client in Berry

1. Sign in to Berry as an owner/admin.
2. Open **Administration > AI & tools > Connectors**.
3. Choose **Google OAuth**.
4. Enter:
   - OAuth client ID
   - OAuth client secret
   - Hosted domain: the actual primary Workspace domain, normally `aesg.com`
   - Picker API key and project number when Selected files is used
5. Confirm that Berry displays:

   ```text
   https://ai.aesg.com/v1/connectors/google/callback
   ```

6. Save, then use **Test**. This checks Google's discovery endpoint and marks
   the provider reachable. The first successful member connection validates
   the actual client, redirect, consent, domain, and token exchange.
7. Set Google Workspace, Gmail, and Google Calendar individually to Off, Read,
   or Full. For Workspace, also choose Selected files or Workspace search.

Recommended first rollout:

- Google Workspace: **Read + Selected files**
- Gmail: **Read**
- Google Calendar: **Read**

Move a connector to Full only after reviewing its write tools and confirmation
experience with a pilot account.

## 8. Test as a member

1. Open **Settings > Connectors**.
2. Open one Google connector and choose Read or Full, if Full is allowed.
3. Select **Connect**, choose the AESG account, review the consent screen, and
   return to Berry.
4. For Workspace Selected files, choose **Choose Drive files** and select test
   files in Picker.
5. Test read prompts before write prompts:
   - `Find the project brief I selected and summarize it.`
   - `Show unread mail from this week that needs a reply.`
   - `Summarize my calendar for tomorrow.`
6. Test one write with non-production data and verify Berry asks for approval:
   - create a draft rather than sending immediately;
   - create a test calendar event;
   - create a test Drive folder/document.
7. Disconnect the connector and verify its tools disappear from later turns.

Each connector stores its own grant. A member can connect Workspace without
connecting Gmail or Calendar. If Google grants only part of a request, Berry
stores the scopes actually granted and removes tools whose scopes are missing.
Google revocation removes all scopes the user granted to the app, not just one
Berry card. Therefore, Disconnect always deletes that connector's local token,
but calls Google's remote revocation endpoint only when it is the user's final
connected Google connector. A user can remove the entire Berry grant at any
time from their Google Account's linked-apps page.

## Effective access matrix

| Connector | Read | Full adds |
| --- | --- | --- |
| Workspace, Selected files | Search/read files selected through Berry, read Docs/Sheets/Slides, read Form responses | Create/update only files created by or explicitly opened with Berry; Full still uses only `drive.file` |
| Workspace, Workspace search | Search/read all files the user can already access, read Docs/Sheets/Slides and Form responses | Broad Docs/Sheets/Slides/Forms editor scopes plus `drive.file` for Drive file operations |
| Gmail | Search/read messages, threads, attachments, labels, and drafts | Create/update/send drafts and messages; reply; label; mark read/unread; trash/untrash |
| Calendar | List calendars/events, read events, query free/busy, suggest slots | Create/update/respond/delete events with explicit invitation-update behavior |

Berry also supports My Drive and shared-drive reads, capability preflights,
bounded Sheets reads/writes, Docs revision guards, Slides thumbnails, Forms
responses/publishing, Gmail MIME attachments and threading, and Calendar
recurrence/free-busy. It intentionally excludes Drive ownership/sharing
changes, irreversible Drive/Gmail deletion, Gmail administration, Calendar
ACL/calendar administration, raw Google endpoint calls, background mailbox or
Drive indexing, and Google Admin SDK operations.

## Security and data handling

- OAuth client secrets, user refresh tokens, and shared connector credentials
  are AES-256-GCM encrypted with record-bound authenticated data before they are
  stored in PostgreSQL.
- Access tokens are refreshed server-side. Picker is the only flow that exposes
  a short-lived access token to Berry's authenticated browser UI.
- Native Google tools have fixed schemas and fixed Google endpoints. The model
  cannot supply an arbitrary Google API URL.
- The organization maximum, the member's chosen level, and the scopes Google
  actually granted are all enforced at runtime.
- Write/destructive actions still pass through Berry's tool approval flow.
- Connector data may be sent to the model provider configured for the task.
  AESG must ensure the selected provider and retention settings match its data
  policy. Berry does not use Workspace data for generalized model training.
- Do not use Domain-Wide Delegation for this feature. Per-user OAuth preserves
  Google permissions, consent, revocation, and account attribution.

Google classifies several Drive and Gmail scopes as sensitive or restricted.
An Internal app can be exempt from parts of external verification, but it is
not exempt from secure handling, accurate consent disclosures, least privilege,
or the Google API Services User Data Policy and Limited Use requirements.

## Custom MCP connectors

Custom MCP is configured separately under the same Berry Connectors area:

1. An admin supplies a public HTTPS MCP endpoint and chooses Streamable HTTP or
   HTTP + SSE.
2. The admin chooses no auth, per-user bearer/OAuth, or one shared organization
   credential.
3. Berry resolves and rejects private/reserved endpoint addresses, negotiates
   current MCP OAuth where configured, and discovers the tool schemas.
4. The admin explicitly selects a non-empty tool allowlist and publishes it.
5. Members connect their own credential when personal auth is selected. A
   shared credential makes the connector immediately available to all members.

Shared auth means the upstream service may see one organization identity, not
the individual Berry user. Use a dedicated least-privilege service account.
Berry treats custom MCP tool annotations as untrusted: every custom MCP call
requires approval even if the server advertises a tool as read-only. Custom
MCPs therefore do not offer a misleading Read/Full switch; the enforceable
boundary is the exact admin-published tool allowlist. Production
network egress controls must also prevent DNS rebinding and metadata/private
network access; application validation alone is not an egress firewall.

## Required outbound network access

Permit HTTPS from the Berry API to the Google hosts used by the native
connectors:

```text
accounts.google.com
oauth2.googleapis.com
openidconnect.googleapis.com
www.googleapis.com
docs.googleapis.com
sheets.googleapis.com
slides.googleapis.com
forms.googleapis.com
gmail.googleapis.com
apis.google.com
```

Also keep `ai.aesg.com` in `BERRY_CLOUD_NETWORK_ALLOWED_DOMAINS`; Berry's
native Google adapter is exposed to the agent runtime through a signed,
short-lived internal MCP session on that origin. Add every published custom MCP
hostname to the same allowlist.

Custom MCP endpoints require their exact approved HTTPS hosts as well. Do not
open general outbound access to RFC1918, loopback, link-local, cloud metadata,
or other internal ranges.

## Troubleshooting

### `redirect_uri_mismatch`

Compare Google's OAuth web-client entry to Berry's displayed callback. It must
be exactly `https://ai.aesg.com/v1/connectors/google/callback`, without a
trailing slash. Confirm the request uses the intended production client ID.

### `Access blocked: Authorization Error` or `admin_policy_enforced`

In Workspace Admin, find the exact OAuth client ID under Manage App Access.
Verify the member's organizational unit and every requested service/scope.
Check Manage Google Services for Restricted services. Do not work around this
by changing the app to Trusted without a security review.

### `org_internal`

The selected account is outside the OAuth app's organization, or the Cloud
project is not associated with the intended Workspace organization. Use the
AESG account and verify project ownership/audience.

### Google does not return a refresh token

Disconnect Berry, open the Google Account's third-party access page, remove the
existing Berry grant, then reconnect. Berry requests offline access and forces
consent, but Google can omit a new refresh token when an older grant remains.

### Picker is blank or reports a developer-key error

Verify Picker API is enabled, the API key permits `https://ai.aesg.com/*`, its
API restriction is Google Picker API, and Berry contains the numeric project
number rather than the project ID. Also verify the connected Google account
matches the OAuth token used by Picker.

### `403` API disabled or insufficient permission

Confirm the named API is enabled in the same project as the OAuth client. Then
compare the connection's granted scopes to the selected Berry access level. If
the admin raised Read to Full after a user connected, the user must reconnect
and consent to the added scopes.

### External test users lose access after seven days

For an AESG-only deployment, use an Internal audience in an organization-owned
project. External apps left in Testing can have short-lived authorizations.

## Official references

- [Create a Google Cloud project](https://developers.google.com/workspace/guides/create-project)
- [Enable Google Workspace APIs](https://developers.google.com/workspace/guides/enable-apis)
- [Configure OAuth consent](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [OAuth for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies)
- [Control app access in Workspace Admin](https://support.google.com/a/answer/7281227)
- [Workspace API user-data and Limited Use policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
- [Choose Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Choose Docs scopes](https://developers.google.com/workspace/docs/api/auth)
- [Choose Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes)
- [Choose Slides scopes](https://developers.google.com/workspace/slides/api/scopes)
- [Integrate Google Picker](https://developers.google.com/workspace/drive/picker/guides/web-picker)
- [Choose Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Choose Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
