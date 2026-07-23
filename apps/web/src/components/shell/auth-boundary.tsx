import * as React from "react";
import { BerryLogo } from "@berry/desktop-ui/components/berry-logo";

export type SignedInUser = { id: string; email: string; name?: string | null };

export function AuthBoundary({ baseUrl, initialUser, sessionResolved, children }: {
  baseUrl: string;
  initialUser: SignedInUser | null;
  sessionResolved: boolean;
  children: (user: SignedInUser, onSignedOut: () => void) => React.ReactNode;
}) {
  const [user, setUser] = React.useState<SignedInUser | null>(initialUser);
  const [loading, setLoading] = React.useState(!sessionResolved);

  const refreshSession = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${baseUrl}/v1/auth/get-session`, { credentials: "include" });
      if (!response.ok) {
        setUser(null);
        return;
      }
      const data = await response.json() as { user?: SignedInUser | null } | null;
      setUser(data?.user ?? null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  React.useEffect(() => {
    if (sessionResolved) return;
    void refreshSession();
  }, [refreshSession, sessionResolved]);

  if (loading) {
    return <div className="auth-shell"><div className="auth-card"><AuthBrand /><p>Loading your workspace…</p></div></div>;
  }
  if (!user) return <AuthScreen baseUrl={baseUrl} onAuthenticated={refreshSession} />;
  return children(user, () => setUser(null));
}

function AuthScreen({ baseUrl, onAuthenticated }: { baseUrl: string; onAuthenticated: () => Promise<void> }) {
  const [creating, setCreating] = React.useState(false);
  const [config, setConfig] = React.useState<AuthConfig | null>(null);
  const [configLoading, setConfigLoading] = React.useState(true);
  const [setupToken, setSetupToken] = React.useState(() => setupTokenFromLocation());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    void fetch(`${baseUrl}/v1/auth/config`)
      .then(async (response) => response.ok ? response.json() as Promise<AuthConfig> : null)
      .then((nextConfig) => { if (!cancelled) setConfig(nextConfig); })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setConfigLoading(false); });
    return () => { cancelled = true; };
  }, [baseUrl]);

  const setup = config?.setup;
  const settingUp = setup?.required === true;

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

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        <AuthBrand />
        {configLoading ? <div><h1>Checking this deployment…</h1><p>Berry is reading its first-run state.</p></div> : settingUp ? (
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
            <div><h1>{creating ? "Create your account" : "Welcome back"}</h1><p>{creating ? "Join this private Berry deployment." : "Sign in to your projects and tasks."}</p></div>
            {creating ? <label>Name<input name="name" autoComplete="name" required maxLength={80} /></label> : null}
            <label>Email<input name="email" type="email" autoComplete="email" required /></label>
            <label>Password<input name="password" type="password" autoComplete={creating ? "new-password" : "current-password"} minLength={8} maxLength={128} required /></label>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "Please wait…" : creating ? "Create account" : "Sign in"}</button>
          </>
        )}
        {!configLoading && !settingUp && (config?.signupEnabled || creating) ? (
          <button className="text-button" type="button" onClick={() => { setCreating((value) => !value); setError(""); }}>
            {creating ? "Already have an account? Sign in" : "Need an account? Create one"}
          </button>
        ) : null}
      </form>
    </div>
  );
}

function AuthBrand() {
  return (
    <div className="brand-mark">
      <BerryLogo className="auth-brand-logo" alt="" />
      <span>Berry</span>
    </div>
  );
}

type AuthConfig = {
  signupEnabled?: boolean;
  setup?: {
    required: boolean;
    available: boolean;
    ownerEmail: string | null;
    missingConfiguration: string[];
  };
};

async function postJson(url: string, body: unknown, fallbackMessage: string): Promise<void> {
  const response = await fetch(url, {
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

function setupTokenFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("setup") ?? "";
}

function clearSetupTokenFromLocation(): void {
  if (typeof window === "undefined" || !window.location.hash.includes("setup=")) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}
