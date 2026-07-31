export interface DurableAttachmentReference {
  fileId: string;
  name: string;
  mediaType?: string | null;
  size?: number | null;
}

export function durableAttachmentPath(attachment: Pick<DurableAttachmentReference, "fileId" | "name">): string {
  return `/workspace/inputs/${attachment.fileId}/${safeAttachmentName(attachment.name)}`;
}

export function durableAttachmentPrompt(attachment: DurableAttachmentReference): string {
  const mediaType = attachment.mediaType?.trim().toLowerCase() ?? "";
  const lowerName = attachment.name.toLowerCase();
  const details = [
    attachment.mediaType?.trim(),
    typeof attachment.size === "number" && Number.isFinite(attachment.size)
      ? `${attachment.size} bytes`
      : null,
  ].filter(Boolean).join(", ");
  return [
    `Attached file: ${attachment.name}${details ? ` (${details})` : ""}`,
    `Sandbox path: ${durableAttachmentPath(attachment)}`,
    mediaType === "application/pdf" || lowerName.endsWith(".pdf")
      ? "Use read_file on this PDF path; read_file extracts its text safely instead of decoding the PDF bytes as UTF-8."
      : mediaType.startsWith("image/")
        ? "This is a binary image. read_file returns safe metadata; use an image-capable skill/tool when visual inspection is required."
        : "",
  ].filter(Boolean).join("\n");
}

function safeAttachmentName(value: string): string {
  const basename = value.trim().replaceAll("\\", "/").split("/").at(-1) ?? "";
  const normalized = basename
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._() -]+/gu, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return normalized && normalized !== "." && normalized !== ".." ? normalized : "attachment";
}
