import { actionErrorMessage } from "@/lib/action-error";
import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import { PERSONAL_SKILL_PACKAGE_MAX_BYTES } from "@berry/shared";
import { Upload, LoaderCircle } from "lucide-react";
import { Button, InlineNotice, Input, ManagementDialog, SegmentedControl, Textarea } from "./management-primitives";

export function SkillImportDialog({ client, tenantId, ownerId, open, onOpenChange, onSuccess }: {
  client: BerryApiClient | null; tenantId: string; ownerId?: string; open: boolean;
  onOpenChange: (open: boolean) => void; onSuccess: () => void;
}) {
  const [source, setSource] = React.useState<"upload" | "text" | "git">("upload");
  const [file, setFile] = React.useState<File | null>(null);
  const [content, setContent] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState("");
  const [phase, setPhase] = React.useState<"idle" | "uploading" | "installing">("idle");
  const [progress, setProgress] = React.useState(0);
  const locked = React.useRef(false);
  const abort = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abort.current?.abort(), []);
  const busy = phase !== "idle";
  function choose(next?: File) {
    if (locked.current || !next) return;
    setError(""); setFile(null);
    if (!/\.(skill|zip|md)$/i.test(next.name)) { setError("Choose a .skill, .zip, or SKILL.md file."); return; }
    if (next.size > PERSONAL_SKILL_PACKAGE_MAX_BYTES) { setError("Skill packages can be up to 500 MB."); return; }
    if (/\.md$/i.test(next.name) && next.size > 256 * 1024) { setError("SKILL.md instructions can be up to 256 KB. Put larger resources in a .skill package."); return; }
    setFile(next);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!client || locked.current || (source === "upload" && !file)) return;
    locked.current = true;
    setError(""); setProgress(0); setPhase("installing");
    const controller = new AbortController(); abort.current = controller;
    let uploadedId: string | undefined;
    try {
      if (source === "upload" && file && !/\.md$/i.test(file.name)) {
        setPhase("uploading");
        const uploaded = await client.uploadFile(file, { origin: "user_upload", associationRole: "reference", signal: controller.signal, onProgress: ({ ratio }) => setProgress(Math.round(ratio * 100)) });
        uploadedId = uploaded.id;
        if (controller.signal.aborted) return;
        setPhase("installing");
        if (ownerId) await client.installMemberSkillArchive(tenantId, ownerId, uploaded.id, controller.signal);
        else await client.installPersonalSkillArchive(uploaded.id, controller.signal);
      } else {
        const input = { content: source === "upload" && file ? await file.text() : content, source, sourceUrl: source === "git" ? url : null, enabled: true };
        if (controller.signal.aborted) return;
        if (ownerId) await client.saveMemberSkill(tenantId, ownerId, input);
        else await client.savePersonalSkill(input);
      }
      if (controller.signal.aborted) return;
      onSuccess(); onOpenChange(false); setFile(null); setContent(""); setUrl("");
    } catch (cause) {
      if (!controller.signal.aborted) setError(actionErrorMessage(cause, "Could not import this skill. Please try again."));
    } finally {
      if (uploadedId) void client.deleteFile(uploadedId).catch(() => undefined);
      locked.current = false; abort.current = null; setPhase("idle");
    }
  }
  const formId = React.useId();
  return <ManagementDialog
    open={open}
    onOpenChange={(value) => { if (!locked.current) onOpenChange(value); }}
    title="Import a skill"
    description={ownerId ? "Add a skill to this member’s account. It is turned on as soon as it is imported." : "Add a skill to your account from a package, pasted instructions or GitHub. It is turned on as soon as it is imported."}
    size="lg"
    footer={<>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
      <Button type="submit" form={formId} disabled={busy || !client || (source === "upload" && !file)}>{busy ? "Importing…" : "Import skill"}</Button>
    </>}
  >
    <form id={formId} onSubmit={submit} className="grid gap-4" aria-busy={busy}>
      <fieldset disabled={busy} className="grid min-w-0 gap-3">
        <div><SegmentedControl label="Import source" value={source} onChange={(value) => { setSource(value); setError(""); }} options={[{ value: "upload", label: "Package" }, { value: "text", label: "Paste instructions" }, { value: "git", label: "GitHub URL" }]} /></div>
        {source === "upload" ? <label className="relative flex min-h-28 cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border px-4 py-3 transition-colors hover:bg-[var(--berry-hover)] focus-within:ring-2 focus-within:ring-ring motion-reduce:transition-none" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); choose(e.dataTransfer.files[0]); }}>
          <input className="sr-only" type="file" accept=".skill,.zip,.md" onChange={(e) => choose(e.currentTarget.files?.[0])} />
          <Upload className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="grid min-w-0 gap-0.5">
            <b className="break-all text-md font-medium text-foreground">{file?.name || "Choose or drop a skill package"}</b>
            <small className="text-xs text-muted-foreground">{file ? `${formatFileSize(file.size)} · Click to replace` : ".skill or .zip up to 500 MB, or a SKILL.md up to 256 KB"}</small>
          </span>
        </label> : source === "text" ? <div className="grid gap-1.5">
          <Textarea aria-label="SKILL.md instructions" required value={content} onChange={(e) => setContent(e.target.value)} className="min-h-48 font-mono text-xs" placeholder={"---\nname: weekly-report\ndescription: Prepare my weekly status report\n---\n\nInstructions for Berry…"} />
          <p className="text-xs leading-5 text-muted-foreground">Paste the full SKILL.md, including the name and description at the top.</p>
        </div> : <div className="grid gap-1.5">
          <Input aria-label="GitHub SKILL.md URL" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/org/repo/blob/main/skill/SKILL.md" />
          <p className="text-xs leading-5 text-muted-foreground">Link to a SKILL.md file in a public GitHub repository.</p>
        </div>}
      </fieldset>
      {busy ? <div className="flex items-center gap-3 text-md text-muted-foreground" role="status">
        {phase === "uploading" ? <svg width="24" height="24" viewBox="0 0 36 36" role="progressbar" aria-label="Uploading skill" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" opacity=".15" strokeWidth="3" /><circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="3" pathLength="100" strokeDasharray={`${progress} 100`} transform="rotate(-90 18 18)" /></svg> : <LoaderCircle className="size-5 motion-safe:animate-spin" aria-hidden />}
        {phase === "uploading" ? `Uploading… ${progress}%` : "Checking and installing…"}
      </div> : null}
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
    </form>
  </ManagementDialog>;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
