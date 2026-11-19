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

## Organization connectors: keeping tools current

A web organization's custom MCP connectors keep a stored tool list (`organization_connectors.config.discoveredTools`). Hosted tasks start from it, and the worker updates it from the server without anyone reconnecting. The worker lists the server's tools live:

- whenever a task connects to the server, for example to run one of its tools;
- at turn start, in the background, when the stored list is more than 15 minutes old (`BERRY_MCP_TOOL_REFRESH_STALE_MS`). The turn never waits for it; it keeps using the stored list until the server answers, and gives up after 5 seconds;
- when `tool_search` finds nothing, or is asked for a tool name the list lacks, when a task calls a tool the list lacks, and when a call's arguments break the stored schema. Berry re-lists once, then searches or checks again before reporting a failure. A connector is re-listed at most once every 30 seconds in a task;
- when the server sends `notifications/tools/list_changed`.

Added, changed and removed tools are compared by name and a hash of each definition (input schema, description and safety hints); only a real change is saved. Saves only replace the list they compared against, and a claim in the connector row lets one worker at a time run the turn-start refresh. A failed refresh, including an expired or rejected credential, keeps the stored list silently and is retried after the claim expires (2 minutes). An empty list is never stored.

Organization-approved catalog servers expose every tool they list. Administrator-reviewed servers still expose only approved tool names: a new tool is stored for review and stays unavailable until an administrator approves it, while an approved tool's schema follows the server. Set `BERRY_MCP_TOOL_REFRESH=off` on the worker to keep every connector on its stored list.

## Live verification

Live provider verification requires server-owner accounts and is tracked in `plans/human-blockers.md` #14. The automated suite uses local stdio servers and HTTP OAuth fixtures for both grant types.
