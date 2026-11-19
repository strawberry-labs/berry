import * as React from "react";
import { Alert, StyleSheet, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import type { Connector, PersonalMcpServer } from "@berry/shared";
import { apiErrorMessage } from "../../api/client";
import { useSignedInSession } from "../../session/session";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { ArrowUpRight01Icon, Clock, Ellipsis, Plus, Zap } from "../../ui/icons";
import { Menu } from "../../ui/menu";
import { EmptyState, Input, StatusPill } from "../../ui/primitives";
import { Section } from "../../ui/screen";
import { Sheet } from "../../ui/sheet";
import { Text } from "../../ui/text";
import { openWebSettings } from "./connectors-tab";
import {
  settingsKeys,
  useConnectorRequests,
  useConnectors,
  useEffectivePermissions,
  usePersonalMcpServers,
  usePollWhile,
  useRefreshConnections,
  useRefreshOnForeground,
} from "./settings-data";
import {
  connectorForServer,
  customMcpConnectors,
  formatDateTime,
  isHttpsUrl,
  mcpHealthTone,
  personalMcpConnectionAction,
  personalMcpOAuthStatus,
} from "./settings-model";
import { AsyncContent, Field, FilterInput, InlineMessage, ListRow, SelectField, SettingsPage, ValueRow } from "./settings-ui";

type Status = { tone: "danger" | "success"; text: string };

const TRANSPORTS: ReadonlyArray<{ value: PersonalMcpServer["transport"]; label: string }> = [
  { value: "streamable-http", label: "Streamable HTTP" },
  { value: "http-sse", label: "HTTP + SSE" },
];

const AUTH_OPTIONS: ReadonlyArray<{ value: PersonalMcpServer["auth"]; label: string }> = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer token" },
  { value: "oauth", label: "OAuth" },
];

/** Settings › MCP servers: the web's personal MCP screen. */
export function McpTab() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  const servers = usePersonalMcpServers();
  const connectors = useConnectors();
  const requests = useConnectorRequests();
  const permissions = useEffectivePermissions();
  const refresh = useRefreshConnections();
  const canApprove = Boolean(permissions.data?.permissions.includes("mcp:write"));
  const mcpConnectors = React.useMemo(() => customMcpConnectors(connectors.data ?? [], requests.data ?? []), [connectors.data, requests.data]);
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<Status | null>(null);
  usePollWhile(mcpConnectors.some((connector) => connector.approvalStatus === "pending"), refresh);
  useRefreshOnForeground(refresh);

  const all = servers.data ?? [];
  const rows = all.filter((server) => `${server.name} ${server.url}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = all.find((server) => server.id === selectedId) ?? null;
  const replace = (next: PersonalMcpServer) => queryClient.setQueryData<PersonalMcpServer[]>(settingsKeys.mcpServers(profile.serverUrl), (current) => current?.map((item) => (item.id === next.id ? next : item)));

  const runAction = async (server: PersonalMcpServer) => {
    const connector = connectorForServer(mcpConnectors, server);
    const action = personalMcpConnectionAction(server, connector, canApprove);
    if (action.disabled) return;
    setBusyId(server.id);
    setStatus(null);
    try {
      if (action.kind === "test") {
        const next = await client.testPersonalMcpServer(server.id);
        replace(next);
        setStatus({ tone: next.health === "healthy" ? "success" : "danger", text: next.health === "healthy" ? `${next.name} responded with ${next.toolCount} tools.` : `${next.name}: ${next.health.replaceAll("-", " ")}.` });
        return;
      }
      let current: Connector | null = connector;
      if (!current || current.approvalStatus !== "approved") {
        current = await client.requestMcpConnector(server.url);
        refresh();
      }
      if (current.approvalStatus !== "approved") {
        setStatus({ tone: "success", text: "Server submitted for organization approval. Connect will unlock after approval." });
        return;
      }
      // The OAuth callback needs the web's signed-in session, so authorization finishes there.
      await openWebSettings(profile.serverUrl, "/settings/mcp");
      refresh();
    } catch (cause) {
      setStatus({ tone: "danger", text: apiErrorMessage(cause, "Could not complete the MCP request. Please try again.") });
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = (server: PersonalMcpServer) => {
    Alert.alert(`Delete ${server.name}?`, "Remove this saved server and its stored credentials from your account. You can add the server again later.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete server",
        style: "destructive",
        onPress: async () => {
          setBusyId(server.id);
          setStatus(null);
          try {
            const result = await client.deletePersonalMcpServer(server.id);
            if (!result.ok) throw new Error("The server could not be deleted. Please try again.");
            queryClient.setQueryData<PersonalMcpServer[]>(settingsKeys.mcpServers(profile.serverUrl), (current) => current?.filter((item) => item.id !== server.id));
            setSelectedId((current) => (current === server.id ? null : current));
            setStatus({ tone: "success", text: `Removed ${server.name} from your MCP servers.` });
            refresh();
          } catch (cause) {
            setStatus({ tone: "danger", text: apiErrorMessage(cause, "The server could not be deleted. Please try again.") });
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  };

  return (
    <SettingsPage
      title="MCP servers"
      description="Connect approved Streamable HTTP MCP servers and inspect their authorization state."
      refreshing={servers.isRefetching}
      onRefresh={refresh}
      trailing={<Button variant="ghost" size="sm" icon={Plus} label="Add server" onPress={() => setCreating(true)} />}
    >
      <FilterInput value={query} onChangeText={setQuery} placeholder="Search servers" />
      {status ? <InlineMessage tone={status.tone} onDismiss={() => setStatus(null)}>{status.text}</InlineMessage> : null}
      <AsyncContent
        loading={servers.isPending}
        error={servers.isError ? apiErrorMessage(servers.error, "Could not load your MCP servers.") : null}
        onRetry={() => void servers.refetch()}
        rows={4}
      >
        <Section>
          {rows.length === 0 ? (
            <EmptyState
              title={query ? "No matching servers" : "No MCP servers yet"}
              message={query ? "Try a different search." : "Add a remote MCP server to give Berry more tools."}
              action={query ? undefined : <Button variant="outline" size="sm" icon={Plus} label="Add server" onPress={() => setCreating(true)} />}
            />
          ) : rows.map((server, index) => (
            <ServerRow
              key={server.id}
              server={server}
              connector={connectorForServer(mcpConnectors, server)}
              canApprove={canApprove}
              busy={busyId === server.id}
              disabled={busyId !== null}
              last={index === rows.length - 1}
              onPress={() => setSelectedId(server.id)}
              onAction={() => void runAction(server)}
              onDelete={() => confirmDelete(server)}
            />
          ))}
        </Section>
      </AsyncContent>

      <ServerSheet
        server={selected}
        connector={selected ? connectorForServer(mcpConnectors, selected) : null}
        canApprove={canApprove}
        busy={selected ? busyId === selected.id : false}
        onClose={() => setSelectedId(null)}
        onAction={(server) => void runAction(server)}
        onDelete={confirmDelete}
      />
      <CreateServerSheet open={creating} onOpenChange={setCreating} canApprove={canApprove} onStatus={setStatus} />
    </SettingsPage>
  );
}

function statusPill(server: PersonalMcpServer, connector: Connector | null): { tone: "good" | "warning" | "danger" | "neutral"; label: string } {
  if (server.auth === "oauth") {
    const oauth = personalMcpOAuthStatus(connector);
    return { tone: oauth.tone, label: oauth.health };
  }
  return { tone: mcpHealthTone(server.health), label: server.health.replaceAll("-", " ") };
}

function ServerRow({ server, connector, canApprove, busy, disabled, last, onPress, onAction, onDelete }: {
  server: PersonalMcpServer;
  connector: Connector | null;
  canApprove: boolean;
  busy: boolean;
  disabled: boolean;
  last: boolean;
  onPress: () => void;
  onAction: () => void;
  onDelete: () => void;
}) {
  const { colors } = useTheme();
  const action = personalMcpConnectionAction(server, connector, canApprove);
  const pill = statusPill(server, connector);
  const authLabel = server.auth === "oauth" ? `OAuth ${personalMcpOAuthStatus(connector).authentication}` : server.credentialConfigured ? `${server.auth} configured` : server.auth;
  return (
    <ListRow last={last} onPress={onPress} accessibilityLabel={`${server.name}, ${pill.label}`} style={styles.serverRow}>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text variant="body" weight="medium" numberOfLines={1} style={{ flexShrink: 1 }}>{server.name}</Text>
          <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
        </View>
        <Text variant="meta" tone="tertiary" numberOfLines={1}>{server.url}</Text>
        <Text variant="meta" tone="faint" numberOfLines={1}>
          {server.transport} · {authLabel} · {server.auth === "oauth" ? personalMcpOAuthStatus(connector).approval : server.trusted ? "Reviewed" : "Needs review"}
        </Text>
      </View>
      <Button
        variant="secondary"
        size="sm"
        label={busy ? (action.kind === "test" ? "Testing…" : "Connecting…") : action.label}
        {...(busy ? {} : { icon: action.kind === "pending" ? Clock : action.kind === "test" ? Zap : ArrowUpRight01Icon })}
        disabled={action.disabled || disabled}
        onPress={onAction}
      />
      <Menu title={server.name} items={[{ id: "delete", title: "Delete server", systemImage: "trash", destructive: true, disabled }]} onSelect={(id) => { if (id === "delete") onDelete(); }}>
        <View accessible accessibilityRole="button" accessibilityLabel={`More options for ${server.name}`} style={styles.more}>
          <Ellipsis size={16} color={colors.textTertiary} />
        </View>
      </Menu>
    </ListRow>
  );
}

function ServerSheet({ server, connector, canApprove, busy, onClose, onAction, onDelete }: {
  server: PersonalMcpServer | null;
  connector: Connector | null;
  canApprove: boolean;
  busy: boolean;
  onClose: () => void;
  onAction: (server: PersonalMcpServer) => void;
  onDelete: (server: PersonalMcpServer) => void;
}) {
  const last = React.useRef<PersonalMcpServer | null>(null);
  if (server) last.current = server;
  const shown = server ?? last.current;
  const { colors, layout } = useTheme();
  const oauth = shown?.auth === "oauth" ? personalMcpOAuthStatus(connector) : null;
  const action = shown ? personalMcpConnectionAction(shown, connector, canApprove) : null;
  return (
    <Sheet open={server !== null} onOpenChange={(open) => { if (!open) onClose(); }} title={shown?.name ?? "MCP server"} {...(shown ? { description: shown.url } : {})}>
      {shown && action ? (
        <>
          <View style={[styles.details, { borderColor: colors.border, borderRadius: layout.radius }]}>
            <ValueRow label="Tools" value={String(shown.toolCount)} />
            <ValueRow label="Transport" value={shown.transport} />
            <ValueRow label="Authentication" value={(oauth ? oauth.authentication === "connected" : shown.credentialConfigured) ? "Configured" : "Not configured"} />
            {oauth ? <ValueRow label="Organization approval" value={oauth.approval} /> : <ValueRow label="Trust" value={shown.trusted ? "Reviewed" : "Needs review"} />}
            <ValueRow
              label={oauth ? "Connection" : "Last tested"}
              value={oauth ? oauth.health : shown.lastCheckedAt ? formatDateTime(shown.lastCheckedAt) : "Never"}
              last
            />
          </View>
          {shown.auth !== "oauth" && shown.diagnostics.length ? <InlineMessage tone="info">{shown.diagnostics.join(" · ")}</InlineMessage> : null}
          {shown.auth === "oauth" && (action.kind === "connect" || action.kind === "reconnect") ? (
            <Text variant="meta" tone="tertiary">Authorization opens Berry on the web, where you're asked to sign in to this server.</Text>
          ) : null}
          <View style={styles.sheetActions}>
            <Button variant="outline" label="Delete server" disabled={busy} onPress={() => onDelete(shown)} />
            <Button label={busy ? "Working…" : action.label} disabled={action.disabled || busy} onPress={() => onAction(shown)} />
          </View>
        </>
      ) : <View />}
    </Sheet>
  );
}

function CreateServerSheet({ open, onOpenChange, canApprove, onStatus }: { open: boolean; onOpenChange: (open: boolean) => void; canApprove: boolean; onStatus: (status: Status) => void }) {
  const { client } = useSignedInSession();
  const refresh = useRefreshConnections();
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [transport, setTransport] = React.useState<PersonalMcpServer["transport"]>("streamable-http");
  const [auth, setAuth] = React.useState<PersonalMcpServer["auth"]>("none");
  const [credential, setCredential] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName("");
    setUrl("");
    setTransport("streamable-http");
    setAuth("none");
    setCredential("");
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!name.trim() || busy) return;
    if (!isHttpsUrl(url)) {
      setError("Enter the server's https:// URL.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = auth === "bearer" ? credential.trim() : "";
      const server = await client.savePersonalMcpServer({
        name: name.trim(),
        url: url.trim(),
        transport,
        auth,
        ...(token ? { credential: token } : {}),
        enabled: true,
        trusted: false,
      });
      onOpenChange(false);
      if (server.auth === "oauth" && server.transport === "streamable-http") {
        try {
          const connector = await client.requestMcpConnector(server.url);
          onStatus({ tone: "success", text: connector.approvalStatus === "approved" ? "Server approved. Tap Connect to authorize your account." : "Server submitted for organization approval. Connect will unlock after approval." });
        } catch (cause) {
          onStatus({ tone: "danger", text: `Server was saved, but approval could not be submitted: ${apiErrorMessage(cause, "try again later.")}` });
        }
      } else {
        onStatus({ tone: "success", text: "Server saved. Test its connection before trusting it." });
      }
      refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not save this server."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }} title="Review server connection" description="Credentials are stored by reference and are never returned to the app." scroll>
      <Field label="Name">
        <Input value={name} onChangeText={setName} placeholder="e.g. Company docs" accessibilityLabel="Name" autoFocus maxLength={100} />
      </Field>
      <Field label="HTTPS URL">
        <Input value={url} onChangeText={setUrl} placeholder="https://mcp.example.com/mcp" accessibilityLabel="HTTPS URL" keyboardType="url" autoCapitalize="none" autoCorrect={false} textContentType="URL" />
      </Field>
      <View style={styles.selects}>
        <View style={{ flex: 1 }}><Field label="Transport"><SelectField label="Transport" value={transport} options={TRANSPORTS} onChange={setTransport} /></Field></View>
        <View style={{ flex: 1 }}><Field label="Authentication"><SelectField label="Authentication" value={auth} options={AUTH_OPTIONS} onChange={(value) => { setAuth(value); if (value !== "bearer") setCredential(""); }} /></Field></View>
      </View>
      {auth === "bearer" ? (
        <Field label="Bearer token">
          <Input value={credential} onChangeText={setCredential} secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="none" accessibilityLabel="Bearer token" />
        </Field>
      ) : null}
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}
      <View style={styles.sheetActionsEnd}>
        <Button variant="outline" label="Cancel" disabled={busy} onPress={() => onOpenChange(false)} />
        <Button
          label={busy ? "Saving…" : auth === "oauth" ? (canApprove ? "Save and approve" : "Submit for approval") : "Save for testing"}
          disabled={busy || !name.trim() || !url.trim()}
          onPress={() => void submit()}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, minWidth: 0, gap: 3 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  serverRow: { paddingRight: 8 },
  more: { width: 36, height: 44, alignItems: "center", justifyContent: "center" },
  details: { borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  selects: { flexDirection: "row", gap: 8 },
  sheetActions: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  sheetActionsEnd: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
});
