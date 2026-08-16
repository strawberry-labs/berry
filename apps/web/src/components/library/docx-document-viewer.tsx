import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { renderAsync } from "docx-preview";
import { filePreviewDecision } from "./file-preview-policy";
import { readResponseBytes } from "./preview-stream";
import { useOfficePreviewBytes } from "./office-preview-gate";

export default function DocxDocumentViewer({ file }: { file: StoredFile }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<Error | null>(null);
  const previewBytes = useOfficePreviewBytes();

  React.useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      setError(new Error("Document preview timed out. Download the file to open it safely."));
      controller.abort();
    }, 15_000);
    const container = containerRef.current;
    if (!container) return;

    setLoading(true);
    setError(null);
    container.replaceChildren();

    const decision = filePreviewDecision(file);
    if (!decision.allowed || decision.kind !== "docx") {
      setError(new Error(decision.reason ?? "This document cannot be previewed safely."));
      setLoading(false);
      return () => { clearTimeout(timeout); controller.abort(); };
    }
    const bufferPromise = previewBytes
      ? Promise.resolve(previewBytes)
      : fetch(file.previewUrl, { credentials: "include", signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error(`File request failed (${response.status})`);
        return readResponseBytes(response, decision.maxSourceBytes ?? 1 * 1024 * 1024);
      });
    void bufferPromise
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
          renderAltChunks: false,
          useBase64URL: true,
        });
      })
      .then(() => {
        if (!controller.signal.aborted) sanitizeRenderedLinks(container);
      })
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
      container.replaceChildren();
    };
  }, [file.id, file.previewUrl, previewBytes]);

  if (error) throw error;

  return (
    <div className="berry-docx-viewer" aria-label={`Preview of ${file.name}`}>
      <div ref={containerRef} className="berry-docx-canvas" />
      {loading ? <DocumentLoading label="Opening document…" /> : null}
    </div>
  );
}

function sanitizeRenderedLinks(container: HTMLElement): void {
  for (const anchor of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const raw = anchor.getAttribute("href")?.trim() ?? "";
    let safe = false;
    try {
      const protocol = new URL(raw, window.location.href).protocol;
      safe = protocol === "http:" || protocol === "https:" || protocol === "mailto:";
    } catch {
      safe = false;
    }
    if (!safe) {
      anchor.removeAttribute("href");
      anchor.setAttribute("aria-disabled", "true");
      anchor.removeAttribute("target");
    } else {
      anchor.setAttribute("rel", "noreferrer noopener");
    }
  }
}

function DocumentLoading({ label }: { label: string }) {
  return <div className="berry-office-loading" role="status" aria-live="polite" aria-busy="true"><CircularActivitySpinner size={28} className="text-[var(--berry-preview-muted)]" label={label} /></div>;
}
