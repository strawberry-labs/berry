import * as React from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import type { Connector } from "@berry/shared";
import { apiErrorMessage } from "../../api/client";
import { useSignedInSession } from "../../session/session";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { ArrowUpRight01Icon, CalendarClock, Clock, Mail, Plug, Plus, type Icon } from "../../ui/icons";
import { EmptyState, Input, StatusPill } from "../../ui/primitives";
import { Section } from "../../ui/screen";
import { Sheet } from "../../ui/sheet";
import { Text } from "../../ui/text";
import { useConnectorRequests, useConnectors, useEffectivePermissions, usePollWhile, useRefreshConnections, useRefreshOnForeground } from "./settings-data";
import { HardDrive } from "../../ui/icons";
import { connectorAccessLabel, customMcpConnectors, filterConnectors, humanTool, isHttpsUrl, webUrl } from "./settings-model";
import { AsyncContent, Chip, Field, FilterInput, InlineMessage, ListRow, SettingsPage } from "./settings-ui";

type Status = { tone: "danger" | "success"; text: string };

export function connectorIcon(connector: Pick<Connector, "key">): Icon {
  if (connector.key === "google-workspace") return HardDrive;
  if (connector.key === "gmail") return Mail;
  if (connector.key === "google-calendar") return CalendarClock;
  return Plug;
}

/**
 * Opens a settings page of the web app. Connector OAuth callbacks need the
 * web's signed-in session, so authorization finishes there.
 */
export async function openWebSettings(serverUrl: string, path: "/settings/connectors" | "/settings/mcp"): Promise<void> {
  await WebBrowser.openBrowserAsync(webUrl(serverUrl, path), { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET });
}

/** Settings › Connectors: the web's connector catalog, connect and disconnect. */
export function ConnectorsTab() {
  const connectors = useConnectors();
  const requests = useConnectorRequests();
  const permissions = useEffectivePermissions();
  const refresh = useRefreshConnections();
  const [query, setQuery] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [status, setStatus] = React.useState<Status | null>(null);
  const canApprove = Boolean(permissions.data?.permissions.includes("mcp:write"));

  const all = connectors.data ?? [];
  const visible = filterConnectors(all, query);
  const unresolved = (requests.data ?? []).filter((connector) => connector.approvalStatus !== "approved");
  const hasPending = (requests.data ?? []).some((connector) => connector.approvalStatus === "pending");
  const selected = all.find((connector) => connector.id === selectedId) ?? null;
  usePollWhile(hasPending, refresh);
  useRefreshOnForeground(refresh);

  return (
    <SettingsPage
      title="Connectors"
      description="Connect approved apps once, then let Berry use their tools when a task needs them."
      refreshing={connectors.isRefetching}
      onRefresh={refresh}
      trailing={<Button variant="ghost" size="sm" icon={Plus} label="Add MCP" onPress={() => setAddOpen(true)} />}
    >
      {status ? <InlineMessage tone={status.tone} onDismiss={() => setStatus(null)}>{status.text}</InlineMessage> : null}

      {unresolved.length ? (
        <Section title="MCP approval status" description="Connect becomes available after an organization administrator approves the server.">
          {unresolved.map((connector, index) => (
            <ListRow key={connector.id} last={index === unresolved.length - 1}>
              <ConnectorGlyph connector={connector} />
              <View style={styles.body}>
                <Text variant="body" weight="medium" numberOfLines={1}>{connector.name}</Text>
                <Text variant="meta" tone="tertiary" numberOfLines={1}>{connector.url ?? ""}</Text>
              </View>
              <StatusPill tone={connector.approvalStatus === "pending" ? "warning" : "neutral"}>{connector.approvalStatus === "pending" ? "Awaiting approval" : "Not approved"}</StatusPill>
            </ListRow>
          ))}
        </Section>
      ) : null}

      <FilterInput value={query} onChangeText={setQuery} placeholder="Search connectors" />

      <AsyncContent
        loading={connectors.isPending}
        error={connectors.isError ? apiErrorMessage(connectors.error, "Could not load connectors.") : null}
        onRetry={() => void connectors.refetch()}
        rows={4}
      >
        <Section>
          {visible.length === 0 ? (
            <EmptyState
              title={query ? "No matching connectors" : "No connectors available"}
              message={query ? "Try a different search." : "An administrator must enable connectors before they appear here."}
            />
          ) : visible.map((connector, index) => (
            <ConnectorRow key={connector.id} connector={connector} last={index === visible.length - 1} onPress={() => setSelectedId(connector.id)} />
          ))}
        </Section>
      </AsyncContent>

      <ConnectorSheet connector={selected} onClose={() => setSelectedId(null)} onStatus={setStatus} />
      <AddMcpSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        canApprove={canApprove}
        approved={customMcpConnectors(all, []).filter((connector) => connector.approvalStatus === "approved")}
        onOpenConnector={(connector) => { setAddOpen(false); setSelectedId(connector.id); }}
        onStatus={setStatus}
      />
    </SettingsPage>
  );
}

function ConnectorGlyph({ connector, large = false }: { connector: Connector; large?: boolean }) {
  const { colors, layout } = useTheme();
  const Glyph = connectorIcon(connector);
  const size = large ? 56 : 40;
  return (
    <View style={[styles.glyph, { width: size, height: size, borderRadius: layout.radius + 2, borderColor: colors.border, backgroundColor: colors.control }]}>
      <Glyph size={large ? 26 : 18} color={colors.textPrimary} />
    </View>
  );
}

function ConnectorRow({ connector, last, onPress }: { connector: Connector; last: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const connected = connector.connectionStatus === "connected";
  return (
    <ListRow last={last} onPress={onPress} accessibilityLabel={`${connector.name}${connected ? ", connected" : ""}`} style={styles.connectorRow}>
      <ConnectorGlyph connector={connector} />
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text variant="body" weight="medium" numberOfLines={1} style={{ flexShrink: 1 }}>{connector.name}</Text>
          {connected ? <StatusPill tone="good">Connected</StatusPill> : null}
          {connector.connectionStatus === "reauth_required" ? <StatusPill tone="warning">Reconnect</StatusPill> : null}
        </View>
        <Text variant="secondary" tone="tertiary" numberOfLines={2}>{connector.description}</Text>
        {connector.services.length ? <Text variant="meta" tone="faint" numberOfLines={1}>{connector.services.join(" · ")}</Text> : null}
      </View>
      {!connected ? <Plus size={16} color={colors.textTertiary} /> : null}
    </ListRow>
  );
}

function ConnectorSheet({ connector, onClose, onStatus }: { connector: Connector | null; onClose: () => void; onStatus: (status: Status) => void }) {
  // Keep the last connector rendered while the sheet animates closed.
  const last = React.useRef<Connector | null>(null);
  if (connector) last.current = connector;
  const shown = connector ?? last.current;
  return (
    <Sheet open={connector !== null} onOpenChange={(open) => { if (!open) onClose(); }} scroll>
      {shown ? <ConnectorDetails key={shown.id} connector={shown} onStatus={onStatus} /> : <View />}
    </Sheet>
  );
}

function ConnectorDetails({ connector, onStatus }: { connector: Connector; onStatus: (status: Status) => void }) {
  const { client, profile } = useSignedInSession();
  const { colors, layout } = useTheme();
  const refresh = useRefreshConnections();
  const [credential, setCredential] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const connected = connector.connectionStatus === "connected";
  const needsToken = connector.authType === "bearer" && connector.authStrategy === "personal" && !connected;
  const oauth = connector.authType === "oauth";

  const connect = async () => {
    setError(null);
    if (oauth) {
      await openWebSettings(profile.serverUrl, "/settings/connectors");
      refresh();
      return;
    }
    if (!credential.trim()) {
      setError("Enter the access token supplied by the connector.");
      return;
    }
    setBusy(true);
    try {
      const updated = await client.connectConnectorBearer(connector.id, credential.trim());
      setCredential("");
      refresh();
      onStatus({ tone: "success", text: `${updated.name} connected.` });
    } catch (cause) {
      setError(apiErrorMessage(cause, "Connector request failed."));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    Alert.alert(`Disconnect ${connector.name}?`, "Berry stops using this connection in your tasks. You can connect again later.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          setError(null);
          try {
            await client.disconnectConnector(connector.id);
            refresh();
            onStatus({ tone: "success", text: `${connector.name} disconnected.` });
          } catch (cause) {
            setError(apiErrorMessage(cause, "Connector request failed."));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const openLink = (url: string) => void WebBrowser.openBrowserAsync(url);

  return (
    <>
      <View style={styles.sheetHeader}>
        <ConnectorGlyph connector={connector} large />
        <Text variant="body" weight="semibold" accessibilityRole="header" style={styles.center}>{connector.name}</Text>
        <Text variant="secondary" tone="tertiary" style={styles.center}>{connector.description}</Text>
      </View>

      {connected ? (
        <View style={[styles.connectedCard, { borderColor: colors.border, backgroundColor: colors.surfaceUnder, borderRadius: layout.radius }]}>
          <View style={styles.body}>
            <Text variant="body" weight="medium">Connected</Text>
            <Text variant="secondary" tone="tertiary" numberOfLines={1}>{connector.accountEmail ?? (connector.authStrategy === "shared" ? "Managed by your organization" : "Credential saved")}</Text>
          </View>
          <StatusPill tone="good">{connectorAccessLabel(connector)}</StatusPill>
        </View>
      ) : null}

      {needsToken ? (
        <Field label="Access token">
          <Input value={credential} onChangeText={setCredential} placeholder="Paste token" secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="none" accessibilityLabel="Access token" />
        </Field>
      ) : null}

      {!connected && connector.authType !== "none" ? (
        <Text variant="secondary" tone="tertiary">
          Berry uses this connection only for tasks you request. Relevant connector data may be sent to the model provider configured by your organization. Write actions still require confirmation, and connector data is not used for generalized model training by Berry.
        </Text>
      ) : null}

      {connector.services.length ? (
        <View style={styles.block}>
          <Text variant="secondary" weight="medium">Available services</Text>
          <View style={styles.chips}>{connector.services.map((service) => <Chip key={service}>{service}</Chip>)}</View>
        </View>
      ) : null}

      <View style={styles.block}>
        <Text variant="secondary" weight="medium">What Berry can do</Text>
        {connector.tools.length ? (
          <View style={styles.tools}>
            {connector.tools.slice(0, 10).map((tool) => (
              <View key={tool} style={[styles.tool, { borderColor: colors.border, borderRadius: layout.radius - 4 }]}>
                <Text variant="meta" tone="secondary" numberOfLines={1}>{humanTool(tool)}</Text>
              </View>
            ))}
            {connector.tools.length > 10 ? <Text variant="meta" tone="tertiary">Plus {connector.tools.length - 10} more approved tools</Text> : null}
          </View>
        ) : <Text variant="secondary" tone="tertiary">Berry will discover this server's tools after you authorize your account.</Text>}
      </View>

      {connector.limitations.length ? (
        <View style={[styles.boundary, { borderColor: colors.border, backgroundColor: colors.surfaceUnder, borderRadius: layout.radius }]}>
          <Text variant="secondary" weight="medium">Security boundary</Text>
          {connector.limitations.map((limitation) => <Text key={limitation} variant="secondary" tone="tertiary">{limitation}</Text>)}
        </View>
      ) : null}

      {connector.websiteUrl || connector.privacyPolicyUrl ? (
        <View style={styles.links}>
          {connector.websiteUrl ? <LinkText label="Website" onPress={() => openLink(connector.websiteUrl!)} /> : null}
          {connector.privacyPolicyUrl ? <LinkText label="Privacy policy" onPress={() => openLink(connector.privacyPolicyUrl!)} /> : null}
        </View>
      ) : null}

      {oauth && !connected ? (
        <Text variant="meta" tone="tertiary">Authorization opens Berry on the web, where you're asked to sign in to the app you're connecting.</Text>
      ) : null}
      {connected && connector.key === "google-workspace" && connector.workspaceAccessMode === "selected_files" ? (
        <Text variant="meta" tone="tertiary">Choose which Drive files Berry can use from Berry on the web.</Text>
      ) : null}

      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}

      <View style={styles.sheetActions}>
        {connected && connector.authStrategy === "personal" ? <Button variant="outline" label="Disconnect" disabled={busy} onPress={disconnect} /> : <View />}
        {!connected && connector.authType !== "none" ? (
          <Button
            label={busy ? "Connecting…" : !connector.configured ? "Admin setup required" : oauth ? "Connect on the web" : `Connect ${connector.name}`}
            {...(oauth && connector.configured ? { icon: ArrowUpRight01Icon } : {})}
            disabled={busy || !connector.configured}
            onPress={() => void connect()}
          />
        ) : null}
      </View>
    </>
  );
}

function LinkText({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="link" onPress={onPress} hitSlop={8} style={styles.link}>
      <Text variant="secondary" style={{ textDecorationLine: "underline" }}>{label}</Text>
      <ArrowUpRight01Icon size={12} color={colors.textSecondary} />
    </Pressable>
  );
}

function AddMcpSheet({ open, onOpenChange, canApprove, approved, onOpenConnector, onStatus }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canApprove: boolean;
  approved: Connector[];
  onOpenConnector: (connector: Connector) => void;
  onStatus: (status: Status) => void;
}) {
  const { client } = useSignedInSession();
  const { colors, layout } = useTheme();
  const refresh = useRefreshConnections();
  const [url, setUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setUrl("");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    if (!isHttpsUrl(url)) {
      setError("Enter the server's https:// URL.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const connector = await client.requestMcpConnector(url.trim());
      refresh();
      onOpenChange(false);
      if (connector.approvalStatus === "approved") {
        onStatus({ tone: "success", text: `${connector.name} is approved and ready to connect.` });
        onOpenConnector(connector);
      } else {
        onStatus({ tone: "success", text: "MCP server sent for organization approval." });
      }
    } catch (cause) {
      setError(apiErrorMessage(cause, "Connector request failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add an MCP server"
      description={canApprove ? "Paste a Streamable HTTP MCP URL. Administrators can approve it immediately." : "Paste a Streamable HTTP MCP URL. An administrator must approve a new server before anyone can connect."}
      scroll
    >
      {approved.length ? (
        <View style={styles.block}>
          <View>
            <Text variant="secondary" weight="medium">Organization catalog</Text>
            <Text variant="meta" tone="tertiary">Already approved and available to everyone.</Text>
          </View>
          {approved.map((connector) => (
            <View key={connector.id} style={[styles.catalogRow, { borderColor: colors.border, borderRadius: layout.radius }]}>
              <View style={styles.body}>
                <Text variant="secondary" weight="medium" numberOfLines={1}>{connector.name}</Text>
                <Text variant="meta" tone="tertiary" numberOfLines={1}>{connector.url ?? ""}</Text>
              </View>
              <Button variant="outline" size="sm" label={connector.connectionStatus === "connected" ? "View" : "Connect"} onPress={() => onOpenConnector(connector)} />
            </View>
          ))}
        </View>
      ) : null}
      <Field label="Streamable HTTP MCP URL">
        <Input value={url} onChangeText={setUrl} placeholder="https://mcp.example.com/mcp" keyboardType="url" autoCapitalize="none" autoCorrect={false} textContentType="URL" accessibilityLabel="Streamable HTTP MCP URL" returnKeyType="go" onSubmitEditing={() => void submit()} />
      </Field>
      <Text variant="meta" tone="tertiary">Berry discovers the server's OAuth configuration when you connect. Your authorization is personal; approving the server does not share anyone's OAuth tokens.</Text>
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}
      <View style={styles.sheetActionsEnd}>
        <Button variant="outline" label="Cancel" disabled={busy} onPress={() => onOpenChange(false)} />
        <Button label={busy ? "Submitting…" : canApprove ? "Add to organization" : "Request approval"} {...(busy ? {} : { icon: canApprove ? Plus : Clock })} disabled={busy || !url.trim()} onPress={() => void submit()} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  connectorRow: { alignItems: "flex-start", paddingVertical: 14 },
  glyph: { alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth },
  sheetHeader: { alignItems: "center", gap: 6, paddingTop: 4 },
  center: { textAlign: "center" },
  connectedCard: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  block: { gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tools: { gap: 6 },
  tool: { paddingHorizontal: 10, paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth },
  boundary: { padding: 12, gap: 4, borderWidth: StyleSheet.hairlineWidth },
  links: { flexDirection: "row", gap: 16 },
  link: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32 },
  catalogRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth },
  sheetActions: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  sheetActionsEnd: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
});
