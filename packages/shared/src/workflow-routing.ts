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
  if (/\b(calendar|schedule|meeting|appointment|invite|reminder)\b/.test(text)) return classification("calendar");
  if (/\b(image|illustration|photo|picture|visual|draw|logo|icon|render)\b/.test(text)) return classification("image");
  if (/\b(pdf|docx?|word|pptx?|powerpoint|spreadsheet|excel|csv|report|document|presentation)\b/.test(text)) {
    return classification("documents");
  }
  if (/\b(email|e-mail|slack|linkedin|sms|text message|message|communicat|reply|draft)\b/.test(text)) {
    return classification("communications");
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
 * Workflow classification is advisory: it may rank tools and select prompt
 * guidance, but it must never remove a capability the caller already admitted.
 * Natural-language requests are routinely multi-intent (for example, "draft a
 * presentation"), so using one heuristic category as authorization can make
 * otherwise valid work impossible.
 */
export function routedBuiltInToolNames(
  _category: WorkflowCategory | null | undefined,
  requested: readonly DurableBuiltInToolName[],
): DurableBuiltInToolName[] {
  return unique(requested);
}

function classification(category: WorkflowCategory): WorkflowClassification {
  return { category, version: WORKFLOW_CATEGORY_VERSION };
}

function unique(values: readonly DurableBuiltInToolName[]): DurableBuiltInToolName[] {
  return [...new Set(values)];
}
