import { validateArchivePreview } from "./archive-preview";
import type { OfficePreviewWorkerRequest, OfficePreviewWorkerResponse } from "./office-preview-types";
import { readResponseBytes } from "./preview-stream";
import { readZipEntries, readZipEntry, validateZipPayload, type ZipPreviewEntry } from "./zip-preview";
import { countDocxPages, countPptxSlideIds, hasExternalMediaRelationship, hasRequiredOfficeEntries, hasUnsafeDocxMarkup, hasUnboundedEmbeddedMediaRelationship } from "./office-preview-bounds";
import { assertImagePreviewBounds } from "./image-preview-bounds";

self.onmessage = (event: MessageEvent<OfficePreviewWorkerRequest>) => {
  if (event.data.type !== "inspect") return;
  void inspect(event.data);
};

async function inspect(request: OfficePreviewWorkerRequest) {
  try {
    if (request.sourceBytes > request.maxSourceBytes) throw new Error("The file is too large to preview safely.");
    const response = await fetch(request.url, { credentials: "include" });
    if (!response.ok) throw new Error(`File request failed (${response.status})`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > request.maxSourceBytes) throw new Error("The file is too large to preview safely.");
    const bytes = new Uint8Array(await readResponseBytes(response, request.maxSourceBytes));

    const entries = readZipEntries(bytes, request.maxEntryCount);
    const limits = {
      sourceBytes: request.maxSourceBytes,
      expandedBytes: request.maxExpandedBytes,
      entryCount: request.maxEntryCount,
      entryBytes: request.maxEntryBytes,
      expansionRatio: 100,
    };
    const metadata = validateArchivePreview(bytes.byteLength, entries, limits);
    if (!metadata.ok) throw new Error(metadata.reason);
    const names = new Set(entries.map((entry) => entry.name));
    const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
    if (!hasRequiredOfficeEntries(request.kind, names)) throw new Error(`The archive is not a valid ${request.kind} document.`);
    const slides = request.kind === "pptx" ? await readPptxSlideCount(bytes, entries, request.maxEntryBytes, request.maxSlides) : null;
    if (slides != null && slides > request.maxSlides) throw new Error("This presentation contains too many slides to preview safely.");
    const validation = await validateZipPayload(bytes, limits, entries);

    if (request.kind === "docx" || request.kind === "pptx") {
      for (const mediaEntry of entries.filter((entry) => isImageEntry(entry.name))) {
        const mediaType = embeddedImageMediaType(mediaEntry.name);
        if (!mediaType) throw new Error("This document contains embedded media that cannot be bounded safely.");
        const mediaBytes = await readEntry(bytes, mediaEntry, request.maxEntryBytes);
        if (!mediaBytes) throw new Error("This document contains embedded media that cannot be bounded safely.");
        assertImagePreviewBounds(mediaBytes, mediaType);
      }
    }

    if (request.kind === "docx") {
      // docx-preview also renders header/footer XML. Scan every XML part that
      // can reach that renderer, not just word/document.xml, before exposing
      // the transferred bytes to the main thread.
      for (const xmlEntry of entries.filter((entry) => entry.name.toLowerCase().endsWith(".xml") && !entry.name.toLowerCase().endsWith(".rels"))) {
        const xml = await readEntry(bytes, xmlEntry, request.maxEntryBytes);
        if (xml && hasUnsafeDocxMarkup(new TextDecoder().decode(xml))) {
          throw new Error("This document contains legacy active markup and is download-only.");
        }
      }
      for (const relationship of entries.filter((entry) => entry.name.toLowerCase().endsWith(".rels"))) {
        const xml = await readEntry(bytes, relationship, request.maxEntryBytes);
        const sourceName = relationshipSourceName(relationship.name);
        const sourceXml = sourceName ? await readEntry(bytes, entryByName.get(sourceName), request.maxEntryBytes) : null;
        const relationshipText = xml ? new TextDecoder().decode(xml) : "";
        const sourceText = sourceXml ? new TextDecoder().decode(sourceXml) : "";
        if (xml && (hasExternalMediaRelationship(relationshipText, sourceText) || hasUnboundedEmbeddedMediaRelationship(relationshipText, sourceText))) {
          throw new Error("External media is disabled for safe document preview.");
        }
      }
    }

    if (request.kind === "pptx") {
      for (const relationship of entries.filter((entry) => entry.name.toLowerCase().endsWith(".rels"))) {
        const xml = await readEntry(bytes, relationship, request.maxEntryBytes);
        const sourceName = relationshipSourceName(relationship.name);
        const sourceXml = sourceName ? await readEntry(bytes, entryByName.get(sourceName), request.maxEntryBytes) : null;
        const relationshipText = xml ? new TextDecoder().decode(xml) : "";
        const sourceText = sourceXml ? new TextDecoder().decode(sourceXml) : "";
        if (xml && (hasExternalMediaRelationship(relationshipText, sourceText) || hasUnboundedEmbeddedMediaRelationship(relationshipText, sourceText))) {
          throw new Error("External media is disabled for safe presentation preview.");
        }
      }
    }

    let pages: number | null = null;
    if (request.kind === "docx") {
      const documentEntry = entryByName.get("word/document.xml");
      pages = documentEntry ? await readDocxPageCount(bytes, documentEntry, request.maxEntryBytes, request.maxPages) : null;
      if (documentEntry && pages === null) throw new Error("The document page count could not be bounded safely.");
      if (pages != null && pages > request.maxPages) throw new Error("This document contains too many pages to preview safely.");
    }

    post({ type: "ready", entries: validation.entries, expandedBytes: validation.expandedBytes, slides, pages, bytes: bytes.buffer as ArrayBuffer }, [bytes.buffer as ArrayBuffer]);
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

function relationshipSourceName(name: string): string | null {
  const marker = "/_rels/";
  const markerIndex = name.toLowerCase().indexOf(marker);
  if (markerIndex < 0 || !name.toLowerCase().endsWith(".rels")) return null;
  return `${name.slice(0, markerIndex)}/${name.slice(markerIndex + marker.length, -5)}`;
}

function embeddedImageMediaType(name: string): string | null {
  const extension = name.toLowerCase().split(".").at(-1) ?? "";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  if (extension === "avif") return "image/avif";
  if (extension === "ico") return "image/x-icon";
  return null;
}

function isImageEntry(name: string): boolean {
  return /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp|emf|wmf)$/i.test(name);
}

async function readPptxSlideCount(bytes: Uint8Array, entries: ZipPreviewEntry[], maxOutputBytes: number, maxSlides: number): Promise<number> {
  const presentation = entries.find((entry) => entry.name === "ppt/presentation.xml");
  if (!presentation) throw new Error("The presentation slide list could not be bounded safely.");
  const xml = await readEntry(bytes, presentation, maxOutputBytes);
  if (!xml) throw new Error("The presentation slide list could not be bounded safely.");
  return countPptxSlideIds(new TextDecoder().decode(xml), maxSlides);
}

async function readDocxPageCount(bytes: Uint8Array, entry: ZipPreviewEntry, maxOutputBytes: number, maxPages: number): Promise<number | null> {
  const xml = await readEntry(bytes, entry, maxOutputBytes);
  if (!xml) return null;
  const text = new TextDecoder().decode(xml);
  if (hasUnsafeDocxMarkup(text)) throw new Error("This document contains legacy active markup and is download-only.");
  return countDocxPages(text, maxPages);
}

async function readEntry(bytes: Uint8Array, entry: ZipPreviewEntry | undefined, maxOutputBytes: number): Promise<Uint8Array | null> {
  if (!entry) return null;
  try {
    return await readZipEntry(bytes, entry, maxOutputBytes);
  } catch {
    return null;
  }
}

function post(message: OfficePreviewWorkerResponse, transfer?: Transferable[]) {
  (self as unknown as { postMessage: (value: OfficePreviewWorkerResponse, transfer?: Transferable[]) => void }).postMessage(message, transfer ?? []);
}
