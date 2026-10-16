import { toast } from "sonner";

/**
 * Copies text and reports what actually happened. Clipboard access can be
 * missing or denied, so success is shown only after the write resolves (H-044).
 */
export function copyText(text: string): void {
  void Promise.resolve()
    .then(() => navigator.clipboard.writeText(text))
    .then(
      () => { toast.success("Copied"); },
      () => { toast.error("Couldn't copy. Allow clipboard access, or select the text and copy it manually."); },
    );
}
