# Local sandbox tiers

Berry maps permission modes to OS execution policies:

| Permission mode | Sandbox tier | Default network |
| --- | --- | --- |
| Plan | `read-only` | Off |
| Ask | `workspace-write` | Off |
| Auto-edit | `workspace-write` | Off |
| Full access | `danger-full-access` | Unrestricted |

The workspace-write network toggle is stored as `sandbox.workspaceWrite.network`. The active tier and enforcement mechanism are visible in the task header. `sandbox.status` reports whether the platform is enforced or approval-only.

## Enforcement

- macOS uses a deny-default Seatbelt profile through `/usr/bin/sandbox-exec`. Commands can read system files but can write only to canonical writable roots. Network is absent unless enabled.
- Linux uses bubblewrap when `/usr/bin/bwrap` or `/bin/bwrap` is installed: the root filesystem is read-only, writable roots are rebound, and `--unshare-net` blocks egress when required.
- Phase 11 launch decision: Windows remains approval-only for v1. Restricted-token enforcement is not shipped, because this repository cannot honestly prove it without a dedicated Windows implementation and CI evidence. Berry labels this through `sandbox.status` as `approval-only` with the reason "Windows restricted-token enforcement is not available yet; approvals remain active."
- If the expected mechanism is missing, Berry leaves approvals active and reports `approval-only` with a reason. It does not claim enforcement.

Agent shell, ripgrep, git, configured command, command hook, sub-agent, and PTY shell processes use the same policy wrapper. A tool may request `sandbox_permissions: "require_escalated"` with a justification. `ToolGuard` routes that request through approval and only an approved call uses the unsandboxed executor.

On Windows, Berry still applies execpolicy, permission prompts, persistent grants, protected-path checks, audit records, and the visible sandbox tier labels. It does not wrap local commands in a restricted token or job object, so `read-only` and `workspace-write` are approval/control-plane policies rather than OS-enforced containment on that platform.

## Protected paths

Direct write/edit/patch tools reject paths outside the workspace and protect `.git`, `.berry`, `.codex`, `.agents`, `.ssh`, credentials, private keys, and generated sidecar/build outputs unless the existing protected-write approval flow explicitly authorizes a direct file operation.

The shell preflight rejects commands that reference credential/config paths. Seatbelt additionally denies writes under `.git/hooks`, `.berry`, `.codex`, `.agents`, and `.ssh` even though the workspace root is writable. These checks remain active independently of model provider.
