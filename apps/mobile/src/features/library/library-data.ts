import * as React from "react";
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { StoredFile, StoredFilePage } from "@berry/shared";
import { useSignedInSession } from "../../session/session";
import { uploadPickedFile, type PickedFile } from "../composer/attachments";
import { actionErrorMessage, isAbort } from "../page-kit/errors";
import { LIBRARY_PAGE_SIZE, flattenLibraryPages, removeFileFromPages } from "./library-model";

export const libraryKeys = {
  all: (server: string) => ["library", server] as const,
  files: (server: string, workspaceId: string, search: string) => ["library", server, "files", workspaceId, search] as const,
};

type LibraryData = InfiniteData<StoredFilePage, string | null>;

/** The web Library's paged /v1/files load, filtered by project and file name. */
export function useLibraryFiles(filter: { workspaceId: string; search: string }) {
  const { client, profile } = useSignedInSession();
  const query = useInfiniteQuery({
    queryKey: libraryKeys.files(profile.serverUrl, filter.workspaceId, filter.search),
    queryFn: ({ pageParam, signal }) => client.listFiles({
      limit: LIBRARY_PAGE_SIZE,
      ...(pageParam ? { cursor: pageParam } : {}),
      ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
      ...(filter.search ? { search: filter.search } : {}),
    }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    // Keep the previous results on screen while a new search loads.
    placeholderData: (previous) => previous,
  });
  const items = React.useMemo(() => flattenLibraryPages(query.data?.pages), [query.data]);
  return { ...query, items };
}

export function useRemoveFromLibrary() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: StoredFile) => client.removeFileFromLibrary(file.id),
    onSuccess: (_result, file) => {
      queryClient.setQueriesData<LibraryData>({ queryKey: libraryKeys.all(profile.serverUrl) }, (data) => removeFileFromPages(data, file.id));
    },
  });
}

export type LibraryUpload = {
  id: string;
  name: string;
  progress: number;
  state: "uploading" | "failed";
  error: string | null;
  controller: AbortController;
};

/**
 * Uploads picked photos and documents into the Library through the same
 * multipart flow as the composer. Completed uploads join the Library on the
 * server, so the list just refreshes.
 */
export function useLibraryUploads() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  const [uploads, setUploads] = React.useState<LibraryUpload[]>([]);
  const uploadsRef = React.useRef(uploads);
  uploadsRef.current = uploads;
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the screen stops unfinished uploads rather than orphaning them.
      for (const upload of uploadsRef.current) upload.controller.abort();
    };
  }, []);

  const update = React.useCallback((id: string, change: Partial<LibraryUpload> | null) => {
    if (!mounted.current) return;
    setUploads((current) => change === null ? current.filter((item) => item.id !== id) : current.map((item) => item.id === id ? { ...item, ...change } : item));
  }, []);

  const start = React.useCallback((files: PickedFile[]) => {
    for (const [index, file] of files.entries()) {
      const id = `${Date.now()}-${index}-${file.name}`;
      const controller = new AbortController();
      setUploads((current) => [...current, { id, name: file.name, progress: 0, state: "uploading", error: null, controller }]);
      void uploadPickedFile(client, file, { signal: controller.signal, onProgress: (ratio) => update(id, { progress: ratio }) })
        .then(() => {
          update(id, null);
          void queryClient.invalidateQueries({ queryKey: libraryKeys.all(profile.serverUrl) });
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted || isAbort(cause)) update(id, null);
          else update(id, { state: "failed", error: actionErrorMessage(cause, "Upload failed. Try again.") });
        });
    }
  }, [client, profile.serverUrl, queryClient, update]);

  const cancel = React.useCallback((upload: LibraryUpload) => {
    upload.controller.abort();
    update(upload.id, null);
  }, [update]);

  return { uploads, start, cancel };
}
