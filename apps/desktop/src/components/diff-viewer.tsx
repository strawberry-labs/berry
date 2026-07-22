import * as React from "react";
import type { BundledLanguage, BundledTheme, ThemedToken } from "shiki";
import type { ReviewComment, ReviewCommentAnchor } from "@berry/shared";
import { ChevronRight, FileText, MessageSquare } from "@berry/desktop-ui/lib/icons";
import { useTheme } from "next-themes";

import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { cn } from "@berry/desktop-ui/lib/utils";
import { diffLineAnchor, type DiffFile, type DiffLine, type DiffRange, parseUnifiedDiff, virtualRange } from "@berry/thread-ui/diff-model";

const ROW_HEIGHT = 22;
const LARGE_DIFF_THRESHOLD = 160;
const LARGE_DIFF_HEIGHT = 440;

type HighlightMap = Map<string, ThemedToken[]>;

export function DiffViewer({ diff, review }: {
  diff: string;
  review?: {
    commitSha: string;
    comments: ReviewComment[];
    onCreate?: (anchor: ReviewCommentAnchor, body: string) => Promise<void>;
    onResolve?: (comment: ReviewComment, resolved: boolean) => Promise<void>;
    onReply?: (comment: ReviewComment, body: string) => Promise<void>;
  };
}) {
  const files = React.useMemo(() => parseUnifiedDiff(diff), [diff]);
  const identity = files.map((file) => file.id).join("|");
  const [openFiles, setOpenFiles] = React.useState<Set<string>>(() => new Set(files.slice(0, 2).map((file) => file.id)));
  const [draft, setDraft] = React.useState<{ fileId: string; anchor: ReviewCommentAnchor } | null>(null);

  React.useEffect(() => {
    setOpenFiles(new Set(files.slice(0, 2).map((file) => file.id)));
  }, [identity]);

  if (files.length === 0) return <div className="berry-activity-surface p-3 text-sm text-muted-foreground">No diff</div>;

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-2" data-testid="diff-viewer">
      {files.map((file) => {
        const open = openFiles.has(file.id);
        return (
          <section key={file.id} className="w-full min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-[var(--berry-surface-inset)]" data-diff-file={file.newPath}>
            <button
              type="button"
              aria-expanded={open}
              aria-label={`Toggle diff for ${file.newPath}`}
              className="flex min-h-10 w-full items-center gap-2 px-3 text-left hover:bg-muted/25"
              onClick={() => setOpenFiles((current) => {
                const next = new Set(current);
                if (next.has(file.id)) next.delete(file.id); else next.add(file.id);
                return next;
              })}
            >
              <ChevronRight className={cn("size-3.5 shrink-0 transition-transform duration-200", open && "rotate-90")} />
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.displayPath}>{file.displayPath}</span>
              {file.status !== "modified" ? <Badge variant="outline" className="shrink-0 capitalize">{file.status}</Badge> : null}
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-success">+{file.additions}</span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-destructive">-{file.deletions}</span>
            </button>
            {open ? (
              <>
                <DiffFileBody
                  file={file}
                  comments={review?.comments ?? []}
                  onSelectLine={review?.onCreate ? (line) => {
                    const anchor = diffLineAnchor(file, line);
                    if (anchor) setDraft({ fileId: file.id, anchor: { ...anchor, oldPath: anchor.oldPath || null, commitSha: review.commitSha } });
                  } : undefined}
                />
                {review && (draft?.fileId === file.id || review.comments.some((comment) => comment.anchor.path === file.newPath || comment.anchor.oldPath === file.oldPath)) ? (
                  <ReviewThreads
                    file={file}
                    comments={review.comments}
                    draft={draft?.fileId === file.id ? draft.anchor : null}
                    onCancel={() => setDraft(null)}
                    onCreate={review.onCreate ? async (anchor, body) => { await review.onCreate!(anchor, body); setDraft(null); } : undefined}
                    onResolve={review.onResolve}
                    onReply={review.onReply}
                  />
                ) : null}
              </>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function DiffFileBody({ file, comments, onSelectLine }: { file: DiffFile; comments: ReviewComment[]; onSelectLine?: (line: DiffLine) => void }) {
  const highlights = useDiffHighlights(file);
  const virtualized = file.lines.length > LARGE_DIFF_THRESHOLD;
  const [scrollTop, setScrollTop] = React.useState(0);
  const range = virtualized
    ? virtualRange(file.lines.length, scrollTop, LARGE_DIFF_HEIGHT, ROW_HEIGHT)
    : { start: 0, end: file.lines.length, offsetTop: 0, offsetBottom: 0 };
  const visible = file.lines.slice(range.start, range.end);

  return (
    <div
      className={cn("w-full max-w-full overflow-auto border-t border-border font-mono text-[11px]", virtualized && "max-h-[440px]")}
      data-virtualized={virtualized ? "true" : "false"}
      data-line-count={file.lines.length}
      data-highlight-status={highlights.size > 0 ? "highlighted" : "pending"}
      onScroll={virtualized ? (event) => setScrollTop(event.currentTarget.scrollTop) : undefined}
    >
      <div className="min-w-max" style={{ paddingTop: range.offsetTop, paddingBottom: range.offsetBottom }}>
        {visible.map((line) => (
          <DiffRow
            key={line.id}
            line={line}
            tokens={highlights.get(line.id) ?? []}
            commentCount={comments.filter((comment) => commentMatchesLine(file, line, comment)).length}
            onSelect={onSelectLine && (line.oldLine || line.newLine) ? () => onSelectLine(line) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function DiffRow({ line, tokens, commentCount, onSelect }: { line: DiffLine; tokens: ThemedToken[]; commentCount: number; onSelect?: () => void }) {
  if (line.kind === "hunk") {
    return <div className="flex h-[22px] min-w-full items-center bg-accent/20 px-3 text-warning" data-diff-line="hunk"><span>{line.raw}</span></div>;
  }
  if (line.kind === "meta") {
    return <div className="flex h-[22px] min-w-full items-center px-3 text-muted-foreground" data-diff-line="meta"><span>{line.raw}</span></div>;
  }
  return (
    <div className={cn("group flex h-[22px] min-w-full items-stretch", lineBackground(line.kind))} data-diff-line={line.kind}>
      <span className="flex w-10 shrink-0 items-center justify-end border-r border-border/50 px-2 text-muted-foreground/55 tabular-nums select-none">{line.oldLine ?? ""}</span>
      <span className="flex w-10 shrink-0 items-center justify-end border-r border-border/50 px-2 text-muted-foreground/55 tabular-nums select-none">{line.newLine ?? ""}</span>
      <span className={cn("flex w-5 shrink-0 items-center justify-center select-none", line.kind === "add" ? "text-success" : line.kind === "remove" ? "text-destructive" : "text-muted-foreground/50")}>{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}</span>
      <code className="flex min-w-0 flex-1 items-center pr-4 whitespace-pre">{renderHighlightedContent(line, tokens)}</code>
      {onSelect ? (
        <button type="button" className={cn("sticky right-0 flex w-8 shrink-0 items-center justify-center bg-inherit text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100", commentCount > 0 && "opacity-100")} aria-label={`Comment on line ${line.newLine ?? line.oldLine}`} title="Add review comment" onClick={onSelect}>
          <MessageSquare className="size-3" />
          {commentCount > 0 ? <span className="ml-0.5 text-[9px] tabular-nums">{commentCount}</span> : null}
        </button>
      ) : null}
    </div>
  );
}

function ReviewThreads({ file, comments, draft, onCancel, onCreate, onResolve, onReply }: {
  file: DiffFile;
  comments: ReviewComment[];
  draft: ReviewCommentAnchor | null;
  onCancel: () => void;
  onCreate?: (anchor: ReviewCommentAnchor, body: string) => Promise<void>;
  onResolve?: (comment: ReviewComment, resolved: boolean) => Promise<void>;
  onReply?: (comment: ReviewComment, body: string) => Promise<void>;
}) {
  const [body, setBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [replyTo, setReplyTo] = React.useState<string | null>(null);
  const [replyBody, setReplyBody] = React.useState("");
  const fileComments = comments.filter((comment) => comment.anchor.path === file.newPath || comment.anchor.oldPath === file.oldPath);
  return (
    <div className="border-t border-border bg-background/35 p-3" data-testid="review-threads">
      <div className="flex flex-col gap-2">
        {fileComments.map((comment) => (
          <div key={comment.id} className={cn("rounded-md border border-border bg-[var(--berry-surface-raised)] p-2.5", comment.resolved && "opacity-65", comment.inReplyToId && "ml-5")}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0"><div className="truncate text-[10px] font-medium">{comment.author ?? (comment.source === "github" ? "GitHub reviewer" : "Berry review")}</div><div className="font-mono text-[10px] text-muted-foreground">{comment.anchor.side === "new" ? "+" : "-"}{comment.anchor.line} · {comment.anchor.commitSha.slice(0, 8)}</div></div>
              <div className="flex items-center gap-1">{comment.outdated ? <Badge variant="outline">Outdated</Badge> : null}{onReply && comment.source === "github" && comment.externalId ? <Button size="sm" variant="ghost" onClick={() => setReplyTo(replyTo === comment.id ? null : comment.id)}>Reply</Button> : null}{onResolve && comment.source !== "github" ? <Button size="sm" variant="ghost" onClick={() => void onResolve(comment, !comment.resolved)}>{comment.resolved ? "Reopen" : "Resolve"}</Button> : null}</div>
            </div>
            <p className={cn("mt-1 whitespace-pre-wrap text-xs leading-5", comment.resolved && "line-through")}>{comment.body}</p>
            {replyTo === comment.id && onReply ? <form className="mt-2 border-t border-border pt-2" onSubmit={(event) => { event.preventDefault(); if (!replyBody.trim() || saving) return; setSaving(true); void onReply(comment, replyBody.trim()).then(() => { setReplyBody(""); setReplyTo(null); }).finally(() => setSaving(false)); }}><textarea autoFocus aria-label={`Reply to ${comment.author ?? "review comment"}`} value={replyBody} onChange={(event) => setReplyBody(event.target.value)} className="min-h-16 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50" /><div className="mt-2 flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setReplyTo(null)}>Cancel</Button><Button type="submit" size="sm" disabled={!replyBody.trim() || saving}>{saving ? "Replying..." : "Reply"}</Button></div></form> : null}
          </div>
        ))}
        {draft && onCreate ? (
          <form className="rounded-md border border-border bg-[var(--berry-surface-raised)] p-2.5" onSubmit={(event) => {
            event.preventDefault();
            if (!body.trim() || saving) return;
            setSaving(true);
            void onCreate(draft, body.trim()).finally(() => { setSaving(false); setBody(""); });
          }}>
            <div className="mb-2 font-mono text-[10px] text-muted-foreground">{draft.path}:{draft.line} · {draft.commitSha.slice(0, 8)}</div>
            <textarea autoFocus aria-label="Review comment" value={body} onChange={(event) => setBody(event.target.value)} className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
            <div className="mt-2 flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button><Button type="submit" size="sm" disabled={!body.trim() || saving}>{saving ? "Adding..." : "Add comment"}</Button></div>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function commentMatchesLine(file: DiffFile, line: DiffLine, comment: ReviewComment): boolean {
  const anchor = diffLineAnchor(file, line);
  return Boolean(anchor && comment.anchor.path === anchor.path && comment.anchor.side === anchor.side && comment.anchor.line === anchor.line);
}

function useDiffHighlights(file: DiffFile): HighlightMap {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "light" ? "vitesse-light" : "vitesse-dark";
  const codeLines = React.useMemo(() => file.lines.filter((line) => line.kind === "context" || line.kind === "add" || line.kind === "remove"), [file.lines]);
  const cacheKey = `${theme}\0${file.language}\0${codeLines.map((line) => line.content).join("\n")}`;
  const [result, setResult] = React.useState<HighlightMap>(new Map());

  React.useEffect(() => {
    let cancelled = false;
    if (codeLines.length === 0) { setResult(new Map()); return; }
    void import("shiki").then(async (shiki) => {
      const language = shikiLanguage(file.language, shiki.bundledLanguages);
      if (!language) return;
      const highlighted = await shiki.codeToTokens(codeLines.map((line) => line.content).join("\n"), { lang: language, theme: theme as BundledTheme });
      if (cancelled) return;
      setResult(new Map(codeLines.map((line, index) => [line.id, highlighted.tokens[index] ?? []])));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [cacheKey, codeLines, file.language, theme]);

  return result;
}

function renderHighlightedContent(line: DiffLine, tokens: ThemedToken[]): React.ReactNode {
  if (tokens.length === 0) return renderSlices(line.content, line.changed, undefined, "fallback");
  return tokens.map((token, tokenIndex) => {
    const start = token.offset ?? tokens.slice(0, tokenIndex).reduce((sum, value) => sum + value.content.length, 0);
    const localRanges = intersections(line.changed, start, start + token.content.length).map((range) => ({ start: range.start - start, end: range.end - start }));
    return <React.Fragment key={`${tokenIndex}:${start}`}>{renderSlices(token.content, localRanges, token.color ? { color: token.color } : undefined, `${tokenIndex}`)}</React.Fragment>;
  });
}

function renderSlices(content: string, ranges: DiffRange[], style: React.CSSProperties | undefined, keyPrefix: string): React.ReactNode[] {
  if (ranges.length === 0) return [<span key={`${keyPrefix}:plain`} style={style} data-shiki-token={style ? "" : undefined}>{content || "\u00a0"}</span>];
  const boundaries = new Set([0, content.length]);
  for (const range of ranges) { boundaries.add(range.start); boundaries.add(range.end); }
  const points = [...boundaries].sort((left, right) => left - right);
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1]!;
    const changed = ranges.some((range) => start >= range.start && end <= range.end);
    return <span key={`${keyPrefix}:${start}`} style={style} className={changed ? "bg-foreground/15 font-semibold" : undefined} data-shiki-token={style ? "" : undefined} data-word-change={changed ? "true" : undefined}>{content.slice(start, end)}</span>;
  });
}

function intersections(ranges: DiffRange[], start: number, end: number): DiffRange[] {
  return ranges.flatMap((range) => {
    const overlapStart = Math.max(start, range.start);
    const overlapEnd = Math.min(end, range.end);
    return overlapStart < overlapEnd ? [{ start: overlapStart, end: overlapEnd }] : [];
  });
}

function lineBackground(kind: DiffLine["kind"]): string {
  if (kind === "add") return "bg-success/10";
  if (kind === "remove") return "bg-destructive/10";
  return "bg-transparent";
}

function shikiLanguage(language: string, bundledLanguages: Record<string, unknown>): BundledLanguage | null {
  if (language === "text") return null;
  return language in bundledLanguages ? language as BundledLanguage : null;
}
