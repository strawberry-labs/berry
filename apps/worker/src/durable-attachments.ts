export interface DurableAttachmentReference {
  fileId: string;
  name: string;
  mediaType?: string | null;
  size?: number | null;
}

export function durableAttachmentPath(
  attachment: Pick<DurableAttachmentReference, "fileId" | "name">,
  workspaceRoot = "/workspace",
): string {
  return `${safeWorkspaceRoot(workspaceRoot)}/inputs/${attachment.fileId}/${safeAttachmentName(attachment.name)}`;
}

export function durableAttachmentPrompt(attachment: DurableAttachmentReference, workspaceRoot = "/workspace"): string {
  const lowerName = attachment.name.toLowerCase();
  const mediaType = semanticAttachmentMediaType(lowerName, attachment.mediaType);
  const isPdf = mediaType === "application/pdf";
  const isZip = mediaType === "application/zip";
  const isOfficeDocument = /\.(docx?|xlsx?|xlsm|pptx?)$/.test(lowerName)
    || /wordprocessingml|msword|spreadsheet|excel|presentationml|powerpoint/.test(mediaType);
  const details = [
    mediaType,
    typeof attachment.size === "number" && Number.isFinite(attachment.size)
      ? `${attachment.size} bytes`
      : null,
  ].filter(Boolean).join(", ");
  return [
    `Attached file: ${attachment.name}${details ? ` (${details})` : ""}`,
    `Sandbox path: ${durableAttachmentPath(attachment, workspaceRoot)}`,
    isPdf
      ? "Use read on this PDF path for page-numbered text. Use page_start/page_end for a targeted range."
      : isZip
        ? "Use read on this ZIP path first to get a safe inventory, then use read on the exact extracted document paths you need."
        : isOfficeDocument
          ? "Use read on this document path for extracted text. Use the matching document skill when layout, formatting, formulas, or editing matter."
      : mediaType.startsWith("image/")
        ? "This is a binary image. read returns safe metadata; use an image-capable skill/tool when visual inspection is required."
        : "",
  ].filter(Boolean).join("\n");
}

function semanticAttachmentMediaType(name: string, declaredMediaType: string | null | undefined): string {
  const extensionMediaType = ({
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
  } as Record<string, string>)[name.split(".").at(-1) ?? ""];
  return extensionMediaType ?? declaredMediaType?.trim().toLowerCase() ?? "";
}

function safeWorkspaceRoot(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!normalized.startsWith("/") || parts.length === 0 || parts.includes(".") || parts.includes("..")) {
    throw new Error("Sandbox workspace root must be an absolute path without traversal segments");
  }
  return `/${parts.join("/")}`;
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
