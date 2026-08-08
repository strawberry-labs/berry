# Dedicated Instance Provisioning Runbook

This runbook is for one Berry tenant per isolated cluster or namespace. It uses the same image and Helm chart as managed cloud and self-hosted deployments, with `DEPLOYMENT_MODE=dedicated`.

## Prerequisites

- Kubernetes 1.30+ with an ingress controller and metrics server.
- External Postgres with a migration account that owns the Berry schema and can
  create the three service roles. The long-lived API and worker accounts must
  not own tables or have `BYPASSRLS`.
- External Redis for budgets, streaming jobs, and workers.
- S3-compatible artifact and audit buckets.
- DNS control for the customer web and API hostnames.
- Secret manager or sealed-secret flow for auth, policy, usage, billing, BerryRouter, E2B, and S3 credentials.

## Provision

```sh
kubectl create namespace berry-acme
kubectl -n berry-acme create secret generic berry-postgres \
  --from-literal=BERRY_MIGRATION_DATABASE_URL='postgres://schema-owner:...@postgres/berry' \
  --from-literal=BERRY_API_DATABASE_URL='postgres://berry_api:...@postgres/berry' \
  --from-literal=BERRY_WORKER_DATABASE_URL='postgres://berry_worker:...@postgres/berry' \
  --from-literal=BERRY_PLATFORM_DATABASE_URL='postgres://berry_platform:...@postgres/berry' \
  --from-literal=BERRY_API_DATABASE_PASSWORD='...' \
  --from-literal=BERRY_WORKER_DATABASE_PASSWORD='...' \
  --from-literal=BERRY_PLATFORM_DATABASE_PASSWORD='...'
kubectl -n berry-acme create secret generic berry-redis --from-literal=BERRY_REDIS_URL='redis://...'
kubectl -n berry-acme create secret generic berry-s3 \
  --from-literal=BERRY_ARTIFACT_S3_ACCESS_KEY_ID='...' \
  --from-literal=BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY='...'
kubectl -n berry-acme create secret generic berry-auth \
  --from-literal=BETTER_AUTH_SECRET='...' \
  --from-literal=BERRY_SCIM_BEARER_TOKEN='...'
kubectl -n berry-acme create secret generic berry-policy-signing \
  --from-literal=BERRY_POLICY_SIGNING_KEY_ID='acme-2026' \
  --from-file=BERRY_POLICY_SIGNING_PRIVATE_KEY_PEM=./berry-policy-ed25519.pem
kubectl -n berry-acme create secret generic berry-usage-signing --from-literal=BERRY_USAGE_SIGNING_SECRETS='router-prod:...,sandbox-prod:...,client-prod:...'
kubectl -n berry-acme create secret generic berry-billing \
  --from-literal=STRIPE_SECRET_KEY='sk_live_...' \
  --from-literal=STRIPE_BILLING_METER_EVENT_NAME='berry_model_tokens' \
  --from-literal=STRIPE_CREDIT_PRICE_ID='price_...'
kubectl -n berry-acme create secret generic berry-router --from-literal=BERRY_ROUTER_API_KEY='...'
kubectl -n berry-acme create secret generic berry-e2b --from-literal=E2B_API_KEY='...'
kubectl -n berry-acme create secret generic berry-connectors --from-literal=BERRY_CONNECTOR_ENCRYPTION_KEY='...'

helm upgrade --install berry deploy/helm/berry-platform \
  --namespace berry-acme \
  --set deploymentMode=dedicated \
  --set image.repository=ghcr.io/YOUR_ORG/berry-chat \
  --set image.tag=YOUR_TAG \
  --set auth.baseUrl=https://api.acme.example.com \
  --set auth.trustedOrigins=https://berry.acme.example.com \
  --set external.s3.endpoint=https://s3.us-east-1.amazonaws.com \
  --set external.s3.artifactBucket=acme-berry-artifacts \
  --set external.s3.auditBucket=acme-berry-audit \
  --set billing.provider=stripe \
  --set connectors.enabled=true \
  --set router.inferenceBaseUrl=https://router.acme.example.com/v1 \
  --set sandbox.templateId=base \
  --set ingress.enabled=true \
  --set ingress.webHost=berry.acme.example.com \
  --set ingress.apiHost=api.acme.example.com \
  --set ingress.tlsSecretName=berry-acme-tls
```

The artifact S3 principal must allow `s3:ListBucketVersions` on the artifact
bucket and `s3:DeleteObject` plus `s3:DeleteObjectVersion` on its objects. Berry
does not acknowledge a file-deletion job until every stored version and delete
marker has been removed.

## Confirm

```sh
kubectl -n berry-acme rollout status deploy/berry-platform-api
kubectl -n berry-acme rollout status deploy/berry-platform-web
kubectl -n berry-acme rollout status deploy/berry-platform-worker
kubectl -n berry-acme get hpa
curl -fsS https://api.acme.example.com/healthz
```

Then register the dedicated host mapping, configure SSO/SCIM, publish a signed policy, verify Stripe test-mode credit grants and meter events, and run the Phase 9 end-to-end smoke from `plans/human-blockers.md`.
