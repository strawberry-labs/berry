# Security policy

## Supported versions

Berry is pre-1.0. Security fixes land on `main` first. Once signed releases exist, the latest released `0.x` line receives security fixes; older unsigned builds are not supported.

## Reporting a vulnerability

Use GitHub Private Vulnerability Reporting for this repository when it is enabled. If private reporting is unavailable, open a public issue with a minimal description and ask for a private contact path before sharing exploit details, tokens, logs, customer data, or proof-of-concept code.

Do not include live API keys, update signing keys, OAuth tokens, customer prompts, private repository content, or database exports in a report. Redact secrets and include only the shortest reproduction needed to prove the issue.

## What to include

- Affected component: desktop, CLI, host socket, credential store, MCP, plugins, browser/web tools, updater, cloud API, extension, or mobile app.
- Impact: what an attacker can read, write, execute, impersonate, or bypass.
- Reproduction steps against fixtures, a test repository, or a local throwaway account.
- Logs with secrets removed.
- Suggested severity if you have one.

## Response targets

Berry uses these targets for incoming reports:

- Acknowledge: 3 business days.
- Triage and initial severity: 7 business days.
- Fix or mitigation plan for critical/high issues: 14 business days after triage.
- Public advisory or release note: after a fix is available and reporters have had a chance to verify it.

## Disclosure policy

Coordinated disclosure is expected for vulnerabilities that expose credentials, bypass approvals/sandbox policy, execute arbitrary code, bypass update signatures, break host socket authentication, or expand untrusted MCP/plugin capabilities. Berry credits reporters in the advisory unless they ask not to be named.

Public disclosure before a fix is available may put users at risk. If a report is already being exploited or the reporter cannot reach the maintainers, include only enough public detail for users to mitigate.

## Security boundaries

The current v1 security posture is documented in [docs/security-review.md](docs/security-review.md). Two boundaries are especially important:

- Windows local command sandboxing is approval-only for v1. Berry does not claim restricted-token or job-object containment on Windows.
- Desktop credentials are stored in an AES-256-GCM encrypted file today. A future OS keychain migration is recommended, but not shipped in v1.
