# Harness improvements backlog

Requested on 20 October 2026 after reviewing DeepSeek Harness. The five changes in
`output/harness-optimization-2026-10-20/progress.md` are the current implementation
scope. The following features are deferred; none is enabled by this rollout.

- [ ] **Programmatic MCP calls:** authenticated tool bindings inside a bounded
  script runtime, per-call authorization and cancellation, complete intermediate
  values, and compact results returned to the model. Benchmark native calls
  against scripts before choosing defaults.
- [ ] **Durable web subagents:** child runs on the existing queue with bounded
  concurrency, explicit token/spend limits, cancellation, evidence-linked
  reports and recovery after restart. Preserve completed parent history only
  when the provider, model and tool envelope match. Compare with fresh children.
- [ ] **Background commands:** durable job IDs, bounded output reads, cancellation
  and completion notifications for OCR, rendering and long processing jobs.
  Avoid polling loops and duplicate notifications after reconnect.
- [ ] **Recorded-stream regression replay:** sanitized fixtures from model streams
  and durable events, including compaction, tool failures, cancellation and
  recovery. Keep this distinct from live quality/cache/performance evaluation.
- [ ] **Controlled live benchmark:** compare factual completeness, source coverage,
  uncached input, weighted cache-read/input ratio, TTFT, decoding TPS, tool time,
  whole-task duration and cost with a fixed provider/model/reasoning/tool set.
  Report cold and warm runs separately; do not optimize hit percentage alone.
- [ ] **Coding tools:** evaluate language-server definitions, references and
  diagnostics for coding-heavy tenants. This is lower priority than enterprise
  research and document workflows.
- [ ] **Persistent shell sessions:** evaluate isolated stateful shells only where
  useful, with explicit ownership and ordering around shared shell state.

Provider-specific DeepSeek APIs (in-history system/tool updates and Files API)
need an explicit capability check before use on Inference.net. Do not assume
OpenAI-compatible providers accept those extensions.
