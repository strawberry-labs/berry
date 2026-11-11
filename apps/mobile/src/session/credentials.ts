import * as SecureStore from "expo-secure-store";
import type { MobileBrand, MobileSessionUser } from "@berry/shared";
import { kv, readJson, writeJson } from "../storage/kv";

/** Non-secret details about a paired server; the token itself lives in the keychain. */
export type ServerProfile = {
  serverUrl: string;
  apiUrl: string;
  deviceId: string;
  user: MobileSessionUser;
  brand: MobileBrand;
  pairedAt: string;
  sessionExpiresAt: string;
};

const PROFILES_KEY = "berry.servers.v1";
const ACTIVE_KEY = "berry.servers.active";
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  // Never restored from a backup onto another device.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

function tokenKey(serverUrl: string): string {
  return `berry_session_${serverUrl.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/**
 * Profiles are kept as a list so a later release can offer a server
 * switcher (several organizations, or hosted Berry Cloud). v1 uses one.
 */
export function listProfiles(): ServerProfile[] {
  return readJson<ServerProfile[]>(PROFILES_KEY) ?? [];
}

export async function loadActiveSession(): Promise<{ profile: ServerProfile; token: string } | null> {
  const active = kv.getItem(ACTIVE_KEY);
  const profile = listProfiles().find((candidate) => candidate.serverUrl === active);
  if (!profile) return null;
  const token = await SecureStore.getItemAsync(tokenKey(profile.serverUrl), SECURE_OPTIONS);
  return token ? { profile, token } : null;
}

export async function saveSession(profile: ServerProfile, token: string): Promise<void> {
  await SecureStore.setItemAsync(tokenKey(profile.serverUrl), token, SECURE_OPTIONS);
  writeJson(PROFILES_KEY, [...listProfiles().filter((candidate) => candidate.serverUrl !== profile.serverUrl), profile]);
  kv.setItem(ACTIVE_KEY, profile.serverUrl);
}

export async function clearSession(serverUrl: string): Promise<void> {
  await SecureStore.deleteItemAsync(tokenKey(serverUrl), SECURE_OPTIONS).catch(() => undefined);
  writeJson(PROFILES_KEY, listProfiles().filter((candidate) => candidate.serverUrl !== serverUrl));
  if (kv.getItem(ACTIVE_KEY) === serverUrl) kv.removeItem(ACTIVE_KEY);
}
