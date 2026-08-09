# Deployment onboarding

Berry's first-run onboarding configures one private Google Workspace deployment. It appears only while the deployment has no active owner. Progress is stored in PostgreSQL, so the wizard can be resumed after a browser, API, or EC2 restart.

## Bootstrap environment

Set these server-side values before starting the API:

```dotenv
NODE_ENV=production
BERRY_AUTH_LOGIN_METHODS=google
BERRY_AUTH_BASE_URL=https://ai.aesg.com
BERRY_WEB_PUBLIC_URL=https://ai.aesg.com
BERRY_SETUP_OWNER_EMAIL=strawberry@aesg.com
BERRY_SETUP_TOKEN=<at-least-32-random-characters>
BETTER_AUTH_SECRET=<independent-random-secret>
BERRY_CONNECTOR_ENCRYPTION_KEY=<output-of-openssl-rand-base64-32>
BERRY_REDIS_URL=<private-redis-url>
BERRY_ARTIFACT_S3_BUCKET=<private-s3-bucket>
BERRY_AUDIT_S3_BUCKET=<private-audit-s3-bucket>
```

For AWS S3, set `BERRY_ARTIFACT_S3_REGION=eu-west-1` and leave the custom S3 endpoint and access-key fields blank. The API and worker then use the AWS SDK credential chain. Attach an EC2 instance role with access to the artifact and audit buckets.

Open `https://ai.aesg.com/#setup=<BERRY_SETUP_TOKEN>`. The fragment is exchanged for a signed, HTTP-only setup cookie and then removed from the address bar. The cookie expires after 30 minutes. OAuth secrets are encrypted before storage and are never returned to the browser.

## Wizard stages

1. **System check** connects to PostgreSQL, pings Redis, checks access to both S3 buckets, and validates the connector encryption key, public HTTPS URL, and model configuration. Continuing records a server-side foundation checkpoint; later setup endpoints and the owner claim reject requests until this checkpoint exists.
2. **Organization** sets the organization name, application name, logo URL, accent, support contacts, and timezone.
3. **Google SSO** stores the identity-only OAuth client and restricts sign-in to the exact Workspace domain.
4. **Google connectors** stores the separate connector OAuth client, Google Picker settings, and the maximum Drive, Gmail, and Calendar access policies.
5. **Review and claim** allows only the exact `BERRY_SETUP_OWNER_EMAIL` Google identity to become owner. The claim assigns default workspace ownership, creates initial budgets, and permanently closes onboarding.

Use these Google OAuth redirect URIs:

```text
https://ai.aesg.com/v1/auth/callback/google
https://ai.aesg.com/v1/connectors/google/callback
```

## Users and administrators

- Any verified `@aesg.com` user may sign in through Google and is created just in time as a member.
- JIT users cannot become administrators through sign-in claims.
- The owner adds `it2@aesg.com` from **Settings → People** as a pending Google administrator.
- The pending administrator becomes active only after signing in with that exact Google account.
- Only the owner may add or promote administrators. No password is created for any Google-only account.

After the owner claim succeeds, remove `BERRY_SETUP_TOKEN` from the production environment. Keep `BERRY_SETUP_OWNER_EMAIL` only if operations needs the deployment record; the database owner state is authoritative and the wizard will not reopen.
