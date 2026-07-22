import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Search, SquareTerminal, Trash2 } from "@berry/desktop-ui/lib/icons";
import type { CommandManifest } from "@berry/shared";
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
import { Kbd } from "@berry/desktop-ui/components/ui/kbd";
import { Label } from "@berry/desktop-ui/components/ui/label";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { Switch } from "@berry/desktop-ui/components/ui/switch";
import { host } from "@/lib/berry";
import { SettingCard, SettingsPageHeader, SettingsSectionLabel } from "./shared";

const COMMANDS_KEY = ["commands"] as const;

function isBuiltIn(command: CommandManifest): boolean {
  return command.trusted && command.id.startsWith("slash_");
}

function isPluginCommand(command: CommandManifest): boolean {
  return command.id.startsWith("plugin_command_") || command.sourcePath?.startsWith("plugin:") === true;
}

function NewCommandDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [commandText, setCommandText] = useState("");

  const save = useMutation({
    mutationFn: () =>
      host.call("command.save", {
        name: name.trim().replace(/^\//, ""),
        description: description.trim(),
        command: commandText.trim(),
        enabled: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: COMMANDS_KEY });
      toast.success(`Added /${name.trim().replace(/^\//, "")}`);
      setOpen(false);
      setName("");
      setDescription("");
      setCommandText("");
    },
    onError: () => toast.error("Could not save command"),
  });

  const valid = name.trim().length > 0 && commandText.trim().length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          New command
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New command</DialogTitle>
            <DialogDescription>
              Commands can be invoked with /command-name in chat.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="command-name">Name</Label>
            <Input
              id="command-name"
              placeholder="e.g. review"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="command-description">Description</Label>
            <Input
              id="command-description"
              placeholder="What this command does"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="command-text">Command</Label>
            <Input
              id="command-text"
              className="font-mono text-xs"
              placeholder="Review the current diff for correctness bugs"
              value={commandText}
              onChange={(e) => setCommandText(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending ? "Saving..." : "Add command"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CommandRow({ command, builtIn }: { command: CommandManifest; builtIn: boolean }) {
  const queryClient = useQueryClient();
  const plugin = isPluginCommand(command);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => host.call("command.save", { ...command, enabled }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: COMMANDS_KEY });
      const previous = queryClient.getQueryData<CommandManifest[]>(COMMANDS_KEY);
      queryClient.setQueryData<CommandManifest[]>(COMMANDS_KEY, (current) =>
        (current ?? []).map((item) => (item.id === command.id ? { ...item, enabled } : item)),
      );
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) queryClient.setQueryData(COMMANDS_KEY, context.previous);
      toast.error(`Could not update /${command.name}`);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: COMMANDS_KEY }),
  });
  const remove = useMutation({
    mutationFn: () => host.call("command.delete", { id: command.id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: COMMANDS_KEY });
      toast.success(`Removed /${command.name}`);
    },
    onError: () => toast.error(`Could not remove /${command.name}`),
  });

  return (
    <div className="flex items-center justify-between gap-6 p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2">
          <Kbd className="font-mono">/{command.name}</Kbd>
          {builtIn ? <Badge variant="outline">Built-in</Badge> : null}
          {plugin ? <Badge variant="secondary">Plugin</Badge> : null}
        </span>
        {command.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{command.description}</p>
        ) : null}
      </div>
      {builtIn || plugin ? null : (
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={command.enabled}
            onCheckedChange={(enabled) => toggle.mutate(enabled)}
            aria-label={`Enable /${command.name}`}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            aria-label={`Delete /${command.name}`}
          >
            <Trash2 />
          </Button>
        </div>
      )}
    </div>
  );
}

export function CommandsSettings() {
  const [search, setSearch] = useState("");
  const commands = useQuery({
    queryKey: COMMANDS_KEY,
    queryFn: () => host.call<CommandManifest[]>("command.list"),
  });

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) return commands.data ?? [];
    return (commands.data ?? []).filter(
      (command) =>
        command.name.toLowerCase().includes(query) ||
        command.description.toLowerCase().includes(query),
    );
  }, [commands.data, search]);

  const builtIn = filtered.filter(isBuiltIn);
  const user = filtered.filter((command) => !isBuiltIn(command));

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Commands"
        description="Manage Berry command files. Commands can be invoked with /command-name in chat."
        actions={<NewCommandDialog />}
      />

      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          placeholder="Search commands..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search commands"
        />
      </InputGroup>

      {commands.isPending ? (
        <SettingCard>
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center justify-between gap-6 p-4">
              <div className="flex w-full flex-col gap-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </SettingCard>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <SettingsSectionLabel>Your commands</SettingsSectionLabel>
            {user.length === 0 ? (
              <Empty className="border border-dashed border-border py-10 md:p-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SquareTerminal />
                  </EmptyMedia>
                  <EmptyTitle className="text-sm">No user commands</EmptyTitle>
                  <EmptyDescription>
                    Create a command to reuse a prompt with a quick /name in chat.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <SettingCard>
                {user.map((command) => (
                  <CommandRow key={command.id} command={command} builtIn={false} />
                ))}
              </SettingCard>
            )}
          </div>

          {builtIn.length > 0 ? (
            <div className="flex flex-col gap-3">
              <SettingsSectionLabel>Built-in</SettingsSectionLabel>
              <SettingCard>
                {builtIn.map((command) => (
                  <CommandRow key={command.id} command={command} builtIn />
                ))}
              </SettingCard>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
