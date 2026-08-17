import type { Task, Workspace } from "@berry/shared";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@berry/desktop-ui/components/ui/command";
import { MessageSquare, Settings, CircleHelp } from "@berry/desktop-ui/lib/icons";

export function WebCommandPalette({ open, onOpenChange, tasks, workspaces, onOpenTask, onSettings, onHelp }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: Task[];
  workspaces: Workspace[];
  onOpenTask: (taskId: string) => void;
  onSettings?: (() => void) | undefined;
  onHelp: () => void;
}) {
  const workspaceNames = new Map(workspaces.map((workspace) => [
    workspace.id,
    workspace.workspaceKind === "general" ? "Tasks" : workspace.name,
  ]));
  const select = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search Berry" description="Search tasks and actions">
      <CommandInput
        autoFocus
        placeholder="Search tasks and actions…"
        aria-label="Search tasks and actions"
        className="berry-command-search-input"
        wrapperClassName="berry-command-search-wrapper"
      />
      <CommandList>
        <CommandEmpty>No tasks or actions found.</CommandEmpty>
        <CommandGroup heading="Actions">
          {onSettings ? <CommandItem value="settings preferences" onSelect={() => select(onSettings)}><Settings /> Settings <CommandShortcut>⌘,</CommandShortcut></CommandItem> : null}
          <CommandItem value="help docs support diagnostics" onSelect={() => select(onHelp)}><CircleHelp /> Help and diagnostics</CommandItem>
        </CommandGroup>
        <CommandGroup heading="Tasks">
          {tasks.map((task) => {
            const provenance = workspaceNames.get(task.workspaceId) ?? "Tasks";
            return (
              <CommandItem
                key={task.id}
                value={`${task.title} ${provenance} ${task.status}`}
                onSelect={() => select(() => onOpenTask(task.id))}
              >
                <MessageSquare />
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                <span className="text-xs text-muted-foreground">Task · {provenance} · {task.deletedAt ? "deleted" : task.archived ? "archived" : task.status}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
