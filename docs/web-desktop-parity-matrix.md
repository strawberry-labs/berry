# Berry desktop and web alignment matrix

Desktop is the shared visual reference, not a pixel-for-pixel contract. A web
surface is complete when its information architecture, primary workflow,
interaction state, accessibility, and Berry design language are roughly
90–95% aligned. Browser and native platform differences are expected.

| Surface | Shared behavior | Intentional platform difference | Status and evidence |
| --- | --- | --- | --- |
| Application shell | Shared `BerryShellFrame`, titlebar spacing, history controls, task route state, and design tokens. | Tauri owns native traffic lights, drag regions, and Finder/window actions. | Verified by desktop screenshots, real Tauri capture, and web shell E2E. |
| Conversation sidebar | One Chat/Code selector; Pinned, Projects, Chats order; five rows plus Show N more; expansion resets on collapse. | Web footer contains cloud account/sign-out actions. | Verified with 100+ conversation and keyboard tests in both engines. |
| Chat and Code | The selector mutates `conversationKind` on the same task and filters the sidebar. Runtime, tools, permissions, model, reasoning, transcript, queue, and active turn remain intact. | Code panes use native project paths on desktop and hosted sandbox APIs on web. | Verified by desktop `mode-layouts` and web kind-switch tests. |
| Thread | Shared `BerryThreadView`, messages, activity, approvals, questions, artifacts, editing, copy actions, errors, and streaming reducer. | Conversation forking is desktop-only. | Verified by desktop activity suite and web thread E2E. |
| Composer | Lexical editor, atomic mentions, attachments, permission/model/reasoning controls, and slash-command interception. | Desktop accepts authorized native paths; web accepts uploads and indexed sandbox paths. | Verified in Chromium, WebKit, and Tauri rendering. |
| Code workspace | Files, terminal, changes/review, and preview are available without changing runtime permissions. | Desktop uses Git/worktrees, PTY, and local browser sessions; web uses browser-safe sandbox endpoints and never exposes host paths. | Verified by desktop work-pane/PTY tests and web sandbox workspace E2E. |
| Search and lifecycle | Cross-kind search, deep links, rename, pin, archive/delete/restore, and help/diagnostics. | Native reveal/open actions remain desktop-only. | Verified by desktop and web lifecycle suites. |
| Queue and async state | Running turns survive navigation and profile changes; queued follow-ups, approvals, reconnect, retry, and terminal errors remain session-scoped. | Desktop host and cloud API own their respective execution lifecycles. | Verified by runtime/API tests and both browser engines. |
| Personal capabilities | Personal Skills and remote HTTP MCP show provenance, trust, health, enablement, and deletion. | Desktop can also discover local/project capabilities and stdio MCP. | Verified by desktop settings and web API/E2E tests. |
| Organization governance | Required/default-on/available/blocked capability precedence, RBAC, model policy, budgets, audit, SSO/SCIM, billing, and retention use API permissions. | Organization and platform administration are cloud-only; platform routes require explicit authorization. | Verified by API integration and routed settings E2E. |
| Secrets | Credentials are referenced, redacted, and excluded from audit metadata and client payloads. | Desktop user credentials use native credential storage; organization credentials remain server-side or in an in-memory connected channel. | Verified by security and policy-distribution tests. |
| Responsive and accessible UI | Keyboard workflows, named icon controls, live status/error states, focus restoration, reduced motion, themes, and forced colors. | Mobile uses an off-canvas sheet; native desktop retains its minimum window constraints. | Verified at 390×844, 768×1024, 820×640, 1280×720, and 1440×900 in Chromium/WebKit. |

## Release interpretation

Chromium screenshots are tolerant regression aids. WebKit functional tests and
the real Tauri shell are required because Berry Desktop ships in WKWebView.
Small font rasterization, native chrome, select-menu, scrollbar, and hosted
sandbox differences do not block release when the workflow and visual hierarchy
remain coherent.
