---
name: google-calendar-mcp
description: Find common availability, schedule meetings, send Calendar invitations, add Google Meet, and update events using Berry’s Google Calendar connector.
---

# Google Calendar

Use `tool_search` with connector `Google Calendar` and the requested operation. Call the tool with the exact schema Berry returns, using `use_tool` when discovery activates a deferred tool. Use Berry’s **Reconnect** card if it requests sign-in. If write tools are missing because the connection is read-only, open **Settings → Connectors → Grant write access** and discover them again after the user grants access.

## Find a time

1. Resolve each required attendee’s email, the organizer, duration, date, and time zone. Use the task’s date and time zone to interpret relative dates. Find the organizer’s calendar with `google_calendar_list_calendars` when needed.
2. Use `google_calendar_query_freebusy` or `google_calendar_suggest_times`. Pass `calendarIds` for the organizer, every required attendee, and the room resource if the user wants to book one. Use an RFC 3339 `timeMin` and `timeMax`. For suggestions, pass `durationMinutes`. Check the whole interval. An absent entry or a calendar error means availability is unknown.
3. Give the user one sentence on the result before proposing the write. If the preferred time conflicts, show the closest suitable slot. When the user asked Berry to find a time, use the approval card for the proposed slot. Ask a separate question only when an essential detail is unresolved.

## Propose and confirm the event

- Use `google_calendar_create_event` with `calendarId: "primary"` for the connected user’s calendar unless the user specifies another. Pass `summary`, explicit-offset `start` and `end`, the IANA `timeZone`, and a stable `idempotencyKey` for this event. Pass validated email addresses in `attendees`. Use `sendUpdates: "all"` when sending invitations and `createMeet: true` when adding Google Meet.
- Use the room’s verified resource email as an attendee to request a booking. `location` supplies a display label. Check the room’s response before saying it is booked. Say when availability or booking is unconfirmed.
- Submit the exact write to show Berry’s inline approval card and wait for the decision. A decline ends that action. A changed proposal gets its own approval. After a successful create, give the event link, time, and attendee status. Use `google_calendar_get_event` to retrieve a pending conference link or room response.
- For updates, get the existing event and use its exact `eventId` and `calendarId` with `google_calendar_update_event`. Preserve the current title, start, and end when the user changes other fields. Calendar deletion is unavailable.
- Use the provider’s error to correct a confirmed rejection. If a write’s outcome is uncertain, read the same calendar with `google_calendar_list_events` or `google_calendar_get_event` and check for the intended event before proposing another write. Keep the same idempotency key for the same event.

Adapted from the Workspace CLI [find free time recipe](https://github.com/googleworkspace/cli/blob/main/skills/recipe-find-free-time/SKILL.md) and [Calendar insert workflow](https://github.com/googleworkspace/cli/blob/main/skills/gws-calendar-insert/SKILL.md).
