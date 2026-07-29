import {
  AsyncState,
  Button,
  ManagementPage,
  Section,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

export function PrivacySettingsScreen({ client, config, tenantId }: ManagementScreenProps) {
  const fallbackPermissions = config.rolePermissions.find((entry) => entry.tenantId === tenantId)?.permissions ?? [];
  const resource = useResource(
    `privacy:${tenantId}`,
    async () => client
      ? client.effectivePermissions(tenantId)
      : { permissions: fallbackPermissions, role: "demo", featureFlags: [] } as any,
    null as any,
  );

  const clear = () => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("berry.web.")) localStorage.removeItem(key);
    }
    location.reload();
  };

  return (
    <ManagementPage
      title="Privacy & local data"
      description="Understand effective access, local browser data, and organization-managed policy."
      eyebrow="Privacy & local data"
    >
      <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
        <Section
          title="Effective access"
          description={`Role: ${resource.data?.role ?? "Unknown"}. Denied capabilities are enforced by the server.`}
        >
          <div className="flex flex-wrap gap-1.5">
            {(resource.data?.permissions ?? []).map((permission: string) => <code className="rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground" key={permission}>{permission}</code>)}
          </div>
        </Section>
        <Section
          title="Local browser data"
          description="Clearing local preferences does not delete cloud tasks or organization records."
        >
          <div className="grid divide-y divide-border">
            <label className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <span className="grid gap-0.5">
                <b className="text-sm font-medium text-foreground">Berry preferences</b>
                <small className="text-xs text-muted-foreground">Theme, composer defaults, custom instructions, and local prompt library.</small>
              </span>
              <Button variant="destructive" onClick={clear}>Clear local data</Button>
            </label>
          </div>
        </Section>
      </AsyncState>
    </ManagementPage>
  );
}
