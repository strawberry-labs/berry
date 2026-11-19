import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BerryApiClient } from "@berry/api-client";
import type { MobilePairingPollResponse, MobileServerInfo } from "@berry/shared";
import { createMobileApiClient } from "../api/client";
import { kv } from "../storage/kv";
import { clearUserFiles } from "../storage/user-files";
import { clearSession, loadActiveSession, saveSession, type ServerProfile } from "./credentials";

/** Per-user caches (drafts, list state) live under this prefix and are wiped on sign-out. */
export const USER_STORAGE_PREFIX = "berry.user.";

export type SignedOutReason = "signed-out" | "revoked" | null;

export type SessionState =
  | { status: "loading" }
  | { status: "signed-out"; reason: SignedOutReason }
  | {
      status: "signed-in";
      profile: ServerProfile;
      client: BerryApiClient;
      serverInfo: MobileServerInfo | null;
      /** Bearer header for authorized media (image previews, downloads). */
      authHeaders: Record<string, string>;
    };

const signOutListeners = new Set<() => void>();

/** Lets in-memory caches (live session controllers) drop everything on sign-out. */
export function addSignOutListener(listener: () => void): () => void {
  signOutListeners.add(listener);
  return () => signOutListeners.delete(listener);
}

type SessionContextValue = {
  state: SessionState;
  completePairing(input: {
    serverUrl: string;
    apiUrl: string;
    serverInfo: MobileServerInfo;
    result: Extract<MobilePairingPollResponse, { status: "approved" }>;
  }): Promise<void>;
  signOut(): Promise<void>;
};

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = React.useState<SessionState>({ status: "loading" });
  const ending = React.useRef(false);

  const endSession = React.useCallback(async (profile: ServerProfile, reason: SignedOutReason) => {
    if (ending.current) return;
    ending.current = true;
    try {
      await clearSession(profile.serverUrl);
      kv.clearPrefix(USER_STORAGE_PREFIX);
      queryClient.clear();
      for (const listener of signOutListeners) listener();
      await clearUserFiles();
      setState({ status: "signed-out", reason });
    } finally {
      ending.current = false;
    }
  }, [queryClient]);

  const open = React.useCallback((profile: ServerProfile, token: string, serverInfo: MobileServerInfo | null) => {
    const client = createMobileApiClient({
      apiUrl: profile.apiUrl,
      token,
      // The server deleted this phone's session (revoked, policy, deprovisioned).
      onUnauthorized: () => void endSession(profile, "revoked"),
    });
    setState({ status: "signed-in", profile, client, serverInfo, authHeaders: { Authorization: `Bearer ${token}` } });
    if (!serverInfo) {
      void client.getMobileServerInfo()
        .then((info) => setState((current) => current.status === "signed-in" && current.profile.serverUrl === profile.serverUrl ? { ...current, serverInfo: info } : current))
        .catch(() => undefined);
    }
  }, [endSession]);

  React.useEffect(() => {
    let cancelled = false;
    void loadActiveSession()
      .then((stored) => {
        if (cancelled) return;
        if (stored) open(stored.profile, stored.token, null);
        else setState({ status: "signed-out", reason: null });
      })
      .catch(() => { if (!cancelled) setState({ status: "signed-out", reason: null }); });
    return () => { cancelled = true; };
  }, [open]);

  const completePairing = React.useCallback<SessionContextValue["completePairing"]>(async ({ serverUrl, apiUrl, serverInfo, result }) => {
    const profile: ServerProfile = {
      serverUrl,
      apiUrl,
      deviceId: result.deviceId,
      user: result.user,
      brand: serverInfo.brand,
      pairedAt: new Date().toISOString(),
      sessionExpiresAt: result.sessionExpiresAt,
    };
    await saveSession(profile, result.sessionToken);
    open(profile, result.sessionToken, serverInfo);
  }, [open]);

  const signOut = React.useCallback(async () => {
    if (state.status !== "signed-in") return;
    // Best effort: the local sign-out must work offline too.
    await state.client.signOutMobileSession().catch(() => undefined);
    await endSession(state.profile, "signed-out");
  }, [endSession, state]);

  const value = React.useMemo(() => ({ state, completePairing, signOut }), [completePairing, signOut, state]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = React.useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

/** For screens behind the signed-in guard. */
export function useSignedInSession(): Extract<SessionState, { status: "signed-in" }> & { signOut: () => Promise<void> } {
  const { state, signOut } = useSession();
  if (state.status !== "signed-in") throw new Error("This screen requires a paired server");
  return { ...state, signOut };
}
