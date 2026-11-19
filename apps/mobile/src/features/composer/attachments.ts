import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { BerryApiClient } from "@berry/api-client";
import type { AttachmentInput } from "@berry/shared";

export type PickedFile = { uri: string; name: string; mediaType: string; size: number | null };

export type PendingAttachment = {
  id: string;
  name: string;
  mediaType: string;
  previewUri: string | null;
  ratio: number;
  state: "uploading" | "ready" | "failed";
  attachment: AttachmentInput | null;
  controller: AbortController;
};

export async function pickPhotos(source: "camera" | "library"): Promise<PickedFile[]> {
  const permission = source === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error(source === "camera" ? "Allow camera access in Settings to take a photo." : "Allow photo access in Settings to attach photos.");
  const result = source === "camera"
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85 })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 10, quality: 0.85 });
  if (result.canceled) return [];
  return result.assets.map((asset, index) => ({
    uri: asset.uri,
    name: asset.fileName ?? `photo-${Date.now()}-${index + 1}.jpg`,
    mediaType: asset.mimeType ?? "image/jpeg",
    size: asset.fileSize ?? null,
  }));
}

export async function pickDocuments(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({ uri: asset.uri, name: asset.name, mediaType: asset.mimeType ?? "application/octet-stream", size: asset.size ?? null }));
}

/**
 * Uploads a picked file through the same multipart flow as the web. The API
 * client only needs name, type, size and slice(), which a native Blob read
 * from the file URI provides.
 */
export async function uploadPickedFile(
  client: BerryApiClient,
  file: PickedFile,
  options: { taskId?: string | undefined; sessionId?: string | undefined; signal: AbortSignal; onProgress: (ratio: number) => void },
): Promise<AttachmentInput> {
  const blob = await (await fetch(file.uri)).blob();
  const fileLike = { name: file.name, type: file.mediaType, size: blob.size, slice: (start?: number, end?: number) => blob.slice(start, end) } as unknown as File;
  const stored = await client.uploadFile(fileLike, {
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    signal: options.signal,
    onProgress: ({ ratio }) => options.onProgress(ratio),
  });
  return {
    id: stored.id,
    fileId: stored.id,
    name: stored.name,
    mediaType: stored.mediaType,
    declaredMediaType: stored.declaredMediaType,
    detectedMediaType: stored.detectedMediaType,
    size: stored.size,
    sourceKind: "object-storage",
    previewUrl: stored.previewUrl,
  };
}
