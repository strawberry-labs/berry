import * as React from "react";
import { Check, Copy } from "lucide-react";
import {
  AsyncState,
  Button,
  DataTable,
  DefinitionList,
  DetailDrawer,
  InlineNotice,
  ManagementPage,
  Section,
  StatusPill,
  formatDate,
  formatDateTime,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

const LOCK_LABELS: Record<string, string> = {
  execpolicy: "Command rules",
  models: "Model allowlist",
  mcp: "MCP server allowlist",
  plugins: "Plugin allowlist",
  sandbox: "Minimum sandbox level",
  telemetry: "Telemetry",
};

export function AdminManagedPolicyScreen({
  client,
  config,
  tenantId,
}: ManagementScreenProps) {
  const r = useResource(
    `policy:${tenantId}`,
    async () =>
      client
        ? client.listPolicyVersions(tenantId)
        : config.policyVersions.filter((x) => x.tenantId === tenantId),
    [] as any[],
  );
  const [active, setActive] = React.useState<number | null>(null);
  const [copied, setCopied] = React.useState(false);
  const versions = [...r.data].sort((a: any, b: any) => b.version - a.version);
  const current = versions.find((v: any) => v.status === "active") ?? null;
  const detail = active != null ? versions[active] : null;
  const copyHash = (hash: string) => {
    void navigator.clipboard?.writeText(hash).then(() => setCopied(true)).catch(() => {});
  };
  return (
    <ManagementPage
      title="Managed policy"
      description="Signed rules every Berry client must follow: which commands, models, and tools are allowed. Members cannot override the active version."
      eyebrow="Identity & security"
    >
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={versions.length === 0}
        emptyTitle="No managed policy"
        emptyText="No policy version has been published, so clients run with their own local settings."
      >
        {current ? (
          <InlineNotice tone="good" title={`Version ${current.version} is active`}>
            Published {formatDateTime(current.publishedAt ?? current.createdAt)}
            {current.keyId ? <> · signed with key <span className="font-mono text-xs">{current.keyId}</span></> : null}
            {current.note ? <> · {current.note}</> : null}
          </InlineNotice>
        ) : (
          <InlineNotice tone="warning" title="No version is active">
            Clients are not receiving a managed policy and run with their own local settings.
          </InlineNotice>
        )}
        <Section title="Versions" description="Each published version replaces the one before it. Revoked versions are rejected by clients." flush>
          <DataTable
            label="Policy versions"
            columns={[
              "Version",
              "Status",
              "Published",
              "Signing key",
              "Note",
            ]}
            onRowSelect={(index) => { setCopied(false); setActive(index); }}
            activeRow={active}
            rowLabel={(i) => `Version ${versions[i].version}`}
            rows={versions.map((v: any) => [
              <b className="font-medium tabular-nums text-foreground" data-sort={v.version}>Version {v.version}</b>,
              <StatusPill tone={statusTone(v.status)}>{statusLabel(v.status)}</StatusPill>,
              formatDateTime(v.publishedAt ?? v.createdAt),
              v.keyId ? <span className="font-mono text-xs">{v.keyId}</span> : "—",
              v.note ?? "—",
            ])}
          />
        </Section>
        {detail ? (
          <DetailDrawer
            title={`Version ${detail.version}`}
            subtitle={`Published ${formatDate(detail.publishedAt ?? detail.createdAt)}`}
            badge={<StatusPill tone={statusTone(detail.status)}>{statusLabel(detail.status)}</StatusPill>}
            onClose={() => setActive(null)}
          >
            <DefinitionList items={enforcedItems(detail)} />
            <DefinitionList
              items={[
                {
                  term: "Published",
                  detail: formatDateTime(detail.publishedAt ?? detail.createdAt),
                },
                ...(detail.revokedAt
                  ? [{ term: "Revoked", detail: formatDateTime(detail.revokedAt) }]
                  : []),
                ...(detail.bundle?.expiresAt
                  ? [{ term: "Expires", detail: formatDateTime(detail.bundle.expiresAt) }]
                  : []),
                ...(detail.note ? [{ term: "Note", detail: detail.note }] : []),
                { term: "Signing key", detail: detail.keyId ? <span className="font-mono text-xs">{detail.keyId}</span> : "—" },
                {
                  term: "Bundle hash",
                  detail: detail.bundleHash ? (
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate font-mono text-xs" title={detail.bundleHash}>{detail.bundleHash}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0"
                        onClick={() => copyHash(detail.bundleHash)}
                        aria-label="Copy hash"
                      >
                        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                      </Button>
                    </span>
                  ) : (
                    "—"
                  ),
                },
                ...(detail.bundlePath
                  ? [{ term: "Bundle file", detail: <span className="break-all font-mono text-xs">{detail.bundlePath}</span> }]
                  : []),
              ]}
            />
          </DetailDrawer>
        ) : null}
      </AsyncState>
    </ManagementPage>
  );
}

/** What a version actually enforces, read from the signed bundle when it is loaded. */
function enforcedItems(version: any): Array<{ term: string; detail: React.ReactNode }> {
  const policy = version?.bundle?.policy;
  if (!policy) {
    const locks: string[] = version?.locks ?? [];
    return [{
      term: "Enforces",
      detail: locks.length ? locks.map((lock) => LOCK_LABELS[lock] ?? lock).join(", ") : "Nothing",
    }];
  }
  const count = (items: unknown[] | undefined, noun: string, none: string) =>
    items?.length ? `${items.length} ${noun}${items.length === 1 ? "" : "s"}` : none;
  const personal = policy.personalAdditions;
  return [
    { term: "Command rules", detail: count(policy.execpolicy, "rule", "None") },
    { term: "Models", detail: count(policy.modelAllowlist, "allowed model", "Any model") },
    { term: "MCP servers", detail: count(policy.mcpAllowlist, "allowed server", "Any server") },
    { term: "Plugins", detail: count(policy.pluginAllowlist, "allowed plugin", "Any plugin") },
    ...(personal
      ? [{
          term: "Personal additions",
          detail: [personal.skills ? "Skills allowed" : "Skills blocked", personal.mcp ? "MCP servers allowed" : "MCP servers blocked"].join(" · "),
        }]
      : []),
    { term: "Minimum sandbox", detail: sandboxLabel(policy.sandboxFloor) },
    { term: "Telemetry", detail: policy.telemetry === "required" ? "Required" : policy.telemetry === "disabled" ? "Disabled" : "Member’s choice" },
  ];
}

function sandboxLabel(floor: string | undefined) {
  return floor === "read-only" ? "Read only" : floor === "workspace-write" ? "Workspace write" : "Full access";
}

function statusTone(status: string): "good" | "danger" | "neutral" {
  return status === "active" ? "good" : status === "revoked" ? "danger" : "neutral";
}

function statusLabel(status: string) {
  return status === "active" ? "Active" : status === "revoked" ? "Revoked" : status === "draft" ? "Draft" : status;
}
