#!/usr/bin/env sh
set -eu

repo_dir="${BERRY_DEPLOY_REPO_DIR:-/opt/berry}"
env_file="$repo_dir/deploy/.env.production"
requested_ref="${1:-origin/main}"
expected_domain="${BERRY_DEPLOY_EXPECTED_DOMAIN:-}"
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

domain="$(sed -n 's/^BERRY_DOMAIN=//p' "$env_file" | tail -n 1)"
if [ -z "$domain" ]; then
  echo "BERRY_DOMAIN is missing from $env_file." >&2
  exit 1
fi
if [ -n "$expected_domain" ] && [ "$domain" != "$expected_domain" ]; then
  echo "Refusing deployment because the host domain does not match BERRY_DEPLOY_EXPECTED_DOMAIN." >&2
  exit 1
fi

max_sandbox_ttl_seconds=300
sandbox_ttl_seconds="$(sed -n 's/^BERRY_SANDBOX_TTL_SECONDS=//p' "$env_file" | tail -n 1)"
case "$sandbox_ttl_seconds" in
  ''|*[!0-9]*)
    echo "BERRY_SANDBOX_TTL_SECONDS must be an integer between 1 and $max_sandbox_ttl_seconds in $env_file." >&2
    exit 1
    ;;
esac
if [ "$sandbox_ttl_seconds" -lt 1 ] || [ "$sandbox_ttl_seconds" -gt "$max_sandbox_ttl_seconds" ]; then
  echo "BERRY_SANDBOX_TTL_SECONDS must be between 1 and $max_sandbox_ttl_seconds in $env_file; found $sandbox_ttl_seconds." >&2
  echo "Back up the file and change only BERRY_SANDBOX_TTL_SECONDS. Deployment automation will not replace the production environment file." >&2
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
if ! git merge-base --is-ancestor "$target_ref" origin/main; then
  echo "Refusing to deploy a commit that is not reachable from origin/main." >&2
  exit 1
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
export BERRY_BUILD_REVISION="$target_ref"

storage_mode="$(sed -n 's/^BERRY_OBJECT_STORAGE_MODE=//p' "$env_file" | tail -n 1)"
background_worker_replicas="$(sed -n 's/^BERRY_BACKGROUND_WORKER_REPLICAS=//p' "$env_file" | tail -n 1)"
foreground_worker_replicas="$(sed -n 's/^BERRY_FOREGROUND_WORKER_REPLICAS=//p' "$env_file" | tail -n 1)"
background_worker_replicas="${background_worker_replicas:-1}"
foreground_worker_replicas="${foreground_worker_replicas:-5}"
case "$background_worker_replicas:$foreground_worker_replicas" in
  *[!0-9:]*|0:*|*:0)
    echo "Worker replica counts must be positive integers in $env_file." >&2
    exit 1
    ;;
esac
worker_scale_args="--scale worker=$background_worker_replicas --scale worker-foreground=$foreground_worker_replicas"
if [ "$storage_mode" = "aws" ]; then
  export BERRY_STORAGE_PROXY_IMPORT='/etc/caddy/storage/native/*.caddy'
  berry_runtime_services="caddy embeddings mem0 tika redis api worker worker-foreground alertmanager prometheus web"
  berry_initialize_minio=false
  compose() {
    docker compose --env-file "$env_file" -f deploy/compose.yaml -f deploy/compose.aws.yaml "$@"
  }
elif [ "$storage_mode" = "r2" ]; then
  export BERRY_STORAGE_PROXY_IMPORT='/etc/caddy/storage/native/*.caddy'
  berry_runtime_services="caddy postgres mem0-postgres embeddings mem0 tika redis api worker worker-foreground alertmanager prometheus web"
  berry_initialize_minio=false
  compose() {
    docker compose --env-file "$env_file" -f deploy/compose.yaml "$@"
  }
else
  export BERRY_STORAGE_PROXY_IMPORT='/etc/caddy/storage/minio/*.caddy'
  berry_runtime_services="caddy postgres mem0-postgres embeddings mem0 tika redis minio api worker worker-foreground alertmanager prometheus web"
  berry_initialize_minio=true
  compose() {
    docker compose --profile minio --env-file "$env_file" -f deploy/compose.yaml "$@"
  }
fi

. "$repo_dir/deploy/deployment-impact.sh"
previous_ifs="$IFS"
IFS='
'
for file in $changed_files; do
  berry_impact_add_file "$file"
done
IFS="$previous_ifs"

compose config --quiet

if [ -n "$berry_image_services" ]; then
  echo "Building affected services:$berry_image_services"
  DOCKER_BUILDKIT=1 compose build $berry_image_services
fi
if [ "$berry_prometheus_changed" = true ]; then
  compose pull alertmanager prometheus
fi

if [ "$berry_run_migrations" = true ]; then
  echo "Running database migrations..."
  compose run --rm --no-deps db-migrate
fi
if [ "$berry_configure_roles" = true ]; then
  echo "Configuring least-privilege database roles..."
  compose run --rm --no-deps postgres-roles
fi

worker_scale_reconciled=false
berry_non_monitoring_restart_services=""
for service in $berry_restart_services; do
  case "$service" in
    alertmanager|prometheus) ;;
    *) berry_non_monitoring_restart_services="$berry_non_monitoring_restart_services $service" ;;
  esac
done
if [ "$berry_compose_changed" = true ]; then
  # Wait only for long-running services. Compose reports a successful one-shot
  # container such as minio-init as an error under `up --wait`, and following
  # API dependencies here would also run migrations and role setup twice.
  compose up -d --no-deps --no-build --pull never --remove-orphans --wait --wait-timeout 120 $worker_scale_args $berry_runtime_services
  worker_scale_reconciled=true
  if [ "$berry_initialize_minio" = true ]; then
    compose run --rm --no-deps minio-init
  fi
elif [ -n "$berry_non_monitoring_restart_services" ]; then
  echo "Restarting affected services:$berry_restart_services"
  case " $berry_non_monitoring_restart_services " in
    *" worker "*|*" worker-foreground "*)
      compose up -d --no-build --pull never --no-deps --wait --wait-timeout 120 $worker_scale_args $berry_non_monitoring_restart_services
      worker_scale_reconciled=true
      ;;
    *)
      compose up -d --no-build --pull never --no-deps --wait --wait-timeout 120 $berry_non_monitoring_restart_services
      ;;
  esac
fi
if [ "$berry_caddy_changed" = true ] && [ "$berry_compose_changed" = false ]; then
  compose up -d --no-build --pull never --force-recreate --no-deps --wait --wait-timeout 120 caddy
fi
if [ "$berry_prometheus_changed" = true ] && [ "$berry_compose_changed" = false ]; then
  compose up -d --no-build --pull never --force-recreate --no-deps --wait --wait-timeout 120 alertmanager prometheus
fi
if [ "$worker_scale_reconciled" = false ]; then
  # Reassert capacity on every revision without recreating healthy workers.
  # This repairs manual scale drift and prevents an unrelated deployment from
  # silently leaving the foreground pool below its configured replica count.
  compose up -d --no-build --pull never --no-deps --wait --wait-timeout 120 \
    $worker_scale_args worker worker-foreground
fi

attempt=1
while [ "$attempt" -le 18 ]; do
  if curl -fsS "https://$domain/healthz" >/dev/null 2>&1 \
    && curl -fsS "https://$domain/" >/dev/null 2>&1; then
    printf '%s\n' "$target_ref" > .deployment-commit
    elapsed="$(( $(date +%s) - started_at ))"
    echo "Deployed $target_ref in ${elapsed}s: ${berry_restart_services:-configuration only}"
    exit 0
  fi
  sleep 5
  attempt="$((attempt + 1))"
done

compose ps
echo "Production health check failed after deployment." >&2
exit 1
