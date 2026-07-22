import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceIndexSearchResult, WorkspaceIndexStatus, WorkspaceWiki } from "@berry/shared";
import { RefreshCw, Search, ShieldCheck } from "@berry/desktop-ui/lib/icons";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { host, useWorkbench } from "@/lib/berry";
import { formatCount, SettingCard, SettingRow, SettingsPageHeader, SettingsSectionLabel, SwitchSettingRow } from "./shared";

export function IndexingSettings() {
  const queryClient = useQueryClient();
  const { activeWorkspace } = useWorkbench();
  const [query, setQuery] = useState("");
  const workspaceId = activeWorkspace?.id ?? "";
  const status = useQuery({
    queryKey: ["workspace.index.status", workspaceId],
    queryFn: () => host.call<WorkspaceIndexStatus>("workspace.index.status", { workspaceId }),
    enabled: Boolean(activeWorkspace),
  });
  const wiki = useQuery({
    queryKey: ["workspace.wiki.get", workspaceId],
    queryFn: () => host.call<WorkspaceWiki | null>("workspace.wiki.get", { workspaceId }),
    enabled: Boolean(activeWorkspace),
  });
  const search = useQuery({
    queryKey: ["workspace.index.search", workspaceId, query],
    queryFn: () => host.call<{ results: WorkspaceIndexSearchResult[] }>("workspace.index.search", { workspaceId, query, limit: 12 }),
    enabled: Boolean(activeWorkspace) && query.trim().length >= 2,
  });
  const rebuild = useMutation({
    mutationFn: () => host.call("workspace.index.rebuild", { workspaceId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workspace.index.status", workspaceId] });
      await queryClient.invalidateQueries({ queryKey: ["workspace.wiki.get", workspaceId] });
      await queryClient.invalidateQueries({ queryKey: ["workspace.index.search", workspaceId] });
    },
  });
  const languageText = useMemo(() => {
    const languages = wiki.data?.languages ?? [];
    return languages.slice(0, 4).map((item) => `${item.name} ${formatCount(item.files)}`).join(" · ");
  }, [wiki.data]);
  const watcherText =
    status.data?.watcherStatus === "watching"
      ? "watching"
      : status.data?.watcherStatus === "pending"
        ? `${formatCount(status.data.watcherPending)} pending`
        : status.data?.watcherStatus === "error"
          ? "watcher error"
          : "watcher off";

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Indexing"
        description="Build a local searchable repo index and workspace wiki. Index data stays on this machine."
        actions={
          <Button size="sm" onClick={() => rebuild.mutate()} disabled={!activeWorkspace || rebuild.isPending}>
            <RefreshCw />
            Rebuild
          </Button>
        }
      />

      <div className="flex flex-col gap-3">
        <SettingsSectionLabel>Codebase</SettingsSectionLabel>
        <SettingCard>
          <SwitchSettingRow
            title="Index workspace files"
            description="Automatically index workspace files so Berry can find code and gather context faster."
            settingKey="indexing.files"
            defaultValue={false}
          />
          <SwitchSettingRow
            title="Index git history"
            description="Reserve git history for future repo wiki enrichment."
            settingKey="indexing.git"
            defaultValue={false}
          />
          <SettingRow
            title="Current index"
            description={status.data?.error ?? status.data?.rootPath ?? activeWorkspace?.path ?? "Open a workspace to index files."}
            control={
              <div className="flex items-center gap-2">
                <Badge variant={status.data?.status === "ready" ? "secondary" : "outline"}>
                  {status.data?.status ?? "missing"}
                </Badge>
                <Badge variant={status.data?.watcherStatus === "watching" ? "secondary" : "outline"}>
                  {watcherText}
                </Badge>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {formatCount(status.data?.fileCount ?? 0)} files
                </span>
              </div>
            }
          />
        </SettingCard>
      </div>

      <div className="flex flex-col gap-3">
        <SettingsSectionLabel>Repo wiki</SettingsSectionLabel>
        <SettingCard>
          <SettingRow
            title="Overview"
            description={wiki.isPending ? "Loading wiki..." : wiki.data?.overview ?? "Rebuild the index to generate a repo wiki."}
            control={<ShieldCheck className="text-muted-foreground" />}
          >
            {wiki.isPending ? (
              <Skeleton className="h-12" />
            ) : wiki.data ? (
              <div className="grid gap-3 text-sm md:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Languages</span>
                  <span className="text-pretty">{languageText || "No language buckets"}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Entrypoints</span>
                  <span className="truncate font-mono text-xs">{wiki.data.entrypoints.slice(0, 4).join(", ") || "None detected"}</span>
                </div>
              </div>
            ) : null}
          </SettingRow>
        </SettingCard>
      </div>

      <div className="flex flex-col gap-3">
        <SettingsSectionLabel>Search index</SettingsSectionLabel>
        <SettingCard>
          <SettingRow title="Search files" description="Search indexed paths and file content.">
            <div className="flex items-center gap-2">
              <Search className="text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="component, function, route..." />
            </div>
            {query.trim().length >= 2 ? (
              <div className="flex flex-col gap-2">
                {(search.data?.results ?? []).map((result) => (
                  <button
                    key={result.id}
                    type="button"
                    className="flex min-w-0 flex-col gap-1 rounded-md px-2 py-2 text-left transition-[background-color,scale] active:scale-[0.96] hover:bg-muted"
                    onClick={() => void host.call("system.openPath", { workspaceId, path: result.absolutePath })}
                  >
                    <span className="truncate font-mono text-xs">{result.path}</span>
                    <span className="line-clamp-2 text-pretty text-xs text-muted-foreground">{result.snippet || result.language || "Indexed file"}</span>
                  </button>
                ))}
                {search.data?.results.length === 0 ? <p className="text-sm text-muted-foreground">No indexed matches.</p> : null}
              </div>
            ) : null}
          </SettingRow>
        </SettingCard>
      </div>
    </div>
  );
}
