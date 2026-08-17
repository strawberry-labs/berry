import { z } from "zod";
import type { DurableBuiltInToolName } from "./durable-context.ts";

export const WORKFLOW_CATEGORY_VERSION = "workflow-v1" as const;

export const WorkflowCategorySchema = z.enum([
  "general",
  "code",
  "documents",
  "communications",
  "file_data",
  "image",
  "calendar",
  "web_research",
  "memory",
  "unknown",
]);
export type WorkflowCategory = z.infer<typeof WorkflowCategorySchema>;

export type WorkflowClassificationInput = {
  input?: string | null | undefined;
  intent?: string | null | undefined;
  conversationKind?: string | null | undefined;
  attachments?: ReadonlyArray<{ name?: string | null | undefined; mediaType?: string | null | undefined }> | undefined;
};

export type WorkflowClassification = {
  category: WorkflowCategory;
  version: typeof WORKFLOW_CATEGORY_VERSION;
};

/**
 * Classifies only at admission, while the protected prompt is already in
 * memory. The durable record stores the low-cardinality result, never the
 * text used to choose it.
 */
export function classifyWorkflowCategory(input: WorkflowClassificationInput): WorkflowClassification {
  const intent = input.intent?.trim().toLowerCase();
  if (intent === "image_generation") return classification("image");
  if (input.conversationKind?.trim().toLowerCase() === "code") return classification("code");

  const attachmentText = (input.attachments ?? [])
    .flatMap((attachment) => [attachment.name ?? "", attachment.mediaType ?? ""])
    .join(" ")
    .toLowerCase();
  if (/image|png|jpe?g|gif|webp|visual|photo/.test(attachmentText)) return classification("image");
  if (/pdf|docx?|word|pptx?|powerpoint|spreadsheet|excel|csv|report|document/.test(attachmentText)) {
    return classification("documents");
  }

  const text = `${input.input ?? ""} ${intent ?? ""}`.trim().toLowerCase();
  if (!text) return classification("unknown");
  if (/\b(code|coding|repository|repo|pull request|bug|typescript|javascript|python|sql|debug|compile|test suite)\b/.test(text)) {
    return classification("code");
  }
  if (/\b(email|e-mail|slack|linkedin|sms|text message|message|communicat|reply|draft)\b/.test(text)) {
    return classification("communications");
  }
  if (/\b(calendar|schedule|meeting|appointment|invite|reminder)\b/.test(text)) return classification("calendar");
  if (/\b(image|illustration|photo|picture|visual|draw|logo|icon|render)\b/.test(text)) return classification("image");
  if (/\b(pdf|docx?|word|pptx?|powerpoint|spreadsheet|excel|csv|report|document|presentation)\b/.test(text)) {
    return classification("documents");
  }
  if (/\b(file|folder|directory|data|dataset|table|json|yaml|upload|download|artifact)\b/.test(text)) {
    return classification("file_data");
  }
  if (/\b(search|research|browse|web|website|url|source|citation|extract)\b/.test(text)) {
    return classification("web_research");
  }
  if (/\b(memory|remember|forget|personaliz|preference)\b/.test(text)) return classification("memory");
  return classification("general");
}

/**
 * Keep high-risk and user-control tools available, while limiting ordinary
 * built-ins to the admitted workflow. An unknown category deliberately keeps
 * the legacy requested set so older/resumed records remain compatible.
 */
export function routedBuiltInToolNames(
  category: WorkflowCategory | null | undefined,
  requested: readonly DurableBuiltInToolName[],
): DurableBuiltInToolName[] {
  if (!category || category === "unknown") return unique(requested);
  const safety = new Set(["ask_user_question", "compose_message", "persist_artifact", "save_personal_skill", "activate_skill"]);
  const categoryTools: Record<Exclude<WorkflowCategory, "unknown">, readonly DurableBuiltInToolName[]> = {
    general: ["read", "grep", "find", "ls"],
    code: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    documents: ["read", "write", "edit", "grep", "find", "ls"],
    communications: ["read", "grep", "find", "ls"],
    file_data: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    image: ["read", "inspect_images", "create_image"],
    calendar: ["read", "grep", "find", "ls"],
    web_research: ["read", "grep", "find", "ls"],
    memory: ["read", "grep", "find", "ls"],
  };
  const allowed = new Set([...safety, ...categoryTools[category]]);
  return unique(requested.filter((name) => allowed.has(name)));
}

function classification(category: WorkflowCategory): WorkflowClassification {
  return { category, version: WORKFLOW_CATEGORY_VERSION };
}

function unique(values: readonly DurableBuiltInToolName[]): DurableBuiltInToolName[] {
  return [...new Set(values)];
}
