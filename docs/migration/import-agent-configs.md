# Import Agent Configs

Berry can import extension and MCP settings from other local agent tools, then keep the imported entries disabled or untrusted until a user reviews them.

## Supported source locations

Common sources include:

- Claude Code: `~/.claude.json` and `~/.claude/settings.json`
- Codex: `~/.codex/config.toml`
- ZCode: `~/.zcode/mcp.json` and `~/.config/zcode/mcp.json`
- Agents-compatible MCP config: `~/.agents/mcp.json`

## Import flow

Open Berry desktop and go to `Settings > MCP Servers`. Use the import action for the source you want to scan.

For each imported server:

1. Review the command, arguments, environment variables, and working directory.
2. Fill in local secret values in the Berry secret field instead of committing them to config files.
3. Run the server test.
4. Enable the server only after the test succeeds.
5. Add policy allowlist entries if the server should be available to a managed team.

## CLI checks

```sh
berry mcp list --json
berry doctor --json
```

## Confirm it works

- Imported servers appear in `Settings > MCP Servers`.
- Disabled imports stay disabled until explicitly enabled.
- The user must review each imported server before tool calls can run.
- `berry mcp list --json` shows the expected trusted/enabled state.
- Managed policy can still block imported servers that are not allowlisted.

## Notes

Imports copy configuration shape, not trust. Secrets should be re-entered through Berry, and team deployments should prefer signed plugin or managed policy distribution once the imported config is approved.
