// Keep this module dependency-free: recovery must work even when optional UI
// chunks from an older deployment have disappeared.
const STORAGE_KEY = "berry.web.chunk-recovery";
const RELOAD_COOLDOWN_MS = 5 * 60 * 1_000;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message
    : typeof error === "string" ? error
    : error && typeof error === "object" && "message" in error ? String(error.message) : "";
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading (?:CSS )?chunk .+ failed|Unable to preload CSS for/i.test(message);
}

type RecoveryWindow = Pick<Window, "sessionStorage" | "location" | "navigator" | "addEventListener" | "removeEventListener">;

export function createChunkLoadRecovery(browser: RecoveryWindow, now = Date.now) {
  let reloading = false;
  function recover(error: unknown): boolean {
    if (!isChunkLoadError(error) || browser.navigator.onLine === false) return false;
    if (reloading) return true;
    const message = error instanceof Error ? error.message : String(
      typeof error === "object" && error && "message" in error ? error.message : error,
    );
    try {
      const previous = JSON.parse(browser.sessionStorage.getItem(STORAGE_KEY) ?? "null") as { at?: number; message?: string } | null;
      // Remember the failed module across reloads, including failed hydration.
      // Do not clear this on mount: an optional chunk may fail much later.
      if (previous?.message === message || (typeof previous?.at === "number" && now() - previous.at < RELOAD_COOLDOWN_MS)) return false;
      browser.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ at: now(), message }));
    } catch {
      // Without durable per-tab storage we cannot guarantee a loop-free reload.
      return false;
    }
    reloading = true;
    browser.location.reload();
    return true;
  }
  const onPreloadError = (event: Event) => {
    if (recover((event as Event & { payload: unknown }).payload)) event.preventDefault();
  };
  browser.addEventListener("vite:preloadError", onPreloadError);
  return { recover, dispose: () => browser.removeEventListener("vite:preloadError", onPreloadError) };
}

let recovery: ReturnType<typeof createChunkLoadRecovery> | undefined;
export function installChunkLoadRecovery() {
  if (typeof window !== "undefined") recovery ??= createChunkLoadRecovery(window);
}

export function recoverChunkLoadError(error: unknown): boolean {
  installChunkLoadRecovery();
  return recovery?.recover(error) ?? false;
}
