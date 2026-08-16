import { validateArchivePreview, type ArchiveEntry, type ArchivePreviewLimits } from "./archive-preview";

export type ZipPreviewEntry = ArchiveEntry & { compressionMethod: number; localOffset: number };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export async function validateZipPayload(bytes: Uint8Array, limits: ArchivePreviewLimits, knownEntries?: ZipPreviewEntry[]): Promise<{ entries: number; expandedBytes: number }> {
  const entries = knownEntries ?? readZipEntries(bytes, limits.entryCount);
  const metadata = validateArchivePreview(bytes.byteLength, entries, limits);
  if (!metadata.ok) throw new Error(metadata.reason);
  let expandedBytes = 0;
  for (const entry of entries) {
    // A trailing slash is only a ZIP naming convention. Do not trust it as a
    // directory marker: a malicious archive can attach compressed payload to
    // a slash-suffixed name and otherwise bypass actual expansion checks.
    const actual = await inflateEntry(bytes, entry, limits.entryBytes);
    expandedBytes += actual;
    if (expandedBytes > limits.expandedBytes) throw new Error("The expanded archive is too large to preview safely.");
    if (entry.compressedBytes === 0 ? actual > 0 : actual / entry.compressedBytes > limits.expansionRatio) {
      throw new Error("The archive expands beyond the safe compression ratio.");
    }
  }
  return { entries: metadata.entries, expandedBytes };
}

export function readZipEntries(bytes: Uint8Array, maxEntryCount = 5_000): ZipPreviewEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= start; offset -= 1) {
    if (offset >= 0 && view.getUint32(offset, true) === EOCD_SIGNATURE) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("The workbook archive is invalid or uses unsupported ZIP64 metadata.");
  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDiskNumber = view.getUint16(eocd + 6, true);
  const countOnDisk = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (diskNumber !== 0 || centralDiskNumber !== 0 || countOnDisk !== count) throw new Error("Multi-disk workbooks are not supported for browser preview.");
  if (eocd + 22 + commentLength !== bytes.byteLength) throw new Error("The workbook archive directory is invalid.");
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 workbooks are not supported for browser preview.");
  if (count > maxEntryCount) throw new Error("The archive contains too many entries to preview safely.");
  if (centralOffset + centralSize !== eocd) throw new Error("The workbook archive directory is invalid.");
  const centralEnd = centralOffset + centralSize;

  const entries: ZipPreviewEntry[] = [];
  const seenNames = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > centralEnd || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw new Error("The workbook archive directory is invalid.");
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const expandedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (compressedBytes === 0xffffffff || expandedBytes === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64 workbook entries are not supported for browser preview.");
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new Error("The workbook contains an invalid local entry.");
    const localFlags = view.getUint16(localOffset + 6, true);
    const localCompressionMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localName = new TextDecoder().decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name || localCompressionMethod !== compressionMethod || (localFlags & 0x41) !== (flags & 0x41)) throw new Error("The workbook central and local ZIP headers disagree.");
    if (localOffset + 30 + localNameLength + localExtraLength + compressedBytes > bytes.byteLength) throw new Error("The workbook contains an out-of-bounds entry.");
    if (seenNames.has(name)) throw new Error("The archive contains duplicate entry names and cannot be previewed safely.");
    seenNames.add(name);
    entries.push({ name, compressedBytes, expandedBytes, encrypted: (flags & 0x41) !== 0, compressionMethod, localOffset });
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > centralEnd) throw new Error("The workbook archive directory is invalid.");
    offset = nextOffset;
  }
  // Downstream OOXML parsers scan consecutive central-directory records and
  // do not consistently trust the EOCD count. Require the declared count to
  // cover the complete directory so hidden entries cannot bypass our budgets.
  if (offset !== centralEnd) throw new Error("The workbook archive directory is invalid.");
  return entries;
}

export async function readZipEntry(bytes: Uint8Array, entry: ZipPreviewEntry, maxBytes: number): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.localOffset + 30 > bytes.byteLength || view.getUint32(entry.localOffset, true) !== LOCAL_SIGNATURE) throw new Error("The workbook contains an invalid local entry.");
  const localNameLength = view.getUint16(entry.localOffset + 26, true);
  const localExtraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + localNameLength + localExtraLength;
  const compressed = bytes.subarray(start, start + entry.compressedBytes);
  if (entry.compressionMethod === 0) return compressed.byteLength <= maxBytes ? compressed : fail("A workbook entry is too large to preview safely.");
  if (entry.compressionMethod !== 8 || typeof DecompressionStream === "undefined") throw new Error("The workbook uses unsupported compression.");
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  const reader = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("workbook entry limit");
      throw new Error("A workbook entry is too large to preview safely.");
    }
    chunks.push(next.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function inflateEntry(bytes: Uint8Array, entry: ZipPreviewEntry, maxBytes: number): Promise<number> {
  return (await readZipEntry(bytes, entry, maxBytes)).byteLength;
}

function fail(message: string): never {
  throw new Error(message);
}
