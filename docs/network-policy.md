# Network policy

## Web organization settings

Saved **Execution & network** policies are loaded on every new turn and replace
deployment network defaults. Without a saved policy, the deployment defaults
and approved MCP host additions retain their existing behavior. A saved policy
is authoritative: MCP approval does not override a network block. An explicitly
empty organization allowlist disables egress.

E2B sandbox reuse applies the admitted policy before executing commands, including
after a worker restart. A failed policy update stops the operation; it does not
continue with stale permissions or discard the workspace. Saving a setting
affects subsequent turns, not a command already running under an admitted policy.

For S3 resource links, allow the hostname actually present in the URL (for example
`s3.eu-west-1.amazonaws.com`), not just the MCP server hostname. Expired signed
URLs still need refreshing. TLS failures to known blocked hosts are reported as
network policy errors without exposing signed query parameters.

E2B cannot enforce arbitrary domain exclusions from unrestricted egress or from
a wider wildcard allowance. Such combinations fail with an actionable policy
error; use allowlist mode with explicit permitted hosts instead.

## Local sandbox policy

Berry applies one network policy to agent commands, browser automation, web search and fetch, and remote HTTP MCP servers.

- Plan/read-only sessions have egress off.
- Ask and Auto-edit/workspace-write sessions have egress off by default. The user can enable it in Settings > General.
- Full-access/danger sessions skip the workspace egress toggle but still honor an explicit domain allowlist or stricter execpolicy rule.
- `network.domainAllowlist` optionally restricts browser, web, and remote MCP destinations to exact domains or `*.example.com` subdomain patterns. An empty list permits public domains when egress is on.

Shell egress-off enforcement remains in the macOS Seatbelt and Linux network namespace/seccomp sandbox. Host-side tools enforce the same state before approval or transport connection. Browser sessions pass the allowlist to agent-browser's request-time navigation policy so link clicks cannot bypass the initial URL check. Fetch retains DNS rebinding/SSRF checks, and remote MCP retains HTTPS, credential-in-URL, and private-address checks.

Execpolicy `network` rules are an additional layer. A matching `forbid` is final and runs before sandbox and origin approval checks. Domain allowance does not replace normal per-origin approvals.

The credential-masking proxy described in the platform plan is deferred. No proxy or implicit credential injection is implemented in this phase; credentials continue to use each provider/MCP transport's existing scoped path.
