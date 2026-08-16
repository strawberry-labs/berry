/** Read a fetch body without ever accumulating more than the preview budget. */
export async function readResponseBytes(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.body) {
    throw new Error("The preview response has no bounded streaming body.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("preview source byte limit");
        throw new Error("The preview response is larger than the safe byte budget.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readResponseBytes(response, maxBytes));
}
