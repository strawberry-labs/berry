import { createHash } from "node:crypto";
import { createPublicRemoteFetch, validatedPublicRemoteUrl } from "@berry/local-agent";
import type { ChatToolDefinition } from "@berry/router-client";
import { networkDomainAllowed } from "@berry/shared";
import { z } from "zod";
import { ToolArgumentError, notRunMessage } from "./tool-arguments.js";

/** upload_file holds the file in memory once, so it is bounded. */
export const FILE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const FILE_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const RESPONSE_EXCERPT_BYTES = 16 * 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
// The HTTP client derives these from the URL and the bytes. A supplied
// Content-Length or Host is checked against them instead of being sent.
const CONNECTION_HEADERS = new Set([
  "connection", "content-length", "expect", "host", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

const InputSchema = z.object({
  path: z.string().trim().min(1, "path is required").max(4_096),
  url: z.string().trim().min(1, "url is required").max(16_384),
  method: z.literal("PUT", { errorMap: () => ({ message: "method must be PUT; upload_file sends signed PUT uploads" }) }).optional(),
  headers: z.record(z.union([z.string().max(8_192), z.number().finite()]).transform(String)).optional(),
}).strict();

export type FileUploadInput = {
  path: string;
  url: URL;
  /** Lower-case names, each once. */
  headers: ReadonlyArray<readonly [string, string]>;
};

export type FileUploadPolicy = { egress: "on" | "off" | "unrestricted"; allowedDomains: readonly string[] };

export const fileUploadDefinition: ChatToolDefinition = {
  type: "function",
  function: {
    name: "upload_file",
    description: "Send one workspace file's exact bytes with an HTTP PUT to an upload URL, such as a presigned URL a connector returned for S3, Google Cloud Storage or Azure Blob Storage. Pass the URL and its headers exactly as the connector returned them; Berry sets Content-Length and checks any checksum header against the file before sending. Redirects are not followed. The result gives the HTTP status, size, SHA-256 and storage receipt; the URL's query string is never repeated in results.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "url"],
      properties: {
        path: { type: "string", description: "Workspace path of the file to send, for example a connector file's sandbox path." },
        url: { type: "string", description: "HTTPS upload URL, exactly as returned, including its query string." },
        headers: { type: "object", description: "Header names and values to send exactly as returned with the URL, for example {\"Content-Type\": \"application/pdf\"}." },
        method: { type: "string", enum: ["PUT"], description: "Always PUT." },
      },
    },
  },
};

/** Validates upload_file arguments before any sandbox or network work. */
export function fileUploadInput(value: unknown): FileUploadInput {
  const parsed = InputSchema.safeParse(value);
  if (!parsed.success) {
    throw new ToolArgumentError(notRunMessage("upload_file", parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
      .join("; ")));
  }
  let url: URL;
  try {
    url = validatedPublicRemoteUrl(parsed.data.url);
  } catch (error) {
    throw new ToolArgumentError(notRunMessage("upload_file", `url ${(error as Error).message}`));
  }
  url.hash = "";
  const entries = Object.entries(parsed.data.headers ?? {});
  if (entries.length > 64) throw new ToolArgumentError(notRunMessage("upload_file", "headers may contain at most 64 entries"));
  const headers = new Map<string, string>();
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim();
    if (!HEADER_NAME.test(name)) throw new ToolArgumentError(notRunMessage("upload_file", `header name ${JSON.stringify(rawName.slice(0, 80))} is not a valid HTTP header name`));
    if (/[\r\n\0]/.test(rawValue)) throw new ToolArgumentError(notRunMessage("upload_file", `header ${name} must not contain line breaks`));
    const key = name.toLowerCase();
    const headerValue = rawValue.trim();
    const previous = headers.get(key);
    if (previous !== undefined && previous !== headerValue) throw new ToolArgumentError(notRunMessage("upload_file", `header ${name} is given twice with different values`));
    headers.set(key, headerValue);
  }
  const host = headers.get("host");
  if (host !== undefined && host.toLowerCase() !== url.host.toLowerCase()) {
    throw new ToolArgumentError(notRunMessage("upload_file", `the Host header ${host} does not match the URL's host ${url.host}`));
  }
  return { path: parsed.data.path, url, headers: [...headers] };
}

/** The destination as people may see it: origin and path, never the signed query. */
export function uploadDestination(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/** Applies the task's network policy, the same one its sandbox uses. */
export function uploadNetworkProblem(url: URL, policy: FileUploadPolicy): string | null {
  if (policy.egress === "off") {
    return `This task's network policy blocks outbound network access, so the file was not sent to ${url.hostname}. An organization admin can allow the hostname in Execution & network. Nothing was sent.`;
  }
  if (policy.egress === "on" && !networkDomainAllowed(url.hostname, [...policy.allowedDomains])) {
    return `Network access to ${url.hostname} is blocked by this task's network policy. An organization admin must allow the hostname in Execution & network, then retry in a new turn. Nothing was sent.`;
  }
  return null;
}

/**
 * Sends the bytes once with PUT. Every check that can fail without the
 * network runs first, so a refusal before sending says that nothing was sent.
 */
export async function uploadFileBytes(input: {
  upload: FileUploadInput;
  bytes: Uint8Array<ArrayBuffer>;
  policy: FileUploadPolicy;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<{ output: Record<string, string | number | boolean>; summary: string }> {
  const { upload, bytes } = input;
  const name = upload.path.slice(upload.path.lastIndexOf("/") + 1) || upload.path;
  const destination = uploadDestination(upload.url);
  const networkProblem = uploadNetworkProblem(upload.url, input.policy);
  if (networkProblem) throw new Error(networkProblem);
  const sha256Hex = createHash("sha256").update(bytes).digest("hex");
  const sha256Base64 = Buffer.from(sha256Hex, "hex").toString("base64");
  const md5Base64 = createHash("md5").update(bytes).digest("base64");
  const supplied = new Map(upload.headers);
  const mismatch = checksumMismatch(supplied, { size: bytes.byteLength, sha256Hex, sha256Base64, md5Base64 });
  if (mismatch) {
    throw new Error(`${mismatch}, so ${upload.path} is not the file this upload URL was prepared for. Check the path, or request a new upload URL for this file. Nothing was sent.`);
  }
  const headers = upload.headers
    .filter(([headerName]) => !CONNECTION_HEADERS.has(headerName))
    .map(([headerName, headerValue]): [string, string] => [headerName, headerValue]);
  const send = input.fetch ?? createPublicRemoteFetch({ redirect: "manual", timeoutMs: FILE_UPLOAD_TIMEOUT_MS });
  const response = await send(upload.url.toString(), {
    method: "PUT",
    headers,
    body: bytes,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const excerpt = await responseExcerpt(response);
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${destination} answered the upload of ${name} with a redirect (HTTP ${response.status}). Berry does not follow redirects for uploads, so the file may not be stored. Request a new upload URL that accepts the file directly.`);
  }
  if (!response.ok) {
    const reason = storageErrorReason(excerpt);
    throw new Error(`Upload of ${name} to ${destination} failed with HTTP ${response.status}${reason ? ` (${reason})` : ""}. ${statusHint(response.status)}`);
  }
  const etag = response.headers.get("etag");
  const versionId = response.headers.get("x-amz-version-id");
  const serverChecksum = response.headers.get("x-amz-checksum-sha256");
  const checksumConfirmed = serverChecksum === sha256Base64;
  if (serverChecksum && !checksumConfirmed) {
    throw new Error(`${destination} stored ${name} but reported SHA-256 ${serverChecksum}, while the file sent has ${sha256Base64}. Treat the upload as failed and request a new upload URL.`);
  }
  const contentType = supplied.get("content-type");
  const content = [
    `Uploaded ${name} (${bytes.byteLength} bytes) to ${destination} with PUT: HTTP ${response.status}.`,
    `SHA-256 (base64): ${sha256Base64}. SHA-256 (hex): ${sha256Hex}.`,
    ...(contentType ? [`Content-Type sent: ${contentType}.`] : []),
    ...(etag ? [`ETag: ${etag}.`] : []),
    ...(versionId ? [`Version ID: ${versionId}.`] : []),
    checksumConfirmed ? "The storage service confirmed the SHA-256 checksum." : "",
  ].filter(Boolean).join(" ");
  return {
    output: {
      content,
      path: upload.path,
      destination,
      method: "PUT",
      status: response.status,
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex,
      sha256Base64,
      ...(contentType ? { contentType } : {}),
      ...(etag ? { etag } : {}),
      ...(versionId ? { versionId } : {}),
      checksumConfirmed,
    },
    summary: `Uploaded ${name} to ${upload.url.hostname} (HTTP ${response.status})`,
  };
}

function checksumMismatch(
  headers: ReadonlyMap<string, string>,
  file: { size: number; sha256Hex: string; sha256Base64: string; md5Base64: string },
): string | null {
  const contentLength = headers.get("content-length");
  if (contentLength !== undefined && contentLength !== String(file.size)) {
    return `Content-Length expected ${contentLength} bytes but the file has ${file.size}`;
  }
  const amzChecksum = headers.get("x-amz-checksum-sha256");
  if (amzChecksum !== undefined && amzChecksum !== file.sha256Base64) {
    return `x-amz-checksum-sha256 expected SHA-256 ${amzChecksum} but the file has ${file.sha256Base64}`;
  }
  const amzContent = headers.get("x-amz-content-sha256");
  if (amzContent !== undefined && /^[0-9a-f]{64}$/i.test(amzContent) && amzContent.toLowerCase() !== file.sha256Hex) {
    return `x-amz-content-sha256 expected SHA-256 ${amzContent} but the file has ${file.sha256Hex}`;
  }
  const contentMd5 = headers.get("content-md5");
  if (contentMd5 !== undefined && contentMd5 !== file.md5Base64) {
    return `Content-MD5 expected ${contentMd5} but the file has ${file.md5Base64}`;
  }
  const googleMd5 = headers.get("x-goog-hash")?.split(",").map((part) => part.trim()).find((part) => part.startsWith("md5="))?.slice(4);
  if (googleMd5 !== undefined && googleMd5 !== file.md5Base64) {
    return `x-goog-hash expected MD5 ${googleMd5} but the file has ${file.md5Base64}`;
  }
  return null;
}

async function responseExcerpt(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < RESPONSE_EXCERPT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // The status already says what happened; the body is only an excerpt.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, RESPONSE_EXCERPT_BYTES).toString("utf8");
}

/**
 * The storage service's own reason, without anything that can carry signing
 * material: S3 and GCS error XML repeat the canonical request, the string to
 * sign and the credential, so only their Code and Message are kept.
 */
export function storageErrorReason(body: string): string {
  const xmlCode = /<Code>([^<]{1,200})<\/Code>/.exec(body)?.[1];
  const xmlMessage = /<Message>([^<]{1,500})<\/Message>/.exec(body)?.[1];
  let reason = [xmlCode, xmlMessage].filter(Boolean).join(": ");
  if (!reason) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const error = parsed.error && typeof parsed.error === "object" ? parsed.error as Record<string, unknown> : parsed;
      reason = [error.code, error.message].filter((item): item is string => typeof item === "string").join(": ")
        || (typeof parsed.error === "string" ? parsed.error : "");
    } catch {
      reason = /^\s*</.test(body) ? "" : body;
    }
  }
  // URLs keep their origin and path; anything else that looks like a key,
  // token or signature is removed.
  const urls: string[] = [];
  return reason
    .replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
      let shown = "[URL]";
      try { shown = uploadDestination(new URL(match)); } catch { /* not a URL after all */ }
      urls.push(shown);
      return `\u0000${urls.length - 1}\u0000`;
    })
    .replace(/[A-Za-z0-9+/_-]{32,}/g, "[redacted]")
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => urls[Number(index)] ?? "[URL]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function statusHint(status: number): string {
  if (status === 401 || status === 403) return "The upload URL may have expired, or a signed header differs from the headers sent. Request a new upload URL and pass its headers exactly.";
  if (status === 400) return "The storage service rejected the request; check the signed headers and that this is the file the URL was prepared for.";
  if (status === 404) return "The upload destination does not exist; request a new upload URL.";
  if (status === 413) return "The file is larger than the upload URL allows.";
  if (status >= 500) return "The storage service failed; one retry of the same upload is reasonable.";
  return "Request a new upload URL if the problem persists.";
}
