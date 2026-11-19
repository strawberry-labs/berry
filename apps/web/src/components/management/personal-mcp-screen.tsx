import { actionErrorMessage } from "@/lib/action-error";
import * as React from "react";
import { useRefreshModelCatalog } from "@/lib/model-catalog";
import { McpApprovalsLink } from "./admin-mcp-approvals-screen";
import { EllipsisVertical, FlaskConical, LoaderCircle, Plus, PlugZap, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@berry/desktop-ui/components/ui/dropdown-menu";
import type { Connector, PersonalMcpServer } from "@berry/shared";
import {
  AsyncState,
  Button,
  CellStack,
  DataTable,
  DefinitionList,
  DetailDrawer,
  EmptyPanel,
  FormSelect,
  InlineNotice,
  Input,
  ManagementDialog,
  ManagementPage,
  ManagementSwitch,
  Section,
  StatusPill,
  SuccessMessage,
  formatDateTime,
  formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

export function PersonalMcpScreen({ client, config, permissions }: ManagementScreenProps) {
  const refreshCatalog = useRefreshModelCatalog();
  const [creating, setCreating] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState("");
  const [draftTransport, setDraftTransport] = React.useState<PersonalMcpServer["transport"]>("streamable-http");
  const [draftAuth, setDraftAuth] = React.useState<PersonalMcpServer["auth"]>("none");
  const [draftCredential, setDraftCredential] = React.useState("");
  const [selected, setSelected] = React.useState<PersonalMcpServer | null>(
    null,
  );
  const [message, setMessage] = React.useState("");
  const [connectionError, setConnectionError] = React.useState("");
  const [busyServerId, setBusyServerId] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<PersonalMcpServer | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState("");
  const deleteInFlight = React.useRef(false);
  const canApprove = permissions.includes("mcp:write");
  const resource = useResource(
    "personal-mcp",
    async () =>
      client
        ? client.listPersonalMcpServers()
        : config.mcpServers.map((server) => ({
            id: server.id,
            tenantId: "demo",
            userId: "demo",
            name: server.name,
            url: server.url,
            transport: "streamable-http" as const,
            auth: server.auth,
            credentialRef: null,
            credentialConfigured: false,
            enabled: server.enabled,
            trusted: true,
            health: "healthy" as const,
            toolCount: 0,
            lastCheckedAt: null,
            diagnostics: [],
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          })),
    [] as PersonalMcpServer[],
  );
  const connectorResource = useResource(
    "personal-mcp-connectors",
    async () => {
      if (!client) return [];
      const [available, requested] = await Promise.all([
        client.listConnectors(),
        client.listConnectorRequests(),
      ]);
      return [...new Map([...requested, ...available].map((connector) => [connector.id, connector])).values()]
        .filter((connector) => connector.kind === "custom_mcp");
    },
    [] as Connector[],
  );
  const rows = resource.data;
  const openCreate = () => {
    setDraftAuth("none");
    setDraftTransport("streamable-http");
    setDraftCredential("");
    setSaveError("");
    setCreating(true);
  };
  const closeCreate = () => {
    if (saving) return;
    setCreating(false);
    setDraftAuth("none");
    setDraftTransport("streamable-http");
    setDraftCredential("");
    setSaveError("");
  };

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("connector_error");
    if (error) setConnectionError(error);
    if (params.get("connected") === "true") setMessage("MCP server connected and ready to use.");
    if (error || params.has("connected")) {
      params.delete("connector_error");
      params.delete("connected");
      params.delete("connector");
      window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
      connectorResource.retry();
      resource.retry();
    }
  }, []);

  const hasPendingApproval = connectorResource.data.some((connector) => connector.approvalStatus === "pending");
  React.useEffect(() => {
    if (!hasPendingApproval) return;
    const timer = window.setInterval(connectorResource.retry, 15_000);
    return () => window.clearInterval(timer);
  }, [hasPendingApproval]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || saving) return;
    setMessage("");
    setConnectionError("");
    setSaveError("");
    const form = new FormData(event.currentTarget);
    const credential = personalMcpManualCredential(draftAuth, draftCredential);
    setSaving(true);
    let server: PersonalMcpServer;
    try {
      server = await client.savePersonalMcpServer({
        name: String(form.get("name")),
        url: String(form.get("url")),
        transport: String(form.get("transport")) as
          "http-sse" | "streamable-http",
        auth: draftAuth,
        ...(credential ? { credential } : {}),
        enabled: true,
        trusted: false,
      });
    } catch (cause) {
      setSaveError(errorMessage(cause));
      setSaving(false);
      return;
    }
    setSaving(false);
    setCreating(false);
    setDraftAuth("none");
    setDraftTransport("streamable-http");
    setDraftCredential("");
    if (server.auth === "oauth" && server.transport === "streamable-http") {
      try {
        const connector = await client.requestMcpConnector(server.url);
        setMessage(connector.approvalStatus === "approved"
          ? "Server approved. Choose Connect to sign in with your account."
          : "Server sent for organization approval. You can connect once an administrator approves it.");
        connectorResource.retry();
      } catch (cause) {
        setConnectionError(`Server was saved, but approval could not be requested: ${errorMessage(cause)}`);
      }
    } else {
      setMessage("Server saved. Test the connection, then open the server and turn on Use in tasks.");
    }
    resource.retry();
    refreshCatalog();
  }

  async function test(server: PersonalMcpServer) {
    if (!client) return;
    setBusyServerId(server.id);
    setConnectionError("");
    try {
      const next = await client.testPersonalMcpServer(server.id);
      setSelected(next);
      resource.retry();
    } catch (cause) {
      setConnectionError(errorMessage(cause));
    } finally {
      setBusyServerId(null);
    }
  }

  async function connect(server: PersonalMcpServer) {
    if (!client) return;
    setBusyServerId(server.id);
    setMessage("");
    setConnectionError("");
    try {
      let connector = connectorForServer(connectorResource.data, server);
      if (!connector || connector.approvalStatus !== "approved") {
        connector = await client.requestMcpConnector(server.url);
        connectorResource.retry();
      }
      if (connector.approvalStatus !== "approved") {
        setMessage("Server sent for organization approval. You can connect once an administrator approves it.");
        return;
      }
      const flow = await client.startConnectorOAuth(connector.id, "full", "/settings/mcp");
      window.location.assign(flow.authorizationUrl);
    } catch (cause) {
      setConnectionError(errorMessage(cause));
    } finally {
      setBusyServerId(null);
    }
  }

  async function deleteServer() {
    if (!client || !pendingDelete || deleteInFlight.current) return;
    const server = pendingDelete;
    deleteInFlight.current = true;
    setDeleting(true);
    setDeleteError("");
    try {
      const result = await client.deletePersonalMcpServer(server.id);
      if (!result.ok) throw new Error("The server could not be deleted. Please try again.");
      resource.setData((servers) => servers.filter((item) => item.id !== server.id));
      setSelected((current) => current?.id === server.id ? null : current);
      setPendingDelete(null);
      setConnectionError("");
      setMessage(`Removed ${server.name} from your MCP servers.`);
      resource.invalidate();
      refreshCatalog();
    } catch (cause) {
      setDeleteError(errorMessage(cause));
    } finally {
      deleteInFlight.current = false;
      setDeleting(false);
    }
  }

  const selectedConnector = selected ? connectorForServer(connectorResource.data, selected) : null;
  const selectedStatus = selected ? personalMcpStatus(selected, selectedConnector) : null;
  const selectedAction = selected ? personalMcpConnectionAction(selected, selectedConnector, canApprove) : null;
  const oauthNeedsStreamable = draftAuth === "oauth" && draftTransport !== "streamable-http";

  const actionButton = (server: PersonalMcpServer, action: PersonalMcpConnectionAction) => {
    // A pending or unsupported server has nothing to press; its status says why.
    if (action.kind === "pending" || action.kind === "unsupported") return null;
    const busy = busyServerId === server.id;
    return (
      <Button
        variant="secondary"
        disabled={!client || action.disabled || busy || deleting}
        onClick={() => action.kind === "test" ? void test(server) : void connect(server)}
      >
        {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : action.kind === "test" ? <FlaskConical /> : <PlugZap />}
        {busy ? action.kind === "test" ? "Testing…" : "Connecting…" : action.label}
      </Button>
    );
  };

  return (
    <ManagementPage
      title="MCP servers"
      description="Servers you add for your own tasks. A server that signs in with OAuth needs organization approval before you can connect."
      actions={<>
        <McpApprovalsLink permissions={permissions} />
        <Button disabled={!client} onClick={openCreate}>
          <Plus />
          Add server
        </Button>
      </>}
    >
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      {connectionError ? <InlineNotice tone="danger">{connectionError}</InlineNotice> : null}
      <ManagementDialog
        open={creating}
        onOpenChange={(open) => { if (open) setCreating(true); else closeCreate(); }}
        title="Add an MCP server"
        description="The server is saved to your account only. Access tokens are stored securely and never shown again."
        footer={
          <>
            <Button type="button" variant="secondary" disabled={saving} onClick={closeCreate}>
              Cancel
            </Button>
            <Button type="submit" form="create-personal-mcp-form" disabled={saving || oauthNeedsStreamable}>
              {saving ? "Saving…" : draftAuth === "oauth" ? canApprove ? "Save and approve" : "Save and request approval" : "Save server"}
            </Button>
          </>
        }
      >
        <form
          id="create-personal-mcp-form"
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => void save(event)}
        >
          <label className="grid gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
            Name
            <Input name="name" autoFocus required maxLength={100} placeholder="Docs search" />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
            Server URL
            <Input name="url" type="url" required placeholder="https://mcp.example.com/mcp" />
          </label>
          <label className="grid content-start gap-1.5 text-xs font-medium text-foreground">
            Transport
            <FormSelect
              name="transport"
              ariaLabel="Transport"
              value={draftTransport}
              onChange={(value) => setDraftTransport(value as PersonalMcpServer["transport"])}
              options={[
                { value: "streamable-http", label: "Streamable HTTP" },
                { value: "http-sse", label: "HTTP + SSE" },
              ]}
            />
            <span className="font-normal leading-5 text-muted-foreground">Most servers use Streamable HTTP.</span>
          </label>
          <label className="grid content-start gap-1.5 text-xs font-medium text-foreground">
            Authentication
            <FormSelect
              name="auth"
              ariaLabel="Authentication"
              value={draftAuth}
              onChange={(value) => {
                const auth = value as PersonalMcpServer["auth"];
                setDraftAuth(auth);
                if (!personalMcpNeedsManualCredential(auth)) setDraftCredential("");
              }}
              options={[
                { value: "none", label: "None" },
                { value: "bearer", label: "Bearer token" },
                { value: "oauth", label: "OAuth" },
              ]}
            />
            <span className="font-normal leading-5 text-muted-foreground">
              {draftAuth === "oauth"
                ? canApprove ? "You sign in after saving. As an administrator you approve the server straight away." : "An administrator approves the server first, then you sign in."
                : draftAuth === "bearer" ? "Berry sends this token with every request to the server." : "For servers that need no sign-in."}
            </span>
          </label>
          {personalMcpNeedsManualCredential(draftAuth) ? (
            <label className="grid gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
              Bearer token
              <Input
                name="credential"
                type="password"
                autoComplete="off"
                value={draftCredential}
                onChange={(event) => setDraftCredential(event.currentTarget.value)}
              />
            </label>
          ) : null}
          {oauthNeedsStreamable ? <div className="sm:col-span-2"><InlineNotice tone="warning">OAuth sign-in only works with the Streamable HTTP transport.</InlineNotice></div> : null}
          {saveError ? <div className="sm:col-span-2"><InlineNotice tone="danger">{saveError}</InlineNotice></div> : null}
        </form>
      </ManagementDialog>
      <AsyncState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.retry}
      >
        {rows.length === 0 ? (
          <EmptyPanel
            icon={PlugZap}
            title="No MCP servers yet"
            description="Add a server by its URL to give Berry extra tools in your own tasks. Servers shared by your organization are under Connectors."
            action={<Button variant="secondary" disabled={!client} onClick={openCreate}><Plus />Add server</Button>}
          />
        ) : (
        <Section flush>
        <DataTable
          label="MCP servers"
          columns={["Server", "Authentication", "Status", "Actions"]}
          onRowSelect={(index) => setSelected(rows[index] ?? null)}
          rowLabel={(index) => `Opened ${rows[index]?.name ?? "server"}`}
          rows={rows.map((server) => {
            const connector = connectorForServer(connectorResource.data, server);
            const action = personalMcpConnectionAction(server, connector, canApprove);
            const status = personalMcpStatus(server, connector);
            const busy = busyServerId === server.id;
            return [
            <span className="block max-w-[30rem]"><CellStack primary={server.name} secondary={server.url} /></span>,
            AUTH_LABELS[server.auth],
            <span className="inline-flex flex-wrap items-center gap-2" data-sort={status.rank}>
              <StatusPill tone={status.tone}>{status.label}</StatusPill>
              {status.note ? <span className="text-xs text-muted-foreground">{status.note}</span> : null}
            </span>,
            <div className="flex items-center justify-end gap-1.5" onClick={(event) => event.stopPropagation()}>
              {actionButton(server, action)}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`More options for ${server.name}`} disabled={!client || busy || deleting}><EllipsisVertical /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem variant="destructive" onSelect={() => { setDeleteError(""); setPendingDelete(server); }}><Trash2 />Delete server…</DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>,
            ];
          })}
        />
        </Section>
        )}
      </AsyncState>
      <ManagementDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => { if (!open && !deleteInFlight.current) { setPendingDelete(null); setDeleteError(""); } }}
        title={`Delete ${pendingDelete?.name ?? "MCP server"}?`}
        description="The server and any token saved for it are removed from your account. You can add it again later."
        size="sm"
        footer={<>
          <Button variant="secondary" disabled={deleting} onClick={() => { setPendingDelete(null); setDeleteError(""); }}>Cancel</Button>
          <Button variant="destructive" aria-label="Confirm delete MCP server" disabled={!client || deleting} onClick={() => void deleteServer()}>{deleting ? "Deleting…" : "Delete server"}</Button>
        </>}
      >
        <div className="grid gap-3">
          <p className="break-all font-mono text-xs text-muted-foreground">{pendingDelete?.url}</p>
          {deleteError ? <InlineNotice tone="danger">{deleteError}</InlineNotice> : null}
        </div>
      </ManagementDialog>
      {selected && selectedStatus && selectedAction ? (
        <DetailDrawer
          title={selected.name}
          subtitle={<span className="break-all font-mono">{selected.url}</span>}
          badge={<StatusPill tone={selectedStatus.tone}>{selectedStatus.label}</StatusPill>}
          onClose={() => setSelected(null)}
          footer={<>
            <Button variant="secondary" disabled={!client || deleting} onClick={() => { setDeleteError(""); setPendingDelete(selected); }}><Trash2 />Delete server</Button>
            {actionButton(selected, selectedAction)}
          </>}
        >
          {selectedStatus.explanation ? <InlineNotice tone={selectedStatus.tone === "danger" ? "danger" : selectedStatus.tone === "warning" ? "warning" : "info"}>{selectedStatus.explanation}</InlineNotice> : null}
          <DefinitionList items={[
            { term: "Transport", detail: selected.transport === "streamable-http" ? "Streamable HTTP" : "HTTP + SSE" },
            { term: "Authentication", detail: selected.auth === "oauth" ? "OAuth" : selected.auth === "bearer" ? selected.credentialConfigured ? "Bearer token saved" : "Bearer token missing" : "None" },
            ...(selected.auth === "oauth"
              ? [
                  { term: "Organization approval", detail: selectedStatus.approval ?? "—" },
                  { term: "Your sign-in", detail: selectedConnector?.connectionStatus === "connected" ? "Connected" : "Not connected" },
                ]
              : [
                  { term: "Tools found", detail: selected.lastCheckedAt ? formatNumber(selected.toolCount) : "—" },
                  { term: "Last tested", detail: selected.lastCheckedAt ? formatDateTime(selected.lastCheckedAt) : "Never" },
                ]),
          ]} />
          {selected.auth !== "oauth" && selected.diagnostics.length ? (
            <InlineNotice tone="warning" title="Last test">{selected.diagnostics.join(" · ")}</InlineNotice>
          ) : null}
        </DetailDrawer>
      ) : null}
    </ManagementPage>
  );
}

const AUTH_LABELS: Record<PersonalMcpServer["auth"], string> = { none: "None", bearer: "Bearer token", oauth: "OAuth" };

export function personalMcpNeedsManualCredential(auth: PersonalMcpServer["auth"]): boolean {
  return auth === "bearer";
}

export function personalMcpManualCredential(auth: PersonalMcpServer["auth"], value: string): string | undefined {
  if (!personalMcpNeedsManualCredential(auth)) return undefined;
  return value.trim() || undefined;
}

export type PersonalMcpConnectionAction = {
  kind: "test" | "connect" | "request" | "pending" | "reconnect" | "unsupported";
  label: string;
  disabled: boolean;
};

export function personalMcpConnectionAction(
  server: Pick<PersonalMcpServer, "auth" | "transport">,
  connector: Pick<Connector, "approvalStatus" | "connectionStatus"> | null,
  canApprove: boolean,
): PersonalMcpConnectionAction {
  if (server.auth !== "oauth") return { kind: "test", label: "Test", disabled: false };
  if (server.transport !== "streamable-http") return { kind: "unsupported", label: "OAuth unavailable", disabled: true };
  if (connector?.approvalStatus === "pending") return { kind: "pending", label: "Awaiting approval", disabled: true };
  if (connector?.approvalStatus === "approved") {
    return connector.connectionStatus === "connected"
      ? { kind: "reconnect", label: "Reconnect", disabled: false }
      : { kind: "connect", label: "Connect", disabled: false };
  }
  return canApprove
    ? { kind: "connect", label: "Connect", disabled: false }
    : { kind: "request", label: "Request approval", disabled: false };
}

function connectorForServer(connectors: readonly Connector[], server: Pick<PersonalMcpServer, "url">): Connector | null {
  const url = comparableUrl(server.url);
  return connectors.find((connector) => connector.url && comparableUrl(connector.url) === url) ?? null;
}

type PersonalMcpStatus = {
  label: string;
  tone: "good" | "warning" | "danger" | "neutral";
  /** Short qualifier shown beside the pill in the list. */
  note?: string;
  /** One sentence on what to do next, shown in the drawer. */
  explanation?: string;
  approval?: string;
  /** Sort key: what needs attention first. */
  rank: number;
};

/** One status per server, covering approval, sign-in and health. */
function personalMcpStatus(server: Pick<PersonalMcpServer, "auth" | "transport" | "health" | "trusted">, connector: Connector | null): PersonalMcpStatus {
  if (server.auth === "oauth") {
    if (server.transport !== "streamable-http") return { label: "OAuth unavailable", tone: "danger", approval: "Not requested", rank: 0, explanation: "OAuth sign-in only works with the Streamable HTTP transport. Delete this server and add it again with that transport." };
    if (connector?.approvalStatus === "pending") return { label: "Awaiting approval", tone: "warning", approval: "Awaiting approval", rank: 1, explanation: "An organization administrator has to approve this server before you can connect." };
    if (connector?.approvalStatus === "rejected") return { label: "Not approved", tone: "danger", approval: "Not approved", rank: 0, explanation: "An administrator declined this server, so it can’t be connected." };
    if (connector?.approvalStatus === "approved" && connector.connectionStatus === "connected") return { label: "Connected", tone: "good", approval: "Approved", rank: 4 };
    if (connector?.approvalStatus === "approved") return { label: "Not connected", tone: "warning", approval: "Approved", rank: 2, explanation: "This server is approved. Connect to sign in with your account." };
    return { label: "Approval not requested", tone: "neutral", approval: "Not requested", rank: 2, explanation: "This server needs organization approval before you can sign in." };
  }
  const unused = server.trusted ? {} : { note: "Needs review" };
  if (server.health === "healthy") return { label: "Healthy", tone: "good", rank: server.trusted ? 4 : 3, ...unused, ...(server.trusted ? {} : { explanation: "The connection works. Berry starts using this server in tasks once it has been reviewed." }) };
  if (server.health === "unknown") return { label: "Not tested", tone: "neutral", rank: 2, ...unused, explanation: "Test the connection to check that Berry can reach this server." };
  if (server.health === "unauthorized") return { label: "Sign-in rejected", tone: "danger", rank: 0, ...unused, explanation: "The server refused the saved credentials. Delete it and add it again with a valid token." };
  if (server.health === "unreachable") return { label: "Unreachable", tone: "danger", rank: 0, ...unused, explanation: "Berry could not reach this server. Check the URL and that the server is running, then test again." };
  return { label: "Invalid response", tone: "warning", rank: 1, ...unused, explanation: "The server answered, but not as an MCP server. Check the URL and transport." };
}

function comparableUrl(value: string): string {
  try { return new URL(value).toString(); } catch { return value; }
}

function errorMessage(cause: unknown): string {
  return actionErrorMessage(cause, "Could not complete the MCP request. Please try again. If it continues, contact your administrator.");
}
