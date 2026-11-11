/**
 * Demo-mode data for the settings, admin and platform screens.
 *
 * When the web app runs without an API (`config.demoMode`), the management
 * screens receive this client instead of `null`, so they render a large,
 * internally consistent organization rather than empty states. Nothing here
 * talks to a network: every read is generated from a seeded PRNG, with time
 * series anchored on `Date.now()` so the charts always end today.
 */
import type { BerryApiClient } from "@berry/api-client";
import {
  OrgPermissionSchema,
  type AllowanceAdjustment,
  type AllowanceBalance,
  type CloudAuditEvent,
  type Connector,
  type Department,
  type EffectiveCapability,
  type ManagedPolicyVersion,
  type MemoryItem,
  type OrgCapability,
  type OrgMembership,
  type OrgPermission,
  type PersonalMcpServer,
  type PersonalSkill,
  type PlatformTenantSummary,
  type ScheduledTask,
  type ScheduledTaskRun,
  type Task,
  type UsageAnalytics,
  type UsageAnalyticsQuery,
  type UsageRequestDetail,
  type UsageRequestPage,
  type UsageRequestSummary,
} from "@berry/shared";
import type { WebConfig } from "./config";

/* ------------------------------------------------------------------ types */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
type ClientMethod = { [K in keyof BerryApiClient]: BerryApiClient[K] extends AnyFn ? K : never }[keyof BerryApiClient];
/** Every implemented method is checked against the real client's signature. */
type DemoImplementation = {
  [K in ClientMethod]?: (...args: Parameters<BerryApiClient[K]>) => ReturnType<BerryApiClient[K]>;
};

/* -------------------------------------------------------------- utilities */

const HOUR = 3_600_000;
const DAY = 86_400_000;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hash(text: string): number {
  let value = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
}

/** Deterministic number in [0, 1) for a key. */
function unit(key: string): number {
  return mulberry32(hash(key))();
}

function hex(key: string, length: number): string {
  const random = mulberry32(hash(key));
  let out = "";
  while (out.length < length) out += Math.floor(random() * 0x100000000).toString(16).padStart(8, "0");
  return out.slice(0, length);
}

function base36(key: string, length: number): string {
  const random = mulberry32(hash(key));
  let out = "";
  while (out.length < length) out += Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0");
  return out.slice(0, length).toUpperCase();
}

function at<T>(items: readonly T[], index: number): T {
  return items[((index % items.length) + items.length) % items.length] as T;
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))] as T;
}

function pickWeighted<T>(items: readonly T[], weight: (item: T) => number, random: () => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let cursor = random() * total;
  for (const item of items) {
    cursor -= weight(item);
    if (cursor <= 0) return item;
  }
  return items[items.length - 1] as T;
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const held = out[index] as T;
    out[index] = out[other] as T;
    out[other] = held;
  }
  return out;
}

/** Splits an integer total across shares so the parts sum exactly to the total. */
function allocate(total: number, shares: readonly number[]): number[] {
  const sum = shares.reduce((acc, share) => acc + share, 0);
  if (sum <= 0 || total <= 0) return shares.map(() => 0);
  const exact = shares.map((share) => (total * share) / sum);
  const parts = exact.map((value) => Math.floor(value));
  let remainder = total - parts.reduce((acc, value) => acc + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let index = 0; remainder > 0 && order.length > 0; index += 1, remainder -= 1) {
    const slot = (order[index % order.length] as { index: number }).index;
    parts[slot] = (parts[slot] ?? 0) + 1;
  }
  return parts;
}

const iso = (ms: number) => new Date(ms).toISOString();
/** Dollars to micro-USD string, the money encoding used across the API. */
const usd = (dollars: number) => String(Math.round(dollars * 1_000_000));
const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* ------------------------------------------------------------------- cron */

const CRON_STEP = 15 * 60_000;
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Fire times of a five-field cron expression in a timezone, nearest first,
 * walking forward (`direction` 1) or back (-1) from `from`. Supports the
 * shapes the automation form writes: numbers, `*` and `1-5`, on quarter hours.
 */
function cronFireTimes(expression: string, timezone: string, from: number, direction: 1 | -1, count: number): number[] {
  const [minute = "*", hour = "*", dayOfMonth = "*", , dayOfWeek = "*"] = expression.split(" ");
  const matches = (field: string, value: number, modulus = 60) => field === "*" || (field === "1-5" ? value >= 1 && value <= 5 : Number(field) % modulus === value);
  const format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", weekday: "short", day: "numeric", hour: "numeric", minute: "numeric" });
  const out: number[] = [];
  let ts = direction === 1 ? Math.floor(from / CRON_STEP) * CRON_STEP + CRON_STEP : Math.floor(from / CRON_STEP) * CRON_STEP;
  for (let step = 0; step < 220 * 96 && out.length < count; step += 1, ts += direction * CRON_STEP) {
    const parts: Record<string, string> = {};
    for (const part of format.formatToParts(ts)) parts[part.type] = part.value;
    if (matches(minute, Number(parts.minute)) && matches(hour, Number(parts.hour)) && matches(dayOfMonth, Number(parts.day)) && matches(dayOfWeek, WEEKDAY_INDEX[parts.weekday ?? ""] ?? -1, 7)) out.push(ts);
  }
  return out;
}

/* ------------------------------------------------------------ usage model */

/** requests, input, output, cache read, cache write, cost (micro-USD), failures */
type Vec = [number, number, number, number, number, number, number];
const ZERO: Vec = [0, 0, 0, 0, 0, 0, 0];
const REQ = 0, IN = 1, OUT = 2, CR = 3, CW = 4, COST = 5, FAIL = 6;

interface UsageProfile {
  seed: string;
  /** Totals for the trailing 30 days ending now. */
  targets: Vec;
  /** Sunday..Saturday relative volume. */
  weekdays: readonly number[];
  noise: number;
  growthPerDay: number;
  /** Relative volume by UTC hour. */
  hours: readonly number[];
  historyDays: number;
  /** Day offsets (days before today) with unusual behaviour, for the anomaly cards. */
  spendSpikeDaysAgo?: number;
  incidentDaysAgo?: number;
}

const ORG_HOURS = [0.9, 0.8, 0.8, 0.9, 1.1, 1.5, 2.2, 3.4, 4.9, 5.8, 6.2, 6.3, 5.9, 6.1, 6.4, 6.2, 5.7, 4.9, 3.9, 3.0, 2.3, 1.7, 1.3, 1.0];
const PERSONAL_HOURS = [0.1, 0.05, 0.05, 0.05, 0.1, 0.3, 1.2, 3.5, 6.5, 8.0, 8.4, 7.6, 5.2, 7.4, 8.2, 7.8, 6.4, 4.2, 2.1, 1.6, 1.8, 1.4, 0.6, 0.2];

const ORG_REQUESTS = 3_200_000;
const ORG_PROFILE: UsageProfile = {
  seed: "org",
  targets: [ORG_REQUESTS, 41_800_000_000, 6_900_000_000, 19_400_000_000, 2_300_000_000, 212_000 * 1_000_000, Math.round(ORG_REQUESTS * 0.014)],
  weekdays: [0.31, 1.0, 1.07, 1.1, 1.06, 0.95, 0.38],
  noise: 0.06,
  growthPerDay: 0.0032,
  hours: ORG_HOURS,
  historyDays: 540,
  spendSpikeDaysAgo: 6,
  incidentDaysAgo: 3,
};

const PERSONAL_REQUESTS = 9_400;
const PERSONAL_PROFILE: UsageProfile = {
  seed: "me",
  targets: [PERSONAL_REQUESTS, 262_000_000, 48_000_000, 148_000_000, 14_000_000, 1_386 * 1_000_000, Math.round(PERSONAL_REQUESTS * 0.009)],
  weekdays: [0.12, 1.0, 1.12, 1.18, 1.05, 0.86, 0.2],
  noise: 0.22,
  growthPerDay: 0.0025,
  hours: PERSONAL_HOURS,
  historyDays: 410,
};

function dayVector(profile: UsageProfile, day: number, today: number): Vec {
  const weekday = at(profile.weekdays, new Date(day * DAY).getUTCDay());
  const jitter = (metric: string, amplitude: number) => 1 + amplitude * (unit(`${profile.seed}:${metric}:${day}`) * 2 - 1);
  const base = weekday * Math.exp(profile.growthPerDay * (day - today)) * jitter("volume", profile.noise);
  const daysAgo = today - day;
  const spike = profile.spendSpikeDaysAgo === daysAgo ? 1.24 : 1;
  const failureRate = profile.incidentDaysAgo === daysAgo ? 0.052 : 0.011 + 0.004 * unit(`${profile.seed}:fail:${day}`);
  return [
    base,
    base * jitter("in", 0.05) * spike,
    base * jitter("out", 0.07) * spike,
    base * jitter("cr", 0.06) * spike,
    base * jitter("cw", 0.09),
    base * jitter("cost", 0.07) * spike,
    base * failureRate,
  ];
}

/** Unscaled volume between two instants; nothing is produced after `now`. */
function integrate(profile: UsageProfile, from: number, to: number, now: number): Vec {
  const start = Math.max(from, now - profile.historyDays * DAY);
  const end = Math.min(to, now);
  const out: Vec = [...ZERO];
  if (end <= start) return out;
  const today = Math.floor(now / DAY);
  const hourTotal = profile.hours.reduce((sum, value) => sum + value, 0);
  for (let day = Math.floor(start / DAY); day * DAY < end; day += 1) {
    const vector = dayVector(profile, day, today);
    for (let hour = 0; hour < 24; hour += 1) {
      const hourStart = day * DAY + hour * HOUR;
      const overlap = Math.min(hourStart + HOUR, end) - Math.max(hourStart, start);
      if (overlap <= 0) continue;
      const weight = (at(profile.hours, hour) / hourTotal) * (overlap / HOUR);
      for (let metric = 0; metric < 7; metric += 1) out[metric] = (out[metric] ?? 0) + (vector[metric] ?? 0) * weight;
    }
  }
  return out;
}

/** Per-metric multiplier that turns unscaled volume into the profile's 30-day targets. */
function scaleFor(profile: UsageProfile, now: number): Vec {
  const reference = integrate(profile, now - 30 * DAY, now, now);
  return profile.targets.map((target, metric) => ((reference[metric] ?? 0) > 0 ? target / (reference[metric] as number) : 0)) as Vec;
}

/** Mirrors the API's series bucketing so each range returns the point count production does. */
function usageBucketMs(from: number, to: number): number {
  const duration = Math.max(60_000, to - from);
  if (duration <= 30 * 60_000) return 60_000;
  if (duration <= 3 * HOUR) return 5 * 60_000;
  if (duration <= 24 * HOUR) return 30 * 60_000;
  if (duration <= 7 * DAY) return 6 * HOUR;
  if (duration <= 35 * DAY) return DAY;
  if (duration <= 100 * DAY) return 3 * DAY;
  if (duration <= 370 * DAY) return 30 * DAY;
  return 90 * DAY;
}

interface DimensionRow {
  id: string | null;
  label: string;
  name?: string;
  email?: string;
  /** Share of requests. */
  share: number;
  /** Relative tokens per request. */
  tok?: number;
  /** Relative output share of tokens. */
  out?: number;
  /** Relative cache usage. */
  cache?: number;
  /** Relative cost per request. */
  cost?: number;
  err?: number;
  p50?: number;
  p95?: number;
  group?: string;
}

function rowWeights(row: DimensionRow): Vec {
  const tokens = row.share * (row.tok ?? 1);
  return [
    row.share,
    tokens,
    tokens * (row.out ?? 1),
    tokens * (row.cache ?? 1),
    tokens * (row.cache ?? 1),
    row.share * (row.cost ?? 1),
    row.share * ((row.err ?? 0.014) / 0.014),
  ];
}

type BreakdownRow = UsageAnalytics["breakdowns"][string][number];

function breakdown(dimension: string, rows: readonly DimensionRow[], totals: Vec): BreakdownRow[] {
  const weights = rows.map(rowWeights);
  const parts = [REQ, IN, OUT, CR, CW, COST].map((metric) => allocate(totals[metric] ?? 0, weights.map((weight) => weight[metric] ?? 0)));
  const column = (metric: number, index: number) => parts[metric]?.[index] ?? 0;
  return rows
    .map((row, index): BreakdownRow => ({
      dimension,
      id: row.id,
      label: row.label,
      ...(row.name ? { name: row.name } : {}),
      ...(row.email ? { email: row.email } : {}),
      billedCostMicros: String(column(5, index)),
      requests: column(0, index),
      tokens: column(1, index) + column(2, index),
      inputTokens: column(1, index),
      outputTokens: column(2, index),
      cacheReadTokens: column(3, index),
      cacheWriteTokens: column(4, index),
      errorRate: column(0, index) > 0 ? row.err ?? 0.014 : null,
      latencyP50Ms: row.p50 ?? 1_840,
      latencyP95Ms: row.p95 ?? 9_200,
    }))
    .sort((a, b) => Number(b.billedCostMicros) - Number(a.billedCostMicros));
}

/** Rows kept by a filter and the per-metric fraction of the whole they represent. */
function restrict(rows: readonly DimensionRow[], keep: ((row: DimensionRow) => boolean) | null): { rows: DimensionRow[]; factor: Vec } {
  if (!keep) return { rows: [...rows], factor: [1, 1, 1, 1, 1, 1, 1] };
  const kept = rows.filter(keep);
  const sum = (list: readonly DimensionRow[]) => list.map(rowWeights).reduce<Vec>((acc, weight) => acc.map((value, metric) => value + (weight[metric] ?? 0)) as Vec, [...ZERO]);
  const all = sum(rows);
  const part = sum(kept);
  return { rows: kept, factor: all.map((value, metric) => (value > 0 ? (part[metric] ?? 0) / value : 0)) as Vec };
}

/* --------------------------------------------------------------- catalogs */

interface DemoModel extends DimensionRow {
  id: string;
  group: string;
  ttft: number;
  /** USD per million tokens: input, output, cache read, cache write. */
  price: [number, number, number, number];
  window: number;
  maxOutput: number;
  api: "openai-chat-completions" | "openai-responses" | "anthropic-messages";
  vision: boolean;
}

const MODELS: readonly DemoModel[] = [
  { id: "kimi-2.6", label: "Kimi 2.6", group: "router", share: 0.24, tok: 0.9, out: 0.9, cache: 1.05, cost: 0.3, err: 0.011, p50: 1_450, p95: 6_800, ttft: 480, price: [0.6, 2.5, 0.15, 0.75], window: 262_144, maxOutput: 32_768, api: "openai-chat-completions", vision: false },
  { id: "glm-5.2", label: "GLM 5.2", group: "router", share: 0.16, tok: 0.85, out: 0.95, cache: 0.95, cost: 0.26, err: 0.013, p50: 1_620, p95: 7_400, ttft: 520, price: [0.5, 2.0, 0.1, 0.6], window: 200_000, maxOutput: 32_768, api: "openai-chat-completions", vision: false },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", group: "anthropic", share: 0.21, tok: 1.35, out: 1.1, cache: 1.2, cost: 2.4, err: 0.009, p50: 2_150, p95: 11_600, ttft: 690, price: [3, 15, 0.3, 3.75], window: 200_000, maxOutput: 64_000, api: "anthropic-messages", vision: true },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "anthropic", share: 0.12, tok: 0.8, out: 0.85, cache: 1.1, cost: 0.55, err: 0.008, p50: 980, p95: 4_300, ttft: 310, price: [1, 5, 0.1, 1.25], window: 200_000, maxOutput: 64_000, api: "anthropic-messages", vision: true },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5", group: "anthropic", share: 0.04, tok: 1.6, out: 1.25, cache: 1.15, cost: 6, err: 0.012, p50: 3_900, p95: 19_800, ttft: 1_150, price: [5, 25, 0.5, 6.25], window: 200_000, maxOutput: 32_000, api: "anthropic-messages", vision: true },
  { id: "gpt-5", label: "GPT-5", group: "openai", share: 0.11, tok: 1.1, out: 1.2, cache: 0.8, cost: 1.5, err: 0.031, p50: 2_600, p95: 14_200, ttft: 840, price: [1.25, 10, 0.125, 1.25], window: 400_000, maxOutput: 128_000, api: "openai-responses", vision: true },
  { id: "gpt-5-mini", label: "GPT-5 mini", group: "openai", share: 0.08, tok: 0.6, out: 0.9, cache: 0.75, cost: 0.22, err: 0.027, p50: 1_100, p95: 5_100, ttft: 360, price: [0.25, 2, 0.025, 0.25], window: 400_000, maxOutput: 128_000, api: "openai-responses", vision: true },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", group: "google", share: 0.04, tok: 1.2, out: 1.0, cache: 0.7, cost: 1.3, err: 0.016, p50: 2_300, p95: 12_900, ttft: 760, price: [1.25, 10, 0.31, 1.25], window: 1_048_576, maxOutput: 65_536, api: "openai-chat-completions", vision: true },
];

const PROVIDERS = [
  { id: "router", label: "Berry Router", kind: "berry-router", api: "openai-chat-completions", baseUrl: "https://router.berry.example/v1", auth: "bearer", p95: 7_100 },
  { id: "anthropic", label: "Anthropic", kind: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", auth: "x-api-key", p95: 11_400 },
  { id: "openai", label: "OpenAI", kind: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", auth: "bearer", p95: 13_100 },
  { id: "google", label: "Google Vertex AI", kind: "openai-compatible", api: "openai-chat-completions", baseUrl: "https://aiplatform.googleapis.com/v1/openapi", auth: "bearer", p95: 12_900 },
] as const;

const DEPARTMENTS = [
  { name: "Engineering", seats: 18, headcount: 512, share: 0.34, intensity: 1.6, budget: 82_000 },
  { name: "Product", seats: 6, headcount: 118, share: 0.08, intensity: 1.0, budget: 20_000 },
  { name: "Data Science", seats: 6, headcount: 96, share: 0.14, intensity: 1.5, budget: 36_000 },
  { name: "Sales", seats: 11, headcount: 274, share: 0.06, intensity: 0.7, budget: 16_000 },
  { name: "Support", seats: 10, headcount: 236, share: 0.09, intensity: 0.9, budget: 22_000 },
  { name: "Legal", seats: 2, headcount: 42, share: 0.02, intensity: 0.8, budget: 6_000 },
  { name: "Finance", seats: 4, headcount: 88, share: 0.025, intensity: 0.7, budget: 7_500 },
  { name: "Operations", seats: 6, headcount: 152, share: 0.04, intensity: 0.7, budget: 11_000 },
  { name: "Marketing", seats: 6, headcount: 124, share: 0.045, intensity: 0.8, budget: 12_000 },
  { name: "Security", seats: 3, headcount: 58, share: 0.035, intensity: 1.1, budget: 10_000 },
  { name: "Research", seats: 5, headcount: 84, share: 0.11, intensity: 1.4, budget: 30_000 },
  { name: "People", seats: 3, headcount: 66, share: 0.015, intensity: 0.6, budget: 4_500 },
] as const;
const TOTAL_MEMBERS = DEPARTMENTS.reduce((sum, department) => sum + department.headcount, 0);
const departmentId = (name: string) => `dept_${slugify(name).replace(/-/g, "_")}`;

const FEATURES: readonly DimensionRow[] = [
  { id: "model.turn", label: "Chat and agent turns", share: 0.61, tok: 1.05, cost: 1.08, err: 0.013 },
  { id: "model.subagent", label: "Subagent runs", share: 0.17, tok: 1.3, cost: 1.2, err: 0.017, p95: 13_400 },
  { id: "grounding.search", label: "File and knowledge grounding", share: 0.09, tok: 0.9, out: 0.4, cost: 0.6, err: 0.009, p50: 900, p95: 3_800 },
  { id: "scheduled.task", label: "Scheduled tasks", share: 0.06, tok: 1.1, cost: 0.95, err: 0.021 },
  { id: "prompt.improve", label: "Prompt improvement", share: 0.04, tok: 0.2, cost: 0.12, err: 0.006, p50: 700, p95: 2_100 },
  { id: "image.generate", label: "Image generation", share: 0.02, tok: 0.1, out: 0.2, cache: 0, cost: 1.9, err: 0.024, p50: 8_400, p95: 21_000 },
  { id: "sandbox.exec", label: "Sandbox execution", share: 0.01, tok: 0.3, cache: 0.3, cost: 0.4, err: 0.032, p50: 3_100, p95: 16_500 },
];

const AGENTS: readonly DimensionRow[] = [
  { id: null, label: "Direct chat (no agent)", share: 0.46, tok: 0.8, cost: 0.85 },
  { id: "agent_code_review", label: "Code review agent", share: 0.13, tok: 1.5, cost: 1.5, err: 0.012, p95: 14_800 },
  { id: "agent_research", label: "Deep research agent", share: 0.11, tok: 1.6, cost: 1.6, err: 0.018, p95: 18_200 },
  { id: "agent_data_analyst", label: "Data analyst", share: 0.09, tok: 1.3, cost: 1.2, err: 0.021, p95: 12_600 },
  { id: "agent_support_triage", label: "Support triage", share: 0.08, tok: 0.7, cost: 0.6, err: 0.008, p95: 5_200 },
  { id: "agent_contract_review", label: "Contract review", share: 0.04, tok: 1.4, cost: 1.5, err: 0.01, p95: 13_900 },
  { id: "agent_sales_briefing", label: "Account briefings", share: 0.04, tok: 0.9, cost: 0.8, err: 0.011, p95: 7_700 },
  { id: "agent_incident_scribe", label: "Incident scribe", share: 0.03, tok: 1.0, cost: 0.9, err: 0.015, p95: 8_300 },
  { id: "agent_release_notes", label: "Release notes writer", share: 0.02, tok: 1.1, cost: 1.0, err: 0.009, p95: 9_100 },
];

const WORKSPACES: readonly DimensionRow[] = [
  { id: "ws_general", label: "General", share: 0.38, tok: 0.8, cost: 0.8 },
  { id: "ws_platform_monorepo", label: "Platform monorepo", share: 0.16, tok: 1.5, cost: 1.5 },
  { id: "ws_customer_insights", label: "Customer insights", share: 0.1, tok: 1.2, cost: 1.2 },
  { id: "ws_support_knowledge", label: "Support knowledge base", share: 0.09, tok: 0.8, cost: 0.7 },
  { id: "ws_forecasting", label: "Demand forecasting", share: 0.08, tok: 1.3, cost: 1.3 },
  { id: "ws_contracts", label: "Contracts and procurement", share: 0.06, tok: 1.2, cost: 1.3 },
  { id: "ws_mobile_apps", label: "Mobile apps", share: 0.06, tok: 1.4, cost: 1.4 },
  { id: "ws_security_reviews", label: "Security reviews", share: 0.04, tok: 1.1, cost: 1.1 },
  { id: "ws_brand_studio", label: "Brand studio", share: 0.03, tok: 0.6, cost: 1.0 },
];

const FAILURE_SPLIT: Record<string, number> = { failed: 0.62, cancelled: 0.24, blocked: 0.14 };

const FIRST_NAMES = ["Aisha", "Mateo", "Priya", "Jonas", "Mei", "Oluwaseun", "Sofia", "Daniel", "Yuki", "Fatima", "Lucas", "Ananya", "Henrik", "Camila", "Tariq", "Elena", "Kwame", "Hannah", "Arjun", "Isabelle", "Diego", "Nadia", "Tomasz", "Leila", "Marcus", "Ingrid", "Rahul", "Chloe", "Emeka", "Valentina", "Hiroshi", "Zainab", "Oscar", "Thandiwe", "Felix", "Noor", "Gabriel", "Sana", "Viktor", "Amara", "Beatriz", "Ravi", "Astrid", "Jamal", "Ines", "Kofi", "Lena", "Darius", "Mina", "Pablo"];
const LAST_NAMES = ["Rahman", "Alvarez", "Nair", "Lindqvist", "Chen", "Adeyemi", "Rossi", "Okafor", "Tanaka", "Haddad", "Moreau", "Iyer", "Sorensen", "Vargas", "Aziz", "Petrova", "Mensah", "Becker", "Mehta", "Dubois", "Castillo", "Karimi", "Nowak", "Farouk", "Thompson", "Halvorsen", "Kapoor", "Bennett", "Eze", "Marino", "Sato", "Hussain", "Lund", "Dlamini", "Weber", "Siddiqui", "Santos", "Malik", "Horvat", "Osei"];
const EMAIL_DOMAIN = "northwind.example";

/* ---------------------------------------------------------------- factory */

export function createDemoManagementClient(config: WebConfig, tenantId: string): BerryApiClient {
  const organization = config.organizations.find((entry) => entry.id === tenantId);
  const organizationName = organization?.name ?? "Northwind Global";
  const seed = `demo:${tenantId}`;
  const ago = (days: number, hours = 0) => iso(Date.now() - days * DAY - hours * HOUR);
  const stamp = (days: number) => ({ createdAt: ago(days + 30 + Math.round(unit(`${seed}:created:${days}`) * 200)), updatedAt: ago(days) });

  /* ----------------------------------------------------------- directory */

  const departments: Department[] = DEPARTMENTS.map((department, index) => ({
    id: departmentId(department.name),
    tenantId,
    parentId: null,
    name: department.name,
    slug: slugify(department.name),
    externalId: `grp-${1040 + index * 7}`,
    status: "active",
    createdAt: ago(520 - index * 3),
    updatedAt: ago(3 + index * 4),
  }));

  let memberCache: { members: OrgMembership[]; shares: Map<string, number>; ranked: OrgMembership[] } | null = null;
  /** The whole organization, one row per seat. Built once per client. */
  const directory = () => {
    if (memberCache) return memberCache;
    const random = mulberry32(hash(`${seed}:members`));
    const seats = shuffled(DEPARTMENTS.flatMap((department) => Array.from({ length: department.headcount }, () => department)), random);
    const customRoles = [
      ...Array.from({ length: 24 }, () => "department_lead"), ...Array.from({ length: 12 }, () => "analyst"),
      "billing_manager", "billing_manager", "billing_manager", "security_auditor", "security_auditor", "security_auditor", "security_auditor",
    ];
    const adminCount = 14;
    const privileged = 1 + adminCount + customRoles.length;
    // Everyone with an elevated role stays active; the rest get the invite, suspension and dormancy mix.
    const order = shuffled(Array.from({ length: seats.length - privileged }, (_, index) => index + privileged), random);
    const statuses = new Map<number, OrgMembership["status"]>();
    order.slice(0, PENDING_MEMBERS).forEach((index) => statuses.set(index, "pending"));
    order.slice(PENDING_MEMBERS, PENDING_MEMBERS + 15).forEach((index) => statuses.set(index, "disabled"));
    order.slice(PENDING_MEMBERS + 15, PENDING_MEMBERS + 25).forEach((index) => statuses.set(index, "deprovisioned"));
    const dormant = new Set(order.slice(PENDING_MEMBERS + 25, PENDING_MEMBERS + 25 + DORMANT_MEMBERS));
    const nameSpace = FIRST_NAMES.length * LAST_NAMES.length;
    const members = seats.map((department, index): OrgMembership => {
      // 733 is coprime with the name space, so every seat gets a distinct first/last pair.
      const nameIndex = (index * 733 + 17) % nameSpace;
      const first = at(FIRST_NAMES, nameIndex % FIRST_NAMES.length);
      const last = at(LAST_NAMES, Math.floor(nameIndex / FIRST_NAMES.length));
      const status: OrgMembership["status"] = statuses.get(index) ?? "active";
      const role = index === 0 ? "owner" : index <= adminCount ? "admin" : index < privileged ? at(customRoles, index - adminCount - 1) : "member";
      const sourceRoll = random();
      const source: OrgMembership["source"] = sourceRoll < 0.62 ? "scim" : sourceRoll < 0.9 ? "sso" : "manual";
      const primary = departmentId(department.name);
      const secondary = random() < 0.12 ? departmentId(pick(DEPARTMENTS, random).name) : null;
      const joinedDays = status === "pending" ? 1 + Math.floor(random() * 20) : (dormant.has(index) ? 240 : 20) + Math.floor(random() * 500);
      // `updatedAt` is the last-active time the People screen shows.
      const idleHours = status === "pending" ? joinedDays * 24
        : status !== "active" ? (20 + Math.floor(random() * 380)) * 24
          : dormant.has(index) ? (31 + Math.floor(random() ** 2 * 190)) * 24
            : Math.floor(random() ** 3 * 20 * 24);
      return {
        tenantId,
        userId: `usr_${String(index + 1).padStart(4, "0")}_${hex(`${seed}:usr:${index}`, 6)}`,
        email: `${first}.${last}`.toLowerCase() + `@${EMAIL_DOMAIN}`,
        name: `${first} ${last}`,
        status,
        role,
        departmentIds: secondary && secondary !== primary ? [primary, secondary] : [primary],
        primaryDepartmentId: primary,
        externalId: source === "scim" ? `00u${base36(`${seed}:ext:${index}`, 14).toLowerCase()}` : null,
        source,
        joinedAt: ago(joinedDays),
        updatedAt: iso(Date.now() - Math.min(idleHours * HOUR, joinedDays * DAY)),
      };
    });
    // Share of organization usage for every member who was active in the last 30 days.
    const intensityByDepartment = new Map(DEPARTMENTS.map((department) => [departmentId(department.name), department.intensity]));
    const active = shuffled(members.filter((member, index) => member.status === "active" && !dormant.has(index)), mulberry32(hash(`${seed}:rank`)));
    const raw = active.map((member, rank) => (intensityByDepartment.get(member.primaryDepartmentId ?? "") ?? 1) / (rank + 2.5) ** 0.7);
    const rawTotal = raw.reduce((sum, value) => sum + value, 0);
    const shares = new Map(active.map((member, index) => [member.userId, ((raw[index] ?? 0) / rawTotal) * (1 - UNATTRIBUTED_SHARE)]));
    const ranked = [...active].sort((a, b) => (shares.get(b.userId) ?? 0) - (shares.get(a.userId) ?? 0));
    memberCache = { members, shares, ranked };
    return memberCache;
  };
  const memberShare = (userId: string) => directory().shares.get(userId) ?? 0;
  /** Members with usage in the last 30 days, heaviest first. */
  const rankedMembers = () => directory().ranked;
  const departmentName = (id: string | null | undefined) => departments.find((department) => department.id === id)?.name ?? null;
  const self = () => directory().members[0] as OrgMembership;

  const memberRows = (limit: number): DimensionRow[] => {
    const listed = rankedMembers().slice(0, limit);
    const listedShare = listed.reduce((sum, member) => sum + memberShare(member.userId), 0);
    const otherShare = 1 - UNATTRIBUTED_SHARE - listedShare;
    const intensity = (member: OrgMembership) => 0.85 + 0.5 * unit(`${seed}:tok:${member.userId}`);
    return [
      ...listed.map((member): DimensionRow => ({
        id: member.userId, label: member.name, name: member.name, email: member.email, share: memberShare(member.userId),
        tok: intensity(member), err: 0.006 + 0.02 * unit(`${seed}:err:${member.userId}`), p95: 6_000 + Math.round(9_000 * unit(`${seed}:p95:${member.userId}`)),
      })),
      ...(otherShare > 1e-9 ? [{ id: "members:other", label: `Other members (${(TOTAL_MEMBERS - listed.length).toLocaleString("en-US")})`, share: otherShare, tok: 1.01 }] : []),
      { id: null, label: "Unattributed (service accounts)", share: UNATTRIBUTED_SHARE, tok: 0.7, cost: 0.6, err: 0.019 },
    ];
  };

  const departmentRows: DimensionRow[] = DEPARTMENTS.map((department) => ({
    id: departmentId(department.name), label: department.name, share: department.share,
    tok: 0.7 + department.intensity * 0.3, cost: 0.6 + department.intensity * 0.4,
    err: 0.009 + 0.012 * unit(`${seed}:dept-err:${department.name}`), p95: 7_000 + Math.round(5_000 * unit(`${seed}:dept-p95:${department.name}`)),
  }));

  /* ------------------------------------------------------------ analytics */

  const analytics = (scope: "org" | "me", query: UsageAnalyticsQuery): UsageAnalytics => {
    const profile = scope === "org" ? ORG_PROFILE : PERSONAL_PROFILE;
    const now = Date.now();
    const from = new Date(query.from).getTime();
    const to = new Date(query.to).getTime();
    const scale = scaleFor(profile, now);

    const modelSet = restrict(MODELS, query.model || query.provider ? (row) => (!query.model || row.id === query.model) && (!query.provider || row.group === query.provider) : null);
    const featureSet = restrict(FEATURES, query.feature ? (row) => row.id === query.feature : null);
    const agentSet = restrict(AGENTS, query.agentId ? (row) => row.id === query.agentId : null);
    const workspaceSet = restrict(WORKSPACES, query.workspaceId ? (row) => row.id === query.workspaceId : null);
    const departmentSet = restrict(departmentRows, scope === "org" && query.departmentId ? (row) => row.id === query.departmentId : null);
    const allMembers = scope === "org" && query.memberId ? memberRows(rankedMembers().length) : [];
    const memberFactor = scope === "org" && query.memberId ? restrict(allMembers, (row) => row.id === query.memberId).factor : null;
    const factors = [modelSet.factor, featureSet.factor, agentSet.factor, workspaceSet.factor, departmentSet.factor, ...(memberFactor ? [memberFactor] : [])];
    const factor = scale.map((value, metric) => factors.reduce((acc, item) => acc * (item[metric] ?? 1), value)) as Vec;

    const bucketMs = usageBucketMs(from, to);
    const first = Math.max(from, now - profile.historyDays * DAY);
    const last = Math.min(to, now);
    const series: UsageAnalytics["series"] = [];
    const totals: Vec = [...ZERO];
    for (let bucket = Math.floor(first / bucketMs) * bucketMs; bucket < last; bucket += bucketMs) {
      const volume = integrate(profile, Math.max(bucket, from), Math.min(bucket + bucketMs, to), now);
      const values = volume.map((value, metric) => Math.round(value * (factor[metric] ?? 0))) as Vec;
      const failureRate = values[REQ] > 0 ? Math.min(1, values[FAIL] / values[REQ]) : 0;
      if (query.status) {
        const part = query.status === "completed" ? 1 - failureRate : failureRate * (FAILURE_SPLIT[query.status] ?? 0);
        for (let metric = 0; metric < 6; metric += 1) values[metric] = Math.round((values[metric] ?? 0) * part);
        values[FAIL] = query.status === "completed" ? 0 : values[REQ];
      }
      values[FAIL] = Math.min(values[FAIL], values[REQ]);
      for (let metric = 0; metric < 7; metric += 1) totals[metric] = (totals[metric] ?? 0) + (values[metric] ?? 0);
      series.push({
        ts: iso(bucket),
        billedCostMicros: String(values[COST]),
        requests: values[REQ],
        tokens: values[IN] + values[OUT],
        successes: values[REQ] - values[FAIL],
        failures: values[FAIL],
      });
    }

    const requests = totals[REQ];
    const failures = totals[FAIL];
    const models = breakdown("models", modelSet.rows, totals);
    const providerTotals = new Map<string, BreakdownRow>();
    for (const row of models) {
      const model = MODELS.find((entry) => entry.id === row.id);
      const provider = PROVIDERS.find((entry) => entry.id === model?.group);
      if (!provider) continue;
      const current = providerTotals.get(provider.id);
      providerTotals.set(provider.id, {
        dimension: "providers", id: provider.id, label: provider.label,
        billedCostMicros: String(Number(current?.billedCostMicros ?? 0) + Number(row.billedCostMicros)),
        requests: (current?.requests ?? 0) + row.requests,
        tokens: (current?.tokens ?? 0) + row.tokens,
        inputTokens: (current?.inputTokens ?? 0) + row.inputTokens,
        outputTokens: (current?.outputTokens ?? 0) + row.outputTokens,
        cacheReadTokens: (current?.cacheReadTokens ?? 0) + row.cacheReadTokens,
        cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + row.cacheWriteTokens,
        errorRate: provider.id === "openai" ? 0.029 : provider.id === "google" ? 0.016 : 0.011,
        latencyP50Ms: Math.round(provider.p95 / 5.2),
        latencyP95Ms: provider.p95,
      });
    }
    const statusRows: DimensionRow[] = [
      { id: "completed", label: "Completed", share: requests - failures, err: 0 },
      ...Object.entries(FAILURE_SPLIT).map(([id, part]): DimensionRow => ({
        id, label: id === "blocked" ? "Blocked by limit" : id === "failed" ? "Failed" : "Cancelled", share: failures * part, tok: id === "blocked" ? 0.02 : 0.5, out: 0.3, cost: id === "blocked" ? 0 : 0.4, err: 1,
      })),
    ].filter((row) => !query.status || row.id === query.status);

    const breakdowns: UsageAnalytics["breakdowns"] = {
      models,
      providers: [...providerTotals.values()].sort((a, b) => Number(b.billedCostMicros) - Number(a.billedCostMicros)),
      features: breakdown("features", featureSet.rows, totals),
      statuses: breakdown("statuses", statusRows, totals).map((row) => ({ ...row, errorRate: row.id === "completed" ? 0 : 1 })),
    };
    if (scope === "org") {
      // The default page size (50) lists the top 25 members; larger requests, such as the People screen, get every listed member.
      const memberLimit = query.limit && query.limit > 50 ? rankedMembers().length : 25;
      breakdowns.departments = breakdown("departments", departmentSet.rows, totals);
      breakdowns.members = query.memberId
        ? breakdown("members", allMembers.filter((row) => row.id === query.memberId), totals)
        : breakdown("members", memberRows(memberLimit), totals);
      breakdowns.agents = breakdown("agents", agentSet.rows, totals);
      breakdowns.workspaces = breakdown("workspaces", workspaceSet.rows, totals);
    }

    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
    const monthEnd = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1);
    const monthToDate = integrate(profile, monthStart, now, now)[COST] * factor[COST];
    const recentDaily = (integrate(profile, now - 7 * DAY, now, now)[COST] * factor[COST]) / 7;
    const cacheEligible = Math.round(requests * (scope === "org" ? 0.78 : 0.84));
    const focusedModel = modelSet.rows.length === 1 ? modelSet.rows[0] : undefined;

    const anomalies: UsageAnalytics["anomalies"] = [];
    if (scope === "org" && !query.model && !query.feature && !query.status && !query.memberId) {
      const dayStart = (daysAgo: number) => (Math.floor(now / DAY) - daysAgo) * DAY;
      const inRange = (daysAgo: number) => dayStart(daysAgo) >= from && dayStart(daysAgo) < to && now - profile.historyDays * DAY < dayStart(daysAgo);
      const daily = (daysAgo: number, metric: number) => integrate(profile, dayStart(daysAgo), dayStart(daysAgo) + DAY, now)[metric]! * factor[metric]!;
      if (inRange(6) && (!query.departmentId || query.departmentId === departmentId("Data Science"))) {
        const observed = daily(6, COST) * 0.14 / 1e6;
        anomalies.push({
          id: "anomaly_spend_data_science", kind: "spend", severity: "warning", label: "Data Science spend ran 71% above its baseline",
          baseline: Math.round(observed / 1.71), observed: Math.round(observed), unit: "USD", windowStart: iso(dayStart(6)), windowEnd: iso(dayStart(5)),
          dimension: { kind: "department", id: departmentId("Data Science"), label: "Data Science" },
          explanation: "A batch re-evaluation of the forecasting notebooks sent long-context Claude Opus 4.5 requests without prompt caching for about nine hours.",
        });
      }
      if (inRange(3) && (!query.provider || query.provider === "openai")) {
        const dayRequests = daily(3, REQ) * 0.19;
        anomalies.push({
          id: "anomaly_failures_openai", kind: "failures", severity: "error", label: "OpenAI requests failed at 21.4% for 47 minutes",
          baseline: Math.round(dayRequests * 0.029), observed: Math.round(dayRequests * 0.214), unit: "failed requests", windowStart: iso(dayStart(3) + 13 * HOUR + 12 * 60_000), windowEnd: iso(dayStart(3) + 13 * HOUR + 59 * 60_000),
          dimension: { kind: "provider", id: "openai", label: "OpenAI" },
          explanation: "Upstream 529 responses during a provider incident. The router retried on Berry Router models after the third consecutive failure, so most tasks still completed.",
        });
      }
      if (to >= now - DAY && (!query.departmentId || query.departmentId === departmentId("Engineering"))) {
        const projected = ((monthToDate + recentDaily * Math.max(0, (monthEnd - now) / DAY)) * 0.34) / 1e6;
        anomalies.push({
          id: "anomaly_projection_engineering", kind: "budget_projection", severity: "warning", label: "Engineering is projected to reach its monthly guardrail early",
          baseline: 82_000, observed: Math.round(Math.max(projected, 84_300)), unit: "USD", windowStart: iso(monthStart), windowEnd: iso(monthEnd),
          dimension: { kind: "department", id: departmentId("Engineering"), label: "Engineering" },
          explanation: "At the trailing seven-day run rate Engineering passes its $82,000 soft limit about four days before the cycle resets.",
        });
      }
    }

    return {
      tenantId,
      from: query.from,
      to: query.to,
      totals: {
        billedCostMicros: String(totals[COST]),
        requests,
        tokens: totals[IN] + totals[OUT],
        inputTokens: totals[IN],
        outputTokens: totals[OUT],
        successRate: requests > 0 ? (requests - failures) / requests : null,
        projectedMonthEndMicros: String(Math.round(monthToDate + recentDaily * Math.max(0, (monthEnd - now) / DAY))),
      },
      series,
      breakdowns,
      performance: {
        latencyP50Ms: focusedModel?.p50 ?? 1_840,
        latencyP95Ms: focusedModel?.p95 ?? 9_200,
        ttftP50Ms: 620,
        ttftP95Ms: 2_140,
        cachedTokens: totals[CR],
        cacheReadTokens: totals[CR],
        cacheWriteTokens: totals[CW],
        cacheEligibleRequests: cacheEligible,
        cacheHitRequests: Math.round(cacheEligible * (scope === "org" ? 0.74 : 0.86)),
        sandboxMinutes: Math.round(requests * 0.058),
      },
      anomalies,
      unavailableDimensions: [],
    };
  };

  /* ------------------------------------------------------------- requests */

  const requestRows = new Map<string, UsageRequestSummary>();
  const requestStatuses = [{ id: "completed", weight: 0.88 }, { id: "failed", weight: 0.07 }, { id: "cancelled", weight: 0.03 }, { id: "blocked", weight: 0.02 }] as const;

  const requestRow = (scope: "org" | "me", key: string, ts: number, query: Partial<UsageAnalyticsQuery>): UsageRequestSummary => {
    const random = mulberry32(hash(`${seed}:request:${key}`));
    const models = MODELS.filter((model) => (!query.model || model.id === query.model) && (!query.provider || model.group === query.provider));
    const model = pickWeighted(models.length ? models : MODELS, (item) => item.share, random);
    const status = query.status ?? pickWeighted(requestStatuses, (item) => item.weight, random).id;
    const feature = query.feature ?? (pickWeighted(FEATURES, (item) => item.share, random).id as string);
    const agent = query.agentId ?? pickWeighted(AGENTS, (item) => item.share, random).id;
    const workspace = query.workspaceId ?? pickWeighted(WORKSPACES, (item) => item.share, random).id;
    const ranked = rankedMembers();
    const forcedMember = query.memberId ? directory().members.find((member) => member.userId === query.memberId) : undefined;
    const inDepartment = query.departmentId ? ranked.filter((member) => member.primaryDepartmentId === query.departmentId) : ranked;
    const member = scope === "me" ? self() : forcedMember ?? pickWeighted(inDepartment.length ? inDepartment : ranked, (item) => memberShare(item.userId), random);
    const blocked = status === "blocked";
    const tokensIn = blocked ? 0 : Math.round(1_200 + Math.exp(random() * 5.3) * 850);
    const cacheEligible = !blocked && tokensIn > 4_096 && random() < 0.88;
    const cacheHit = cacheEligible && random() < 0.8;
    const cacheReadTokens = cacheHit ? Math.round(tokensIn * (0.55 + random() * 0.38)) : 0;
    const cacheWriteTokens = cacheEligible ? Math.round((tokensIn - cacheReadTokens) * (cacheHit ? 0.25 + random() * 0.3 : 0.7 + random() * 0.25)) : 0;
    const tokensOut = blocked ? 0 : status === "failed" ? Math.round(random() * 120) : Math.round(60 + Math.exp(random() * 4.7) * 42);
    const ttftMs = blocked ? null : Math.round(model.ttft * (0.6 + random() * 1.6));
    const latencyMs = blocked ? 14 + Math.round(random() * 20) : status === "failed" && random() < 0.4 ? 30_000 + Math.round(random() * 900) : (ttftMs ?? 0) + Math.round(tokensOut * (9 + random() * 14));
    const [inputPrice, outputPrice, readPrice, writePrice] = model.price;
    const cost = ((tokensIn - cacheReadTokens - cacheWriteTokens) * inputPrice + cacheReadTokens * readPrice + cacheWriteTokens * writePrice + tokensOut * outputPrice);
    const id = `ue_${hex(`${seed}:ue:${key}`, 20)}`;
    const row: UsageRequestSummary = {
      id,
      requestId: `req_${base36(`${seed}:rid:${key}`, 22)}`,
      ts: iso(ts),
      userId: member.userId,
      departmentId: member.primaryDepartmentId ?? null,
      workspaceId: workspace,
      userName: member.name,
      userEmail: member.email,
      departmentName: departmentName(member.primaryDepartmentId),
      agentId: agent,
      feature,
      provider: model.group,
      model: model.id,
      status,
      tokensIn,
      tokensOut,
      tokensCached: cacheReadTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheEligible,
      cacheMissReason: cacheEligible && !cacheHit ? pick(["prefix_changed", "ttl_expired", "first_request_in_session"], random) : null,
      finishReason: status === "completed" ? pickWeighted([{ id: "stop", weight: 0.58 }, { id: "tool_calls", weight: 0.38 }, { id: "length", weight: 0.04 }], (item) => item.weight, random).id
        : status === "failed" ? pick(["provider_error", "timeout", "context_length_exceeded", "rate_limited"], random)
          : status === "cancelled" ? "cancelled" : "allowance_exhausted",
      billedCostMicros: String(Math.round(Math.max(0, cost))),
      latencyMs,
      ttftMs,
      reservationStatus: status === "completed" ? "reconciled" : blocked ? "blocked" : "released",
    };
    requestRows.set(id, row);
    return row;
  };

  const requestPage = (scope: "org" | "me", query: UsageAnalyticsQuery): UsageRequestPage => {
    const limit = Math.max(1, Math.min(100, query.limit ?? 50));
    const page = query.cursor ? Number(query.cursor.split(":")[1] ?? 0) || 0 : 0;
    const maxPages = 6;
    const from = new Date(query.from).getTime();
    const end = Math.min(new Date(query.to).getTime(), Date.now());
    // Requests arrive every few seconds across the organization and every few minutes for one person.
    const meanGap = scope === "org" ? (query.memberId ? 240_000 : query.departmentId || query.model || query.status ? 45_000 : 7_000) : 210_000;
    const filterKey = JSON.stringify([query.departmentId, query.memberId, query.model, query.provider, query.feature, query.status, query.workspaceId, query.agentId]);
    // Anchor to a coarse clock so reloads within the same window list the same rows.
    const anchor = Math.floor(end / (scope === "org" ? 60_000 : 600_000)) * (scope === "org" ? 60_000 : 600_000);
    const items: UsageRequestSummary[] = [];
    let ts = anchor - page * limit * meanGap;
    for (let index = 0; index < limit; index += 1) {
      const key = `${scope}:${filterKey}:${anchor}:${page}:${index}`;
      ts -= Math.round(meanGap * (0.15 + 1.7 * unit(`${seed}:gap:${key}`)));
      if (ts < from) break;
      items.push(requestRow(scope, key, ts, query));
    }
    const hasMore = items.length === limit && page + 1 < maxPages;
    return { items, nextCursor: hasMore ? `page:${page + 1}` : null, hasMore };
  };

  const requestDetail = (requestId: string): UsageRequestDetail => {
    const row = requestRows.get(requestId) ?? requestRow("org", `detail:${requestId}`, Date.now() - Math.round(unit(`${seed}:detail-ts:${requestId}`) * 6 * HOUR), {});
    const model = MODELS.find((entry) => entry.id === row.model);
    return {
      ...row,
      id: requestId,
      taskId: `task_${hex(`${seed}:task:${requestId}`, 16)}`,
      sessionId: `sess_${hex(`${seed}:sess:${requestId}`, 16)}`,
      sandboxId: row.feature === "sandbox.exec" || row.agentId === "agent_data_analyst" ? `sbx_${hex(`${seed}:sbx:${requestId}`, 12)}` : null,
      reservationId: `rsv_${hex(`${seed}:rsv:${requestId}`, 16)}`,
      safeMetadata: {
        routerRegion: at(["eu-west-1", "eu-central-1", "us-east-1"], hash(requestId)),
        upstreamRequestId: `up_${hex(`${seed}:up:${requestId}`, 18)}`,
        apiType: model?.api ?? "openai-chat-completions",
        attempt: row.status === "failed" ? 3 : 1,
        fallbackUsed: row.status === "failed",
        streamed: true,
        toolCalls: row.finishReason === "tool_calls" ? 1 + (hash(requestId) % 6) : 0,
        reasoningEffort: at(["medium", "high", "low", "medium"], hash(`${requestId}:effort`)),
        priceSnapshot: ago(1).slice(0, 10),
        contextWindowTokens: model?.window ?? null,
        clientSurface: at(["web", "web", "mobile", "scheduled", "api"], hash(`${requestId}:surface`)),
      },
    };
  };

  const csv = (rows: readonly UsageRequestSummary[]) => [
    "timestamp,request_id,feature,provider,model,status,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,billed_usd,latency_ms,finish_reason",
    ...rows.map((row) => [row.ts, row.requestId, row.feature, row.provider ?? "", row.model ?? "", row.status, row.tokensIn, row.tokensOut, row.cacheReadTokens, row.cacheWriteTokens, (Number(row.billedCostMicros) / 1e6).toFixed(6), row.latencyMs ?? "", row.finishReason ?? ""].join(",")),
  ].join("\n");

  /* ----------------------------------------------------------- allowances */

  const profileSeeds = [
    { id: "alw_standard", name: "Standard", description: "Default monthly allowance for every member.", limit: 250 },
    { id: "alw_knowledge", name: "Knowledge worker", description: "Support, Sales and Operations teams with daily assistant use.", limit: 500 },
    { id: "alw_power", name: "Power user", description: "Analysts and leads running agents most of the day.", limit: 1_000 },
    { id: "alw_builder", name: "Builder", description: "Engineering, Data Science and Research with long-context coding and research agents.", limit: 2_500 },
    { id: "alw_principal", name: "Principal", description: "Staff engineers and research leads approved for heavy agent workloads.", limit: 5_000 },
  ] as const;
  const departmentProfile: Record<string, string> = {
    Engineering: "alw_builder", "Data Science": "alw_builder", Research: "alw_builder", Security: "alw_power", Product: "alw_power",
    Support: "alw_knowledge", Sales: "alw_knowledge", Operations: "alw_knowledge",
  };
  const profileLimit = (id: string) => profileSeeds.find((profile) => profile.id === id)?.limit ?? 250;
  const cycleBounds = () => {
    const now = new Date();
    return { start: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), end: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) };
  };

  const adjustments = (): AllowanceAdjustment[] => {
    const { start, end } = cycleBounds();
    const ranked = rankedMembers();
    const admins = directory().members.filter((member) => member.role === "admin" || member.role === "owner");
    const reasons = [
      "Quarter-end forecasting sprint approved by the department lead",
      "Migration of the billing service to the new platform — extra agent runs",
      "Security review backlog for the vendor audit",
      "Customer escalation: bulk transcript analysis",
      "Onboarding cohort workshop week",
      "Research benchmark re-run after the model upgrade",
      "Incident postmortem drafting and log analysis",
      "Contract renewal season — document review surge",
    ];
    const elapsed = Math.max(HOUR, Date.now() - start);
    return Array.from({ length: 14 }, (_, index): AllowanceAdjustment => {
      const member = at(ranked, index * 3 + (index % 2));
      const createdAt = start + Math.round(elapsed * (0.05 + 0.93 * unit(`${seed}:adj-at:${index}`)));
      return {
        id: `adj_${hex(`${seed}:adj:${index}`, 12)}`,
        tenantId,
        userId: member.userId,
        amountMicros: usd(at([100, 250, 500, 150, 1_000, 250, 750, 300, 1_500, 200], index)),
        reason: at(reasons, index),
        idempotencyKey: `topup-${hex(`${seed}:adj-key:${index}`, 16)}`,
        cycleStart: iso(start),
        cycleEnd: iso(end),
        createdBy: at(admins, index).userId,
        createdAt: iso(createdAt),
      };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };

  const balances = (): AllowanceBalance[] => {
    const { start, end } = cycleBounds();
    const now = Date.now();
    const cycleSpend = integrate(ORG_PROFILE, start, now, now)[COST] * scaleFor(ORG_PROFILE, now)[COST];
    const topUps = new Map<string, number>();
    for (const adjustment of adjustments()) topUps.set(adjustment.userId, (topUps.get(adjustment.userId) ?? 0) + Number(adjustment.amountMicros));
    return directory().members.map((member, index): AllowanceBalance => {
      const used = Math.round(cycleSpend * memberShare(member.userId));
      const adjustment = topUps.get(member.userId) ?? 0;
      const reserved = used > 0 ? Math.round(unit(`${seed}:reserved:${member.userId}`) ** 3 * 4_200_000) : 0;
      const base = { tenantId, userId: member.userId, userName: member.name, userEmail: member.email, cycleStart: iso(start), cycleEnd: iso(end), usedMicros: String(used), reservedMicros: String(reserved), adjustmentMicros: String(adjustment) };
      if (member.role === "owner" || index === 3) {
        return { ...base, baseLimitMicros: null, effectiveLimitMicros: null, availableMicros: null, status: "unlimited", baseSource: "unlimited", baseSourceId: null };
      }
      const department = DEPARTMENTS.find((entry) => departmentId(entry.name) === member.primaryDepartmentId);
      const assigned = department ? departmentProfile[department.name] : undefined;
      const roll = unit(`${seed}:limit:${member.userId}`);
      let limit = profileLimit(assigned ?? "alw_standard") * 1_000_000;
      let source: AllowanceBalance["baseSource"] = assigned ? "department" : "organization";
      let sourceId: string | null = assigned ? member.primaryDepartmentId ?? null : null;
      const projected = memberShare(member.userId) * ORG_PROFILE.targets[COST];
      if (used > 0 && roll < 0.015) {
        // Out of allowance until an admin tops them up.
        limit = Math.max(10_000_000, Math.floor((used - adjustment) / 10_000_000) * 10_000_000);
        source = "member"; sourceId = member.userId;
      } else if (used > 0 && roll < 0.075) {
        limit = Math.max(10_000_000, Math.round((used / 0.88 - adjustment) / 5_000_000) * 5_000_000);
        source = "member"; sourceId = member.userId;
      } else if (projected * 1.2 > limit + adjustment) {
        // Heavy users were given an individual base that fits their workload.
        limit = ([500, 1_000, 2_500, 5_000, 7_500, 10_000, 15_000].find((tier) => tier * 1_000_000 >= projected * 1.25) ?? 20_000) * 1_000_000;
        source = "member"; sourceId = member.userId;
      }
      const effective = limit + adjustment;
      const available = Math.max(0, effective - used - reserved);
      const ratio = effective > 0 ? (used + reserved) / effective : 1;
      return {
        ...base,
        baseLimitMicros: String(limit),
        effectiveLimitMicros: String(effective),
        availableMicros: String(available),
        status: available <= 0 ? "blocked" : ratio >= 0.8 ? "warning" : "healthy",
        baseSource: source,
        baseSourceId: sourceId,
      };
    });
  };

  /* -------------------------------------------------------------- billing */

  const ledger = () => {
    // A coarse clock keeps the ledger and the billing summary identical when loaded side by side.
    const now = Math.floor(Date.now() / 300_000) * 300_000;
    const scale = scaleFor(ORG_PROFILE, now)[COST];
    const today = Math.floor(now / DAY);
    const admin = directory().members[1] as OrgMembership;
    type Entry = Awaited<ReturnType<BerryApiClient["billingLedger"]>>["items"][number];
    const entries: Entry[] = [];
    let balance = 141_300_000_000;
    const push = (kind: Entry["kind"], amount: number, source: string, externalRef: string | null, actorUserId: string | null, ts: number, status = "settled") => {
      balance += amount;
      entries.push({ id: `led_${hex(`${seed}:ledger:${entries.length}`, 14)}`, tenantId, kind, amountMicros: String(Math.round(amount)), balanceAfterMicros: String(Math.round(balance)), source, externalRef, actorUserId, status, createdAt: iso(ts) });
    };
    for (let daysAgo = 21; daysAgo >= 1; daysAgo -= 1) {
      const dayStart = (today - daysAgo) * DAY;
      const spend = Math.round(integrate(ORG_PROFILE, dayStart, dayStart + DAY, now)[COST] * scale);
      push("reconciliation", -spend, "usage", `usage-${iso(dayStart).slice(0, 10)}`, null, dayStart + DAY + 14 * 60_000);
      if (balance < 50_000_000_000) push("purchase", 100_000_000_000, "stripe", `pi_3${base36(`${seed}:pi:${daysAgo}`, 22)}`, null, dayStart + DAY + 16 * 60_000);
      if (daysAgo === 17) push("grant", 25_000_000_000, "support", "CASE-48211", admin.userId, dayStart + 15 * HOUR);
      if (daysAgo === 11) push("refund", 1_840_000_000, "stripe", `re_3${base36(`${seed}:re`, 22)}`, null, dayStart + 9 * HOUR);
      if (daysAgo === 5) push("adjustment", -612_400_000, "manual", "Q3 true-up for image generation metering", admin.userId, dayStart + 11 * HOUR);
    }
    const openReservations = Math.round(integrate(ORG_PROFILE, now - 20 * 60_000, now, now)[COST] * scale);
    push("reservation", -openReservations, "usage", null, null, now - 4 * 60_000, "open");
    return { entries: entries.reverse(), balance: Math.round(balance) };
  };

  /* ----------------------------------------------------------- connectors */

  const connector = (input: Pick<Connector, "id" | "name" | "description"> & Partial<Connector>): Connector => ({
    key: input.id,
    kind: "custom_mcp",
    provider: "custom",
    enabled: true,
    maxAccessLevel: "full",
    workspaceAccessMode: null,
    authStrategy: "personal",
    authType: "oauth",
    publicationStatus: "published",
    approvalStatus: "approved",
    serverApproved: true,
    transport: "streamable-http",
    url: null,
    websiteUrl: null,
    privacyPolicyUrl: null,
    configured: true,
    credentialConfigured: true,
    connectionStatus: "not_connected",
    connectedAccessLevel: null,
    accountEmail: null,
    grantedScopes: [],
    services: [],
    tools: [],
    limitations: [],
    createdAt: ago(120),
    updatedAt: ago(6),
    ...input,
  });

  const organizationConnectors = (): Connector[] => {
    const me = self();
    return [
      connector({ id: "google-workspace", kind: "app", provider: "google", name: "Google Drive", description: "Search and read Docs, Sheets and Slides the member can already open.", workspaceAccessMode: "search_workspace", transport: null, connectionStatus: "connected", connectedAccessLevel: "read", accountEmail: me.email, grantedScopes: ["drive.readonly", "documents.readonly", "spreadsheets.readonly"], services: ["Drive", "Docs", "Sheets", "Slides"], tools: ["drive_search", "docs_read", "sheets_read", "slides_read", "drive_export"], maxAccessLevel: "read", createdAt: ago(310), updatedAt: ago(12) }),
      connector({ id: "gmail", kind: "app", provider: "google", name: "Gmail", description: "Read, search and draft email on the member's behalf.", transport: null, connectionStatus: "connected", connectedAccessLevel: "full", accountEmail: me.email, grantedScopes: ["gmail.readonly", "gmail.compose"], services: ["Gmail"], tools: ["gmail_search", "gmail_read_thread", "gmail_create_draft", "gmail_get_attachment"], limitations: ["Sending always asks for confirmation."], createdAt: ago(310), updatedAt: ago(9) }),
      connector({ id: "google-calendar", kind: "app", provider: "google", name: "Google Calendar", description: "Check availability and propose or create events.", transport: null, connectionStatus: "reauth_required", connectedAccessLevel: "read", accountEmail: me.email, grantedScopes: ["calendar.readonly"], services: ["Calendar"], tools: ["calendar_list_events", "calendar_free_busy", "calendar_create_event"], createdAt: ago(310), updatedAt: ago(2) }),
      connector({ id: "mcp_jira", name: "Jira", description: "Search issues, read sprints and file tickets in the Northwind Jira site.", url: "https://mcp.atlassian.example/v1/mcp", websiteUrl: "https://www.atlassian.com/software/jira", privacyPolicyUrl: "https://www.atlassian.com/legal/privacy-policy", connectionStatus: "connected", connectedAccessLevel: "full", accountEmail: me.email, grantedScopes: ["read:jira-work", "write:jira-work"], tools: ["jira_search", "jira_get_issue", "jira_create_issue", "jira_add_comment", "jira_transition_issue", "jira_list_sprints"], createdAt: ago(240), updatedAt: ago(4) }),
      connector({ id: "mcp_confluence", name: "Confluence", description: "Search and read engineering, product and policy spaces.", url: "https://mcp.atlassian.example/v1/confluence", websiteUrl: "https://www.atlassian.com/software/confluence", connectionStatus: "connected", connectedAccessLevel: "full", accountEmail: me.email, grantedScopes: ["read:confluence-content.all"], tools: ["confluence_search", "confluence_get_page", "confluence_list_spaces"], createdAt: ago(238), updatedAt: ago(21) }),
      connector({ id: "mcp_github", name: "GitHub Enterprise", description: "Read repositories, pull requests and code search across the northwind organization.", url: "https://mcp.github.example/mcp", websiteUrl: "https://github.com", connectionStatus: "connected", connectedAccessLevel: "full", accountEmail: me.email, grantedScopes: ["repo", "read:org"], tools: ["search_code", "get_pull_request", "list_pull_requests", "create_pull_request_review", "get_file_contents", "list_commits", "create_issue", "list_workflow_runs"], createdAt: ago(226), updatedAt: ago(1) }),
      connector({ id: "mcp_salesforce", name: "Salesforce", description: "Account, opportunity and case lookups for Sales and Support.", url: "https://mcp.salesforce.example/mcp", websiteUrl: "https://www.salesforce.com", tools: ["soql_query", "get_account", "get_opportunity", "list_cases", "update_case"], createdAt: ago(190), updatedAt: ago(15) }),
      connector({ id: "mcp_snowflake", name: "Snowflake", description: "Read-only SQL against the analytics warehouse through a governed role.", url: "https://mcp.data.northwind.example/snowflake", authStrategy: "shared", authType: "bearer", connectionStatus: "connected", connectedAccessLevel: "full", tools: ["run_query", "list_schemas", "describe_table"], limitations: ["Queries run as ANALYST_RO and time out after 120 seconds."], createdAt: ago(172), updatedAt: ago(8) }),
      connector({ id: "mcp_servicenow", name: "ServiceNow", description: "Incident, change and knowledge article access for Operations.", url: "https://mcp.servicenow.example/mcp", websiteUrl: "https://www.servicenow.com", tools: ["get_incident", "search_incidents", "create_change_request", "search_knowledge"], createdAt: ago(150), updatedAt: ago(33) }),
      connector({ id: "mcp_slack", name: "Slack", description: "Search public channels and post summaries to channels the member belongs to.", url: "https://mcp.slack.example/mcp", websiteUrl: "https://slack.com", connectionStatus: "connected", connectedAccessLevel: "full", accountEmail: me.email, grantedScopes: ["search:read", "chat:write"], tools: ["search_messages", "post_message", "list_channels", "get_thread"], createdAt: ago(141), updatedAt: ago(3) }),
      connector({ id: "mcp_notion", name: "Notion", description: "Product specs and team wikis.", url: "https://mcp.notion.example/mcp", websiteUrl: "https://www.notion.so", tools: ["search", "get_page", "query_database", "append_block"], createdAt: ago(118), updatedAt: ago(40) }),
      connector({ id: "mcp_pagerduty", name: "PagerDuty", description: "On-call schedules and incident timelines for the incident scribe agent.", url: "https://mcp.pagerduty.example/mcp", authStrategy: "shared", authType: "bearer", connectionStatus: "connected", connectedAccessLevel: "full", tools: ["list_incidents", "get_incident_timeline", "who_is_on_call"], createdAt: ago(96), updatedAt: ago(5) }),
      connector({ id: "mcp_datadog", name: "Datadog", description: "Metrics, monitors and log queries.", url: "https://mcp.datadoghq.example/mcp", authStrategy: "shared", authType: "bearer", enabled: false, publicationStatus: "draft", connectionStatus: "error", tools: ["query_metrics", "search_logs"], limitations: ["Last discovery failed: 401 from the upstream server."], createdAt: ago(44), updatedAt: ago(2) }),
      connector({ id: "mcp_req_linear", name: "Linear", description: "Requested by Product for roadmap triage.", url: "https://mcp.linear.example/sse", transport: "http-sse", enabled: false, publicationStatus: "draft", approvalStatus: "pending", serverApproved: false, configured: false, credentialConfigured: false, createdAt: ago(3), updatedAt: ago(3) }),
      connector({ id: "mcp_req_figma", name: "Figma", description: "Requested by Marketing for design handoff summaries.", url: "https://mcp.figma.example/mcp", enabled: false, publicationStatus: "draft", approvalStatus: "pending", serverApproved: false, configured: false, credentialConfigured: false, createdAt: ago(2), updatedAt: ago(2) }),
      connector({ id: "mcp_req_hubspot", name: "HubSpot", description: "Requested by Sales operations for campaign reporting.", url: "https://mcp.hubspot.example/mcp", enabled: false, publicationStatus: "draft", approvalStatus: "pending", serverApproved: false, configured: false, credentialConfigured: false, authType: "bearer", createdAt: ago(1), updatedAt: ago(1) }),
      connector({ id: "mcp_req_pastebin", name: "Paste relay", description: "Rejected: unverified publisher and no privacy policy.", url: "https://paste-relay.example/mcp", authType: "none", enabled: false, publicationStatus: "draft", approvalStatus: "rejected", serverApproved: false, configured: false, credentialConfigured: false, createdAt: ago(19), updatedAt: ago(18) }),
    ];
  };

  /* ---------------------------------------------------------- capabilities */

  const skillSeeds = [
    { id: "code-review", description: "Structured pull request review with severity-ranked findings.", assignment: "required", disable: false, bytes: 48_211, resources: ["checklists/security.md", "checklists/performance.md"] },
    { id: "incident-postmortem", description: "Blameless postmortem drafts from timelines, logs and chat exports.", assignment: "default-on", disable: true, bytes: 21_904, resources: ["templates/postmortem.md"] },
    { id: "brand-voice", description: "Northwind tone, terminology and formatting rules for customer-facing writing.", assignment: "required", disable: false, bytes: 9_377, resources: [] },
    { id: "deep-research", description: "Conduct extensive multi-source research when explicitly requested.", assignment: "default-on", disable: true, bytes: 15_660, resources: [] },
    { id: "sql-analyst", description: "Warehouse conventions, approved marts and query review rules for Snowflake.", assignment: "default-on", disable: true, bytes: 132_480, resources: ["schemas/marts.yaml", "scripts/explain.py"] },
    { id: "contract-review", description: "Clause extraction and risk flags against the legal playbook.", assignment: "available", disable: true, bytes: 284_113, resources: ["playbook/msa.md", "playbook/dpa.md", "playbook/order-form.md"] },
    { id: "support-reply", description: "Draft support replies grounded in the knowledge base and case history.", assignment: "default-on", disable: true, bytes: 18_042, resources: ["macros/refunds.md"] },
    { id: "release-notes", description: "Turn merged pull requests into customer-ready release notes.", assignment: "available", disable: true, bytes: 7_815, resources: [] },
    { id: "forecast-review", description: "Finance forecast variance commentary using the monthly close pack.", assignment: "available", disable: true, bytes: 64_702, resources: ["templates/variance.xlsx"] },
    { id: "security-questionnaire", description: "Answer vendor security questionnaires from approved control statements.", assignment: "available", disable: true, bytes: 96_338, resources: ["controls/soc2.md", "controls/iso27001.md"] },
    { id: "interview-kit", description: "Structured interview plans and scorecards for People partners.", assignment: "available", disable: true, bytes: 12_260, resources: [] },
    { id: "slide-builder", description: "Build decks in the Northwind template with speaker notes.", assignment: "default-on", disable: true, bytes: 1_904_332, resources: ["template/northwind.pptx", "scripts/build.py"] },
    { id: "pii-redaction", description: "Redact personal data before content leaves a task.", assignment: "required", disable: false, bytes: 5_120, resources: [] },
    { id: "shadow-scraper", description: "Blocked: scrapes third-party sites against their terms.", assignment: "blocked", disable: false, bytes: 3_402, resources: [] },
  ] as const;
  const mcpSeeds = [
    { id: "mcp_jira", name: "Jira", description: "Issue search and ticket creation.", assignment: "default-on", url: "https://mcp.atlassian.example/v1/mcp" },
    { id: "mcp_confluence", name: "Confluence", description: "Engineering, product and policy spaces.", assignment: "default-on", url: "https://mcp.atlassian.example/v1/confluence" },
    { id: "mcp_github", name: "GitHub Enterprise", description: "Repositories, pull requests and code search.", assignment: "default-on", url: "https://mcp.github.example/mcp" },
    { id: "mcp_snowflake", name: "Snowflake", description: "Governed read-only analytics warehouse.", assignment: "available", url: "https://mcp.data.northwind.example/snowflake" },
    { id: "mcp_salesforce", name: "Salesforce", description: "Accounts, opportunities and cases.", assignment: "available", url: "https://mcp.salesforce.example/mcp" },
    { id: "mcp_servicenow", name: "ServiceNow", description: "Incidents, changes and knowledge.", assignment: "available", url: "https://mcp.servicenow.example/mcp" },
    { id: "mcp_pagerduty", name: "PagerDuty", description: "On-call schedules and incident timelines.", assignment: "required", url: "https://mcp.pagerduty.example/mcp" },
    { id: "mcp_public_web_fetch", name: "Open web fetch", description: "Blocked: unrestricted outbound fetch bypasses the egress allowlist.", assignment: "blocked", url: "https://fetch.mcp.example/mcp" },
  ] as const;
  const skillContent = (id: string, description: string) => `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\n${description}\n\n## When to use\n\nUse this skill when the request matches the description above. Confirm the scope with the requester before producing a long deliverable.\n\n## Steps\n\n1. Gather the source material the requester named.\n2. Apply the checklist in this package.\n3. Report findings first, then supporting detail.\n`;

  const organizationCapabilities = (): OrgCapability[] => [
    ...skillSeeds.map((skill, index): OrgCapability => ({
      id: `cap_skill_${skill.id.replace(/-/g, "_")}`, tenantId, kind: "skill", capabilityId: skill.id, name: skill.id, description: skill.description,
      assignment: skill.assignment, allowUserDisable: skill.disable, contentHash: hex(`${seed}:skill:${skill.id}`, 64), config: { content: skillContent(skill.id, skill.description) },
      resources: [...skill.resources], packageBytes: skill.bytes, createdAt: ago(300 - index * 14), updatedAt: ago(2 + index * 5),
    })),
    ...mcpSeeds.map((server, index): OrgCapability => ({
      id: `cap_${server.id}`, tenantId, kind: "mcp", capabilityId: server.id, name: server.name, description: server.description,
      assignment: server.assignment, allowUserDisable: server.assignment !== "required" && server.assignment !== "blocked", contentHash: null, config: { url: server.url, transport: "streamable-http" },
      resources: [], packageBytes: 0, createdAt: ago(240 - index * 17), updatedAt: ago(4 + index * 6),
    })),
  ];

  const personalSkills = (): PersonalSkill[] => {
    const me = self();
    const seeds = [
      { name: "weekly-status", description: "Compile my weekly status from merged pull requests, Jira and calendar.", source: "text", enabled: true, bytes: 2_840 },
      { name: "rfc-outline", description: "Outline an engineering RFC in the platform team's format.", source: "text", enabled: true, bytes: 3_112 },
      { name: "sql-style", description: "My preferred SQL formatting and CTE naming conventions.", source: "text", enabled: true, bytes: 1_506 },
      { name: "meeting-notes", description: "Turn a transcript into decisions, owners and follow-ups.", source: "upload", enabled: true, bytes: 18_774 },
      { name: "terraform-review", description: "Review Terraform plans for drift, blast radius and tagging.", source: "git", enabled: true, bytes: 96_208 },
      { name: "one-on-one-prep", description: "Prepare talking points for 1:1s from the last two weeks of notes.", source: "text", enabled: false, bytes: 1_988 },
      { name: "changelog-digest", description: "Summarise upstream dependency changelogs for the monthly upgrade.", source: "git", enabled: false, bytes: 41_330 },
    ] as const;
    return seeds.map((skill, index): PersonalSkill => ({
      id: `psk_${hex(`${seed}:psk:${skill.name}`, 12)}`, tenantId, userId: me.userId, name: skill.name, description: skill.description,
      content: skillContent(skill.name, skill.description), enabled: skill.enabled, trusted: skill.source !== "git" || index !== 6,
      source: skill.source, sourceUrl: skill.source === "git" ? `https://github.example/northwind/skills/tree/main/${skill.name}` : null,
      version: skill.source === "git" ? `1.${index}.0` : null, hash: hex(`${seed}:psk-hash:${skill.name}`, 64),
      diagnostics: index === 6 ? ["Package includes a shell script; review before trusting."] : [],
      resources: skill.source === "text" ? [] : ["README.md", "scripts/run.sh"], packageBytes: skill.bytes,
      createdAt: ago(160 - index * 19), updatedAt: ago(1 + index * 6),
    }));
  };

  const personalMcpServers = (): PersonalMcpServer[] => {
    const me = self();
    const seeds = [
      { name: "Local docs index", url: "https://docs-mcp.northwind.example/mcp", transport: "streamable-http", auth: "oauth", health: "healthy", tools: 6, enabled: true, trusted: true },
      { name: "Sentry", url: "https://mcp.sentry.example/sse", transport: "http-sse", auth: "oauth", health: "healthy", tools: 11, enabled: true, trusted: true },
      { name: "Grafana staging", url: "https://grafana-mcp.staging.northwind.example/mcp", transport: "streamable-http", auth: "bearer", health: "unauthorized", tools: 0, enabled: true, trusted: false },
      { name: "Feature flag console", url: "https://flags-mcp.northwind.example/mcp", transport: "streamable-http", auth: "bearer", health: "healthy", tools: 4, enabled: false, trusted: true },
      { name: "Design tokens", url: "https://tokens.design.northwind.example/sse", transport: "http-sse", auth: "none", health: "unreachable", tools: 0, enabled: false, trusted: false },
    ] as const;
    return seeds.map((server, index): PersonalMcpServer => ({
      id: `pmcp_${hex(`${seed}:pmcp:${server.name}`, 12)}`, tenantId, userId: me.userId, name: server.name, url: server.url, transport: server.transport, auth: server.auth,
      credentialRef: server.auth === "none" ? null : `vault:personal/mcp/${slugify(server.name)}`, credentialConfigured: server.auth !== "none",
      enabled: server.enabled, trusted: server.trusted, health: server.health, toolCount: server.tools, lastCheckedAt: ago(0, 1 + index * 7),
      diagnostics: server.health === "unauthorized" ? ["The server returned 401. The token may have expired."] : server.health === "unreachable" ? ["Connection timed out after 10 seconds."] : [],
      createdAt: ago(90 - index * 11), updatedAt: ago(index * 3),
    }));
  };

  const effectiveCapabilities = (): EffectiveCapability[] => [
    ...organizationCapabilities().map((capability, index): EffectiveCapability => {
      const blocked = capability.assignment === "blocked";
      const userDisabled = capability.assignment === "default-on" && index % 5 === 3;
      const userEnabled = capability.assignment === "available" && index % 3 === 0;
      const content = capability.kind === "skill" ? skillContent(capability.capabilityId, capability.description) : undefined;
      return {
        kind: capability.kind, capabilityId: capability.capabilityId, name: capability.name,
        enabled: blocked ? false : capability.assignment === "required" || (capability.assignment === "default-on" && !userDisabled) || userEnabled,
        locked: blocked || capability.assignment === "required" || !capability.allowUserDisable, assignment: capability.assignment, provenance: "organization",
        reason: blocked ? "blocked" : capability.assignment === "required" ? "required" : userDisabled ? "user-disabled" : userEnabled ? "user-enabled" : capability.assignment === "default-on" ? "default" : "available",
        contentHash: capability.contentHash, description: capability.description, ...(content ? { content } : {}),
        packageFiles: capability.kind === "skill" ? ["SKILL.md", ...capability.resources] : [],
        packageStorage: capability.kind === "skill" ? (capability.resources.length ? "stored" : "definition-only") : "managed",
        packageBytes: capability.packageBytes,
      };
    }),
    ...personalSkills().map((skill): EffectiveCapability => ({
      kind: "skill", capabilityId: skill.id, name: skill.name, enabled: skill.enabled, locked: false, assignment: null, provenance: "personal", reason: "personal",
      contentHash: skill.hash, description: skill.description, content: skill.content, packageFiles: ["SKILL.md", ...skill.resources], packageStorage: skill.resources.length ? "stored" : "definition-only", packageBytes: skill.packageBytes,
    })),
    ...personalMcpServers().map((server): EffectiveCapability => ({
      kind: "mcp", capabilityId: server.id, name: server.name, enabled: server.enabled, locked: false, assignment: null, provenance: "personal", reason: "personal", contentHash: null, description: server.url,
    })),
  ];

  /* ------------------------------------------------------------- governance */

  const allPermissions = OrgPermissionSchema.options as OrgPermission[];
  const rolePermissionSets = () => {
    const readOnly = allPermissions.filter((permission) => permission.endsWith(":read"));
    const configured = (role: string) => config.rolePermissions.find((entry) => entry.tenantId === tenantId && entry.role === role)?.permissions;
    return [
      { role: "owner", permissions: configured("owner") ?? allPermissions, source: "system", days: 210 },
      { role: "admin", permissions: configured("admin") ?? allPermissions.filter((permission) => permission !== "org:admin"), source: "system", days: 210 },
      { role: "member", permissions: ["org:read", "departments:read", "models:read", "skills:read", "mcp:read"] as OrgPermission[], source: "system", days: 210 },
      { role: "department_lead", permissions: ["org:read", "departments:read", "members:read", "usage:read", "budgets:read", "models:read", "skills:read", "mcp:read", "reports:read"] as OrgPermission[], source: "custom", days: 64 },
      { role: "analyst", permissions: ["org:read", "departments:read", "usage:read", "usage:export", "reports:read", "reports:write", "alerts:read", "models:read"] as OrgPermission[], source: "custom", days: 41 },
      { role: "billing_manager", permissions: ["org:read", "billing:read", "billing:write", "budgets:read", "budgets:write", "usage:read", "usage:export", "reports:read", "alerts:read", "alerts:write"] as OrgPermission[], source: "custom", days: 88 },
      { role: "security_auditor", permissions: [...readOnly, "audit:export"] as OrgPermission[], source: "custom", days: 17 },
    ].map((entry) => ({ tenantId, role: entry.role, permissions: [...entry.permissions], source: entry.source, updatedAt: ago(entry.days) }));
  };

  const featureFlags = () => {
    const flag = (name: string, enabled: boolean, days: number, roleDefaults: Record<string, OrgPermission[]> = {}) => ({ tenantId, flag: name, enabled, roleDefaults, updatedAt: ago(days) });
    return [
      flag("enterprise-governance", true, 122, { owner: ["budgets:read", "budgets:write", "models:read", "models:write", "policy:read", "policy:write", "audit:read", "audit:export"], admin: ["budgets:read", "budgets:write", "models:read", "models:write", "policy:read", "audit:read"], member: ["models:read"] }),
      flag("usage-analytics", true, 96, { owner: ["usage:read", "usage:export", "reports:read", "reports:write"], admin: ["usage:read", "usage:export", "reports:read"], analyst: ["usage:read", "usage:export"] }),
      flag("spend-allowances", true, 74, { owner: ["budgets:read", "budgets:write"], admin: ["budgets:read", "budgets:write"], billing_manager: ["budgets:read", "budgets:write"] }),
      flag("deep-research", true, 58, { member: ["models:read"] }),
      flag("code-execution-sandbox", true, 51, { owner: ["guardrails:read", "guardrails:write"], admin: ["guardrails:read"] }),
      flag("scheduled-tasks", true, 47),
      flag("connectors", true, 44, { owner: ["mcp:read", "mcp:write"], admin: ["mcp:read", "mcp:write"], member: ["mcp:read"] }),
      flag("personal-mcp-servers", true, 39, { member: ["mcp:read"] }),
      flag("personal-skills", true, 39, { member: ["skills:read"] }),
      flag("memory", true, 33),
      flag("image-generation", true, 28),
      flag("artifacts", true, 13),
      flag("mobile-app", true, 21, { owner: ["auth_policy:read", "auth_policy:write"], admin: ["auth_policy:read"] }),
      flag("browser-sessions", false, 6),
      flag("voice-input", false, 9),
      flag("internal-sites", false, 4, { owner: ["org_settings:read", "org_settings:write"] }),
    ];
  };

  const resourceAcls = () => {
    const members = rankedMembers();
    const rows: Array<[string, string, "user" | "role" | "department", string, OrgPermission[], OrgPermission[], number]> = [
      ["model", "anthropic/claude-opus-4-5", "department", departmentId("Research"), ["models:read"], [], 12],
      ["model", "anthropic/claude-opus-4-5", "department", departmentId("Engineering"), ["models:read"], [], 12],
      ["model", "anthropic/claude-opus-4-5", "role", "member", [], ["models:read"], 12],
      ["model", "openai/gpt-5", "department", departmentId("Legal"), [], ["models:read"], 30],
      ["connector", "mcp_snowflake", "department", departmentId("Data Science"), ["mcp:read"], [], 26],
      ["connector", "mcp_snowflake", "department", departmentId("Finance"), ["mcp:read"], [], 26],
      ["connector", "mcp_snowflake", "role", "member", [], ["mcp:read"], 26],
      ["connector", "mcp_salesforce", "department", departmentId("Sales"), ["mcp:read", "mcp:write"], [], 40],
      ["connector", "mcp_salesforce", "department", departmentId("Support"), ["mcp:read"], [], 40],
      ["skill", "contract-review", "department", departmentId("Legal"), ["skills:read", "skills:write"], [], 55],
      ["skill", "security-questionnaire", "department", departmentId("Security"), ["skills:read", "skills:write"], [], 19],
      ["workspace", "ws_contracts", "department", departmentId("Legal"), ["org:read"], [], 61],
      ["workspace", "ws_security_reviews", "role", "security_auditor", ["org:read", "audit:read"], [], 17],
      ["workspace", "ws_forecasting", "user", at(members, 4).userId, ["org:read", "usage:read"], [], 8],
      ["report", "monthly-spend-by-department", "role", "billing_manager", ["reports:read", "reports:write"], [], 22],
      ["report", "monthly-spend-by-department", "user", at(members, 9).userId, ["reports:read"], [], 3],
    ];
    return rows.map(([resourceType, resourceId, principalType, principalId, allow, deny, days], index) => ({
      id: `acl_${hex(`${seed}:acl:${index}`, 12)}`, tenantId, resourceType, resourceId, principalType, principalId, allow, deny, updatedAt: ago(days),
    }));
  };

  const policyVersions = (): ManagedPolicyVersion[] => {
    const publishers = directory().members.slice(0, 4);
    const notes = [
      "Initial signed baseline for the pilot group.",
      "Added the model allowlist ahead of the company-wide rollout.",
      "Required telemetry and raised the sandbox floor after the security review.",
      "Blocked unrestricted web fetch; added PagerDuty for the incident scribe.",
      "Allowed Claude Opus 4.5 for Research and Engineering.",
      "Personal MCP servers allowed; destructive shell commands now prompt.",
      "Draft: forbid outbound network from sandboxes except the package mirrors.",
    ];
    return notes.map((note, index): ManagedPolicyVersion => {
      const version = index + 1;
      const status = version === notes.length ? "draft" : version === notes.length - 1 ? "active" : "revoked";
      const publishedDays = [212, 171, 133, 96, 61, 19, 1][index] ?? 1;
      const issuedAt = ago(publishedDays);
      return {
        id: `pol_${hex(`${seed}:policy:${version}`, 12)}`,
        tenantId,
        version,
        status,
        bundle: {
          version,
          organization: { id: tenantId, name: organizationName },
          issuedAt,
          expiresAt: status === "active" ? ago(-180) : null,
          policy: {
            execpolicy: [
              { id: "allow-git-read", kind: "prefix_rule", decision: "allow", pattern: ["git", "status"], description: "Read-only git commands run without a prompt." },
              { id: "prompt-rm-rf", kind: "regex-lite", decision: "prompt", pattern: "rm -rf *", description: "Recursive deletes always ask first." },
              { id: "forbid-curl-pipe-sh", kind: "regex-lite", decision: "forbid", pattern: "curl * | sh", description: "Piping downloads into a shell is not allowed." },
              ...(version >= 4 ? [{ id: "network-package-mirrors", kind: "network" as const, decision: "allow" as const, pattern: ["registry.npmjs.org", "pypi.org", "mirror.northwind.example"], description: "Package mirrors reachable from sandboxes." }] : []),
            ],
            modelAllowlist: version >= 2 ? MODELS.filter((model) => version >= 5 || model.id !== "claude-opus-4-5").map((model) => `${model.group}/${model.id}`) : [],
            mcpAllowlist: version >= 4 ? mcpSeeds.filter((server) => server.assignment !== "blocked").map((server) => server.id) : [],
            pluginAllowlist: version >= 3 ? ["berry-review", "berry-research"] : [],
            personalAdditions: { skills: true, mcp: version >= 6 },
            sandboxFloor: version >= 3 ? "workspace-write" : "danger-full-access",
            telemetry: version >= 3 ? "required" : "optional",
          },
          signature: { algorithm: "ed25519", keyId: version >= 4 ? "northwind-policy-2026" : "northwind-policy-2025", value: hex(`${seed}:policy-sig:${version}`, 128) },
        },
        bundlePath: `policies/${tenantId}/v${version}/bundle.json`,
        bundleHash: `sha256:${hex(`${seed}:policy-hash:${version}`, 64)}`,
        keyId: version >= 4 ? "northwind-policy-2026" : "northwind-policy-2025",
        publishedBy: at(publishers, index).userId,
        publishedAt: issuedAt,
        revokedAt: status === "revoked" ? ago([171, 133, 96, 61, 19][index] ?? 19) : null,
        auditEventId: `aud_${hex(`${seed}:policy-audit:${version}`, 16)}`,
        note,
      };
    }).reverse();
  };

  const auditEvents = (): CloudAuditEvent[] => {
    const random = mulberry32(hash(`${seed}:audit`));
    const admins = directory().members.filter((member) => member.role !== "member").slice(0, 9);
    const everyone = rankedMembers();
    const templates: Array<{ category: string; action: string; targetType: string | null; target: () => string | null; actor: "admin" | "member" | "system"; before?: unknown; after?: unknown; metadata?: Record<string, string | number | boolean> }> = [
      { category: "auth", action: "sso_login_succeeded", targetType: "user", target: () => pick(everyone, random).userId, actor: "member", metadata: { connection: "okta-workforce", mfa: true } },
      { category: "auth", action: "sso_login_failed", targetType: "user", target: () => pick(everyone, random).userId, actor: "system", metadata: { connection: "okta-workforce", reason: "assertion_expired" } },
      { category: "auth", action: "mobile_device_paired", targetType: "device", target: () => `dev_${hex(`${random()}`, 8)}`, actor: "member", metadata: { platform: "ios", appVersion: "1.8.2" } },
      { category: "members", action: "member_provisioned", targetType: "user", target: () => pick(everyone, random).userId, actor: "system", metadata: { source: "scim" } },
      { category: "members", action: "member_role_changed", targetType: "user", target: () => pick(everyone, random).userId, actor: "admin", before: { role: "member" }, after: { role: "department_lead" } },
      { category: "members", action: "member_deprovisioned", targetType: "user", target: () => pick(everyone, random).userId, actor: "system", metadata: { source: "scim", sessionsRevoked: 3 } },
      { category: "budgets", action: "allowance_adjusted", targetType: "user", target: () => pick(everyone, random).userId, actor: "admin", metadata: { amountUsd: 500, reason: "Quarter-end forecasting sprint" } },
      { category: "budgets", action: "allowance_default_updated", targetType: "department", target: () => departmentId(pick(DEPARTMENTS, random).name), actor: "admin", before: { hardLimitUsd: 1_000 }, after: { hardLimitUsd: 2_500 } },
      { category: "budgets", action: "request_blocked", targetType: "user", target: () => pick(everyone, random).userId, actor: "system", metadata: { reason: "allowance_exhausted", estimatedCostUsd: 0.42 } },
      { category: "models", action: "model_policy_updated", targetType: "model", target: () => { const model = pick(MODELS, random); return `${model.group}/${model.id}`; }, actor: "admin", before: { status: "blocked" }, after: { status: "allowed" } },
      { category: "models", action: "provider_tested", targetType: "provider", target: () => pick(PROVIDERS, random).id, actor: "admin", metadata: { ok: true, latencyMs: 412 } },
      { category: "models", action: "access_rule_created", targetType: "model", target: () => "anthropic/claude-opus-4-5", actor: "admin", metadata: { scope: "department", effect: "allowed" } },
      { category: "policy", action: "managed_policy_published", targetType: "policy", target: () => "v6", actor: "admin", metadata: { keyId: "northwind-policy-2026" } },
      { category: "policy", action: "execution_policy_updated", targetType: "policy", target: () => "execution", actor: "admin", before: { outboundNetwork: "unrestricted" }, after: { outboundNetwork: "allowlist" } },
      { category: "connectors", action: "connector_request_approved", targetType: "connector", target: () => pick(["mcp_pagerduty", "mcp_notion", "mcp_slack"], random), actor: "admin" },
      { category: "connectors", action: "connector_request_submitted", targetType: "connector", target: () => pick(["mcp_req_linear", "mcp_req_figma", "mcp_req_hubspot"], random), actor: "member" },
      { category: "connectors", action: "connector_oauth_connected", targetType: "connector", target: () => pick(["mcp_jira", "mcp_github", "gmail", "google-workspace"], random), actor: "member", metadata: { accessLevel: "read" } },
      { category: "skills", action: "organization_skill_published", targetType: "skill", target: () => pick(skillSeeds, random).id, actor: "admin", metadata: { assignment: "default-on" } },
      { category: "billing", action: "credits_purchased", targetType: "billing_account", target: () => tenantId, actor: "system", metadata: { amountUsd: 100_000, trigger: "auto_refill" } },
      { category: "billing", action: "credit_grant_created", targetType: "billing_account", target: () => tenantId, actor: "admin", metadata: { amountUsd: 25_000, source: "support" } },
      { category: "data", action: "usage_export_downloaded", targetType: "report", target: () => "monthly-spend-by-department", actor: "admin", metadata: { format: "csv", rows: 48_210 } },
      { category: "data", action: "retention_policy_updated", targetType: "policy", target: () => "data", actor: "admin", before: { conversationRetentionDays: 365 }, after: { conversationRetentionDays: 180 } },
      { category: "security", action: "service_account_token_rotated", targetType: "service_account", target: () => pick(["svc_ci_review", "svc_data_pipeline", "svc_support_bot"], random), actor: "admin" },
      { category: "security", action: "support_view_started", targetType: "user", target: () => pick(everyone, random).userId, actor: "admin", metadata: { reason: "Member reported a missing connector", readOnly: true } },
      { category: "security", action: "pii_filter_blocked", targetType: "task", target: () => `task_${hex(`${random()}`, 12)}`, actor: "system", metadata: { detector: "credential", action: "block" } },
    ];
    const events: CloudAuditEvent[] = [];
    let ts = Date.now() - 11 * 60_000;
    const latest = 48_216;
    for (let index = 0; index < 72; index += 1) {
      const template = at(templates, Math.floor(random() * templates.length));
      const sequence = latest - index;
      const actor = template.actor === "system" ? null : template.actor === "admin" ? pick(admins, random).userId : pick(everyone, random).userId;
      const inTask = template.category === "security" && template.targetType === "task";
      events.push({
        id: `aud_${hex(`${seed}:audit:${sequence}`, 16)}`,
        tenantId,
        sequence,
        actorUserId: actor,
        category: template.category,
        action: template.action,
        targetType: template.targetType,
        targetId: template.target(),
        workspaceId: inTask ? "ws_platform_monorepo" : null,
        taskId: inTask ? `task_${hex(`${seed}:audit-task:${sequence}`, 12)}` : null,
        sessionId: template.category === "auth" ? `sess_${hex(`${seed}:audit-sess:${sequence}`, 12)}` : null,
        before: (template.before ?? null) as CloudAuditEvent["before"],
        after: (template.after ?? null) as CloudAuditEvent["after"],
        metadata: { ...(template.metadata ?? {}), ip: `10.${20 + (sequence % 40)}.${sequence % 250}.${(sequence * 7) % 250}`, userAgent: at(["Berry Web/Chrome 141", "Berry Web/Safari 18", "Berry iOS/1.8.2", "scim-client/okta"], sequence) },
        previousHash: hex(`${seed}:audit-hash:${sequence - 1}`, 64),
        eventHash: hex(`${seed}:audit-hash:${sequence}`, 64),
        ts: iso(ts),
        expiresAt: iso(ts + 400 * DAY),
        createdAt: iso(ts + 180),
      });
      ts -= Math.round((0.2 + random() * 5.6) * HOUR);
    }
    return events;
  };

  /* --------------------------------------------------------------- personal */

  const memories = (): MemoryItem[] => {
    const me = self();
    const seeds: Array<[string, string, boolean]> = [
      ["working_convention", "Lead with the answer, then the reasoning. Keep status updates under six bullet points.", true],
      ["working_convention", "Use British spelling in documents for the London office and American spelling in code comments.", true],
      ["working_convention", "Never paste customer names into examples; use Contoso or Fabrikam placeholders.", true],
      ["working_convention", "When reviewing SQL, check for missing partition filters before anything else.", true],
      ["working_convention", "Default to TypeScript with strict mode; no default exports.", true],
      ["profile", "Based in Lisbon and works mostly 08:00–17:00 Western European Time.", false],
      ["profile", "Speaks English and Portuguese; reads Spanish.", false],
      ["profile", "Prefers 24-hour times and ISO dates in written plans.", true],
      ["career", "Staff platform engineer leading the developer-experience group in Engineering.", false],
      ["career", "Previously ran the payments reliability team for three years.", false],
      ["career", "Chairs the monthly architecture review and writes most of its RFC summaries.", false],
      ["project", "Billing service migration: moving invoicing from the monolith to the ledger service; cutover planned for the end of the quarter.", false],
      ["project", "Build cache rollout: remote cache enabled for 60% of CI jobs; flaky-test quarantine still manual.", false],
      ["project", "Incident scribe agent: drafts postmortems from PagerDuty timelines; pilot with two on-call rotations.", false],
      ["project", "Forecasting notebooks: Data Science partnership to cut warehouse cost by pruning unused marts.", false],
      ["project", "Mobile release train: fortnightly releases, with the change log generated from merged pull requests.", false],
      ["preference", "Prefers tables for comparisons and short prose for recommendations.", true],
      ["preference", "Likes diagrams as Mermaid so they can be pasted into Confluence.", true],
      ["preference", "Wants cost estimates in USD with the assumptions listed underneath.", false],
      ["preference", "Uses pnpm, Vitest and Playwright; avoids Jest in new packages.", false],
      ["preference", "Prefers Claude Sonnet 4.5 for code review and Kimi 2.6 for quick drafting.", false],
      ["preference", "Calendar holds: no meetings on Wednesday afternoons.", true],
      ["preference", "Asks for a rollback plan in every deployment checklist.", false],
      ["preference", "Reads long documents on mobile; keep headings descriptive.", false],
      ["project", "Vendor security review: SOC 2 evidence collection due before the audit window opens next month.", false],
      ["working_convention", "Commit messages follow Conventional Commits with the Jira key in the footer.", true],
      ["career", "Mentors two senior engineers and runs the platform guild reading group.", false],
      ["profile", "Coffee over tea; schedule deep work before 11:00.", false],
    ];
    return seeds.map(([kind, content, explicit], index): MemoryItem => ({
      id: `mem_${hex(`${seed}:mem:${index}`, 14)}`,
      tenantId,
      userId: me.userId,
      workspaceId: null,
      scope: "personal",
      kind,
      stableKey: `${kind}:${slugify(content).slice(0, 48)}`,
      content,
      value: {},
      status: "active",
      explicit,
      confidence: explicit ? 0.99 : Math.round((0.62 + 0.34 * unit(`${seed}:mem-conf:${index}`)) * 100) / 100,
      salience: Math.round((0.4 + 0.55 * unit(`${seed}:mem-sal:${index}`)) * 100) / 100,
      validFrom: null,
      validUntil: null,
      expiresAt: kind === "project" && index % 4 === 0 ? ago(-90) : null,
      extractorVersion: "memory-extractor-3.2",
      sourceTaskId: explicit ? null : `task_${hex(`${seed}:mem-task:${index}`, 12)}`,
      sourceSessionId: explicit ? null : `sess_${hex(`${seed}:mem-sess:${index}`, 12)}`,
      sourceMessageId: null,
      supersededItemId: null,
      lastSeenAt: ago(index % 9, 3),
      lastUsedAt: index % 6 === 5 ? null : ago(index % 12, 2),
      createdAt: ago(14 + index * 6),
      updatedAt: ago(index % 9, 3),
    }));
  };

  const archivedTasks = (): Task[] => {
    const titles = [
      "Draft the Q3 platform reliability review", "Compare vector store options for the knowledge base", "Summarise the vendor security questionnaire", "Refactor invoice rounding in the ledger service",
      "Investigate flaky checkout e2e test", "Plan the mobile release train for October", "Write the onboarding guide for new on-call engineers", "Analyse support ticket themes for September",
      "Prototype a cost dashboard for department leads", "Review the data retention policy wording", "Translate the release notes into Portuguese", "Benchmark prompt caching on long code reviews",
      "Outline the RFC for the build cache rollout", "Reconcile Stripe payouts against the ledger", "Prepare talking points for the architecture review", "Clean up unused feature flags",
      "Summarise the incident timeline for INC-4182", "Draft the customer email about the maintenance window", "Evaluate OCR quality on scanned contracts", "Generate test fixtures for the allowance engine",
      "Explain the Terraform drift in the staging account", "Rewrite the README for the design tokens package", "Compare SSO providers for the acquisition", "Audit npm dependencies with known advisories",
      "Model headcount scenarios for next fiscal year", "Draft interview questions for a staff data engineer", "Convert the pricing sheet into a comparison table", "Find duplicate accounts in the CRM export",
      "Write a migration plan for the search cluster", "Summarise the board deck appendix", "Build a changelog digest for the React 19 upgrade", "Check accessibility of the new settings screens",
      "Estimate warehouse savings from pruning marts", "Draft the postmortem for the router failover drill",
    ];
    // Production scale: a heavy user archives a few hundred tasks a year, so the list pages.
    const passes = ["", ", second pass", " for EMEA", " for the US team", " for APAC", ", follow-up", " for the board pack"];
    const count = titles.length * passes.length;
    return Array.from({ length: count }, (_, index): Task => {
      const title = `${titles[index % titles.length]}${passes[Math.floor(index / titles.length)]}`;
      const updatedDays = 2 + Math.floor(index * 1.6) + Math.floor(unit(`${seed}:task-age:${index}`) * 2);
      const deleted = index % 7 === 5;
      const code = index % 4 === 0;
      return {
        id: `task_arch_${hex(`${seed}:archived:${index}`, 12)}`,
        workspaceId: config.workspaceId,
        title,
        status: index % 11 === 7 ? "failed" : index % 13 === 9 ? "cancelled" : "completed",
        activeSessionId: null,
        conversationKind: code ? "code" : "chat",
        pinned: false,
        archived: !deleted || index % 2 === 0,
        deletedAt: deleted ? ago(Math.max(1, updatedDays - 1)) : null,
        unreadAt: null,
        lastReadAt: ago(updatedDays),
        worktreePath: null,
        worktreeBranch: null,
        worktreeBaseRef: null,
        worktreeBaseSha: null,
        pullRequestUrl: null,
        pullRequestNumber: null,
        createdAt: ago(updatedDays + 1 + (index % 5)),
        updatedAt: ago(updatedDays),
      };
    });
  };

  /* ------------------------------------------------------------ automations */

  type DemoAutomation = { task: ScheduledTask; runs: ScheduledTaskRun[] };
  let automationCache: { slot: number; entries: DemoAutomation[] } | null = null;
  const automations = (): DemoAutomation[] => {
    // Fire times only move on quarter hours, so one build serves every poll inside a slot.
    const slot = Math.floor(Date.now() / CRON_STEP);
    if (automationCache?.slot === slot) return automationCache.entries;
    const now = Date.now();
    const me = self();
    const uuid = (key: string) => hex(`${seed}:automation:${key}`, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    const seeds: Array<{ name: string; prompt: string; expression: string; timezone: string; runs: number; state?: "paused"; failing?: string; model: [string, string]; reasoning: ScheduledTask["reasoning"]; created: number }> = [
      { name: "Morning engineering brief", prompt: "Summarise overnight pull requests, failed CI runs and new incidents for the platform team. Lead with anything that blocks today's release, then list owners.", expression: "30 8 * * 1-5", timezone: "Europe/Lisbon", runs: 10, model: ["anthropic", "claude-sonnet-4-5"], reasoning: "medium", created: 148 },
      { name: "Hourly incident watch", prompt: "Check PagerDuty and the #incidents channel for new or escalated incidents in the last hour. Only write a summary if something changed.", expression: "0 * * * *", timezone: "UTC", runs: 10, model: ["router", "kimi-2.6"], reasoning: "low", created: 61 },
      { name: "Warehouse cost check", prompt: "Query yesterday's Snowflake spend by warehouse and compare it with the trailing seven-day average. Flag any warehouse more than 25% above its average and name the top three queries.", expression: "0 7 * * *", timezone: "Europe/London", runs: 9, failing: "Snowflake connector returned 401: the shared credential expired. Reconnect it in Settings, then run this automation again.", model: ["openai", "gpt-5"], reasoning: "medium", created: 92 },
      { name: "Weekly status report", prompt: "Draft my weekly status from merged pull requests, closed Jira issues and calendar notes. Use the weekly-status skill and keep it under six bullet points.", expression: "0 16 * * 5", timezone: "Europe/Lisbon", runs: 8, model: ["anthropic", "claude-sonnet-4-5"], reasoning: "medium", created: 203 },
      { name: "Monday dependency advisories", prompt: "Audit the platform monorepo for npm and PyPI packages with new security advisories since last Monday. Group by severity and propose upgrade pull requests for anything critical.", expression: "0 9 * * 1", timezone: "America/New_York", runs: 7, model: ["anthropic", "claude-opus-4-5"], reasoning: "high", created: 117 },
      { name: "Customer escalations digest", prompt: "Summarise open priority-one and priority-two Salesforce cases for accounts above $250k ARR, with the age of each case and the next action owner.", expression: "0 9 * * 1-5", timezone: "Asia/Dubai", runs: 10, model: ["router", "glm-5.2"], reasoning: "low", created: 74 },
      { name: "Monthly spend review", prompt: "Build the monthly AI spend review: totals by department and model, month-over-month change, the ten heaviest users and any department over 90% of its guardrail. Export a table for Finance.", expression: "0 9 1 * *", timezone: "Europe/London", runs: 6, model: ["anthropic", "claude-sonnet-4-5"], reasoning: "high", created: 188 },
      { name: "Standup notes to Confluence", prompt: "Turn yesterday's standup transcript into decisions, owners and follow-ups, then append them to the team's Confluence page.", expression: "15 10 * * 1-5", timezone: "Europe/Berlin", runs: 6, state: "paused", model: ["anthropic", "claude-haiku-4-5"], reasoning: "off", created: 131 },
    ];
    const entries = seeds.map((entry, index): DemoAutomation => {
      const id = uuid(`task:${index}`);
      const past = cronFireTimes(entry.expression, entry.timezone, now, -1, entry.runs + (entry.state === "paused" ? 8 : 0));
      // A paused automation stopped firing a while ago; its history ends there.
      const fired = entry.state === "paused" ? past.slice(8) : past;
      const runs = fired.map((scheduledAt, runIndex): ScheduledTaskRun => {
        const key = `run:${index}:${scheduledAt}`;
        const roll = unit(`${seed}:automation-roll:${key}`);
        const failed = entry.failing ? runIndex < 2 : roll < 0.07;
        const skipped = !failed && roll > 0.96;
        const running = !failed && !skipped && runIndex === 0 && now - scheduledAt < 6 * 60_000;
        const waiting = !failed && !skipped && !running && roll > 0.9 && runIndex > 0;
        const manual = runIndex === 3 && index % 3 === 1;
        const started = scheduledAt + (manual ? 37 * 60_000 : 0) + 2_000 + Math.round(roll * 9_000);
        const admitted = !skipped && !(failed && !entry.failing && roll < 0.03);
        return {
          id: uuid(key),
          scheduleId: id,
          scheduledAt: iso(scheduledAt + (manual ? 37 * 60_000 : 0)),
          trigger: manual ? "manual" : "scheduled",
          state: skipped ? "skipped" : admitted ? "admitted" : "failed",
          taskId: admitted ? uuid(`${key}:task`) : null,
          sessionId: admitted ? uuid(`${key}:session`) : null,
          turnId: admitted ? uuid(`${key}:turn`) : null,
          turnState: skipped ? null : !admitted ? null : failed ? "failed" : running ? "running" : waiting ? "waiting" : "completed",
          waitingReason: waiting ? "approval" : null,
          error: failed ? entry.failing ?? (admitted ? "The model provider timed out after three attempts." : "Monthly allowance was exhausted when this run was due.") : skipped ? "Skipped because the previous run was still in progress." : null,
          createdAt: iso(started),
          finishedAt: skipped || running || waiting ? (skipped ? iso(started) : null) : iso(started + 40_000 + Math.round(unit(`${seed}:automation-duration:${key}`) * 420_000)),
        };
      });
      const lastRunAt = fired[0] ?? null;
      const next = entry.state === "paused" ? [] : cronFireTimes(entry.expression, entry.timezone, now, 1, 1);
      return {
        task: {
          id, tenantId, userId: me.userId, workspaceId: config.workspaceId, sourceTaskId: index % 2 === 0 ? uuid(`source:${index}`) : null,
          name: entry.name, prompt: entry.prompt, schedule: { kind: "cron", expression: entry.expression, timezone: entry.timezone },
          state: entry.state ?? "active", nextRunAt: next[0] === undefined ? null : iso(next[0]), lastRunAt: lastRunAt === null ? null : iso(lastRunAt),
          lastError: entry.failing ?? null, modelProviderId: entry.model[0], model: entry.model[1], reasoning: entry.reasoning,
          createdAt: ago(entry.created), updatedAt: entry.state === "paused" ? iso((lastRunAt ?? now) + 3 * HOUR) : iso(lastRunAt ?? now),
        },
        runs,
      };
    });
    // One finished one-off, so the "Finished" state has a row too.
    const onceId = uuid("task:once");
    const onceAt = Math.floor((now - 9 * DAY) / HOUR) * HOUR;
    entries.push({
      task: {
        id: onceId, tenantId, userId: me.userId, workspaceId: config.workspaceId, sourceTaskId: uuid("source:once"), name: "Audit window reminder pack",
        prompt: "Collect the SOC 2 evidence checklist, list what is still missing per control owner, and draft the reminder emails for my review.",
        schedule: { kind: "once", runAt: iso(onceAt), timezone: "Europe/Lisbon" }, state: "completed", nextRunAt: null, lastRunAt: iso(onceAt), lastError: null,
        modelProviderId: "anthropic", model: "claude-sonnet-4-5", reasoning: "medium", createdAt: iso(onceAt - 5 * DAY), updatedAt: iso(onceAt + 4 * 60_000),
      },
      runs: [{
        id: uuid("run:once"), scheduleId: onceId, scheduledAt: iso(onceAt), trigger: "scheduled", state: "admitted", taskId: uuid("run:once:task"), sessionId: uuid("run:once:session"), turnId: uuid("run:once:turn"),
        turnState: "completed", waitingReason: null, error: null, createdAt: iso(onceAt + 3_000), finishedAt: iso(onceAt + 4 * 60_000),
      }],
    });
    automationCache = { slot, entries };
    return entries;
  };

  /* --------------------------------------------------------------- platform */

  const platformTenants = (): PlatformTenantSummary[] => {
    const rows: Array<[string, string, string, string | null, string, number, number, number, string, string, string]> = [
      [organizationName, organization?.deploymentMode === "selfhost" ? "selfhost" : "dedicated", "enterprise", "eu-west-1", "active", TOTAL_MEMBERS, 212_000, 0, "healthy", "healthy", tenantId],
      ["Meridian Bank", "dedicated", "enterprise", "eu-central-1", "active", 2_240, 186_400, 310_000, "healthy", "healthy", "tnt_meridian"],
      ["Helix Biosciences", "dedicated", "enterprise", "us-east-1", "active", 1_410, 164_200, 96_500, "healthy", "healthy", "tnt_helix"],
      ["Atlas Logistics", "shared", "enterprise", "eu-west-1", "active", 1_780, 142_900, 41_200, "degraded", "healthy", "tnt_atlas"],
      ["Lumen Health", "dedicated", "enterprise", "us-east-1", "active", 960, 121_300, 220_000, "healthy", "warning", "tnt_lumen"],
      ["Orbital Retail Group", "shared", "business", "eu-west-1", "active", 1_120, 98_700, 64_300, "healthy", "healthy", "tnt_orbital"],
      ["Kestrel Aerospace", "selfhost", "enterprise", null, "active", 840, 87_100, 0, "not_configured", "healthy", "tnt_kestrel"],
      ["Brightwater Insurance", "shared", "business", "us-east-1", "active", 720, 74_600, 28_900, "healthy", "healthy", "tnt_brightwater"],
      ["Northfield University", "shared", "education", "us-west-2", "active", 3_900, 61_800, 15_400, "healthy", "healthy", "tnt_northfield"],
      ["Vantage Legal", "dedicated", "business", "eu-west-2", "active", 310, 52_300, 80_000, "healthy", "healthy", "tnt_vantage"],
      ["Cobalt Energy", "shared", "business", "eu-central-1", "active", 540, 44_100, 6_200, "blocked", "healthy", "tnt_cobalt"],
      ["Pinecrest Media", "shared", "team", "us-east-1", "active", 180, 31_400, 12_700, "healthy", "not_configured", "tnt_pinecrest"],
      ["Solace Robotics", "shared", "team", "ap-southeast-1", "trial", 95, 22_600, 5_000, "healthy", "not_configured", "tnt_solace"],
      ["Tidewater Municipal", "shared", "business", "us-east-1", "suspended", 260, 0, 1_150, "blocked", "warning", "tnt_tidewater"],
    ];
    return rows.map(([name, deploymentMode, plan, region, lifecycle, seats, spend, prepaid, billingHealth, ssoHealth, id], index): PlatformTenantSummary => {
      const own = id === tenantId;
      return {
        tenantId: id,
        name,
        slug: own ? organization?.slug ?? slugify(name) : slugify(name),
        lifecycle,
        deploymentMode,
        region,
        hostname: own ? organization?.hostname ?? null : deploymentMode === "selfhost" ? null : `${slugify(name)}.berry.example`,
        plan,
        seats,
        monthlySpendMicros: usd(spend),
        prepaidBalanceMicros: own ? String(ledger().balance) : usd(prepaid),
        billingHealth,
        ssoHealth,
        updatedAt: ago(index % 6, index * 2),
      };
    });
  };
  const PLATFORM_RATIO = 1_297_400 / 212_000;

  /* -------------------------------------------------------- implementation */

  const implementation: DemoImplementation = {
    /* usage */
    usageAnalytics: async (_tenantId, query) => analytics("org", query),
    usageRequests: async (_tenantId, query) => requestPage("org", query),
    usageRequestDetail: async (_tenantId, requestId) => requestDetail(requestId),
    myUsage: async (_tenantId, query) => analytics("me", query),
    myUsageRequests: async (_tenantId, query) => requestPage("me", query),
    exportMyUsageCsv: async (_tenantId, filter = {}) => csv(requestPage("me", { from: filter.from ?? ago(30), to: filter.to ?? iso(Date.now()), limit: 100 }).items),
    savedAnalyticsViews: async () => {
      const owners = directory().members;
      const views: Array<[string, Partial<UsageAnalyticsQuery>, "private" | "tenant", number]> = [
        ["Monthly spend by department", {}, "tenant", 3],
        ["Engineering — coding agents", { departmentId: departmentId("Engineering"), feature: "model.subagent" }, "tenant", 9],
        ["Claude Opus 4.5 watchlist", { model: "claude-opus-4-5" }, "tenant", 12],
        ["OpenAI reliability", { provider: "openai", status: "failed" }, "tenant", 2],
        ["Support triage agent", { agentId: "agent_support_triage" }, "private", 21],
        ["Blocked requests", { status: "blocked" }, "private", 6],
      ];
      return views.map(([name, filters, visibility, days], index) => ({
        id: `view_${hex(`${seed}:view:${index}`, 10)}`, tenantId, name, ownerUserId: at(owners, index).userId, filters, visibility, createdAt: ago(days + 40), updatedAt: ago(days),
      }));
    },

    /* directory */
    listOrgMembers: async () => directory().members,
    listOrgMembersPage: async (_tenantId, query = {}) => {
      const search = (query.search ?? "").toLowerCase();
      const matched = directory().members.filter((member) =>
        (!search || `${member.name} ${member.email}`.toLowerCase().includes(search))
        && (!query.status || member.status === query.status)
        && (!query.role || member.role === query.role)
        && (!query.departmentId || member.departmentIds.includes(query.departmentId))
        && (!query.source || member.source === query.source));
      const limit = query.limit ?? 25;
      const offset = query.cursor ? Number(query.cursor) || 0 : 0;
      const items = matched.slice(offset, offset + limit);
      const hasMore = offset + limit < matched.length;
      return { items, nextCursor: hasMore ? String(offset + limit) : null, hasMore, total: matched.length };
    },
    listDepartments: async () => departments,
    listDepartmentsPage: async (_tenantId, query = {}) => {
      const search = (query.search ?? "").toLowerCase();
      const items = departments.filter((department) => (!search || department.name.toLowerCase().includes(search)) && (!query.status || department.status === query.status));
      return { items, nextCursor: null, hasMore: false, total: items.length };
    },
    listMemberMobileDevices: async (_tenantId, userId) => {
      const count = 1 + (hash(`${seed}:devices:${userId}`) % 3);
      const models = [["iPhone 16 Pro", "ios", "18.6"], ["Pixel 9", "android", "15"], ["iPhone 15", "ios", "18.5"], ["Galaxy S25", "android", "15"]] as const;
      return Array.from({ length: count }, (_, index) => {
        const [model, platform, osVersion] = at(models, hash(`${userId}:${index}`));
        const pairedDays = 6 + ((hash(`${userId}:paired:${index}`) % 140));
        return {
          id: `mdev_${hex(`${seed}:mdev:${userId}:${index}`, 12)}`, tenantId, userId, deviceId: `device-${hex(`${seed}:device:${userId}:${index}`, 16)}`, platform,
          pushProvider: platform === "ios" ? "apns" as const : "fcm" as const, pushTokenLast4: hex(`${userId}:push:${index}`, 4), endpointMode: "paired" as const, appVersion: index === 0 ? "1.8.2" : "1.7.4",
          capabilities: ["approvals", "chat", "tasks", "push"], status: "active" as const, displayName: `${directory().members.find((member) => member.userId === userId)?.name.split(" ")[0] ?? "Member"}'s ${model}`,
          model, osVersion, pairedAt: ago(pairedDays), revokedAt: null, current: false, createdAt: ago(pairedDays), updatedAt: ago(index * 4, 2), lastSeenAt: ago(index * 4, 2),
        };
      });
    },
    memberSkills: async () => ({ personal: personalSkills().slice(0, 4), effective: effectiveCapabilities().filter((capability) => capability.kind === "skill") }),
    authConfig: async () => ({ loginMode: "mixed", emailPassword: { enabled: true }, ssoProviders: [{ id: "google", name: "Google Workspace", domain: EMAIL_DOMAIN }] }),
    effectivePermissions: async () => {
      const role = organization?.role ?? "owner";
      const permissions = config.rolePermissions.find((entry) => entry.tenantId === tenantId && entry.role === role)?.permissions ?? allPermissions;
      return { tenantId, userId: self().userId, role, permissions: [...permissions], featureFlags: featureFlags() };
    },
    organizationProfile: async () => ({
      tenantId,
      name: organizationName,
      slug: organization?.slug ?? slugify(organizationName),
      logoUrl: null,
      timezone: "Europe/London",
      language: "en-GB",
      supportEmail: `ai-support@${EMAIL_DOMAIN}`,
      securityEmail: `security@${EMAIL_DOMAIN}`,
      deploymentMode: organization?.deploymentMode ?? "dedicated",
      region: "eu-west-1",
      announcements: [
        { id: "ann_opus", message: "Claude Opus 4.5 is now available to Research and Engineering. Other teams can request access from their department lead.", active: true },
        { id: "ann_maintenance", message: "Router maintenance on Saturday 02:00–03:00 UTC. Scheduled tasks will resume automatically.", active: true },
        { id: "ann_training", message: "Agent basics training recordings are in the People workspace.", active: false },
      ],
      termsUrl: "https://northwind.example/legal/ai-acceptable-use",
      privacyUrl: "https://northwind.example/legal/privacy",
      branding: { applicationName: "Northwind Assistant", accentColor: "#7c6df2" },
      domains: [
        { id: "dom_primary", domain: EMAIL_DOMAIN, status: "verified", customDomain: false, verifiedAt: ago(402) },
        { id: "dom_ai", domain: `ai.${EMAIL_DOMAIN}`, status: "verified", customDomain: true, verifiedAt: ago(288) },
        { id: "dom_emea", domain: "northwind-emea.example", status: "verified", customDomain: false, verifiedAt: ago(171) },
        { id: "dom_labs", domain: "northwindlabs.example", status: "pending", customDomain: false, verifiedAt: null },
      ],
      updatedAt: ago(9),
    }),

    /* access control */
    listRolePermissions: async () => rolePermissionSets(),
    listFeatureFlags: async () => featureFlags(),
    listResourceAcls: async (_tenantId, resource) => resourceAcls().filter((acl) => !resource || (acl.resourceType === resource.resourceType && acl.resourceId === resource.resourceId)),
    listSsoConnections: async () => [
      { id: "sso_okta_workforce", tenantId, kind: "saml", provider: "okta", slug: "okta-workforce", displayName: "Okta Workforce", status: "enabled", issuer: "http://www.okta.com/exk8f2northwind", ssoUrl: "https://northwind.okta.example/app/berry/exk8f2/sso/saml", metadataUrl: "https://northwind.okta.example/app/exk8f2/sso/saml/metadata", entityId: `urn:berry:${tenantId}`, clientId: null, clientSecretConfigured: false, domains: [EMAIL_DOMAIN, "northwind-emea.example"], jitProvisioning: true, defaultRole: "member", scimEnabled: true, lastTestedAt: ago(1, 4), lastErrorCode: null, createdAt: ago(396), updatedAt: ago(1, 4) },
      { id: "sso_google", tenantId, kind: "oidc", provider: "google", slug: "google-workspace", displayName: "Google Workspace", status: "enabled", issuer: "https://accounts.google.com", ssoUrl: null, metadataUrl: "https://accounts.google.com/.well-known/openid-configuration", entityId: null, clientId: "481920337741-n0rthw1nd.apps.googleusercontent.example", clientSecretConfigured: true, domains: [EMAIL_DOMAIN], jitProvisioning: true, defaultRole: "member", scimEnabled: false, lastTestedAt: ago(12), lastErrorCode: null, createdAt: ago(310), updatedAt: ago(12) },
      { id: "sso_entra_emea", tenantId, kind: "oidc", provider: "microsoft-entra", slug: "entra-emea", displayName: "Microsoft Entra ID (EMEA subsidiary)", status: "draft", issuer: "https://login.microsoftonline.com/7c1d0e5a-emea/v2.0", ssoUrl: null, metadataUrl: "https://login.microsoftonline.com/7c1d0e5a-emea/v2.0/.well-known/openid-configuration", entityId: null, clientId: "5f2b9a10-6c3e-4a7d-9b1e-emea00000001", clientSecretConfigured: false, domains: ["northwindlabs.example"], jitProvisioning: false, defaultRole: "member", scimEnabled: false, lastTestedAt: ago(4), lastErrorCode: "invalid_client", createdAt: ago(8), updatedAt: ago(4) },
      { id: "sso_legacy_adfs", tenantId, kind: "saml", provider: "generic", slug: "legacy-adfs", displayName: "Legacy ADFS (retired)", status: "disabled", issuer: "https://adfs.northwind.example/adfs/services/trust", ssoUrl: "https://adfs.northwind.example/adfs/ls", metadataUrl: null, entityId: `urn:berry:${tenantId}:legacy`, clientId: null, clientSecretConfigured: false, domains: [], jitProvisioning: false, defaultRole: "member", scimEnabled: false, lastTestedAt: ago(214), lastErrorCode: null, createdAt: ago(520), updatedAt: ago(214) },
    ],
    listPolicyVersions: async () => policyVersions(),
    listAuditEvents: async (_tenantId, filter = {}) => auditEvents()
      .filter((event) => (!filter.category || event.category === filter.category) && (!filter.action || event.action === filter.action) && (!filter.sessionId || event.sessionId === filter.sessionId))
      .slice(0, filter.limit ?? 100),
    serviceAccounts: async () => {
      const rows: Array<[string, string, "active" | "revoked" | "expired", OrgPermission[], string | null, number | null, number | null, number]> = [
        ["svc_ci_review", "CI code review bot", "active", ["org:read", "models:read", "skills:read"], departmentId("Engineering"), 0.01, -180, 211],
        ["svc_data_pipeline", "Nightly forecasting pipeline", "active", ["org:read", "models:read", "usage:read"], departmentId("Data Science"), 0.3, -92, 164],
        ["svc_support_bot", "Support triage bot", "active", ["org:read", "models:read", "mcp:read", "skills:read"], departmentId("Support"), 0.004, -240, 131],
        ["svc_usage_export", "Finance usage export", "active", ["usage:read", "usage:export", "billing:read", "reports:read"], departmentId("Finance"), 1.1, -30, 96],
        ["svc_scim_sync", "Directory reconciliation", "active", ["members:read", "members:write", "departments:read", "departments:write"], null, 0.08, null, 288],
        ["svc_siem_forwarder", "SIEM audit forwarder", "expired", ["audit:read", "audit:export"], departmentId("Security"), 9, 9, 380],
        ["svc_hackathon", "Hackathon demo", "revoked", ["org:read", "models:read"], departmentId("Product"), 47, 40, 75],
      ];
      return rows.map(([id, name, status, permissions, department, lastUsedDays, expiresDays, createdDays]) => ({
        id, tenantId, name, status, permissions, departmentId: department,
        resourceRestrictions: id === "svc_data_pipeline" ? [{ type: "workspace", id: "ws_forecasting" }] : id === "svc_support_bot" ? [{ type: "connector", id: "mcp_salesforce" }] : [],
        expiresAt: expiresDays === null ? null : ago(expiresDays), lastUsedAt: lastUsedDays === null ? null : ago(lastUsedDays), tokenLast4: hex(`${seed}:svc:${id}`, 4),
        createdAt: ago(createdDays), updatedAt: ago(Math.min(createdDays, 14)),
      }));
    },
    createServiceAccount: async (_tenantId, input) => ({
      account: {
        id: `svc_${hex(`${seed}:new-svc:${input.name}`, 10)}`, tenantId, name: input.name, status: "active", permissions: input.permissions, departmentId: input.departmentId ?? null,
        resourceRestrictions: input.resourceRestrictions ?? [], expiresAt: input.expiresAt ?? null, lastUsedAt: null, tokenLast4: "demo", createdAt: iso(Date.now()), updatedAt: iso(Date.now()),
      },
      token: `berry_sa_demo_${hex(`${seed}:new-token:${input.name}`, 28)}_demo`,
    }),
    executionPolicy: async () => ({
      tenantId, sandboxEnabled: true, codeExecutionEnabled: true, approvalRequired: true, outboundNetwork: "allowlist",
      allowedDomains: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "github.example", "mirror.northwind.example", "api.northwind.example"],
      blockedDomains: ["pastebin.com", "transfer.sh", "ngrok.io"],
      allowedToolClasses: ["filesystem", "shell", "python", "browser-readonly", "connectors"],
      maxRunSeconds: 1_800, maxConcurrency: 24, requestsPerMinute: 600, tokenQuota: 60_000_000_000, sandboxMinuteQuota: 250_000, updatedAt: ago(19),
    }),
    authenticationPolicy: async () => ({
      tenantId, mfaRequired: true, sessionMaxAgeMinutes: 720, idleTimeoutMinutes: 60, trustedDevicesAllowed: true, allowedLoginMethods: ["saml", "oidc", "password"],
      allowedDomains: [EMAIL_DOMAIN, "northwind-emea.example"], emergencyLocalOwnerEnabled: true, mobileAppEnabled: true, updatedAt: ago(33),
    }),
    dataGovernancePolicy: async () => ({
      tenantId, conversationRetentionDays: 180, temporaryChatHours: 24,
      retentionByDataType: { conversations: 180, files: 365, sandboxes: 14, auditEvents: 400, usageEvents: 730, memories: 365 },
      residency: "eu-west-1", piiFilterMode: "warn", credentialFilterMode: "block", moderationHookConfigured: true, legalHoldEnabled: false, updatedAt: ago(26),
    }),

    /* allowances and budgets */
    listBudgetLimits: async () => {
      const members = rankedMembers();
      return [
        { id: "lim_org_month", tenantId, scopeType: "org" as const, scopeId: tenantId, period: "month" as const, softLimitMicros: usd(260_000), hardLimitMicros: usd(300_000), requestLimit: null, tokenLimit: 60_000_000_000, sandboxMinuteLimit: 250_000, thresholdPercentages: [50, 80, 95, 100], status: "active" as const, updatedAt: ago(19) },
        { id: "lim_org_day", tenantId, scopeType: "org" as const, scopeId: tenantId, period: "day" as const, softLimitMicros: usd(11_000), hardLimitMicros: usd(15_000), requestLimit: 220_000, tokenLimit: null, sandboxMinuteLimit: null, thresholdPercentages: [80, 100], status: "active" as const, updatedAt: ago(19) },
        ...DEPARTMENTS.map((department, index) => ({
          id: `lim_${departmentId(department.name)}`, tenantId, scopeType: "department" as const, scopeId: departmentId(department.name), period: "month" as const,
          softLimitMicros: usd(department.budget), hardLimitMicros: usd(Math.round(department.budget * 1.2)), requestLimit: null, tokenLimit: null,
          sandboxMinuteLimit: department.intensity > 1 ? Math.round(department.headcount * 120) : null, thresholdPercentages: [80, 100], status: (department.name === "People" ? "disabled" : "active") as "active" | "disabled", updatedAt: ago(6 + index * 5),
        })),
        ...[0, 1, 2, 5].map((rank) => {
          const member = at(members, rank);
          return { id: `lim_user_${hex(`${seed}:lim-user:${rank}`, 8)}`, tenantId, scopeType: "user" as const, scopeId: member.userId, period: "day" as const, softLimitMicros: usd(250), hardLimitMicros: usd(400), requestLimit: 2_500, tokenLimit: null, sandboxMinuteLimit: 240, thresholdPercentages: [80, 100], status: "active" as const, updatedAt: ago(2 + rank * 3) };
        }),
      ];
    },
    listAllowanceProfiles: async () => profileSeeds.map((profile, index) => ({
      id: profile.id, tenantId, name: profile.name, description: profile.description, period: "month" as const, softLimitMicros: usd(profile.limit * 0.8), hardLimitMicros: usd(profile.limit),
      requestLimit: null, tokenLimit: null, sandboxMinuteLimit: index >= 3 ? 1_200 : null, thresholdPercentages: [80, 100], status: "active" as const, createdAt: ago(190 - index * 12), updatedAt: ago(20 + index * 9),
    })),
    listAllowanceDefaults: async () => [
      { id: "alwd_org", tenantId, profileId: "alw_standard", role: null, departmentId: null, priority: 0, createdAt: ago(190), updatedAt: ago(48) },
      ...Object.entries(departmentProfile).map(([name, profileId], index) => ({ id: `alwd_${departmentId(name)}`, tenantId, profileId, role: null, departmentId: departmentId(name), priority: 10, createdAt: ago(160 - index * 6), updatedAt: ago(11 + index * 4) })),
      { id: "alwd_role_admin", tenantId, profileId: "alw_power", role: "admin", departmentId: null, priority: 20, createdAt: ago(120), updatedAt: ago(37) },
      { id: "alwd_role_lead", tenantId, profileId: "alw_power", role: "department_lead", departmentId: null, priority: 20, createdAt: ago(64), updatedAt: ago(29) },
    ],
    allowanceCycle: async () => ({ tenantId, timezone: "Europe/London", anchorDay: 1, updatedBy: self().userId, updatedAt: ago(96) }),
    allowanceBalances: async () => balances(),
    allowanceBalance: async (_tenantId, userId) => balances().find((balance) => balance.userId === userId) ?? (balances()[0] as AllowanceBalance),
    allowanceAdjustments: async (_tenantId, userId) => adjustments().filter((adjustment) => !userId || adjustment.userId === userId),

    /* billing */
    billingSummary: async () => {
      const { balance } = ledger();
      const now = Date.now();
      const support = 18_400_000_000;
      const manual = 6_250_000_000;
      const purchased = Math.max(0, balance - support - manual);
      const month = (offset: number) => Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + offset, 1);
      const invoiceTotals = [212_000, 198_400, 187_900, 171_300, 158_600, 149_200, 133_800, 121_500];
      return {
        tenantId,
        provider: "stripe",
        providerConfigured: true,
        billingDependencyRequired: true,
        prepaidBalanceMicros: String(balance),
        currency: "usd",
        activeGrants: [
          { id: "grant_auto_refill_latest", tenantId, source: "stripe", amountMicros: usd(100_000), remainingMicros: String(Math.min(purchased, 100_000_000_000)), currency: "usd", externalRef: `pi_3${base36(`${seed}:grant:1`, 22)}`, status: "active", metadata: { trigger: "auto_refill" }, createdBy: null, createdAt: ago(4), updatedAt: ago(0, 1) },
          ...(purchased > 100_000_000_000 ? [{ id: "grant_auto_refill_previous", tenantId, source: "stripe" as const, amountMicros: usd(100_000), remainingMicros: String(purchased - 100_000_000_000), currency: "usd", externalRef: `pi_3${base36(`${seed}:grant:0`, 22)}`, status: "active" as const, metadata: { trigger: "auto_refill" }, createdBy: null, createdAt: ago(15), updatedAt: ago(4) }] : []),
          { id: "grant_support_credit", tenantId, source: "support", amountMicros: usd(25_000), remainingMicros: String(support), currency: "usd", externalRef: "CASE-48211", status: "active", metadata: { reason: "Service credit for the September router incident" }, createdBy: (directory().members[1] as OrgMembership).userId, createdAt: ago(17), updatedAt: ago(2) },
          { id: "grant_pilot_credit", tenantId, source: "manual", amountMicros: usd(10_000), remainingMicros: String(manual), currency: "usd", externalRef: "PO-2291-AI", status: "active", metadata: { reason: "Research pilot funded by the innovation budget" }, createdBy: self().userId, createdAt: ago(41), updatedAt: ago(6) },
        ],
        recentMeterEvents: Array.from({ length: 12 }, (_, index) => {
          const meter = at(["model_tokens", "model_tokens", "sandbox_minutes", "model_tokens", "image_generations"], index);
          const status = index === 0 ? "pending" as const : index === 7 ? "failed" as const : "reported" as const;
          return {
            id: `meter_${hex(`${seed}:meter:${index}`, 12)}`, tenantId, usageEventId: `ue_${hex(`${seed}:meter-ue:${index}`, 20)}`, requestId: `req_${base36(`${seed}:meter-req:${index}`, 22)}`, meter,
            quantity: String(meter === "model_tokens" ? 180_000_000 + Math.round(unit(`${seed}:meter-q:${index}`) * 240_000_000) : meter === "sandbox_minutes" ? 1_200 + index * 37 : 310 + index * 11),
            costBilledMicros: usd(meter === "model_tokens" ? 640 + unit(`${seed}:meter-c:${index}`) * 900 : meter === "sandbox_minutes" ? 54 + index : 21 + index * 0.8),
            provider: "stripe" as const, externalEventId: status === "reported" ? `mtr_evt_${base36(`${seed}:meter-ext:${index}`, 18)}` : null, status,
            reportedAt: status === "reported" ? ago(0, index * 2 + 1) : null, metadata: { window: "hourly", ...(status === "failed" ? { error: "Stripe returned 429; retry scheduled." } : {}) }, createdAt: ago(0, index * 2 + 1),
          };
        }),
        invoices: invoiceTotals.map((total, index) => ({
          id: `inv_${hex(`${seed}:invoice:${index}`, 12)}`, tenantId, provider: "stripe" as const, externalInvoiceId: index === 0 ? null : `in_1${base36(`${seed}:invoice-ext:${index}`, 22)}`,
          status: index === 0 ? "draft" as const : index === 1 ? "open" as const : "paid" as const, totalMicros: usd(index === 0 ? Math.round(integrate(ORG_PROFILE, month(0), now, now)[COST] * scaleFor(ORG_PROFILE, now)[COST]) / 1e6 : total),
          currency: "usd", hostedInvoiceUrl: index === 0 ? null : `https://invoice.stripe.example/i/${hex(`${seed}:invoice-url:${index}`, 24)}`,
          periodStart: iso(month(-index)), periodEnd: iso(month(1 - index)), metadata: { purchaseOrder: "PO-2291-AI", seats: TOTAL_MEMBERS - index * 38 }, createdAt: iso(Math.min(now, month(1 - index))), updatedAt: iso(Math.min(now, month(1 - index) + 3 * DAY)),
        })),
        updatedAt: iso(now - 4 * 60_000),
      };
    },
    billingHealth: async () => ({ status: "healthy", provider: "stripe", reservationHealthy: true, ingestHealthy: true, explanation: "Reservations settle within 40 seconds and meter events are reported hourly. One meter event is retrying after a rate limit.", recoveryStatus: null }),
    billingLedger: async () => ({ items: ledger().entries, nextCursor: null, hasMore: false }),
    autoRefill: async () => ({ supported: true, enabled: true, triggerBalanceMicros: usd(50_000), purchaseAmountMicros: usd(100_000), currency: "usd" }),

    /* models */
    listOrganizationModelProviders: async () => [
      ...PROVIDERS.map((provider, index) => ({
        id: `omp_${provider.id}`, tenantId, providerId: provider.id, displayName: provider.label, kind: provider.kind, apiType: provider.api, baseUrl: provider.baseUrl, endpointPath: null, modelsPath: provider.id === "anthropic" ? "/v1/models" : "/models",
        authType: provider.auth, credentialRef: `vault:org/providers/${provider.id}`, defaultModel: MODELS.find((model) => model.group === provider.id)?.id ?? null, enabled: true, status: "active" as const,
        lastTestedAt: ago(0, 2 + index * 5), createdAt: ago(380 - index * 40), updatedAt: ago(3 + index * 6),
      })),
      { id: "omp_vllm_eu", tenantId, providerId: "vllm-eu", displayName: "On-prem vLLM (Frankfurt)", kind: "openai-compatible" as const, apiType: "openai-chat-completions" as const, baseUrl: "https://llm.fra.northwind.example/v1", endpointPath: "/chat/completions", modelsPath: "/models", authType: "bearer" as const, credentialRef: "vault:org/providers/vllm-eu", defaultModel: "qwen3-coder-32b", enabled: true, status: "error" as const, lastTestedAt: ago(0, 6), createdAt: ago(52), updatedAt: ago(0, 6) },
      { id: "omp_ollama_lab", tenantId, providerId: "ollama-lab", displayName: "Research lab Ollama", kind: "ollama" as const, apiType: "openai-chat-completions" as const, baseUrl: "http://ollama.lab.northwind.example:11434/v1", endpointPath: null, modelsPath: null, authType: "none" as const, credentialRef: null, defaultModel: "llama3.2", enabled: false, status: "disabled" as const, lastTestedAt: ago(73), createdAt: ago(140), updatedAt: ago(73) },
    ],
    testOrganizationModelProvider: async (_tenantId, providerId) => {
      const provider = PROVIDERS.find((entry) => entry.id === providerId) ?? PROVIDERS[0];
      return {
        id: `omp_${providerId}`, tenantId, providerId, displayName: provider.label, kind: provider.kind, apiType: provider.api, baseUrl: provider.baseUrl, endpointPath: null, modelsPath: "/models", authType: provider.auth,
        credentialRef: `vault:org/providers/${providerId}`, defaultModel: MODELS.find((model) => model.group === provider.id)?.id ?? null, enabled: true, status: "active", lastTestedAt: iso(Date.now()), createdAt: ago(380), updatedAt: iso(Date.now()),
      };
    },
    listOrgTaskModels: async (_tenantId, filter = {}) => {
      const policy = (providerId: string, model: string, displayName: string, api: DemoModel["api"], status: "allowed" | "blocked", capabilities: Awaited<ReturnType<BerryApiClient["listOrgTaskModels"]>>[number]["capabilities"], metadata: Record<string, string>, days: number) => ({
        id: `omp_model_${slugify(`${providerId}-${model}`)}`, tenantId, providerId, model, displayName, presetId: null, apiType: api, capabilities, status, enforce: status === "blocked", modeAllow: ["chat" as const, "code" as const], metadata, createdAt: ago(days + 60), updatedAt: ago(days),
      });
      const allowed = MODELS.map((model, index) => policy(model.group, model.id, model.label, model.api, "allowed", {
        tools: true, vision: model.vision, reasoning: true, reasoningEfforts: model.id.includes("mini") || model.id.includes("haiku") ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"], json: true,
        context: { windowTokens: model.window, maxOutputTokens: model.maxOutput },
        cost: { input: model.price[0], output: model.price[1], cacheRead: model.price[2], cacheWrite: model.price[3] },
        promptCaching: { supported: true, cacheKey: model.group === "openai", cacheControl: model.group === "anthropic", retention: model.group === "anthropic" ? ["short", "long"] : ["short"], minimumTokens: model.group === "anthropic" ? 1_024 : 4_096 },
      }, { tier: model.cost && model.cost > 2 ? "premium" : "standard" }, 4 + index * 9));
      const blocked = [
        policy("openai", "gpt-4o", "GPT-4o (retired)", "openai-chat-completions", "blocked", { tools: true, vision: true, json: true, context: { windowTokens: 128_000, maxOutputTokens: 16_384 }, cost: { input: 2.5, output: 10 } }, { reason: "Superseded by GPT-5 mini." }, 88),
        policy("router", "deepseek-r1", "DeepSeek R1", "openai-chat-completions", "blocked", { tools: false, reasoning: true, context: { windowTokens: 64_000, maxOutputTokens: 8_192 }, cost: { input: 0.55, output: 2.19 } }, { reason: "Pending data-processing review." }, 31),
        policy("vllm-eu", "qwen3-coder-32b", "Qwen3 Coder 32B (on-prem)", "openai-chat-completions", "blocked", { tools: true, context: { windowTokens: 131_072, maxOutputTokens: 16_384 }, cost: { input: 0, output: 0 } }, { reason: "Provider health check failing." }, 2),
      ];
      return filter.includeBlocked ? [...allowed, ...blocked] : allowed;
    },
    listOrgModelDefaults: async () => [
      { tenantId, mode: "chat", providerId: "router", model: "kimi-2.6", enforce: false, updatedAt: ago(44) },
      { tenantId, mode: "code", providerId: "anthropic", model: "claude-sonnet-4-5", enforce: false, updatedAt: ago(44) },
    ],
    listOrgAuxiliaryModelDefaults: async () => [{ tenantId, purpose: "vision", providerId: "openai", model: "gpt-5-mini", updatedAt: ago(37) }],
    listOrgAiAccessRules: async (_tenantId, resource) => {
      const members = rankedMembers();
      const rows: Array<["org" | "department" | "user", string, "model" | "feature" | "skill" | "mcp" | "execution", string, "allowed" | "blocked", number]> = [
        ["org", tenantId, "model", "anthropic/claude-opus-4-5", "blocked", 61],
        ["department", departmentId("Research"), "model", "anthropic/claude-opus-4-5", "allowed", 61],
        ["department", departmentId("Engineering"), "model", "anthropic/claude-opus-4-5", "allowed", 61],
        ["user", at(members, 2).userId, "model", "anthropic/claude-opus-4-5", "allowed", 14],
        ["department", departmentId("Legal"), "model", "openai/gpt-5", "blocked", 30],
        ["department", departmentId("Legal"), "model", "openai/gpt-5-mini", "blocked", 30],
        ["org", tenantId, "feature", "image.generate", "blocked", 28],
        ["department", departmentId("Marketing"), "feature", "image.generate", "allowed", 28],
        ["department", departmentId("Product"), "feature", "image.generate", "allowed", 22],
        ["department", departmentId("People"), "execution", "sandbox", "blocked", 51],
        ["department", departmentId("Finance"), "mcp", "mcp_snowflake", "allowed", 26],
        ["department", departmentId("Sales"), "mcp", "mcp_salesforce", "allowed", 40],
        ["department", departmentId("Legal"), "skill", "contract-review", "allowed", 55],
        ["user", at(members, 7).userId, "execution", "sandbox", "blocked", 5],
      ];
      return rows
        .filter(([, , resourceType, resourceId]) => !resource || (resource.resourceType === resourceType && resource.resourceId === resourceId))
        .map(([scopeType, scopeId, resourceType, resourceId, effect, days], index) => ({ id: `air_${hex(`${seed}:air:${index}`, 12)}`, tenantId, scopeType, scopeId, resourceType, resourceId, effect, createdAt: ago(days + 2), updatedAt: ago(days) }));
    },

    /* capabilities and connectors */
    listOrganizationCapabilities: async () => organizationCapabilities(),
    organizationCapabilitySettings: async () => ({ skills: true, mcp: true }),
    effectiveCapabilities: async () => effectiveCapabilities(),
    organizationSkillPackage: async (_tenantId, id) => {
      const skill = skillSeeds.find((entry) => entry.id === id) ?? skillSeeds[0];
      return { content: skillContent(skill.id, skill.description), resourceFiles: skill.resources.map((path) => ({ path, contentBase64: btoa(`# ${path}\n\nDemo resource for the ${skill.id} skill.\n`) })) };
    },
    organizationSkillPackageFile: async (_tenantId, id, path) => ({ path, contentBase64: btoa(path === "SKILL.md" ? skillContent(id, skillSeeds.find((entry) => entry.id === id)?.description ?? id) : `# ${path}\n\nDemo resource for the ${id} skill.\n`) }),
    listOrganizationConnectors: async () => organizationConnectors(),
    googleConnectorConfiguration: async () => ({ configured: true, clientId: "481920337741-c0nnect0rs.apps.googleusercontent.example", hostedDomain: EMAIL_DOMAIN, pickerConfigured: true, pickerProjectNumber: "481920337741", status: "verified", lastTestedAt: ago(5), callbackUrl: "https://ai.northwind.example/v1/connectors/oauth/callback" }),
    listConnectors: async () => organizationConnectors().filter((item) => item.approvalStatus === "approved" && item.publicationStatus === "published" && item.enabled),
    listConnectorRequests: async () => organizationConnectors().filter((item) => item.id === "mcp_req_linear" || item.id === "mcp_req_pastebin"),
    listPersonalMcpServers: async () => personalMcpServers(),
    testPersonalMcpServer: async (id) => {
      const server = personalMcpServers().find((entry) => entry.id === id) ?? (personalMcpServers()[0] as PersonalMcpServer);
      return { ...server, lastCheckedAt: iso(Date.now()) };
    },
    listPersonalSkills: async () => personalSkills(),
    personalSkillPackage: async (id) => {
      const skill = personalSkills().find((entry) => entry.id === id) ?? (personalSkills()[0] as PersonalSkill);
      return { content: skill.content, resourceFiles: skill.resources.map((path) => ({ path, contentBase64: btoa(`# ${path}\n\nDemo resource for the ${skill.name} skill.\n`) })) };
    },

    /* memory and archive */
    listMemories: async (input = {}) => {
      const search = (input.search ?? "").toLowerCase();
      const items = memories().filter((memory) => (!input.scope || memory.scope === input.scope) && (!input.status || memory.status === input.status) && (!search || memory.content.toLowerCase().includes(search)));
      return { items: items.slice(0, input.limit ?? 50), nextCursor: null };
    },
    memorySettings: async () => ({ memoryEnabled: true, implicitMemoryEnabled: true }),
    exportMemories: async () => ({ items: memories(), versions: [] }),
    listArchivedTasksPage: async (filter = {}) => {
      const search = (filter.search ?? "").toLocaleLowerCase();
      const state = filter.state ?? "archived";
      const matched = archivedTasks().filter((task) =>
        (state === "all" ? true : state === "archived" ? task.archived && !task.deletedAt : Boolean(task.deletedAt))
        && (!filter.workspaceId || task.workspaceId === filter.workspaceId)
        && (!search || task.title.toLocaleLowerCase().includes(search)));
      const limit = filter.limit ?? 50;
      const offset = filter.cursor ? Number(filter.cursor) || 0 : 0;
      const hasMore = offset + limit < matched.length;
      return { items: matched.slice(offset, offset + limit), nextCursor: hasMore ? String(offset + limit) : null, hasMore };
    },
    deleteAllArchivedTasks: async () => ({ deletedCount: archivedTasks().filter((task) => task.archived && !task.deletedAt).length }),

    /* automations */
    listScheduledTasks: async () => automations().map((entry) => entry.task),
    listScheduledTaskRuns: async (id, limit = 30) => (automations().find((entry) => entry.task.id === id)?.runs ?? []).slice(0, limit),

    /* reports and alerts */
    reportSchedules: async () => {
      const rows: Array<[string, number, "csv" | "html", "daily" | "weekly" | "monthly", string[], "active" | "paused" | "disabled", number, number | null]> = [
        ["Monthly spend by department", 0, "html", "monthly", ["finance-ops", "cfo-office"], "active", -19, 11],
        ["Weekly engineering agent usage", 1, "csv", "weekly", ["eng-leads"], "active", -3, 4],
        ["Daily reliability digest", 3, "html", "daily", ["platform-oncall", "ai-admins"], "active", -0.4, 0.6],
        ["Opus watchlist", 2, "csv", "weekly", ["research-leads"], "paused", -5, 16],
        ["Blocked requests", 5, "csv", "daily", ["ai-admins"], "disabled", -1, 37],
      ];
      return rows.map(([name, view, format, cadence, recipients, status, nextDays, lastDays], index) => ({
        id: `rpt_${hex(`${seed}:report:${index}`, 10)}`, tenantId, name, savedViewId: `view_${hex(`${seed}:view:${view}`, 10)}`, format, cadence, timezone: "Europe/London",
        recipients: recipients.map((alias) => `${alias}@${EMAIL_DOMAIN}`), status, nextRunAt: status === "active" ? ago(nextDays) : null, lastRunAt: lastDays === null ? null : ago(lastDays), createdAt: ago(80 + index * 9), updatedAt: ago(index * 4 + 1),
      }));
    },
    reportRuns: async () => Array.from({ length: 16 }, (_, index) => {
      const schedule = at([2, 2, 1, 2, 2, 0, 2, 1, 2, 2, 3, 2, 1, 2, 2, 2], index);
      const status = index === 0 ? "running" as const : index === 5 ? "failed" as const : "delivered" as const;
      const started = Date.now() - Math.round((index * 0.9 + 0.02) * DAY);
      return {
        id: `run_${hex(`${seed}:run:${index}`, 12)}`, tenantId, scheduleId: `rpt_${hex(`${seed}:report:${schedule}`, 10)}`, windowKey: iso(started).slice(0, schedule === 0 ? 7 : 10), status,
        artifactRef: status === "delivered" ? `reports/${tenantId}/${iso(started).slice(0, 10)}/${hex(`${seed}:artifact:${index}`, 8)}.${schedule === 1 ? "csv" : "html"}` : null,
        error: status === "failed" ? "SMTP relay rejected two recipients (550 mailbox unavailable). Delivery retried to the remaining recipients." : null,
        startedAt: iso(started), completedAt: status === "running" ? null : iso(started + 42_000 + index * 3_100), createdAt: iso(started - 1_500),
      };
    }),
    alertDestinations: async () => [
      { id: "dest_ai_admins", tenantId, kind: "email", label: "AI platform admins", configured: true, emailRecipients: [`ai-admins@${EMAIL_DOMAIN}`], createdAt: ago(190), updatedAt: ago(41) },
      { id: "dest_finance", tenantId, kind: "email", label: "Finance operations", configured: true, emailRecipients: [`finance-ops@${EMAIL_DOMAIN}`, `cfo-office@${EMAIL_DOMAIN}`], createdAt: ago(170), updatedAt: ago(22) },
      { id: "dest_pagerduty", tenantId, kind: "webhook", label: "PagerDuty — platform on-call", configured: true, emailRecipients: [], createdAt: ago(133), updatedAt: ago(9) },
      { id: "dest_slack", tenantId, kind: "webhook", label: "Slack #ai-platform-alerts", configured: true, emailRecipients: [], createdAt: ago(133), updatedAt: ago(3) },
      { id: "dest_siem", tenantId, kind: "webhook", label: "SIEM intake (pending secret)", configured: false, emailRecipients: [], createdAt: ago(6), updatedAt: ago(6) },
    ],
    alertRules: async () => {
      const rows: Array<[string, "spend_threshold" | "quota_threshold" | "projected_overrun" | "credits" | "unusual_spend" | "request_volume" | "error_rate" | "latency" | "blocked_requests" | "system_health", boolean, number, number, string[], ("org" | "department") | null, string | null]> = [
        ["Organization spend reaches 80% of the monthly guardrail", "spend_threshold", true, 80, 1_440, ["dest_ai_admins", "dest_finance"], "org", tenantId],
        ["Engineering projected to overrun", "projected_overrun", true, 100, 1_440, ["dest_finance", "dest_slack"], "department", departmentId("Engineering")],
        ["Data Science unusual spend", "unusual_spend", true, 50, 360, ["dest_slack"], "department", departmentId("Data Science")],
        ["Prepaid credits below $60,000", "credits", true, 60_000, 60, ["dest_finance", "dest_ai_admins"], null, null],
        ["Error rate above 5% for 15 minutes", "error_rate", true, 5, 15, ["dest_pagerduty", "dest_slack"], null, null],
        ["P95 latency above 20 seconds", "latency", true, 20_000, 30, ["dest_slack"], null, null],
        ["Blocked requests spike", "blocked_requests", true, 250, 60, ["dest_ai_admins"], null, null],
        ["Request volume doubles hour over hour", "request_volume", false, 200, 60, ["dest_slack"], null, null],
        ["Router or billing health degraded", "system_health", true, 1, 5, ["dest_pagerduty"], null, null],
        ["Member allowance at 90%", "quota_threshold", true, 90, 1_440, ["dest_ai_admins"], null, null],
      ];
      return rows.map(([name, signal, enabled, threshold, windowMinutes, destinationIds, scopeType, scopeId], index) => ({
        id: `rule_${hex(`${seed}:rule:${index}`, 10)}`, tenantId, name, signal, enabled, ...(scopeType && scopeId ? { scopeType, scopeId } : {}), threshold, windowMinutes, destinationIds, createdAt: ago(120 - index * 7), updatedAt: ago(2 + index * 3),
      }));
    },
    alertDeliveries: async () => Array.from({ length: 18 }, (_, index) => {
      const destination = at(["dest_slack", "dest_pagerduty", "dest_ai_admins", "dest_finance", "dest_slack", "dest_siem"], index);
      const failed = destination === "dest_siem" || index === 7;
      const report = index % 5 === 4;
      return {
        id: `dlv_${hex(`${seed}:delivery:${index}`, 12)}`, tenantId, alertEventId: report ? null : `alev_${hex(`${seed}:alert-event:${index}`, 10)}`, reportRunId: report ? `run_${hex(`${seed}:run:${index % 16}`, 12)}` : null, destinationId: destination,
        attempt: failed ? 3 : 1, status: index === 0 ? "pending" as const : failed ? "failed" as const : "delivered" as const, providerMessageId: failed || index === 0 ? null : `msg_${base36(`${seed}:message:${index}`, 16)}`,
        error: failed ? (destination === "dest_siem" ? "Destination is not configured: signing secret missing." : "Webhook returned 503 after three attempts.") : null, createdAt: ago(0, 1 + index * 7),
      };
    }),

    /* platform */
    platformOverview: async () => {
      const now = Date.now();
      const scale = scaleFor(ORG_PROFILE, now);
      const today = Math.floor(now / DAY);
      const tenants = platformTenants();
      const series = Array.from({ length: 30 }, (_, index) => {
        const dayStart = (today - 29 + index) * DAY;
        const volume = integrate(ORG_PROFILE, dayStart, dayStart + DAY, now);
        const wobble = 0.97 + 0.06 * unit(`${seed}:platform-day:${today - 29 + index}`);
        const billed = Math.round(volume[COST] * scale[COST] * PLATFORM_RATIO * wobble);
        const requests = Math.round(volume[REQ] * scale[REQ] * PLATFORM_RATIO * wobble);
        return { ts: iso(dayStart), billedCostMicros: String(billed), rawCostMicros: String(Math.round(billed * 0.64)), requests, successRate: requests > 0 ? 1 - (volume[FAIL] / Math.max(volume[REQ], 1e-9)) * 1.15 : null };
      });
      const billed = series.reduce((sum, point) => sum + Number(point.billedCostMicros), 0);
      const requests = series.reduce((sum, point) => sum + point.requests, 0);
      const raw = Math.round(billed * 0.64);
      const operators = ["op_sara.lindholm", "op_devon.achebe", "op_mira.kovacs"];
      const activity: Array<[string, string, string, number]> = [
        ["tenant.lifecycle.suspended", "tnt_tidewater", "Invoice 62 days overdue; finance approved suspension (FIN-2207).", 0.4],
        ["rollout.updated", "artifacts", "Raised exposure from 25% to 50% after a clean week.", 0.9],
        ["tenant.credit_grant.created", "tnt_atlas", "Service credit for delayed meter reconciliation.", 1.6],
        ["router.price_snapshot.published", "prices-2026-11", "Monthly provider price refresh.", 2.2],
        ["tenant.provisioned", "tnt_solace", "Trial tenant for the robotics pilot.", 3.5],
        ["rollout.updated", "browser-sessions", "Opened the internal channel to dedicated deployments.", 4.1],
        ["tenant.support_view.started", "tnt_lumen", "SSO certificate rotation follow-up (SUP-9920).", 5.3],
        ["router.provider.failover", "openai", "Manual failover during the upstream incident.", 3.0],
        ["tenant.plan.changed", "tnt_orbital", "Moved from team to business at renewal.", 8.7],
        ["tenant.lifecycle.reactivated", "tnt_cobalt", "Payment method updated; billing block lifted pending settlement.", 9.4],
      ];
      return {
        tenants: tenants.length,
        activeTenants: tenants.filter((tenant) => tenant.lifecycle === "active" || tenant.lifecycle === "trial").length,
        billedSpendMicros: String(billed),
        rawCostMicros: String(raw),
        marginMicros: String(billed - raw),
        successfulRequestRate: 0.983,
        routerLagSeconds: 4,
        incidents: [
          { key: "router-volume", label: "Router volume", status: "healthy", detail: `${Math.round(requests / 1e5) / 10}M requests and roughly 318B tokens routed across ${tenants.length} organizations in the last 30 days.` },
          { key: "openai-upstream", label: "OpenAI upstream", status: "warning", detail: "Elevated 529 responses three days ago; automatic failover held task success above 97%." },
          { key: "billing-cobalt", label: "Billing reconciliation", status: "error", detail: "Cobalt Energy is blocked on a failed payment; two retries remain." },
        ],
        recentOperatorActivity: activity.map(([action, targetId, auditNote, days], index) => ({ id: `opact_${hex(`${seed}:operator:${index}`, 10)}`, action, targetId, actorUserId: at(operators, index), auditNote, createdAt: ago(days) })),
        series,
        topTenants: tenants.slice(0, 8).map((tenant) => ({
          tenantId: tenant.tenantId, name: tenant.name, billedCostMicros: tenant.tenantId === tenantId ? String(Math.round(billed / PLATFORM_RATIO)) : tenant.monthlySpendMicros,
          requests: Math.round((Number(tenant.monthlySpendMicros) / 212_000_000_000) * ORG_REQUESTS),
        })),
      };
    },
    platformOrganizations: async () => platformTenants(),
    platformBilling: async () => {
      const tenants = platformTenants();
      return {
        prepaidLiabilityMicros: String(tenants.reduce((sum, tenant) => sum + Number(tenant.prepaidBalanceMicros), 0)),
        consumedThisMonthMicros: String(tenants.reduce((sum, tenant) => sum + Number(tenant.monthlySpendMicros), 0)),
        invoicesDue: 3,
        failedPayments: 1,
        blockedTenants: tenants.filter((tenant) => tenant.billingHealth === "blocked").length,
        tenants,
      };
    },
    platformRouterHealth: async () => ({
      status: "degraded",
      contractVersion: "2026-10-01",
      priceSnapshotAt: ago(2, 5),
      eventLagSeconds: 4,
      signatureSuccessRate: 0.9997,
      providers: [
        { provider: "Berry Router", models: 11, requestShare: 0.38, latencyP95Ms: 7_100, errorRate: 0.011, status: "healthy" },
        { provider: "Anthropic", models: 5, requestShare: 0.34, latencyP95Ms: 11_400, errorRate: 0.009, status: "healthy" },
        { provider: "OpenAI", models: 6, requestShare: 0.17, latencyP95Ms: 13_100, errorRate: 0.031, status: "degraded" },
        { provider: "Google Vertex AI", models: 4, requestShare: 0.06, latencyP95Ms: 12_900, errorRate: 0.016, status: "healthy" },
        { provider: "AWS Bedrock", models: 7, requestShare: 0.04, latencyP95Ms: 12_200, errorRate: 0.012, status: "healthy" },
        { provider: "Self-hosted (tenant)", models: 9, requestShare: 0.01, latencyP95Ms: 18_600, errorRate: 0.044, status: "warning" },
      ],
    }),
    platformRollouts: async () => {
      const rows: Array<[string, "draft" | "internal" | "beta" | "gradual" | "general", number, string, string, string[], number | null, number]> = [
        ["artifacts", "gradual", 50, "all", "stable", ["tnt_meridian"], 2, 0.9],
        ["browser-sessions", "internal", 5, "dedicated", "internal", [], 1, 4.1],
        ["internal-sites", "beta", 15, "shared", "beta", ["tnt_northfield"], 2, 6],
        ["attachment-transfer", "general", 100, "all", "stable", [], null, 21],
        ["mobile-push-approvals", "general", 100, "all", "stable", [], null, 34],
        ["grounding-rerank-v2", "gradual", 25, "shared", "stable", ["tnt_lumen", "tnt_vantage"], 1.5, 2.5],
        ["voice-input", "beta", 10, "all", "beta", [], 3, 11],
        ["generative-ui", "draft", 0, "dedicated", "internal", [], 1, 1.2],
        ["sandbox-gpu-pool", "internal", 2, "dedicated", "internal", [], 0.5, 8],
        ["memory-v3-extractor", "gradual", 75, "all", "stable", ["tnt_kestrel"], 2, 3.3],
      ];
      return rows.map(([feature, status, exposurePercent, deploymentMode, channel, exclusions, rollback, days], index) => ({
        id: `rollout_${slugify(feature)}`, feature, status, exposurePercent, target: { deploymentMode, channel }, exclusions, errorRateRollbackPercent: rollback, ownerUserId: at(["op_sara.lindholm", "op_devon.achebe", "op_mira.kovacs"], index), updatedAt: ago(days),
      }));
    },
  };

  /* ------------------------------------------------------------------ proxy */

  const firstPlainObject = (args: readonly unknown[]): Record<string, unknown> | null => {
    for (const arg of args) {
      if (arg && typeof arg === "object" && !Array.isArray(arg) && Object.getPrototypeOf(arg) === Object.prototype) return arg as Record<string, unknown>;
    }
    return null;
  };
  const fallbacks = new Map<string, AnyFn>();
  const fallback = (name: string): AnyFn => {
    if (/^list/.test(name)) return async () => [];
    // Writes echo their input so optimistic screens keep rendering in demo mode.
    if (/^(upsert|update|create|set|bulk)/.test(name)) return async (...args: unknown[]) => firstPlainObject(args) ?? {};
    if (/^(delete|remove|revoke)/.test(name)) return async () => undefined;
    if (/^export.*Csv$/.test(name)) return async () => "note\nDemo mode has no data to export for this view.\n";
    return async () => null;
  };

  return new Proxy(implementation, {
    get(target, property) {
      if (typeof property !== "string" || property === "then") return undefined;
      const implemented = (target as Record<string, AnyFn | undefined>)[property];
      if (implemented) return implemented;
      if (!isDemoClientMethodName(property)) return undefined;
      let handler = fallbacks.get(property);
      if (!handler) {
        handler = fallback(property);
        fallbacks.set(property, handler);
      }
      return handler;
    },
  }) as unknown as BerryApiClient;
}

/** Share of organization usage that has no member, such as service accounts. */
const UNATTRIBUTED_SHARE = 0.016;
/** Outstanding invitations. */
const PENDING_MEMBERS = 40;
/** Active accounts with no activity in the last 30 days. */
const DORMANT_MEMBERS = 212;
/**
 * Property probes from runtimes and test tools that must not look like API
 * methods. Kept in step with `demo-management-client.lazy.ts` by hand: sharing
 * the helper would split it into an extra chunk on every route.
 */
const NON_METHOD_PROPERTIES = new Set(["then", "catch", "finally", "constructor", "toJSON", "toString", "valueOf", "inspect", "nodeType", "asymmetricMatch"]);
const isDemoClientMethodName = (property: string) => /^[a-z][A-Za-z0-9]*$/.test(property) && !NON_METHOD_PROPERTIES.has(property);

/** Names of the methods that return generated data, for tests and diagnostics. */
export const DEMO_MANAGEMENT_METHODS = [
  "usageAnalytics", "usageRequests", "usageRequestDetail", "myUsage", "myUsageRequests", "exportMyUsageCsv", "savedAnalyticsViews",
  "listOrgMembers", "listOrgMembersPage", "listDepartments", "listDepartmentsPage", "listMemberMobileDevices", "memberSkills", "authConfig", "effectivePermissions", "organizationProfile",
  "listRolePermissions", "listFeatureFlags", "listResourceAcls", "listSsoConnections", "listPolicyVersions", "listAuditEvents", "serviceAccounts", "createServiceAccount",
  "executionPolicy", "authenticationPolicy", "dataGovernancePolicy",
  "listBudgetLimits", "listAllowanceProfiles", "listAllowanceDefaults", "allowanceCycle", "allowanceBalances", "allowanceBalance", "allowanceAdjustments",
  "billingSummary", "billingHealth", "billingLedger", "autoRefill",
  "listOrganizationModelProviders", "testOrganizationModelProvider", "listOrgTaskModels", "listOrgModelDefaults", "listOrgAuxiliaryModelDefaults", "listOrgAiAccessRules",
  "listOrganizationCapabilities", "organizationCapabilitySettings", "effectiveCapabilities", "organizationSkillPackage", "organizationSkillPackageFile",
  "listOrganizationConnectors", "googleConnectorConfiguration", "listConnectors", "listConnectorRequests",
  "listPersonalMcpServers", "testPersonalMcpServer", "listPersonalSkills", "personalSkillPackage",
  "listMemories", "memorySettings", "exportMemories", "listArchivedTasksPage", "deleteAllArchivedTasks",
  "listScheduledTasks", "listScheduledTaskRuns",
  "reportSchedules", "reportRuns", "alertDestinations", "alertRules", "alertDeliveries",
  "platformOverview", "platformOrganizations", "platformBilling", "platformRouterHealth", "platformRollouts",
] as const satisfies readonly (keyof BerryApiClient)[];
