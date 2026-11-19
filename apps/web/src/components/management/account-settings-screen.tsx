import * as React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@berry/desktop-ui/components/ui/avatar";
import { AsyncState, DefinitionList, ManagementPage, Section, StatusPill } from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { MobileDevicesSection } from "./mobile-devices-section";
import { mobilePairingApi } from "../../lib/mobile-pairing";
import { AccountAccessSkeleton } from "./management-screen-skeletons";
import { FillHeightScroller } from "../infinite-scroll-trigger";

export function AccountSettingsScreen({ client, config, tenantId, user }: ManagementScreenProps) {
  const fallbackPermissions = config.rolePermissions.find((entry) => entry.tenantId === tenantId)?.permissions ?? [];
  const access = useResource(
    `account-access:${tenantId}`,
    async () => client
      ? client.effectivePermissions(tenantId)
      : { permissions: fallbackPermissions, role: "demo", featureFlags: [] } as any,
    { permissions: fallbackPermissions, role: "Unknown", featureFlags: [] } as any,
  );
  const name = user?.name?.trim() || "Unnamed account";
  const pairing = React.useMemo(() => mobilePairingApi(client), [client]);
  const groups = permissionGroups(access.data?.permissions ?? []);

  return <ManagementPage width="narrow" title="Account" description="Who you are signed in as, the phones on your account, and what your role lets you do.">
    <Section title="Profile" description="Your name, email and picture come from the account you sign in with, so they can’t be edited here.">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar className="size-10" aria-label={name}>
          {user?.image ? <AvatarImage src={user.image} alt="" /> : null}
          <AvatarFallback className="bg-[var(--berry-accent-soft)] text-md font-semibold text-foreground">{initials(name, user?.email)}</AvatarFallback>
        </Avatar>
        <div className="grid min-w-0 gap-0.5">
          <strong className="truncate text-md font-medium text-foreground">{name}</strong>
          <span className="truncate text-xs text-muted-foreground">{user?.email ?? "No email available"}</span>
        </div>
      </div>
    </Section>
    <MobileDevicesSection
      resourceKey={`mobile-devices:${tenantId}:${user?.id ?? "anonymous"}`}
      description="Phones signed in with the Berry app. Signing one out takes effect the next time it connects."
      emptyText="Choose Get the mobile app in the sidebar to sign in on your phone."
      load={() => pairing.listDevices()}
      revoke={(deviceId) => pairing.revokeDevice(deviceId)}
    />
    <AsyncState loading={access.loading} error={access.error} onRetry={access.retry} skeleton={<AccountAccessSkeleton rows={groups.length} />}>
      <Section
        title="Organization access"
        description="What your role allows in this organization. An organization owner can change your role."
        actions={<StatusPill tone="neutral">{humanize(access.data?.role ?? "Unknown")}</StatusPill>}
      >
        {groups.length
          ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <FillHeightScroller>
                <DefinitionList bare items={groups.map((group) => ({ term: group.area, detail: group.actions.join(", ") }))} />
              </FillHeightScroller>
            </div>
          )
          : <p className="text-xs text-muted-foreground">Your role has no administrative permissions. You can still use Berry for your own tasks.</p>}
      </Section>
    </AsyncState>
  </ManagementPage>;
}

/** `usage:export` → area "Usage", action "Export"; one row per area. */
function permissionGroups(permissions: readonly string[]): Array<{ area: string; actions: string[] }> {
  const groups = new Map<string, string[]>();
  for (const permission of permissions) {
    const [area = permission, ...rest] = permission.split(":");
    const action = humanize(rest.join(" ") || "access");
    const key = AREA_LABELS[area] ?? humanize(area);
    const actions = groups.get(key) ?? [];
    if (!actions.includes(action)) actions.push(action);
    groups.set(key, actions);
  }
  return [...groups].map(([area, actions]) => ({ area, actions })).sort((left, right) => left.area.localeCompare(right.area));
}

const AREA_LABELS: Record<string, string> = { mcp: "MCP servers", sso: "Single sign-on", scim: "SCIM provisioning", org: "Organization" };

function humanize(value: string): string {
  const text = value.replace(/[_\-.]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Unknown";
}

function initials(name: string, email?: string | null): string {
  const source = name === "Unnamed account" ? email?.split("@")[0] ?? "B" : name;
  return source.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "B";
}
