# MCP servers

Berry supports MCP over stdio, legacy HTTP+SSE, and Streamable HTTP. Remote URLs must use HTTPS, cannot contain credentials, and cannot target literal private-network addresses.

## Native browser control in web chats and Automations

The bundled Berrycrawl connector gives **Berry Chat's own agent** a remote browser.
The agent plans each action, calls the browser tools through `use_tool`, reads the
result, and chooses its next action. The bundle includes 13 direct browser controls;
Berrycrawl's hosted browser-agent and recording-runner tools are excluded.

Configure the official connector on the API and worker with
`BERRY_CLOUD_MCP_SERVERS_JSON` and a server-side `BERRYCRAWL_API_KEY`:

```json
[{"id":"berrycrawl","name":"BerryCrawl","transport":"streamable-http","url":"https://api.berrycrawl.com/api/v1/mcp","credentialEnv":"BERRYCRAWL_API_KEY","enabled":true,"trusted":true}]
```

The key must have browser access in Berrycrawl. No key is sent to the chat client.
The API admits the reviewed catalog and credential capability for the selected
member; Automations use that same admission path as interactive chats. Worker
restarts preserve the admitted tool restrictions. Existing administrator overrides
for `cachedTools`, `allowedTools`, and `defaultTools` remain authoritative: update
those reviewed lists if they intentionally pin an older catalog.

Open, navigate, snapshot, click, type, press, scroll, screenshot, read, and close
are ready on the first model call. `tool_search` discovers tab controls, file
metadata, and batched actions with their exact schemas. The agent reuses the
returned `session_id`, refreshes element references after navigation, and closes
sessions it opens when done. Each automation should start a fresh, bounded session.
A user-supplied existing session stays open unless the user asks to close it.
Browser downloads are exposed as Berrycrawl file metadata; they are not
implicitly imported into the Berry Chat Library.

Screenshot image blocks reach native vision models as validated, bounded raster
images. Full results live in private artifact storage and can be restored after a
worker release without repeating the browser action. Set up the existing
`BERRY_ARTIFACT_S3_*` result store for this recovery path. The durable journal
contains image metadata and a scoped reference, never screenshot base64. A
text-only model uses DOM snapshots/read; missing or invalid pixels produce
explicit recovery guidance. Page content is untrusted source material.

Browser mutations follow the task's approval mode and are marked non-idempotent;
a successful mutation is deduplicated until the agent explicitly inspects the
same session again. This permits another scroll or click after a fresh observation
while refusing blind repeated writes. Open and close keep unconditional success
deduplication. After a lost response, the agent must inspect current state before
deciding what to do next. DOM reads and
screenshots retain their reviewed read-only policy. MCP connection startup stays
lazy, and browser calls allow the documented two-minute action timeout.

The browser definitions were reviewed against Berrycrawl's live official MCP catalog on 2026-11-04. Live tool
schemas, descriptions, and annotations are checked against the admitted catalog
before execution; an altered definition fails closed until reviewed again.

## Human browser takeover

Chats and Automations show a Browser card after a successful browser open. **View
browser** is read-only. **Pause & take control** waits for the current agent phase
to finish and saves a durable checkpoint before allowing mouse, keyboard, paste,
and tab controls. The agent can request the same checkpoint with
`request_browser_handoff` when it encounters a login, MFA, CAPTCHA, or another
human-only step. Closing the viewer or refreshing the page releases browser input
but keeps the agent paused. Use **Return to agent** explicitly when finished.

Return releases the viewer, checks that no other viewer still controls the
browser, and obtains a fresh DOM snapshot. The original run and chat continue
with that observation; earlier queued actions are cancelled rather than replayed
against stale element references. Worker and API restarts preserve the pause.
Automation history shows **Browser needs help**, prevents overlapping runs, and
links to the original chat. While Berry is open in the background, handoff events
can notify the user through their existing browser notification preferences.
Active owners and administrators can also use these controls in support view;
the selected member owns the run and the administrator remains the audit actor.

Migration 75 adds `turn_runs.browser_handoff`. Deploy API, worker and web together
after migrating. The server uses Berrycrawl's existing scoped-token and action
REST APIs alongside its MCP tools. Live viewer credentials are short lived and
kept out of model context, persisted messages, event streams, and browser storage.
Only the run owner (or an authorized support administrator) can request them.
Credentials authorize `live_view` or `live_control`; the account API key stays on
the server. Web CSP permits the official Berrycrawl WebSocket origin.

Browser lifetime and idle timeouts still apply during a checkpoint. The viewer
shows the known expiry. If a browser has ended, explicit handback tells the agent
to recover with a replacement when appropriate; it cannot restore that browser's
page state. An outage or a viewer still holding control leaves the run paused
for retry.

Berrycrawl already implements live view, scoped control, tabs, input, and an
exclusive human-control lock that rejects agent actions. Its MCP browser tools
intentionally omit signed viewer credentials and do not manage the Berry Chat
checkpoint lifecycle. That lifecycle is implemented by Berry Chat's own agent,
API, durable worker, and viewer. No separate hosted browser agent is introduced.
[Browser Use's human checkpoint guide](https://docs.browser-use.com/cloud/agent/human-in-the-loop)
also coordinates an idle agent, a live browser, and an explicit continuation in
the same session. Its [live preview guide](https://docs.browser-use.com/cloud/browser/live-preview)
documents browser embedding and the credential handling required for live URLs.

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
