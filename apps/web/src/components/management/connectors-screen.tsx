import * as React from "react";
import type { Connector, GoogleConnectorConfiguration } from "@berry/shared";
import {
  CalendarDays,
  Check,
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

export function PersonalConnectorsScreen({ client }: ManagementScreenProps) {
  const resource = useResource("connectors:me", () => client?.listConnectors() ?? Promise.resolve([]), [] as Connector[]);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<Connector | null>(null);
  const [access, setAccess] = React.useState<"read" | "full">("read");
  const [credential, setCredential] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const visible = resource.data.filter((connector) => `${connector.name} ${connector.description} ${connector.services.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("connector_error");
    if (error) toast.error(error);
    if (params.get("connected") === "true") toast.success("Connector connected");
    if (error || params.has("connected")) {
      params.delete("connector_error"); params.delete("connected"); params.delete("connector");
      window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
      resource.retry();
    }
  }, []);

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

  return <ManagementPage title="Connectors" description="Connect approved apps once, then let Berry use their tools when a task needs them.">
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search connectors" aria-label="Search connectors" className="h-10 pl-9" />
    </div>
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} empty={!resource.loading && visible.length === 0} emptyTitle="No connectors available" emptyText="An administrator must enable connectors before they appear here.">
      <div className="grid gap-3 md:grid-cols-2">
        {visible.map((connector) => <ConnectorCard key={connector.id} connector={connector} onClick={() => open(connector)} />)}
      </div>
    </AsyncState>
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
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">{selected.tools.slice(0, 10).map((tool) => <div key={tool} className="rounded-md border border-border px-2.5 py-2 text-xs text-muted-foreground">{humanTool(tool)}</div>)}</div>
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

export function AdminConnectorsScreen({ client, tenantId, permissions }: ManagementScreenProps) {
  const canWrite = permissions.includes("mcp:write");
  const canConfigure = permissions.includes("org_settings:write");
  const canReadGoogleConfiguration = permissions.includes("org_settings:read");
  const resource = useResource(`connectors:admin:${tenantId}:${canReadGoogleConfiguration ? "google-config" : "connectors-only"}`, async () => {
    if (!client) return { connectors: [] as Connector[], google: EMPTY_GOOGLE };
    return loadAdminConnectorData(client, tenantId, canReadGoogleConfiguration);
  }, { connectors: [] as Connector[], google: EMPTY_GOOGLE });
  const googleApps = React.useMemo(() => resource.data.connectors.filter((item) => item.provider === "google"), [resource.data.connectors]);
  const googleConfigured = resource.data.google.configured || googleApps.some((connector) => connector.configured);
  const custom = React.useMemo(() => resource.data.connectors.filter((item) => item.kind === "custom_mcp"), [resource.data.connectors]);
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [customOpen, setCustomOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<Connector | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [googleDraft, setGoogleDraft] = React.useState({ clientId: "", clientSecret: "", hostedDomain: "", pickerApiKey: "", pickerProjectNumber: "" });
  const [customDraft, setCustomDraft] = React.useState({ name: "", description: "", url: "", websiteUrl: "", privacyPolicyUrl: "", transport: "streamable-http" as "streamable-http" | "http-sse", authType: "oauth" as "none" | "bearer" | "oauth", authStrategy: "personal" as "personal" | "shared", maxAccessLevel: "full" as const, oauthScope: "", sharedCredential: "", personalCredential: "" });
  const [toolAllowlist, setToolAllowlist] = React.useState<Record<string, { available: string[]; selected: string[] }>>({});

  React.useEffect(() => setGoogleDraft((current) => ({ ...current, clientId: resource.data.google.clientId ?? "", hostedDomain: resource.data.google.hostedDomain ?? "", pickerProjectNumber: resource.data.google.pickerProjectNumber ?? "" })), [resource.data.google]);
  React.useEffect(() => {
    setToolAllowlist((current) => {
      const next = { ...current };
      let changed = false;
      for (const connector of custom) {
        const prior = current[connector.id];
        if (!prior) {
          next[connector.id] = { available: connector.tools, selected: connector.tools };
          changed = true;
          continue;
        }
        if (prior.available.join("\0") !== connector.tools.join("\0")) {
          const selected = prior.available.length
            ? prior.selected.filter((tool) => connector.tools.includes(tool))
            : connector.tools;
          next[connector.id] = { available: connector.tools, selected };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [custom]);

  const saveGoogle = async () => {
    if (!client) return; setBusy("google-save");
    try {
      await client.configureGoogleConnectors(tenantId, {
        clientId: googleDraft.clientId,
        ...(googleDraft.clientSecret ? { clientSecret: googleDraft.clientSecret } : {}),
        hostedDomain: googleDraft.hostedDomain || null,
        ...(googleDraft.pickerApiKey ? { pickerApiKey: googleDraft.pickerApiKey } : {}),
        pickerProjectNumber: googleDraft.pickerProjectNumber || null,
      });
      toast.success("Google OAuth configuration saved"); setSetupOpen(false); resource.retry();
    } catch (cause) { toast.error(message(cause)); } finally { setBusy(null); }
  };
  const updateGoogle = async (connector: Connector, enabled: boolean, maxAccessLevel: "read" | "full", workspaceAccessMode = connector.workspaceAccessMode ?? "selected_files") => {
    if (!client) return; setBusy(connector.id);
    try { await client.updateGoogleConnector(tenantId, connector.key as "google-workspace" | "gmail" | "google-calendar", { enabled, maxAccessLevel, ...(connector.key === "google-workspace" ? { workspaceAccessMode } : {}) }); resource.retry(); }
    catch (cause) { toast.error(message(cause)); } finally { setBusy(null); }
  };
  const saveCustom = async () => {
    if (!client) return; setBusy("custom-save");
    try {
      const connector = await client.saveOrganizationCustomConnector(tenantId, {
        name: customDraft.name,
        url: customDraft.url,
        transport: customDraft.transport,
        authType: customDraft.authType,
        authStrategy: customDraft.authStrategy,
        maxAccessLevel: customDraft.maxAccessLevel,
        ...(customDraft.description ? { description: customDraft.description } : {}),
        ...(customDraft.websiteUrl ? { websiteUrl: customDraft.websiteUrl } : {}),
        ...(customDraft.privacyPolicyUrl ? { privacyPolicyUrl: customDraft.privacyPolicyUrl } : {}),
        ...(customDraft.oauthScope ? { oauthScope: customDraft.oauthScope } : {}),
        ...(customDraft.sharedCredential ? { sharedCredential: customDraft.sharedCredential } : {}),
        ...(customDraft.personalCredential ? { personalCredential: customDraft.personalCredential } : {}),
      });
      toast.success(`${connector.name} saved as a draft`); setCustomOpen(false); resource.retry();
    } catch (cause) { toast.error(message(cause)); } finally { setBusy(null); }
  };
  const action = async (connector: Connector, kind: "oauth" | "discover" | "publish" | "disable") => {
    if (!client) return; setBusy(`${connector.id}:${kind}`);
    try {
      if (kind === "oauth") { const flow = await client.startOrganizationConnectorOAuth(tenantId, connector.id); window.location.assign(flow.authorizationUrl); return; }
      if (kind === "discover") await client.discoverOrganizationCustomConnector(tenantId, connector.id);
      const allowedTools = toolAllowlist[connector.id]?.selected ?? connector.tools;
      if (kind === "publish") await client.publishOrganizationCustomConnector(tenantId, connector.id, { enabled: true, allowedTools });
      if (kind === "disable") await client.publishOrganizationCustomConnector(tenantId, connector.id, { enabled: false, allowedTools });
      toast.success(kind === "discover" ? "Tools discovered—review and publish the connector" : kind === "publish" ? "Connector published to all users" : "Connector disabled");
      resource.retry();
    } catch (cause) { toast.error(message(cause)); } finally { setBusy(null); }
  };
  const deleteConnector = async () => {
    if (!client || !pendingDelete) return;
    const connector = pendingDelete;
    setBusy(`${connector.id}:delete`);
    try {
      await client.deleteOrganizationCustomConnector(tenantId, connector.id);
      toast.success("Connector deleted");
      setPendingDelete(null);
      resource.retry();
    } catch (cause) { toast.error(message(cause)); } finally { setBusy(null); }
  };

  return <ManagementPage title="Connectors" eyebrow="Organization administration" description="Configure native apps and publish reviewed MCP servers to everyone in your organization." actions={<>
    <Button variant="outline" disabled={!canConfigure} onClick={() => setSetupOpen(true)}><KeyRound />Google OAuth</Button>
    <Button disabled={!canWrite} onClick={() => setCustomOpen(true)}><Plus />Custom MCP</Button>
  </>}>
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
      <Section title="Google apps" description="The OAuth app is configured once. Each user then connects their own Google account.">
        {canReadGoogleConfiguration ? <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
          <span><b className="block text-sm font-medium">Google OAuth client</b><small className="text-xs text-muted-foreground">{resource.data.google.configured ? `${resource.data.google.status} · ${resource.data.google.clientId}` : "Not configured"}</small></span>
          <div className="flex items-center gap-2"><StatusPill tone={resource.data.google.status === "verified" ? "good" : resource.data.google.configured ? "warning" : "neutral"}>{resource.data.google.status.replace("_", " ")}</StatusPill>{resource.data.google.configured && canConfigure ? <Button size="sm" variant="ghost" disabled={busy === "google-test"} onClick={() => { setBusy("google-test"); void client?.testGoogleConnectorConfiguration(tenantId).then(() => { toast.success("Google discovery endpoint is reachable"); resource.retry(); }).catch((cause) => toast.error(message(cause))).finally(() => setBusy(null)); }}><RefreshCw />Test</Button> : null}</div>
        </div> : null}
        <div className="grid gap-3">{googleApps.map((connector) => <GooglePolicyRow key={connector.id} connector={connector} disabled={!canWrite || busy === connector.id || !googleConfigured} onChange={(enabled, level, mode) => void updateGoogle(connector, enabled, level, mode)} />)}</div>
      </Section>
      <Section title="Custom MCP" description="Save a draft, authenticate if needed, inspect its advertised tools, then publish an exact allowlist.">
        {custom.length ? <div className="grid gap-3">{custom.map((connector) => <div key={connector.id} className="rounded-xl border border-border bg-card p-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <span className="flex min-w-0 items-start gap-3"><ConnectorIcon connector={connector} /><span className="min-w-0"><b className="block truncate text-sm font-medium">{connector.name}</b><small className="block truncate text-xs text-muted-foreground">{connector.url}</small><span className="mt-1.5 flex gap-1.5"><StatusPill tone={connector.publicationStatus === "published" ? connector.enabled ? "good" : "warning" : "neutral"}>{connector.publicationStatus === "draft" ? "Draft" : connector.enabled ? "Published" : "Disabled"}</StatusPill><Badge variant="outline">{connector.authStrategy === "shared" ? "Organization auth" : "Per-user auth"}</Badge></span></span></span>
            <div className="flex flex-wrap justify-end gap-1.5">
              {connector.authType === "oauth" && !connector.credentialConfigured ? <Button size="sm" variant="outline" disabled={!canWrite || Boolean(busy)} onClick={() => void action(connector, "oauth")}><KeyRound />Authorize</Button> : null}
              <Button size="sm" variant="outline" disabled={!canWrite || Boolean(busy) || (connector.authType !== "none" && !connector.credentialConfigured)} onClick={() => void action(connector, "discover")}><Search />Discover tools</Button>
              {connector.publicationStatus === "draft" && connector.tools.length ? <Button size="sm" disabled={!canWrite || Boolean(busy) || !(toolAllowlist[connector.id]?.selected.length ?? connector.tools.length)} onClick={() => void action(connector, "publish")}><ShieldCheck />Publish {toolAllowlist[connector.id]?.selected.length ?? connector.tools.length}</Button> : null}
              {connector.publicationStatus === "published" ? <Button size="sm" variant="outline" disabled={!canWrite || Boolean(busy)} onClick={() => void action(connector, connector.enabled ? "disable" : "publish")}>{connector.enabled ? "Disable" : "Enable"}</Button> : null}
              <Button size="icon-sm" variant="ghost" disabled={!canWrite || Boolean(busy)} aria-label={`Delete ${connector.name}`} onClick={() => setPendingDelete(connector)}><Trash2 /></Button>
            </div>
          </div>
          {connector.tools.length ? <div className="mt-3 border-t border-border pt-3">
            <div className="mb-2 flex items-center justify-between gap-3"><b className="text-xs font-medium">Published tool allowlist</b><small className="text-xs text-muted-foreground">Select only tools users may call</small></div>
            <div className="flex flex-wrap gap-1.5">{connector.tools.map((tool) => { const selected = toolAllowlist[connector.id]?.selected.includes(tool) ?? true; return <button key={tool} type="button" role="checkbox" aria-checked={selected} disabled={!canWrite || connector.publicationStatus === "published"} onClick={() => setToolAllowlist((current) => { const entry = current[connector.id] ?? { available: connector.tools, selected: connector.tools }; return { ...current, [connector.id]: { ...entry, selected: selected ? entry.selected.filter((name) => name !== tool) : [...entry.selected, tool] } }; })} className={cn("rounded-md border px-2 py-1 text-[11px] transition-colors disabled:cursor-default", selected ? "border-foreground/20 bg-muted text-foreground" : "border-border bg-transparent text-muted-foreground line-through")}>{tool}</button>; })}</div>
          </div> : <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">No reviewed tools yet.</p>}
        </div>)}</div> : <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center"><PlugZap className="mx-auto size-5 text-muted-foreground" /><b className="mt-2 block text-sm font-medium">No custom MCP connectors</b><p className="mt-1 text-xs text-muted-foreground">Only administrators can add and publish one.</p></div>}
      </Section>
    </AsyncState>

    <Dialog open={setupOpen} onOpenChange={setSetupOpen}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>Google OAuth configuration</DialogTitle><DialogDescription>Stored encrypted in Berry’s database. Secrets are never returned to the browser after saving.</DialogDescription></DialogHeader><div className="grid gap-3 py-2">
      <Field label="OAuth client ID"><Input value={googleDraft.clientId} onChange={(event) => setGoogleDraft({ ...googleDraft, clientId: event.currentTarget.value })} placeholder="…apps.googleusercontent.com" /></Field>
      <Field label={resource.data.google.configured ? "OAuth client secret (leave blank to keep current)" : "OAuth client secret"}><Input type="password" autoComplete="new-password" value={googleDraft.clientSecret} onChange={(event) => setGoogleDraft({ ...googleDraft, clientSecret: event.currentTarget.value })} /></Field>
      <Field label="Restrict connected accounts to domain"><Input value={googleDraft.hostedDomain} onChange={(event) => setGoogleDraft({ ...googleDraft, hostedDomain: event.currentTarget.value })} placeholder="aesg.com" /></Field>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="Picker API key (optional)"><Input type="password" autoComplete="new-password" value={googleDraft.pickerApiKey} onChange={(event) => setGoogleDraft({ ...googleDraft, pickerApiKey: event.currentTarget.value })} /></Field><Field label="Google Cloud project number"><Input inputMode="numeric" value={googleDraft.pickerProjectNumber} onChange={(event) => setGoogleDraft({ ...googleDraft, pickerProjectNumber: event.currentTarget.value })} /></Field></div>
      <div className="rounded-lg border border-border bg-muted/20 p-3"><b className="text-xs font-medium">Authorized redirect URI</b><code className="mt-1 block break-all text-xs text-muted-foreground">{resource.data.google.callbackUrl}</code></div>
    </div><DialogFooter><Button variant="outline" onClick={() => setSetupOpen(false)}>Cancel</Button><Button disabled={!googleDraft.clientId || busy === "google-save"} onClick={() => void saveGoogle()}>{busy === "google-save" ? "Saving…" : "Save configuration"}</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={customOpen} onOpenChange={setCustomOpen}><DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>Add custom MCP</DialogTitle><DialogDescription>The connector stays disabled until you authenticate it, discover its tools, and publish the reviewed allowlist.</DialogDescription></DialogHeader><div className="grid gap-3 py-2">
      <Field label="Name"><Input value={customDraft.name} onChange={(event) => setCustomDraft({ ...customDraft, name: event.currentTarget.value })} placeholder="Company knowledge" /></Field>
      <Field label="Description"><Textarea value={customDraft.description} onChange={(event) => setCustomDraft({ ...customDraft, description: event.currentTarget.value })} rows={2} /></Field>
      <Field label="HTTPS MCP URL"><Input value={customDraft.url} onChange={(event) => setCustomDraft({ ...customDraft, url: event.currentTarget.value })} placeholder="https://mcp.example.com/mcp" /></Field>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="Website (optional)"><Input type="url" value={customDraft.websiteUrl} onChange={(event) => setCustomDraft({ ...customDraft, websiteUrl: event.currentTarget.value })} placeholder="https://example.com" /></Field><Field label="Privacy policy (optional)"><Input type="url" value={customDraft.privacyPolicyUrl} onChange={(event) => setCustomDraft({ ...customDraft, privacyPolicyUrl: event.currentTarget.value })} placeholder="https://example.com/privacy" /></Field></div>
      <Field label="Transport"><FormSelect value={customDraft.transport} onChange={(transport) => setCustomDraft({ ...customDraft, transport: transport as typeof customDraft.transport })} options={[{ value: "streamable-http", label: "Streamable HTTP" }, { value: "http-sse", label: "HTTP + SSE" }]} /></Field>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="Authentication"><FormSelect value={customDraft.authType} onChange={(authType) => setCustomDraft({ ...customDraft, authType: authType as typeof customDraft.authType })} options={[{ value: "oauth", label: "OAuth 2.1" }, { value: "bearer", label: "Bearer token" }, { value: "none", label: "None" }]} /></Field><Field label="Credential ownership"><FormSelect value={customDraft.authStrategy} onChange={(authStrategy) => setCustomDraft({ ...customDraft, authStrategy: authStrategy as typeof customDraft.authStrategy })} options={[{ value: "personal", label: "Each user connects" }, { value: "shared", label: "One organization credential" }]} /></Field></div>
      {customDraft.authStrategy === "shared" ? <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground"><b className="block font-medium text-foreground">Organization-wide authority</b>Every user will act through the same credential. The upstream system may record the organization account rather than the individual Berry user. Use a dedicated least-privilege service account and publish only the required tools.</div> : null}
      {customDraft.authType === "oauth" ? <Field label="OAuth scopes (optional)"><Input value={customDraft.oauthScope} onChange={(event) => setCustomDraft({ ...customDraft, oauthScope: event.currentTarget.value })} placeholder="read write" /></Field> : null}
      {customDraft.authType === "bearer" && customDraft.authStrategy === "shared" ? <Field label="Organization bearer token"><Input type="password" autoComplete="new-password" value={customDraft.sharedCredential} onChange={(event) => setCustomDraft({ ...customDraft, sharedCredential: event.currentTarget.value })} /></Field> : null}
      {customDraft.authType === "bearer" && customDraft.authStrategy === "personal" ? <Field label="Your bearer token for tool discovery"><Input type="password" autoComplete="new-password" value={customDraft.personalCredential} onChange={(event) => setCustomDraft({ ...customDraft, personalCredential: event.currentTarget.value })} /></Field> : null}
    </div><DialogFooter><Button variant="outline" onClick={() => setCustomOpen(false)}>Cancel</Button><Button disabled={!customDraft.name || !customDraft.url || busy === "custom-save"} onClick={() => void saveCustom()}>{busy === "custom-save" ? "Saving…" : "Save draft"}</Button></DialogFooter></DialogContent></Dialog>

    <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open && busy !== `${pendingDelete?.id}:delete`) setPendingDelete(null); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
          <AlertDialogDescription>This removes the connector and its stored credentials for the organization. This action cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy === `${pendingDelete?.id}:delete`}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy === `${pendingDelete?.id}:delete`} onClick={(event) => { event.preventDefault(); void deleteConnector(); }}>
            {busy === `${pendingDelete?.id}:delete` ? "Deleting…" : "Delete connector"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </ManagementPage>;
}

function ConnectorCard({ connector, onClick }: { connector: Connector; onClick: () => void }) {
  const connected = connector.connectionStatus === "connected";
  return <button type="button" onClick={onClick} className="group flex min-h-28 items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/20 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <ConnectorIcon connector={connector} />
    <span className="min-w-0 flex-1"><span className="flex items-start justify-between gap-2"><b className="text-sm font-medium text-foreground">{connector.name}</b>{connected ? <StatusPill tone="good">Connected</StatusPill> : <Plus className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" />}</span><span className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{connector.description}</span><span className="mt-2 block text-[11px] text-muted-foreground">{connector.services.join(" · ")}</span></span>
  </button>;
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

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="grid gap-1.5"><Label className="text-xs">{label}</Label>{children}</div>; }
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
