import * as React from "react";
import { useRefreshModelCatalog } from "@/lib/model-catalog";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Connector, OrgPermission } from "@berry/shared";
import { Check, RefreshCw, ShieldCheck } from "lucide-react";
import { managementQueryKeys } from "@/lib/management-query-keys";
import { useResource, type ManagementScreenProps } from "./management-context";
import { AsyncState, Button, ManagementPage, PermissionDenied, Section, StatusPill } from "./management-primitives";

type ApprovalProps = Pick<ManagementScreenProps, "client" | "tenantId" | "permissions">;

export function canReadMcpApprovals(permissions: readonly OrgPermission[]) {
  return permissions.includes("org:admin") && permissions.includes("mcp:read");
}

export function McpApprovalsLink({ permissions }: Pick<ApprovalProps, "permissions">) {
  if (!canReadMcpApprovals(permissions)) return null;
  return <Button variant="outline" asChild><Link to="/admin/$tab" params={{ tab: "mcp-approvals" }} search={{}}><ShieldCheck data-icon="inline-start" />MCP approvals</Link></Button>;
}

export function AdminMcpApprovalsScreen(props: ApprovalProps) {
  if (!canReadMcpApprovals(props.permissions)) return <PermissionDenied label="MCP approvals" />;
  return <ManagementPage title="MCP approvals" eyebrow="Organization administration" description="Review servers submitted by members. Approved servers become available for each user to connect."><McpApprovalQueue {...props} /></ManagementPage>;
}

export function McpApprovalQueue(props: ApprovalProps) {
  if (!canReadMcpApprovals(props.permissions)) return null;
  return <AuthorizedMcpApprovalQueue {...props} />;
}

function AuthorizedMcpApprovalQueue({ client, tenantId, permissions }: ApprovalProps) {
  const queryClient = useQueryClient();
  const refreshCatalog = useRefreshModelCatalog();
  const resource = useResource(`connectors:approvals:${tenantId}`, () => client ? client.listOrganizationConnectors(tenantId) : Promise.resolve([]), [] as Connector[]);
  const pending = resource.data.filter((item) => item.kind === "custom_mcp" && item.approvalStatus === "pending");
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
      setNotice(decision === "approve" ? `${connector.name} approved. Users can now connect their own accounts.` : `${connector.name} rejected.`);
      // Refresh both the organization catalog and personal pending/connection views.
      void queryClient.invalidateQueries({ queryKey: managementQueryKeys.all });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to review this request");
    } finally {
      reviewing.current = false;
      setBusy(null);
    }
  }

  return <Section title="MCP approval requests" description="Review the server address before approving. Each user still authorizes their own account.">
    <div className="mb-3 flex items-center justify-between gap-3"><StatusPill tone={pending.length ? "warning" : "neutral"}>{pending.length} pending</StatusPill><Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={resource.retry}><RefreshCw data-icon="inline-start" />Refresh requests</Button></div>
    {error ? <p role="alert" className="mb-3 text-xs text-[var(--berry-danger)]">{error}</p> : null}
    {notice ? <p role="status" className="mb-3 text-xs text-[var(--berry-text-secondary)]">{notice}</p> : null}
    <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
      {pending.length ? <div className="flex flex-col gap-2">{pending.map((connector) => <div key={connector.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
        <div className="min-w-0 flex-1"><b className="block text-sm font-medium">{connector.name}</b><p className="break-all text-xs text-muted-foreground">{connector.url}</p><p className="mt-1 text-[11px] text-muted-foreground">{connector.transport} · {connector.authType} · {connector.authStrategy === "shared" ? "Organization authorization" : "Per-user authorization"}</p></div>
        <div className="flex items-center gap-2"><Button size="sm" variant="outline" aria-label={`Reject ${connector.name}`} disabled={!canWrite || Boolean(busy)} onClick={() => void review(connector, "reject")}>{busy === `${connector.id}:reject` ? "Rejecting…" : "Reject"}</Button><Button size="sm" aria-label={`Approve ${connector.name}`} disabled={!canWrite || Boolean(busy)} onClick={() => void review(connector, "approve")}><Check data-icon="inline-start" />{busy === `${connector.id}:approve` ? "Approving…" : "Approve"}</Button></div>
      </div>)}</div> : <p className="py-5 text-center text-xs text-muted-foreground">No MCP requests waiting for approval.</p>}
      {!canWrite ? <p className="mt-3 text-xs text-muted-foreground">You can view requests. An administrator with MCP write permission can approve or reject them.</p> : null}
    </AsyncState>
  </Section>;
}
