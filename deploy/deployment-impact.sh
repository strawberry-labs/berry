# Shared production change classifier. Keep this file POSIX-sh compatible: the
# production host sources it from deploy/server-deploy.sh.

berry_impact_reset() {
  berry_image_services=""
  berry_restart_services=""
  berry_run_migrations=false
  berry_configure_roles=false
  berry_compose_changed=false
  berry_caddy_changed=false
  berry_prometheus_changed=false
}

berry_add_image_service() {
  case " $berry_image_services " in
    *" $1 "*) ;;
    *) berry_image_services="$berry_image_services $1" ;;
  esac
}

berry_add_restart_service() {
  case " $berry_restart_services " in
    *" $1 "*) ;;
    *) berry_restart_services="$berry_restart_services $1" ;;
  esac
}

berry_mark_service() {
  berry_add_image_service "$1"
  berry_add_restart_service "$1"
}

berry_mark_worker_pools() {
  # Both process roles use the same image, but every worker code change must
  # recreate both services without building the image twice.
  berry_add_image_service worker
  berry_add_restart_service worker
  berry_add_restart_service worker-foreground
}

berry_impact_add_file() {
  case "$1" in
    package.json|pnpm-lock.yaml|pnpm-workspace.yaml|turbo.json|tsconfig.base.json|Dockerfile|.dockerignore)
      berry_mark_service api
      berry_mark_worker_pools
      berry_mark_service mem0
      berry_mark_service web
      ;;
    apps/web/*|apps/desktop/src/globals.css|packages/api-client/*|packages/desktop-ui/*|packages/thread-ui/*|scripts/prepare-web-build.mjs|scripts/verify-web-build-assets.mjs)
      berry_mark_service web
      ;;
    apps/api/src/migrate.ts|apps/api/src/db/cloud-database.service.ts)
      berry_mark_service api
      berry_run_migrations=true
      ;;
    apps/api/src/configure-service-roles.ts)
      berry_mark_service api
      berry_configure_roles=true
      ;;
    apps/api/src/db/pg-executor.ts)
      berry_mark_service api
      berry_run_migrations=true
      berry_configure_roles=true
      ;;
    apps/api/*)
      berry_mark_service api
      ;;
    packages/db/*)
      berry_mark_service api
      berry_run_migrations=true
      berry_configure_roles=true
      ;;
    packages/desktop-db/*|packages/local-agent/*|packages/execpolicy/*|packages/harness/*|packages/router-client/*|packages/sandbox-contract/*)
      berry_mark_service api
      berry_mark_worker_pools
      ;;
    apps/worker/*)
      berry_mark_worker_pools
      ;;
    apps/mem0/*)
      berry_mark_service mem0
      ;;
    packages/personal-memory/*)
      berry_mark_service api
      berry_mark_worker_pools
      berry_mark_service mem0
      ;;
    packages/shared/*)
      berry_mark_service api
      berry_mark_worker_pools
      berry_mark_service mem0
      berry_mark_service web
      ;;
    deploy/compose.yaml|deploy/compose.aws.yaml)
      berry_mark_service api
      berry_mark_worker_pools
      berry_mark_service mem0
      berry_mark_service web
      berry_add_restart_service alertmanager
      berry_add_restart_service prometheus
      berry_run_migrations=true
      berry_configure_roles=true
      berry_compose_changed=true
      berry_prometheus_changed=true
      ;;
    deploy/prometheus/*|deploy/production-runtime-alerts.yaml)
      berry_add_restart_service alertmanager
      berry_add_restart_service prometheus
      berry_prometheus_changed=true
      ;;
    deploy/Caddyfile|deploy/Caddyfile.storage|deploy/Caddyfile.native)
      berry_caddy_changed=true
      ;;
    apps/cli/*|apps/docs/*|apps/desktop/*|apps/extension/*|apps/mobile/*|packages/acp-adapter/*|packages/cli-npm/*|packages/host/*|packages/local-agent-protocol/*)
      # These workspaces are outside the production web deployment path. The
      # shared desktop stylesheet is matched by the web rule above.
      ;;
    apps/*|packages/*)
      # Fail closed for a new or renamed runtime workspace. Until its precise
      # service impact is classified, rebuild every production application so
      # a deploy can never record a commit while serving stale code.
      berry_mark_service api
      berry_mark_worker_pools
      berry_mark_service mem0
      berry_mark_service web
      ;;
  esac
}

berry_impact_reset
