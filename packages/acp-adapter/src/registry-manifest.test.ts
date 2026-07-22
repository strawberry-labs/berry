import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ACP registry manifest template", () => {
  it("contains the required registry fields and launches the published Berry CLI in ACP mode", () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../distribution/acp/agent.json.template"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: "__BERRY_ACP_AGENT_ID__",
      name: "Berry",
      version: "__BERRY_VERSION__",
      repository: "https://github.com/__BERRY_GITHUB_REPOSITORY__",
      license: "__BERRY_LICENSE__",
      distribution: {
        npx: {
          package: "__BERRY_NPM_PACKAGE__@__BERRY_VERSION__",
          args: ["acp"],
        },
      },
    });
    expect(String(manifest.description)).not.toHaveLength(0);
    expect(manifest.auth).toBeUndefined();
  });
});
