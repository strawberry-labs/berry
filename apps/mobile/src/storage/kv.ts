import Storage from "expo-sqlite/kv-store";
import type { KeyValueStorage } from "@berry/client-core/queued-follow-ups";

/**
 * Synchronous, non-secret key-value storage (preferences, drafts, cached
 * brand). Secrets such as session tokens live in the keychain instead.
 */
export const kv: KeyValueStorage & { clearPrefix(prefix: string): void } = {
  getItem: (key) => Storage.getItemSync(key),
  setItem: (key, value) => Storage.setItemSync(key, value),
  removeItem: (key) => { Storage.removeItemSync(key); },
  clearPrefix(prefix) {
    for (const key of Storage.getAllKeysSync()) if (key.startsWith(prefix)) Storage.removeItemSync(key);
  },
};

export function readJson<T>(key: string): T | null {
  try {
    const value = kv.getItem(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  kv.setItem(key, JSON.stringify(value));
}
