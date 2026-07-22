# Plugin, Skill, and MCP Authoring

Berry supports three extension surfaces: Plugin bundles, skill directories, and MCP servers. Each imported item is untrusted until reviewed, enabled, and allowed by policy.

## Plugin authoring

Use a plugin when you need to ship a local bundle of skills, commands, apps, or MCP server metadata.

Minimum files:

```text
my-plugin/
  .codex-plugin/plugin.json
  skills/
```

The manifest should declare the plugin id, version, display name, capabilities, and any signature/update metadata. See `docs/plugins.md` for the full manifest and trust model.

Author checklist:

- Keep plugin ids stable across versions.
- Pin network endpoints and executable paths in the manifest.
- Sign release artifacts when distributing outside a local workspace.
- Test install, disable, update, and uninstall flows before publishing.

## Skill authoring

Use a skill when the extension is mostly instructions, domain workflow, templates, or helper scripts for an agent.

Minimum files:

```text
my-skill/
  SKILL.md
```

`SKILL.md` should state when the skill applies, what files or scripts it owns, and what verification steps prove the skill worked. See `docs/skills.md` for compatible import locations and update behavior.

## MCP authoring

Use MCP when Berry should call a tool server over a protocol boundary.

Author checklist:

- Prefer explicit JSON schemas for every tool argument.
- Keep destructive tools behind confirmations or managed policy.
- Provide a local fixture mode so tests do not need paid services.
- Document required environment variables beside the server config.

See `docs/mcp.md` for imported config paths, trust states, and audit behavior.

## Review before enabling

Before a plugin, Skill, or MCP server is enabled for real work:

- Read the manifest or `SKILL.md`.
- Confirm executable paths and network endpoints.
- Run the extension in a test workspace.
- Check audit logs for tool calls and denied operations.
- Add a managed policy allowlist entry if the extension is approved for a team.
