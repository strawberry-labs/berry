import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestHost } from "@tanstack/react-start/server";
import { getWebConfig } from "./env.server";

export const loadWebConfig = createServerFn({ method: "GET" }).handler(() => getWebConfig());

export const loadWebBootstrap = createServerFn({ method: "GET" }).handler(async () => {
  const config = getWebConfig();
  if (config.demoMode || !config.apiBaseUrl) {
    return { config, user: null, sessionResolved: true };
  }

  const requestHeaders = getRequestHeaders();
  const cookie = requestHeaders.get("cookie");
  const userAgent = requestHeaders.get("user-agent");
  const publicApiHost = new URL(config.apiBaseUrl).host;
  const requestHost = getRequestHost({ xForwardedHost: true });
  if (!cookie && publicApiHost !== requestHost) {
    // A cookie scoped to a separate public API host is not available to the
    // web SSR request. Preserve the client-side session check for that setup.
    return { config, user: null, sessionResolved: false };
  }
  const apiBaseUrl = process.env.BERRY_WEB_API_INTERNAL_URL?.replace(/\/+$/, "") || config.apiBaseUrl;

  try {
    const response = await fetch(`${apiBaseUrl}/v1/auth/get-session`, {
      cache: "no-store",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(userAgent ? { "user-agent": userAgent } : {}),
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { config, user: null, sessionResolved: false };
    const session = await response.json() as {
      user?: { id?: unknown; email?: unknown; name?: unknown } | null;
    } | null;
    const user = session?.user;
    if (!user || typeof user.id !== "string" || typeof user.email !== "string") {
      return { config, user: null, sessionResolved: true };
    }
    return {
      config,
      user: {
        id: user.id,
        email: user.email,
        name: typeof user.name === "string" ? user.name : null,
      },
      sessionResolved: true,
    };
  } catch {
    return { config, user: null, sessionResolved: false };
  }
});
