import * as React from "react";
import type { Connector } from "@berry/shared";
import { ExternalLink, FileText, Plus, PlugZap } from "lucide-react";
import { toast } from "sonner";
import {
  AsyncState,
  Button,
  CellStack,
  DataTable,
  DefinitionList,
  EmptyPanel,
  InlineNotice,
  Input,
  ManagementDialog,
  ManagementPage,
  Section,
  SegmentedControl,
  StatusPill,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { PersonalConnectorsSkeleton } from "./management-screen-skeletons";
import { ConnectorMark } from "../connector-mark";

export function PersonalConnectorsScreen({ client, permissions }: ManagementScreenProps) {
  const resource = useResource("connectors:me", () => client?.listConnectors() ?? Promise.resolve([]), [] as Connector[]);
  const requests = useResource("connectors:requests", () => client?.listConnectorRequests() ?? Promise.resolve([]), [] as Connector[]);
  const canApprove = permissions.includes("mcp:write");
  const requestUrlId = React.useId();
  const [addOpen, setAddOpen] = React.useState(false);
  const [requestUrl, setRequestUrl] = React.useState("");
  const [requestBusy, setRequestBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<Connector | null>(null);
  const [access, setAccess] = React.useState<"read" | "full">("read");
  const [credential, setCredential] = React.useState("");
  const [busy, setBusy] = React.useState(false);
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
    const defaultAccess = connector.provider === "google" ? connector.maxAccessLevel : "read";
    setAccess(connector.connectedAccessLevel ?? defaultAccess);
    setCredential("");
  };
  const connect = async (accessLevel = access) => {
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
      const flow = await client.startConnectorOAuth(selected.id, accessLevel);
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

  // Requests that are still waiting (or were declined) are not in the catalog
  // yet, so they join the same list instead of a separate section.
  const rows = React.useMemo(() => {
    const byId = new Map<string, Connector>();
    for (const connector of requests.data) if (connector.approvalStatus !== "approved") byId.set(connector.id, connector);
    for (const connector of resource.data) if (!byId.has(connector.id)) byId.set(connector.id, connector);
    return [...byId.values()].sort((left, right) => connectorRank(left) - connectorRank(right) || left.name.localeCompare(right.name));
  }, [requests.data, resource.data]);
  const pendingCount = rows.filter((connector) => connector.approvalStatus === "pending").length;
  const selectedApproved = selected?.approvalStatus === "approved";
  const selectedConnected = selected?.connectionStatus === "connected";
  const canGrantWriteAccess = selectedApproved && selectedConnected && selected.provider === "google"
    && selected.connectedAccessLevel === "read" && selected.maxAccessLevel === "full";

  return <ManagementPage title="Connectors" description="Connect your accounts in other apps so Berry can use them when a task needs to." actions={<Button disabled={!client} onClick={() => setAddOpen(true)}><Plus />Add MCP server</Button>}>
    {pendingCount ? <InlineNotice tone="info">
      {pendingCount === 1 ? "One server you requested is" : `${pendingCount} servers you requested are`} waiting for an organization administrator. You can connect as soon as {pendingCount === 1 ? "it is" : "they are"} approved, and this list updates on its own.
    </InlineNotice> : null}
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} skeleton={<PersonalConnectorsSkeleton />}>
      {rows.length === 0 ? <EmptyPanel
        icon={PlugZap}
        title="No connectors available"
        description="Your organization has not turned on any connectors yet. You can request an MCP server, or ask an administrator to enable one."
        action={<Button variant="secondary" disabled={!client} onClick={() => setAddOpen(true)}><Plus />Add MCP server</Button>}
      /> : <Section flush>
        <DataTable
          label="Connectors"
          columns={["Connector", "Works with", "Status"]}
          onRowSelect={(index) => { const connector = rows[index]; if (connector) open(connector); }}
          rowLabel={(index) => `Opened ${rows[index]?.name ?? "connector"}`}
          rows={rows.map((connector) => {
            const status = connectorStatus(connector);
            return [
              <span className="flex min-w-0 max-w-[30rem] items-center gap-3">
                <ConnectorIcon connector={connector} />
                <CellStack primary={connector.name} secondary={connector.description || connector.url} />
              </span>,
              <span className="text-muted-foreground">{connector.services.length ? connector.services.join(", ") : connector.kind === "custom_mcp" ? "MCP server" : "—"}</span>,
              <span data-sort={connectorRank(connector)}><StatusPill tone={status.tone}>{status.label}</StatusPill></span>,
            ];
          })}
        />
      </Section>}
    </AsyncState>

    <ManagementDialog
      open={addOpen}
      onOpenChange={setAddOpen}
      title="Add an MCP server"
      description={canApprove
        ? "Add a server that signs you in with OAuth. As an administrator you approve it for the organization straight away."
        : "Request a server that signs you in with OAuth. An administrator has to approve it before anyone can connect."}
      footer={<>
        <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
        <Button type="submit" form="request-mcp-connector-form" disabled={requestBusy || !client || !requestUrl.trim()}>{requestBusy ? "Submitting…" : canApprove ? "Add to organization" : "Request approval"}</Button>
      </>}
    >
      <form id="request-mcp-connector-form" className="grid gap-4" onSubmit={(event) => void requestMcp(event)}>
        <div className="grid gap-1.5">
          <label htmlFor={requestUrlId} className="text-xs font-medium text-foreground">Server URL</label>
          <Input id={requestUrlId} type="url" required value={requestUrl} onChange={(event) => setRequestUrl(event.currentTarget.value)} placeholder="https://mcp.example.com/mcp" autoComplete="url" />
          <p className="text-xs leading-5 text-muted-foreground">The server must use the Streamable HTTP transport. Servers that are already approved are in the list on this page.</p>
        </div>
        <InlineNotice tone="info">Approval makes the server available to everyone, but each person signs in with their own account. Nobody’s sign-in is shared.</InlineNotice>
      </form>
    </ManagementDialog>

    <ManagementDialog
      open={Boolean(selected)}
      onOpenChange={(value) => { if (!value) setSelected(null); }}
      title={selected?.name ?? "Connector"}
      description={selected?.description || "A connector approved for your organization."}
      size="lg"
      footer={selected ? <>
        {selectedConnected && selected.authStrategy === "personal" ? <Button variant="secondary" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button> : null}
        {selectedConnected && selected.key === "google-workspace" && selected.workspaceAccessMode === "selected_files" ? <Button variant="secondary" disabled={busy} onClick={() => void chooseFiles()}><FileText />Choose Drive files</Button> : null}
        {canGrantWriteAccess ? <Button disabled={busy || !client || !selected.configured} onClick={() => void connect("full")}>{busy ? "Opening sign-in…" : "Grant write access"}</Button> : null}
        {selectedApproved && !selectedConnected && selected.authType !== "none" ? <Button disabled={busy || !client || !selected.configured} onClick={() => void connect()}>{busy ? "Connecting…" : needsReconnect(selected) ? `Reconnect ${selected.name}` : `Connect ${selected.name}`}</Button> : null}
      </> : undefined}
    >
      {selected ? <div className="grid gap-4">
        {selected.approvalStatus === "pending" ? <InlineNotice tone="warning" title="Awaiting approval">An organization administrator has to approve this server before you can connect.</InlineNotice> : null}
        {selected.approvalStatus === "rejected" ? <InlineNotice tone="danger" title="Not approved">An administrator declined this server, so it can’t be connected.</InlineNotice> : null}
        {selectedApproved && !selectedConnected && !selected.configured && selected.authType !== "none" ? <InlineNotice tone="warning" title="Needs admin setup">An administrator has to finish setting up this connector before you can connect.</InlineNotice> : null}
        <DefinitionList items={[
          { term: "Status", detail: <StatusPill tone={connectorStatus(selected).tone}>{connectorStatus(selected).label}</StatusPill> },
          ...(selectedConnected ? [{ term: "Account", detail: selected.accountEmail ?? (selected.authStrategy === "shared" ? "Managed by your organization" : "Saved access token") }] : []),
          ...(selectedConnected && selected.provider === "google" ? [{ term: "Access", detail: selected.connectedAccessLevel === "full" ? "Read and write" : "Read only" }] : []),
          ...(selected.services.length ? [{ term: "Works with", detail: selected.services.join(", ") }] : []),
          ...(selected.kind === "custom_mcp" && selected.url ? [{ term: "Server", detail: <span className="break-all font-mono text-xs">{selected.url}</span> }] : []),
        ]} />
        {selectedApproved && selected.provider === "google" && selected.authType === "oauth" && !selectedConnected ? <div className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Access to request</span>
          {selected.maxAccessLevel === "full" ? <>
            <div><SegmentedControl label="Access to request" value={access} onChange={setAccess} options={[{ value: "read", label: "Read only" }, { value: "full", label: "Read and write" }]} /></div>
            <p className="text-xs leading-5 text-muted-foreground">{access === "full" ? "Berry can search, read, create and change data. Changes still ask for your confirmation." : "Berry can search and read data but not change it."}</p>
          </> : <p className="text-xs leading-5 text-muted-foreground">Read only. Your administrator has limited this connector to reading data.</p>}
        </div> : null}
        {selectedApproved && selected.authType === "bearer" && selected.authStrategy === "personal" && !selectedConnected ? <label className="grid gap-1.5 text-xs font-medium text-foreground">
          Access token
          <Input type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.currentTarget.value)} placeholder="Paste the token from the app" />
        </label> : null}
        <div className="grid gap-1.5">
          <h3 className="text-xs font-medium text-foreground">What Berry can do</h3>
          {selected.tools.length ? <>
            <ul className="grid gap-x-6 gap-y-1 text-md text-muted-foreground sm:grid-cols-2">{selected.tools.slice(0, 10).map((tool) => <li key={tool} className="truncate">{humanTool(tool)}</li>)}</ul>
            {selected.tools.length > 10 ? <p className="text-xs text-muted-foreground">And {selected.tools.length - 10} more.</p> : null}
          </> : <p className="text-xs leading-5 text-muted-foreground">Berry finds out what this server offers after you connect your account.</p>}
        </div>
        {selected.limitations.length ? <div className="grid gap-1.5">
          <h3 className="text-xs font-medium text-foreground">Limits</h3>
          <ul className="grid gap-1 text-xs leading-5 text-muted-foreground">{selected.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
        </div> : null}
        {selectedApproved && !selectedConnected && selected.authType !== "none" ? <p className="text-xs leading-5 text-muted-foreground">
          Berry uses this connection only for tasks you ask for. Data it reads may be sent to the model provider your organization has chosen, and changes always ask for your confirmation first.
        </p> : null}
        {selected.websiteUrl || selected.privacyPolicyUrl ? <div className="flex flex-wrap gap-4 text-xs">
          {selected.websiteUrl ? <a href={selected.websiteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-foreground underline underline-offset-4">Website<ExternalLink className="size-3" aria-hidden /></a> : null}
          {selected.privacyPolicyUrl ? <a href={selected.privacyPolicyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-foreground underline underline-offset-4">Privacy policy<ExternalLink className="size-3" aria-hidden /></a> : null}
        </div> : null}
      </div> : null}
    </ManagementDialog>
  </ManagementPage>;
}

/** Shared by the three capability screens' lists: what needs attention sorts first. */
function connectorRank(connector: Connector): number {
  if (connector.approvalStatus === "pending" || needsReconnect(connector)) return 0;
  if (connector.connectionStatus === "connected") return 1;
  if (connector.approvalStatus === "rejected") return 3;
  return 2;
}

function connectorStatus(connector: Connector): { label: string; tone: "good" | "warning" | "danger" | "neutral" } {
  if (connector.approvalStatus === "pending") return { label: "Awaiting approval", tone: "warning" };
  if (connector.approvalStatus === "rejected") return { label: "Not approved", tone: "danger" };
  if (connector.connectionStatus === "connected") return { label: "Connected", tone: "good" };
  if (connector.connectionStatus === "error") return { label: "Connection error", tone: "danger" };
  if (needsReconnect(connector)) return { label: "Reconnect needed", tone: "warning" };
  if (connector.authType === "none") return { label: "Ready", tone: "good" };
  if (!connector.configured) return { label: "Needs admin setup", tone: "neutral" };
  return { label: "Not connected", tone: "neutral" };
}

function needsReconnect(connector: Connector): boolean {
  return connector.approvalStatus === "approved" && ["reauth_required", "revoked", "error"].includes(connector.connectionStatus);
}

function ConnectorIcon({ connector }: { connector: Connector }) {
  return <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--berry-surface-under)] text-muted-foreground"><ConnectorMark connectorKey={connector.key} className="size-4 object-contain" /></span>;
}

function humanTool(value: string): string { return value.replace(/^google_/, "").replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase()); }
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
