import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { routeTree } from "./routeTree.gen";
import { serverCspNonce } from "./router-csp.server";

const getServerCspNonce = createIsomorphicFn()
  .client(() => undefined)
  .server(serverCspNonce);

export function getRouter() {
  const nonce = typeof window === "undefined" ? getServerCspNonce() : undefined;
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    ...(nonce ? { ssr: { nonce } } : {}),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
