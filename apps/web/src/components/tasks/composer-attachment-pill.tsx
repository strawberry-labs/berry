import type { AttachmentInput } from "@berry/shared";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle } from "@berry/desktop-ui/components/ui/attachment";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@berry/desktop-ui/components/ui/tooltip";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { FileText } from "@berry/desktop-ui/lib/icons";
import { isPassiveInlineImageFile } from "../library/file-preview-policy";

export function ComposerAttachmentPill({ attachment, presentation, onRemove, onShowInline, onOpenFile }: {
  attachment: AttachmentInput;
  presentation: { title: string; mode: "inline" | "file" } | undefined;
  onRemove: () => void;
  onShowInline: () => void;
  onOpenFile: () => void;
}) {
  const imagePreview = isPassiveInlineImageFile(attachment) ? (attachment.previewUrl || attachment.dataUrl) : null;
  const pill = (
    <Attachment size="sm" className="max-w-[360px] flex-nowrap rounded-[22px] border-0 bg-card shadow-[var(--berry-ring-subtle)]">
      {presentation?.mode === "file" ? <button type="button" className="absolute inset-0 z-10 rounded-[22px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Open ${attachment.name}`} onClick={onOpenFile} /> : null}
      <AttachmentMedia variant={imagePreview ? "image" : "icon"} className={imagePreview ? "berry-composer-attachment-preview !w-10 rounded-lg" : "!w-10 rounded-full bg-transparent"}>
        {imagePreview ? <img src={imagePreview} alt="" /> : presentation ? <FileText className="text-[var(--berry-accent)]" /> : <FileTypeIcon path={attachment.name} className="size-10" />}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{presentation?.title ?? attachment.name}</AttachmentTitle>
        {presentation?.mode === "inline" ? <AttachmentDescription><button type="button" className="relative z-20 underline decoration-dotted underline-offset-4" onClick={onShowInline}>Show in text field ›</button></AttachmentDescription> : <AttachmentDescription>{presentation ? "Pasted text" : formatFileSize(attachment.size)}</AttachmentDescription>}
      </AttachmentContent>
      <AttachmentActions><AttachmentAction aria-label={`Remove ${attachment.name}`} onClick={onRemove}>×</AttachmentAction></AttachmentActions>
    </Attachment>
  );
  if (presentation?.mode !== "file") return pill;
  return <TooltipProvider delayDuration={350}><Tooltip><TooltipTrigger asChild><div className="w-fit max-w-full">{pill}</div></TooltipTrigger><TooltipContent side="top" showArrow={false}>Too long to show in text field</TooltipContent></Tooltip></TooltipProvider>;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
