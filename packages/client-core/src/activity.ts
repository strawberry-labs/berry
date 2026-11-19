export type ToolStatus = "running" | "completed" | "failed" | "denied" | "cancelled";

export interface ActivityTool {
  toolCallId: string;
  name: string;
  title?: string | undefined;
  status: ToolStatus;
  /** Truncated output preview from tool.end / tool.update. */
  summary?: string | undefined;
  /** Full output text when persisted (settled messages). */
  output?: string | undefined;
  /** Tool input arguments (command, path, pattern, …). */
  args?: Record<string, unknown> | null | undefined;
  durationMs?: number | undefined;
  startedAt: number;
  /** Live child tool calls when this is a `task` (sub-agent) dispatch. */
  children?: ActivityTool[] | undefined;
}
