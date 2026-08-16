# Web route bundle budgets

The production web build runs `scripts/verify-web-build-assets.mjs` after Vite. The verifier reads the TanStack Start manifest, resolves each route's root and route preloads, follows their static JavaScript imports, and includes only the AppShell lazy hop from the root route declarations. It then measures concrete route branches: the selected task/home surface and every declared settings, platform, and admin tab variant. Per-tab leaf loaders keep the selected management implementation out of the route preload; shared primitive/chart chunks are charged only when that selected branch imports them. This avoids charging a user for sibling tabs that were not requested. Home and task branches also include their immediately requested Composer/Thread chunks; interaction-only previews and dialogs remain outside unrelated-route budgets. Management graphs fail the build if they contain task-only chunks (`web-composer`, `web-task-view`, `task-route-state`, or the benchmark).

For every route branch it measures raw emitted bytes, Brotli encoded bytes, gzip bytes, and JavaScript request count. The root shell has the same raw/encoded/gzip checks. A build fails when any branch exceeds its budget or when an expected lazy import disappears.

| Route branch | Budget raw | Budget Brotli | Budget gzip | Budget requests | Latest measured raw | Latest measured Brotli | Latest measured gzip | Latest requests |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Home `/` | 1,500,000 | 450,000 | 500,000 | 65 | 1,324,128 | 360,355 | 411,798 | 55 |
| Task `/tasks/$taskId` | 2,200,000 | 650,000 | 700,000 | 75 | 1,915,714 | 511,322 | 589,994 | 66 |
| Settings `/settings/$tab` (worst: skills) | 2,100,000 | 600,000 | 700,000 | 85 | 1,859,829 | 489,929 | 565,906 | 66 |
| Platform `/platform/$tab` (worst: overview) | 1,800,000 | 500,000 | 550,000 | 65 | 1,602,633 | 432,044 | 495,373 | 57 |
| Admin `/admin/$tab` (worst: analytics) | 1,900,000 | 525,000 | 575,000 | 70 | 1,629,813 | 439,516 | 503,805 | 59 |

The root shell is 556,102 raw / 147,886 Brotli / 169,144 gzip bytes across 12 files. Compared with the pre-split build measured during Item 8, home fell from 2,634,749 raw / 809,611 gzip bytes to 1,324,128 / 411,798, and the task route fell from 2,649,434 / 815,863 to 1,915,714 / 589,994. The old verifier over-unioned every management tab, so its settings, platform, and admin baselines were each 72 files / 1,710,787 raw / 529,616 gzip; that version did not record Brotli. The new branch-specific worst cases are settings/skills at 1,859,829 raw, platform/overview at 1,602,633, and admin/analytics at 1,629,813, with the complete raw/Brotli/gzip/request results in the table above. The task route deliberately retains the thread and composer chunks because they are immediately needed there; management routes reject those chunks entirely.

The settings variants are `general`, `account`, `personalization`, `connectors`, `skills`, `mcp`, `usage`, and `archived`. Platform measures `overview`, `organizations`, `feature-rollout`, `router-health`, and `billing-operations`. Admin measures `overview`, `members`, `departments`, `analytics`, `spend-limits`, `credits-billing`, `reports`, `policy`, `service-accounts`, `roles`, `resource-access`, `providers`, `models`, `skills-mcp`, `feature-access`, `sso-scim`, `managed-policy`, `audit-log`, `connectors`, and `organization`.

The route graph is checked as part of `pnpm --filter @berry/web... build`, so CI rejects both size regressions and missing route manifest entries.
