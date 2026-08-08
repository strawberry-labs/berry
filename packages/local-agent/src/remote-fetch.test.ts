import { beforeEach, describe, expect, it, vi } from "vitest";

const undici = vi.hoisted(() => ({
  fetch: vi.fn(),
  agentOptions: undefined as unknown,
}));

vi.mock("undici", () => ({
  Agent: class {
    constructor(options: unknown) { undici.agentOptions = options; }
  },
  fetch: undici.fetch,
}));

import {
  createPublicRemoteFetch,
  isPublicRemoteAddress,
  validatedPublicRemoteUrl,
} from "./remote-fetch.ts";

describe("public remote fetch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects private, reserved, mapped, and local addresses", () => {
    expect(isPublicRemoteAddress("8.8.8.8")).toBe(true);
    expect(isPublicRemoteAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicRemoteAddress("10.0.0.1")).toBe(false);
    expect(isPublicRemoteAddress("100.64.0.1")).toBe(false);
    expect(isPublicRemoteAddress("192.0.2.1")).toBe(false);
    expect(isPublicRemoteAddress("::1")).toBe(false);
    expect(isPublicRemoteAddress("fd00::1")).toBe(false);
    expect(isPublicRemoteAddress("::ffff:127.0.0.1")).toBe(false);
  });

  it("configures a connection-time DNS lookup guard", () => {
    expect(undici.agentOptions).toMatchObject({ connect: { lookup: expect.any(Function) } });
  });

  it("requires credential-free HTTPS URLs", () => {
    expect(validatedPublicRemoteUrl("https://mcp.example.com/tools").hostname).toBe("mcp.example.com");
    expect(() => validatedPublicRemoteUrl("http://mcp.example.com/tools")).toThrow("https");
    expect(() => validatedPublicRemoteUrl("https://user:secret@mcp.example.com/tools")).toThrow("credentials");
    expect(() => validatedPublicRemoteUrl("https://[::ffff:127.0.0.1]/tools")).toThrow("private networks");
  });

  it("rejects a redirect to a private-network target before issuing it", async () => {
    undici.fetch.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "https://127.0.0.1/internal" },
    }));

    await expect(createPublicRemoteFetch()("https://mcp.example.com/start"))
      .rejects.toThrow("private networks");
    expect(undici.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not forward bearer credentials across redirect origins", async () => {
    undici.fetch
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://other.example.com/tools" },
      }))
      .mockResolvedValueOnce(new Response("ok"));

    await createPublicRemoteFetch({ bearerToken: "secret" })("https://mcp.example.com/start");

    const firstHeaders = new Headers(undici.fetch.mock.calls[0]![1].headers);
    const secondHeaders = new Headers(undici.fetch.mock.calls[1]![1].headers);
    expect(firstHeaders.get("authorization")).toBe("Bearer secret");
    expect(secondHeaders.has("authorization")).toBe(false);
  });
});
