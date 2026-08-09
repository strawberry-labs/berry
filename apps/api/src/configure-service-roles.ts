import { pathToFileURL } from "node:url";
import { PgSqlExecutor } from "./db/pg-executor.js";

export async function configureServiceRoles(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const databaseUrl = env.BERRY_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("BERRY_DATABASE_URL or DATABASE_URL is required");
  const passwords = {
    berry_api: required(env, "BERRY_API_DATABASE_PASSWORD"),
    berry_worker: required(env, "BERRY_WORKER_DATABASE_PASSWORD"),
    berry_platform: required(env, "BERRY_PLATFORM_DATABASE_PASSWORD"),
  } as const;
  const executor = PgSqlExecutor.fromConnectionString(databaseUrl);
  try {
    await executor.execute(`
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'berry_api') THEN CREATE ROLE berry_api; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'berry_worker') THEN CREATE ROLE berry_worker; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'berry_platform') THEN CREATE ROLE berry_platform; END IF;
END
$$
    `.trim());
    for (const [role, password] of Object.entries(passwords)) {
      const rows = await executor.query<{ statement: string }>(
        `SELECT format(
          'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
          $1::text,
          $2::text
        ) AS statement`,
        [role, password],
      );
      await executor.execute(rows[0]!.statement);
    }
    const database = await executor.query<{ name: string }>("SELECT current_database() AS name");
    await executor.execute(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database[0]!.name)} TO berry_api, berry_worker, berry_platform`);
    await executor.execute(`
GRANT USAGE ON SCHEMA public TO berry_api, berry_worker, berry_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO berry_api, berry_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO berry_api, berry_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO berry_api, berry_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO berry_api, berry_worker;

REVOKE ALL ON platform_rollout_rules, platform_operator_audit_events
  FROM berry_api, berry_worker;
GRANT SELECT ON tenants, tenant_memberships, tenant_hostnames, usage_events,
  billing_credit_grants, billing_invoices, billing_meter_events,
  platform_rollout_rules, platform_operator_audit_events TO berry_platform;
GRANT INSERT, UPDATE ON tenants, platform_rollout_rules TO berry_platform;
GRANT INSERT ON platform_operator_audit_events TO berry_platform;

REVOKE ALL ON FUNCTION berry_set_tenant_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION berry_set_tenant_id(uuid) TO berry_api, berry_worker;
    `.trim());
  } finally {
    await executor.close();
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await configureServiceRoles();
}
