import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@/host-client";

const ROUTER_CALLBACK = "berry://router/oauth/callback";

export function parseRouterCallback(value: string): { code: string; state: string } | null {
  try {
    const url = new URL(value);
    if (`${url.protocol}//${url.host}${url.pathname}` !== ROUTER_CALLBACK) return null;
    const code = url.searchParams.get("code")?.trim();
    const state = url.searchParams.get("state")?.trim();
    if (!code || !state) return null;
    return { code, state };
  } catch {
    return null;
  }
}

export async function openRouterAuthorization(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Berry Router authorization must use HTTPS.");
  if (isTauri()) {
    await openUrl(parsed);
    return;
  }
  window.open(parsed, "_blank", "noopener,noreferrer");
}

export async function subscribeRouterCallbacks(handler: (callback: { code: string; state: string }) => void): Promise<() => void> {
  const accept = (urls: string[]) => {
    for (const value of urls) {
      const callback = parseRouterCallback(value);
      if (callback) handler(callback);
    }
  };
  if (isTauri()) {
    const current = await getCurrent();
    if (current) accept(current);
    return await onOpenUrl(accept);
  }
  const listener = (event: Event) => {
    const value = (event as CustomEvent<string>).detail;
    if (typeof value === "string") accept([value]);
  };
  window.addEventListener("berry:deep-link", listener);
  return () => window.removeEventListener("berry:deep-link", listener);
}
