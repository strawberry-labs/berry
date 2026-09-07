import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagementScreenProps } from "./management-context";
import { PersonalMcpScreen } from "./personal-mcp-screen";

vi.mock("./management-primitives", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./management-primitives")>();
  return {
    ...actual,
    ManagementPage: ({ children, actions }: any) => <main>{actions}{children}</main>,
    ManagementDialog: ({ open, title, children, footer }: any) => open ? <section role="dialog" aria-label={title}>{children}{footer}</section> : null,
    DataTable: ({ rows }: any) => <div>{rows.map((row: React.ReactNode[], i: number) => <div key={i}>{row.map((cell, j) => <span key={j}>{cell}</span>)}</div>)}</div>,
  };
});
vi.mock("@berry/desktop-ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => children,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuGroup: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: any) => <button data-menu-item onClick={onSelect}>{children}</button>,
}));
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });
const server = { id: "mcp-personal", name: "aesg-connect", url: "https://connect.aesg.com/", auth: "oauth", transport: "streamable-http", diagnostics: [] };
let renderer: ReactTestRenderer | undefined;
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.unstubAllGlobals(); });
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function mount(deletePersonalMcpServer: (...args: any[]) => Promise<{ ok: boolean }>) {
  vi.stubGlobal("window", { location: { search: "" }, setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
  let rows = [server];
  const client = {
    listPersonalMcpServers: vi.fn(async () => rows),
    listConnectors: vi.fn(async () => []),
    listConnectorRequests: vi.fn(async () => [{ id: "org-connector", kind: "custom_mcp", url: server.url, approvalStatus: "pending" }]),
    deletePersonalMcpServer: vi.fn(async (id: string) => { const result = await deletePersonalMcpServer(id); if (result.ok) rows = []; return result; }),
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => {
    renderer = create(<QueryClientProvider client={cache}><PersonalMcpScreen {...{ client, config: { mcpServers: [] }, permissions: [] } as unknown as ManagementScreenProps} /></QueryClientProvider>);
  });
  await settle();
  return client;
}
async function openDelete() {
  await act(async () => { renderer!.root.findAllByType("button").find((node) => node.props["data-menu-item"])!.props.onClick(); });
}
function confirm() { return renderer!.root.findAllByType("button").find((node) => node.props["aria-label"] === "Confirm delete MCP server")!; }

describe("personal MCP deletion", () => {
  it("lets members remove an approval-pending server after confirmation", async () => {
    const client = await mount(async () => ({ ok: true }));
    expect(JSON.stringify(renderer!.toJSON())).toContain("Awaiting approval");
    const menu = renderer!.root.findAllByType("button").find((node) => node.props["aria-label"] === "More options for aesg-connect")!;
    expect(menu.props.disabled).toBe(false);
    await openDelete();
    expect(client.deletePersonalMcpServer).not.toHaveBeenCalled();
    await act(async () => { confirm().props.onClick(); });
    await settle();
    expect(client.deletePersonalMcpServer).toHaveBeenCalledExactlyOnceWith("mcp-personal");
    expect(renderer!.root.findAllByType("button").some((node) => node.props["aria-label"] === "More options for aesg-connect")).toBe(false);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Removed aesg-connect from your MCP servers");
  });

  it("does not delete when confirmation is cancelled", async () => {
    const client = await mount(async () => ({ ok: true }));
    await openDelete();
    await act(async () => { renderer!.root.findAllByType("button").find((node) => node.children.includes("Cancel"))!.props.onClick(); });
    expect(client.deletePersonalMcpServer).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  it("retains the server and enables retry after a failed delete", async () => {
    await mount(async () => { throw new Error("Server unavailable"); });
    await openDelete();
    await act(async () => { confirm().props.onClick(); });
    await settle();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Server unavailable");
    expect(confirm().props.disabled).toBe(false);
    expect(renderer!.root.findAllByType("button").some((node) => node.props["aria-label"] === "More options for aesg-connect")).toBe(true);
  });

  it("prevents a duplicate delete while the first request is in flight", async () => {
    let finish!: (value: { ok: boolean }) => void;
    const client = await mount(() => new Promise((resolve) => { finish = resolve; }));
    await openDelete();
    await act(async () => { const click = confirm().props.onClick; click(); click(); });
    expect(client.deletePersonalMcpServer).toHaveBeenCalledTimes(1);
    expect(confirm().props.disabled).toBe(true);
    await act(async () => { finish({ ok: true }); });
  });
});
