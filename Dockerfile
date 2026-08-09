# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS workspace

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./

# Keep dependency installation independent from application source. A normal
# TypeScript or CSS edit now reuses the complete install layer.
COPY apps/api/package.json ./apps/api/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/docs/package.json ./apps/docs/package.json
COPY apps/extension/package.json ./apps/extension/package.json
COPY apps/mem0/package.json ./apps/mem0/package.json
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/acp-adapter/package.json ./packages/acp-adapter/package.json
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY packages/cli-npm/package.json packages/cli-npm/install.js ./packages/cli-npm/
COPY packages/db/package.json ./packages/db/package.json
COPY packages/desktop-db/package.json ./packages/desktop-db/package.json
COPY packages/desktop-ui/package.json ./packages/desktop-ui/package.json
COPY packages/execpolicy/package.json ./packages/execpolicy/package.json
COPY packages/harness/package.json ./packages/harness/package.json
COPY packages/host/package.json ./packages/host/package.json
COPY packages/local-agent-protocol/package.json ./packages/local-agent-protocol/package.json
COPY packages/local-agent/package.json ./packages/local-agent/package.json
COPY packages/personal-memory/package.json ./packages/personal-memory/package.json
COPY packages/router-client/package.json ./packages/router-client/package.json
COPY packages/sandbox-contract/package.json ./packages/sandbox-contract/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/thread-ui/package.json ./packages/thread-ui/package.json

# Resolve dependencies from the lightweight manifest layer so ordinary source
# changes reuse both the fetched pnpm store and the offline install.
RUN --mount=type=cache,id=berry-pnpm-store,target=/pnpm/store \
  corepack pnpm config set store-dir /pnpm/store \
  && corepack pnpm fetch --frozen-lockfile

RUN --mount=type=cache,id=berry-pnpm-store,target=/pnpm/store \
  corepack pnpm install --offline --frozen-lockfile

FROM workspace AS build-api
COPY apps/api ./apps/api
COPY packages/db ./packages/db
COPY packages/desktop-db ./packages/desktop-db
COPY packages/execpolicy ./packages/execpolicy
COPY packages/harness ./packages/harness
COPY packages/local-agent ./packages/local-agent
COPY packages/personal-memory ./packages/personal-memory
COPY packages/router-client ./packages/router-client
COPY packages/sandbox-contract ./packages/sandbox-contract
COPY packages/shared ./packages/shared
RUN --mount=type=cache,id=berry-turbo,target=/app/.turbo \
  corepack pnpm --filter @berry/api... build \
  && corepack pnpm --filter @berry/api deploy --prod --legacy /out/apps/api

FROM workspace AS build-worker
COPY apps/worker ./apps/worker
COPY packages/desktop-db ./packages/desktop-db
COPY packages/execpolicy ./packages/execpolicy
COPY packages/harness ./packages/harness
COPY packages/local-agent ./packages/local-agent
COPY packages/personal-memory ./packages/personal-memory
COPY packages/router-client ./packages/router-client
COPY packages/sandbox-contract ./packages/sandbox-contract
COPY packages/shared ./packages/shared
RUN --mount=type=cache,id=berry-turbo,target=/app/.turbo \
  corepack pnpm --filter @berry/worker... build \
  && corepack pnpm --filter @berry/worker deploy --prod --legacy /out/apps/worker

FROM workspace AS build-mem0
COPY apps/mem0 ./apps/mem0
COPY packages/personal-memory ./packages/personal-memory
COPY packages/shared ./packages/shared
RUN --mount=type=cache,id=berry-turbo,target=/app/.turbo \
  corepack pnpm --filter @berry/mem0... build \
  && corepack pnpm --filter @berry/mem0 deploy --prod --legacy /out/apps/mem0

FROM workspace AS build-web
COPY apps/desktop/src/globals.css ./apps/desktop/src/globals.css
COPY apps/web ./apps/web
COPY packages/api-client ./packages/api-client
COPY packages/desktop-ui ./packages/desktop-ui
COPY packages/shared ./packages/shared
COPY packages/thread-ui ./packages/thread-ui
COPY scripts/prepare-web-build.mjs scripts/verify-web-build-assets.mjs ./scripts/
RUN --mount=type=cache,id=berry-turbo,target=/app/.turbo \
  corepack pnpm --filter @berry/web... build \
  && corepack pnpm --filter @berry/web deploy --prod --legacy /out/apps/web

FROM node:22-bookworm-slim AS runtime-base

WORKDIR /app
ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable \
  && mkdir -p /data \
  && chown node:node /data

VOLUME ["/data"]
EXPOSE 3000 3010 3108 8010

FROM runtime-base AS api

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=build-api /out/apps/api /app/apps/api

USER node

CMD ["node", "apps/api/dist/main.js"]

FROM runtime-base AS worker

COPY --chown=node:node --from=build-worker /out/apps/worker /app/apps/worker

USER node

CMD ["node", "apps/worker/dist/main.js"]

FROM runtime-base AS mem0

COPY --chown=node:node --from=build-mem0 /out/apps/mem0 /app/apps/mem0

USER node

CMD ["node", "apps/mem0/dist/main.js"]

FROM runtime-base AS web

COPY --chown=node:node --from=build-web /out/apps/web /app/apps/web

USER node

CMD ["apps/web/node_modules/.bin/srvx", "--prod", "-s", "../client", "apps/web/dist/server/server.js"]
