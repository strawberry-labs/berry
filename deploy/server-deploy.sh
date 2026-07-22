#!/usr/bin/env sh
set -eu

repo_dir="${BERRY_DEPLOY_REPO_DIR:-/opt/berry}"
env_file="$repo_dir/deploy/.env.production"
requested_ref="${1:-origin/main}"
lock_dir="/tmp/berry-production-deploy.lock"

if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "Another Berry deployment is already running." >&2
  exit 1
fi
trap 'rmdir "$lock_dir"' EXIT INT TERM

if [ ! -d "$repo_dir/.git" ]; then
  echo "$repo_dir is not a Git checkout." >&2
  exit 1
fi
if [ ! -f "$env_file" ]; then
  echo "Missing production environment file: $env_file" >&2
  exit 1
fi

cd "$repo_dir"
started_at="$(date +%s)"

git fetch --prune origin main
if [ "$requested_ref" = "origin/main" ]; then
  target_ref="$(git rev-parse origin/main)"
else
  case "$requested_ref" in
    *[!0-9a-f]*|'')
      echo "Deployment ref must be a full lowercase Git commit SHA." >&2
      exit 1
      ;;
  esac
  if [ "${#requested_ref}" -ne 40 ]; then
    echo "Deployment ref must be a 40-character Git commit SHA." >&2
    exit 1
  fi
  target_ref="$requested_ref"
  git cat-file -e "$target_ref^{commit}"
fi

deployed_ref="$(sed -n '1p' .deployment-commit 2>/dev/null || true)"
case "$deployed_ref" in
  *[!0-9a-f]*|'') deployed_ref="$(git rev-parse HEAD)" ;;
esac

if [ "$deployed_ref" = "$target_ref" ]; then
  echo "Production already runs $target_ref."
  exit 0
fi

if ! git merge-base --is-ancestor "$deployed_ref" "$target_ref"; then
  echo "Refusing a non-fast-forward production deployment." >&2
  exit 1
fi

changed_files="$(git diff --name-only "$deployed_ref" "$target_ref")"
git reset --hard "$target_ref"

if grep -q '^BERRY_OBJECT_STORAGE_MODE=r2$' "$env_file"; then
  compose() {
    docker compose --env-file "$env_file" -f deploy/compose.yaml "$@"
  }
else
  compose() {
    docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml "$@"
  }
fi

services=""
add_service() {
  case " $services " in
    *" $1 "*) ;;
    *) services="$services $1" ;;
  esac
}

compose_changed=false
caddy_changed=false

for file in $changed_files; do
  case "$file" in
    package.json|pnpm-lock.yaml|pnpm-workspace.yaml|turbo.json|tsconfig.base.json|Dockerfile|.dockerignore)
      add_service web
      add_service api
      add_service worker
      ;;
    apps/web/*|packages/api-client/*|packages/desktop-ui/*|packages/thread-ui/*|scripts/prepare-web-build.mjs|scripts/verify-web-build-assets.mjs)
      add_service web
      ;;
    apps/api/*|packages/db/*|packages/desktop-db/*|packages/local-agent/*|packages/execpolicy/*|packages/harness/*|packages/router-client/*|packages/sandbox-contract/*)
      add_service api
      ;;
    apps/worker/*)
      add_service worker
      ;;
    packages/shared/*)
      add_service web
      add_service api
      add_service worker
      ;;
    deploy/compose.yaml|deploy/.env.production.example)
      compose_changed=true
      ;;
    deploy/Caddyfile)
      caddy_changed=true
      ;;
  esac
done

compose config --quiet

for service in $services; do
  echo "Building $service..."
  DOCKER_BUILDKIT=1 compose build "$service"
done

for service in $services; do
  echo "Restarting $service..."
  compose up -d --no-deps "$service"
done

if [ "$compose_changed" = true ]; then
  compose up -d --no-build --remove-orphans
fi
if [ "$caddy_changed" = true ]; then
  compose up -d --force-recreate --no-deps caddy
fi

domain="$(sed -n 's/^BERRY_DOMAIN=//p' "$env_file" | tail -n 1)"
attempt=1
while [ "$attempt" -le 18 ]; do
  if curl -fsS "https://$domain/healthz" >/dev/null 2>&1; then
    printf '%s\n' "$target_ref" > .deployment-commit
    elapsed="$(( $(date +%s) - started_at ))"
    echo "Deployed $target_ref in ${elapsed}s: ${services:-configuration only}"
    exit 0
  fi
  sleep 5
  attempt="$((attempt + 1))"
done

compose ps
echo "Production health check failed after deployment." >&2
exit 1
