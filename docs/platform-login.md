# Berry Platform Login

Desktop and CLI org login use additive host methods under `platform.*`.

## Client Environment

For a fixture or self-host smoke, set these before running `berry login` or the desktop host:

```sh
export BERRY_PLATFORM_BASE_URL=https://YOUR_API_ORIGIN
export BERRY_PLATFORM_OAUTH_CLIENT_ID=berry-cli
export BERRY_PLATFORM_AUTHORIZE_URL=https://YOUR_API_ORIGIN/oauth/authorize
export BERRY_PLATFORM_TOKEN_URL=https://YOUR_API_ORIGIN/oauth/token
export BERRY_PLATFORM_SESSION_URL=https://YOUR_API_ORIGIN/v1/me/org-session
export BERRY_PLATFORM_REDIRECT_URI=berry://platform/oauth/callback
export BERRY_PLATFORM_USAGE_SIGNING_KEY_ID=client-prod-2026q3
export BERRY_PLATFORM_USAGE_SIGNING_SECRET=replace-with-client-hmac-secret
```

The org-session endpoint returns the tenant, user, policy URL, policy public-key map, usage ingest URL, and usage signing key ID. If it includes policy public keys, login immediately runs `policy.sync` against the returned `berry-policy.json` URL.

## CLI Smoke

```sh
berry login --base-url "$BERRY_PLATFORM_BASE_URL"
berry login status --json
berry logout
```

For non-interactive fixture tests:

```sh
berry login --base-url "$BERRY_PLATFORM_BASE_URL" --code FIXTURE_CODE --public-key KEY_ID=RAW_BASE64_PUBLIC_KEY --json
```

Local usage upload is policy-controlled. `platform.usage.flush` uploads only when an org session exists, upload is enabled by the session, and telemetry is not disabled by managed policy or user settings.
