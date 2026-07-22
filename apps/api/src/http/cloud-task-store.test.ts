import { describe, expect, it } from "vitest";
import { SELF_HOST_WORKSPACE_ID } from "@berry/db";
import { normalizeWorkspaceId } from "./cloud-task-store.ts";

describe("cloud workspace identifiers", () => {
  it("preserves valid project UUIDs instead of moving tasks to the default workspace", () => {
    const projectId = "f7faac34-1cc1-4395-8092-81ce5586a2cf";

    expect(normalizeWorkspaceId(projectId)).toBe(projectId);
  });

  it("retains the legacy self-host fallback for non-UUID workspace aliases", () => {
    expect(normalizeWorkspaceId("self-host")).toBe(SELF_HOST_WORKSPACE_ID);
  });
});
