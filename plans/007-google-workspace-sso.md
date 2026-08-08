# Plan 007: Google Workspace SSO with future enterprise identity seams

Status: **DONE**
Owner: Authentication and enterprise identity
Last updated: 2026-08-08

## Outcome

Berry will support Google Workspace sign-in for the AESG deployment at
`https://ai.aesg.com` while retaining local email/password authentication.
The first production provider is Google OIDC. The stored connection and
membership contracts remain provider-neutral so Microsoft Entra ID, Okta,
generic OIDC, SAML 2.0, and SCIM 2.0 can be added without changing the user or
tenant model.

The Google callback URI is:

```text
https://ai.aesg.com/v1/auth/callback/google
```

## Product rules

- SSO is optional. Local password sign-in remains visible and functional.
- Only an organization owner or administrator with `sso:write` can configure
  or enable SSO.
- SSO client credentials are stored in PostgreSQL as authenticated ciphertext.
  `BERRY_CONNECTOR_ENCRYPTION_KEY` remains the root key supplied by the
  deployment environment and supports bounded rotation through
  `BERRY_CONNECTOR_DECRYPTION_KEYS`.
- Google SSO requests only `openid email profile`. Connector scopes for Drive,
  Gmail, and Calendar are separate grants and are never requested during sign-in.
- The Google authorization request may send `hd` as a UI hint, but access is
  enforced using the signed `hd` claim in the returned ID token.
- A new approved SSO user may be JIT-provisioned as a `member`. SSO never grants
  the owner or administrator role.
- Existing local accounts may link to Google only when Google has verified the
  email and the hosted-domain restriction passes.
- Disabled or deprovisioned memberships cannot create an authorized Berry
  session even if Google authentication succeeds.

## Implementation shape

1. Extend `sso_connections` additively with a provider identifier, encrypted
   client-secret envelope, JIT policy, default role, and operational health
   fields. Responses expose only `clientSecretConfigured`.
2. Keep the existing provider-neutral `kind` (`oidc` or `saml`), issuer,
   domains, and SCIM fields. Google is the only executable provider in this
   release.
3. Load the enabled Google connection from PostgreSQL when a Google sign-in
   starts. Cache the Better Auth handler by a non-secret configuration
   fingerprint so an admin change takes effect without an API restart.
4. Let Better Auth perform authorization-code state handling, PKCE, code
   exchange, ID-token signature/issuer/audience/expiry checks, secure session
   cookies, and verified-email account linking.
5. Use the Google provider's hosted-domain validation and create the Berry
   tenant membership with source `sso` after a new SSO user is created.
6. Replace the placeholder redirect generator with an admin configuration
   form and a real `Continue with Google` login action.

## Future SCIM and provider contract

The existing SCIM-shaped resources and tenant membership lifecycle remain the
forward-compatible seam. Before SCIM is declared production-ready, Berry must
still add per-connection hashed bearer tokens, complete RFC 7644 filtering and
pagination, full PATCH semantics, standard error documents, group membership
reconciliation, token rotation/revocation, and conformance tests.

Future OIDC/SAML providers should use the same encrypted connection record and
membership source. Generic OIDC discovery must allowlist HTTPS issuer origins
and defend against SSRF before arbitrary administrator-supplied issuers are
enabled. SAML must validate signed assertions, audience, recipient, time
windows, replay IDs, and certificate rotation; the existing placeholder SAML
request builder must not be used.

## Verification gates

Completed on 2026-08-08: the production web build, all four required typecheck
paths, 227 API tests, 105 web tests, 82 database tests, and 44 API-client tests
passed. Browser QA covered the admin configuration dialog, saved enabled state,
coexistence with password login, and the Google authorization redirect.

- Database migration and shared schema tests cover all new fields and prove
  plaintext client secrets never appear in response objects.
- API tests cover admin authorization, strict input validation, encrypted
  storage, live enable/disable behavior, JIT membership source, and local
  password coexistence.
- Web tests cover Google-button visibility, OAuth redirect initiation, and
  the admin configuration screen.
- Run:

```sh
pnpm --filter @berry/web... typecheck
pnpm --filter @berry/web... build
pnpm --filter @berry/api... typecheck
pnpm --filter @berry/worker... typecheck
```

## Sources behind the design

- Google OpenID Connect documents the exact redirect match, authorization-code
  flow, ID-token validation, and signed `hd` claim enforcement.
- Better Auth's Google provider validates issuer, audience, signature, expiry,
  verified email, OAuth state, and configured Workspace `hd` restrictions.
- RFC 7643 and RFC 7644 define the future SCIM resource and protocol contract;
  the current seams are not labelled production-complete until conformance is
  implemented.
