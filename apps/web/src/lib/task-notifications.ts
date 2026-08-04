export const BROWSER_NOTIFICATIONS_KEY = "berry.web.browserNotifications";
export const SOUND_ALERTS_KEY = "berry.web.soundAlerts";

const progressNotifiedAt = new Map<string, number>();
const completionIds = new Set<string>();
const PROGRESS_THROTTLE_MS = 30_000;
let completionAudioContext: AudioContext | null = null;

export type BrowserPermissionState = NotificationPermission | "unsupported";

export function storedPreference(key: string, fallback = true): boolean {
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(key);
  return stored === null ? fallback : stored === "on";
}

export function notificationPermission(): BrowserPermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserPermissionState> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (window.Notification.permission !== "default") return window.Notification.permission;
  return window.Notification.requestPermission();
}

export function armCompletionSound(): () => void {
  if (typeof document === "undefined") return () => undefined;
  let armed = true;
  const cleanup = () => {
    if (!armed) return;
    armed = false;
    document.removeEventListener("pointerdown", unlock, true);
    document.removeEventListener("keydown", unlock, true);
  };
  const unlock = () => {
    cleanup();
    if (storedPreference(SOUND_ALERTS_KEY)) void unlockCompletionSound();
  };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
  return cleanup;
}

export async function unlockCompletionSound(): Promise<boolean> {
  const context = completionSoundContext();
  if (!context) return false;
  try {
    if (context.state === "suspended") await context.resume();
    return context.state === "running";
  } catch {
    return false;
  }
}

export function notifyBackgroundProgress(input: {
  sessionId: string;
  taskId: string;
  taskTitle: string;
  detail: string;
}): void {
  if (!isAway() || !notificationsAvailable()) return;
  const now = Date.now();
  if (now - (progressNotifiedAt.get(input.sessionId) ?? 0) < PROGRESS_THROTTLE_MS) return;
  progressNotifiedAt.set(input.sessionId, now);
  showNotification(`${input.taskTitle} is making progress`, input.detail, `berry-progress:${input.sessionId}`, input.taskId);
}

export function notifyTaskCompleted(input: {
  completionId: string;
  sessionId: string;
  taskId: string;
  taskTitle: string;
}): void {
  if (!isAway() || completionIds.has(input.completionId)) return;
  completionIds.add(input.completionId);
  progressNotifiedAt.delete(input.sessionId);
  if (notificationsAvailable()) {
    showNotification("Task completed", input.taskTitle, `berry-complete:${input.taskId}`, input.taskId);
  }
  if (storedPreference(SOUND_ALERTS_KEY)) void playCompletionSound();
}

function notificationsAvailable(): boolean {
  return storedPreference(BROWSER_NOTIFICATIONS_KEY)
    && notificationPermission() === "granted";
}

function isAway(): boolean {
  return typeof document !== "undefined" && (document.hidden || !document.hasFocus());
}

function showNotification(title: string, body: string, tag: string, taskId: string): void {
  const notification = new window.Notification(title, { body, tag, silent: true });
  notification.onclick = () => {
    window.focus();
    window.location.assign(`/tasks/${encodeURIComponent(taskId)}`);
    notification.close();
  };
}

async function playCompletionSound(): Promise<void> {
  const context = completionSoundContext();
  if (!context) return;
  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch {
      return;
    }
  }
  if (context.state !== "running") return;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.42);
  gain.connect(context.destination);
  for (const [offset, frequency] of [[0, 660], [0.12, 880]] as const) {
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, context.currentTime + offset);
    oscillator.connect(gain);
    oscillator.start(context.currentTime + offset);
    oscillator.stop(context.currentTime + offset + 0.24);
  }
}

function completionSoundContext(): AudioContext | null {
  if (completionAudioContext && completionAudioContext.state !== "closed") return completionAudioContext;
  const AudioContextClass = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  completionAudioContext = new AudioContextClass();
  return completionAudioContext;
}
