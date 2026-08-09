import { describe, expect, it } from "vitest";
import { ArtifactListQuerySchema } from "./artifact-pagination.ts";

describe("artifact pagination", () => {
  it("defaults to a bounded page", () => {
    expect(ArtifactListQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it("rejects oversized pages and cursors", () => {
    expect(ArtifactListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ArtifactListQuerySchema.safeParse({ cursor: "x".repeat(4_097) }).success).toBe(false);
  });
});
