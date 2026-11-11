import { actionErrorMessage } from "@/lib/action-error";
import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { PersonalSkill, EffectiveCapability } from "@berry/shared";
import { Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { AsyncState, Button, InlineNotice, ManagementDialog, ManagementSwitch, StatusPill } from "./management-primitives";
import { useResource } from "./management-context";
import { SkillImportDialog } from "./skill-import-dialog";
import { useRefreshModelCatalog } from "@/lib/model-catalog";
const empty = { personal: [] as PersonalSkill[], effective: [] as EffectiveCapability[] };
const heading = "text-xs font-medium text-muted-foreground";
export function MemberSkillsDialog({ client, tenantId, member, canWrite, onClose }: { client: BerryApiClient | null; tenantId: string; member: { userId: string; name: string }; canWrite: boolean; onClose: () => void }) {
  const resource = useResource(`member-skills:${tenantId}:${member.userId}`, async () => client ? client.memberSkills(tenantId, member.userId) : empty, empty);
  const [importing, setImporting] = React.useState(false);
  const [removing, setRemoving] = React.useState<PersonalSkill | null>(null);
  const [busy, setBusy] = React.useState(false);
  const lock = React.useRef(false);
  const refresh = useRefreshModelCatalog();
  function updated() { resource.retry(); refresh(); }
  async function mutate(action: () => Promise<unknown>, message: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await action(); updated(); setRemoving(null); toast.success(message); }
    catch (cause) { toast.error(actionErrorMessage(cause, "Could not update this skill. Please try again.")); }
    finally { lock.current = false; setBusy(false); }
  }
  const inherited = resource.data.effective.filter((skill) => skill.provenance === "organization");
  return <>
    <ManagementDialog
      open={!importing}
      onOpenChange={(open) => { if (!open && !lock.current) onClose(); }}
      title={`${member.name || "Member"}’s skills`}
      description="Skills this member added for themselves, and the organization skills that apply to them."
      size="lg"
      footer={canWrite ? <Button variant="secondary" disabled={busy} onClick={() => setImporting(true)}><Upload />Import a skill for this member</Button> : undefined}
    >
      <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
        <div className="grid gap-4">
          <section className="grid gap-1">
            <h3 className={heading}>Personal skills</h3>
            {!resource.data.personal.length ? <p className="py-2 text-md text-muted-foreground">This member has not added any skills.</p> : (
              <div className="grid divide-y divide-border">
                {resource.data.personal.map((skill) => (
                  <div key={skill.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-md font-medium text-foreground">{skill.name}</p>
                      {skill.description ? <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{skill.description}</p> : null}
                    </div>
                    <ManagementSwitch aria-label={`${skill.name} enabled`} checked={skill.enabled} disabled={!canWrite || busy} onCheckedChange={(enabled) => { if (client) void mutate(() => client.updateMemberSkill(tenantId, member.userId, skill.id, enabled), "Skill updated"); }} />
                    {canWrite ? <Button variant="ghost" size="icon" aria-label={`Delete ${skill.name}`} disabled={busy} onClick={() => setRemoving(skill)}><Trash2 /></Button> : null}
                  </div>
                ))}
              </div>
            )}
          </section>
          {removing ? (
            <InlineNotice
              tone="warning"
              title={`Delete “${removing.name}” from this member’s account?`}
              action={<div className="flex gap-2"><Button variant="secondary" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => { if (client) void mutate(() => client.deleteMemberSkill(tenantId, member.userId, removing.id), "Skill deleted"); }}>{busy ? "Deleting…" : "Delete skill"}</Button></div>}
            >
              The member loses the skill immediately. This cannot be undone.
            </InlineNotice>
          ) : null}
          <section className="grid gap-1">
            <h3 className={heading}>Organization skills</h3>
            {!inherited.length ? <p className="py-2 text-md text-muted-foreground">No organization skills apply to this member.</p> : (
              <div className="grid divide-y divide-border">
                {inherited.map((skill) => (
                  <div key={skill.capabilityId} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="min-w-0 truncate text-md text-foreground">{skill.name}</span>
                    <StatusPill tone={skill.enabled ? "good" : "neutral"}>{skill.enabled ? "Enabled" : "Disabled"}</StatusPill>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs leading-5 text-muted-foreground">Organization skills are managed under AI &amp; tools → Skills &amp; MCP.</p>
          </section>
          {!canWrite ? <p className="text-xs text-muted-foreground">You can view these skills. Changing them needs the “Skills: write” permission.</p> : null}
        </div>
      </AsyncState>
    </ManagementDialog>
    <SkillImportDialog client={client} tenantId={tenantId} ownerId={member.userId} open={importing} onOpenChange={setImporting} onSuccess={() => { updated(); toast.success("Skill imported for member"); }} />
  </>;
}
