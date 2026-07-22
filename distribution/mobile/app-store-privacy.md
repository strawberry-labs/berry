# App Store Privacy Notes

Nothing leaves the device except data sent to endpoints the user configures: Berry managed cloud, a self-hosted Berry API, a custom OpenAI-compatible endpoint, or an explicit localhost/RFC1918 LAN endpoint.

No data is sold, used for third-party advertising, or used for cross-app tracking.

Data used for app functionality:
- Account/session token when the user signs in to Berry managed cloud or self-hosted Berry.
- Task titles, messages, tool rows, approvals, and approval decisions exchanged with the configured Berry API.
- Optional push token registered with the configured Berry API for approval notifications. API responses expose only `pushTokenLast4`.
- Direct endpoint chat prompts and responses sent only to the custom/LAN endpoint entered by the user. Direct endpoint mode does not support tools or approvals push.

Apple privacy manifest:
- `apps/mobile/PrivacyInfo.xcprivacy` declares no tracking, no tracking domains, no collected data types, and no required-reason accessed APIs.
