# Google Workspace SSO: self-hosting setup

This runbook enables **Continue with Google** for the production deployment at:

```text
https://ai.example.com
```

The production profile is Google-only. Set
`BERRY_AUTH_LOGIN_METHODS=google`; the login page, owner claim, administrator
reservations, and ordinary member access then use verified Workspace accounts.
Berry does not expose email/password sign-in or permit local member accounts in
this mode.

SSO is also separate from Berry's Google connectors:

| Purpose | OAuth client | Permissions |
| --- | --- | --- |
| Sign in to Berry | `Berry SSO production` | `openid`, `email`, `profile` only |
| Drive, Gmail, and Calendar tools | `Berry connectors production` | Only the connector scopes enabled by the Berry admin and accepted by each user |

Use two OAuth client IDs. This lets the Workspace admin permit basic Google
sign-in without automatically permitting Gmail, Drive, or Calendar access.

## Before starting

You need:

- a Google Cloud project owned by the customer organization;
- access to Google Cloud Console's Google Auth Platform pages;
- a Google Workspace administrator with the Security settings privilege;
- Berry owner/admin access;
- `BERRY_CONNECTOR_ENCRYPTION_KEY` configured in the API deployment.

The OAuth client ID and secret are entered in Berry's admin UI and stored in
Postgres. The secret is encrypted with `BERRY_CONNECTOR_ENCRYPTION_KEY`. Do not
add the Google client ID or secret to `.env`.

## 1. Verify Berry's deployment settings

Keep these values in the untracked `deploy/.env.production`:

```dotenv
BERRY_AUTH_BASE_URL=https://ai.example.com
BERRY_AUTH_TRUSTED_ORIGINS=https://ai.example.com
BERRY_AUTH_LOGIN_METHODS=google
BERRY_AUTH_SIGNUP_ENABLED=false
BETTER_AUTH_SECRET=YOUR_EXISTING_36_BYTE_BASE64_SECRET
BERRY_CONNECTOR_ENCRYPTION_KEY=YOUR_EXISTING_32_BYTE_BASE64_KEY
BERRY_CONNECTOR_DECRYPTION_KEYS=
```

Use separate random values for `BETTER_AUTH_SECRET` and
`BERRY_CONNECTOR_ENCRYPTION_KEY`. Back up both in the production secret manager.
Changing or losing the connector-encryption key makes saved SSO and connector
credentials unreadable.

## 2. Configure Google Auth Platform

In [Google Cloud Console](https://console.cloud.google.com/), open the
production project and then **Google Auth Platform**.

### Branding

Configure:

- App name: `Berry`
- User support email: an organization-managed address
- Home page: `https://ai.example.com`
- Privacy policy and terms: public organization-approved URLs
- Authorized domain: `example.com`
- Developer contact: a monitored organization engineering/security address

### Audience

Choose **Internal**. An Internal audience restricts authorization to accounts
in the Google Cloud project's parent Workspace/Cloud Identity organization.
If a Workspace user gets `org_internal`, confirm the Cloud project belongs to
the correct customer organization.

Do not use Testing for production. Google documents that Testing authorization
can expire after seven days and is subject to test-user limits.

### Data access

For the SSO client, Berry requests only:

```text
openid
email
profile
```

Do not add Drive, Gmail, Calendar, Directory, or Admin SDK scopes to the SSO
flow. Those belong to the separate connector client and connector policy.
Google APIs such as Drive or Gmail do not need to be enabled merely for SSO.

## 3. Create the SSO OAuth client

1. Open **Google Auth Platform > Clients**.
2. Select **Create client**.
3. Choose **Web application**.
4. Name it `Berry SSO production`.
5. Add this authorized JavaScript origin exactly:

   ```text
   https://ai.example.com
   ```

6. Add this authorized redirect URI exactly, with no trailing slash:

   ```text
   https://ai.example.com/v1/auth/callback/google
   ```

7. Create the client and securely copy its client ID and client secret.

Google requires an exact redirect match, including scheme, host, path, case,
port, and trailing slash. `redirect_uri_mismatch` nearly always means the URI
above was entered differently or the credentials came from another client.

For local development, create a different development OAuth client in the
development Google Cloud project. Never add localhost URLs to the production
client.

## 4. Apply the Workspace Admin policy

In [Google Admin console](https://admin.google.com/):

1. Go to **Security > Access and data control > API controls**.
2. Open **Manage App Access**.
3. Choose **Configure new app > OAuth app name or client ID**.
4. Search using the complete `Berry SSO production` client ID.
5. Select the SSO client and the organizational units that may use it.
6. Choose the narrowest setting that allows basic sign-in—normally
   **Limited** for this identity-only client. Do not mark the SSO client
   **Trusted** merely to make login work.
7. Save and allow time for the policy to propagate.

If the organization's unconfigured-app policy already allows apps that request only basic
Sign in with Google information, explicit configuration may not be required.
Configuring the client is still useful because it makes the intended access and
organizational-unit scope visible to administrators.

The connector OAuth client is reviewed separately. For Drive/Gmail/Calendar,
prefer **Specific Google data** with only the approved services/scopes over
blanket **Trusted** access. See
[`google-connectors-self-hosting.md`](./google-connectors-self-hosting.md).

## 5. Configure SSO during Berry onboarding

1. Open the application URL and append `#setup=<BERRY_SETUP_TOKEN>` locally.
   Never send or paste the complete tokenized URL into chat, email, or a ticket.
2. Complete the foundation and organization steps.
3. On **Google SSO**, enter the identity OAuth client.
4. Confirm the displayed redirect URI is:

   ```text
   https://ai.example.com/v1/auth/callback/google
   ```

5. Paste the SSO OAuth client ID and client secret.
6. Set the Workspace hosted domain to `example.com`.
7. Keep **Create members on first sign-in** on if the organization wants just-in-time
   provisioning. New users receive the `member` role; SSO cannot create an
   owner or admin.
8. Save and continue through connector policy and review.
9. Claim `owner@example.com` as owner with Google.

After saving, the secret cannot be read back from the API or UI. To rotate it,
enter the new client ID/secret pair and save again.

## 6. Verify safely

Keep the owner session open in one browser window.

1. Open a private/incognito window at `https://ai.example.com/login`.
2. Confirm only **Continue with Google** appears.
3. Sign in with an organization-managed Workspace account.
4. Confirm a personal Gmail account is rejected.
5. If JIT is on, confirm the first login created one Berry member with source
   `sso` and role `member`.
6. Disable that member in Berry and confirm its existing session no longer
   authorizes organization requests.
7. Confirm Drive, Gmail, and Calendar consent was not requested during login.
8. Pre-authorize `it-admin@example.com` as an administrator, sign in with that Google
   account, and confirm it receives the reserved admin role.

Berry verifies Google's ID-token signature, issuer, audience, expiry, and the
signed `hd` claim. The email suffix is not used as proof of Workspace
membership. Google explicitly says to use `sub` as the stable Google identity
and `hd` when restricting access to a Workspace domain.

## Troubleshooting

### `redirect_uri_mismatch`

The authorized redirect URI must be exactly:

```text
https://ai.example.com/v1/auth/callback/google
```

Check that the client ID pasted into Berry belongs to the same OAuth client.

### Google button does not appear

- Confirm the connection status is Enabled in **SSO & SCIM**.
- Confirm both client ID and encrypted client secret are configured.
- Confirm `BERRY_CONNECTOR_ENCRYPTION_KEY` is present in the API container.
- Check API logs for migration or credential-decryption errors without printing
  the credential itself.

### `org_internal`

The user is outside the Google Cloud project's parent organization, or the
project is owned by the wrong organization. Do not solve this by changing the
production app to External unless the organization intentionally wants outside accounts.

### `access_blocked` or an admin-policy page

Review **Google Admin > Security > Access and data control > API controls**.
Search by the exact SSO OAuth client ID and ensure the user's organizational
unit is covered by the configured access rule.

### Existing user signs in but a duplicate account appears

Account linking relies on Google's verified email for an existing Berry user,
while the provider account itself is keyed by Google's stable `sub`. Check for
historic duplicate emails before rollout and normalize them to lowercase.

## SCIM and future providers

The database model already separates provider, protocol, domain, JIT policy,
default role, and encrypted credentials. That is the extension point for
future SAML/OIDC providers and RFC 7643/7644 SCIM provisioning.

SCIM is not enabled by this Google SSO setup. Until Berry ships token lifecycle,
group mapping, deprovisioning, replay-safe PATCH handling, and operational
tests end to end, use Berry's admin membership controls and Google JIT login.

## Official references

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Google OIDC claims reference](https://developers.google.com/identity/openid-connect/reference)
- [OAuth for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies)
- [Manage Google Auth Platform audience](https://support.google.com/cloud/answer/15549945)
- [Control Workspace app access](https://support.google.com/a/answer/7281227)
