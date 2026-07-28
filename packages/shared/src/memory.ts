import type { MemoryItem, MemoryOperation, MemoryOperationKind, MemoryScope } from "./durable-context.js";

const IMPLICIT_ELIGIBLE_KINDS = new Set([
  "preference",
  "profile",
  "working_convention",
  "relationship",
  "accessibility",
  "communication_style",
  "project_decision",
  "project_convention",
]);

const SECRET_PATTERNS = [
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|private[_ -]?key)\b\s*[:=]/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

const EPHEMERAL_PATTERNS = [
  /\b(?:for now|temporary|temporarily|one[- ]off|this task|current task|today|tomorrow)\b/i,
  /\b(?:line|row|page)\s+\d+\b.*\b(?:current|this)\b/i,
];

export type MemoryCandidateDecision = {
  operation: MemoryOperationKind;
  reason: string;
};

export function decideMemoryOperation(
  existing: Pick<MemoryItem, "content" | "explicit"> | null,
  candidate: Pick<MemoryOperation, "operation" | "kind" | "content" | "explicit">,
  scope: MemoryScope,
): MemoryCandidateDecision {
  if (candidate.operation === "NOOP") return { operation: "NOOP", reason: candidate.content ? "candidate_noop" : "empty_candidate" };
  const eligibility = memoryCandidateEligibility(candidate, scope);
  if (!eligibility.eligible) return { operation: "NOOP", reason: eligibility.reason };
  if (!existing) return { operation: "ADD", reason: "no_active_equivalent" };
  if (normalizeMemoryContent(existing.content) === normalizeMemoryContent(candidate.content)) {
    return { operation: "REFRESH", reason: "same_fact_reconfirmed" };
  }
  if (existing.explicit && !candidate.explicit) {
    return { operation: "NOOP", reason: "implicit_candidate_cannot_replace_explicit_memory" };
  }
  return { operation: "SUPERSEDE", reason: candidate.explicit ? "explicit_update" : "newer_conflicting_fact" };
}

export function memoryCandidateEligibility(
  candidate: Pick<MemoryOperation, "kind" | "content" | "explicit">,
  scope: MemoryScope,
): { eligible: true } | { eligible: false; reason: string } {
  const content = candidate.content.trim();
  if (!content) return { eligible: false, reason: "empty_content" };
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    return { eligible: false, reason: "credentials_and_secrets_are_not_memory" };
  }
  if (!candidate.explicit && !IMPLICIT_ELIGIBLE_KINDS.has(candidate.kind)) {
    return { eligible: false, reason: "unsupported_implicit_memory_kind" };
  }
  if (!candidate.explicit && EPHEMERAL_PATTERNS.some((pattern) => pattern.test(content))) {
    return { eligible: false, reason: "ephemeral_task_detail" };
  }
  if (!candidate.explicit && (content.length > 2_000 || content.split("\n").length > 20)) {
    return { eligible: false, reason: scope === "personal" ? "copied_document_is_not_personal_memory" : "candidate_too_large" };
  }
  return { eligible: true };
}

export function normalizeMemoryStableKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 240);
}

export function normalizeMemoryContent(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function sanitizePersonalMemorySource(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\0/g, "")
    .split("\n")
    .filter((line) => !SECRET_PATTERNS.some((pattern) => pattern.test(line)))
    .join("\n")
    .trim()
    .slice(0, 16_000);
}
