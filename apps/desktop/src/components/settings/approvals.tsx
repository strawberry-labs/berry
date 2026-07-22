import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ApprovalRequest } from "@berry/shared";
import { ShieldQuestion, RefreshCw } from "@berry/desktop-ui/lib/icons";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@berry/desktop-ui/components/ui/empty";
import { host } from "@/lib/berry";
import { ApprovalEvidence, type ApprovalEvidenceProps } from "@/components/approval-evidence";
import { SettingCard, SettingRow, SettingsPageHeader, SettingsSectionLabel } from "./shared";

const APPROVALS_KEY = ["approvals", "pending"] as const;

function approvalTitle(approval: ApprovalRequest): string {
  const request = approval.request;
  if (request && typeof request === "object" && !Array.isArray(request)) {
    const title = (request as { title?: unknown; summary?: unknown; toolName?: unknown }).title;
    const summary = (request as { summary?: unknown }).summary;
    const toolName = (request as { toolName?: unknown }).toolName;
    if (typeof title === "string" && title) return title;
    if (typeof summary === "string" && summary) return summary;
    if (typeof toolName === "string" && toolName) return toolName;
  }
  return approval.kind;
}

function approvalDetail(approval: ApprovalRequest): string {
  const request = approval.request;
  if (request && typeof request === "object" && !Array.isArray(request)) {
    const detail = (request as { detail?: unknown; reason?: unknown; path?: unknown }).detail;
    const reason = (request as { reason?: unknown }).reason;
    const path = (request as { path?: unknown }).path;
    if (typeof detail === "string" && detail) return detail;
    if (typeof reason === "string" && reason) return reason;
    if (typeof path === "string" && path) return path;
  }
  return "Awaiting a decision.";
}

function approvalEvidence(approval: ApprovalRequest): ApprovalEvidenceProps {
  if (!approval.request || typeof approval.request !== "object" || Array.isArray(approval.request)) return {};
  const request = approval.request as Record<string, unknown>;
  const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload as Record<string, unknown> : {};
  const value = (key: string) => request[key] ?? payload[key];
  return {
    ...(typeof value("detail") === "string" ? { detail: value("detail") as string } : {}),
    ...(typeof value("rawDetail") === "string" ? { rawDetail: value("rawDetail") as string } : {}),
    ...(typeof value("diff") === "string" ? { diff: value("diff") as string } : {}),
    ...(value("destructive") === true ? { destructive: true } : {}),
    ...(value("openWorld") === true ? { openWorld: true } : {}),
  };
}

export function ApprovalSettings() {
  const queryClient = useQueryClient();
  const approvals = useQuery({
    queryKey: APPROVALS_KEY,
    queryFn: () => host.call<ApprovalRequest[]>("approval.list"),
    refetchInterval: 3000,
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approved_once" | "denied" }) =>
      host.call("approval.decide", { id, decision }),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: APPROVALS_KEY });
      toast.success(variables.decision === "approved_once" ? "Approval granted" : "Approval denied");
    },
  });
  const rows = useMemo(() => approvals.data ?? [], [approvals.data]);

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Approvals"
        description="Review pending shell, file, browser, MCP, and protected-write requests across the desktop host."
        actions={
          <Button size="sm" variant="outline" onClick={() => void approvals.refetch()}>
            <RefreshCw />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-3">
        <SettingsSectionLabel>Pending queue</SettingsSectionLabel>
        {rows.length === 0 ? (
          <Empty className="border border-dashed border-border py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldQuestion />
              </EmptyMedia>
              <EmptyTitle>No pending approvals</EmptyTitle>
              <EmptyDescription>New direct actions and agent tool requests will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <SettingCard>
            {rows.map((approval) => (
              <SettingRow
                key={approval.id}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{approvalTitle(approval)}</span>
                    <Badge variant="outline">{approval.kind}</Badge>
                  </span>
                }
                description={<ApprovalEvidence {...approvalEvidence(approval)} fallback={approvalDetail(approval)} />}
                control={
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => decide.mutate({ id: approval.id, decision: "denied" })}
                    >
                      Deny
                    </Button>
                    <Button size="sm" onClick={() => decide.mutate({ id: approval.id, decision: "approved_once" })}>
                      Allow once
                    </Button>
                  </div>
                }
              />
            ))}
          </SettingCard>
        )}
      </div>
    </div>
  );
}
