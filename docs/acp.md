# Berry ACP adapter

Berry implements Agent Client Protocol v1 with `@agentclientprotocol/sdk` 1.2.1. The adapter exposes initialize, authenticate, session new/load/list/prompt/cancel, message and reasoning streams, tool progress, approvals, image/context input, persisted replay, and session metadata updates.

## Run with Zed

Install the Berry CLI, then add a custom external agent in Zed settings:

```json
{
  "agent_servers": {
    "berry": {
      "type": "custom",
      "command": "berry",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

`berry acp` attaches to the desktop/app-server discovery socket when one is available. Otherwise it starts a private authenticated app-server against the normal Berry database, so Zed can launch it without opening the desktop first. Set `BERRY_HOST_SOCKET` and `BERRY_HOST_TOKEN` to target a non-default app-server, or `BERRY_DESKTOP_DB` to use another store.

Run `berry acp doctor` for the terminal authentication check advertised to ACP clients. It reports whether a model provider is enabled and tells the user where to configure one. The adapter itself never writes diagnostics to stdout because stdout carries ACP NDJSON frames.

Use `dev: open acp logs` in Zed to inspect the protocol exchange. A working smoke creates a thread, streams a response and tool row, presents a permission request, cancels a turn, closes Zed, then loads the same Berry session with its history replayed.

## Translation contract

- Berry text and reasoning deltas become ACP agent message and thought chunks.
- Berry tool start/update/end events become ACP tool calls with stable IDs, kinds, locations, raw input, and summaries.
- ACP permission outcomes map to Berry allow-once, allow-for-session, deny, and abort decisions.
- Berry structured questions use ACP form elicitation when the client advertises it. Choice-only questions fall back to a permission selector on stable ACP clients.
- ACP text, images, embedded text resources, and resource links become Berry input and attachments.
- ACP-provided MCP servers may use stdio or headerless HTTPS-SSE, matching Berry's existing transports. Streamable HTTP, OAuth, and authenticated SSE remain Phase 5 work and fail with actionable errors.

The official SDK client tests cover direct and NDJSON transports, replay/list, approval translation, cancellation, MCP forwarding, and private app-server startup. Live Zed and registry publication remain in `plans/human-blockers.md`.
