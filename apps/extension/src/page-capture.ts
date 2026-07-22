import type { CapturedPageContext } from "./types";
import type { JsonValue } from "@berry/shared";

export interface CaptureChromeApi {
  tabs: Pick<typeof chrome.tabs, "query">;
  scripting: Pick<typeof chrome.scripting, "executeScript">;
  permissions: Pick<typeof chrome.permissions, "contains" | "request">;
}

export async function captureCurrentPage(api: CaptureChromeApi, options: { fullText: boolean }): Promise<CapturedPageContext> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab is available");
  const url = tab.url ?? "";
  if (options.fullText) await ensurePagePermission(api, url);
  const [result] = await api.scripting.executeScript({
    target: { tabId: tab.id },
    func: readPageContext,
    args: [options.fullText],
  });
  const context = result?.result as Pick<CapturedPageContext, "title" | "selection" | "text"> | undefined;
  return {
    url,
    title: tab.title ?? context?.title ?? "Untitled page",
    selection: context?.selection ?? "",
    text: context?.text ?? "",
    capturedAt: new Date().toISOString(),
  };
}

export function pageContextToAttachment(context: CapturedPageContext) {
  const body = [
    `URL: ${context.url}`,
    `Title: ${context.title}`,
    context.selection ? `Selection:\n${context.selection}` : null,
    context.text ? `Page text:\n${context.text}` : null,
  ].filter(Boolean).join("\n\n");
  return {
    kind: "attachment",
    content: {
      id: `page_${crypto.randomUUID()}`,
      name: `${safeTitle(context.title)}.md`,
      mediaType: "text/markdown",
      size: body.length,
      textContent: body,
      sourceKind: "browser-page",
      metadata: context as unknown as Record<string, JsonValue>,
    },
  };
}

async function ensurePagePermission(api: CaptureChromeApi, url: string): Promise<void> {
  const origin = originPattern(url);
  if (!origin) return;
  const hasPermission = await api.permissions.contains({ origins: [origin] });
  if (hasPermission) return;
  const granted = await api.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`Berry needs permission to read ${new URL(url).origin}`);
}

function originPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

function readPageContext(fullText: boolean) {
  const selection = globalThis.getSelection?.()?.toString().trim() ?? "";
  const text = fullText ? (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 80_000) : "";
  return { title: document.title, selection, text };
}

function safeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "browser-page";
}
