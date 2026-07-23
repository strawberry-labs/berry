export const BERRY_THEME_STORAGE_KEY = "berry.web.theme";
export const DEFAULT_BERRY_THEME = "dark";
export const BERRY_THEME_CHANGE_EVENT = "berry:web-theme";

export type BerryThemePreference = "dark" | "light" | "system";
export type ResolvedBerryTheme = "dark" | "light";

export function normalizeThemePreference(value: unknown): BerryThemePreference {
  return value === "light" || value === "system" || value === "dark"
    ? value
    : DEFAULT_BERRY_THEME;
}

export function resolveTheme(
  preference: BerryThemePreference,
  prefersDark: boolean,
): ResolvedBerryTheme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

export function readThemePreference(
  storage: Pick<Storage, "getItem"> | null,
): BerryThemePreference {
  if (!storage) return DEFAULT_BERRY_THEME;
  try {
    return normalizeThemePreference(storage.getItem(BERRY_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_BERRY_THEME;
  }
}

export function applyDocumentTheme(
  preference = readThemePreference(typeof window === "undefined" ? null : window.localStorage),
): ResolvedBerryTheme {
  const prefersDark = typeof window !== "undefined"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = resolveTheme(preference, prefersDark);

  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(BERRY_THEME_CHANGE_EVENT, {
      detail: { preference, resolved },
    }));
  }

  return resolved;
}

export function watchSystemTheme(): () => void {
  if (typeof window === "undefined") return () => {};
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (readThemePreference(window.localStorage) === "system") {
      applyDocumentTheme("system");
    }
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function currentDocumentTheme(): ResolvedBerryTheme {
  if (typeof document === "undefined") return DEFAULT_BERRY_THEME;
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// This runs in <head> before the stylesheet is processed, so the first painted
// frame uses the stored theme instead of the server's dark-mode fallback.
export const BERRY_THEME_BOOTSTRAP_SCRIPT = `(()=>{let t="dark";try{const s=localStorage.getItem("${BERRY_THEME_STORAGE_KEY}");if(s==="light"||s==="system"||s==="dark")t=s}catch{}const d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light"})()`;
