# Harness cache audit — 7 September 2026

Task: `810f3060-b6ed-4dea-b410-ef47dfdb34ba`.
Run: `28ec68df-7781-457a-a2ee-344089400068`.
Model route: `canopywave/qwen/qwen3.8-flash-next` through Berry Router.

## Evidence and limits

At 10:12 UTC the active run had 91 usage events: 21,362,600 input tokens,
1,404,800 cache-read tokens (6.58% of input), 133,252 output tokens, and
$3.088439 recorded model cost. This is a timestamped subtotal, not a final
invoice, and excludes sandbox, infrastructure, and external tools.

| Token category | Tokens | Share of input | Cost at admitted USD/million rates |
| --- | ---: | ---: | ---: |
| Fresh input | 19,957,800 | 93.42% | $2.993670 at $0.15/M |
| Cached input | 1,404,800 | 6.58% | $0.028096 at $0.02/M |
| Output | 133,252 | N/A | $0.066626 at $0.50/M |

Rate-based subtotal is $3.088392; the recorded $3.088439 includes per-call
rounding to whole microdollars. Output is 0.62% of all input-plus-output tokens.

There were zero persisted checkpoints and no portable checkpoint in the
admitted runtime. Grounding is assembled once and stored on the run; the worker
does not update it each model iteration. Local reconstruction on the production
host, using the deployed message builder and historical journal cutoffs, found
one complete system-message hash across 92 request snapshots. Every reconstructed
message list retained the previous list before appending messages. The tool
manifest changed once, after call seven, and then remained stable.

This reconstruction is not a capture of historical network requests. It uses
the persisted runtime and excludes transient supplemental model content. It
therefore rules out routine checkpoint churn and provides strong evidence
against repeated grounding changes, but cannot certify every historical wire
byte or the provider's internal tokenization and cache residency.

Historical examples: 235,520 of 239,020 input tokens were reported cached on one
call; the next reported zero of 242,165. Later, 419,328 of 421,037 were cached,
followed by zero of 425,297. A constant small-prefix break does not explain that
pattern on its own. Historical telemetry conflates omitted counters with zero.

Controlled synthetic tests through the same route, using no task contents:

| Test | Result |
| --- | --- |
| 21,558-token identical prompt | First call zero; five repeats each cached 21,504 (99.75%) |
| 430,958-token prompt | First call reused the earlier 21,504-token synthetic prefix; exact repeat cached 430,080 (99.80%) |
| Append assistant and user messages to the long prompt | 430,080 / 430,978 cached (99.79%); identical repeat also hit |

One long request took 95 seconds despite its 99.79% cache hit. Cache rate alone
does not explain latency. These tests demonstrate functioning short/long prefix
caching and counter transport; they do not prove the production task's requests
landed on the same backend or received complete usage reports.

Automatic approval review rejected resending reconstructed private task contents
to the provider. That replay was not performed. No task execution was altered.
The remaining distinction between omitted telemetry, unrecorded request changes,
and provider residency/routing requires new correlated request diagnostics or
provider-side evidence. There is no confirmed single root cause for all misses.

## Pi comparison

Cloned https://github.com/earendil-works/pi at
`1f78cea7ad938f529cae6251bbbfd82b8bca0df3` into `/tmp/berry-pi-cache-audit`.
Pi is MIT licensed. This change adapts the design principles; it does not replace
Berry's enterprise authorization, durable execution, or provider transport.

Relevant source:

- `packages/ai/src/api/openai-completions.ts`: session-based cache keys,
  declared provider compatibility, streaming usage requests, usage aliases.
- `packages/ai/src/api/openai-prompt-cache.ts`: 64-character OpenAI key limit.
- `packages/agent/src/harness/compaction/compaction.ts`: compaction settings.
- `packages/coding-agent/src/core/tools/truncate.ts`: 2,000-line/50-KiB output limits.

Berry already uses Pi's near-capacity compaction policy. With a one-million-token
window and a 16,384-token reserve this triggers around 983,616 tokens. Copying
that policy again cannot reduce the current task's growing research history.
Pi's affinity headers are explicitly compatibility-gated and disabled by
default. Do not invent CanopyWave support for OpenAI/Anthropic cache controls.

## Implemented corrections

1. Canonicalize outgoing durable tool schemas and order them by tool name.
   Previously the diagnostic canonicalized object keys while the wire payload
   retained arbitrary property order.
2. Add hashes and character lengths for every serialized wire message, including
   full system context; compare the previous prefix, report the first changed
   message and tool-schema change, and retain provider/router request IDs. These
   are message/character measurements, not claims about provider token-cache hits.
3. Use opaque, tenant/session/provider/model/route cache keys rather than changing
   manifest hashes. Keep keys within 64 characters; old keys were 70 characters.
4. Resolve declared cache capabilities from the admitted model/provider catalog
   before the legacy worker environment. Preserve the global control switch.
5. Replace inferred `provider_unsupported` misses with `unknown` when explicit
   controls are absent. Observed cache reads make eligibility true.
6. Parse standard, DeepSeek, and Kimi cache usage fields; distinguish omitted
   counters from reported zeros. Preserve an earlier measured cache counter when
   a later streaming totals chunk omits it. Request streaming usage on OpenAI and
   Berry Router routes.
7. Append supplemental text after tool results rather than rewriting an earlier
   user message. This particularly affects the text-only vision adapter path.
8. Normalize Anthropic fresh-input counts to Berry's inclusive input convention
   at the durable boundary, and include cached tokens in Anthropic total counts.
   Price fresh input, reads, writes, and output once
   each in worker/API calculations; cache writes previously also incurred the
   normal input charge. This is a separate accounting defect, not an explanation
   for this Qwen run, which uses a different transport and has no cache writes.

## Remaining optimization work

- Measure actual prefix reuse and reported/unknown cache counters on new runs;
  correlate provider IDs before changing routing or asserting an eviction cause.
- Benchmark a smaller research working context, for example 64k–128k, against the
  same task quality. Use fixed checkpoint epochs, a retained recent tail, and
  structured evidence with source references. Do not rewrite the checkpoint each
  tool step, or drop raw evidence without a working retrieval path.
- Store large connector responses outside the prompt, expose bounded excerpts
  and an actual retrieval tool, then cap output consistently. Existing persisted
  result markers alone are insufficient: they currently advise rerunning tools.
- Consider provider-supported affinity/explicit caching only after compatibility
  and routing tests, including identical and append-only requests with realistic
  tool/assistant histories.
- Optimize total spend and completion quality, not cache percentage alone. Keeping
  unnecessary context can inflate cache percentage while still wasting tokens.

90%+ is attainable in the controls; it is not a guaranteed session-wide target
without accounting for cold starts, new tool results, schema changes, compaction,
and provider cache behavior. Production rollout is separate from this audit.

## Validation

- 261 focused tests passed across worker (115), router client (48), local-agent
  adapters (22), API budget calculations (15), and shared source tests (61).
- Web, API, and worker dependency typechecks passed.
- Web and worker dependency builds passed; the local-agent build, worker
  dependency typecheck, and 137 adapter/worker tests passed again after the final
  Anthropic total-token correction.
- Generated protocol documentation is refreshed, and `git diff --check` passed.
- Changes are local and have not been deployed. Unrelated working-tree files
  were left alone.

## Review follow-up

- Normalized Anthropic input counts at the non-durable local-runtime boundary
  as well, including usage events, saved usage records, and assistant metadata.
  Regressions cover cache reads exceeding fresh input, cache-only input, and
  avoiding double-counting on OpenAI-compatible responses. API pricing retains
  all cache-write charges for the normalized event.
- The follow-up runtime/adapter and API budget suites passed all 74 tests;
  local-agent typecheck and build passed.
- Rebuilt the memo `.skill` archive from all ten current source resources and
  verified member contents, ZIP integrity, Python syntax, and the identical
  `Downloads/aesg-organisation-memo-latest.skill` copy. Its generator now includes
  the printable-border and department-signature changes already in the sources.
