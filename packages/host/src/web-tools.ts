import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export type SearchProviderKind = "brave" | "tavily" | "searxng" | "ollama";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  publishedAt?: string;
}

export interface SearchResponse {
  provider: SearchProviderKind;
  query: string;
  results: SearchResult[];
}

export interface SearchProvider {
  readonly kind: SearchProviderKind;
  readonly endpoint: URL;
  search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse>;
}

export interface SearchProviderOptions {
  kind: SearchProviderKind;
  apiKey?: string;
  searxngUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface FetchUrlOptions {
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  allowPrivateHosts?: string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface FetchedPage {
  url: string;
  title: string;
  byline: string | null;
  excerpt: string | null;
  content: string;
  contentType: string;
  size: number;
}

const BRAVE_ENDPOINT = new URL("https://api.search.brave.com/res/v1/web/search");
const TAVILY_ENDPOINT = new URL("https://api.tavily.com/search");
const OLLAMA_ENDPOINT = new URL("https://ollama.com/api/web_search");
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

export function searchCredentialReference(kind: SearchProviderKind): string | null {
  if (kind === "searxng") return null;
  return `web-search-${kind}`;
}

export function createSearchProvider(options: SearchProviderOptions): SearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey?.trim();
  if (options.kind !== "searxng" && !apiKey) throw new Error(`${options.kind} web search requires an API key`);
  if (options.kind === "brave") return new BraveSearchProvider(fetchImpl, apiKey!);
  if (options.kind === "tavily") return new TavilySearchProvider(fetchImpl, apiKey!);
  if (options.kind === "ollama") return new OllamaSearchProvider(fetchImpl, apiKey!);
  return new SearxngSearchProvider(fetchImpl, validatedConfiguredEndpoint(options.searxngUrl));
}

export function searchProviderEndpoint(kind: SearchProviderKind, searxngUrl?: string): URL {
  if (kind === "brave") return new URL(BRAVE_ENDPOINT);
  if (kind === "tavily") return new URL(TAVILY_ENDPOINT);
  if (kind === "ollama") return new URL(OLLAMA_ENDPOINT);
  return validatedConfiguredEndpoint(searxngUrl);
}

class BraveSearchProvider implements SearchProvider {
  readonly kind = "brave" as const;
  readonly endpoint = BRAVE_ENDPOINT;

  constructor(readonly fetchImpl: typeof fetch, readonly apiKey: string) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
    const url = new URL(this.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));
    const body = await requestJson(this.fetchImpl, url, {
      headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey },
      ...(signal ? { signal } : {}),
    });
    const web = record(body.web);
    return {
      provider: this.kind,
      query,
      results: array(web.results).slice(0, maxResults).flatMap((item) => searchResult(item, "description", "age")),
    };
  }
}

class TavilySearchProvider implements SearchProvider {
  readonly kind = "tavily" as const;
  readonly endpoint = TAVILY_ENDPOINT;

  constructor(readonly fetchImpl: typeof fetch, readonly apiKey: string) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
    const body = await requestJson(this.fetchImpl, this.endpoint, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, search_depth: "basic", include_answer: false, include_raw_content: false, max_results: maxResults }),
      ...(signal ? { signal } : {}),
    });
    return {
      provider: this.kind,
      query,
      results: array(body.results).slice(0, maxResults).flatMap((item) => searchResult(item, "content", "published_date")),
    };
  }
}

class SearxngSearchProvider implements SearchProvider {
  readonly kind = "searxng" as const;

  constructor(readonly fetchImpl: typeof fetch, readonly endpoint: URL) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
    const url = new URL(this.endpoint);
    if (!url.pathname.replace(/\/$/, "").endsWith("/search")) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/search`;
    }
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("safesearch", "1");
    const body = await requestJson(this.fetchImpl, url, {
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    return {
      provider: this.kind,
      query,
      results: array(body.results).slice(0, maxResults).flatMap((item) => searchResult(item, "content", "publishedDate")),
    };
  }
}

class OllamaSearchProvider implements SearchProvider {
  readonly kind = "ollama" as const;
  readonly endpoint = OLLAMA_ENDPOINT;

  constructor(readonly fetchImpl: typeof fetch, readonly apiKey: string) {}

  async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
    const body = await requestJson(this.fetchImpl, this.endpoint, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: maxResults }),
      ...(signal ? { signal } : {}),
    });
    return {
      provider: this.kind,
      query,
      results: array(body.results).slice(0, maxResults).flatMap((item) => searchResult(item, "content")),
    };
  }
}

export async function fetchReadableUrl(rawUrl: string, options: FetchUrlOptions = {}): Promise<FetchedPage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveHost = options.resolveHost ?? resolveHostname;
  const allowPrivateHosts = normalizeAllowlist(options.allowPrivateHosts ?? []);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`fetch_url timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    let url = await validatedFetchUrl(rawUrl, { resolveHost, allowPrivateHosts });
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const response = await fetchImpl(url, {
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml,text/xml;q=0.9,*/*;q=0.1",
          "User-Agent": "Berry/0.1 fetch_url",
        },
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`fetch_url received redirect ${response.status} without Location`);
        if (redirect === maxRedirects) throw new Error(`fetch_url exceeded ${maxRedirects} redirects`);
        await response.body?.cancel();
        const redirected = await validatedFetchUrl(new URL(location, url).toString(), { resolveHost, allowPrivateHosts });
        if (redirected.origin !== url.origin) {
          throw new Error(`fetch_url redirected to ${redirected.origin}; call fetch_url for the redirected URL to approve that origin`);
        }
        url = redirected;
        continue;
      }
      if (!response.ok) throw new Error(`fetch_url failed with HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
      if (!isSupportedTextType(contentType)) throw new Error(`fetch_url does not support content type ${contentType}`);
      const declaredSize = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new Error(`fetch_url content exceeds ${maxBytes} bytes`);
      const bytes = await readBoundedBody(response, maxBytes);
      const decoded = new TextDecoder().decode(bytes);
      return extractFetchedPage(url.toString(), contentType, decoded, bytes.byteLength);
    }
    throw new Error("fetch_url redirect loop");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function validatedFetchUrl(
  rawUrl: string,
  options: { resolveHost?: (hostname: string) => Promise<string[]>; allowPrivateHosts?: Set<string> } = {},
): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("fetch_url only supports http and https URLs");
  if (url.username || url.password) throw new Error("fetch_url URLs must not contain credentials");
  const hostname = normalizedHostname(url.hostname);
  if (!hostname) throw new Error("fetch_url URL must include a hostname");
  const allowlist = options.allowPrivateHosts ?? new Set<string>();
  if (hostAllowed(hostname, allowlist)) return url;
  const addresses = isIP(hostname) ? [hostname] : await (options.resolveHost ?? resolveHostname)(hostname);
  if (addresses.length === 0) throw new Error(`fetch_url could not resolve ${hostname}`);
  if (addresses.some(isBlockedAddress)) throw new Error(`fetch_url blocked private or reserved address for ${hostname}`);
  return url;
}

export function isBlockedAddress(address: string): boolean {
  const normalized = normalizedHostname(address);
  if (normalized.startsWith("::ffff:")) return isBlockedAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const [a = 0, b = 0, c = 0] = normalized.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(normalized) === 6) {
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("2001:db8:");
  }
  return true;
}

function validatedConfiguredEndpoint(rawUrl: string | undefined): URL {
  if (!rawUrl?.trim()) throw new Error("SearXNG web search requires an instance URL");
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("SearXNG URL must use http or https");
  if (url.username || url.password) throw new Error("SearXNG URL must not contain credentials");
  return url;
}

async function requestJson(fetchImpl: typeof fetch, url: URL, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}`);
  const body = await response.json() as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Web search returned malformed JSON");
  return body as Record<string, unknown>;
}

function searchResult(value: unknown, snippetKey: string, publishedKey?: string): SearchResult[] {
  const item = record(value);
  const title = text(item.title);
  const url = text(item.url);
  if (!title || !isPublicResultUrl(url)) return [];
  const snippet = htmlToText(text(item[snippetKey]));
  const score = typeof item.score === "number" && Number.isFinite(item.score) ? item.score : undefined;
  const publishedAt = publishedKey ? text(item[publishedKey]) || undefined : undefined;
  return [{ title, url, snippet, ...(score !== undefined ? { score } : {}), ...(publishedAt ? { publishedAt } : {}) }];
}

function isPublicResultUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function htmlToText(html: string): string {
  if (!html) return "";
  const { document } = parseHTML(`<body>${html}</body>`);
  return (document.body?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function extractFetchedPage(url: string, contentType: string, source: string, size: number): FetchedPage {
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    const { document } = parseHTML(source);
    const article = new Readability(document as unknown as Document).parse();
    const fallback = (document.body?.textContent ?? "").replace(/\s+/g, " ").trim();
    return {
      url,
      title: article?.title?.trim() || document.title?.trim() || new URL(url).hostname,
      byline: article?.byline?.trim() || null,
      excerpt: article?.excerpt?.trim() || null,
      content: (article?.textContent || fallback).replace(/\n{3,}/g, "\n\n").trim(),
      contentType,
      size,
    };
  }
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    let content = source;
    try {
      content = JSON.stringify(JSON.parse(source), null, 2);
    } catch {
      throw new Error("fetch_url received malformed JSON");
    }
    return { url, title: new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? new URL(url).hostname, byline: null, excerpt: null, content, contentType, size };
  }
  return {
    url,
    title: new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? new URL(url).hostname,
    byline: null,
    excerpt: null,
    content: source.trim(),
    contentType,
    size,
  };
}

function isSupportedTextType(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType === "application/json" || contentType.endsWith("+json") ||
    contentType === "application/xml" || contentType.endsWith("+xml") || contentType === "application/xhtml+xml";
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`fetch_url content exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function resolveHostname(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function normalizeAllowlist(values: string[]): Set<string> {
  return new Set(values.map((value) => normalizedHostname(value.trim())).filter(Boolean));
}

function hostAllowed(hostname: string, allowlist: Set<string>): boolean {
  if (allowlist.has(hostname)) return true;
  for (const item of allowlist) {
    if (item.startsWith("*.") && hostname.endsWith(item.slice(1)) && hostname !== item.slice(2)) return true;
  }
  return false;
}

function normalizedHostname(value: string): string {
  return value.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
