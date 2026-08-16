import { getResponseHeader, setResponseHeader } from "@tanstack/react-start/server";
import { buildSiteContentSecurityPolicy, createCspNonce, CSP_NONCE_RESPONSE_HEADER } from "./lib/site-csp";

export function serverCspNonce(): string {
  try {
    const existing = getResponseHeader(CSP_NONCE_RESPONSE_HEADER);
    if (existing) return existing;
    const nonce = createCspNonce();
    setResponseHeader(CSP_NONCE_RESPONSE_HEADER, nonce);
    setResponseHeader("Content-Security-Policy", buildSiteContentSecurityPolicy({ nonce }));
    return nonce;
  } catch {
    return createCspNonce();
  }
}
