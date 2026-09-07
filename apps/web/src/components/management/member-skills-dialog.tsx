import { actionErrorMessage } from "@/lib/action-error";
import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { PersonalSkill, EffectiveCapability } from "@berry/shared";
import { toast } from "sonner";
import { AsyncState, Button, ManagementDialog, ManagementSwitch } from "./management-primitives";
import { useResource } from "./management-context";
import { SkillImportDialog } from "./skill-import-dialog";
import { useRefreshModelCatalog } from "@/lib/model-catalog";
const empty = { personal: [] as PersonalSkill[], effective: [] as EffectiveCapability[] };
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
    <ManagementDialog open={!importing} onOpenChange={(open) => { if (!open && !lock.current) onClose(); }} title={`${member.name || "Member"}’s skills`} description="Manage personal skills and review organization-provided skills." size="lg">
      <div className="grid gap-4">
        {canWrite ? <div className="flex justify-end"><Button disabled={busy} onClick={() => setImporting(true)}>Import a skill</Button></div> : null}
        <AsyncState loading={resource.loading} error={resource.error} onRetry={resource.retry}>
          <h3 className="text-sm font-medium">Personal skills</h3>
          {!resource.data.personal.length ? <p className="text-xs text-muted-foreground">No personal skills added.</p> : resource.data.personal.map((skill) => <div key={skill.id} className="flex items-center gap-3 border-b border-border py-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{skill.name}</p><p className="text-xs text-muted-foreground">{skill.description}</p></div><ManagementSwitch aria-label={`${skill.name} enabled`} checked={skill.enabled} disabled={!canWrite || busy} onCheckedChange={(enabled) => { if (client) void mutate(() => client.updateMemberSkill(tenantId, member.userId, skill.id, enabled), "Skill updated"); }} />{canWrite ? <Button variant="secondary" disabled={busy} onClick={() => setRemoving(skill)}>Delete</Button> : null}</div>)}
          <h3 className="mt-2 text-sm font-medium">Organization skills</h3>
          {!inherited.length ? <p className="text-xs text-muted-foreground">No organization skills assigned.</p> : inherited.map((skill) => <div key={skill.capabilityId} className="flex items-center justify-between gap-3 border-b border-border py-3"><span className="text-sm">{skill.name}</span><span className="text-xs text-muted-foreground">{skill.enabled ? "Enabled" : "Disabled"} · Managed by organization</span></div>)}
        </AsyncState>
        {removing ? <div role="alert" className="grid gap-2 rounded-lg border border-border p-3"><p className="text-sm">Delete “{removing.name}” from this member’s account?</p><div className="flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button><Button disabled={busy} onClick={() => { if (client) void mutate(() => client.deleteMemberSkill(tenantId, member.userId, removing.id), "Skill deleted"); }}>{busy ? "Deleting…" : "Delete skill"}</Button></div></div> : null}
      </div>
    </ManagementDialog>
    <SkillImportDialog client={client} tenantId={tenantId} ownerId={member.userId} open={importing} onOpenChange={setImporting} onSuccess={() => { updated(); toast.success("Skill imported for member"); }} />
  </>;
}
