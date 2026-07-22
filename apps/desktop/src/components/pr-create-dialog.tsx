import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GitPrDraft, GitPullRequest as GitPullRequestResult, ModelProvider } from "@berry/shared";
import { GitPullRequest, RefreshCw } from "@berry/desktop-ui/lib/icons";
import { toast } from "sonner";

import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { Switch } from "@berry/desktop-ui/components/ui/switch";
import { Textarea } from "@berry/desktop-ui/components/ui/textarea";

import { callWithApprovalRetry, host } from "@/lib/berry";

export function PrCreateDialog({ open, onOpenChange, workspaceId, taskId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  taskId: string;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [base, setBase] = React.useState("main");
  const [draft, setDraft] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const providersQuery = useQuery({ queryKey: ["model.provider.list"], queryFn: () => host.call<ModelProvider[]>("model.provider.list", {}) });
  const provider = providersQuery.data?.find((candidate) => candidate.enabled) ?? null;

  const draftQuery = useQuery({
    queryKey: ["git.pr.draft", workspaceId, taskId],
    queryFn: () => host.call<GitPrDraft>("git.pr.draft", {
      workspaceId,
      taskId,
      ...(provider ? { providerId: provider.id, credentialRef: provider.credentialRef ?? undefined } : {}),
    }),
    enabled: open && Boolean(provider),
  });

  React.useEffect(() => {
    if (!open || !draftQuery.data) return;
    setTitle(draftQuery.data.title);
    setBody(draftQuery.data.body);
    setBase(draftQuery.data.base);
  }, [draftQuery.data, open]);

  const create = async () => {
    if (!title.trim() || !base.trim()) return;
    setCreating(true);
    try {
      const pullRequest = await callWithApprovalRetry<GitPullRequestResult>("git.pr.create", {
        workspaceId,
        taskId,
        title: title.trim(),
        body,
        base: base.trim(),
        draft,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["task.list"] }),
        queryClient.invalidateQueries({ queryKey: ["git.info", workspaceId, taskId] }),
        queryClient.invalidateQueries({ queryKey: ["git.changedFiles", workspaceId, taskId] }),
      ]);
      onOpenChange(false);
      toast.success(`Pull request #${pullRequest.number} created`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create pull request");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(760px,90vh)] flex-col overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4 text-left">
          <DialogTitle>Create pull request</DialogTitle>
          <DialogDescription>Review the generated description before pushing the task branch to GitHub.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {draftQuery.isLoading || providersQuery.isLoading ? (
            <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">Generating description...</div>
          ) : !provider ? (
            <div className="flex min-h-40 items-center justify-center text-center text-sm text-destructive">Enable a model provider to generate the pull-request description.</div>
          ) : draftQuery.error ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center text-sm text-destructive">
              <span>{draftQuery.error.message}</span>
              <Button variant="outline" className="min-h-10" onClick={() => void draftQuery.refetch()}><RefreshCw />Retry</Button>
            </div>
          ) : (
            <>
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Title
                <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={256} disabled={creating} />
              </label>
              <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                Description
                <Textarea value={body} onChange={(event) => setBody(event.target.value)} rows={12} maxLength={100_000} className="min-h-56 resize-y font-mono text-xs leading-5" disabled={creating} />
              </label>
              <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
                <label className="block space-y-1.5 text-xs font-medium text-muted-foreground">
                  Base branch
                  <Input value={base} onChange={(event) => setBase(event.target.value)} disabled={creating} />
                </label>
                <label className="flex min-h-10 items-center gap-2 text-sm">
                  <Switch checked={draft} onCheckedChange={setDraft} disabled={creating} aria-label="Create as draft" />
                  Draft
                </label>
              </div>
            </>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t px-5 py-4">
          <Button variant="ghost" className="min-h-10" disabled={creating} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="min-h-10" disabled={creating || draftQuery.isLoading || !provider || !title.trim() || !base.trim()} onClick={() => void create()}>
            <GitPullRequest />{creating ? "Creating..." : "Create PR"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
