import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connector, OrgPermission } from "@berry/shared";
import { McpApprovalQueue, canReadMcpApprovals } from "./admin-mcp-approvals-screen";
import type { ManagementScreenProps } from "./management-context";
import { adminAreaForTab } from "./management-navigation";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });
const permissions: OrgPermission[] = ["org:admin", "mcp:read", "mcp:write"];
const pending = { id: "connector-aesg", name: "aesg-connect", url: "https://connect.aesg.com/", kind: "custom_mcp", approvalStatus: "pending", transport: "streamable-http", authType: "oauth", authStrategy: "personal" } as Connector;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function mount(client: unknown, access = permissions) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => { renderer = create(<QueryClientProvider client={cache}><McpApprovalQueue client={client as ManagementScreenProps["client"]} tenantId="tenant-aesg" permissions={access} /></QueryClientProvider>); });
  await settle();
}
function button(label: string) { return renderer!.root.findAllByType("button").find((item) => item.props["aria-label"] === label)!; }

describe("MCP approvals", () => {
  it("exposes an MCP-only administration tab", () => {
    expect(adminAreaForTab("mcp-approvals").tabs).toContainEqual({ id: "mcp-approvals", label: "MCP approvals", permission: "mcp:read" });
    expect(canReadMcpApprovals(permissions)).toBe(true);
    expect(canReadMcpApprovals(["mcp:read", "mcp:write"])).toBe(false);
  });

  it.each(["approve", "reject"] as const)("can %s a member request without loading Google configuration", async (decision) => {
    let row = pending;
    const client = {
      listOrganizationConnectors: vi.fn(async () => [row]),
      approveOrganizationConnectorRequest: vi.fn(async () => (row = { ...pending, approvalStatus: "approved" })),
      rejectOrganizationConnectorRequest: vi.fn(async () => (row = { ...pending, approvalStatus: "rejected" })),
      googleConnectorConfiguration: vi.fn(async () => { throw new Error("Google unavailable"); }),
    };
    await mount(client);
    expect(JSON.stringify(renderer!.toJSON())).toContain("https://connect.aesg.com/");
    await act(async () => { button(`${decision === "approve" ? "Approve" : "Reject"} aesg-connect`).props.onClick(); });
    await settle();
    const action = decision === "approve" ? client.approveOrganizationConnectorRequest : client.rejectOrganizationConnectorRequest;
    expect(action).toHaveBeenCalledExactlyOnceWith("tenant-aesg", "connector-aesg");
    expect(client.googleConnectorConfiguration).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain("No MCP requests waiting for approval");
  });

  it("keeps a failed request reviewable and shows the error", async () => {
    const client = { listOrganizationConnectors: vi.fn(async () => [pending]), approveOrganizationConnectorRequest: vi.fn(async () => { throw new Error("Permission denied"); }) };
    await mount(client);
    await act(async () => { button("Approve aesg-connect").props.onClick(); });
    await settle();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Permission denied");
    expect(button("Approve aesg-connect").props.disabled).toBe(false);
  });

  it("does not allow read-only admins to mutate requests", async () => {
    const client = { listOrganizationConnectors: vi.fn(async () => [pending]), approveOrganizationConnectorRequest: vi.fn() };
    await mount(client, ["org:admin", "mcp:read"]);
    expect(button("Approve aesg-connect").props.disabled).toBe(true);
    await act(async () => { button("Approve aesg-connect").props.onClick(); });
    expect(client.approveOrganizationConnectorRequest).not.toHaveBeenCalled();
  });

  it("does not fetch organization requests for ordinary members", async () => {
    const client = { listOrganizationConnectors: vi.fn(async () => [pending]) };
    await mount(client, []);
    expect(client.listOrganizationConnectors).not.toHaveBeenCalled();
    expect(renderer!.toJSON()).toBeNull();
  });
});
