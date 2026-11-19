import type {
  Connector,
  MemoryItem,
  MobileDeviceRegistration,
  PersonalMcpServer,
  PersonalizationProfile,
  Task,
  UsageAnalytics,
  Workspace,
} from "@berry/shared";

/**
 * Platform-neutral settings logic: the web's personal settings tab list
 * (apps/web/src/components/management/management-navigation.ts) and the
 * pure helpers its screens use, so the phone shows the same tabs and labels.
 */

export type SettingsTabId =
  | "general"
  | "account"
  | "personalization"
  | "connectors"
  | "skills"
  | "mcp"
  | "schedules"
  | "usage"
  | "archived";

export type SettingsTab = {
  id: SettingsTabId;
  label: string;
  description: string;
  /** Server capability (MobileServerInfo.capabilities) the tab needs, if any. */
  capability: string | null;
  /** Tabs whose phone screen lives outside settings, like the sidebar's Skills and Scheduled. */
  href: string | null;
  /** Extra words Search matches this tab by. */
  keywords: string;
};

/** Same ids, labels and order as the web's PERSONAL_NAV, so `/settings/<id>` links agree. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: "general", label: "General", description: "Choose how Berry looks on this phone.", capability: null, href: null, keywords: "theme appearance dark light mode language" },
  { id: "account", label: "Account", description: "Your signed-in identity and effective organization access.", capability: null, href: null, keywords: "profile email role permissions access phones devices sign out" },
  { id: "personalization", label: "Personalization", description: "Set explicit profile context and control what Berry remembers.", capability: "personalization", href: null, keywords: "profile nickname occupation about custom instructions memory remember" },
  { id: "connectors", label: "Connectors", description: "Connect approved apps once, then let Berry use their tools when a task needs them.", capability: "connectors", href: null, keywords: "apps integrations google drive gmail calendar connect" },
  { id: "skills", label: "Skills", description: "Skills Berry can use in your tasks.", capability: "skills", href: "/(app)/skills", keywords: "skill" },
  { id: "mcp", label: "MCP servers", description: "Connect approved Streamable HTTP MCP servers and inspect their authorization state.", capability: "mcp", href: null, keywords: "mcp server tools remote" },
  { id: "schedules", label: "Scheduled tasks", description: "Give Berry work to do later.", capability: "scheduled-tasks", href: "/(app)/scheduled", keywords: "schedule scheduled recurring later automation" },
  { id: "usage", label: "Usage", description: "Your model activity, token consumption, and billed usage for any period.", capability: "usage", href: null, keywords: "usage spend cost billing tokens allowance requests" },
  { id: "archived", label: "Archived tasks", description: "Search, restore, or remove archived and deleted tasks.", capability: "archived-tasks", href: null, keywords: "archive archived deleted restore trash history" },
];

/** Old web tab ids that the web route redirects (settings.$tab.tsx). */
const LEGACY_TABS: Readonly<Record<string, SettingsTabId>> = {
  prompts: "personalization",
  memory: "personalization",
  privacy: "account",
  providers: "general",
};

/** Resolves a route param to a tab; unknown ids fall back to General, as on the web. */
export function resolveSettingsTab(value: string | string[] | undefined): SettingsTabId {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return "general";
  const legacy = LEGACY_TABS[raw];
  if (legacy) return legacy;
  return SETTINGS_TABS.find((tab) => tab.id === raw)?.id ?? "general";
}

export function settingsTab(id: SettingsTabId): SettingsTab {
  return SETTINGS_TABS.find((tab) => tab.id === id) ?? SETTINGS_TABS[0]!;
}

/**
 * Tabs this server supports. Before server info loads (`null`), everything is
 * shown, matching the sidebar's `hasCapability(...) || !serverInfo` rule.
 */
export function visibleSettingsTabs(capabilities: readonly string[] | null): SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => !tab.capability || !capabilities || capabilities.includes(tab.capability));
}

/** The web only shows the organization console to members with `org:admin`. */
export function canOpenAdminConsole(permissions: readonly string[]): boolean {
  return permissions.includes("org:admin");
}

/** An absolute link into the web app on the paired server. */
export function webUrl(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

// Devices -------------------------------------------------------------------

export function describePairedDevice(device: Pick<MobileDeviceRegistration, "platform" | "osVersion" | "appVersion">): string {
  const platform = device.platform === "ios" ? "iOS" : device.platform === "android" ? "Android" : "Mobile";
  return [device.osVersion ? `${platform} ${device.osVersion}` : platform, device.appVersion ? `Berry ${device.appVersion}` : null].filter(Boolean).join(" · ");
}

export function deviceTitle(device: Pick<MobileDeviceRegistration, "displayName" | "model">): string {
  return device.displayName || device.model || "Phone";
}

/** This phone first, then the most recently active. */
export function sortDevices<T extends Pick<MobileDeviceRegistration, "current" | "lastSeenAt">>(devices: readonly T[]): T[] {
  return [...devices].sort((left, right) => {
    if (Boolean(left.current) !== Boolean(right.current)) return left.current ? -1 : 1;
    return right.lastSeenAt.localeCompare(left.lastSeenAt);
  });
}

// Formatting (management-primitives.tsx) --------------------------------------

export function formatDate(value: string | number | Date | null | undefined): string {
  if (value == null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value == null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatMoney(micros: string | number | bigint | null | undefined): string {
  const value = Number(micros ?? 0) / 1_000_000;
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: value < 10 ? 2 : 0 }).format(value);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function humanize(value: string): string {
  const text = value.replaceAll("_", " ").replaceAll("-", " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Other";
}

// Personalization -------------------------------------------------------------

export type ProfileFields = Pick<PersonalizationProfile, "nickname" | "occupation" | "about" | "customInstructions">;

export const PROFILE_LIMITS: Readonly<Record<keyof ProfileFields, number>> = {
  nickname: 80,
  occupation: 160,
  about: 4_000,
  customInstructions: 12_000,
};

export function profileInput(profile: ProfileFields): ProfileFields {
  return {
    nickname: profile.nickname.trim(),
    occupation: profile.occupation.trim(),
    about: profile.about.trim(),
    customInstructions: profile.customInstructions.trim(),
  };
}

export function sameProfile(left: ProfileFields, right: ProfileFields): boolean {
  const a = profileInput(left);
  const b = profileInput(right);
  return a.nickname === b.nickname && a.occupation === b.occupation && a.about === b.about && a.customInstructions === b.customInstructions;
}

// Memory ----------------------------------------------------------------------

export const MEMORY_KINDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "profile", label: "Profile" },
  { value: "preference", label: "Preference" },
  { value: "communication_style", label: "Communication style" },
  { value: "accessibility", label: "Accessibility" },
  { value: "working_convention", label: "Working convention" },
];

/** The category picker's options, keeping an unlisted current kind selectable. */
export function memoryKindOptions(current: string): Array<{ value: string; label: string }> {
  return MEMORY_KINDS.some((kind) => kind.value === current) || !current
    ? [...MEMORY_KINDS]
    : [...MEMORY_KINDS, { value: current, label: humanize(current) }];
}

export function groupActiveMemories(items: readonly MemoryItem[]): Array<{ kind: string; items: MemoryItem[] }> {
  const groups = new Map<string, MemoryItem[]>();
  for (const item of items) {
    if (item.status !== "active") continue;
    const group = groups.get(item.kind) ?? [];
    group.push(item);
    groups.set(item.kind, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, grouped]) => ({ kind, items: grouped }));
}

export function filterMemories(items: readonly MemoryItem[], query: string): MemoryItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => `${item.kind} ${item.content}`.toLowerCase().includes(needle));
}

/**
 * Parses the optional expiry typed as YYYY-MM-DD into the end of that local
 * day, as the web's date input does. Empty means "never"; bad input is null.
 */
export function parseMemoryExpiry(value: string): { ok: true; expiresAt: string | null } | { ok: false } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, expiresAt: null };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return { ok: false };
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day, 23, 59, 59);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return { ok: false };
  return { ok: true, expiresAt: date.toISOString() };
}

// Usage -------------------------------------------------------------------------

export type UsageRangeKey = "15m" | "30m" | "1h" | "3h" | "1d" | "1w" | "1mo" | "3mo" | "1y" | "all";

/** The web's range menu, minus "Custom range" (the phone has no date-time picker). */
export const USAGE_RANGES: ReadonlyArray<{ value: UsageRangeKey; label: string }> = [
  { value: "15m", label: "Past 15 minutes" },
  { value: "30m", label: "Past 30 minutes" },
  { value: "1h", label: "Past hour" },
  { value: "3h", label: "Past 3 hours" },
  { value: "1d", label: "Past day" },
  { value: "1w", label: "Past week" },
  { value: "1mo", label: "Past month" },
  { value: "3mo", label: "Past 3 months" },
  { value: "1y", label: "Past year" },
  { value: "all", label: "All time" },
];

const RANGE_MS: Readonly<Record<Exclude<UsageRangeKey, "all">, number>> = {
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 3_600_000,
  "3h": 3 * 3_600_000,
  "1d": 86_400_000,
  "1w": 7 * 86_400_000,
  "1mo": 30 * 86_400_000,
  "3mo": 90 * 86_400_000,
  "1y": 365 * 86_400_000,
};

export function usageRange(key: UsageRangeKey, anchor: number): { from: string; to: string } {
  const from = key === "all" ? new Date(0) : new Date(anchor - RANGE_MS[key]);
  return { from: from.toISOString(), to: new Date(anchor).toISOString() };
}

export function usageRangeLabel(key: UsageRangeKey): string {
  return USAGE_RANGES.find((range) => range.value === key)?.label ?? "Selected period";
}

export function cacheSummary(performance: Pick<UsageAnalytics["performance"], "cacheEligibleRequests" | "cacheHitRequests">): { hits: number; misses: number; hitRate: number | null } {
  const eligible = performance.cacheEligibleRequests;
  const hits = performance.cacheHitRequests;
  return { hits, misses: Math.max(0, eligible - hits), hitRate: eligible ? hits / eligible : null };
}

export function requestTone(status: string): "good" | "danger" | "neutral" {
  if (["completed", "success", "succeeded"].includes(status)) return "good";
  if (["failed", "error", "cancelled"].includes(status)) return "danger";
  return "neutral";
}

/** Each value as a share of the largest, for the phone's bar charts. */
export function relativeHeights(values: readonly number[]): number[] {
  const max = Math.max(0, ...values);
  return values.map((value) => (max > 0 ? Math.max(0, value) / max : 0));
}

// Archived tasks ----------------------------------------------------------------

export type ArchiveState = "archived" | "deleted" | "all";

export const ARCHIVE_STATES: ReadonlyArray<{ value: ArchiveState; label: string }> = [
  { value: "archived", label: "Archived" },
  { value: "deleted", label: "Recently deleted" },
  { value: "all", label: "Archived and deleted" },
];

export function workspaceLabel(workspace: Pick<Workspace, "workspaceKind" | "name"> | undefined): string {
  if (!workspace) return "Unknown project";
  return workspace.workspaceKind === "general" ? "Tasks" : workspace.name;
}

/** Groups by project (sorted by name), newest task first, like the web archive. */
export function groupArchivedTasks(tasks: readonly Task[], workspaces: readonly Workspace[]): Array<{ workspaceId: string; title: string; items: Task[] }> {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const grouped = new Map<string, Task[]>();
  for (const task of tasks) grouped.set(task.workspaceId, [...(grouped.get(task.workspaceId) ?? []), task]);
  return [...grouped]
    .map(([workspaceId, items]) => ({
      workspaceId,
      title: workspaceLabel(byId.get(workspaceId)),
      sortName: byId.get(workspaceId)?.name ?? "",
      items: [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    }))
    .sort((left, right) => left.sortName.localeCompare(right.sortName))
    .map(({ workspaceId, title, items }) => ({ workspaceId, title, items }));
}

export function archiveStatusMessage(action: "unarchive" | "delete" | "restore", title: string): string {
  if (action === "unarchive") return `Unarchived ${title}.`;
  if (action === "delete") return `Moved ${title} to recently deleted.`;
  return `Restored ${title}.`;
}

// Connectors and MCP (personal-connectors-screen.tsx, personal-mcp-screen.tsx) ---

export function filterConnectors(connectors: readonly Connector[], query: string): Connector[] {
  const needle = query.trim().toLowerCase();
  return connectors.filter((connector) => `${connector.name} ${connector.description} ${connector.services.join(" ")}`.toLowerCase().includes(needle));
}

export function humanTool(value: string): string {
  return value.replace(/^google_/, "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function connectorAccessLabel(connector: Pick<Connector, "provider" | "connectedAccessLevel">): string {
  if (connector.provider !== "google") return "Connected";
  return connector.connectedAccessLevel === "full" ? "Full access" : "Read access";
}

export type PersonalMcpConnectionAction = {
  kind: "test" | "connect" | "request" | "pending" | "reconnect" | "unsupported";
  label: string;
  disabled: boolean;
};

export function personalMcpConnectionAction(
  server: Pick<PersonalMcpServer, "auth" | "transport">,
  connector: Pick<Connector, "approvalStatus" | "connectionStatus"> | null,
  canApprove: boolean,
): PersonalMcpConnectionAction {
  if (server.auth !== "oauth") return { kind: "test", label: "Test", disabled: false };
  if (server.transport !== "streamable-http") return { kind: "unsupported", label: "OAuth unavailable", disabled: true };
  if (connector?.approvalStatus === "pending") return { kind: "pending", label: "Awaiting approval", disabled: true };
  if (connector?.approvalStatus === "approved") {
    return connector.connectionStatus === "connected"
      ? { kind: "reconnect", label: "Reconnect", disabled: false }
      : { kind: "connect", label: "Connect", disabled: false };
  }
  return canApprove ? { kind: "connect", label: "Connect", disabled: false } : { kind: "request", label: "Request approval", disabled: false };
}

export type PersonalMcpOAuthStatus = { authentication: string; approval: string; health: string; tone: "good" | "warning" | "danger" | "neutral" };

export function personalMcpOAuthStatus(connector: Pick<Connector, "approvalStatus" | "connectionStatus"> | null): PersonalMcpOAuthStatus {
  if (connector?.approvalStatus === "pending") return { authentication: "pending", approval: "Awaiting approval", health: "approval pending", tone: "warning" };
  if (connector?.approvalStatus === "rejected") return { authentication: "not connected", approval: "Not approved", health: "not connected", tone: "danger" };
  if (connector?.approvalStatus === "approved" && connector.connectionStatus === "connected") return { authentication: "connected", approval: "Approved", health: "connected", tone: "good" };
  if (connector?.approvalStatus === "approved") return { authentication: "not connected", approval: "Approved", health: "not connected", tone: "warning" };
  return { authentication: "not connected", approval: "Not submitted", health: "not connected", tone: "neutral" };
}

export function mcpHealthTone(health: PersonalMcpServer["health"]): "good" | "danger" | "warning" {
  if (health === "healthy") return "good";
  if (health === "unreachable") return "danger";
  return "warning";
}

function comparableUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

export function connectorForServer<T extends Pick<Connector, "url">>(connectors: readonly T[], server: Pick<PersonalMcpServer, "url">): T | null {
  const url = comparableUrl(server.url);
  return connectors.find((connector) => connector.url && comparableUrl(connector.url) === url) ?? null;
}

/** Requested and available custom MCP connectors, de-duplicated by id (requests win). */
export function customMcpConnectors(available: readonly Connector[], requested: readonly Connector[]): Connector[] {
  return [...new Map([...requested, ...available].map((connector) => [connector.id, connector])).values()].filter((connector) => connector.kind === "custom_mcp");
}

export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || (url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname));
  } catch {
    return false;
  }
}
