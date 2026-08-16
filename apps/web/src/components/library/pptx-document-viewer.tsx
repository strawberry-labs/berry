import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer/browser";
import { filePreviewDecision } from "./file-preview-policy";
import { readResponseBytes } from "./preview-stream";
import { useOfficePreviewBytes } from "./office-preview-gate";

export default function PptxDocumentViewer({ file }: { file: StoredFile }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<Error | null>(null);
  const previewBytes = useOfficePreviewBytes();

  React.useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      setError(new Error("Presentation preview timed out. Download the file to open it safely."));
      setLoading(false);
      controller.abort();
    }, 15_000);
    const container = containerRef.current;
    if (!container) return;

    setLoading(true);
    setError(null);
    container.replaceChildren();

    const viewer = new PptxViewer(container, {
      fitMode: "contain",
      scrollContainer: container,
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazyMedia: true,
      lazySlides: true,
      onRenderComplete: () => setLoading(false),
    });

    const decision = filePreviewDecision(file);
    if (!decision.allowed || decision.kind !== "pptx") {
      setError(new Error(decision.reason ?? "This presentation cannot be previewed safely."));
      setLoading(false);
      return () => { clearTimeout(timeout); controller.abort(); viewer.destroy(); container.replaceChildren(); };
    }
    const bufferPromise = previewBytes
      ? Promise.resolve(previewBytes)
      : fetch(file.previewUrl, { credentials: "include", signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error(`File request failed (${response.status})`);
        return readResponseBytes(response, decision.maxSourceBytes ?? 50 * 1024 * 1024);
      });
    void bufferPromise
      .then((buffer) => viewer.open(buffer, {
        renderMode: "list",
        signal: controller.signal,
        lazyMedia: true,
        lazySlides: true,
        listOptions: {
          windowed: true,
          batchSize: 8,
          initialSlides: 4,
          overscanViewport: 1.5,
          showSlideLabels: true,
        },
      }))
      .then(() => {
        clearTimeout(timeout);
        if (!controller.signal.aborted) setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setLoading(false);
        }
      });

    return () => {
      clearTimeout(timeout);
      controller.abort();
      viewer.destroy();
      container.replaceChildren();
    };
  }, [file.id, file.previewUrl, previewBytes]);

  if (error) throw error;

  return (
    <div className="berry-pptx-viewer" aria-label={`Preview of ${file.name}`}>
      <div ref={containerRef} className="berry-pptx-canvas" />
      {loading ? <DocumentLoading label="Opening presentation…" /> : null}
    </div>
  );
}

function DocumentLoading({ label }: { label: string }) {
  return <div className="berry-office-loading" role="status" aria-live="polite" aria-busy="true"><CircularActivitySpinner size={28} className="text-[var(--berry-preview-muted)]" label={label} /></div>;
}
