import type { BerryApiClient } from "@berry/api-client";
import type { WebConfig } from "./config";

/** Property probes from runtimes and test tools that must not look like API methods. */
const NON_METHOD_PROPERTIES = new Set(["then", "catch", "finally", "constructor", "toJSON", "toString", "valueOf", "inspect", "nodeType", "asymmetricMatch"]);

/** True for names that can be a client method; `then`, symbols and framework probes are not. */
export function isDemoClientMethodName(property: string | symbol): property is string {
  return typeof property === "string" && /^[a-z][A-Za-z0-9]*$/.test(property) && !NON_METHOD_PROPERTIES.has(property);
}

/**
 * Stand-in for the demo management client that keeps its generated data out
 * of the main bundle. The data module loads on the first method call; every
 * client method is async, so callers cannot observe the extra step.
 */
export function createLazyDemoManagementClient(config: WebConfig, tenantId: string): BerryApiClient {
  let loading: Promise<BerryApiClient> | null = null;
  const load = () => {
    loading ??= import("./demo-management-client").then((module) => module.createDemoManagementClient(config, tenantId));
    // A failed chunk load must not poison every later call.
    loading.catch(() => { loading = null; });
    return loading;
  };
  const methods = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return new Proxy({}, {
    get(_target, property) {
      if (!isDemoClientMethodName(property)) return undefined;
      let method = methods.get(property);
      if (!method) {
        method = async (...args: unknown[]) => {
          const client = await load() as unknown as Record<string, ((...input: unknown[]) => unknown) | undefined>;
          return client[property]?.(...args);
        };
        methods.set(property, method);
      }
      return method;
    },
  }) as unknown as BerryApiClient;
}
