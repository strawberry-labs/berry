import * as React from "react";
import { Check, FlaskConical, Plus, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { BerryApiError, type BerryApiClient } from "@berry/api-client";
import type { EffectiveCapability, PersonalMcpServer, PersonalSkill, PersonalSkillReview } from "@berry/shared";
import { readBrowserSkillImport } from "@/lib/skill-import";
import { AsyncState, Button, DataTable, DetailDrawer, FormSelect, Input, ManagementPage, ManagementSwitch, SearchInput, Section, StatusPill, SuccessMessage, Textarea, Toolbar } from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

type SkillCatalogRow = {
  key: string;
  capabilityId: string;
  name: string;
  description: string;
  enabled: boolean;
  locked: boolean;
  provenance: "organization" | "personal" | "self-host-bootstrap";
  assignment: EffectiveCapability["assignment"];
  reason: EffectiveCapability["reason"] | "deployment";
  personal?: PersonalSkill;
};

const emptySkillResource = { personal: [] as PersonalSkill[], effective: [] as EffectiveCapability[] };
const emptyDraft = { content: "", sourceUrl: "", source: "upload" as "text" | "upload" | "git", packageFiles: [] as string[], fileName: "" };

export async function loadPersonalSkillResource(
  client: Pick<BerryApiClient, "listPersonalSkills" | "effectiveCapabilities">,
  tenantId: string,
): Promise<typeof emptySkillResource> {
  const [personal, effective] = await Promise.all([
    client.listPersonalSkills(),
    client.effectiveCapabilities(tenantId).catch((cause) => {
      if (cause instanceof BerryApiError && cause.status === 403) return [];
      throw cause;
    }),
  ]);
  return { personal, effective };
}

export function PersonalSkillsScreen({ client, config, tenantId }: ManagementScreenProps) {
  const [query, setQuery] = React.useState("");
  const [review, setReview] = React.useState<PersonalSkillReview | null>(null);
  const [draft, setDraft] = React.useState(emptyDraft);
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<SkillCatalogRow | null>(null);
  const [message, setMessage] = React.useState("");
  const [importError, setImportError] = React.useState("");
  const resource = useResource(
    `personal-skills:${tenantId}`,
    async () => client
      ? loadPersonalSkillResource(client, tenantId)
      : emptySkillResource,
    emptySkillResource,
  );
  const rows = React.useMemo(() => buildSkillRows(resource.data.personal, resource.data.effective, config.skills)
    .filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())), [resource.data, config.skills, query]);

  async function preview(event: React.FormEvent) {
    event.preventDefault();
    if (!client) return;
    setImportError("");
    try {
      setReview(await client.reviewPersonalSkill({ content: draft.content, source: draft.source, sourceUrl: draft.sourceUrl || null, packageFiles: draft.packageFiles }));
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "Skill review failed");
    }
  }

  async function confirm() {
    if (!client || !review) return;
    await client.savePersonalSkill({ content: draft.content, source: draft.source, sourceUrl: draft.sourceUrl || null, packageFiles: draft.packageFiles, enabled: false, trusted: false, confirmedHash: review.hash });
    setCreating(false);
    setReview(null);
    setDraft(emptyDraft);
    setMessage("Skill imported. Trust it, then turn it on when you are ready to use it.");
    resource.retry();
  }

  async function toggle(skill: SkillCatalogRow, enabled: boolean) {
    if (!client) return;
    if (skill.personal) await client.updatePersonalSkill(skill.personal.id, { enabled });
    else await client.setCapabilityOverride(tenantId, "skill", skill.capabilityId, enabled);
    resource.retry();
  }

  async function setTrusted(skill: PersonalSkill, trusted: boolean) {
    if (!client) return;
    await client.updatePersonalSkill(skill.id, { trusted, ...(trusted ? {} : { enabled: false }) });
    setSelected(null);
    resource.retry();
  }

  async function remove(skill: PersonalSkill) {
    if (!client) return;
    await client.deletePersonalSkill(skill.id);
    setSelected(null);
    resource.retry();
  }

  async function selectFile(file: File | undefined) {
    if (!file) return;
    setImportError("");
    setReview(null);
    try {
      const imported = await readBrowserSkillImport(file);
      setDraft({ content: imported.content, packageFiles: imported.packageFiles, fileName: imported.fileName, source: "upload", sourceUrl: "" });
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "Could not read this skill package");
    }
  }

  return (
    <ManagementPage
      title="Skills"
      description="Review personal and organization-provided capabilities before enabling them."
      eyebrow="Capabilities"
      actions={<Button disabled={!client} onClick={() => { setCreating(true); setReview(null); setImportError(""); }}><Plus />Import skill</Button>}
    >
      <Toolbar>
        <SearchInput label="Search skills" value={query} onChange={setQuery} placeholder="Search skills" />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      {creating ? (
        <Section title={review ? "Review skill" : "Import a skill"} description="Import an Agent Skills package, paste SKILL.md, or load a GitHub SKILL.md URL.">
          {!review ? (
            <form className="mgmt-inline-form" onSubmit={preview}>
              <label className="mgmt-field">Source<FormSelect value={draft.source} onChange={(source) => { setReview(null); setImportError(""); setDraft({ ...emptyDraft, source: source as typeof draft.source }); }} options={[{ value: "upload", label: "Skill package" }, { value: "text", label: "Paste SKILL.md" }, { value: "git", label: "GitHub URL" }]} /></label>
              {draft.source === "upload" ? <label className="mgmt-skill-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void selectFile(event.dataTransfer.files[0]); }}><input type="file" accept=".skill,.zip,.md,text/markdown,application/zip" onChange={(event) => void selectFile(event.currentTarget.files?.[0])} /><Upload aria-hidden /><span><b>{draft.fileName || "Choose or drop a .skill package"}</b><small>.skill, .zip, or SKILL.md · up to 5 MB</small></span></label> : null}
              {draft.source === "text" ? <label className="mgmt-field mgmt-field-wide">SKILL.md<Textarea className="mgmt-textarea" required value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.currentTarget.value })} placeholder={'---\nname: my-skill\ndescription: What this skill does and when to use it\n---\n\nInstructions…'} /></label> : null}
              {draft.source === "git" ? <label className="mgmt-field mgmt-field-wide">GitHub SKILL.md URL<Input type="url" required value={draft.sourceUrl} onChange={(event) => setDraft({ ...draft, sourceUrl: event.currentTarget.value })} placeholder="https://github.com/org/repo/blob/main/skill/SKILL.md" /></label> : null}
              {importError ? <div className="mgmt-callout" role="alert">{importError}</div> : null}
              <Button type="button" variant="secondary" onClick={() => { setCreating(false); setDraft(emptyDraft); setImportError(""); }}><X />Cancel</Button>
              <Button><ShieldCheck />Review</Button>
            </form>
          ) : (
            <div className="mgmt-review-flow">
              <dl><div><dt>Skill</dt><dd>${review.name}</dd></div><div><dt>Description</dt><dd>{review.description}</dd></div><div><dt>Version</dt><dd>{review.version ?? "Not specified"}</dd></div><div><dt>Package</dt><dd>{review.resources.length ? `${review.resources.length + 1} files` : "SKILL.md only"}</dd></div><div><dt>Content hash</dt><dd><code>{review.hash}</code></dd></div></dl>
              {review.compatibility ? <p className="mgmt-muted">Compatibility: {review.compatibility}</p> : null}
              {review.resources.length ? <div className="mgmt-skill-files"><b>Included resources</b><span>{review.resources.slice(0, 8).join(" · ")}{review.resources.length > 8 ? ` · +${review.resources.length - 8} more` : ""}</span></div> : null}
              {review.warnings.length ? <div className="mgmt-callout" role="alert">{review.warnings.join(" · ")}</div> : <p className="mgmt-success"><Check />No review warnings found.</p>}
              <div className="mgmt-form-actions"><Button variant="secondary" onClick={() => setReview(null)}>Back</Button><Button onClick={confirm}><Check />Import disabled</Button></div>
            </div>
          )}
        </Section>
      ) : null}
      <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} empty={rows.length === 0}>
        <DataTable
          label="Skills"
          columns={["Skill", "Provided by", "Policy", "Status"]}
          rows={rows.map((skill) => [
            <Button variant="ghost" className="mgmt-table-link" onClick={() => setSelected(skill)}><b>{skill.name.startsWith("$") ? skill.name : `$${skill.name}`}</b><small>{skill.description}</small></Button>,
            skill.provenance === "organization" ? "Organization" : skill.provenance === "personal" ? "You" : "Deployment",
            skill.personal && !skill.personal.trusted ? <StatusPill tone="warning">Trust required</StatusPill> : <StatusPill tone={skill.locked ? "neutral" : "info"}>{skill.assignment ? skill.assignment.replace("-", " ") : skill.reason}</StatusPill>,
            <span className="mgmt-skill-switch"><ManagementSwitch checked={skill.enabled} disabled={!client || skill.locked || Boolean(skill.personal && !skill.personal.trusted)} onCheckedChange={(enabled) => void toggle(skill, enabled)} aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`} /><small>{skill.enabled ? "On" : "Off"}</small></span>,
          ])}
        />
      </AsyncState>
      {selected ? <Detail title={`$${selected.name}`} onClose={() => setSelected(null)}><p>{selected.description}</p><dl><div><dt>Provided by</dt><dd>{selected.provenance === "organization" ? "Organization" : selected.provenance === "personal" ? "You" : "Deployment"}</dd></div><div><dt>Assignment</dt><dd>{selected.assignment ?? selected.reason}</dd></div>{selected.personal ? <><div><dt>Version</dt><dd>{selected.personal.version ?? "Unversioned"}</dd></div><div><dt>Hash</dt><dd><code>{selected.personal.hash}</code></dd></div></> : null}</dl>{selected.personal ? <><label className="mgmt-toggle-row"><span>Trust this skill<small>Trusted skills can run when enabled.</small></span><ManagementSwitch checked={selected.personal.trusted} onCheckedChange={(trusted) => void setTrusted(selected.personal!, trusted)} aria-label="Trust this skill" /></label><Button variant="secondary" onClick={() => void remove(selected.personal!)}><Trash2 aria-hidden />Delete skill</Button></> : null}</Detail> : null}
    </ManagementPage>
  );
}

function buildSkillRows(personal: PersonalSkill[], effective: EffectiveCapability[], deployed: Array<{ id: string; name: string; description: string; enabled: boolean }>): SkillCatalogRow[] {
  const rows = new Map<string, SkillCatalogRow>();
  const deployedByName = new Map(deployed.map((item) => [item.name.replace(/^\$/, "").toLowerCase(), item]));
  for (const item of effective.filter((entry) => entry.kind === "skill" && entry.provenance === "organization")) {
    rows.set(item.name.toLowerCase(), { key: `organization:${item.capabilityId}`, capabilityId: item.capabilityId, name: item.name, description: deployedByName.get(item.name.toLowerCase())?.description ?? "Managed by your organization", enabled: item.enabled, locked: item.locked, provenance: "organization", assignment: item.assignment, reason: item.reason });
  }
  for (const item of personal) {
    rows.set(item.name.toLowerCase(), { key: `personal:${item.id}`, capabilityId: item.id, name: item.name, description: item.description, enabled: item.enabled && item.trusted, locked: false, provenance: "personal", assignment: null, reason: "personal", personal: item });
  }
  for (const item of deployed) {
    const key = item.name.replace(/^\$/, "").toLowerCase();
    if (!rows.has(key)) rows.set(key, { key: `deployment:${item.id}`, capabilityId: item.id, name: item.name.replace(/^\$/, ""), description: item.description, enabled: item.enabled, locked: true, provenance: "self-host-bootstrap", assignment: null, reason: "deployment" });
  }
  return [...rows.values()].sort((a, b) => a.provenance.localeCompare(b.provenance) || a.name.localeCompare(b.name));
}

export function PersonalMcpScreen({ client, config }: ManagementScreenProps) {
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<PersonalMcpServer | null>(null);
  const [message, setMessage] = React.useState("");
  const resource = useResource(
    "personal-mcp",
    async () => client ? client.listPersonalMcpServers() : config.mcpServers.map((server) => ({
      id: server.id, tenantId: "demo", userId: "demo", name: server.name, url: server.url, transport: "streamable-http" as const,
      auth: server.auth, credentialRef: null, credentialConfigured: false, enabled: server.enabled, trusted: true, health: "healthy" as const,
      toolCount: 0, lastCheckedAt: null, diagnostics: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    })),
    [] as PersonalMcpServer[],
  );
  const rows = resource.data.filter((server) => `${server.name} ${server.url}`.toLowerCase().includes(query.toLowerCase()));

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    const credential = String(form.get("credential"));
    await client.savePersonalMcpServer({
      name: String(form.get("name")), url: String(form.get("url")), transport: String(form.get("transport")) as "http-sse" | "streamable-http",
      auth: String(form.get("auth")) as "none" | "bearer" | "oauth", ...(credential ? { credential } : {}), enabled: true, trusted: false,
    });
    setCreating(false);
    setMessage("Server saved. Test its connection before trusting it.");
    resource.retry();
  }

  async function test(server: PersonalMcpServer) {
    if (!client) return;
    const next = await client.testPersonalMcpServer(server.id);
    setSelected(next);
    resource.retry();
  }

  return (
    <ManagementPage title="MCP servers" description="Inspect tools, authentication state, trust, and connection health." eyebrow="Capabilities" actions={<Button disabled={!client} onClick={() => setCreating(true)}><Plus />Add server</Button>}>
      <Toolbar><SearchInput label="Search MCP servers" value={query} onChange={setQuery} placeholder="Search servers" /></Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      {creating ? <Section title="Review server connection" description="Credentials are stored by reference and are never returned to the browser."><form className="mgmt-inline-form" onSubmit={save}><label className="mgmt-field">Name<Input name="name" required /></label><label className="mgmt-field mgmt-field-wide">HTTPS URL<Input name="url" type="url" required /></label><label className="mgmt-field">Transport<FormSelect name="transport" defaultValue="streamable-http" options={[{ value: "streamable-http", label: "Streamable HTTP" }, { value: "http-sse", label: "HTTP + SSE" }]} /></label><label className="mgmt-field">Authentication<FormSelect name="auth" defaultValue="none" options={[{ value: "none", label: "None" }, { value: "bearer", label: "Bearer token" }, { value: "oauth", label: "OAuth" }]} /></label><label className="mgmt-field">Credential<Input name="credential" type="password" autoComplete="off" /></label><Button type="button" variant="secondary" onClick={() => setCreating(false)}>Cancel</Button><Button>Save for testing</Button></form></Section> : null}
      <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} empty={rows.length === 0}>
        <DataTable label="MCP servers" columns={["Server", "Transport", "Authentication", "Trust", "Health", "Actions"]} rows={rows.map((server) => [<Button variant="ghost" className="mgmt-table-link" onClick={() => setSelected(server)}><b>{server.name}</b><small>{server.url}</small></Button>, server.transport, server.credentialConfigured ? `${server.auth} configured` : server.auth, server.trusted ? "Reviewed" : "Needs review", <StatusPill tone={server.health === "healthy" ? "good" : server.health === "unreachable" ? "danger" : "warning"}>{server.health}</StatusPill>, <Button variant="secondary" disabled={!client} onClick={() => test(server)}><FlaskConical />Test</Button>])} />
      </AsyncState>
      {selected ? <Detail title={selected.name} onClose={() => setSelected(null)}><dl><div><dt>Tools</dt><dd>{selected.toolCount}</dd></div><div><dt>Authentication</dt><dd>{selected.credentialConfigured ? "Configured" : "Not configured"}</dd></div><div><dt>Last tested</dt><dd>{selected.lastCheckedAt ? new Date(selected.lastCheckedAt).toLocaleString() : "Never"}</dd></div></dl>{selected.diagnostics.length ? <div className="mgmt-callout">{selected.diagnostics.join(" · ")}</div> : null}</Detail> : null}
    </ManagementPage>
  );
}

function Detail({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <DetailDrawer title={title} onClose={onClose}>{children}</DetailDrawer>;
}
