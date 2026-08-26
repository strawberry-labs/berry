import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  auth: vi.fn(),
  extractWWWAuthenticateParams: vi.fn(),
  refreshAuthorization: vi.fn(),
}));
const remote = vi.hoisted(() => ({
  fetch: vi.fn(),
  resolvePublicRemoteUrl: vi.fn(async (rawUrl: string) => new URL(rawUrl)),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => sdk);
vi.mock("./remote-fetch.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remote-fetch.ts")>()),
  createPublicRemoteFetch: vi.fn(() => remote.fetch),
  resolvePublicRemoteUrl: remote.resolvePublicRemoteUrl,
}));

import {
  refreshRemoteMcpOAuth,
  startRemoteMcpOAuth,
  validateRemoteMcpOAuthIssuer,
  type McpOAuthState,
} from "./mcp-oauth.ts";

describe("startRemoteMcpOAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    remote.fetch.mockResolvedValue(new Response(null, { status: 401 }));
    sdk.extractWWWAuthenticateParams.mockReturnValue({ scope: "challenge:read" });
    sdk.auth.mockImplementation(async (provider: { redirectToAuthorization(url: URL): void }) => {
      provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
  });

  it("prefers the resource challenge scope and keeps configured scope as fallback metadata", async () => {
    await startRemoteMcpOAuth({
      serverUrl: "https://mcp.example.com/mcp",
      callbackUrl: "https://berry.example.com/v1/connectors/mcp/oauth/callback",
      requestState: "request-state",
      scope: "configured:fallback",
    });

    const [provider, options] = sdk.auth.mock.calls[0] as [
      { clientMetadata: { scope?: string } },
      { scope?: string },
    ];
    expect(options.scope).toBe("challenge:read");
    expect(provider.clientMetadata.scope).toBe("configured:fallback");
  });
});

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

describe("validateRemoteMcpOAuthIssuer", () => {
  const state = {
    discoveryState: {
      authorizationServerUrl: "https://auth.example.com/",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com/",
        authorization_response_iss_parameter_supported: true,
      },
    },
  } as unknown as McpOAuthState;

  it("accepts the issuer discovered for the authorization server", () => {
    expect(() => validateRemoteMcpOAuthIssuer(state, "https://auth.example.com/")).not.toThrow();
  });

  it("rejects a missing or mismatched required issuer", () => {
    expect(() => validateRemoteMcpOAuthIssuer(state, undefined)).toThrow("did not include");
    expect(() => validateRemoteMcpOAuthIssuer(state, "https://attacker.example/")).toThrow("does not match");
  });
});
