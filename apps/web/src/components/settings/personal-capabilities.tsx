import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { EffectiveCapability, OrgCapability, OrgCapabilityAssignment, PersonalMcpServer, PersonalSkill, PersonalSkillReview } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { toast } from "sonner";

function InheritedRows({ rows, client, tenantId, onChanged }: { rows: EffectiveCapability[]; client: BerryApiClient | null; tenantId: string; onChanged?: () => void }) {
  if (!rows.length) return null;
  return <div className="settings-list" aria-label="Organization capabilities">{rows.map((row) => (
    <div className="settings-row" key={`${row.kind}:${row.capabilityId}`}>
      <strong>{row.kind === "skill" ? `$${row.name}` : row.name}</strong>
      <span>Organization · {row.assignment} · {row.reason}{row.locked ? " · locked" : ""}</span>
      {!row.locked && client ? <Button size="sm" variant="ghost" onClick={() => void client.setCapabilityOverride(tenantId, row.kind, row.capabilityId, !row.enabled).then(() => onChanged?.()).catch((cause) => toast.error(text(cause)))}>{row.enabled ? "Disable" : "Enable"}</Button> : null}
    </div>
  ))}</div>;
}

export function InheritedMcpSettings({ client, tenantId }: { client: BerryApiClient | null; tenantId: string }) {
  const [rows, setRows] = React.useState<EffectiveCapability[]>([]);
  const load = React.useCallback(() => client?.effectiveCapabilities(tenantId).then((items) => setRows(items.filter((row) => row.kind === "mcp" && row.provenance === "organization"))), [client, tenantId]);
  React.useEffect(() => { void load()?.catch((cause) => toast.error(text(cause))); }, [load]);
  return <InheritedRows rows={rows} client={client} tenantId={tenantId} onChanged={() => void load()} />;
}

export function OrganizationCapabilitiesSettings({ client, tenantId }: { client: BerryApiClient; tenantId: string }) {
  const [records, setRecords] = React.useState<OrgCapability[]>([]);
  const [settings, setSettings] = React.useState({ skills: true, mcp: true });
  const [draft, setDraft] = React.useState({ kind: "skill" as "skill" | "mcp", capabilityId: "", name: "", description: "", assignment: "default-on" as OrgCapabilityAssignment, allowUserDisable: true, content: "", url: "" });
  const load = React.useCallback(async () => { const [nextRecords, nextSettings] = await Promise.all([client.listOrganizationCapabilities(tenantId), client.organizationCapabilitySettings(tenantId)]); setRecords(nextRecords); setSettings(nextSettings); }, [client, tenantId]);
  React.useEffect(() => { void load().catch((cause) => toast.error(text(cause))); }, [load]);
  const save = async () => {
    const config = draft.kind === "skill" ? { content: draft.content } : { url: draft.url, transport: "streamable-http" };
    await client.upsertOrganizationCapability(tenantId, { kind: draft.kind, capabilityId: draft.capabilityId.trim().toLowerCase(), name: draft.name.trim(), description: draft.description.trim(), assignment: draft.assignment, allowUserDisable: draft.allowUserDisable, config });
    setDraft({ kind: "skill", capabilityId: "", name: "", description: "", assignment: "default-on", allowUserDisable: true, content: "", url: "" });
    await load(); toast.success("Organization capability saved");
  };
  const updateSettings = async (next: typeof settings) => { setSettings(await client.updateOrganizationCapabilitySettings(tenantId, next)); toast.success("Personal addition policy saved"); };
  return <div className="admin-section" aria-label="Default Skills and MCP">
    <div className="admin-section-heading"><strong>Default Skills and MCP</strong><span>Required, default-on, available, or blocked for this organization.</span></div>
    <div className="capability-form">
      <label>Type<select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.currentTarget.value as "skill" | "mcp" })}><option value="skill">Skill</option><option value="mcp">MCP</option></select></label>
      <label>Capability ID<input value={draft.capabilityId} onChange={(event) => setDraft({ ...draft, capabilityId: event.currentTarget.value })} /></label>
      <label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></label>
      <label>Description<input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })} /></label>
      <label>Assignment<select value={draft.assignment} onChange={(event) => setDraft({ ...draft, assignment: event.currentTarget.value as OrgCapabilityAssignment })}><option value="required">Required</option><option value="default-on">Default on</option><option value="available">Available</option><option value="blocked">Blocked</option></select></label>
      <label><span>Allow user disable</span><input type="checkbox" checked={draft.allowUserDisable} onChange={(event) => setDraft({ ...draft, allowUserDisable: event.currentTarget.checked })} disabled={draft.assignment === "required" || draft.assignment === "blocked"} /></label>
      {draft.kind === "skill" ? <label>SKILL.md<textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.currentTarget.value })} /></label> : <label>HTTPS URL<input type="url" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.currentTarget.value })} /></label>}
      <Button size="sm" onClick={() => void save().catch((cause) => toast.error(text(cause)))} disabled={!draft.capabilityId.trim() || !draft.name.trim() || (draft.kind === "skill" ? !draft.content : !draft.url)}>Save default</Button>
    </div>
    <div className="settings-list">{records.map((record) => <div className="settings-row" key={record.id}><strong>{record.name}</strong><span>{record.kind} · {record.assignment} · organization{record.contentHash ? ` · ${record.contentHash.slice(0, 10)}…` : ""}</span><Button size="sm" variant="ghost" onClick={() => void client.deleteOrganizationCapability(tenantId, record.id).then(load).catch((cause) => toast.error(text(cause)))}>Delete</Button></div>)}</div>
    <div className="settings-list">
      <label className="settings-row"><span><strong>Personal Skills</strong><small>Allow users to add personal Skills within organization policy.</small></span><input type="checkbox" checked={settings.skills} onChange={(event) => void updateSettings({ ...settings, skills: event.currentTarget.checked }).catch((cause) => toast.error(text(cause)))} /></label>
      <label className="settings-row"><span><strong>Personal MCP</strong><small>Allow users to add personal remote MCP servers.</small></span><input type="checkbox" checked={settings.mcp} onChange={(event) => void updateSettings({ ...settings, mcp: event.currentTarget.checked }).catch((cause) => toast.error(text(cause)))} /></label>
    </div>
  </div>;
}

export function PersonalSkillsSettings({ client, fallback, tenantId }: { client: BerryApiClient | null; fallback: Array<{ id: string; name: string; description: string }>; tenantId: string }) {
  const [skills, setSkills] = React.useState<PersonalSkill[]>([]);
  const [review, setReview] = React.useState<PersonalSkillReview | null>(null);
  const [draft, setDraft] = React.useState({ name: "", description: "", content: "", sourceUrl: "", source: "text" as "text" | "upload" | "git" });
  const [effective, setEffective] = React.useState<EffectiveCapability[]>([]);
  const load = React.useCallback(() => client ? Promise.all([client.listPersonalSkills().then(setSkills), client.effectiveCapabilities(tenantId).then(setEffective)]) : undefined, [client, tenantId]);
  React.useEffect(() => { void load()?.catch((cause) => toast.error(text(cause))); }, [load]);
  const preview = async () => { if (!client) return toast.info("Personal skill editing is available when connected to Berry Cloud."); setReview(await client.reviewPersonalSkill({ ...draft, sourceUrl: draft.sourceUrl || null })); };
  const install = async () => { if (!client || !review) return; const skill = await client.savePersonalSkill({ ...draft, sourceUrl: draft.sourceUrl || null, confirmedHash: review.hash, trusted: false }); setSkills((current) => [...current, skill]); setReview(null); setDraft({ name: "", description: "", content: "", sourceUrl: "", source: "text" }); toast.success("Skill installed; review trust before enabling runtime use"); };
  return <div className="personal-capabilities">
    <InheritedRows rows={effective.filter((row) => row.kind === "skill" && row.provenance === "organization")} client={client} tenantId={tenantId} onChanged={() => void load()} />
    <div className="capability-form"><h2>Add personal skill</h2><label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>Description<input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label><label>Source<select value={draft.source} onChange={(event) => setDraft({ ...draft, source: event.target.value as typeof draft.source })}><option value="text">Text</option><option value="upload">Uploaded package</option><option value="git">Approved Git source</option></select></label>{draft.source === "git" ? <label>Git URL<input type="url" value={draft.sourceUrl} onChange={(event) => setDraft({ ...draft, sourceUrl: event.target.value })} placeholder="https://github.com/…/SKILL.md" /></label> : <label>SKILL.md<textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>}<Button size="sm" onClick={() => void preview()} disabled={!draft.name || !draft.description || (draft.source === "git" ? !draft.sourceUrl : !draft.content)}>Review skill</Button>{review ? <div className="capability-review" role="status"><strong>Review before install</strong><span>{review.bytes.toLocaleString()} bytes · {review.hash.slice(0, 12)}…</span>{review.warnings.map((warning) => <span key={warning}>{warning}</span>)}<Button size="sm" onClick={() => void install()}>Confirm install</Button></div> : null}</div>
    <div className="settings-list">{skills.length ? skills.map((skill) => <CapabilityRow key={skill.id} title={`$${skill.name}`} detail={`${skill.source} · ${skill.hash.slice(0, 10)}… · ${skill.trusted ? "trusted" : "not trusted"}`} enabled={skill.enabled} trusted={skill.trusted} onToggle={async (enabled) => replace(setSkills, await client!.updatePersonalSkill(skill.id, { enabled }))} onTrust={async (trusted) => replace(setSkills, await client!.updatePersonalSkill(skill.id, { trusted }))} onDelete={async () => { await client!.deletePersonalSkill(skill.id); setSkills((current) => current.filter((item) => item.id !== skill.id)); }} />) : fallback.map((skill) => <div className="settings-row" key={skill.id}><strong>${skill.name}</strong><span>{skill.description} · managed by deployment</span></div>)}</div>
  </div>;
}

export function PersonalMcpSettings({ client, fallback }: { client: BerryApiClient | null; fallback: Array<{ id: string; name: string; url: string; auth: string }> }) {
  const [servers, setServers] = React.useState<PersonalMcpServer[]>([]);
  const [draft, setDraft] = React.useState({ name: "", url: "", transport: "streamable-http" as "streamable-http" | "http-sse", auth: "none" as "none" | "bearer" | "oauth", credential: "" });
  const load = React.useCallback(() => client?.listPersonalMcpServers().then(setServers), [client]);
  React.useEffect(() => { void load()?.catch((cause) => toast.error(text(cause))); }, [load]);
  const add = async () => { if (!client) return toast.info("Personal MCP editing is available when connected to Berry Cloud."); const server = await client.savePersonalMcpServer({ name: draft.name, url: draft.url, transport: draft.transport, auth: draft.auth, ...(draft.credential ? { credential: draft.credential } : {}), trusted: false }); setServers((current) => [...current, server]); setDraft({ name: "", url: "", transport: "streamable-http", auth: "none", credential: "" }); };
  return <div className="personal-capabilities"><div className="capability-form"><h2>Add remote MCP</h2><label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>HTTPS URL<input type="url" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label><label>Transport<select value={draft.transport} onChange={(event) => setDraft({ ...draft, transport: event.target.value as typeof draft.transport })}><option value="streamable-http">Streamable HTTP</option><option value="http-sse">HTTP / SSE</option></select></label><label>Authentication<select value={draft.auth} onChange={(event) => setDraft({ ...draft, auth: event.target.value as typeof draft.auth })}><option value="none">None</option><option value="bearer">Bearer token</option><option value="oauth">OAuth</option></select></label>{draft.auth === "bearer" ? <label>Bearer token<input type="password" autoComplete="off" value={draft.credential} onChange={(event) => setDraft({ ...draft, credential: event.target.value })} /></label> : null}<Button size="sm" onClick={() => void add()} disabled={!draft.name || !draft.url}>Add server</Button></div><div className="settings-list">{servers.length ? servers.map((server) => <CapabilityRow key={server.id} title={server.name} detail={`${server.transport} · ${server.auth} · ${server.health} · ${server.credentialConfigured ? "credential stored" : "no credential"}`} enabled={server.enabled} trusted={server.trusted} onToggle={async (enabled) => replace(setServers, await client!.updatePersonalMcpServer(server.id, { enabled }))} onTrust={async (trusted) => replace(setServers, await client!.updatePersonalMcpServer(server.id, { trusted }))} onTest={async () => replace(setServers, await client!.testPersonalMcpServer(server.id))} onDelete={async () => { await client!.deletePersonalMcpServer(server.id); setServers((current) => current.filter((item) => item.id !== server.id)); }} />) : fallback.map((server) => <div className="settings-row" key={server.id}><strong>{server.name}</strong><span>{server.auth} · {server.url} · managed by deployment</span></div>)}</div></div>;
}

function CapabilityRow({ title, detail, enabled, trusted, onToggle, onTrust, onTest, onDelete }: { title: string; detail: string; enabled: boolean; trusted: boolean; onToggle: (value: boolean) => Promise<void>; onTrust: (value: boolean) => Promise<void>; onTest?: (() => Promise<void>) | undefined; onDelete: () => Promise<void> }) { return <div className="settings-row capability-row"><strong>{title}</strong><span>{detail}</span><div><Button size="sm" variant="ghost" onClick={() => void onToggle(!enabled)}>{enabled ? "Disable" : "Enable"}</Button><Button size="sm" variant="ghost" onClick={() => void onTrust(!trusted)}>{trusted ? "Untrust" : "Trust"}</Button>{onTest ? <Button size="sm" variant="ghost" onClick={() => void onTest()}>Test</Button> : null}<Button size="sm" variant="ghost" onClick={() => void onDelete()}>Delete</Button></div></div>; }
function replace<T extends { id: string }>(set: React.Dispatch<React.SetStateAction<T[]>>, next: T) { set((current) => current.map((item) => item.id === next.id ? next : item)); }
function text(cause: unknown) { return cause instanceof Error ? cause.message : "Capability operation failed"; }
