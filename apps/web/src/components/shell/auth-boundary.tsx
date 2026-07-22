import * as React from "react";

export type SignedInUser = { id: string; email: string; name?: string | null };

export function AuthBoundary({ baseUrl, children }: {
  baseUrl: string;
  children: (user: SignedInUser, onSignedOut: () => void) => React.ReactNode;
}) {
  const [user, setUser] = React.useState<SignedInUser | null>(null);
  const [loading, setLoading] = React.useState(true);

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
    void refreshSession();
  }, [refreshSession]);

  if (loading) {
    return <div className="auth-shell"><div className="auth-card"><div className="brand-mark">Berry</div><p>Loading your workspace…</p></div></div>;
  }
  if (!user) return <AuthScreen baseUrl={baseUrl} onAuthenticated={refreshSession} />;
  return children(user, () => setUser(null));
}

function AuthScreen({ baseUrl, onAuthenticated }: { baseUrl: string; onAuthenticated: () => Promise<void> }) {
  const [creating, setCreating] = React.useState(false);
  const [signupEnabled, setSignupEnabled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    void fetch(`${baseUrl}/v1/auth/config`)
      .then(async (response) => response.ok ? response.json() as Promise<{ signupEnabled?: boolean }> : null)
      .then((config) => { if (!cancelled) setSignupEnabled(config?.signupEnabled === true); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [baseUrl]);

  const submit = React.useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const body = creating
      ? { name: String(form.get("name") ?? "").trim(), email, password }
      : { email, password, rememberMe: true };
    try {
      const response = await fetch(`${baseUrl}/v1/auth/${creating ? "sign-up" : "sign-in"}/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) throw new Error(result?.message ?? `Unable to ${creating ? "create the account" : "sign in"}`);
      await onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }, [baseUrl, creating, onAuthenticated]);

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        <div className="brand-mark">Berry</div>
        <div><h1>{creating ? "Create your account" : "Welcome back"}</h1><p>{creating ? "Join this private Berry deployment." : "Sign in to your projects and tasks."}</p></div>
        {creating ? <label>Name<input name="name" autoComplete="name" required maxLength={80} /></label> : null}
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" autoComplete={creating ? "new-password" : "current-password"} minLength={8} maxLength={128} required /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={busy}>{busy ? "Please wait…" : creating ? "Create account" : "Sign in"}</button>
        {signupEnabled || creating ? (
          <button className="text-button" type="button" onClick={() => { setCreating((value) => !value); setError(""); }}>
            {creating ? "Already have an account? Sign in" : "Need an account? Create one"}
          </button>
        ) : null}
      </form>
    </div>
  );
}
