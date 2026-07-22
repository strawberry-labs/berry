import * as React from "react";
import type { Task, Workspace } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { ScrollArea } from "@berry/desktop-ui/components/ui/scroll-area";
import { Separator } from "@berry/desktop-ui/components/ui/separator";
import { CircleHollow, CirclePlus, ListTodo } from "@berry/desktop-ui/lib/icons";
import { cn } from "@berry/desktop-ui/lib/utils";
import { ProjectSwitcher } from "../projects/project-switcher";

const STATUS_LABEL: Record<Task["status"], string> = {
  queued: "Queued",
  running: "Working",
  "waiting-for-approval": "Waiting",
  cancelled: "Stopped",
  failed: "Failed",
  completed: "Completed",
};

export function TaskContextRail({
  workspaces,
  activeWorkspaceId,
  activeTaskId,
  tasks,
  onSelectWorkspace,
  onOpenTask,
  onNewTask,
  onCreateProject,
}: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  activeTaskId: string;
  tasks: Task[];
  onSelectWorkspace: (workspaceId: string) => void;
  onOpenTask: (taskId: string) => void;
  onNewTask: () => void;
  onCreateProject: () => void;
}) {
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  const visibleTasks = React.useMemo(
    () => tasks
      .filter((task) => task.workspaceId === activeWorkspaceId && !task.deletedAt && !task.archived)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    [activeWorkspaceId, tasks],
  );

  return (
    <aside className="berry-task-context-rail" aria-label="Tasks">
      <div className="berry-task-context-rail-header">
        <div className="flex min-w-0 items-center gap-2">
          <ListTodo />
          <span>Tasks</span>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onNewTask} aria-label="New task" title="New task">
          <CirclePlus />
        </Button>
      </div>
      <div className="berry-task-context-rail-project">
        <span className="berry-task-context-rail-eyebrow">Project</span>
        <ProjectSwitcher
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
          onCreateProject={onCreateProject}
          className="berry-task-context-rail-switcher"
        />
      </div>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <div className="berry-task-context-rail-list">
          <span className="berry-task-context-rail-eyebrow">
            {activeWorkspace?.workspaceKind === "general" ? "Chats" : "Recent tasks"}
          </span>
          {visibleTasks.length > 0 ? visibleTasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className={cn("berry-task-context-rail-item", task.id === activeTaskId && "is-active")}
              aria-current={task.id === activeTaskId ? "page" : undefined}
              onClick={() => onOpenTask(task.id)}
            >
              <CircleHollow data-status={task.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{task.title || "Untitled task"}</span>
                <span className="berry-task-context-rail-status">{STATUS_LABEL[task.status]}</span>
              </span>
            </button>
          )) : <p className="berry-task-context-rail-empty">No tasks in this project yet.</p>}
        </div>
      </ScrollArea>
    </aside>
  );
}
