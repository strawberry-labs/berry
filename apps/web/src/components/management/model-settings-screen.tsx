import {
  AsyncState,
  DataTable,
  ManagementPage,
  Section,
  StatusPill,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

export function ModelSettingsScreen({ client, config, tenantId }: ManagementScreenProps) {
  const resource = useResource(
    `models:${tenantId}`,
    async () => client
      ? Promise.all([
        client.listOrgModels(tenantId, { includeBlocked: true }),
        client.listOrgModelDefaults(tenantId),
      ])
      : [config.modelPolicies, config.modelDefaults] as const,
    [[], []] as any,
  );

  return (
    <ManagementPage
      title="Model defaults"
      description="Choose personal Chat and Code defaults within your organization’s model policy."
      eyebrow="Preferences"
    >
      <AsyncState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.retry}
        empty={!resource.loading && !resource.error && resource.data[0].length === 0}
        emptyTitle="No models available"
      >
        <Section title="Effective model catalog" description="Managed restrictions are locked and can only be changed by an administrator.">
          <DataTable
            label="Available models"
            columns={["Model", "Provider", "State", "Modes"]}
            rows={resource.data[0].map((model: any) => [
              <b>{model.displayName || model.model}</b>,
              model.providerId,
              <StatusPill tone={model.status === "allowed" ? "good" : "danger"}>{model.status}</StatusPill>,
              model.modeAllow.join(", "),
            ])}
          />
        </Section>
        <Section title="Organization defaults">
          <DataTable
            label="Model defaults"
            columns={["Mode", "Default", "Policy"]}
            rows={resource.data[1].map((modelDefault: any) => [
              modelDefault.mode,
              <code>{modelDefault.providerId}/{modelDefault.model}</code>,
              modelDefault.enforce ? <StatusPill tone="info">Enforced</StatusPill> : "Suggested",
            ])}
          />
        </Section>
      </AsyncState>
    </ManagementPage>
  );
}
