import {
  GeneratedImageContentSchema,
  MessageAttachmentContentSchema,
  MessageDraftSchema,
  type GeneratedImageContent,
  type Message,
  type MessageDraft,
  type MessagePart,
} from "@berry/shared";
import type { ActivityTool } from "./activity.ts";
// Self-reference keeps this importable from bundler and NodeNext consumers alike.
import { settleRunningActivityTools, toolTerminalStatus, type MessageSegment, type StreamState, type ToolEntry } from "@berry/client-core/thread-stream";

/* ------------------------------------------------------------------------ */
/* Settled-turn presentation logic shared by the web/desktop thread view and */
/* the native thread: turn grouping, part partitioning and the small text    */
/* helpers. Platform-neutral so both renderers show the same turns.          */
/* ------------------------------------------------------------------------ */

export interface GeneratedImageView extends GeneratedImageContent {
  id: string;
}

export interface MessageDraftPartResolution {
  draft: MessageDraft;
}

export type TurnGroup = { key: string; user?: Message; assistants: Message[] };

export function isContinuableAssistantTurn(messages: Message[]): boolean {
  const latestAssistant = messages.at(-1);
  return latestAssistant?.status === "failed" || latestAssistant?.status === "cancelled";
}

export function isImageMessagePart(part: MessagePart): boolean {
  if (part.kind !== "image") return false;
  if (typeof part.content === "string") {
    return part.content.startsWith("data:") || part.content.startsWith("https://") || part.content.startsWith("http://") || part.content.startsWith("/");
  }
  return Boolean(part.content && typeof part.content === "object" && !Array.isArray(part.content) && typeof part.content.src === "string");
}

export function generatedImageFromPart(part: MessagePart): GeneratedImageView | null {
  if (part.kind !== "image") return null;
  const parsed = GeneratedImageContentSchema.safeParse(part.content);
  return parsed.success ? { id: part.id, ...parsed.data } : null;
}

export function messageDraftFromToolResult(content: unknown): MessageDraft | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const record = content as Record<string, unknown>;
  if (record.name !== "compose_message" || record.status === "failed" || record.status === "denied" || record.status === "cancelled") return null;
  const output = record.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const outputRecord = output as Record<string, unknown>;
  const parsed = MessageDraftSchema.safeParse(outputRecord.draft ?? outputRecord);
  return parsed.success ? parsed.data : null;
}

export function settledTurnKey(sessionId: string, groupKey: string): string {
  return `${sessionId}:turn-${groupKey}`;
}

/** Resolve a turn identity from an overlap-aware message-id map. */
export function stableTurnGroupKey(
  group: { key: string; user?: Message; assistants: Message[] },
  knownIdentities?: ReadonlyMap<string, string>,
): string {
  const ids = [group.user?.id, ...group.assistants.map((message) => message.id)].filter((id): id is string => Boolean(id));
  const known = ids.map((id) => knownIdentities?.get(id)).find((key): key is string => Boolean(key));
  return known ?? group.key;
}

/**
 * Berry shows ONE "Worked for Xs" per user turn; the agent loop persists
 * several assistant messages per turn, so consecutive ones group under the
 * preceding user message. `identities` keeps each group's key stable while
 * older pages prepend or optimistic ids are replaced.
 */
export function groupSettledTurns(settled: readonly Message[], identities: Map<string, string>): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const message of settled) {
    if (message.role === "user") {
      groups.push({ key: message.id, user: message, assistants: [] });
    } else {
      const last = groups[groups.length - 1];
      if (last) last.assistants.push(message);
      else groups.push({ key: message.id, assistants: [message] });
    }
  }
  const currentMessageIds = new Set<string>();
  for (const group of groups) {
    const ids = [group.user?.id, ...group.assistants.map((message) => message.id)].filter((id): id is string => Boolean(id));
    const key = stableTurnGroupKey(group, identities);
    group.key = key;
    for (const id of ids) {
      currentMessageIds.add(id);
      identities.set(id, key);
    }
  }
  for (const id of identities.keys()) {
    if (!currentMessageIds.has(id)) identities.delete(id);
  }
  return groups;
}

export function shouldReplaceLatestSettledAssistantWithLiveTurn(input: {
  liveVisible: boolean;
  latestTurnHasUser: boolean;
  continuation: boolean;
}): boolean {
  return input.liveVisible && input.latestTurnHasUser && !input.continuation;
}

export function shouldUseLiveMarkdown(stream: Pick<StreamState, "turnActive">): boolean {
  return stream.turnActive;
}

/**
 * Whether the live turn should render below the settled history. The host
 * stores settled assistant messages with database ids, not the transient
 * stream message id, so the latest user turn is the handoff boundary: a
 * stopped turn never renders both persisted and live activity.
 */
export function liveTurnVisible(stream: StreamState, latestTurn: TurnGroup | undefined, hasLiveContent = false): boolean {
  const liveHasContent = stream.turnActive
    || Boolean(stream.approval)
    || Boolean(stream.question)
    || stream.text.length > 0
    || stream.timeline.length > 0
    || stream.reasoning.length > 0
    || Boolean(stream.error)
    || hasLiveContent;
  const liveHasSessionNote = stream.timeline.some((entry) => entry.kind === "note");
  const latestTurnHasSettledAssistant = Boolean(latestTurn?.user && latestTurn.assistants.length > 0);
  return liveHasContent && (
    stream.turnActive
    || Boolean(stream.approval)
    || Boolean(stream.question)
    || hasLiveContent
    || liveHasSessionNote
    || !latestTurnHasSettledAssistant
  );
}

export function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** Full, untruncated user text for editing/copying (parts joined verbatim). */
export function fullUserText(message: Message): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => String(part.content))
    .join("\n");
}

/** Every text part of a settled turn, for copying the answer. */
export function assistantTurnText(messages: readonly Message[]): string {
  return messages
    .flatMap((message) => message.parts)
    .filter((part) => part.kind === "text")
    .map((part) => String(part.content))
    .join("\n");
}

export function messageAttachmentName(part: MessagePart): string | null {
  if (part.kind !== "attachment") return null;
  const attachment = MessageAttachmentContentSchema.safeParse(part.content);
  return attachment.success ? attachment.data.name : null;
}

export function latestTerminalMessageStatus(
  messages: readonly Message[],
): Exclude<Message["status"], "streaming"> | undefined {
  const status = messages.at(-1)?.status;
  return status && status !== "streaming" ? status : undefined;
}

/**
 * Splits a settled agent turn into an ordered stream of reasoning, tool runs,
 * and prose — walking parts in document order like Berry. Consecutive tools
 * merge into one run (ToolFlow then groups them into "Explore"); reasoning
 * renders inline as a "Thought" row. Tool-call/tool-result parts sharing a
 * call id collapse to one entry with the final status/output.
 */
export function partitionAssistantParts(
  parts: MessagePart[],
  writingBlockParts: Map<string, MessageDraftPartResolution> = new Map(),
  visibleArtifactToolCallIds?: ReadonlySet<string>,
  terminalStatus?: Message["status"],
): {
  segments: MessageSegment[];
  totalMs: number;
  hadTools: boolean;
} {
  const toolMap = new Map<string, ActivityTool>();
  const segments: MessageSegment[] = [];

  const upsertTool = (id: string, meta: Record<string, unknown>, fromResult: boolean) => {
    const existing = toolMap.get(id);
    const args =
      meta.arguments && typeof meta.arguments === "object" && !Array.isArray(meta.arguments)
        ? (meta.arguments as Record<string, unknown>)
        : existing?.args ?? null;
    const output =
      typeof meta.output === "string"
        ? meta.output
        : meta.output !== undefined && meta.output !== null
          ? JSON.stringify(meta.output)
          : existing?.output;
    // Persisted sub-agent child tool calls (on the `task` tool) → nested tools.
    const children: ActivityTool[] | undefined = Array.isArray(meta.children)
      ? (meta.children as Array<Record<string, unknown>>).map((child) => ({
          toolCallId: typeof child.toolCallId === "string" ? child.toolCallId : "",
          name: typeof child.name === "string" ? child.name : "tool",
          args:
            child.args && typeof child.args === "object" && !Array.isArray(child.args)
              ? (child.args as Record<string, unknown>)
              : null,
          status: toolStatusFromMeta(child.status),
          ...(typeof child.output === "string" ? { output: child.output } : {}),
          ...(typeof child.durationMs === "number" ? { durationMs: child.durationMs } : {}),
          startedAt: typeof child.startedAt === "number" ? child.startedAt : 0,
        }))
      : existing?.children;
    const tool: ActivityTool = {
      toolCallId: id,
      name: typeof meta.name === "string" ? meta.name : existing?.name ?? "tool",
      title: typeof meta.title === "string" ? meta.title : existing?.title,
      args,
      ...(output !== undefined ? { output } : {}),
      ...(children ? { children } : {}),
      status: fromResult ? toolStatusFromMeta(meta.status) : existing?.status ?? toolStatusFromMeta(meta.status),
      summary: typeof meta.summary === "string" ? meta.summary : existing?.summary,
      durationMs: typeof meta.durationMs === "number" ? meta.durationMs : existing?.durationMs,
      startedAt: existing?.startedAt ?? 0,
    };
    toolMap.set(id, tool);
    if (existing) {
      // Update in place inside whichever segment holds it.
      for (const segment of segments) {
        if (segment.kind !== "tools") continue;
        const at = segment.tools.findIndex((candidate) => candidate.toolCallId === id);
        if (at !== -1) {
          segment.tools[at] = tool;
          return;
        }
      }
      return;
    }
    const last = segments[segments.length - 1];
    if (last && last.kind === "tools") last.tools.push(tool);
    else segments.push({ kind: "tools", tools: [tool] });
  };

  for (const part of parts) {
    if (part.kind === "tool-call" || part.kind === "tool-result") {
      const meta =
        part.content && typeof part.content === "object" && !Array.isArray(part.content)
          ? (part.content as Record<string, unknown>)
          : {};
      const id = typeof meta.toolCallId === "string" ? meta.toolCallId : part.id;
      if (meta.name === "compose_message") {
        if (part.kind === "tool-result") {
          const resolved = writingBlockParts.get(part.id);
          const draft = resolved?.draft ?? messageDraftFromToolResult(part.content);
          if (draft) {
            segments.push({ kind: "writing-block", id: `writing-block-${part.id}`, draft });
          }
        }
        continue;
      }
      // Finalization can discover files left in /workspace/outputs by an
      // earlier turn and project result-only persist_artifact messages for
      // them. When a settled turn has an explicit, completed publication
      // batch, keep both the cards and activity rows scoped to that batch.
      // Otherwise stale result-only rows land after the final answer and make
      // it look like the current turn published every historical output.
      const visibleArtifactActivity = meta.name !== "persist_artifact"
        || !visibleArtifactToolCallIds
        || visibleArtifactToolCallIds.has(id);
      if (visibleArtifactActivity) upsertTool(id, meta, part.kind === "tool-result");
      if (
        part.kind === "tool-result"
        && meta.name === "persist_artifact"
        && (!visibleArtifactToolCallIds || visibleArtifactToolCallIds.has(id))
      ) {
        const result = meta.output && typeof meta.output === "object" && !Array.isArray(meta.output)
          ? (meta.output as Record<string, unknown>)
          : undefined;
        const artifact = result?.artifact && typeof result.artifact === "object" && !Array.isArray(result.artifact)
          ? (result.artifact as Record<string, unknown>)
          : undefined;
        const path = typeof artifact?.path === "string" ? artifact.path : typeof result?.path === "string" ? result.path : undefined;
        const name = typeof artifact?.name === "string" ? artifact.name : undefined;
        if (path && name) {
          segments.push({
            kind: "artifact",
            id: `${part.id}-artifact`,
            name,
            path,
            ...(typeof artifact?.mediaType === "string" ? { mediaType: artifact.mediaType } : {}),
            ...(typeof artifact?.size === "number" ? { size: artifact.size } : {}),
          });
        }
      }
    } else if (part.kind === "reasoning") {
      const text = String(part.content);
      // Always keep reasoning so "Thought" rows expand to the real text.
      if (text.trim().length > 0) segments.push({ kind: "thought", id: part.id, text });
    } else if (part.kind === "text") {
      const text = String(part.content);
      if (text.trim().length > 0) segments.push({ kind: "text", id: part.id, text });
    } else if (part.kind === "error") {
      segments.push({ kind: "error", id: part.id, text: String(part.content) });
    }
  }

  if (terminalStatus && terminalStatus !== "streaming") {
    const status = toolTerminalStatus(terminalStatus);
    for (const segment of segments) {
      if (segment.kind === "tools") segment.tools = settleRunningActivityTools(segment.tools, status);
    }
  }
  const tools = segments.flatMap((segment) => segment.kind === "tools" ? segment.tools : []);
  const totalMs = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  return { segments, totalMs, hadTools: tools.length > 0 };
}

/** Merges tool runs that were split across adjacent assistant messages. */
export function mergeAdjacentToolSegments(segments: MessageSegment[]): MessageSegment[] {
  const merged: MessageSegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (segment.kind === "tools" && last && last.kind === "tools") last.tools.push(...segment.tools);
    else merged.push(segment);
  }
  return merged;
}

/**
 * A durable user turn can contain many model/tool iterations. Each model
 * message that calls persist_artifact declares one publication batch. Only
 * the latest batch with settled results belongs in the visible response;
 * earlier batches remain available in the task files and activity history.
 */
export function latestArtifactToolCallIds(messages: Message[]): ReadonlySet<string> | undefined {
  const completed = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== "tool-result") continue;
      const meta = part.content && typeof part.content === "object" && !Array.isArray(part.content)
        ? part.content as Record<string, unknown>
        : undefined;
      if (meta?.name !== "persist_artifact" || meta.status !== "completed") continue;
      const toolCallId = typeof meta.toolCallId === "string" ? meta.toolCallId : undefined;
      if (toolCallId) completed.add(toolCallId);
    }
  }

  let latest: Set<string> | undefined;
  for (const message of messages) {
    const batch = new Set<string>();
    for (const part of message.parts) {
      if (part.kind !== "tool-call") continue;
      const meta = part.content && typeof part.content === "object" && !Array.isArray(part.content)
        ? part.content as Record<string, unknown>
        : undefined;
      if (meta?.name !== "persist_artifact") continue;
      const toolCallId = typeof meta.toolCallId === "string" ? meta.toolCallId : part.id;
      if (completed.has(toolCallId)) batch.add(toolCallId);
    }
    if (batch.size > 0) latest = batch;
  }
  return latest;
}

/**
 * Every completed compose_message result remains attached to its own timeline
 * part. The stable draft id still identifies the logical artifact for model
 * follow-ups, while the part id preserves each revision as a separate card.
 */
export function collectMessageDraftParts(messages: Message[]): Map<string, MessageDraftPartResolution> {
  const resolved = new Map<string, MessageDraftPartResolution>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind !== "tool-result") continue;
      const draft = messageDraftFromToolResult(part.content);
      if (!draft) continue;
      resolved.set(part.id, { draft });
    }
  }
  return resolved;
}

/** The compact one-line summary of a turn's activity ("read 3 files, wrote a.ts"). */
export function summarizeActivity(segments: MessageSegment[]): string | undefined {
  const tools = segments.flatMap((segment) => segment.kind === "tools" ? segment.tools : []);
  const reads = tools.filter((tool) => tool.name === "read").length;
  const writes = tools.flatMap((tool) => {
    if (!/^(?:write|edit)$/.test(tool.name)) return [];
    const args = tool.args ?? {};
    const path = [args.path, args.file_path, args.filePath, args.file].find((value) => typeof value === "string");
    return typeof path === "string" ? [path.replace(/^.*[\\/]/, "")] : [];
  });
  const details: string[] = [];
  if (reads > 0) details.push(`read ${reads} ${reads === 1 ? "file" : "files"}`);
  if (writes.length > 0) details.push(`wrote ${writes.slice(0, 2).join(", ")}`);
  const remaining = tools.length - reads - writes.length;
  if (details.length === 0 && remaining > 0) details.push(`ran ${remaining} ${remaining === 1 ? "tool" : "tools"}`);
  return details.length > 0 ? details.join(", ") : undefined;
}

/**
 * DeepSeek Harness accounting: sum paired output tokens / sum decoding time.
 * Keep request, TTFT, tool and wall time separate. Older/unmeasured calls do
 * not contribute either tokens or time to decoding throughput.
 */
export function settledTurnTiming(messages: readonly Message[], toolTotalMs: number, rememberedElapsedMs?: number): {
  elapsedMs: number | undefined;
  tokensPerSecond: number | undefined;
  tokenRateIsEstimated: boolean;
  reportedOutputTokens: number;
  modelMs: number;
  firstTokenMs: number;
  decodeMs: number;
  decodeTokens: number;
  toolMs: number;
} {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const wallMs = first && last ? Date.parse(last.updatedAt) - Date.parse(first.createdAt) : Number.NaN;
  let modelMs = 0;
  let firstTokenMs = 0;
  let decodeMs = 0;
  let decodeTokens = 0;
  let reportedOutputTokens = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    reportedOutputTokens += Math.max(0, message.outputTokens || 0);
    const timing = message.modelTiming;
    modelMs += Math.max(0, timing?.requestMs ?? message.generationMs ?? 0);
    firstTokenMs += timing?.firstTokenMs ?? 0;
    if (timing && timing.decodeMs !== undefined && timing.decodeMs > 0
      && timing.decodeTokens !== undefined && timing.decodeTokens > 0
      && timing.firstTokenMs !== undefined && timing.firstTokenMs >= 0
      && timing.decodeMs <= timing.requestMs - timing.firstTokenMs + 1
      && Number.isFinite(timing.decodeMs) && Number.isFinite(timing.decodeTokens)) {
      decodeMs += timing.decodeMs;
      decodeTokens += timing.decodeTokens;
    }
  }
  const elapsedCandidates = [wallMs, rememberedElapsedMs, modelMs, toolTotalMs]
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
  const elapsedMs = elapsedCandidates.length > 0 ? Math.max(...elapsedCandidates) : undefined;
  const tokensPerSecond = decodeMs > 0 && decodeTokens > 0 ? decodeTokens / (decodeMs / 1000) : undefined;
  return { elapsedMs, tokensPerSecond, tokenRateIsEstimated: false, reportedOutputTokens,
    modelMs, firstTokenMs, decodeMs, decodeTokens, toolMs: Math.max(0, toolTotalMs) };
}

function toolStatusFromMeta(value: unknown): ToolEntry["status"] {
  if (value === "running" || value === "failed" || value === "denied" || value === "completed" || value === "cancelled") return value;
  return "completed";
}
