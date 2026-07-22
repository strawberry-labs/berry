# MCP servers

Berry supports MCP over stdio, legacy HTTP+SSE, and Streamable HTTP. Remote URLs must use HTTPS, cannot contain credentials, and cannot target literal private-network addresses.

## Add and import

Add servers in **Settings > MCP Servers**. Imported configurations are discovered from:

- `~/.claude.json` and `~/.claude/settings.json`
- `~/.codex/config.toml`
- `~/.zcode/mcp.json` and `~/.config/zcode/mcp.json`
- `~/.agents/mcp.json`

The import dialog shows the source file, command or URL, and transport before writing anything. Every imported server is disabled from agent use by its untrusted state until the user reviews and trusts it.

## OAuth

Remote servers can use OAuth authorization-code with PKCE or OAuth device authorization. Configure the public client ID, HTTPS endpoints, and scopes on the server. Berry opens the system browser, stores the returned token JSON under the server's `credentialRef` in the OS credential store, and passes it to `berry-host` only for MCP connection attempts. SQLite stores the credential reference and non-secret OAuth configuration, not access or refresh tokens.

Authorization-code callbacks use `berry://mcp/oauth/callback`. Device authorization shows the provider's user code and polls at the provider-specified interval. The **Authorize** action remains available for re-authentication; **Reconnect** retries health discovery with the stored credential.

## Health and startup

The settings row reports connection state, tool count, last error, and latency. Health probes cache tool names, descriptions, and input schemas. Agent turns use that cache immediately and connect in the background, so a slow or broken MCP server does not delay turn startup. Calling a cached tool waits for its own server connection and reports that server's failure without disabling other servers.

When the MCP catalog exceeds `mcp.toolDeferral.threshold` (default `40`) and the selected model supports tools, Berry initially exposes `tool_search`. A search reveals matching MCP tools to the active harness. The threshold and enable switch are in MCP settings.

## Live verification

Live provider verification requires server-owner accounts and is tracked in `plans/human-blockers.md` #14. The automated suite uses local stdio servers and HTTP OAuth fixtures for both grant types.
