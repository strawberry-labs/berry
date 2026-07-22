import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@/host-client";

const MCP_CALLBACK = "berry://mcp/oauth/callback";

export function parseMcpCallback(value: string): { code: string; state: string } | null {
  try {
    const url = new URL(value);
    if (`${url.protocol}//${url.host}${url.pathname}` !== MCP_CALLBACK) return null;
    const code = url.searchParams.get("code")?.trim();
    const state = url.searchParams.get("state")?.trim();
    return code && state ? { code, state } : null;
  } catch {
    return null;
  }
}

export async function openMcpAuthorization(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("MCP authorization must use HTTPS.");
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export async function subscribeMcpCallbacks(handler: (callback: { code: string; state: string }) => void): Promise<() => void> {
  const accept = (values: string[]) => {
    for (const value of values) {
      const callback = parseMcpCallback(value);
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
