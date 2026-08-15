import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deployment onboarding styles", () => {
  it("keeps a visible keyboard outline on onboarding controls", () => {
    const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

    expect(css).toMatch(/body \.berry-onboarding-shell :is\(button, input, select\):focus-visible\s*\{[^}]*outline: 2px solid var\(--berry-focus\) !important;/s);
  });

  it("uses readable text tokens for compact setup details", () => {
    const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

    expect(css).toMatch(/\.berry-onboarding-checks article p\s*\{[^}]*color: var\(--berry-text-secondary\)/s);
    expect(css).toMatch(/\.berry-onboarding-connectors article p\s*\{[^}]*color: var\(--berry-text-secondary\)/s);
    expect(css).toMatch(/\.berry-onboarding-review span\s*\{[^}]*color: var\(--berry-text-secondary\)/s);
  });

  it("keeps mobile step buttons named when their visible labels collapse", () => {
    const source = readFileSync(new URL("./deployment-onboarding.tsx", import.meta.url), "utf8");

    expect(source).toContain('aria-label={item.label}');
  });

  it("uses the shared broken-logo fallback", () => {
    const source = readFileSync(new URL("./deployment-onboarding.tsx", import.meta.url), "utf8");

    expect(source).toContain("<DeploymentBrandImage logoUrl={logoUrl}");
  });
});
