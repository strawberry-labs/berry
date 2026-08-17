import { describe, expect, it } from "vitest";
import {
  classifyWorkflowCategory,
  routedBuiltInToolNames,
  WORKFLOW_CATEGORY_VERSION,
} from "./workflow-routing.ts";

describe("workflow routing", () => {
  it("persists a versioned category and recognizes explicit intent", () => {
    expect(classifyWorkflowCategory({ intent: "image_generation", input: "make a logo" })).toEqual({
      category: "image",
      version: WORKFLOW_CATEGORY_VERSION,
    });
    expect(classifyWorkflowCategory({ conversationKind: "code", input: "write a function" }).category).toBe("code");
  });

  it("allows unknown workflows to remain compatible", () => {
    expect(classifyWorkflowCategory({ input: "" }).category).toBe("unknown");
    expect(routedBuiltInToolNames("unknown", ["bash", "ask_user_question", "bash"])).toEqual([
      "bash",
      "ask_user_question",
    ]);
  });

  it("keeps control tools while narrowing ordinary tools to the task", () => {
    expect(routedBuiltInToolNames("communications", [
      "bash",
      "read",
      "compose_message",
      "ask_user_question",
      "persist_artifact",
    ])).toEqual(["read", "compose_message", "ask_user_question", "persist_artifact"]);
  });
});
