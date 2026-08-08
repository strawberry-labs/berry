import * as React from "react";

export default function GoogleSsoButton({ baseUrl, domain, busy, setBusy, setError }: {
  baseUrl: string;
  domain: string;
  busy: boolean;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string>>;
}) {
  async function signIn(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${baseUrl}/v1/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(googleSsoRequest(`${window.location.origin}/`)),
      });
      const result = await response.json().catch(() => null) as { url?: string; message?: string | string[] } | null;
      if (!response.ok || !result?.url) {
        const message = Array.isArray(result?.message) ? result.message.join(" ") : result?.message;
        throw new Error(message ?? "Unable to start Google sign-in");
      }
      window.location.assign(result.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start Google sign-in");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="auth-divider"><span>or</span></div>
      <button className="sso-button" type="button" disabled={busy} onClick={() => void signIn()}>
        <img className="google-mark" src="/google-g.svg" alt="" />
        Continue with Google
      </button>
      <p className="auth-sso-domain">For {domain} Workspace accounts</p>
    </>
  );
}

export function googleSsoRequest(callbackURL: string) {
  return {
    provider: "google" as const,
    callbackURL,
    errorCallbackURL: `${new URL(callbackURL).origin}/login`,
    disableRedirect: true,
  };
}
