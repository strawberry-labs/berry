# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS workspace

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./

# Fetch dependency tarballs before source code is copied. Normal application
# changes now keep this expensive layer and reuse the BuildKit pnpm cache.
RUN --mount=type=cache,id=berry-pnpm-store,target=/pnpm/store \
  corepack pnpm config set store-dir /pnpm/store \
  && corepack pnpm fetch --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN --mount=type=cache,id=berry-pnpm-store,target=/pnpm/store \
  corepack pnpm install --offline --frozen-lockfile

FROM workspace AS build-api
RUN --mount=type=cache,id=berry-turbo,target=/app/.turbo \
  corepack pnpm --filter @berry/api... build

FROM workspace AS build-worker
RUN --mount=type=cache,id=berry-turbo,target=/app/.turbo \
  corepack pnpm --filter @berry/worker... build

FROM workspace AS build-web
RUN --mount=type=cache,id=berry-turbo,target=/app/.turbo \
  corepack pnpm --filter @berry/web... build

FROM node:22-bookworm-slim AS runtime-base

WORKDIR /app
ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable

VOLUME ["/data"]
EXPOSE 3000 3108

FROM runtime-base AS api

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build-api /app /app

CMD ["node", "apps/api/dist/main.js"]

FROM runtime-base AS worker

COPY --from=build-worker /app /app

CMD ["node", "apps/worker/dist/main.js"]

FROM runtime-base AS web

COPY --from=build-web /app /app

CMD ["apps/web/node_modules/.bin/srvx", "--prod", "-s", "../client", "apps/web/dist/server/server.js"]
