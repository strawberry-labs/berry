import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from "@berry/desktop-ui/lib/icons";
import { FileTypeIcon } from "@/lib/file-icons";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@berry/desktop-ui/components/ui/empty";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { ScrollArea, ScrollBar } from "@berry/desktop-ui/components/ui/scroll-area";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { cn } from "@berry/desktop-ui/lib/utils";
import { host, useWorkbench } from "@/lib/berry";

interface FileTreeEntry {
  path: string;
  kind: "dir" | "file";
  size?: number;
}

interface FileReadResult {
  content: string;
  truncated: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  children: TreeNode[];
}

interface TreeRow {
  node: TreeNode;
  depth: number;
}

// Soft cap on rendered rows to keep huge workspaces from janking the tree.
const MAX_RENDERED_ROWS = 500;

/** The host returns a flat list of workspace-relative paths; nest it for rendering. */
function buildTree(entries: FileTreeEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);

  const ensureDir = (path: string): TreeNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = ensureDir(slash === -1 ? "" : path.slice(0, slash));
    const node: TreeNode = { name: path.slice(slash + 1), path, kind: "dir", children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  };

  for (const entry of entries) {
    if (entry.kind === "dir") {
      ensureDir(entry.path);
      continue;
    }
    const slash = entry.path.lastIndexOf("/");
    const parent = ensureDir(slash === -1 ? "" : entry.path.slice(0, slash));
    parent.children.push({ name: entry.path.slice(slash + 1), path: entry.path, kind: "file", children: [] });
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(root.children);
  return root.children;
}

/** Keep files whose path matches, and dirs that match or contain a match. */
function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  const q = query.toLowerCase();
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (node.path.toLowerCase().includes(q)) {
      result.push(node);
      continue;
    }
    if (node.kind === "dir") {
      const children = filterTree(node.children, query);
      if (children.length > 0) result.push({ ...node, children });
    }
  }
  return result;
}

function flattenVisible(nodes: TreeNode[], depth: number, expanded: Set<string>, searching: boolean, out: TreeRow[]) {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.kind === "dir" && (searching || expanded.has(node.path))) {
      flattenVisible(node.children, depth + 1, expanded, searching, out);
    }
  }
}

export function FilesPanel({
  workspaceId,
  taskId,
  mode = "full",
  initialPath,
  target,
}: {
  workspaceId: string;
  taskId?: string;
  mode?: "full" | "pane";
  initialPath?: string;
  target?: { path: string; line?: number; nonce: number };
}) {
  const { openHome } = useWorkbench();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(target?.path ?? initialPath ?? null);
  const [highlightLine, setHighlightLine] = useState<number | null>(null);
  const lineRefs = useRef(new Map<number, HTMLDivElement>());

  const { data: entries, isLoading: treeLoading } = useQuery({
    queryKey: ["file.tree", workspaceId, taskId],
    queryFn: () => host.call<FileTreeEntry[]>("file.tree", { workspaceId, ...(taskId ? { taskId } : {}) }),
  });

  const tree = useMemo(() => buildTree(entries ?? []), [entries]);
  const searching = search.trim().length > 0;
  const rows = useMemo(() => {
    const visible = searching ? filterTree(tree, search.trim()) : tree;
    const out: TreeRow[] = [];
    flattenVisible(visible, 0, expanded, searching, out);
    return out;
  }, [tree, search, expanded, searching]);
  const shownRows = rows.slice(0, MAX_RENDERED_ROWS);
  const hiddenCount = rows.length - shownRows.length;

  const { data: file, isLoading: fileLoading } = useQuery({
    queryKey: ["file.read", workspaceId, taskId, selectedPath],
    queryFn: () => host.call<FileReadResult>("file.read", { workspaceId, ...(taskId ? { taskId } : {}), path: selectedPath ?? "" }),
    enabled: selectedPath !== null,
  });

  useEffect(() => {
    if (!target?.path) return;
    setSelectedPath(target.path);
    setSearch("");
    setExpanded((current) => {
      const next = new Set(current);
      for (const dir of parentDirs(target.path)) next.add(dir);
      return next;
    });
    if (target.line) setHighlightLine(target.line);
  }, [target?.nonce, target?.path, target?.line]);

  useEffect(() => {
    if (!target?.line || fileLoading || selectedPath !== target.path) return;
    const frame = window.requestAnimationFrame(() => {
      lineRefs.current.get(target.line!)?.scrollIntoView({ block: "center" });
    });
    const timer = window.setTimeout(() => setHighlightLine(null), 1800);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [fileLoading, selectedPath, target?.line, target?.path, target?.nonce]);

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectedName = selectedPath?.split("/").at(-1) ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {mode === "full" ? (
          <Button variant="ghost" size="sm" onClick={openHome}>
            <ArrowLeft />
            Back to tasks
          </Button>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <FolderOpen className="size-4 text-muted-foreground" />
            <span>Files</span>
          </div>
        )}
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search files..."
          aria-label="Search files"
          className={cn("h-8 flex-1", mode === "full" ? "max-w-64" : "min-w-0")}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh files"
          className="ml-auto"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ["file.tree", workspaceId, taskId] })}
        >
          <RefreshCw />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className={cn("flex shrink-0 flex-col border-r border-border", mode === "full" ? "w-64" : "w-56")}>
          <ScrollArea className="h-full scroll-fade">
            <div className="p-2" role="tree" aria-label="Workspace files">
              {treeLoading ? (
                <div className="space-y-2 p-1">
                  {Array.from({ length: 8 }, (_, index) => (
                    <Skeleton key={index} className="h-6" style={{ width: `${90 - (index % 4) * 12}%` }} />
                  ))}
                </div>
              ) : shownRows.length === 0 ? (
                <p className="px-2 py-4 text-sm text-muted-foreground">
                  {searching ? "No files match your search." : "This workspace is empty."}
                </p>
              ) : (
                shownRows.map(({ node, depth }) => {
                  const isDir = node.kind === "dir";
                  const isOpen = searching || expanded.has(node.path);
                  const isSelected = node.path === selectedPath;
                  return (
                    <button
                      key={node.path}
                      type="button"
                      role="treeitem"
                      aria-level={depth + 1}
                      aria-expanded={isDir ? isOpen : undefined}
                      aria-selected={isSelected}
                      title={node.path}
                      style={{ paddingLeft: `${depth * 12 + 8}px` }}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isSelected
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground/90 hover:bg-accent/50 hover:text-foreground",
                      )}
                      onClick={() => (isDir ? toggleDir(node.path) : setSelectedPath(node.path))}
                    >
                      {isDir ? (
                        <>
                          <ChevronRight
                            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
                          />
                          {isOpen ? (
                            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <Folder className="size-4 shrink-0 text-muted-foreground" />
                          )}
                        </>
                      ) : (
                        <>
                          <span className="size-3.5 shrink-0" aria-hidden="true" />
                          <FileTypeIcon path={node.name} />
                        </>
                      )}
                      <span className="truncate">{node.name}</span>
                    </button>
                  );
                })
              )}
              {hiddenCount > 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {hiddenCount} more item{hiddenCount === 1 ? "" : "s"} — refine your search to narrow the tree.
                </p>
              )}
            </div>
          </ScrollArea>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {selectedPath === null ? (
            <Empty className="h-full border-none">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileText />
                </EmptyMedia>
                <EmptyTitle>No file selected</EmptyTitle>
                <EmptyDescription>Choose a file from the tree to preview its contents.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
                <FileTypeIcon path={selectedName} />
                <span className="truncate text-sm font-medium" title={selectedPath}>
                  {selectedName}
                </span>
                <Badge variant="outline" className="ml-auto shrink-0 text-muted-foreground">
                  Read-only preview
                </Badge>
              </div>
              {fileLoading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 6 }, (_, index) => (
                    <Skeleton key={index} className="h-4" style={{ width: `${95 - (index % 3) * 15}%` }} />
                  ))}
                </div>
              ) : (
                <ScrollArea className="min-h-0 flex-1 scroll-fade">
                  {file?.truncated && (
                    <p className="border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
                      Preview truncated — showing the beginning of the file.
                    </p>
                  )}
                  <div className="min-w-max p-4 font-mono text-xs leading-relaxed">
                    {(file?.content ?? "").split("\n").map((line, index) => {
                      const lineNumber = index + 1;
                      return (
                        <div
                          key={lineNumber}
                          ref={(node) => {
                            if (node) lineRefs.current.set(lineNumber, node);
                            else lineRefs.current.delete(lineNumber);
                          }}
                          className={cn(
                            "grid grid-cols-[3.5rem_minmax(0,1fr)] rounded-[4px]",
                            highlightLine === lineNumber && "bg-warning/15 text-foreground",
                          )}
                        >
                          <span className="select-none pr-4 text-right text-muted-foreground/60">{lineNumber}</span>
                          <span className="whitespace-pre">{line || " "}</span>
                        </div>
                      );
                    })}
                  </div>
                  <ScrollBar orientation="horizontal" />
                </ScrollArea>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function parentDirs(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const dirs: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    dirs.push(parts.slice(0, index).join("/"));
  }
  return dirs;
}
