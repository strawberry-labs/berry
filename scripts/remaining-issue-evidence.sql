-- Read-only evidence for the audit issues still waiting on production data:
-- H-003 (tool-error categories), H-006 (MCP and BerryCrawl failures), H-013
-- (preparation, Office reads and snapshot timing), H-021 (model retry timing in
-- two stranded tasks) and H-024 (one task's connector receipts).
--
-- Run where the production database is reachable, for example on the server:
--   psql "$DATABASE_URL" -v since=2026-09-14 -f scripts/remaining-issue-evidence.sql > evidence.txt
--
-- Everything runs in one READ ONLY transaction with statement and lock
-- timeouts; nothing is created or written. The aggregate sections mask quoted
-- text, URLs, paths and numbers in error messages. The named-task sections
-- (H-006, H-021, H-024) print raw error text and connector receipts for those
-- tasks only; review the output before sharing it outside the team.

\set ON_ERROR_STOP on
\pset pager off
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';

\echo '== H-003: failed tool steps by tool and error category (masked) =='
WITH failed AS (
  SELECT s.tenant_id, s.run_id, s.sequence, s.step_type, r.user_id, r.state AS run_state,
         COALESCE(s.input->>'toolName', substr(s.step_type, 6)) AS tool,
         lower(regexp_replace(COALESCE(s.error, ''), '^Tool failed \(repair attempt [0-9]+/[0-9]+[^)]*\)\.\s*', '')) AS error
  FROM turn_steps s
  JOIN turn_runs r ON r.id = s.run_id AND r.tenant_id = s.tenant_id
  WHERE s.step_type LIKE 'tool.%' AND s.state = 'failed' AND s.created_at >= :'since'::timestamptz
), categorised AS (
  SELECT f.*,
    CASE
      WHEN f.error ~ '(402|insufficient (credit|quota|balance|funds)|quota|billing|out of credits)' THEN 'provider_unavailable'
      WHEN f.error ~ '(timed out|timeout|econnreset|etimedout|socket hang up|\m50[234]\M|\m429\M|rate limit|temporar|unavailable)' THEN 'transient'
      WHEN f.error ~ '(changed since review|re-?approv|not approved|allowlist|not configured|unconfigured|network policy|domain is not)' THEN 'configuration'
      WHEN f.error ~ '(\m40[13]\M|unauthori|forbidden|permission|denied|not allowed|policy|blocked|reauth|invalid.?grant|invalid token|token expired|expired token)' THEN 'auth_or_policy'
      WHEN f.error ~ '(enoent|not found|no such file|\m404\M|does not exist|unknown .* resource)' THEN 'missing_resource'
      WHEN f.error ~ '(invalid|must |required|expected|schema|validation|unsupported|malformed|syntaxerror|cannot parse)' THEN 'invalid_arguments'
      WHEN f.error ~ '(suppressed|duplicate|identical arguments)' THEN 'loop_guard'
      ELSE 'other'
    END AS category,
    EXISTS (
      SELECT 1 FROM turn_steps n
      WHERE n.tenant_id = f.tenant_id AND n.run_id = f.run_id AND n.sequence > f.sequence AND n.step_type = f.step_type
    ) AS retried_later
  FROM failed f
)
SELECT tool, category, count(*) AS failures, count(DISTINCT run_id) AS runs, count(DISTINCT user_id) AS users,
       round(100.0 * avg(retried_later::int), 1) AS same_tool_called_again_pct,
       round(100.0 * avg((run_state = 'failed')::int), 1) AS run_failed_pct
FROM categorised
GROUP BY tool, category
ORDER BY failures DESC
LIMIT 60;

\echo '== H-003: most common masked errors per category =='
WITH failed AS (
  SELECT COALESCE(s.input->>'toolName', substr(s.step_type, 6)) AS tool,
         regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           left(regexp_replace(COALESCE(s.error, ''), '^Tool failed \(repair attempt [0-9]+/[0-9]+[^)]*\)\.\s*', ''), 300),
           '([''"`])[^''"`]*\1', '<quoted>', 'g'),
           'https?://\S+', '<url>', 'g'),
           '\S*/\S*', '<path>', 'g'),
           '\m[0-9a-f]{6,}\M|[0-9]+', '<n>', 'g') AS masked
  FROM turn_steps s
  WHERE s.step_type LIKE 'tool.%' AND s.state = 'failed' AND s.created_at >= :'since'::timestamptz
)
SELECT tool, masked, count(*) AS failures
FROM failed
GROUP BY tool, masked
ORDER BY failures DESC
LIMIT 40;

\echo '== H-006: MCP, crawl and search tool failures (masked) =='
WITH failed AS (
  SELECT COALESCE(s.input->>'toolName', substr(s.step_type, 6)) AS tool, r.user_id,
         regexp_replace(regexp_replace(regexp_replace(regexp_replace(
           left(regexp_replace(COALESCE(s.error, ''), '^Tool failed \(repair attempt [0-9]+/[0-9]+[^)]*\)\.\s*', ''), 300),
           '([''"`])[^''"`]*\1', '<quoted>', 'g'),
           'https?://\S+', '<url>', 'g'),
           '\S*/\S*', '<path>', 'g'),
           '\m[0-9a-f]{6,}\M|[0-9]+', '<n>', 'g') AS masked
  FROM turn_steps s
  JOIN turn_runs r ON r.id = s.run_id AND r.tenant_id = s.tenant_id
  WHERE s.step_type LIKE 'tool.%' AND s.state = 'failed' AND s.created_at >= :'since'::timestamptz
    AND COALESCE(s.input->>'toolName', s.step_type) ~* '(mcp|crawl|scrape|search|fetch|browse)'
)
SELECT tool, masked, count(*) AS failures, count(DISTINCT user_id) AS users
FROM failed
GROUP BY tool, masked
ORDER BY failures DESC
LIMIT 40;

\echo '== H-006: task 8576270d (invalid token / reauthentication), failed steps =='
SELECT s.sequence, COALESCE(s.input->>'toolName', substr(s.step_type, 6)) AS tool, s.created_at, left(s.error, 400) AS error
FROM turn_steps s
JOIN turn_runs r ON r.id = s.run_id AND r.tenant_id = s.tenant_id
WHERE r.task_id = '8576270d-fe63-4a9e-8d56-44f0729edebf' AND s.state = 'failed'
ORDER BY s.created_at, s.sequence;

\echo '== H-013: time from run start to the first model call, by attachments (ms) =='
WITH runs AS (
  SELECT r.id,
         COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(r.runtime_request->'attachments') = 'array' THEN r.runtime_request->'attachments' END), 0) AS attachments,
         (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.runtime_request->'attachments') = 'array' THEN r.runtime_request->'attachments' ELSE '[]'::jsonb END) a
           WHERE a->>'mediaType' LIKE 'image/%') AS images,
         (SELECT min(m.started_at) FROM turn_steps m WHERE m.tenant_id = r.tenant_id AND m.run_id = r.id AND m.step_type = 'model.call') AS first_model_at,
         r.created_at
  FROM turn_runs r
  WHERE r.created_at >= :'since'::timestamptz
)
SELECT CASE WHEN attachments = 0 THEN 'none' WHEN images > 0 THEN 'with images' ELSE 'files only' END AS attachments,
       count(*) AS runs,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_model_at - created_at) * 1000)::numeric) AS p50_ms,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM first_model_at - created_at) * 1000)::numeric) AS p90_ms,
       round(percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM first_model_at - created_at) * 1000)::numeric) AS p99_ms
FROM runs
WHERE first_model_at IS NOT NULL
GROUP BY 1
ORDER BY 1;

\echo '== H-013: Office and PDF read durations by extension (ms) =='
WITH reads AS (
  SELECT lower(substring(s.input->'arguments'->>'path' FROM '\.([A-Za-z0-9]+)$')) AS extension,
         extract(epoch FROM s.completed_at - s.started_at) * 1000 AS ms
  FROM turn_steps s
  WHERE s.step_type = 'tool.read' AND s.state = 'completed' AND s.created_at >= :'since'::timestamptz
    AND s.started_at IS NOT NULL AND s.completed_at IS NOT NULL
)
SELECT extension, count(*) AS reads,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::numeric) AS p50_ms,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY ms)::numeric) AS p90_ms,
       round(max(ms)::numeric) AS max_ms
FROM reads
WHERE extension IN ('docx', 'xlsx', 'pptx', 'pdf', 'doc', 'xls', 'ppt')
GROUP BY extension
ORDER BY reads DESC;

\echo '== H-013: snapshot jobs by reason (queue-to-completion ms; includes queue wait and retries) =='
WITH jobs AS (
  SELECT split_part(split_part(o.dedupe_key, ':snapshot:', 2), ':', 1) AS reason,
         o.attempts, o.last_error IS NOT NULL AS had_error,
         extract(epoch FROM o.completed_at - o.created_at) * 1000 AS ms
  FROM runtime_outbox o
  WHERE o.event_type = 'sandbox.snapshot' AND o.created_at >= :'since'::timestamptz AND o.completed_at IS NOT NULL
)
SELECT COALESCE(NULLIF(reason, ''), 'interval') AS reason, count(*) AS jobs,
       round(100.0 * avg(had_error::int), 1) AS had_error_pct, max(attempts) AS max_attempts,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::numeric) AS p50_ms,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY ms)::numeric) AS p90_ms,
       round(max(ms)::numeric) AS max_ms
FROM jobs
GROUP BY 1
ORDER BY jobs DESC;

\echo '== H-021: model calls in the two stranded tasks =='
SELECT r.task_id, r.id AS run_id, r.state AS run_state, s.sequence, s.state, s.attempt,
       s.started_at, s.completed_at,
       round(extract(epoch FROM COALESCE(s.completed_at, s.updated_at) - s.started_at)::numeric, 1) AS seconds,
       s.output->'providerDiagnostics'->>'category' AS failure_category,
       s.output->'providerDiagnostics'->>'statusClass' AS status_class,
       left(s.error, 300) AS error
FROM turn_runs r
JOIN turn_steps s ON s.run_id = r.id AND s.tenant_id = r.tenant_id AND s.step_type = 'model.call'
WHERE r.task_id IN ('f1bb2668-ed04-465a-b172-ad8f199d0cb7', '57dced38-6e3e-442b-bfe0-95f6c96fa578')
ORDER BY r.task_id, r.created_at, s.sequence;

\echo '== H-021: provider attempts in those tasks =='
SELECT r.task_id, e.run_id, e.created_at,
       e.payload->>'physicalAttempt' AS attempt, e.payload->>'model' AS model,
       e.payload->>'statusClass' AS status_class, e.payload->>'category' AS category,
       e.payload->>'retryDecision' AS retry_decision, e.payload->>'latencyMs' AS latency_ms,
       e.payload->>'finishReason' AS finish_reason
FROM turn_events e
JOIN turn_runs r ON r.id = e.run_id AND r.tenant_id = e.tenant_id
WHERE r.task_id IN ('f1bb2668-ed04-465a-b172-ad8f199d0cb7', '57dced38-6e3e-442b-bfe0-95f6c96fa578')
  AND e.event_type = 'provider.attempt'
ORDER BY r.task_id, e.created_at;

\echo '== H-024: tool steps and connector receipts in task 2743dd77 =='
SELECT s.sequence, COALESCE(s.input->>'toolName', substr(s.step_type, 6)) AS tool, s.state,
       round(extract(epoch FROM s.completed_at - s.started_at)::numeric, 1) AS seconds,
       left(s.input->>'arguments', 300) AS arguments,
       CASE WHEN COALESCE(s.input->>'toolName', s.step_type) ~* '(drive|connector|onedrive|sharepoint|gmail|google)'
            THEN left(s.output::text, 1000) END AS connector_receipt,
       left(s.error, 300) AS error
FROM turn_runs r
JOIN turn_steps s ON s.run_id = r.id AND s.tenant_id = r.tenant_id AND s.step_type LIKE 'tool.%'
WHERE r.task_id = '2743dd77-227e-4343-b50b-2d0a4ea164a5'
ORDER BY r.created_at, s.sequence
LIMIT 40;

ROLLBACK;
