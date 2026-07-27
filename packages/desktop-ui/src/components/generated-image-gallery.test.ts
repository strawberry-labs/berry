import { describe, expect, it } from "vitest";
import type { MessagePart } from "@berry/shared";
import { generatedImageFromPart } from "./generated-image-gallery";

const basePart = {
  id: "part_1",
  messageId: "message_1",
  kind: "image" as const,
  position: 0,
  createdAt: "2026-07-27T00:00:00.000Z",
};

describe("generated image message content", () => {
  it("accepts only structured generated-image assets", () => {
    expect(generatedImageFromPart({
      ...basePart,
      content: {
        src: "/v1/files/file/content",
        fileId: "00000000-0000-4000-8000-000000000001",
        title: "Berry over Dubai",
        aspectRatio: "16:9",
        mimeType: "image/png",
        transparentBackground: false,
      },
    } satisfies MessagePart)).toMatchObject({ title: "Berry over Dubai", aspectRatio: "16:9" });
    expect(generatedImageFromPart({
      ...basePart,
      content: "data:image/png;base64,aW1hZ2U=",
    } satisfies MessagePart)).toBeNull();
  });
});
