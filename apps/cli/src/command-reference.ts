export const CLI_VERSION = "0.1.0";

export const CLI_COMMAND_NAMES = [
  "run",
  "ls",
  "resume",
  "doctor",
  "app-server",
  "acp",
  "skills",
  "commands",
  "plugins",
  "mcp",
  "policy",
  "login",
  "logout",
  "update",
  "tui",
  "version",
  "help",
] as const;

export type CommandName = (typeof CLI_COMMAND_NAMES)[number];

export interface CliOptionReference {
  flag: string;
  description: string;
}

export interface CliCommandReference {
  command: CommandName | string;
  usage: string;
  summary: string;
  details: string[];
  options: CliOptionReference[];
  examples: string[];
}

export const CLI_COMMANDS: CliCommandReference[] = [
  {
    command: "run",
    usage: "berry run -p <prompt> [--cwd <path>] [--mode ask|auto-edit|plan|full-access] [--kind chat|code] [--model <id>] [--provider <id>] [--json]",
    summary: "Start a new task or continue an existing task from the terminal.",
    details: [
      "Creates a workspace task when no task or session id is supplied.",
      "Use `--continue` or a positional task/session id to append a turn to an existing task.",
      "Provider and model selection use the configured desktop/host providers unless explicit flags are supplied.",
    ],
    options: [
      { flag: "-p, --prompt <text>", description: "Prompt text. If omitted, Berry reads piped stdin." },
      { flag: "--cwd <path>", description: "Workspace path to open before creating or resolving the task." },
      { flag: "--mode <mode>", description: "Permission mode: `ask`, `auto-edit`, `plan`, or `full-access`." },
      { flag: "--kind <kind>", description: "Conversation presentation: `chat` or `code`." },
      { flag: "--ui-mode <mode>", description: "Deprecated compatibility alias; `cowork` maps to `chat`." },
      { flag: "--provider <id>", description: "Configured provider id to use for the turn." },
      { flag: "--model <id>", description: "Model id to use with the selected provider." },
      { flag: "--attach <path>", description: "Attach a local text file to the turn. May be repeated." },
      { flag: "--resume <task-or-session-id>", description: "Append the prompt to a specific task or session." },
      { flag: "--continue", description: "Continue the most recent active task in the workspace." },
      { flag: "--json", description: "Emit machine-readable event JSON." },
    ],
    examples: [
      'berry run -p "Summarize the release notes" --cwd .',
      'berry run -p "Fix the failing test" --mode auto-edit --kind code',
    ],
  },
  {
    command: "resume",
    usage: "berry resume <task-or-session-id> [-p <prompt>] [--kind chat|code] [--json]",
    summary: "Inspect or continue an existing task/session.",
    details: [
      "Without a prompt, Berry prints the session messages.",
      "With a prompt, Berry sends a new turn to the selected task/session.",
    ],
    options: [
      { flag: "-p, --prompt <text>", description: "Prompt text to append to the session." },
      { flag: "--mode <mode>", description: "Permission mode for the appended turn." },
      { flag: "--kind <kind>", description: "Conversation presentation for the existing task." },
      { flag: "--ui-mode <mode>", description: "Deprecated compatibility alias; `cowork` maps to `chat`." },
      { flag: "--json", description: "Emit machine-readable JSON." },
    ],
    examples: [
      "berry resume task_123",
      'berry resume session_123 -p "Keep going"',
    ],
  },
  {
    command: "ls",
    usage: "berry ls [--cwd <path>] [--json]",
    summary: "List tasks known to the local Berry host.",
    details: ["Lists active workspace tasks and their active session ids."],
    options: [
      { flag: "--cwd <path>", description: "Limit the list to a workspace path." },
      { flag: "--json", description: "Emit task rows as JSON." },
    ],
    examples: ["berry ls --cwd .", "berry ls --json"],
  },
  {
    command: "doctor",
    usage: "berry doctor [--json]",
    summary: "Check local database, provider, and worktree health.",
    details: ["Returns exit code 2 when the installation is reachable but needs setup or cleanup."],
    options: [{ flag: "--json", description: "Emit the health report as JSON." }],
    examples: ["berry doctor", "berry doctor --json"],
  },
  {
    command: "app-server",
    usage: "berry app-server [--stdio] [--socket <path>]",
    summary: "Run the local host socket server used by desktop and attached CLI commands.",
    details: ["Use `--stdio` for protocol testing or `--socket` to bind a specific Unix socket/Windows named pipe path."],
    options: [
      { flag: "--stdio", description: "Serve JSON-RPC over stdio instead of a socket." },
      { flag: "--socket <path>", description: "Socket path to serve." },
    ],
    examples: ["berry app-server --socket /tmp/berry.sock"],
  },
  {
    command: "acp",
    usage: "berry acp [doctor] [--socket <path>]",
    summary: "Run or inspect the Agent Client Protocol bridge.",
    details: ["`berry acp doctor` validates bridge startup without opening a long-running server."],
    options: [{ flag: "--socket <path>", description: "Host socket path for the bridge." }],
    examples: ["berry acp doctor", "berry acp --socket /tmp/berry.sock"],
  },
  {
    command: "skills|commands|plugins|mcp",
    usage: "berry skills|commands|plugins|mcp list [--json]",
    summary: "List configured extension catalogs from the local host.",
    details: ["These commands share the same `list` subcommand and trust state rendering."],
    options: [{ flag: "--json", description: "Emit catalog entries as JSON." }],
    examples: ["berry skills list", "berry mcp list --json"],
  },
  {
    command: "policy",
    usage: "berry policy [status|sync] [--url <policy-url>] [--public-key <keyId=base64>] [--json]",
    summary: "Inspect or sync signed managed policy.",
    details: [
      "`status` prints the current local policy state.",
      "`sync` downloads or refreshes a signed policy bundle after signature verification.",
    ],
    options: [
      { flag: "--url <policy-url>", description: "Policy bundle URL to sync." },
      { flag: "--public-key <keyId=base64>", description: "Trusted Ed25519 public key. May be repeated." },
      { flag: "--json", description: "Emit policy status as JSON." },
    ],
    examples: [
      "berry policy status",
      "berry policy sync --url https://platform.example.test/policy.json --public-key prod=BASE64",
    ],
  },
  {
    command: "login",
    usage: "berry login [status] [--base-url <url>] [--code <oauth-code>] [--public-key <keyId=base64>] [--json]",
    summary: "Connect the local host to Berry platform auth and managed policy.",
    details: [
      "Without `--code`, Berry prints the authorization URL and PKCE verifier path.",
      "With `--code`, Berry exchanges the OAuth code and stores the platform session.",
    ],
    options: [
      { flag: "--base-url <url>", description: "Platform base URL." },
      { flag: "--code <oauth-code>", description: "OAuth authorization code returned by the platform." },
      { flag: "--public-key <keyId=base64>", description: "Trusted policy signing public key. May be repeated." },
      { flag: "--skip-usage-flush", description: "Skip the immediate usage flush after login." },
      { flag: "--json", description: "Emit login/status output as JSON." },
    ],
    examples: [
      "berry login --base-url https://platform.example.test",
      "berry login --code OAUTH_CODE --json",
      "berry login status",
    ],
  },
  {
    command: "logout",
    usage: "berry logout [--json]",
    summary: "Remove the stored platform session.",
    details: ["Local workspace data, tasks, and provider settings remain in place."],
    options: [{ flag: "--json", description: "Emit `{ ok: true }` on success." }],
    examples: ["berry logout", "berry logout --json"],
  },
  {
    command: "update",
    usage: "berry update [--manifest <url-or-path>] [--public-key <keyId=base64>] [--check] [--apply] [--json]",
    summary: "Check, stage, or apply a signed CLI update manifest.",
    details: [
      "Manifests are verified before artifact download.",
      "`--check` reports availability without staging; `--apply` replaces the installed binary after staging.",
    ],
    options: [
      { flag: "--manifest <url-or-path>", description: "Signed update manifest URL or local fixture path." },
      { flag: "--public-key <keyId=base64>", description: "Trusted Ed25519 update signing public key. May be repeated." },
      { flag: "--check", description: "Only report update availability." },
      { flag: "--apply", description: "Replace the installed CLI with the staged artifact." },
      { flag: "--install-path <path>", description: "Override the binary path to replace." },
      { flag: "--stage-dir <path>", description: "Override the update staging directory." },
      { flag: "--json", description: "Emit update status as JSON." },
    ],
    examples: [
      "berry update --check --manifest https://releases.example.test/berry-cli.json --public-key prod=BASE64",
      "berry update --manifest ./fixtures/cli-update.json --public-key test=BASE64 --apply",
    ],
  },
  {
    command: "tui",
    usage: "berry tui",
    summary: "Print the v1 status of the terminal UI.",
    details: ["The interactive TUI is planned after v1; use `berry run`, `berry resume`, or the desktop app today."],
    options: [],
    examples: ["berry tui"],
  },
  {
    command: "version",
    usage: "berry version",
    summary: "Print the Berry CLI version.",
    details: ["`berry --version` and `berry -V` are aliases."],
    options: [],
    examples: ["berry version", "berry --version"],
  },
];

export function isCliCommandName(value: string): value is CommandName {
  return (CLI_COMMAND_NAMES as readonly string[]).includes(value);
}

export function renderCliHelp(): string {
  const summaryLines = CLI_COMMANDS.map((command) => `  ${command.usage.replace(/^berry /, "")}`);
  return [
    "Usage: berry <command> [options]",
    "",
    "Commands:",
    ...summaryLines,
    "  any host command may use --attach-host [--socket <path>]",
  ].join("\n");
}

export function renderCliReferenceMarkdown(version = CLI_VERSION): string {
  const lines = [
    "# Berry CLI Reference",
    "",
    "Generated from `apps/cli/src/command-reference.ts`. Do not edit by hand.",
    "",
    `CLI version: \`${version}\``,
    "",
    "## Global Flags",
    "",
    "| Flag | Description |",
    "| --- | --- |",
    "| `--attach-host` | Use the already-running desktop host socket instead of starting an embedded host. |",
    "| `--socket <path>` | Override the host socket path for attached host/server commands. |",
    "| `--db <path>` | Override the local host database path for embedded-host commands. |",
    "| `--version`, `-V` | Print the CLI version. |",
    "",
    "## Commands",
    "",
  ];
  for (const command of CLI_COMMANDS) {
    lines.push(`### \`${command.command}\``, "", command.summary, "", "Usage:", "", "```sh", command.usage, "```", "");
    if (command.details.length > 0) {
      lines.push("Notes:", "");
      for (const detail of command.details) lines.push(`- ${detail}`);
      lines.push("");
    }
    if (command.options.length > 0) {
      lines.push("Options:", "", "| Flag | Description |", "| --- | --- |");
      for (const option of command.options) lines.push(`| \`${option.flag}\` | ${option.description} |`);
      lines.push("");
    }
    if (command.examples.length > 0) {
      lines.push("Examples:", "", "```sh", ...command.examples, "```", "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
