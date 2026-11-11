# Mobile Store Review Notes

Berry for iPhone and Android is the companion app for an organization's
Berry workspace. It has the same tasks, projects, skills, library and
scheduled tasks as the Berry web app, built with native screens.

There is no account creation in the app. A person who is already signed in
to their organization's Berry on the web links the phone by scanning a QR
code, so there is also no in-app account deletion: accounts belong to the
organization and are managed by its administrators. Signing out or revoking
a phone (Settings → Mobile devices, on the phone or the web) deletes only
that phone's session.

Reviewer paths (demo server URL and web credentials are supplied in App
Store Connect / Play Console review notes, never in this repository):
1. On a computer, sign in to the demo Berry web app and choose
   "Get the mobile app" at the bottom of the sidebar.
2. On the phone, tap "Scan QR code" and scan the code. Without a second
   device, choose "Enter a code instead", type the server address and the
   8-character code shown on the computer.
3. Approve the sign-in on the computer. The phone opens the home screen.
4. Start a task from the composer, open the sidebar to switch tasks, and
   review the activity rows, approvals and questions in a task.
5. Open Settings → Mobile devices and sign out of the phone.

Scope:
- Tasks run on the organization's Berry server, not on the phone. No terminal is available on mobile; tool activity is shown read-only.
- Administrator and platform consoles open in the browser.
- Push notifications are not part of this version.

Permissions:
- Camera: scanning the sign-in code, and taking a photo the person chooses to attach.
- Photos: attaching photos the person picks. Files: attaching documents the person picks.

Privacy:
- Nothing leaves the device except data sent to endpoints the user configures: the Berry server whose QR code they scanned.
- The phone stores its session token in the iOS Keychain / Android Keystore, scoped to this device.

Human-owned credentials:
- Expo/EAS, App Store Connect, Apple Developer, Google Play Console credentials and the reviewer demo account are not stored in this repository.
