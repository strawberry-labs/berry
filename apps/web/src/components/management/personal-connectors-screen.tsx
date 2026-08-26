import * as React from "react";
import type { Connector, GoogleConnectorConfiguration } from "@berry/shared";
import {
  CalendarDays,
  Check,
  Clock3,
  ExternalLink,
  FileText,
  HardDrive,
  KeyRound,
  Mail,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@berry/desktop-ui/components/ui/alert-dialog";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import { Label } from "@berry/desktop-ui/components/ui/label";
import { cn } from "@berry/desktop-ui/lib/utils";
import { AsyncState, Button, FormSelect, Input, ManagementPage, Section, StatusPill, Textarea } from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

const EMPTY_GOOGLE: GoogleConnectorConfiguration = {
  configured: false,
  clientId: null,
  hostedDomain: null,
  pickerConfigured: false,
  pickerProjectNumber: null,
  status: "not_configured",
  lastTestedAt: null,
  callbackUrl: "https://example.invalid/v1/connectors/google/callback",
};

type AdminConnectorClient = Pick<NonNullable<ManagementScreenProps["client"]>, "listOrganizationConnectors" | "googleConnectorConfiguration">;

export async function loadAdminConnectorData(client: AdminConnectorClient, tenantId: string, includeGoogleConfiguration: boolean) {
  const [connectors, google] = await Promise.all([
    client.listOrganizationConnectors(tenantId),
    includeGoogleConfiguration ? client.googleConnectorConfiguration(tenantId) : Promise.resolve(EMPTY_GOOGLE),
  ]);
  return { connectors, google };
}

export function PersonalConnectorsScreen({ client, permissions }: ManagementScreenProps) {
  const resource = useResource("connectors:me", () => client?.listConnectors() ?? Promise.resolve([]), [] as Connector[]);
  const requests = useResource("connectors:requests", () => client?.listConnectorRequests() ?? Promise.resolve([]), [] as Connector[]);
  const canApprove = permissions.includes("mcp:write");
  const requestUrlId = React.useId();
  const [query, setQuery] = React.useState("");
  const [addOpen, setAddOpen] = React.useState(false);
  const [requestUrl, setRequestUrl] = React.useState("");
  const [requestBusy, setRequestBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<Connector | null>(null);
  const [access, setAccess] = React.useState<"read" | "full">("read");
  const [credential, setCredential] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const visible = resource.data.filter((connector) => `${connector.name} ${connector.description} ${connector.services.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  const hasPendingRequest = requests.data.some((connector) => connector.approvalStatus === "pending");

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("connector_error");
    if (error) toast.error(error);
    if (params.get("connected") === "true") toast.success("Connector connected");
    if (error || params.has("connected")) {
      params.delete("connector_error"); params.delete("connected"); params.delete("connector");
      window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
      resource.retry();
      requests.retry();
    }
  }, []);

  React.useEffect(() => {
    if (!hasPendingRequest) return;
    const timer = window.setInterval(() => { requests.retry(); resource.retry(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [hasPendingRequest]);

  const open = (connector: Connector) => {
    setSelected(connector);
    setAccess(connector.maxAccessLevel === "read" ? "read" : connector.connectedAccessLevel ?? "read");
    setCredential("");
  };
  const connect = async () => {
    if (!client || !selected) return;
    setBusy(true);
    try {
      if (selected.authType === "none") return;
      if (selected.authType === "bearer") {
        if (!credential.trim()) throw new Error("Enter the access token supplied by the connector");
        const updated = await client.connectConnectorBearer(selected.id, credential);
        setSelected(updated); resource.retry(); toast.success(`${updated.name} connected`);
        return;
      }
      const flow = await client.startConnectorOAuth(selected.id, access);
      window.location.assign(flow.authorizationUrl);
    } catch (cause) {
      toast.error(message(cause));
    } finally { setBusy(false); }
  };
  const requestMcp = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!client || !requestUrl.trim()) return;
    setRequestBusy(true);
    try {
      const connector = await client.requestMcpConnector(requestUrl.trim());
      resource.retry(); requests.retry(); setRequestUrl(""); setAddOpen(false);
      if (connector.approvalStatus === "approved") {
        toast.success(`${connector.name} is approved and ready to connect`);
        open(connector);
      } else {
        toast.success("MCP server sent for organization approval");
      }
    } catch (cause) { toast.error(message(cause)); } finally { setRequestBusy(false); }
  };
  const disconnect = async () => {
    if (!client || !selected) return;
    setBusy(true);
    try {
      await client.disconnectConnector(selected.id);
      setSelected({ ...selected, connectionStatus: "not_connected", connectedAccessLevel: null, accountEmail: null, credentialConfigured: false, grantedScopes: [] });
      resource.retry(); toast.success(`${selected.name} disconnected`);
    } catch (cause) { toast.error(message(cause)); } finally { setBusy(false); }
  };
  const chooseFiles = async () => {
    if (!client || !selected) return;
    setBusy(true);
    try {
      const session = await client.googlePickerSession(selected.id);
      const picker = await loadGooglePicker();
      const view = new picker.DocsView(picker.ViewId.DOCS).setIncludeFolders(true);
      new picker.PickerBuilder()
        .setAppId(session.appId)
        .setDeveloperKey(session.apiKey)
        .setOAuthToken(session.accessToken)
        .setOrigin(session.origin)
        .addView(view)
        .enableFeature(picker.Feature.MULTISELECT_ENABLED)
        .setCallback((result: Record<string, unknown>) => {
          if (result.action === picker.Action.PICKED) {
            const documents = Array.isArray(result.docs) ? result.docs : [];
            toast.success(`${documents.length} Google Drive ${documents.length === 1 ? "item" : "items"} available to Berry`);
          }
        })
        .build()
        .setVisible(true);
    } catch (cause) { toast.error(message(cause)); } finally { setBusy(false); }
  };

  const unresolvedRequests = requests.data.filter((connector) => connector.approvalStatus !== "approved");
  const approvedMcp = resource.data.filter((connector) => connector.kind === "custom_mcp");

  return <ManagementPage title="Connectors" description="Connect approved apps once, then let Berry use their tools when a task needs them." actions={<Button onClick={() => setAddOpen(true)}><Plus />Add MCP server</Button>}>
    {unresolvedRequests.length ? <Section title="MCP approval status" description="Connect becomes available after an organization administrator approves the server.">
      <div className="grid gap-2">
        {unresolvedRequests.map((connector) => <div key={connector.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
          <span className="flex min-w-0 items-center gap-3"><ConnectorIcon connector={connector} /><span className="min-w-0"><b className="block truncate text-sm font-medium">{connector.name}</b><small className="block truncate text-xs text-muted-foreground">{connector.url}</small></span></span>
          <div className="flex items-center gap-2"><StatusPill tone={connector.approvalStatus === "pending" ? "warning" : "neutral"}>{connector.approvalStatus === "pending" ? <><Clock3 className="size-3" />Awaiting approval</> : "Not approved"}</StatusPill><Button size="sm" disabled>{connector.approvalStatus === "pending" ? "Connect after approval" : "Connect unavailable"}</Button></div>
        </div>)}
      </div>
    </Section> : null}
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search connectors" aria-label="Search connectors" className="h-10 pl-9" />
    </div>
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} empty={!resource.loading && visible.length === 0} emptyTitle="No connectors available" emptyText="An administrator must enable connectors before they appear here.">
      <div className="grid gap-3 md:grid-cols-2">
        {visible.map((connector) => <ConnectorCard key={connector.id} connector={connector} onClick={() => open(connector)} />)}
      </div>
    </AsyncState>
    <Dialog open={addOpen} onOpenChange={setAddOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add an MCP server</DialogTitle>
          <DialogDescription>{canApprove ? "Paste a Streamable HTTP MCP URL. Administrators can approve it immediately." : "Paste a Streamable HTTP MCP URL. An administrator must approve a new server before anyone can connect."}</DialogDescription>
        </DialogHeader>
        {approvedMcp.length ? <div className="grid gap-2">
          <div><b className="text-xs font-medium">Organization catalog</b><p className="mt-0.5 text-xs text-muted-foreground">Already approved and available to everyone.</p></div>
          <div className="max-h-48 space-y-1.5 overflow-y-auto">{approvedMcp.map((connector) => <div key={connector.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"><span className="min-w-0"><b className="block truncate text-sm font-medium">{connector.name}</b><small className="block truncate text-xs text-muted-foreground">{connector.url}</small></span><Button size="sm" variant="outline" onClick={() => { setAddOpen(false); open(connector); }}>{connector.connectionStatus === "connected" ? "View" : "Connect"}</Button></div>)}</div>
        </div> : null}
        <form className="grid gap-3" onSubmit={(event) => void requestMcp(event)}>
          {approvedMcp.length ? <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-muted-foreground"><span className="h-px flex-1 bg-border" /><span>New server</span><span className="h-px flex-1 bg-border" /></div> : null}
          <Field label="Streamable HTTP MCP URL" htmlFor={requestUrlId}><Input id={requestUrlId} type="url" required value={requestUrl} onChange={(event) => setRequestUrl(event.currentTarget.value)} placeholder="https://mcp.example.com/mcp" autoComplete="url" /></Field>
          <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">Berry discovers the server’s OAuth configuration when you connect. Your authorization is personal; approving the server does not share anyone’s OAuth tokens.</div>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button><Button type="submit" disabled={requestBusy || !client || !requestUrl.trim()}>{requestBusy ? "Submitting…" : canApprove ? "Add to organization" : "Request approval"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(selected)} onOpenChange={(value) => { if (!value) setSelected(null); }}>
      {selected ? <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="items-center text-center sm:items-center sm:text-center">
          <ConnectorIcon connector={selected} large />
          <DialogTitle className="text-xl">{selected.name}</DialogTitle>
          <DialogDescription className="max-w-lg text-sm leading-6">{selected.description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 py-2">
          {selected.connectionStatus === "connected" ? <div className="flex items-center justify-between rounded-lg border border-border bg-muted/25 px-3 py-2.5">
            <span className="min-w-0"><b className="block text-sm font-medium">Connected</b><small className="block truncate text-xs text-muted-foreground">{selected.accountEmail ?? (selected.authStrategy === "shared" ? "Managed by your organization" : "Credential saved")}</small></span>
            <StatusPill tone="good"><Check className="size-3" />{selected.provider === "google" ? selected.connectedAccessLevel === "full" ? "Full access" : "Read access" : "Connected"}</StatusPill>
          </div> : null}
          {selected.provider === "google" && selected.authType === "oauth" && selected.connectionStatus !== "connected" ? <fieldset className="grid gap-2">
            <legend className="text-xs font-medium text-foreground">Access to request</legend>
            <div className="grid grid-cols-2 gap-2">
              <AccessChoice title="Read" description="Search and review data" selected={access === "read"} onClick={() => setAccess("read")} />
              <AccessChoice title="Full" description="Also create and change data" selected={access === "full"} disabled={selected.maxAccessLevel !== "full"} onClick={() => setAccess("full")} />
            </div>
            {selected.maxAccessLevel !== "full" ? <small className="text-xs text-muted-foreground">Your administrator has limited this connector to read access.</small> : null}
          </fieldset> : null}
          {selected.authType === "bearer" && selected.authStrategy === "personal" && selected.connectionStatus !== "connected" ? <label className="grid gap-1.5 text-xs font-medium">Access token<Input type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.currentTarget.value)} placeholder="Paste token" /></label> : null}
          {selected.connectionStatus !== "connected" && selected.authType !== "none" ? <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">
            Berry uses this connection only for tasks you request. Relevant connector data may be sent to the model provider configured by your organization. Write actions still require confirmation, and connector data is not used for generalized model training by Berry.
          </div> : null}
          <div>
            <h3 className="text-xs font-medium text-foreground">Available services</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">{selected.services.map((service) => <Badge key={service} variant="secondary">{service}</Badge>)}</div>
          </div>
          <div>
            <h3 className="text-xs font-medium text-foreground">What Berry can do</h3>
            {selected.tools.length ? <div className="mt-2 grid gap-1.5 sm:grid-cols-2">{selected.tools.slice(0, 10).map((tool) => <div key={tool} className="rounded-md border border-border px-2.5 py-2 text-xs text-muted-foreground">{humanTool(tool)}</div>)}</div> : <p className="mt-2 text-xs leading-5 text-muted-foreground">Berry will discover this server’s tools after you authorize your account.</p>}
            {selected.tools.length > 10 ? <small className="mt-2 block text-xs text-muted-foreground">Plus {selected.tools.length - 10} more approved tools</small> : null}
          </div>
          {selected.limitations.length ? <div className="rounded-lg border border-border bg-muted/20 p-3"><b className="text-xs font-medium">Security boundary</b>{selected.limitations.map((limitation) => <p key={limitation} className="mt-1 text-xs leading-5 text-muted-foreground">{limitation}</p>)}</div> : null}
          {selected.websiteUrl || selected.privacyPolicyUrl ? <div><h3 className="text-xs font-medium text-foreground">More information</h3><div className="mt-2 flex flex-wrap gap-3">{selected.websiteUrl ? <a href={selected.websiteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-foreground underline underline-offset-4">Website<ExternalLink className="size-3" /></a> : null}{selected.privacyPolicyUrl ? <a href={selected.privacyPolicyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-foreground underline underline-offset-4">Privacy policy<ExternalLink className="size-3" /></a> : null}</div></div> : null}
        </div>
        <DialogFooter className="sm:justify-between">
          {selected.connectionStatus === "connected" && selected.authStrategy === "personal" ? <Button variant="outline" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button> : <span />}
          {selected.connectionStatus === "connected" && selected.key === "google-workspace" && selected.workspaceAccessMode === "selected_files" ? <Button variant="outline" disabled={busy} onClick={() => void chooseFiles()}><FileText />Choose Drive files</Button> : null}
          {selected.connectionStatus !== "connected" && selected.authType !== "none" ? <Button disabled={busy || !client || !selected.configured} onClick={() => void connect()}>{busy ? "Connecting…" : selected.configured ? `Connect ${selected.name}` : "Admin setup required"}</Button> : null}
        </DialogFooter>
      </DialogContent> : null}
    </Dialog>
  </ManagementPage>;
}

function ConnectorCard({ connector, onClick }: { connector: Connector; onClick: () => void }) {
  const connected = connector.connectionStatus === "connected";
  return <button type="button" onClick={onClick} className="group flex min-h-28 items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/20 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <ConnectorIcon connector={connector} />
    <span className="min-w-0 flex-1"><span className="flex items-start justify-between gap-2"><b className="text-sm font-medium text-foreground">{connector.name}</b>{connected ? <StatusPill tone="good">Connected</StatusPill> : <Plus className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" />}</span><span className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{connector.description}</span><span className="mt-2 block text-[11px] text-muted-foreground">{connector.services.join(" · ")}</span></span>
  </button>;
}

function ConnectorSummary({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "good" | "warning" | "neutral" }) {
  return <div className="rounded-xl border border-border bg-card p-3.5"><div className="flex items-start justify-between gap-2"><span className="text-xs font-medium text-muted-foreground">{label}</span><StatusPill tone={tone}>{tone === "good" ? "Ready" : tone === "warning" ? "Setup" : "Managed"}</StatusPill></div><b className="mt-2 block text-lg font-medium tabular-nums text-foreground">{value}</b><p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{detail}</p></div>;
}

function ConnectorIcon({ connector, large = false }: { connector: Connector; large?: boolean }) {
  const Icon = connector.key === "google-workspace" ? HardDrive : connector.key === "gmail" ? Mail : connector.key === "google-calendar" ? CalendarDays : PlugZap;
  return <span className={cn("flex shrink-0 items-center justify-center rounded-xl border border-border bg-muted/30 text-foreground", large ? "mb-1 size-16" : "size-11")}><Icon className={large ? "size-7" : "size-5"} aria-hidden /></span>;
}

function AccessChoice({ title, description, selected, disabled, onClick }: { title: string; description: string; selected: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" disabled={disabled} onClick={onClick} className={cn("rounded-lg border px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-40", selected ? "border-foreground/30 bg-muted/50" : "border-border hover:bg-muted/20")}><b className="block text-sm font-medium">{title}</b><small className="text-xs text-muted-foreground">{description}</small></button>;
}

function GooglePolicyRow({ connector, disabled, onChange }: { connector: Connector; disabled: boolean; onChange: (enabled: boolean, level: "read" | "full", mode?: "selected_files" | "search_workspace") => void }) {
  const [mode, setMode] = React.useState(connector.workspaceAccessMode ?? "selected_files");
  React.useEffect(() => setMode(connector.workspaceAccessMode ?? "selected_files"), [connector.workspaceAccessMode]);
  return <div className="rounded-xl border border-border bg-card p-3.5"><div className="flex flex-wrap items-center justify-between gap-3"><span className="flex min-w-0 items-center gap-3"><ConnectorIcon connector={connector} /><span><b className="block text-sm font-medium">{connector.name}</b><small className="text-xs text-muted-foreground">{connector.services.join(" · ")}</small></span></span><div className="flex items-center rounded-lg border border-border bg-muted/20 p-0.5" role="group" aria-label={`${connector.name} access`}>
    {(["off", "read", "full"] as const).map((level) => { const active = level === "off" ? !connector.enabled : connector.enabled && connector.maxAccessLevel === level; return <button key={level} type="button" disabled={disabled} onClick={() => onChange(level !== "off", level === "full" ? "full" : "read", mode)} className={cn("rounded-md px-3 py-1.5 text-xs font-medium capitalize text-muted-foreground transition-colors disabled:opacity-40", active && "bg-background text-foreground shadow-sm")}>{level}</button>; })}
  </div></div>{connector.key === "google-workspace" ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3"><span><b className="block text-xs font-medium">Drive access boundary</b><small className="text-xs text-muted-foreground">Selected files uses Google Picker; workspace search can search all files the user can access.</small></span><div className="w-48"><FormSelect value={mode} onChange={(value) => { const next = value as typeof mode; setMode(next); if (connector.enabled) onChange(true, connector.maxAccessLevel, next); }} options={[{ value: "selected_files", label: "Selected files only" }, { value: "search_workspace", label: "Workspace search" }]} /></div></div> : null}</div>;
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) { return <div className="grid gap-1.5"><Label htmlFor={htmlFor} className="text-xs">{label}</Label>{children}</div>; }
function humanTool(value: string): string { return value.replace(/^google_/, "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : "Connector request failed"; }

let pickerPromise: Promise<any> | null = null;
function loadGooglePicker(): Promise<any> {
  if (pickerPromise) return pickerPromise;
  const attempt = new Promise<any>((resolve, reject) => {
    const ready = () => {
      const api = (window as any).gapi;
      if (!api?.load) { reject(new Error("Google Picker failed to load")); return; }
      api.load("picker", { callback: () => resolve((window as any).google.picker), onerror: () => reject(new Error("Google Picker failed to initialize")) });
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-berry-google-picker="true"]');
    if (existing) {
      if ((window as any).gapi) ready();
      else if (existing.dataset.berryGooglePickerLoaded === "true") reject(new Error("Google Picker failed to load"));
      else {
        existing.addEventListener("load", ready, { once: true });
        existing.addEventListener("error", () => reject(new Error("Google Picker script could not be loaded")), { once: true });
      }
      return;
    }
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.dataset.berryGooglePicker = "true";
    script.addEventListener("load", () => { script.dataset.berryGooglePickerLoaded = "true"; ready(); }, { once: true });
    script.addEventListener("error", () => reject(new Error("Google Picker script could not be loaded")), { once: true });
    document.head.appendChild(script);
  });
  pickerPromise = attempt.catch((error) => {
    pickerPromise = null;
    if (!(window as any).gapi) document.querySelector('script[data-berry-google-picker="true"]')?.remove();
    throw error;
  });
  return pickerPromise;
}
