-- Run with the synergy-mcp database owner, never with the web app's DATABASE_URL.
-- This reader exposes only completed shared research in the /workspace namespace.
-- It does not expose authentication, sessions, API keys, or collaboration records.
CREATE SCHEMA IF NOT EXISTS synergy_module_research;
REVOKE ALL ON SCHEMA synergy_module_research FROM PUBLIC;

CREATE OR REPLACE VIEW synergy_module_research.records WITH (security_barrier=true) AS
SELECT 'program'::text AS kind,p.id,p.name AS title,'Research program'::text AS source,p.created_at,
  p.champion_revision::text AS version,
  jsonb_build_object('name',p.name,'benchmark',p.benchmark::jsonb,'minimumTrades',p.minimum_trades,
    'championId',p.champion_id,'championRevision',p.champion_revision)::text AS body
FROM synergy_trading.programs p WHERE p.root='/workspace'
UNION ALL
SELECT 'strategy',s.id,s.name,p.name,s.created_at,s.content_hash,
  jsonb_build_object('name',s.name,'programId',p.id,'rules',s.rules,'parentId',s.parent_id,
    'isChampion',p.champion_id=s.id,'championRevision',p.champion_revision)::text
FROM synergy_trading.strategies s JOIN synergy_trading.programs p ON p.id=s.program_id WHERE p.root='/workspace'
UNION ALL
SELECT 'trade',t.id,t.external_id,p.name,t.created_at,t.version::text,
  jsonb_build_object('kind',t.kind,'programId',p.id,'strategyId',t.strategy_id,'payload',t.payload::jsonb,
    'close',t.close_payload::jsonb,'grossR',t.gross_r,'costR',t.cost_r,'version',t.version)::text
FROM synergy_trading.trades t JOIN synergy_trading.programs p ON p.id=t.program_id WHERE p.root='/workspace'
UNION ALL
SELECT 'evaluation',e.strategy_id,s.name,p.name,e.completed_at,e.payload_hash,
  jsonb_build_object('programId',p.id,'strategyId',s.id,'completion',e.payload::jsonb,'completedAt',e.completed_at)::text
FROM synergy_trading.evaluations e JOIN synergy_trading.programs p ON p.id=e.program_id
JOIN synergy_trading.strategies s ON s.id=e.strategy_id WHERE p.root='/workspace';

CREATE OR REPLACE VIEW synergy_module_research.artifacts WITH (security_barrier=true) AS
SELECT id,path,source,created_at,verified_sha256,received_bytes,payload::jsonb->>'mediaType' AS media_type
FROM synergy_archive.artifacts
WHERE root='/workspace' AND completed_at IS NOT NULL AND verified_sha256 IS NOT NULL
  AND path !~* '(^|/)(\.env($|\.)|[^/]*\.(pem|key|p12|pfx)$)';

CREATE OR REPLACE VIEW synergy_module_research.sources WITH (security_barrier=true) AS
SELECT 'artifact'::text AS kind,id,path AS title,source,created_at,verified_sha256 AS version,
  received_bytes AS byte_length,media_type FROM synergy_module_research.artifacts
UNION ALL
SELECT kind,id,title,source,created_at,version,octet_length(body)::bigint AS byte_length,
  'application/json'::text AS media_type FROM synergy_module_research.records;

CREATE OR REPLACE VIEW synergy_module_research.artifact_chunks WITH (security_barrier=true) AS
SELECT c.artifact_id,c.byte_offset,c.byte_length,c.content
FROM synergy_archive.artifact_chunks c JOIN synergy_module_research.artifacts a ON a.id=c.artifact_id;
