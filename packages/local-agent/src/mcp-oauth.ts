import {
  auth,
  refreshAuthorization,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { validatedRemoteMcpUrl } from "./mcp.ts";
import { createPublicRemoteFetch, resolvePublicRemoteUrl } from "./remote-fetch.ts";

export type McpOAuthState = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
};

export type McpOAuthStartResult = {
  authorizationUrl: string;
  state: McpOAuthState;
};

class PersistedOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;

  constructor(
    readonly redirectUrl: string,
    readonly clientMetadata: OAuthClientMetadata,
    private readonly oauthState: McpOAuthState,
    private readonly requestState: string,
    initialClientInformation?: OAuthClientInformationMixed,
  ) {
    if (initialClientInformation && !this.oauthState.clientInformation) {
      this.oauthState.clientInformation = initialClientInformation;
    }
  }

  state() { return this.requestState; }
  clientInformation() { return this.oauthState.clientInformation; }
  saveClientInformation(value: OAuthClientInformationMixed) { this.oauthState.clientInformation = value; }
  tokens() { return this.oauthState.tokens; }
  saveTokens(value: OAuthTokens) { this.oauthState.tokens = value; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(value: string) { this.oauthState.codeVerifier = value; }
  codeVerifier() { if (!this.oauthState.codeVerifier) throw new Error("MCP OAuth code verifier is missing"); return this.oauthState.codeVerifier; }
  saveDiscoveryState(value: OAuthDiscoveryState) { this.oauthState.discoveryState = value; }
  discoveryState() { return this.oauthState.discoveryState; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") delete this.oauthState.clientInformation;
    if (scope === "all" || scope === "tokens") delete this.oauthState.tokens;
    if (scope === "all" || scope === "verifier") delete this.oauthState.codeVerifier;
    if (scope === "all" || scope === "discovery") delete this.oauthState.discoveryState;
  }
}

export async function startRemoteMcpOAuth(input: {
  serverUrl: string;
  callbackUrl: string;
  requestState: string;
  scope?: string;
  clientInformation?: OAuthClientInformationMixed;
}): Promise<McpOAuthStartResult> {
  const serverUrl = validatedRemoteMcpUrl(input.serverUrl);
  const state: McpOAuthState = {};
  const provider = new PersistedOAuthProvider(
    input.callbackUrl,
    clientMetadata(input.callbackUrl),
    state,
    input.requestState,
    input.clientInformation,
  );
  const result = await auth(provider, {
    serverUrl,
    ...(input.scope ? { scope: input.scope } : {}),
    fetchFn: guardedOAuthFetch,
  });
  if (result !== "REDIRECT" || !provider.authorizationUrl) {
    throw new Error("MCP server did not start an interactive OAuth flow");
  }
  await resolvePublicRemoteUrl(provider.authorizationUrl.toString());
  return { authorizationUrl: provider.authorizationUrl.toString(), state };
}

export async function completeRemoteMcpOAuth(input: {
  serverUrl: string;
  callbackUrl: string;
  requestState: string;
  authorizationCode: string;
  state: McpOAuthState;
  scope?: string;
}): Promise<McpOAuthState> {
  const serverUrl = validatedRemoteMcpUrl(input.serverUrl);
  const provider = new PersistedOAuthProvider(
    input.callbackUrl,
    clientMetadata(input.callbackUrl),
    input.state,
    input.requestState,
  );
  const result = await auth(provider, {
    serverUrl,
    authorizationCode: input.authorizationCode,
    ...(input.scope ? { scope: input.scope } : {}),
    fetchFn: guardedOAuthFetch,
  });
  if (result !== "AUTHORIZED" || !input.state.tokens?.access_token) {
    throw new Error("MCP OAuth token exchange did not complete");
  }
  delete input.state.codeVerifier;
  return input.state;
}

export async function refreshRemoteMcpOAuth(input: {
  serverUrl: string;
  callbackUrl: string;
  state: McpOAuthState;
  scope?: string;
}): Promise<McpOAuthState> {
  validatedRemoteMcpUrl(input.serverUrl);
  const discovery = input.state.discoveryState;
  const client = input.state.clientInformation;
  const refreshToken = input.state.tokens?.refresh_token;
  if (!discovery || !client || !refreshToken) throw new Error("MCP OAuth refresh metadata is incomplete");
  const refreshed = await refreshAuthorization(discovery.authorizationServerUrl, {
    ...(discovery.authorizationServerMetadata ? { metadata: discovery.authorizationServerMetadata } : {}),
    clientInformation: client,
    refreshToken,
    ...(discovery.resourceMetadata?.resource ? { resource: new URL(discovery.resourceMetadata.resource) } : {}),
    fetchFn: guardedOAuthFetch,
  });
  input.state.tokens = {
    ...refreshed,
    refresh_token: refreshed.refresh_token ?? refreshToken,
  };
  return input.state;
}

function clientMetadata(callbackUrl: string): OAuthClientMetadata {
  return {
    client_name: "Berry Connectors",
    redirect_uris: [callbackUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

async function guardedOAuthFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return createPublicRemoteFetch({ redirect: "manual", timeoutMs: 15_000 })(input, init);
}
