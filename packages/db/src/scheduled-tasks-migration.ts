export const SCHEDULED_TASKS_MIGRATION = `
CREATE TABLE scheduled_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 32000),
  schedule jsonb NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','completed')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  model_provider_id text,
  model text,
  reasoning text NOT NULL DEFAULT 'off' CHECK (reasoning IN ('off','low','medium','high','xhigh')),
  creation_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id,user_id,creation_key),
  CHECK (state <> 'active' OR next_run_at IS NOT NULL)
);
CREATE INDEX scheduled_tasks_owner_idx ON scheduled_tasks (tenant_id,user_id,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX scheduled_tasks_due_idx ON scheduled_tasks (tenant_id,next_run_at) WHERE state='active' AND deleted_at IS NULL;

CREATE TABLE scheduled_task_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  scheduled_at timestamptz NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('scheduled','manual')),
  occurrence_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dispatching','admitted','failed','skipped')),
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  turn_id uuid REFERENCES turn_runs(id) ON DELETE SET NULL,
  input jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  retry_at timestamptz NOT NULL DEFAULT now(),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id,schedule_id,occurrence_key)
);
CREATE INDEX scheduled_task_runs_history_idx ON scheduled_task_runs (tenant_id,schedule_id,created_at DESC,id DESC);
CREATE INDEX scheduled_task_runs_pending_idx ON scheduled_task_runs (tenant_id,retry_at,lease_expires_at) WHERE state IN ('pending','dispatching');

CREATE TABLE scheduled_task_operations (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,user_id,operation_id)
);
ALTER TABLE scheduled_task_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_task_operations_tenant_isolation ON scheduled_task_operations
  USING (tenant_id=berry_current_tenant_id()) WITH CHECK (tenant_id=berry_current_tenant_id());

ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_tasks_tenant_isolation ON scheduled_tasks
  USING (tenant_id=berry_current_tenant_id()) WITH CHECK (tenant_id=berry_current_tenant_id());
ALTER TABLE scheduled_task_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_task_runs_tenant_isolation ON scheduled_task_runs
  USING (tenant_id=berry_current_tenant_id()) WITH CHECK (tenant_id=berry_current_tenant_id());
`.trim();
