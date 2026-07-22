import type { ApprovalRequest, Task } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@berry/desktop-ui/components/ui/dropdown-menu";
import { ShieldCheck } from "@berry/desktop-ui/lib/icons";

export function GlobalApprovals({ approvals, tasks, onOpenTask }: {
  approvals: ApprovalRequest[];
  tasks: Task[];
  onOpenTask: (taskId: string) => void;
}) {
  if (approvals.length === 0) return null;
  return (
    <div className="fixed right-14 top-2 z-[70]">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" aria-label={`${approvals.length} pending approvals`} className="gap-1.5"><ShieldCheck /> {approvals.length}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuLabel>Pending approvals</DropdownMenuLabel>
          {approvals.map((approval) => {
            const task = tasks.find((item) => item.id === approval.taskId);
            const request = approval.request && typeof approval.request === "object" && !Array.isArray(approval.request) ? approval.request : {};
            const title = typeof request.title === "string" ? request.title : "Approval required";
            return (
              <DropdownMenuItem key={approval.id} disabled={!approval.taskId} onClick={() => { if (approval.taskId) onOpenTask(approval.taskId); }}>
                <ShieldCheck />
                <span className="min-w-0 flex-1"><strong className="block truncate">{title}</strong><small className="block truncate text-muted-foreground">{task?.title ?? "Background conversation"} · {approval.status}</small></span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
