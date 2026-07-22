export type MentionTrigger = "@" | "/" | "$" | "#";

export interface MentionItem {
  id: string;
  category: "files" | "folders" | "commands" | "skills" | "subagents" | "sessions";
  label: string;
  description?: string | undefined;
  value: string;
  keywords?: string[] | undefined;
}

export interface MentionSection {
  key: string;
  title: string;
  items: MentionItem[];
}

export interface DetectedTrigger {
  trigger: MentionTrigger;
  query: string;
  tokenStart: number;
}

const TRIGGER_RE = /(^|\s)([@/$#])([^\s@/$#]*)$/;

export function detectTrigger(textBeforeCaret: string): DetectedTrigger | null {
  const match = TRIGGER_RE.exec(textBeforeCaret);
  if (!match) return null;
  const trigger = match[2] as MentionTrigger;
  const query = match[3] ?? "";
  return { trigger, query, tokenStart: textBeforeCaret.length - query.length - 1 };
}

export function filterItems(items: MentionItem[], query: string, limit = 10): MentionItem[] {
  if (!query) return items.slice(0, limit);
  const q = query.toLowerCase();
  return items
    .map((item, index) => ({ item, index, score: scoreItem(item, q) }))
    .filter((entry): entry is { item: MentionItem; index: number; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item)
    .slice(0, limit);
}

function scoreItem(item: MentionItem, query: string): number | null {
  const fields = [item.value, item.label, item.description ?? "", ...(item.keywords ?? [])].map((value) => value.toLowerCase());
  let best: number | null = null;
  for (const field of fields) {
    if (!field) continue;
    const score = field.startsWith(query) ? field.length - query.length : field.includes(query) ? 100 + field.indexOf(query) : null;
    if (score !== null && (best === null || score < best)) best = score;
  }
  return best;
}
