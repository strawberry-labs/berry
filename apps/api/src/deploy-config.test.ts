import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deploymentRuntimeDescription, publicDeploymentModeFromEnv, tenantDeploymentModeForPublicMode } from "./deployment-mode.ts";

const root = resolve(import.meta.dirname, "../../..");
const compose = readFileSync(resolve(root, "deploy/compose.yaml"), "utf8");
const awsCompose = readFileSync(resolve(root, "deploy/compose.aws.yaml"), "utf8");
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const envExample = readFileSync(resolve(root, "deploy/.env.example"), "utf8");
const productionEnvExample = readFileSync(resolve(root, "deploy/.env.production.example"), "utf8");
const helmValues = readFileSync(resolve(root, "deploy/helm/berry-platform/values.yaml"), "utf8");
const helmConfig = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/configmap.yaml"), "utf8");
const helmApi = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/api-deployment.yaml"), "utf8");
const helmWeb = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/web-deployment.yaml"), "utf8");
const helmWorker = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/worker-deployment.yaml"), "utf8");
const helmHpa = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/hpa.yaml"), "utf8");
const helmDatabaseBootstrap = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/database-bootstrap-job.yaml"), "utf8");
const runbook = readFileSync(resolve(root, "deploy/dedicated-instance-runbook.md"), "utf8");
const productionRunbook = readFileSync(resolve(root, "deploy/PRODUCTION.md"), "utf8");
const serviceRoleBootstrap = readFileSync(resolve(root, "apps/api/src/configure-service-roles.ts"), "utf8");
const deploymentLauncher = readFileSync(resolve(root, "deploy/up.sh"), "utf8");
const caddyfile = readFileSync(resolve(root, "deploy/Caddyfile"), "utf8");
const storageCaddyfile = readFileSync(resolve(root, "deploy/Caddyfile.storage"), "utf8");
const composeApi = compose.split("\n  api:")[1]?.split("\n  worker:")[0] ?? "";
const composeWorker = compose.split("\n  worker:")[1]?.split("\n  web:")[0] ?? "";

describe("self-host compose deployment", () => {
  it("runs api, web, and worker with local MinIO or IAM-backed S3", () => {
    for (const service of ["caddy", "postgres", "db-migrate", "postgres-roles", "redis", "minio", "minio-init", "api", "worker", "web"]) {
      expect(compose).toContain(`  ${service}:`);
    }
    expect(compose).toContain('command: ["node", "apps/api/dist/main.js"]');
    expect(compose).toContain('command: ["apps/web/node_modules/.bin/srvx", "--prod", "-s", "../client", "apps/web/dist/server/server.js"]');
    expect(compose).toContain('command: ["node", "apps/worker/dist/main.js"]');
    expect(compose).toContain("BERRY_DATABASE_URL:");
    expect(compose).toContain("berry_api:");
    expect(compose).toContain("berry_worker:");
    expect(compose).toContain("berry_platform:");
    expect(compose).toContain("BERRY_RUN_MIGRATIONS: \"false\"");
    expect(compose).toContain('command: ["node", "apps/api/dist/configure-service-roles.js"]');
    expect(compose).toContain("BERRY_REDIS_URL:");
    expect(composeWorker).toContain("BERRY_MODEL_IDLE_TIMEOUT_MS: ${BERRY_MODEL_IDLE_TIMEOUT_MS:-240000}");
    expect(composeWorker).toContain("BERRY_MODEL_MAX_DURATION_MS: ${BERRY_MODEL_MAX_DURATION_MS:-900000}");
    expect(envExample).toContain("BERRY_MODEL_IDLE_TIMEOUT_MS=240000");
    expect(envExample).toContain("BERRY_MODEL_MAX_DURATION_MS=900000");
    expect(compose).toContain("DEPLOYMENT_MODE:");
    expect(compose).toContain("BERRY_BUDGETS_ENABLED:");
    expect(compose).toContain("BERRY_BUDGET_FAIL_CLOSED:");
    expect(compose).toContain("BERRY_BILLING_PROVIDER:");
    expect(compose).toContain("STRIPE_BILLING_METER_EVENT_NAME:");
    expect(compose).toContain("BERRY_ARTIFACT_S3_ENDPOINT: ${BERRY_ARTIFACT_S3_ENDPOINT:-}");
    expect(compose).toContain("BERRY_ARTIFACT_S3_ACCESS_KEY_ID: ${BERRY_ARTIFACT_S3_ACCESS_KEY_ID:-}");
    expect(envExample).toContain("BERRY_ARTIFACT_S3_ENDPOINT=http://minio:9000");
    expect(compose).toContain("BERRY_AUTH_LOGIN_METHODS: ${BERRY_AUTH_LOGIN_METHODS:-password}");
    expect(compose).toContain("BERRY_AUTH_GOOGLE_REDIRECT_URI: ${BERRY_AUTH_GOOGLE_REDIRECT_URI:-}");
    expect(compose).toContain("BERRY_AUTH_IP_ADDRESS_HEADERS: ${BERRY_AUTH_IP_ADDRESS_HEADERS:-x-berry-client-ip,x-forwarded-for}");
    expect(compose).toContain("BERRY_AUTH_SOCIAL_SIGN_IN_RATE_LIMIT_MAX: ${BERRY_AUTH_SOCIAL_SIGN_IN_RATE_LIMIT_MAX:-600}");
    expect(compose).toContain("mc mb --ignore-existing");
    expect(compose).toContain('127.0.0.1:${BERRY_API_PORT:-3001}:3000');
    expect(caddyfile).toContain("reverse_proxy @api api:3000");
    expect(caddyfile).toContain("header_up X-Berry-Client-IP {http.request.remote.host}");
    expect(caddyfile).toContain("reverse_proxy web:3108");
    expect(caddyfile).toContain("not path /v1/sessions/*/events /v1/tasks/*/events");
    expect(caddyfile).toContain('Cache-Control "no-cache, no-transform"');
    expect(caddyfile).toContain("flush_interval -1");
    expect(caddyfile).toContain("protocols h1 h2");
    expect(caddyfile).toContain("import {$BERRY_STORAGE_PROXY_IMPORT:");
    expect(caddyfile).not.toContain("reverse_proxy minio:9000");
    expect(storageCaddyfile).toContain("{$BERRY_FILES_DOMAIN}");
    expect(storageCaddyfile).toContain("reverse_proxy minio:9000");
    expect(compose).toContain("BERRY_STORAGE_PROXY_IMPORT:");
    expect(compose).toContain("./Caddyfile.native:/etc/caddy/storage/native/storage.caddy:ro");
    expect(compose).not.toContain('"443:443/udp"');
  });

  it("uses RDS and excludes local database containers in the AWS profile", () => {
    expect(awsCompose).toContain('profiles: ["local-database"]');
    expect(awsCompose).toContain("depends_on: !override {}");
    expect(awsCompose).toContain("BERRY_DATABASE_URL: ${BERRY_API_DATABASE_URL:");
    expect(awsCompose).toContain("BERRY_DATABASE_URL: ${BERRY_WORKER_DATABASE_URL:");
    expect(awsCompose).toContain("BERRY_MEM0_DATABASE_URL: ${BERRY_MEM0_DATABASE_URL:");
    expect(deploymentLauncher).toContain("-f deploy/compose.yaml -f deploy/compose.aws.yaml");
    expect(dockerfile).toContain("https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem");
    expect(dockerfile).toContain("NODE_EXTRA_CA_CERTS=/etc/ssl/certs/aws-rds-global-bundle.pem");
    for (const key of [
      "BERRY_DATABASE_URL",
      "BERRY_API_DATABASE_URL",
      "BERRY_WORKER_DATABASE_URL",
      "BERRY_PLATFORM_DATABASE_URL",
      "BERRY_MEM0_DATABASE_URL",
    ]) {
      expect(productionEnvExample).toContain(`${key}=postgres://`);
    }
    expect(serviceRoleBootstrap).toContain("NOBYPASSRLS");
    expect(serviceRoleBootstrap).toContain("'ALTER ROLE %I LOGIN PASSWORD %L'");
    expect(serviceRoleBootstrap).not.toContain("ALTER ROLE %I LOGIN NOSUPERUSER");
    expect(serviceRoleBootstrap).not.toContain('"BYPASSRLS"');
    expect(productionRunbook).toContain("aws s3api put-bucket-cors");
    expect(productionRunbook).toContain('"AllowedOrigins":["https://ai.example.com"]');
    expect(productionRunbook).toContain('"ExposeHeaders":["ETag"]');
  });

  it("uses direct E2B in production while keeping Docker and Router seams available", () => {
    expect(compose).toContain("BERRY_SANDBOX_PROVIDER: ${BERRY_SANDBOX_PROVIDER:-e2b}");
    expect(compose).toContain("BERRY_SANDBOX_DOCKER_IMAGE_ALLOWLIST:");
    expect(compose).toContain("E2B_API_KEY:");
    expect(compose).toContain("BERRY_E2B_TEMPLATE_ID:");
    expect(compose).toContain("BERRY_E2B_KEEP_MEMORY_ON_PAUSE:");
    expect(compose).toContain("BERRY_E2B_ESTIMATED_HOURLY_COST_MICROS:");
    expect(compose).toContain("BERRY_SANDBOX_CWD: ${BERRY_SANDBOX_CWD:-/workspace}");
    expect(compose).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(envExample).toContain("BERRY_SANDBOX_COMMERCIAL_PROVIDER=");
    for (const key of [
      "E2B_API_KEY",
      "BERRY_E2B_TEMPLATE_ID",
      "BERRY_E2B_DOMAIN",
      "BERRY_E2B_REQUEST_TIMEOUT_MS",
      "BERRY_E2B_KEEP_MEMORY_ON_PAUSE",
      "BERRY_E2B_ESTIMATED_HOURLY_COST_MICROS",
      "BERRY_E2B_MINIMUM_EXEC_COST_MICROS",
    ]) {
      expect(composeApi).toContain(`${key}:`);
      expect(composeWorker).toContain(`${key}:`);
    }
  });

  it("builds the deployable surfaces and documents local-only defaults", () => {
    expect(dockerfile).toContain("corepack pnpm --filter @berry/api... build");
    expect(dockerfile).toContain("corepack pnpm --filter @berry/web... build");
    expect(dockerfile).toContain("corepack pnpm --filter @berry/worker... build");
    expect(dockerfile).toContain("docker.io");
    expect(envExample).toContain("BERRY_AUTH_MODE=better-auth");
    expect(envExample).toContain("BERRY_DEPLOYMENT_PROFILE=local");
    expect(envExample).toContain("BERRY_SETUP_OWNER_EMAIL=founder@local.test");
    expect(envExample).toContain("BERRY_SETUP_TOKEN=");
    expect(compose).toContain("BERRY_SETUP_OWNER_EMAIL:");
    expect(compose).toContain("BERRY_SETUP_TOKEN:");
    expect(deploymentLauncher).toContain('BERRY_AUTH_MODE must be better-auth');
    expect(deploymentLauncher).toContain('[ "$deployment_profile" = "production" ]');
    expect(deploymentLauncher).toContain('[ "$storage_mode" = "minio" ]');
    expect(deploymentLauncher).toContain("The setup key is not printed.");
    expect(deploymentLauncher).not.toContain("#setup=$setup_token");
    expect(productionEnvExample).toContain("BERRY_DEPLOYMENT_PROFILE=production");
    expect(productionEnvExample).toContain("BERRY_AUTH_LOGIN_METHODS=google");
    expect(productionEnvExample).toContain("BERRY_AUTH_GOOGLE_REDIRECT_URI=");
    expect(productionEnvExample).toContain("BERRY_OBJECT_STORAGE_MODE=aws");
    expect(productionEnvExample).not.toContain("BERRY_FILES_DOMAIN=");
    expect(envExample).toContain("DEPLOYMENT_MODE=self-hosted");
    expect(envExample).toContain("BERRY_SCIM_BEARER_TOKEN=");
    expect(envExample).toContain("BERRY_BUDGETS_ENABLED=true");
    expect(envExample).toContain("BERRY_BUDGET_FAIL_CLOSED=true");
    expect(envExample).toContain("BERRY_BILLING_PROVIDER=none");
    expect(envExample).toContain("STRIPE_CREDIT_PRICE_ID=");
    expect(envExample).toContain("BERRY_API_MODEL_MODE=fixture");
    expect(productionRunbook).toContain("E2B session files survive idle timeout and API restart through pause/reconnect");
  });

  it("validates public deployment modes without changing internal tenant enums", () => {
    expect(publicDeploymentModeFromEnv({ DEPLOYMENT_MODE: "managed" })).toBe("managed");
    expect(publicDeploymentModeFromEnv({ DEPLOYMENT_MODE: "dedicated" })).toBe("dedicated");
    expect(publicDeploymentModeFromEnv({ DEPLOYMENT_MODE: "self-hosted" })).toBe("self-hosted");
    expect(tenantDeploymentModeForPublicMode("managed")).toBe("shared");
    expect(tenantDeploymentModeForPublicMode("dedicated")).toBe("dedicated");
    expect(tenantDeploymentModeForPublicMode("self-hosted")).toBe("selfhost");
    expect(deploymentRuntimeDescription({ DEPLOYMENT_MODE: "managed" })).toMatchObject({ mode: "managed", tenantDeploymentMode: "shared", managed: true });
    expect(() => publicDeploymentModeFromEnv({ DEPLOYMENT_MODE: "saas" })).toThrow();
  });

  it("ships Helm chart seams for managed, dedicated, and self-hosted Kubernetes deployments", () => {
    expect(helmValues).toContain("deploymentMode: self-hosted");
    expect(helmValues).toContain("external:");
    expect(helmValues).toContain("existingSecret: berry-postgres");
    expect(helmValues).toContain("existingSecret: berry-redis");
    expect(helmValues).toContain("existingSecret: berry-s3");
    expect(helmValues).toContain("existingSecret: berry-billing");
    expect(helmValues).toContain("provider: none");
    expect(helmValues).toContain("modelIdleTimeoutMs: 240000");
    expect(helmValues).toContain("modelMaxDurationMs: 900000");
    expect(helmConfig).toContain("BERRY_MODEL_IDLE_TIMEOUT_MS: {{ .Values.durableContext.modelIdleTimeoutMs | quote }}");
    expect(helmConfig).toContain("BERRY_MODEL_MAX_DURATION_MS: {{ .Values.durableContext.modelMaxDurationMs | quote }}");
    expect(helmValues).toContain("setupTokenKey: BERRY_SETUP_TOKEN");
    expect(helmApi).toContain("BERRY_SETUP_TOKEN");
    expect(helmApi).toContain("command: [\"node\", \"apps/api/dist/main.js\"]");
    expect(helmApi).toContain("BERRY_DATABASE_URL");
    expect(helmApi).toContain("BERRY_PLATFORM_DATABASE_URL");
    expect(helmApi).toContain("BERRY_REDIS_URL");
    expect(helmApi).toContain("BERRY_POLICY_SIGNING_PRIVATE_KEY_PEM");
    expect(helmApi).toContain("BERRY_USAGE_SIGNING_SECRETS");
    expect(helmApi).toContain("BERRY_ROUTER_API_KEY");
    expect(helmApi).toContain("E2B_API_KEY");
    expect(helmApi).toContain("STRIPE_SECRET_KEY");
    expect(helmApi).toContain("STRIPE_BILLING_METER_EVENT_NAME");
    expect(helmWeb).toContain("command: [\"apps/web/node_modules/.bin/srvx\", \"--prod\", \"-s\", \"../client\", \"apps/web/dist/server/server.js\"]");
    expect(helmWorker).toContain("command: [\"node\", \"apps/worker/dist/main.js\"]");
    expect(helmWorker).toContain("workerSecretKey");
    expect(helmDatabaseBootstrap).toContain("pre-install,pre-upgrade");
    expect(helmDatabaseBootstrap).toContain("node apps/api/dist/migrate.js && node apps/api/dist/configure-service-roles.js");
    expect(helmDatabaseBootstrap).toContain("migrationSecretKey");
    expect(helmDatabaseBootstrap).toContain("BERRY_API_DATABASE_PASSWORD");
    expect(helmDatabaseBootstrap).toContain("BERRY_WORKER_DATABASE_PASSWORD");
    expect(helmDatabaseBootstrap).toContain("BERRY_PLATFORM_DATABASE_PASSWORD");
    expect(helmHpa.match(/kind: HorizontalPodAutoscaler/g)?.length).toBe(3);
    expect(runbook).toContain("--set deploymentMode=dedicated");
    expect(runbook).toContain("kubectl -n berry-acme create secret generic berry-billing");
    expect(runbook).toContain("kubectl -n berry-acme create secret generic berry-postgres");
    expect(runbook).toContain("kubectl -n berry-acme create secret generic berry-e2b");
  });
});
