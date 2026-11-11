import * as React from "react";
import { Alert } from "react-native";
import type { StoredFile } from "@berry/shared";
import { isAbort } from "../page-kit/errors";
import { useAuthHeaders } from "../page-kit/auth-headers";
import { downloadLibraryFile, openWithSystem } from "./file-open";
import { downloadErrorMessage } from "./library-model";

export type FileOpenState = {
  file: StoredFile;
  phase: "downloading" | "error";
  received: number;
  total: number | null;
  message: string | null;
};

/**
 * The phone's FileDownloadProvider: downloads one file at a time with the
 * bearer token, reports progress, and hands the result to the share sheet.
 */
export function useFileOpener() {
  const headers = useAuthHeaders();
  const [state, setState] = React.useState<FileOpenState | null>(null);
  const active = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => { active.current?.abort(); active.current = null; }, []);

  const start = React.useCallback(async (file: StoredFile) => {
    if (!headers) {
      Alert.alert("Couldn't open this file", "Your sign-in details aren't ready yet. Try again in a moment.");
      return;
    }
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const current = () => active.current === controller;
    setState({ file, phase: "downloading", received: 0, total: file.size > 0 ? file.size : null, message: null });
    try {
      const local = await downloadLibraryFile(file, headers, {
        signal: controller.signal,
        onProgress: ({ received, total }) => {
          if (current()) setState((prior) => prior && prior.file.id === file.id ? { ...prior, received, total } : prior);
        },
      });
      if (!current() || controller.signal.aborted) return;
      active.current = null;
      setState(null);
      await openWithSystem(local, file).catch((cause: unknown) => {
        Alert.alert("Couldn't open this file", cause instanceof Error ? cause.message : "Try again.");
      });
    } catch (cause) {
      if (controller.signal.aborted || isAbort(cause) || !current()) return;
      active.current = null;
      setState((prior) => prior && prior.file.id === file.id ? { ...prior, phase: "error", message: downloadErrorMessage(cause) } : prior);
    }
  }, [headers]);

  const cancel = React.useCallback(() => {
    active.current?.abort();
    active.current = null;
    setState(null);
  }, []);

  return { state, start, cancel, busy: state?.phase === "downloading" };
}
