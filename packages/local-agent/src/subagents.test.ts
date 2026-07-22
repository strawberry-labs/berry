import { describe, expect, it } from "vitest";
import { builtInSubagents, parseSubagentMarkdown, serializeSubagentMarkdown } from "./subagents.ts";

describe("parseSubagentMarkdown", () => {
  it("ships non-empty built-in prompts for general-purpose and explore", () => {
    const agents = new Map(builtInSubagents().map((agent) => [agent.name, agent]));
    const general = agents.get("general-purpose");
    const explore = agents.get("explore");

    expect(general?.systemPrompt).toContain("general-purpose sub-agent");
    expect(general?.systemPrompt).toContain("Complete the delegated task");
    expect(explore?.systemPrompt).toContain("read-only exploration sub-agent");
    expect(explore?.systemPrompt).toContain("must not create, modify, delete");
    expect(explore?.tools).toContain("grep");
    expect(explore?.tools).not.toContain("bash");
  });

  it("parses frontmatter + body into a manifest", () => {
    const md = ["---", "name: reviewer", "description: Reviews diffs", "color: green", "tools:", "  - read_file", "  - grep", "---", "", "You are a code reviewer."].join("\n");
    const result = parseSubagentMarkdown(md, "/agents/reviewer.md", "user");
    expect("agent" in result).toBe(true);
    if (!("agent" in result)) return;
    expect(result.agent.name).toBe("reviewer");
    expect(result.agent.description).toBe("Reviews diffs");
    expect(result.agent.tools).toEqual(["read_file", "grep"]);
    expect(result.agent.systemPrompt).toBe("You are a code reviewer.");
    expect(result.agent.scope).toBe("user");
    expect(result.agent.readOnly).toBe(false);
  });

  it("falls back to the filename when name is omitted, and defaults tools to *", () => {
    const md = ["---", "description: Does things", "---", "prompt body"].join("\n");
    const result = parseSubagentMarkdown(md, "/agents/helper.md", "workspace");
    if (!("agent" in result)) throw new Error("expected agent");
    expect(result.agent.name).toBe("helper");
    expect(result.agent.tools).toEqual(["*"]);
    expect(result.agent.readOnly).toBe(true);
  });

  it("rejects files without frontmatter, a bad name, or no description", () => {
    expect("error" in parseSubagentMarkdown("just text", "/a.md", "user")).toBe(true);
    expect("error" in parseSubagentMarkdown("---\nname: ab\ndescription: x\n---\n", "/a.md", "user")).toBe(true); // name too short
    expect("error" in parseSubagentMarkdown("---\nname: valid-name\n---\n", "/a.md", "user")).toBe(true); // no description
  });

  it("round-trips through serialize", () => {
    const [agent] = builtInSubagents();
    const custom = { ...agent!, scope: "user" as const, name: "roundtrip", description: "d", systemPrompt: "hello", tools: ["read_file"], model: "x/y" };
    const reparsed = parseSubagentMarkdown(serializeSubagentMarkdown(custom), "/agents/roundtrip.md", "user");
    if (!("agent" in reparsed)) throw new Error("expected agent");
    expect(reparsed.agent.name).toBe("roundtrip");
    expect(reparsed.agent.tools).toEqual(["read_file"]);
    expect(reparsed.agent.model).toBe("x/y");
    expect(reparsed.agent.systemPrompt).toBe("hello");
  });
});
