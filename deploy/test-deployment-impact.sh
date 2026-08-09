#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
. "$repo_dir/deploy/deployment-impact.sh"

assert_contains() {
  list="$1"
  value="$2"
  label="$3"
  case " $list " in
    *" $value "*) ;;
    *) echo "Expected $label to contain $value; got:$list" >&2; exit 1 ;;
  esac
}

assert_not_contains() {
  list="$1"
  value="$2"
  label="$3"
  case " $list " in
    *" $value "*) echo "Expected $label not to contain $value; got:$list" >&2; exit 1 ;;
    *) ;;
  esac
}

berry_impact_add_file "apps/web/src/routes/index.tsx"
assert_contains "$berry_image_services" web "web image services"
assert_contains "$berry_restart_services" web "web restart services"
assert_not_contains "$berry_image_services" api "web image services"
test "$berry_run_migrations" = false

berry_impact_reset
berry_impact_add_file "apps/desktop/src/globals.css"
assert_contains "$berry_image_services" web "shared desktop stylesheet image services"
assert_not_contains "$berry_image_services" api "shared desktop stylesheet image services"

berry_impact_reset
berry_impact_add_file "apps/api/src/tasks/task.service.ts"
assert_contains "$berry_image_services" api "API image services"
assert_contains "$berry_restart_services" api "API restart services"
assert_not_contains "$berry_image_services" worker "API image services"
test "$berry_run_migrations" = false
test "$berry_configure_roles" = false

berry_impact_reset
berry_impact_add_file "apps/api/src/db/cloud-database.service.ts"
test "$berry_run_migrations" = true
test "$berry_configure_roles" = false

berry_impact_reset
berry_impact_add_file "apps/api/src/db/pg-executor.ts"
test "$berry_run_migrations" = true
test "$berry_configure_roles" = true

berry_impact_reset
berry_impact_add_file "packages/db/src/index.ts"
assert_contains "$berry_image_services" api "database image services"
assert_not_contains "$berry_image_services" worker "database image services"
test "$berry_run_migrations" = true
test "$berry_configure_roles" = true

berry_impact_reset
berry_impact_add_file "packages/personal-memory/src/index.ts"
assert_contains "$berry_image_services" api "personal-memory image services"
assert_contains "$berry_image_services" worker "personal-memory image services"
assert_contains "$berry_image_services" mem0 "personal-memory image services"
assert_not_contains "$berry_image_services" web "personal-memory image services"

berry_impact_reset
berry_impact_add_file "packages/shared/src/index.ts"
for service in api worker mem0 web; do
  assert_contains "$berry_image_services" "$service" "shared image services"
done

berry_impact_reset
berry_impact_add_file "deploy/compose.yaml"
test "$berry_compose_changed" = true
test "$berry_run_migrations" = true
test "$berry_configure_roles" = true
for service in api worker mem0 web; do
  assert_contains "$berry_image_services" "$service" "Compose image services"
  assert_contains "$berry_restart_services" "$service" "Compose restart services"
done

berry_impact_reset
berry_impact_add_file "deploy/compose.aws.yaml"
test "$berry_compose_changed" = true
test "$berry_run_migrations" = true
test "$berry_configure_roles" = true
for service in api worker mem0 web; do
  assert_contains "$berry_image_services" "$service" "AWS Compose image services"
  assert_contains "$berry_restart_services" "$service" "AWS Compose restart services"
done

berry_impact_reset
berry_impact_add_file "deploy/.env.production.example"
test "$berry_compose_changed" = false
test -z "$berry_image_services"

berry_impact_reset
berry_impact_add_file "Dockerfile"
for service in api worker mem0 web; do
  assert_contains "$berry_image_services" "$service" "Dockerfile image services"
done

berry_impact_reset
berry_impact_add_file "deploy/Caddyfile"
test "$berry_caddy_changed" = true
test -z "$berry_image_services"

berry_impact_reset
berry_impact_add_file "deploy/Caddyfile.storage"
test "$berry_caddy_changed" = true
test -z "$berry_image_services"

berry_impact_reset
berry_impact_add_file "deploy/Caddyfile.native"
test "$berry_caddy_changed" = true
test -z "$berry_image_services"

berry_impact_reset
berry_impact_add_file "apps/desktop/src/main.ts"
test -z "$berry_image_services"
test -z "$berry_restart_services"

berry_impact_reset
berry_impact_add_file "packages/future-runtime/src/index.ts"
for service in api worker mem0 web; do
  assert_contains "$berry_image_services" "$service" "unknown runtime workspace image services"
  assert_contains "$berry_restart_services" "$service" "unknown runtime workspace restart services"
done

echo "[deploy] production change classification OK"
