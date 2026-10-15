-- Where run time goes (H-013), from the timings the worker records in
-- agent_operational_events:
--   run.claim                  queueWaitMs (request to first claim), hydrationMs
--   phase.transition           model.call durationMs and firstTokenMs
--   tool.attempt               durationMs of each finished tool step
--   sandbox.operation          sandbox.ensure, inputs.wait, inputs.stage,
--                              skill.stage, document.extract, snapshot.capture,
--                              snapshot.upload with durationMs
--   finalization.transition    durationMs of the whole run
-- Tool time includes any sandbox access, staging and extraction done inside
-- the tool, so the columns overlap and do not add up to the total.
--
-- Run where the production database is reachable, for example:
--   psql "$DATABASE_URL" -v since=2026-10-15 -v tenant_id=<tenant uuid> -f scripts/run-timing-report.sql
-- tenant_id is needed when row-level security is enforced for the role.
-- Everything runs in one READ ONLY transaction; nothing is created or written,
-- and the output holds run IDs and durations only.

\set ON_ERROR_STOP on
\pset pager off
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';
\if :{?tenant_id}
SELECT berry_set_tenant_id(:'tenant_id'::uuid);
\endif

\echo '== Percentiles across finished runs (milliseconds) =='
WITH run_timing AS (
  WITH events AS (
    SELECT run_id, event_type, payload, created_at
    FROM agent_operational_events
    WHERE created_at >= :'since'::timestamptz AND run_id IS NOT NULL
  )
  SELECT
    run_id,
    (array_agg((payload->>'queueWaitMs')::bigint ORDER BY created_at) FILTER (WHERE event_type = 'run.claim'))[1] AS queue_ms,
    sum((payload->>'hydrationMs')::bigint) FILTER (WHERE event_type = 'run.claim') AS hydration_ms,
    (array_agg((payload->>'firstTokenMs')::bigint ORDER BY created_at)
      FILTER (WHERE event_type = 'phase.transition' AND payload->>'phase' = 'model.call' AND payload ? 'firstTokenMs'))[1] AS first_token_ms,
    count(*) FILTER (WHERE event_type = 'phase.transition' AND payload->>'phase' = 'model.call' AND payload ? 'durationMs') AS model_calls,
    sum((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'phase.transition' AND payload->>'phase' = 'model.call') AS model_ms,
    count(*) FILTER (WHERE event_type = 'tool.attempt' AND payload ? 'durationMs') AS tool_steps,
    sum((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'tool.attempt') AS tool_ms,
    sum((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'sandbox.operation' AND payload->>'operation' = 'sandbox.ensure') AS sandbox_ms,
    sum((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'sandbox.operation' AND payload->>'operation' IN ('inputs.wait', 'inputs.stage', 'skill.stage')) AS staging_ms,
    sum((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'sandbox.operation' AND payload->>'operation' = 'document.extract') AS extraction_ms,
    sum((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'sandbox.operation' AND payload->>'operation' IN ('snapshot.capture', 'snapshot.upload')) AS snapshot_ms,
    max((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'finalization.transition') AS total_ms
  FROM events
  GROUP BY run_id
)
SELECT component,
       count(value) AS runs,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY value) AS p50,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY value) AS p90,
       max(value) AS max
FROM run_timing,
     LATERAL (VALUES
       ('1 total', total_ms), ('2 queue wait', queue_ms), ('3 hydration', hydration_ms),
       ('4 first token', first_token_ms), ('5 model', model_ms), ('6 tools', tool_ms),
       ('7 sandbox access', sandbox_ms), ('8 staging', staging_ms),
       ('9 document extraction', extraction_ms), ('10 snapshot', snapshot_ms)
     ) AS parts(component, value)
WHERE total_ms IS NOT NULL
GROUP BY component
ORDER BY split_part(component, ' ', 1)::int;

\echo '== Slowest 20 runs, broken down (milliseconds) =='
WITH run_timing AS (
  WITH events AS (
    SELECT run_id, event_type, payload, created_at
    FROM agent_operational_events
    WHERE created_at >= :'since'::timestamptz AND run_id IS NOT NULL
  )
  SELECT
    run_id,
    (array_agg((payload->>'queueWaitMs')::bigint ORDER BY created_at) FILTER (WHERE event_type = 'run.claim'))[1] AS queue_ms,
    sum((payload->>'hydrationMs')::bigint) FILTER (WHERE event_type = 'run.claim') AS hydration_ms,
    (array_agg((payload->>'firstTokenMs')::bigint ORDER BY created_at)
      FILTER (WHERE event_type = 'phase.transition' AND payload->>'phase' = 'model.call' AND payload ? 'firstTokenMs'))[1] AS first_token_ms,
    count(*) FILTER (WHERE event_type = 'phase.transition' AND payload->>'phase' = 'model.call' AND payload ? 'durationMs') AS model_calls,
    sum((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'phase.transition' AND payload->>'phase' = 'model.call') AS model_ms,
    count(*) FILTER (WHERE event_type = 'tool.attempt' AND payload ? 'durationMs') AS tool_steps,
    sum((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'tool.attempt') AS tool_ms,
    sum((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'sandbox.operation' AND payload->>'operation' = 'sandbox.ensure') AS sandbox_ms,
    sum((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'sandbox.operation' AND payload->>'operation' IN ('inputs.wait', 'inputs.stage', 'skill.stage')) AS staging_ms,
    sum((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'sandbox.operation' AND payload->>'operation' = 'document.extract') AS extraction_ms,
    sum((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'sandbox.operation' AND payload->>'operation' IN ('snapshot.capture', 'snapshot.upload')) AS snapshot_ms,
    max((payload->>'durationMs')::bigint) FILTER (WHERE event_type = 'finalization.transition') AS total_ms
  FROM events
  GROUP BY run_id
)
SELECT run_id, total_ms, queue_ms, first_token_ms, model_calls, model_ms, tool_steps, tool_ms,
       sandbox_ms, staging_ms, extraction_ms, snapshot_ms
FROM run_timing
WHERE total_ms IS NOT NULL
ORDER BY total_ms DESC
LIMIT 20;

\echo '== Preparation steps by operation and outcome (milliseconds) =='
SELECT payload->>'operation' AS operation,
       payload->>'outcome' AS outcome,
       count(*) AS steps,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY (payload->>'durationMs')::bigint) AS p50,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY (payload->>'durationMs')::bigint) AS p90,
       max((payload->>'durationMs')::bigint) AS max,
       sum(COALESCE((payload->>'byteCount')::bigint, 0)) AS bytes
FROM agent_operational_events
WHERE created_at >= :'since'::timestamptz
  AND event_type = 'sandbox.operation'
  AND payload ? 'durationMs'
GROUP BY 1, 2
ORDER BY 1, 2;

ROLLBACK;
