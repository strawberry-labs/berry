import { lookup as dnsLookup } from "node:dns";
import { lookup as dnsLookupPromise } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const BODY_HEADERS = ["content-encoding", "content-language", "content-length", "content-location", "content-type"];
const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization"];

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Returns true only for ordinary public-unicast addresses. */
export function isPublicRemoteAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(normalizedHostname(address));
    if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

function assertPublicAddresses(addresses: Array<{ address: string; family: number }>): void {
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicRemoteAddress(address))) {
    throw new Error("remote endpoints must not resolve to private or reserved networks");
  }
}

/** Validates the URL shape without trusting a DNS result that can change before connect. */
export function validatedPublicRemoteUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("remote endpoints must use https");
  if (url.username || url.password) throw new Error("remote URLs must not contain credentials");
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("remote endpoints must not target localhost or private networks");
  }
  if (isIP(hostname) && !isPublicRemoteAddress(hostname)) {
    throw new Error("remote endpoints must not target localhost or private networks");
  }
  return url;
}

/** Resolves once for fast configuration feedback. The socket lookup repeats this check. */
export async function resolvePublicRemoteUrl(rawUrl: string): Promise<URL> {
  const url = validatedPublicRemoteUrl(rawUrl);
  const hostname = normalizedHostname(url.hostname);
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await dnsLookupPromise(hostname, { all: true, verbatim: true });
  assertPublicAddresses(addresses);
  return url;
}

const publicNetworkLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, {
    all: true,
    verbatim: true,
    ...(options.family ? { family: options.family } : {}),
    ...(options.hints ? { hints: options.hints } : {}),
  }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    try {
      const resolved = Array.isArray(addresses) ? addresses : [addresses];
      assertPublicAddresses(resolved);
      if (options.all) callback(null, resolved);
      else callback(null, resolved[0]!.address, resolved[0]!.family);
    } catch (cause) {
      callback(cause instanceof Error ? cause : new Error("remote hostname resolution was rejected"), []);
    }
  });
};

// Every new TCP/TLS connection resolves through the guard. Returning the checked
// address from lookup also pins that connection to the validated DNS result.
const publicRemoteAgent = new Agent({ connect: { lookup: publicNetworkLookup } });

type PublicRemoteFetchOptions = {
  bearerToken?: string | null;
  redirect?: "follow" | "manual" | "error";
  timeoutMs?: number;
};

function redirectMethod(status: number, method: string): string {
  if (status === 303 && method !== "GET" && method !== "HEAD") return "GET";
  if ((status === 301 || status === 302) && method === "POST") return "GET";
  return method;
}

function undiciInit(input: {
  body: Uint8Array | undefined;
  headers: Headers;
  method: string;
  signal: AbortSignal;
}): UndiciRequestInit {
  return {
    method: input.method,
    headers: [...input.headers.entries()],
    ...(input.body ? { body: input.body } : {}),
    redirect: "manual",
    dispatcher: publicRemoteAgent,
    signal: input.signal,
  };
}

/**
 * Fetches only HTTPS public-network URLs. Redirects are revalidated and
 * credentials are never forwarded across origins.
 */
export function createPublicRemoteFetch(options: PublicRemoteFetchOptions = {}): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    let url = validatedPublicRemoteUrl(request.url);
    let method = request.method.toUpperCase();
    let body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const headers = new Headers(request.headers);
    if (options.bearerToken) headers.set("authorization", `Bearer ${options.bearerToken}`);
    const timeoutSignal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : null;
    const signal = timeoutSignal ? AbortSignal.any([request.signal, timeoutSignal]) : request.signal;
    const redirectMode = options.redirect ?? "follow";

    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await undiciFetch(url, undiciInit({ body, headers, method, signal }));
      if (!REDIRECT_STATUSES.has(response.status) || !response.headers.has("location")) {
        return response as unknown as Response;
      }
      if (redirectMode === "manual") return response as unknown as Response;
      if (redirectMode === "error") {
        await response.body?.cancel();
        throw new TypeError("remote endpoint redirected while redirects are disabled");
      }
      if (redirectCount >= MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new TypeError(`remote endpoint exceeded ${MAX_REDIRECTS} redirects`);
      }

      const nextUrl = validatedPublicRemoteUrl(new URL(response.headers.get("location")!, url).toString());
      if (nextUrl.origin !== url.origin) {
        for (const header of SENSITIVE_HEADERS) headers.delete(header);
      }
      const nextMethod = redirectMethod(response.status, method);
      if (nextMethod !== method) {
        method = nextMethod;
        body = undefined;
        for (const header of BODY_HEADERS) headers.delete(header);
      }
      await response.body?.cancel();
      url = nextUrl;
    }
  };
}
