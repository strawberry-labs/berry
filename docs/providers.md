# Provider support

Berry uses three transport contracts: OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages. Provider presets select one of those transports; they do not introduce provider SDKs.

## Enterprise matrix

| Provider | Desktop lane | Authentication | Fixture coverage | Live status |
| --- | --- | --- | --- | --- |
| Anthropic | Native Messages API at `https://api.anthropic.com/v1` | `x-api-key` plus `anthropic-version` | Models, first-party capability/context metadata, streaming text, tools/reasoning adapter behavior, and usage | Human key required; see blocker #11 |
| Google Gemini | OpenAI-compatible Chat Completions at `https://generativelanguage.googleapis.com/v1beta/openai` | Bearer API key | Models, completion request/response, tools/images through the shared Chat Completions adapter, and usage | Human key required; see blocker #11 |
| Amazon Bedrock | Berry Router | Router virtual key/account | Router aliases and served-by attribution | Router contract confirmation required; see blocker #2 |
| Google Vertex AI | Berry Router | Router virtual key/account | Router aliases and served-by attribution | Router contract confirmation required; see blocker #2 |

The direct Anthropic and Gemini settings follow the current official contracts: [Claude Messages and Models APIs](https://platform.claude.com/docs/en/api/messages/create), [Claude model IDs](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions), and [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai). The recorded matrix is `packages/router-client/src/fixtures/provider-enterprise-matrix.json`.

Bedrock and Vertex deliberately have no native desktop presets. That preserves the product decision in `plans/berry-platform-product-decisions.md` section 7.2: cloud IAM, region/project configuration, and provider-specific signing belong in Router adapters. A design-partner requirement is the threshold for adding a direct desktop adapter. This remains true even though Bedrock and Vertex expose OpenAI-compatible surfaces.

## Live verification

The live matrix performs one small model-list and generation request per direct provider. It is opt-in and never runs in CI:

```sh
ANTHROPIC_API_KEY='...' \
GEMINI_API_KEY='...' \
corepack pnpm --filter @berry/router-client verify:live
```

`GOOGLE_API_KEY` may be used instead of `GEMINI_API_KEY`. The command fails if either preset default is absent, Anthropic does not finish its stream, or Gemini returns an empty completion. Record the date, account region/tier, returned model IDs, and pass/fail below without keys or response content.

No human-key run has been recorded yet. See `plans/human-blockers.md` #11.
