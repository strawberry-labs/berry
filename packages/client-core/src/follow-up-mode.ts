export type FollowUpMode = "queue" | "steer";

const STORAGE_KEY = "berry.web.followUpMode";

/** Keep old Codex-style `interrupt` preferences working without exposing it. */
export function normalizeFollowUpMode(value: string | null | undefined): FollowUpMode {
  return value === "steer" || value === "interrupt" ? "steer" : "queue";
}

type PreferenceStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function browserStorage(): PreferenceStorage | undefined {
  return (globalThis as { localStorage?: PreferenceStorage }).localStorage;
}

export function readFollowUpMode(storage: PreferenceStorage | undefined = browserStorage()): FollowUpMode {
  if (!storage) return "queue";
  const stored = storage.getItem(STORAGE_KEY);
  const mode = normalizeFollowUpMode(stored);
  if (stored === "interrupt") storage.setItem(STORAGE_KEY, mode);
  return mode;
}

export function saveFollowUpMode(mode: FollowUpMode, storage: PreferenceStorage | undefined = browserStorage()): void {
  storage?.setItem(STORAGE_KEY, mode);
}
