# Mobile Store Review Notes

Berry mobile is an approvals-first companion for Berry tasks.

Reviewer paths:
1. Connect with a Berry managed-cloud account, a self-hosted Berry URL, or a custom OpenAI-compatible endpoint.
2. For local/LAN endpoints, enter an RFC1918 or localhost `http://` URL and confirm the plaintext warning.
3. Open the Approvals tab, review a pending approval, and approve or deny it.
4. Open Tasks and inspect a read-only Code-mode task. No terminal is available on mobile.
5. In direct endpoint mode, verify the UI states that tools, approvals push, and hosted task sync are unavailable.

Privacy:
- Nothing leaves the device except data sent to endpoints the user configures.
- Push notification payloads contain approval metadata only and no secrets.
- The API stores push tokens server-side and returns only `pushTokenLast4`.

Human-owned credentials:
- Expo/EAS, App Store Connect, Apple Developer APNs, Firebase/Google Play, and Play Console credentials are not stored in this repository.
