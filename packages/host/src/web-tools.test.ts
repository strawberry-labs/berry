import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSearchProvider,
  fetchReadableUrl,
  isBlockedAddress,
  searchCredentialReference,
  validatedFetchUrl,
  type SearchProviderKind,
} from "./web-tools.ts";

const localFixture = join(import.meta.dirname, "fixtures", "web-search-contracts.json");
const fixturePath = existsSync(localFixture) ? localFixture : join(import.meta.dirname, "..", "src", "fixtures", "web-search-contracts.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

describe("search providers", () => {
  it.each([
    ["brave", "https://api.search.brave.com/res/v1/web/search", "web-search-brave"],
    ["tavily", "https://api.tavily.com/search", "web-search-tavily"],
    ["ollama", "https://ollama.com/api/web_search", "web-search-ollama"],
    ["searxng", "https://search.example.test/search", null],
  ] as const)("normalizes the %s contract and preserves source URLs", async (kind, expectedUrl, credentialRef) => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const provider = createSearchProvider({
      kind,
      ...(kind === "searxng" ? { searxngUrl: "https://search.example.test" } : { apiKey: "secret-key" }),
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), ...(init ? { init } : {}) });
        return Response.json(fixture[kind]);
      },
    });
    const response = await provider.search("berry chat", 3);
    expect(response.provider).toBe(kind);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.url).toMatch(/^https:\/\//);
    expect(response.results[0]?.snippet).not.toContain("<strong>");
    expect(searchCredentialReference(kind)).toBe(credentialRef);
    expect(requests[0]?.url).toContain(expectedUrl);

    const headers = new Headers(requests[0]?.init?.headers);
    if (kind === "brave") {
      expect(headers.get("x-subscription-token")).toBe("secret-key");
      expect(requests[0]?.url).toContain("q=berry+chat");
      expect(requests[0]?.url).toContain("count=3");
    } else if (kind === "tavily") {
      expect(headers.get("authorization")).toBe("Bearer secret-key");
      expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ query: "berry chat", search_depth: "basic", max_results: 3 });
    } else if (kind === "ollama") {
      expect(headers.get("authorization")).toBe("Bearer secret-key");
      expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ query: "berry chat", max_results: 3 });
    } else {
      expect(requests[0]?.url).toContain("format=json");
      expect(requests[0]?.url).toContain("safesearch=1");
    }
  });

  it.each(["brave", "tavily", "ollama"] as SearchProviderKind[])("requires a key for %s", (kind) => {
    expect(() => createSearchProvider({ kind })).toThrow("requires an API key");
  });
});

describe("fetch_url SSRF policy", () => {
  it.each([
    ["0.0.0.0", true],
    ["10.1.2.3", true],
    ["100.64.1.1", true],
    ["127.0.0.1", true],
    ["169.254.169.254", true],
    ["172.16.0.1", true],
    ["192.168.1.1", true],
    ["192.0.2.1", true],
    ["198.18.0.1", true],
    ["198.51.100.1", true],
    ["203.0.113.1", true],
    ["224.0.0.1", true],
    ["::", true],
    ["::1", true],
    ["fc00::1", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["ff02::1", true],
    ["2001:db8::1", true],
    ["8.8.8.8", false],
    ["2606:4700:4700::1111", false],
  ])("classifies %s", (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });

  it("blocks private DNS answers and URL credentials", async () => {
    await expect(validatedFetchUrl("https://public.example.test/path", { resolveHost: async () => ["10.0.0.8"] }))
      .rejects.toThrow("private or reserved");
    await expect(validatedFetchUrl("https://user:pass@public.example.test", { resolveHost: async () => ["8.8.8.8"] }))
      .rejects.toThrow("credentials");
    await expect(validatedFetchUrl("file:///etc/passwd")).rejects.toThrow("http and https");
  });

  it("allows explicitly configured private hosts and wildcard subdomains", async () => {
    await expect(validatedFetchUrl("http://docs.internal.test/page", {
      resolveHost: async () => ["10.0.0.9"],
      allowPrivateHosts: new Set(["*.internal.test"]),
    })).resolves.toMatchObject({ hostname: "docs.internal.test" });
    await expect(validatedFetchUrl("http://internal.test/page", {
      resolveHost: async () => ["10.0.0.9"],
      allowPrivateHosts: new Set(["*.internal.test"]),
    })).rejects.toThrow("private or reserved");
  });

  it("validates every redirect before following it", async () => {
    let calls = 0;
    await expect(fetchReadableUrl("https://public.example.test/start", {
      resolveHost: async (hostname) => hostname === "public.example.test" ? ["8.8.8.8"] : ["127.0.0.1"],
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { Location: "http://localhost/admin" } });
      },
    })).rejects.toThrow("private or reserved");
    expect(calls).toBe(1);
  });

  it("requires a new approval for a public cross-origin redirect", async () => {
    let calls = 0;
    await expect(fetchReadableUrl("https://public.example.test/start", {
      resolveHost: async () => ["8.8.8.8"],
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { Location: "https://other.example.test/article" } });
      },
    })).rejects.toThrow("call fetch_url for the redirected URL to approve that origin");
    expect(calls).toBe(1);
  });
});

describe("fetch_url content extraction", () => {
  const resolveHost = async () => ["8.8.8.8"];

  it("extracts the readable HTML article", async () => {
    const html = `<!doctype html><html><head><title>Fallback</title></head><body><nav>Navigation</nav><article><h1>Berry Web Tools</h1><p>${"Readable article sentence. ".repeat(20)}</p></article><script>steal()</script></body></html>`;
    const page = await fetchReadableUrl("https://docs.example.test/article", {
      resolveHost,
      fetchImpl: async () => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    });
    expect(page.title).toBe("Fallback");
    expect(page.content).toContain("Readable article sentence");
    expect(page.content).not.toContain("steal()");
    expect(page.contentType).toBe("text/html");
  });

  it("pretty-prints JSON and returns plain text", async () => {
    const json = await fetchReadableUrl("https://api.example.test/data", {
      resolveHost,
      fetchImpl: async () => Response.json({ ok: true, count: 2 }),
    });
    expect(json.content).toBe('{\n  "ok": true,\n  "count": 2\n}');
    const plain = await fetchReadableUrl("https://docs.example.test/readme.txt", {
      resolveHost,
      fetchImpl: async () => new Response("plain body", { headers: { "Content-Type": "text/plain" } }),
    });
    expect(plain.content).toBe("plain body");
  });

  it("rejects declared, streamed, and binary oversized content", async () => {
    await expect(fetchReadableUrl("https://docs.example.test/large", {
      resolveHost,
      maxBytes: 4,
      fetchImpl: async () => new Response("12345", { headers: { "Content-Type": "text/plain", "Content-Length": "5" } }),
    })).rejects.toThrow("exceeds 4 bytes");
    await expect(fetchReadableUrl("https://docs.example.test/stream", {
      resolveHost,
      maxBytes: 4,
      fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("12345")); controller.close(); } }), { headers: { "Content-Type": "text/plain" } }),
    })).rejects.toThrow("exceeds 4 bytes");
    await expect(fetchReadableUrl("https://docs.example.test/image", {
      resolveHost,
      fetchImpl: async () => new Response("png", { headers: { "Content-Type": "image/png" } }),
    })).rejects.toThrow("does not support content type image/png");
  });

  it("aborts a hanging request at the configured timeout", async () => {
    await expect(fetchReadableUrl("https://docs.example.test/hang", {
      resolveHost,
      timeoutMs: 10,
      fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    })).rejects.toThrow("timed out after 10ms");
  });
});
