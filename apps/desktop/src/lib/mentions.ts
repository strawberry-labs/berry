/**
 * Composer autocomplete primitives for trigger-token insertion. Four trigger
 * characters each open a popover of live-filtering results:
 *   @ files/folders   / commands   $ skills   # conversations
 */

export type MentionTrigger = "@" | "/" | "$" | "#";

export const MENTION_TRIGGERS: MentionTrigger[] = ["@", "/", "$", "#"];

export interface MentionItem {
  id: string;
  /** Groups items under a section header and picks the accent color. */
  category: string;
  label: string;
  description?: string;
  /** Text inserted after the trigger char, e.g. a file path or command name. */
  value: string;
  /** Extra strings the fuzzy filter also matches against. */
  keywords?: string[];
}

export interface MentionSection {
  key: string;
  title: string;
  items: MentionItem[];
}

/** A trigger only fires at line start or after whitespace; query is the run of
 *  non-space, non-trigger chars up to the caret. */
const TRIGGER_RE = /(^|\s)([@/$#])([^\s@/$#]*)$/;
/** The run of characters after the caret that belong to the same token. */
const TAIL_RE = /^[^\s@/$#]*/;

export interface DetectedTrigger {
  trigger: MentionTrigger;
  query: string;
  /** Index of the trigger char in the full value. */
  tokenStart: number;
}

/** Parse the text before the caret; returns the active trigger token or null. */
export function detectTrigger(textBeforeCaret: string): DetectedTrigger | null {
  const match = TRIGGER_RE.exec(textBeforeCaret);
  if (!match) return null;
  const trigger = match[2] as MentionTrigger;
  const query = match[3] ?? "";
  return { trigger, query, tokenStart: textBeforeCaret.length - query.length - 1 };
}

/** Replace the whole trigger token (including any tail after the caret) with
 *  `insertText` + a trailing space. Returns the new value and caret offset. */
export function applyMention(
  value: string,
  caret: number,
  tokenStart: number,
  insertText: string,
): { value: string; caret: number } {
  const tail = TAIL_RE.exec(value.slice(caret))?.[0] ?? "";
  const end = caret + tail.length;
  const next = `${value.slice(0, tokenStart)}${insertText} ${value.slice(end)}`;
  return { value: next, caret: tokenStart + insertText.length + 1 };
}

/**
 * Fuzzy score — lower is better, null means "no match":
 *   exact prefix  → len - qlen           (best)
 *   substring     → 100 + index
 *   subsequence   → 200 + gap + (len - qlen)
 */
function fuzzyScore(candidate: string, query: string): number | null {
  if (query.length === 0) return 0;
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (c.startsWith(q)) return c.length - q.length;
  const index = c.indexOf(q);
  if (index !== -1) return 100 + index;
  // subsequence
  let ci = 0;
  let gap = 0;
  let lastHit = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (; ci < c.length; ci++) {
      if (c[ci] === ch) {
        found = ci;
        ci++;
        break;
      }
    }
    if (found === -1) return null;
    if (lastHit !== -1) gap += found - lastHit - 1;
    lastHit = found;
  }
  return 200 + gap + (c.length - q.length);
}

/** Weighted min score across value/label/description/keywords. */
function scoreItem(item: MentionItem, query: string): number | null {
  const candidates: Array<[string, number]> = [
    [item.value, 0],
    [item.label, 50],
    [item.description ?? "", 250],
    ...(item.keywords ?? []).map((k) => [k, 350] as [string, number]),
  ];
  let best: number | null = null;
  for (const [text, penalty] of candidates) {
    if (!text) continue;
    const s = fuzzyScore(text, query);
    if (s === null) continue;
    const total = s + penalty;
    if (best === null || total < best) best = total;
  }
  return best;
}

/** Filter + sort a candidate list. With no query, returns the first `limit`
 *  (unless `requireQuery` forces empty). */
export function filterItems(
  items: MentionItem[],
  query: string,
  options: { limit?: number; requireQuery?: boolean } = {},
): MentionItem[] {
  const { limit, requireQuery } = options;
  if (query.length === 0) {
    if (requireQuery) return [];
    return typeof limit === "number" ? items.slice(0, limit) : items;
  }
  const scored: Array<{ item: MentionItem; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const score = scoreItem(item, query);
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index || a.item.label.localeCompare(b.item.label));
  const sorted = scored.map((s) => s.item);
  return typeof limit === "number" ? sorted.slice(0, limit) : sorted;
}

/** Footer hint text shown while a trigger is active but the query is empty. */
export const MENTION_HINTS: Record<MentionTrigger, string> = {
  "@": "Type to search files or folders",
  "/": "Type to search commands",
  $: "Type to search skills",
  "#": "Type to search recent conversations",
};

export const MENTION_EMPTY: Record<MentionTrigger, string> = {
  "@": "No matching files",
  "/": "No matching commands",
  $: "No matching skills",
  "#": "No matching conversations",
};
