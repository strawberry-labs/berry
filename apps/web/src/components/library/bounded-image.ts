import * as React from "react";
import { assertImagePreviewBounds } from "./image-preview-bounds";
import { readResponseBytes } from "./preview-stream";
import { PREVIEW_LIMITS } from "./file-preview-policy";

const MAX_CONCURRENT_IMAGE_FETCHES = 4;
const MAX_RETAINED_IMAGE_BYTES = 64 * 1024 * 1024;
let activeImageFetches = 0;
const queuedImageFetches: Array<{ signal: AbortSignal; resolve: (release: (() => void) | null) => void }> = [];
const retainedImages = new Map<string, { bytes: number; onEvicted: () => void }>();
let retainedImageBytes = 0;

function retainImage(url: string, bytes: number, onEvicted: () => void): () => void {
  const entry = { bytes, onEvicted };
  retainedImages.set(url, entry);
  retainedImageBytes += bytes;
  while (retainedImageBytes > MAX_RETAINED_IMAGE_BYTES) {
    const oldest = retainedImages.entries().next().value as [string, { bytes: number; onEvicted: () => void }] | undefined;
    if (!oldest || oldest[0] === url) break;
    retainedImages.delete(oldest[0]);
    retainedImageBytes -= oldest[1].bytes;
    URL.revokeObjectURL(oldest[0]);
    oldest[1].onEvicted();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (retainedImages.get(url) !== entry) return;
    retainedImages.delete(url);
    retainedImageBytes -= bytes;
  };
}

function pumpImageFetches(): void {
  while (activeImageFetches < MAX_CONCURRENT_IMAGE_FETCHES && queuedImageFetches.length > 0) {
    const next = queuedImageFetches.shift()!;
    if (next.signal.aborted) {
      next.resolve(null);
      continue;
    }
    activeImageFetches += 1;
    let released = false;
    next.resolve(() => {
      if (released) return;
      released = true;
      activeImageFetches -= 1;
      pumpImageFetches();
    });
  }
}

function acquireImageFetch(signal: AbortSignal): Promise<(() => void) | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    queuedImageFetches.push({ signal, resolve });
    pumpImageFetches();
    signal.addEventListener("abort", pumpImageFetches, { once: true });
  });
}

export function useBoundedImageSource({ src, mediaType, enabled = true }: { src?: string | null | undefined; mediaType?: string | null | undefined; enabled?: boolean | undefined }): string | null {
  const [safeSource, setSafeSource] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!enabled || !src || !mediaType) {
      setSafeSource(null);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setSafeSource(null);
    void acquireImageFetch(controller.signal)
      .then(async (release) => {
        if (!release) return null;
        try {
          const response = await fetch(src, { credentials: "include", signal: controller.signal });
          if (!response.ok) throw new Error(`Image request failed (${response.status})`);
          return await readResponseBytes(response, PREVIEW_LIMITS.imageBytes);
        } finally {
          release();
        }
      })
      .then((bytes) => {
        if (!bytes) return;
        if (controller.signal.aborted) return;
        const imageBytes = new Uint8Array(bytes);
        assertImagePreviewBounds(imageBytes, mediaType);
        objectUrl = URL.createObjectURL(new Blob([imageBytes], { type: mediaType }));
        const releaseRetained = retainImage(objectUrl, imageBytes.byteLength, () => {
          setSafeSource(null);
          objectUrl = null;
        });
        controller.signal.addEventListener("abort", releaseRetained, { once: true });
        setSafeSource(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSafeSource(null);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [enabled, mediaType, src]);

  return safeSource;
}
