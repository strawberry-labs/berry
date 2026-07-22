import * as React from "react";
import { Check, FlaskConical, Plus, Search, ShieldCheck, X } from "lucide-react";
import type { PersonalMcpServer, PersonalSkill, PersonalSkillReview } from "@berry/shared";
import { AsyncState, Button, DataTable, DetailDrawer, FormSelect, Input, ManagementPage, SearchInput, Section, StatusPill, SuccessMessage, Textarea, Toolbar } from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

export function PersonalSkillsScreen({ client, config }: ManagementScreenProps) {
  const [query, setQuery] = React.useState("");
  const [review, setReview] = React.useState<PersonalSkillReview | null>(null);
  const [draft, setDraft] = React.useState({ name: "", description: "", content: "" });
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<PersonalSkill | null>(null);
  const [message, setMessage] = React.useState("");
  const resource = useResource(
    "personal-skills",
    async () => client
      ? client.listPersonalSkills()
      : config.skills.map((skill) => ({
          id: skill.id,
          tenantId: "demo",
          userId: "demo",
          name: skill.name,
          description: skill.description,
          content: "",
          enabled: skill.enabled,
          trusted: true,
          source: "text" as const,
          sourceUrl: null,
          version: null,
          hash: "demo",
          diagnostics: [],
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        })),
    [] as PersonalSkill[],
  );
  const rows = resource.data.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()));

  async function preview(event: React.FormEvent) {
    event.preventDefault();
    if (!client) return;
    setReview(await client.reviewPersonalSkill({ ...draft, source: "text" }));
  }

  async function confirm() {
    if (!client || !review) return;
    await client.savePersonalSkill({ ...draft, source: "text", enabled: true, trusted: true, confirmedHash: review.hash });
    setCreating(false);
    setReview(null);
    setDraft({ name: "", description: "", content: "" });
    setMessage("Skill reviewed and added to your personal catalog.");
    resource.retry();
  }

  async function toggle(skill: PersonalSkill) {
    if (!client) return;
    await client.updatePersonalSkill(skill.id, { enabled: !skill.enabled });
    resource.retry();
  }

  return (
    <ManagementPage
      title="Skills"
      description="Review personal and organization-provided capabilities before enabling them."
      eyebrow="Capabilities"
      actions={<Button disabled={!client} onClick={() => setCreating(true)}><Plus />Import skill</Button>}
    >
      <Toolbar>
        <SearchInput label="Search skills" value={query} onChange={setQuery} placeholder="Search skills" />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      {creating ? (
        <Section title={review ? "Review import" : "Create or import skill"} description="Berry shows the normalized content and hash before anything is enabled.">
          {!review ? (
            <form className="mgmt-inline-form" onSubmit={preview}>
              <label className="mgmt-field">Name<Input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></label>
              <label className="mgmt-field mgmt-field-wide">Description<Input required value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })} /></label>
              <label className="mgmt-field mgmt-field-wide">Skill content<Textarea className="mgmt-textarea" required value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.currentTarget.value })} /></label>
              <Button type="button" variant="secondary" onClick={() => setCreating(false)}><X />Cancel</Button>
              <Button><ShieldCheck />Review</Button>
            </form>
          ) : (
            <div className="mgmt-review-flow">
              <dl><div><dt>Name</dt><dd>{review.name}</dd></div><div><dt>Content hash</dt><dd><code>{review.hash}</code></dd></div><div><dt>Source</dt><dd>{review.source}</dd></div></dl>
              {review.warnings.length ? <div className="mgmt-callout" role="alert">{review.warnings.join(" · ")}</div> : <p className="mgmt-success"><Check />No review warnings found.</p>}
              <div className="mgmt-form-actions"><Button variant="secondary" onClick={() => setReview(null)}>Back</Button><Button onClick={confirm}><Check />Confirm import</Button></div>
            </div>
          )}
        </Section>
      ) : null}
      <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry} empty={rows.length === 0}>
        <DataTable
          label="Skills"
          columns={["Skill", "Source", "Trust", "Assignment", "Action"]}
          rows={rows.map((skill) => [
            <Button variant="ghost" className="mgmt-table-link" onClick={() => setSelected(skill)}><b>{skill.name.startsWith("$") ? skill.name : `$${skill.name}`}</b><small>{skill.description}</small></Button>,
            skill.source,
            <StatusPill tone={skill.trusted ? "good" : "warning"}>{skill.trusted ? "Reviewed" : "Needs review"}</StatusPill>,
            skill.enabled ? <StatusPill tone="info">Enabled</StatusPill> : "Available",
            <Button variant="secondary" disabled={!client} onClick={() => toggle(skill)}>{skill.enabled ? "Disable" : "Enable"}</Button>,
          ])}
        />
      </AsyncState>
      {selected ? <Detail title={selected.name} onClose={() => setSelected(null)}><p>{selected.description}</p><dl><div><dt>Version</dt><dd>{selected.version ?? "Unversioned"}</dd></div><div><dt>Hash</dt><dd><code>{selected.hash}</code></dd></div><div><dt>Trust</dt><dd>{selected.trusted ? "Reviewed" : "Review required"}</dd></div></dl></Detail> : null}
    </ManagementPage>
  );
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
