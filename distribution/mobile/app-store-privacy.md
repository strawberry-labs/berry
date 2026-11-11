# App Store Privacy Notes

Nothing leaves the device except data sent to endpoints the user configures: the self-hosted (or, later, hosted) Berry server the person paired the phone with by scanning a QR code from their signed-in web session.

No data is sold, used for third-party advertising, or used for cross-app tracking. The app developer does not receive any of it.

Data used for app functionality, sent only to the paired Berry server:
- A device session token issued at pairing, stored in the Keychain (Keystore on Android) with this-device-only access.
- The device model, platform, OS version and app version, shown to the person on the web when they approve the pairing and listed under Mobile devices.
- Task titles, prompts, messages, attachments the person chooses (photos, camera photos, files), approvals and answers exchanged with that server.

Not used in this version: push notifications, location, contacts, microphone, analytics or crash-reporting SDKs.

Apple privacy manifest:
- `apps/mobile/PrivacyInfo.xcprivacy` (mirrored in `expo.ios.privacyManifests`) declares no tracking, no tracking domains and no collected data types. Its required-reason APIs are the on-device ones React Native and Expo use: file timestamps (C617.1), the app's own UserDefaults (CA92.1) and system boot time for timers (35F9.1).
