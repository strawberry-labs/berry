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
  const frameSources = normalizeSources(options.frameSources?.length ? options.frameSources : DEFAULT_FRAME_SOURCES);
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
  return (sources ?? []).map((source) => source.trim()).filter(Boolean).join(" ");
}
