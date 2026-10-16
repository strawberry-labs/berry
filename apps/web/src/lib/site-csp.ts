export const CSP_NONCE_RESPONSE_HEADER = "X-Berry-CSP-Nonce";

const DEFAULT_FRAME_SOURCES = [
  "https://accounts.google.com",
  "https://docs.google.com",
  "https://drive.google.com",
  "https://*.googleusercontent.com",
  "https://*.e2b.app",
];

export function createCspNonce(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replaceAll("-", "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export function buildSiteContentSecurityPolicy(options: {
  nonce: string;
  connectOrigins?: readonly string[];
  imageOrigins?: readonly string[];
  frameSources?: readonly string[];
}): string {
  const connectOrigins = normalizeSources(options.connectOrigins);
  const imageOrigins = normalizeSources(options.imageOrigins);
  const frameSources = normalizeSources([...DEFAULT_FRAME_SOURCES, ...(options.frameSources ?? [])]);
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${options.nonce}' 'wasm-unsafe-eval' https://apis.google.com`,
    "script-src-attr 'none'",
    "style-src 'self'",
    "style-src-elem 'self'",
    // React's small set of data-driven progress/chart styles are attributes;
    // keep element stylesheets and script-injected CSS non-inline.
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob: https://*.googleusercontent.com${imageOrigins ? ` ${imageOrigins}` : ""}`,
    "font-src 'self' data:",
    `connect-src 'self'${connectOrigins ? ` ${connectOrigins}` : ""}`,
    `frame-src 'self' ${frameSources}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self' blob:",
    "upgrade-insecure-requests",
  ].join("; ");
}

function normalizeSources(sources: readonly string[] | undefined): string {
  return [...new Set((sources ?? []).map((source) => source.trim()).filter(Boolean))].join(" ");
}

/** Match the public S3 signer without granting browser access to every S3 bucket. */
export function storageConnectOrigins(input: { endpoint?: string | undefined; bucket?: string | undefined; region?: string | undefined; accelerate?: boolean }): string[] {
  if (input.endpoint) {
    try {
      const url = new URL(input.endpoint);
      return ["https:", "http:"].includes(url.protocol) ? [url.origin] : [];
    } catch { return []; }
  }
  if (!input.bucket || !/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/.test(input.bucket)) return [];
  const region = input.region || "eu-west-1";
  if (!/^[a-z0-9-]+$/.test(region)) return [];
  const suffix = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  // HTTPS S3 uses path-style addressing for dotted bucket names.
  return [`https://${input.bucket.includes(".") ? "" : `${input.bucket}.`}s3.${region}.${suffix}`,
    ...(input.accelerate && !input.bucket.includes(".") ? [`https://${input.bucket}.s3-accelerate.amazonaws.com`] : [])];
}
