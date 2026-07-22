# Berry Host Protocol

Generated from `packages/shared/src/index.ts`. Do not edit by hand.

Protocol version: `1`

## Handshake

Clients send their `protocolVersion` in `host.handshake`. The host returns its protocol version and capability list. An incompatible major version fails with `protocol_mismatch`; clients must stop before issuing any mutating call.

Socket clients must also send the token from `<socket-path>.token`. Missing or invalid tokens fail with `unauthorized`.

## Methods

### `agent.cancel`

Params:

```json
{
  "$ref": "#/definitions/agent.cancel.params",
  "definitions": {
    "agent.cancel.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        },
        "owner": {
          "type": "string"
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/agent.cancel.result",
  "definitions": {
    "agent.cancel.result": {
      "type": "object",
      "properties": {
        "cancelled": {
          "type": "boolean"
        }
      },
      "required": [
        "cancelled"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `agent.create`

Params:

```json
{
  "$ref": "#/definitions/agent.create.params",
  "definitions": {
    "agent.create.params": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/agent.create.result",
  "definitions": {
    "agent.create.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "systemPrompt": {
          "type": "string",
          "default": ""
        },
        "model": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "color": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "tools": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": [
            "*"
          ]
        },
        "disallowedTools": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "skills": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "permissionMode": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "maxTurns": {
          "type": [
            "number",
            "null"
          ],
          "default": null
        },
        "scope": {
          "type": "string",
          "enum": [
            "built-in",
            "user",
            "workspace"
          ]
        },
        "path": {
          "type": "string"
        },
        "enabled": {
          "type": "boolean",
          "default": true
        },
        "readOnly": {
          "type": "boolean",
          "default": false
        }
      },
      "required": [
        "id",
        "name",
        "description",
        "scope",
        "path"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `agent.delete`

Params:

```json
{
  "$ref": "#/definitions/agent.delete.params",
  "definitions": {
    "agent.delete.params": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/agent.delete.result",
  "definitions": {
    "agent.delete.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `agent.enable`

Params:

```json
{
  "$ref": "#/definitions/agent.enable.params",
  "definitions": {
    "agent.enable.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "enabled": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "enabled"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/agent.enable.result",
  "definitions": {
    "agent.enable.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `agent.followUp`

Params:

```json
{
  "$ref": "#/definitions/agent.followUp.params",
  "definitions": {
    "agent.followUp.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        },
        "input": {
          "type": "string"
        },
        "owner": {
          "type": "string"
        }
      },
      "required": [
        "sessionId",
        "input"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/agent.followUp.result",
  "definitions": {
    "agent.followUp.result": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "number"
        },
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "array",
          "items": {
            "$ref": "#/definitions/agent.followUp.result"
          }
        },
        {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/definitions/agent.followUp.result"
          }
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `agent.getUserDirectory`

Params:

```json
{
  "$ref": "#/definitions/agent.getUserDirectory.params",
  "definitions": {
    "agent.getUserDirectory.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/agent.getUserDirectory.result",
  "definitions": {
    "agent.getUserDirectory.result": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `agent.list`

Params:

```json
{
  "$ref": "#/definitions/agent.list.params",
  "definitions": {
    "agent.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "workspaceId": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/agent.list.result",
  "definitions": {
    "agent.list.result": {
      "type": "object",
      "properties": {
        "agents": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "description": {
                "type": "string"
              },
              "systemPrompt": {
                "type": "string",
                "default": ""
              },
              "model": {
                "type": [
                  "string",
                  "null"
                ],
                "default": null
              },
              "color": {
                "type": [
                  "string",
                  "null"
                ],
                "default": null
              },
              "tools": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "default": [
                  "*"
                ]
              },
              "disallowedTools": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "default": []
              },
              "skills": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "default": []
              },
              "permissionMode": {
                "type": [
                  "string",
                  "null"
                ],
                "default": null
              },
              "maxTurns": {
                "type": [
                  "number",
                  "null"
                ],
                "default": null
              },
              "scope": {
                "type": "string",
                "enum": [
                  "built-in",
                  "user",
                  "workspace"
                ]
              },
              "path": {
                "type": "string"
              },
              "enabled": {
                "type": "boolean",
                "default": true
              },
              "readOnly": {
                "type": "boolean",
                "default": false
              }
            },
            "required": [
              "id",
              "name",
              "description",
              "scope",
              "path"
            ],
            "additionalProperties": false
          }
        },
        "diagnostics": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              },
              {
                "type": "null"
              },
              {
                "type": "array",
                "items": {
                  "$ref": "#/definitions/agent.list.result/properties/diagnostics/items"
                }
              },
              {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/definitions/agent.list.result/properties/diagnostics/items"
                }
              }
            ]
          },
          "default": []
        }
      },
      "required": [
        "agents"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `agent.steer`

Params:

```json
{
  "$ref": "#/definitions/agent.steer.params",
  "definitions": {
    "agent.steer.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        },
        "input": {
          "type": "string"
        },
        "owner": {
          "type": "string"
        }
      },
      "required": [
        "sessionId",
        "input"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/agent.steer.result",
  "definitions": {
    "agent.steer.result": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "number"
        },
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "array",
          "items": {
            "$ref": "#/definitions/agent.steer.result"
          }
        },
        {
          "type": "object",
          "additionalProperties": {
            "$ref": "#/definitions/agent.steer.result"
          }
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `agent.takeover`

Params:

```json
{
  "$ref": "#/definitions/agent.takeover.params",
  "definitions": {
    "agent.takeover.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        },
        "owner": {
          "type": "string"
        }
      },
      "required": [
        "sessionId",
        "owner"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/agent.takeover.result",
  "definitions": {
    "agent.takeover.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "previousOwner": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "ok",
        "previousOwner"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `agent.turn`

Params:

```json
{
  "$ref": "#/definitions/agent.turn.params",
  "definitions": {
    "agent.turn.params": {
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string"
        },
        "input": {
          "type": "string"
        },
        "continueInterruptedTurn": {
          "type": "boolean"
        },
        "owner": {
          "type": "string"
        },
        "mcpServers": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "transport": {
                "type": "string",
                "enum": [
                  "stdio",
                  "http-sse"
                ]
              },
              "command": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "args": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "default": []
              },
              "url": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "env": {
                "type": "object",
                "additionalProperties": {
                  "type": "string"
                },
                "default": {}
              }
            },
            "required": [
              "id",
              "name",
              "transport",
              "command",
              "url"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "taskId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/agent.turn.result",
  "definitions": {
    "agent.turn.result": {
      "type": "object",
      "properties": {
        "turnId": {
          "type": "string"
        },
        "sessionId": {
          "type": "string"
        }
      },
      "required": [
        "turnId",
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `agent.turnState`

Params:

```json
{
  "$ref": "#/definitions/agent.turnState.params",
  "definitions": {
    "agent.turnState.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/agent.turnState.result",
  "definitions": {
    "agent.turnState.result": {
      "type": "object",
      "properties": {
        "active": {
          "type": "boolean"
        },
        "turnId": {
          "type": [
            "string",
            "null"
          ]
        },
        "bufferedEvents": {
          "type": "array",
          "items": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "turn.start"
                  },
                  "turnId": {
                    "type": "string"
                  },
                  "continuation": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "kind",
                  "turnId"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "message.start"
                  },
                  "messageId": {
                    "type": "string"
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "system",
                      "user",
                      "assistant",
                      "tool"
                    ]
                  }
                },
                "required": [
                  "kind",
                  "messageId",
                  "role"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "message.delta"
                  },
                  "messageId": {
                    "type": "string"
                  },
                  "delta": {
                    "type": "string"
                  },
                  "channel": {
                    "type": "string",
                    "enum": [
                      "text",
                      "reasoning"
                    ],
                    "default": "text"
                  }
                },
                "required": [
                  "kind",
                  "messageId",
                  "delta"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "message.end"
                  },
                  "messageId": {
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "messageId"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "tool.start"
                  },
                  "toolCallId": {
                    "type": "string"
                  },
                  "name": {
                    "type": "string"
                  },
                  "title": {
                    "type": "string"
                  },
                  "args": {
                    "anyOf": [
                      {
                        "type": "string"
                      },
                      {
                        "type": "number"
                      },
                      {
                        "type": "boolean"
                      },
                      {
                        "type": "null"
                      },
                      {
                        "type": "array",
                        "items": {
                          "$ref": "#/definitions/agent.turnState.result/properties/bufferedEvents/items/anyOf/4/properties/args"
                        }
                      },
                      {
                        "type": "object",
                        "additionalProperties": {
                          "$ref": "#/definitions/agent.turnState.result/properties/bufferedEvents/items/anyOf/4/properties/args"
                        }
                      }
                    ]
                  },
                  "parentToolCallId": {
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "toolCallId",
                  "name"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "tool.update"
                  },
                  "toolCallId": {
                    "type": "string"
                  },
                  "detail": {
                    "type": "string"
                  },
                  "parentToolCallId": {
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "toolCallId"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "tool.end"
                  },
                  "toolCallId": {
                    "type": "string"
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "completed",
                      "failed",
                      "denied"
                    ]
                  },
                  "durationMs": {
                    "type": "number"
                  },
                  "summary": {
                    "type": "string"
                  },
                  "parentToolCallId": {
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "toolCallId",
                  "status"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "approval.request"
                  },
                  "approvalId": {
                    "type": "string"
                  },
                  "approvalKind": {
                    "type": "string",
                    "enum": [
                      "file-edit",
                      "shell",
                      "terminal",
                      "mcp",
                      "browser",
                      "credential",
                      "workspace-trust"
                    ]
                  },
                  "title": {
                    "type": "string"
                  },
                  "detail": {
                    "type": "string"
                  },
                  "subject": {
                    "type": "string"
                  },
                  "rawDetail": {
                    "type": "string"
                  },
                  "diff": {
                    "type": "string"
                  },
                  "destructive": {
                    "type": "boolean"
                  },
                  "openWorld": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "kind",
                  "approvalId",
                  "approvalKind",
                  "title"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "question.request"
                  },
                  "questionId": {
                    "type": "string"
                  },
                  "toolCallId": {
                    "type": "string"
                  },
                  "question": {
                    "type": "string"
                  },
                  "options": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "label": {
                          "type": "string"
                        },
                        "description": {
                          "type": "string"
                        }
                      },
                      "required": [
                        "label"
                      ],
                      "additionalProperties": false
                    },
                    "default": []
                  },
                  "multi": {
                    "type": "boolean",
                    "default": false
                  }
                },
                "required": [
                  "kind",
                  "questionId",
                  "toolCallId",
                  "question"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "question.answered"
                  },
                  "questionId": {
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "questionId"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "usage"
                  },
                  "inputTokens": {
                    "type": "number"
                  },
                  "outputTokens": {
                    "type": "number"
                  },
                  "model": {
                    "type": "string"
                  },
                  "requestedModel": {
                    "type": "string"
                  },
                  "servedProvider": {
                    "type": "string"
                  },
                  "servedModel": {
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "inputTokens",
                  "outputTokens"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "session.note"
                  },
                  "note": {
                    "type": "string",
                    "enum": [
                      "compacted",
                      "resumed",
                      "forked",
                      "rewound",
                      "steered",
                      "followed-up"
                    ]
                  },
                  "detail": {
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "note"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "mode.changed"
                  },
                  "mode": {
                    "type": "string",
                    "enum": [
                      "chat",
                      "code",
                      "cowork"
                    ]
                  },
                  "source": {
                    "type": "string",
                    "enum": [
                      "classifier",
                      "agent",
                      "user"
                    ]
                  },
                  "reason": {
                    "type": "string"
                  },
                  "applied": {
                    "type": "boolean"
                  },
                  "pinnedByUser": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "kind",
                  "mode",
                  "source",
                  "reason",
                  "applied",
                  "pinnedByUser"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "error"
                  },
                  "message": {
                    "type": "string"
                  }
                },
                "required": [
                  "kind",
                  "message"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "turn.end"
                  },
                  "turnId": {
                    "type": "string"
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "completed",
                      "cancelled",
                      "failed"
                    ]
                  }
                },
                "required": [
                  "kind",
                  "turnId",
                  "status"
                ],
                "additionalProperties": false
              }
            ]
          }
        },
        "replayOnly": {
          "type": "boolean",
          "default": false
        },
        "owner": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "active",
        "turnId",
        "bufferedEvents"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `approval.decide`

Params:

```json
{
  "$ref": "#/definitions/approval.decide.params",
  "definitions": {
    "approval.decide.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/approval.decide.result",
  "definitions": {
    "approval.decide.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `approval.list`

Params:

```json
{
  "$ref": "#/definitions/approval.list.params",
  "definitions": {
    "approval.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/approval.list.result",
  "definitions": {
    "approval.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "taskId": {
            "type": [
              "string",
              "null"
            ]
          },
          "toolCallId": {
            "type": [
              "string",
              "null"
            ]
          },
          "kind": {
            "type": "string",
            "enum": [
              "file-edit",
              "shell",
              "terminal",
              "mcp",
              "browser",
              "credential",
              "workspace-trust"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "approved",
              "denied",
              "expired"
            ]
          },
          "request": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              },
              {
                "type": "null"
              },
              {
                "type": "array",
                "items": {
                  "$ref": "#/definitions/approval.list.result/items/properties/request"
                }
              },
              {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/definitions/approval.list.result/items/properties/request"
                }
              }
            ]
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "decidedAt": {
            "anyOf": [
              {
                "$ref": "#/definitions/approval.list.result/items/properties/createdAt"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "taskId",
          "toolCallId",
          "kind",
          "status",
          "request",
          "createdAt",
          "decidedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `audit.export`

Params:

```json
{
  "$ref": "#/definitions/audit.export.params",
  "definitions": {
    "audit.export.params": {
      "type": "object",
      "properties": {
        "format": {
          "type": "string",
          "enum": [
            "json",
            "csv"
          ]
        },
        "path": {
          "type": "string"
        },
        "sessionId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "category": {
          "type": "string"
        }
      },
      "required": [
        "format"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/audit.export.result",
  "definitions": {
    "audit.export.result": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "count": {
          "type": "integer",
          "minimum": 0
        },
        "format": {
          "type": "string",
          "enum": [
            "json",
            "csv"
          ]
        },
        "chainValid": {
          "type": "boolean"
        }
      },
      "required": [
        "path",
        "count",
        "format",
        "chainValid"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `audit.list`

Params:

```json
{
  "$ref": "#/definitions/audit.list.params",
  "definitions": {
    "audit.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 5000
            },
            "sessionId": {
              "type": "string"
            },
            "taskId": {
              "type": "string"
            },
            "category": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/audit.list.result",
  "definitions": {
    "audit.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "sequence": {
            "type": "integer",
            "minimum": 0
          },
          "category": {
            "type": "string"
          },
          "action": {
            "type": "string"
          },
          "actor": {
            "type": "string"
          },
          "workspaceId": {
            "type": [
              "string",
              "null"
            ]
          },
          "taskId": {
            "type": [
              "string",
              "null"
            ]
          },
          "sessionId": {
            "type": [
              "string",
              "null"
            ]
          },
          "subject": {
            "type": [
              "string",
              "null"
            ]
          },
          "metadata": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              },
              {
                "type": "null"
              },
              {
                "type": "array",
                "items": {
                  "$ref": "#/definitions/audit.list.result/items/properties/metadata"
                }
              },
              {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/definitions/audit.list.result/items/properties/metadata"
                }
              }
            ]
          },
          "previousHash": {
            "type": "string"
          },
          "eventHash": {
            "type": "string"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          }
        },
        "required": [
          "id",
          "sequence",
          "category",
          "action",
          "actor",
          "workspaceId",
          "taskId",
          "sessionId",
          "subject",
          "metadata",
          "previousHash",
          "eventHash",
          "createdAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.back`

Params:

```json
{
  "$ref": "#/definitions/browser.back.params",
  "definitions": {
    "browser.back.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.back.result",
  "definitions": {
    "browser.back.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.click`

Params:

```json
{
  "$ref": "#/definitions/browser.click.params",
  "definitions": {
    "browser.click.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "selector": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "selector"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.click.result",
  "definitions": {
    "browser.click.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.close`

Params:

```json
{
  "$ref": "#/definitions/browser.close.params",
  "definitions": {
    "browser.close.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.close.result",
  "definitions": {
    "browser.close.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.fill`

Params:

```json
{
  "$ref": "#/definitions/browser.fill.params",
  "definitions": {
    "browser.fill.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "selector": {
          "type": "string"
        },
        "text": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "selector",
        "text"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.fill.result",
  "definitions": {
    "browser.fill.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.forward`

Params:

```json
{
  "$ref": "#/definitions/browser.forward.params",
  "definitions": {
    "browser.forward.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.forward.result",
  "definitions": {
    "browser.forward.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.navigate`

Params:

```json
{
  "$ref": "#/definitions/browser.navigate.params",
  "definitions": {
    "browser.navigate.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "url": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "url"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.navigate.result",
  "definitions": {
    "browser.navigate.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.press`

Params:

```json
{
  "$ref": "#/definitions/browser.press.params",
  "definitions": {
    "browser.press.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "key": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "key"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.press.result",
  "definitions": {
    "browser.press.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.reload`

Params:

```json
{
  "$ref": "#/definitions/browser.reload.params",
  "definitions": {
    "browser.reload.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.reload.result",
  "definitions": {
    "browser.reload.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.screenshot`

Params:

```json
{
  "$ref": "#/definitions/browser.screenshot.params",
  "definitions": {
    "browser.screenshot.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.screenshot.result",
  "definitions": {
    "browser.screenshot.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        },
        "path": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "mediaType": {
          "type": "string"
        },
        "size": {
          "type": "integer",
          "minimum": 0
        },
        "dataUrl": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr",
        "path"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.session.create`

Params:

```json
{
  "$ref": "#/definitions/browser.session.create.params",
  "definitions": {
    "browser.session.create.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.session.create.result",
  "definitions": {
    "browser.session.create.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "starting",
            "running",
            "closed",
            "failed"
          ]
        },
        "currentUrl": {
          "type": [
            "string",
            "null"
          ]
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/browser.session.create.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "status",
        "currentUrl",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.session.list`

Params:

```json
{
  "$ref": "#/definitions/browser.session.list.params",
  "definitions": {
    "browser.session.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "workspaceId": {
              "type": "string"
            },
            "taskId": {
              "type": "string"
            }
          },
          "required": [
            "workspaceId"
          ],
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.session.list.result",
  "definitions": {
    "browser.session.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "starting",
              "running",
              "closed",
              "failed"
            ]
          },
          "currentUrl": {
            "type": [
              "string",
              "null"
            ]
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "updatedAt": {
            "$ref": "#/definitions/browser.session.list.result/items/properties/createdAt"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "status",
          "currentUrl",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.snapshot`

Params:

```json
{
  "$ref": "#/definitions/browser.snapshot.params",
  "definitions": {
    "browser.snapshot.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.snapshot.result",
  "definitions": {
    "browser.snapshot.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `browser.type`

Params:

```json
{
  "$ref": "#/definitions/browser.type.params",
  "definitions": {
    "browser.type.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "selector": {
          "type": "string"
        },
        "text": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "selector",
        "text"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/browser.type.result",
  "definitions": {
    "browser.type.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `command.delete`

Params:

```json
{
  "$ref": "#/definitions/command.delete.params",
  "definitions": {
    "command.delete.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/command.delete.result",
  "definitions": {
    "command.delete.result": {
      "type": "object",
      "properties": {
        "removed": {
          "type": "boolean"
        }
      },
      "required": [
        "removed"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `command.list`

Params:

```json
{
  "$ref": "#/definitions/command.list.params",
  "definitions": {
    "command.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "workspaceId": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/command.list.result",
  "definitions": {
    "command.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": [
              "string",
              "null"
            ]
          },
          "name": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "command": {
            "type": "string"
          },
          "args": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "default": []
          },
          "sourcePath": {
            "type": [
              "string",
              "null"
            ]
          },
          "trusted": {
            "type": "boolean"
          },
          "enabled": {
            "type": "boolean"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "updatedAt": {
            "$ref": "#/definitions/command.list.result/items/properties/createdAt"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "name",
          "description",
          "command",
          "sourcePath",
          "trusted",
          "enabled",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `command.run`

Params:

```json
{
  "$ref": "#/definitions/command.run.params",
  "definitions": {
    "command.run.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "workspaceId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/command.run.result",
  "definitions": {
    "command.run.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `command.save`

Params:

```json
{
  "$ref": "#/definitions/command.save.params",
  "definitions": {
    "command.save.params": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "command": {
          "type": "string"
        }
      },
      "required": [
        "name",
        "command"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/command.save.result",
  "definitions": {
    "command.save.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "name": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "sourcePath": {
          "type": [
            "string",
            "null"
          ]
        },
        "trusted": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/command.save.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "name",
        "description",
        "command",
        "sourcePath",
        "trusted",
        "enabled",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `credential.delete`

Params:

```json
{
  "$ref": "#/definitions/credential.delete.params",
  "definitions": {
    "credential.delete.params": {
      "type": "object",
      "properties": {
        "reference": {
          "type": "string"
        }
      },
      "required": [
        "reference"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/credential.delete.result",
  "definitions": {
    "credential.delete.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `credential.set`

Params:

```json
{
  "$ref": "#/definitions/credential.set.params",
  "definitions": {
    "credential.set.params": {
      "type": "object",
      "properties": {
        "reference": {
          "type": "string"
        },
        "secret": {
          "type": "string"
        }
      },
      "required": [
        "reference",
        "secret"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/credential.set.result",
  "definitions": {
    "credential.set.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `credential.status`

Params:

```json
{
  "$ref": "#/definitions/credential.status.params",
  "definitions": {
    "credential.status.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "reference": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/credential.status.result",
  "definitions": {
    "credential.status.result": {
      "type": "object",
      "properties": {
        "exists": {
          "type": "boolean"
        },
        "hint": {
          "type": [
            "string",
            "null"
          ]
        },
        "owner": {
          "type": "string"
        },
        "storage": {
          "type": "string"
        },
        "plaintext": {
          "type": "boolean"
        },
        "plaintextSqliteStorage": {
          "type": "boolean"
        }
      },
      "required": [
        "storage"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `extension.nativeMessaging.setEnabled`

Params:

```json
{
  "$ref": "#/definitions/extension.nativeMessaging.setEnabled.params",
  "definitions": {
    "extension.nativeMessaging.setEnabled.params": {
      "type": "object",
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "extensionIds": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[a-p]{32}$"
          }
        }
      },
      "required": [
        "enabled"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/extension.nativeMessaging.setEnabled.result",
  "definitions": {
    "extension.nativeMessaging.setEnabled.result": {
      "type": "object",
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "hostName": {
          "type": "string"
        },
        "manifestPaths": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "configPath": {
          "type": "string"
        },
        "nativeHostPath": {
          "type": "string"
        },
        "socketPath": {
          "type": [
            "string",
            "null"
          ]
        },
        "tokenPath": {
          "type": [
            "string",
            "null"
          ]
        },
        "allowedOrigins": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "requiresExtensionId": {
          "type": "boolean"
        }
      },
      "required": [
        "enabled",
        "hostName",
        "manifestPaths",
        "configPath",
        "nativeHostPath",
        "socketPath",
        "tokenPath",
        "allowedOrigins",
        "requiresExtensionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `extension.nativeMessaging.status`

Params:

```json
{
  "$ref": "#/definitions/extension.nativeMessaging.status.params",
  "definitions": {
    "extension.nativeMessaging.status.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/extension.nativeMessaging.status.result",
  "definitions": {
    "extension.nativeMessaging.status.result": {
      "type": "object",
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "hostName": {
          "type": "string"
        },
        "manifestPaths": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "configPath": {
          "type": "string"
        },
        "nativeHostPath": {
          "type": "string"
        },
        "socketPath": {
          "type": [
            "string",
            "null"
          ]
        },
        "tokenPath": {
          "type": [
            "string",
            "null"
          ]
        },
        "allowedOrigins": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "requiresExtensionId": {
          "type": "boolean"
        }
      },
      "required": [
        "enabled",
        "hostName",
        "manifestPaths",
        "configPath",
        "nativeHostPath",
        "socketPath",
        "tokenPath",
        "allowedOrigins",
        "requiresExtensionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `file.list`

Params:

```json
{
  "$ref": "#/definitions/file.list.params",
  "definitions": {
    "file.list.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/file.list.result",
  "definitions": {
    "file.list.result": {
      "type": "object",
      "properties": {
        "root": {
          "type": "string"
        },
        "entries": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "relativePath": {
                "type": "string"
              },
              "kind": {
                "type": "string",
                "enum": [
                  "directory",
                  "file"
                ]
              }
            },
            "required": [
              "name",
              "path",
              "relativePath",
              "kind"
            ],
            "additionalProperties": false
          }
        },
        "truncated": {
          "type": "boolean",
          "default": false
        }
      },
      "required": [
        "root",
        "entries"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `file.read`

Params:

```json
{
  "$ref": "#/definitions/file.read.params",
  "definitions": {
    "file.read.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "path": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "path"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/file.read.result",
  "definitions": {
    "file.read.result": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "content": {
          "type": "string"
        },
        "truncated": {
          "type": "boolean"
        }
      },
      "required": [
        "content",
        "truncated"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `file.tree`

Params:

```json
{
  "$ref": "#/definitions/file.tree.params",
  "definitions": {
    "file.tree.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "path": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/file.tree.result",
  "definitions": {
    "file.tree.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "enum": [
              "dir",
              "file"
            ]
          },
          "size": {
            "type": "integer",
            "minimum": 0
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time"
          }
        },
        "required": [
          "path",
          "kind"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `file.write`

Params:

```json
{
  "$ref": "#/definitions/file.write.params",
  "definitions": {
    "file.write.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "path": {
          "type": "string"
        },
        "content": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "path",
        "content"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/file.write.result",
  "definitions": {
    "file.write.result": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "bytes": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "path",
        "bytes"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.branch`

Params:

```json
{
  "$ref": "#/definitions/git.branch.params",
  "definitions": {
    "git.branch.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.branch.result",
  "definitions": {
    "git.branch.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.branches`

Params:

```json
{
  "$ref": "#/definitions/git.branches.params",
  "definitions": {
    "git.branches.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.branches.result",
  "definitions": {
    "git.branches.result": {
      "type": "object",
      "properties": {
        "current": {
          "type": [
            "string",
            "null"
          ]
        },
        "branches": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "current": {
                "type": "boolean"
              }
            },
            "required": [
              "name",
              "current"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "current",
        "branches"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.changedFiles`

Params:

```json
{
  "$ref": "#/definitions/git.changedFiles.params",
  "definitions": {
    "git.changedFiles.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.changedFiles.result",
  "definitions": {
    "git.changedFiles.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string"
          },
          "indexStatus": {
            "type": "string"
          },
          "worktreeStatus": {
            "type": "string"
          },
          "staged": {
            "type": "boolean"
          },
          "unstaged": {
            "type": "boolean"
          },
          "untracked": {
            "type": "boolean"
          }
        },
        "required": [
          "path",
          "indexStatus",
          "worktreeStatus",
          "staged",
          "unstaged",
          "untracked"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.checkpoint`

Params:

```json
{
  "$ref": "#/definitions/git.checkpoint.params",
  "definitions": {
    "git.checkpoint.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "sessionId": {
          "type": "string"
        },
        "entryId": {
          "type": "string"
        },
        "reason": {
          "type": "string",
          "enum": [
            "manual",
            "auto-rewind",
            "auto-restore",
            "auto-merge"
          ]
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.checkpoint.result",
  "definitions": {
    "git.checkpoint.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.copyPatch`

Params:

```json
{
  "$ref": "#/definitions/git.copyPatch.params",
  "definitions": {
    "git.copyPatch.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "path": {
          "type": "string"
        },
        "baseBranch": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.copyPatch.result",
  "definitions": {
    "git.copyPatch.result": {
      "type": "object",
      "properties": {
        "patch": {
          "type": "string"
        }
      },
      "required": [
        "patch"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.diff`

Params:

```json
{
  "$ref": "#/definitions/git.diff.params",
  "definitions": {
    "git.diff.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "path": {
          "type": "string"
        },
        "baseBranch": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.diff.result",
  "definitions": {
    "git.diff.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.diffBase`

Params:

```json
{
  "$ref": "#/definitions/git.diffBase.params",
  "definitions": {
    "git.diffBase.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "baseBranch": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.diffBase.result",
  "definitions": {
    "git.diffBase.result": {
      "type": "object",
      "properties": {
        "baseBranch": {
          "type": [
            "string",
            "null"
          ]
        },
        "mergeBase": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "baseBranch",
        "mergeBase"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.info`

Params:

```json
{
  "$ref": "#/definitions/git.info.params",
  "definitions": {
    "git.info.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.info.result",
  "definitions": {
    "git.info.result": {
      "type": "object",
      "properties": {
        "isRepo": {
          "type": "boolean"
        },
        "branch": {
          "type": [
            "string",
            "null"
          ]
        },
        "defaultBranch": {
          "type": [
            "string",
            "null"
          ]
        },
        "diffBase": {
          "type": [
            "string",
            "null"
          ]
        },
        "ahead": {
          "type": "integer",
          "minimum": 0
        },
        "behind": {
          "type": "integer",
          "minimum": 0
        },
        "dirty": {
          "type": "boolean"
        },
        "changedFiles": {
          "type": "integer",
          "minimum": 0
        },
        "stagedFiles": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "isRepo",
        "branch",
        "defaultBranch",
        "diffBase",
        "ahead",
        "behind",
        "dirty",
        "changedFiles",
        "stagedFiles"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.log`

Params:

```json
{
  "$ref": "#/definitions/git.log.params",
  "definitions": {
    "git.log.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "limit": {
          "type": "number"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.log.result",
  "definitions": {
    "git.log.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.pr.comment.create`

Params:

```json
{
  "$ref": "#/definitions/git.pr.comment.create.params",
  "definitions": {
    "git.pr.comment.create.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "number": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "anchor": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "minLength": 1
            },
            "oldPath": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "side": {
              "type": "string",
              "enum": [
                "old",
                "new"
              ]
            },
            "line": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "commitSha": {
              "type": "string",
              "minLength": 7
            },
            "contextHash": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "path",
            "oldPath",
            "side",
            "line",
            "commitSha",
            "contextHash"
          ],
          "additionalProperties": false
        },
        "body": {
          "type": "string",
          "minLength": 1,
          "maxLength": 20000
        }
      },
      "required": [
        "workspaceId",
        "taskId",
        "number",
        "anchor",
        "body"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.pr.comment.create.result",
  "definitions": {
    "git.pr.comment.create.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "reviewSessionId": {
          "type": "string"
        },
        "anchor": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "minLength": 1
            },
            "oldPath": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "side": {
              "type": "string",
              "enum": [
                "old",
                "new"
              ]
            },
            "line": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "commitSha": {
              "type": "string",
              "minLength": 7
            },
            "contextHash": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "path",
            "oldPath",
            "side",
            "line",
            "commitSha",
            "contextHash"
          ],
          "additionalProperties": false
        },
        "body": {
          "type": "string",
          "minLength": 1
        },
        "resolved": {
          "type": "boolean"
        },
        "source": {
          "type": "string",
          "enum": [
            "local",
            "github"
          ]
        },
        "author": {
          "type": [
            "string",
            "null"
          ]
        },
        "url": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "externalId": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "inReplyToId": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "outdated": {
          "type": "boolean"
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/git.pr.comment.create.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "reviewSessionId",
        "anchor",
        "body",
        "resolved",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.pr.comment.reply`

Params:

```json
{
  "$ref": "#/definitions/git.pr.comment.reply.params",
  "definitions": {
    "git.pr.comment.reply.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "number": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "commentId": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "body": {
          "type": "string",
          "minLength": 1,
          "maxLength": 20000
        }
      },
      "required": [
        "workspaceId",
        "taskId",
        "number",
        "commentId",
        "body"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.pr.comment.reply.result",
  "definitions": {
    "git.pr.comment.reply.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "reviewSessionId": {
          "type": "string"
        },
        "anchor": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "minLength": 1
            },
            "oldPath": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "side": {
              "type": "string",
              "enum": [
                "old",
                "new"
              ]
            },
            "line": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "commitSha": {
              "type": "string",
              "minLength": 7
            },
            "contextHash": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "path",
            "oldPath",
            "side",
            "line",
            "commitSha",
            "contextHash"
          ],
          "additionalProperties": false
        },
        "body": {
          "type": "string",
          "minLength": 1
        },
        "resolved": {
          "type": "boolean"
        },
        "source": {
          "type": "string",
          "enum": [
            "local",
            "github"
          ]
        },
        "author": {
          "type": [
            "string",
            "null"
          ]
        },
        "url": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "externalId": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "inReplyToId": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "outdated": {
          "type": "boolean"
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/git.pr.comment.reply.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "reviewSessionId",
        "anchor",
        "body",
        "resolved",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.pr.create`

Params:

```json
{
  "$ref": "#/definitions/git.pr.create.params",
  "definitions": {
    "git.pr.create.params": {
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "body": {
          "type": "string",
          "maxLength": 100000
        },
        "base": {
          "type": "string",
          "minLength": 1
        },
        "draft": {
          "type": "boolean"
        }
      },
      "required": [
        "taskId",
        "base"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.pr.create.result",
  "definitions": {
    "git.pr.create.result": {
      "type": "object",
      "properties": {
        "number": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "url": {
          "type": "string",
          "format": "uri"
        },
        "title": {
          "type": "string"
        },
        "body": {
          "type": "string"
        },
        "base": {
          "type": "string"
        },
        "head": {
          "type": "string"
        },
        "draft": {
          "type": "boolean"
        },
        "state": {
          "type": "string"
        },
        "taskId": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "number",
        "url",
        "title",
        "body",
        "base",
        "head",
        "draft",
        "state",
        "taskId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.pr.draft`

Params:

```json
{
  "$ref": "#/definitions/git.pr.draft.params",
  "definitions": {
    "git.pr.draft.params": {
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string"
        },
        "base": {
          "type": "string"
        },
        "providerId": {
          "type": "string"
        },
        "model": {
          "type": "string"
        }
      },
      "required": [
        "taskId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.pr.draft.result",
  "definitions": {
    "git.pr.draft.result": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string"
        },
        "body": {
          "type": "string"
        },
        "base": {
          "type": "string"
        },
        "head": {
          "type": "string"
        }
      },
      "required": [
        "title",
        "body",
        "base",
        "head"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.pr.list`

Params:

```json
{
  "$ref": "#/definitions/git.pr.list.params",
  "definitions": {
    "git.pr.list.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "state": {
          "type": "string",
          "enum": [
            "open",
            "closed",
            "merged",
            "all"
          ]
        },
        "limit": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 100
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.pr.list.result",
  "definitions": {
    "git.pr.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "number": {
            "type": "integer",
            "exclusiveMinimum": 0
          },
          "url": {
            "type": "string",
            "format": "uri"
          },
          "title": {
            "type": "string"
          },
          "body": {
            "type": "string"
          },
          "base": {
            "type": "string"
          },
          "head": {
            "type": "string"
          },
          "draft": {
            "type": "boolean"
          },
          "state": {
            "type": "string"
          },
          "taskId": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "number",
          "url",
          "title",
          "body",
          "base",
          "head",
          "draft",
          "state",
          "taskId"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.pr.status`

Params:

```json
{
  "$ref": "#/definitions/git.pr.status.params",
  "definitions": {
    "git.pr.status.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.pr.status.result",
  "definitions": {
    "git.pr.status.result": {
      "type": "object",
      "properties": {
        "installed": {
          "type": "boolean"
        },
        "authenticated": {
          "type": "boolean"
        },
        "version": {
          "type": [
            "string",
            "null"
          ]
        },
        "hostname": {
          "type": "string"
        },
        "account": {
          "type": [
            "string",
            "null"
          ]
        },
        "error": {
          "type": [
            "string",
            "null"
          ]
        },
        "setupCommands": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "installed",
        "authenticated",
        "version",
        "hostname",
        "account",
        "error",
        "setupCommands"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.pr.view`

Params:

```json
{
  "$ref": "#/definitions/git.pr.view.params",
  "definitions": {
    "git.pr.view.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "number": {
          "type": "integer",
          "exclusiveMinimum": 0
        }
      },
      "required": [
        "workspaceId",
        "number"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.pr.view.result",
  "definitions": {
    "git.pr.view.result": {
      "type": "object",
      "properties": {
        "number": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "url": {
          "type": "string",
          "format": "uri"
        },
        "title": {
          "type": "string"
        },
        "body": {
          "type": "string"
        },
        "base": {
          "type": "string"
        },
        "head": {
          "type": "string"
        },
        "draft": {
          "type": "boolean"
        },
        "state": {
          "type": "string"
        },
        "taskId": {
          "type": [
            "string",
            "null"
          ]
        },
        "headSha": {
          "type": "string",
          "minLength": 7
        },
        "mergeable": {
          "type": [
            "string",
            "null"
          ]
        },
        "diff": {
          "type": "string"
        },
        "comments": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "reviewSessionId": {
                "type": "string"
              },
              "anchor": {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1
                  },
                  "oldPath": {
                    "anyOf": [
                      {
                        "type": "string",
                        "minLength": 1
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "side": {
                    "type": "string",
                    "enum": [
                      "old",
                      "new"
                    ]
                  },
                  "line": {
                    "type": "integer",
                    "exclusiveMinimum": 0
                  },
                  "commitSha": {
                    "type": "string",
                    "minLength": 7
                  },
                  "contextHash": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "required": [
                  "path",
                  "oldPath",
                  "side",
                  "line",
                  "commitSha",
                  "contextHash"
                ],
                "additionalProperties": false
              },
              "body": {
                "type": "string",
                "minLength": 1
              },
              "resolved": {
                "type": "boolean"
              },
              "source": {
                "type": "string",
                "enum": [
                  "local",
                  "github"
                ]
              },
              "author": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "url": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "uri"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "externalId": {
                "anyOf": [
                  {
                    "type": "integer",
                    "exclusiveMinimum": 0
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "inReplyToId": {
                "anyOf": [
                  {
                    "type": "integer",
                    "exclusiveMinimum": 0
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "outdated": {
                "type": "boolean"
              },
              "createdAt": {
                "type": "string",
                "format": "date-time"
              },
              "updatedAt": {
                "$ref": "#/definitions/git.pr.view.result/properties/comments/items/properties/createdAt"
              }
            },
            "required": [
              "id",
              "reviewSessionId",
              "anchor",
              "body",
              "resolved",
              "createdAt",
              "updatedAt"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "number",
        "url",
        "title",
        "body",
        "base",
        "head",
        "draft",
        "state",
        "taskId",
        "headSha",
        "mergeable",
        "diff",
        "comments"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.revertFile`

Params:

```json
{
  "$ref": "#/definitions/git.revertFile.params",
  "definitions": {
    "git.revertFile.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "path": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "path"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.revertFile.result",
  "definitions": {
    "git.revertFile.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.stage`

Params:

```json
{
  "$ref": "#/definitions/git.stage.params",
  "definitions": {
    "git.stage.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "paths": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "workspaceId",
        "paths"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.stage.result",
  "definitions": {
    "git.stage.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.status`

Params:

```json
{
  "$ref": "#/definitions/git.status.params",
  "definitions": {
    "git.status.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.status.result",
  "definitions": {
    "git.status.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.switchBranch`

Params:

```json
{
  "$ref": "#/definitions/git.switchBranch.params",
  "definitions": {
    "git.switchBranch.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "branch": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "branch"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.switchBranch.result",
  "definitions": {
    "git.switchBranch.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `git.unstage`

Params:

```json
{
  "$ref": "#/definitions/git.unstage.params",
  "definitions": {
    "git.unstage.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "paths": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "workspaceId",
        "paths"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/git.unstage.result",
  "definitions": {
    "git.unstage.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `host.handshake`

Params:

```json
{
  "$ref": "#/definitions/host.handshake.params",
  "definitions": {
    "host.handshake.params": {
      "type": "object",
      "properties": {
        "nonce": {
          "type": "string"
        },
        "protocolVersion": {
          "type": "number",
          "minimum": 0
        }
      },
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/host.handshake.result",
  "definitions": {
    "host.handshake.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "protocolVersion": {
          "type": "integer"
        },
        "capabilities": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        }
      },
      "required": [
        "ok",
        "protocolVersion"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `logs.export`

Params:

```json
{
  "$ref": "#/definitions/logs.export.params",
  "definitions": {
    "logs.export.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "path": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/logs.export.result",
  "definitions": {
    "logs.export.result": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `logs.list`

Params:

```json
{
  "$ref": "#/definitions/logs.list.params",
  "definitions": {
    "logs.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number"
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/logs.list.result",
  "definitions": {
    "logs.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "level": {
            "type": "string"
          },
          "source": {
            "type": "string"
          },
          "message": {
            "type": "string"
          },
          "metadata": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              },
              {
                "type": "null"
              },
              {
                "type": "array",
                "items": {
                  "$ref": "#/definitions/logs.list.result/items/properties/metadata"
                }
              },
              {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/definitions/logs.list.result/items/properties/metadata"
                }
              }
            ]
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          }
        },
        "required": [
          "id",
          "level",
          "source",
          "message",
          "metadata",
          "createdAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `mcp.import.apply`

Params:

```json
{
  "$ref": "#/definitions/mcp.import.apply.params",
  "definitions": {
    "mcp.import.apply.params": {
      "type": "object",
      "properties": {
        "servers": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "source": {
                "type": "string",
                "enum": [
                  "claude-code",
                  "codex",
                  "zcode",
                  "agents"
                ]
              },
              "sourcePath": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "transport": {
                "type": "string",
                "enum": [
                  "stdio",
                  "http-sse",
                  "streamable-http"
                ]
              },
              "command": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "args": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "default": []
              },
              "url": {
                "anyOf": [
                  {
                    "type": "string",
                    "format": "uri"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "env": {
                "type": "object",
                "additionalProperties": {
                  "type": "string"
                },
                "default": {}
              }
            },
            "required": [
              "source",
              "sourcePath",
              "name",
              "transport",
              "command",
              "url"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "servers"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/mcp.import.apply.result",
  "definitions": {
    "mcp.import.apply.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": [
              "string",
              "null"
            ]
          },
          "name": {
            "type": "string"
          },
          "transport": {
            "type": "string",
            "enum": [
              "stdio",
              "http-sse",
              "streamable-http"
            ]
          },
          "command": {
            "type": [
              "string",
              "null"
            ]
          },
          "args": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "default": []
          },
          "url": {
            "anyOf": [
              {
                "type": "string",
                "format": "uri"
              },
              {
                "type": "null"
              }
            ]
          },
          "env": {
            "type": "object",
            "additionalProperties": {
              "type": "string"
            },
            "default": {}
          },
          "authType": {
            "type": "string",
            "enum": [
              "none",
              "bearer-api-key",
              "oauth-authorization-code",
              "oauth-device"
            ],
            "default": "none"
          },
          "credentialRef": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "oauth": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "clientId": {
                    "type": "string"
                  },
                  "authorizationUrl": {
                    "anyOf": [
                      {
                        "type": "string",
                        "format": "uri"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "tokenUrl": {
                    "type": "string",
                    "format": "uri"
                  },
                  "deviceAuthorizationUrl": {
                    "anyOf": [
                      {
                        "type": "string",
                        "format": "uri"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "scopes": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    },
                    "default": []
                  }
                },
                "required": [
                  "clientId",
                  "authorizationUrl",
                  "tokenUrl",
                  "deviceAuthorizationUrl"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "source": {
            "type": "string",
            "default": "manual"
          },
          "trusted": {
            "type": "boolean"
          },
          "enabled": {
            "type": "boolean"
          },
          "healthStatus": {
            "type": "string",
            "enum": [
              "disconnected",
              "connecting",
              "connected",
              "auth-required",
              "error"
            ],
            "default": "disconnected"
          },
          "toolCount": {
            "type": "integer",
            "minimum": 0,
            "default": 0
          },
          "lastError": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "latencyMs": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "lastCheckedAt": {
            "anyOf": [
              {
                "type": "string",
                "format": "date-time"
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "cachedTools": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string"
                },
                "description": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "inputSchema": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "boolean"
                    },
                    {
                      "type": "null"
                    },
                    {
                      "type": "array",
                      "items": {
                        "$ref": "#/definitions/mcp.import.apply.result/items/properties/cachedTools/items/properties/inputSchema"
                      }
                    },
                    {
                      "type": "object",
                      "additionalProperties": {
                        "$ref": "#/definitions/mcp.import.apply.result/items/properties/cachedTools/items/properties/inputSchema"
                      }
                    }
                  ]
                },
                "annotations": {
                  "type": "object",
                  "properties": {
                    "readOnlyHint": {
                      "type": "boolean"
                    },
                    "destructiveHint": {
                      "type": "boolean"
                    },
                    "idempotentHint": {
                      "type": "boolean"
                    },
                    "openWorldHint": {
                      "type": "boolean"
                    }
                  },
                  "additionalProperties": false
                }
              },
              "required": [
                "name",
                "description",
                "inputSchema"
              ],
              "additionalProperties": false
            },
            "default": []
          },
          "createdAt": {
            "$ref": "#/definitions/mcp.import.apply.result/items/properties/lastCheckedAt/anyOf/0"
          },
          "updatedAt": {
            "$ref": "#/definitions/mcp.import.apply.result/items/properties/lastCheckedAt/anyOf/0"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "name",
          "transport",
          "command",
          "url",
          "trusted",
          "enabled",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `mcp.import.scan`

Params:

```json
{
  "$ref": "#/definitions/mcp.import.scan.params",
  "definitions": {
    "mcp.import.scan.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "paths": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/mcp.import.scan.result",
  "definitions": {
    "mcp.import.scan.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "source": {
            "type": "string",
            "enum": [
              "claude-code",
              "codex",
              "zcode",
              "agents"
            ]
          },
          "sourcePath": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "transport": {
            "type": "string",
            "enum": [
              "stdio",
              "http-sse",
              "streamable-http"
            ]
          },
          "command": {
            "type": [
              "string",
              "null"
            ]
          },
          "args": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "default": []
          },
          "url": {
            "anyOf": [
              {
                "type": "string",
                "format": "uri"
              },
              {
                "type": "null"
              }
            ]
          },
          "env": {
            "type": "object",
            "additionalProperties": {
              "type": "string"
            },
            "default": {}
          }
        },
        "required": [
          "source",
          "sourcePath",
          "name",
          "transport",
          "command",
          "url"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `mcp.oauth.exchange`

Params:

```json
{
  "$ref": "#/definitions/mcp.oauth.exchange.params",
  "definitions": {
    "mcp.oauth.exchange.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "state": {
          "type": "string"
        },
        "code": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "state",
        "code"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/mcp.oauth.exchange.result",
  "definitions": {
    "mcp.oauth.exchange.result": {
      "type": "object",
      "properties": {
        "credentialRef": {
          "type": "string"
        },
        "secret": {
          "type": "string"
        }
      },
      "required": [
        "credentialRef",
        "secret"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `mcp.oauth.poll`

Params:

```json
{
  "$ref": "#/definitions/mcp.oauth.poll.params",
  "definitions": {
    "mcp.oauth.poll.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "state": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "state"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/mcp.oauth.poll.result",
  "definitions": {
    "mcp.oauth.poll.result": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "pending",
            "complete"
          ]
        },
        "credentialRef": {
          "type": [
            "string",
            "null"
          ]
        },
        "secret": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "status",
        "credentialRef",
        "secret"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `mcp.oauth.start`

Params:

```json
{
  "$ref": "#/definitions/mcp.oauth.start.params",
  "definitions": {
    "mcp.oauth.start.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "redirectUri": {
          "type": "string",
          "format": "uri"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/mcp.oauth.start.result",
  "definitions": {
    "mcp.oauth.start.result": {
      "type": "object",
      "properties": {
        "flow": {
          "type": "string",
          "enum": [
            "authorization-code",
            "device"
          ]
        },
        "state": {
          "type": "string"
        },
        "authorizationUrl": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "verificationUri": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "userCode": {
          "type": [
            "string",
            "null"
          ]
        },
        "intervalSeconds": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "flow",
        "state",
        "authorizationUrl",
        "verificationUri",
        "userCode",
        "intervalSeconds"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `mcp.server.enable`

Params:

```json
{
  "$ref": "#/definitions/mcp.server.enable.params",
  "definitions": {
    "mcp.server.enable.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "enabled": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "enabled"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/mcp.server.enable.result",
  "definitions": {
    "mcp.server.enable.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `mcp.server.health`

Params:

```json
{
  "$ref": "#/definitions/mcp.server.health.params",
  "definitions": {
    "mcp.server.health.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "credentialRef": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/mcp.server.health.result",
  "definitions": {
    "mcp.server.health.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "name": {
          "type": "string"
        },
        "transport": {
          "type": "string",
          "enum": [
            "stdio",
            "http-sse",
            "streamable-http"
          ]
        },
        "command": {
          "type": [
            "string",
            "null"
          ]
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "url": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "env": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          },
          "default": {}
        },
        "authType": {
          "type": "string",
          "enum": [
            "none",
            "bearer-api-key",
            "oauth-authorization-code",
            "oauth-device"
          ],
          "default": "none"
        },
        "credentialRef": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "oauth": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "clientId": {
                  "type": "string"
                },
                "authorizationUrl": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "uri"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "tokenUrl": {
                  "type": "string",
                  "format": "uri"
                },
                "deviceAuthorizationUrl": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "uri"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "scopes": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "default": []
                }
              },
              "required": [
                "clientId",
                "authorizationUrl",
                "tokenUrl",
                "deviceAuthorizationUrl"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "source": {
          "type": "string",
          "default": "manual"
        },
        "trusted": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "healthStatus": {
          "type": "string",
          "enum": [
            "disconnected",
            "connecting",
            "connected",
            "auth-required",
            "error"
          ],
          "default": "disconnected"
        },
        "toolCount": {
          "type": "integer",
          "minimum": 0,
          "default": 0
        },
        "lastError": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "latencyMs": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "lastCheckedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "cachedTools": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "description": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "inputSchema": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  },
                  {
                    "type": "null"
                  },
                  {
                    "type": "array",
                    "items": {
                      "$ref": "#/definitions/mcp.server.health.result/properties/cachedTools/items/properties/inputSchema"
                    }
                  },
                  {
                    "type": "object",
                    "additionalProperties": {
                      "$ref": "#/definitions/mcp.server.health.result/properties/cachedTools/items/properties/inputSchema"
                    }
                  }
                ]
              },
              "annotations": {
                "type": "object",
                "properties": {
                  "readOnlyHint": {
                    "type": "boolean"
                  },
                  "destructiveHint": {
                    "type": "boolean"
                  },
                  "idempotentHint": {
                    "type": "boolean"
                  },
                  "openWorldHint": {
                    "type": "boolean"
                  }
                },
                "additionalProperties": false
              }
            },
            "required": [
              "name",
              "description",
              "inputSchema"
            ],
            "additionalProperties": false
          },
          "default": []
        },
        "createdAt": {
          "$ref": "#/definitions/mcp.server.health.result/properties/lastCheckedAt/anyOf/0"
        },
        "updatedAt": {
          "$ref": "#/definitions/mcp.server.health.result/properties/lastCheckedAt/anyOf/0"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "name",
        "transport",
        "command",
        "url",
        "trusted",
        "enabled",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `mcp.server.list`

Params:

```json
{
  "$ref": "#/definitions/mcp.server.list.params",
  "definitions": {
    "mcp.server.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/mcp.server.list.result",
  "definitions": {
    "mcp.server.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": [
              "string",
              "null"
            ]
          },
          "name": {
            "type": "string"
          },
          "transport": {
            "type": "string",
            "enum": [
              "stdio",
              "http-sse",
              "streamable-http"
            ]
          },
          "command": {
            "type": [
              "string",
              "null"
            ]
          },
          "args": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "default": []
          },
          "url": {
            "anyOf": [
              {
                "type": "string",
                "format": "uri"
              },
              {
                "type": "null"
              }
            ]
          },
          "env": {
            "type": "object",
            "additionalProperties": {
              "type": "string"
            },
            "default": {}
          },
          "authType": {
            "type": "string",
            "enum": [
              "none",
              "bearer-api-key",
              "oauth-authorization-code",
              "oauth-device"
            ],
            "default": "none"
          },
          "credentialRef": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "oauth": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "clientId": {
                    "type": "string"
                  },
                  "authorizationUrl": {
                    "anyOf": [
                      {
                        "type": "string",
                        "format": "uri"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "tokenUrl": {
                    "type": "string",
                    "format": "uri"
                  },
                  "deviceAuthorizationUrl": {
                    "anyOf": [
                      {
                        "type": "string",
                        "format": "uri"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "scopes": {
                    "type": "array",
                    "items": {
                      "type": "string"
                    },
                    "default": []
                  }
                },
                "required": [
                  "clientId",
                  "authorizationUrl",
                  "tokenUrl",
                  "deviceAuthorizationUrl"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "source": {
            "type": "string",
            "default": "manual"
          },
          "trusted": {
            "type": "boolean"
          },
          "enabled": {
            "type": "boolean"
          },
          "healthStatus": {
            "type": "string",
            "enum": [
              "disconnected",
              "connecting",
              "connected",
              "auth-required",
              "error"
            ],
            "default": "disconnected"
          },
          "toolCount": {
            "type": "integer",
            "minimum": 0,
            "default": 0
          },
          "lastError": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "latencyMs": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "lastCheckedAt": {
            "anyOf": [
              {
                "type": "string",
                "format": "date-time"
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "cachedTools": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string"
                },
                "description": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "inputSchema": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "boolean"
                    },
                    {
                      "type": "null"
                    },
                    {
                      "type": "array",
                      "items": {
                        "$ref": "#/definitions/mcp.server.list.result/items/properties/cachedTools/items/properties/inputSchema"
                      }
                    },
                    {
                      "type": "object",
                      "additionalProperties": {
                        "$ref": "#/definitions/mcp.server.list.result/items/properties/cachedTools/items/properties/inputSchema"
                      }
                    }
                  ]
                },
                "annotations": {
                  "type": "object",
                  "properties": {
                    "readOnlyHint": {
                      "type": "boolean"
                    },
                    "destructiveHint": {
                      "type": "boolean"
                    },
                    "idempotentHint": {
                      "type": "boolean"
                    },
                    "openWorldHint": {
                      "type": "boolean"
                    }
                  },
                  "additionalProperties": false
                }
              },
              "required": [
                "name",
                "description",
                "inputSchema"
              ],
              "additionalProperties": false
            },
            "default": []
          },
          "createdAt": {
            "$ref": "#/definitions/mcp.server.list.result/items/properties/lastCheckedAt/anyOf/0"
          },
          "updatedAt": {
            "$ref": "#/definitions/mcp.server.list.result/items/properties/lastCheckedAt/anyOf/0"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "name",
          "transport",
          "command",
          "url",
          "trusted",
          "enabled",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `mcp.server.reconnect`

Params:

```json
{
  "$ref": "#/definitions/mcp.server.reconnect.params",
  "definitions": {
    "mcp.server.reconnect.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "credentialRef": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/mcp.server.reconnect.result",
  "definitions": {
    "mcp.server.reconnect.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "name": {
          "type": "string"
        },
        "transport": {
          "type": "string",
          "enum": [
            "stdio",
            "http-sse",
            "streamable-http"
          ]
        },
        "command": {
          "type": [
            "string",
            "null"
          ]
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "url": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "env": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          },
          "default": {}
        },
        "authType": {
          "type": "string",
          "enum": [
            "none",
            "bearer-api-key",
            "oauth-authorization-code",
            "oauth-device"
          ],
          "default": "none"
        },
        "credentialRef": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "oauth": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "clientId": {
                  "type": "string"
                },
                "authorizationUrl": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "uri"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "tokenUrl": {
                  "type": "string",
                  "format": "uri"
                },
                "deviceAuthorizationUrl": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "uri"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "scopes": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "default": []
                }
              },
              "required": [
                "clientId",
                "authorizationUrl",
                "tokenUrl",
                "deviceAuthorizationUrl"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "source": {
          "type": "string",
          "default": "manual"
        },
        "trusted": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "healthStatus": {
          "type": "string",
          "enum": [
            "disconnected",
            "connecting",
            "connected",
            "auth-required",
            "error"
          ],
          "default": "disconnected"
        },
        "toolCount": {
          "type": "integer",
          "minimum": 0,
          "default": 0
        },
        "lastError": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "latencyMs": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "lastCheckedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "cachedTools": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "description": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "inputSchema": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  },
                  {
                    "type": "null"
                  },
                  {
                    "type": "array",
                    "items": {
                      "$ref": "#/definitions/mcp.server.reconnect.result/properties/cachedTools/items/properties/inputSchema"
                    }
                  },
                  {
                    "type": "object",
                    "additionalProperties": {
                      "$ref": "#/definitions/mcp.server.reconnect.result/properties/cachedTools/items/properties/inputSchema"
                    }
                  }
                ]
              },
              "annotations": {
                "type": "object",
                "properties": {
                  "readOnlyHint": {
                    "type": "boolean"
                  },
                  "destructiveHint": {
                    "type": "boolean"
                  },
                  "idempotentHint": {
                    "type": "boolean"
                  },
                  "openWorldHint": {
                    "type": "boolean"
                  }
                },
                "additionalProperties": false
              }
            },
            "required": [
              "name",
              "description",
              "inputSchema"
            ],
            "additionalProperties": false
          },
          "default": []
        },
        "createdAt": {
          "$ref": "#/definitions/mcp.server.reconnect.result/properties/lastCheckedAt/anyOf/0"
        },
        "updatedAt": {
          "$ref": "#/definitions/mcp.server.reconnect.result/properties/lastCheckedAt/anyOf/0"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "name",
        "transport",
        "command",
        "url",
        "trusted",
        "enabled",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `mcp.server.save`

Params:

```json
{
  "$ref": "#/definitions/mcp.server.save.params",
  "definitions": {
    "mcp.server.save.params": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "transport": {
          "type": "string",
          "enum": [
            "stdio",
            "http-sse",
            "streamable-http"
          ]
        }
      },
      "required": [
        "name",
        "transport"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/mcp.server.save.result",
  "definitions": {
    "mcp.server.save.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "name": {
          "type": "string"
        },
        "transport": {
          "type": "string",
          "enum": [
            "stdio",
            "http-sse",
            "streamable-http"
          ]
        },
        "command": {
          "type": [
            "string",
            "null"
          ]
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "url": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "env": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          },
          "default": {}
        },
        "authType": {
          "type": "string",
          "enum": [
            "none",
            "bearer-api-key",
            "oauth-authorization-code",
            "oauth-device"
          ],
          "default": "none"
        },
        "credentialRef": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "oauth": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "clientId": {
                  "type": "string"
                },
                "authorizationUrl": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "uri"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "tokenUrl": {
                  "type": "string",
                  "format": "uri"
                },
                "deviceAuthorizationUrl": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "uri"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "scopes": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "default": []
                }
              },
              "required": [
                "clientId",
                "authorizationUrl",
                "tokenUrl",
                "deviceAuthorizationUrl"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "source": {
          "type": "string",
          "default": "manual"
        },
        "trusted": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "healthStatus": {
          "type": "string",
          "enum": [
            "disconnected",
            "connecting",
            "connected",
            "auth-required",
            "error"
          ],
          "default": "disconnected"
        },
        "toolCount": {
          "type": "integer",
          "minimum": 0,
          "default": 0
        },
        "lastError": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "latencyMs": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "lastCheckedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "cachedTools": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "description": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "inputSchema": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  },
                  {
                    "type": "null"
                  },
                  {
                    "type": "array",
                    "items": {
                      "$ref": "#/definitions/mcp.server.save.result/properties/cachedTools/items/properties/inputSchema"
                    }
                  },
                  {
                    "type": "object",
                    "additionalProperties": {
                      "$ref": "#/definitions/mcp.server.save.result/properties/cachedTools/items/properties/inputSchema"
                    }
                  }
                ]
              },
              "annotations": {
                "type": "object",
                "properties": {
                  "readOnlyHint": {
                    "type": "boolean"
                  },
                  "destructiveHint": {
                    "type": "boolean"
                  },
                  "idempotentHint": {
                    "type": "boolean"
                  },
                  "openWorldHint": {
                    "type": "boolean"
                  }
                },
                "additionalProperties": false
              }
            },
            "required": [
              "name",
              "description",
              "inputSchema"
            ],
            "additionalProperties": false
          },
          "default": []
        },
        "createdAt": {
          "$ref": "#/definitions/mcp.server.save.result/properties/lastCheckedAt/anyOf/0"
        },
        "updatedAt": {
          "$ref": "#/definitions/mcp.server.save.result/properties/lastCheckedAt/anyOf/0"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "name",
        "transport",
        "command",
        "url",
        "trusted",
        "enabled",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `mcp.server.trust`

Params:

```json
{
  "$ref": "#/definitions/mcp.server.trust.params",
  "definitions": {
    "mcp.server.trust.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "trusted": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "trusted"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/mcp.server.trust.result",
  "definitions": {
    "mcp.server.trust.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `model.local.cancel`

Params:

```json
{
  "$ref": "#/definitions/model.local.cancel.params",
  "definitions": {
    "model.local.cancel.params": {
      "type": "object",
      "properties": {
        "operationId": {
          "type": "string"
        }
      },
      "required": [
        "operationId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/model.local.cancel.result",
  "definitions": {
    "model.local.cancel.result": {
      "type": "object",
      "properties": {
        "cancelled": {
          "type": "boolean"
        }
      },
      "required": [
        "cancelled"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `model.local.discover`

Params:

```json
{
  "$ref": "#/definitions/model.local.discover.params",
  "definitions": {
    "model.local.discover.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/model.local.discover.result",
  "definitions": {
    "model.local.discover.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "presetId": {
            "type": "string",
            "enum": [
              "jan-llamacpp",
              "ollama",
              "lm-studio"
            ]
          },
          "kind": {
            "type": "string",
            "enum": [
              "berry-router",
              "openai",
              "anthropic",
              "openai-compatible",
              "ollama",
              "lm-studio",
              "local",
              "custom"
            ]
          },
          "name": {
            "type": "string"
          },
          "baseUrl": {
            "type": "string",
            "format": "uri"
          },
          "apiType": {
            "type": "string",
            "enum": [
              "openai-chat-completions",
              "openai-responses",
              "anthropic-messages"
            ]
          },
          "authType": {
            "type": "string",
            "enum": [
              "none",
              "bearer",
              "optional-bearer",
              "x-api-key"
            ]
          },
          "running": {
            "type": "boolean"
          },
          "models": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string"
                },
                "name": {
                  "type": "string"
                },
                "ownedBy": {
                  "type": "string"
                },
                "apiType": {
                  "$ref": "#/definitions/model.local.discover.result/items/properties/apiType"
                },
                "contextWindow": {
                  "type": "integer",
                  "exclusiveMinimum": 0
                },
                "maxOutputTokens": {
                  "type": "integer",
                  "exclusiveMinimum": 0
                },
                "inputModalities": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "outputModalities": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "capabilities": {
                  "type": "object",
                  "properties": {
                    "tools": {
                      "type": "boolean"
                    },
                    "vision": {
                      "type": "boolean"
                    },
                    "reasoning": {
                      "type": "boolean"
                    },
                    "json": {
                      "type": "boolean"
                    },
                    "context": {
                      "type": "object",
                      "properties": {
                        "windowTokens": {
                          "type": "integer",
                          "exclusiveMinimum": 0
                        },
                        "maxOutputTokens": {
                          "type": "integer",
                          "exclusiveMinimum": 0
                        }
                      },
                      "additionalProperties": false
                    },
                    "cost": {
                      "type": "object",
                      "properties": {
                        "input": {
                          "type": "number",
                          "minimum": 0
                        },
                        "output": {
                          "type": "number",
                          "minimum": 0
                        },
                        "cacheRead": {
                          "type": "number",
                          "minimum": 0
                        },
                        "cacheWrite": {
                          "type": "number",
                          "minimum": 0
                        }
                      },
                      "additionalProperties": false
                    }
                  },
                  "additionalProperties": false
                },
                "capabilityOverrides": {
                  "$ref": "#/definitions/model.local.discover.result/items/properties/models/items/properties/capabilities"
                },
                "family": {
                  "type": "string"
                },
                "families": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "parameterSize": {
                  "type": "string"
                },
                "quantization": {
                  "type": "string"
                },
                "format": {
                  "type": "string"
                },
                "sizeBytes": {
                  "type": "integer",
                  "minimum": 0
                },
                "sizeVramBytes": {
                  "type": "integer",
                  "minimum": 0
                },
                "loaded": {
                  "type": "boolean"
                },
                "loadedInstanceIds": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "raw": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "boolean"
                    },
                    {
                      "type": "null"
                    },
                    {
                      "type": "array",
                      "items": {
                        "$ref": "#/definitions/model.local.discover.result/items/properties/models/items/properties/raw"
                      }
                    },
                    {
                      "type": "object",
                      "additionalProperties": {
                        "$ref": "#/definitions/model.local.discover.result/items/properties/models/items/properties/raw"
                      }
                    }
                  ]
                }
              },
              "required": [
                "id"
              ],
              "additionalProperties": false
            }
          },
          "version": {
            "type": "string"
          },
          "nativeApi": {
            "type": "boolean",
            "default": false
          },
          "helpCommand": {
            "type": "string"
          }
        },
        "required": [
          "presetId",
          "kind",
          "name",
          "baseUrl",
          "apiType",
          "authType",
          "running",
          "models"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `model.local.download`

Params:

```json
{
  "$ref": "#/definitions/model.local.download.params",
  "definitions": {
    "model.local.download.params": {
      "type": "object",
      "properties": {
        "providerId": {
          "type": "string"
        },
        "model": {
          "type": "string",
          "minLength": 1
        },
        "quantization": {
          "type": "string"
        }
      },
      "required": [
        "providerId",
        "model"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/model.local.download.result",
  "definitions": {
    "model.local.download.result": {
      "type": "object",
      "properties": {
        "operationId": {
          "type": "string"
        },
        "started": {
          "type": "boolean"
        }
      },
      "required": [
        "operationId",
        "started"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `model.local.load`

Params:

```json
{
  "$ref": "#/definitions/model.local.load.params",
  "definitions": {
    "model.local.load.params": {
      "type": "object",
      "properties": {
        "providerId": {
          "type": "string"
        },
        "model": {
          "type": "string",
          "minLength": 1
        },
        "contextLength": {
          "type": "integer",
          "exclusiveMinimum": 0
        }
      },
      "required": [
        "providerId",
        "model"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/model.local.load.result",
  "definitions": {
    "model.local.load.result": {
      "type": "object",
      "properties": {
        "loaded": {
          "type": "boolean"
        },
        "instanceId": {
          "type": "string"
        }
      },
      "required": [
        "loaded",
        "instanceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `model.local.pull`

Params:

```json
{
  "$ref": "#/definitions/model.local.pull.params",
  "definitions": {
    "model.local.pull.params": {
      "type": "object",
      "properties": {
        "providerId": {
          "type": "string"
        },
        "model": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "providerId",
        "model"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/model.local.pull.result",
  "definitions": {
    "model.local.pull.result": {
      "type": "object",
      "properties": {
        "operationId": {
          "type": "string"
        },
        "started": {
          "type": "boolean"
        }
      },
      "required": [
        "operationId",
        "started"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `model.local.unload`

Params:

```json
{
  "$ref": "#/definitions/model.local.unload.params",
  "definitions": {
    "model.local.unload.params": {
      "type": "object",
      "properties": {
        "providerId": {
          "type": "string"
        },
        "instanceId": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "providerId",
        "instanceId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/model.local.unload.result",
  "definitions": {
    "model.local.unload.result": {
      "type": "object",
      "properties": {
        "unloaded": {
          "type": "boolean"
        },
        "instanceId": {
          "type": "string"
        }
      },
      "required": [
        "unloaded",
        "instanceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `model.preset.list`

Params:

```json
{
  "$ref": "#/definitions/model.preset.list.params",
  "definitions": {
    "model.preset.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/model.preset.list.result",
  "definitions": {
    "model.preset.list.result": {
      "type": "array"
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `model.provider.check`

Params:

```json
{
  "$ref": "#/definitions/model.provider.check.params",
  "definitions": {
    "model.provider.check.params": {
      "type": "object",
      "properties": {
        "providerId": {
          "type": "string"
        }
      },
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/model.provider.check.result",
  "definitions": {
    "model.provider.check.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "status": {
          "type": "string"
        },
        "category": {
          "type": "string",
          "enum": [
            "healthy",
            "auth",
            "network",
            "model",
            "server"
          ]
        },
        "message": {
          "type": "string"
        },
        "modelCount": {
          "type": "integer"
        },
        "httpStatus": {
          "type": "integer"
        },
        "checkedAt": {
          "type": "string",
          "format": "date-time"
        },
        "latencyMs": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "ok",
        "status"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `model.provider.delete`

Params:

```json
{
  "$ref": "#/definitions/model.provider.delete.params",
  "definitions": {
    "model.provider.delete.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/model.provider.delete.result",
  "definitions": {
    "model.provider.delete.result": {
      "type": "object",
      "properties": {
        "removed": {
          "type": "boolean"
        }
      },
      "required": [
        "removed"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `model.provider.list`

Params:

```json
{
  "$ref": "#/definitions/model.provider.list.params",
  "definitions": {
    "model.provider.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/model.provider.list.result",
  "definitions": {
    "model.provider.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "enum": [
              "berry-router",
              "openai",
              "anthropic",
              "openai-compatible",
              "ollama",
              "lm-studio",
              "local",
              "custom"
            ]
          },
          "name": {
            "type": "string"
          },
          "apiType": {
            "type": "string",
            "enum": [
              "openai-chat-completions",
              "openai-responses",
              "anthropic-messages"
            ]
          },
          "baseUrl": {
            "type": "string",
            "format": "uri"
          },
          "endpointPath": {
            "type": [
              "string",
              "null"
            ]
          },
          "modelsPath": {
            "type": [
              "string",
              "null"
            ]
          },
          "defaultModel": {
            "type": "string"
          },
          "credentialRef": {
            "type": [
              "string",
              "null"
            ]
          },
          "authType": {
            "type": "string",
            "enum": [
              "none",
              "bearer",
              "optional-bearer",
              "x-api-key"
            ]
          },
          "enabled": {
            "type": "boolean"
          },
          "models": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string"
                },
                "name": {
                  "type": "string"
                },
                "ownedBy": {
                  "type": "string"
                },
                "apiType": {
                  "$ref": "#/definitions/model.provider.list.result/items/properties/apiType"
                },
                "contextWindow": {
                  "type": "integer",
                  "exclusiveMinimum": 0
                },
                "maxOutputTokens": {
                  "type": "integer",
                  "exclusiveMinimum": 0
                },
                "inputModalities": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "outputModalities": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "capabilities": {
                  "type": "object",
                  "properties": {
                    "tools": {
                      "type": "boolean"
                    },
                    "vision": {
                      "type": "boolean"
                    },
                    "reasoning": {
                      "type": "boolean"
                    },
                    "json": {
                      "type": "boolean"
                    },
                    "context": {
                      "type": "object",
                      "properties": {
                        "windowTokens": {
                          "type": "integer",
                          "exclusiveMinimum": 0
                        },
                        "maxOutputTokens": {
                          "type": "integer",
                          "exclusiveMinimum": 0
                        }
                      },
                      "additionalProperties": false
                    },
                    "cost": {
                      "type": "object",
                      "properties": {
                        "input": {
                          "type": "number",
                          "minimum": 0
                        },
                        "output": {
                          "type": "number",
                          "minimum": 0
                        },
                        "cacheRead": {
                          "type": "number",
                          "minimum": 0
                        },
                        "cacheWrite": {
                          "type": "number",
                          "minimum": 0
                        }
                      },
                      "additionalProperties": false
                    }
                  },
                  "additionalProperties": false
                },
                "capabilityOverrides": {
                  "$ref": "#/definitions/model.provider.list.result/items/properties/models/items/properties/capabilities"
                },
                "family": {
                  "type": "string"
                },
                "families": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "parameterSize": {
                  "type": "string"
                },
                "quantization": {
                  "type": "string"
                },
                "format": {
                  "type": "string"
                },
                "sizeBytes": {
                  "type": "integer",
                  "minimum": 0
                },
                "sizeVramBytes": {
                  "type": "integer",
                  "minimum": 0
                },
                "loaded": {
                  "type": "boolean"
                },
                "loadedInstanceIds": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "expiresAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "raw": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "boolean"
                    },
                    {
                      "type": "null"
                    },
                    {
                      "type": "array",
                      "items": {
                        "$ref": "#/definitions/model.provider.list.result/items/properties/models/items/properties/raw"
                      }
                    },
                    {
                      "type": "object",
                      "additionalProperties": {
                        "$ref": "#/definitions/model.provider.list.result/items/properties/models/items/properties/raw"
                      }
                    }
                  ]
                }
              },
              "required": [
                "id"
              ],
              "additionalProperties": false
            },
            "default": []
          },
          "capabilities": {
            "type": "object",
            "properties": {
              "reasoning": {
                "type": "boolean"
              },
              "toolCalling": {
                "type": "boolean"
              },
              "imageInput": {
                "type": "boolean"
              }
            },
            "additionalProperties": false,
            "default": {}
          },
          "headers": {
            "type": "object",
            "additionalProperties": {
              "type": "string"
            },
            "default": {}
          },
          "source": {
            "type": "string",
            "enum": [
              "preset",
              "custom",
              "discovered"
            ],
            "default": "custom"
          },
          "createdAt": {
            "$ref": "#/definitions/model.provider.list.result/items/properties/models/items/properties/expiresAt"
          },
          "updatedAt": {
            "$ref": "#/definitions/model.provider.list.result/items/properties/models/items/properties/expiresAt"
          }
        },
        "required": [
          "id",
          "kind",
          "name",
          "apiType",
          "baseUrl",
          "endpointPath",
          "modelsPath",
          "defaultModel",
          "credentialRef",
          "authType",
          "enabled",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `model.provider.models`

Params:

```json
{
  "$ref": "#/definitions/model.provider.models.params",
  "definitions": {
    "model.provider.models.params": {
      "type": "object",
      "properties": {
        "providerId": {
          "type": "string"
        }
      },
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/model.provider.models.result",
  "definitions": {
    "model.provider.models.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "ownedBy": {
            "type": "string"
          },
          "apiType": {
            "type": "string",
            "enum": [
              "openai-chat-completions",
              "openai-responses",
              "anthropic-messages"
            ]
          },
          "contextWindow": {
            "type": "integer",
            "exclusiveMinimum": 0
          },
          "maxOutputTokens": {
            "type": "integer",
            "exclusiveMinimum": 0
          },
          "inputModalities": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "outputModalities": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "capabilities": {
            "type": "object",
            "properties": {
              "tools": {
                "type": "boolean"
              },
              "vision": {
                "type": "boolean"
              },
              "reasoning": {
                "type": "boolean"
              },
              "json": {
                "type": "boolean"
              },
              "context": {
                "type": "object",
                "properties": {
                  "windowTokens": {
                    "type": "integer",
                    "exclusiveMinimum": 0
                  },
                  "maxOutputTokens": {
                    "type": "integer",
                    "exclusiveMinimum": 0
                  }
                },
                "additionalProperties": false
              },
              "cost": {
                "type": "object",
                "properties": {
                  "input": {
                    "type": "number",
                    "minimum": 0
                  },
                  "output": {
                    "type": "number",
                    "minimum": 0
                  },
                  "cacheRead": {
                    "type": "number",
                    "minimum": 0
                  },
                  "cacheWrite": {
                    "type": "number",
                    "minimum": 0
                  }
                },
                "additionalProperties": false
              }
            },
            "additionalProperties": false
          },
          "capabilityOverrides": {
            "$ref": "#/definitions/model.provider.models.result/items/properties/capabilities"
          },
          "family": {
            "type": "string"
          },
          "families": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "parameterSize": {
            "type": "string"
          },
          "quantization": {
            "type": "string"
          },
          "format": {
            "type": "string"
          },
          "sizeBytes": {
            "type": "integer",
            "minimum": 0
          },
          "sizeVramBytes": {
            "type": "integer",
            "minimum": 0
          },
          "loaded": {
            "type": "boolean"
          },
          "loadedInstanceIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "expiresAt": {
            "type": "string",
            "format": "date-time"
          },
          "raw": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              },
              {
                "type": "null"
              },
              {
                "type": "array",
                "items": {
                  "$ref": "#/definitions/model.provider.models.result/items/properties/raw"
                }
              },
              {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/definitions/model.provider.models.result/items/properties/raw"
                }
              }
            ]
          }
        },
        "required": [
          "id"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `model.provider.save`

Params:

```json
{
  "$ref": "#/definitions/model.provider.save.params",
  "definitions": {
    "model.provider.save.params": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "baseUrl": {
          "type": "string"
        },
        "defaultModel": {
          "type": "string"
        }
      },
      "required": [
        "name",
        "baseUrl",
        "defaultModel"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/model.provider.save.result",
  "definitions": {
    "model.provider.save.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "berry-router",
            "openai",
            "anthropic",
            "openai-compatible",
            "ollama",
            "lm-studio",
            "local",
            "custom"
          ]
        },
        "name": {
          "type": "string"
        },
        "apiType": {
          "type": "string",
          "enum": [
            "openai-chat-completions",
            "openai-responses",
            "anthropic-messages"
          ]
        },
        "baseUrl": {
          "type": "string",
          "format": "uri"
        },
        "endpointPath": {
          "type": [
            "string",
            "null"
          ]
        },
        "modelsPath": {
          "type": [
            "string",
            "null"
          ]
        },
        "defaultModel": {
          "type": "string"
        },
        "credentialRef": {
          "type": [
            "string",
            "null"
          ]
        },
        "authType": {
          "type": "string",
          "enum": [
            "none",
            "bearer",
            "optional-bearer",
            "x-api-key"
          ]
        },
        "enabled": {
          "type": "boolean"
        },
        "models": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "ownedBy": {
                "type": "string"
              },
              "apiType": {
                "$ref": "#/definitions/model.provider.save.result/properties/apiType"
              },
              "contextWindow": {
                "type": "integer",
                "exclusiveMinimum": 0
              },
              "maxOutputTokens": {
                "type": "integer",
                "exclusiveMinimum": 0
              },
              "inputModalities": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "outputModalities": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "capabilities": {
                "type": "object",
                "properties": {
                  "tools": {
                    "type": "boolean"
                  },
                  "vision": {
                    "type": "boolean"
                  },
                  "reasoning": {
                    "type": "boolean"
                  },
                  "json": {
                    "type": "boolean"
                  },
                  "context": {
                    "type": "object",
                    "properties": {
                      "windowTokens": {
                        "type": "integer",
                        "exclusiveMinimum": 0
                      },
                      "maxOutputTokens": {
                        "type": "integer",
                        "exclusiveMinimum": 0
                      }
                    },
                    "additionalProperties": false
                  },
                  "cost": {
                    "type": "object",
                    "properties": {
                      "input": {
                        "type": "number",
                        "minimum": 0
                      },
                      "output": {
                        "type": "number",
                        "minimum": 0
                      },
                      "cacheRead": {
                        "type": "number",
                        "minimum": 0
                      },
                      "cacheWrite": {
                        "type": "number",
                        "minimum": 0
                      }
                    },
                    "additionalProperties": false
                  }
                },
                "additionalProperties": false
              },
              "capabilityOverrides": {
                "$ref": "#/definitions/model.provider.save.result/properties/models/items/properties/capabilities"
              },
              "family": {
                "type": "string"
              },
              "families": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "parameterSize": {
                "type": "string"
              },
              "quantization": {
                "type": "string"
              },
              "format": {
                "type": "string"
              },
              "sizeBytes": {
                "type": "integer",
                "minimum": 0
              },
              "sizeVramBytes": {
                "type": "integer",
                "minimum": 0
              },
              "loaded": {
                "type": "boolean"
              },
              "loadedInstanceIds": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time"
              },
              "raw": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  },
                  {
                    "type": "null"
                  },
                  {
                    "type": "array",
                    "items": {
                      "$ref": "#/definitions/model.provider.save.result/properties/models/items/properties/raw"
                    }
                  },
                  {
                    "type": "object",
                    "additionalProperties": {
                      "$ref": "#/definitions/model.provider.save.result/properties/models/items/properties/raw"
                    }
                  }
                ]
              }
            },
            "required": [
              "id"
            ],
            "additionalProperties": false
          },
          "default": []
        },
        "capabilities": {
          "type": "object",
          "properties": {
            "reasoning": {
              "type": "boolean"
            },
            "toolCalling": {
              "type": "boolean"
            },
            "imageInput": {
              "type": "boolean"
            }
          },
          "additionalProperties": false,
          "default": {}
        },
        "headers": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          },
          "default": {}
        },
        "source": {
          "type": "string",
          "enum": [
            "preset",
            "custom",
            "discovered"
          ],
          "default": "custom"
        },
        "createdAt": {
          "$ref": "#/definitions/model.provider.save.result/properties/models/items/properties/expiresAt"
        },
        "updatedAt": {
          "$ref": "#/definitions/model.provider.save.result/properties/models/items/properties/expiresAt"
        }
      },
      "required": [
        "id",
        "kind",
        "name",
        "apiType",
        "baseUrl",
        "endpointPath",
        "modelsPath",
        "defaultModel",
        "credentialRef",
        "authType",
        "enabled",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `permission.grant.list`

Params:

```json
{
  "$ref": "#/definitions/permission.grant.list.params",
  "definitions": {
    "permission.grant.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "workspaceId": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/permission.grant.list.result",
  "definitions": {
    "permission.grant.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": [
              "string",
              "null"
            ]
          },
          "mode": {
            "type": "string",
            "enum": [
              "ask",
              "auto-edit",
              "plan",
              "full-access"
            ]
          },
          "subject": {
            "type": "string"
          },
          "decision": {
            "type": "string"
          },
          "expiresAt": {
            "anyOf": [
              {
                "type": "string",
                "format": "date-time"
              },
              {
                "type": "null"
              }
            ]
          },
          "createdAt": {
            "$ref": "#/definitions/permission.grant.list.result/items/properties/expiresAt/anyOf/0"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "mode",
          "subject",
          "decision",
          "expiresAt",
          "createdAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `permission.grant.revoke`

Params:

```json
{
  "$ref": "#/definitions/permission.grant.revoke.params",
  "definitions": {
    "permission.grant.revoke.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/permission.grant.revoke.result",
  "definitions": {
    "permission.grant.revoke.result": {
      "type": "object",
      "properties": {
        "removed": {
          "type": "boolean"
        }
      },
      "required": [
        "removed"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `permission.mode.get`

Params:

```json
{
  "$ref": "#/definitions/permission.mode.get.params",
  "definitions": {
    "permission.mode.get.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/permission.mode.get.result",
  "definitions": {
    "permission.mode.get.result": {
      "type": "string",
      "enum": [
        "ask",
        "auto-edit",
        "plan",
        "full-access"
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `permission.mode.set`

Params:

```json
{
  "$ref": "#/definitions/permission.mode.set.params",
  "definitions": {
    "permission.mode.set.params": {
      "type": "object",
      "properties": {
        "mode": {
          "type": "string",
          "enum": [
            "ask",
            "auto-edit",
            "plan",
            "full-access"
          ]
        }
      },
      "required": [
        "mode"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/permission.mode.set.result",
  "definitions": {
    "permission.mode.set.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `platform.login.exchange`

Params:

```json
{
  "$ref": "#/definitions/platform.login.exchange.params",
  "definitions": {
    "platform.login.exchange.params": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "minLength": 1
        },
        "state": {
          "type": "string",
          "minLength": 1
        },
        "baseUrl": {
          "type": "string",
          "format": "uri"
        },
        "redirectUri": {
          "type": "string",
          "format": "uri"
        },
        "publicKeys": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        }
      },
      "required": [
        "code",
        "state"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/platform.login.exchange.result",
  "definitions": {
    "platform.login.exchange.result": {
      "type": "object",
      "properties": {
        "session": {
          "type": "object",
          "properties": {
            "state": {
              "type": "string",
              "enum": [
                "signed-out",
                "connected"
              ]
            },
            "baseUrl": {
              "anyOf": [
                {
                  "type": "string",
                  "format": "uri"
                },
                {
                  "type": "null"
                }
              ]
            },
            "tenantId": {
              "type": [
                "string",
                "null"
              ]
            },
            "organization": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "id",
                    "name"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "null"
                }
              ]
            },
            "user": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1
                    },
                    "email": {
                      "anyOf": [
                        {
                          "type": "string",
                          "format": "email"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "name": {
                      "type": [
                        "string",
                        "null"
                      ]
                    }
                  },
                  "required": [
                    "id",
                    "email",
                    "name"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "null"
                }
              ]
            },
            "credentialRef": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "tokenType": {
              "type": [
                "string",
                "null"
              ]
            },
            "expiresAt": {
              "anyOf": [
                {
                  "type": "string",
                  "format": "date-time"
                },
                {
                  "type": "null"
                }
              ]
            },
            "policyUrl": {
              "anyOf": [
                {
                  "type": "string",
                  "format": "uri"
                },
                {
                  "type": "null"
                }
              ]
            },
            "policyPublicKeys": {
              "type": "object",
              "additionalProperties": {
                "type": "string"
              },
              "default": {}
            },
            "usageIngestUrl": {
              "anyOf": [
                {
                  "type": "string",
                  "format": "uri"
                },
                {
                  "type": "null"
                }
              ]
            },
            "usageSigningKeyId": {
              "type": [
                "string",
                "null"
              ]
            },
            "usageUploadEnabled": {
              "type": "boolean"
            },
            "connectedAt": {
              "anyOf": [
                {
                  "$ref": "#/definitions/platform.login.exchange.result/properties/session/properties/expiresAt/anyOf/0"
                },
                {
                  "type": "null"
                }
              ]
            },
            "updatedAt": {
              "anyOf": [
                {
                  "$ref": "#/definitions/platform.login.exchange.result/properties/session/properties/expiresAt/anyOf/0"
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "state",
            "baseUrl",
            "tenantId",
            "organization",
            "user",
            "credentialRef",
            "tokenType",
            "expiresAt",
            "policyUrl",
            "usageIngestUrl",
            "usageSigningKeyId",
            "usageUploadEnabled",
            "connectedAt",
            "updatedAt"
          ],
          "additionalProperties": false
        },
        "policy": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "status": {
                  "type": "object",
                  "properties": {
                    "state": {
                      "type": "string",
                      "enum": [
                        "absent",
                        "active",
                        "rejected"
                      ]
                    },
                    "path": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "organization": {
                      "anyOf": [
                        {
                          "$ref": "#/definitions/platform.login.exchange.result/properties/session/properties/organization/anyOf/0"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "version": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "exclusiveMinimum": 0
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "keyId": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "issuedAt": {
                      "anyOf": [
                        {
                          "$ref": "#/definitions/platform.login.exchange.result/properties/session/properties/expiresAt/anyOf/0"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "expiresAt": {
                      "anyOf": [
                        {
                          "$ref": "#/definitions/platform.login.exchange.result/properties/session/properties/expiresAt/anyOf/0"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "error": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "locks": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "execpolicy",
                          "models",
                          "skills",
                          "mcp",
                          "plugins",
                          "sandbox",
                          "telemetry"
                        ]
                      }
                    },
                    "personalAdditions": {
                      "anyOf": [
                        {
                          "anyOf": [
                            {
                              "not": {}
                            },
                            {
                              "type": "object",
                              "properties": {
                                "skills": {
                                  "type": "boolean"
                                },
                                "mcp": {
                                  "type": "boolean"
                                }
                              },
                              "required": [
                                "skills",
                                "mcp"
                              ],
                              "additionalProperties": false
                            }
                          ]
                        },
                        {
                          "type": "null"
                        }
                      ],
                      "default": null
                    },
                    "capabilityCatalog": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "enum": [
                              "skill",
                              "mcp"
                            ]
                          },
                          "id": {
                            "type": "string"
                          },
                          "name": {
                            "type": "string"
                          },
                          "description": {
                            "type": "string"
                          },
                          "hash": {
                            "type": [
                              "string",
                              "null"
                            ]
                          },
                          "assignment": {
                            "type": "string",
                            "enum": [
                              "required",
                              "default-on",
                              "available",
                              "blocked"
                            ]
                          },
                          "content": {
                            "type": "string"
                          },
                          "url": {
                            "type": "string",
                            "format": "uri"
                          },
                          "transport": {
                            "type": "string",
                            "enum": [
                              "http-sse",
                              "streamable-http"
                            ]
                          }
                        },
                        "required": [
                          "kind",
                          "id",
                          "hash",
                          "assignment"
                        ],
                        "additionalProperties": false
                      },
                      "default": []
                    }
                  },
                  "required": [
                    "state",
                    "path",
                    "organization",
                    "version",
                    "keyId",
                    "issuedAt",
                    "expiresAt",
                    "error",
                    "locks"
                  ],
                  "additionalProperties": false
                },
                "bundle": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "version": {
                          "type": "integer",
                          "exclusiveMinimum": 0
                        },
                        "organization": {
                          "$ref": "#/definitions/platform.login.exchange.result/properties/session/properties/organization/anyOf/0"
                        },
                        "issuedAt": {
                          "$ref": "#/definitions/platform.login.exchange.result/properties/session/properties/expiresAt/anyOf/0"
                        },
                        "expiresAt": {
                          "anyOf": [
                            {
                              "$ref": "#/definitions/platform.login.exchange.result/properties/session/properties/expiresAt/anyOf/0"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "policy": {
                          "type": "object",
                          "properties": {
                            "execpolicy": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "id": {
                                    "type": "string",
                                    "minLength": 1
                                  },
                                  "kind": {
                                    "type": "string",
                                    "enum": [
                                      "prefix_rule",
                                      "exact",
                                      "regex-lite",
                                      "network"
                                    ]
                                  },
                                  "decision": {
                                    "type": "string",
                                    "enum": [
                                      "allow",
                                      "prompt",
                                      "forbid"
                                    ]
                                  },
                                  "pattern": {
                                    "anyOf": [
                                      {
                                        "type": "string"
                                      },
                                      {
                                        "type": "array",
                                        "items": {
                                          "type": "string"
                                        }
                                      }
                                    ]
                                  },
                                  "description": {
                                    "type": "string"
                                  }
                                },
                                "required": [
                                  "id",
                                  "kind",
                                  "decision",
                                  "pattern"
                                ],
                                "additionalProperties": false
                              },
                              "default": []
                            },
                            "modelAllowlist": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1
                              },
                              "default": []
                            },
                            "mcpAllowlist": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1
                              },
                              "default": []
                            },
                            "pluginAllowlist": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1
                              },
                              "default": []
                            },
                            "personalAdditions": {
                              "$ref": "#/definitions/platform.login.exchange.result/properties/policy/anyOf/0/properties/status/properties/personalAdditions/anyOf/0"
                            },
                            "capabilityCatalog": {
                              "$ref": "#/definitions/platform.login.exchange.result/properties/policy/anyOf/0/properties/status/properties/capabilityCatalog"
                            },
                            "sandboxFloor": {
                              "type": "string",
                              "enum": [
                                "read-only",
                                "workspace-write",
                                "danger-full-access"
                              ],
                              "default": "danger-full-access"
                            },
                            "telemetry": {
                              "type": "string",
                              "enum": [
                                "disabled",
                                "optional",
                                "required"
                              ],
                              "default": "optional"
                            }
                          },
                          "additionalProperties": false
                        },
                        "signature": {
                          "type": "object",
                          "properties": {
                            "algorithm": {
                              "type": "string",
                              "const": "ed25519"
                            },
                            "keyId": {
                              "type": "string",
                              "minLength": 1
                            },
                            "value": {
                              "type": "string",
                              "minLength": 1
                            }
                          },
                          "required": [
                            "algorithm",
                            "keyId",
                            "value"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "required": [
                        "version",
                        "organization",
                        "issuedAt",
                        "policy",
                        "signature"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "provenance": {
                  "type": "object",
                  "properties": {
                    "source": {
                      "type": "string",
                      "enum": [
                        "platform",
                        "mdm",
                        "manual",
                        "development"
                      ]
                    },
                    "url": {
                      "type": [
                        "string",
                        "null"
                      ]
                    },
                    "fetchedAt": {
                      "$ref": "#/definitions/platform.login.exchange.result/properties/session/properties/expiresAt/anyOf/0"
                    },
                    "verifiedAt": {
                      "anyOf": [
                        {
                          "$ref": "#/definitions/platform.login.exchange.result/properties/session/properties/expiresAt/anyOf/0"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "bundleHash": {
                      "type": [
                        "string",
                        "null"
                      ]
                    }
                  },
                  "required": [
                    "source",
                    "url",
                    "fetchedAt",
                    "verifiedAt",
                    "bundleHash"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "status",
                "bundle",
                "provenance"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "session",
        "policy"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `platform.login.start`

Params:

```json
{
  "$ref": "#/definitions/platform.login.start.params",
  "definitions": {
    "platform.login.start.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "baseUrl": {
              "type": "string",
              "format": "uri"
            },
            "redirectUri": {
              "type": "string",
              "format": "uri"
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/platform.login.start.result",
  "definitions": {
    "platform.login.start.result": {
      "type": "object",
      "properties": {
        "authorizationUrl": {
          "type": "string",
          "format": "uri"
        },
        "state": {
          "type": "string",
          "minLength": 1
        },
        "redirectUri": {
          "type": "string",
          "format": "uri"
        },
        "baseUrl": {
          "type": "string",
          "format": "uri"
        }
      },
      "required": [
        "authorizationUrl",
        "state",
        "redirectUri",
        "baseUrl"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `platform.logout`

Params:

```json
{
  "$ref": "#/definitions/platform.logout.params",
  "definitions": {
    "platform.logout.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/platform.logout.result",
  "definitions": {
    "platform.logout.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `platform.session.get`

Params:

```json
{
  "$ref": "#/definitions/platform.session.get.params",
  "definitions": {
    "platform.session.get.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/platform.session.get.result",
  "definitions": {
    "platform.session.get.result": {
      "type": "object",
      "properties": {
        "state": {
          "type": "string",
          "enum": [
            "signed-out",
            "connected"
          ]
        },
        "baseUrl": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "tenantId": {
          "type": [
            "string",
            "null"
          ]
        },
        "organization": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1
                },
                "name": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "id",
                "name"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "user": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1
                },
                "email": {
                  "anyOf": [
                    {
                      "type": "string",
                      "format": "email"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "name": {
                  "type": [
                    "string",
                    "null"
                  ]
                }
              },
              "required": [
                "id",
                "email",
                "name"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "credentialRef": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "tokenType": {
          "type": [
            "string",
            "null"
          ]
        },
        "expiresAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ]
        },
        "policyUrl": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "policyPublicKeys": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          },
          "default": {}
        },
        "usageIngestUrl": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "usageSigningKeyId": {
          "type": [
            "string",
            "null"
          ]
        },
        "usageUploadEnabled": {
          "type": "boolean"
        },
        "connectedAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/platform.session.get.result/properties/expiresAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ]
        },
        "updatedAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/platform.session.get.result/properties/expiresAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "state",
        "baseUrl",
        "tenantId",
        "organization",
        "user",
        "credentialRef",
        "tokenType",
        "expiresAt",
        "policyUrl",
        "usageIngestUrl",
        "usageSigningKeyId",
        "usageUploadEnabled",
        "connectedAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `platform.usage.flush`

Params:

```json
{
  "$ref": "#/definitions/platform.usage.flush.params",
  "definitions": {
    "platform.usage.flush.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 1000
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/platform.usage.flush.result",
  "definitions": {
    "platform.usage.flush.result": {
      "type": "object",
      "properties": {
        "uploaded": {
          "type": "integer",
          "minimum": 0
        },
        "skipped": {
          "type": "integer",
          "minimum": 0
        },
        "failed": {
          "type": "integer",
          "minimum": 0
        },
        "reason": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "uploaded",
        "skipped",
        "failed",
        "reason"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `plugin.applyUpdate`

Params:

```json
{
  "$ref": "#/definitions/plugin.applyUpdate.params",
  "definitions": {
    "plugin.applyUpdate.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "confirmHash": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "confirmHash"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/plugin.applyUpdate.result",
  "definitions": {
    "plugin.applyUpdate.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "name": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "source": {
          "type": "string"
        },
        "sourcePath": {
          "type": [
            "string",
            "null"
          ]
        },
        "sourceKind": {
          "type": "string",
          "enum": [
            "manifest",
            "folder",
            "git"
          ],
          "default": "manifest"
        },
        "sourceUrl": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "commitHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "contentHash": {
          "type": "string",
          "default": ""
        },
        "signatureStatus": {
          "type": "string",
          "enum": [
            "unsigned",
            "verified",
            "invalid"
          ],
          "default": "unsigned"
        },
        "signatureFingerprint": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "updateAvailable": {
          "type": "boolean",
          "default": false
        },
        "pendingVersion": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pendingContentHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pendingCommitHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "capabilityDiff": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "manifest": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/definitions/plugin.applyUpdate.result/properties/manifest"
              }
            },
            {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/definitions/plugin.applyUpdate.result/properties/manifest"
              }
            }
          ]
        },
        "trusted": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "installedAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/plugin.applyUpdate.result/properties/installedAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "name",
        "version",
        "description",
        "source",
        "sourcePath",
        "manifest",
        "trusted",
        "enabled",
        "installedAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `plugin.checkUpdate`

Params:

```json
{
  "$ref": "#/definitions/plugin.checkUpdate.params",
  "definitions": {
    "plugin.checkUpdate.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/plugin.checkUpdate.result",
  "definitions": {
    "plugin.checkUpdate.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "name": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "source": {
          "type": "string"
        },
        "sourcePath": {
          "type": [
            "string",
            "null"
          ]
        },
        "sourceKind": {
          "type": "string",
          "enum": [
            "manifest",
            "folder",
            "git"
          ],
          "default": "manifest"
        },
        "sourceUrl": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "commitHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "contentHash": {
          "type": "string",
          "default": ""
        },
        "signatureStatus": {
          "type": "string",
          "enum": [
            "unsigned",
            "verified",
            "invalid"
          ],
          "default": "unsigned"
        },
        "signatureFingerprint": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "updateAvailable": {
          "type": "boolean",
          "default": false
        },
        "pendingVersion": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pendingContentHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pendingCommitHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "capabilityDiff": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "manifest": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/definitions/plugin.checkUpdate.result/properties/manifest"
              }
            },
            {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/definitions/plugin.checkUpdate.result/properties/manifest"
              }
            }
          ]
        },
        "trusted": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "installedAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/plugin.checkUpdate.result/properties/installedAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "name",
        "version",
        "description",
        "source",
        "sourcePath",
        "manifest",
        "trusted",
        "enabled",
        "installedAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `plugin.delete`

Params:

```json
{
  "$ref": "#/definitions/plugin.delete.params",
  "definitions": {
    "plugin.delete.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/plugin.delete.result",
  "definitions": {
    "plugin.delete.result": {
      "type": "object",
      "properties": {
        "removed": {
          "type": "boolean"
        }
      },
      "required": [
        "removed"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `plugin.enable`

Params:

```json
{
  "$ref": "#/definitions/plugin.enable.params",
  "definitions": {
    "plugin.enable.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "enabled": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "enabled"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/plugin.enable.result",
  "definitions": {
    "plugin.enable.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `plugin.installGit`

Params:

```json
{
  "$ref": "#/definitions/plugin.installGit.params",
  "definitions": {
    "plugin.installGit.params": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string"
        }
      },
      "required": [
        "url"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/plugin.installGit.result",
  "definitions": {
    "plugin.installGit.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "name": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "source": {
          "type": "string"
        },
        "sourcePath": {
          "type": [
            "string",
            "null"
          ]
        },
        "sourceKind": {
          "type": "string",
          "enum": [
            "manifest",
            "folder",
            "git"
          ],
          "default": "manifest"
        },
        "sourceUrl": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "commitHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "contentHash": {
          "type": "string",
          "default": ""
        },
        "signatureStatus": {
          "type": "string",
          "enum": [
            "unsigned",
            "verified",
            "invalid"
          ],
          "default": "unsigned"
        },
        "signatureFingerprint": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "updateAvailable": {
          "type": "boolean",
          "default": false
        },
        "pendingVersion": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pendingContentHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pendingCommitHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "capabilityDiff": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "manifest": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/definitions/plugin.installGit.result/properties/manifest"
              }
            },
            {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/definitions/plugin.installGit.result/properties/manifest"
              }
            }
          ]
        },
        "trusted": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "installedAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/plugin.installGit.result/properties/installedAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "name",
        "version",
        "description",
        "source",
        "sourcePath",
        "manifest",
        "trusted",
        "enabled",
        "installedAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `plugin.installManifest`

Params:

```json
{
  "$ref": "#/definitions/plugin.installManifest.params",
  "definitions": {
    "plugin.installManifest.params": {
      "type": "object",
      "properties": {
        "manifest": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/definitions/plugin.installManifest.params/properties/manifest"
              }
            },
            {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/definitions/plugin.installManifest.params/properties/manifest"
              }
            }
          ]
        }
      },
      "required": [
        "manifest"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/plugin.installManifest.result",
  "definitions": {
    "plugin.installManifest.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "name": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "source": {
          "type": "string"
        },
        "sourcePath": {
          "type": [
            "string",
            "null"
          ]
        },
        "sourceKind": {
          "type": "string",
          "enum": [
            "manifest",
            "folder",
            "git"
          ],
          "default": "manifest"
        },
        "sourceUrl": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "commitHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "contentHash": {
          "type": "string",
          "default": ""
        },
        "signatureStatus": {
          "type": "string",
          "enum": [
            "unsigned",
            "verified",
            "invalid"
          ],
          "default": "unsigned"
        },
        "signatureFingerprint": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "updateAvailable": {
          "type": "boolean",
          "default": false
        },
        "pendingVersion": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pendingContentHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pendingCommitHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "capabilityDiff": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "manifest": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/definitions/plugin.installManifest.result/properties/manifest"
              }
            },
            {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/definitions/plugin.installManifest.result/properties/manifest"
              }
            }
          ]
        },
        "trusted": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "installedAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/plugin.installManifest.result/properties/installedAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "name",
        "version",
        "description",
        "source",
        "sourcePath",
        "manifest",
        "trusted",
        "enabled",
        "installedAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `plugin.installPath`

Params:

```json
{
  "$ref": "#/definitions/plugin.installPath.params",
  "definitions": {
    "plugin.installPath.params": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/plugin.installPath.result",
  "definitions": {
    "plugin.installPath.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "name": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "source": {
          "type": "string"
        },
        "sourcePath": {
          "type": [
            "string",
            "null"
          ]
        },
        "sourceKind": {
          "type": "string",
          "enum": [
            "manifest",
            "folder",
            "git"
          ],
          "default": "manifest"
        },
        "sourceUrl": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "commitHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "contentHash": {
          "type": "string",
          "default": ""
        },
        "signatureStatus": {
          "type": "string",
          "enum": [
            "unsigned",
            "verified",
            "invalid"
          ],
          "default": "unsigned"
        },
        "signatureFingerprint": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "updateAvailable": {
          "type": "boolean",
          "default": false
        },
        "pendingVersion": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pendingContentHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pendingCommitHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "capabilityDiff": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "manifest": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/definitions/plugin.installPath.result/properties/manifest"
              }
            },
            {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/definitions/plugin.installPath.result/properties/manifest"
              }
            }
          ]
        },
        "trusted": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "installedAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/plugin.installPath.result/properties/installedAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "name",
        "version",
        "description",
        "source",
        "sourcePath",
        "manifest",
        "trusted",
        "enabled",
        "installedAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `plugin.list`

Params:

```json
{
  "$ref": "#/definitions/plugin.list.params",
  "definitions": {
    "plugin.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "workspaceId": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/plugin.list.result",
  "definitions": {
    "plugin.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": [
              "string",
              "null"
            ]
          },
          "name": {
            "type": "string"
          },
          "version": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "source": {
            "type": "string"
          },
          "sourcePath": {
            "type": [
              "string",
              "null"
            ]
          },
          "sourceKind": {
            "type": "string",
            "enum": [
              "manifest",
              "folder",
              "git"
            ],
            "default": "manifest"
          },
          "sourceUrl": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "commitHash": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "contentHash": {
            "type": "string",
            "default": ""
          },
          "signatureStatus": {
            "type": "string",
            "enum": [
              "unsigned",
              "verified",
              "invalid"
            ],
            "default": "unsigned"
          },
          "signatureFingerprint": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "updateAvailable": {
            "type": "boolean",
            "default": false
          },
          "pendingVersion": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "pendingContentHash": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "pendingCommitHash": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "capabilityDiff": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "default": []
          },
          "manifest": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              },
              {
                "type": "null"
              },
              {
                "type": "array",
                "items": {
                  "$ref": "#/definitions/plugin.list.result/items/properties/manifest"
                }
              },
              {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/definitions/plugin.list.result/items/properties/manifest"
                }
              }
            ]
          },
          "trusted": {
            "type": "boolean"
          },
          "enabled": {
            "type": "boolean"
          },
          "installedAt": {
            "type": "string",
            "format": "date-time"
          },
          "updatedAt": {
            "$ref": "#/definitions/plugin.list.result/items/properties/installedAt"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "name",
          "version",
          "description",
          "source",
          "sourcePath",
          "manifest",
          "trusted",
          "enabled",
          "installedAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `plugin.trust`

Params:

```json
{
  "$ref": "#/definitions/plugin.trust.params",
  "definitions": {
    "plugin.trust.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "trusted": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "trusted"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/plugin.trust.result",
  "definitions": {
    "plugin.trust.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `policy.get`

Params:

```json
{
  "$ref": "#/definitions/policy.get.params",
  "definitions": {
    "policy.get.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/policy.get.result",
  "definitions": {
    "policy.get.result": {
      "type": "object",
      "properties": {
        "state": {
          "type": "string",
          "enum": [
            "absent",
            "active",
            "rejected"
          ]
        },
        "path": {
          "type": [
            "string",
            "null"
          ]
        },
        "organization": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1
                },
                "name": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "id",
                "name"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "version": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "keyId": {
          "type": [
            "string",
            "null"
          ]
        },
        "issuedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ]
        },
        "expiresAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/policy.get.result/properties/issuedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ]
        },
        "error": {
          "type": [
            "string",
            "null"
          ]
        },
        "locks": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "execpolicy",
              "models",
              "skills",
              "mcp",
              "plugins",
              "sandbox",
              "telemetry"
            ]
          }
        },
        "personalAdditions": {
          "anyOf": [
            {
              "anyOf": [
                {
                  "not": {}
                },
                {
                  "type": "object",
                  "properties": {
                    "skills": {
                      "type": "boolean"
                    },
                    "mcp": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "skills",
                    "mcp"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "capabilityCatalog": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "skill",
                  "mcp"
                ]
              },
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "description": {
                "type": "string"
              },
              "hash": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "assignment": {
                "type": "string",
                "enum": [
                  "required",
                  "default-on",
                  "available",
                  "blocked"
                ]
              },
              "content": {
                "type": "string"
              },
              "url": {
                "type": "string",
                "format": "uri"
              },
              "transport": {
                "type": "string",
                "enum": [
                  "http-sse",
                  "streamable-http"
                ]
              }
            },
            "required": [
              "kind",
              "id",
              "hash",
              "assignment"
            ],
            "additionalProperties": false
          },
          "default": []
        }
      },
      "required": [
        "state",
        "path",
        "organization",
        "version",
        "keyId",
        "issuedAt",
        "expiresAt",
        "error",
        "locks"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `policy.rule.create`

Params:

```json
{
  "$ref": "#/definitions/policy.rule.create.params",
  "definitions": {
    "policy.rule.create.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "layer": {
          "type": "string",
          "enum": [
            "user",
            "workspace"
          ]
        },
        "kind": {
          "type": "string",
          "enum": [
            "prefix_rule",
            "exact",
            "regex-lite",
            "network"
          ]
        },
        "decision": {
          "type": "string",
          "enum": [
            "allow",
            "prompt",
            "forbid"
          ]
        },
        "pattern": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        },
        "description": {
          "type": "string"
        }
      },
      "required": [
        "layer",
        "kind",
        "decision",
        "pattern"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/policy.rule.create.result",
  "definitions": {
    "policy.rule.create.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "layer": {
          "type": "string",
          "enum": [
            "managed",
            "workspace",
            "user",
            "session"
          ]
        },
        "kind": {
          "type": "string",
          "enum": [
            "prefix_rule",
            "exact",
            "regex-lite",
            "network"
          ]
        },
        "decision": {
          "type": "string",
          "enum": [
            "allow",
            "prompt",
            "forbid"
          ]
        },
        "pattern": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        },
        "description": {
          "type": [
            "string",
            "null"
          ]
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/policy.rule.create.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "layer",
        "kind",
        "decision",
        "pattern",
        "description",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `policy.rule.delete`

Params:

```json
{
  "$ref": "#/definitions/policy.rule.delete.params",
  "definitions": {
    "policy.rule.delete.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/policy.rule.delete.result",
  "definitions": {
    "policy.rule.delete.result": {
      "type": "object",
      "properties": {
        "removed": {
          "type": "boolean"
        }
      },
      "required": [
        "removed"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `policy.rule.list`

Params:

```json
{
  "$ref": "#/definitions/policy.rule.list.params",
  "definitions": {
    "policy.rule.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "workspaceId": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/policy.rule.list.result",
  "definitions": {
    "policy.rule.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": [
              "string",
              "null"
            ]
          },
          "layer": {
            "type": "string",
            "enum": [
              "managed",
              "workspace",
              "user",
              "session"
            ]
          },
          "kind": {
            "type": "string",
            "enum": [
              "prefix_rule",
              "exact",
              "regex-lite",
              "network"
            ]
          },
          "decision": {
            "type": "string",
            "enum": [
              "allow",
              "prompt",
              "forbid"
            ]
          },
          "pattern": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            ]
          },
          "description": {
            "type": [
              "string",
              "null"
            ]
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "updatedAt": {
            "$ref": "#/definitions/policy.rule.list.result/items/properties/createdAt"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "layer",
          "kind",
          "decision",
          "pattern",
          "description",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `policy.rule.update`

Params:

```json
{
  "$ref": "#/definitions/policy.rule.update.params",
  "definitions": {
    "policy.rule.update.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "enum": [
            "prefix_rule",
            "exact",
            "regex-lite",
            "network"
          ]
        },
        "decision": {
          "type": "string",
          "enum": [
            "allow",
            "prompt",
            "forbid"
          ]
        },
        "pattern": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        },
        "description": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "id",
        "kind",
        "decision",
        "pattern"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/policy.rule.update.result",
  "definitions": {
    "policy.rule.update.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "layer": {
          "type": "string",
          "enum": [
            "managed",
            "workspace",
            "user",
            "session"
          ]
        },
        "kind": {
          "type": "string",
          "enum": [
            "prefix_rule",
            "exact",
            "regex-lite",
            "network"
          ]
        },
        "decision": {
          "type": "string",
          "enum": [
            "allow",
            "prompt",
            "forbid"
          ]
        },
        "pattern": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        },
        "description": {
          "type": [
            "string",
            "null"
          ]
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/policy.rule.update.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "layer",
        "kind",
        "decision",
        "pattern",
        "description",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `policy.sync`

Params:

```json
{
  "$ref": "#/definitions/policy.sync.params",
  "definitions": {
    "policy.sync.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "url": {
              "type": "string",
              "format": "uri"
            },
            "tenantId": {
              "type": "string"
            },
            "accessToken": {
              "type": "string"
            },
            "publicKeys": {
              "type": "object",
              "additionalProperties": {
                "type": "string"
              }
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/policy.sync.result",
  "definitions": {
    "policy.sync.result": {
      "type": "object",
      "properties": {
        "status": {
          "type": "object",
          "properties": {
            "state": {
              "type": "string",
              "enum": [
                "absent",
                "active",
                "rejected"
              ]
            },
            "path": {
              "type": [
                "string",
                "null"
              ]
            },
            "organization": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "id",
                    "name"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "null"
                }
              ]
            },
            "version": {
              "anyOf": [
                {
                  "type": "integer",
                  "exclusiveMinimum": 0
                },
                {
                  "type": "null"
                }
              ]
            },
            "keyId": {
              "type": [
                "string",
                "null"
              ]
            },
            "issuedAt": {
              "anyOf": [
                {
                  "type": "string",
                  "format": "date-time"
                },
                {
                  "type": "null"
                }
              ]
            },
            "expiresAt": {
              "anyOf": [
                {
                  "$ref": "#/definitions/policy.sync.result/properties/status/properties/issuedAt/anyOf/0"
                },
                {
                  "type": "null"
                }
              ]
            },
            "error": {
              "type": [
                "string",
                "null"
              ]
            },
            "locks": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "execpolicy",
                  "models",
                  "skills",
                  "mcp",
                  "plugins",
                  "sandbox",
                  "telemetry"
                ]
              }
            },
            "personalAdditions": {
              "anyOf": [
                {
                  "anyOf": [
                    {
                      "not": {}
                    },
                    {
                      "type": "object",
                      "properties": {
                        "skills": {
                          "type": "boolean"
                        },
                        "mcp": {
                          "type": "boolean"
                        }
                      },
                      "required": [
                        "skills",
                        "mcp"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                {
                  "type": "null"
                }
              ],
              "default": null
            },
            "capabilityCatalog": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "enum": [
                      "skill",
                      "mcp"
                    ]
                  },
                  "id": {
                    "type": "string"
                  },
                  "name": {
                    "type": "string"
                  },
                  "description": {
                    "type": "string"
                  },
                  "hash": {
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "assignment": {
                    "type": "string",
                    "enum": [
                      "required",
                      "default-on",
                      "available",
                      "blocked"
                    ]
                  },
                  "content": {
                    "type": "string"
                  },
                  "url": {
                    "type": "string",
                    "format": "uri"
                  },
                  "transport": {
                    "type": "string",
                    "enum": [
                      "http-sse",
                      "streamable-http"
                    ]
                  }
                },
                "required": [
                  "kind",
                  "id",
                  "hash",
                  "assignment"
                ],
                "additionalProperties": false
              },
              "default": []
            }
          },
          "required": [
            "state",
            "path",
            "organization",
            "version",
            "keyId",
            "issuedAt",
            "expiresAt",
            "error",
            "locks"
          ],
          "additionalProperties": false
        },
        "bundle": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "version": {
                  "type": "integer",
                  "exclusiveMinimum": 0
                },
                "organization": {
                  "$ref": "#/definitions/policy.sync.result/properties/status/properties/organization/anyOf/0"
                },
                "issuedAt": {
                  "$ref": "#/definitions/policy.sync.result/properties/status/properties/issuedAt/anyOf/0"
                },
                "expiresAt": {
                  "anyOf": [
                    {
                      "$ref": "#/definitions/policy.sync.result/properties/status/properties/issuedAt/anyOf/0"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "policy": {
                  "type": "object",
                  "properties": {
                    "execpolicy": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "minLength": 1
                          },
                          "kind": {
                            "type": "string",
                            "enum": [
                              "prefix_rule",
                              "exact",
                              "regex-lite",
                              "network"
                            ]
                          },
                          "decision": {
                            "type": "string",
                            "enum": [
                              "allow",
                              "prompt",
                              "forbid"
                            ]
                          },
                          "pattern": {
                            "anyOf": [
                              {
                                "type": "string"
                              },
                              {
                                "type": "array",
                                "items": {
                                  "type": "string"
                                }
                              }
                            ]
                          },
                          "description": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "id",
                          "kind",
                          "decision",
                          "pattern"
                        ],
                        "additionalProperties": false
                      },
                      "default": []
                    },
                    "modelAllowlist": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      },
                      "default": []
                    },
                    "mcpAllowlist": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      },
                      "default": []
                    },
                    "pluginAllowlist": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      },
                      "default": []
                    },
                    "personalAdditions": {
                      "$ref": "#/definitions/policy.sync.result/properties/status/properties/personalAdditions/anyOf/0"
                    },
                    "capabilityCatalog": {
                      "$ref": "#/definitions/policy.sync.result/properties/status/properties/capabilityCatalog"
                    },
                    "sandboxFloor": {
                      "type": "string",
                      "enum": [
                        "read-only",
                        "workspace-write",
                        "danger-full-access"
                      ],
                      "default": "danger-full-access"
                    },
                    "telemetry": {
                      "type": "string",
                      "enum": [
                        "disabled",
                        "optional",
                        "required"
                      ],
                      "default": "optional"
                    }
                  },
                  "additionalProperties": false
                },
                "signature": {
                  "type": "object",
                  "properties": {
                    "algorithm": {
                      "type": "string",
                      "const": "ed25519"
                    },
                    "keyId": {
                      "type": "string",
                      "minLength": 1
                    },
                    "value": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "algorithm",
                    "keyId",
                    "value"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "version",
                "organization",
                "issuedAt",
                "policy",
                "signature"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "provenance": {
          "type": "object",
          "properties": {
            "source": {
              "type": "string",
              "enum": [
                "platform",
                "mdm",
                "manual",
                "development"
              ]
            },
            "url": {
              "type": [
                "string",
                "null"
              ]
            },
            "fetchedAt": {
              "$ref": "#/definitions/policy.sync.result/properties/status/properties/issuedAt/anyOf/0"
            },
            "verifiedAt": {
              "anyOf": [
                {
                  "$ref": "#/definitions/policy.sync.result/properties/status/properties/issuedAt/anyOf/0"
                },
                {
                  "type": "null"
                }
              ]
            },
            "bundleHash": {
              "type": [
                "string",
                "null"
              ]
            }
          },
          "required": [
            "source",
            "url",
            "fetchedAt",
            "verifiedAt",
            "bundleHash"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "status",
        "bundle",
        "provenance"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `question.answer`

Params:

```json
{
  "$ref": "#/definitions/question.answer.params",
  "definitions": {
    "question.answer.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "answer": {
          "type": "string"
        },
        "selectedOptions": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "id",
        "answer"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/question.answer.result",
  "definitions": {
    "question.answer.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `question.list`

Params:

```json
{
  "$ref": "#/definitions/question.list.params",
  "definitions": {
    "question.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/question.list.result",
  "definitions": {
    "question.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "taskId": {
            "type": [
              "string",
              "null"
            ]
          },
          "sessionId": {
            "type": "string"
          },
          "toolCallId": {
            "type": [
              "string",
              "null"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "answered",
              "cancelled",
              "expired"
            ]
          },
          "question": {
            "type": "string"
          },
          "options": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "label": {
                  "type": "string"
                },
                "description": {
                  "type": "string"
                }
              },
              "required": [
                "label"
              ],
              "additionalProperties": false
            },
            "default": []
          },
          "multi": {
            "type": "boolean",
            "default": false
          },
          "answer": {
            "anyOf": [
              {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  },
                  {
                    "type": "null"
                  },
                  {
                    "type": "array",
                    "items": {
                      "$ref": "#/definitions/question.list.result/items/properties/answer/anyOf/0"
                    }
                  },
                  {
                    "type": "object",
                    "additionalProperties": {
                      "$ref": "#/definitions/question.list.result/items/properties/answer/anyOf/0"
                    }
                  }
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "answeredAt": {
            "anyOf": [
              {
                "$ref": "#/definitions/question.list.result/items/properties/createdAt"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "taskId",
          "sessionId",
          "toolCallId",
          "status",
          "question",
          "answer",
          "createdAt",
          "answeredAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.comment.create`

Params:

```json
{
  "$ref": "#/definitions/review.comment.create.params",
  "definitions": {
    "review.comment.create.params": {
      "type": "object",
      "properties": {
        "reviewSessionId": {
          "type": "string"
        },
        "anchor": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "minLength": 1
            },
            "oldPath": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "side": {
              "type": "string",
              "enum": [
                "old",
                "new"
              ]
            },
            "line": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "commitSha": {
              "type": "string",
              "minLength": 7
            },
            "contextHash": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "path",
            "oldPath",
            "side",
            "line",
            "commitSha",
            "contextHash"
          ],
          "additionalProperties": false
        },
        "body": {
          "type": "string",
          "minLength": 1,
          "maxLength": 20000
        }
      },
      "required": [
        "reviewSessionId",
        "anchor",
        "body"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/review.comment.create.result",
  "definitions": {
    "review.comment.create.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "reviewSessionId": {
          "type": "string"
        },
        "anchor": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "minLength": 1
            },
            "oldPath": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "side": {
              "type": "string",
              "enum": [
                "old",
                "new"
              ]
            },
            "line": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "commitSha": {
              "type": "string",
              "minLength": 7
            },
            "contextHash": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "path",
            "oldPath",
            "side",
            "line",
            "commitSha",
            "contextHash"
          ],
          "additionalProperties": false
        },
        "body": {
          "type": "string",
          "minLength": 1
        },
        "resolved": {
          "type": "boolean"
        },
        "source": {
          "type": "string",
          "enum": [
            "local",
            "github"
          ]
        },
        "author": {
          "type": [
            "string",
            "null"
          ]
        },
        "url": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "externalId": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "inReplyToId": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "outdated": {
          "type": "boolean"
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/review.comment.create.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "reviewSessionId",
        "anchor",
        "body",
        "resolved",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.comment.list`

Params:

```json
{
  "$ref": "#/definitions/review.comment.list.params",
  "definitions": {
    "review.comment.list.params": {
      "type": "object",
      "properties": {
        "reviewSessionId": {
          "type": "string"
        }
      },
      "required": [
        "reviewSessionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/review.comment.list.result",
  "definitions": {
    "review.comment.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "reviewSessionId": {
            "type": "string"
          },
          "anchor": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1
              },
              "oldPath": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "side": {
                "type": "string",
                "enum": [
                  "old",
                  "new"
                ]
              },
              "line": {
                "type": "integer",
                "exclusiveMinimum": 0
              },
              "commitSha": {
                "type": "string",
                "minLength": 7
              },
              "contextHash": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "path",
              "oldPath",
              "side",
              "line",
              "commitSha",
              "contextHash"
            ],
            "additionalProperties": false
          },
          "body": {
            "type": "string",
            "minLength": 1
          },
          "resolved": {
            "type": "boolean"
          },
          "source": {
            "type": "string",
            "enum": [
              "local",
              "github"
            ]
          },
          "author": {
            "type": [
              "string",
              "null"
            ]
          },
          "url": {
            "anyOf": [
              {
                "type": "string",
                "format": "uri"
              },
              {
                "type": "null"
              }
            ]
          },
          "externalId": {
            "anyOf": [
              {
                "type": "integer",
                "exclusiveMinimum": 0
              },
              {
                "type": "null"
              }
            ]
          },
          "inReplyToId": {
            "anyOf": [
              {
                "type": "integer",
                "exclusiveMinimum": 0
              },
              {
                "type": "null"
              }
            ]
          },
          "outdated": {
            "type": "boolean"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "updatedAt": {
            "$ref": "#/definitions/review.comment.list.result/items/properties/createdAt"
          }
        },
        "required": [
          "id",
          "reviewSessionId",
          "anchor",
          "body",
          "resolved",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.comment.resolve`

Params:

```json
{
  "$ref": "#/definitions/review.comment.resolve.params",
  "definitions": {
    "review.comment.resolve.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "resolved": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "resolved"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/review.comment.resolve.result",
  "definitions": {
    "review.comment.resolve.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "reviewSessionId": {
          "type": "string"
        },
        "anchor": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "minLength": 1
            },
            "oldPath": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "side": {
              "type": "string",
              "enum": [
                "old",
                "new"
              ]
            },
            "line": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "commitSha": {
              "type": "string",
              "minLength": 7
            },
            "contextHash": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "path",
            "oldPath",
            "side",
            "line",
            "commitSha",
            "contextHash"
          ],
          "additionalProperties": false
        },
        "body": {
          "type": "string",
          "minLength": 1
        },
        "resolved": {
          "type": "boolean"
        },
        "source": {
          "type": "string",
          "enum": [
            "local",
            "github"
          ]
        },
        "author": {
          "type": [
            "string",
            "null"
          ]
        },
        "url": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "externalId": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "inReplyToId": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "outdated": {
          "type": "boolean"
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/review.comment.resolve.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "reviewSessionId",
        "anchor",
        "body",
        "resolved",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.finding.apply`

Params:

```json
{
  "$ref": "#/definitions/review.finding.apply.params",
  "definitions": {
    "review.finding.apply.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/review.finding.apply.result",
  "definitions": {
    "review.finding.apply.result": {
      "type": "object",
      "properties": {
        "applied": {
          "type": "boolean"
        },
        "files": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "applied",
        "files"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.finding.convert`

Params:

```json
{
  "$ref": "#/definitions/review.finding.convert.params",
  "definitions": {
    "review.finding.convert.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/review.finding.convert.result",
  "definitions": {
    "review.finding.convert.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "reviewSessionId": {
          "type": "string"
        },
        "anchor": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "minLength": 1
            },
            "oldPath": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "side": {
              "type": "string",
              "enum": [
                "old",
                "new"
              ]
            },
            "line": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "commitSha": {
              "type": "string",
              "minLength": 7
            },
            "contextHash": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "path",
            "oldPath",
            "side",
            "line",
            "commitSha",
            "contextHash"
          ],
          "additionalProperties": false
        },
        "body": {
          "type": "string",
          "minLength": 1
        },
        "resolved": {
          "type": "boolean"
        },
        "source": {
          "type": "string",
          "enum": [
            "local",
            "github"
          ]
        },
        "author": {
          "type": [
            "string",
            "null"
          ]
        },
        "url": {
          "anyOf": [
            {
              "type": "string",
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "externalId": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "inReplyToId": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "outdated": {
          "type": "boolean"
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/review.finding.convert.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "reviewSessionId",
        "anchor",
        "body",
        "resolved",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.finding.list`

Params:

```json
{
  "$ref": "#/definitions/review.finding.list.params",
  "definitions": {
    "review.finding.list.params": {
      "type": "object",
      "properties": {
        "reviewSessionId": {
          "type": "string"
        }
      },
      "required": [
        "reviewSessionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/review.finding.list.result",
  "definitions": {
    "review.finding.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "reviewSessionId": {
            "type": "string"
          },
          "severity": {
            "type": "string",
            "enum": [
              "low",
              "medium",
              "high",
              "critical"
            ]
          },
          "anchor": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1
              },
              "oldPath": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "side": {
                "type": "string",
                "enum": [
                  "old",
                  "new"
                ]
              },
              "line": {
                "type": "integer",
                "exclusiveMinimum": 0
              },
              "commitSha": {
                "type": "string",
                "minLength": 7
              },
              "contextHash": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "path",
              "oldPath",
              "side",
              "line",
              "commitSha",
              "contextHash"
            ],
            "additionalProperties": false
          },
          "title": {
            "type": "string"
          },
          "rationale": {
            "type": "string"
          },
          "suggestionPatch": {
            "type": [
              "string",
              "null"
            ]
          },
          "verificationReason": {
            "type": "string"
          },
          "convertedCommentId": {
            "type": [
              "string",
              "null"
            ]
          },
          "applied": {
            "type": "boolean"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "updatedAt": {
            "$ref": "#/definitions/review.finding.list.result/items/properties/createdAt"
          }
        },
        "required": [
          "id",
          "reviewSessionId",
          "severity",
          "anchor",
          "title",
          "rationale",
          "suggestionPatch",
          "verificationReason",
          "convertedCommentId",
          "applied",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.session.complete`

Params:

```json
{
  "$ref": "#/definitions/review.session.complete.params",
  "definitions": {
    "review.session.complete.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/review.session.complete.result",
  "definitions": {
    "review.session.complete.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "scope": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "working-tree"
                },
                "baseBranch": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "branch"
                },
                "branch": {
                  "type": "string",
                  "minLength": 1
                },
                "baseBranch": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "branch",
                "baseBranch"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "range"
                },
                "from": {
                  "type": "string",
                  "minLength": 1
                },
                "to": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "from",
                "to"
              ],
              "additionalProperties": false
            }
          ]
        },
        "commitSha": {
          "type": "string",
          "minLength": 7
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "completed"
          ]
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/review.session.complete.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "scope",
        "commitSha",
        "status",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.session.create`

Params:

```json
{
  "$ref": "#/definitions/review.session.create.params",
  "definitions": {
    "review.session.create.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "scope": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "working-tree"
                },
                "baseBranch": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "branch"
                },
                "branch": {
                  "type": "string",
                  "minLength": 1
                },
                "baseBranch": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "branch",
                "baseBranch"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "range"
                },
                "from": {
                  "type": "string",
                  "minLength": 1
                },
                "to": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "from",
                "to"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "workspaceId",
        "scope"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/review.session.create.result",
  "definitions": {
    "review.session.create.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "scope": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "working-tree"
                },
                "baseBranch": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "branch"
                },
                "branch": {
                  "type": "string",
                  "minLength": 1
                },
                "baseBranch": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "branch",
                "baseBranch"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "range"
                },
                "from": {
                  "type": "string",
                  "minLength": 1
                },
                "to": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "from",
                "to"
              ],
              "additionalProperties": false
            }
          ]
        },
        "commitSha": {
          "type": "string",
          "minLength": 7
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "completed"
          ]
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/review.session.create.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "scope",
        "commitSha",
        "status",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.session.get`

Params:

```json
{
  "$ref": "#/definitions/review.session.get.params",
  "definitions": {
    "review.session.get.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/review.session.get.result",
  "definitions": {
    "review.session.get.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "scope": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "working-tree"
                },
                "baseBranch": {
                  "anyOf": [
                    {
                      "type": "string",
                      "minLength": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "branch"
                },
                "branch": {
                  "type": "string",
                  "minLength": 1
                },
                "baseBranch": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "branch",
                "baseBranch"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "range"
                },
                "from": {
                  "type": "string",
                  "minLength": 1
                },
                "to": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "kind",
                "from",
                "to"
              ],
              "additionalProperties": false
            }
          ]
        },
        "commitSha": {
          "type": "string",
          "minLength": 7
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "completed"
          ]
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/review.session.get.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "scope",
        "commitSha",
        "status",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.session.list`

Params:

```json
{
  "$ref": "#/definitions/review.session.list.params",
  "definitions": {
    "review.session.list.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/review.session.list.result",
  "definitions": {
    "review.session.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": "string"
          },
          "taskId": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "scope": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "working-tree"
                  },
                  "baseBranch": {
                    "anyOf": [
                      {
                        "type": "string",
                        "minLength": 1
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "kind"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "branch"
                  },
                  "branch": {
                    "type": "string",
                    "minLength": 1
                  },
                  "baseBranch": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "required": [
                  "kind",
                  "branch",
                  "baseBranch"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "range"
                  },
                  "from": {
                    "type": "string",
                    "minLength": 1
                  },
                  "to": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "required": [
                  "kind",
                  "from",
                  "to"
                ],
                "additionalProperties": false
              }
            ]
          },
          "commitSha": {
            "type": "string",
            "minLength": 7
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "completed"
            ]
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "updatedAt": {
            "$ref": "#/definitions/review.session.list.result/items/properties/createdAt"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "scope",
          "commitSha",
          "status",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `review.start`

Params:

```json
{
  "$ref": "#/definitions/review.start.params",
  "definitions": {
    "review.start.params": {
      "type": "object",
      "properties": {
        "reviewSessionId": {
          "type": "string"
        },
        "providerId": {
          "type": "string"
        },
        "model": {
          "type": "string"
        }
      },
      "required": [
        "reviewSessionId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/review.start.result",
  "definitions": {
    "review.start.result": {
      "type": "object",
      "properties": {
        "session": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "workspaceId": {
              "type": "string"
            },
            "taskId": {
              "type": [
                "string",
                "null"
              ],
              "default": null
            },
            "scope": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "working-tree"
                    },
                    "baseBranch": {
                      "anyOf": [
                        {
                          "type": "string",
                          "minLength": 1
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "kind"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "branch"
                    },
                    "branch": {
                      "type": "string",
                      "minLength": 1
                    },
                    "baseBranch": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "branch",
                    "baseBranch"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "range"
                    },
                    "from": {
                      "type": "string",
                      "minLength": 1
                    },
                    "to": {
                      "type": "string",
                      "minLength": 1
                    }
                  },
                  "required": [
                    "kind",
                    "from",
                    "to"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "commitSha": {
              "type": "string",
              "minLength": 7
            },
            "status": {
              "type": "string",
              "enum": [
                "active",
                "completed"
              ]
            },
            "createdAt": {
              "type": "string",
              "format": "date-time"
            },
            "updatedAt": {
              "$ref": "#/definitions/review.start.result/properties/session/properties/createdAt"
            }
          },
          "required": [
            "id",
            "workspaceId",
            "scope",
            "commitSha",
            "status",
            "createdAt",
            "updatedAt"
          ],
          "additionalProperties": false
        },
        "findings": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "reviewSessionId": {
                "type": "string"
              },
              "severity": {
                "type": "string",
                "enum": [
                  "low",
                  "medium",
                  "high",
                  "critical"
                ]
              },
              "anchor": {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1
                  },
                  "oldPath": {
                    "anyOf": [
                      {
                        "type": "string",
                        "minLength": 1
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "side": {
                    "type": "string",
                    "enum": [
                      "old",
                      "new"
                    ]
                  },
                  "line": {
                    "type": "integer",
                    "exclusiveMinimum": 0
                  },
                  "commitSha": {
                    "type": "string",
                    "minLength": 7
                  },
                  "contextHash": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "required": [
                  "path",
                  "oldPath",
                  "side",
                  "line",
                  "commitSha",
                  "contextHash"
                ],
                "additionalProperties": false
              },
              "title": {
                "type": "string"
              },
              "rationale": {
                "type": "string"
              },
              "suggestionPatch": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "verificationReason": {
                "type": "string"
              },
              "convertedCommentId": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "applied": {
                "type": "boolean"
              },
              "createdAt": {
                "$ref": "#/definitions/review.start.result/properties/session/properties/createdAt"
              },
              "updatedAt": {
                "$ref": "#/definitions/review.start.result/properties/session/properties/createdAt"
              }
            },
            "required": [
              "id",
              "reviewSessionId",
              "severity",
              "anchor",
              "title",
              "rationale",
              "suggestionPatch",
              "verificationReason",
              "convertedCommentId",
              "applied",
              "createdAt",
              "updatedAt"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "session",
        "findings"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `router.account.get`

Params:

```json
{
  "$ref": "#/definitions/router.account.get.params",
  "definitions": {
    "router.account.get.params": {
      "type": "object",
      "properties": {
        "providerId": {
          "type": "string"
        },
        "credentialRef": {
          "type": "string"
        },
        "apiKey": {
          "type": "string"
        }
      },
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/router.account.get.result",
  "definitions": {
    "router.account.get.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "email": {
          "type": [
            "string",
            "null"
          ]
        },
        "displayName": {
          "type": [
            "string",
            "null"
          ]
        },
        "plan": {
          "type": "string"
        },
        "quota": {
          "type": "object",
          "properties": {
            "limit": {
              "anyOf": [
                {
                  "type": "number",
                  "minimum": 0
                },
                {
                  "type": "null"
                }
              ]
            },
            "used": {
              "type": "number",
              "minimum": 0
            },
            "remaining": {
              "anyOf": [
                {
                  "type": "number",
                  "minimum": 0
                },
                {
                  "type": "null"
                }
              ]
            },
            "unit": {
              "type": "string"
            },
            "resetsAt": {
              "anyOf": [
                {
                  "type": "string",
                  "format": "date-time"
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "limit",
            "used",
            "remaining",
            "unit",
            "resetsAt"
          ],
          "additionalProperties": false
        },
        "aliases": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "id",
        "email",
        "displayName",
        "plan",
        "quota",
        "aliases"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `router.contract.status`

Params:

```json
{
  "$ref": "#/definitions/router.contract.status.params",
  "definitions": {
    "router.contract.status.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/router.contract.status.result",
  "definitions": {
    "router.contract.status.result": {
      "type": "object",
      "properties": {
        "oauthAvailable": {
          "type": "boolean"
        },
        "redirectUri": {
          "type": "string"
        },
        "accountPath": {
          "type": "string"
        }
      },
      "required": [
        "oauthAvailable",
        "redirectUri",
        "accountPath"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `router.image.generate`

Params:

```json
{
  "$ref": "#/definitions/router.image.generate.params",
  "definitions": {
    "router.image.generate.params": {
      "type": "object",
      "properties": {
        "providerId": {
          "type": "string",
          "minLength": 1
        },
        "credentialRef": {
          "type": "string",
          "minLength": 1
        },
        "apiKey": {
          "type": "string",
          "minLength": 1
        },
        "prompt": {
          "type": "string",
          "minLength": 1
        },
        "model": {
          "type": "string",
          "minLength": 1
        },
        "size": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "prompt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/router.image.generate.result",
  "definitions": {
    "router.image.generate.result": {
      "type": "object",
      "properties": {
        "model": {
          "type": "string"
        },
        "created": {
          "type": "number"
        },
        "data": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "url": {
                "type": "string",
                "format": "uri"
              },
              "b64_json": {
                "type": "string"
              },
              "revised_prompt": {
                "type": "string"
              }
            },
            "additionalProperties": true
          }
        }
      },
      "required": [
        "data"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `router.oauth.exchange`

Params:

```json
{
  "$ref": "#/definitions/router.oauth.exchange.params",
  "definitions": {
    "router.oauth.exchange.params": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "minLength": 1
        },
        "state": {
          "type": "string",
          "minLength": 1
        },
        "redirectUri": {
          "type": "string",
          "format": "uri"
        }
      },
      "required": [
        "code",
        "state"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/router.oauth.exchange.result",
  "definitions": {
    "router.oauth.exchange.result": {
      "type": "object",
      "properties": {
        "accessToken": {
          "type": "string",
          "minLength": 1
        },
        "tokenType": {
          "type": "string"
        },
        "expiresAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "accessToken",
        "tokenType",
        "expiresAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `router.oauth.start`

Params:

```json
{
  "$ref": "#/definitions/router.oauth.start.params",
  "definitions": {
    "router.oauth.start.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "redirectUri": {
              "type": "string",
              "format": "uri"
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/router.oauth.start.result",
  "definitions": {
    "router.oauth.start.result": {
      "type": "object",
      "properties": {
        "authorizationUrl": {
          "type": "string",
          "format": "uri"
        },
        "state": {
          "type": "string"
        }
      },
      "required": [
        "authorizationUrl",
        "state"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `sandbox.status`

Params:

```json
{
  "$ref": "#/definitions/sandbox.status.params",
  "definitions": {
    "sandbox.status.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "permissionMode": {
          "type": "string",
          "enum": [
            "ask",
            "auto-edit",
            "plan",
            "full-access"
          ]
        }
      },
      "required": [
        "workspaceId",
        "permissionMode"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/sandbox.status.result",
  "definitions": {
    "sandbox.status.result": {
      "type": "object",
      "properties": {
        "platform": {
          "type": "string",
          "enum": [
            "macos",
            "linux",
            "windows",
            "other"
          ]
        },
        "tier": {
          "type": "string",
          "enum": [
            "read-only",
            "workspace-write",
            "danger-full-access"
          ]
        },
        "enforcement": {
          "type": "string",
          "enum": [
            "enforced",
            "approval-only"
          ]
        },
        "mechanism": {
          "type": "string",
          "enum": [
            "seatbelt",
            "bubblewrap",
            "none"
          ]
        },
        "network": {
          "type": "string",
          "enum": [
            "on",
            "off",
            "unrestricted"
          ]
        },
        "reason": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "platform",
        "tier",
        "enforcement",
        "mechanism",
        "network",
        "reason"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `search.ripgrep`

Params:

```json
{
  "$ref": "#/definitions/search.ripgrep.params",
  "definitions": {
    "search.ripgrep.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "query": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId",
        "query"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/search.ripgrep.result",
  "definitions": {
    "search.ripgrep.result": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string"
        },
        "exitCode": {
          "type": "integer"
        },
        "stdout": {
          "type": "string"
        },
        "stderr": {
          "type": "string"
        }
      },
      "required": [
        "command",
        "args",
        "cwd",
        "exitCode",
        "stdout",
        "stderr"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `session.appendMessage`

Params:

```json
{
  "$ref": "#/definitions/session.appendMessage.params",
  "definitions": {
    "session.appendMessage.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        },
        "role": {
          "type": "string",
          "enum": [
            "system",
            "user",
            "assistant",
            "tool"
          ]
        },
        "parts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string"
              },
              "content": {
                "anyOf": [
                  {
                    "type": "string"
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  },
                  {
                    "type": "null"
                  },
                  {
                    "type": "array",
                    "items": {
                      "$ref": "#/definitions/session.appendMessage.params/properties/parts/items/properties/content"
                    }
                  },
                  {
                    "type": "object",
                    "additionalProperties": {
                      "$ref": "#/definitions/session.appendMessage.params/properties/parts/items/properties/content"
                    }
                  }
                ]
              }
            },
            "required": [
              "kind",
              "content"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "sessionId",
        "parts"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/session.appendMessage.result",
  "definitions": {
    "session.appendMessage.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `session.compact`

Params:

```json
{
  "$ref": "#/definitions/session.compact.params",
  "definitions": {
    "session.compact.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/session.compact.result",
  "definitions": {
    "session.compact.result": {
      "type": "object",
      "properties": {
        "summary": {
          "type": "string"
        },
        "tokensBefore": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "summary",
        "tokensBefore"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `session.contextStats`

Params:

```json
{
  "$ref": "#/definitions/session.contextStats.params",
  "definitions": {
    "session.contextStats.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        },
        "providerId": {
          "type": [
            "string",
            "null"
          ]
        },
        "model": {
          "type": [
            "string",
            "null"
          ]
        },
        "pendingInput": {
          "type": "string"
        },
        "attachments": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "mediaType": {
                "type": "string"
              },
              "size": {
                "type": "integer",
                "minimum": 0
              },
              "dataUrl": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "textContent": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "localPath": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "sourceKind": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "name",
              "mediaType",
              "size"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/session.contextStats.result",
  "definitions": {
    "session.contextStats.result": {
      "type": "object",
      "properties": {
        "usedTokens": {
          "type": "integer",
          "minimum": 0
        },
        "contextWindow": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "percentUsed": {
          "anyOf": [
            {
              "type": "number",
              "minimum": 0,
              "maximum": 100
            },
            {
              "type": "null"
            }
          ]
        },
        "tokensLeft": {
          "anyOf": [
            {
              "type": "integer"
            },
            {
              "type": "null"
            }
          ]
        },
        "source": {
          "type": "string",
          "enum": [
            "estimated",
            "provider-reported",
            "unknown"
          ]
        },
        "thresholdState": {
          "type": "string",
          "enum": [
            "unknown",
            "normal",
            "warning",
            "critical"
          ]
        }
      },
      "required": [
        "usedTokens",
        "contextWindow",
        "percentUsed",
        "tokensLeft",
        "source",
        "thresholdState"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `session.fork`

Params:

```json
{
  "$ref": "#/definitions/session.fork.params",
  "definitions": {
    "session.fork.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        },
        "entryId": {
          "type": "string"
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/session.fork.result",
  "definitions": {
    "session.fork.result": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `session.get`

Params:

```json
{
  "$ref": "#/definitions/session.get.params",
  "definitions": {
    "session.get.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/session.get.result",
  "definitions": {
    "session.get.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "parentSessionId": {
          "type": [
            "string",
            "null"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "compacted",
            "forked",
            "rewound",
            "archived"
          ]
        },
        "modelProviderId": {
          "type": [
            "string",
            "null"
          ]
        },
        "model": {
          "type": [
            "string",
            "null"
          ]
        },
        "permissionMode": {
          "type": "string",
          "enum": [
            "ask",
            "auto-edit",
            "plan",
            "full-access"
          ]
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/session.get.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "taskId",
        "parentSessionId",
        "status",
        "modelProviderId",
        "model",
        "permissionMode",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `session.messages`

Params:

```json
{
  "$ref": "#/definitions/session.messages.params",
  "definitions": {
    "session.messages.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/session.messages.result",
  "definitions": {
    "session.messages.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "sessionId": {
            "type": "string"
          },
          "role": {
            "type": "string",
            "enum": [
              "system",
              "user",
              "assistant",
              "tool"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "streaming",
              "complete",
              "cancelled",
              "failed"
            ]
          },
          "parts": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string"
                },
                "messageId": {
                  "type": "string"
                },
                "kind": {
                  "type": "string",
                  "enum": [
                    "text",
                    "code",
                    "reasoning",
                    "tool-call",
                    "tool-result",
                    "image",
                    "attachment",
                    "terminal",
                    "browser-screenshot",
                    "error"
                  ]
                },
                "content": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "boolean"
                    },
                    {
                      "type": "null"
                    },
                    {
                      "type": "array",
                      "items": {
                        "$ref": "#/definitions/session.messages.result/items/properties/parts/items/properties/content"
                      }
                    },
                    {
                      "type": "object",
                      "additionalProperties": {
                        "$ref": "#/definitions/session.messages.result/items/properties/parts/items/properties/content"
                      }
                    }
                  ]
                },
                "position": {
                  "type": "integer",
                  "minimum": 0
                },
                "createdAt": {
                  "type": "string",
                  "format": "date-time"
                }
              },
              "required": [
                "id",
                "messageId",
                "kind",
                "content",
                "position",
                "createdAt"
              ],
              "additionalProperties": false
            }
          },
          "inputTokens": {
            "type": "number",
            "default": 0
          },
          "outputTokens": {
            "type": "number",
            "default": 0
          },
          "generationMs": {
            "type": "number",
            "default": 0
          },
          "createdAt": {
            "$ref": "#/definitions/session.messages.result/items/properties/parts/items/properties/createdAt"
          },
          "updatedAt": {
            "$ref": "#/definitions/session.messages.result/items/properties/parts/items/properties/createdAt"
          }
        },
        "required": [
          "id",
          "sessionId",
          "role",
          "status",
          "parts",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `session.rewind`

Params:

```json
{
  "$ref": "#/definitions/session.rewind.params",
  "definitions": {
    "session.rewind.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        },
        "entryId": {
          "type": "string"
        }
      },
      "required": [
        "sessionId",
        "entryId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/session.rewind.result",
  "definitions": {
    "session.rewind.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `session.setModel`

Params:

```json
{
  "$ref": "#/definitions/session.setModel.params",
  "definitions": {
    "session.setModel.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        },
        "providerId": {
          "type": "string"
        },
        "model": {
          "type": "string"
        }
      },
      "required": [
        "sessionId",
        "providerId",
        "model"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/session.setModel.result",
  "definitions": {
    "session.setModel.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `session.target.clear`

Params:

```json
{
  "$ref": "#/definitions/session.target.clear.params",
  "definitions": {
    "session.target.clear.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/session.target.clear.result",
  "definitions": {
    "session.target.clear.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `session.target.get`

Params:

```json
{
  "$ref": "#/definitions/session.target.get.params",
  "definitions": {
    "session.target.get.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        }
      },
      "required": [
        "sessionId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/session.target.get.result",
  "definitions": {
    "session.target.get.result": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "sessionId": {
              "type": "string"
            },
            "goalText": {
              "type": "string"
            },
            "status": {
              "type": "string",
              "enum": [
                "active",
                "met",
                "paused",
                "cleared"
              ]
            },
            "tokenBudget": {
              "anyOf": [
                {
                  "type": "integer",
                  "exclusiveMinimum": 0
                },
                {
                  "type": "null"
                }
              ]
            },
            "timeBudgetMin": {
              "anyOf": [
                {
                  "type": "integer",
                  "exclusiveMinimum": 0
                },
                {
                  "type": "null"
                }
              ]
            },
            "createdAt": {
              "type": "string",
              "format": "date-time"
            },
            "updatedAt": {
              "$ref": "#/definitions/session.target.get.result/anyOf/0/properties/createdAt"
            }
          },
          "required": [
            "sessionId",
            "goalText",
            "status",
            "tokenBudget",
            "timeBudgetMin",
            "createdAt",
            "updatedAt"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `session.target.set`

Params:

```json
{
  "$ref": "#/definitions/session.target.set.params",
  "definitions": {
    "session.target.set.params": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        },
        "goalText": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "met",
            "paused",
            "cleared"
          ]
        },
        "tokenBudget": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "timeBudgetMin": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "sessionId",
        "goalText"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/session.target.set.result",
  "definitions": {
    "session.target.set.result": {
      "type": "object",
      "properties": {
        "sessionId": {
          "type": "string"
        },
        "goalText": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "met",
            "paused",
            "cleared"
          ]
        },
        "tokenBudget": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "timeBudgetMin": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ]
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/session.target.set.result/properties/createdAt"
        }
      },
      "required": [
        "sessionId",
        "goalText",
        "status",
        "tokenBudget",
        "timeBudgetMin",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `settings.get`

Params:

```json
{
  "$ref": "#/definitions/settings.get.params",
  "definitions": {
    "settings.get.params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string"
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/settings.get.result",
  "definitions": {
    "settings.get.result": {
      "anyOf": [
        {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/definitions/settings.get.result/anyOf/0"
              }
            },
            {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/definitions/settings.get.result/anyOf/0"
              }
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `settings.list`

Params:

```json
{
  "$ref": "#/definitions/settings.list.params",
  "definitions": {
    "settings.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/settings.list.result",
  "definitions": {
    "settings.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string"
          },
          "value": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              },
              {
                "type": "null"
              },
              {
                "type": "array",
                "items": {
                  "$ref": "#/definitions/settings.list.result/items/properties/value"
                }
              },
              {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/definitions/settings.list.result/items/properties/value"
                }
              }
            ]
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time"
          }
        },
        "required": [
          "key",
          "value",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `settings.set`

Params:

```json
{
  "$ref": "#/definitions/settings.set.params",
  "definitions": {
    "settings.set.params": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string"
        },
        "value": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/definitions/settings.set.params/properties/value"
              }
            },
            {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/definitions/settings.set.params/properties/value"
              }
            }
          ]
        }
      },
      "required": [
        "key"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/settings.set.result",
  "definitions": {
    "settings.set.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `skill.create`

Params:

```json
{
  "$ref": "#/definitions/skill.create.params",
  "definitions": {
    "skill.create.params": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "scope": {
          "type": "string",
          "enum": [
            "project",
            "global"
          ]
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/skill.create.result",
  "definitions": {
    "skill.create.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "name": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "sourcePath": {
          "type": "string"
        },
        "originPath": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "version": {
          "type": "string",
          "default": "0.1.0"
        },
        "contentHash": {
          "type": "string",
          "default": ""
        },
        "updateAvailable": {
          "type": "boolean",
          "default": false
        },
        "pendingContentHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "scope": {
          "type": "string",
          "enum": [
            "workspace",
            "workspace-legacy",
            "user",
            "user-legacy",
            "codex",
            "registered",
            "plugin"
          ],
          "default": "registered"
        },
        "readOnly": {
          "type": "boolean",
          "default": false
        },
        "trusted": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "shadowedBy": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "shadows": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "diagnostic": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/skill.create.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "name",
        "description",
        "sourcePath",
        "trusted",
        "enabled",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `skill.delete`

Params:

```json
{
  "$ref": "#/definitions/skill.delete.params",
  "definitions": {
    "skill.delete.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/skill.delete.result",
  "definitions": {
    "skill.delete.result": {
      "type": "object",
      "properties": {
        "removed": {
          "type": "boolean"
        }
      },
      "required": [
        "removed"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `skill.enable`

Params:

```json
{
  "$ref": "#/definitions/skill.enable.params",
  "definitions": {
    "skill.enable.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "enabled": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "enabled"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/skill.enable.result",
  "definitions": {
    "skill.enable.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `skill.getUserDirectory`

Params:

```json
{
  "$ref": "#/definitions/skill.getUserDirectory.params",
  "definitions": {
    "skill.getUserDirectory.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/skill.getUserDirectory.result",
  "definitions": {
    "skill.getUserDirectory.result": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `skill.import`

Params:

```json
{
  "$ref": "#/definitions/skill.import.params",
  "definitions": {
    "skill.import.params": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "scope": {
          "type": "string",
          "enum": [
            "project",
            "global"
          ]
        },
        "conflictAction": {
          "type": "string",
          "enum": [
            "replace",
            "keep",
            "cancel"
          ]
        },
        "expectedFingerprint": {
          "type": "string"
        },
        "trusted": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "limits": {
          "type": "object",
          "properties": {
            "maxArchiveBytes": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxExtractedBytes": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxIndividualFileBytes": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxFiles": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "maxPathLength": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "maxDirectoryDepth": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "maxCompressionRatio": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxEntryCompressionRatio": {
              "type": "number",
              "exclusiveMinimum": 0
            }
          },
          "additionalProperties": false,
          "default": {}
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/skill.import.result",
  "definitions": {
    "skill.import.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": [
              "string",
              "null"
            ]
          },
          "name": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "sourcePath": {
            "type": "string"
          },
          "originPath": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "version": {
            "type": "string",
            "default": "0.1.0"
          },
          "contentHash": {
            "type": "string",
            "default": ""
          },
          "updateAvailable": {
            "type": "boolean",
            "default": false
          },
          "pendingContentHash": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "scope": {
            "type": "string",
            "enum": [
              "workspace",
              "workspace-legacy",
              "user",
              "user-legacy",
              "codex",
              "registered",
              "plugin"
            ],
            "default": "registered"
          },
          "readOnly": {
            "type": "boolean",
            "default": false
          },
          "trusted": {
            "type": "boolean"
          },
          "enabled": {
            "type": "boolean"
          },
          "shadowedBy": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "shadows": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "default": []
          },
          "diagnostic": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "updatedAt": {
            "$ref": "#/definitions/skill.import.result/items/properties/createdAt"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "name",
          "description",
          "sourcePath",
          "trusted",
          "enabled",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `skill.inspect`

Params:

```json
{
  "$ref": "#/definitions/skill.inspect.params",
  "definitions": {
    "skill.inspect.params": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "limits": {
          "type": "object",
          "properties": {
            "maxArchiveBytes": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxExtractedBytes": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxIndividualFileBytes": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxFiles": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "maxPathLength": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "maxDirectoryDepth": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "maxCompressionRatio": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxEntryCompressionRatio": {
              "type": "number",
              "exclusiveMinimum": 0
            }
          },
          "additionalProperties": false,
          "default": {}
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/skill.inspect.result",
  "definitions": {
    "skill.inspect.result": {
      "type": "object",
      "properties": {
        "archivePath": {
          "type": "string"
        },
        "archiveName": {
          "type": "string"
        },
        "fingerprint": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "license": {
          "type": [
            "string",
            "null"
          ]
        },
        "compatibility": {
          "type": [
            "string",
            "null"
          ]
        },
        "allowedTools": {
          "type": [
            "string",
            "null"
          ]
        },
        "metadata": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        },
        "version": {
          "type": "string"
        },
        "archiveSize": {
          "type": "number",
          "minimum": 0
        },
        "extractedSize": {
          "type": "number",
          "minimum": 0
        },
        "fileCount": {
          "type": "integer",
          "minimum": 0
        },
        "rootLayout": {
          "type": "string",
          "enum": [
            "archive-root",
            "top-level-directory"
          ]
        },
        "sourceDirectoryName": {
          "type": [
            "string",
            "null"
          ]
        },
        "hasScripts": {
          "type": "boolean"
        },
        "scripts": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "references": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "assets": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "resources": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "projectAvailable": {
          "type": "boolean"
        },
        "projectTrusted": {
          "type": "boolean"
        },
        "destinations": {
          "type": "object",
          "properties": {
            "project": {
              "type": [
                "string",
                "null"
              ]
            },
            "global": {
              "type": "string"
            }
          },
          "required": [
            "project",
            "global"
          ],
          "additionalProperties": false
        },
        "conflicts": {
          "type": "object",
          "properties": {
            "project": {
              "type": "boolean"
            },
            "global": {
              "type": "boolean"
            }
          },
          "required": [
            "project",
            "global"
          ],
          "additionalProperties": false
        },
        "limits": {
          "type": "object",
          "properties": {
            "maxArchiveBytes": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxExtractedBytes": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxIndividualFileBytes": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxFiles": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "maxPathLength": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "maxDirectoryDepth": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "maxCompressionRatio": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "maxEntryCompressionRatio": {
              "type": "number",
              "exclusiveMinimum": 0
            }
          },
          "additionalProperties": false,
          "default": {}
        }
      },
      "required": [
        "archivePath",
        "archiveName",
        "fingerprint",
        "name",
        "description",
        "license",
        "compatibility",
        "allowedTools",
        "metadata",
        "version",
        "archiveSize",
        "extractedSize",
        "fileCount",
        "rootLayout",
        "sourceDirectoryName",
        "hasScripts",
        "scripts",
        "references",
        "assets",
        "resources",
        "projectAvailable",
        "projectTrusted",
        "destinations",
        "conflicts"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `skill.list`

Params:

```json
{
  "$ref": "#/definitions/skill.list.params",
  "definitions": {
    "skill.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "workspaceId": {
              "type": "string"
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/skill.list.result",
  "definitions": {
    "skill.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": [
              "string",
              "null"
            ]
          },
          "name": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "sourcePath": {
            "type": "string"
          },
          "originPath": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "version": {
            "type": "string",
            "default": "0.1.0"
          },
          "contentHash": {
            "type": "string",
            "default": ""
          },
          "updateAvailable": {
            "type": "boolean",
            "default": false
          },
          "pendingContentHash": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "scope": {
            "type": "string",
            "enum": [
              "workspace",
              "workspace-legacy",
              "user",
              "user-legacy",
              "codex",
              "registered",
              "plugin"
            ],
            "default": "registered"
          },
          "readOnly": {
            "type": "boolean",
            "default": false
          },
          "trusted": {
            "type": "boolean"
          },
          "enabled": {
            "type": "boolean"
          },
          "shadowedBy": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "shadows": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "default": []
          },
          "diagnostic": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "updatedAt": {
            "$ref": "#/definitions/skill.list.result/items/properties/createdAt"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "name",
          "description",
          "sourcePath",
          "trusted",
          "enabled",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `skill.openFile`

Params:

```json
{
  "$ref": "#/definitions/skill.openFile.params",
  "definitions": {
    "skill.openFile.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/skill.openFile.result",
  "definitions": {
    "skill.openFile.result": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "command": {
              "type": "string"
            },
            "args": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "cwd": {
              "type": "string"
            },
            "exitCode": {
              "type": "integer"
            },
            "stdout": {
              "type": "string"
            },
            "stderr": {
              "type": "string"
            }
          },
          "required": [
            "command",
            "args",
            "cwd",
            "exitCode",
            "stdout",
            "stderr"
          ],
          "additionalProperties": true
        },
        {
          "type": "object",
          "properties": {
            "ok": {
              "type": "boolean"
            }
          },
          "required": [
            "ok"
          ],
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `skill.openFolder`

Params:

```json
{
  "$ref": "#/definitions/skill.openFolder.params",
  "definitions": {
    "skill.openFolder.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/skill.openFolder.result",
  "definitions": {
    "skill.openFolder.result": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "command": {
              "type": "string"
            },
            "args": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "cwd": {
              "type": "string"
            },
            "exitCode": {
              "type": "integer"
            },
            "stdout": {
              "type": "string"
            },
            "stderr": {
              "type": "string"
            }
          },
          "required": [
            "command",
            "args",
            "cwd",
            "exitCode",
            "stdout",
            "stderr"
          ],
          "additionalProperties": true
        },
        {
          "type": "object",
          "properties": {
            "ok": {
              "type": "boolean"
            }
          },
          "required": [
            "ok"
          ],
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `skill.save`

Params:

```json
{
  "$ref": "#/definitions/skill.save.params",
  "definitions": {
    "skill.save.params": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "sourcePath": {
          "type": "string"
        }
      },
      "required": [
        "name",
        "sourcePath"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/skill.save.result",
  "definitions": {
    "skill.save.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": [
            "string",
            "null"
          ]
        },
        "name": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "sourcePath": {
          "type": "string"
        },
        "originPath": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "version": {
          "type": "string",
          "default": "0.1.0"
        },
        "contentHash": {
          "type": "string",
          "default": ""
        },
        "updateAvailable": {
          "type": "boolean",
          "default": false
        },
        "pendingContentHash": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "scope": {
          "type": "string",
          "enum": [
            "workspace",
            "workspace-legacy",
            "user",
            "user-legacy",
            "codex",
            "registered",
            "plugin"
          ],
          "default": "registered"
        },
        "readOnly": {
          "type": "boolean",
          "default": false
        },
        "trusted": {
          "type": "boolean"
        },
        "enabled": {
          "type": "boolean"
        },
        "shadowedBy": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "shadows": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "diagnostic": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/skill.save.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "name",
        "description",
        "sourcePath",
        "trusted",
        "enabled",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `skill.trust`

Params:

```json
{
  "$ref": "#/definitions/skill.trust.params",
  "definitions": {
    "skill.trust.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "trusted": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "trusted"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/skill.trust.result",
  "definitions": {
    "skill.trust.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `support.crashReport.record`

Params:

```json
{
  "$ref": "#/definitions/support.crashReport.record.params",
  "definitions": {
    "support.crashReport.record.params": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "maxLength": 200
        },
        "message": {
          "type": "string",
          "maxLength": 4000
        },
        "stack": {
          "type": "string",
          "maxLength": 12000
        },
        "componentStack": {
          "type": "string",
          "maxLength": 12000
        },
        "route": {
          "type": "string",
          "maxLength": 1000
        },
        "fatal": {
          "type": "boolean",
          "default": false
        },
        "metadata": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/definitions/support.crashReport.record.params/properties/metadata"
              }
            },
            {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/definitions/support.crashReport.record.params/properties/metadata"
              }
            }
          ]
        }
      },
      "required": [
        "message"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/support.crashReport.record.result",
  "definitions": {
    "support.crashReport.record.result": {
      "type": "object",
      "properties": {
        "recorded": {
          "type": "boolean"
        },
        "id": {
          "type": [
            "string",
            "null"
          ]
        },
        "reason": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "recorded",
        "id",
        "reason"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `support.issueReport.create`

Params:

```json
{
  "$ref": "#/definitions/support.issueReport.create.params",
  "definitions": {
    "support.issueReport.create.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "path": {
              "type": "string"
            },
            "includeIssueBody": {
              "type": "boolean",
              "default": true
            },
            "issueTitle": {
              "type": "string",
              "maxLength": 200
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/support.issueReport.create.result",
  "definitions": {
    "support.issueReport.create.result": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "issueBodyPath": {
          "type": [
            "string",
            "null"
          ]
        },
        "configHash": {
          "type": "string"
        },
        "logCount": {
          "type": "integer",
          "minimum": 0
        },
        "usageEventCount": {
          "type": "integer",
          "minimum": 0
        },
        "crashReportCount": {
          "type": "integer",
          "minimum": 0
        },
        "telemetryEnabled": {
          "type": "boolean"
        },
        "schemaVersion": {
          "type": "number",
          "const": 1
        }
      },
      "required": [
        "path",
        "issueBodyPath",
        "configHash",
        "logCount",
        "usageEventCount",
        "crashReportCount",
        "telemetryEnabled",
        "schemaVersion"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `system.openPath`

Params:

```json
{
  "$ref": "#/definitions/system.openPath.params",
  "definitions": {
    "system.openPath.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "path": {
          "type": "string"
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/system.openPath.result",
  "definitions": {
    "system.openPath.result": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "command": {
              "type": "string"
            },
            "args": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "cwd": {
              "type": "string"
            },
            "exitCode": {
              "type": "integer"
            },
            "stdout": {
              "type": "string"
            },
            "stderr": {
              "type": "string"
            }
          },
          "required": [
            "command",
            "args",
            "cwd",
            "exitCode",
            "stdout",
            "stderr"
          ],
          "additionalProperties": true
        },
        {
          "type": "object",
          "properties": {
            "ok": {
              "type": "boolean"
            }
          },
          "required": [
            "ok"
          ],
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `task.create`

Params:

```json
{
  "$ref": "#/definitions/task.create.params",
  "definitions": {
    "task.create.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "workspaceKind": {
          "type": "string",
          "enum": [
            "project",
            "general"
          ]
        },
        "conversationKind": {
          "type": "string",
          "enum": [
            "chat",
            "code"
          ],
          "default": "chat"
        },
        "title": {
          "type": "string"
        },
        "permissionMode": {
          "type": "string",
          "enum": [
            "ask",
            "auto-edit",
            "plan",
            "full-access"
          ]
        },
        "modelProviderId": {
          "type": "string"
        },
        "model": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/task.create.result",
  "definitions": {
    "task.create.result": {
      "type": "object",
      "properties": {
        "task": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "workspaceId": {
              "type": "string"
            },
            "title": {
              "type": "string"
            },
            "status": {
              "type": "string",
              "enum": [
                "queued",
                "running",
                "waiting-for-approval",
                "cancelled",
                "failed",
                "completed"
              ]
            },
            "activeSessionId": {
              "type": [
                "string",
                "null"
              ]
            },
            "conversationKind": {
              "type": "string",
              "enum": [
                "chat",
                "code"
              ]
            },
            "uiMode": {
              "anyOf": [
                {
                  "type": "string",
                  "enum": [
                    "chat",
                    "code",
                    "cowork"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "uiModePinned": {
              "type": "boolean"
            },
            "uiModeSource": {
              "anyOf": [
                {
                  "type": "string",
                  "enum": [
                    "classifier",
                    "agent",
                    "user"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "pinned": {
              "type": "boolean",
              "default": false
            },
            "archived": {
              "type": "boolean",
              "default": false
            },
            "deletedAt": {
              "anyOf": [
                {
                  "type": "string",
                  "format": "date-time"
                },
                {
                  "type": "null"
                }
              ],
              "default": null
            },
            "unreadAt": {
              "anyOf": [
                {
                  "$ref": "#/definitions/task.create.result/properties/task/properties/deletedAt/anyOf/0"
                },
                {
                  "type": "null"
                }
              ],
              "default": null
            },
            "lastReadAt": {
              "anyOf": [
                {
                  "$ref": "#/definitions/task.create.result/properties/task/properties/deletedAt/anyOf/0"
                },
                {
                  "type": "null"
                }
              ],
              "default": null
            },
            "worktreePath": {
              "type": [
                "string",
                "null"
              ],
              "default": null
            },
            "worktreeBranch": {
              "type": [
                "string",
                "null"
              ],
              "default": null
            },
            "worktreeBaseRef": {
              "type": [
                "string",
                "null"
              ],
              "default": null
            },
            "worktreeBaseSha": {
              "type": [
                "string",
                "null"
              ],
              "default": null
            },
            "pullRequestUrl": {
              "type": [
                "string",
                "null"
              ],
              "default": null
            },
            "pullRequestNumber": {
              "anyOf": [
                {
                  "type": "integer",
                  "exclusiveMinimum": 0
                },
                {
                  "type": "null"
                }
              ],
              "default": null
            },
            "createdAt": {
              "$ref": "#/definitions/task.create.result/properties/task/properties/deletedAt/anyOf/0"
            },
            "updatedAt": {
              "$ref": "#/definitions/task.create.result/properties/task/properties/deletedAt/anyOf/0"
            }
          },
          "required": [
            "id",
            "workspaceId",
            "title",
            "status",
            "activeSessionId",
            "conversationKind",
            "createdAt",
            "updatedAt"
          ],
          "additionalProperties": false
        },
        "session": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "taskId": {
              "type": "string"
            },
            "parentSessionId": {
              "type": [
                "string",
                "null"
              ]
            },
            "status": {
              "type": "string",
              "enum": [
                "active",
                "compacted",
                "forked",
                "rewound",
                "archived"
              ]
            },
            "modelProviderId": {
              "type": [
                "string",
                "null"
              ]
            },
            "model": {
              "type": [
                "string",
                "null"
              ]
            },
            "permissionMode": {
              "type": "string",
              "enum": [
                "ask",
                "auto-edit",
                "plan",
                "full-access"
              ]
            },
            "createdAt": {
              "$ref": "#/definitions/task.create.result/properties/task/properties/deletedAt/anyOf/0"
            },
            "updatedAt": {
              "$ref": "#/definitions/task.create.result/properties/task/properties/deletedAt/anyOf/0"
            }
          },
          "required": [
            "id",
            "taskId",
            "parentSessionId",
            "status",
            "modelProviderId",
            "model",
            "permissionMode",
            "createdAt",
            "updatedAt"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "task",
        "session"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `task.delete`

Params:

```json
{
  "$ref": "#/definitions/task.delete.params",
  "definitions": {
    "task.delete.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "deleted": {
          "type": "boolean"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/task.delete.result",
  "definitions": {
    "task.delete.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "running",
            "waiting-for-approval",
            "cancelled",
            "failed",
            "completed"
          ]
        },
        "activeSessionId": {
          "type": [
            "string",
            "null"
          ]
        },
        "conversationKind": {
          "type": "string",
          "enum": [
            "chat",
            "code"
          ]
        },
        "uiMode": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "chat",
                "code",
                "cowork"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "uiModePinned": {
          "type": "boolean"
        },
        "uiModeSource": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "classifier",
                "agent",
                "user"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "pinned": {
          "type": "boolean",
          "default": false
        },
        "archived": {
          "type": "boolean",
          "default": false
        },
        "deletedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "unreadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.delete.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "lastReadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.delete.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "worktreePath": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBranch": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseRef": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseSha": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestUrl": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestNumber": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "createdAt": {
          "$ref": "#/definitions/task.delete.result/properties/deletedAt/anyOf/0"
        },
        "updatedAt": {
          "$ref": "#/definitions/task.delete.result/properties/deletedAt/anyOf/0"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "title",
        "status",
        "activeSessionId",
        "conversationKind",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `task.list`

Params:

```json
{
  "$ref": "#/definitions/task.list.params",
  "definitions": {
    "task.list.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "includeArchived": {
          "type": "boolean"
        },
        "includeDeleted": {
          "type": "boolean"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/task.list.result",
  "definitions": {
    "task.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "queued",
              "running",
              "waiting-for-approval",
              "cancelled",
              "failed",
              "completed"
            ]
          },
          "activeSessionId": {
            "type": [
              "string",
              "null"
            ]
          },
          "conversationKind": {
            "type": "string",
            "enum": [
              "chat",
              "code"
            ]
          },
          "uiMode": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "chat",
                  "code",
                  "cowork"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "uiModePinned": {
            "type": "boolean"
          },
          "uiModeSource": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "classifier",
                  "agent",
                  "user"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "pinned": {
            "type": "boolean",
            "default": false
          },
          "archived": {
            "type": "boolean",
            "default": false
          },
          "deletedAt": {
            "anyOf": [
              {
                "type": "string",
                "format": "date-time"
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "unreadAt": {
            "anyOf": [
              {
                "$ref": "#/definitions/task.list.result/items/properties/deletedAt/anyOf/0"
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "lastReadAt": {
            "anyOf": [
              {
                "$ref": "#/definitions/task.list.result/items/properties/deletedAt/anyOf/0"
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "worktreePath": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "worktreeBranch": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "worktreeBaseRef": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "worktreeBaseSha": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "pullRequestUrl": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "pullRequestNumber": {
            "anyOf": [
              {
                "type": "integer",
                "exclusiveMinimum": 0
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "createdAt": {
            "$ref": "#/definitions/task.list.result/items/properties/deletedAt/anyOf/0"
          },
          "updatedAt": {
            "$ref": "#/definitions/task.list.result/items/properties/deletedAt/anyOf/0"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "title",
          "status",
          "activeSessionId",
          "conversationKind",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `task.listGeneral`

Params:

```json
{
  "$ref": "#/definitions/task.listGeneral.params",
  "definitions": {
    "task.listGeneral.params": {
      "type": "object",
      "properties": {
        "includeArchived": {
          "type": "boolean"
        },
        "includeDeleted": {
          "type": "boolean"
        },
        "limit": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 500
        },
        "offset": {
          "type": "integer",
          "minimum": 0
        }
      },
      "additionalProperties": false,
      "default": {}
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/task.listGeneral.result",
  "definitions": {
    "task.listGeneral.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "queued",
              "running",
              "waiting-for-approval",
              "cancelled",
              "failed",
              "completed"
            ]
          },
          "activeSessionId": {
            "type": [
              "string",
              "null"
            ]
          },
          "conversationKind": {
            "type": "string",
            "enum": [
              "chat",
              "code"
            ]
          },
          "uiMode": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "chat",
                  "code",
                  "cowork"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "uiModePinned": {
            "type": "boolean"
          },
          "uiModeSource": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "classifier",
                  "agent",
                  "user"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "pinned": {
            "type": "boolean",
            "default": false
          },
          "archived": {
            "type": "boolean",
            "default": false
          },
          "deletedAt": {
            "anyOf": [
              {
                "type": "string",
                "format": "date-time"
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "unreadAt": {
            "anyOf": [
              {
                "$ref": "#/definitions/task.listGeneral.result/items/properties/deletedAt/anyOf/0"
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "lastReadAt": {
            "anyOf": [
              {
                "$ref": "#/definitions/task.listGeneral.result/items/properties/deletedAt/anyOf/0"
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "worktreePath": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "worktreeBranch": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "worktreeBaseRef": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "worktreeBaseSha": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "pullRequestUrl": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "pullRequestNumber": {
            "anyOf": [
              {
                "type": "integer",
                "exclusiveMinimum": 0
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "createdAt": {
            "$ref": "#/definitions/task.listGeneral.result/items/properties/deletedAt/anyOf/0"
          },
          "updatedAt": {
            "$ref": "#/definitions/task.listGeneral.result/items/properties/deletedAt/anyOf/0"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "title",
          "status",
          "activeSessionId",
          "conversationKind",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `task.markRead`

Params:

```json
{
  "$ref": "#/definitions/task.markRead.params",
  "definitions": {
    "task.markRead.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "unread": {
          "type": "boolean"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/task.markRead.result",
  "definitions": {
    "task.markRead.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "running",
            "waiting-for-approval",
            "cancelled",
            "failed",
            "completed"
          ]
        },
        "activeSessionId": {
          "type": [
            "string",
            "null"
          ]
        },
        "conversationKind": {
          "type": "string",
          "enum": [
            "chat",
            "code"
          ]
        },
        "uiMode": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "chat",
                "code",
                "cowork"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "uiModePinned": {
          "type": "boolean"
        },
        "uiModeSource": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "classifier",
                "agent",
                "user"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "pinned": {
          "type": "boolean",
          "default": false
        },
        "archived": {
          "type": "boolean",
          "default": false
        },
        "deletedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "unreadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.markRead.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "lastReadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.markRead.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "worktreePath": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBranch": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseRef": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseSha": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestUrl": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestNumber": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "createdAt": {
          "$ref": "#/definitions/task.markRead.result/properties/deletedAt/anyOf/0"
        },
        "updatedAt": {
          "$ref": "#/definitions/task.markRead.result/properties/deletedAt/anyOf/0"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "title",
        "status",
        "activeSessionId",
        "conversationKind",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `task.restore`

Params:

```json
{
  "$ref": "#/definitions/task.restore.params",
  "definitions": {
    "task.restore.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/task.restore.result",
  "definitions": {
    "task.restore.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "running",
            "waiting-for-approval",
            "cancelled",
            "failed",
            "completed"
          ]
        },
        "activeSessionId": {
          "type": [
            "string",
            "null"
          ]
        },
        "conversationKind": {
          "type": "string",
          "enum": [
            "chat",
            "code"
          ]
        },
        "uiMode": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "chat",
                "code",
                "cowork"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "uiModePinned": {
          "type": "boolean"
        },
        "uiModeSource": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "classifier",
                "agent",
                "user"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "pinned": {
          "type": "boolean",
          "default": false
        },
        "archived": {
          "type": "boolean",
          "default": false
        },
        "deletedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "unreadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.restore.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "lastReadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.restore.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "worktreePath": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBranch": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseRef": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseSha": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestUrl": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestNumber": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "createdAt": {
          "$ref": "#/definitions/task.restore.result/properties/deletedAt/anyOf/0"
        },
        "updatedAt": {
          "$ref": "#/definitions/task.restore.result/properties/deletedAt/anyOf/0"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "title",
        "status",
        "activeSessionId",
        "conversationKind",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `task.search`

Params:

```json
{
  "$ref": "#/definitions/task.search.params",
  "definitions": {
    "task.search.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "query": {
          "type": "string"
        },
        "includeArchived": {
          "type": "boolean"
        },
        "includeDeleted": {
          "type": "boolean"
        },
        "limit": {
          "type": "integer",
          "exclusiveMinimum": 0
        }
      },
      "required": [
        "workspaceId",
        "query"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/task.search.result",
  "definitions": {
    "task.search.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "status": {
            "type": "string",
            "enum": [
              "queued",
              "running",
              "waiting-for-approval",
              "cancelled",
              "failed",
              "completed"
            ]
          },
          "activeSessionId": {
            "type": [
              "string",
              "null"
            ]
          },
          "conversationKind": {
            "type": "string",
            "enum": [
              "chat",
              "code"
            ]
          },
          "uiMode": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "chat",
                  "code",
                  "cowork"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "uiModePinned": {
            "type": "boolean"
          },
          "uiModeSource": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "classifier",
                  "agent",
                  "user"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "pinned": {
            "type": "boolean",
            "default": false
          },
          "archived": {
            "type": "boolean",
            "default": false
          },
          "deletedAt": {
            "anyOf": [
              {
                "type": "string",
                "format": "date-time"
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "unreadAt": {
            "anyOf": [
              {
                "$ref": "#/definitions/task.search.result/items/properties/deletedAt/anyOf/0"
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "lastReadAt": {
            "anyOf": [
              {
                "$ref": "#/definitions/task.search.result/items/properties/deletedAt/anyOf/0"
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "worktreePath": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "worktreeBranch": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "worktreeBaseRef": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "worktreeBaseSha": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "pullRequestUrl": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "pullRequestNumber": {
            "anyOf": [
              {
                "type": "integer",
                "exclusiveMinimum": 0
              },
              {
                "type": "null"
              }
            ],
            "default": null
          },
          "createdAt": {
            "$ref": "#/definitions/task.search.result/items/properties/deletedAt/anyOf/0"
          },
          "updatedAt": {
            "$ref": "#/definitions/task.search.result/items/properties/deletedAt/anyOf/0"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "title",
          "status",
          "activeSessionId",
          "conversationKind",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `task.setArchived`

Params:

```json
{
  "$ref": "#/definitions/task.setArchived.params",
  "definitions": {
    "task.setArchived.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "archived": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "archived"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/task.setArchived.result",
  "definitions": {
    "task.setArchived.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "running",
            "waiting-for-approval",
            "cancelled",
            "failed",
            "completed"
          ]
        },
        "activeSessionId": {
          "type": [
            "string",
            "null"
          ]
        },
        "conversationKind": {
          "type": "string",
          "enum": [
            "chat",
            "code"
          ]
        },
        "uiMode": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "chat",
                "code",
                "cowork"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "uiModePinned": {
          "type": "boolean"
        },
        "uiModeSource": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "classifier",
                "agent",
                "user"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "pinned": {
          "type": "boolean",
          "default": false
        },
        "archived": {
          "type": "boolean",
          "default": false
        },
        "deletedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "unreadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.setArchived.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "lastReadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.setArchived.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "worktreePath": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBranch": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseRef": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseSha": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestUrl": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestNumber": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "createdAt": {
          "$ref": "#/definitions/task.setArchived.result/properties/deletedAt/anyOf/0"
        },
        "updatedAt": {
          "$ref": "#/definitions/task.setArchived.result/properties/deletedAt/anyOf/0"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "title",
        "status",
        "activeSessionId",
        "conversationKind",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `task.setConversationKind`

Params:

```json
{
  "$ref": "#/definitions/task.setConversationKind.params",
  "definitions": {
    "task.setConversationKind.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "conversationKind": {
          "type": "string",
          "enum": [
            "chat",
            "code"
          ]
        }
      },
      "required": [
        "id",
        "conversationKind"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/task.setConversationKind.result",
  "definitions": {
    "task.setConversationKind.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "running",
            "waiting-for-approval",
            "cancelled",
            "failed",
            "completed"
          ]
        },
        "activeSessionId": {
          "type": [
            "string",
            "null"
          ]
        },
        "conversationKind": {
          "type": "string",
          "enum": [
            "chat",
            "code"
          ]
        },
        "uiMode": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "chat",
                "code",
                "cowork"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "uiModePinned": {
          "type": "boolean"
        },
        "uiModeSource": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "classifier",
                "agent",
                "user"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "pinned": {
          "type": "boolean",
          "default": false
        },
        "archived": {
          "type": "boolean",
          "default": false
        },
        "deletedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "unreadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.setConversationKind.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "lastReadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.setConversationKind.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "worktreePath": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBranch": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseRef": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseSha": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestUrl": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestNumber": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "createdAt": {
          "$ref": "#/definitions/task.setConversationKind.result/properties/deletedAt/anyOf/0"
        },
        "updatedAt": {
          "$ref": "#/definitions/task.setConversationKind.result/properties/deletedAt/anyOf/0"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "title",
        "status",
        "activeSessionId",
        "conversationKind",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `task.setPinned`

Params:

```json
{
  "$ref": "#/definitions/task.setPinned.params",
  "definitions": {
    "task.setPinned.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "pinned": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "pinned"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/task.setPinned.result",
  "definitions": {
    "task.setPinned.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "running",
            "waiting-for-approval",
            "cancelled",
            "failed",
            "completed"
          ]
        },
        "activeSessionId": {
          "type": [
            "string",
            "null"
          ]
        },
        "conversationKind": {
          "type": "string",
          "enum": [
            "chat",
            "code"
          ]
        },
        "uiMode": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "chat",
                "code",
                "cowork"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "uiModePinned": {
          "type": "boolean"
        },
        "uiModeSource": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "classifier",
                "agent",
                "user"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "pinned": {
          "type": "boolean",
          "default": false
        },
        "archived": {
          "type": "boolean",
          "default": false
        },
        "deletedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "unreadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.setPinned.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "lastReadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.setPinned.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "worktreePath": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBranch": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseRef": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseSha": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestUrl": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestNumber": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "createdAt": {
          "$ref": "#/definitions/task.setPinned.result/properties/deletedAt/anyOf/0"
        },
        "updatedAt": {
          "$ref": "#/definitions/task.setPinned.result/properties/deletedAt/anyOf/0"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "title",
        "status",
        "activeSessionId",
        "conversationKind",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `task.update`

Params:

```json
{
  "$ref": "#/definitions/task.update.params",
  "definitions": {
    "task.update.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "title": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "title"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/task.update.result",
  "definitions": {
    "task.update.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "running",
            "waiting-for-approval",
            "cancelled",
            "failed",
            "completed"
          ]
        },
        "activeSessionId": {
          "type": [
            "string",
            "null"
          ]
        },
        "conversationKind": {
          "type": "string",
          "enum": [
            "chat",
            "code"
          ]
        },
        "uiMode": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "chat",
                "code",
                "cowork"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "uiModePinned": {
          "type": "boolean"
        },
        "uiModeSource": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "classifier",
                "agent",
                "user"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "pinned": {
          "type": "boolean",
          "default": false
        },
        "archived": {
          "type": "boolean",
          "default": false
        },
        "deletedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "unreadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.update.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "lastReadAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/task.update.result/properties/deletedAt/anyOf/0"
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "worktreePath": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBranch": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseRef": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "worktreeBaseSha": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestUrl": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "pullRequestNumber": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "type": "null"
            }
          ],
          "default": null
        },
        "createdAt": {
          "$ref": "#/definitions/task.update.result/properties/deletedAt/anyOf/0"
        },
        "updatedAt": {
          "$ref": "#/definitions/task.update.result/properties/deletedAt/anyOf/0"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "title",
        "status",
        "activeSessionId",
        "conversationKind",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `terminal.close`

Params:

```json
{
  "$ref": "#/definitions/terminal.close.params",
  "definitions": {
    "terminal.close.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/terminal.close.result",
  "definitions": {
    "terminal.close.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `terminal.create`

Params:

```json
{
  "$ref": "#/definitions/terminal.create.params",
  "definitions": {
    "terminal.create.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/terminal.create.result",
  "definitions": {
    "terminal.create.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "workspaceId": {
          "type": "string"
        },
        "cwd": {
          "type": "string"
        },
        "shell": {
          "type": "string"
        },
        "cols": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "rows": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "status": {
          "type": "string",
          "enum": [
            "starting",
            "running",
            "exited",
            "failed",
            "killed",
            "lost"
          ]
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "updatedAt": {
          "$ref": "#/definitions/terminal.create.result/properties/createdAt"
        }
      },
      "required": [
        "id",
        "workspaceId",
        "cwd",
        "shell",
        "cols",
        "rows",
        "status",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `terminal.events`

Params:

```json
{
  "$ref": "#/definitions/terminal.events.params",
  "definitions": {
    "terminal.events.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "limit": {
          "type": "number"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/terminal.events.result",
  "definitions": {
    "terminal.events.result": {
      "type": "array",
      "items": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "number"
          },
          {
            "type": "boolean"
          },
          {
            "type": "null"
          },
          {
            "type": "array",
            "items": {
              "$ref": "#/definitions/terminal.events.result/items"
            }
          },
          {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/definitions/terminal.events.result/items"
            }
          }
        ]
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `terminal.list`

Params:

```json
{
  "$ref": "#/definitions/terminal.list.params",
  "definitions": {
    "terminal.list.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/terminal.list.result",
  "definitions": {
    "terminal.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "workspaceId": {
            "type": "string"
          },
          "cwd": {
            "type": "string"
          },
          "shell": {
            "type": "string"
          },
          "cols": {
            "type": "integer",
            "exclusiveMinimum": 0
          },
          "rows": {
            "type": "integer",
            "exclusiveMinimum": 0
          },
          "status": {
            "type": "string",
            "enum": [
              "starting",
              "running",
              "exited",
              "failed",
              "killed",
              "lost"
            ]
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "updatedAt": {
            "$ref": "#/definitions/terminal.list.result/items/properties/createdAt"
          }
        },
        "required": [
          "id",
          "workspaceId",
          "cwd",
          "shell",
          "cols",
          "rows",
          "status",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `terminal.resize`

Params:

```json
{
  "$ref": "#/definitions/terminal.resize.params",
  "definitions": {
    "terminal.resize.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "cols": {
          "type": "number"
        },
        "rows": {
          "type": "number"
        }
      },
      "required": [
        "id",
        "cols",
        "rows"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/terminal.resize.result",
  "definitions": {
    "terminal.resize.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `terminal.write`

Params:

```json
{
  "$ref": "#/definitions/terminal.write.params",
  "definitions": {
    "terminal.write.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "data": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "data"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/terminal.write.result",
  "definitions": {
    "terminal.write.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        }
      },
      "required": [
        "ok"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `timeline.list`

Params:

```json
{
  "$ref": "#/definitions/timeline.list.params",
  "definitions": {
    "timeline.list.params": {
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "taskId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/timeline.list.result",
  "definitions": {
    "timeline.list.result": {
      "type": "array",
      "items": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "checkpoint"
              },
              "id": {
                "type": "string"
              },
              "taskId": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "sessionId": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "entryId": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "commitSha": {
                "type": "string"
              },
              "message": {
                "type": "string"
              },
              "reason": {
                "type": "string",
                "enum": [
                  "manual",
                  "auto-rewind",
                  "auto-restore",
                  "auto-merge"
                ]
              },
              "createdAt": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "kind",
              "id",
              "taskId",
              "sessionId",
              "entryId",
              "commitSha",
              "message",
              "reason",
              "createdAt"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "conversation"
              },
              "id": {
                "type": "string"
              },
              "sessionId": {
                "type": "string"
              },
              "entryId": {
                "type": "string"
              },
              "role": {
                "type": "string",
                "enum": [
                  "user",
                  "assistant"
                ]
              },
              "summary": {
                "type": "string"
              },
              "createdAt": {
                "$ref": "#/definitions/timeline.list.result/items/anyOf/0/properties/createdAt"
              }
            },
            "required": [
              "kind",
              "id",
              "sessionId",
              "entryId",
              "role",
              "summary",
              "createdAt"
            ],
            "additionalProperties": false
          }
        ]
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `timeline.restore`

Params:

```json
{
  "$ref": "#/definitions/timeline.restore.params",
  "definitions": {
    "timeline.restore.params": {
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string"
        },
        "mode": {
          "type": "string",
          "enum": [
            "files",
            "conversation",
            "both"
          ]
        },
        "checkpointId": {
          "type": "string"
        },
        "entryId": {
          "type": "string"
        }
      },
      "required": [
        "taskId",
        "mode"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/timeline.restore.result",
  "definitions": {
    "timeline.restore.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "autoCheckpointId": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "ok",
        "autoCheckpointId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `updater.install`

Params:

```json
{
  "$ref": "#/definitions/updater.install.params",
  "definitions": {
    "updater.install.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/updater.install.result",
  "definitions": {
    "updater.install.result": {
      "type": "object",
      "properties": {
        "installed": {
          "type": "boolean"
        },
        "status": {
          "type": "string",
          "enum": [
            "installed",
            "current",
            "not-configured",
            "error"
          ]
        },
        "version": {
          "type": "string"
        },
        "restartRequired": {
          "type": "boolean"
        },
        "error": {
          "type": "string"
        }
      },
      "required": [
        "installed",
        "status"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `updater.status`

Params:

```json
{
  "$ref": "#/definitions/updater.status.params",
  "definitions": {
    "updater.status.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/updater.status.result",
  "definitions": {
    "updater.status.result": {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "development",
            "not-configured",
            "current",
            "available",
            "error"
          ]
        },
        "feed": {
          "type": "string"
        },
        "configured": {
          "type": "boolean"
        },
        "endpoint": {
          "type": "string"
        },
        "signingKeyPresent": {
          "type": "boolean"
        },
        "currentVersion": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "date": {
          "type": [
            "string",
            "null"
          ]
        },
        "body": {
          "type": [
            "string",
            "null"
          ]
        },
        "rolloutEligible": {
          "type": "boolean"
        },
        "error": {
          "type": "string"
        }
      },
      "required": [
        "status",
        "feed",
        "configured"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `usage.events`

Params:

```json
{
  "$ref": "#/definitions/usage.events.params",
  "definitions": {
    "usage.events.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "exclusiveMinimum": 0
            }
          },
          "additionalProperties": false
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/usage.events.result",
  "definitions": {
    "usage.events.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "type": {
            "type": "string"
          },
          "providerId": {
            "type": [
              "string",
              "null"
            ]
          },
          "taskId": {
            "type": [
              "string",
              "null"
            ]
          },
          "sessionId": {
            "type": [
              "string",
              "null"
            ]
          },
          "name": {
            "type": "string"
          },
          "status": {
            "type": [
              "string",
              "null"
            ]
          },
          "value": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "number"
              },
              {
                "type": "boolean"
              },
              {
                "type": "null"
              },
              {
                "type": "array",
                "items": {
                  "$ref": "#/definitions/usage.events.result/items/properties/value"
                }
              },
              {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/definitions/usage.events.result/items/properties/value"
                }
              }
            ]
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          }
        },
        "required": [
          "id",
          "type",
          "providerId",
          "taskId",
          "sessionId",
          "name",
          "status",
          "value",
          "createdAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `usage.list`

Params:

```json
{
  "$ref": "#/definitions/usage.list.params",
  "definitions": {
    "usage.list.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/usage.list.result",
  "definitions": {
    "usage.list.result": {
      "type": "array",
      "items": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "number"
          },
          {
            "type": "boolean"
          },
          {
            "type": "null"
          },
          {
            "type": "array",
            "items": {
              "$ref": "#/definitions/usage.list.result/items"
            }
          },
          {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/definitions/usage.list.result/items"
            }
          }
        ]
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `usage.summary`

Params:

```json
{
  "$ref": "#/definitions/usage.summary.params",
  "definitions": {
    "usage.summary.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/usage.summary.result",
  "definitions": {
    "usage.summary.result": {
      "type": "object",
      "properties": {
        "days": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "date": {
                "type": "string"
              },
              "tokens": {
                "type": "number"
              },
              "turns": {
                "type": "number"
              }
            },
            "required": [
              "date",
              "tokens",
              "turns"
            ],
            "additionalProperties": false
          }
        },
        "models": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "model": {
                "type": "string"
              },
              "inputTokens": {
                "type": "number"
              },
              "outputTokens": {
                "type": "number"
              },
              "requests": {
                "type": "number"
              }
            },
            "required": [
              "model",
              "inputTokens",
              "outputTokens",
              "requests"
            ],
            "additionalProperties": false
          }
        },
        "tools": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "calls": {
                "type": "number"
              },
              "denied": {
                "type": "number"
              }
            },
            "required": [
              "name",
              "calls"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "days",
        "models",
        "tools"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `workspace.ensureGeneral`

Params:

```json
{
  "$ref": "#/definitions/workspace.ensureGeneral.params",
  "definitions": {
    "workspace.ensureGeneral.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/workspace.ensureGeneral.result",
  "definitions": {
    "workspace.ensureGeneral.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "path": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "workspaceKind": {
          "type": "string",
          "enum": [
            "project",
            "general"
          ],
          "default": "project"
        },
        "ownerUserId": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "trustState": {
          "type": "string",
          "enum": [
            "untrusted",
            "trusted",
            "blocked"
          ]
        },
        "lastOpenedAt": {
          "type": "string",
          "format": "date-time"
        },
        "indexedAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/workspace.ensureGeneral.result/properties/lastOpenedAt"
            },
            {
              "type": "null"
            }
          ]
        },
        "createdAt": {
          "$ref": "#/definitions/workspace.ensureGeneral.result/properties/lastOpenedAt"
        },
        "updatedAt": {
          "$ref": "#/definitions/workspace.ensureGeneral.result/properties/lastOpenedAt"
        },
        "pinned": {
          "type": "boolean",
          "default": false
        }
      },
      "required": [
        "id",
        "path",
        "name",
        "trustState",
        "lastOpenedAt",
        "indexedAt",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `workspace.get`

Params:

```json
{
  "$ref": "#/definitions/workspace.get.params",
  "definitions": {
    "workspace.get.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/workspace.get.result",
  "definitions": {
    "workspace.get.result": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "path": {
              "type": "string"
            },
            "name": {
              "type": "string"
            },
            "workspaceKind": {
              "type": "string",
              "enum": [
                "project",
                "general"
              ],
              "default": "project"
            },
            "ownerUserId": {
              "type": [
                "string",
                "null"
              ],
              "default": null
            },
            "trustState": {
              "type": "string",
              "enum": [
                "untrusted",
                "trusted",
                "blocked"
              ]
            },
            "lastOpenedAt": {
              "type": "string",
              "format": "date-time"
            },
            "indexedAt": {
              "anyOf": [
                {
                  "$ref": "#/definitions/workspace.get.result/anyOf/0/properties/lastOpenedAt"
                },
                {
                  "type": "null"
                }
              ]
            },
            "createdAt": {
              "$ref": "#/definitions/workspace.get.result/anyOf/0/properties/lastOpenedAt"
            },
            "updatedAt": {
              "$ref": "#/definitions/workspace.get.result/anyOf/0/properties/lastOpenedAt"
            },
            "pinned": {
              "type": "boolean",
              "default": false
            }
          },
          "required": [
            "id",
            "path",
            "name",
            "trustState",
            "lastOpenedAt",
            "indexedAt",
            "createdAt",
            "updatedAt"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `workspace.index.rebuild`

Params:

```json
{
  "$ref": "#/definitions/workspace.index.rebuild.params",
  "definitions": {
    "workspace.index.rebuild.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "force": {
          "type": "boolean"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/workspace.index.rebuild.result",
  "definitions": {
    "workspace.index.rebuild.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": [
            "string",
            "null"
          ]
        },
        "workspaceId": {
          "type": "string"
        },
        "rootPath": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "missing",
            "ready",
            "indexing",
            "failed"
          ]
        },
        "watcherStatus": {
          "type": "string",
          "enum": [
            "unavailable",
            "watching",
            "pending",
            "error"
          ],
          "default": "unavailable"
        },
        "watcherPending": {
          "type": "integer",
          "minimum": 0,
          "default": 0
        },
        "watcherError": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "fileCount": {
          "type": "integer",
          "minimum": 0
        },
        "indexedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ]
        },
        "error": {
          "type": [
            "string",
            "null"
          ]
        },
        "metadata": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/definitions/workspace.index.rebuild.result/properties/metadata"
              }
            },
            {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/definitions/workspace.index.rebuild.result/properties/metadata"
              }
            }
          ],
          "default": {}
        },
        "wiki": {
          "type": "object",
          "properties": {
            "workspaceId": {
              "type": "string"
            },
            "generatedAt": {
              "$ref": "#/definitions/workspace.index.rebuild.result/properties/indexedAt/anyOf/0"
            },
            "updatedAt": {
              "$ref": "#/definitions/workspace.index.rebuild.result/properties/indexedAt/anyOf/0"
            },
            "overview": {
              "type": "string"
            },
            "languages": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "files": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "name",
                  "files"
                ],
                "additionalProperties": false
              },
              "default": []
            },
            "topDirectories": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string"
                  },
                  "files": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "path",
                  "files"
                ],
                "additionalProperties": false
              },
              "default": []
            },
            "entrypoints": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "default": []
            }
          },
          "required": [
            "workspaceId",
            "generatedAt",
            "updatedAt",
            "overview"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "id",
        "workspaceId",
        "rootPath",
        "status",
        "fileCount",
        "indexedAt",
        "error",
        "wiki"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `workspace.index.search`

Params:

```json
{
  "$ref": "#/definitions/workspace.index.search.params",
  "definitions": {
    "workspace.index.search.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "query": {
          "type": "string"
        },
        "limit": {
          "type": "integer",
          "exclusiveMinimum": 0
        }
      },
      "required": [
        "workspaceId",
        "query"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/workspace.index.search.result",
  "definitions": {
    "workspace.index.search.result": {
      "type": "object",
      "properties": {
        "results": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "workspaceId": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "absolutePath": {
                "type": "string"
              },
              "kind": {
                "type": "string"
              },
              "language": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "size": {
                "type": "integer",
                "minimum": 0
              },
              "updatedAt": {
                "type": "string",
                "format": "date-time"
              },
              "snippet": {
                "type": "string"
              },
              "score": {
                "type": "number"
              }
            },
            "required": [
              "id",
              "workspaceId",
              "path",
              "absolutePath",
              "kind",
              "language",
              "size",
              "updatedAt",
              "snippet"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "results"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `workspace.index.status`

Params:

```json
{
  "$ref": "#/definitions/workspace.index.status.params",
  "definitions": {
    "workspace.index.status.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/workspace.index.status.result",
  "definitions": {
    "workspace.index.status.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": [
            "string",
            "null"
          ]
        },
        "workspaceId": {
          "type": "string"
        },
        "rootPath": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "missing",
            "ready",
            "indexing",
            "failed"
          ]
        },
        "watcherStatus": {
          "type": "string",
          "enum": [
            "unavailable",
            "watching",
            "pending",
            "error"
          ],
          "default": "unavailable"
        },
        "watcherPending": {
          "type": "integer",
          "minimum": 0,
          "default": 0
        },
        "watcherError": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "fileCount": {
          "type": "integer",
          "minimum": 0
        },
        "indexedAt": {
          "anyOf": [
            {
              "type": "string",
              "format": "date-time"
            },
            {
              "type": "null"
            }
          ]
        },
        "error": {
          "type": [
            "string",
            "null"
          ]
        },
        "metadata": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "number"
            },
            {
              "type": "boolean"
            },
            {
              "type": "null"
            },
            {
              "type": "array",
              "items": {
                "$ref": "#/definitions/workspace.index.status.result/properties/metadata"
              }
            },
            {
              "type": "object",
              "additionalProperties": {
                "$ref": "#/definitions/workspace.index.status.result/properties/metadata"
              }
            }
          ],
          "default": {}
        }
      },
      "required": [
        "id",
        "workspaceId",
        "rootPath",
        "status",
        "fileCount",
        "indexedAt",
        "error"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `workspace.list`

Params:

```json
{
  "$ref": "#/definitions/workspace.list.params",
  "definitions": {
    "workspace.list.params": {
      "type": "object",
      "properties": {
        "includeGeneral": {
          "type": "boolean"
        }
      },
      "additionalProperties": false,
      "default": {}
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/workspace.list.result",
  "definitions": {
    "workspace.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "path": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "workspaceKind": {
            "type": "string",
            "enum": [
              "project",
              "general"
            ],
            "default": "project"
          },
          "ownerUserId": {
            "type": [
              "string",
              "null"
            ],
            "default": null
          },
          "trustState": {
            "type": "string",
            "enum": [
              "untrusted",
              "trusted",
              "blocked"
            ]
          },
          "lastOpenedAt": {
            "type": "string",
            "format": "date-time"
          },
          "indexedAt": {
            "anyOf": [
              {
                "$ref": "#/definitions/workspace.list.result/items/properties/lastOpenedAt"
              },
              {
                "type": "null"
              }
            ]
          },
          "createdAt": {
            "$ref": "#/definitions/workspace.list.result/items/properties/lastOpenedAt"
          },
          "updatedAt": {
            "$ref": "#/definitions/workspace.list.result/items/properties/lastOpenedAt"
          },
          "pinned": {
            "type": "boolean",
            "default": false
          }
        },
        "required": [
          "id",
          "path",
          "name",
          "trustState",
          "lastOpenedAt",
          "indexedAt",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `workspace.open`

Params:

```json
{
  "$ref": "#/definitions/workspace.open.params",
  "definitions": {
    "workspace.open.params": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "trusted": {
          "type": "boolean"
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/workspace.open.result",
  "definitions": {
    "workspace.open.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "path": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "workspaceKind": {
          "type": "string",
          "enum": [
            "project",
            "general"
          ],
          "default": "project"
        },
        "ownerUserId": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "trustState": {
          "type": "string",
          "enum": [
            "untrusted",
            "trusted",
            "blocked"
          ]
        },
        "lastOpenedAt": {
          "type": "string",
          "format": "date-time"
        },
        "indexedAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/workspace.open.result/properties/lastOpenedAt"
            },
            {
              "type": "null"
            }
          ]
        },
        "createdAt": {
          "$ref": "#/definitions/workspace.open.result/properties/lastOpenedAt"
        },
        "updatedAt": {
          "$ref": "#/definitions/workspace.open.result/properties/lastOpenedAt"
        },
        "pinned": {
          "type": "boolean",
          "default": false
        }
      },
      "required": [
        "id",
        "path",
        "name",
        "trustState",
        "lastOpenedAt",
        "indexedAt",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `workspace.remove`

Params:

```json
{
  "$ref": "#/definitions/workspace.remove.params",
  "definitions": {
    "workspace.remove.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/workspace.remove.result",
  "definitions": {
    "workspace.remove.result": {
      "type": "object",
      "properties": {
        "removed": {
          "type": "boolean"
        }
      },
      "required": [
        "removed"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `workspace.update`

Params:

```json
{
  "$ref": "#/definitions/workspace.update.params",
  "definitions": {
    "workspace.update.params": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "name": {
          "type": "string",
          "minLength": 1
        },
        "pinned": {
          "type": "boolean"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/workspace.update.result",
  "definitions": {
    "workspace.update.result": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "path": {
          "type": "string"
        },
        "name": {
          "type": "string"
        },
        "workspaceKind": {
          "type": "string",
          "enum": [
            "project",
            "general"
          ],
          "default": "project"
        },
        "ownerUserId": {
          "type": [
            "string",
            "null"
          ],
          "default": null
        },
        "trustState": {
          "type": "string",
          "enum": [
            "untrusted",
            "trusted",
            "blocked"
          ]
        },
        "lastOpenedAt": {
          "type": "string",
          "format": "date-time"
        },
        "indexedAt": {
          "anyOf": [
            {
              "$ref": "#/definitions/workspace.update.result/properties/lastOpenedAt"
            },
            {
              "type": "null"
            }
          ]
        },
        "createdAt": {
          "$ref": "#/definitions/workspace.update.result/properties/lastOpenedAt"
        },
        "updatedAt": {
          "$ref": "#/definitions/workspace.update.result/properties/lastOpenedAt"
        },
        "pinned": {
          "type": "boolean",
          "default": false
        }
      },
      "required": [
        "id",
        "path",
        "name",
        "trustState",
        "lastOpenedAt",
        "indexedAt",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `workspace.wiki.get`

Params:

```json
{
  "$ref": "#/definitions/workspace.wiki.get.params",
  "definitions": {
    "workspace.wiki.get.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/workspace.wiki.get.result",
  "definitions": {
    "workspace.wiki.get.result": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "workspaceId": {
              "type": "string"
            },
            "generatedAt": {
              "type": "string",
              "format": "date-time"
            },
            "updatedAt": {
              "$ref": "#/definitions/workspace.wiki.get.result/anyOf/0/properties/generatedAt"
            },
            "overview": {
              "type": "string"
            },
            "languages": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "files": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "name",
                  "files"
                ],
                "additionalProperties": false
              },
              "default": []
            },
            "topDirectories": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string"
                  },
                  "files": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "path",
                  "files"
                ],
                "additionalProperties": false
              },
              "default": []
            },
            "entrypoints": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "default": []
            }
          },
          "required": [
            "workspaceId",
            "generatedAt",
            "updatedAt",
            "overview"
          ],
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `worktree.applyBack`

Params:

```json
{
  "$ref": "#/definitions/worktree.applyBack.params",
  "definitions": {
    "worktree.applyBack.params": {
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "taskId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/worktree.applyBack.result",
  "definitions": {
    "worktree.applyBack.result": {
      "type": "object",
      "properties": {
        "applied": {
          "type": "boolean"
        },
        "files": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "autoCheckpointId": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "applied",
        "files",
        "autoCheckpointId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `worktree.applyBack.preview`

Params:

```json
{
  "$ref": "#/definitions/worktree.applyBack.preview.params",
  "definitions": {
    "worktree.applyBack.preview.params": {
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "taskId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/worktree.applyBack.preview.result",
  "definitions": {
    "worktree.applyBack.preview.result": {
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string"
        },
        "branch": {
          "type": "string"
        },
        "baseSha": {
          "type": "string"
        },
        "mainSha": {
          "type": "string"
        },
        "patch": {
          "type": "string"
        },
        "files": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "applicable": {
          "type": "boolean"
        },
        "conflict": {
          "type": [
            "string",
            "null"
          ]
        }
      },
      "required": [
        "taskId",
        "branch",
        "baseSha",
        "mainSha",
        "patch",
        "files",
        "applicable",
        "conflict"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `worktree.create`

Params:

```json
{
  "$ref": "#/definitions/worktree.create.params",
  "definitions": {
    "worktree.create.params": {
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string"
        },
        "baseRef": {
          "type": "string"
        },
        "path": {
          "type": "string"
        },
        "branch": {
          "type": "string"
        }
      },
      "required": [
        "taskId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/worktree.create.result",
  "definitions": {
    "worktree.create.result": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "head": {
          "type": "string"
        },
        "branch": {
          "type": [
            "string",
            "null"
          ]
        },
        "baseRef": {
          "type": [
            "string",
            "null"
          ]
        },
        "taskId": {
          "type": [
            "string",
            "null"
          ]
        },
        "main": {
          "type": "boolean"
        },
        "locked": {
          "type": "boolean"
        },
        "prunable": {
          "type": "boolean"
        },
        "dirty": {
          "type": "boolean"
        },
        "ahead": {
          "type": "integer",
          "minimum": 0
        },
        "behind": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "path",
        "head",
        "branch",
        "baseRef",
        "taskId",
        "main",
        "locked",
        "prunable",
        "dirty",
        "ahead",
        "behind"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `worktree.list`

Params:

```json
{
  "$ref": "#/definitions/worktree.list.params",
  "definitions": {
    "worktree.list.params": {
      "type": "object",
      "properties": {
        "workspaceId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "workspaceId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/worktree.list.result",
  "definitions": {
    "worktree.list.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string"
          },
          "head": {
            "type": "string"
          },
          "branch": {
            "type": [
              "string",
              "null"
            ]
          },
          "baseRef": {
            "type": [
              "string",
              "null"
            ]
          },
          "taskId": {
            "type": [
              "string",
              "null"
            ]
          },
          "main": {
            "type": "boolean"
          },
          "locked": {
            "type": "boolean"
          },
          "prunable": {
            "type": "boolean"
          },
          "dirty": {
            "type": "boolean"
          },
          "ahead": {
            "type": "integer",
            "minimum": 0
          },
          "behind": {
            "type": "integer",
            "minimum": 0
          }
        },
        "required": [
          "path",
          "head",
          "branch",
          "baseRef",
          "taskId",
          "main",
          "locked",
          "prunable",
          "dirty",
          "ahead",
          "behind"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `worktree.orphans`

Params:

```json
{
  "$ref": "#/definitions/worktree.orphans.params",
  "definitions": {
    "worktree.orphans.params": {
      "anyOf": [
        {
          "not": {}
        },
        {
          "type": "object",
          "properties": {},
          "additionalProperties": true
        }
      ]
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/worktree.orphans.result",
  "definitions": {
    "worktree.orphans.result": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string"
          },
          "workspaceId": {
            "type": "string"
          },
          "taskId": {
            "type": [
              "string",
              "null"
            ]
          },
          "reason": {
            "type": "string",
            "enum": [
              "unassociated",
              "missing-path",
              "missing-registration"
            ]
          },
          "action": {
            "type": "string"
          }
        },
        "required": [
          "path",
          "workspaceId",
          "taskId",
          "reason",
          "action"
        ],
        "additionalProperties": false
      }
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `worktree.prepareBranch`

Params:

```json
{
  "$ref": "#/definitions/worktree.prepareBranch.params",
  "definitions": {
    "worktree.prepareBranch.params": {
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string"
        },
        "message": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500
        }
      },
      "required": [
        "taskId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/worktree.prepareBranch.result",
  "definitions": {
    "worktree.prepareBranch.result": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "head": {
          "type": "string"
        },
        "branch": {
          "type": [
            "string",
            "null"
          ]
        },
        "baseRef": {
          "type": [
            "string",
            "null"
          ]
        },
        "taskId": {
          "type": [
            "string",
            "null"
          ]
        },
        "main": {
          "type": "boolean"
        },
        "locked": {
          "type": "boolean"
        },
        "prunable": {
          "type": "boolean"
        },
        "dirty": {
          "type": "boolean"
        },
        "ahead": {
          "type": "integer",
          "minimum": 0
        },
        "behind": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "path",
        "head",
        "branch",
        "baseRef",
        "taskId",
        "main",
        "locked",
        "prunable",
        "dirty",
        "ahead",
        "behind"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `worktree.remove`

Params:

```json
{
  "$ref": "#/definitions/worktree.remove.params",
  "definitions": {
    "worktree.remove.params": {
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string"
        },
        "force": {
          "type": "boolean"
        }
      },
      "required": [
        "taskId"
      ],
      "additionalProperties": true
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/worktree.remove.result",
  "definitions": {
    "worktree.remove.result": {
      "type": "object",
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "path": {
          "type": "string"
        }
      },
      "required": [
        "ok",
        "path"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### `worktree.status`

Params:

```json
{
  "$ref": "#/definitions/worktree.status.params",
  "definitions": {
    "worktree.status.params": {
      "type": "object",
      "properties": {
        "taskId": {
          "type": "string"
        }
      },
      "required": [
        "taskId"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

Result:

```json
{
  "$ref": "#/definitions/worktree.status.result",
  "definitions": {
    "worktree.status.result": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "head": {
          "type": "string"
        },
        "branch": {
          "type": [
            "string",
            "null"
          ]
        },
        "baseRef": {
          "type": [
            "string",
            "null"
          ]
        },
        "taskId": {
          "type": [
            "string",
            "null"
          ]
        },
        "main": {
          "type": "boolean"
        },
        "locked": {
          "type": "boolean"
        },
        "prunable": {
          "type": "boolean"
        },
        "dirty": {
          "type": "boolean"
        },
        "ahead": {
          "type": "integer",
          "minimum": 0
        },
        "behind": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "path",
        "head",
        "branch",
        "baseRef",
        "taskId",
        "main",
        "locked",
        "prunable",
        "dirty",
        "ahead",
        "behind"
      ],
      "additionalProperties": false
    }
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```
