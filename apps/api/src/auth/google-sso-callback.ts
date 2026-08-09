const AUTH_BASE_PATH = "/v1/auth";
const DEFAULT_GOOGLE_CALLBACK_PATH = `${AUTH_BASE_PATH}/callback/google`;

export type GoogleSsoCallbackEnv = Record<string, string | undefined>;

export function resolveGoogleSsoRedirectUri(env: GoogleSsoCallbackEnv = process.env): string {
  const baseUrl = parseUrl(env.BERRY_AUTH_BASE_URL?.trim() || "http://localhost:3000", "BERRY_AUTH_BASE_URL");
  const configured = env.BERRY_AUTH_GOOGLE_REDIRECT_URI?.trim();
  const redirect = configured
    ? parseUrl(configured, "BERRY_AUTH_GOOGLE_REDIRECT_URI")
    : new URL(DEFAULT_GOOGLE_CALLBACK_PATH, baseUrl);

  if (redirect.origin !== baseUrl.origin) {
    throw new Error("BERRY_AUTH_GOOGLE_REDIRECT_URI must use the same origin as BERRY_AUTH_BASE_URL");
  }
  if (!redirect.pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
    throw new Error(`BERRY_AUTH_GOOGLE_REDIRECT_URI must use a path under ${AUTH_BASE_PATH}/`);
  }
  if (redirect.search || redirect.hash) {
    throw new Error("BERRY_AUTH_GOOGLE_REDIRECT_URI must not contain a query string or fragment");
  }
  if (configured && env.NODE_ENV === "production" && redirect.protocol !== "https:") {
    throw new Error("BERRY_AUTH_GOOGLE_REDIRECT_URI must use HTTPS in production");
  }

  return redirect.toString();
}

export function googleSsoCallbackPath(env: GoogleSsoCallbackEnv = process.env): string {
  return new URL(resolveGoogleSsoRedirectUri(env)).pathname;
}

export function normalizeGoogleSsoCallbackRequestUrl(
  requestUrl: string | undefined,
  callbackPath: string,
): string {
  const url = new URL(requestUrl ?? "/", "http://berry.local");
  if (url.pathname === callbackPath && callbackPath !== DEFAULT_GOOGLE_CALLBACK_PATH) {
    url.pathname = DEFAULT_GOOGLE_CALLBACK_PATH;
  }
  return `${url.pathname}${url.search}`;
}

function parseUrl(value: string, key: string): URL {
  try {
    const url = new URL(value);
    if (url.username || url.password) throw new Error("credentials are not allowed");
    return url;
  } catch {
    throw new Error(`${key} must be a valid absolute URL`);
  }
}
