CREATE TABLE IF NOT EXISTS user_sessions (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions (expire);

CREATE TABLE IF NOT EXISTS journal_entries (
  id uuid NOT NULL PRIMARY KEY,
  owner_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long', 'short')),
  entry_time text NOT NULL,
  entry_price text NOT NULL,
  exit_price text NOT NULL,
  profit_loss text NOT NULL,
  notes text NOT NULL DEFAULT '',
  confluences jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(confluences) = 'array'),
  screenshot_count integer NOT NULL DEFAULT 0 CHECK (screenshot_count BETWEEN 0 AND 20),
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_owner_created
  ON journal_entries (owner_id, created_at DESC);
