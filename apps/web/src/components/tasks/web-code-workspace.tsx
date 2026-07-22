import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { CloudGitState, CloudPreview, CloudTerminalEvent, CloudTerminalSession, CloudWorkspaceFileEntry, CloudWorkspaceState } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { FileText, Files, GitBranch, Globe, RefreshCw, SquareTerminal, X } from "@berry/desktop-ui/lib/icons";
import { toast } from "sonner";

type Tab = "files" | "terminal" | "changes" | "preview";
const TABS: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
  { id: "files", label: "Files", icon: Files },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "changes", label: "Changes", icon: GitBranch },
  { id: "preview", label: "Preview", icon: Globe },
];

export function WebCodeWorkspace({ taskId, client }: { taskId: string; client: BerryApiClient | null }) {
  const storageKey = `berry.web.code-workspace.${taskId}`;
  const [tab, setTab] = React.useState<Tab>("files");
  const [state, setState] = React.useState<CloudWorkspaceState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  React.useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (saved && TABS.some((entry) => entry.id === saved)) setTab(saved as Tab);
  }, [storageKey]);
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    (client ? client.ensureTaskWorkspace(taskId) : Promise.resolve(demoState(taskId)))
      .then((next) => { if (!cancelled) setState(next); })
      .catch((cause) => { if (!cancelled) setError(message(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, taskId]);
  const selectTab = (next: Tab) => { setTab(next); window.localStorage.setItem(storageKey, next); };

  return (
    <>
    <Button className="berry-code-workspace-mobile-open" size="sm" onClick={() => setMobileOpen(true)}><SquareTerminal /> Workspace</Button>
    <aside className={`berry-code-workspace${mobileOpen ? " is-mobile-open" : ""}`} aria-label="Code workspace" data-testid="web-code-workspace">
      <div className="berry-code-workspace-tabs" role="tablist" aria-label="Code workspace panels">
        {TABS.map((entry) => <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className="berry-code-workspace-tab" onClick={() => selectTab(entry.id)}><entry.icon /><span>{entry.label}</span></button>)}
        <Button className="berry-code-workspace-mobile-close" variant="ghost" size="icon-xs" aria-label="Close code workspace" onClick={() => setMobileOpen(false)}><X /></Button>
      </div>
      <div className="berry-code-workspace-body">
        {loading ? <WorkspaceState text="Attaching sandbox…" /> : error ? <WorkspaceState text={error} action="Retry" onAction={() => window.location.reload()} /> : state ? (
          <>
            {tab === "files" ? <FilesPanel taskId={taskId} client={client} /> : null}
            {tab === "terminal" ? <TerminalPanel taskId={taskId} client={client} /> : null}
            {tab === "changes" ? <ChangesPanel taskId={taskId} client={client} /> : null}
            {tab === "preview" ? <PreviewPanel taskId={taskId} client={client} /> : null}
          </>
        ) : null}
      </div>
    </aside>
    </>
  );
}

function FilesPanel({ taskId, client }: { taskId: string; client: BerryApiClient | null }) {
  const [files, setFiles] = React.useState<CloudWorkspaceFileEntry[]>([]);
  const [path, setPath] = React.useState<string | null>(null);
  const [content, setContent] = React.useState("");
  const [dirty, setDirty] = React.useState(false);
  const load = React.useCallback(async () => setFiles(client ? await client.listWorkspaceFiles(taskId) : demoFiles()), [client, taskId]);
  React.useEffect(() => { void load().catch((cause) => toast.error(message(cause))); }, [load]);
  const open = async (nextPath: string) => {
    const file = client ? await client.readWorkspaceFile(taskId, nextPath) : { content: nextPath.endsWith("README.md") ? "# Berry web workspace\n\nEdit sandbox files safely in the browser." : "export const ready = true;" };
    setPath(nextPath); setContent(file.content); setDirty(false);
  };
  const save = async () => {
    if (!path) return;
    if (client) await client.writeWorkspaceFile(taskId, path, content);
    setDirty(false); toast.success("Saved to sandbox"); void load();
  };
  return <div className="berry-workspace-files">
    <nav className="berry-workspace-file-list" aria-label="Sandbox files">
      <div className="berry-workspace-panel-heading"><span>Workspace</span><Button variant="ghost" size="icon-xs" aria-label="Refresh files" onClick={() => void load()}><RefreshCw /></Button></div>
      {files.length ? files.map((file) => <button type="button" key={file.path} className="berry-workspace-file-row" aria-current={path === file.path ? "page" : undefined} onClick={() => file.type === "file" && void open(file.path)}><FileText /><span>{file.path.replace(/^\/workspace\//, "")}</span></button>) : <p className="berry-workspace-empty">No files yet.</p>}
    </nav>
    <section className="berry-workspace-editor" aria-label="File editor">
      {path ? <><div className="berry-workspace-panel-heading"><span className="truncate">{path.replace(/^\/workspace\//, "")}{dirty ? " •" : ""}</span><Button size="sm" disabled={!dirty} onClick={() => void save()}>Save</Button></div><textarea aria-label="File contents" spellCheck={false} value={content} onChange={(event) => { setContent(event.target.value); setDirty(true); }} /></> : <WorkspaceState text="Select a file to edit" />}
    </section>
  </div>;
}

function TerminalPanel({ taskId, client }: { taskId: string; client: BerryApiClient | null }) {
  const [terminal, setTerminal] = React.useState<CloudTerminalSession | null>(null);
  const [events, setEvents] = React.useState<CloudTerminalEvent[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { (client ? client.listWorkspaceTerminals(taskId).then(async (items) => items.find((item) => item.status !== "closed") ?? client.createWorkspaceTerminal(taskId)) : Promise.resolve(demoTerminal(taskId))).then(setTerminal).catch((cause) => toast.error(message(cause))); }, [client, taskId]);
  React.useEffect(() => {
    if (!client || !terminal) return;
    const subscription = client.subscribeWorkspaceTerminal(taskId, terminal.id, { onEvents: (next) => setEvents((current) => [...current, ...next.filter((event) => !current.some((item) => item.ordinal === event.ordinal))]), onError: (cause) => toast.error(cause.message) });
    return () => subscription.close();
  }, [client, taskId, terminal?.id]);
  const run = async () => {
    if (!terminal || !input.trim() || busy) return;
    const command = input.trim(); setInput(""); setBusy(true);
    try {
      if (client) {
        try { await client.writeWorkspaceTerminal(taskId, terminal.id, command); }
        catch (cause) {
          if (!(cause instanceof Error) || !("status" in cause) || (cause as { status?: number }).status !== 403 || !window.confirm(`Allow this terminal command?\n\n${command}`)) throw cause;
          await client.writeWorkspaceTerminal(taskId, terminal.id, command, true);
        }
      } else setEvents((current) => [...current, { ordinal: current.length, kind: "input", data: command }, { ordinal: current.length + 1, kind: "stdout", data: `$ ${command}\n/workspace\n` }]);
    } catch (cause) { toast.error(message(cause)); } finally { setBusy(false); }
  };
  return <div className="berry-workspace-terminal"><div className="berry-workspace-panel-heading"><span>Sandbox terminal</span>{terminal ? <span className="berry-workspace-status">{terminal.status}</span> : null}</div><pre aria-live="polite">{events.map((event) => <span key={event.ordinal} data-kind={event.kind}>{event.kind === "input" ? `$ ${event.data}\n` : event.data}</span>)}</pre><div className="berry-terminal-input"><span>$</span><input aria-label="Terminal command" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void run(); }} disabled={!terminal || busy} /><Button size="sm" onClick={() => void run()} disabled={!terminal || busy || !input.trim()}>Run</Button></div></div>;
}

function ChangesPanel({ taskId, client }: { taskId: string; client: BerryApiClient | null }) {
  const [git, setGit] = React.useState<CloudGitState | null>(null);
  const load = React.useCallback(() => (client ? client.workspaceGit(taskId) : Promise.resolve(demoGit())).then(setGit), [client, taskId]);
  React.useEffect(() => { void load().catch((cause) => toast.error(message(cause))); }, [load]);
  return <div className="berry-workspace-changes"><div className="berry-workspace-panel-heading"><span>{git?.branch ?? "Changes / Review"}</span><Button variant="ghost" size="icon-xs" aria-label="Refresh changes" onClick={() => void load()}><RefreshCw /></Button></div>{git ? <>{git.clean ? <WorkspaceState text="Working tree clean" /> : <><pre className="berry-git-status">{git.status}</pre><pre className="berry-git-diff">{git.diff || "No unstaged diff."}</pre></>}</> : <WorkspaceState text="Loading changes…" />}</div>;
}

function PreviewPanel({ taskId, client }: { taskId: string; client: BerryApiClient | null }) {
  const [previews, setPreviews] = React.useState<CloudPreview[]>([]);
  const [port, setPort] = React.useState("3000");
  React.useEffect(() => { (client ? client.listWorkspacePreviews(taskId) : Promise.resolve([])).then(setPreviews).catch((cause) => toast.error(message(cause))); }, [client, taskId]);
  const expose = async () => {
    const number = Number(port); if (!Number.isInteger(number) || number < 1 || number > 65535) return toast.error("Enter a valid port");
    if (client && !window.confirm(`Expose sandbox port ${number} to this private preview?`)) return;
    const preview = client ? await client.exposeWorkspacePreview(taskId, number, true) : { port: number, protocol: "https" as const, url: "https://example.com", expiresAt: null };
    setPreviews((current) => [...current.filter((entry) => entry.port !== number), preview]);
  };
  const active = previews[0] ?? null;
  return <div className="berry-workspace-preview"><div className="berry-preview-toolbar"><input aria-label="Preview port" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} /><Button size="sm" onClick={() => void expose()}>Open port</Button>{active ? <a href={active.url} target="_blank" rel="noreferrer">Open in new tab</a> : null}</div>{active ? <iframe title={`Sandbox preview on port ${active.port}`} sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts" src={active.url} /> : <WorkspaceState text="Expose a running app port to preview it here" />}</div>;
}

function WorkspaceState({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) { return <div className="berry-workspace-empty-state"><p>{text}</p>{action ? <Button size="sm" onClick={onAction}>{action}</Button> : null}</div>; }
function message(cause: unknown) { return cause instanceof Error ? cause.message : "Workspace operation failed"; }
function demoState(taskId: string): CloudWorkspaceState { return { taskId, sandboxId: `demo_${taskId}`, status: "running", root: "/workspace", provider: "fixture", expiresAt: null, updatedAt: new Date().toISOString() }; }
function demoFiles(): CloudWorkspaceFileEntry[] { return [{ path: "/workspace/README.md", type: "file", sizeBytes: 72, mtime: null }, { path: "/workspace/src/index.ts", type: "file", sizeBytes: 27, mtime: null }]; }
function demoTerminal(taskId: string): CloudTerminalSession { const now = new Date().toISOString(); return { id: `demo_terminal_${taskId}`, taskId, status: "running", cols: 80, rows: 24, createdAt: now, updatedAt: now }; }
function demoGit(): CloudGitState { return { branch: "main", clean: false, status: "## main\n M src/index.ts", diff: "diff --git a/src/index.ts b/src/index.ts\n+export const ready = true;" }; }
