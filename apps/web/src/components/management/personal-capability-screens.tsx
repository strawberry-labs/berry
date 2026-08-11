import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Code2,
  EllipsisVertical,
  Eye,
  FlaskConical,
  Info,
  MessageCircle,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { BerryApiError, type BerryApiClient } from "@berry/api-client";
import { Markdown } from "@berry/desktop-ui/components/berry-markdown";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@berry/desktop-ui/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@berry/desktop-ui/components/ui/tooltip";
import type {
  EffectiveCapability,
  PersonalMcpServer,
  PersonalSkill,
} from "@berry/shared";
import { readBrowserSkillImport } from "@/lib/skill-import";
import {
  AsyncState,
  Button,
  DataTable,
  DetailDrawer,
  FormSelect,
  Input,
  ManagementDialog,
  ManagementPage,
  ManagementSwitch,
  SearchInput,
  StatusPill,
  SuccessMessage,
  Textarea,
  Toolbar,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

type SkillCatalogRow = {
  key: string;
  capabilityId: string;
  name: string;
  description: string;
  content: string | null;
  enabled: boolean;
  locked: boolean;
  provenance: "organization" | "personal" | "self-host-bootstrap";
  assignment: EffectiveCapability["assignment"];
  reason: EffectiveCapability["reason"] | "deployment";
  personal?: PersonalSkill;
};

const emptySkillResource = {
  personal: [] as PersonalSkill[],
  effective: [] as EffectiveCapability[],
};
const emptyDraft = {
  content: "",
  sourceUrl: "",
  source: "upload" as "text" | "upload" | "git",
  packageFiles: [] as string[],
  fileName: "",
};

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

export function PersonalSkillsScreen({
  client,
  config,
  tenantId,
}: ManagementScreenProps) {
  const navigate = useNavigate();
  const [query, setQuery] = React.useState("");
  const [draft, setDraft] = React.useState(emptyDraft);
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<SkillCatalogRow | null>(null);
  const [message, setMessage] = React.useState("");
  const [importError, setImportError] = React.useState("");
  const resource = useResource(
    `personal-skills:${tenantId}`,
    async () =>
      client ? loadPersonalSkillResource(client, tenantId) : emptySkillResource,
    emptySkillResource,
  );
  const rows = React.useMemo(
    () =>
      buildSkillRows(
        resource.data.personal,
        resource.data.effective,
        config.skills,
      ).filter((skill) =>
        `${skill.name} ${skill.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [resource.data, config.skills, query],
  );

  async function install(event: React.FormEvent) {
    event.preventDefault();
    if (!client) return;
    setImportError("");
    try {
      await client.savePersonalSkill({
        content: draft.content,
        source: draft.source,
        sourceUrl: draft.sourceUrl || null,
        packageFiles: draft.packageFiles,
        enabled: true,
      });
      setCreating(false);
      setDraft(emptyDraft);
      setMessage("Skill imported and enabled for your account.");
      resource.retry();
    } catch (cause) {
      setImportError(
        cause instanceof Error ? cause.message : "Skill import failed",
      );
    }
  }

  async function toggle(skill: SkillCatalogRow, enabled: boolean) {
    if (!client) return;
    if (skill.personal)
      await client.updatePersonalSkill(skill.personal.id, { enabled });
    else
      await client.setCapabilityOverride(
        tenantId,
        "skill",
        skill.capabilityId,
        enabled,
      );
    setSelected((current) =>
      current?.key === skill.key ? { ...current, enabled } : current,
    );
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
    try {
      const imported = await readBrowserSkillImport(file);
      setDraft({
        content: imported.content,
        packageFiles: imported.packageFiles,
        fileName: imported.fileName,
        source: "upload",
        sourceUrl: "",
      });
    } catch (cause) {
      setImportError(
        cause instanceof Error
          ? cause.message
          : "Could not read this skill package",
      );
    }
  }

  function tryInChat(skill: SkillCatalogRow) {
    window.localStorage.setItem("berry.web.pendingPrompt", `$${skill.capabilityId} `);
    setSelected(null);
    void navigate({ to: "/" });
  }

  return (
    <ManagementPage
      title="Skills"
      description="Import your own skills or use capabilities provided by your organization."
      eyebrow="Tools & connections"
      actions={
        <Button
          disabled={!client}
          onClick={() => {
            setCreating(true);
            setImportError("");
          }}
        >
          <Plus />
          Import skill
        </Button>
      }
    >
      <Toolbar>
        <SearchInput
          label="Search skills"
          value={query}
          onChange={setQuery}
          placeholder="Search skills"
        />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <ManagementDialog
        open={creating}
        onOpenChange={setCreating}
        title="Import a skill"
        description="Import a skill package, paste SKILL.md, or load a GitHub SKILL.md URL. Valid skills are enabled for your account immediately."
        size="lg"
      >
        <form
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={install}
        >
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Source
              <FormSelect
                value={draft.source}
                onChange={(source) => {
                  setImportError("");
                  setDraft({
                    ...emptyDraft,
                    source: source as typeof draft.source,
                  });
                }}
                options={[
                  { value: "upload", label: "Skill package" },
                  { value: "text", label: "Paste SKILL.md" },
                  { value: "git", label: "GitHub URL" },
                ]}
              />
            </label>
            {draft.source === "upload" ? (
              <label
                className="settings-skill-dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void selectFile(event.dataTransfer.files[0]);
                }}
              >
                <input
                  type="file"
                  accept=".skill,.zip,.md,text/markdown,application/zip"
                  onChange={(event) =>
                    void selectFile(event.currentTarget.files?.[0])
                  }
                />
                <Upload aria-hidden />
                <span>
                  <b>{draft.fileName || "Choose or drop a .skill package"}</b>
                  <small>.skill, .zip, or SKILL.md · up to 5 MB</small>
                </span>
              </label>
            ) : null}
            {draft.source === "text" ? (
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
                SKILL.md
                <Textarea
                  className="min-h-32 resize-y"
                  required
                  value={draft.content}
                  onChange={(event) =>
                    setDraft({ ...draft, content: event.currentTarget.value })
                  }
                  placeholder={
                    "---\nname: my-skill\ndescription: What this skill does and when to use it\n---\n\nInstructions…"
                  }
                />
              </label>
            ) : null}
            {draft.source === "git" ? (
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
                GitHub SKILL.md URL
                <Input
                  type="url"
                  required
                  value={draft.sourceUrl}
                  onChange={(event) =>
                    setDraft({ ...draft, sourceUrl: event.currentTarget.value })
                  }
                  placeholder="https://github.com/org/repo/blob/main/skill/SKILL.md"
                />
              </label>
            ) : null}
            {importError ? (
              <div
                className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                role="alert"
              >
                {importError}
              </div>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setCreating(false);
                setDraft(emptyDraft);
                setImportError("");
              }}
            >
              <X />
              Cancel
            </Button>
            <Button type="submit">
              <Check />
              Import and enable
            </Button>
          </form>
      </ManagementDialog>
      <AsyncState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.retry}
        empty={rows.length === 0}
      >
        <DataTable
          label="Skills"
          columns={["Skill", "Provided by", "Policy", "Status"]}
          rows={rows.map((skill) => {
            const controlHint = skillControlHint(skill, Boolean(client));
            const hintId = `skill-control-${skill.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            return [
              <Button
                variant="ghost"
                className="grid h-auto max-w-80 justify-start gap-0.5 p-0 text-left [&_b]:truncate [&_small]:truncate [&_small]:text-xs [&_small]:text-muted-foreground"
                onClick={() => setSelected(skill)}
              >
                <b>
                  {skill.name.startsWith("$") ? skill.name : `$${skill.name}`}
                </b>
                <small>{skill.description}</small>
              </Button>,
              skill.provenance === "organization"
                ? "Organization"
                : skill.provenance === "personal"
                  ? "You"
                  : "Deployment",
              <StatusPill tone={skill.locked ? "neutral" : "info"}>
                {skill.assignment
                  ? skill.assignment.replace("-", " ")
                  : skill.reason}
              </StatusPill>,
              <span className="inline-flex items-center gap-2 [&_small]:max-w-40 [&_small]:text-xs [&_small]:text-[var(--berry-text-secondary)]">
                <ManagementSwitch
                  checked={skill.enabled}
                  disabled={!client || skill.locked}
                  onCheckedChange={(enabled) => void toggle(skill, enabled)}
                  aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                  aria-describedby={hintId}
                  title={controlHint}
                />
                <small id={hintId}>{controlHint}</small>
              </span>,
            ];
          })}
        />
      </AsyncState>
      {selected ? (
        <SkillDetailsDialog
          key={selected.key}
          skill={selected}
          hasClient={Boolean(client)}
          onClose={() => setSelected(null)}
          onToggle={(enabled) => toggle(selected, enabled)}
          onTryInChat={() => tryInChat(selected)}
          onUninstall={selected.personal ? () => remove(selected.personal!) : undefined}
        />
      ) : null}
    </ManagementPage>
  );
}

type SkillViewMode = "rendered" | "source";

export function skillMarkdownBody(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const delimiter = normalized.indexOf("\n---\n", 4);
  if (delimiter < 0) return normalized;
  return normalized.slice(delimiter + 5).trimStart();
}

function SkillDetailsDialog({
  skill,
  hasClient,
  onClose,
  onToggle,
  onTryInChat,
  onUninstall,
}: {
  skill: SkillCatalogRow;
  hasClient: boolean;
  onClose: () => void;
  onToggle: (enabled: boolean) => Promise<void>;
  onTryInChat: () => void;
  onUninstall?: (() => Promise<void>) | undefined;
}) {
  const [view, setView] = React.useState<SkillViewMode>("rendered");
  const [descriptionExpanded, setDescriptionExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState<"toggle" | "uninstall" | null>(null);
  const [actionError, setActionError] = React.useState("");
  const provider = skill.provenance === "organization"
    ? "your organization"
    : skill.provenance === "personal"
      ? "you"
      : "this deployment";
  const descriptionCanExpand = skill.description.length > 220;
  const markdown = skill.content ? skillMarkdownBody(skill.content) : "";
  const controlHint = skillControlHint(skill, hasClient);

  async function changeEnabled(enabled: boolean) {
    setActionError("");
    setBusy("toggle");
    try {
      await onToggle(enabled);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not update this skill");
    } finally {
      setBusy(null);
    }
  }

  async function uninstall() {
    if (!onUninstall) return;
    setActionError("");
    setBusy("uninstall");
    try {
      await onUninstall();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not uninstall this skill");
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(92dvh,920px)] w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden rounded-[18px] border border-[var(--berry-border)] bg-[var(--berry-main-bg)] p-0 shadow-[var(--berry-shadow-floating)] sm:w-[calc(100vw-2rem)] sm:max-w-[min(1440px,calc(100vw-2rem))]"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--berry-border-subtle)] px-3 sm:px-5">
          <DialogClose asChild>
            <Button variant="ghost" className="h-8 gap-2 px-2 text-sm font-medium">
              <ArrowLeft aria-hidden />
              Skills
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close skill details">
              <X aria-hidden />
            </Button>
          </DialogClose>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-5">
          <div className="grid shrink-0 gap-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <DialogTitle className="truncate text-lg leading-6 font-semibold text-[var(--berry-text-primary)]">
                    {skill.name}
                  </DialogTitle>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" aria-label={`About ${skill.name}`}>
                          <Info aria-hidden />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent sideOffset={6}>
                        {skill.assignment ? `${skill.assignment.replace("-", " ")} organization skill` : `${skill.reason.replace("-", " ")} skill`}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <p className="mt-0.5 text-xs text-[var(--berry-text-secondary)]">by {provider}</p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <ManagementSwitch
                  checked={skill.enabled}
                  disabled={!hasClient || skill.locked || busy !== null}
                  onCheckedChange={(enabled) => void changeEnabled(enabled)}
                  aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                  title={controlHint}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${skill.name}`}>
                      <EllipsisVertical aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48 border-[var(--berry-border)] bg-[var(--berry-card-bg)]">
                    <DropdownMenuItem onSelect={onTryInChat}>
                      <MessageCircle aria-hidden />
                      Try in chat
                    </DropdownMenuItem>
                    {onUninstall ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={busy !== null}
                          onSelect={() => void uninstall()}
                        >
                          <Trash2 aria-hidden />
                          {busy === "uninstall" ? "Uninstalling…" : "Uninstall"}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <DialogDescription
              className={`max-w-none text-sm leading-6 text-[var(--berry-text-primary)] ${descriptionExpanded ? "" : "line-clamp-2"}`}
            >
              {skill.description}
            </DialogDescription>
            {descriptionCanExpand ? (
              <Button
                variant="ghost"
                className="h-auto w-fit p-0 text-xs text-[var(--berry-accent)] hover:bg-transparent"
                onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                aria-expanded={descriptionExpanded}
              >
                {descriptionExpanded ? "See less" : "See more"}
              </Button>
            ) : null}
            {actionError ? (
              <p role="alert" className="text-xs text-[var(--berry-danger)]">{actionError}</p>
            ) : null}
          </div>

          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--berry-border)] bg-[var(--berry-surface-inset)]" aria-label={`${skill.name} files`}>
            <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-[var(--berry-border-subtle)] px-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="rounded-lg border border-[var(--berry-border)] bg-[var(--berry-control-bg)] px-3 py-1.5 text-sm font-medium text-[var(--berry-text-primary)]">
                  SKILL.md
                </span>
                <span className="text-xs text-[var(--berry-text-tertiary)]">1 file</span>
              </div>
              <div className="flex rounded-lg bg-[var(--berry-control-bg)] p-0.5" role="group" aria-label="Skill content view">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={view === "rendered" ? "bg-[var(--berry-selected)] text-[var(--berry-text-primary)]" : "text-[var(--berry-text-secondary)]"}
                  onClick={() => setView("rendered")}
                  aria-label="Rendered Markdown"
                  aria-pressed={view === "rendered"}
                >
                  <Eye aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={view === "source" ? "bg-[var(--berry-selected)] text-[var(--berry-text-primary)]" : "text-[var(--berry-text-secondary)]"}
                  onClick={() => setView("source")}
                  aria-label="Markdown source"
                  aria-pressed={view === "source"}
                >
                  <Code2 aria-hidden />
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
              {!skill.content ? (
                <div className="grid min-h-full place-items-center p-8 text-center">
                  <div className="max-w-md">
                    <p className="text-sm font-medium text-[var(--berry-text-primary)]">SKILL.md is not available</p>
                    <p className="mt-1 text-xs leading-5 text-[var(--berry-text-secondary)]">
                      This offline deployment entry only publishes skill metadata. Connect to Berry to load the organization definition.
                    </p>
                  </div>
                </div>
              ) : view === "rendered" ? (
                <Markdown className="mx-auto max-w-5xl px-5 py-6 text-[14px] leading-7 tracking-normal text-[var(--berry-text-primary)] sm:px-8 sm:py-8">
                  {markdown}
                </Markdown>
              ) : (
                <SkillSource content={skill.content} />
              )}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SkillSource({ content }: { content: string }) {
  return (
    <div className="min-w-max py-4 font-mono text-xs leading-6 text-[var(--berry-text-primary)]">
      {content.replace(/\r\n?/g, "\n").split("\n").map((line, index) => (
        <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] px-4" key={`${index}:${line}`}>
          <span className="select-none pe-4 text-right text-[var(--berry-text-tertiary)]" aria-hidden>{index + 1}</span>
          <code className="whitespace-pre pe-6">{line || " "}</code>
        </div>
      ))}
    </div>
  );
}

function buildSkillRows(
  personal: PersonalSkill[],
  effective: EffectiveCapability[],
  deployed: Array<{
    id: string;
    name: string;
    description: string;
    enabled: boolean;
  }>,
): SkillCatalogRow[] {
  const rows = new Map<string, SkillCatalogRow>();
  const deployedByName = new Map(
    deployed.map((item) => [item.name.replace(/^\$/, "").toLowerCase(), item]),
  );
  for (const item of effective.filter(
    (entry) => entry.kind === "skill" && entry.provenance === "organization",
  )) {
    rows.set(item.name.toLowerCase(), {
      key: `organization:${item.capabilityId}`,
      capabilityId: item.capabilityId,
      name: item.name,
      description:
        item.description?.trim()
        || deployedByName.get(item.name.toLowerCase())?.description
        || "Managed by your organization",
      content: item.content ?? null,
      enabled: item.enabled,
      locked: item.locked,
      provenance: "organization",
      assignment: item.assignment,
      reason: item.reason,
    });
  }
  for (const item of personal) {
    rows.set(item.name.toLowerCase(), {
      key: `personal:${item.id}`,
      capabilityId: item.id,
      name: item.name,
      description: item.description,
      content: item.content,
      enabled: item.enabled,
      locked: false,
      provenance: "personal",
      assignment: null,
      reason: "personal",
      personal: item,
    });
  }
  for (const item of deployed) {
    const key = item.name.replace(/^\$/, "").toLowerCase();
    if (!isManagedSkillDuplicate(item.name, effective) && !rows.has(key))
      rows.set(key, {
        key: `deployment:${item.id}`,
        capabilityId: item.id,
        name: item.name.replace(/^\$/, ""),
        description: item.description,
        content: null,
        enabled: item.enabled,
        locked: true,
        provenance: "self-host-bootstrap",
        assignment: null,
        reason: "deployment",
      });
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.provenance.localeCompare(b.provenance) || a.name.localeCompare(b.name),
  );
}

export function isManagedSkillDuplicate(
  deployedName: string,
  effective: EffectiveCapability[],
): boolean {
  const key = deployedName.replace(/^\$/, "").toLowerCase();
  return effective.some((item) =>
    item.kind === "skill"
    && item.provenance === "organization"
    && item.capabilityId.replace(/^\$/, "").toLowerCase() === key,
  );
}

export function skillControlHint(
  skill: Pick<SkillCatalogRow, "enabled" | "locked" | "personal">,
  hasClient: boolean,
): string {
  if (!hasClient) return "Connect to Berry to change this setting";
  if (skill.locked)
    return skill.enabled
      ? "Required by your organization"
      : "Disabled by your organization";
  return skill.enabled ? "On" : "Off";
}

export function PersonalMcpScreen({ client, config }: ManagementScreenProps) {
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<PersonalMcpServer | null>(
    null,
  );
  const [message, setMessage] = React.useState("");
  const resource = useResource(
    "personal-mcp",
    async () =>
      client
        ? client.listPersonalMcpServers()
        : config.mcpServers.map((server) => ({
            id: server.id,
            tenantId: "demo",
            userId: "demo",
            name: server.name,
            url: server.url,
            transport: "streamable-http" as const,
            auth: server.auth,
            credentialRef: null,
            credentialConfigured: false,
            enabled: server.enabled,
            trusted: true,
            health: "healthy" as const,
            toolCount: 0,
            lastCheckedAt: null,
            diagnostics: [],
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          })),
    [] as PersonalMcpServer[],
  );
  const rows = resource.data.filter((server) =>
    `${server.name} ${server.url}`.toLowerCase().includes(query.toLowerCase()),
  );

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    const credential = String(form.get("credential"));
    await client.savePersonalMcpServer({
      name: String(form.get("name")),
      url: String(form.get("url")),
      transport: String(form.get("transport")) as
        "http-sse" | "streamable-http",
      auth: String(form.get("auth")) as "none" | "bearer" | "oauth",
      ...(credential ? { credential } : {}),
      enabled: true,
      trusted: false,
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
    <ManagementPage
      title="MCP servers"
      description="Inspect tools, authentication state, trust, and connection health."
      eyebrow="Tools & connections"
      actions={
        <Button disabled={!client} onClick={() => setCreating(true)}>
          <Plus />
          Add server
        </Button>
      }
    >
      <Toolbar>
        <SearchInput
          label="Search MCP servers"
          value={query}
          onChange={setQuery}
          placeholder="Search servers"
        />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <ManagementDialog
        open={creating}
        onOpenChange={setCreating}
        title="Review server connection"
        description="Credentials are stored by reference and are never returned to the browser."
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
            <Button type="submit" form="create-personal-mcp-form">
              Save for testing
            </Button>
          </>
        }
      >
        <form
          id="create-personal-mcp-form"
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={save}
        >
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Name
            <Input name="name" autoFocus required />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
            HTTPS URL
            <Input name="url" type="url" required />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Transport
            <FormSelect
              name="transport"
              defaultValue="streamable-http"
              options={[
                { value: "streamable-http", label: "Streamable HTTP" },
                { value: "http-sse", label: "HTTP + SSE" },
              ]}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Authentication
            <FormSelect
              name="auth"
              defaultValue="none"
              options={[
                { value: "none", label: "None" },
                { value: "bearer", label: "Bearer token" },
                { value: "oauth", label: "OAuth" },
              ]}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Credential
            <Input name="credential" type="password" autoComplete="off" />
          </label>
        </form>
      </ManagementDialog>
      <AsyncState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.retry}
        empty={rows.length === 0}
      >
        <DataTable
          label="MCP servers"
          columns={[
            "Server",
            "Transport",
            "Authentication",
            "Trust",
            "Health",
            "Actions",
          ]}
          rows={rows.map((server) => [
            <Button
              variant="ghost"
              className="grid h-auto max-w-80 justify-start gap-0.5 p-0 text-left [&_b]:truncate [&_small]:truncate [&_small]:text-xs [&_small]:text-muted-foreground"
              onClick={() => setSelected(server)}
            >
              <b>{server.name}</b>
              <small>{server.url}</small>
            </Button>,
            server.transport,
            server.credentialConfigured
              ? `${server.auth} configured`
              : server.auth,
            server.trusted ? "Reviewed" : "Needs review",
            <StatusPill
              tone={
                server.health === "healthy"
                  ? "good"
                  : server.health === "unreachable"
                    ? "danger"
                    : "warning"
              }
            >
              {server.health}
            </StatusPill>,
            <Button
              variant="secondary"
              disabled={!client}
              onClick={() => test(server)}
            >
              <FlaskConical />
              Test
            </Button>,
          ])}
        />
      </AsyncState>
      {selected ? (
        <Detail title={selected.name} onClose={() => setSelected(null)}>
          <dl>
            <div>
              <dt>Tools</dt>
              <dd>{selected.toolCount}</dd>
            </div>
            <div>
              <dt>Authentication</dt>
              <dd>
                {selected.credentialConfigured
                  ? "Configured"
                  : "Not configured"}
              </dd>
            </div>
            <div>
              <dt>Last tested</dt>
              <dd>
                {selected.lastCheckedAt
                  ? new Date(selected.lastCheckedAt).toLocaleString()
                  : "Never"}
              </dd>
            </div>
          </dl>
          {selected.diagnostics.length ? (
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {selected.diagnostics.join(" · ")}
            </div>
          ) : null}
        </Detail>
      ) : null}
    </ManagementPage>
  );
}

function Detail({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <DetailDrawer title={title} onClose={onClose}>
      {children}
    </DetailDrawer>
  );
}
