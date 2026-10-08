-- Provider API credentials inside the payload are sealed with AES-256-GCM.
CREATE TABLE IF NOT EXISTS user_workspaces (
  owner_id text PRIMARY KEY,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
