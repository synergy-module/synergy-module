CREATE TABLE IF NOT EXISTS app_users (
  user_id text PRIMARY KEY,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS app_bans (
  user_id text PRIMARY KEY,
  actor_id text NOT NULL,
  reason text NOT NULL DEFAULT '',
  banned_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS indicator_requests (
  user_id text PRIMARY KEY,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS revoked_user_sessions (
  sid text PRIMARY KEY,
  revoked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_operator
  ON user_sessions ((sess->'operator'->>'id'));
