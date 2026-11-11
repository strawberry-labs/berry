import type { DetectedTrigger } from "@berry/client-core/mentions";

export type TextSegment = { text: string; mention: boolean };

/**
 * Splits composer text into plain runs and mention tokens. A mention is the
 * same `trigger + value` markdown the web editor serializes, so the prompt
 * text sent to the server is identical on both clients.
 */
export function segmentText(text: string, tokens: readonly string[]): TextSegment[] {
  const ranges = mentionRanges(text, tokens);
  const segments: TextSegment[] = [];
  let index = 0;
  for (const [start, end] of ranges) {
    if (start > index) segments.push({ text: text.slice(index, start), mention: false });
    segments.push({ text: text.slice(start, end), mention: true });
    index = end;
  }
  if (index < text.length || segments.length === 0) segments.push({ text: text.slice(index), mention: false });
  return segments;
}

/** Deleting one character inside a mention removes the whole token, like the web's atomic nodes. */
export function applyAtomicDeletion(previous: string, next: string, tokens: readonly string[]): string {
  if (next.length !== previous.length - 1) return next;
  let removed = 0;
  while (removed < next.length && previous[removed] === next[removed]) removed += 1;
  if (previous.slice(removed + 1) !== next.slice(removed)) return next;
  const range = mentionRanges(previous, tokens).find(([start, end]) => removed >= start && removed < end);
  if (!range) return next;
  return previous.slice(0, range[0]) + previous.slice(range[1]);
}

/** Replaces the typed trigger and query with the mention markdown and a trailing space. */
export function insertMention(text: string, cursor: number, trigger: DetectedTrigger, markdown: string): { text: string; cursor: number } {
  const before = text.slice(0, trigger.tokenStart);
  const after = text.slice(cursor).replace(/^\S*/, "");
  const inserted = `${markdown} `;
  return { text: `${before}${inserted}${after.replace(/^ /, "")}`, cursor: before.length + inserted.length };
}

function mentionRanges(text: string, tokens: readonly string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const ordered = [...new Set(tokens)].filter(Boolean).sort((left, right) => right.length - left.length);
  for (const token of ordered) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(token, from);
      if (start === -1) break;
      const end = start + token.length;
      const boundaryBefore = start === 0 || /\s/.test(text[start - 1]!);
      const boundaryAfter = end === text.length || /\s/.test(text[end]!);
      if (boundaryBefore && boundaryAfter && !ranges.some(([s, e]) => start < e && end > s)) ranges.push([start, end]);
      from = start + 1;
    }
  }
  return ranges.sort((left, right) => left[0] - right[0]);
}
