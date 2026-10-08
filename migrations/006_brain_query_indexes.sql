-- Additive indexes for bounded, tenant-scoped reads. Existing run/document
-- payloads and timestamps are preserved. Writes continue using the owner lock.
CREATE INDEX IF NOT EXISTS idx_agent_brain_runs_owner_page
  ON agent_brain_runs (owner_id, updated_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS idx_agent_brain_runs_owner_active
  ON agent_brain_runs (owner_id)
  WHERE payload->>'status' IN ('running', 'awaiting_approval', 'approving');

CREATE INDEX IF NOT EXISTS idx_agent_brain_documents_owner_page
  ON agent_brain_documents (owner_id, updated_at DESC, id ASC);

-- Explicit configuration makes this expression immutable and independent of
-- the session's default text-search language. No extension/model is required.
CREATE INDEX IF NOT EXISTS idx_agent_brain_documents_search
  ON agent_brain_documents USING gin (
    to_tsvector('simple', coalesce(payload->>'title', '') || ' ' || coalesce(payload->>'text', ''))
  );

CREATE INDEX IF NOT EXISTS idx_agent_brain_cache_owner_page
  ON agent_brain_cache (owner_id, updated_at DESC, id ASC);
