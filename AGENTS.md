# Berry web platform

## Current priority

Berry is developed first as a self-hosted enterprise AI assistant and workspace.
Prioritize `apps/web`, `apps/api`, `apps/worker`, and the shared packages they
depend on. Desktop, mobile, extension, and release packaging must not block the
web build or production deployment path.

## UI system

- Route surfaces, text, borders, and accents through the existing
  `--berry-*` variables. Do not hardcode component-specific theme colors.
- Keep the web interface compact: 14px body text, 12px secondary text, 11px
  metadata, restrained borders, and clear focus states.
- The prompt editor uses Lexical. Mentions are atomic tokens whose serialized
  text remains compatible with plain prompt text.
- Keep motion interruptible and respect reduced-motion preferences.

## Web verification

For normal web work, run the focused checks instead of the full cross-platform
suite:

```sh
pnpm --filter @berry/web... typecheck
pnpm --filter @berry/web... build
pnpm --filter @berry/api... typecheck
pnpm --filter @berry/worker... typecheck
```

Run broader tests only when the changed package is shared with another surface.

## Production

- Production secrets live only in `deploy/.env.production`; this file is never
  committed or replaced by deployment automation.
- A normal web-only change rebuilds and restarts only the `web` service.
- API, worker, Compose, proxy, or schema changes must use the corresponding
  service deployment path.
