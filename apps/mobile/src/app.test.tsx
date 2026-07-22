import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  const primitive = (name: string) => (props: Record<string, unknown>) => ReactModule.createElement(name, props, props.children as React.ReactNode);
  return {
    Pressable: primitive("Pressable"),
    SafeAreaView: primitive("SafeAreaView"),
    ScrollView: primitive("ScrollView"),
    Text: primitive("Text"),
    TextInput: primitive("TextInput"),
    View: primitive("View"),
  };
});

describe("Berry mobile app", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("renders the approvals-first companion surface", async () => {
    const { default: App } = await import("../App");
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });

    const json = renderer!.toJSON();
    expect(JSON.stringify(json)).toContain("Approvals first");
    expect(JSON.stringify(json)).toContain("Run npm publish");
    expect(JSON.stringify(json)).toContain("Approve");
  });

  it("switches to connection settings with LAN warnings", async () => {
    const { default: App } = await import("../App");
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    const connectButton = renderer!.root.findAll((node) => {
      if (node.props.accessibilityRole !== "button") return false;
      return node.findAll((child) => typeof child.props.children === "string" && child.props.children.includes("Connect")).length > 0;
    })[0];
    await act(async () => {
      connectButton!.props.onPress();
    });

    expect(JSON.stringify(renderer!.toJSON())).toContain("Direct endpoint mode cannot receive push notifications");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Plain HTTP");
  });
});
