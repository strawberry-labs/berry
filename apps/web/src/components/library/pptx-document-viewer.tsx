import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer/browser";

export default function PptxDocumentViewer({ file }: { file: StoredFile }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
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

    void fetch(file.previewUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`File request failed (${response.status})`);
        return response.arrayBuffer();
      })
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
        if (!controller.signal.aborted) setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
      viewer.destroy();
      container.replaceChildren();
    };
  }, [file.id, file.previewUrl]);

  if (error) throw error;

  return (
    <div className="berry-pptx-viewer" aria-label={`Preview of ${file.name}`}>
      <div ref={containerRef} className="berry-pptx-canvas" />
      {loading ? <DocumentLoading label="Opening presentation…" /> : null}
    </div>
  );
}

function DocumentLoading({ label }: { label: string }) {
  return <div className="berry-office-loading"><CircularActivitySpinner size={18} className="text-[var(--berry-preview-muted)]" label={label} />{label}</div>;
}
