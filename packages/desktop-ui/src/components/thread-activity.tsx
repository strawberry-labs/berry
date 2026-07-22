import * as React from "react";
import type { SessionNoteKind } from "@berry/shared";
import {
  ArrowRight02,
  Bot,
  Brain,
  BookOpen,
  ChevronRight,
  CircleCheckIcon,
  CircleHelp,
  CircleHollow,
  Globe,
  ListTodo,
  NotebookPen,
  PencilLine,
  Rocket,
  Search,
  SquareTerminal,
  Wrench,
} from "@berry/desktop-ui/lib/icons";

import { Spinner } from "@berry/desktop-ui/components/ui/spinner";

import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { Markdown } from "@berry/desktop-ui/components/berry-markdown";

import {
  Collapsible,
  CollapsibleTrigger,
} from "@berry/desktop-ui/components/ui/collapsible";

import { AnimatedCollapse } from "@berry/desktop-ui/components/animated-collapse";
import { cn } from "@berry/desktop-ui/lib/utils";

export type ToolStatus = "running" | "completed" | "failed" | "denied";

export interface ActivityTool {
  toolCallId: string;
  name: string;
  title?: string | undefined;
  status: ToolStatus;
  /** Truncated output preview from tool.end / tool.update. */
  summary?: string | undefined;
  /** Full output text when persisted (settled messages). */
  output?: string | undefined;
  /** Tool input arguments (command, path, pattern, …). */
  args?: Record<string, unknown> | null | undefined;
  durationMs?: number | undefined;
  startedAt: number;
  /** Live child tool calls when this is a `task` (sub-agent) dispatch. */
  children?: ActivityTool[] | undefined;
}

/* ------------------------------------------------------------------------ */
/* Berry tool-family classification (Ka/Ga/$_ mapped to Berry tool names).  */
/* ------------------------------------------------------------------------ */

export type ToolFamily = "file-read" | "file-write" | "shell" | "search" | "explore" | "other";

const EXACT_FAMILY: Record<string, ToolFamily> = {
  read: "file-read",
  read_file: "file-read",
  write: "file-write",
  write_file: "file-write",
  edit: "file-write",
  edit_file: "file-write",
  apply_patch: "file-write",
  bash: "shell",
  todo_write: "other",
  glob: "search",
  grep: "search",
  list_files: "search",
  webfetch: "search",
  websearch: "search",
  web_search: "search",
  web_fetch: "search",
};

export function familyFromTool(name: string): ToolFamily {
  const key = name.trim().toLowerCase();
  const exact = EXACT_FAMILY[key];
  if (exact) return exact;
  // Berry's legacy regex chain (Ga), applied to dot/dash-normalized names so
  // Berry names like "file.read" classify the same way as "read_file".
  const n = key.replace(/[.-]/g, "_");
  if (/^(?:read|view|open|cat|head|tail|read_file)(?:_|$)/.test(n) || /^file_read/.test(n)) return "file-read";
  if (/(?:^|_)(?:edit|patch|replace|multi_edit|multiedit|write|create|save|apply_patch)(?:_|$)/.test(n)) return "file-write";
  if (/^(?:execute|run|exec|bash|shell|command|terminal)(?:_|$)/.test(n)) return "shell";
  if (/^(?:search|grep|find|fetch|web_search|web_fetch|webfetch|query|lookup|glob|list|ls|dir|tree)(?:_|$)/.test(n)) return "search";
  if (/^(?:explore|inspect)(?:_|$)/.test(n)) return "explore";
  return "other";
}

/* ---------------------- input extraction helpers ------------------------ */

function stringArg(args: ActivityTool["args"], ...keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function commandOf(tool: ActivityTool): string | undefined {
  return stringArg(tool.args, "command", "cmd", "script") ?? (familyFromTool(tool.name) === "shell" ? tool.title : undefined);
}

function filePathOf(tool: ActivityTool): string | undefined {
  return stringArg(tool.args, "path", "file_path", "filePath", "file") ?? tool.title;
}

function queryOf(tool: ActivityTool): string | undefined {
  return stringArg(tool.args, "pattern", "query", "url", "path", "glob") ?? tool.title;
}

function browserSessionOf(tool: ActivityTool): string | undefined {
  return stringArg(tool.args, "id", "sessionId", "session_id");
}

function browserUrlOf(tool: ActivityTool): string | undefined {
  const value = stringArg(tool.args, "url", "currentUrl", "current_url") ?? tool.title;
  return value && isLikelyUrl(value) ? value : undefined;
}

function outputOf(tool: ActivityTool): string | undefined {
  return tool.output ?? tool.summary;
}

function metaTextOf(tool: ActivityTool): string | undefined {
  const segments: string[] = [];
  if (typeof tool.durationMs === "number" && Number.isFinite(tool.durationMs)) {
    segments.push(tool.durationMs >= 1000 ? `${(tool.durationMs / 1000).toFixed(1)}s` : `${Math.round(tool.durationMs)}ms`);
  }
  const args = tool.args ?? {};
  const truncated =
    args.truncated === true ||
    args.outputTruncated === true ||
    args.output_truncated === true ||
    args.bytesTruncated === true ||
    args.linesTruncated === true ||
    /\btruncat(?:ed|ion)\b/i.test(tool.summary ?? "");
  if (truncated) segments.push("truncated");
  return segments.length > 0 ? segments.join(" · ") : undefined;
}

/** Workspace root used to relativize file paths (Berry shows "apps/desktop/"). */
let workspaceRoot = "";
export function setActivityWorkspaceRoot(root: string | null | undefined): void {
  workspaceRoot = root ? root.replace(/\/+$/, "") : "";
}

function relativizePath(path: string): string {
  if (workspaceRoot && path.startsWith(`${workspaceRoot}/`)) return path.slice(workspaceRoot.length + 1);
  if (workspaceRoot && path === workspaceRoot) return "";
  return path;
}

function splitPath(path: string): { base: string; dir?: string } {
  const rel = relativizePath(path);
  const slash = rel.lastIndexOf("/");
  if (slash === -1) return { base: rel };
  return { base: rel.slice(slash + 1), dir: rel.slice(0, slash + 1) };
}

/* --------------- Berry Explore grouping (get/CX/pet/met) ---------------- */

const READ_CMD =
  /\b(rg|grep|find|ls|cat|head|tail|wc|stat|pwd|which|readlink|tree|sed\s+-n|get-childitem|gci|dir|get-content|gc|type|select-string|sls|get-location|test-path|resolve-path)\b|^git\s+(status|log|show|diff)\b/i;
const WRITE_CMD =
  /\b(sed\s+-i|perl\s+-pi|tee|mv|cp|rm|mkdir|rmdir|touch|truncate|chmod|chown|remove-item|del|erase|set-content|add-content|clear-content|out-file|new-item|move-item|copy-item|rename-item|set-item)\b|^git\s+(add|commit|rm|mv|checkout|switch|restore|reset|clean|revert|cherry-pick|merge|rebase)\b/i;
const REDIRECT = /(^|[^\d<])>>?\s*\S|&>\s*\S/i;
const LOOP = /\b(for|while)\b/i;

export function isExploreEligible(tool: ActivityTool): boolean {
  const family = familyFromTool(tool.name);
  if (family === "file-write") return false;
  if (family === "file-read" || family === "search" || family === "explore") return true;
  if (family !== "shell") return false;
  const command = commandOf(tool);
  if (!command) return false;
  const commands = command.split(/&&|\|\||;|\|/).map((part) => part.trim()).filter(Boolean);
  if (commands.length === 0) return false;
  if (commands.some((cmd) => WRITE_CMD.test(cmd) || REDIRECT.test(cmd))) return false;
  if (commands.some((cmd) => READ_CMD.test(cmd))) return true;
  return commands.some((cmd) => LOOP.test(cmd) && READ_CMD.test(cmd));
}

/* -------------------- Explore bucket counts (itt/att) ------------------- */

type ExploreBucket = "search" | "list" | "file";

function bucketFor(tool: ActivityTool): ExploreBucket {
  // Normalize separators so names like "list_files" match \blist\b.
  const label = `${tool.name} ${tool.title ?? ""}`.toLowerCase().replace(/[._-]/g, " ");
  const cmd = (commandOf(tool) ?? "").toLowerCase();
  if (/(\bgrep\b|\bsearch\b|\bfetch\b|\bweb.?search\b|\bweb.?fetch\b)/.test(label) || /(^|\s)(rg|grep|ripgrep|git\s+grep)(\s|$)/.test(cmd)) {
    return "search";
  }
  if (/(\bglob\b|\bfind\b|\blist\b|\btree\b|\bdir\b|\bls\b)/.test(label) || /(^|\s)(ls|find|tree|dir)(\s|$)/.test(cmd)) {
    return "list";
  }
  return "file";
}

function exploreSummary(tools: ActivityTool[]): string {
  const counts: Record<ExploreBucket, number> = { search: 0, list: 0, file: 0 };
  for (const tool of tools) counts[bucketFor(tool)] += 1;
  const label: Record<ExploreBucket, [string, string]> = {
    search: ["search", "searches"],
    list: ["list", "lists"],
    file: ["file", "files"],
  };
  const segments = (Object.keys(counts) as ExploreBucket[])
    .filter((bucket) => counts[bucket] > 0)
    .map((bucket) => `${counts[bucket]} ${label[bucket][counts[bucket] === 1 ? 0 : 1]}`);
  return segments.length > 0 ? segments.join(", ") : "0 files";
}

/* ---------------- rolling summary (Berry Xq, implemented directly) ----------------- */

/** Berry Xq pacing constants: each summary item shows ≥800ms; at most two
 * items queue (current pending + newest); a pending item that waited >250ms
 * gets skipped in favor of the newest; the roll itself runs 300ms. */
const ROLL_MIN_SHOW_MS = 800;
const ROLL_STALE_MS = 250;
const ROLL_QUEUE_MAX = 2;
const ROLL_MS = 300;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

interface RollItem {
  key: string;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
}

interface QueuedRollItem {
  item: RollItem;
  queuedAt: number;
}

export function dequeueRollQueue<T extends { queuedAt: number }>(
  queue: T[],
  now: number,
): { next: T | null; rest: T[] } {
  const candidates = queue.length > 1 && now - queue[0]!.queuedAt > ROLL_STALE_MS ? queue.slice(-1) : queue;
  const [next, ...rest] = candidates;
  return { next: next ?? null, rest };
}

/**
 * Berry's `Xq`: the tool-row summary "rolodex". On `contentKey` change the new
 * content rolls up from below (y: 0.8em → 0) while the old rolls out the top
 * (y: 0 → -0.8em), both 300ms easeOutCubic, clipped by the
 * overflow-hidden wrapper. Changes are paced: each item is displayed at least
 * 800ms, at most two queue, and stale intermediates are skipped — this cadence
 * is what makes the roll readable instead of a flicker.
 */
function RollingSummary({
  contentKey,
  primaryText,
  secondaryText,
  enabled,
  sequence,
}: {
  contentKey: string;
  primaryText: React.ReactNode;
  secondaryText?: React.ReactNode | undefined;
  enabled: boolean;
  sequence?: RollItem[] | undefined;
}) {
  // Hook must run unconditionally — short-circuiting on `enabled` changes the
  // hook order when the row toggles and crashes the renderer.
  const reducedMotion = usePrefersReducedMotion();
  const animate = enabled && !reducedMotion;
  const incoming: RollItem = { key: contentKey, primary: primaryText, secondary: secondaryText };
  const sequenceKey = sequence?.map((item) => item.key).join("\u0000") ?? "";
  const [shown, setShown] = React.useState<RollItem>(() => (animate && sequence && sequence.length > 1 ? sequence[0]! : incoming));
  const [exiting, setExiting] = React.useState<RollItem | null>(null);
  const [entryMotion, setEntryMotion] = React.useState(animate);
  const shownRef = React.useRef(shown);
  const wasAnimatingRef = React.useRef(animate);
  const queueRef = React.useRef<QueuedRollItem[]>([]);
  const displayStartedAt = React.useRef(typeof performance !== "undefined" ? performance.now() : 0);
  const paceTimer = React.useRef<number | null>(null);
  const exitTimer = React.useRef<number | null>(null);

  React.useEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  React.useEffect(() => {
    const clearPace = () => {
      if (paceTimer.current !== null) {
        window.clearTimeout(paceTimer.current);
        paceTimer.current = null;
      }
    };
    const enqueue = (item: RollItem) => {
      const queue = queueRef.current;
      if (queue.some((entry) => entry.item.key === item.key)) return;
      const queued = { item, queuedAt: performance.now() };
      queueRef.current = queue.length === 0 ? [queued] : [queue[0]!, queued].slice(0, ROLL_QUEUE_MAX);
    };
    const cleanupTimers = () => {
      clearPace();
      if (exitTimer.current !== null) {
        window.clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
    };
    function show(item: RollItem) {
      setExiting(shownRef.current);
      setEntryMotion(true);
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
      exitTimer.current = window.setTimeout(() => {
        setExiting(null);
        exitTimer.current = null;
      }, ROLL_MS);
      shownRef.current = item;
      setShown(item);
      displayStartedAt.current = performance.now();
      clearPace();
      scheduleQueued();
    }
    function scheduleQueued() {
      if (paceTimer.current !== null || queueRef.current.length === 0) return;
      const elapsed = performance.now() - displayStartedAt.current;
      const delay = Math.max(0, ROLL_MIN_SHOW_MS - elapsed);
      paceTimer.current = window.setTimeout(() => {
        paceTimer.current = null;
        const { next, rest } = dequeueRollQueue(queueRef.current, performance.now());
        if (!next) {
          queueRef.current = [];
          return;
        }
        queueRef.current = rest;
        show(next.item);
      }, delay);
    }

    if (!animate) {
      wasAnimatingRef.current = false;
      clearPace();
      queueRef.current = [];
      shownRef.current = incoming;
      displayStartedAt.current = performance.now();
      setShown(incoming);
      setExiting(null);
      setEntryMotion(false);
      return cleanupTimers;
    }

    if (!wasAnimatingRef.current) {
      wasAnimatingRef.current = true;
      queueRef.current = [];
      shownRef.current = incoming;
      displayStartedAt.current = performance.now();
      setShown(incoming);
      setExiting(null);
      setEntryMotion(false);
      return cleanupTimers;
    }

    const items = sequence && sequence.length > 0 ? sequence : [incoming];
    const shownIndex = items.findIndex((item) => item.key === shownRef.current.key);
    const pendingItems = shownIndex === -1 ? items : items.slice(shownIndex + 1);
    for (const item of pendingItems) {
      if (item.key !== shownRef.current.key) enqueue(item);
    }
    if (shownRef.current.key !== incoming.key && !queueRef.current.some((entry) => entry.item.key === incoming.key)) {
      enqueue(incoming);
    }
    scheduleQueued();
    return cleanupTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey, sequenceKey, animate]);

  if (!animate) {
    return (
      <>
        {primaryText}
        {secondaryText}
      </>
    );
  }
  return (
    <span className="relative inline-flex min-w-0 items-center overflow-hidden align-middle">
      {exiting ? (
        <span key={`exit:${exiting.key}`} className="berry-roll-exit absolute inset-0 inline-flex min-w-0 items-center gap-2" aria-hidden>
          {exiting.primary}
          {exiting.secondary}
        </span>
      ) : null}
      <span
        key={shown.key}
        data-testid="rolling-summary-current"
        className={cn(entryMotion && "berry-roll-enter", "inline-flex min-w-0 max-w-full items-center gap-2")}
      >
        {shown.primary}
        {shown.secondary}
      </span>
    </span>
  );
}

/* ------------------ open-state + entrance-anim caches -------------------- */

/** Berry Zq: per-tool open state, in-memory only. */
const openMap = new Map<string, boolean>();
/** Berry FZ: tool ids that already ran their entrance animation. */
const seenAnimation = new Map<string, true>();
const SEEN_CAP = 800;

function useEntranceAnimation(key: string, active: boolean): boolean {
  const [animate, setAnimate] = React.useState(() => active && !seenAnimation.has(key));
  React.useEffect(() => {
    if (!animate) return;
    seenAnimation.set(key, true);
    if (seenAnimation.size > SEEN_CAP) {
      const first = seenAnimation.keys().next().value;
      if (first) seenAnimation.delete(first);
    }
    const timer = window.setTimeout(() => setAnimate(false), 1000);
    return () => window.clearTimeout(timer);
  }, [animate]);
  return animate;
}

/* ------------------------- ToolLayout ($q/e5e) --------------------------- */

interface ToolLayoutProps {
  toolId: string;
  icon?: React.ReactNode;
  showIcon?: boolean;
  canToggle?: boolean;
  defaultOpen?: boolean;
  /**
   * Berry agent-row behavior: expand while running, then auto-collapse to the
   * header the moment the step settles (unless the user toggled it).
   */
  autoCollapseOnComplete?: boolean;
  kindLabel: string;
  isRunning?: boolean;
  /** Render the kind label in bright foreground (Berry does this for SubAgent). */
  strongLabel?: boolean;
  /** Accent detail rendered right after the kind label (e.g. agent-name pill). */
  kindDetail?: React.ReactNode;
  /** Extra summary content after the kind label. */
  primaryText?: React.ReactNode;
  /** Berry $q: replaces primaryText while the row is expanded (e.g. Explore
   * shows the rolling live action collapsed, the static counts when open). */
  expandedPrimaryText?: React.ReactNode;
  secondaryText?: React.ReactNode | undefined;
  metaText?: string | undefined;
  hideSecondaryTextWhenOpen?: boolean;
  separator?: string;
  /** Berry $q animateSummaryContent: roll the summary when its key changes. */
  animateSummaryContent?: boolean;
  /** Berry $q summaryContentKey: identity of the current summary content. */
  summaryContentKey?: string;
  /** Ordered child actions, used when several tool events arrive before paint. */
  summarySequence?: RollItem[];
  statusLabel?: string | undefined;
  children?: React.ReactNode;
}

function ToolLayout({
  toolId,
  icon,
  showIcon = true,
  canToggle = true,
  defaultOpen = false,
  autoCollapseOnComplete = false,
  kindLabel,
  isRunning = false,
  strongLabel = false,
  kindDetail,
  primaryText,
  expandedPrimaryText,
  secondaryText,
  metaText,
  hideSecondaryTextWhenOpen = false,
  separator,
  animateSummaryContent = false,
  summaryContentKey,
  summarySequence,
  statusLabel,
  children,
}: ToolLayoutProps) {
  const [open, setOpenState] = React.useState(() => openMap.get(toolId) ?? defaultOpen);
  const setOpen = (value: boolean) => {
    openMap.set(toolId, value);
    setOpenState(value);
  };
  // Auto-collapse when a running step finishes (Berry's autoCollapseOnComplete),
  // unless the user has taken over the disclosure by clicking it.
  const userInteracted = React.useRef(false);
  const wasRunning = React.useRef(isRunning);
  React.useEffect(() => {
    if (!autoCollapseOnComplete) return;
    if (wasRunning.current && !isRunning && !userInteracted.current) setOpen(false);
    wasRunning.current = isRunning;
  }, [autoCollapseOnComplete, isRunning]);
  const effectiveOpen = canToggle && open;

  return (
    <Collapsible
      open={effectiveOpen}
      onOpenChange={(value) => {
        if (!canToggle) return;
        userInteracted.current = true;
        setOpen(value);
      }}
      className="flex w-full flex-col"
    >
      <CollapsibleTrigger
        disabled={!canToggle}
        className={cn(
          "group/tool-summary items-center gap-2 text-left text-[13px] transition-colors",
          canToggle
            ? "inline-flex max-w-full cursor-pointer self-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-sm"
            : "flex w-full cursor-default focus-visible:outline-none",
        )}
        aria-expanded={effectiveOpen}
      >
        {showIcon ? (
          <span className="shrink-0 text-muted-foreground/70 [&_svg]:text-muted-foreground/70">{icon}</span>
        ) : null}
        <span
          className={cn(
            "shrink-0 whitespace-nowrap font-medium",
            isRunning ? "berry-shimmer" : strongLabel ? "text-foreground" : "text-muted-foreground/70",
          )}
        >
          {kindLabel}
        </span>
        {kindDetail}
        <span className="flex min-w-0 max-w-full items-center gap-2 text-muted-foreground/70">
          {separator ? <span className="shrink-0">{separator}</span> : null}
          {/* Berry $q: expanded rows show the static expanded text; collapsed
              rows show the (optionally rolling) live summary. */}
          <RollingSummary
            contentKey={summaryContentKey ?? `${toolId}:${statusLabel ?? ""}`}
            primaryText={effectiveOpen && expandedPrimaryText !== undefined ? expandedPrimaryText : primaryText}
            secondaryText={secondaryText && !(hideSecondaryTextWhenOpen && effectiveOpen) ? secondaryText : undefined}
            enabled={animateSummaryContent && !effectiveOpen}
            sequence={summarySequence}
          />
          {metaText ? <span className="shrink-0 whitespace-nowrap text-muted-foreground/50">{metaText}</span> : null}
          {statusLabel ? <span className="shrink-0 whitespace-nowrap text-destructive/70">{statusLabel}</span> : null}
        </span>
        {canToggle ? (
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground/70 will-change-transform",
              "transition-[transform,opacity] duration-[var(--duration-quick)] ease-[var(--ease-in-out)]",
              effectiveOpen ? "rotate-90 opacity-100" : "rotate-0 opacity-0 group-hover/tool-summary:opacity-100",
            )}
          />
        ) : null}
      </CollapsibleTrigger>
      {canToggle ? (
        <AnimatedCollapse open={effectiveOpen}>
          <div className="pt-2">{children}</div>
        </AnimatedCollapse>
      ) : null}
    </Collapsible>
  );
}

/* --------------------------- per-family rows ----------------------------- */

function failureLabel(status: ToolStatus): string | undefined {
  if (status === "failed") return "Failed";
  if (status === "denied") return "Denied";
  return undefined;
}

/** Shell ("Ran") row: inline mono command; expands to the $-prefixed box. */
function ShellRow({ tool, showIcon }: { tool: ActivityTool; showIcon: boolean }) {
  const running = tool.status === "running";
  const command = commandOf(tool);
  const output = outputOf(tool);
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      icon={<SquareTerminal className="size-4 shrink-0" />}
      showIcon={showIcon}
      canToggle
      kindLabel={running ? "Running" : "Ran"}
      isRunning={running}
      secondaryText={command ? <code className="min-w-0 truncate font-mono">{command}</code> : undefined}
      metaText={metaTextOf(tool)}
      hideSecondaryTextWhenOpen
      statusLabel={failureLabel(tool.status)}
    >
      <div className="mb-2 space-y-3 rounded-xl border border-border bg-[var(--berry-panel-bg)] px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-start gap-2 font-mono text-[13px] text-foreground">
            <span className="shrink-0 text-muted-foreground">$</span>
            <pre className="block max-h-60 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words">{command ?? tool.title ?? tool.name}</pre>
          </div>
        </div>
        {output ? (
          <div className="space-y-1">
            <pre className="max-h-[25rem] overflow-auto whitespace-pre-wrap break-words font-mono text-[13px] text-muted-foreground">{output}</pre>
          </div>
        ) : running ? null : (
          <div className="space-y-1">
            <p className="font-mono text-[13px] text-muted-foreground">No output</p>
          </div>
        )}
      </div>
    </ToolLayout>
  );
}

/** File read row: never expandable; file-type icon + name + muted dir. */
function ReadRow({ tool, showIcon }: { tool: ActivityTool; showIcon: boolean }) {
  const running = tool.status === "running";
  const path = filePathOf(tool);
  const { base, dir } = path ? splitPath(path) : { base: tool.name, dir: undefined };
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      icon={<Search className="size-4 shrink-0" />}
      showIcon={showIcon}
      canToggle={false}
      kindLabel={running ? "Reading" : "Read"}
      isRunning={running}
      primaryText={
        path ? <FilePathButton path={path} label={base} /> : <span className="min-w-0 truncate font-medium">{base}</span>
      }
      secondaryText={dir ? <span className="min-w-0 truncate text-muted-foreground/70">{dir}</span> : undefined}
      metaText={metaTextOf(tool)}
      statusLabel={failureLabel(tool.status)}
    />
  );
}

function FilePathButton({ path, label }: { path: string; label: string }) {
  return (
    <span
      role="link"
      tabIndex={0}
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground hover:underline"
      title={path}
      onClick={(event) => {
        event.stopPropagation();
        openFilePath(path);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        openFilePath(path);
      }}
    >
      <FileTypeIcon path={path} />
      <span className="min-w-0 truncate font-medium">{label}</span>
    </span>
  );
}

function openFilePath(path: string, line?: number) {
  window.dispatchEvent(new CustomEvent("berry:open-file", { detail: { path, ...(line ? { line } : {}) } }));
}

function openBrowserTarget(url?: string, sessionId?: string) {
  window.dispatchEvent(new CustomEvent("berry:open-browser", { detail: { ...(url ? { url } : {}), ...(sessionId ? { sessionId } : {}) } }));
}

function isLikelyUrl(value: string): boolean {
  return /^(https?:|file:|about:)/i.test(value.trim());
}

function BrowserUrlButton({ url, sessionId, label }: { url?: string | undefined; sessionId?: string | undefined; label: string }) {
  return (
    <span
      role="link"
      tabIndex={0}
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground hover:underline"
      title={url ?? sessionId}
      onClick={(event) => {
        event.stopPropagation();
        openBrowserTarget(url, sessionId);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        openBrowserTarget(url, sessionId);
      }}
    >
      <Globe className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

/** Search/list row: never expandable; plain truncated query text. */
function SearchRow({ tool, showIcon }: { tool: ActivityTool; showIcon: boolean }) {
  const running = tool.status === "running";
  const isWeb = /web|fetch|url/i.test(tool.name);
  const isList = bucketFor(tool) === "list";
  const kind = running ? (isList ? "Listing" : "Searching") : isList ? "Listed" : "Searched";
  const query = queryOf(tool);
  const display = query && query.startsWith("/") ? relativizePath(query) : query;
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      icon={isWeb ? <Globe className="size-4 shrink-0" /> : <Search className="size-4 shrink-0" />}
      showIcon={showIcon}
      canToggle={false}
      kindLabel={kind}
      isRunning={running}
      primaryText={
        display && isWeb && isLikelyUrl(display)
          ? <BrowserUrlButton url={display} label={display} />
          : <span className="min-w-0 truncate">{display}</span>
      }
      metaText={metaTextOf(tool)}
      statusLabel={failureLabel(tool.status)}
    />
  );
}

/** Write/edit row: file chip in foreground; expandable when output exists. */
function EditRow({ tool, showIcon }: { tool: ActivityTool; showIcon: boolean }) {
  const running = tool.status === "running";
  const normalized = tool.name.toLowerCase().replace(/[.-]/g, "_");
  const isDelete = /(?:^|_)(delete|remove|rm|unlink)(?:_|$)/.test(normalized);
  const isWrite = /(?:^|_)(write|create|save)/.test(normalized);
  const kind = isDelete
    ? running
      ? "Deleting"
      : "Deleted"
    : running
      ? isWrite
        ? "Writing"
        : "Editing"
      : isWrite
        ? "Wrote"
        : "Edited";
  const path = filePathOf(tool);
  const { base, dir } = path ? splitPath(path) : { base: tool.name, dir: undefined };
  const output = outputOf(tool);
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      icon={<PencilLine className="size-4 shrink-0" />}
      showIcon={showIcon}
      canToggle={Boolean(output)}
      kindLabel={kind}
      isRunning={running}
      primaryText={
        path ? <FilePathButton path={path} label={base} /> : <span className="min-w-0 truncate font-medium">{base}</span>
      }
      secondaryText={dir ? <span className="min-w-0 truncate text-muted-foreground/70">{dir}</span> : undefined}
      metaText={metaTextOf(tool)}
      statusLabel={failureLabel(tool.status)}
    >
      {output ? (
        <pre className="mb-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-[var(--berry-panel-bg)] px-4 py-3 font-mono text-[13px] text-muted-foreground">
          {output}
        </pre>
      ) : null}
    </ToolLayout>
  );
}

/** Fallback row for MCP/unknown tools: capitalized kind + raw args box. */
function DefaultRow({ tool, showIcon }: { tool: ActivityTool; showIcon: boolean }) {
  const running = tool.status === "running";
  const kind = tool.name
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const output = outputOf(tool);
  const raw = tool.args && Object.keys(tool.args).length > 0 ? JSON.stringify(tool.args, null, 2) : undefined;
  const browserUrl = /^browser[._-]/i.test(tool.name) ? browserUrlOf(tool) : undefined;
  const browserSessionId = /^browser[._-]/i.test(tool.name) ? browserSessionOf(tool) : undefined;
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      icon={<Wrench className="size-4 shrink-0" />}
      showIcon={showIcon}
      canToggle={Boolean(output || raw)}
      kindLabel={running ? kind : kind}
      isRunning={running}
      primaryText={
        browserUrl || browserSessionId
          ? <BrowserUrlButton url={browserUrl} sessionId={browserSessionId} label={browserUrl ?? browserSessionId ?? "Browser session"} />
          : tool.title && tool.title !== tool.name
            ? <span className="min-w-0 truncate">{tool.title}</span>
            : undefined
      }
      metaText={metaTextOf(tool)}
      statusLabel={failureLabel(tool.status)}
    >
      <div className="mb-2 space-y-2">
        {raw ? (
          <pre className="max-h-48 overflow-auto rounded-xl bg-[var(--berry-surface-inset)] px-4 py-3 font-mono text-[10px] text-muted-foreground">{raw}</pre>
        ) : null}
        {output ? (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-[var(--berry-panel-bg)] px-4 py-3 font-mono text-[13px] text-muted-foreground">
            {output}
          </pre>
        ) : null}
      </div>
    </ToolLayout>
  );
}

function SkillRow({ tool, showIcon }: { tool: ActivityTool; showIcon: boolean }) {
  const running = tool.status === "running";
  const name = stringArg(tool.args, "skill", "skillName", "skill_name", "name", "id") ?? tool.title ?? "Skill";
  const output = outputOf(tool);
  const raw = tool.args && Object.keys(tool.args).length > 0 ? JSON.stringify(tool.args, null, 2) : undefined;
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      icon={<Rocket className="size-4 shrink-0" />}
      showIcon={showIcon}
      canToggle={Boolean(output || raw)}
      kindLabel={running ? "Running skill" : "Skill"}
      isRunning={running}
      primaryText={<span className="min-w-0 truncate">{name}</span>}
      metaText={metaTextOf(tool)}
      statusLabel={failureLabel(tool.status)}
    >
      <div className="mb-2 space-y-2">
        {raw ? (
          <pre className="max-h-48 overflow-auto rounded-xl bg-[var(--berry-surface-inset)] px-4 py-3 font-mono text-[10px] text-muted-foreground">{raw}</pre>
        ) : null}
        {output ? (
          <Markdown className="rounded-xl border border-border bg-[var(--berry-panel-bg)] px-4 py-3 text-[13px] text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            {output}
          </Markdown>
        ) : null}
      </div>
    </ToolLayout>
  );
}

function AskUserQuestionRow({ tool, showIcon }: { tool: ActivityTool; showIcon: boolean }) {
  const running = tool.status === "running";
  const question = stringArg(tool.args, "question", "prompt") ?? tool.title ?? "User input requested";
  const optionsRaw = Array.isArray(tool.args?.options) ? tool.args.options : [];
  const answer = stringArg(tool.args, "answer") ?? outputOf(tool);
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      icon={<CircleHelp className="size-4 shrink-0" />}
      showIcon={showIcon}
      canToggle={optionsRaw.length > 0 || Boolean(answer)}
      kindLabel={running ? "Asking" : "Question"}
      isRunning={running}
      primaryText={<span className="min-w-0 truncate">{question}</span>}
      metaText={metaTextOf(tool)}
      statusLabel={failureLabel(tool.status)}
    >
      <div className="mb-2 space-y-2 rounded-xl border border-border bg-[var(--berry-panel-bg)] px-4 py-3 text-[13px]">
        <p className="text-foreground">{question}</p>
        {optionsRaw.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {optionsRaw.map((option, index) => {
              const record = option && typeof option === "object" ? (option as Record<string, unknown>) : {};
              const label = typeof record.label === "string" ? record.label : String(option);
              const description = typeof record.description === "string" ? record.description : undefined;
              return (
                <span key={`${index}-${label}`} className="inline-flex max-w-full flex-col rounded-md border border-border bg-[var(--berry-surface-inset)] px-2 py-1">
                  <span className="truncate font-medium text-foreground">{label}</span>
                  {description ? <span className="truncate text-muted-foreground">{description}</span> : null}
                </span>
              );
            })}
          </div>
        ) : null}
        {answer ? <p className="text-muted-foreground">Answer: {answer}</p> : null}
      </div>
    </ToolLayout>
  );
}

function GoalRow({ tool, showIcon }: { tool: ActivityTool; showIcon: boolean }) {
  const running = tool.status === "running";
  const goal = stringArg(tool.args, "goal", "goal_text", "goalText", "target", "title") ?? tool.title ?? "Session goal";
  const status = stringArg(tool.args, "status");
  const output = outputOf(tool);
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      icon={<NotebookPen className="size-4 shrink-0" />}
      showIcon={showIcon}
      canToggle={Boolean(output)}
      kindLabel={running ? "Updating goal" : "Goal"}
      isRunning={running}
      primaryText={<span className="min-w-0 truncate">{goal}</span>}
      secondaryText={status ? <span className="shrink-0 capitalize">{status.replace(/[_-]/g, " ")}</span> : undefined}
      metaText={metaTextOf(tool)}
      statusLabel={failureLabel(tool.status)}
    >
      {output ? (
        <Markdown className="mb-2 rounded-xl border border-border bg-[var(--berry-panel-bg)] px-4 py-3 text-[13px] text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {output}
        </Markdown>
      ) : null}
    </ToolLayout>
  );
}

function SessionContextRow({ tool, showIcon }: { tool: ActivityTool; showIcon: boolean }) {
  const running = tool.status === "running";
  const query = stringArg(tool.args, "query", "reason", "context", "summary") ?? tool.title ?? "Session context";
  const output = outputOf(tool);
  return (
    <ToolLayout
      toolId={tool.toolCallId}
      icon={<BookOpen className="size-4 shrink-0" />}
      showIcon={showIcon}
      canToggle={Boolean(output || query)}
      kindLabel={running ? "Reading context" : "Session context"}
      isRunning={running}
      primaryText={<span className="min-w-0 truncate">{query}</span>}
      metaText={metaTextOf(tool)}
      statusLabel={failureLabel(tool.status)}
    >
      <div className="mb-2 space-y-2 rounded-xl border border-border bg-[var(--berry-panel-bg)] px-4 py-3 text-[13px]">
        <section>
          <h4 className="mb-1 font-medium text-muted-foreground/70">Query</h4>
          <p className="text-foreground">{query}</p>
        </section>
        {output ? (
          <section>
            <h4 className="mb-1 font-medium text-muted-foreground/70">Result</h4>
            <Markdown className="text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{output}</Markdown>
          </section>
        ) : null}
      </div>
    </ToolLayout>
  );
}

/* ------------------------------ Todo (Jtt) ------------------------------- */

type TodoStatus = "pending" | "in_progress" | "completed";
interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** Read the checklist off the `todo_write` call's arguments. */
function todosFromTool(tool: ActivityTool): TodoItem[] {
  const raw = tool.args && typeof tool.args === "object" ? (tool.args as Record<string, unknown>).todos : undefined;
  if (!Array.isArray(raw)) return [];
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content : "";
    if (!content) continue;
    const status: TodoStatus = record.status === "completed" || record.status === "in_progress" ? record.status : "pending";
    items.push({ content, status });
  }
  return items;
}

const TODO_ICON: Record<TodoStatus, typeof CircleCheckIcon> = {
  completed: CircleCheckIcon,
  in_progress: ArrowRight02,
  pending: CircleHollow,
};
const TODO_ICON_COLOR: Record<TodoStatus, string> = {
  completed: "text-emerald-500",
  in_progress: "text-foreground",
  pending: "text-muted-foreground/50",
};
const TODO_TEXT: Record<TodoStatus, string> = {
  pending: "text-muted-foreground",
  in_progress: "text-foreground",
  completed: "text-muted-foreground/50 line-through",
};

/**
 * Berry's todo panel (Jtt): a collapsible "Todo · <current> · N/M" header over a
 * tinted checklist. Current item = the in-progress one, else the first pending,
 * else the last. Only the label shimmers while running; default collapsed.
 */
function TodoRow({ tool, showIcon = true }: { tool: ActivityTool; showIcon?: boolean }) {
  const todos = todosFromTool(tool);
  if (todos.length === 0) return <DefaultRow tool={tool} showIcon={showIcon} />;
  const running = tool.status === "running";
  const completed = todos.filter((item) => item.status === "completed").length;
  const current =
    todos.find((item) => item.status === "in_progress") ??
    todos.find((item) => item.status !== "completed") ??
    todos[todos.length - 1];

  return (
    <ToolLayout
      toolId={`${tool.toolCallId}:todo`}
      icon={<ListTodo className="size-4 shrink-0" />}
      showIcon={showIcon}
      canToggle
      kindLabel="Todo"
      isRunning={running}
      primaryText={current ? <span className="min-w-0 truncate">{current.content}</span> : null}
      secondaryText={
        <span className="shrink-0 font-mono text-[13px] tabular-nums">
          {completed}/{todos.length}
        </span>
      }
      metaText={metaTextOf(tool)}
    >
      <div className="space-y-1 rounded-xl bg-muted/40 px-3 py-2">
        {todos.map((item, index) => {
          const Icon = TODO_ICON[item.status];
          return (
            <div key={`${index}-${item.content}`} className="flex min-w-0 items-center gap-2 py-1">
              <Icon className={cn("size-3.5 shrink-0", TODO_ICON_COLOR[item.status])} />
              <span className={cn("min-w-0 break-words text-[13px]", TODO_TEXT[item.status])}>{item.content}</span>
            </div>
          );
        })}
      </div>
    </ToolLayout>
  );
}

function ToolRow({ tool, showIcon = true }: { tool: ActivityTool; showIcon?: boolean }) {
  if (tool.name === "todo_write") return <TodoRow tool={tool} showIcon={showIcon} />;
  if (/^(?:skill|skill[._-]invoke|invoke_skill)$/i.test(tool.name)) return <SkillRow tool={tool} showIcon={showIcon} />;
  if (/^(?:ask_user_question|ask[._-]user[._-]question|question[._-]ask)$/i.test(tool.name)) return <AskUserQuestionRow tool={tool} showIcon={showIcon} />;
  if (/^(?:goal|session[._-]target|target[._-]set|goal[._-](?:set|update))$/i.test(tool.name)) return <GoalRow tool={tool} showIcon={showIcon} />;
  if (/^(?:session[._-]context|read[._-]session[._-]context|context[._-]read)$/i.test(tool.name)) return <SessionContextRow tool={tool} showIcon={showIcon} />;
  const family = familyFromTool(tool.name);
  if (family === "shell") return <ShellRow tool={tool} showIcon={showIcon} />;
  if (family === "file-read") return <ReadRow tool={tool} showIcon={showIcon} />;
  if (family === "file-write") return <EditRow tool={tool} showIcon={showIcon} />;
  if (family === "search" || family === "explore") return <SearchRow tool={tool} showIcon={showIcon} />;
  return <DefaultRow tool={tool} showIcon={showIcon} />;
}

/* ------------------------ Explore group (utt) ---------------------------- */

/** DefaultRow's label: "workspace.scan" → "Workspace Scan". */
function prettyToolKind(name: string): string {
  return name
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Live verb + rich label for one tool call (Berry `aZ`): mono command for
 * shell, file chip for reads/writes, truncated query for searches, and a
 * prettified kind + title for everything else. `key` drives the roll-animation
 * remount when the action changes.
 */
function toolAction(active: ActivityTool): { key: string; node: React.ReactNode } | null {
  const family = familyFromTool(active.name);
  if (family === "shell") {
    const command = commandOf(active);
    if (command) {
      return {
        key: `shell:${active.toolCallId}:${command}`,
        node: (
          <>
            <span className="shrink-0">Running</span>
            <code className="min-w-0 truncate font-mono">{command}</code>
          </>
        ),
      };
    }
  }
  if (family === "file-read" || family === "file-write") {
    const path = filePathOf(active);
    if (path) {
      const { base } = splitPath(path);
      const normalized = active.name.toLowerCase().replace(/[.-]/g, "_");
      const verb =
        family === "file-read"
          ? "Reading"
          : /(?:^|_)(delete|remove|rm|unlink)(?:_|$)/.test(normalized)
            ? "Deleting"
            : /(?:^|_)(write|create|save)/.test(normalized)
              ? "Writing"
              : "Editing";
      return {
        key: `${verb}:${active.toolCallId}:${path}`,
        node: (
          <>
            <span className="shrink-0">{verb}</span>
            <FilePathButton path={path} label={base} />
          </>
        ),
      };
    }
  }
  if (family === "search" || family === "explore") {
    const query = queryOf(active);
    if (query) {
      const display = query.startsWith("/") ? relativizePath(query) : query;
      const verb = bucketFor(active) === "list" ? "Listing" : "Searching";
      return {
        key: `${verb}:${active.toolCallId}:${display}`,
        node: (
          <>
            <span className="shrink-0">{verb}</span>
            <span className="min-w-0 truncate">{display}</span>
          </>
        ),
      };
    }
  }
  // MCP / todo / unknown tools: prettified name plus the human title.
  return {
    key: `tool:${active.toolCallId}:${active.title ?? active.name}`,
    node: (
      <>
        <span className="shrink-0">{prettyToolKind(active.name)}</span>
        {active.title && active.title !== active.name ? <span className="min-w-0 truncate">{active.title}</span> : null}
      </>
    ),
  };
}

/**
 * Live action while a group runs (Berry `aZ`): the NEWEST describable child,
 * walking from the end — a verb ("Running" / "Reading" / "Listing" /
 * "Searching") plus the same rich label the child row would render. `key`
 * drives the summary roll.
 */
function liveChildAction(tools: ActivityTool[]): { key: string; node: React.ReactNode } | null {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const child = tools[index];
    if (!child) continue;
    const action = toolAction(child);
    if (action) return action;
  }
  return null;
}

/**
 * The turn's current activity, shown in the collapsed "Working…" header so a
 * collapsed-but-running turn is never a blank shimmer: the most recent running
 * tool (drilling into a running sub-agent's children), prefixed with its group
 * kind — "Explore · Reading …", "SubAgent · …" — like Berry's group summaries.
 */
export function latestTurnAction(tools: ActivityTool[]): { key: string; node: React.ReactNode } | null {
  if (tools.length === 0) return null;
  let active = [...tools].reverse().find((tool) => tool.status === "running") ?? tools[tools.length - 1]!;
  let prefix: string | null = null;
  if (active.name === "task") {
    prefix = "SubAgent";
    const childAction = active.status === "running" ? liveChildAction(active.children ?? []) : null;
    if (childAction) {
      return {
        key: `SubAgent:${childAction.key}`,
        node: (
          <>
            <span className="shrink-0 font-medium">SubAgent</span>
            <span className="shrink-0">·</span>
            {childAction.node}
          </>
        ),
      };
    }
    const args = active.args ?? {};
    const description = typeof args.description === "string" ? args.description : active.title;
    return {
      key: `task:${active.toolCallId}`,
      node: (
        <>
          <span className="shrink-0 font-medium">SubAgent</span>
          {description ? <span className="min-w-0 truncate">{description}</span> : null}
        </>
      ),
    };
  } else if (isExploreEligible(active)) {
    prefix = "Explore";
  }
  const action = toolAction(active);
  if (!action) return null;
  if (!prefix) return action;
  return {
    key: `${prefix}:${action.key}`,
    node: (
      <>
        <span className="shrink-0 font-medium">{prefix}</span>
        <span className="shrink-0">·</span>
        {action.node}
      </>
    ),
  };
}

function ExploreGroup({ tools, active, latest = false }: { tools: ActivityTool[]; active: boolean; latest?: boolean }) {
  const anyRunning = tools.some((tool) => tool.status === "running");
  // Exploration probes files that may not exist, so individual failed reads are
  // routine; only flag the group when nothing in it succeeded.
  const allProblem =
    tools.length > 0 && tools.every((tool) => tool.status === "failed" || tool.status === "denied");
  const groupId = `${tools[0]?.toolCallId ?? "explore"}:explore`;
  // Berry utt: while running, the collapsed summary is the newest child action
  // (rolling); the trailing group of a live turn keeps its action up between
  // calls to avoid flicker. Expanded and settled groups show the counts.
  const live = active && (latest || anyRunning);
  const liveActions = live
    ? tools.flatMap((tool) => {
        const action = toolAction(tool);
        return action ? [action] : [];
      })
    : [];
  const liveAction = liveActions[liveActions.length - 1] ?? null;
  const liveSequence = liveActions.map((action) => ({ key: action.key, primary: action.node }));
  const counts = <span className="min-w-0 truncate">{exploreSummary(tools)}</span>;
  return (
    <ToolLayout
      toolId={groupId}
      icon={<Search className="size-4 shrink-0" />}
      canToggle
      kindLabel="Explore"
      isRunning={live}
      separator="·"
      primaryText={liveAction ? liveAction.node : counts}
      expandedPrimaryText={counts}
      animateSummaryContent
      summaryContentKey={liveAction?.key ?? `explore:${groupId}:${live ? "running" : "done"}:${exploreSummary(tools)}`}
      summarySequence={liveSequence}
      metaText={tools.length > 0 ? metaTextOf(tools[tools.length - 1]!) : undefined}
      statusLabel={allProblem ? "Failed" : undefined}
    >
      <div className="ml-2 space-y-2 border-l border-border pl-3.5">
        {tools.map((tool) => (
          <ToolEntranceWrapper key={tool.toolCallId} tool={tool} active={active}>
            <ToolRow tool={tool} showIcon={false} />
          </ToolEntranceWrapper>
        ))}
      </div>
    </ToolLayout>
  );
}

/** Entrance fade per Berry: 0.9s cubic-bezier(.16,1,.3,1), once per tool id. */
function ToolEntranceWrapper({
  tool,
  active,
  children,
}: {
  tool: ActivityTool;
  active: boolean;
  children: React.ReactNode;
}) {
  const animate = useEntranceAnimation(`tool:${tool.toolCallId}`, active);
  return (
    <div
      className="w-full"
      data-tool-call-id={tool.toolCallId}
      data-tool-name={tool.name}
      data-status={tool.status}
      data-berry-tool-stream-animate={animate ? "true" : undefined}
    >
      {children}
    </div>
  );
}

/* ------------------------- ToolFlow (the walker) ------------------------- */

/**
 * Renders one consecutive run of tool calls the way Berry's message walker
 * does: consecutive explore-eligible calls collapse into one Explore group;
 * everything else renders as its own row. Rows/groups stack with gap-4.
 */
export function ToolFlow({
  tools,
  active = false,
  latest = false,
  showTodos = true,
}: {
  tools: ActivityTool[];
  active?: boolean;
  /** True when this flow is the trailing segment of a live turn. */
  latest?: boolean;
  showTodos?: boolean;
}) {
  const visibleTools = showTodos ? tools : tools.filter((tool) => tool.name !== "todo_write");
  if (visibleTools.length === 0) return null;
  const segments: Array<
    { kind: "explore"; tools: ActivityTool[] } | { kind: "single"; tool: ActivityTool } | { kind: "subagent"; tool: ActivityTool }
  > = [];
  for (const tool of visibleTools) {
    if (tool.name === "task") {
      segments.push({ kind: "subagent", tool });
    } else if (isExploreEligible(tool)) {
      const last = segments[segments.length - 1];
      if (last && last.kind === "explore") last.tools.push(tool);
      else segments.push({ kind: "explore", tools: [tool] });
    } else {
      segments.push({ kind: "single", tool });
    }
  }
  // A lone eligible call still gets the Explore treatment in Berry (it is an
  // aggregate of one); keep that behavior.
  return (
    <div className="flex w-full flex-col gap-4">
      {segments.map((segment, index) =>
        segment.kind === "explore" ? (
          <ExploreGroup
            key={`explore-${segment.tools[0]?.toolCallId ?? index}`}
            tools={segment.tools}
            active={active}
            latest={latest && index === segments.length - 1}
          />
        ) : segment.kind === "subagent" ? (
          <ToolEntranceWrapper key={segment.tool.toolCallId} tool={segment.tool} active={active}>
            <SubagentActivity tool={segment.tool} active={active} />
          </ToolEntranceWrapper>
        ) : (
          <ToolEntranceWrapper key={segment.tool.toolCallId} tool={segment.tool} active={active}>
            <ToolRow tool={segment.tool} />
          </ToolEntranceWrapper>
        ),
      )}
    </div>
  );
}

/* --- Sub-agent name accent (Berry Yet/Zet: deterministic hashed color) ----- */

const AGENT_COLORS = [
  "text-amber-700 dark:text-amber-300",
  "text-rose-700 dark:text-rose-300",
  "text-orange-700 dark:text-orange-300",
  "text-emerald-700 dark:text-emerald-300",
  "text-cyan-700 dark:text-cyan-300",
  "text-sky-700 dark:text-sky-300",
  "text-violet-700 dark:text-violet-300",
  "text-pink-700 dark:text-pink-300",
];

function agentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length]!;
}

/** Section box for the sub-agent prompt / output (Berry btt/gZ): the body is
 * markdown, exactly like Berry's `AP` renderer with first/last margins trimmed. */
function SubagentBox({ label, children, tinted }: { label: string; children: string; tinted?: boolean }) {
  return (
    <section className="space-y-2">
      <div className={cn("flex flex-col rounded-lg border border-border", tinted && "bg-muted/40")}>
        <h4 className="p-3 text-[13px] font-medium tracking-wide text-muted-foreground/70 uppercase">{label}</h4>
        <div className={cn("overflow-auto", tinted ? "max-h-64" : "max-h-52")}>
          <Markdown className="min-w-0 px-3 pb-2 text-[13px] break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            {children}
          </Markdown>
        </div>
      </div>
    </section>
  );
}

/**
 * Sub-agent dispatch (Berry's agent_activity): a collapsible bright "SubAgent"
 * header + (for a named agent) a hash-colored monospace pill + the task
 * description. Expands to a left-railed column: the prompt box, the subagent
 * output box, then the flat tool calls it ran. Auto-collapses on complete.
 */
function SubagentActivity({ tool, active = false }: { tool: ActivityTool; active?: boolean }) {
  const args = tool.args ?? {};
  const agentType =
    typeof args.subagent_type === "string" && args.subagent_type.trim() ? args.subagent_type.trim() : "general-purpose";
  // Berry only shows the colored agent-name pill for a specifically-named agent;
  // the default/general agent shows just "SubAgent · <description>".
  const named = agentType !== "general-purpose" && agentType !== "general";
  const description = typeof args.description === "string" ? args.description.trim() : "";
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const output = (tool.output ?? tool.summary ?? "").trim();
  const children = tool.children ?? [];
  const running = tool.status === "running";
  // Berry wtt: while running, the collapsed summary rolls the newest child
  // tool action (aZ) exactly like Explore; expanded/settled shows the task
  // description.
  const liveActions = running
    ? children.flatMap((child) => {
        const action = toolAction(child);
        return action ? [action] : [];
      })
    : [];
  const liveAction = liveActions[liveActions.length - 1] ?? null;
  const liveSequence = liveActions.map((action) => ({ key: action.key, primary: action.node }));
  const descriptionNode = description ? <span className="min-w-0 truncate">{description}</span> : null;

  return (
    <ToolLayout
      toolId={`${tool.toolCallId}:subagent`}
      icon={<Bot className="size-4 shrink-0" />}
      canToggle
      defaultOpen={active || running}
      autoCollapseOnComplete
      kindLabel="SubAgent"
      isRunning={running}
      strongLabel
      kindDetail={
        named ? (
          <span className={cn("inline-flex max-w-40 shrink-0 items-center truncate font-mono font-medium", agentColor(agentType))}>
            {agentType}
          </span>
        ) : undefined
      }
      separator="·"
      primaryText={liveAction ? liveAction.node : descriptionNode}
      expandedPrimaryText={descriptionNode}
      animateSummaryContent
      summaryContentKey={liveAction?.key ?? `agent:${tool.toolCallId}:${description}`}
      summarySequence={liveSequence}
      metaText={metaTextOf(tool)}
      statusLabel={tool.status === "failed" ? "Failed" : tool.status === "denied" ? "Denied" : undefined}
    >
      <div className="ml-2 flex flex-col gap-3 border-l border-border pl-3.5">
        {prompt ? <SubagentBox label="Prompt">{prompt}</SubagentBox> : null}
        {output ? (
          <SubagentBox label="Subagent output" tinted>
            {output}
          </SubagentBox>
        ) : null}
        {children.length > 0 ? (
          // The sub-agent's calls go through the same walker as top-level ones,
          // so consecutive explore-eligible calls fold into an Explore group
          // whose header rolls the latest child action while it runs.
          <ToolFlow tools={children} active={active && running} latest={active && running} />
        ) : null}
      </div>
    </ToolLayout>
  );
}

/* -------------------- Turn header (Working / Worked) --------------------- */

/**
 * Codex `RO`: the user's manual expand/collapse choice per turn, keyed by
 * session + turn ordinal. In-memory only, and shared between the live and
 * persisted render paths so a remount at turn settle can't reset the state.
 */
const turnCollapsedChoice = new Map<string, boolean>();
const CHOICE_CAP = 800;

function rememberTurnChoice(turnKey: string, collapsed: boolean): void {
  turnCollapsedChoice.delete(turnKey);
  turnCollapsedChoice.set(turnKey, collapsed);
  if (turnCollapsedChoice.size > CHOICE_CAP) {
    const first = turnCollapsedChoice.keys().next().value;
    if (first) turnCollapsedChoice.delete(first);
  }
}

/**
 * Drop remembered disclosure state (turn accordion choice + thought rows) for
 * a session's turn ordinal onward. Called when a fresh turn starts, so an
 * edit-and-resubmit rerun at the same ordinal cannot inherit the disclosure
 * of the turns it replaced (Codex keys by turnId, which makes this automatic
 * there; Berry keys by ordinal, so stale entries must be cleared).
 */
export function forgetTurnDisclosure(sessionId: string, fromOrdinal: number): void {
  const prefix = `${sessionId}:turn-`;
  for (const map of [turnCollapsedChoice, openMap]) {
    for (const key of [...map.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const ordinal = Number.parseInt(key.slice(prefix.length), 10);
      if (Number.isFinite(ordinal) && ordinal >= fromOrdinal) map.delete(key);
    }
  }
}

/**
 * Turn activity header + accordion: a muted "Working for Xs" / "Worked for Xs"
 * label over a hairline divider that collapses the whole turn's activity
 * (reasoning + tool rows), which stream in as its children.
 *
 * Disclosure is Berry-style and fully derived — never imperatively toggled by
 * stream events:
 * - The whole live run stays OPEN: every parent-level row (thoughts, Explore
 *   groups, tools, sub-agents, interim prose) streams in visibly; only the
 *   latest item animates (the Explore group's rolling summary, entrance fades).
 * - It collapses exactly once, when the turn settles.
 * - A manual toggle is always available and wins over both defaults; the
 *   choice persists per turn key across the live → settled handoff.
 * - If the user collapses a still-running turn, the latest tool action rolls
 *   on its own line under the divider so progress stays visible.
 */
export function TurnActivity({
  turnKey,
  active,
  elapsedMs,
  liveAction = null,
  summary,
  children,
}: {
  turnKey: string;
  active: boolean;
  elapsedMs?: number | undefined;
  /** Latest tool action, rolled in under the header while active + collapsed. */
  liveAction?: { key: string; node: React.ReactNode } | null;
  /** Compact mode's lossless roll-up; expanding still renders every tool row. */
  summary?: string | undefined;
  children?: React.ReactNode;
}) {
  const time = elapsedMs !== undefined && (!active || elapsedMs >= 1000) ? ` for ${formatDuration(elapsedMs)}` : "";
  const label = active ? `Working${time || "..."}` : `Worked${time}${summary ? ` — ${summary}` : ""}`;
  const hasChildren = React.Children.toArray(children).some(Boolean);
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);
  // Derived: open for the whole live run, collapsed once settled — unless the
  // user chose otherwise for this turn (the remembered choice always wins).
  const open = !(turnCollapsedChoice.get(turnKey) ?? !active);

  const labelSpan = (
    <span className={cn("berry-turn-summary-label tabular-nums", active && "berry-shimmer")}>{label}</span>
  );

  if (!hasChildren) {
    return <div className="flex w-full border-b border-border/50 pb-2">{labelSpan}</div>;
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={(value) => {
        rememberTurnChoice(turnKey, !value);
        rerender();
      }}
      className="flex w-full flex-col"
    >
      <CollapsibleTrigger
        className="berry-turn-summary group/turn flex w-full cursor-pointer items-center gap-2 border-b border-border/50 pb-2 text-left focus-visible:outline-none"
        aria-expanded={open}
        data-testid="turn-activity"
      >
        {labelSpan}
        {/* Unlike tool rows (hover-revealed), the turn accordion's chevron is
            always visible so collapsed turns are obviously expandable. */}
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground/70 will-change-transform",
            "transition-transform duration-[var(--duration-quick)] ease-[var(--ease-in-out)]",
            open ? "rotate-90" : "rotate-0",
          )}
        />
      </CollapsibleTrigger>
      {/* While the turn runs collapsed, the latest tool action rolls in on its
          own line under the divider (Berry group-summary style) so the header
          is never a blank shimmer while tool calls stream invisibly. */}
      {active && !open && liveAction ? (
        <div
          className="flex min-w-0 max-w-full items-center gap-2 pt-3 text-[13px] text-muted-foreground/70"
          data-testid="turn-activity-live-action"
        >
          <RollingSummary contentKey={liveAction.key} primaryText={liveAction.node} enabled />
        </div>
      ) : null}
      <AnimatedCollapse open={open}>
        <div className="flex flex-col gap-2 pt-3">{children}</div>
      </AnimatedCollapse>
    </Collapsible>
  );
}

/**
 * Berry's reasoning row: spinner + shimmering "Thinking" while text streams
 * in; brain icon + "Thought for a few seconds / for Xs" once done, expanding
 * to the reasoning text on a rail.
 */
export function ThoughtRow({
  active,
  reasoning,
  durationMs,
  defaultOpen = false,
  stateKey,
  autoCollapseKey = null,
  collapseWhenInactive = false,
}: {
  active: boolean;
  reasoning: string;
  durationMs?: number;
  defaultOpen?: boolean;
  /** Shared disclosure key (session + turn ordinal + thought ordinal) so the
   * open state survives the live → persisted remount at turn settle. */
  stateKey?: string;
  /** Berry `mnt`/`cnt`: identity of the next rendered part after this thought.
   * A CHANGE of this key collapses the row exactly once (unless the user has
   * toggled it); streaming merely stopping never collapses it. */
  autoCollapseKey?: string | null;
  /** Live rows should not keep their reasoning body open once another visible
   * part starts streaming; otherwise the hidden body creates extra vertical
   * space until the turn settles. */
  collapseWhenInactive?: boolean;
}) {
  const hasText = reasoning.trim().length > 0;
  const [open, setOpenState] = React.useState(
    () => (stateKey ? openMap.get(stateKey) : undefined) ?? ((active || defaultOpen) && hasText),
  );
  const setOpen = React.useCallback(
    (value: boolean) => {
      if (stateKey) openMap.set(stateKey, value);
      setOpenState(value);
    },
    [stateKey],
  );
  const userInteracted = React.useRef(false);
  // Berry `VZ`: open automatically while streaming.
  React.useEffect(() => {
    if (active && hasText && !userInteracted.current) setOpen(true);
  }, [active, hasText, setOpen]);
  // Berry `cnt`: collapse once when the next part appears after this thought.
  // The ref starts at the mount-time key, so settled rows (whose key never
  // changes) keep their defaultOpen/remembered state.
  const previousCollapseKey = React.useRef(autoCollapseKey);
  React.useEffect(() => {
    const previous = previousCollapseKey.current;
    previousCollapseKey.current = autoCollapseKey;
    if (autoCollapseKey != null && autoCollapseKey !== previous && !userInteracted.current) setOpen(false);
  }, [autoCollapseKey, setOpen]);
  React.useEffect(() => {
    if (!collapseWhenInactive || active || userInteracted.current) return;
    setOpen(false);
  }, [active, collapseWhenInactive, setOpen]);
  const effectiveOpen = open && hasText && !(collapseWhenInactive && !active && !userInteracted.current);

  const thinking = active && !hasText;
  const suffix = active
    ? ""
    : durationMs !== undefined && durationMs >= 10_000
      ? `for ${formatDuration(durationMs)}`
      : "for a few seconds";

  return (
    <Collapsible
      open={effectiveOpen}
      onOpenChange={(value) => {
        userInteracted.current = true;
        if (hasText) setOpen(value);
      }}
      className="flex w-full flex-col"
    >
      <CollapsibleTrigger
        disabled={!hasText}
        className={cn(
          "group/thought inline-flex max-w-full items-center gap-2 self-start text-left text-[13px] transition-colors",
          hasText ? "cursor-pointer" : "cursor-default",
        )}
        aria-expanded={effectiveOpen}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
          {thinking ? <Spinner className="size-3.5" /> : <Brain className="size-4" />}
        </span>
        <span className={cn("font-medium", active ? "berry-shimmer" : "text-muted-foreground/70")}>
          {active ? "Thinking" : "Thought"}
        </span>
        {suffix ? <span className="text-muted-foreground/60">{suffix}</span> : null}
        {hasText ? (
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground/70 will-change-transform",
              "transition-[transform,opacity] duration-[var(--duration-quick)] ease-[var(--ease-in-out)]",
              effectiveOpen ? "rotate-90 opacity-100" : "rotate-0 opacity-0 group-hover/thought:opacity-100",
            )}
          />
        ) : null}
      </CollapsibleTrigger>
      {hasText ? (
        <AnimatedCollapse open={effectiveOpen}>
          <div className="pt-2">
            <div className="ml-2 max-h-60 space-y-2 overflow-auto border-l border-border pl-3.5 text-[13px] text-muted-foreground">
              <p className="min-w-0 whitespace-pre-wrap break-words">{reasoning}</p>
            </div>
          </div>
        </AnimatedCollapse>
      ) : null}
    </Collapsible>
  );
}

/** Section break emitted by the agent (e.g. "compacted"). */
export function ActivityNote({
  children,
  note,
}: {
  children: string;
  note?: SessionNoteKind;
}) {
  const active = note === "steered" || note === "followed-up";
  return (
    <div data-session-note={note} className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
      <span className={cn("h-px min-w-0 flex-1", active ? "bg-primary/30" : "bg-border/70")} />
      <span
        className={cn(
          "max-w-full truncate",
          active && "rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-primary",
        )}
      >
        {children}
      </span>
      <span className={cn("h-px min-w-0 flex-1", active ? "bg-primary/30" : "bg-border/70")} />
    </div>
  );
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}
