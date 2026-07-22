# Plugins

Berry plugins are declarative capability packages. They can add commands, skills, MCP server definitions, and explicit command hooks, but they do not load renderer or runtime code in-process.

## Package layout

A folder or git repository must contain one of these manifest paths, checked in order:

1. `.berry-plugin/plugin.json`
2. `.codex-plugin/plugin.json`
3. `plugin.json`

The manifest requires `name`; `version` defaults to `0.0.0`. Capabilities may be declared under `capabilities.commands`, `capabilities.skills`, `capabilities.mcpServers`, and `capabilities.hooks`. Legacy top-level capability arrays remain supported.

Folder and git installs are copied to `~/.berry/plugins/<id>`. Git installs use a shallow, no-tags clone and record the resolved commit hash. Package hashing covers every regular file by sorted relative path and bytes. Symlinks are rejected, along with packages over 2,000 files or 50 MiB.

## Trust and signatures

Unsigned packages are installed untrusted. The settings review lists each command, skill, and MCP server before the user can trust that installation. Untrusted or disabled plugin capabilities are not expanded into the runtime.

A signed manifest uses this shape:

```json
{
  "signature": {
    "algorithm": "ed25519",
    "publicKey": "<base64 DER SPKI public key>",
    "value": "<base64 signature>"
  }
}
```

The signature input is canonical JSON for the whole manifest with `signature` removed: object keys sorted recursively, arrays left in order, UTF-8 encoded. A valid signature marks the install verified and trusted and records the SHA-256 public-key fingerprint. An invalid or unsupported signature rejects installation.

## Updates and removal

Update checks reread the original folder or shallow-clone the git URL. Changed packages are copied to a staging directory and surfaced with their version, commit, content hash, and capability diff. Applying an update requires the exact staged content hash; Berry re-hashes and re-verifies the staged package before replacing the managed copy.

Removing a plugin deletes its managed and staged files and its install record. Commands, skills, and MCP servers are derived from enabled, trusted install records, so they disappear immediately on removal.
