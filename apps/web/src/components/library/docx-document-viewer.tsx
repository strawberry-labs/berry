import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { renderAsync } from "docx-preview";

export default function DocxDocumentViewer({ file }: { file: StoredFile }) {
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

    void fetch(file.previewUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`File request failed (${response.status})`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        if (controller.signal.aborted) return;
        return renderAsync(buffer, container, container, {
          inWrapper: true,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: false,
          renderChanges: false,
          useBase64URL: true,
        });
      })
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
      container.replaceChildren();
    };
  }, [file.id, file.previewUrl]);

  if (error) throw error;

  return (
    <div className="berry-docx-viewer" aria-label={`Preview of ${file.name}`}>
      <div ref={containerRef} className="berry-docx-canvas" />
      {loading ? <DocumentLoading label="Opening document…" /> : null}
    </div>
  );
}

function DocumentLoading({ label }: { label: string }) {
  return <div className="berry-office-loading" role="status"><span className="berry-document-spinner" />{label}</div>;
}
