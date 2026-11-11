import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sortProjects, conversationSectionReducer, INITIAL_CONVERSATION_SECTION_STATE } from "./conversations.ts";
import { timeAgo } from "./format.ts";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(sourceDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({ name, text: readFileSync(join(sourceDir, name), "utf8") }));

describe("@berry/client-core", () => {
  it("stays free of DOM and web-only dependencies so React Native can load it", () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/from "react-dom/);
      expect(text, name).not.toMatch(/from "@berry\/desktop-ui/);
      expect(text, name).not.toMatch(/\b(document|window|HTMLElement|navigator)\./);
    }
  });

  it("sorts projects for every sidebar the same way", () => {
    const project = (name: string, pinned: boolean, updatedAt: string) => ({ workspace: { name, pinned, updatedAt } as never });
    const projects = [project("b", false, "2026-10-02"), project("a", true, "2026-10-01"), project("c", false, "2026-10-03")];
    expect(sortProjects(projects, "last-updated").map((item) => (item.workspace as { name: string }).name)).toEqual(["c", "b", "a"]);
    expect(sortProjects(projects, "priority").map((item) => (item.workspace as { name: string }).name)).toEqual(["a", "c", "b"]);
    expect(sortProjects(projects, "manual")).toEqual(projects);
  });

  it("collapses and expands sidebar sections", () => {
    const collapsed = conversationSectionReducer(INITIAL_CONVERSATION_SECTION_STATE, { type: "toggle-all", projectIds: ["p1"] });
    expect(collapsed).toMatchObject({ allCollapsed: true, chatsCollapsed: true });
    expect([...collapsed.collapsedProjects]).toEqual(["p1"]);
  });

  it("formats relative ages", () => {
    expect(timeAgo(new Date(Date.now() - 30_000).toISOString())).toBe("now");
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m");
    expect(timeAgo(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe("3h");
  });
});
