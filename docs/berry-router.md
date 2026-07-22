# Berry Router integration

Berry Desktop treats Router as an external HTTP contract. Routing, fallback selection, virtual keys, billing, and quota enforcement do not run in this repository.

## Provisional contract

The checked-in fixture at `packages/router-client/src/fixtures/berry-router-contract.json` locks the contract used while the live service is unconfirmed:

- OpenAI-compatible `POST /v1/chat/completions`, `POST /v1/responses`, and `GET /v1/models`.
- Bearer credentials stored under the encrypted `berry-router` credential reference.
- Alias model IDs such as `berry/fast`, `berry/cheap`, and `berry/flagship` are sent unchanged in the request `model` field.
- Served-provider/model metadata uses `x-berry-served-provider` and `x-berry-served-model`. The client also accepts the equivalent `x-router-*` headers and response-body `served_provider`, `served_model`, `metadata`, or `routing` fields.
- Header-only usage uses `x-berry-usage-input-tokens`, `x-berry-usage-output-tokens`, and `x-berry-usage-total-tokens`; `x-router-*` and `x-usage-*` equivalents are accepted.
- `GET /v1/account` returns account identity, plan, quota, usage, and aliases. The normalizer accepts the fixture's nested shape and common flat variants.
- OAuth uses Authorization Code with PKCE S256 and the provisional callback `berry://router/oauth/callback`. No client secret is embedded in the app.

## Runtime configuration

The desktop host reads these variables from its process environment:

```sh
export BERRY_ROUTER_OAUTH_CLIENT_ID='native-client-id'
export BERRY_ROUTER_AUTHORIZE_URL='https://ROUTER_HOST/oauth/authorize'
export BERRY_ROUTER_TOKEN_URL='https://ROUTER_HOST/oauth/token'
export BERRY_ROUTER_REDIRECT_URI='berry://router/oauth/callback'
export BERRY_ROUTER_ACCOUNT_PATH='/account'
```

`BERRY_ROUTER_API_KEY` remains the non-interactive credential fallback. The Router provider base URL is currently the provisional `https://router.berry.dev/v1` preset.

OAuth is shown only when the client ID and both OAuth endpoint variables are present. Paste-key connection remains available without them. Tauri registers the `berry` desktop scheme, validates the exact callback route, rejects expired/replayed OAuth state, and opens authorization only over HTTPS.

## Fixture verification

```sh
corepack pnpm --filter @berry/router-client test
corepack pnpm --filter @berry/host test
corepack pnpm --dir apps/desktop exec playwright test tests/local-models.spec.ts --project=chromium --project=webkit
```

The tests cover chat, Responses, models, usage headers, account normalization, PKCE exchange, state replay rejection, encrypted credential handoff through the Tauri shell, account/quota rendering, OAuth callback handling, and served-by usage rows.
