# Berry Self-Host Compose

Start the Phase 8 self-host stack from the repository root:

```sh
cp deploy/.env.example deploy/.env
./deploy/up.sh deploy/.env
```

The launcher prints the application URL but never prints the setup key. Open the application URL and append `#setup=<BERRY_SETUP_TOKEN>` locally. Confirm the configured owner email and complete the setup flow. The owner, organization membership, default workspace, and initial budgets are created in one database transaction; setup then closes automatically. After verifying owner sign-in, clear both `BERRY_SETUP_OWNER_EMAIL` and `BERRY_SETUP_TOKEN` and restart the stack. The API listens on `http://localhost:3001`, MinIO on `http://localhost:9000`, and the MinIO console on `http://localhost:9001`.

Defaults are intentionally local-only:

- `DEPLOYMENT_MODE=self-hosted` selects the public deployment model. Helm accepts `managed`, `dedicated`, or `self-hosted`; the app maps these to the internal tenant modes `shared`, `dedicated`, and `selfhost`.
- `BERRY_AUTH_MODE=better-auth` is used everywhere. `BERRY_SETUP_OWNER_EMAIL` and `BERRY_SETUP_TOKEN` protect the one-time first-owner setup; `BERRY_AUTH_SIGNUP_ENABLED` controls only later self-service member signup.
- `BERRY_API_MODEL_MODE=fixture` streams deterministic model output without paid provider credentials.
- Organization providers saved in Settings become runtime-eligible only after a guarded health check. Set `BERRY_ORGANIZATION_PROVIDER_ALLOWED_HOSTS` to an exact comma-separated host allowlist. Credential references resolve from API environment variables or from the server-only `BERRY_ORGANIZATION_PROVIDER_CREDENTIALS_JSON` object; raw keys are never saved in Berry's database.
- `BERRY_PERSONAL_MEMORY_PROVIDER=mem0` runs the open-source Mem0 package inside
  the stack. Set the internal API key, its dedicated PostgreSQL password, and
  OpenAI-compatible LLM/embedding settings before startup.
- `BERRY_BILLING_PROVIDER=none` keeps self-host free of Stripe/Lago dependencies. Managed or dedicated cloud should use `stripe` plus `STRIPE_SECRET_KEY`, `STRIPE_BILLING_METER_EVENT_NAME`, and `STRIPE_CREDIT_PRICE_ID` from an untracked secret store.
- `BERRY_SANDBOX_PROVIDER=fixture` keeps local smoke tests unprivileged. The production template uses the server-side E2B SDK directly; the API and durable worker receive the same server-owned E2B configuration.

Before exposing this deployment, set production secrets and public URLs in `deploy/.env`: `POSTGRES_PASSWORD`, `BERRY_MEM0_POSTGRES_PASSWORD`, `BERRY_MEM0_API_KEY`, the `BERRY_MEM0_LLM_*` and `BERRY_MEM0_EMBEDDING_*` settings, `MINIO_ROOT_PASSWORD`, `BETTER_AUTH_SECRET`, `BERRY_SETUP_OWNER_EMAIL`, `BERRY_SETUP_TOKEN`, `BERRY_AUTH_BASE_URL`, `BERRY_AUTH_TRUSTED_ORIGINS`, `E2B_API_KEY`, `BERRY_SCIM_BEARER_TOKEN` if SCIM provisioning is enabled, `BERRY_USAGE_SIGNING_SECRETS` for signed provider usage webhooks, `BERRY_POLICY_SIGNING_KEY_ID` plus `BERRY_POLICY_SIGNING_PRIVATE_KEY_PEM` for signed `berry-policy.json` publication, `BERRY_PLATFORM_*` values for desktop/CLI org login verification, `BERRY_AUDIT_S3_*` for audit SIEM drops when using S3 export, `STRIPE_*` values for managed/dedicated billing when `BERRY_BILLING_PROVIDER=stripe`, and the BerryRouter inference credentials. Webhook SIEM export destinations are configured per org through `PUT /v1/orgs/:tenantId/audit/exports`.

For the Hetzner single-box deployment, follow `deploy/PRODUCTION.md` and start from `deploy/.env.production.example`. For Kubernetes, install `deploy/helm/berry-platform` and provide external Postgres, Redis, and S3-compatible buckets through Kubernetes Secrets. Use `deploy/dedicated-instance-runbook.md` for a dedicated-customer namespace with custom web/API domains.

For memory, project RAG, prompt-cache telemetry, long-running turn recovery,
backfills, and retention cleanup, use
[`docs/durable-context-operations.md`](../docs/durable-context-operations.md).
For Mem0 ownership, isolation, configuration, backups, and rollback, use
[`docs/self-hosted-personal-memory.md`](../docs/self-hosted-personal-memory.md).
