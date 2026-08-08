import { describe, expect, it, vi } from "vitest";
import { loadAdminConnectorData } from "./connectors-screen.tsx";

describe("admin connector loading", () => {
  it("does not request protected Google configuration for an MCP-only administrator", async () => {
    const listOrganizationConnectors = vi.fn(async () => []);
    const googleConnectorConfiguration = vi.fn(async () => { throw new Error("forbidden"); });

    const result = await loadAdminConnectorData({
      listOrganizationConnectors,
      googleConnectorConfiguration,
    }, "tenant-1", false);

    expect(listOrganizationConnectors).toHaveBeenCalledWith("tenant-1");
    expect(googleConnectorConfiguration).not.toHaveBeenCalled();
    expect(result).toMatchObject({ connectors: [], google: { configured: false } });
  });
});
