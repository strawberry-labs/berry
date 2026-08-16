import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestHost, getResponseHeader, removeResponseHeader, setResponseHeader } from "@tanstack/react-start/server";
import { getWebConfig } from "./env.server";
import { buildSiteContentSecurityPolicy, CSP_NONCE_RESPONSE_HEADER } from "./site-csp";

export const loadWebConfig = createServerFn({ method: "GET" }).handler(() => getWebConfig());

export const loadWebBootstrap = createServerFn({ method: "GET" }).handler(async () => {
  // The loader can serialize the signed-in user into SSR HTML. Never let a
  // proxy or browser cache replay that document to another request.
  setResponseHeader("Cache-Control", "private, no-store, max-age=0");
  setResponseHeader("Vary", "Cookie, Authorization");
  const config = getWebConfig();
  const nonce = getResponseHeader(CSP_NONCE_RESPONSE_HEADER);
  if (nonce) {
    const apiOrigin = config.apiBaseUrl ? new URL(config.apiBaseUrl).origin : null;
    const extraConnect = splitCspSources(process.env.BERRY_CSP_EXTRA_CONNECT_SOURCES);
    const extraImages = splitCspSources(process.env.BERRY_CSP_EXTRA_IMAGE_SOURCES);
    const extraFrames = splitCspSources(process.env.BERRY_CSP_EXTRA_FRAME_SOURCES);
    setResponseHeader("Content-Security-Policy", buildSiteContentSecurityPolicy({
      nonce,
      connectOrigins: [apiOrigin, ...extraConnect].filter((value): value is string => Boolean(value)),
      imageOrigins: [apiOrigin, ...extraImages].filter((value): value is string => Boolean(value)),
      ...(extraFrames.length > 0 ? { frameSources: extraFrames } : {}),
    }));
    removeResponseHeader(CSP_NONCE_RESPONSE_HEADER);
  }
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
      user?: { id?: unknown; email?: unknown; name?: unknown; image?: unknown } | null;
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
        image: typeof user.image === "string" ? user.image : null,
      },
      sessionResolved: true,
    };
  } catch {
    return { config, user: null, sessionResolved: false };
  }
});

function splitCspSources(value: string | undefined): string[] {
  return value?.split(/\s+/).map((source) => source.trim()).filter(Boolean) ?? [];
}
