import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { MemoryItem } from "@berry/shared";
import { Download, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  AsyncState,
  Button,
  Input,
  ManagementPage,
  ManagementSwitch,
  Section,
  StatusPill,
  formatDate,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

type MemoryResource = {
  settings: { memoryEnabled: boolean; implicitMemoryEnabled: boolean };
  items: MemoryItem[];
  nextCursor: string | null;
};

export function groupActiveMemories(items: readonly MemoryItem[]): Array<{ kind: string; items: MemoryItem[] }> {
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

export function withoutMemory(items: readonly MemoryItem[], memoryId: string): MemoryItem[] {
  return items.filter((item) => item.id !== memoryId);
}

export function MemorySettingsScreen({ client }: ManagementScreenProps) {
  const resource = useResource<MemoryResource>(
    "personal-memory",
    async () => {
      if (!client) return { settings: { memoryEnabled: true, implicitMemoryEnabled: true }, items: [], nextCursor: null };
      const [settings, page] = await Promise.all([
        client.memorySettings(),
        client.listMemories({ scope: "personal", status: "active", limit: 50 }),
      ]);
      return { settings, ...page };
    },
    { settings: { memoryEnabled: true, implicitMemoryEnabled: true }, items: [], nextCursor: null },
  );
  const [data, setData] = React.useState(resource.data);
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<MemoryItem | null>(null);
  const [confirmForget, setConfirmForget] = React.useState<string | null>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [mutationError, setMutationError] = React.useState("");
  const [kind, setKind] = React.useState("preference");
  const [content, setContent] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");

  React.useEffect(() => setData(resource.data), [resource.data]);

  const updateSetting = async (patch: { memoryEnabled?: boolean; implicitMemoryEnabled?: boolean }) => {
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
            expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
          })
        : await client.rememberMemory({
            scope: "personal",
            kind: kind.trim() || "preference",
            content: content.trim(),
            expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
          });
      if (result.item) {
        setData((current) => ({
          ...current,
          items: [result.item!, ...current.items.filter((item) => item.id !== editing?.id && item.id !== result.item!.id)],
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
      setData((current) => ({ ...current, items: withoutMemory(current.items, memoryId) }));
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
        items: [...current.items, ...page.items.filter((item) => !current.items.some((existing) => existing.id === item.id))],
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
      downloadJson(value, `berry-memory-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (cause) {
      setMutationError(message(cause, "Unable to export memory"));
    } finally {
      setBusy(null);
    }
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
    `${item.kind} ${item.content}`.toLowerCase().includes(query.trim().toLowerCase())
  );
  const groups = groupActiveMemories(filtered);
  const disabled = !data.settings.memoryEnabled;

  return (
    <ManagementPage
      title="Memory"
      description="Control the personal facts and working preferences Berry may recall across your chats and projects."
      eyebrow="Personalization"
      actions={(
        <>
          <Button variant="secondary" onClick={() => void exportMemory()} disabled={!client || busy === "export"}>
            <Download />Export
          </Button>
          <Button onClick={openCreate} disabled={!client || disabled}><Plus />Add memory</Button>
        </>
      )}
    >
      <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
        <Section title="Recall controls" description="These settings apply only to your authenticated account.">
          <div className="grid divide-y divide-border [&>label]:flex [&>label]:items-center [&>label]:justify-between [&>label]:gap-4 [&>label]:py-3 [&>label>span]:grid [&>label>span]:gap-0.5 [&_b]:text-sm [&_small]:text-xs [&_small]:text-muted-foreground">
            <label>
              <span><b>Use personal memory</b><small>Recall active facts and preferences in future chats.</small></span>
              <ManagementSwitch
                checked={data.settings.memoryEnabled}
                disabled={busy === "settings"}
                aria-label="Use personal memory"
                onCheckedChange={(memoryEnabled) => void updateSetting({ memoryEnabled })}
              />
            </label>
            <label>
              <span><b>Learn from completed chats</b><small>Propose durable facts after a turn. Explicit entries always take priority.</small></span>
              <ManagementSwitch
                checked={data.settings.implicitMemoryEnabled}
                disabled={disabled || busy === "settings"}
                aria-label="Learn from completed chats"
                onCheckedChange={(implicitMemoryEnabled) => void updateSetting({ implicitMemoryEnabled })}
              />
            </label>
          </div>
          {disabled ? <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">Recall and implicit extraction are disabled. Existing entries remain available to edit, export, or forget.</p> : null}
        </Section>

        {(creating || editing) ? (
          <Section title={editing ? "Edit memory" : "Add a memory"} description="Save only durable context you want Berry to reuse.">
            <div className="memory-editor">
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Kind<Input value={kind} maxLength={80} onChange={(event) => setKind(event.currentTarget.value)} /></label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">Memory<Input value={content} maxLength={20_000} onChange={(event) => setContent(event.currentTarget.value)} /></label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Expires<Input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.currentTarget.value)} /></label>
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={closeEditor}><X />Cancel</Button>
                <Button onClick={() => void saveMemory()} disabled={!content.trim() || busy === "create" || busy?.startsWith("edit:")}>Save</Button>
              </div>
            </div>
          </Section>
        ) : null}

        <Section
          title="Saved memory"
          description="Explicit entries are user-authored. Inferred entries were consolidated from completed chats."
          actions={<Input className="memory-search" aria-label="Search memory" placeholder="Search memory" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />}
        >
          {mutationError ? <p className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground" role="alert">{mutationError}</p> : null}
          {groups.length === 0 ? (
            <div className="memory-empty">
              <strong>{query ? "No matching memories" : "Nothing saved yet"}</strong>
              <span>{query ? "Try a different search." : "Add a preference or let Berry learn after completed chats."}</span>
            </div>
          ) : (
            <div className="memory-groups">
              {groups.map((group) => (
                <section key={group.kind} className="memory-group" aria-labelledby={`memory-kind-${group.kind}`}>
                  <header><h3 id={`memory-kind-${group.kind}`}>{humanize(group.kind)}</h3><span>{group.items.length}</span></header>
                  <div className="memory-list">
                    {group.items.map((item) => (
                      <article key={item.id} className="memory-row">
                        <div className="memory-copy">
                          <p>{item.content}</p>
                          <div className="memory-meta">
                            <StatusPill tone={item.explicit ? "info" : "neutral"}>{item.explicit ? "Explicit" : "Inferred"}</StatusPill>
                            <span>{Math.round(item.confidence * 100)}% confidence</span>
                            <span>Last used {formatDate(item.lastUsedAt)}</span>
                            {item.expiresAt ? <span>Expires {formatDate(item.expiresAt)}</span> : null}
                            {item.sourceTaskId ? <a href={`/tasks/${encodeURIComponent(item.sourceTaskId)}`}>Source task</a> : null}
                          </div>
                        </div>
                        <div className="memory-actions">
                          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${item.content}`} onClick={() => openEdit(item)}><Pencil /></Button>
                          {confirmForget === item.id ? (
                            <>
                              <Button variant="ghost" size="sm" onClick={() => setConfirmForget(null)}>Keep</Button>
                              <Button variant="destructive" size="sm" disabled={busy === `forget:${item.id}`} onClick={() => void forget(item.id)}>Forget</Button>
                            </>
                          ) : (
                            <Button variant="ghost" size="icon-sm" aria-label={`Forget ${item.content}`} onClick={() => setConfirmForget(item.id)}><Trash2 /></Button>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          {data.nextCursor && !query ? <Button variant="outline" onClick={() => void loadMore()} disabled={busy === "more"}>Load more</Button> : null}
          <div className="memory-clear">
            {confirmClear ? (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                <strong>Forget all personal memory?</strong>
                <span>This removes every active personal entry from recall while preserving the audit/version history.</span>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="ghost" onClick={() => setConfirmClear(false)}>Cancel</Button>
                  <Button variant="destructive" disabled={busy === "clear"} onClick={() => void clearAll()}>Forget all</Button>
                </div>
              </div>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmClear(true)} disabled={data.items.length === 0}><Trash2 />Clear all personal memory</Button>
            )}
          </div>
        </Section>
      </AsyncState>
    </ManagementPage>
  );
}

function humanize(value: string): string {
  const text = value.replaceAll("_", " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Other";
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function downloadJson(value: unknown, name: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export type MemoryClient = Pick<
  BerryApiClient,
  "listMemories" | "memorySettings" | "updateMemorySettings" | "rememberMemory" | "updateMemory" | "forgetMemory" | "clearMemories" | "exportMemories"
>;
