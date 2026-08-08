import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  auth: vi.fn(),
  refreshAuthorization: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => sdk);

import { refreshRemoteMcpOAuth, type McpOAuthState } from "./mcp-oauth.ts";

describe("refreshRemoteMcpOAuth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves the existing refresh token when the server does not rotate it", async () => {
    sdk.refreshAuthorization.mockResolvedValue({
      access_token: "new-access-token",
      token_type: "Bearer",
      expires_in: 3_600,
    });
    const state = {
      clientInformation: { client_id: "berry-client" },
      tokens: {
        access_token: "old-access-token",
        refresh_token: "stable-refresh-token",
        token_type: "Bearer",
      },
      discoveryState: {
        authorizationServerUrl: "https://auth.example.com/",
      },
    } as unknown as McpOAuthState;

    const refreshed = await refreshRemoteMcpOAuth({
      serverUrl: "https://mcp.example.com/mcp",
      callbackUrl: "https://berry.example.com/v1/connectors/mcp/oauth/callback",
      state,
    });

    expect(refreshed.tokens).toMatchObject({
      access_token: "new-access-token",
      refresh_token: "stable-refresh-token",
    });
  });

  it("stores a rotated refresh token returned by the server", async () => {
    sdk.refreshAuthorization.mockResolvedValue({
      access_token: "new-access-token",
      refresh_token: "rotated-refresh-token",
      token_type: "Bearer",
    });
    const state = {
      clientInformation: { client_id: "berry-client" },
      tokens: { access_token: "old", refresh_token: "old-refresh", token_type: "Bearer" },
      discoveryState: { authorizationServerUrl: "https://auth.example.com/" },
    } as unknown as McpOAuthState;

    const refreshed = await refreshRemoteMcpOAuth({
      serverUrl: "https://mcp.example.com/mcp",
      callbackUrl: "https://berry.example.com/v1/connectors/mcp/oauth/callback",
      state,
    });

    expect(refreshed.tokens?.refresh_token).toBe("rotated-refresh-token");
  });
});
