import * as React from "react";
import { createRoot } from "react-dom/client";
import { Check, ChevronsUpDown, CircleAlert, ExternalLink, MessageSquare, RefreshCw, Send, ShieldCheck, X } from "lucide-react";
import { MarkdownContent, ThreadToolStrip } from "@berry/thread-ui";
import type { ApprovalRequest, Message, Task } from "@berry/shared";
import { createBerryClient, loadConnectionConfig, saveConnectionConfig } from "./connection";
import type { BerryExtensionClient, CapturedPageContext, ExtensionConnectionConfig } from "./types";
import "./styles.css";

function App() {
  const [config, setConfig] = React.useState<ExtensionConnectionConfig | null>(null);
  const [client, setClient] = React.useState<BerryExtensionClient | null>(null);
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [activeTask, setActiveTask] = React.useState<Task | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [approvals, setApprovals] = React.useState<ApprovalRequest[]>([]);
  const [draft, setDraft] = React.useState("");
  const [page, setPage] = React.useState<CapturedPageContext | null>(null);
  const [status, setStatus] = React.useState("Loading");

  React.useEffect(() => {
    void loadConnectionConfig().then(async (loaded) => {
      setConfig(loaded);
      await connect(loaded);
      await consumePendingPage(setPage);
    });
  }, []);

  async function connect(nextConfig: ExtensionConnectionConfig) {
    setStatus("Connecting");
    try {
      const nextClient = await createBerryClient(nextConfig);
      setClient(nextClient);
      const [nextTasks, nextApprovals] = await Promise.all([nextClient.listTasks(), nextClient.listApprovals()]);
      setTasks(nextTasks);
      setActiveTask(nextTasks[0] ?? null);
      setApprovals(nextApprovals);
      setStatus(nextClient.label);
      if (nextTasks[0]?.activeSessionId) setMessages(await nextClient.listMessages(nextTasks[0].activeSessionId));
      else setMessages([]);
    } catch (error) {
      setClient(null);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function refresh() {
    if (!client) return;
    const [nextTasks, nextApprovals] = await Promise.all([client.listTasks(), client.listApprovals()]);
    setTasks(nextTasks);
    setApprovals(nextApprovals);
    const nextActive = activeTask ? nextTasks.find((task) => task.id === activeTask.id) ?? nextTasks[0] ?? null : nextTasks[0] ?? null;
    setActiveTask(nextActive);
    setMessages(nextActive?.activeSessionId ? await client.listMessages(nextActive.activeSessionId) : []);
  }

  async function send() {
    if (!client || draft.trim().length === 0) return;
    const task = activeTask ?? (await client.createTask(page?.title ? `Browser: ${page.title}` : "Browser task")).task;
    const sessionId = task.activeSessionId;
    if (!sessionId) return;
    await client.sendMessage({ task, sessionId, text: draft.trim(), page });
    setDraft("");
    setPage(null);
    await refresh();
  }

  async function capture(fullText: boolean) {
    const response = await chrome.runtime.sendMessage({ type: "berry.capturePage", fullText });
    if (!response?.ok) throw new Error(response?.error ?? "Capture failed");
    setPage(response.page);
  }

  async function updateConfig(next: ExtensionConnectionConfig) {
    setConfig(next);
    await saveConnectionConfig(next);
    await connect(next);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="brand">Berry</div>
          <div className="status">{status}</div>
        </div>
        <button className="iconButton" onClick={() => void refresh()} aria-label="Refresh"><RefreshCw size={16} /></button>
      </header>

      {config ? <ConnectionSwitch config={config} onChange={(next) => void updateConfig(next)} /> : null}

      <section className="captureBand">
        <button onClick={() => void capture(false)}><ExternalLink size={15} /> Selection</button>
        <button onClick={() => void capture(true)}><ExternalLink size={15} /> Full page</button>
        {page ? <span className="pageChip">{page.title}</span> : null}
      </section>

      <section className="taskGrid">
        <div className="taskList">
          {tasks.length === 0 ? <p className="empty">No browser-ready tasks.</p> : tasks.map((task) => (
            <button key={task.id} className={task.id === activeTask?.id ? "task active" : "task"} onClick={() => {
              setActiveTask(task);
              void (task.activeSessionId ? client?.listMessages(task.activeSessionId).then(setMessages) : Promise.resolve(setMessages([])));
            }}>
              <span>{task.title}</span>
              <small>{task.status}</small>
            </button>
          ))}
        </div>

        <div className="thread">
          {messages.length === 0 ? (
            <div className="threadEmpty"><MessageSquare size={18} /> Start or select a task.</div>
          ) : messages.map((message) => <MessageRow key={message.id} message={message} />)}
        </div>
      </section>

      <section className="approvals">
        <div className="sectionTitle"><ShieldCheck size={15} /> Approvals <b>{approvals.length}</b></div>
        {approvals.map((approval) => (
          <div className="approval" key={approval.id}>
            <div>
              <strong>{approvalTitle(approval)}</strong>
              <small>{approval.kind}</small>
            </div>
            <button onClick={() => void client?.decideApproval(approval.id, "approved_once").then(refresh)}><Check size={14} /></button>
            <button onClick={() => void client?.decideApproval(approval.id, "denied").then(refresh)}><X size={14} /></button>
          </div>
        ))}
      </section>

      <footer className="composer">
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask Berry about this page or task" />
        <button onClick={() => void send()} disabled={!client || draft.trim().length === 0}><Send size={16} /></button>
      </footer>
    </main>
  );
}

function ConnectionSwitch({ config, onChange }: { config: ExtensionConnectionConfig; onChange: (config: ExtensionConnectionConfig) => void }) {
  const [open, setOpen] = React.useState(false);
  const [baseUrl, setBaseUrl] = React.useState(config.platformBaseUrl);
  const [token, setToken] = React.useState(config.platformToken);
  return (
    <section className="connection">
      <button className="connectionToggle" onClick={() => setOpen(!open)}>
        {config.kind === "local" ? "Desktop host" : "Platform"} <ChevronsUpDown size={14} />
      </button>
      {open ? (
        <div className="connectionPanel">
          <button onClick={() => onChange({ ...config, kind: "local" })}>Desktop host</button>
          <label>Platform URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></label>
          <label>Bearer token<input value={token} onChange={(event) => setToken(event.target.value)} type="password" /></label>
          <button onClick={() => onChange({ ...config, kind: "platform", platformBaseUrl: baseUrl, platformToken: token })}>Use platform</button>
        </div>
      ) : null}
    </section>
  );
}

function MessageRow({ message }: { message: Message }) {
  const text = message.parts.map((part) => typeof part.content === "string" ? part.content : part.kind === "text" && typeof part.content === "object" && part.content && "text" in part.content ? String(part.content.text) : "").filter(Boolean).join("\n\n");
  return (
    <article className={`message ${message.role}`}>
      <strong>{message.role}</strong>
      <MarkdownContent>{text || "(attachment)"}</MarkdownContent>
      <ThreadToolStrip tools={[]} className="toolStrip" pillClassName="toolPill" />
    </article>
  );
}

async function consumePendingPage(setPage: (page: CapturedPageContext | null) => void) {
  const response = await chrome.runtime.sendMessage({ type: "berry.consumePendingPage" }).catch(() => null);
  if (response?.page) setPage(response.page);
}

function approvalTitle(approval: ApprovalRequest): string {
  const request = approval.request;
  if (request && typeof request === "object" && !Array.isArray(request) && typeof request.title === "string") return request.title;
  return "Approval requested";
}

createRoot(document.getElementById("root")!).render(<App />);
