import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("extension manifest", () => {
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "manifest.json"), "utf8"));

  it("keeps page access explicit and per-origin", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(expect.arrayContaining(["activeTab", "nativeMessaging", "sidePanel", "scripting"]));
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
  });

  it("registers the side panel, context menu worker, and send-page command", () => {
    expect(manifest.side_panel.default_path).toBe("side-panel.html");
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.commands["send-page-to-berry"]).toBeDefined();
  });
});

