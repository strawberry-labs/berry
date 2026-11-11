import * as React from "react";
import { useRefreshModelCatalog } from "@/lib/model-catalog";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Connector, OrgPermission } from "@berry/shared";
import { Check, RefreshCw, ShieldCheck } from "lucide-react";
import { managementQueryKeys } from "@/lib/management-query-keys";
import { useResource, type ManagementScreenProps } from "./management-context";
import {
  AsyncState, Button, CellStack, DataTable, InlineNotice, ManagementPage, PermissionDenied,
  Section, StatusPill, formatDate,
} from "./management-primitives";

type ApprovalProps = Pick<ManagementScreenProps, "client" | "tenantId" | "permissions">;

const TRANSPORT_LABEL: Record<string, string> = { "streamable-http": "Streamable HTTP", "http-sse": "HTTP + SSE" };
const AUTH_LABEL: Record<string, string> = { oauth: "OAuth", bearer: "Bearer token", none: "No authentication" };

function connectionSummary(connector: Connector) {
  return [
    connector.transport ? TRANSPORT_LABEL[connector.transport] ?? connector.transport : null,
    AUTH_LABEL[connector.authType] ?? connector.authType,
    connector.authStrategy === "shared" ? "One organization credential" : "Each member signs in",
  ].filter(Boolean).join(" · ");
}

export function canReadMcpApprovals(permissions: readonly OrgPermission[]) {
  return permissions.includes("org:admin") && permissions.includes("mcp:read");
}

export function McpApprovalsLink({ permissions }: Pick<ApprovalProps, "permissions">) {
  if (!canReadMcpApprovals(permissions)) return null;
  return <Button variant="secondary" asChild><Link to="/admin/$tab" params={{ tab: "mcp-approvals" }} search={{}}><ShieldCheck aria-hidden />MCP approvals</Link></Button>;
}

export function AdminMcpApprovalsScreen(props: ApprovalProps) {
  if (!canReadMcpApprovals(props.permissions)) return <PermissionDenied label="MCP approvals" />;
  return (
    <ManagementPage
      title="MCP approvals"
      eyebrow="AI & tools"
      description="MCP servers that members have asked to use. An approved server joins the organization’s connectors, where each member connects their own account."
    >
      <McpApprovalQueue {...props} showReviewed />
    </ManagementPage>
  );
}

export function McpApprovalQueue(props: ApprovalProps & { showReviewed?: boolean }) {
  if (!canReadMcpApprovals(props.permissions)) return null;
  return <AuthorizedMcpApprovalQueue {...props} />;
}

function AuthorizedMcpApprovalQueue({ client, tenantId, permissions, showReviewed = false }: ApprovalProps & { showReviewed?: boolean }) {
  const queryClient = useQueryClient();
  const refreshCatalog = useRefreshModelCatalog();
  const resource = useResource(`connectors:approvals:${tenantId}`, () => client ? client.listOrganizationConnectors(tenantId) : Promise.resolve([]), [] as Connector[]);
  const requests = resource.data.filter((item) => item.kind === "custom_mcp");
  const pending = requests.filter((item) => item.approvalStatus === "pending");
  // Member requests only: administrator-created connectors never pass through this queue.
  const reviewed = requests
    .filter((item) => item.approvalStatus === "rejected" || (item.approvalStatus === "approved" && item.serverApproved))
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  const canWrite = permissions.includes("mcp:write");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const reviewing = React.useRef(false);

  async function review(connector: Connector, decision: "approve" | "reject") {
    if (!client || !canWrite || reviewing.current) return;
    reviewing.current = true;
    setBusy(`${connector.id}:${decision}`);
    setError(null);
    setNotice(null);
    try {
      const result = decision === "approve"
        ? await client.approveOrganizationConnectorRequest(tenantId, connector.id)
        : await client.rejectOrganizationConnectorRequest(tenantId, connector.id);
      refreshCatalog();
      resource.setData((rows) => rows.map((row) => row.id === result.id ? result : row));
      setNotice(decision === "approve" ? `${connector.name} approved. Members can now connect their own accounts.` : `${connector.name} rejected.`);
      // Refresh both the organization catalog and personal pending/connection views.
      void queryClient.invalidateQueries({ queryKey: managementQueryKeys.all });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to review this request");
    } finally {
      reviewing.current = false;
      setBusy(null);
    }
  }

  return <>
    {error ? <InlineNotice tone="danger" title="The request was not reviewed">{error}</InlineNotice> : null}
    {notice ? <InlineNotice tone="good">{notice}</InlineNotice> : null}
    <Section
      flush
      title="Waiting for review"
      description="Check that the address belongs to a service you trust. Approving shares the server, not anyone’s credentials."
      actions={<>
        {pending.length ? <StatusPill tone="warning">{pending.length} pending</StatusPill> : null}
        <Button variant="ghost" disabled={Boolean(busy)} onClick={resource.retry}><RefreshCw aria-hidden />Refresh</Button>
      </>}
    >
      <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
        {pending.length ? (
          <div className="grid divide-y divide-border">
            {pending.map((connector) => (
              <div key={connector.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 px-4 py-3">
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <b className="text-md font-medium text-foreground">{connector.name}</b>
                  <code className="break-all text-muted-foreground">{connector.url}</code>
                  <span className="text-xs text-muted-foreground">{connectionSummary(connector)}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="secondary" aria-label={`Reject ${connector.name}`} disabled={!canWrite || Boolean(busy)} onClick={() => void review(connector, "reject")}>{busy === `${connector.id}:reject` ? "Rejecting…" : "Reject"}</Button>
                  <Button aria-label={`Approve ${connector.name}`} disabled={!canWrite || Boolean(busy)} onClick={() => void review(connector, "approve")}><Check aria-hidden />{busy === `${connector.id}:approve` ? "Approving…" : "Approve"}</Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-4 py-8 text-center text-md text-muted-foreground">No MCP requests waiting for approval. A request appears here when a member asks to add a server.</p>
        )}
        {!canWrite && pending.length ? (
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">You can view requests. Approving or rejecting needs the “Connectors &amp; MCP: manage” permission.</p>
        ) : null}
      </AsyncState>
    </Section>
    {showReviewed && reviewed.length ? (
      <Section flush title="Reviewed" description="Earlier decisions on member requests. Approved servers are managed under Connectors.">
        <DataTable
          label="Reviewed requests"
          columns={["Server", "Decision", "Connection", "Updated"]}
          rows={reviewed.map((connector) => [
            <CellStack primary={connector.name} secondary={<span className="font-mono">{connector.url}</span>} />,
            <StatusPill tone={connector.approvalStatus === "approved" ? "good" : "danger"}>{connector.approvalStatus === "approved" ? "Approved" : "Rejected"}</StatusPill>,
            connectionSummary(connector),
            formatDate(connector.updatedAt),
          ])}
        />
      </Section>
    ) : null}
  </>;
}
