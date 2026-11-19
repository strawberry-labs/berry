import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { MemoryItem } from "@berry/shared";
import { Check, ClipboardCopy, Download, Pencil, Plus, Trash2, Upload } from "lucide-react";
import {
  AsyncState,
  Button,
  FormSelect,
  InlineNotice,
  Input,
  ManagementDialog,
  ManagementPage,
  ManagementSwitch,
  SearchInput,
  Section,
  SettingList,
  SettingRow,
  StatusPill,
  Textarea,
  formatDate,
  formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { FillHeightScroller, InfiniteScrollTrigger } from "../infinite-scroll-trigger";

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

export function MemorySettingsScreen({ client, embedded = false, lead }: ManagementScreenProps & { embedded?: boolean; lead?: React.ReactNode }) {
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

  const [loadMoreError, setLoadMoreError] = React.useState<string | null>(null);
  const loadMore = async () => {
    if (!client || !data.nextCursor || busy) return;
    setBusy("more");
    setLoadMoreError(null);
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
      setLoadMoreError(message(cause, "Unable to load more memories"));
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
  const forgetTarget = confirmForget ? data.items.find((item) => item.id === confirmForget) ?? null : null;
  const dialogOpen = importOpen || creating || Boolean(editing) || Boolean(forgetTarget) || confirmClear;
  const errorNotice = mutationError ? <InlineNotice tone="danger">{mutationError}</InlineNotice> : null;
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
        {disabled ? (
          <InlineNotice tone="warning" title="Memory is off">
            Berry is not recalling or saving anything. Your saved entries stay here to edit, export or forget.
          </InlineNotice>
        ) : null}
        {!dialogOpen ? errorNotice : null}

        <Section
          title="Saved memory"
          description="What Berry can recall when it starts your tasks. Entries are either added by you or learned from completed tasks."
          actions={data.items.length > 0 ? <SearchInput label="Search memory" placeholder="Search memory" value={query} onChange={setQuery} /> : undefined}
          flush
        >
          {groups.length === 0 ? (
            <div className="grid justify-items-center gap-1 px-6 py-10 text-center">
              <strong className="text-sm font-medium text-foreground">
                {query ? "No matching memories" : "Nothing saved yet"}
              </strong>
              <span className="max-w-md text-md leading-5 text-muted-foreground">
                {query
                  ? data.nextCursor ? "Nothing in the entries loaded so far. Clear the search and scroll the list to load older memories." : "Try a different search."
                  : disabled ? "Turn on memory below to start saving entries." : "Add a memory yourself, import from another assistant, or let Berry learn from completed tasks."}
              </span>
              {!query && !disabled && client ? <Button className="mt-3" variant="secondary" onClick={openCreate}><Plus />Add memory</Button> : null}
            </div>
          ) : (
            <FillHeightScroller>
            <div className="grid divide-y divide-border">
              {groups.map((group) => (
                <section key={group.kind} aria-labelledby={`memory-kind-${group.kind}`}>
                  <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-[var(--berry-surface-under)] px-4 py-1.5">
                    <h3 id={`memory-kind-${group.kind}`} className="text-xs font-medium text-muted-foreground">
                      {humanize(group.kind)}
                    </h3>
                    <span className="text-xs text-muted-foreground tabular-nums">{group.items.length}</span>
                  </header>
                  <div className="grid divide-y divide-border">
                    {group.items.map((item) => (
                      <article key={item.id} className="flex items-start gap-3 px-4 py-3 hover:bg-[var(--berry-hover)]">
                        <div className="grid min-w-0 flex-1 gap-1.5">
                          <p className="text-md leading-5 text-foreground [overflow-wrap:anywhere]">{item.content}</p>
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                            <StatusPill tone={item.explicit ? "info" : "neutral"}>
                              {item.explicit ? "Added by you" : "Learned"}
                            </StatusPill>
                            {!item.explicit ? <span>{Math.round(item.confidence * 100)}% confidence</span> : null}
                            <span>{item.lastUsedAt ? `Last used ${formatDate(item.lastUsedAt)}` : "Not used yet"}</span>
                            {item.expiresAt ? <span>Expires {formatDate(item.expiresAt)}</span> : null}
                            {item.sourceTaskId ? (
                              <a className="text-foreground underline underline-offset-2" href={`/tasks/${encodeURIComponent(item.sourceTaskId)}`}>
                                Source task
                              </a>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${item.content}`} disabled={!client} onClick={() => openEdit(item)}>
                            <Pencil />
                          </Button>
                          <Button variant="ghost" size="icon-sm" aria-label={`Forget ${item.content}`} disabled={!client} onClick={() => { setMutationError(""); setConfirmForget(item.id); }}>
                            <Trash2 />
                          </Button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
            <InfiniteScrollTrigger
              className="border-t border-border"
              hasMore={Boolean(client && data.nextCursor)}
              loading={busy === "more"}
              error={loadMoreError}
              onLoadMore={() => void loadMore()}
            />
            </FillHeightScroller>
          )}
          {data.nextCursor && query ? (
            <p className="border-t border-border px-4 py-2 text-center text-xs text-muted-foreground">Search covers the {formatNumber(data.items.length)} entries loaded so far. Scroll the list to load older ones.</p>
          ) : null}
        </Section>

        <Section title="Memory settings" flush>
          <SettingList>
            <SettingRow title="Use memory" description="Berry recalls your saved entries when it starts a task. Turning this off keeps the entries but stops recall and learning.">
              <ManagementSwitch
                checked={data.settings.memoryEnabled}
                disabled={!client || busy === "settings"}
                aria-label="Use personal memory"
                onCheckedChange={(memoryEnabled) => void updateSetting({ memoryEnabled })}
              />
            </SettingRow>
            <SettingRow
              title="Learn from completed tasks"
              description={disabled
                ? "Unavailable while memory is off."
                : "Berry saves new entries on its own after a task finishes. When off, only entries you add are saved."}
            >
              <ManagementSwitch
                checked={data.settings.implicitMemoryEnabled}
                disabled={!client || disabled || busy === "settings"}
                aria-label="Learn from completed tasks"
                onCheckedChange={(implicitMemoryEnabled) => void updateSetting({ implicitMemoryEnabled })}
              />
            </SettingRow>
            <SettingRow title="Forget everything" description="Remove every saved entry from recall. This can’t be undone from here; export first if you want a copy.">
              <Button variant="secondary" onClick={() => { setMutationError(""); setConfirmClear(true); }} disabled={!client || data.items.length === 0}>
                <Trash2 />
                Forget all memory
              </Button>
            </SettingRow>
          </SettingList>
        </Section>

        <ManagementDialog
          open={importOpen}
          onOpenChange={(open) => {
            if (!open) closeImport();
          }}
          title="Import memory"
          description="Bring preferences and context over from ChatGPT, Claude or another assistant. Review the pasted text before importing it."
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="memory-import-step-one" className="text-md font-medium text-foreground">1. Ask your current assistant to export its memory</h3>
                <Button variant="secondary" onClick={() => void copyImportPrompt()}>
                  {promptCopied ? <Check /> : <ClipboardCopy />}
                  {promptCopied ? "Copied" : "Copy prompt"}
                </Button>
              </div>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--berry-surface-under)] p-3 text-xs leading-5 text-muted-foreground">
                {MEMORY_EXPORT_PROMPT}
              </pre>
            </section>

            <section className="grid gap-2" aria-labelledby="memory-import-step-two">
              <h3 id="memory-import-step-two" className="text-md font-medium text-foreground">2. Paste what it gives you</h3>
              <Textarea
                aria-label="Exported memories"
                className="min-h-44 resize-y"
                placeholder="Paste the export here"
                value={importText}
                onChange={(event) => setImportText(event.currentTarget.value)}
              />
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {importText.trim()
                  ? `${importEntries.length} ${importEntries.length === 1 ? "memory" : "memories"} ready to import. Wording, categories and known source dates are kept.`
                  : "Berry imports every entry it detects and merges duplicates."}
              </p>
              {errorNotice}
            </section>
          </div>
        </ManagementDialog>

        <ManagementDialog
          open={Boolean(creating || editing)}
          onOpenChange={(open) => {
            if (!open) closeEditor();
          }}
          title={editing ? "Edit memory" : "Add a memory"}
          description="Save lasting context you want Berry to reuse, such as a preference or how you like work done."
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
                {busy === "create" || busy?.startsWith("edit:") ? "Saving…" : "Save memory"}
              </Button>
            </>
          }
        >
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Memory
              <Textarea
                className="min-h-24 resize-y"
                value={content}
                maxLength={20_000}
                placeholder="I prefer short answers with the sources listed at the end."
                onChange={(event) => setContent(event.currentTarget.value)}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs font-medium text-foreground">
                Category
                <FormSelect
                  ariaLabel="Category"
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
              <label className="grid gap-1.5 text-xs font-medium text-foreground">
                Expires
                <Input
                  type="date"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.currentTarget.value)}
                />
                <span className="font-normal text-muted-foreground">Optional. Berry stops using the memory after this date.</span>
              </label>
            </div>
            {errorNotice}
          </div>
        </ManagementDialog>

        <ManagementDialog
          open={Boolean(forgetTarget)}
          onOpenChange={(open) => { if (!open && !busy) setConfirmForget(null); }}
          title="Forget this memory?"
          description="Berry will stop recalling it. This can’t be undone from here."
          size="sm"
          footer={
            <>
              <Button variant="secondary" disabled={Boolean(busy)} onClick={() => setConfirmForget(null)}>Keep</Button>
              <Button variant="destructive" disabled={Boolean(busy)} onClick={() => { if (forgetTarget) void forget(forgetTarget.id); }}>
                {busy?.startsWith("forget:") ? "Forgetting…" : "Forget memory"}
              </Button>
            </>
          }
        >
          <div className="grid gap-3">
            <p className="line-clamp-6 rounded-lg bg-[var(--berry-surface-under)] px-3 py-2 text-md leading-5 text-foreground [overflow-wrap:anywhere]">{forgetTarget?.content}</p>
            {errorNotice}
          </div>
        </ManagementDialog>

        <ManagementDialog
          open={confirmClear}
          onOpenChange={(open) => { if (!open && busy !== "clear") setConfirmClear(false); }}
          title="Forget all memory?"
          description="Every saved entry is removed from recall, including ones not loaded on this page. Version history is kept for audit."
          size="sm"
          footer={
            <>
              <Button variant="secondary" disabled={busy === "clear"} onClick={() => setConfirmClear(false)}>Cancel</Button>
              <Button variant="destructive" disabled={busy === "clear"} onClick={() => void clearAll()}>
                {busy === "clear" ? "Forgetting…" : "Forget all"}
              </Button>
            </>
          }
        >
          <div className="grid gap-3">
            <p className="text-md leading-5 text-muted-foreground">Export first if you want a copy. The memory settings stay as they are.</p>
            {errorNotice}
          </div>
        </ManagementDialog>
      </AsyncState>
  );
  if (embedded) return <div className="grid min-w-0 gap-5"><div className="flex flex-wrap items-center justify-between gap-2">{lead ?? <span />}<div className="flex flex-wrap items-center gap-2">{actions}</div></div>{screenContent}</div>;
  return <ManagementPage width="narrow" title="Memory" description="Review and manage what Berry remembers about you." actions={actions}>{screenContent}</ManagementPage>;
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
