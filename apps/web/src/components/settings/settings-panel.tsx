import * as React from "react";
import { CreditCard, Settings } from "lucide-react";
import { type BerryApiClient } from "@berry/api-client";
import type { OrgMembership, OrgPermission } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { ShieldCheck } from "@berry/desktop-ui/lib/icons";
import { toast } from "sonner";
import type { WebConfig } from "@/lib/config";
import { applyDocumentTheme, DEFAULT_BERRY_THEME, normalizeThemePreference } from "@/lib/theme";
import { WEB_SETTINGS_NAV, type SettingsTab } from "../shell/web-sidebar";
import { InheritedMcpSettings, OrganizationCapabilitiesSettings, PersonalMcpSettings, PersonalSkillsSettings } from "./personal-capabilities";

export function SettingsPanel({
  config,
  client,
  activeOrganizationId,
  onOrganizationChange,
  tab,
  onAdminChanged,
  onUsePrompt,
  error,
}: {
  config: WebConfig;
  client: BerryApiClient | null;
  activeOrganizationId: string;
  onOrganizationChange: (organizationId: string) => void;
  tab: SettingsTab;
  onAdminChanged: () => Promise<void>;
  onUsePrompt: (prompt: string) => void;
  error?: string | undefined;
}) {
  const [customInstructions, setCustomInstructions] = useStoredSetting("berry.web.customInstructions", "");
  const [reviewPrompt, setReviewPrompt] = useStoredSetting("berry.web.reviewPrompt", "Review this change for correctness, regressions, and missing tests.");
  const [theme, setTheme] = useStoredSetting("berry.web.theme", DEFAULT_BERRY_THEME);
  const [language, setLanguage] = useStoredSetting("berry.web.language", "system");
  const [queueMessages, setQueueMessages] = useStoredSetting("berry.web.queueMessages", "true");
  const [showReasoning, setShowReasoning] = useStoredSetting("berry.web.showReasoning", "false");
  const [analytics, setAnalytics] = useStoredSetting("berry.web.analytics", "false");
  const roles = config.rolePermissions.filter((role) => role.tenantId === activeOrganizationId);
  const organizationRole = config.organizations.find((organization) => organization.id === activeOrganizationId)?.role ?? "member";
  const [effectivePermissions, setEffectivePermissions] = React.useState<OrgPermission[] | null>(null);
  React.useEffect(() => {
    setEffectivePermissions(null);
    if (!client) return;
    void client.effectivePermissions(activeOrganizationId).then((result) => setEffectivePermissions(result.permissions)).catch(() => setEffectivePermissions([]));
  }, [activeOrganizationId, client]);
  const permissions = effectivePermissions ?? roles.find((entry) => entry.role === organizationRole)?.permissions ?? [];
  const hasPermission = (permission: OrgPermission) => permissions.includes(permission);
  const canAdmin = hasPermission("org:admin") || hasPermission("budgets:write") || hasPermission("models:write") || hasPermission("policy:write") || hasPermission("skills:write") || hasPermission("mcp:write");
  const flags = config.featureFlags.filter((flag) => flag.tenantId === activeOrganizationId && flag.enabled);
  const departments = config.departments.filter((department) => department.tenantId === activeOrganizationId && department.status === "active");
  const ssoConnections = config.ssoConnections.filter((connection) => connection.tenantId === activeOrganizationId);
  const resourceAcls = config.resourceAcls.filter((acl) => acl.tenantId === activeOrganizationId);
  const budgetLimits = config.budgetLimits.filter((limit) => limit.tenantId === activeOrganizationId && limit.status === "active");
  const usageDashboard = config.usageDashboards.find((dashboard) => dashboard.tenantId === activeOrganizationId);
  const billingSummary = config.billingSummaries.find((summary) => summary.tenantId === activeOrganizationId) ?? null;
  const modelPolicies = config.modelPolicies.filter((policy) => policy.tenantId === activeOrganizationId);
  const policyVersions = config.policyVersions.filter((policy) => policy.tenantId === activeOrganizationId);
  const auditSettings = config.auditSettings.find((settings) => settings.tenantId === activeOrganizationId) ?? null;
  const auditEvents = config.auditEvents.filter((event) => event.tenantId === activeOrganizationId);
  const auditExports = config.auditExports.filter((auditExport) => auditExport.tenantId === activeOrganizationId);
  const platformTenant = config.platformTenants.find((tenant) => tenant.id === activeOrganizationId) ?? null;
  const activePolicyVersion = policyVersions.find((policy) => policy.status === "active") ?? null;
  const allowedModelCount = modelPolicies.filter((policy) => policy.status === "allowed").length;
  const blockedModelCount = modelPolicies.filter((policy) => policy.status === "blocked").length;
  const codeDefault = config.modelDefaults.find((entry) => entry.tenantId === activeOrganizationId && entry.mode === "code");
  const topFeature = usageDashboard?.byFeature[0] ?? null;
  const topModel = usageDashboard?.byModel[0] ?? null;
  const latestBurn = usageDashboard?.burnDown.at(-1) ?? null;
  if (tab === "general") {
    return (
      <div className="berry-settings-content">
        <h1>General</h1>
        {error ? <div className="composer-error" role="alert">{error} <Button size="sm" variant="ghost" onClick={() => void onAdminChanged()}>Retry</Button></div> : null}
        <div className="berry-settings-card">
          <label><span><strong>Organization</strong><small>Choose the cloud organization whose policy and usage settings are shown.</small></span><select aria-label="Organization" value={activeOrganizationId} onChange={(event) => onOrganizationChange(event.currentTarget.value)}>{config.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
          <label><span><strong>App theme</strong><small>Choose how Berry appears in this browser.</small></span><select value={theme} onChange={(event) => { const value = event.currentTarget.value; setTheme(value); applyDocumentTheme(normalizeThemePreference(value)); }}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
          <label><span><strong>Language</strong><small>Choose the display language used by the interface.</small></span><select value={language} onChange={(event) => { setLanguage(event.currentTarget.value); document.documentElement.lang = event.currentTarget.value === "system" ? navigator.language : event.currentTarget.value; }}><option value="system">System default</option><option value="en">English</option></select></label>
        </div>
        <div className="berry-settings-card">
          <label><span><strong>Queue messages</strong><small>Messages sent while Berry works are delivered as follow-ups.</small></span><input type="checkbox" checked={queueMessages === "true"} onChange={(event) => setQueueMessages(String(event.currentTarget.checked))} /></label>
          <label><span><strong>Show reasoning</strong><small>Show expandable reasoning summaries in the thread.</small></span><input type="checkbox" checked={showReasoning === "true"} onChange={(event) => setShowReasoning(String(event.currentTarget.checked))} /></label>
        </div>
        <div className="berry-settings-card berry-settings-editor-card">
          <label><span><strong>Custom instructions</strong><small>Instructions included with every new task in this browser.</small></span></label>
          <textarea aria-label="Custom instructions" value={customInstructions} onChange={(event) => setCustomInstructions(event.currentTarget.value)} placeholder="Add preferences for how Berry should work and respond…" />
        </div>
      </div>
    );
  }
  if (tab === "prompts") {
    return (
      <div className="berry-settings-content">
        <h1>Prompts</h1>
        <p className="berry-settings-description">Edit reusable prompts that can be inserted from the composer.</p>
        <div className="berry-settings-card berry-settings-editor-card">
          <label><span><strong>Review changes</strong><small>Default prompt used for a focused code review.</small></span></label>
          <textarea aria-label="Review changes prompt" value={reviewPrompt} onChange={(event) => setReviewPrompt(event.currentTarget.value)} />
          <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={() => setReviewPrompt("Review this change for correctness, regressions, and missing tests.")}>Reset</Button><Button size="sm" variant="secondary" onClick={() => onUsePrompt(reviewPrompt)}>Use in composer</Button></div>
        </div>
      </div>
    );
  }
  if (tab === "privacy") {
    return <div className="berry-settings-content"><h1>Permissions and privacy</h1><p className="berry-settings-description">Conversation presentation never changes permissions. Approval, sandbox, and network policy remain independent controls.</p><div className="berry-settings-card"><label><span><strong>Product analytics</strong><small>Opt in to anonymous browser usage diagnostics. Conversation content is excluded.</small></span><input type="checkbox" checked={analytics === "true"} onChange={(event) => setAnalytics(String(event.currentTarget.checked))} /></label><div className="settings-row"><strong>Organization policy</strong><span>{permissions.length ? `${permissions.length} effective permissions from the API` : client ? "Permission data unavailable" : "Demo deployment policy"}</span></div><div className="settings-row"><strong>Browser storage</strong><span>Theme, composer preferences, and custom instructions stay in this browser. Organization credentials are never stored here.</span></div></div></div>;
  }
  if (tab === "usage") {
    return <div className="berry-settings-content"><h1>Usage</h1><p className="berry-settings-description">Your current organization usage and budget status.</p><div className="berry-settings-card"><div className="settings-row"><strong>Requests</strong><span>{(usageDashboard?.totals.requests ?? 0).toLocaleString("en-US")}</span></div><div className="settings-row"><strong>Spend</strong><span>{formatMicros(usageDashboard?.totals.costBilledMicros ?? "0")}</span></div><div className="settings-row"><strong>Monthly budget</strong><span>{budgetLimits[0] ? `${formatMicros(budgetLimits[0].hardLimitMicros)} hard limit` : "No active limit"}</span></div>{client && hasPermission("budgets:read") ? <Button size="sm" variant="secondary" onClick={() => void client.exportUsageCsv(activeOrganizationId).then((csv) => downloadText(csv, `berry-usage-${activeOrganizationId}.csv`, "text/csv")).catch((cause) => toast.error(cause instanceof Error ? cause.message : "Usage export failed"))}>Export CSV</Button> : null}</div></div>;
  }
  return (
    <div className="panel-stack">
      {error ? <div className="composer-error" role="alert">{error} <Button size="sm" variant="ghost" onClick={() => void onAdminChanged()}>Retry</Button></div> : null}
      <div className="panel-card">
        <h1 className="berry-cloud-settings-title">{WEB_SETTINGS_NAV.find((item) => item.id === tab)?.label ?? "Settings"}</h1>
        <div className="settings-list">
          {tab === "providers" ? config.providers.map((provider) => (
            <div className="settings-row" key={provider.id}>
              <strong><span className="status-dot" /> {provider.name}</strong>
              <span>{provider.kind} · {provider.defaultModel} · {provider.enabled ? "enabled" : "disabled"}</span>
            </div>
          )) : null}
          {tab === "mcp" ? <><InheritedMcpSettings client={client} tenantId={activeOrganizationId} /><PersonalMcpSettings client={client} fallback={config.mcpServers} /></> : null}
          {tab === "skills" ? <PersonalSkillsSettings client={client} fallback={config.skills} tenantId={activeOrganizationId} /> : null}
          {tab === "governance" ? (
            <div className="governance-panel" data-testid="governance-panel">
              <div className="governance-summary">
                <strong><ShieldCheck size={15} aria-hidden /> Admin console</strong>
                <span>{pluralize(roles.length, "role")} · {pluralize(departments.length, "department")} · {pluralize(ssoConnections.length, "SSO connection")} · {pluralize(budgetLimits.length, "budget limit")} · {billingSummary ? formatMicros(billingSummary.prepaidBalanceMicros) : "$0"} credits · {pluralize(allowedModelCount, "allowed model")} · {pluralize(policyVersions.length, "policy version")} · {pluralize(usageDashboard?.totals.requests ?? 0, "usage event")} · {pluralize(auditEvents.length, "audit event")}</span>
              </div>
              {client && (hasPermission("skills:write") || hasPermission("mcp:write")) ? <OrganizationCapabilitiesSettings client={client} tenantId={activeOrganizationId} /> : null}
              {client && canAdmin ? <CloudAdminControls config={config} client={client} tenantId={activeOrganizationId} permissions={permissions} onSaved={onAdminChanged} /> : null}
              {client && canAdmin ? <CloudGovernanceMutations config={config} client={client} tenantId={activeOrganizationId} permissions={permissions} onSaved={onAdminChanged} /> : null}
              <div className="admin-section">
                <div className="admin-section-heading">
                  <strong><CreditCard size={15} aria-hidden /> Billing</strong>
                  <span>{billingSummary ? `${billingSummary.provider} provider · ${billingSummary.providerConfigured ? "configured" : "pending"} · ${billingSummary.billingDependencyRequired ? "required" : "optional"}` : "no billing record"}</span>
                </div>
                {billingSummary ? (
                  <>
                    <div className="settings-row">
                      <strong>Prepaid credits</strong>
                      <span>{formatMicros(billingSummary.prepaidBalanceMicros)} remaining · {pluralize(billingSummary.activeGrants.length, "active grant")}</span>
                    </div>
                    {billingSummary.activeGrants.slice(0, 2).map((grant) => (
                      <div className="settings-row" key={grant.id}>
                        <strong>{grant.source} credit grant</strong>
                        <span>{formatMicros(grant.remainingMicros)} remaining of {formatMicros(grant.amountMicros)} · {grant.externalRef ?? "manual"}</span>
                      </div>
                    ))}
                    {billingSummary.recentMeterEvents.slice(0, 2).map((event) => (
                      <div className="settings-row" key={event.id}>
                        <strong>Stripe meters</strong>
                        <span>{event.meter} · {event.status} · {Number(event.quantity).toLocaleString("en-US")} units · {formatMicros(event.costBilledMicros)}</span>
                      </div>
                    ))}
                    {billingSummary.invoices.slice(0, 2).map((invoice) => (
                      <div className="settings-row" key={invoice.id}>
                        <strong>Invoice {invoice.externalInvoiceId ?? invoice.id}</strong>
                        <span>{invoice.status} · {formatMicros(invoice.totalMicros)} · {invoice.hostedInvoiceUrl ?? "no hosted URL"}</span>
                      </div>
                    ))}
                  </>
                ) : null}
              </div>
              <div className="admin-section">
                <div className="admin-section-heading">
                  <strong>Identity and access</strong>
                  <span>{flags.length} enabled flags · {resourceAcls.length} ACL entries</span>
                </div>
                {departments.map((department) => (
                  <div className="settings-row" key={department.id}>
                    <strong>{department.name} department</strong>
                    <span>{department.parentId ? `child of ${department.parentId}` : "top-level"} · slug {department.slug}</span>
                  </div>
                ))}
                {ssoConnections.map((connection) => (
                  <div className="settings-row" key={connection.id}>
                    <strong>{connection.displayName}</strong>
                    <span>{connection.kind.toUpperCase()} · {connection.status} · SCIM {connection.scimEnabled ? "enabled" : "disabled"} · {connection.domains.join(", ") || "no domains"}</span>
                  </div>
                ))}
                {roles.map((role) => (
                  <div className="settings-row" key={role.role}>
                    <strong>{role.role}</strong>
                    <span>{role.permissions.slice(0, 4).join(", ")}{role.permissions.length > 4 ? ` +${role.permissions.length - 4}` : ""}</span>
                  </div>
                ))}
                {flags.map((flag) => (
                  <div className="settings-row" key={flag.flag}>
                    <strong>{flag.flag}</strong>
                    <span>{Object.keys(flag.roleDefaults).join(", ")} seeded</span>
                  </div>
                ))}
                {resourceAcls.map((acl) => (
                  <div className="settings-row" key={acl.id}>
                    <strong>{acl.resourceType}:{acl.resourceId} ACL</strong>
                    <span>{acl.principalType} {acl.principalId} · allow {acl.allow.join(", ") || "none"} · deny {acl.deny.join(", ") || "none"}</span>
                  </div>
                ))}
              </div>
              <div className="admin-section">
                <div className="admin-section-heading">
                  <strong>Budgets and usage</strong>
                  <span>{usageDashboard ? formatMicros(usageDashboard.totals.costBilledMicros) : "$0"} billed this window</span>
                </div>
                {budgetLimits.map((limit) => (
                  <div className="settings-row" key={limit.id}>
                    <strong>Budget hard limit</strong>
                    <span>{formatMicros(limit.hardLimitMicros)} / {limit.period} · {limit.scopeType}</span>
                  </div>
                ))}
                {usageDashboard ? (
                  <>
                    <div className="settings-row">
                      <strong>Usage spend</strong>
                      <span>{formatMicros(usageDashboard.totals.costBilledMicros)} · {(usageDashboard.totals.tokensIn + usageDashboard.totals.tokensOut).toLocaleString("en-US")} tokens</span>
                    </div>
                    {topFeature ? (
                      <div className="settings-row">
                        <strong>Feature drill-down</strong>
                        <span>{topFeature.feature} · {topFeature.requests} requests · {formatMicros(topFeature.costBilledMicros)}</span>
                      </div>
                    ) : null}
                    {topModel ? (
                      <div className="settings-row">
                        <strong>Model drill-down</strong>
                        <span>{topModel.model} · {topModel.tokens.toLocaleString("en-US")} tokens · {formatMicros(topModel.costBilledMicros)}</span>
                      </div>
                    ) : null}
                    {latestBurn ? (
                      <div className="settings-row">
                        <strong>Burn-down</strong>
                        <span>{latestBurn.date} · {latestBurn.requests} requests · {formatMicros(latestBurn.costBilledMicros)}</span>
                      </div>
                    ) : null}
                    <div className="settings-row">
                      <strong>CSV export</strong>
                      <span>/v1/orgs/{activeOrganizationId}/usage/export.csv</span>
                    </div>
                  </>
                ) : null}
              </div>
              <div className="admin-section">
                <div className="admin-section-heading">
                  <strong>Models and policy</strong>
                  <span>{allowedModelCount} allowed · {blockedModelCount} blocked · {modelPolicies.filter((policy) => policy.enforce).length} enforced</span>
                </div>
                {codeDefault ? (
                  <div className="settings-row">
                    <strong>Code model default</strong>
                    <span>{codeDefault.providerId} · {codeDefault.model} · {codeDefault.enforce ? "enforced" : "suggested"}</span>
                  </div>
                ) : null}
                {modelPolicies[0] ? (
                  <div className="settings-row">
                    <strong>Model allow-list</strong>
                    <span>{allowedModelCount} allowed · {blockedModelCount} blocked · {modelPolicies.filter((policy) => policy.enforce).length} enforced</span>
                  </div>
                ) : null}
                {activePolicyVersion ? (
                  <div className="settings-row">
                    <strong>Managed policy</strong>
                    <span>v{activePolicyVersion.version} · {activePolicyVersion.keyId} · {activePolicyVersion.locks.join(", ")} · {activePolicyVersion.bundlePath}</span>
                  </div>
                ) : null}
              </div>
              <div className="admin-section">
                <div className="admin-section-heading">
                  <strong>Audit and retention</strong>
                  <span>{auditSettings ? `${auditSettings.retentionDays} day retention` : "no retention policy"} · {auditExports.length} SIEM exports</span>
                </div>
                {auditSettings ? (
                  <div className="settings-row">
                    <strong>Client audit ingestion</strong>
                    <span>{auditSettings.clientIngestEnabled ? "opt-in enabled by policy" : "disabled by policy"} · updated {formatShortDate(auditSettings.updatedAt)}</span>
                  </div>
                ) : null}
                {auditExports.map((auditExport) => (
                  <div className="settings-row" key={auditExport.id}>
                    <strong>{auditExport.kind.toUpperCase()} SIEM export</strong>
                    <span>{auditExport.status} · {auditExport.format.toUpperCase()} · {auditExport.destination} · last {auditExport.lastExportedAt ? formatShortDate(auditExport.lastExportedAt) : "pending"}</span>
                  </div>
                ))}
                {auditEvents.slice(-3).map((event) => (
                  <div className="settings-row" key={event.id}>
                    <strong>#{event.sequence} {event.category}.{event.action}</strong>
                    <span>{event.targetType ?? "target"} {event.targetId ?? "-"} · {event.actorUserId ?? "system"} · {formatShortDate(event.ts)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {tab === "platform" && config.platformAuthorized ? (
            <div className="governance-panel" data-testid="platform-admin-panel">
              <div className="governance-summary">
                <strong><ShieldCheck size={15} aria-hidden /> Platform super-admin</strong>
                <span>{config.deploymentMode} · {pluralize(config.platformUsage.tenants, "tenant")} · {pluralize(config.platformUsage.activeTenants, "active tenant")} · {formatMicros(config.platformUsage.totalSpendMicros)} cross-tenant spend · {formatMicros(totalPrepaidCredits(config.billingSummaries))} prepaid credits · {pluralize(config.platformUsage.totalUsageEvents, "usage event")}</span>
              </div>
              <div className="admin-section">
                <div className="admin-section-heading">
                  <strong>Tenant lifecycle</strong>
                  <span>{config.platformTenants.filter((tenant) => tenant.lifecycle === "provisioning").length} provisioning · {config.platformTenants.filter((tenant) => tenant.lifecycle === "suspended").length} suspended</span>
                </div>
                {config.platformTenants.map((tenant) => (
                  <div className="settings-row" key={tenant.id}>
                    <strong>{tenant.name}</strong>
                    <span>{tenant.lifecycle} · {tenant.deploymentMode} · {tenant.hostname ?? "no hostname"} · {tenant.region} · {tenant.seats} seats</span>
                  </div>
                ))}
              </div>
              <div className="admin-section">
                <div className="admin-section-heading">
                  <strong>Cross-tenant usage</strong>
                  <span>{formatShortDate(config.platformUsage.from)} to {formatShortDate(config.platformUsage.to)}</span>
                </div>
                {config.platformUsage.topTenants.map((tenant) => (
                  <div className="settings-row" key={tenant.tenantId}>
                    <strong>{tenant.tenantName}</strong>
                    <span>{formatMicros(tenant.spendMicros)} · {pluralize(tenant.usageEvents, "usage event")}</span>
                  </div>
                ))}
              </div>
              <div className="admin-section">
                <div className="admin-section-heading">
                  <strong>Billing operations</strong>
                  <span>{pluralize(config.billingSummaries.filter((summary) => summary.provider === "stripe").length, "Stripe tenant")} · {config.billingSummaries.filter((summary) => summary.billingDependencyRequired && !summary.providerConfigured).length} pending setup</span>
                </div>
                {config.billingSummaries.map((summary) => (
                  <div className="settings-row" key={summary.tenantId}>
                    <strong>{config.platformTenants.find((tenant) => tenant.id === summary.tenantId)?.name ?? summary.tenantId}</strong>
                    <span>{summary.provider} · {summary.providerConfigured ? "configured" : "pending"} · {formatMicros(summary.prepaidBalanceMicros)} credits · {pluralize(summary.recentMeterEvents.length, "meter event")}</span>
                  </div>
                ))}
              </div>
              {platformTenant ? (
                <div className="admin-section">
                  <div className="admin-section-heading">
                    <strong>Selected tenant</strong>
                    <span>{platformTenant.slug} · {platformTenant.plan}</span>
                  </div>
                  <div className="settings-row">
                    <strong>{platformTenant.name} lifecycle</strong>
                    <span>{platformTenant.lifecycle} · {formatMicros(platformTenant.monthlySpendMicros)} this month · updated {formatShortDate(platformTenant.updatedAt)}</span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : tab === "platform" ? <div className="composer-error" role="alert">Platform authorization is required.</div> : null}
        </div>
      </div>
    </div>
  );
}

function useStoredSetting(key: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = React.useState(fallback);
  React.useEffect(() => {
    const stored = window.localStorage.getItem(key);
    if (stored !== null) setValue(stored);
  }, [key]);
  const update = React.useCallback((next: string) => {
    setValue(next);
    window.localStorage.setItem(key, next);
    window.dispatchEvent(new CustomEvent("berry:web-setting", { detail: { key, value: next } }));
  }, [key]);
  return [value, update];
}

function CloudAdminControls({ config, client, tenantId, permissions, onSaved }: { config: WebConfig; client: BerryApiClient; tenantId: string; permissions: OrgPermission[]; onSaved: () => Promise<void> }) {
  const provider = config.providers.find((item) => item.enabled) ?? config.providers[0];
  const availableModels = provider?.models ?? [];
  const [selectedModel, setSelectedModel] = React.useState(availableModels[0]?.id ?? provider?.defaultModel ?? "");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [members, setMembers] = React.useState<OrgMembership[]>([]);
  const [membersLoading, setMembersLoading] = React.useState(true);
  const [newRole, setNewRole] = React.useState<"member" | "admin">("member");
  const [newUserBudget, setNewUserBudget] = React.useState("15");
  const [memberBudgets, setMemberBudgets] = React.useState<Record<string, string>>({});
  const existingPolicy = config.modelPolicies.find((policy) => policy.tenantId === tenantId && policy.providerId === provider?.id && policy.model === selectedModel);
  const existingBudget = config.budgetLimits.find((limit) => limit.tenantId === tenantId && limit.scopeType === "org" && limit.period === "month");
  const [organizationBudget, setOrganizationBudget] = React.useState(() => existingBudget ? String(Number(BigInt(existingBudget.hardLimitMicros) / 1_000_000n)) : "100");
  const [modelDisplayName, setModelDisplayName] = React.useState("");
  const [modelStatus, setModelStatus] = React.useState<"allowed" | "blocked">("allowed");
  const [modelEnforced, setModelEnforced] = React.useState(true);
  const [makeDefault, setMakeDefault] = React.useState(false);

  React.useEffect(() => {
    setModelDisplayName(existingPolicy?.displayName ?? availableModels.find((item) => item.id === selectedModel)?.name ?? "");
    setModelStatus(existingPolicy?.status ?? "allowed");
    setModelEnforced(existingPolicy?.enforce ?? true);
    setMakeDefault(false);
  }, [availableModels, existingPolicy, selectedModel]);
  React.useEffect(() => { setOrganizationBudget(existingBudget ? String(Number(BigInt(existingBudget.hardLimitMicros) / 1_000_000n)) : "100"); }, [existingBudget]);

  const refreshMembers = React.useCallback(async () => {
    setMembersLoading(true);
    try {
      setMembers(await client.listOrgMembers(tenantId));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to load organization users");
    } finally {
      setMembersLoading(false);
    }
  }, [client, tenantId]);

  React.useEffect(() => {
    void refreshMembers();
  }, [refreshMembers]);

  const createMember = React.useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const budgetDollars = Number(form.get("budgetDollars"));
    if (!Number.isFinite(budgetDollars) || budgetDollars <= 0) {
      setMessage("Enter a user budget greater than zero.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const member = await client.createOrgMember(tenantId, {
        email: String(form.get("email") ?? "").trim(),
        name: String(form.get("name") ?? "").trim(),
        password: String(form.get("password") ?? ""),
        role: form.get("role") === "admin" ? "admin" : "member",
      });
      await client.upsertBudgetLimit(tenantId, {
        scopeType: "user",
        scopeId: member.userId,
        period: "month",
        softLimitMicros: String(Math.round(budgetDollars * 0.8 * 1_000_000)),
        hardLimitMicros: String(Math.round(budgetDollars * 1_000_000)),
        status: "active",
      });
      formElement.reset();
      setNewRole("member");
      setNewUserBudget("15");
      await Promise.all([onSaved(), refreshMembers()]);
      setMessage(`${member.name || member.email} can now sign in. Their monthly limit is $${budgetDollars.toLocaleString("en-US")}.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to create the user");
    } finally {
      setBusy(false);
    }
  }, [client, onSaved, refreshMembers, tenantId]);

  const saveMemberBudget = React.useCallback(async (event: React.FormEvent<HTMLFormElement>, member: OrgMembership) => {
    event.preventDefault();
    const dollars = Number(new FormData(event.currentTarget).get("hardLimitDollars"));
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setMessage("Enter a user budget greater than zero.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await client.upsertBudgetLimit(tenantId, {
        scopeType: "user",
        scopeId: member.userId,
        period: "month",
        softLimitMicros: String(Math.round(dollars * 0.8 * 1_000_000)),
        hardLimitMicros: String(Math.round(dollars * 1_000_000)),
        status: "active",
      });
      await onSaved();
      setMessage(`${member.name || member.email}'s monthly limit is now $${dollars.toLocaleString("en-US")}.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save the user budget");
    } finally {
      setBusy(false);
    }
  }, [client, onSaved, tenantId]);

  const saveBudget = React.useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const dollars = Number(form.get("hardLimitDollars"));
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setMessage("Enter a monthly limit greater than zero.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const hardLimitMicros = String(Math.round(dollars * 1_000_000));
      const softLimitMicros = String(Math.round(dollars * 0.8 * 1_000_000));
      await client.upsertBudgetLimit(tenantId, { scopeType: "org", scopeId: tenantId, period: "month", softLimitMicros, hardLimitMicros, status: "active" });
      await onSaved();
      setMessage("Monthly budget saved.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save the budget");
    } finally {
      setBusy(false);
    }
  }, [client, onSaved, tenantId]);

  const saveModel = React.useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!provider || !selectedModel) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      await client.upsertOrgModelPolicy(tenantId, {
        providerId: provider.id,
        model: selectedModel,
        displayName: String(form.get("displayName") ?? "").trim() || null,
        status: form.get("status") === "blocked" ? "blocked" : "allowed",
        enforce: form.get("enforce") === "on",
        modeAllow: ["chat", "code"],
      });
      if (form.get("makeDefault") === "on") {
        await Promise.all((["chat", "code"] as const).map((mode) => client.upsertOrgModelDefault(tenantId, mode, {
          providerId: provider.id,
          model: selectedModel,
          enforce: form.get("enforce") === "on",
        })));
      }
      await onSaved();
      setMessage("Model policy saved.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to save the model policy");
    } finally {
      setBusy(false);
    }
  }, [client, onSaved, provider, selectedModel, tenantId]);

  return (
    <div className="admin-edit-grid" aria-label="Administration controls">
      {permissions.includes("org:admin") ? <form className="admin-edit-form" onSubmit={(event) => void createMember(event)}>
        <strong>Create user</strong>
        <label>Name<input name="name" autoComplete="name" required maxLength={100} /></label>
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        <label>Temporary password<input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} /></label>
        <label>Role<select name="role" value={newRole} onChange={(event) => setNewRole(event.currentTarget.value as "member" | "admin")}><option value="member">Member</option><option value="admin">Admin</option></select></label>
        <label>Monthly limit (USD)<input name="budgetDollars" type="number" min="1" step="1" value={newUserBudget} onChange={(event) => setNewUserBudget(event.currentTarget.value)} required /></label>
        <span>The user can sign in immediately. Share the temporary password through a secure channel.</span>
        <button type="submit" disabled={busy}>Create user</button>
      </form> : null}
      {permissions.includes("org:read") ? <div className="admin-edit-form admin-member-panel">
        <strong>Users and monthly limits</strong>
        {membersLoading ? <span>Loading users…</span> : members.length === 0 ? <span>No users found.</span> : members.map((member) => {
          const limit = config.budgetLimits.find((entry) => entry.tenantId === tenantId && entry.scopeType === "user" && entry.scopeId === member.userId && entry.period === "month");
          const dollars = limit ? Number(BigInt(limit.hardLimitMicros) / 1_000_000n) : 15;
          return (
            <form className="admin-member-row" key={member.userId} onSubmit={(event) => void saveMemberBudget(event, member)}>
              <div><strong>{member.name || member.email}</strong><span>{member.email} · {member.role}</span></div>
              <label>USD<input name="hardLimitDollars" type="number" min="1" step="1" value={memberBudgets[member.userId] ?? String(dollars)} onChange={(event) => setMemberBudgets((current) => ({ ...current, [member.userId]: event.currentTarget.value }))} /></label>
              <button type="submit" disabled={busy}>Save</button>
            </form>
          );
        })}
      </div> : null}
      {permissions.includes("budgets:write") ? <form className="admin-edit-form" onSubmit={(event) => void saveBudget(event)}>
        <strong>Monthly organization budget</strong>
        <label>Hard limit (USD)<input name="hardLimitDollars" type="number" min="1" step="1" value={organizationBudget} onChange={(event) => setOrganizationBudget(event.currentTarget.value)} /></label>
        <span>Berry warns at 80% and blocks new spend at the hard limit.</span>
        <button type="submit" disabled={busy}>Save budget</button>
      </form> : null}
      {permissions.includes("models:write") ? <form className="admin-edit-form" onSubmit={(event) => void saveModel(event)}>
        <strong>Model name and policy</strong>
        <label>Router model<select name="model" value={selectedModel} onChange={(event) => setSelectedModel(event.currentTarget.value)}>{availableModels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Display name<input name="displayName" value={modelDisplayName} onChange={(event) => setModelDisplayName(event.currentTarget.value)} /></label>
        <label>Status<select name="status" value={modelStatus} onChange={(event) => setModelStatus(event.currentTarget.value as "allowed" | "blocked")}><option value="allowed">Allowed</option><option value="blocked">Blocked</option></select></label>
        <label className="check-label"><input name="enforce" type="checkbox" checked={modelEnforced} onChange={(event) => setModelEnforced(event.currentTarget.checked)} /> Enforce this policy</label>
        <label className="check-label"><input name="makeDefault" type="checkbox" checked={makeDefault} onChange={(event) => setMakeDefault(event.currentTarget.checked)} /> Make default for Chat and Code</label>
        <button type="submit" disabled={busy || !selectedModel}>Save model</button>
      </form> : null}
      {message ? <p className="admin-edit-message" role="status">{message}</p> : null}
    </div>
  );
}

const ALL_ORG_PERMISSIONS: OrgPermission[] = ["org:read", "org:admin", "departments:read", "departments:write", "sso:read", "sso:write", "rbac:read", "rbac:write", "feature_flags:read", "feature_flags:write", "acl:read", "acl:write", "budgets:read", "budgets:write", "models:read", "models:write", "policy:read", "policy:write", "audit:read", "audit:export", "skills:read", "skills:write", "mcp:read", "mcp:write"];

function CloudGovernanceMutations({ config, client, tenantId, permissions, onSaved }: { config: WebConfig; client: BerryApiClient; tenantId: string; permissions: OrgPermission[]; onSaved: () => Promise<void> }) {
  const roles = config.rolePermissions.filter((item) => item.tenantId === tenantId);
  const audit = config.auditSettings.find((item) => item.tenantId === tenantId);
  const [departmentName, setDepartmentName] = React.useState("");
  const [role, setRole] = React.useState(roles[0]?.role ?? "member");
  const [rolePermissions, setRolePermissions] = React.useState<OrgPermission[]>(roles[0]?.permissions ?? []);
  const [flagName, setFlagName] = React.useState("");
  const [flagEnabled, setFlagEnabled] = React.useState(true);
  const [acl, setAcl] = React.useState({ resourceType: "workspace", resourceId: "default", principalType: "role" as "role" | "user" | "department", principalId: "member", allow: "org:read", deny: "" });
  const [sso, setSso] = React.useState({ kind: "oidc" as "oidc" | "saml", slug: "", displayName: "", issuer: "", ssoUrl: "", clientId: "", domains: "", scimEnabled: false });
  const [retentionDays, setRetentionDays] = React.useState(String(audit?.retentionDays ?? 90));
  const [clientIngest, setClientIngest] = React.useState(audit?.clientIngestEnabled ?? false);
  const [creditDollars, setCreditDollars] = React.useState("100");
  const run = async (operation: () => Promise<unknown>, success: string) => { try { await operation(); await onSaved(); toast.success(success); } catch (cause) { toast.error(cause instanceof Error ? cause.message : "Organization setting could not be saved"); } };
  React.useEffect(() => { const selected = roles.find((item) => item.role === role); setRolePermissions(selected?.permissions ?? []); }, [role, roles]);

  return <div className="admin-edit-grid" aria-label="Advanced organization controls">
    {permissions.includes("departments:write") ? <form className="admin-edit-form" onSubmit={(event) => { event.preventDefault(); void run(() => client.createDepartment(tenantId, { name: departmentName.trim() }), "Department created").then(() => setDepartmentName("")); }}><strong>Create department</strong><label>Name<input value={departmentName} onChange={(event) => setDepartmentName(event.currentTarget.value)} required /></label><button type="submit" disabled={!departmentName.trim()}>Create department</button></form> : null}
    {permissions.includes("rbac:write") ? <form className="admin-edit-form" onSubmit={(event) => { event.preventDefault(); void run(() => client.updateRolePermissions(tenantId, role, { permissions: rolePermissions, source: "web-admin" }), "Role permissions saved"); }}><strong>Roles and permissions</strong><label>Role<select value={role} onChange={(event) => setRole(event.currentTarget.value)}>{roles.map((item) => <option key={item.role} value={item.role}>{item.role}</option>)}</select></label><div className="capability-review">{ALL_ORG_PERMISSIONS.map((permission) => <label className="check-label" key={permission}><input type="checkbox" checked={rolePermissions.includes(permission)} onChange={(event) => setRolePermissions((current) => event.currentTarget.checked ? [...new Set([...current, permission])] : current.filter((item) => item !== permission))} /> {permission}</label>)}</div><button type="submit">Save role</button></form> : null}
    {permissions.includes("feature_flags:write") ? <form className="admin-edit-form" onSubmit={(event) => { event.preventDefault(); void run(() => client.upsertFeatureFlag(tenantId, flagName.trim(), { enabled: flagEnabled, roleDefaults: {} }), "Feature flag saved").then(() => setFlagName("")); }}><strong>Feature flag</strong><label>Flag<input value={flagName} onChange={(event) => setFlagName(event.currentTarget.value)} required /></label><label className="check-label"><input type="checkbox" checked={flagEnabled} onChange={(event) => setFlagEnabled(event.currentTarget.checked)} /> Enabled</label><button type="submit" disabled={!flagName.trim()}>Save flag</button></form> : null}
    {permissions.includes("acl:write") ? <form className="admin-edit-form" onSubmit={(event) => { event.preventDefault(); const parsePermissions = (value: string) => value.split(",").map((item) => item.trim()).filter((item): item is OrgPermission => ALL_ORG_PERMISSIONS.includes(item as OrgPermission)); void run(() => client.upsertResourceAcl(tenantId, { ...acl, allow: parsePermissions(acl.allow), deny: parsePermissions(acl.deny) }), "Resource ACL saved"); }}><strong>Resource ACL</strong><label>Resource type<input value={acl.resourceType} onChange={(event) => setAcl({ ...acl, resourceType: event.currentTarget.value })} /></label><label>Resource ID<input value={acl.resourceId} onChange={(event) => setAcl({ ...acl, resourceId: event.currentTarget.value })} /></label><label>Principal type<select value={acl.principalType} onChange={(event) => setAcl({ ...acl, principalType: event.currentTarget.value as typeof acl.principalType })}><option value="role">Role</option><option value="user">User</option><option value="department">Department</option></select></label><label>Principal ID<input value={acl.principalId} onChange={(event) => setAcl({ ...acl, principalId: event.currentTarget.value })} /></label><label>Allow (comma-separated)<input value={acl.allow} onChange={(event) => setAcl({ ...acl, allow: event.currentTarget.value })} /></label><label>Deny (comma-separated)<input value={acl.deny} onChange={(event) => setAcl({ ...acl, deny: event.currentTarget.value })} /></label><button type="submit">Save ACL</button></form> : null}
    {permissions.includes("sso:write") ? <form className="admin-edit-form" onSubmit={(event) => { event.preventDefault(); void run(() => client.createSsoConnection(tenantId, { kind: sso.kind, slug: sso.slug.trim(), displayName: sso.displayName.trim(), issuer: sso.issuer || null, ssoUrl: sso.ssoUrl || null, clientId: sso.clientId || null, domains: sso.domains.split(",").map((item) => item.trim()).filter(Boolean), scimEnabled: sso.scimEnabled }), "SSO connection created"); }}><strong>SSO / SCIM</strong><label>Kind<select value={sso.kind} onChange={(event) => setSso({ ...sso, kind: event.currentTarget.value as "oidc" | "saml" })}><option value="oidc">OIDC</option><option value="saml">SAML</option></select></label><label>Slug<input value={sso.slug} onChange={(event) => setSso({ ...sso, slug: event.currentTarget.value })} /></label><label>Display name<input value={sso.displayName} onChange={(event) => setSso({ ...sso, displayName: event.currentTarget.value })} /></label><label>Issuer<input type="url" value={sso.issuer} onChange={(event) => setSso({ ...sso, issuer: event.currentTarget.value })} /></label><label>SSO URL<input type="url" value={sso.ssoUrl} onChange={(event) => setSso({ ...sso, ssoUrl: event.currentTarget.value })} /></label><label>Client ID<input value={sso.clientId} onChange={(event) => setSso({ ...sso, clientId: event.currentTarget.value })} /></label><label>Domains<input value={sso.domains} onChange={(event) => setSso({ ...sso, domains: event.currentTarget.value })} /></label><label className="check-label"><input type="checkbox" checked={sso.scimEnabled} onChange={(event) => setSso({ ...sso, scimEnabled: event.currentTarget.checked })} /> Enable SCIM</label><button type="submit" disabled={!sso.slug || !sso.displayName || !sso.ssoUrl}>Create connection</button></form> : null}
    {permissions.includes("audit:export") ? <form className="admin-edit-form" onSubmit={(event) => { event.preventDefault(); void run(() => client.updateAuditSettings(tenantId, { retentionDays: Number(retentionDays), clientIngestEnabled: clientIngest }), "Audit policy saved"); }}><strong>Audit and retention</strong><label>Retention days<input type="number" min="1" max="3650" value={retentionDays} onChange={(event) => setRetentionDays(event.currentTarget.value)} /></label><label className="check-label"><input type="checkbox" checked={clientIngest} onChange={(event) => setClientIngest(event.currentTarget.checked)} /> Accept opted-in client audit events</label><button type="submit">Save audit policy</button></form> : null}
    {permissions.includes("billing:write") ? <form className="admin-edit-form" onSubmit={(event) => { event.preventDefault(); void run(() => client.createBillingCreditGrant(tenantId, { source: "manual", amountMicros: String(Math.round(Number(creditDollars) * 1_000_000)), currency: "usd", reason: "Manual administrator credit grant", confirmation: true, idempotencyKey: crypto.randomUUID(), metadata: {} }), "Credit grant created"); }}><strong>Billing credit grant</strong><label>USD<input type="number" min="1" step="1" value={creditDollars} onChange={(event) => setCreditDollars(event.currentTarget.value)} /></label><span>This financial mutation is recorded in the organization audit log.</span><button type="submit">Create grant</button></form> : null}
  </div>;
}

export function settledValue<T>(result: PromiseSettledResult<unknown>, fallback: T): T {
  return result.status === "fulfilled" ? result.value as T : fallback;
}

export function replaceTenantValue<T extends { tenantId: string }>(current: T[], tenantId: string, next: T | null): T[] {
  return [...current.filter((item) => item.tenantId !== tenantId), ...(next ? [next] : [])];
}

function formatMicros(value: string): string {
  const dollars = Number(BigInt(value) / 1_000_000n);
  return `$${dollars.toLocaleString("en-US")}`;
}

function totalPrepaidCredits(summaries: WebConfig["billingSummaries"]): string {
  return summaries.reduce((sum, summary) => sum + BigInt(summary.prepaidBalanceMicros), 0n).toString();
}

function downloadText(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

function formatShortDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
