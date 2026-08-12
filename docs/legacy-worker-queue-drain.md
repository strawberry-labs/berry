# Legacy `berry-cloud` queue drain

The split worker rollout keeps a bounded background consumer on the old
`berry-cloud` BullMQ queue. New outbox deliveries go to `berry-foreground` or
`berry-background`; old job IDs, receipts, retries, and recovery semantics are
left intact while the legacy queue drains.

## During rollout

1. Keep `BERRY_LEGACY_QUEUE_DRAIN=true` and
   `BERRY_LEGACY_WORKER_CONCURRENCY=1` on the background worker.
2. Confirm no API, outbox dispatcher, or worker from the pre-split revision is
   still running. An old producer can refill `berry-cloud` after it first reaches
   zero.
3. Watch these Prometheus queries. Queue gauges appear on multiple worker
   targets, so use `max`, not `sum`:

   ```promql
   max(berry_worker_queue_jobs{queue="legacy",state="waiting"}) or vector(0)
   max(berry_worker_queue_jobs{queue="legacy",state="active"}) or vector(0)
   max(berry_worker_queue_jobs{queue="legacy",state="failed"}) or vector(0)
   max(berry_worker_queue_oldest_waiting_seconds{queue="legacy"}) or vector(0)
   ```

4. Investigate `BerryLegacyQueueDrainStalled` before increasing concurrency.
   A stuck non-idempotent job must be reconciled through its durable receipt;
   do not delete or replay queue keys manually.

## Safe exit criterion

Disable the legacy consumer only after waiting and active have both remained
zero for at least 15 minutes, the old revision is absent, and failed jobs have
been inspected and reconciled. Record the observation window with the deployed
revision. Then set `BERRY_LEGACY_QUEUE_DRAIN=false` in the deployment environment
and recreate the background worker. Metrics remain available even when the
consumer is disabled.

If the old queue rises again, restore `BERRY_LEGACY_QUEUE_DRAIN=true` and recreate
the background worker. Do not rename the queue or purge its Redis keys during
the compatibility window.
