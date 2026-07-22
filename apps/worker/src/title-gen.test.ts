import { describe, expect, it } from "vitest";
import { HeuristicTitleGenerator, processTitleGenerationJob } from "./title-gen.js";

const tenantId = "00000000-0000-7000-8000-000000000001";

describe("title generation", () => {
  it("creates compact titles from task text", async () => {
    const title = await new HeuristicTitleGenerator().generateTitle({
      tenantId,
      taskId: "task_1",
      sourceText: "Please add a cloud worker that runs compaction and usage rollup jobs",
    });

    expect(title).toBe("add cloud worker that runs compaction usage rollup");
  });

  it("persists generated titles through the repository seam", async () => {
    const updates: unknown[] = [];
    await expect(processTitleGenerationJob({
      tenantId,
      taskId: "task_1",
      sourceText: "Use explicit title",
    }, {
      titles: {
        async updateTaskTitle(input) {
          updates.push(input);
        },
      },
      generator: {
        async generateTitle() {
          return "A".repeat(120);
        },
      },
    })).resolves.toEqual({ taskId: "task_1", title: `${"A".repeat(77)}...` });
    expect(updates).toEqual([{ tenantId, taskId: "task_1", title: `${"A".repeat(77)}...` }]);
  });
});
