# Policy and Admin Guide

This guide is for administrators who need managed policy, platform login, provider controls, and audit-ready setup.

## Managed policy flow

Berry accepts local or remote signed managed policy bundles. The admin signs a policy JSON bundle, distributes the public key, and points clients at the bundle URL or a local policy file.

CLI sync:

```sh
berry policy sync \
  --url https://platform.example.test/v1/policy.json \
  --public-key prod=BASE64
```

Status check:

```sh
berry policy status --json
```

Desktop users can also receive policy through platform login when the platform session advertises policy keys and URLs.

## What to configure

| Item | Where it goes | Notes |
| --- | --- | --- |
| Policy signing public key | `berry policy --public-key keyId=base64`, platform org session, or managed desktop config | Public only. Keep the signing private key offline or in a controlled signer. |
| Policy bundle URL | Platform org session or `berry policy sync --url` | Must serve the exact signed bundle. |
| Provider allowlist | Signed policy bundle | Locks hosted/local provider choices and model ids. |
| Usage ingest URL | Platform org session | Used only after login and opt-in policy allows upload. |
| Update public key | Release/update config | Separate from policy signing keys. |

## Confirm it works

Run:

```sh
berry login status
berry policy status
berry doctor
```

Confirm it works when:

- `berry login status` reports the expected organization.
- `berry policy status` reports the expected policy version, key id, and locks.
- Desktop settings show locked fields as read-only.
- Attempts to save a disallowed provider or model fail with a policy error.

## Operating rules

- Rotate policy keys by publishing both old and new public keys before switching the signing key.
- Keep policy changes additive during rollout; remove old allowances only after clients have synced the replacement bundle.
- Treat local development fixture keys as test-only material.
- Record final production keys, URLs, and owner contacts in the release runbook.

## Web administration runbook

Use `/settings/*` for the signed-in user's preferences and capabilities,
`/admin/*` for one organization's policy and operations, and `/platform/*` only
for separately authorized platform operators. An organization administrator
must receive `403` from platform APIs even when they hold every organization
permission.

Before changing credits or other financial state:

1. Confirm the active organization and the displayed balance.
2. Enter the requested confirmation text and a durable audit reason.
3. Submit once with a unique idempotency key; retry with the same key after a
   network failure.
4. Verify the credit ledger and organization audit event. Platform-originated
   changes must also appear in the platform operator audit trail.

For a suspected tenant-isolation issue, stop mutations, record the actor and
tenant ids, verify the request was denied at the API layer, and test the same
query under a non-superuser PostgreSQL role with `app.tenant_id` set. Do not
disable row-level security to diagnose the problem.

Report and alert delivery uses a fixture provider until email or webhook
credentials are configured. Provider configuration is external setup; durable
job state, redacted destinations, attempts, and delivery results remain visible
in the admin console without exposing credentials.
