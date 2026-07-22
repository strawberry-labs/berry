import { describe, expect, it, vi } from "vitest";
import { directEndpointLimitations, runDirectEndpointChat } from "./direct-chat";

describe("direct endpoint chat", () => {
  it("runs a minimal OpenAI-compatible chat request without tools", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "llama3.2",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi from LAN" } }] }), {
        headers: { "content-type": "application/json" },
      });
    });

    await expect(runDirectEndpointChat({
      baseUrl: "http://192.168.1.20:11434/v1",
      model: "llama3.2",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }, [{ role: "user", content: "hello" }])).resolves.toBe("hi from LAN");
    expect(fetchImpl).toHaveBeenCalledWith("http://192.168.1.20:11434/v1/chat/completions", expect.objectContaining({ method: "POST" }));
  });

  it("states the limits of direct endpoint mode", () => {
    expect(directEndpointLimitations().join(" ")).toContain("Tools");
  });
});
