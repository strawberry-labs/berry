# OpenRouter and Berry Router

Use this when Berry should reach hosted models through OpenRouter directly or through the Berry Router service.

## Direct OpenRouter

Open Berry desktop and go to `Settings > Models`. Add a provider:

- Provider type: OpenAI-compatible
- Name: OpenRouter
- Base URL: `https://openrouter.ai/api/v1`
- Auth: API key
- Default model: an allowed OpenRouter model id

Paste the OpenRouter key into the encrypted provider secret field and run the provider test. Berry stores only the local encrypted secret reference in the database.

## Berry Router

Use Berry Router when you need shared policy, org billing, usage export, model allowlists, or cost controls.

For a self-hosted router, configure:

- Desktop provider base URL: your router `/v1` endpoint
- Platform base URL: the platform URL used by `berry login`
- Managed policy public key: the `keyId=base64` public key distributed by the administrator

CLI login example:

```sh
berry login --base-url https://platform.example.test --public-key prod=BASE64
berry login --code OAUTH_CODE --json
berry policy sync --url https://platform.example.test/v1/policy.json --public-key prod=BASE64
```

## Confirm it works

- The provider test succeeds for the selected hosted model.
- `berry login status` reports the expected organization.
- `berry policy status` shows the signed policy version when managed policy is enabled.
- Usage export uses the configured cost controls and signing key after login.

## Admin notes

Hosted-provider keys, router domains, org enrollment, and paid billing plans are human-owned setup items. The repository provides the router contracts, policy sync, and mocked tests; production account creation belongs in the release runbook.
