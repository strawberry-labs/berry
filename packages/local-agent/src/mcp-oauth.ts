import {
  auth,
  extractWWWAuthenticateParams,
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
    clientMetadataUrl?: string,
  ) {
    if (clientMetadataUrl) (this as OAuthClientProvider).clientMetadataUrl = clientMetadataUrl;
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
  clientMetadataUrl?: string;
}): Promise<McpOAuthStartResult> {
  const serverUrl = validatedRemoteMcpUrl(input.serverUrl);
  const challenge = await discoverMcpOAuthChallenge(serverUrl);
  const state: McpOAuthState = {};
  const provider = new PersistedOAuthProvider(
    input.callbackUrl,
    clientMetadata(input.callbackUrl, input.scope),
    state,
    input.requestState,
    input.clientInformation,
    input.clientMetadataUrl,
  );
  const result = await auth(provider, {
    serverUrl,
    ...(challenge.scope ? { scope: challenge.scope } : {}),
    ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
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
  clientMetadataUrl?: string;
}): Promise<McpOAuthState> {
  const serverUrl = validatedRemoteMcpUrl(input.serverUrl);
  const provider = new PersistedOAuthProvider(
    input.callbackUrl,
    clientMetadata(input.callbackUrl, input.scope),
    input.state,
    input.requestState,
    undefined,
    input.clientMetadataUrl,
  );
  const result = await auth(provider, {
    serverUrl,
    authorizationCode: input.authorizationCode,
    fetchFn: guardedOAuthFetch,
  });
  if (result !== "AUTHORIZED" || !input.state.tokens?.access_token) {
    throw new Error("MCP OAuth token exchange did not complete");
  }
  delete input.state.codeVerifier;
  return input.state;
}

export function validateRemoteMcpOAuthIssuer(state: McpOAuthState, issuer: string | undefined): void {
  const metadata = state.discoveryState?.authorizationServerMetadata as ({ issuer?: unknown; authorization_response_iss_parameter_supported?: unknown } | undefined);
  const expected = typeof metadata?.issuer === "string" ? metadata.issuer : null;
  const required = metadata?.authorization_response_iss_parameter_supported === true;
  if (!issuer) {
    if (required) throw new Error("MCP OAuth response did not include the authorization server issuer");
    return;
  }
  if (!expected || issuer !== expected) throw new Error("MCP OAuth response issuer does not match the discovered authorization server");
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

function clientMetadata(callbackUrl: string, scope?: string): OAuthClientMetadata {
  return {
    client_name: "Berry Connectors",
    redirect_uris: [callbackUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(scope ? { scope } : {}),
  };
}

async function guardedOAuthFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return createPublicRemoteFetch({ redirect: "manual", timeoutMs: 15_000 })(input, init);
}

async function discoverMcpOAuthChallenge(serverUrl: string | URL): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  let response: Response;
  try {
    response = await guardedOAuthFetch(serverUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "berry-oauth-discovery", method: "tools/list", params: {} }),
    });
  } catch {
    return {};
  }
  try {
    if (response.status !== 401) return {};
    const challenge = extractWWWAuthenticateParams(response);
    if (challenge.resourceMetadataUrl) await resolvePublicRemoteUrl(challenge.resourceMetadataUrl.toString());
    return {
      ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
      ...(challenge.scope ? { scope: challenge.scope } : {}),
    };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}
