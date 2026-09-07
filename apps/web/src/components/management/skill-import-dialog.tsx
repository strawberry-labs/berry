import { actionErrorMessage } from "@/lib/action-error";
import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import { PERSONAL_SKILL_PACKAGE_MAX_BYTES } from "@berry/shared";
import { Upload, LoaderCircle } from "lucide-react";
import { Button, Input, Textarea, ManagementDialog } from "./management-primitives";

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
  return <ManagementDialog open={open} onOpenChange={(value) => { if (!locked.current) onOpenChange(value); }} title="Import a skill" description={ownerId ? "Add and enable a personal skill for this member." : "Add a package, paste instructions, or import from GitHub."} size="lg">
    <form onSubmit={submit} className="grid gap-4" aria-busy={busy}>
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <div className="flex gap-2" role="group" aria-label="Import source">{([ ["upload", "Package"], ["text", "Paste instructions"], ["git", "GitHub URL"] ] as const).map(([value, label]) => <Button key={value} type="button" variant={source === value ? "default" : "secondary"} aria-pressed={source === value} onClick={() => { setSource(value); setError(""); }}>{label}</Button>)}</div>
        {source === "upload" ? <label className="settings-skill-dropzone min-h-32" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); choose(e.dataTransfer.files[0]); }}>
          <input type="file" accept=".skill,.zip,.md" onChange={(e) => choose(e.currentTarget.files?.[0])} /><Upload aria-hidden /><span className="min-w-0"><b className="break-all">{file?.name || "Choose or drop a skill package"}</b><small>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · Click to replace` : ".skill or .zip up to 500 MB · SKILL.md up to 256 KB"}</small></span>
        </label> : source === "text" ? <Textarea aria-label="SKILL.md instructions" required value={content} onChange={(e) => setContent(e.target.value)} className="min-h-48" placeholder="Paste SKILL.md including its name and description…" /> : <Input aria-label="GitHub SKILL.md URL" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/org/repo/blob/main/skill/SKILL.md" />}
      </fieldset>
      {busy ? <div className="flex items-center gap-3 text-sm" role="status">
        {phase === "uploading" ? <svg width="32" height="32" viewBox="0 0 36 36" role="progressbar" aria-label="Uploading skill" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" opacity=".15" strokeWidth="3" /><circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="3" pathLength="100" strokeDasharray={`${progress} 100`} transform="rotate(-90 18 18)" /></svg> : <LoaderCircle className="size-6 motion-safe:animate-spin" />}
        {phase === "uploading" ? `Uploading… ${progress}%` : "Verifying and installing…"}
      </div> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy || !client || (source === "upload" && !file)}>{busy ? "Importing…" : "Import and enable"}</Button></div>
    </form>
  </ManagementDialog>;
}
