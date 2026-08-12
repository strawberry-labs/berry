import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { MemoryItem } from "@berry/shared";
import { Check, ClipboardCopy, Download, Pencil, Plus, Trash2, Upload } from "lucide-react";
import {
  AsyncState,
  Button,
  Input,
  ManagementDialog,
  ManagementPage,
  ManagementSwitch,
  FormSelect,
  Section,
  StatusPill,
  Textarea,
  formatDate,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

const MEMORY_IMPORT_CONCURRENCY = 4;

const MEMORY_SECTION_KINDS: Record<string, string> = {
  instructions: "working_convention",
  identity: "profile",
  career: "career",
  projects: "project",
  preferences: "preference",
};

export const MEMORY_EXPORT_PROMPT = `Export all of my stored memories and any context you've learned about me from past conversations. Preserve my words verbatim where possible, especially for instructions and preferences.

## Categories (output in this order):

1. **Instructions**: Rules I've explicitly asked you to follow going forward — tone, format, style, "always do X", "never do Y", and corrections to your behavior. Only include rules from stored memories, not from conversations.

2. **Identity**: Name, age, location, education, family, relationships, languages, and personal interests.

3. **Career**: Current and past roles, companies, and general skill areas.

4. **Projects**: Projects I meaningfully built or committed to. Ideally ONE entry per project. Include what it does, current status, and any key decisions. Use the project name or a short descriptor as the first words of the entry.

5. **Preferences**: Opinions, tastes, and working-style preferences that apply broadly.

## Format:

Use section headers for each category. Within each category, list one entry per line, sorted by oldest date first. Format each line as:

[YYYY-MM-DD] - Entry content here.

If no date is known, use [unknown] instead.

## Output:
- Wrap the entire export in a single code block for easy copying.
- After the code block, state whether this is the complete set or if more remain.`;

export type MemoryImportEntry = {
  kind: string;
  content: string;
  sourceDate: string | null;
};

type MemoryResource = {
  settings: { memoryEnabled: boolean; implicitMemoryEnabled: boolean };
  items: MemoryItem[];
  nextCursor: string | null;
};

export function groupActiveMemories(
  items: readonly MemoryItem[],
): Array<{ kind: string; items: MemoryItem[] }> {
  const groups = new Map<string, MemoryItem[]>();
  for (const item of items) {
    if (item.status !== "active") continue;
    const group = groups.get(item.kind) ?? [];
    group.push(item);
    groups.set(item.kind, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, grouped]) => ({ kind, items: grouped }));
}

export function withoutMemory(
  items: readonly MemoryItem[],
  memoryId: string,
): MemoryItem[] {
  return items.filter((item) => item.id !== memoryId);
}

export function parseMemoryImport(value: string): MemoryImportEntry[] {
  const body = firstCodeBlock(value.trim());
  const jsonEntries = parseMemoryJson(body);
  if (jsonEntries) return dedupeImportEntries(jsonEntries);

  const entries: MemoryImportEntry[] = [];
  let kind = "preference";
  let pending: MemoryImportEntry | null = null;
  const flushPending = () => {
    if (!pending) return;
    const entry = pending;
    pending = null;
    if (!isEmptySectionStatement(entry.content)) entries.push(entry);
  };
  for (const rawLine of body.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line === "```") continue;

    const heading = importHeading(line);
    if (heading) {
      flushPending();
      kind = heading;
      continue;
    }

    if (/^(?:this is )?(?:the )?complete set\b|^no (?:more|additional) memories\b|^more (?:memories|items) remain\b/i.test(line)) {
      flushPending();
      continue;
    }

    const dated = line.match(/^(?:[-*•]\s*)?\[(\d{4}-\d{2}-\d{2}|unknown)\]\s*[-‐‑‒–—−:]\s*(.*)$/i);
    if (dated) {
      flushPending();
      const content = dated[2]?.trim() ?? "";
      if (content) {
        pending = {
          kind,
          content,
          sourceDate: dated[1]?.toLowerCase() === "unknown" ? null : dated[1] ?? null,
        };
      }
      continue;
    }

    const listed = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/)?.[1]?.trim();
    if (listed) {
      flushPending();
      if (!isEmptySectionStatement(listed)) {
        entries.push({ kind, content: listed, sourceDate: null });
      }
      continue;
    }

    if (pending) {
      pending = { ...pending, content: `${pending.content} ${line}`.trim() };
      continue;
    }

    if (!isEmptySectionStatement(line)) {
      entries.push({ kind, content: line, sourceDate: null });
    }
  }
  flushPending();
  return dedupeImportEntries(entries);
}

export async function importMemoryEntries(
  client: Pick<BerryApiClient, "rememberMemory">,
  entries: readonly MemoryImportEntry[],
): Promise<{ imported: MemoryItem[]; failures: MemoryImportEntry[] }> {
  const imported: MemoryItem[] = [];
  const failures: MemoryImportEntry[] = [];
  await runWithConcurrency(entries, MEMORY_IMPORT_CONCURRENCY, async (entry) => {
    try {
      const result = await client.rememberMemory({
        scope: "personal",
        kind: entry.kind,
        content: entry.content,
        value: {
          importedFrom: "assistant_export",
          ...(entry.sourceDate ? { sourceDate: entry.sourceDate } : {}),
        },
      });
      if (result.item) imported.push(result.item);
    } catch {
      failures.push(entry);
    }
  });
  return { imported, failures };
}

export function MemorySettingsScreen({ client, embedded = false }: ManagementScreenProps & { embedded?: boolean }) {
  const resource = useResource<MemoryResource>(
    "personal-memory",
    async () => {
      if (!client)
        return {
          settings: { memoryEnabled: true, implicitMemoryEnabled: true },
          items: [],
          nextCursor: null,
        };
      const [settings, page] = await Promise.all([
        client.memorySettings(),
        client.listMemories({ scope: "personal", status: "active", limit: 50 }),
      ]);
      return { settings, ...page };
    },
    {
      settings: { memoryEnabled: true, implicitMemoryEnabled: true },
      items: [],
      nextCursor: null,
    },
  );
  const [data, setData] = React.useState(resource.data);
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [importText, setImportText] = React.useState("");
  const [promptCopied, setPromptCopied] = React.useState(false);
  const [editing, setEditing] = React.useState<MemoryItem | null>(null);
  const [confirmForget, setConfirmForget] = React.useState<string | null>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [mutationError, setMutationError] = React.useState("");
  const [kind, setKind] = React.useState("preference");
  const [content, setContent] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const importEntries = React.useMemo(() => parseMemoryImport(importText), [importText]);

  React.useEffect(() => setData(resource.data), [resource.data]);

  const updateSetting = async (patch: {
    memoryEnabled?: boolean;
    implicitMemoryEnabled?: boolean;
  }) => {
    if (!client || busy) return;
    const previous = data.settings;
    const optimistic = { ...previous, ...patch };
    setData((current) => ({ ...current, settings: optimistic }));
    setBusy("settings");
    setMutationError("");
    try {
      const settings = await client.updateMemorySettings(patch);
      setData((current) => ({ ...current, settings }));
    } catch (cause) {
      setData((current) => ({ ...current, settings: previous }));
      setMutationError(message(cause, "Unable to update memory settings"));
    } finally {
      setBusy(null);
    }
  };

  const saveMemory = async () => {
    if (!client || !content.trim() || busy) return;
    setBusy(editing ? `edit:${editing.id}` : "create");
    setMutationError("");
    try {
      const result = editing
        ? await client.updateMemory(editing.id, {
            content: content.trim(),
            kind: kind.trim() || editing.kind,
            expiresAt: expiresAt
              ? new Date(`${expiresAt}T23:59:59`).toISOString()
              : null,
          })
        : await client.rememberMemory({
            scope: "personal",
            kind: kind.trim() || "preference",
            content: content.trim(),
            expiresAt: expiresAt
              ? new Date(`${expiresAt}T23:59:59`).toISOString()
              : null,
          });
      if (result.item) {
        setData((current) => ({
          ...current,
          items: [
            result.item!,
            ...current.items.filter(
              (item) => item.id !== editing?.id && item.id !== result.item!.id,
            ),
          ],
        }));
      }
      closeEditor();
    } catch (cause) {
      setMutationError(message(cause, "Unable to save this memory"));
    } finally {
      setBusy(null);
    }
  };

  const forget = async (memoryId: string) => {
    if (!client || busy) return;
    setBusy(`forget:${memoryId}`);
    setMutationError("");
    try {
      await client.forgetMemory(memoryId);
      setData((current) => ({
        ...current,
        items: withoutMemory(current.items, memoryId),
      }));
      setConfirmForget(null);
    } catch (cause) {
      setMutationError(message(cause, "Unable to forget this memory"));
    } finally {
      setBusy(null);
    }
  };

  const clearAll = async () => {
    if (!client || busy) return;
    setBusy("clear");
    setMutationError("");
    try {
      await client.clearMemories({ scope: "personal" });
      setData((current) => ({ ...current, items: [], nextCursor: null }));
      setConfirmClear(false);
    } catch (cause) {
      setMutationError(message(cause, "Unable to clear personal memory"));
    } finally {
      setBusy(null);
    }
  };

  const loadMore = async () => {
    if (!client || !data.nextCursor || busy) return;
    setBusy("more");
    try {
      const page = await client.listMemories({
        scope: "personal",
        status: "active",
        cursor: data.nextCursor,
        limit: 50,
      });
      setData((current) => ({
        ...current,
        items: [
          ...current.items,
          ...page.items.filter(
            (item) =>
              !current.items.some((existing) => existing.id === item.id),
          ),
        ],
        nextCursor: page.nextCursor,
      }));
    } catch (cause) {
      setMutationError(message(cause, "Unable to load more memories"));
    } finally {
      setBusy(null);
    }
  };

  const exportMemory = async () => {
    if (!client) return;
    setBusy("export");
    try {
      const value = await client.exportMemories();
      downloadJson(
        value,
        `berry-memory-${new Date().toISOString().slice(0, 10)}.json`,
      );
    } catch (cause) {
      setMutationError(message(cause, "Unable to export memory"));
    } finally {
      setBusy(null);
    }
  };

  const copyImportPrompt = async () => {
    setMutationError("");
    try {
      await navigator.clipboard.writeText(MEMORY_EXPORT_PROMPT);
      setPromptCopied(true);
    } catch (cause) {
      setMutationError(message(cause, "Unable to copy the export prompt"));
    }
  };

  const importMemories = async () => {
    if (!client || disabled || busy || importEntries.length === 0) return;
    setBusy("import");
    setMutationError("");
    const { imported, failures } = await importMemoryEntries(client, importEntries);
    if (imported.length > 0) {
      setData((current) => ({
        ...current,
        items: mergeMemoryItems(imported, current.items),
      }));
    }
    if (failures.length > 0) {
      setMutationError(
        `Imported ${imported.length} of ${importEntries.length} memories. ${failures.length} failed. Retrying is safe; existing entries are consolidated.`,
      );
    } else {
      setImportOpen(false);
      setImportText("");
      setPromptCopied(false);
    }
    setBusy(null);
  };

  const openImport = () => {
    setImportText("");
    setPromptCopied(false);
    setMutationError("");
    setImportOpen(true);
  };

  const closeImport = () => {
    if (busy === "import") return;
    setImportOpen(false);
    setImportText("");
    setPromptCopied(false);
    setMutationError("");
  };

  const openCreate = () => {
    setEditing(null);
    setKind("preference");
    setContent("");
    setExpiresAt("");
    setCreating(true);
  };
  const openEdit = (item: MemoryItem) => {
    setCreating(false);
    setEditing(item);
    setKind(item.kind);
    setContent(item.content);
    setExpiresAt(item.expiresAt?.slice(0, 10) ?? "");
  };
  const closeEditor = () => {
    setCreating(false);
    setEditing(null);
    setContent("");
    setExpiresAt("");
  };

  const filtered = data.items.filter((item) =>
    `${item.kind} ${item.content}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const groups = groupActiveMemories(filtered);
  const disabled = !data.settings.memoryEnabled;
  const actions = <>
    <Button variant="secondary" onClick={() => void exportMemory()} disabled={!client || busy === "export"}><Download />Export</Button>
    <Button variant="secondary" onClick={openImport} disabled={!client || disabled || Boolean(busy)}><Upload />Import</Button>
    <Button onClick={openCreate} disabled={!client || disabled}><Plus />Add memory</Button>
  </>;

  const screenContent = (
      <AsyncState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.retry}
      >
        <Section>
          <div className="grid divide-y divide-border [&>label]:flex [&>label]:items-center [&>label]:justify-between [&>label]:gap-4 [&>label]:py-3 [&>label>span]:grid [&>label>span]:gap-0.5 [&_b]:text-sm [&_small]:text-xs [&_small]:text-muted-foreground">
            <label>
              <span>
                <b>Use personal memory</b>
              </span>
              <ManagementSwitch
                checked={data.settings.memoryEnabled}
                disabled={busy === "settings"}
                aria-label="Use personal memory"
                onCheckedChange={(memoryEnabled) =>
                  void updateSetting({ memoryEnabled })
                }
              />
            </label>
            <label>
              <span>
                <b>Learn from completed chats</b>
              </span>
              <ManagementSwitch
                checked={data.settings.implicitMemoryEnabled}
                disabled={disabled || busy === "settings"}
                aria-label="Learn from completed chats"
                onCheckedChange={(implicitMemoryEnabled) =>
                  void updateSetting({ implicitMemoryEnabled })
                }
              />
            </label>
          </div>
          {disabled ? (
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Recall and implicit extraction are disabled. Existing entries
              remain available to edit, export, or forget.
            </p>
          ) : null}
        </Section>

        <ManagementDialog
          open={importOpen}
          onOpenChange={(open) => {
            if (!open) closeImport();
          }}
          title="Import memory"
          description="Move durable preferences and context from ChatGPT, Claude, or another assistant. Review the pasted text before importing it."
          size="lg"
          footer={
            <>
              <Button variant="secondary" onClick={closeImport} disabled={busy === "import"}>
                Cancel
              </Button>
              <Button
                onClick={() => void importMemories()}
                disabled={busy === "import" || importEntries.length === 0}
              >
                <Upload />
                {busy === "import"
                  ? "Importing…"
                  : `Import ${importEntries.length || ""} ${importEntries.length === 1 ? "memory" : "memories"}`.replace("  ", " ")}
              </Button>
            </>
          }
        >
          <div className="grid gap-5">
            <section className="grid gap-2" aria-labelledby="memory-import-step-one">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-full bg-[var(--berry-control-bg)] text-xs font-semibold text-[var(--berry-text-secondary)]">1</span>
                  <h3 id="memory-import-step-one" className="text-sm font-medium text-foreground">Ask your current AI to export its memory</h3>
                </div>
                <Button variant="secondary" size="sm" onClick={() => void copyImportPrompt()}>
                  {promptCopied ? <Check /> : <ClipboardCopy />}
                  {promptCopied ? "Copied" : "Copy prompt"}
                </Button>
              </div>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--berry-border)] bg-[var(--berry-surface-under)] p-3 text-xs leading-5 text-[var(--berry-text-secondary)]">
                {MEMORY_EXPORT_PROMPT}
              </pre>
            </section>

            <section className="grid gap-2" aria-labelledby="memory-import-step-two">
              <div className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-full bg-[var(--berry-control-bg)] text-xs font-semibold text-[var(--berry-text-secondary)]">2</span>
                <h3 id="memory-import-step-two" className="text-sm font-medium text-foreground">Paste the exported memories</h3>
              </div>
              <Textarea
                aria-label="Exported memories"
                className="min-h-44 resize-y text-sm leading-5"
                placeholder="Paste the export here"
                value={importText}
                onChange={(event) => setImportText(event.currentTarget.value)}
              />
              <p className="text-xs text-[var(--berry-text-tertiary)]" aria-live="polite">
                {importText.trim()
                  ? `${importEntries.length} ${importEntries.length === 1 ? "memory" : "memories"} ready to import. Wording, categories and known source dates are preserved.`
                  : "Berry imports every detected entry, with duplicates consolidated."}
              </p>
              {mutationError ? <p className="text-xs text-destructive" role="alert">{mutationError}</p> : null}
            </section>
          </div>
        </ManagementDialog>

        <ManagementDialog
          open={Boolean(creating || editing)}
          onOpenChange={(open) => {
            if (!open) closeEditor();
          }}
          title={editing ? "Edit memory" : "Add a memory"}
          description="Save only durable context you want Berry to reuse."
          footer={
            <>
              <Button variant="secondary" onClick={closeEditor}>
                Cancel
              </Button>
              <Button
                onClick={() => void saveMemory()}
                disabled={
                  !content.trim() ||
                  busy === "create" ||
                  busy?.startsWith("edit:")
                }
              >
                Save memory
              </Button>
            </>
          }
        >
          <div className="memory-editor">
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Category
              <FormSelect
                value={kind}
                onChange={setKind}
                options={[
                  { value: "profile", label: "Profile" },
                  { value: "preference", label: "Preference" },
                  { value: "communication_style", label: "Communication style" },
                  { value: "accessibility", label: "Accessibility" },
                  { value: "working_convention", label: "Working convention" },
                  ...(!["profile", "preference", "communication_style", "accessibility", "working_convention"].includes(kind) ? [{ value: kind, label: humanize(kind) }] : []),
                ]}
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
              Memory
              <Input
                value={content}
                maxLength={20_000}
                onChange={(event) => setContent(event.currentTarget.value)}
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Expires
              <Input
                type="date"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.currentTarget.value)}
              />
            </label>
          </div>
        </ManagementDialog>

        <Section
          title="Saved memory"
          description="Explicit entries are user-authored. Inferred entries were consolidated from completed chats."
          actions={
            <Input
              className="memory-search"
              aria-label="Search memory"
              placeholder="Search memory"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          }
        >
          {mutationError ? (
            <p
              className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground"
              role="alert"
            >
              {mutationError}
            </p>
          ) : null}
          {groups.length === 0 ? (
            <div className="memory-empty">
              <strong>
                {query ? "No matching memories" : "Nothing saved yet"}
              </strong>
              <span>
                {query
                  ? "Try a different search."
                  : "Add a preference or let Berry learn after completed chats."}
              </span>
            </div>
          ) : (
            <div className="memory-groups">
              {groups.map((group) => (
                <section
                  key={group.kind}
                  className="memory-group"
                  aria-labelledby={`memory-kind-${group.kind}`}
                >
                  <header>
                    <h3 id={`memory-kind-${group.kind}`}>
                      {humanize(group.kind)}
                    </h3>
                    <span>{group.items.length}</span>
                  </header>
                  <div className="memory-list">
                    {group.items.map((item) => (
                      <article key={item.id} className="memory-row">
                        <div className="memory-copy">
                          <p>{item.content}</p>
                          <div className="memory-meta">
                            <StatusPill
                              tone={item.explicit ? "info" : "neutral"}
                            >
                              {item.explicit ? "Explicit" : "Inferred"}
                            </StatusPill>
                            <span>
                              {Math.round(item.confidence * 100)}% confidence
                            </span>
                            <span>Last used {formatDate(item.lastUsedAt)}</span>
                            {item.expiresAt ? (
                              <span>Expires {formatDate(item.expiresAt)}</span>
                            ) : null}
                            {item.sourceTaskId ? (
                              <a
                                href={`/tasks/${encodeURIComponent(item.sourceTaskId)}`}
                              >
                                Source task
                              </a>
                            ) : null}
                          </div>
                        </div>
                        <div className="memory-actions">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Edit ${item.content}`}
                            onClick={() => openEdit(item)}
                          >
                            <Pencil />
                          </Button>
                          {confirmForget === item.id ? (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setConfirmForget(null)}
                              >
                                Keep
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={busy === `forget:${item.id}`}
                                onClick={() => void forget(item.id)}
                              >
                                Forget
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Forget ${item.content}`}
                              onClick={() => setConfirmForget(item.id)}
                            >
                              <Trash2 />
                            </Button>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          {data.nextCursor && !query ? (
            <Button
              variant="outline"
              onClick={() => void loadMore()}
              disabled={busy === "more"}
            >
              Load more
            </Button>
          ) : null}
          <div className="memory-clear">
            {confirmClear ? (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                <strong>Forget all personal memory?</strong>
                <span>
                  This removes every active personal entry from recall while
                  preserving the audit/version history.
                </span>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => setConfirmClear(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={busy === "clear"}
                    onClick={() => void clearAll()}
                  >
                    Forget all
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                onClick={() => setConfirmClear(true)}
                disabled={data.items.length === 0}
              >
                <Trash2 />
                Clear all personal memory
              </Button>
            )}
          </div>
        </Section>
      </AsyncState>
  );
  if (embedded) return <div className="grid min-w-0 gap-4"><div className="flex flex-wrap justify-end gap-2">{actions}</div>{screenContent}</div>;
  return <ManagementPage title="Memory" description="Review the durable context Berry can recall." actions={actions}>{screenContent}</ManagementPage>;
}

function humanize(value: string): string {
  const text = value.replaceAll("_", " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Other";
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function downloadJson(value: unknown, name: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function firstCodeBlock(value: string): string {
  return value.match(/```(?:[\w-]+)?\s*\n([\s\S]*?)```/)?.[1]?.trim() ?? value;
}

function importHeading(value: string): string | null {
  const normalized = value
    .replace(/^#{1,6}\s*/, "")
    .replaceAll("**", "")
    .replaceAll("__", "")
    .replace(/^(?:\d+[.)]\s*)/, "")
    .replace(/:$/, "")
    .trim();
  const match = normalized.match(/^(instructions|identity|career|projects|preferences)$/i);
  return match?.[1] ? MEMORY_SECTION_KINDS[match[1].toLowerCase()] ?? null : null;
}

function parseMemoryJson(value: string): MemoryImportEntry[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
        ? (parsed as { items: unknown[] }).items
        : null;
    if (!items) return null;
    return items.flatMap((item): MemoryImportEntry[] => {
      if (!item || typeof item !== "object") return [];
      const memory = item as { content?: unknown; kind?: unknown; scope?: unknown; status?: unknown };
      if (memory.scope === "project" || (memory.status && memory.status !== "active")) return [];
      if (typeof memory.content !== "string" || !memory.content.trim()) return [];
      const kind = typeof memory.kind === "string" && memory.kind.trim()
        ? memory.kind.trim().slice(0, 80)
        : "preference";
      return [{ kind, content: memory.content.trim(), sourceDate: null }];
    });
  } catch {
    return null;
  }
}

function dedupeImportEntries(entries: readonly MemoryImportEntry[]): MemoryImportEntry[] {
  const seen = new Set<string>();
  return entries.flatMap((entry) => splitImportEntry(entry)).filter((entry) => {
    const key = `${entry.kind}\n${entry.content.replace(/\s+/g, " ").trim().toLowerCase()}`;
    if (!entry.content.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isEmptySectionStatement(value: string): boolean {
  const text = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (/^(?:none|nothing|not applicable|n\/a)[.!]?$/.test(text)) return true;
  if (/^i (?:found|have) no\b.*\b(?:record|records|memory|memories|instruction|instructions|rule|rules|detail|details|information|context|item|items)\b/.test(text)) return true;
  return /^no\b.*\b(?:record|records|memory|memories|instruction|instructions|rule|rules|detail|details|information|context|item|items)\b.*\b(?:found|available|present|stored|recorded|provided|identified|remain|exists?)\b/.test(text);
}

function splitImportEntry(entry: MemoryImportEntry): MemoryImportEntry[] {
  const content = entry.content.replace(/\s+/g, " ").trim();
  if (content.length <= 20_000) return content ? [{ ...entry, content }] : [];
  const parts: MemoryImportEntry[] = [];
  let rest = content;
  while (rest.length > 20_000) {
    const boundary = Math.max(
      rest.lastIndexOf(". ", 19_950),
      rest.lastIndexOf("; ", 19_950),
      rest.lastIndexOf(" ", 19_950),
    );
    const end = boundary > 1_000 ? boundary + 1 : 20_000;
    parts.push({ ...entry, content: rest.slice(0, end).trim() });
    rest = rest.slice(end).trim();
  }
  if (rest) parts.push({ ...entry, content: rest });
  return parts;
}

function mergeMemoryItems(imported: readonly MemoryItem[], current: readonly MemoryItem[]): MemoryItem[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of imported) byId.set(item.id, item);
  const importedIds = new Set(imported.map((item) => item.id));
  return [
    ...imported.filter((item, index) => imported.findIndex((candidate) => candidate.id === item.id) === index),
    ...current.filter((item) => !importedIds.has(item.id)),
  ].filter((item) => byId.has(item.id));
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) await run(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}

export type MemoryClient = Pick<
  BerryApiClient,
  | "listMemories"
  | "memorySettings"
  | "updateMemorySettings"
  | "rememberMemory"
  | "updateMemory"
  | "forgetMemory"
  | "clearMemories"
  | "exportMemories"
>;
