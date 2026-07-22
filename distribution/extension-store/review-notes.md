# Chrome Web Store Review Notes

Berry Companion is an MV3 side-panel extension for the Berry desktop/web/mobile agent harness.

Review account:
- Use a test Berry account or self-hosted fixture endpoint supplied by the release owner.
- Local desktop native messaging requires the 32-character extension ID to be entered in Berry Desktop under Settings > Security > Browser extension.

Permission notes:
- `activeTab` and `scripting` are used only after explicit user action.
- Optional `http://*/*` and `https://*/*` origin access is requested per site for full-page capture.
- Native messaging is disabled until the user enables the desktop bridge.
- No broad `host_permissions` key is present in `apps/extension/src/manifest.json`.

Functional smoke:
1. Build with `corepack pnpm --filter @berry/extension build`.
2. Load `apps/extension/dist` unpacked.
3. Open the side panel and connect to Berry platform or Desktop host.
4. Capture selected text into a task.
5. Trigger a pending approval and approve or deny it from the side panel.
