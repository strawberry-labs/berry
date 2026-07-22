import { createSearchProvider, fetchReadableUrl } from "../dist/web-tools.js";

const configured = [
  ["brave", process.env.BRAVE_SEARCH_API_KEY, undefined],
  ["tavily", process.env.TAVILY_API_KEY, undefined],
  ["ollama", process.env.OLLAMA_API_KEY, undefined],
  ["searxng", undefined, process.env.SEARXNG_URL],
].filter(([, apiKey, url]) => apiKey || url);

if (configured.length === 0) {
  throw new Error("Set BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, OLLAMA_API_KEY, or SEARXNG_URL.");
}

const providers = {};
for (const [kind, apiKey, searxngUrl] of configured) {
  const provider = createSearchProvider({ kind, ...(apiKey ? { apiKey } : {}), ...(searxngUrl ? { searxngUrl } : {}) });
  const result = await provider.search("Berry Chat open source coding agent", 3, AbortSignal.timeout(20_000));
  if (result.results.length === 0 || result.results.some((item) => !/^https?:\/\//.test(item.url))) {
    throw new Error(`${kind} returned no usable source URLs`);
  }
  providers[kind] = { resultCount: result.results.length, sourceHosts: result.results.map((item) => new URL(item.url).hostname) };
}

const fetched = await fetchReadableUrl(process.env.WEB_FETCH_VERIFY_URL || "https://example.com", { timeoutMs: 20_000 });
if (!fetched.content.trim()) throw new Error("fetch_url returned no readable content");

process.stdout.write(`${JSON.stringify({ providers, fetchUrl: { url: fetched.url, title: fetched.title, contentType: fetched.contentType, size: fetched.size } }, null, 2)}\n`);
