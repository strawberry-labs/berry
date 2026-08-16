import * as React from "react";
import type { Message } from "@berry/shared";
import { BerryThreadView } from "@berry/desktop-ui/components/berry-thread-view";
import { IDLE } from "@berry/desktop-ui/components/thread-stream";

/** Development-only history benchmark kept out of the normal shell chunk. */
export function MessageHistoryBenchmark() {
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
  } as Message)) : []), ...Array.from({ length: 10_000 }, (_, index) => {
    const role = index % 2 === 0 ? "user" : "assistant";
    return {
      id: `benchmark-message-${index}`,
      sessionId: "benchmark-session",
      role,
      status: "complete",
      parts: [{ id: `benchmark-part-${index}`, messageId: `benchmark-message-${index}`, kind: "text", content: role === "user" ? `Benchmark prompt ${index / 2}` : `Benchmark response ${index / 2}`, position: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
      inputTokens: 0,
      outputTokens: 0,
      generationMs: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as Message;
  })], [olderBatchLoaded]);
  const loadOlderMessages = React.useCallback(() => {
    if (olderBatchLoaded) return false;
    setOlderBatchLoaded(true);
    return true;
  }, [olderBatchLoaded]);
  return (
    <main data-testid="message-history-benchmark" data-benchmark-total-rows={messages.length} data-benchmark-older-loaded={olderBatchLoaded ? "true" : "false"} className="flex h-screen w-screen flex-col gap-2 bg-background p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-medium">Message history benchmark</h1>
        <button data-testid="benchmark-update" type="button" onClick={() => setRevision((value) => value + 1)}>Update {revision}</button>
      </div>
      <div className="flex min-h-0 flex-1">
        <BerryThreadView sessionId="benchmark-session" stream={IDLE} messages={messages} autoScroll={false} autoLoadOlderOnScroll={false} hasOlderMessages={!olderBatchLoaded} onLoadOlderMessages={loadOlderMessages} liveContent={<span data-testid="benchmark-revision">{revision}</span>} />
      </div>
    </main>
  );
}
