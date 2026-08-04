import { Mail, ShieldCheck, UserRound } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@berry/desktop-ui/components/ui/avatar";
import { AsyncState, ManagementPage, Section } from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

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

  return <ManagementPage title="Account" description="Your signed-in identity and effective organization access.">
    <Section title="Profile">
      <div className="flex items-center gap-4 rounded-xl border border-[var(--berry-border-subtle)] bg-[var(--berry-surface-under)] p-4">
        <Avatar className="size-12" aria-label={name}>
          {user?.image ? <AvatarImage src={user.image} alt="" /> : null}
          <AvatarFallback className="bg-[var(--berry-accent-soft)] font-semibold text-[var(--berry-text-primary)]">{initials(name, user?.email)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-sm font-semibold text-foreground">{name}</strong>
          <span className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground"><Mail className="size-3.5" aria-hidden />{user?.email ?? "No email available"}</span>
        </div>
        <span className="hidden items-center gap-1.5 rounded-md border border-[var(--berry-border)] bg-[var(--berry-control-bg)] px-2 py-1 text-xs text-[var(--berry-text-secondary)] sm:inline-flex"><UserRound className="size-3.5" aria-hidden />View only</span>
      </div>
    </Section>
    <AsyncState loading={access.loading} error={access.error} onRetry={access.retry}>
      <Section title="Effective access" description={`Role: ${access.data?.role ?? "Unknown"}. Permissions are enforced by the server.`}>
        <div className="flex flex-wrap gap-1.5">
          {(access.data?.permissions ?? []).map((permission: string) => <code className="rounded-md border border-[var(--berry-border-strong)] bg-[var(--berry-accent-soft)] px-2 py-1 text-xs font-medium text-[var(--berry-text-primary)]" key={permission}>{permission}</code>)}
        </div>
        {(access.data?.permissions ?? []).length === 0 ? <p className="text-xs text-muted-foreground">No organization permissions are assigned.</p> : null}
      </Section>
    </AsyncState>
  </ManagementPage>;
}

function initials(name: string, email?: string | null): string {
  const source = name === "Unnamed account" ? email?.split("@")[0] ?? "B" : name;
  return source.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "B";
}
