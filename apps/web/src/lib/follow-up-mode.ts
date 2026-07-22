export type FollowUpMode = "queue" | "steer";

const STORAGE_KEY = "berry.web.followUpMode";

/** Keep old Codex-style `interrupt` preferences working without exposing it. */
export function normalizeFollowUpMode(value: string | null | undefined): FollowUpMode {
  return value === "steer" || value === "interrupt" ? "steer" : "queue";
}

export function readFollowUpMode(): FollowUpMode {
  if (typeof window === "undefined") return "queue";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  const mode = normalizeFollowUpMode(stored);
  if (stored === "interrupt") window.localStorage.setItem(STORAGE_KEY, mode);
  return mode;
}

export function saveFollowUpMode(mode: FollowUpMode): void {
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, mode);
}
