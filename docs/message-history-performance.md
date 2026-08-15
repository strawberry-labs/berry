# Message history performance contract

The web transcript is a bounded, variable-height window. The API returns 50
messages by default for the web client and never accepts a page larger than
200. Older pages use the message `sequence_id` cursor; completed turns request
only rows after the newest known cursor.

The rendering budget is:

- at most 6 rows of overscan on either side of the viewport (normally no more
  than 18 history rows mounted at once);
- one shared `ResizeObserver` for the currently mounted rows plus one low-cost
  container observer for responsive rail layout, rather than one observer per
  historical message;
- no more than eight task transcripts retained in the shell LRU cache, with
  stream, durable-turn, image, and history metadata evicted together. Only the
  visible task is protected; background turns remain server-owned and are
  rehydrated from turn-state/history when revisited;
- the real 10,000-message Chromium benchmark in
  `apps/web/tests/message-history-performance.spec.ts` must keep twenty scroll
  windows under 1,000 ms, updates under 250 ms, mounted history rows at 18 or
  fewer, and the shared observer count at two or fewer (one viewport observer
  plus one shared row observer). When Chromium exposes `performance.memory`,
  the benchmark also caps heap growth at 32 MiB. The desktop-ui range test is
  retained as a fast unit-level guard, but it is not the acceptance benchmark.

When changing the transcript, run:

```sh
pnpm --filter @berry/desktop-ui test -- src/components/berry-thread-view.test.ts
pnpm --filter @berry/web exec playwright test tests/web-shell.spec.ts --project=chromium --grep "task view|transcript"
pnpm --filter @berry/web exec playwright test tests/message-history-performance.spec.ts --project=chromium
```

The browser benchmark uses the real `BerryThreadView` with 10,000
persisted-shaped message rows and checks the mounted DOM, scroll/update costs, observer count,
and (when available) heap growth. The API suite separately walks 10,000
persisted in-memory rows through the same 50-row cursor contract, so the
render benchmark and the storage/pagination benchmark cover the two halves of
the production path without making the browser test depend on a live database.
Browser checks also verify the
`data-history-mounted` count, bounded rail markers, and scrollTop preservation
when adding an older page.

## Migration rollout

Migration 53 adds only the `(tenant_id, message_id, ordinal)` lookup index; it
does not delete or rewrite messages or parts. It runs with
`CREATE INDEX CONCURRENTLY` on a dedicated, advisory-locked connection, and an
invalid index object is dropped and rebuilt on retry. Migration 54 adds a
session revision trigger for updates/deletes of existing projections so
after-cursor refreshes can detect in-place changes without turning every
ordinary append into a full-range refresh; migration 55 adds a deletion-only
revision marker so a concurrent rewind/delete can discard stale cached rows
without confusing ordinary appends.
Both migrations only add metadata and triggers. A rolling application rollback may leave
 these additive objects in place safely; never remove the index, trigger, or any
 message data as a rollback step. Deploy the API migrations before enabling the
 new paging client. During a rollback the client can still parse an old array
 response, but that legacy endpoint may download and materialize the complete
 history; it is compatibility-only and must not be used as the steady-state
 deployment order. Keep the API migration ahead of the web rollout and restore
 the structured page endpoint before serving long-history production traffic.
