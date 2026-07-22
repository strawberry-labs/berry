# Web tools

Berry exposes two agent tools:

- `web_search` queries the provider selected in Settings > General and returns titles, snippets, and source URLs.
- `fetch_url` downloads one HTTP(S) resource, extracts readable text, and returns the final URL and content metadata.

Both tools use the `browser` approval class. `web_search` approvals are scoped to the configured provider origin. `fetch_url` approvals are scoped to the requested source origin. Search snippets and fetched content are wrapped in `UNTRUSTED_BROWSER_CONTENT` delimiters; page text cannot authorize another tool call or override the system prompt.

## Search providers

The adapters follow the first-party contracts checked on 2026-07-10:

| Provider | Endpoint | Authentication | Credential reference |
| --- | --- | --- | --- |
| Brave Search | `GET https://api.search.brave.com/res/v1/web/search` | `X-Subscription-Token` | `web-search-brave` |
| Tavily | `POST https://api.tavily.com/search` | bearer token | `web-search-tavily` |
| SearXNG | `GET <instance>/search?format=json` | instance policy | none |
| Ollama hosted search | `POST https://ollama.com/api/web_search` | bearer token | `web-search-ollama` |

Contract references: [Brave Web Search](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started), [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [SearXNG Search API](https://docs.searxng.org/dev/search_api.html), and [Ollama web search](https://docs.ollama.com/capabilities/web-search).

Desktop keys are stored through the encrypted credential service. Provider selection, the SearXNG URL, and the private fetch allowlist are non-secret host settings:

- `web.search.provider`: `none|brave|tavily|searxng|ollama`
- `web.search.searxngUrl`
- `web.fetch.privateAllowlist`: comma-separated exact hostnames or `*.suffix` entries

CLI/sidecar launches may supply `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, or `OLLAMA_API_KEY`. Secrets are captured by the host bridge and never appear in tool arguments, SQLite settings, message parts, or search output.

## Fetch policy

`fetch_url` applies these checks to the initial URL and every redirect:

- only `http` and `https`; URL credentials are rejected;
- DNS answers and literal IPs are checked against loopback, link-local, private, carrier-grade NAT, documentation, benchmark, multicast, and reserved IPv4/IPv6 ranges;
- private targets are denied unless the hostname matches the user-maintained allowlist;
- redirects are manual and capped at five; a cross-origin redirect stops before reading the second site and requires a new `fetch_url` approval;
- requests time out after 15 seconds and response bodies are streamed with a 2 MiB hard limit;
- HTML/XHTML uses Mozilla Readability with LinkeDOM; JSON is parsed and normalized; text/XML is returned as text; binary content is rejected.

The private-host allowlist is an explicit trust decision for internal documentation. It does not accept URL paths or credentials, and a wildcard does not match its bare suffix.

## Verification

Fixture-backed tests cover all four request/response contracts, source URL preservation, approval origins, adversarial content framing, Readability extraction, content types, redirect validation, timeout, byte caps, and the SSRF address table.

For live verification, set one or more provider variables and run:

```sh
BRAVE_SEARCH_API_KEY='...' \
TAVILY_API_KEY='...' \
OLLAMA_API_KEY='...' \
SEARXNG_URL='https://search.example.com' \
corepack pnpm --filter @berry/host verify:web
```

`WEB_FETCH_VERIFY_URL` may replace the default `https://example.com` fetch target. The command prints provider result counts, source hostnames, and fetch metadata; it does not print keys, snippets, or fetched content.

## Live verification

Pending human credentials and a live SearXNG instance. See `plans/human-blockers.md` #13.
