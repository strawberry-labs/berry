import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { CommandManifest, SkillManifest, SubagentManifest, Task } from "@berry/shared";
import { MessageSquare, SlashSquare, Users, WandSparkles } from "@berry/desktop-ui/lib/icons";
import { cn } from "@berry/desktop-ui/lib/utils";
import { host } from "@/lib/berry";
import { FileTypeIcon } from "@/lib/file-icons";
import {
  filterItems,
  MENTION_EMPTY,
  MENTION_HINTS,
  type DetectedTrigger,
  type MentionItem,
  type MentionSection,
  type MentionTrigger,
} from "@/lib/mentions";
import type { MentionCategory, PromptEditorHandle, PromptEditorMentions } from "@/components/prompt-editor";

interface FileListEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: "file" | "directory";
}
interface FileListResult {
  root: string;
  entries: FileListEntry[];
  truncated: boolean;
}

/** How many results to show before a query narrows things down. */
const RESTING_LIMIT = 10;
/** Hard cap on rendered rows while filtering — keeps huge repos snappy. */
const MAX_RESULTS = 50;

/** Menu-facing controller; also satisfies PromptEditorMentions so the editor's
 *  keyboard/detection plugins can drive it directly. */
export interface MentionsController extends PromptEditorMentions {
  trigger: MentionTrigger | null;
  sections: MentionSection[];
  flatItems: MentionItem[];
  activeIndex: number;
  hint: string;
  emptyText: string;
  loading: boolean;
  hasQuery: boolean;
  select: (item: MentionItem) => void;
  setActiveIndex: (index: number) => void;
}

export function useMentions({
  editorRef,
  workspaceId,
  taskId,
}: {
  editorRef: React.RefObject<PromptEditorHandle | null>;
  workspaceId: string | undefined;
  taskId?: string;
}): MentionsController {
  const [activeIndex, setActiveIndex] = React.useState(0);
  // Fed by the editor's detection plugin on every caret/content change.
  const [detected, setDetected] = React.useState<DetectedTrigger | null>(null);
  // trigger:query that was just dismissed with Esc, so it doesn't reopen.
  const [dismissed, setDismissed] = React.useState<string | null>(null);

  const onDetectedChange = React.useCallback((next: DetectedTrigger | null) => {
    setDetected((prev) => {
      if (prev === next) return prev;
      if (prev && next && prev.trigger === next.trigger && prev.query === next.query && prev.tokenStart === next.tokenStart) {
        return prev;
      }
      return next;
    });
  }, []);

  const dismissKey = detected ? `${detected.trigger}:${detected.query}` : null;
  const suppressed = dismissKey !== null && dismissed === dismissKey;
  const trigger = detected && !suppressed ? detected.trigger : null;
  const query = detected?.query ?? "";

  // Providers — only the active trigger fetches. Files/commands/skills/tasks are
  // fetched once (long staleTime) and filtered client-side.
  const wsParam = workspaceId ? { workspaceId, ...(taskId ? { taskId } : {}) } : undefined;
  const filesQuery = useQuery({
    queryKey: ["file.list", workspaceId, taskId],
    queryFn: () => host.call<FileListResult>("file.list", wsParam),
    enabled: trigger === "@" && Boolean(workspaceId),
    staleTime: 60_000,
  });
  const commandsQuery = useQuery({
    queryKey: ["command.list", workspaceId],
    queryFn: () => host.call<CommandManifest[]>("command.list", wsParam),
    enabled: trigger === "/",
    staleTime: 60_000,
  });
  const skillsQuery = useQuery({
    queryKey: ["skill.list", workspaceId],
    queryFn: () => host.call<SkillManifest[]>("skill.list", wsParam),
    enabled: trigger === "$",
    staleTime: 60_000,
  });
  const tasksQuery = useQuery({
    queryKey: ["task.list", workspaceId],
    queryFn: () => host.call<Task[]>("task.list", wsParam),
    enabled: trigger === "#" && Boolean(workspaceId),
    staleTime: 30_000,
  });
  const agentsQuery = useQuery({
    queryKey: ["agent.list", workspaceId],
    queryFn: () => host.call<{ agents: SubagentManifest[] }>("agent.list", wsParam),
    enabled: trigger === "/",
    staleTime: 60_000,
  });

  // Map raw provider data → items ONCE per data change (not per keystroke).
  // Files are pre-sorted dirs-first so the empty-query view needs no re-sort.
  const fileItems = React.useMemo<MentionItem[]>(() => {
    const items = (filesQuery.data?.entries ?? []).map((e) => ({
      id: `file:${e.relativePath}`,
      category: e.kind === "directory" ? "folders" : "files",
      label: e.name,
      description: e.relativePath,
      value: e.relativePath,
      keywords: [e.relativePath],
    }));
    items.sort((a, b) => Number(b.category === "folders") - Number(a.category === "folders"));
    return items;
  }, [filesQuery.data]);
  const commandItems = React.useMemo<MentionItem[]>(
    () =>
      (commandsQuery.data ?? [])
        .filter((c) => c.enabled)
        .map((c) => ({ id: `cmd:${c.name}`, category: "commands", label: `/${c.name}`, description: c.description, value: c.name, keywords: [c.name] })),
    [commandsQuery.data],
  );
  const skillItems = React.useMemo<MentionItem[]>(
    () =>
      (skillsQuery.data ?? [])
        .filter((s) => s.enabled)
        .map((s) => ({ id: `skill:${s.name}`, category: "skills", label: s.name, description: s.description, value: s.name, keywords: [s.name] })),
    [skillsQuery.data],
  );
  const taskItems = React.useMemo<MentionItem[]>(
    () =>
      (tasksQuery.data ?? [])
        .filter((t) => !t.archived)
        .map((t) => ({ id: `task:${t.id}`, category: "sessions", label: t.title, description: t.status, value: t.title, keywords: [t.title] })),
    [tasksQuery.data],
  );
  const agentItems = React.useMemo<MentionItem[]>(
    () =>
      (agentsQuery.data?.agents ?? [])
        .filter((a) => a.enabled)
        .map((a) => ({ id: `agent:${a.name}`, category: "subagents", label: a.name, description: a.description, value: a.name, keywords: [a.name] })),
    [agentsQuery.data],
  );

  const { sections, loading } = React.useMemo<{ sections: MentionSection[]; loading: boolean }>(() => {
    if (!trigger) return { sections: [], loading: false };
    // Hard cap the rendered rows — an unbounded list of thousands of matches is
    // what made `@` lag.
    const opts = { limit: query ? MAX_RESULTS : RESTING_LIMIT };
    const build = (title: string, key: string, items: MentionItem[], isLoading: boolean) => ({
      sections: [{ key, title, items: filterItems(items, query, opts) }],
      loading: isLoading,
    });
    if (trigger === "@") return build("Files", "files", fileItems, filesQuery.isLoading);
    if (trigger === "/") {
      // `/` surfaces both slash-commands and dispatchable sub-agents.
      return {
        sections: [
          { key: "commands", title: "Commands", items: filterItems(commandItems, query, opts) },
          { key: "subagents", title: "Agents", items: filterItems(agentItems, query, opts) },
        ],
        loading: commandsQuery.isLoading || agentsQuery.isLoading,
      };
    }
    if (trigger === "$") return build("Skills", "skills", skillItems, skillsQuery.isLoading);
    return build("Conversations", "sessions", taskItems, tasksQuery.isLoading);
  }, [
    trigger,
    query,
    fileItems,
    filesQuery.isLoading,
    commandItems,
    commandsQuery.isLoading,
    agentItems,
    agentsQuery.isLoading,
    skillItems,
    skillsQuery.isLoading,
    taskItems,
    tasksQuery.isLoading,
  ]);

  const flatItems = React.useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const open = trigger !== null && (flatItems.length > 0 || loading || query.length === 0);

  // Keep the highlighted row in range as results change.
  React.useEffect(() => {
    setActiveIndex((index) => (index >= flatItems.length ? 0 : index));
  }, [flatItems.length]);

  const select = React.useCallback(
    (item: MentionItem) => {
      if (!detected) return;
      // Pill shows the bare label (command labels carry a leading "/").
      const label = item.label.startsWith(detected.trigger) ? item.label.slice(1) : item.label;
      editorRef.current?.insertMention(
        {
          id: item.id,
          category: item.category as MentionCategory,
          label,
          markdown: `${detected.trigger}${item.value}`,
        },
        detected.trigger,
      );
      setDismissed(null);
    },
    [detected, editorRef],
  );

  const moveActive = React.useCallback(
    (delta: 1 | -1) => {
      setActiveIndex((i) => {
        const count = flatItems.length;
        return count === 0 ? 0 : (i + delta + count) % count;
      });
    },
    [flatItems.length],
  );

  const selectActive = React.useCallback((): boolean => {
    if (flatItems.length === 0) return false;
    const item = flatItems[Math.min(activeIndex, flatItems.length - 1)];
    if (!item) return false;
    select(item);
    return true;
  }, [flatItems, activeIndex, select]);

  const dismiss = React.useCallback(() => {
    setDismissed(dismissKey);
  }, [dismissKey]);

  return {
    open,
    trigger,
    sections,
    flatItems,
    activeIndex,
    hint: trigger ? MENTION_HINTS[trigger] : "",
    emptyText: trigger ? MENTION_EMPTY[trigger] : "",
    loading,
    hasQuery: query.length > 0,
    select,
    setActiveIndex,
    moveActive,
    selectActive,
    dismiss,
    onDetectedChange,
  };
}

function CategoryIcon({ category, label }: { category: string; label: string }) {
  if (category === "files" || category === "folders") return <FileTypeIcon path={label} isDirectory={category === "folders"} />;
  if (category === "commands") return <SlashSquare className="size-4 text-muted-foreground" />;
  if (category === "skills") return <WandSparkles className="size-4 text-muted-foreground" />;
  if (category === "subagents") return <Users className="size-4 text-muted-foreground" />;
  return <MessageSquare className="size-4 text-muted-foreground" />;
}

export function MentionMenu({
  controller,
  placement = "above",
}: {
  controller: MentionsController;
  /** "above" for bottom-anchored surfaces (composer); "below" for surfaces
   * near the top of the viewport (message editor). */
  placement?: "above" | "below";
}) {
  const { open, sections, flatItems, activeIndex, hint, emptyText, loading, hasQuery, select, setActiveIndex } = controller;
  // O(1) row-index lookup so rendering isn't O(n²) over the flat list.
  const indexById = React.useMemo(() => new Map(flatItems.map((item, i) => [item.id, i])), [flatItems]);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    if (!open) return;
    const container = scrollRef.current;
    const active = container?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (!container || !active) return;

    const itemTop = active.offsetTop;
    const itemBottom = itemTop + active.offsetHeight;
    const viewportTop = container.scrollTop;
    const viewportBottom = viewportTop + container.clientHeight;
    if (itemTop < viewportTop) container.scrollTop = itemTop;
    else if (itemBottom > viewportBottom) container.scrollTop = itemBottom - container.clientHeight;
  }, [open, activeIndex, flatItems]);

  if (!open) return null;

  return (
    <div
      className={cn(
        "berry-mention-menu absolute right-0 left-0 z-40 overflow-hidden",
        placement === "above" ? "bottom-full mb-2" : "top-full mt-2",
      )}
      role="listbox"
    >
      <div ref={scrollRef} data-mention-scroll className="max-h-72 overflow-y-auto py-1.5">
        {flatItems.length === 0 ? (
          <div className="berry-mention-status flex items-center gap-2 px-3.5 py-2.5 text-[13px] text-muted-foreground">
            {loading ? "Searching…" : hasQuery ? emptyText : hint}
          </div>
        ) : (
          sections.map((section) =>
            section.items.length === 0 ? null : (
              <div key={section.key}>
                <div className="berry-mention-section px-3.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {section.title}
                </div>
                {section.items.map((item) => {
                  const index = indexById.get(item.id) ?? 0;
                  const active = index === activeIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={cn("berry-mention-item flex w-full items-center gap-2.5 px-3.5 py-2 text-left", active && "is-active")}
                      onMouseEnter={() => setActiveIndex(index)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        select(item);
                      }}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        <CategoryIcon category={item.category} label={item.label} />
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-[13px] font-medium text-foreground">{item.label}</span>
                      {item.description ? (
                        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground" title={item.description}>{item.description}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ),
          )
        )}
        {flatItems.length > 0 ? (
          <div className="berry-mention-footer flex items-center gap-2 px-3.5 pt-1.5 pb-1 text-[12px] text-muted-foreground">
            {hint}
          </div>
        ) : null}
      </div>
    </div>
  );
}
