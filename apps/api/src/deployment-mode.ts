import { z } from "zod";
import type { DeploymentMode } from "@berry/shared";

export const PublicDeploymentModeSchema = z.enum(["managed", "dedicated", "self-hosted"]);
export type PublicDeploymentMode = z.infer<typeof PublicDeploymentModeSchema>;

const DEFAULT_PUBLIC_DEPLOYMENT_MODE: PublicDeploymentMode = "self-hosted";

export function publicDeploymentModeFromEnv(env: NodeJS.ProcessEnv = process.env): PublicDeploymentMode {
  const raw = (env.DEPLOYMENT_MODE ?? env.BERRY_DEPLOYMENT_MODE ?? DEFAULT_PUBLIC_DEPLOYMENT_MODE).trim();
  return PublicDeploymentModeSchema.parse(raw);
}

export function tenantDeploymentModeForPublicMode(mode: PublicDeploymentMode): DeploymentMode {
  if (mode === "managed") return "shared";
  if (mode === "dedicated") return "dedicated";
  return "selfhost";
}

export function deploymentRuntimeDescription(env: NodeJS.ProcessEnv = process.env) {
  const mode = publicDeploymentModeFromEnv(env);
  return {
    mode,
    tenantDeploymentMode: tenantDeploymentModeForPublicMode(mode),
    managed: mode === "managed",
    dedicated: mode === "dedicated",
    selfHosted: mode === "self-hosted",
  };
}
