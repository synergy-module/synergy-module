CREATE TABLE IF NOT EXISTS agent_brain_runs (
  owner_id text NOT NULL,
  id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_brain_runs_owner_updated
  ON agent_brain_runs (owner_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_brain_runs_one_running_per_owner
  ON agent_brain_runs (owner_id) WHERE payload->>'status' = 'running';

CREATE TABLE IF NOT EXISTS agent_brain_documents (
  owner_id text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, id)
);

CREATE TABLE IF NOT EXISTS agent_brain_cache (
  owner_id text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_brain_cache_owner_expiry
  ON agent_brain_cache (owner_id, expires_at);
