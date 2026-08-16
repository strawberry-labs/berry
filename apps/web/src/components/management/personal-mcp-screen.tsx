import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronDown,
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
export function PersonalMcpScreen({ client, config }: ManagementScreenProps) {
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<PersonalMcpServer | null>(
    null,
  );
  const [message, setMessage] = React.useState("");
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
  const rows = resource.data.filter((server) =>
    `${server.name} ${server.url}`.toLowerCase().includes(query.toLowerCase()),
  );

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    const credential = String(form.get("credential"));
    await client.savePersonalMcpServer({
      name: String(form.get("name")),
      url: String(form.get("url")),
      transport: String(form.get("transport")) as
        "http-sse" | "streamable-http",
      auth: String(form.get("auth")) as "none" | "bearer" | "oauth",
      ...(credential ? { credential } : {}),
      enabled: true,
      trusted: false,
    });
    setCreating(false);
    setMessage("Server saved. Test its connection before trusting it.");
    resource.retry();
  }

  async function test(server: PersonalMcpServer) {
    if (!client) return;
    const next = await client.testPersonalMcpServer(server.id);
    setSelected(next);
    resource.retry();
  }

  return (
    <ManagementPage
      title="MCP servers"
      description="Inspect tools, authentication state, trust, and connection health."
      eyebrow="Tools & connections"
      actions={
        <Button disabled={!client} onClick={() => setCreating(true)}>
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
      <ManagementDialog
        open={creating}
        onOpenChange={setCreating}
        title="Review server connection"
        description="Credentials are stored by reference and are never returned to the browser."
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
            <Button type="submit" form="create-personal-mcp-form">
              Save for testing
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
              defaultValue="none"
              options={[
                { value: "none", label: "None" },
                { value: "bearer", label: "Bearer token" },
                { value: "oauth", label: "OAuth" },
              ]}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Credential
            <Input name="credential" type="password" autoComplete="off" />
          </label>
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
          rows={rows.map((server) => [
            <Button
              variant="ghost"
              className="grid h-auto max-w-80 justify-start gap-0.5 p-0 text-left [&_b]:truncate [&_small]:truncate [&_small]:text-xs [&_small]:text-muted-foreground"
              onClick={() => setSelected(server)}
            >
              <b>{server.name}</b>
              <small>{server.url}</small>
            </Button>,
            server.transport,
            server.credentialConfigured
              ? `${server.auth} configured`
              : server.auth,
            server.trusted ? "Reviewed" : "Needs review",
            <StatusPill
              tone={
                server.health === "healthy"
                  ? "good"
                  : server.health === "unreachable"
                    ? "danger"
                    : "warning"
              }
            >
              {server.health}
            </StatusPill>,
            <Button
              variant="secondary"
              disabled={!client}
              onClick={() => test(server)}
            >
              <FlaskConical />
              Test
            </Button>,
          ])}
        />
      </AsyncState>
      {selected ? (
        <Detail title={selected.name} onClose={() => setSelected(null)}>
          <dl>
            <div>
              <dt>Tools</dt>
              <dd>{selected.toolCount}</dd>
            </div>
            <div>
              <dt>Authentication</dt>
              <dd>
                {selected.credentialConfigured
                  ? "Configured"
                  : "Not configured"}
              </dd>
            </div>
            <div>
              <dt>Last tested</dt>
              <dd>
                {selected.lastCheckedAt
                  ? new Date(selected.lastCheckedAt).toLocaleString()
                  : "Never"}
              </dd>
            </div>
          </dl>
          {selected.diagnostics.length ? (
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {selected.diagnostics.join(" · ")}
            </div>
          ) : null}
        </Detail>
      ) : null}
    </ManagementPage>
  );
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
