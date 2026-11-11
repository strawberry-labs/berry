import * as React from "react";
import type { ImageSource } from "expo-image";
import { useSignedInSession } from "../session/session";

/** Server-relative URLs ("/v1/files/…") resolve against the API origin. */
export function resolveServerUrl(apiUrl: string, url: string): string {
  if (/^(?:https?:|data:|file:)/i.test(url)) return url;
  return `${apiUrl.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
}

/**
 * An expo-image source for a server file: same-server URLs carry the phone's
 * bearer token (the web relies on its cookie); anything else loads as is.
 */
export function useServerImageSource(url: string | null | undefined): ImageSource | null {
  const { profile, authHeaders } = useSignedInSession();
  return React.useMemo(() => {
    if (!url) return null;
    if (/^data:/i.test(url)) return { uri: url };
    const resolved = resolveServerUrl(profile.apiUrl, url);
    const sameServer = resolved.startsWith(profile.apiUrl) || resolved.startsWith(profile.serverUrl);
    return sameServer ? { uri: resolved, headers: authHeaders, cacheKey: resolved } : { uri: resolved };
  }, [authHeaders, profile.apiUrl, profile.serverUrl, url]);
}
