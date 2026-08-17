import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const compose = readFileSync(resolve(root, "deploy/compose.yaml"), "utf8");
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const envExample = readFileSync(resolve(root, "deploy/.env.example"), "utf8");
const helmValues = readFileSync(resolve(root, "deploy/helm/berry-platform/values.yaml"), "utf8");
const helmConfig = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/configmap.yaml"), "utf8");
const helmApi = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/api-deployment.yaml"), "utf8");
const helmWeb = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/web-deployment.yaml"), "utf8");
const helmWorker = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/worker-deployment.yaml"), "utf8");
const helmHpa = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/hpa.yaml"), "utf8");
const dedicatedRunbook = readFileSync(resolve(root, "deploy/dedicated-instance-runbook.md"), "utf8");
const productionRunbook = readFileSync(resolve(root, "deploy/PRODUCTION.md"), "utf8");
const deploymentLauncher = readFileSync(resolve(root, "deploy/up.sh"), "utf8");
const serverDeploy = readFileSync(resolve(root, "deploy/server-deploy.sh"), "utf8");
const ssmApplicationDeploy = readFileSync(resolve(root, "deploy/aws/deploy-application.sh"), "utf8");
const deploymentImpact = readFileSync(resolve(root, "deploy/deployment-impact.sh"), "utf8");
const caddyfile = readFileSync(resolve(root, "deploy/Caddyfile"), "utf8");
const productionEnv = readFileSync(resolve(root, "deploy/.env.production.example"), "utf8");

const requiredComposeSnippets = [
  "postgres:",
  "mem0-postgres:",
  "embeddings:",
  "mem0:",
  "caddy:",
  "redis:",
  "minio:",
  "minio-init:",
  "api:",
  "worker:",
  "web:",
  "BERRY_CSP_EXTRA_FRAME_SOURCES:",
  "BERRY_CSP_EXTRA_CONNECT_SOURCES:",
  "BERRY_CSP_EXTRA_IMAGE_SOURCES:",
  "DEPLOYMENT_MODE:",
  "node\", \"apps/api/dist/main.js",
  "node\", \"apps/worker/dist/main.js",
  "node\", \"apps/mem0/dist/main.js",
  "apps/web/node_modules/.bin/srvx\", \"--prod\", \"-s\", \"../client\", \"apps/web/dist/server/server.js",
  "BERRY_DATABASE_URL:",
  "BERRY_REDIS_URL:",
  "BERRY_BUILD_REVISION:",
  "BERRY_WAIT_EXPIRY_ENABLED:",
  "BERRY_TERMINAL_FINALIZATION_ENABLED:",
  "BERRY_MEM0_DATABASE_URL:",
  "BERRY_MEM0_BASE_URL:",
  "BERRY_EMBEDDING_BASE_URL:",
  "BERRY_EMBEDDING_API_KEY:",
  "BERRY_BUDGETS_ENABLED:",
  "BERRY_BUDGET_FAIL_CLOSED:",
  "BERRY_BILLING_PROVIDER:",
  "STRIPE_SECRET_KEY:",
  "STRIPE_BILLING_METER_EVENT_NAME:",
  "BERRY_USAGE_SIGNING_SECRETS:",
  "BERRY_POLICY_SIGNING_KEY_ID:",
  "BERRY_POLICY_SIGNING_PRIVATE_KEY_PEM:",
  "BERRY_AUDIT_S3_ENDPOINT:",
  "BERRY_AUDIT_S3_BUCKET:",
  "BERRY_AUDIT_S3_ACCESS_KEY_ID:",
  "BERRY_AUDIT_S3_SECRET_ACCESS_KEY:",
  "BERRY_SCIM_BEARER_TOKEN:",
  "BERRY_SANDBOX_PROVIDER:",
  "BERRY_ROUTER_INFERENCE_BASE_URL:",
  "BERRY_ROUTER_COMPLETION_TRANSPORT:",
  "BERRY_ORGANIZATION_PROVIDER_ALLOWED_HOSTS:",
  "BERRY_ORGANIZATION_PROVIDER_CREDENTIALS_JSON:",
  "BERRY_CLOUD_MCP_SERVERS_JSON:",
  "BERRY_CLOUD_SKILLS_JSON:",
  "E2B_API_KEY:",
  "BERRY_E2B_TEMPLATE_ID:",
  "BERRY_E2B_ESTIMATED_HOURLY_COST_MICROS:",
  "BERRY_ARTIFACT_S3_ENDPOINT:",
  "BERRY_ARTIFACT_S3_PUBLIC_ENDPOINT:",
  "BERRY_FILE_MAX_UPLOAD_BYTES:",
  "BERRY_WEB_API_INTERNAL_URL: http://api:3000",
  "mc mb --ignore-existing",
  "127.0.0.1:${BERRY_API_PORT:-3001}:3000",
  "image: ${BERRY_API_IMAGE:-berry-api:local}",
  "image: ${BERRY_WORKER_IMAGE:-berry-worker:local}",
  "image: ${BERRY_MEM0_IMAGE:-berry-mem0:local}",
  "image: ${BERRY_WEB_IMAGE:-berry-web:local}",
  "fetch('http://127.0.0.1:3010/readyz')",
];

const requiredDockerfileSnippets = [
  "corepack pnpm --filter @berry/api... build",
  "corepack pnpm --filter @berry/web... build",
  "corepack pnpm --filter @berry/worker... build",
  "corepack pnpm --filter @berry/mem0... build",
  "corepack pnpm --filter @berry/api deploy --prod --legacy /out/apps/api",
  "corepack pnpm --filter @berry/web deploy --prod --legacy /out/apps/web",
  "docker.io",
  "CMD [\"node\", \"apps/api/dist/main.js\"]",
  "CMD [\"node\", \"apps/mem0/dist/main.js\"]",
  "EXPOSE 3000 3010 3108 8010",
];

const requiredEnvSnippets = [
  "BETTER_AUTH_SECRET=",
  "BERRY_SCIM_BEARER_TOKEN=",
  "BERRY_BUDGETS_ENABLED=true",
  "BERRY_BUDGET_FAIL_CLOSED=true",
  "BERRY_WAIT_EXPIRY_ENABLED=false",
  "BERRY_TERMINAL_FINALIZATION_ENABLED=false",
  "BERRY_PERSONAL_MEMORY_PROVIDER=mem0",
  "BERRY_MEM0_API_KEY=",
  "BERRY_BILLING_PROVIDER=none",
  "STRIPE_CREDIT_PRICE_ID=",
  "BERRY_USAGE_SIGNING_SECRETS=fixture:replace-me-usage-secret",
  "BERRY_POLICY_SIGNING_KEY_ID=self-host-2026",
  "BERRY_POLICY_SIGNING_PRIVATE_KEY_PEM=",
  "BERRY_AUDIT_S3_BUCKET=berry-audit",
  "BERRY_API_MODEL_MODE=fixture",
  "BERRY_ORGANIZATION_PROVIDER_ALLOWED_HOSTS=",
  "BERRY_SANDBOX_PROVIDER=fixture",
  "BERRY_ROUTER_SERVICE_TOKEN=",
  "BERRY_WEB_API_BASE_URL=http://localhost:3001",
  "BERRY_WEB_API_INTERNAL_URL=http://localhost:3001",
  "BERRY_CSP_EXTRA_FRAME_SOURCES=https://*.e2b.app",
  "BERRY_CSP_EXTRA_CONNECT_SOURCES=",
  "BERRY_CSP_EXTRA_IMAGE_SOURCES=",
  "BERRY_ARTIFACT_S3_PUBLIC_ENDPOINT=http://127.0.0.1:9000",
  "DEPLOYMENT_MODE=self-hosted",
];

const requiredHelmSnippets = [
  "deploymentMode: self-hosted",
  "external:",
  "postgres:",
  "redis:",
  "s3:",
  "existingSecret: berry-postgres",
  "existingSecret: berry-redis",
  "existingSecret: berry-s3",
  "existingSecret: berry-billing",
  "existingSecret: berry-mem0",
  "hpa:",
];

const requiredHelmTemplateSnippets = [
  "DEPLOYMENT_MODE",
  "BERRY_DATABASE_URL",
  "BERRY_REDIS_URL",
  "BERRY_BILLING_PROVIDER",
  "BERRY_ROUTER_API_KEY",
  "BERRY_ORGANIZATION_PROVIDER_CREDENTIALS_JSON",
  "BERRY_MEM0_API_KEY",
  "E2B_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_BILLING_METER_EVENT_NAME",
  "BERRY_ARTIFACT_S3_ENDPOINT",
  "BERRY_ARTIFACT_S3_PUBLIC_ENDPOINT",
  "BERRY_WEB_API_INTERNAL_URL",
  "BERRY_AUDIT_S3_BUCKET",
  "node\", \"apps/api/dist/main.js",
  "apps/web/node_modules/.bin/srvx\", \"--prod\", \"-s\", \"../client\", \"apps/web/dist/server/server.js",
  "node\", \"apps/worker/dist/main.js",
  "kind: HorizontalPodAutoscaler",
  "name: {{ include \"berry-platform.name\" . }}-api",
  "name: {{ include \"berry-platform.name\" . }}-web",
  "name: {{ include \"berry-platform.name\" . }}-worker",
  "name: {{ include \"berry-platform.name\" . }}-mem0",
];

assertContains("deploy/compose.yaml", compose, requiredComposeSnippets);
assertOccurrences("deploy/compose.yaml", compose, "BERRY_BUILD_REVISION:", 4);
assertContains("Dockerfile", dockerfile, requiredDockerfileSnippets);
assertOccurrences("Dockerfile", dockerfile, "USER node", 4);
assertContains("deploy/.env.example", envExample, requiredEnvSnippets);
assertContains("deploy/helm/berry-platform/values.yaml", helmValues, requiredHelmSnippets);
const helmMem0 = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/mem0-deployment.yaml"), "utf8");
assertContains("deploy/helm/berry-platform/templates/*", `${helmConfig}\n${helmApi}\n${helmWeb}\n${helmWorker}\n${helmMem0}\n${helmHpa}`, requiredHelmTemplateSnippets);
assertContains("deploy/dedicated-instance-runbook.md", dedicatedRunbook, ["DEPLOYMENT_MODE=dedicated", "helm upgrade --install berry", "kubectl -n berry-acme create secret generic berry-postgres", "kubectl -n berry-acme create secret generic berry-billing", "kubectl -n berry-acme create secret generic berry-e2b"]);
assertContains("deploy/Caddyfile", caddyfile, ["{$BERRY_DOMAIN}", "reverse_proxy @api api:3000", "reverse_proxy web:3108", "header @immutable_assets Cache-Control \"public, max-age=31536000, immutable\"", "Content-Security-Policy \"default-src 'none'; sandbox\"", "X-Frame-Options \"SAMEORIGIN\""]);
assertContains("deploy/.env.production.example", productionEnv, ["BERRY_DOMAIN=ai.example.com", "BERRY_AUTH_MODE=better-auth", "BERRY_WEB_API_INTERNAL_URL=http://api:3000", "BERRY_CSP_EXTRA_FRAME_SOURCES=https://*.e2b.app", "BERRY_CSP_EXTRA_CONNECT_SOURCES=", "BERRY_CSP_EXTRA_IMAGE_SOURCES=", "BERRY_ROUTER_COMPLETION_TRANSPORT=stream", "BERRY_ROUTER_MODELS_JSON=", "BERRY_ORGANIZATION_PROVIDER_ALLOWED_HOSTS=", "BERRY_ORGANIZATION_PROVIDER_CREDENTIALS_JSON=", "BERRY_CLOUD_MCP_SERVERS_JSON=", "BERRY_SANDBOX_PROVIDER=e2b", "E2B_API_KEY=", "BERRY_SANDBOX_TTL_SECONDS=300", "BERRY_WAIT_EXPIRY_ENABLED=false", "BERRY_TERMINAL_FINALIZATION_ENABLED=false"]);
assertContains("deploy/PRODUCTION.md", productionRunbook, ["ai.example.com", "pause/reconnect", "deploy/backup.sh", "bak-sandbox-ttl-300", "require IMDSv2", "metadata response hop limit to `2`", "EC2 role can access artifact S3"]);
assertContains("deploy/up.sh", deploymentLauncher, ["BERRY_CONNECTOR_ENCRYPTION_KEY", "openssl base64 -d -A", 'connector_encryption_key_bytes" != "32"']);
assertContains("deploy/server-deploy.sh", serverDeploy, [
  "max_sandbox_ttl_seconds=300",
  "Deployment automation will not replace the production environment file",
  "BERRY_DEPLOY_EXPECTED_DOMAIN",
  'export BERRY_BUILD_REVISION="$target_ref"',
  "not reachable from origin/main",
  'git -c "safe.directory=$repo_dir" "$@"',
  "berry_runtime_revision_is_compatible",
  "berry_revision_impacts_service",
  "berry_runtime_revisions_match",
]);
assertContains("deploy/aws/deploy-application.sh", ssmApplicationDeploy, [
  "BERRY_AWS_DOMAIN",
  "BERRY_DEPLOY_COMMIT",
  "DomainName",
  "berry:role",
  "aws:cloudformation:stack-name",
  "describe-instance-information",
  "dig +short A",
  "BERRY_DEPLOY_EXPECTED_DOMAIN",
  "git -c safe.directory=/opt/berry merge-base --is-ancestor",
  "AWS-RunShellScript",
]);
assertContains("deploy/server-deploy.sh", serverDeploy, [
  "deployment-impact.sh",
  "compose build $berry_image_services",
  "berry_runtime_services=",
  "compose run --rm --no-deps minio-init",
  'worker_scale_args="--scale worker=$background_worker_replicas --scale worker-foreground=$foreground_worker_replicas"',
  "--wait-timeout 120 $worker_scale_args $berry_runtime_services",
]);
assertContains("deploy/deployment-impact.sh", deploymentImpact, ["packages/db/*", "berry_run_migrations=true", "deploy/compose.yaml"]);

console.log("[compose] self-host deployment config OK");
console.log("[helm] managed/dedicated/self-host chart config OK");

function assertContains(name, content, snippets) {
  for (const snippet of snippets) {
    if (!content.includes(snippet)) {
      throw new Error(`${name} missing required snippet: ${snippet}`);
    }
  }
}

function assertOccurrences(name, content, snippet, expected) {
  const actual = content.split(snippet).length - 1;
  if (actual < expected) {
    throw new Error(`${name} expected at least ${expected} occurrences of ${snippet}, found ${actual}`);
  }
}
