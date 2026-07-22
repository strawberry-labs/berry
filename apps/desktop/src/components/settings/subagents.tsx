import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderOpen, Plus, RefreshCw, Search, Trash2, Users } from "@berry/desktop-ui/lib/icons";
import type { SubagentManifest } from "@berry/shared";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@berry/desktop-ui/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@berry/desktop-ui/components/ui/empty";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@berry/desktop-ui/components/ui/input-group";
import { Label } from "@berry/desktop-ui/components/ui/label";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { Switch } from "@berry/desktop-ui/components/ui/switch";
import { Textarea } from "@berry/desktop-ui/components/ui/textarea";
import { host } from "@/lib/berry";
import { SettingCard, SettingsPageHeader, SettingsSectionLabel } from "./shared";

const AGENTS_KEY = ["agent.list"] as const;

interface AgentListResult {
  agents: SubagentManifest[];
  diagnostics: string[];
}

const scopeLabel = (scope: SubagentManifest["scope"]) =>
  scope === "built-in" ? "Built-in" : scope === "workspace" ? "Workspace" : "Personal";

function NewAgentDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");

  const reset = () => {
    setName("");
    setDescription("");
    setModel("");
    setSystemPrompt("");
  };

  const save = useMutation({
    mutationFn: () =>
      host.call("agent.create", {
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        ...(model.trim() ? { model: model.trim() } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY });
      toast.success(`Created ${name.trim()}`);
      setOpen(false);
      reset();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not create agent"),
  });

  // 3–50 chars, letters/digits/hyphens — matches the loader's validation.
  const validName = /^[a-zA-Z0-9-]{3,50}$/.test(name.trim());
  const valid = validName && description.trim().length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          New agent
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New sub-agent</DialogTitle>
            <DialogDescription>
              Sub-agents run autonomously with their own system prompt. Dispatch them from chat with /agent-name or let Berry delegate via the task tool.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-name">Name</Label>
            <Input id="agent-name" placeholder="e.g. code-reviewer" value={name} onChange={(e) => setName(e.target.value)} />
            {name.trim().length > 0 && !validName ? (
              <span className="text-xs text-destructive">3–50 characters, letters, digits, and hyphens only.</span>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-description">Description</Label>
            <Textarea
              id="agent-description"
              placeholder="When Berry should delegate to this agent"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-model">Model (optional)</Label>
            <Input
              id="agent-model"
              className="font-mono text-xs"
              placeholder="Inherit parent model, or e.g. anthropic/claude-haiku-4-5"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-prompt">System prompt</Label>
            <Textarea
              id="agent-prompt"
              className="min-h-32"
              placeholder="You are a focused code reviewer. Given a diff, report correctness and security issues..."
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending ? "Creating..." : "Create agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentRow({ agent }: { agent: SubagentManifest }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => host.call("agent.enable", { id: agent.id, enabled }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: AGENTS_KEY });
      const previous = queryClient.getQueryData<AgentListResult>(AGENTS_KEY);
      queryClient.setQueryData<AgentListResult>(AGENTS_KEY, (current) =>
        current ? { ...current, agents: current.agents.map((a) => (a.id === agent.id ? { ...a, enabled } : a)) } : current,
      );
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) queryClient.setQueryData(AGENTS_KEY, context.previous);
      toast.error(`Could not update ${agent.name}`);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: AGENTS_KEY }),
  });
  const remove = useMutation({
    mutationFn: () => host.call("agent.delete", { name: agent.name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY });
      toast.success(`Deleted ${agent.name}`);
    },
    onError: () => toast.error(`Could not delete ${agent.name}`),
  });

  const toolSummary = agent.tools.includes("*") ? "All tools" : `${agent.tools.length} ${agent.tools.length === 1 ? "tool" : "tools"}`;

  return (
    <div className="flex items-center justify-between gap-6 p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium">{agent.name}</span>
        {agent.description ? <p className="line-clamp-2 text-sm text-muted-foreground">{agent.description}</p> : null}
        <span className="text-xs text-muted-foreground">
          {toolSummary}
          {agent.model ? ` · ${agent.model}` : ""}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Badge variant="outline">{scopeLabel(agent.scope)}</Badge>
        {agent.readOnly ? (
          <span className="text-xs text-muted-foreground">Runtime default</span>
        ) : (
          <>
            <Switch checked={agent.enabled} onCheckedChange={(enabled) => toggle.mutate(enabled)} aria-label={`Enable ${agent.name}`} />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete ${agent.name}`}
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function SubagentsSettings() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

  const agents = useQuery({
    queryKey: AGENTS_KEY,
    queryFn: () => host.call<AgentListResult>("agent.list"),
  });

  const openFolder = useMutation({
    mutationFn: async () => {
      const { path } = await host.call<{ path: string }>("agent.getUserDirectory");
      await host.call("system.openPath", { path });
    },
    onError: () => toast.error("Could not open agents folder"),
  });

  const list = agents.data?.agents ?? [];
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) return list;
    return list.filter((a) => a.name.toLowerCase().includes(query) || a.description.toLowerCase().includes(query));
  }, [list, search]);

  const builtIns = filtered.filter((a) => a.scope === "built-in");
  const custom = filtered.filter((a) => a.scope !== "built-in");

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Sub-agents"
        description="Autonomous agents Berry can delegate to via the task tool, or you can dispatch with /agent-name. Personal agents are Markdown files in ~/.berry/agents."
        actions={
          <>
            <Button size="icon-sm" variant="ghost" aria-label="Open agents folder" onClick={() => openFolder.mutate()}>
              <FolderOpen />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh agents"
              onClick={() => void queryClient.invalidateQueries({ queryKey: AGENTS_KEY })}
            >
              <RefreshCw />
            </Button>
            <NewAgentDialog />
          </>
        }
      />

      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          placeholder="Search agents..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search agents"
        />
      </InputGroup>

      {agents.isPending ? (
        <SettingCard>
          {[0, 1].map((index) => (
            <div key={index} className="flex items-center justify-between gap-6 p-4">
              <div className="flex w-full flex-col gap-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-2/3" />
              </div>
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          ))}
        </SettingCard>
      ) : filtered.length === 0 ? (
        <Empty className="border border-dashed border-border py-10 md:p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Users />
            </EmptyMedia>
            <EmptyTitle className="text-sm">No agents match</EmptyTitle>
            <EmptyDescription>Try a different search, or create a new sub-agent.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          {builtIns.length > 0 ? (
            <div className="flex flex-col gap-3">
              <SettingsSectionLabel>Built-in · runtime defaults, cannot be edited</SettingsSectionLabel>
              <SettingCard>
                {builtIns.map((agent) => (
                  <AgentRow key={agent.id} agent={agent} />
                ))}
              </SettingCard>
            </div>
          ) : null}
          {custom.length > 0 ? (
            <div className="flex flex-col gap-3">
              <SettingsSectionLabel>
                Workspace and personal · {custom.length} {custom.length === 1 ? "item" : "items"}
              </SettingsSectionLabel>
              <SettingCard>
                {custom.map((agent) => (
                  <AgentRow key={agent.id} agent={agent} />
                ))}
              </SettingCard>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
