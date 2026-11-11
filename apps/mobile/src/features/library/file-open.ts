import { Directory, File } from "expo-file-system";
import { userCacheDirectory } from "../../storage/user-files";
import * as Sharing from "expo-sharing";
import type { StoredFile } from "@berry/shared";
import { safeLocalFileName } from "./library-model";

const DOWNLOAD_FOLDER = "berry-library";

export type DownloadProgress = { received: number; total: number | null };

/**
 * Downloads a Library file into the app's cache with the phone's bearer
 * token. Only the most recent download is kept: the folder is cleared first,
 * so private files don't pile up on the device.
 */
export async function downloadLibraryFile(
  file: Pick<StoredFile, "id" | "name" | "size" | "downloadUrl">,
  headers: Record<string, string>,
  options: { signal: AbortSignal; onProgress: (progress: DownloadProgress) => void },
): Promise<File> {
  const root = userCacheDirectory(DOWNLOAD_FOLDER);
  root.delete();
  const folder = new Directory(root, file.id);
  folder.create({ intermediates: true, idempotent: true });
  const destination = new File(folder, safeLocalFileName(file.name));
  options.onProgress({ received: 0, total: file.size > 0 ? file.size : null });
  return File.downloadFileAsync(file.downloadUrl, destination, {
    headers: { ...headers, Accept: "application/octet-stream" },
    idempotent: true,
    signal: options.signal,
    onProgress: ({ bytesWritten, totalBytes }) => options.onProgress({ received: bytesWritten, total: totalBytes > 0 ? totalBytes : file.size > 0 ? file.size : null }),
  });
}

/** Hands a downloaded file to the system share sheet (Save to Files, Quick Look, other apps). */
export async function openWithSystem(local: File, file: Pick<StoredFile, "name" | "mediaType">): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device.");
  await Sharing.shareAsync(local.uri, { mimeType: file.mediaType, dialogTitle: file.name });
}
