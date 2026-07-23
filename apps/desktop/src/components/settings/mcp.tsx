import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileDown, Plug, Plus, RefreshCw, Search } from "@berry/desktop-ui/lib/icons";
import type { McpImportCandidate, McpServerConfig } from "@berry/shared";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { Checkbox } from "@berry/desktop-ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@berry/desktop-ui/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@berry/desktop-ui/components/ui/empty";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@berry/desktop-ui/components/ui/input-group";
import { Label } from "@berry/desktop-ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@berry/desktop-ui/components/ui/select";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { Switch } from "@berry/desktop-ui/components/ui/switch";
import { host } from "@/lib/berry";
import { openMcpAuthorization, subscribeMcpCallbacks } from "@/lib/mcp-auth";
import { SettingCard, SettingsPageHeader } from "./shared";

const MCP_KEY = ["mcp-servers"] as const;

type Transport = "stdio" | "http-sse" | "streamable-http";
type AuthType = "none" | "bearer-api-key" | "oauth-authorization-code" | "oauth-device";

function AddServerDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [commandLine, setCommandLine] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [deviceAuthorizationUrl, setDeviceAuthorizationUrl] = useState("");
  const [scopes, setScopes] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const tokens = commandLine.trim().split(/\s+/).filter(Boolean);
      const credentialRef = authType === "none" ? null : `mcp-${authType === "bearer-api-key" ? "bearer" : "oauth"}-${crypto.randomUUID()}`;
      if (authType === "bearer-api-key") {
        await host.call("credential.set", { reference: credentialRef!, secret: apiKey.trim() });
      }
      return host.call("mcp.server.save", {
        name: name.trim(),
        transport,
        command: transport === "stdio" ? (tokens[0] ?? "") : null,
        args: transport === "stdio" ? tokens.slice(1) : [],
        url: transport === "http-sse" ? url.trim() : null,
        ...(transport === "streamable-http" ? { url: url.trim() } : {}),
        authType,
        credentialRef,
        oauth: authType === "none" || authType === "bearer-api-key" ? null : {
          clientId: clientId.trim(),
          authorizationUrl: authType === "oauth-authorization-code" ? authorizationUrl.trim() : null,
          tokenUrl: tokenUrl.trim(),
          deviceAuthorizationUrl: authType === "oauth-device" ? deviceAuthorizationUrl.trim() : null,
          scopes: scopes.split(/\s+/).filter(Boolean),
        },
        trusted: false,
        enabled: true,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCP_KEY });
      toast.success(`Added ${name.trim()}`);
      setOpen(false);
      setName("");
      setCommandLine("");
      setUrl("");
      setTransport("stdio");
      setAuthType("none");
      setApiKey("");
      setClientId("");
      setAuthorizationUrl("");
      setTokenUrl("");
      setDeviceAuthorizationUrl("");
      setScopes("");
    },
    onError: () => toast.error("Could not save MCP server"),
  });

  const valid =
    name.trim().length > 0 &&
    (transport === "stdio" ? commandLine.trim().length > 0 : url.trim().length > 0) &&
    (authType === "none" || authType === "bearer-api-key" ? apiKey.trim().length > 0 : (clientId.trim().length > 0 && tokenUrl.trim().length > 0 &&
      (authType === "oauth-authorization-code" ? authorizationUrl.trim().length > 0 : deviceAuthorizationUrl.trim().length > 0)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          Add server
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add MCP server</DialogTitle>
            <DialogDescription>
              Register a Model Context Protocol server for the Berry agent to use.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input id="mcp-name" placeholder="e.g. filesystem" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-transport">Transport</Label>
            <Select value={transport} onValueChange={(value) => setTransport(value as Transport)}>
              <SelectTrigger id="mcp-transport" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio</SelectItem>
                <SelectItem value="http-sse">http-sse</SelectItem>
                <SelectItem value="streamable-http">streamable-http</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {transport === "stdio" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="mcp-command">Command</Label>
              <Input
                id="mcp-command"
                className="font-mono text-xs"
                placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Projects"
                value={commandLine}
                onChange={(e) => setCommandLine(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The first token is the executable; the rest are passed as arguments.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="mcp-url">URL</Label>
              <Input
                id="mcp-url"
                className="font-mono text-xs"
                placeholder="https://example.com/mcp/sse"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          )}
          {transport !== "stdio" ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-auth">Authentication</Label>
                <Select value={authType} onValueChange={(value) => setAuthType(value as AuthType)}>
                  <SelectTrigger id="mcp-auth" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="bearer-api-key">Bearer API key</SelectItem>
                    <SelectItem value="oauth-authorization-code">OAuth authorization code</SelectItem>
                    <SelectItem value="oauth-device">OAuth device flow</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {authType === "bearer-api-key" ? (
                <div className="grid gap-3 rounded-md border p-3">
                  <Label htmlFor="mcp-api-key">API key</Label>
                  <Input id="mcp-api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
                  <p className="text-xs text-muted-foreground">Sent as an Authorization: Bearer header and stored encrypted on this device.</p>
                </div>
              ) : authType !== "none" ? (
                <div className="grid gap-3 rounded-md border p-3">
                  <Label htmlFor="mcp-client-id">OAuth client ID</Label>
                  <Input id="mcp-client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} />
                  {authType === "oauth-authorization-code" ? (
                    <><Label htmlFor="mcp-authorization-url">Authorization URL</Label><Input id="mcp-authorization-url" value={authorizationUrl} onChange={(event) => setAuthorizationUrl(event.target.value)} placeholder="https://auth.example.com/authorize" /></>
                  ) : (
                    <><Label htmlFor="mcp-device-url">Device authorization URL</Label><Input id="mcp-device-url" value={deviceAuthorizationUrl} onChange={(event) => setDeviceAuthorizationUrl(event.target.value)} placeholder="https://auth.example.com/device" /></>
                  )}
                  <Label htmlFor="mcp-token-url">Token URL</Label>
                  <Input id="mcp-token-url" value={tokenUrl} onChange={(event) => setTokenUrl(event.target.value)} placeholder="https://auth.example.com/token" />
                  <Label htmlFor="mcp-scopes">Scopes</Label>
                  <Input id="mcp-scopes" value={scopes} onChange={(event) => setScopes(event.target.value)} placeholder="openid profile" />
                </div>
              ) : null}
            </>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending ? "Saving..." : "Add server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportServersDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<McpImportCandidate[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const scan = useMutation({
    mutationFn: () => host.call<McpImportCandidate[]>("mcp.import.scan", {}),
    onSuccess: (items) => {
      setCandidates(items);
      setSelected(new Set(items.map((_, index) => index)));
    },
    onError: () => toast.error("Could not scan MCP configuration files"),
  });
  const apply = useMutation({
    mutationFn: () => host.call("mcp.import.apply", { servers: candidates.filter((_, index) => selected.has(index)) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MCP_KEY });
      toast.success("Imported MCP servers as untrusted");
      setOpen(false);
    },
    onError: () => toast.error("Could not import MCP servers"),
  });
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) scan.mutate(); }}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><FileDown />Import</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import MCP servers</DialogTitle>
          <DialogDescription>Review discovered agent configurations. Imported servers stay untrusted until you confirm them.</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 divide-y overflow-y-auto rounded-md border">
          {scan.isPending ? <div className="p-4 text-sm text-muted-foreground">Scanning...</div> : null}
          {!scan.isPending && candidates.length === 0 ? <div className="p-4 text-sm text-muted-foreground">No MCP configurations found.</div> : null}
          {candidates.map((candidate, index) => (
            <label key={`${candidate.sourcePath}:${candidate.name}`} className="flex items-start gap-3 p-3">
              <Checkbox
                checked={selected.has(index)}
                onCheckedChange={(checked) => setSelected((current) => {
                  const next = new Set(current);
                  if (checked === true) next.add(index); else next.delete(index);
                  return next;
                })}
                aria-label={`Import ${candidate.name}`}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{candidate.name}</span>
                <span className="block truncate font-mono text-xs text-muted-foreground">{candidate.command ?? candidate.url}</span>
                <span className="block text-xs text-muted-foreground">{candidate.source} · {candidate.sourcePath}</span>
              </span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => apply.mutate()} disabled={selected.size === 0 || apply.isPending}>{apply.isPending ? "Importing..." : `Import ${selected.size}`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServerRow({ server }: { server: McpServerConfig }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => host.call("mcp.server.enable", { id: server.id, enabled }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: MCP_KEY });
      const previous = queryClient.getQueryData<McpServerConfig[]>(MCP_KEY);
      queryClient.setQueryData<McpServerConfig[]>(MCP_KEY, (current) =>
        (current ?? []).map((item) => (item.id === server.id ? { ...item, enabled } : item)),
      );
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) queryClient.setQueryData(MCP_KEY, context.previous);
      toast.error(`Could not update ${server.name}`);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: MCP_KEY }),
  });
  const toggleTrusted = useMutation({
    mutationFn: (trusted: boolean) => host.call("mcp.server.trust", { id: server.id, trusted }),
    onMutate: async (trusted) => {
      await queryClient.cancelQueries({ queryKey: MCP_KEY });
      const previous = queryClient.getQueryData<McpServerConfig[]>(MCP_KEY);
      queryClient.setQueryData<McpServerConfig[]>(MCP_KEY, (current) =>
        (current ?? []).map((item) => (item.id === server.id ? { ...item, trusted } : item)),
      );
      return { previous };
    },
    onError: (_error, _trusted, context) => {
      if (context?.previous) queryClient.setQueryData(MCP_KEY, context.previous);
      toast.error(`Could not update ${server.name}`);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: MCP_KEY }),
  });
  const reconnect = useMutation({
    mutationFn: () => host.call("mcp.server.reconnect", { id: server.id, ...(server.credentialRef ? { credentialRef: server.credentialRef } : {}) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: MCP_KEY }),
    onError: () => toast.error(`Could not connect to ${server.name}`),
  });
  const connectOAuth = useMutation({
    mutationFn: async () => {
      const started = await host.call("mcp.oauth.start", { id: server.id, redirectUri: "berry://mcp/oauth/callback" });
      if (started.flow === "authorization-code") {
        let unsubscribe = () => {};
        unsubscribe = await subscribeMcpCallbacks((callback) => {
          if (callback.state !== started.state) return;
          unsubscribe();
          void host.call("mcp.oauth.exchange", { id: server.id, state: callback.state, code: callback.code })
            .then((result) => host.call("credential.set", { reference: result.credentialRef, secret: result.secret }))
            .then(() => reconnect.mutate(), () => toast.error(`Could not authorize ${server.name}`));
        });
        await openMcpAuthorization(started.authorizationUrl!);
        return;
      }
      await openMcpAuthorization(started.verificationUri!);
      toast(`Enter code ${started.userCode ?? "shown by the provider"}`);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, (started.intervalSeconds ?? 5) * 1000));
        const result = await host.call("mcp.oauth.poll", { id: server.id, state: started.state });
        if (result.status === "pending") continue;
        await host.call("credential.set", { reference: result.credentialRef!, secret: result.secret! });
        reconnect.mutate();
        return;
      }
    },
    onError: () => toast.error(`Could not start authorization for ${server.name}`),
  });

  const target =
    server.transport === "stdio"
      ? [server.command, ...server.args].filter(Boolean).join(" ")
      : server.url ?? "";

  return (
    <div className="flex items-center justify-between gap-6 p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium">{server.name}</span>
          <Badge variant="secondary">{server.transport}</Badge>
          {server.source === "organization" ? <Badge variant="secondary">Organization managed</Badge> : null}
          <Badge variant="outline">{server.trusted ? "Trusted" : "Untrusted"}</Badge>
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">{target}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{server.healthStatus === "connected" ? `${server.toolCount} tools` : server.healthStatus.replace("-", " ")}</span>
          {server.latencyMs !== null ? <span>{server.latencyMs} ms</span> : null}
          {server.lastError ? <span className="truncate text-destructive" title={server.lastError}>{server.lastError}</span> : null}
        </span>
      </div>
      <div className="flex items-center gap-4">
        {server.authType === "oauth-authorization-code" || server.authType === "oauth-device" ? (
          <Button size="sm" variant="outline" onClick={() => connectOAuth.mutate()} disabled={connectOAuth.isPending}>Authorize</Button>
        ) : null}
        <Button size="icon-sm" variant="ghost" aria-label={`Reconnect ${server.name}`} title="Reconnect" onClick={() => reconnect.mutate()} disabled={reconnect.isPending || server.source === "organization"}>
          {reconnect.isPending ? <CircularActivitySpinner size={16} label={`Reconnecting ${server.name}`} /> : <RefreshCw />}
        </Button>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Trust
          <Switch
            checked={server.trusted}
            onCheckedChange={(trusted) => toggleTrusted.mutate(trusted)}
            aria-label={`Trust ${server.name}`}
            disabled={server.source === "organization"}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Enable
          <Switch
            checked={server.enabled}
            onCheckedChange={(enabled) => toggle.mutate(enabled)}
            aria-label={`Enable ${server.name}`}
            disabled={server.source === "organization"}
          />
        </label>
      </div>
    </div>
  );
}

export function McpSettings() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const servers = useQuery({
    queryKey: MCP_KEY,
    queryFn: () => host.call<McpServerConfig[]>("mcp.server.list"),
  });
  const deferral = useQuery({
    queryKey: ["mcp-tool-deferral"],
    queryFn: async () => ({
      enabled: (await host.call<boolean | null>("settings.get", { key: "mcp.toolDeferral.enabled" })) !== false,
      threshold: (await host.call<number | null>("settings.get", { key: "mcp.toolDeferral.threshold" })) ?? 40,
    }),
  });
  const saveDeferral = useMutation({
    mutationFn: async (value: { enabled?: boolean; threshold?: number }) => {
      if (value.enabled !== undefined) await host.call("settings.set", { key: "mcp.toolDeferral.enabled", value: value.enabled });
      if (value.threshold !== undefined) await host.call("settings.set", { key: "mcp.toolDeferral.threshold", value: value.threshold });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mcp-tool-deferral"] }),
    onError: () => toast.error("Could not save MCP tool deferral settings"),
  });

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) return servers.data ?? [];
    return (servers.data ?? []).filter(
      (server) =>
        server.name.toLowerCase().includes(query) ||
        (server.command ?? "").toLowerCase().includes(query) ||
        (server.url ?? "").toLowerCase().includes(query),
    );
  }, [servers.data, search]);

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="MCP Servers"
        description="Manage MCP server configurations used by the Berry agent."
        actions={<div className="flex items-center gap-2"><ImportServersDialog /><AddServerDialog /></div>}
      />

      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          placeholder="Search MCP servers..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search MCP servers"
        />
      </InputGroup>

      {servers.isPending ? (
        <SettingCard>
          {[0, 1].map((index) => (
            <div key={index} className="flex items-center justify-between gap-6 p-4">
              <div className="flex w-full flex-col gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          ))}
        </SettingCard>
      ) : filtered.length === 0 ? (
        <Empty className="border border-dashed border-border py-10 md:p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Plug />
            </EmptyMedia>
            <EmptyTitle className="text-sm">
              {(servers.data ?? []).length === 0 ? "No MCP servers" : "No servers match"}
            </EmptyTitle>
            <EmptyDescription>
              {(servers.data ?? []).length === 0
                ? "Add a server to give Berry extra tools like databases, browsers, or emulators."
                : "Try a different search."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SettingCard>
          {filtered.map((server) => (
            <ServerRow key={server.id} server={server} />
          ))}
        </SettingCard>
      )}

      <SettingCard>
        <div className="flex items-center justify-between gap-6 p-4">
          <div>
            <p className="text-sm font-medium">Defer large MCP tool catalogs</p>
            <p className="text-xs text-muted-foreground">Expose tool_search when the active model supports tools and the catalog exceeds the threshold.</p>
          </div>
          <div className="flex items-center gap-3">
            <Input
              className="w-20"
              type="number"
              min={1}
              max={500}
              defaultValue={deferral.data?.threshold ?? 40}
              aria-label="MCP tool deferral threshold"
              onBlur={(event) => saveDeferral.mutate({ threshold: Math.max(1, Math.min(500, Number(event.target.value) || 40)) })}
            />
            <Switch
              checked={deferral.data?.enabled ?? true}
              onCheckedChange={(enabled) => saveDeferral.mutate({ enabled })}
              aria-label="Defer large MCP tool catalogs"
            />
          </div>
        </div>
      </SettingCard>
    </div>
  );
}
