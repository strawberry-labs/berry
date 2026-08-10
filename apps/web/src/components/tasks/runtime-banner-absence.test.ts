import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("passive durable-run banners", () => {
  it("keeps banner presentation out of the task shell and stylesheet", () => {
    const shell = readFileSync(new URL("../app-shell.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    expect(shell).not.toContain("DurableRunStatus");
    expect(styles).not.toContain(".durable-run-status");
  });
});
