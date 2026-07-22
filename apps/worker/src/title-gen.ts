import type { TitleGenJobPayload } from "./jobs.js";

export interface TaskTitleRepository {
  updateTaskTitle(input: { tenantId: string; taskId: string; title: string }): Promise<void>;
}

export interface TitleGenerator {
  generateTitle(input: TitleGenJobPayload): Promise<string>;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "how",
  "into",
  "of",
  "on",
  "or",
  "please",
  "the",
  "this",
  "to",
  "with",
]);

export class HeuristicTitleGenerator implements TitleGenerator {
  async generateTitle(input: TitleGenJobPayload): Promise<string> {
    const words = input.sourceText
      .replace(/[`*_#[\](){}<>]/g, " ")
      .split(/\s+/)
      .map((word) => word.trim().replace(/^[^\w]+|[^\w]+$/g, ""))
      .filter((word) => word.length > 1)
      .filter((word) => !STOP_WORDS.has(word.toLowerCase()));
    const title = words.slice(0, 8).join(" ").trim();
    return constrainTitle(title || input.fallbackTitle || "Untitled task");
  }
}

export async function processTitleGenerationJob(
  payload: TitleGenJobPayload,
  dependencies: { titles: TaskTitleRepository; generator?: TitleGenerator },
): Promise<{ taskId: string; title: string }> {
  const title = constrainTitle(await (dependencies.generator ?? new HeuristicTitleGenerator()).generateTitle(payload));
  await dependencies.titles.updateTaskTitle({ tenantId: payload.tenantId, taskId: payload.taskId, title });
  return { taskId: payload.taskId, title };
}

function constrainTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 80) return normalized || "Untitled task";
  return `${normalized.slice(0, 77).trimEnd()}...`;
}
