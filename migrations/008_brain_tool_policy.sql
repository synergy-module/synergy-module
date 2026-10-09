-- Site-wide admin-controlled tool assignments, separate from operator data.
CREATE TABLE IF NOT EXISTS brain_tool_policy (
  id integer PRIMARY KEY CHECK (id = 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);
