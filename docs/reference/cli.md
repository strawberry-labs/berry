# Berry CLI Reference

Generated from `apps/cli/src/command-reference.ts`. Do not edit by hand.

CLI version: `0.1.0`

## Global Flags

| Flag | Description |
| --- | --- |
| `--attach-host` | Use the already-running desktop host socket instead of starting an embedded host. |
| `--socket <path>` | Override the host socket path for attached host/server commands. |
| `--db <path>` | Override the local host database path for embedded-host commands. |
| `--version`, `-V` | Print the CLI version. |

## Commands

### `run`

Start a new task or continue an existing task from the terminal.

Usage:

```sh
berry run -p <prompt> [--cwd <path>] [--mode ask|auto-edit|plan|full-access] [--kind chat|code] [--model <id>] [--provider <id>] [--json]
```

Notes:

- Creates a workspace task when no task or session id is supplied.
- Use `--continue` or a positional task/session id to append a turn to an existing task.
- Provider and model selection use the configured desktop/host providers unless explicit flags are supplied.

Options:

| Flag | Description |
| --- | --- |
| `-p, --prompt <text>` | Prompt text. If omitted, Berry reads piped stdin. |
| `--cwd <path>` | Workspace path to open before creating or resolving the task. |
| `--mode <mode>` | Permission mode: `ask`, `auto-edit`, `plan`, or `full-access`. |
| `--kind <kind>` | Conversation presentation: `chat` or `code`. |
| `--ui-mode <mode>` | Deprecated compatibility alias; `cowork` maps to `chat`. |
| `--provider <id>` | Configured provider id to use for the turn. |
| `--model <id>` | Model id to use with the selected provider. |
| `--attach <path>` | Attach a local text file to the turn. May be repeated. |
| `--resume <task-or-session-id>` | Append the prompt to a specific task or session. |
| `--continue` | Continue the most recent active task in the workspace. |
| `--json` | Emit machine-readable event JSON. |

Examples:

```sh
berry run -p "Summarize the release notes" --cwd .
berry run -p "Fix the failing test" --mode auto-edit --kind code
```

### `resume`

Inspect or continue an existing task/session.

Usage:

```sh
berry resume <task-or-session-id> [-p <prompt>] [--kind chat|code] [--json]
```

Notes:

- Without a prompt, Berry prints the session messages.
- With a prompt, Berry sends a new turn to the selected task/session.

Options:

| Flag | Description |
| --- | --- |
| `-p, --prompt <text>` | Prompt text to append to the session. |
| `--mode <mode>` | Permission mode for the appended turn. |
| `--kind <kind>` | Conversation presentation for the existing task. |
| `--ui-mode <mode>` | Deprecated compatibility alias; `cowork` maps to `chat`. |
| `--json` | Emit machine-readable JSON. |

Examples:

```sh
berry resume task_123
berry resume session_123 -p "Keep going"
```

### `ls`

List tasks known to the local Berry host.

Usage:

```sh
berry ls [--cwd <path>] [--json]
```

Notes:

- Lists active workspace tasks and their active session ids.

Options:

| Flag | Description |
| --- | --- |
| `--cwd <path>` | Limit the list to a workspace path. |
| `--json` | Emit task rows as JSON. |

Examples:

```sh
berry ls --cwd .
berry ls --json
```

### `doctor`

Check local database, provider, and worktree health.

Usage:

```sh
berry doctor [--json]
```

Notes:

- Returns exit code 2 when the installation is reachable but needs setup or cleanup.

Options:

| Flag | Description |
| --- | --- |
| `--json` | Emit the health report as JSON. |

Examples:

```sh
berry doctor
berry doctor --json
```

### `app-server`

Run the local host socket server used by desktop and attached CLI commands.

Usage:

```sh
berry app-server [--stdio] [--socket <path>]
```

Notes:

- Use `--stdio` for protocol testing or `--socket` to bind a specific Unix socket/Windows named pipe path.

Options:

| Flag | Description |
| --- | --- |
| `--stdio` | Serve JSON-RPC over stdio instead of a socket. |
| `--socket <path>` | Socket path to serve. |

Examples:

```sh
berry app-server --socket /tmp/berry.sock
```

### `acp`

Run or inspect the Agent Client Protocol bridge.

Usage:

```sh
berry acp [doctor] [--socket <path>]
```

Notes:

- `berry acp doctor` validates bridge startup without opening a long-running server.

Options:

| Flag | Description |
| --- | --- |
| `--socket <path>` | Host socket path for the bridge. |

Examples:

```sh
berry acp doctor
berry acp --socket /tmp/berry.sock
```

### `skills|commands|plugins|mcp`

List configured extension catalogs from the local host.

Usage:

```sh
berry skills|commands|plugins|mcp list [--json]
```

Notes:

- These commands share the same `list` subcommand and trust state rendering.

Options:

| Flag | Description |
| --- | --- |
| `--json` | Emit catalog entries as JSON. |

Examples:

```sh
berry skills list
berry mcp list --json
```

### `policy`

Inspect or sync signed managed policy.

Usage:

```sh
berry policy [status|sync] [--url <policy-url>] [--public-key <keyId=base64>] [--json]
```

Notes:

- `status` prints the current local policy state.
- `sync` downloads or refreshes a signed policy bundle after signature verification.

Options:

| Flag | Description |
| --- | --- |
| `--url <policy-url>` | Policy bundle URL to sync. |
| `--public-key <keyId=base64>` | Trusted Ed25519 public key. May be repeated. |
| `--json` | Emit policy status as JSON. |

Examples:

```sh
berry policy status
berry policy sync --url https://platform.example.test/policy.json --public-key prod=BASE64
```

### `login`

Connect the local host to Berry platform auth and managed policy.

Usage:

```sh
berry login [status] [--base-url <url>] [--code <oauth-code>] [--public-key <keyId=base64>] [--json]
```

Notes:

- Without `--code`, Berry prints the authorization URL and PKCE verifier path.
- With `--code`, Berry exchanges the OAuth code and stores the platform session.

Options:

| Flag | Description |
| --- | --- |
| `--base-url <url>` | Platform base URL. |
| `--code <oauth-code>` | OAuth authorization code returned by the platform. |
| `--public-key <keyId=base64>` | Trusted policy signing public key. May be repeated. |
| `--skip-usage-flush` | Skip the immediate usage flush after login. |
| `--json` | Emit login/status output as JSON. |

Examples:

```sh
berry login --base-url https://platform.example.test
berry login --code OAUTH_CODE --json
berry login status
```

### `logout`

Remove the stored platform session.

Usage:

```sh
berry logout [--json]
```

Notes:

- Local workspace data, tasks, and provider settings remain in place.

Options:

| Flag | Description |
| --- | --- |
| `--json` | Emit `{ ok: true }` on success. |

Examples:

```sh
berry logout
berry logout --json
```

### `update`

Check, stage, or apply a signed CLI update manifest.

Usage:

```sh
berry update [--manifest <url-or-path>] [--public-key <keyId=base64>] [--check] [--apply] [--json]
```

Notes:

- Manifests are verified before artifact download.
- `--check` reports availability without staging; `--apply` replaces the installed binary after staging.

Options:

| Flag | Description |
| --- | --- |
| `--manifest <url-or-path>` | Signed update manifest URL or local fixture path. |
| `--public-key <keyId=base64>` | Trusted Ed25519 update signing public key. May be repeated. |
| `--check` | Only report update availability. |
| `--apply` | Replace the installed CLI with the staged artifact. |
| `--install-path <path>` | Override the binary path to replace. |
| `--stage-dir <path>` | Override the update staging directory. |
| `--json` | Emit update status as JSON. |

Examples:

```sh
berry update --check --manifest https://releases.example.test/berry-cli.json --public-key prod=BASE64
berry update --manifest ./fixtures/cli-update.json --public-key test=BASE64 --apply
```

### `tui`

Print the v1 status of the terminal UI.

Usage:

```sh
berry tui
```

Notes:

- The interactive TUI is planned after v1; use `berry run`, `berry resume`, or the desktop app today.

Examples:

```sh
berry tui
```

### `version`

Print the Berry CLI version.

Usage:

```sh
berry version
```

Notes:

- `berry --version` and `berry -V` are aliases.

Examples:

```sh
berry version
berry --version
```
