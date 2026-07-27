import { describe, expect, it } from "vitest";
import type { MessageDraft } from "@berry/shared";
import {
  composeWritingBlockText,
  messageDraftFromToolResult,
  messageDraftState,
  reconcileMessageDraftState,
  writingBlockLaunchAction,
} from "./writing-block";

const draft: MessageDraft = {
  id: "project-update",
  kind: "email",
  summaryTitle: "Project update",
  variants: [
    { label: "Professional", subject: "Project update", body: "Hello team", active: true },
    { label: "Warm", subject: "A quick update", body: "Hi everyone" },
  ],
};

describe("writing block model", () => {
  it("extracts only completed, valid compose_message tool results", () => {
    expect(messageDraftFromToolResult({
      name: "compose_message",
      status: "completed",
      output: { text: "Prepared", draft },
    })).toEqual(draft);
    expect(messageDraftFromToolResult({
      name: "compose_message",
      status: "failed",
      output: { draft },
    })).toBeNull();
    expect(messageDraftFromToolResult({
      name: "other_tool",
      status: "completed",
      output: { draft },
    })).toBeNull();
  });

  it("preserves dirty local text and exposes the incoming revision as a conflict", () => {
    const local = messageDraftState(draft);
    local.variants[0] = { ...local.variants[0]!, body: "My hand-edited version", dirty: true };
    const incoming: MessageDraft = {
      ...draft,
      variants: [
        { label: "Professional", subject: "Revised subject", body: "AI revision" },
        { label: "Warm", subject: "Warmer update", body: "Updated warm version" },
      ],
    };
    const reconciled = reconcileMessageDraftState(local, incoming);
    expect(reconciled.state.variants[0]).toMatchObject({
      body: "My hand-edited version",
      subject: "Project update",
      dirty: true,
    });
    expect(reconciled.conflicts[0]).toMatchObject({ body: "AI revision", subject: "Revised subject" });
    expect(reconciled.state.variants[1]).toMatchObject({
      body: "Updated warm version",
      subject: "Warmer update",
      dirty: false,
    });
  });

  it("formats copy and launch actions by channel", () => {
    expect(composeWritingBlockText("email", { subject: "Hello", body: "Body" })).toBe("Subject: Hello\n\nBody");
    expect(writingBlockLaunchAction("email", { subject: "Hello world", body: "Line one\nLine two" })).toEqual({
      href: "mailto:?subject=Hello%20world&body=Line%20one%0ALine%20two",
      label: "Open in Mail",
    });
    expect(writingBlockLaunchAction("textMessage", { body: "Hello there" })).toEqual({
      href: "sms:?&body=Hello%20there",
      label: "Open in Messages",
    });
    expect(writingBlockLaunchAction("other", { body: "Hello" })).toBeNull();
  });
});
