import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { PolicyListInput, parsePolicyItems } from "./policy-list-input";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("policy domain pills", () => {
  it("normalizes and deduplicates pasted domain lists", () => {
    expect(parsePolicyItems("API.example.com, *.example.com\nAPI.example.com;second.example.com", true)).toEqual(["api.example.com", "*.example.com", "second.example.com"]);
  });
  it.each(["https://example.com", "example.com/path", "example.com:443", "-bad.example", "example..com"])("rejects malformed domain %s without silently broadening access", (value) => {
    expect(() => parsePolicyItems(value, true)).toThrow("Enter a domain");
  });
  it("preserves tool-class identifiers", () => {
    expect(parsePolicyItems("read, write read", false)).toEqual(["read", "write"]);
  });
  it("commits on blur, keeps incomplete text local, and removes a pill", async () => {
    let values = ["existing.example.com"];
    let renderer!: ReactTestRenderer;
    const validity = vi.fn();
    const node = { setCustomValidity: validity, focus: vi.fn() };
    function Harness() {
      const [value, setValue] = React.useState(values);
      return <PolicyListInput id="domains" label="Allowed domains" domains value={value} disabled={false} onChange={(next) => { values = next; setValue(next); }} />;
    }
    await act(async () => { renderer = create(<Harness />, { createNodeMock: () => node }); });
    const input = () => renderer.root.findByType("input");
    await act(async () => { input().props.onChange({ target: { value: "new.example.com", setCustomValidity: validity } }); });
    expect(values).toEqual(["existing.example.com"]);
    await act(async () => { input().props.onBlur(); });
    expect(values).toContain("new.example.com");
    expect(input().props.value).toBe("");
    await act(async () => { renderer.root.findAllByType("button")[0]!.props.onClick({ stopPropagation: vi.fn() }); });
    expect(values).toEqual(["new.example.com"]);
    await act(async () => renderer.unmount());
  });
});
