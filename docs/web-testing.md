# Berry web workflow testing

The Chromium workflow suite is a required pull-request check for changes in
the web platform graph. It runs the same `apps/web/tests` suite used by local
development, so a failing browser assertion fails the job; the workflow does
not use `continue-on-error`, `--pass-with-no-tests`, or an unconditional
success step.

## Run the suite locally

```sh
pnpm install
pnpm --filter @berry/web exec playwright install chromium
pnpm --filter @berry/web exec playwright test --project=chromium
```

The Playwright config starts the Vite demo server on port 3108. Use the
accessible roles, labels, and stable test IDs already present in the suite when
adding a workflow assertion. Keep the file-lifecycle test separate: it starts
the PostgreSQL/MinIO fixture server and is run by the production integration
job with its explicit environment variables.

## Update screenshots deliberately

Chromium screenshots are limited to the management reference tests. Review a
visual change locally with:

```sh
pnpm --filter @berry/web exec playwright test --project=chromium --grep "captures the rebuilt"
pnpm --filter @berry/web exec playwright test --project=chromium --grep "captures the rebuilt" --update-snapshots
```

The repository keeps platform-specific Chromium references because text
antialiasing differs between macOS and the Ubuntu runner. Updating on macOS
refreshes the `*-chromium-darwin.png` files. Refresh the CI references with the
pinned Playwright Linux image, then review and commit the generated
`*-chromium-linux.png` files:

```sh
docker run --rm --ipc=host -v "$PWD":/work -w /work \
  mcr.microsoft.com/playwright:v1.61.1-noble bash -lc '
    cp -a /work /tmp/berry-web && rm -rf /tmp/berry-web/node_modules
    cd /tmp/berry-web && corepack pnpm install --frozen-lockfile
    corepack pnpm --filter @berry/web exec playwright test --project=chromium \
      --grep "captures the rebuilt" --update-snapshots
    cp apps/web/tests/web-shell.spec.ts-snapshots/*-chromium-linux.png \
      /work/apps/web/tests/web-shell.spec.ts-snapshots/
  '
```

Failure traces, screenshots, and videos are written under `test-results/` and
uploaded by CI when the Chromium job fails. They are ignored by Git and should
not be committed.
