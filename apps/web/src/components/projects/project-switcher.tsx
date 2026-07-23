import * as React from "react";
import type { Workspace } from "@berry/shared";
import { BerryTaskPill } from "@berry/desktop-ui/components/berry-task-header";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@berry/desktop-ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@berry/desktop-ui/components/ui/popover";
import { Check, ChevronDown, Folder, FolderPlus } from "@berry/desktop-ui/lib/icons";
import { cn } from "@berry/desktop-ui/lib/utils";

export function ProjectSwitcher({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateProject,
  className,
  align = "start",
}: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateProject?: (() => void) | undefined;
  className?: string | undefined;
  align?: "start" | "center" | "end" | undefined;
}) {
  const [open, setOpen] = React.useState(false);
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [composerPopoverWidth, setComposerPopoverWidth] = React.useState<number | null>(null);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0] ?? null;
  const projects = workspaces.filter((workspace) => workspace.workspaceKind === "project");
  const chats = workspaces.filter((workspace) => workspace.workspaceKind === "general");

  React.useEffect(() => {
    const composer = hostRef.current?.closest<HTMLElement>(".berry-composer-root");
    if (!composer) return;
    const updateWidth = () => setComposerPopoverWidth(Math.max(0, composer.getBoundingClientRect().width - 26));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={hostRef} className="contents">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <BerryTaskPill
            interactive
            aria-label="Choose project"
            aria-haspopup="listbox"
            aria-expanded={open}
            className={cn("berry-project-switcher", className)}
            title={activeWorkspace?.name ?? "Choose project"}
          >
            <Folder />
            <span className="min-w-0 truncate">{activeWorkspace?.name ?? "Choose project"}</span>
            <ChevronDown className="berry-task-pill-caret shrink-0" />
          </BerryTaskPill>
        </PopoverTrigger>
        <PopoverContent
          align={align}
          className="berry-project-switcher-popover w-[min(328px,calc(100vw-26px))] p-0"
          style={composerPopoverWidth ? { width: `${composerPopoverWidth}px`, maxWidth: "calc(100vw - 26px)" } : undefined}
        >
          <Command>
            <CommandInput placeholder="Search projects…" />
            <CommandList>
            <CommandEmpty>No projects found.</CommandEmpty>
            {projects.length > 0 ? (
              <CommandGroup heading="Projects">
                {projects.map((workspace) => (
                  <CommandItem
                    key={workspace.id}
                    value={workspace.name}
                    onSelect={() => {
                      onSelectWorkspace(workspace.id);
                      setOpen(false);
                    }}
                  >
                    <Folder />
                    <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                    {workspace.id === activeWorkspace?.id ? <Check aria-label="Current project" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {chats.length > 0 ? (
              <>
                {projects.length > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading="Other">
                  {chats.map((workspace) => (
                    <CommandItem
                      key={workspace.id}
                      value={workspace.name}
                      onSelect={() => {
                        onSelectWorkspace(workspace.id);
                        setOpen(false);
                      }}
                    >
                      <Folder />
                      <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                      {workspace.id === activeWorkspace?.id ? <Check aria-label="Current location" /> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
            {onCreateProject ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="new project"
                    onSelect={() => {
                      setOpen(false);
                      onCreateProject();
                    }}
                  >
                    <FolderPlus />
                    New project
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
