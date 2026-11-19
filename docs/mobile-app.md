# Berry mobile app

Berry for iPhone and Android is a native companion to an organization's Berry
web app. It has the same structure as the web: the sidebar with projects and
tasks, the home composer, task threads with live activity, Skills, Library,
Scheduled tasks and personal Settings. It is built with React Native (Expo)
and native screens, not a web view.

The app has no sign-up or password sign-in. A person who is signed in to
Berry on the web links their phone by scanning a QR code. Any organization can
use the same store build with its own self-hosted Berry, because the code
tells the phone which server to use.

## How pairing works

1. On the web, the person chooses **Get the mobile app** at the bottom of the
   sidebar, above their profile. The web asks the API for a pairing
   (`POST /v1/mobile/pairings`).
2. The dialog shows a QR code for
   `berry://pair?v=1&s=<server>&a=<api>&i=<pairing id>&k=<secret>`. Underneath is
   an 8-character manual code with the server address, for when the camera
   can't be used.
3. The phone scans the code (or the person types the code), checks the
   server's `/v1/mobile/server-info` for compatibility, and **claims** the
   pairing with its device description. The web dialog then asks
   "Sign in on <device>?" and shows the model, OS, app version and network
   address.
4. The person approves on the web. The phone, which is long-polling, receives
   a device session exactly once and stores it in the Keychain/Keystore
   (this device only).

What the QR code is, and isn't:

- It holds a single-use secret that expires after 2 minutes, never a session
  token. A leaked photo of an old code is useless.
- A claim is not enough to sign in. The browser session that showed the code
  has to approve it, within 3 minutes of the claim.
- Only a web session can create or approve pairings, so a phone can't pair
  further phones.
- Creating, claiming and polling are rate-limited per user, per address and
  per organization. Every step is audited (`mobile.pairing.created`,
  `mobile.pairing.approved`, `mobile.pairing.denied`, `mobile.device.paired`,
  `mobile.device.revoked`, `mobile.session.signed_out`).
- Phone sessions (`client_kind = mobile`) are accepted only as bearer tokens.
  Web sessions are accepted only as cookies, so neither can be replayed as the
  other.

People can see and revoke their phones under **Settings → Mobile devices** on
the web or the phone. Administrators can see and revoke a member's phones from
**Admin → Members → Phones**. Revoking a phone deletes its session on the
server; the phone signs out the next time it calls the API.

There is no account creation in the app, so there is no in-app account
deletion either. Accounts belong to the organization and are managed by its
administrators.

## Self-hosting configuration

Behind the bundled proxy the web app and the API share one origin, and pairing
needs no extra settings. Set these only when your layout differs:

| Variable | Service | Purpose |
| --- | --- | --- |
| `BERRY_WEB_PUBLIC_URL` | api | The web address shown to people and encoded in the QR code. Defaults to the API origin. |
| `BERRY_PUBLIC_API_URL` | api | Where phones reach `/v1` when it isn't the web origin (split deployments, LAN testing). Defaults to the origin of `BERRY_AUTH_BASE_URL`. |
| `BERRY_MOBILE_MINIMUM_APP_VERSION` | api | Oldest app version allowed to pair. Defaults to `0.1.0`. Raise it to force updates. |
| `BERRY_VERSION` | api | The server version reported to phones. |
| `BERRY_MOBILE_APP_STORE_URL`, `BERRY_MOBILE_PLAY_STORE_URL` | web | Optional store links shown in the "Get the mobile app" dialog. |

Phones must reach the API over HTTPS. Plain `http://` is accepted only for
`localhost` and private-network addresses in development builds.

Administrators can turn the mobile app off for the organization with
**Allow the Berry mobile app** in the authentication section of
**Admin → Policy**. When it is off, new pairings are
refused and existing phone sessions are rejected.

## Developing the app

The app lives in `apps/mobile`. Code shared with the web is in two packages:

- `@berry/client-core` holds DOM-free client logic: the stream reducer, thread
  turn grouping and segmenting, activity-row descriptors, mentions, plan
  progress, queued follow-ups, model and reasoning helpers, and formatting.
  The web and desktop thread views import the same modules, so a turn reads
  the same on every surface.
- `@berry/design-tokens` is generated from the web's CSS variables
  (`packages/desktop-ui/src/styles/globals.css`, `apps/desktop/src/globals.css`,
  `apps/web/src/styles.css`). Run `pnpm --filter @berry/design-tokens generate`
  after changing a `--berry-*` variable.

Run it on the iOS Simulator:

```sh
pnpm install
pnpm --filter @berry/mobile exec expo prebuild --platform ios
cd apps/mobile/ios && xcodebuild -workspace Berry.xcworkspace -scheme Berry \
  -configuration Debug -sdk iphonesimulator -derivedDataPath build/derived build
pnpm --filter @berry/mobile exec expo start --port 8081
```

Then install `apps/mobile/ios/build/derived/Build/Products/Debug-iphonesimulator/Berry.app`
on a booted simulator. `ios/` and `android/` are generated and ignored by git.

Notes:

- `patches/expo-modules-jsi@57.1.1.patch` makes `expo-modules-jsi` build
  with the Swift 6 compiler in current Xcode. Drop it once Expo ships the fix.
- Metro pins `react` to the app's copy (`metro.config.cjs`) because the
  workspace hoists a second React for the web.
- Icons are deep-imported from `@hugeicons/core-free-icons/<Name>`. Metro does
  not tree-shake, so importing the package index adds about 7 MB to the bundle.

Checks:

```sh
pnpm --filter @berry/mobile typecheck
pnpm --filter @berry/mobile test
pnpm --filter @berry/client-core test
node scripts/verify-store-review.mjs
```

### Testing against a local stack

To pair a simulator with a local server, run the API with
`BERRY_WEB_PUBLIC_URL=http://127.0.0.1:<web port>` and
`BERRY_PUBLIC_API_URL=http://127.0.0.1:<api port>`, then open the "Get the
mobile app" dialog on the web. The simulator camera can't scan, so either type
the manual code or open the QR payload as a deep link:

```sh
xcrun simctl openurl booted 'berry://pair?v=1&s=…&a=…&i=…&k=…'
```

Turns run on the worker, so a full local run also needs Redis and
`apps/worker`. Point both the API and the worker at the same
OpenAI-compatible endpoint (`BERRY_ROUTER_INFERENCE_BASE_URL`, with
`BERRY_API_MODEL_MODE=live` on the worker) and use
`BERRY_SANDBOX_PROVIDER=fixture` when Docker isn't available.

## Not in this version

- Push notifications.
- The organization admin and platform consoles. Admins get a link that opens
  them in the browser.
- Editing earlier prompts, forking tasks, and terminal or file-editing tools.
  Tool activity is shown read-only, as on the web.
