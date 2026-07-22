import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { JsonValue, PluginInstall } from "@berry/shared";
import { GitBranch, Plug, RefreshCw, ShieldCheck, Trash2 } from "@berry/desktop-ui/lib/icons";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@berry/desktop-ui/components/ui/empty";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { Label } from "@berry/desktop-ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@berry/desktop-ui/components/ui/select";
import { Switch } from "@berry/desktop-ui/components/ui/switch";
import { Textarea } from "@berry/desktop-ui/components/ui/textarea";
import { host, useWorkbench } from "@/lib/berry";
import { SettingCard, SettingRow, SettingsPageHeader, SettingsSectionLabel } from "./shared";

const PLUGINS_KEY = ["plugins"] as const;
type InstallMode = "folder" | "git" | "manifest";

function manifestRecord(plugin: PluginInstall): Record<string, JsonValue> {
  return plugin.manifest && typeof plugin.manifest === "object" && !Array.isArray(plugin.manifest)
    ? plugin.manifest
    : {};
}

function capabilityEntries(plugin: PluginInstall, key: "commands" | "skills" | "mcpServers"): JsonValue[] {
  const manifest = manifestRecord(plugin);
  const capabilities = manifest.capabilities && typeof manifest.capabilities === "object" && !Array.isArray(manifest.capabilities)
    ? manifest.capabilities
    : {};
  const value = key === "mcpServers"
    ? capabilities.mcpServers ?? capabilities.mcp_servers ?? manifest.mcpServers
    : capabilities[key] ?? manifest[key];
  return Array.isArray(value) ? value : [];
}

function capabilityLabels(plugin: PluginInstall): string[] {
  return (["commands", "skills", "mcpServers"] as const).flatMap((kind) =>
    capabilityEntries(plugin, kind).map((entry, index) => {
      const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
      const name = typeof record.name === "string" ? record.name : typeof entry === "string" ? entry : `${index + 1}`;
      return `${kind === "mcpServers" ? "MCP server" : kind.slice(0, -1)}: ${name}`;
    }),
  );
}

function capabilityCount(plugin: PluginInstall, key: "commands" | "skills" | "mcpServers"): number {
  return capabilityEntries(plugin, key).length;
}

export function PluginsSettings() {
  const queryClient = useQueryClient();
  const { activeWorkspace } = useWorkbench();
  const [installMode, setInstallMode] = useState<InstallMode>("folder");
  const [source, setSource] = useState("");
  const [manifestText, setManifestText] = useState("{\n  \"name\": \"\",\n  \"version\": \"0.1.0\",\n  \"description\": \"\"\n}");
  const [pendingTrust, setPendingTrust] = useState<PluginInstall | null>(null);
  const [updateReview, setUpdateReview] = useState<PluginInstall | null>(null);
  const plugins = useQuery({
    queryKey: [...PLUGINS_KEY, activeWorkspace?.id ?? null],
    queryFn: () => host.call<PluginInstall[]>("plugin.list", activeWorkspace ? { workspaceId: activeWorkspace.id } : undefined),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: PLUGINS_KEY });
  const install = useMutation({
    mutationFn: async (): Promise<PluginInstall> => {
      const workspaceId = activeWorkspace?.id;
      if (installMode === "folder") return host.call("plugin.installPath", { path: source.trim(), ...(workspaceId ? { workspaceId } : {}) });
      if (installMode === "git") return host.call("plugin.installGit", { url: source.trim(), ...(workspaceId ? { workspaceId } : {}) });
      return host.call("plugin.installManifest", {
        ...(workspaceId ? { workspaceId } : {}),
        manifest: JSON.parse(manifestText) as JsonValue,
        source: "manual",
        trusted: false,
        enabled: true,
      });
    },
    onSuccess: async (plugin) => {
      await refresh();
      if (!plugin.trusted) setPendingTrust(plugin);
      else toast.success("Verified plugin installed");
    },
    onError: (error) => toast.error("Plugin install failed", { description: error instanceof Error ? error.message : String(error) }),
  });
  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => host.call("plugin.enable", { id, enabled }),
    onSuccess: () => void refresh(),
  });
  const toggleTrusted = useMutation({
    mutationFn: ({ id, trusted }: { id: string; trusted: boolean }) => host.call("plugin.trust", { id, trusted }),
    onSuccess: () => void refresh(),
  });
  const confirmTrust = useMutation({
    mutationFn: (plugin: PluginInstall) => host.call("plugin.trust", { id: plugin.id, trusted: true }),
    onSuccess: () => {
      void refresh();
      setPendingTrust(null);
      toast.success("Plugin trusted and installed");
    },
  });
  const checkUpdate = useMutation({
    mutationFn: (id: string) => host.call<PluginInstall>("plugin.checkUpdate", { id }),
    onSuccess: async (plugin) => {
      await refresh();
      if (plugin.updateAvailable) setUpdateReview(plugin);
      else toast.success("Plugin is up to date");
    },
    onError: (error) => toast.error("Update check failed", { description: error instanceof Error ? error.message : String(error) }),
  });
  const applyUpdate = useMutation({
    mutationFn: (plugin: PluginInstall) => host.call<PluginInstall>("plugin.applyUpdate", { id: plugin.id, confirmHash: plugin.pendingContentHash ?? "" }),
    onSuccess: async () => {
      await refresh();
      setUpdateReview(null);
      toast.success("Plugin updated");
    },
    onError: (error) => toast.error("Plugin update failed", { description: error instanceof Error ? error.message : String(error) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => host.call("plugin.delete", { id }),
    onSuccess: () => {
      void refresh();
      toast.success("Plugin removed");
    },
    onError: () => toast.error("Could not remove plugin"),
  });
  const rows = useMemo(() => plugins.data ?? [], [plugins.data]);
  const canInstall = installMode === "manifest" ? manifestText.trim().length > 0 : source.trim().length > 0;

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Plugins"
        description="Install plugins from local folders, git repositories, or manifests. Unsigned capabilities require review before they are trusted."
        actions={
          <Button size="sm" variant="outline" onClick={() => void plugins.refetch()}>
            <RefreshCw />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-3">
        <SettingsSectionLabel>Install</SettingsSectionLabel>
        <SettingCard>
          <SettingRow
            title="Plugin source"
            description="Folder and git installs are copied into Berry's managed plugin directory."
            control={
              <div className="flex items-center gap-2">
                <Select value={installMode} onValueChange={(value) => setInstallMode(value as InstallMode)}>
                  <SelectTrigger className="w-32" aria-label="Plugin source type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="folder">Folder</SelectItem>
                    <SelectItem value="git">Git</SelectItem>
                    <SelectItem value="manifest">Manifest</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={() => install.mutate()} disabled={!canInstall || install.isPending}>
                  {installMode === "git" ? <GitBranch /> : <Plug />}
                  {install.isPending ? "Installing..." : "Install"}
                </Button>
              </div>
            }
          >
            {installMode === "manifest" ? (
              <Textarea value={manifestText} onChange={(event) => setManifestText(event.target.value)} className="min-h-40 font-mono text-xs" aria-label="Plugin manifest JSON" />
            ) : (
              <Input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                className="font-mono text-xs"
                placeholder={installMode === "git" ? "https://github.com/owner/plugin.git" : "/path/to/plugin"}
                aria-label={installMode === "git" ? "Plugin git URL" : "Plugin folder path"}
              />
            )}
          </SettingRow>
        </SettingCard>
      </div>

      <div className="flex flex-col gap-3">
        <SettingsSectionLabel>Installed plugins</SettingsSectionLabel>
        {rows.length === 0 ? (
          <Empty className="border border-dashed border-border py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Plug /></EmptyMedia>
              <EmptyTitle>No plugins installed</EmptyTitle>
              <EmptyDescription>Installed plugins will appear here with source, trust, and update controls.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <SettingCard>
            {rows.map((plugin) => (
              <SettingRow
                key={plugin.id}
                title={
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate">{plugin.name}</span>
                    <Badge variant={plugin.trusted ? "secondary" : "outline"}>{plugin.trusted ? "Trusted" : "Untrusted"}</Badge>
                    <Badge variant="outline">{plugin.version}</Badge>
                    <Badge variant="outline">{plugin.sourceKind}</Badge>
                    {plugin.signatureStatus === "verified" ? <Badge variant="secondary"><ShieldCheck /> Signed</Badge> : null}
                    {capabilityCount(plugin, "commands") > 0 ? <Badge variant="outline">{capabilityCount(plugin, "commands")} commands</Badge> : null}
                    {capabilityCount(plugin, "skills") > 0 ? <Badge variant="outline">{capabilityCount(plugin, "skills")} skills</Badge> : null}
                    {capabilityCount(plugin, "mcpServers") > 0 ? <Badge variant="outline">{capabilityCount(plugin, "mcpServers")} MCP</Badge> : null}
                  </span>
                }
                description={`${plugin.description || plugin.source}${plugin.commitHash ? ` · ${plugin.commitHash.slice(0, 8)}` : ""}`}
                control={
                  <div className="flex items-center gap-3">
                    {plugin.sourceKind !== "manifest" ? (
                      <Button size="sm" variant="outline" onClick={() => checkUpdate.mutate(plugin.id)} disabled={checkUpdate.isPending}>
                        <RefreshCw />
                        Check update
                      </Button>
                    ) : null}
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      Trust
                      <Switch checked={plugin.trusted} onCheckedChange={(trusted) => toggleTrusted.mutate({ id: plugin.id, trusted })} aria-label={`Trust ${plugin.name}`} />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      Enable
                      <Switch checked={plugin.enabled} onCheckedChange={(enabled) => toggleEnabled.mutate({ id: plugin.id, enabled })} aria-label={`Enable ${plugin.name}`} />
                    </label>
                    <Button size="icon-sm" variant="ghost" onClick={() => remove.mutate(plugin.id)} disabled={remove.isPending} aria-label={`Remove ${plugin.name}`}>
                      <Trash2 />
                    </Button>
                  </div>
                }
              />
            ))}
          </SettingCard>
        )}
      </div>

      <Dialog open={pendingTrust !== null} onOpenChange={(open) => { if (!open) setPendingTrust(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Trust unsigned plugin?</DialogTitle>
            <DialogDescription>{pendingTrust?.name} is unsigned. Review the capabilities it will add before trusting it.</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            {pendingTrust && capabilityLabels(pendingTrust).length > 0 ? (
              <ul className="space-y-1 font-mono text-xs">{capabilityLabels(pendingTrust).map((item) => <li key={item}>{item}</li>)}</ul>
            ) : <p className="text-muted-foreground">No commands, skills, or MCP servers declared.</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingTrust(null)}>Leave untrusted</Button>
            <Button onClick={() => pendingTrust && confirmTrust.mutate(pendingTrust)} disabled={confirmTrust.isPending}>Trust plugin</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={updateReview !== null} onOpenChange={(open) => { if (!open) setUpdateReview(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Review plugin update</DialogTitle>
            <DialogDescription>
              {updateReview?.name} {updateReview?.version} to {updateReview?.pendingVersion ?? "new version"}
              {updateReview?.pendingCommitHash ? ` at ${updateReview.pendingCommitHash.slice(0, 8)}` : ""}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label>Capability changes</Label>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs">
              {updateReview?.capabilityDiff.length ? updateReview.capabilityDiff.join("\n") : "No capability changes."}
            </pre>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUpdateReview(null)}>Cancel</Button>
            <Button onClick={() => updateReview && applyUpdate.mutate(updateReview)} disabled={!updateReview?.pendingContentHash || applyUpdate.isPending}>
              Apply update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
