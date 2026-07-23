import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { MonacoCodeEditor, languageForPath } from "@/components/code-editor";

const MAX_CODE_PREVIEW_BYTES = 2 * 1024 * 1024;

export default function CodeDocumentViewer({ file }: { file: StoredFile }) {
  const [content, setContent] = React.useState<string | null>(null);
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    setError(null);

    if (file.size > MAX_CODE_PREVIEW_BYTES) {
      setError(new Error("This code file is too large to preview in the browser."));
      return () => controller.abort();
    }

    void fetch(file.previewUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`File request failed (${response.status})`);
        return response.text();
      })
      .then((next) => {
        if (!controller.signal.aborted) setContent(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause : new Error(String(cause)));
      });

    return () => controller.abort();
  }, [file.id, file.previewUrl, file.size]);

  if (error) throw error;
  if (content === null) return <div className="berry-code-editor-loading">Opening {file.name}…</div>;

  return <MonacoCodeEditor className="berry-file-code-editor" language={languageForPath(file.name)} path={`file://${file.id}/${file.name}`} readOnly value={content} />;
}
