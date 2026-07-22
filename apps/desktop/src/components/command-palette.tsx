import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import {
  FileText,
  CodeXml,
  FolderOpen,
  GitFork,
  LayoutAlignLeft,
  LayoutList,
  MessageSquare,
  Monitor,
  Moon,
  Plus,
  Rocket,
  Settings,
  SquareTerminal,
  Sun,
  type LucideIcon,
} from "@berry/desktop-ui/lib/icons";
import type { Task } from "@berry/shared";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@berry/desktop-ui/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@berry/desktop-ui/components/ui/toggle-group";
import { host, timeAgo, useWorkbench } from "@/lib/berry";
import type { WorkspaceIndexSearchResult } from "@berry/shared";

type Scope = "all" | "actions" | "tasks" | "files";

interface FileTreeEntry {
  path: string;
  kind: "dir" | "file";
  size?: number;
}

interface PaletteFileResult {
  path: string;
  absolutePath?: string;
  snippet?: string;
}

interface PaletteAction {
  id: string;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  run: () => void;
}

/** Substring first, then subsequence, so "cmpal" still finds "command-palette". */
function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.includes(q)) return true;
  let index = 0;
  for (const char of t) {
    if (char === q[index]) index += 1;
    if (index === q.length) return true;
  }
  return false;
}

const FILE_RESULT_CAP = 50;

const SCOPE_OPTIONS: Array<{ value: Scope; label: string; icon: LucideIcon }> = [
  { value: "all", label: "All", icon: LayoutList },
  { value: "actions", label: "Actions", icon: Rocket },
  { value: "tasks", label: "Tasks", icon: MessageSquare },
  { value: "files", label: "Files", icon: FileText },
];

export function CommandPalette() {
  const { tasks, activeWorkspace, view, selectedConversationKind, setSelectedConversationKind, paletteOpen, setPaletteOpen, openTask, openHome, openSettings, setView } =
    useWorkbench();
  const { setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");

  // A leading ">" narrows to actions regardless of the toggle, mirroring editor palettes.
  const actionsOnly = query.startsWith(">");
  const text = (actionsOnly ? query.slice(1) : query).trim();
  const effectiveScope: Scope = actionsOnly ? "actions" : scope;

  useEffect(() => {
    if (!paletteOpen) {
      setQuery("");
      setScope("all");
    }
  }, [paletteOpen]);

  const close = () => setPaletteOpen(false);

  const workspaceId = activeWorkspace?.id;
  const taskSearch = useQuery({
    queryKey: ["task.search", workspaceId, text],
    queryFn: () =>
      host.call<Task[]>("task.search", {
        workspaceId: workspaceId ?? "",
        query: text,
        includeArchived: true,
        limit: 8,
      }),
    enabled: paletteOpen && Boolean(workspaceId) && text.length > 0 && (effectiveScope === "all" || effectiveScope === "tasks"),
    staleTime: 5_000,
  });

  const recentTasks = useMemo(
    () =>
      text.length > 0
        ? (taskSearch.data ?? [])
        : [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5),
    [taskSearch.data, tasks, text.length],
  );

  const fileScopeActive = effectiveScope === "all" || effectiveScope === "files";
  const { data: tree } = useQuery({
    queryKey: ["file.tree", workspaceId],
    queryFn: () => host.call<FileTreeEntry[]>("file.tree", { workspaceId: workspaceId ?? "" }),
    enabled: paletteOpen && Boolean(workspaceId) && fileScopeActive && text.length === 0,
    staleTime: 30_000,
  });
  const fileSearch = useQuery({
    queryKey: ["workspace.index.search", workspaceId, text],
    queryFn: () =>
      host.call<{ results: WorkspaceIndexSearchResult[] }>("workspace.index.search", {
        workspaceId: workspaceId ?? "",
        query: text,
        limit: FILE_RESULT_CAP,
      }),
    enabled: paletteOpen && Boolean(workspaceId) && fileScopeActive && text.length > 0,
    staleTime: 5_000,
  });

  const files = useMemo<PaletteFileResult[]>(() => {
    if (text.length > 0) {
      return (fileSearch.data?.results ?? []).map((result) => ({
        path: result.path,
        absolutePath: result.absolutePath,
        snippet: result.snippet,
      }));
    }
    return (tree ?? [])
      .filter((entry) => entry.kind === "file")
      .slice(0, FILE_RESULT_CAP)
      .map((entry) => ({ path: entry.path }));
  }, [fileSearch.data?.results, tree, text.length]);

  const activeTask = view.kind === "task" ? tasks.find((task) => task.id === view.taskId) ?? null : null;
  const creationKind = activeTask?.conversationKind ?? selectedConversationKind;
  const suggested: PaletteAction[] = [
    { id: "new-conversation", label: creationKind === "code" ? "New code chat" : "New chat", icon: Plus, shortcut: "⌘N", run: openHome },
    {
      id: "new-worktree-task",
      label: "New code chat in worktree",
      icon: GitFork,
      run: () => {
        openHome();
        setSelectedConversationKind("code");
        window.setTimeout(() => window.dispatchEvent(new CustomEvent("berry:new-worktree-task")), 0);
      },
    },
    { id: "open-workspace", label: "Open project", icon: FolderOpen, shortcut: "⌘O", run: openHome },
    { id: "settings", label: "Settings", icon: Settings, run: () => openSettings() },
  ];
  const panels: PaletteAction[] = [
    {
      id: "toggle-sidebar",
      label: "Toggle sidebar",
      icon: LayoutAlignLeft,
      shortcut: "⌘B",
      run: () => window.dispatchEvent(new CustomEvent("berry:toggle-sidebar")),
    },
    ...(activeTask?.conversationKind === "code" ? [{
      id: "toggle-terminal",
      label: "Toggle terminal",
      icon: SquareTerminal,
      shortcut: "⌘J",
      run: () => window.dispatchEvent(new CustomEvent("berry:toggle-terminal")),
    }] : []),
  ];
  const themes: PaletteAction[] = [
    { id: "theme-light", label: "Light", icon: Sun, run: () => setTheme("light") },
    { id: "theme-dark", label: "Dark", icon: Moon, run: () => setTheme("dark") },
    { id: "theme-system", label: "System", icon: Monitor, run: () => setTheme("system") },
  ];

  const matchActions = (actions: PaletteAction[]) => actions.filter((action) => fuzzyMatch(text, action.label));
  const visibleSuggested = matchActions(suggested);
  const visiblePanels = matchActions(panels);
  const visibleThemes = matchActions(themes);

  const showTasks = (effectiveScope === "all" || effectiveScope === "tasks") && recentTasks.length > 0;
  const showActions = effectiveScope === "all" || effectiveScope === "actions";
  const showFiles = fileScopeActive && Boolean(workspaceId) && files.length > 0;

  const runAction = (action: PaletteAction) => {
    action.run();
    close();
  };

  const renderActionGroup = (heading: string, actions: PaletteAction[]) =>
    actions.length > 0 && (
      <CommandGroup heading={heading}>
        {actions.map((action) => (
          <CommandItem key={action.id} value={action.id} onSelect={() => runAction(action)}>
            <action.icon />
            <span>{action.label}</span>
            {action.shortcut && <CommandShortcut>{action.shortcut}</CommandShortcut>}
          </CommandItem>
        ))}
      </CommandGroup>
    );

  return (
    // Composed from Dialog + Command (instead of CommandDialog) so shouldFilter can be
    // disabled: scope toggles, the ">" prefix, and the file cap need custom filtering.
    <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>Command palette</DialogTitle>
        <DialogDescription>Search actions, tasks, or files</DialogDescription>
      </DialogHeader>
      <DialogContent className="top-[38%] overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        <Command
          shouldFilter={false}
          className="**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
        >
          <CommandInput placeholder="Search actions, tasks, or files" value={query} onValueChange={setQuery} />
          <div className="flex items-center border-b px-3 py-2">
            <ToggleGroup
              type="single"
              size="sm"
              spacing={1}
              value={effectiveScope}
              onValueChange={(value) => {
                if (!value) return;
                setScope(value as Scope);
                if (actionsOnly && value !== "actions") setQuery(text);
              }}
              aria-label="Filter results"
            >
              {SCOPE_OPTIONS.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  className="h-7 gap-1.5 rounded-full px-3 text-xs"
                >
                  <option.icon className="size-3.5" />
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <CommandList className="max-h-[420px]">
            <CommandEmpty>No results found.</CommandEmpty>
            {showTasks && (
              <CommandGroup heading="Recent conversations">
                {recentTasks.map((task) => (
                  <CommandItem
                    key={task.id}
                    value={`task-${task.id}`}
                    onSelect={() => {
                      openTask(task.id);
                      close();
                    }}
                  >
                    {task.conversationKind === "code" ? <CodeXml /> : <MessageSquare />}
                    <span className="truncate">{task.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{timeAgo(task.updatedAt)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {showActions && renderActionGroup("Suggested", visibleSuggested)}
            {showActions && renderActionGroup("Panels", visiblePanels)}
            {showActions && renderActionGroup("Theme", visibleThemes)}
            {showFiles && (
              <CommandGroup heading="Files">
                {files.map((file) => (
                  <CommandItem
                    key={file.path}
                    value={`file-${file.path}`}
                    onSelect={() => {
                      setView({ kind: "files" });
                      close();
                    }}
                  >
                    <FileText />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-mono text-xs">{file.path}</span>
                      {file.snippet ? <span className="truncate text-xs text-muted-foreground">{file.snippet}</span> : null}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
