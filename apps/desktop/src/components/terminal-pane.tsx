import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Plus, SquareTerminal, X } from "@berry/desktop-ui/lib/icons";
import type { TerminalSession } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@berry/desktop-ui/components/ui/empty";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { cn } from "@berry/desktop-ui/lib/utils";
import { callWithApprovalRetry, host, useHostEvent } from "@/lib/berry";

interface TerminalTab {
  id: string;
  title: string;
  status: Extract<TerminalSession["status"], "running" | "exited" | "killed" | "lost">;
}

interface TerminalReplayEvent {
  kind: string;
  payload: string;
}

export function TerminalPane({ workspaceId, taskId, className }: { workspaceId: string; taskId: string; className?: string }) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const terminalFontQuery = useQuery({
    queryKey: ["settings.get", "terminal.font"],
    queryFn: () => host.call<string | null>("settings.get", { key: "terminal.font" }),
  });
  const terminalFont = terminalFontQuery.data?.trim() || "JetBrains Mono, monospace";
  // Monotonic counter so "Terminal n" labels stay unique after closes.
  const counterRef = useRef(0);
  const termsRef = useRef(new Map<string, Xterm>());

  useEffect(() => {
    let cancelled = false;
    setTabs([]);
    setActiveId(null);
    setLoading(true);
    void host
      .call<TerminalSession[]>("terminal.list", { workspaceId, taskId })
      .then((sessions) => {
        if (cancelled) return;
        const open = sessions.filter((session) => session.status === "running" || session.status === "starting");
        counterRef.current = open.length;
        setTabs(open.map((session, index) => ({ id: session.id, title: `Terminal ${index + 1}`, status: "running" })));
        setActiveId(open[0]?.id ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, workspaceId]);

  useHostEvent((event) => {
    if (event.type === "terminal.output") {
      termsRef.current.get(event.terminalId)?.write(event.data);
    } else if (event.type === "terminal.exit") {
      termsRef.current.get(event.terminalId)?.write("\r\n[process exited]");
      setTabs((prev) => prev.map((tab) => (tab.id === event.terminalId ? { ...tab, status: "exited" } : tab)));
    }
  });

  const registerTerm = useCallback((id: string, term: Xterm | null) => {
    if (term) termsRef.current.set(id, term);
    else termsRef.current.delete(id);
  }, []);

  const createTerminal = async () => {
    try {
      const session = await callWithApprovalRetry<TerminalSession>("terminal.create", { workspaceId, taskId, cols: 80, rows: 24 });
      counterRef.current += 1;
      setTabs((prev) => [...prev, { id: session.id, title: `Terminal ${counterRef.current}`, status: "running" }]);
      setActiveId(session.id);
    } catch {
      // The host surfaces terminal failures through push events; nothing to render here.
    }
  };

  const closeTerminal = (id: string) => {
    void host.call("terminal.close", { id }).catch(() => {});
    const index = tabs.findIndex((tab) => tab.id === id);
    const next = tabs.filter((tab) => tab.id !== id);
    setTabs(next);
    if (activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? null);
  };

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5" role="tablist" aria-label="Terminals">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "flex h-7 items-center gap-0.5 rounded-md pr-0.5 pl-2.5 text-xs",
              tab.id === activeId
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeId}
              className="flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setActiveId(tab.id)}
            >
              {tab.title}
              {tab.status !== "running" && <span className="text-muted-foreground">({tab.status})</span>}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              className="rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => closeTerminal(tab.id)}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <Button variant="ghost" size="icon-xs" aria-label="New terminal" onClick={() => void createTerminal()}>
          <Plus />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <TerminalView key={tab.id} id={tab.id} active={tab.id === activeId} register={registerTerm} fontFamily={terminalFont} />
        ))}
        {loading && tabs.length === 0 && (
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        )}
        {!loading && tabs.length === 0 && (
          <Empty className="h-full border-none">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SquareTerminal />
              </EmptyMedia>
              <EmptyTitle className="text-base">No terminals</EmptyTitle>
              <EmptyDescription>Open a terminal to run commands in this workspace.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={() => void createTerminal()}>
                <Plus />
                New terminal
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </div>
    </div>
  );
}

function TerminalView({
  id,
  active,
  register,
  fontFamily,
}: {
  id: string;
  active: boolean;
  register: (id: string, term: Xterm | null) => void;
  fontFamily: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Xterm({
      convertEol: true,
      fontFamily,
      fontSize: 12.5,
      // allowTransparency is required for the transparent theme background to
      // actually show the pane's bg-background underneath.
      allowTransparency: true,
      theme: { background: "transparent" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    let lastCols = 0;
    let lastRows = 0;
    const syncSize = () => {
      fit.fit();
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        void host.call("terminal.resize", { id, cols: term.cols, rows: term.rows }).catch(() => {});
      }
    };
    syncSize();

    const dataListener = term.onData((data) => {
      void host.call("terminal.write", { id, data }).catch(() => {});
    });

    // Replay recorded output so reattached terminals show their history.
    let disposed = false;
    void host
      .call<TerminalReplayEvent[]>("terminal.events", { id })
      .then((events) => {
        if (disposed) return;
        for (const event of events) {
          if (event.kind === "stdout") term.write(event.payload);
        }
      })
      .catch(() => {});

    const observer = new ResizeObserver(() => syncSize());
    observer.observe(container);
    register(id, term);

    return () => {
      disposed = true;
      observer.disconnect();
      dataListener.dispose();
      register(id, null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [fontFamily, id, register]);

  useEffect(() => {
    if (!active) return;
    // Wait a frame so the container has its final size after being revealed.
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div
      ref={containerRef}
      aria-hidden={!active}
      // Inactive terminals stay mounted; `invisible` keeps layout (so fit still
      // measures real dimensions) while hiding the instance.
      className={cn("absolute inset-0 px-2 py-1.5", !active && "invisible")}
    />
  );
}
