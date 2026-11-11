import * as React from "react";
import {
  AsyncState,
  CellStack,
  DataTable,
  DefinitionList,
  DetailDrawer,
  InlineNotice,
  ManagementPage,
  ManagementSwitch,
  StatusPill,
  SuccessMessage,
  formatDate,
  formatDateTime,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

const drawerHeading = "text-xs font-medium text-muted-foreground";

function sentence(value: string) {
  const text = String(value ?? "").replaceAll("_", " ").replaceAll("-", " ").replaceAll(".", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function AdminFeatureAccessScreen({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const canWrite = permissions.includes("feature_flags:write");
  const r = useResource(
    `features:${tenantId}`,
    async () =>
      client
        ? client.listFeatureFlags(tenantId)
        : config.featureFlags.filter((x) => x.tenantId === tenantId),
    [] as any[],
  );
  const [activeFlag, setActiveFlag] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const rows = [...r.data].sort((left: any, right: any) => sentence(left.flag).localeCompare(sentence(right.flag)));
  const activeIndex = rows.findIndex((f: any) => f.flag === activeFlag);
  const detail = activeIndex >= 0 ? rows[activeIndex] : null;
  const roleNames = (flag: any) => Object.keys(flag.roleDefaults ?? {});
  const setEnabled = async (flag: any, enabled: boolean) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await client?.upsertFeatureFlag(tenantId, flag.flag, {
        enabled,
        roleDefaults: flag.roleDefaults,
      });
      r.setData(
        r.data.map((f: any) =>
          f.flag === flag.flag
            ? { ...f, enabled, updatedAt: new Date().toISOString() }
            : f,
        ),
      );
      setMessage(
        `“${sentence(flag.flag)}” turned ${enabled ? "on" : "off"} for the organization and recorded in the audit log.`,
      );
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "The feature could not be updated.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <ManagementPage
      title="Feature access"
      description="Turn Berry features on or off for the whole organization. Models, connectors, and skills have their own tabs."
      eyebrow="AI & tools"
    >
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={rows.length === 0}
        emptyTitle="No features to manage"
        emptyText="Features that can be switched per organization appear here when the platform makes them available."
      >
        <DataTable
          label="Features"
          columns={["Feature", "Organization", "Role overrides", "Updated"]}
          onRowSelect={(index) => setActiveFlag(rows[index]?.flag ?? null)}
          activeRow={activeIndex >= 0 ? activeIndex : null}
          rowLabel={(i) => sentence(rows[i].flag)}
          rows={rows.map((f: any) => [
            <CellStack primary={sentence(f.flag)} secondary={<span className="font-mono">{f.flag}</span>} />,
            <StatusPill tone={f.enabled ? "good" : "neutral"}>
              {f.enabled ? "On" : "Off"}
            </StatusPill>,
            roleNames(f).length ? roleNames(f).map(sentence).join(", ") : <span className="text-muted-foreground">—</span>,
            formatDate(f.updatedAt),
          ])}
        />
      </AsyncState>
      {detail ? (
        <DetailDrawer
          title={sentence(detail.flag)}
          subtitle={<code>{detail.flag}</code>}
          badge={
            <StatusPill tone={detail.enabled ? "good" : "neutral"}>
              {detail.enabled ? "On" : "Off"}
            </StatusPill>
          }
          onClose={() => setActiveFlag(null)}
        >
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
          <div className="flex items-center justify-between gap-4">
            <span className="grid gap-0.5">
              <b className="text-md font-medium text-foreground">On for the organization</b>
              <small className="text-xs leading-5 text-muted-foreground">
                {canWrite ? "Applies to every member of the organization." : "Changing this needs the “Feature access: manage” permission."}
              </small>
            </span>
            <ManagementSwitch
              checked={Boolean(detail.enabled)}
              disabled={!canWrite || busy}
              onCheckedChange={(checked) => void setEnabled(detail, checked)}
              aria-label={`${sentence(detail.flag)} on for the organization`}
            />
          </div>
          <div className="grid gap-2">
            <h3 className={drawerHeading}>Role overrides</h3>
            {roleNames(detail).length ? (
              <>
                <DefinitionList
                  items={Object.entries(detail.roleDefaults).map(
                    ([role, perms]) => ({
                      term: sentence(role),
                      detail: (perms as string[]).length
                        ? <span className="font-mono text-xs">{(perms as string[]).join(", ")}</span>
                        : "—",
                    }),
                  )}
                />
                <p className="text-xs leading-5 text-muted-foreground">Permissions attached to this feature for each role. They cannot be edited on this screen.</p>
              </>
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">None. Every role follows the organization setting.</p>
            )}
          </div>
          <DefinitionList items={[{ term: "Updated", detail: formatDateTime(detail.updatedAt) }]} />
        </DetailDrawer>
      ) : null}
    </ManagementPage>
  );
}
