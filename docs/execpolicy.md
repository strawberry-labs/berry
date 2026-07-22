# Execpolicy

Berry evaluates shell commands before sandbox escalation and permission grants. The strictest matching decision wins: `allow < prompt < forbid`. A `forbid` result is final and never creates an approval request, including in full-access mode.

## Rule files

User rules are loaded from `$BERRY_HOME/execpolicy.json` or `~/.berry/execpolicy.json`. Workspace rules are loaded from `.berry/execpolicy.json` in the workspace. Both use this shape:

```json
{
  "rules": [
    {
      "id": "allow-project-tests",
      "kind": "exact",
      "decision": "allow",
      "pattern": ["npm", "test"],
      "description": "Run the project test suite"
    }
  ]
}
```

Kinds are `exact`, `prefix_rule`, `regex-lite`, and `network`. Regex-lite rejects lookaround, backreferences, atomic groups, and counted repetition. Managed, workspace, user, session, and built-in rules are all evaluated; a less strict rule cannot override a stricter one.

## Canonicalization

The canonicalizer unwraps `bash -lc`, removes leading environment assignments and `env`, and compares executable basenames. Compound operators, substitutions, malformed quoting, and unknown or execution-affecting flags prevent automatic allowance. Built-in rules allow a narrow set of read commands and permanently forbid destructive system and repository operations.

Choosing **Always allow** for a shell approval stores the exact canonical argv as a user-layer rule. Existing shell permission grants are translated into user-layer rules at runtime. Every tool call stores the complete execpolicy, sandbox, permission-mode, and grant decision trace in `tool_calls.decision_trace_json`.
