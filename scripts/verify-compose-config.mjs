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
const caddyfile = readFileSync(resolve(root, "deploy/Caddyfile"), "utf8");
const productionEnv = readFileSync(resolve(root, "deploy/.env.production.example"), "utf8");

const requiredComposeSnippets = [
  "postgres:",
  "caddy:",
  "redis:",
  "minio:",
  "minio-init:",
  "api:",
  "worker:",
  "web:",
  "DEPLOYMENT_MODE:",
  "node\", \"apps/api/dist/main.js",
  "node\", \"apps/worker/dist/main.js",
  "apps/web/node_modules/.bin/srvx\", \"--prod\", \"-s\", \"../client\", \"apps/web/dist/server/server.js",
  "BERRY_DATABASE_URL:",
  "BERRY_REDIS_URL:",
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
];

const requiredDockerfileSnippets = [
  "corepack pnpm --filter @berry/api... build",
  "corepack pnpm --filter @berry/web... build",
  "corepack pnpm --filter @berry/worker... build",
  "docker.io",
  "CMD [\"node\", \"apps/api/dist/main.js\"]",
];

const requiredEnvSnippets = [
  "BETTER_AUTH_SECRET=",
  "BERRY_SCIM_BEARER_TOKEN=",
  "BERRY_BUDGETS_ENABLED=true",
  "BERRY_BUDGET_FAIL_CLOSED=true",
  "BERRY_BILLING_PROVIDER=none",
  "STRIPE_CREDIT_PRICE_ID=",
  "BERRY_USAGE_SIGNING_SECRETS=fixture:replace-me-usage-secret",
  "BERRY_POLICY_SIGNING_KEY_ID=self-host-2026",
  "BERRY_POLICY_SIGNING_PRIVATE_KEY_PEM=",
  "BERRY_AUDIT_S3_BUCKET=berry-audit",
  "BERRY_API_MODEL_MODE=fixture",
  "BERRY_SANDBOX_PROVIDER=fixture",
  "BERRY_ROUTER_SERVICE_TOKEN=",
  "BERRY_WEB_API_BASE_URL=http://localhost:3001",
  "BERRY_WEB_API_INTERNAL_URL=http://localhost:3001",
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
  "hpa:",
];

const requiredHelmTemplateSnippets = [
  "DEPLOYMENT_MODE",
  "BERRY_DATABASE_URL",
  "BERRY_REDIS_URL",
  "BERRY_BILLING_PROVIDER",
  "BERRY_ROUTER_API_KEY",
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
];

assertContains("deploy/compose.yaml", compose, requiredComposeSnippets);
assertContains("Dockerfile", dockerfile, requiredDockerfileSnippets);
assertContains("deploy/.env.example", envExample, requiredEnvSnippets);
assertContains("deploy/helm/berry-platform/values.yaml", helmValues, requiredHelmSnippets);
assertContains("deploy/helm/berry-platform/templates/*", `${helmConfig}\n${helmApi}\n${helmWeb}\n${helmWorker}\n${helmHpa}`, requiredHelmTemplateSnippets);
assertContains("deploy/dedicated-instance-runbook.md", dedicatedRunbook, ["DEPLOYMENT_MODE=dedicated", "helm upgrade --install berry", "kubectl -n berry-acme create secret generic berry-postgres", "kubectl -n berry-acme create secret generic berry-billing", "kubectl -n berry-acme create secret generic berry-e2b"]);
assertContains("deploy/Caddyfile", caddyfile, ["{$BERRY_DOMAIN}", "reverse_proxy @api api:3000", "reverse_proxy web:3108", "header @immutable_assets Cache-Control \"public, max-age=31536000, immutable\""]);
assertContains("deploy/.env.production.example", productionEnv, ["BERRY_DOMAIN=aesg-v2.berry.me", "BERRY_AUTH_MODE=better-auth", "BERRY_WEB_API_INTERNAL_URL=http://api:3000", "BERRY_ROUTER_COMPLETION_TRANSPORT=stream", "BERRY_ROUTER_MODELS_JSON=", "BERRY_CLOUD_MCP_SERVERS_JSON=", "BERRY_SANDBOX_PROVIDER=e2b", "E2B_API_KEY="]);
assertContains("deploy/PRODUCTION.md", productionRunbook, ["aesg-v2.berry.me", "pause/reconnect", "deploy/backup.sh"]);

console.log("[compose] self-host deployment config OK");
console.log("[helm] managed/dedicated/self-host chart config OK");

function assertContains(name, content, snippets) {
  for (const snippet of snippets) {
    if (!content.includes(snippet)) {
      throw new Error(`${name} missing required snippet: ${snippet}`);
    }
  }
}
