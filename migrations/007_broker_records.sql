-- Additive migration. Existing application instances keep using the legacy table
-- until the explicit broker-storage-mode cutover runs after all writers upgrade.
CREATE TABLE IF NOT EXISTS broker_storage_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy', 'normalized')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO broker_storage_control(singleton) VALUES(true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS broker_account_states (
  owner_id text PRIMARY KEY,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  working_set jsonb NOT NULL CHECK (jsonb_typeof(working_set)='object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(working_set->'tools')='array' AND jsonb_array_length(working_set->'tools')<=128),
  CHECK (jsonb_typeof(working_set->'snapshots')='array' AND jsonb_array_length(working_set->'snapshots')<=12),
  CHECK (jsonb_typeof(working_set->'actions')='array' AND jsonb_array_length(working_set->'actions')<=120),
  CHECK (jsonb_typeof(working_set->'events')='array' AND jsonb_array_length(working_set->'events')<=200)
);
CREATE TABLE IF NOT EXISTS broker_tools (
  owner_id text NOT NULL REFERENCES broker_account_states(owner_id) ON DELETE CASCADE,
  id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,id)
);
CREATE TABLE IF NOT EXISTS broker_snapshots (
  owner_id text NOT NULL REFERENCES broker_account_states(owner_id) ON DELETE CASCADE,
  id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,id)
);
CREATE TABLE IF NOT EXISTS broker_actions (
  owner_id text NOT NULL REFERENCES broker_account_states(owner_id) ON DELETE CASCADE,
  id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  record_sequence bigint GENERATED ALWAYS AS IDENTITY,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,id)
);
CREATE INDEX IF NOT EXISTS idx_broker_actions_owner_history ON broker_actions(owner_id,record_sequence DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_broker_actions_owner_request
  ON broker_actions(owner_id,(payload->>'requestId')) WHERE payload->>'requestId' IS NOT NULL;
CREATE TABLE IF NOT EXISTS broker_events (
  owner_id text NOT NULL REFERENCES broker_account_states(owner_id) ON DELETE CASCADE,
  id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  record_sequence bigint GENERATED ALWAYS AS IDENTITY,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,id)
);
CREATE INDEX IF NOT EXISTS idx_broker_events_owner_history ON broker_events(owner_id,record_sequence DESC);

-- Guard old binaries only AFTER explicit cutover. Locking the control row makes
-- this fail closed even if an old writer's statement started during cutover.
CREATE OR REPLACE FUNCTION guard_legacy_broker_writes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE storage_mode text;
BEGIN
  SELECT mode INTO storage_mode FROM broker_storage_control WHERE singleton=true FOR SHARE;
  IF storage_mode IS DISTINCT FROM 'legacy' THEN
    RAISE EXCEPTION 'Broker storage uses normalized records; upgrade this application instance'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS broker_legacy_write_guard ON broker_workspaces;
CREATE TRIGGER broker_legacy_write_guard BEFORE INSERT OR UPDATE ON broker_workspaces
  FOR EACH ROW EXECUTE FUNCTION guard_legacy_broker_writes();
