# Command hooks

Berry command hooks run at `PreToolUse`, `PostToolUse`, `TurnStart`, and `TurnEnd`. Hooks receive one JSON object on stdin and must write one JSON object to stdout. They run as child processes in the workspace directory with a bounded output buffer and timeout.

Hooks are loaded in this order:

1. `~/.berry/hooks.json`
2. `<workspace>/.berry/hooks.json`
3. `capabilities.hooks` from enabled, trusted plugins

## Configuration

Berry accepts a flat format:

```json
{
  "hooks": [
    {
      "id": "protect-main",
      "event": "PreToolUse",
      "matcher": "^(bash|write_file)$",
      "command": "node .berry/hooks/protect-main.mjs",
      "timeoutMs": 5000,
      "failurePolicy": "block"
    }
  ]
}
```

It also accepts the grouped ecosystem format:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^bash$",
        "hooks": [
          { "type": "command", "command": "node .berry/hooks/check-command.mjs", "timeout": 5 }
        ]
      }
    ]
  }
}
```

`matcher` is a regular expression against the tool name. `failurePolicy` is `block` or `continue`; it defaults to `block`. Timeouts, nonzero exits, invalid JSON, spawn errors, and output over 1 MiB are failures. Timeouts are limited to 60 seconds.

## Input and output

Every input includes `hookEventName`, `sessionId`, `turnId`, and `workspacePath`. Tool events also include `toolCallId`, `toolName`, and `input`. `PostToolUse` includes `output`; `TurnEnd` includes `status`.

`PreToolUse` may return:

```json
{ "decision": "block", "reason": "Command is not allowed on this branch" }
```

or rewritten arguments:

```json
{ "updatedInput": { "command": "pnpm check" } }
```

Berry validates rewritten arguments against the tool schema, then sends those exact arguments through `ToolGuard`. A hook cannot approve or bypass a guard decision.

`PostToolUse` may replace the structured `output`, set `isError`, or redact literal values recursively before the result is streamed or persisted:

```json
{ "redact": ["secret-value"] }
```

The Claude-style `hookSpecificOutput.permissionDecision`, `permissionDecisionReason`, and `updatedInput` fields are also accepted for pre-tool hooks.
