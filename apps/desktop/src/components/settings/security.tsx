import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AuditEvent, ExecPolicyStoredRule, ExtensionNativeMessagingStatus, ManagedPolicyStatus, PermissionGrant } from "@berry/shared";
import { FileDown, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from "@berry/desktop-ui/lib/icons";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@berry/desktop-ui/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@berry/desktop-ui/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@berry/desktop-ui/components/ui/tabs";
import { Textarea } from "@berry/desktop-ui/components/ui/textarea";
import { host, useWorkbench } from "@/lib/berry";
import { SettingCard, SettingsPageHeader, SettingsSectionLabel, SwitchSettingRow, TextSettingRow } from "./shared";

const GRANTS_KEY = ["security", "grants"] as const;
const RULES_KEY = ["security", "rules"] as const;
const AUDIT_KEY = ["security", "audit"] as const;

type RuleLayer = "user" | "workspace";
type RuleKind = "prefix_rule" | "exact" | "regex-lite" | "network";
type RuleDecision = "allow" | "prompt" | "forbid";

function EmptySecurityState({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="min-h-52 border border-dashed border-border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><ShieldCheck /></EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function GrantsPanel({ workspaceId }: { workspaceId?: string }) {
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: [...GRANTS_KEY, workspaceId ?? "all"],
    queryFn: () => host.call<PermissionGrant[]>("permission.grant.list", workspaceId ? { workspaceId } : {}),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => host.call("permission.grant.revoke", { id }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: GRANTS_KEY }),
        queryClient.invalidateQueries({ queryKey: AUDIT_KEY }),
      ]);
      toast.success("Grant revoked");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not revoke grant"),
  });
  if (!grants.data?.length) return <EmptySecurityState title="No persistent grants" description="Approvals saved for future turns appear here." />;
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <Table>
        <TableHeader><TableRow><TableHead>Subject</TableHead><TableHead>Scope</TableHead><TableHead>Mode</TableHead><TableHead className="w-12"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
        <TableBody>
          {grants.data.map((grant) => (
            <TableRow key={grant.id}>
              <TableCell className="max-w-96 truncate font-mono text-xs" title={grant.subject}>{grant.subject}</TableCell>
              <TableCell><Badge variant="outline">{grant.workspaceId ? "Workspace" : "User"}</Badge></TableCell>
              <TableCell className="text-muted-foreground">{grant.mode}</TableCell>
              <TableCell>
                <Button size="icon-sm" variant="ghost" title="Revoke grant" aria-label={`Revoke ${grant.subject}`} disabled={revoke.isPending} onClick={() => revoke.mutate(grant.id)}><Trash2 /></Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function parsePattern(kind: RuleKind, value: string): string | string[] {
  if (kind === "regex-lite" || kind === "network") return value.trim();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) return parsed;
  } catch { /* The fallback accepts a plain command line. */ }
  return value.trim().split(/\s+/).filter(Boolean);
}

function RuleDialog({ rule, workspaceId, onClose, onSaved }: { rule: ExecPolicyStoredRule | null; workspaceId?: string; onClose: () => void; onSaved: () => void }) {
  const [layer, setLayer] = useState<RuleLayer>(rule?.layer === "workspace" ? "workspace" : "user");
  const [kind, setKind] = useState<RuleKind>(rule?.kind ?? "exact");
  const [decision, setDecision] = useState<RuleDecision>(rule?.decision ?? "prompt");
  const [pattern, setPattern] = useState(rule ? (Array.isArray(rule.pattern) ? JSON.stringify(rule.pattern) : rule.pattern) : "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [pending, setPending] = useState(false);
  const save = async () => {
    setPending(true);
    try {
      const fields = { kind, decision, pattern: parsePattern(kind, pattern), description };
      if (rule) await host.call("policy.rule.update", { id: rule.id, ...fields });
      else await host.call("policy.rule.create", { layer, ...(layer === "workspace" && workspaceId ? { workspaceId } : {}), ...fields });
      toast.success(rule ? "Policy rule updated" : "Policy rule added");
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save policy rule");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{rule ? "Edit policy rule" : "Add policy rule"}</DialogTitle><DialogDescription>Execution policy rules are evaluated before sandbox and approval grants.</DialogDescription></DialogHeader>
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <div className="grid gap-2"><Label htmlFor="policy-layer">Layer</Label><Select value={layer} disabled={Boolean(rule)} onValueChange={(value) => setLayer(value as RuleLayer)}><SelectTrigger id="policy-layer"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="user">User</SelectItem><SelectItem value="workspace" disabled={!workspaceId}>Workspace</SelectItem></SelectContent></Select></div>
          <div className="grid gap-2"><Label htmlFor="policy-decision">Decision</Label><Select value={decision} onValueChange={(value) => setDecision(value as RuleDecision)}><SelectTrigger id="policy-decision"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="allow">Allow</SelectItem><SelectItem value="prompt">Prompt</SelectItem><SelectItem value="forbid">Forbid</SelectItem></SelectContent></Select></div>
          <div className="grid gap-2 sm:col-span-2"><Label htmlFor="policy-kind">Match type</Label><Select value={kind} onValueChange={(value) => setKind(value as RuleKind)}><SelectTrigger id="policy-kind"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="exact">Exact argv</SelectItem><SelectItem value="prefix_rule">Argv prefix</SelectItem><SelectItem value="regex-lite">Regex-lite</SelectItem><SelectItem value="network">Network domain</SelectItem></SelectContent></Select></div>
          <div className="grid gap-2 sm:col-span-2"><Label htmlFor="policy-pattern">Pattern</Label><Textarea id="policy-pattern" className="min-h-24 font-mono text-xs" value={pattern} onChange={(event) => setPattern(event.target.value)} /></div>
          <div className="grid gap-2 sm:col-span-2"><Label htmlFor="policy-description">Description</Label><Input id="policy-description" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={pending || !pattern.trim() || (layer === "workspace" && !workspaceId)} onClick={() => void save()}>{rule ? "Save" : "Add rule"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RulesPanel({ workspaceId }: { workspaceId?: string }) {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<ExecPolicyStoredRule | "new" | null>(null);
  const rules = useQuery({ queryKey: [...RULES_KEY, workspaceId ?? "all"], queryFn: () => host.call<ExecPolicyStoredRule[]>("policy.rule.list", workspaceId ? { workspaceId } : {}) });
  const remove = useMutation({
    mutationFn: (id: string) => host.call("policy.rule.delete", { id }),
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: RULES_KEY }), queryClient.invalidateQueries({ queryKey: AUDIT_KEY })]);
      toast.success("Policy rule deleted");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not delete policy rule"),
  });
  const refreshed = async () => {
    setEditor(null);
    await Promise.all([queryClient.invalidateQueries({ queryKey: RULES_KEY }), queryClient.invalidateQueries({ queryKey: AUDIT_KEY })]);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end"><Button size="sm" onClick={() => setEditor("new")}><Plus />Add rule</Button></div>
      {!rules.data?.length ? <EmptySecurityState title="No custom rules" description="Managed, user, and workspace execution rules appear here." /> : (
        <div className="overflow-hidden rounded-md border border-border">
          <Table>
            <TableHeader><TableRow><TableHead>Rule</TableHead><TableHead>Layer</TableHead><TableHead>Decision</TableHead><TableHead className="w-24"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
            <TableBody>
              {rules.data.map((rule) => {
                const readOnly = rule.layer === "managed" || rule.layer === "session";
                const pattern = Array.isArray(rule.pattern) ? rule.pattern.join(" ") : rule.pattern;
                return <TableRow key={rule.id}><TableCell className="max-w-md"><div className="truncate font-mono text-xs" title={pattern}>{pattern}</div>{rule.description ? <div className="mt-1 truncate text-xs text-muted-foreground">{rule.description}</div> : null}</TableCell><TableCell><Badge variant="outline">{rule.layer}</Badge></TableCell><TableCell><Badge variant={rule.decision === "forbid" ? "destructive" : "secondary"}>{rule.decision}</Badge></TableCell><TableCell><div className="flex justify-end gap-1"><Button size="icon-sm" variant="ghost" title={readOnly ? "Managed rules are read-only" : "Edit rule"} aria-label={`Edit ${pattern}`} disabled={readOnly} onClick={() => setEditor(rule)}><Pencil /></Button><Button size="icon-sm" variant="ghost" title={readOnly ? "Managed rules are read-only" : "Delete rule"} aria-label={`Delete ${pattern}`} disabled={readOnly || remove.isPending} onClick={() => remove.mutate(rule.id)}><Trash2 /></Button></div></TableCell></TableRow>;
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {editor ? <RuleDialog key={editor === "new" ? "new" : editor.id} rule={editor === "new" ? null : editor} workspaceId={workspaceId} onClose={() => setEditor(null)} onSaved={() => void refreshed()} /> : null}
    </div>
  );
}

const SANDBOX_ROWS = [
  { mode: "Plan", tier: "Read only", writes: "None", network: "Off" },
  { mode: "Ask", tier: "Workspace write", writes: "Approved", network: "Setting" },
  { mode: "Auto-edit", tier: "Workspace write", writes: "Workspace", network: "Setting" },
  { mode: "Full access", tier: "Danger", writes: "Unrestricted", network: "On" },
];

function SandboxPanel() {
  return <div className="flex flex-col gap-6"><div className="overflow-hidden rounded-md border border-border"><Table><TableHeader><TableRow><TableHead>Permission mode</TableHead><TableHead>Sandbox tier</TableHead><TableHead>Writes</TableHead><TableHead>Network</TableHead></TableRow></TableHeader><TableBody>{SANDBOX_ROWS.map((row) => <TableRow key={row.mode}><TableCell className="font-medium">{row.mode}</TableCell><TableCell>{row.tier}</TableCell><TableCell className="text-muted-foreground">{row.writes}</TableCell><TableCell className="text-muted-foreground">{row.network}</TableCell></TableRow>)}</TableBody></Table></div><div className="flex flex-col gap-2"><SettingsSectionLabel>Workspace-write defaults</SettingsSectionLabel><SettingCard><SwitchSettingRow title="Network egress" description="Allow network access for Ask and Auto-edit sandbox processes." settingKey="sandbox.workspaceWrite.network" /><TextSettingRow title="Domain allowlist" description="Exact domains or wildcard subdomains, separated by commas." settingKey="network.domainAllowlist" placeholder="api.example.com, *.docs.example.com" mono /></SettingCard></div></div>;
}

function ExtensionPanel() {
  const queryClient = useQueryClient();
  const [extensionId, setExtensionId] = useState("");
  const status = useQuery({
    queryKey: ["security", "extension-native"],
    queryFn: () => host.call<ExtensionNativeMessagingStatus>("extension.nativeMessaging.status", {}),
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) => host.call<ExtensionNativeMessagingStatus>("extension.nativeMessaging.setEnabled", {
      enabled,
      ...(extensionId.trim() ? { extensionIds: [extensionId.trim()] } : {}),
    }),
    onSuccess: async (next) => {
      queryClient.setQueryData(["security", "extension-native"], next);
      await queryClient.invalidateQueries({ queryKey: ["security", "extension-native"] });
      toast.success(next.enabled ? "Browser extension bridge enabled" : "Browser extension bridge disabled");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update extension bridge"),
  });
  const current = status.data;
  return (
    <div className="flex flex-col gap-4">
      <SettingCard>
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="text-sm font-medium">Chrome side panel bridge</div>
              <div className="text-sm text-muted-foreground">Registers Berry Desktop as a native messaging host for the MV3 browser extension.</div>
            </div>
            <Badge variant={current?.enabled ? "secondary" : "outline"}>{current?.enabled ? "Enabled" : "Disabled"}</Badge>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <Input value={extensionId} onChange={(event) => setExtensionId(event.target.value)} placeholder="Chrome extension id, 32 chars a-p" className="font-mono text-xs" />
            <Button disabled={save.isPending || (extensionId.trim().length > 0 && !/^[a-p]{32}$/.test(extensionId.trim()))} onClick={() => save.mutate(true)}>Enable</Button>
            <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate(false)}>Disable</Button>
          </div>
          {current?.requiresExtensionId ? <div className="text-xs text-muted-foreground">A development extension id is installed until the Chrome Web Store id is supplied.</div> : null}
        </div>
      </SettingCard>
      {current ? (
        <div className="overflow-hidden rounded-md border border-border">
          <Table>
            <TableHeader><TableRow><TableHead>Native messaging file</TableHead><TableHead>Path</TableHead></TableRow></TableHeader>
            <TableBody>
              <TableRow><TableCell>Host name</TableCell><TableCell className="font-mono text-xs">{current.hostName}</TableCell></TableRow>
              <TableRow><TableCell>Config</TableCell><TableCell className="font-mono text-xs">{current.configPath}</TableCell></TableRow>
              <TableRow><TableCell>Executable</TableCell><TableCell className="font-mono text-xs">{current.nativeHostPath}</TableCell></TableRow>
              {current.manifestPaths.map((path) => <TableRow key={path}><TableCell>Manifest</TableCell><TableCell className="font-mono text-xs">{path}</TableCell></TableRow>)}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

function AuditPanel() {
  const queryClient = useQueryClient();
  const audit = useQuery({ queryKey: AUDIT_KEY, queryFn: () => host.call<AuditEvent[]>("audit.list", { limit: 200 }) });
  const exportAudit = async (format: "json" | "csv") => {
    try {
      const result = await host.call<{ path: string; count: number; chainValid: boolean }>("audit.export", { format });
      if (!result.chainValid) {
        toast.error("Audit chain verification failed", { description: result.path });
        return;
      }
      toast.success(`${result.count} audit events exported`, { description: result.path });
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not export audit log"); }
  };
  return <div className="flex flex-col gap-4"><div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="outline" title="Refresh audit log" onClick={() => void queryClient.invalidateQueries({ queryKey: AUDIT_KEY })}><RefreshCw />Refresh</Button><Button size="sm" variant="outline" onClick={() => void exportAudit("json")}><FileDown />JSON</Button><Button size="sm" variant="outline" onClick={() => void exportAudit("csv")}><FileDown />CSV</Button></div>{!audit.data?.length ? <EmptySecurityState title="No audit events" description="Consequential local actions appear here." /> : <div className="overflow-hidden rounded-md border border-border"><Table><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Action</TableHead><TableHead>Scope</TableHead><TableHead>Subject</TableHead></TableRow></TableHeader><TableBody>{audit.data.map((event) => <TableRow key={event.id}><TableCell className="text-xs text-muted-foreground tabular-nums">{new Date(event.createdAt).toLocaleString()}</TableCell><TableCell><div className="font-medium">{event.action}</div><div className="text-xs text-muted-foreground">{event.category}</div></TableCell><TableCell><Badge variant="outline">{event.workspaceId ? "Workspace" : "User"}</Badge></TableCell><TableCell className="max-w-80 truncate font-mono text-xs" title={event.subject ?? undefined}>{event.subject ?? "-"}</TableCell></TableRow>)}</TableBody></Table></div>}</div>;
}

export function SecuritySettings() {
  const { activeWorkspace } = useWorkbench();
  const managedPolicy = useQuery({ queryKey: ["security", "managed-policy"], queryFn: () => host.call<ManagedPolicyStatus>("policy.get", {}) });
  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <SettingsPageHeader title="Security" description="Manage local permissions, execution policy, sandbox defaults, and audit records." />
      {managedPolicy.data?.state === "active" ? (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/25 p-4" data-testid="managed-policy-provenance">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2"><ShieldCheck className="size-4 text-success" /><span className="text-sm font-medium">Managed by {managedPolicy.data.organization?.name}</span></div>
            <span className="font-mono text-xs text-muted-foreground">v{managedPolicy.data.version} · {managedPolicy.data.keyId}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">{managedPolicy.data.locks.map((lock) => <Badge key={lock} variant="outline">{lock}</Badge>)}</div>
        </div>
      ) : managedPolicy.data?.state === "rejected" ? (
        <div className="rounded-md border border-destructive/60 bg-destructive/10 p-4" role="alert"><div className="text-sm font-medium text-destructive">Managed policy rejected</div><div className="mt-1 text-xs text-muted-foreground">{managedPolicy.data.error}</div></div>
      ) : null}
      <Tabs defaultValue="grants" className="gap-5">
        <TabsList variant="line" className="max-w-full overflow-x-auto"><TabsTrigger value="grants">Grants</TabsTrigger><TabsTrigger value="policy">Execpolicy</TabsTrigger><TabsTrigger value="sandbox">Sandbox</TabsTrigger><TabsTrigger value="extension">Browser extension</TabsTrigger><TabsTrigger value="audit">Audit</TabsTrigger></TabsList>
        <TabsContent value="grants"><GrantsPanel workspaceId={activeWorkspace?.id} /></TabsContent>
        <TabsContent value="policy"><RulesPanel workspaceId={activeWorkspace?.id} /></TabsContent>
        <TabsContent value="sandbox"><SandboxPanel /></TabsContent>
        <TabsContent value="extension"><ExtensionPanel /></TabsContent>
        <TabsContent value="audit"><AuditPanel /></TabsContent>
      </Tabs>
    </div>
  );
}
