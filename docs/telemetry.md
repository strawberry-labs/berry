# Telemetry, Crash Reports, and Support Bundles

Berry defaults telemetry and crash capture off for unmanaged users. A managed policy can keep telemetry optional, disable it, or require it for an organization.

## What can leave the machine

Local usage upload only runs after all of these are true:

- `telemetry.enabled` is true, or managed policy sets telemetry to required.
- The user is connected to a Berry platform session.
- The organization session advertises usage upload and an ingest URL.
- A usage signing key is configured.

Crash reports are recorded locally only when telemetry is enabled or required. They are not uploaded by the desktop host in v1; they become part of a support bundle only when the user creates and shares that bundle.

## Public telemetry schema

Usage upload sends signed events derived from local `usage_events` rows:

```json
{
  "schemaVersion": 1,
  "id": "usage_event_id",
  "type": "model|tool",
  "providerId": "provider id or null",
  "taskId": "task id or null",
  "sessionId": "session id or null",
  "name": "model or tool name",
  "status": "completed|denied|failed|null",
  "value": {
    "tokens": "counts and cost fields only",
    "servedProvider": "router provider when available",
    "servedModel": "router model when available"
  },
  "createdAt": "ISO timestamp"
}
```

The upload path excludes prompts, assistant text, file contents, diffs, terminal output, screenshots, API keys, and credential values.

## Crash report schema

`support.crashReport.record` stores local rows with:

```json
{
  "source": "renderer-crash",
  "level": "warn|error",
  "message": "redacted error message",
  "metadata": {
    "name": "Error class",
    "stack": "redacted stack summary",
    "componentStack": "redacted React component stack",
    "route": "renderer route",
    "fatal": false
  }
}
```

## Support bundle schema

`support.issueReport.create` and Help > Create issue bundle write a local JSON file:

```json
{
  "schemaVersion": 1,
  "createdAt": "ISO timestamp",
  "app": { "protocolVersion": 1, "hostPackage": "@berry/host" },
  "runtime": { "node": "v22.x", "platform": "darwin", "arch": "arm64" },
  "environment": { "presentKeys": ["BERRY_DESKTOP_DB"], "ci": false },
  "telemetry": { "enabled": false, "managed": "optional", "uploadRequiresPlatformSession": true },
  "configHash": "sha256 of scrubbed settings",
  "settings": [],
  "logs": [],
  "usageEvents": [],
  "crashReports": []
}
```

The scrubber redacts common token, password, authorization, API key, credential, and email patterns. Users should still review the JSON before attaching it to a public GitHub issue.
