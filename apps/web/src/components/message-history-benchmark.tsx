import * as React from "react";
import type { Message, MessagePart } from "@berry/shared";
import { BerryThreadView } from "@berry/desktop-ui/components/berry-thread-view";
import { IDLE } from "@berry/desktop-ui/components/thread-stream";

const timestamp = "2026-01-01T00:00:00.000Z";

function longHistoryParts(id: string, index: number): MessagePart[] {
  return Array.from({ length: 8 + index % 7 }, (_, step) => [
    { kind: "text", content: `Reviewing source ${step + 1} for project ${index}. ` + "Checking the workbook, researching project details, and validating the generated files before continuing. ".repeat(3) },
    { kind: "reasoning", content: "Compare the source documents and inspect each generated output." },
    { kind: "tool-call", content: { toolCallId: `${id}-tool-${step}`, name: "read", arguments: { path: `outputs/project-${index}/source-${step}.md` } } },
    { kind: "tool-result", content: { toolCallId: `${id}-tool-${step}`, name: "read", output: "Source inspected", status: "complete", durationMs: 250 } },
  ]).flat().map((part, position) => ({ ...part, id: `${id}-part-${position}`, messageId: id, position, createdAt: timestamp }) as MessagePart);
}

/** Development-only history benchmark kept out of the normal shell chunk. */
export function MessageHistoryBenchmark() {
  const longHistory = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("layout") === "long";
  const [narrow, setNarrow] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const [olderBatchLoaded, setOlderBatchLoaded] = React.useState(false);
  const messages = React.useMemo<Message[]>(() => [...(olderBatchLoaded ? Array.from({ length: 50 }, (_, index) => ({
    id: "benchmark-older-message-" + index,
    sessionId: "benchmark-session",
    role: index % 2 === 0 ? "user" : "assistant",
    status: "complete",
    parts: [{ id: "benchmark-older-part-" + index, messageId: "benchmark-older-message-" + index, kind: "text", content: "Older benchmark row " + index, position: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
    inputTokens: 0,
    outputTokens: 0,
    generationMs: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Message)) : []), ...Array.from({ length: longHistory ? 80 : 10_000 }, (_, index) => {
    const role = index % 2 === 0 ? "user" : "assistant";
    return {
      id: `benchmark-message-${index}`,
      sessionId: "benchmark-session",
      role,
      status: longHistory && role === "assistant" ? "cancelled" : "complete",
      parts: longHistory && role === "assistant" ? longHistoryParts(`benchmark-message-${index}`, index) : [{ id: `benchmark-part-${index}`, messageId: `benchmark-message-${index}`, kind: "text", content: role === "user" ? `Benchmark prompt ${index / 2}` : `Benchmark response ${index / 2}`, position: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
      inputTokens: 0,
      outputTokens: 0,
      generationMs: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as Message;
  })], [olderBatchLoaded, longHistory]);
  const loadOlderMessages = React.useCallback(() => {
    if (olderBatchLoaded) return false;
    setOlderBatchLoaded(true);
    return true;
  }, [olderBatchLoaded]);
  return (
    <main data-testid="message-history-benchmark" data-benchmark-total-rows={messages.length} data-benchmark-older-loaded={olderBatchLoaded ? "true" : "false"} className="flex h-screen w-screen flex-col gap-2 bg-background p-4">
      <div className="flex items-center justify-between">
        {longHistory ? <div className="flex gap-3">
          <button type="button" onClick={() => setNarrow((value) => !value)}>Toggle side panel</button>
          <button type="button" onClick={() => setHidden((value) => !value)}>Toggle task visibility</button>
        </div> : null}
        <h1 className="text-sm font-medium">Message history benchmark</h1>
        <button data-testid="benchmark-update" type="button" onClick={() => setRevision((value) => value + 1)}>Update {revision}</button>
      </div>
      {longHistory ? <div role="status" className="flex min-h-12 shrink-0 items-center bg-muted px-4 text-sm">Viewing as a support member</div> : null}
      <div className="flex min-h-0 flex-1" style={{ display: hidden ? "none" : undefined, maxWidth: narrow ? 640 : undefined }}>
        <BerryThreadView sessionId="benchmark-session" stream={IDLE} messages={messages} autoScroll={false} autoLoadOlderOnScroll={false} hasOlderMessages={!olderBatchLoaded} onLoadOlderMessages={loadOlderMessages} liveContent={<span data-testid="benchmark-revision">{revision}</span>} />
      </div>
    </main>
  );
}
