# Berry Self-Host Compose

Start the Phase 8 self-host stack from the repository root:

```sh
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

Then open `http://localhost:3108`. The API listens on `http://localhost:3001`, MinIO on `http://localhost:9000`, and the MinIO console on `http://localhost:9001`.

Defaults are intentionally local-only:

- `DEPLOYMENT_MODE=self-hosted` selects the public deployment model. Helm accepts `managed`, `dedicated`, or `self-hosted`; the app maps these to the internal tenant modes `shared`, `dedicated`, and `selfhost`.
- `BERRY_AUTH_MODE=single-user` bypasses external identity setup for a private self-host smoke.
- `BERRY_API_MODEL_MODE=fixture` streams deterministic model output without paid provider credentials.
- `BERRY_BILLING_PROVIDER=none` keeps self-host free of Stripe/Lago dependencies. Managed or dedicated cloud should use `stripe` plus `STRIPE_SECRET_KEY`, `STRIPE_BILLING_METER_EVENT_NAME`, and `STRIPE_CREDIT_PRICE_ID` from an untracked secret store.
- `BERRY_SANDBOX_PROVIDER=fixture` keeps local smoke tests unprivileged. The production template uses the server-side E2B SDK directly; `E2B_API_KEY` is present only in the API container.

Before exposing this deployment, set production secrets and public URLs in `deploy/.env`: `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `BETTER_AUTH_SECRET`, `BERRY_AUTH_BASE_URL`, `BERRY_AUTH_TRUSTED_ORIGINS`, `E2B_API_KEY`, `BERRY_SCIM_BEARER_TOKEN` if SCIM provisioning is enabled, `BERRY_USAGE_SIGNING_SECRETS` for signed provider usage webhooks, `BERRY_POLICY_SIGNING_KEY_ID` plus `BERRY_POLICY_SIGNING_PRIVATE_KEY_PEM` for signed `berry-policy.json` publication, `BERRY_PLATFORM_*` values for desktop/CLI org login verification, `BERRY_AUDIT_S3_*` for audit SIEM drops when using S3 export, `STRIPE_*` values for managed/dedicated billing when `BERRY_BILLING_PROVIDER=stripe`, and the BerryRouter inference credentials. Webhook SIEM export destinations are configured per org through `PUT /v1/orgs/:tenantId/audit/exports`.

For the Hetzner single-box deployment, follow `deploy/PRODUCTION.md` and start from `deploy/.env.production.example`. For Kubernetes, install `deploy/helm/berry-platform` and provide external Postgres, Redis, and S3-compatible buckets through Kubernetes Secrets. Use `deploy/dedicated-instance-runbook.md` for a dedicated-customer namespace with custom web/API domains.
