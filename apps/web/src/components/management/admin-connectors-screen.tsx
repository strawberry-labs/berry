import * as React from "react";
import { McpApprovalsLink, canReadMcpApprovals } from "./admin-mcp-approvals-screen";
import type { Connector, GoogleConnectorConfiguration } from "@berry/shared";
import {
  KeyRound,
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
import {
  AsyncState, Button, CellStack, Checkbox, DataTable, DefinitionList, DetailDrawer,
  FormSelect, InlineNotice, Input, ManagementDialog, ManagementPage, ManagementSwitch, Num, Section,
  SegmentedControl, SettingList, SettingRow, StatusPill, Textarea, formatDate, formatDateTime,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { ConnectorMark, GoogleWorkspaceWordmark } from "../connector-mark";

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
  const pendingRequests = React.useMemo(() => custom.filter((item) => item.approvalStatus === "pending"), [custom]);
  const approvedCustom = React.useMemo(() => custom.filter((item) => item.approvalStatus === "approved"), [custom]);
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [customOpen, setCustomOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<Connector | null>(null);
  const [activeId, setActiveId] = React.useState<string | null>(null);
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
      toast.success(kind === "discover" ? "Tools discovered. Review them, then publish the server." : kind === "publish" ? "Server published to all members" : "Server disabled");
      resource.retry();
    } catch (cause) { toast.error(message(cause)); } finally { setBusy(null); }
  };
  const deleteConnector = async () => {
    if (!client || !pendingDelete) return;
    const connector = pendingDelete;
    setBusy(`${connector.id}:delete`);
    try {
      await client.deleteOrganizationCustomConnector(tenantId, connector.id);
      toast.success("Server deleted");
      setPendingDelete(null);
      resource.retry();
    } catch (cause) { toast.error(message(cause)); } finally { setBusy(null); }
  };

  const googleStatus = resource.data.google.status;
  const activeIndex = approvedCustom.findIndex((connector) => connector.id === activeId);
  const detail = activeIndex >= 0 ? approvedCustom[activeIndex]! : null;
  const selectedTools = (connector: Connector) => toolAllowlist[connector.id]?.selected ?? connector.tools;
  const toggleTool = (connector: Connector, tool: string) => setToolAllowlist((current) => {
    const entry = current[connector.id] ?? { available: connector.tools, selected: connector.tools };
    const selected = entry.selected.includes(tool);
    return { ...current, [connector.id]: { ...entry, selected: selected ? entry.selected.filter((name) => name !== tool) : [...entry.selected, tool] } };
  });
  const addServerButton = canWrite ? <Button onClick={() => setCustomOpen(true)}><Plus />Add MCP server</Button> : null;

  return <ManagementPage title="Connectors" eyebrow="AI & tools" description="The apps and MCP servers members can connect to their work: Google apps, and custom MCP servers shared with the whole organization." actions={addServerButton}>
    {pendingRequests.length && canReadMcpApprovals(permissions) ? (
      <InlineNotice
        tone="warning"
        title={`${pendingRequests.length} MCP ${pendingRequests.length === 1 ? "request is" : "requests are"} waiting for approval`}
        action={<McpApprovalsLink permissions={permissions} />}
      >
        Members asked to add {pendingRequests.length === 1 ? "this server" : "these servers"}. Review {pendingRequests.length === 1 ? "it" : "them"} under MCP approvals.
      </InlineNotice>
    ) : null}
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
      <Section flush title={<GoogleWorkspaceWordmark />} description="Set up one Google OAuth client for the organization. Each member then connects their own Google account, up to the access level you allow here.">
        <SettingList>
          {canReadGoogleConfiguration ? (
            <SettingRow
              icon={KeyRound}
              title="Google OAuth client"
              description={
                resource.data.google.configured
                  ? <><span className="font-mono">{resource.data.google.clientId}</span>{resource.data.google.hostedDomain ? ` · limited to ${resource.data.google.hostedDomain}` : ""}{resource.data.google.lastTestedAt ? ` · tested ${formatDateTime(resource.data.google.lastTestedAt)}` : ""}</>
                  : canConfigure
                    ? "Not set up. Google apps stay off until a client ID and secret are saved."
                    : "Not set up. Setting it up needs the “Organization settings: manage” permission."
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={GOOGLE_STATUS_TONE[googleStatus] ?? "neutral"}>{GOOGLE_STATUS_LABEL[googleStatus] ?? googleStatus}</StatusPill>
                {resource.data.google.configured && canConfigure ? <Button variant="ghost" disabled={busy === "google-test"} onClick={() => { setBusy("google-test"); void client?.testGoogleConnectorConfiguration(tenantId).then(() => { toast.success("Google discovery endpoint is reachable"); resource.retry(); }).catch((cause) => toast.error(message(cause))).finally(() => setBusy(null)); }}><RefreshCw />{busy === "google-test" ? "Testing…" : "Test"}</Button> : null}
                {canConfigure ? <Button variant="secondary" onClick={() => setSetupOpen(true)}>{resource.data.google.configured ? "Edit" : "Set up"}</Button> : null}
              </div>
            </SettingRow>
          ) : null}
          {googleApps.map((connector) => (
            <GooglePolicyRow
              key={connector.id}
              connector={connector}
              lockedReason={!canWrite ? "Changing this needs the “Connectors & MCP: manage” permission." : !googleConfigured ? "Set up the Google OAuth client first." : null}
              busy={busy === connector.id}
              onChange={(enabled, level, mode) => void updateGoogle(connector, enabled, level, mode)}
            />
          ))}
        </SettingList>
        {googleApps.length === 0 ? <p className="px-4 py-6 text-center text-md text-muted-foreground">No Google apps are available in this deployment.</p> : null}
      </Section>

      <Section
        flush
        title="Custom MCP servers"
        description="Servers every member can use. Requests approved under MCP approvals appear here automatically; servers you add yourself are drafts until you publish a reviewed list of tools."
      >
        {approvedCustom.length ? (
          <DataTable
            label="Custom MCP servers"
            columns={["Server", "Status", "Added by", "Sign-in", "Tools", "Updated"]}
            onRowSelect={(index) => setActiveId(approvedCustom[index]?.id ?? null)}
            activeRow={activeIndex >= 0 ? activeIndex : null}
            rowLabel={(index) => approvedCustom[index]?.name ?? "Server"}
            rows={approvedCustom.map((connector) => [
              <CellStack primary={connector.name} secondary={<span className="font-mono">{connector.url}</span>} />,
              <CustomStatusPill connector={connector} />,
              connector.serverApproved ? "Member request" : "Administrator",
              connector.authStrategy === "shared" ? "One organization credential" : "Each member signs in",
              <Num value={connector.tools.length} kind="number" />,
              formatDate(connector.updatedAt),
            ])}
          />
        ) : (
          <div className="grid justify-items-center gap-3 px-4 py-8 text-center">
            <p className="text-md text-muted-foreground">No custom MCP servers yet. Add one yourself, or approve one a member has requested.</p>
            {addServerButton}
          </div>
        )}
      </Section>
    </AsyncState>

    {detail ? (
      <DetailDrawer
        title={detail.name}
        subtitle={<code className="break-all">{detail.url}</code>}
        badge={<CustomStatusPill connector={detail} />}
        onClose={() => setActiveId(null)}
        footer={canWrite ? (
          <Button variant="ghost" disabled={Boolean(busy)} onClick={() => { setPendingDelete(detail); setActiveId(null); }}><Trash2 />Delete server</Button>
        ) : undefined}
      >
        {!canWrite ? <InlineNotice tone="info">You can view this server. Changing it needs the “Connectors &amp; MCP: manage” permission.</InlineNotice> : null}
        {detail.description ? <p className="text-md leading-5 text-muted-foreground">{detail.description}</p> : null}
        {!detail.serverApproved && detail.publicationStatus === "published" ? (
          <div className="flex items-center justify-between gap-4">
            <span className="grid gap-0.5">
              <b className="text-md font-medium text-foreground">Available to members</b>
              <small className="text-xs leading-5 text-muted-foreground">When off, nobody can call this server’s tools. Its setup is kept.</small>
            </span>
            <ManagementSwitch
              checked={detail.enabled}
              disabled={!canWrite || Boolean(busy)}
              onCheckedChange={(next) => void action(detail, next ? "publish" : "disable")}
              aria-label={`${detail.name} available to members`}
            />
          </div>
        ) : null}
        <DefinitionList
          items={[
            { term: "Added by", detail: detail.serverApproved ? "Member request, approved" : "Administrator" },
            { term: "Transport", detail: detail.transport ? TRANSPORT_LABEL[detail.transport] ?? detail.transport : "—" },
            { term: "Authentication", detail: AUTH_LABEL[detail.authType] ?? detail.authType },
            { term: "Sign-in", detail: detail.authStrategy === "shared" ? "One organization credential for everyone" : "Each member signs in with their own account" },
            ...(!detail.serverApproved && detail.authType !== "none" ? [{ term: "Credential", detail: <StatusPill tone={detail.credentialConfigured ? "good" : "warning"}>{detail.credentialConfigured ? "Authorized" : "Not authorized"}</StatusPill> }] : []),
            ...(detail.websiteUrl ? [{ term: "Website", detail: <span className="break-all">{detail.websiteUrl}</span> }] : []),
            ...(detail.privacyPolicyUrl ? [{ term: "Privacy policy", detail: <span className="break-all">{detail.privacyPolicyUrl}</span> }] : []),
            { term: "Updated", detail: formatDateTime(detail.updatedAt) },
          ]}
        />
        {!detail.serverApproved && canWrite ? (
          <div className="grid gap-2">
            <h3 className={drawerHeading}>{detail.publicationStatus === "draft" ? "Finish setup" : "Maintenance"}</h3>
            {detail.publicationStatus === "draft" ? (
              <p className="text-xs leading-5 text-muted-foreground">
                {detail.authType !== "none" && !detail.credentialConfigured
                  ? "Authorize the server first, then discover its tools."
                  : detail.tools.length === 0
                    ? "Discover the server’s tools, then choose which ones members may call."
                    : "Choose the tools members may call below, then publish."}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {detail.authType === "oauth" && !detail.credentialConfigured ? <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void action(detail, "oauth")}><KeyRound />Authorize</Button> : null}
              <Button variant="secondary" disabled={Boolean(busy) || (detail.authType !== "none" && !detail.credentialConfigured)} onClick={() => void action(detail, "discover")}><Search />{busy === `${detail.id}:discover` ? "Discovering…" : "Discover tools"}</Button>
              {detail.publicationStatus === "draft" && detail.tools.length ? <Button disabled={Boolean(busy) || selectedTools(detail).length === 0} onClick={() => void action(detail, "publish")}><ShieldCheck />Publish {selectedTools(detail).length} {selectedTools(detail).length === 1 ? "tool" : "tools"}</Button> : null}
            </div>
          </div>
        ) : null}
        <div className="grid gap-2">
          <h3 className={drawerHeading}>{detail.serverApproved ? "Tools" : detail.publicationStatus === "draft" ? "Tools members may call" : "Published tools"}</h3>
          {detail.tools.length === 0 ? (
            <p className="text-xs leading-5 text-muted-foreground">{detail.serverApproved ? "Tools appear after the first member connects." : "No tools discovered yet."}</p>
          ) : detail.serverApproved || detail.publicationStatus === "published" || !canWrite ? (
            <>
              <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {(detail.serverApproved ? detail.tools : detail.tools.filter((tool) => selectedTools(detail).includes(tool))).map((tool) => <li key={tool} className="truncate font-mono text-xs text-foreground" title={tool}>{tool}</li>)}
              </ul>
              <p className="text-xs leading-5 text-muted-foreground">{detail.serverApproved ? "The server’s live tool list. Each member connects separately." : "The tool list can be chosen only while the server is a draft."}</p>
            </>
          ) : (
            <div className="grid sm:grid-cols-2">
              {detail.tools.map((tool) => (
                <label key={tool} className="flex min-w-0 items-center gap-2 py-1.5 text-xs text-foreground">
                  <Checkbox checked={selectedTools(detail).includes(tool)} onCheckedChange={() => toggleTool(detail, tool)} />
                  <span className="truncate font-mono" title={tool}>{tool}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      </DetailDrawer>
    ) : null}

    <ManagementDialog
      open={setupOpen}
      onOpenChange={setSetupOpen}
      title="Google OAuth client"
      description="Stored encrypted. Secrets are never shown again after saving."
      footer={<><Button variant="secondary" onClick={() => setSetupOpen(false)}>Cancel</Button><Button disabled={!googleDraft.clientId || busy === "google-save"} onClick={() => void saveGoogle()}>{busy === "google-save" ? "Saving…" : "Save Google client"}</Button></>}
    >
      <div className="grid gap-3">
        <Field label="OAuth client ID"><Input value={googleDraft.clientId} onChange={(event) => setGoogleDraft({ ...googleDraft, clientId: event.currentTarget.value })} placeholder="…apps.googleusercontent.com" /></Field>
        <Field label="OAuth client secret" help={resource.data.google.configured ? "Leave blank to keep the current secret." : undefined}><Input type="password" autoComplete="new-password" value={googleDraft.clientSecret} onChange={(event) => setGoogleDraft({ ...googleDraft, clientSecret: event.currentTarget.value })} /></Field>
        <Field label="Allowed account domain" help="Optional. Members can only connect Google accounts from this domain."><Input value={googleDraft.hostedDomain} onChange={(event) => setGoogleDraft({ ...googleDraft, hostedDomain: event.currentTarget.value })} placeholder="example.com" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Picker API key" help="Optional. Needed for the “Selected files only” Drive mode."><Input type="password" autoComplete="new-password" value={googleDraft.pickerApiKey} onChange={(event) => setGoogleDraft({ ...googleDraft, pickerApiKey: event.currentTarget.value })} /></Field>
          <Field label="Google Cloud project number"><Input inputMode="numeric" value={googleDraft.pickerProjectNumber} onChange={(event) => setGoogleDraft({ ...googleDraft, pickerProjectNumber: event.currentTarget.value })} /></Field>
        </div>
        <Field label="Authorized redirect URI" help="Add this to the OAuth client in Google Cloud.">
          <code className="block break-all rounded-lg bg-[var(--berry-surface-under)] px-3 py-2 text-foreground">{resource.data.google.callbackUrl}</code>
        </Field>
      </div>
    </ManagementDialog>

    <ManagementDialog
      open={customOpen}
      onOpenChange={setCustomOpen}
      title="Add MCP server"
      description="Saved as a draft. Members cannot use it until you authorize it, discover its tools, and publish the ones you have reviewed."
      footer={<><Button variant="secondary" onClick={() => setCustomOpen(false)}>Cancel</Button><Button disabled={!customDraft.name || !customDraft.url || busy === "custom-save"} onClick={() => void saveCustom()}>{busy === "custom-save" ? "Saving…" : "Save draft"}</Button></>}
    >
      <div className="grid gap-3">
        <Field label="Name"><Input value={customDraft.name} onChange={(event) => setCustomDraft({ ...customDraft, name: event.currentTarget.value })} placeholder="Company knowledge" /></Field>
        <Field label="Description"><Textarea value={customDraft.description} onChange={(event) => setCustomDraft({ ...customDraft, description: event.currentTarget.value })} rows={2} /></Field>
        <Field label="Server URL" help="Must be HTTPS."><Input value={customDraft.url} onChange={(event) => setCustomDraft({ ...customDraft, url: event.currentTarget.value })} placeholder="https://mcp.example.com/mcp" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Website" help="Optional."><Input type="url" value={customDraft.websiteUrl} onChange={(event) => setCustomDraft({ ...customDraft, websiteUrl: event.currentTarget.value })} placeholder="https://example.com" /></Field>
          <Field label="Privacy policy" help="Optional."><Input type="url" value={customDraft.privacyPolicyUrl} onChange={(event) => setCustomDraft({ ...customDraft, privacyPolicyUrl: event.currentTarget.value })} placeholder="https://example.com/privacy" /></Field>
        </div>
        <Field label="Transport"><FormSelect ariaLabel="Transport" value={customDraft.transport} onChange={(transport) => setCustomDraft({ ...customDraft, transport: transport as typeof customDraft.transport })} options={[{ value: "streamable-http", label: "Streamable HTTP" }, { value: "http-sse", label: "HTTP + SSE" }]} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Authentication"><FormSelect ariaLabel="Authentication" value={customDraft.authType} onChange={(authType) => setCustomDraft({ ...customDraft, authType: authType as typeof customDraft.authType })} options={[{ value: "oauth", label: "OAuth 2.1" }, { value: "bearer", label: "Bearer token" }, { value: "none", label: "None" }]} /></Field>
          <Field label="Who signs in"><FormSelect ariaLabel="Who signs in" value={customDraft.authStrategy} onChange={(authStrategy) => setCustomDraft({ ...customDraft, authStrategy: authStrategy as typeof customDraft.authStrategy })} options={[{ value: "personal", label: "Each member signs in" }, { value: "shared", label: "One organization credential" }]} /></Field>
        </div>
        {customDraft.authStrategy === "shared" ? <InlineNotice tone="warning" title="Everyone acts as the same account">The other system will see the organization credential, not the individual member. Use a dedicated least-privilege service account and publish only the tools that are needed.</InlineNotice> : null}
        {customDraft.authType === "oauth" ? <Field label="OAuth scopes" help="Optional. Separate scopes with spaces."><Input value={customDraft.oauthScope} onChange={(event) => setCustomDraft({ ...customDraft, oauthScope: event.currentTarget.value })} placeholder="read write" /></Field> : null}
        {customDraft.authType === "bearer" && customDraft.authStrategy === "shared" ? <Field label="Organization bearer token"><Input type="password" autoComplete="new-password" value={customDraft.sharedCredential} onChange={(event) => setCustomDraft({ ...customDraft, sharedCredential: event.currentTarget.value })} /></Field> : null}
        {customDraft.authType === "bearer" && customDraft.authStrategy === "personal" ? <Field label="Your bearer token" help="Used only to discover the server’s tools."><Input type="password" autoComplete="new-password" value={customDraft.personalCredential} onChange={(event) => setCustomDraft({ ...customDraft, personalCredential: event.currentTarget.value })} /></Field> : null}
      </div>
    </ManagementDialog>

    <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open && busy !== `${pendingDelete?.id}:delete`) setPendingDelete(null); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
          <AlertDialogDescription>This removes the server and its stored credentials for the whole organization. It cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy === `${pendingDelete?.id}:delete`}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy === `${pendingDelete?.id}:delete`} onClick={(event) => { event.preventDefault(); void deleteConnector(); }}>
            {busy === `${pendingDelete?.id}:delete` ? "Deleting…" : "Delete server"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </ManagementPage>;
}

const drawerHeading = "text-xs font-medium text-muted-foreground";
const TRANSPORT_LABEL: Record<string, string> = { "streamable-http": "Streamable HTTP", "http-sse": "HTTP + SSE" };
const AUTH_LABEL: Record<string, string> = { oauth: "OAuth", bearer: "Bearer token", none: "No authentication" };
const GOOGLE_STATUS_LABEL: Record<string, string> = { not_configured: "Not set up", configured: "Not tested", verified: "Verified", error: "Failing" };
const GOOGLE_STATUS_TONE: Record<string, "neutral" | "good" | "warning" | "danger"> = { not_configured: "neutral", configured: "warning", verified: "good", error: "danger" };
const ACCESS_LABEL = { off: "Off", read: "Read only", full: "Read and write" } as const;

/** Draft, published and switched-off servers share one pill so every list reads the same. */
function CustomStatusPill({ connector }: { connector: Connector }) {
  if (connector.publicationStatus === "draft") return <StatusPill tone="warning">Draft</StatusPill>;
  return <StatusPill tone={connector.enabled ? "good" : "neutral"}>{connector.enabled ? "Published" : "Disabled"}</StatusPill>;
}

function GooglePolicyRow({ connector, lockedReason, busy, onChange }: { connector: Connector; lockedReason: string | null; busy: boolean; onChange: (enabled: boolean, level: "read" | "full", mode?: "selected_files" | "search_workspace") => void }) {
  const [mode, setMode] = React.useState(connector.workspaceAccessMode ?? "selected_files");
  React.useEffect(() => setMode(connector.workspaceAccessMode ?? "selected_files"), [connector.workspaceAccessMode]);
  const level: keyof typeof ACCESS_LABEL = !connector.enabled ? "off" : connector.maxAccessLevel === "full" ? "full" : "read";
  const services = connector.services.join(" · ");
  return <>
    <SettingRow
      iconContent={<ConnectorMark connectorKey={connector.key} className="mt-0.5 size-4 shrink-0 object-contain text-muted-foreground" />}
      title={connector.name}
      description={lockedReason ? <>{services ? `${services}. ` : ""}{lockedReason}</> : services || connector.description}
    >
      {lockedReason || busy ? (
        <StatusPill tone={level === "off" ? "neutral" : "good"}>{busy ? "Saving…" : ACCESS_LABEL[level]}</StatusPill>
      ) : (
        <SegmentedControl
          label={`${connector.name} access`}
          value={level}
          onChange={(next) => onChange(next !== "off", next === "full" ? "full" : "read", mode)}
          options={(Object.keys(ACCESS_LABEL) as Array<keyof typeof ACCESS_LABEL>).map((value) => ({ value, label: ACCESS_LABEL[value] }))}
        />
      )}
    </SettingRow>
    {connector.key === "google-workspace" ? (
      <SettingRow
        title="Drive file access"
        description="“Selected files only” lets a member pick files with Google Picker. “Workspace search” lets Berry search every file that member can open."
      >
        <div className="w-52 max-w-full">
          <FormSelect
            ariaLabel="Drive file access"
            value={mode}
            disabled={Boolean(lockedReason) || busy}
            onChange={(value) => { const next = value as typeof mode; setMode(next); if (connector.enabled) onChange(true, connector.maxAccessLevel, next); }}
            options={[{ value: "selected_files", label: "Selected files only" }, { value: "search_workspace", label: "Workspace search" }]}
          />
        </div>
      </SettingRow>
    ) : null}
  </>;
}

function Field({ label, help, children }: { label: string; help?: string | undefined; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {children}
      {help ? <small className="text-xs font-normal leading-4">{help}</small> : null}
    </label>
  );
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : "Connector request failed"; }
