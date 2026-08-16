import * as React from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { DEFAULT_DEPLOYMENT_BRAND, DeploymentBrandContext, DeploymentBrandLogo, resolveDeploymentBrandAssetUrl, useDeploymentBrand, type DeploymentBrand } from "./deployment-brand.tsx";

const GoogleSsoButton = React.lazy(() => import("./google-sso-button.tsx"));
const DeploymentOnboarding = React.lazy(() => import("../onboarding/deployment-onboarding.tsx").then((module) => ({ default: module.DeploymentOnboarding })));

export type SignedInUser = { id: string; email: string; name?: string | null; image?: string | null };
export type AuthState = "authenticated" | "unauthenticated" | "unavailable" | "loading";
export type AuthProbeResult = { state: Exclude<AuthState, "loading">; user: SignedInUser | null };

export const AUTH_SESSION_TIMEOUT_MS = 5_000;
export const AUTH_SESSION_RETRY_DELAYS_MS = [0, 250, 1_000] as const;

export function authDestination(input: {
  authenticated: boolean;
  loading: boolean;
  unavailable?: boolean;
  pathname: string;
}): "/" | "/login" | null {
  if (input.loading || input.unavailable) return null;
  if (!input.authenticated) return input.pathname === "/login" ? null : "/login";
  return input.pathname === "/login" ? "/" : null;
}

export async function probeAuthSession(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AuthProbeResult> {
  let lastError: unknown = null;
  for (const [attempt, delayMs] of AUTH_SESSION_RETRY_DELAYS_MS.entries()) {
    if (delayMs > 0) await abortableDelay(delayMs, signal);
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", relayAbort, { once: true });
    const timeout = globalThis.setTimeout(() => controller.abort(new DOMException("Authentication request timed out", "TimeoutError")), AUTH_SESSION_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${baseUrl}/v1/auth/get-session`, { credentials: "include", signal: controller.signal });
      if (response.status === 401 || response.status === 403) return { state: "unauthenticated", user: null };
      if (!response.ok) {
        lastError = new Error(`Authentication request failed with ${response.status}`);
        if (attempt === AUTH_SESSION_RETRY_DELAYS_MS.length - 1) return { state: "unavailable", user: null };
        continue;
      }
      const data = await response.json() as { user?: SignedInUser | null } | null;
      const user = data?.user;
      if (!user || typeof user.id !== "string" || typeof user.email !== "string") return { state: "unauthenticated", user: null };
      return { state: "authenticated", user };
    } catch (cause) {
      if (signal?.aborted) throw cause;
      lastError = cause;
      if (attempt === AUTH_SESSION_RETRY_DELAYS_MS.length - 1) return { state: "unavailable", user: null };
    } finally {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", relayAbort);
    }
  }
  void lastError;
  return { state: "unavailable", user: null };
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function applyDeploymentFavicon(url: string | null): void {
  const existing = document.head.querySelector<HTMLLinkElement>('link[data-berry-organization-favicon="true"]');
  existing?.remove();
  if (!url) {
    return;
  }
  const link = document.createElement("link");
  link.rel = "icon";
  link.href = url;
  const expectedUrl = link.href;
  link.dataset.berryOrganizationFavicon = "true";
  link.onerror = () => {
    if (link.href === expectedUrl) link.remove();
  };
  document.head.append(link);
}

export function AuthBoundary({ baseUrl, initialUser, sessionResolved, children }: {
  baseUrl: string;
  initialUser: SignedInUser | null;
  sessionResolved: boolean;
  children: (user: SignedInUser, onSignedOut: () => void) => React.ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [user, setUser] = React.useState<SignedInUser | null>(initialUser);
  const [authState, setAuthState] = React.useState<AuthState>(() => sessionResolved ? (initialUser ? "authenticated" : "unauthenticated") : "loading");
  const sessionAbortRef = React.useRef<AbortController | null>(null);
  const [brand, setBrand] = React.useState<DeploymentBrand>(DEFAULT_DEPLOYMENT_BRAND);
  const [brandRevision, setBrandRevision] = React.useState(0);

  React.useEffect(() => {
    const refreshBrand = () => setBrandRevision((revision) => revision + 1);
    window.addEventListener("berry:deployment-brand-changed", refreshBrand);
    return () => window.removeEventListener("berry:deployment-brand-changed", refreshBrand);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void fetch(`${baseUrl}/v1/setup`, { credentials: "include" })
      .then(async (response) => response.ok ? response.json() as Promise<{ applicationName?: string; organization?: { logoUrl?: string | null; faviconUrl?: string | null; accentColor?: string | null } }> : null)
      .then(async (value) => {
        if (cancelled || !value) return;
        const next = {
          applicationName: value.applicationName?.trim() || "Berry",
          logoUrl: resolveDeploymentBrandAssetUrl(baseUrl, value.organization?.logoUrl),
          faviconUrl: resolveDeploymentBrandAssetUrl(baseUrl, value.organization?.faviconUrl),
          accentColor: value.organization?.accentColor ?? null,
        };
        setBrand(next);
        document.title = next.applicationName;
        applyDeploymentFavicon(next.faviconUrl);
        const { deploymentAccentTokens } = await import("./deployment-accent.ts");
        if (cancelled) return;
        const accent = deploymentAccentTokens(next.accentColor);
        document.documentElement.style.removeProperty("--berry-accent");
        if (accent) {
          document.documentElement.style.setProperty("--berry-brand-accent-light", accent.light);
          document.documentElement.style.setProperty("--berry-brand-accent-dark", accent.dark);
        } else {
          document.documentElement.style.removeProperty("--berry-brand-accent-light");
          document.documentElement.style.removeProperty("--berry-brand-accent-dark");
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [baseUrl, brandRevision]);

  const refreshSession = React.useCallback(async () => {
    sessionAbortRef.current?.abort();
    const controller = new AbortController();
    sessionAbortRef.current = controller;
    setAuthState("loading");
    try {
      const result = await probeAuthSession(baseUrl, fetch, controller.signal);
      if (controller.signal.aborted) return;
      if (result.state === "authenticated") {
        setUser(result.user);
        setAuthState("authenticated");
      } else if (result.state === "unauthenticated") {
        setUser(null);
        setAuthState("unauthenticated");
      } else {
        // Keep a previously known identity while the auth service is down.
        setAuthState("unavailable");
      }
    } catch {
      if (!controller.signal.aborted) setAuthState("unavailable");
    } finally {
      if (sessionAbortRef.current === controller) sessionAbortRef.current = null;
    }
  }, [baseUrl]);

  React.useEffect(() => () => sessionAbortRef.current?.abort(), []);

  React.useEffect(() => {
    if (sessionResolved) return;
    void refreshSession();
  }, [refreshSession, sessionResolved]);

  const destination = authDestination({
    authenticated: Boolean(user),
    loading: authState === "loading",
    unavailable: authState === "unavailable",
    pathname: location.pathname,
  });
  React.useEffect(() => {
    if (!destination) return;
    void navigate({ to: destination, replace: true });
  }, [destination, navigate]);

  const signedOut = React.useCallback(() => {
    setUser(null);
    setAuthState("unauthenticated");
    void navigate({ to: "/login", replace: true });
  }, [navigate]);

  let content: React.ReactNode;
  if (authState === "loading") content = <div className="auth-shell" role="status" aria-live="polite" aria-busy="true"><CircularActivitySpinner size={28} label="Loading workspace" /></div>;
  else if (authState === "unavailable") content = <AuthUnavailable onRetry={refreshSession} knownUser={Boolean(user)} />;
  else if (!user) content = <AuthScreen baseUrl={baseUrl} onAuthenticated={refreshSession} />;
  else content = children(user, signedOut);
  return <DeploymentBrandContext.Provider value={brand}>{content}</DeploymentBrandContext.Provider>;
}

function AuthUnavailable({ onRetry, knownUser }: { onRetry: () => Promise<void>; knownUser: boolean }) {
  return (
    <div className="auth-shell">
      <div className="auth-card" role="alert">
        <AuthBrand />
        <h1>{knownUser ? "Berry could not verify your session" : "Authentication service unavailable"}</h1>
        <p>Your identity has not been cleared. Check the API connection and try again.</p>
        <button className="primary-button" type="button" onClick={() => void onRetry()}>Retry</button>
      </div>
    </div>
  );
}

function AuthScreen({ baseUrl, onAuthenticated }: { baseUrl: string; onAuthenticated: () => Promise<void> }) {
  const location = useLocation();
  const [creating, setCreating] = React.useState(false);
  const [config, setConfig] = React.useState<AuthConfig | null>(null);
  const [configLoading, setConfigLoading] = React.useState(true);
  const [configError, setConfigError] = React.useState("");
  const [configAttempt, setConfigAttempt] = React.useState(0);
  const [setupToken, setSetupToken] = React.useState(() => setupTokenFromLocation());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(() => oauthErrorMessage(location.search));

  React.useEffect(() => {
    clearSetupTokenFromLocation();
  }, []);

  React.useEffect(() => {
    if (!oauthErrorMessage(location.search)) return;
    clearOauthErrorFromLocation();
  }, [location.search]);

  React.useEffect(() => {
    let cancelled = false;
    setConfigLoading(true);
    setConfigError("");
    void fetchWithTimeout(`${baseUrl}/v1/auth/config`, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Berry could not load the deployment authentication policy.");
        return response.json() as Promise<AuthConfig>;
      })
      .then((nextConfig) => { if (!cancelled) setConfig(nextConfig); })
      .catch(() => { if (!cancelled) setConfigError("Berry could not reach the authentication service. Check the API, then try again."); })
      .finally(() => { if (!cancelled) setConfigLoading(false); });
    return () => { cancelled = true; };
  }, [baseUrl, configAttempt]);

  const setup = config?.setup;
  const settingUp = setup?.required === true;
  const googleSso = config?.ssoProviders?.[0];
  const passwordEnabled = config?.emailPassword?.enabled === true;

  const submit = React.useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim();
    try {
      if (settingUp) {
        await postJson(`${baseUrl}/v1/auth/setup`, {
          organizationName: String(form.get("organizationName") ?? "").trim(),
          name,
          email,
          password,
          setupToken: String(form.get("setupToken") ?? ""),
        }, "Unable to finish setup");
        clearSetupTokenFromLocation();
      } else if (creating) {
        await postJson(`${baseUrl}/v1/auth/sign-up/email`, { name, email, password }, "Unable to create the account");
      }
      if (settingUp || !creating) {
        await postJson(`${baseUrl}/v1/auth/sign-in/email`, { email, password, rememberMe: true }, "Unable to sign in");
      }
      await onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }, [baseUrl, creating, onAuthenticated, settingUp]);

  if (!configLoading && settingUp && config?.loginMode === "google") {
    return <React.Suspense fallback={<div className="auth-shell" role="status"><CircularActivitySpinner size={28} label="Loading deployment setup" /></div>}><DeploymentOnboarding baseUrl={baseUrl} initialToken={setupToken} /></React.Suspense>;
  }

  if (!configLoading && configError) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <AuthBrand />
          <div className="auth-setup-notice" role="alert">
            <strong>Authentication service unavailable</strong>
            <p>{configError}</p>
          </div>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="primary-button" type="button" onClick={() => setConfigAttempt((attempt) => attempt + 1)}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        <AuthBrand />
        {configLoading ? <div className="flex min-h-24 items-center justify-center" role="status" aria-live="polite" aria-busy="true"><CircularActivitySpinner size={28} label="Loading deployment configuration" /></div> : settingUp ? (
          <>
            <div className="auth-setup-intro">
              <h1>Set up your organization</h1>
              <p>Create the first owner account.<br />This setup closes automatically when you finish.</p>
            </div>
            {setup.available ? (
              <>
                <label>Organization name<input name="organizationName" autoComplete="organization" required maxLength={100} defaultValue="My Organization" /></label>
                <label>Your name<input name="name" autoComplete="name" required maxLength={80} /></label>
                <label>Owner email<input name="email" type="email" autoComplete="email" required readOnly={Boolean(setup.ownerEmail)} defaultValue={setup.ownerEmail ?? ""} /></label>
                <label>Password<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>
                <label>Setup key<input name="setupToken" type="password" autoComplete="off" minLength={32} maxLength={512} required value={setupToken} onChange={(event) => setSetupToken(event.target.value)} /></label>
                {error ? <p className="form-error" role="alert">{error}</p> : null}
                <button className="primary-button" type="submit" disabled={busy}>{busy ? "Setting up…" : "Create owner account"}</button>
              </>
            ) : (
              <div className="auth-setup-notice" role="alert">
                <strong>First-run setup is not configured.</strong>
                <p>Add {setup.missingConfiguration.join(" and ")} to the API environment, then restart Berry.</p>
              </div>
            )}
          </>
        ) : (
          <>
            <div><h1>{creating ? "Create your account" : "Welcome back"}</h1><p>{creating ? "Join this private Berry deployment." : googleSso && !passwordEnabled ? `Sign in with your ${googleSso.domain} Google account.` : "Sign in to Berry."}</p></div>
            {passwordEnabled && creating ? <label>Name<input name="name" autoComplete="name" required maxLength={80} /></label> : null}
            {passwordEnabled ? <label>Email<input name="email" type="email" autoComplete="email" required /></label> : null}
            {passwordEnabled ? <label>Password<input name="password" type="password" autoComplete={creating ? "new-password" : "current-password"} minLength={8} maxLength={128} required /></label> : null}
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            {passwordEnabled ? <button className="primary-button" type="submit" disabled={busy}>{busy ? "Please wait…" : creating ? "Create account" : "Sign in"}</button> : null}
            {!creating && googleSso ? (
              <React.Suspense fallback={null}>
                <GoogleSsoButton standalone={!passwordEnabled} baseUrl={baseUrl} domain={googleSso.domain} busy={busy} setBusy={setBusy} setError={setError} />
              </React.Suspense>
            ) : null}
          </>
        )}
        {!configLoading && !settingUp && passwordEnabled && (config?.signupEnabled || creating) ? (
          <button className="text-button" type="button" onClick={() => { setCreating((value) => !value); setError(""); }}>
            {creating ? "Already have an account? Sign in" : "Need an account? Create one"}
          </button>
        ) : null}
      </form>
    </div>
  );
}

function AuthBrand() {
  const brand = useDeploymentBrand();
  return (
    <div className="brand-mark">
      <DeploymentBrandLogo className="auth-brand-logo" alt="" />
      <span>{brand.applicationName}</span>
    </div>
  );
}

type AuthConfig = {
  loginMode?: "password" | "google" | "mixed";
  emailPassword?: { enabled: boolean };
  signupEnabled?: boolean;
  ssoProviders?: Array<{
    id: "google";
    name: string;
    domain: string;
  }>;
  setup?: {
    required: boolean;
    available: boolean;
    ownerEmail: string | null;
    missingConfiguration: string[];
  };
};

export function oauthErrorMessage(search: unknown): string {
  if (!search || typeof search !== "object" || Array.isArray(search)) return "";
  const code = typeof (search as { error?: unknown }).error === "string"
    ? (search as { error: string }).error.trim().toLowerCase()
    : "";
  if (!code) return "";
  const messages: Record<string, string> = {
    access_denied: "Google sign-in was cancelled.",
    invalid_code: "Google sign-in expired or was already used. Please try again.",
    oauth_provider_not_found: "Google sign-in is not configured for this deployment.",
    unable_to_get_user_info: "Google did not return the account details Berry needs.",
    no_code: "Google sign-in did not return an authorization code. Please try again.",
    organization_membership_inactive: "Your organization access is disabled. Contact the Berry owner.",
  };
  return messages[code] ?? "Google sign-in could not be completed. Please try again or contact the Berry owner.";
}

async function postJson(url: string, body: unknown, fallbackMessage: string): Promise<void> {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null) as { message?: string | string[] } | null;
  if (!response.ok) {
    const message = Array.isArray(result?.message) ? result.message.join(" ") : result?.message;
    throw new Error(message ?? fallbackMessage);
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = AUTH_SESSION_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const relayAbort = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener("abort", relayAbort, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(new DOMException("Authentication request timed out", "TimeoutError")), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeout);
    init.signal?.removeEventListener("abort", relayAbort);
  }
}

function setupTokenFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("setup") ?? "";
}

function clearSetupTokenFromLocation(): void {
  if (typeof window === "undefined" || !window.location.hash.includes("setup=")) return;
  window.history.replaceState(null, "", sanitizedAuthUrl(window.location.href));
}

function clearOauthErrorFromLocation(): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(null, "", sanitizedAuthUrl(window.location.href));
}

export function sanitizedAuthUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  if (new URLSearchParams(url.hash.replace(/^#/, "")).has("setup")) url.hash = "";
  return `${url.pathname}${url.search}${url.hash}`;
}
