import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Clock3,
  Code2,
  Download,
  EllipsisVertical,
  Eye,
  File,
  FileCode2,
  FileImage,
  FlaskConical,
  Folder,
  Info,
  LoaderCircle,
  MessageCircle,
  Plus,
  PlugZap,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { BerryApiError, type BerryApiClient } from "@berry/api-client";
import { Markdown } from "@berry/desktop-ui/components/berry-markdown";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@berry/desktop-ui/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@berry/desktop-ui/components/ui/tooltip";
import type {
  Connector,
  EffectiveCapability,
  PersonalMcpServer,
  PersonalSkill,
} from "@berry/shared";
import { createBrowserSkillExport, readBrowserSkillImport } from "@/lib/skill-import";
import {
  AsyncState,
  Button,
  DataTable,
  DetailDrawer,
  FormSelect,
  Input,
  ManagementDialog,
  ManagementPage,
  ManagementSwitch,
  SearchInput,
  StatusPill,
  SuccessMessage,
  Textarea,
  Toolbar,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
export function PersonalMcpScreen({ client, config, permissions }: ManagementScreenProps) {
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [draftAuth, setDraftAuth] = React.useState<PersonalMcpServer["auth"]>("none");
  const [draftCredential, setDraftCredential] = React.useState("");
  const [selected, setSelected] = React.useState<PersonalMcpServer | null>(
    null,
  );
  const [message, setMessage] = React.useState("");
  const [connectionError, setConnectionError] = React.useState("");
  const [busyServerId, setBusyServerId] = React.useState<string | null>(null);
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
  const rows = resource.data.filter((server) =>
    `${server.name} ${server.url}`.toLowerCase().includes(query.toLowerCase()),
  );

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
    if (!client) return;
    setMessage("");
    setConnectionError("");
    const form = new FormData(event.currentTarget);
    const credential = personalMcpManualCredential(draftAuth, draftCredential);
    const server = await client.savePersonalMcpServer({
      name: String(form.get("name")),
      url: String(form.get("url")),
      transport: String(form.get("transport")) as
        "http-sse" | "streamable-http",
      auth: draftAuth,
      ...(credential ? { credential } : {}),
      enabled: true,
      trusted: false,
    });
    setCreating(false);
    setDraftAuth("none");
    setDraftCredential("");
    if (server.auth === "oauth" && server.transport === "streamable-http") {
      try {
        const connector = await client.requestMcpConnector(server.url);
        setMessage(connector.approvalStatus === "approved"
          ? "Server approved. Click Connect to authorize your account."
          : "Server submitted for organization approval. Connect will unlock after approval.");
        connectorResource.retry();
      } catch (cause) {
        setConnectionError(`Server was saved, but approval could not be submitted: ${errorMessage(cause)}`);
      }
    } else {
      setMessage("Server saved. Test its connection before trusting it.");
    }
    resource.retry();
  }

  async function test(server: PersonalMcpServer) {
    if (!client) return;
    const next = await client.testPersonalMcpServer(server.id);
    setSelected(next);
    resource.retry();
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
        setMessage("Server submitted for organization approval. Connect will unlock after approval.");
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

  return (
    <ManagementPage
      title="MCP servers"
      description="Connect approved Streamable HTTP MCP servers and inspect their authorization state."
      eyebrow="Tools & connections"
      actions={
        <Button disabled={!client} onClick={() => {
          setDraftAuth("none");
          setDraftCredential("");
          setCreating(true);
        }}>
          <Plus />
          Add server
        </Button>
      }
    >
      <Toolbar>
        <SearchInput
          label="Search MCP servers"
          value={query}
          onChange={setQuery}
          placeholder="Search servers"
        />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      {connectionError ? <p className="rounded-lg border border-[var(--berry-danger)]/25 bg-[var(--berry-danger)]/5 px-3 py-2 text-xs text-[var(--berry-danger)]" role="alert">{connectionError}</p> : null}
      <ManagementDialog
        open={creating}
        onOpenChange={(open) => {
          setCreating(open);
          if (!open) {
            setDraftAuth("none");
            setDraftCredential("");
          }
        }}
        title="Review server connection"
        description="Credentials are stored by reference and are never returned to the browser."
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setCreating(false);
                setDraftAuth("none");
                setDraftCredential("");
              }}
            >
              Cancel
            </Button>
            <Button type="submit" form="create-personal-mcp-form">
              {draftAuth === "oauth" ? canApprove ? "Save and approve" : "Submit for approval" : "Save for testing"}
            </Button>
          </>
        }
      >
        <form
          id="create-personal-mcp-form"
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={save}
        >
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Name
            <Input name="name" autoFocus required />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
            HTTPS URL
            <Input name="url" type="url" required />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Transport
            <FormSelect
              name="transport"
              defaultValue="streamable-http"
              options={[
                { value: "streamable-http", label: "Streamable HTTP" },
                { value: "http-sse", label: "HTTP + SSE" },
              ]}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Authentication
            <FormSelect
              name="auth"
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
          </label>
          {personalMcpNeedsManualCredential(draftAuth) ? (
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
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
        </form>
      </ManagementDialog>
      <AsyncState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.retry}
        empty={rows.length === 0}
      >
        <DataTable
          label="MCP servers"
          columns={[
            "Server",
            "Transport",
            "Authentication",
            "Trust",
            "Health",
            "Actions",
          ]}
          rows={rows.map((server) => {
            const connector = connectorForServer(connectorResource.data, server);
            const action = personalMcpConnectionAction(server, connector, canApprove);
            const oauth = server.auth === "oauth" ? personalMcpOAuthStatus(connector) : null;
            const busy = busyServerId === server.id;
            return [
            <Button
              variant="ghost"
              className="grid h-auto max-w-80 justify-start gap-0.5 p-0 text-left [&_b]:truncate [&_small]:truncate [&_small]:text-xs [&_small]:text-muted-foreground"
              onClick={() => setSelected(server)}
            >
              <b>{server.name}</b>
              <small>{server.url}</small>
            </Button>,
            server.transport,
            oauth
              ? `oauth ${oauth.authentication}`
              : server.credentialConfigured
              ? `${server.auth} configured`
              : server.auth,
            oauth ? oauth.approval : server.trusted ? "Reviewed" : "Needs review",
            <StatusPill
              tone={
                oauth
                  ? oauth.tone
                  : server.health === "healthy"
                  ? "good"
                  : server.health === "unreachable"
                    ? "danger"
                    : "warning"
              }
            >
              {oauth?.health ?? server.health}
            </StatusPill>,
            <Button
              variant="secondary"
              disabled={!client || action.disabled || busy}
              onClick={() => action.kind === "test" ? void test(server) : void connect(server)}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : action.kind === "test" ? <FlaskConical /> : action.kind === "pending" ? <Clock3 /> : <PlugZap />}
              {busy ? "Connecting…" : action.label}
            </Button>,
            ];
          })}
        />
      </AsyncState>
      {selected ? (() => {
        const connector = connectorForServer(connectorResource.data, selected);
        const oauth = selected.auth === "oauth" ? personalMcpOAuthStatus(connector) : null;
        return (
        <Detail title={selected.name} onClose={() => setSelected(null)}>
          <dl>
            <div>
              <dt>Tools</dt>
              <dd>{selected.toolCount}</dd>
            </div>
            <div>
              <dt>Authentication</dt>
              <dd>
                {(oauth ? oauth.authentication === "connected" : selected.credentialConfigured)
                  ? "Configured"
                  : "Not configured"}
              </dd>
            </div>
            {oauth ? <div><dt>Organization approval</dt><dd>{oauth.approval}</dd></div> : null}
            <div>
              <dt>{oauth ? "Connection" : "Last tested"}</dt>
              <dd>{oauth
                ? oauth.health
                : selected.lastCheckedAt
                  ? new Date(selected.lastCheckedAt).toLocaleString()
                  : "Never"}</dd>
            </div>
          </dl>
          {selected.auth !== "oauth" && selected.diagnostics.length ? (
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {selected.diagnostics.join(" · ")}
            </div>
          ) : null}
        </Detail>
        );
      })() : null}
    </ManagementPage>
  );
}

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

function personalMcpOAuthStatus(connector: Connector | null): { authentication: string; approval: string; health: string; tone: "good" | "warning" | "danger" | "neutral" } {
  if (connector?.approvalStatus === "pending") return { authentication: "pending", approval: "Awaiting approval", health: "approval pending", tone: "warning" };
  if (connector?.approvalStatus === "rejected") return { authentication: "not connected", approval: "Not approved", health: "not connected", tone: "danger" };
  if (connector?.approvalStatus === "approved" && connector.connectionStatus === "connected") return { authentication: "connected", approval: "Approved", health: "connected", tone: "good" };
  if (connector?.approvalStatus === "approved") return { authentication: "not connected", approval: "Approved", health: "not connected", tone: "warning" };
  return { authentication: "not connected", approval: "Not submitted", health: "not connected", tone: "neutral" };
}

function comparableUrl(value: string): string {
  try { return new URL(value).toString(); } catch { return value; }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "MCP connection failed";
}

function Detail({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <DetailDrawer title={title} onClose={onClose}>
      {children}
    </DetailDrawer>
  );
}
