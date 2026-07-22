# Network policy

Berry applies one network policy to agent commands, browser automation, web search and fetch, and remote HTTP MCP servers.

- Plan/read-only sessions have egress off.
- Ask and Auto-edit/workspace-write sessions have egress off by default. The user can enable it in Settings > General.
- Full-access/danger sessions skip the workspace egress toggle but still honor an explicit domain allowlist or stricter execpolicy rule.
- `network.domainAllowlist` optionally restricts browser, web, and remote MCP destinations to exact domains or `*.example.com` subdomain patterns. An empty list permits public domains when egress is on.

Shell egress-off enforcement remains in the macOS Seatbelt and Linux network namespace/seccomp sandbox. Host-side tools enforce the same state before approval or transport connection. Browser sessions pass the allowlist to agent-browser's request-time navigation policy so link clicks cannot bypass the initial URL check. Fetch retains DNS rebinding/SSRF checks, and remote MCP retains HTTPS, credential-in-URL, and private-address checks.

Execpolicy `network` rules are an additional layer. A matching `forbid` is final and runs before sandbox and origin approval checks. Domain allowance does not replace normal per-origin approvals.

The credential-masking proxy described in the platform plan is deferred. No proxy or implicit credential injection is implemented in this phase; credentials continue to use each provider/MCP transport's existing scoped path.
