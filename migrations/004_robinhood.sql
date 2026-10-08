-- Tokens in payload.connection.sealed are encrypted by the application before insertion.
CREATE TABLE IF NOT EXISTS broker_workspaces (
  owner_id text PRIMARY KEY,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
