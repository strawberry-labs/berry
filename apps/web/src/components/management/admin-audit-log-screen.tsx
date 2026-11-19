import * as React from "react";
import { Download } from "lucide-react";
import {
  AsyncState,
  Button,
  CellStack,
  DataTable,
  DefinitionList,
  DetailDrawer,
  FilterSelect,
  ManagementPage,
  SearchInput,
  StatusPill,
  Toolbar,
  formatDateTime,
  formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { AdminAuditLogSkeleton } from "./management-screen-skeletons";

const EVENT_LIMIT = 100;

function sentence(value: string) {
  const text = String(value).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.:]+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function shortId(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export function AdminAuditLogScreen({ client, config, tenantId, permissions }: ManagementScreenProps) {
  const r = useResource(
    `audit:${tenantId}`,
    async () =>
      client
        ? Promise.all([
            client.listAuditEvents(tenantId, { limit: 100 }),
            permissions.includes("members:read") ? client.listOrgMembers(tenantId) : Promise.resolve([]),
          ])
        : [config.auditEvents.filter((x) => x.tenantId === tenantId), []],
    [[], []] as any,
  );
  const [events, members]: [any[], any[]] = r.data;
  const memberById = new Map((members ?? []).map((member) => [member.userId, member]));
  const actorLabel = (actorUserId: string | null) => {
    if (!actorUserId) return "System";
    const member = memberById.get(actorUserId);
    return member ? member.name || member.email : "Unknown member";
  };
  const actorSecondary = (actorUserId: string | null) =>
    actorUserId ? memberById.get(actorUserId)?.email ?? <span className="font-mono">{shortId(actorUserId)}</span> : "Automatic";
  /** People are shown by name; everything else by its type and a shortened id. */
  const targetCell = (event: any) => {
    if (!event.targetId) return "—";
    const member = memberById.get(event.targetId);
    if (member) return <CellStack primary={<span className="font-normal">{member.name || member.email}</span>} secondary={sentence(event.targetType ?? "member")} />;
    return (
      <CellStack
        primary={<span className="font-normal">{event.targetType ? sentence(event.targetType) : "Item"}</span>}
        secondary={<span className="font-mono" title={event.targetId}>{shortId(event.targetId)}</span>}
      />
    );
  };
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("all");
  const [active, setActive] = React.useState<number | null>(null);
  const categories = [...new Set(events.map((x: any) => x.category))].sort();
  const rows = events
    .filter(
      (x: any) =>
        `${x.action} ${x.category} ${actorLabel(x.actorUserId)} ${memberById.get(x.actorUserId)?.email ?? ""} ${memberById.get(x.targetId)?.name ?? ""} ${x.targetType ?? ""} ${x.targetId ?? ""} ${x.workspaceId ?? ""} ${x.taskId ?? ""} ${x.sessionId ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (category === "all" || x.category === category),
    )
    .sort((left: any, right: any) => String(right.ts ?? right.createdAt).localeCompare(String(left.ts ?? left.createdAt)));
  const detail = active != null ? rows[active] : null;
  const filtered = query.length > 0 || category !== "all";
  const exportCsv = () => {
    const header = [
      "sequence",
      "ts",
      "actorName",
      "actorUserId",
      "category",
      "action",
      "targetType",
      "targetId",
    ];
    const body = rows.map((x: any) =>
      [
        x.sequence,
        x.ts ?? x.createdAt,
        actorLabel(x.actorUserId),
        x.actorUserId ?? "system",
        x.category,
        x.action,
        x.targetType ?? "",
        x.targetId ?? "",
      ].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","),
    );
    const csv = [header.join(","), ...body].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "audit-log.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <ManagementPage width="wide"
      title="Audit log"
      description="Who changed what in this organization. Each event is chained to the one before it, so edits and gaps are detectable."
      actions={
        <Button variant="secondary" disabled={rows.length === 0} onClick={exportCsv}>
          <Download aria-hidden />
          Export CSV
        </Button>
      }
    >
      <Toolbar>
        <SearchInput
          label="Search audit events"
          value={query}
          onChange={(next) => { setActive(null); setQuery(next); }}
          placeholder="Search action, actor, or target"
        />
        <FilterSelect
          label="Category"
          value={category}
          onChange={(next) => { setActive(null); setCategory(next); }}
          options={[
            { value: "all", label: "All categories" },
            ...categories.map((c) => ({
              value: String(c),
              label: sentence(String(c)),
            })),
          ]}
        />
      </Toolbar>
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        skeleton={<AdminAuditLogSkeleton />}
        empty={rows.length === 0}
        emptyTitle={filtered ? "No matching events" : "No audit events yet"}
        emptyText={filtered ? "Clear the search or pick another category." : "Changes to members, policies, billing, and settings are recorded here as they happen."}
      >
        <DataTable
          label="Audit events"
          searchable={false}
          initialPageSize={25}
          columns={["Time", "Actor", "Action", "Target", "Category"]}
          onRowSelect={setActive}
          activeRow={active}
          rowLabel={(i) => `${rows[i].category} ${rows[i].action}`}
          rows={rows.map((x: any) => [
            <span data-sort={new Date(x.ts ?? x.createdAt).getTime()} className="whitespace-nowrap tabular-nums">{formatDateTime(x.ts ?? x.createdAt)}</span>,
            <CellStack primary={actorLabel(x.actorUserId)} secondary={actorSecondary(x.actorUserId)} />,
            sentence(x.action),
            targetCell(x),
            <StatusPill tone="neutral">{sentence(x.category)}</StatusPill>,
          ])}
        />
        <p className="text-xs text-muted-foreground">
          {filtered
            ? `${formatNumber(rows.length)} of the latest ${formatNumber(events.length)} events match.`
            : events.length >= EVENT_LIMIT
              ? `Showing the latest ${formatNumber(EVENT_LIMIT)} events.`
              : `${formatNumber(events.length)} ${events.length === 1 ? "event" : "events"}.`}{" "}
          Export CSV saves the events listed here.
        </p>
      </AsyncState>
      {detail ? (
        <DetailDrawer
          title={sentence(detail.action)}
          subtitle={<span className="font-mono">{detail.category}.{detail.action}</span>}
          badge={<StatusPill tone="neutral">{sentence(detail.category)}</StatusPill>}
          onClose={() => setActive(null)}
        >
          <DefinitionList
            items={[
              {
                term: "Time",
                detail: formatDateTime(detail.ts ?? detail.createdAt),
              },
              {
                term: "Actor",
                detail: <CellStack primary={<span className="font-normal">{actorLabel(detail.actorUserId)}</span>} secondary={actorSecondary(detail.actorUserId)} />,
              },
              { term: "Target", detail: targetCell(detail) },
              ...(detail.targetId ? [{ term: "Target ID", detail: <Mono value={detail.targetId} /> }] : []),
              ...(detail.actorUserId ? [{ term: "Actor ID", detail: <Mono value={detail.actorUserId} /> }] : []),
            ]}
          />
          {detail.before || detail.after ? (
            <div className="grid gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">Change</h3>
              <JsonBlock label="Before" value={detail.before ?? null} />
              <JsonBlock label="After" value={detail.after ?? null} />
            </div>
          ) : null}
          {detail.metadata && Object.keys(detail.metadata).length ? (
            <div className="grid gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">Details</h3>
              <JsonBlock value={detail.metadata} />
            </div>
          ) : null}
          <div className="grid gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Record</h3>
            <DefinitionList
              items={[
                { term: "Sequence", detail: <span className="tabular-nums">#{detail.sequence}</span> },
                { term: "Event ID", detail: <Mono value={detail.id} /> },
                ...(detail.workspaceId ? [{ term: "Workspace", detail: <Mono value={detail.workspaceId} /> }] : []),
                ...(detail.taskId ? [{ term: "Task", detail: <Mono value={detail.taskId} /> }] : []),
                ...(detail.sessionId ? [{ term: "Session", detail: <Mono value={detail.sessionId} /> }] : []),
                ...(detail.expiresAt ? [{ term: "Kept until", detail: formatDateTime(detail.expiresAt) }] : []),
                ...(detail.eventHash
                  ? [
                      { term: "Previous hash", detail: <Mono value={String(detail.previousHash ?? "—")} /> },
                      { term: "Event hash", detail: <Mono value={String(detail.eventHash)} /> },
                    ]
                  : []),
              ]}
            />
          </div>
        </DetailDrawer>
      ) : null}
    </ManagementPage>
  );
}

function Mono({ value }: { value: string }) {
  return <span className="break-all font-mono text-xs">{value}</span>;
}

function JsonBlock({ label, value }: { label?: string; value: unknown }) {
  return (
    <div className="min-w-0">
      {label ? <span className="mb-1 block text-xs text-muted-foreground">{label}</span> : null}
      <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--berry-surface-under)] p-3 font-mono text-xs leading-5 text-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
