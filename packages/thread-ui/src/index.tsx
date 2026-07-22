import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { parseUnifiedDiff, type DiffFile } from "./diff-model.js";

export * from "./diff-model.js";

const GFM_PLUGINS = [remarkGfm];

export function MarkdownContent({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={GFM_PLUGINS}>{children}</ReactMarkdown>;
}

export interface ThreadToolPill {
  id: string;
  label: string;
  status?: "running" | "completed" | "failed" | "denied" | "pending";
  detail?: string;
}

export interface ThreadApprovalPill {
  id: string;
  title: string;
}

export function ThreadToolStrip({
  tools,
  approval,
  className,
  pillClassName,
  renderStatusIcon,
}: {
  tools: ThreadToolPill[];
  approval?: ThreadApprovalPill | null;
  className?: string;
  pillClassName?: string;
  renderStatusIcon?: (status: ThreadToolPill["status"], kind: "tool" | "approval") => React.ReactNode;
}) {
  if (tools.length === 0 && !approval) return null;
  return (
    <div className={className} data-thread-tool-strip="">
      {tools.map((tool) => (
        <span key={tool.id} className={pillClassName} data-tool-status={tool.status ?? "pending"}>
          {renderStatusIcon?.(tool.status, "tool")}
          {tool.label}
          {tool.detail ? ` · ${tool.detail}` : ""}
        </span>
      ))}
      {approval ? (
        <span className={pillClassName} data-tool-status="approval" data-approval-id={approval.id}>
          {renderStatusIcon?.("pending", "approval")}
          Approval · {approval.title}
        </span>
      ) : null}
    </div>
  );
}

export interface DiffSummaryFile {
  id: string;
  displayPath: string;
  status: DiffFile["status"];
  additions: number;
  deletions: number;
}

export function summarizeDiff(diff: string): DiffSummaryFile[] {
  return parseUnifiedDiff(diff).map((file) => ({
    id: file.id,
    displayPath: file.displayPath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  }));
}

export function DiffSummary({
  diff,
  className,
  rowClassName,
  pathClassName,
  statClassName,
  emptyLabel = "No diff",
}: {
  diff: string;
  className?: string;
  rowClassName?: string;
  pathClassName?: string;
  statClassName?: string;
  emptyLabel?: string;
}) {
  const files = React.useMemo(() => summarizeDiff(diff), [diff]);
  if (files.length === 0) return <div className={className} data-diff-summary="empty">{emptyLabel}</div>;
  return (
    <div className={className} data-diff-summary="">
      {files.map((file) => (
        <div key={file.id} className={rowClassName} data-diff-summary-file={file.displayPath} data-diff-status={file.status}>
          <span className={pathClassName}>{file.displayPath}</span>
          <b className={statClassName}>+{file.additions} -{file.deletions}</b>
        </div>
      ))}
    </div>
  );
}
