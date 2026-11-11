import { AppState } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { BerryApiClient, BerryApiError } from "@berry/api-client";
import { USER_AGENT_SUFFIX } from "../config";
import { createNativeEventSource } from "./event-source";

const appState = {
  current: () => AppState.currentState,
  subscribe: (listener: (state: string) => void) => {
    const subscription = AppState.addEventListener("change", listener);
    return () => subscription.remove();
  },
};

const streamingFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
  expoFetch(url, { headers: init.headers, signal: init.signal }) as unknown as ReturnType<Parameters<typeof createNativeEventSource>[0]["fetch"]>;

/**
 * A client for one paired server. It always sends the phone's bearer token
 * and never cookies, so a cookie the OS might have stored can't leak in.
 */
export function createMobileApiClient(options: { apiUrl: string; token: string | null; onUnauthorized?: () => void }): BerryApiClient {
  const headers: Record<string, string> = { "X-Berry-Client": USER_AGENT_SUFFIX };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await fetch(input, { ...init, credentials: "omit" });
    if (response.status === 401 && options.token) options.onUnauthorized?.();
    return response;
  };
  return new BerryApiClient({
    baseUrl: options.apiUrl,
    headers,
    credentials: "omit",
    fetchImpl,
    eventSource: createNativeEventSource({ fetch: streamingFetch, appState }),
  });
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof BerryApiError && error.status === 401;
}

export function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof BerryApiError) || typeof error.body !== "object" || error.body === null) return null;
  const code = (error.body as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** A short, user-facing message for any API or network failure. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof BerryApiError) {
    const body = typeof error.body === "object" && error.body !== null ? error.body as { message?: unknown } : {};
    if (error.status === 401) return "You've been signed out of this server.";
    if (error.status === 429) return "Too many attempts. Wait a minute and try again.";
    if (error.status < 500 && typeof body.message === "string" && body.message.trim()) return body.message;
    return fallback;
  }
  if (error instanceof TypeError) return "Couldn't reach the server. Check your connection and try again.";
  return fallback;
}
