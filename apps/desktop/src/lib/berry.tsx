import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import type { ConversationKind, HostPushEvent, JsonValue, Task, Workspace } from "@berry/shared";
import { callWithApprovalRetry as callHostWithApprovalRetry, createHostClient, type HostClient } from "@/host-client";

export { isTauri, localFilePreviewUrl, pickDirectory, pickFiles } from "@/host-client";

/** Singleton host client shared by the whole renderer. */
export const host: HostClient = createHostClient();

export function callWithApprovalRetry<T = JsonValue>(method: string, params: Record<string, JsonValue | undefined>): Promise<T> {
  return callHostWithApprovalRetry<T>(host, method, params);
}

/** Subscribe to host push events for the lifetime of the component. */
export function useHostEvent(handler: (event: HostPushEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => host.subscribe((event) => ref.current(event)), []);
}

export type SettingsPage =
  | "general"
  | "code-preview"
  | "models"
  | "skills"
  | "subagents"
  | "mcp"
  | "commands"
  | "plugins"
  | "security"
  | "indexing"
  | "usage";

export type WorkbenchView =
  | { kind: "home" }
  | { kind: "task"; taskId: string }
  | { kind: "files" }
  | { kind: "settings"; page: SettingsPage };

export interface WorkbenchContextValue {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  setActiveWorkspaceId: (id: string) => void;
  tasks: Task[];
  view: WorkbenchView;
  setView: (view: WorkbenchView) => void;
  openTask: (taskId: string) => void;
  openSettings: (page?: SettingsPage) => void;
  openHome: () => void;
  selectedConversationKind: ConversationKind;
  setSelectedConversationKind: (kind: ConversationKind) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
}

export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export function useWorkbench(): WorkbenchContextValue {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("useWorkbench must be used inside <WorkbenchContext.Provider>");
  return value;
}

export function WorkbenchProvider({ value, children }: { value: WorkbenchContextValue; children: ReactNode }) {
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

/** Human "time ago" for task rows and thread footers. */
export function timeAgo(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

/** Time-of-day greeting for the workspace empty state. */
export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "It's late, take it easy";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "It's late, take it easy";
}
