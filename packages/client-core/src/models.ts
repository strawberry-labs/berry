import type { ReasoningLevel } from "@berry/shared";

/** Reasoning levels a model offers in the composer, shared by web and mobile. */
export function reasoningLevelsForModel(model: {
  id: string;
  label?: string | undefined;
  capabilities?: { reasoning?: boolean | undefined; reasoningEfforts?: ReasoningLevel[] | undefined } | undefined;
} | undefined): ReasoningLevel[] {
  if (!model) return ["off", "low", "medium", "high"];
  if (model.capabilities?.reasoningEfforts?.length) return [...model.capabilities.reasoningEfforts];
  if (model.capabilities?.reasoning === false) return ["off"];
  if (/glm[-_. ]?5(?:\.2|[-_.]?2)/i.test(`${model.id} ${model.label ?? ""}`)) return ["high", "xhigh"];
  return ["off", "low", "medium", "high"];
}

export function reasoningLabel(level: ReasoningLevel): string {
  return level === "xhigh" ? "Extra high" : level[0]!.toUpperCase() + level.slice(1);
}
