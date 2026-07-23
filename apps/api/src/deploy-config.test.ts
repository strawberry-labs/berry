import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deploymentRuntimeDescription, publicDeploymentModeFromEnv, tenantDeploymentModeForPublicMode } from "./deployment-mode.ts";

const root = resolve(import.meta.dirname, "../../..");
const compose = readFileSync(resolve(root, "deploy/compose.yaml"), "utf8");
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const envExample = readFileSync(resolve(root, "deploy/.env.example"), "utf8");
const helmValues = readFileSync(resolve(root, "deploy/helm/berry-platform/values.yaml"), "utf8");
const helmApi = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/api-deployment.yaml"), "utf8");
const helmWeb = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/web-deployment.yaml"), "utf8");
const helmWorker = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/worker-deployment.yaml"), "utf8");
const helmHpa = readFileSync(resolve(root, "deploy/helm/berry-platform/templates/hpa.yaml"), "utf8");
const runbook = readFileSync(resolve(root, "deploy/dedicated-instance-runbook.md"), "utf8");
const productionRunbook = readFileSync(resolve(root, "deploy/PRODUCTION.md"), "utf8");
const deploymentLauncher = readFileSync(resolve(root, "deploy/up.sh"), "utf8");
const caddyfile = readFileSync(resolve(root, "deploy/Caddyfile"), "utf8");

describe("self-host compose deployment", () => {
  it("runs api, web, and worker from one built image with Postgres, Redis, and MinIO", () => {
    for (const service of ["caddy", "postgres", "redis", "minio", "minio-init", "api", "worker", "web"]) {
      expect(compose).toContain(`  ${service}:`);
    }
    expect(compose).toContain('command: ["node", "apps/api/dist/main.js"]');
    expect(compose).toContain('command: ["apps/web/node_modules/.bin/srvx", "--prod", "-s", "../client", "apps/web/dist/server/server.js"]');
    expect(compose).toContain('command: ["node", "apps/worker/dist/main.js"]');
    expect(compose).toContain("BERRY_DATABASE_URL:");
    expect(compose).toContain("BERRY_REDIS_URL:");
    expect(compose).toContain("DEPLOYMENT_MODE:");
    expect(compose).toContain("BERRY_BUDGETS_ENABLED:");
    expect(compose).toContain("BERRY_BUDGET_FAIL_CLOSED:");
    expect(compose).toContain("BERRY_BILLING_PROVIDER:");
    expect(compose).toContain("STRIPE_BILLING_METER_EVENT_NAME:");
    expect(compose).toContain("BERRY_ARTIFACT_S3_ENDPOINT: ${BERRY_ARTIFACT_S3_ENDPOINT:-http://minio:9000}");
    expect(compose).toContain("mc mb --ignore-existing");
    expect(compose).toContain('127.0.0.1:${BERRY_API_PORT:-3001}:3000');
    expect(caddyfile).toContain("reverse_proxy @api api:3000");
    expect(caddyfile).toContain("reverse_proxy web:3108");
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
  });

  it("builds the deployable surfaces and documents local-only defaults", () => {
    expect(dockerfile).toContain("corepack pnpm --filter @berry/api... build");
    expect(dockerfile).toContain("corepack pnpm --filter @berry/web... build");
    expect(dockerfile).toContain("corepack pnpm --filter @berry/worker... build");
    expect(dockerfile).toContain("docker.io");
    expect(envExample).toContain("BERRY_AUTH_MODE=better-auth");
    expect(envExample).toContain("BERRY_SETUP_OWNER_EMAIL=founder@local.test");
    expect(envExample).toContain("BERRY_SETUP_TOKEN=");
    expect(compose).toContain("BERRY_SETUP_OWNER_EMAIL:");
    expect(compose).toContain("BERRY_SETUP_TOKEN:");
    expect(deploymentLauncher).toContain('BERRY_AUTH_MODE must be better-auth');
    expect(deploymentLauncher).toContain("One-time setup URL:");
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
    expect(helmValues).toContain("setupTokenKey: BERRY_SETUP_TOKEN");
    expect(helmApi).toContain("BERRY_SETUP_TOKEN");
    expect(helmApi).toContain("command: [\"node\", \"apps/api/dist/main.js\"]");
    expect(helmApi).toContain("BERRY_DATABASE_URL");
    expect(helmApi).toContain("BERRY_REDIS_URL");
    expect(helmApi).toContain("BERRY_POLICY_SIGNING_PRIVATE_KEY_PEM");
    expect(helmApi).toContain("BERRY_USAGE_SIGNING_SECRETS");
    expect(helmApi).toContain("BERRY_ROUTER_API_KEY");
    expect(helmApi).toContain("E2B_API_KEY");
    expect(helmApi).toContain("STRIPE_SECRET_KEY");
    expect(helmApi).toContain("STRIPE_BILLING_METER_EVENT_NAME");
    expect(helmWeb).toContain("command: [\"apps/web/node_modules/.bin/srvx\", \"--prod\", \"-s\", \"../client\", \"apps/web/dist/server/server.js\"]");
    expect(helmWorker).toContain("command: [\"node\", \"apps/worker/dist/main.js\"]");
    expect(helmHpa.match(/kind: HorizontalPodAutoscaler/g)?.length).toBe(3);
    expect(runbook).toContain("--set deploymentMode=dedicated");
    expect(runbook).toContain("kubectl -n berry-acme create secret generic berry-billing");
    expect(runbook).toContain("kubectl -n berry-acme create secret generic berry-postgres");
    expect(runbook).toContain("kubectl -n berry-acme create secret generic berry-e2b");
  });
});
