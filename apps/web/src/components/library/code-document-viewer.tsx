import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { MonacoCodeEditor, languageForPath } from "@/components/code-editor";
import { filePreviewDecision } from "./file-preview-policy";
import { readResponseText } from "./preview-stream";

export default function CodeDocumentViewer({ file }: { file: StoredFile }) {
  const [content, setContent] = React.useState<string | null>(null);
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      setError(new Error("Code preview timed out. Download the file to open it safely."));
      controller.abort();
    }, 15_000);
    setContent(null);
    setError(null);

    const decision = filePreviewDecision(file);
    if (!decision.allowed) {
      setError(new Error(decision.reason ?? "This file cannot be previewed safely in the browser."));
      return () => {
        clearTimeout(timeout);
        controller.abort();
      };
    }

    void fetch(file.previewUrl, { credentials: "include", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`File request failed (${response.status})`);
        return readResponseText(response, decision.maxSourceBytes ?? 2 * 1024 * 1024);
      })
      .then((next) => {
        clearTimeout(timeout);
        if (!controller.signal.aborted) setContent(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause : new Error(String(cause)));
      });

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [file.id, file.previewUrl, file.size]);

  if (error) throw error;
  if (content === null) return <div className="berry-code-editor-loading" role="status" aria-live="polite" aria-busy="true"><CircularActivitySpinner size={28} label={`Opening ${file.name}`} /></div>;

  return <MonacoCodeEditor className="berry-file-code-editor" language={languageForPath(file.name)} path={`file://${file.id}/${file.name}`} readOnly value={content} />;
}
