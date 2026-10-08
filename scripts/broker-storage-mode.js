import { pathToFileURL } from "node:url";
import pg from "pg";
import { assertMigrationAllowed } from "./migrate.js";
import { readDatabaseConfig } from "../src/config/database-config.js";

const collections = ["tools", "snapshots", "actions", "events"];

async function backfillNormalized(client) {
  // Temp staging is transaction-local and excludes no owners. On reactivation it
  // refreshes working sets from the latest legacy state while retaining archives.
  await client.query(`CREATE TEMP TABLE broker_cutover_records ON COMMIT DROP AS
    SELECT w.owner_id,c.kind,item.ordinality,
      CASE WHEN c.kind='tools' THEN item.payload->>'name'
        WHEN c.kind='events' THEN COALESCE(item.payload->>'id','legacy-'||md5(w.owner_id||':'||c.kind||':'||item.ordinality||':'||item.payload::text))
        ELSE item.payload->>'id' END AS id,
      CASE WHEN c.kind='events' AND item.payload->>'id' IS NULL
        THEN item.payload||jsonb_build_object('id','legacy-'||md5(w.owner_id||':'||c.kind||':'||item.ordinality||':'||item.payload::text))
        ELSE item.payload END AS payload
    FROM broker_workspaces w CROSS JOIN (VALUES('tools'),('snapshots'),('actions'),('events')) c(kind)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.payload->c.kind,'[]'::jsonb)) WITH ORDINALITY item(payload,ordinality)`);
  // A malformed legacy array must fail the whole transaction rather than lose data.
  await client.query(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM broker_cutover_records WHERE id IS NULL OR id='' OR length(id)>256 OR jsonb_typeof(payload)<>'object')
      OR EXISTS(SELECT 1 FROM broker_cutover_records GROUP BY owner_id,kind,id HAVING count(*)>1)
    THEN RAISE EXCEPTION 'Invalid or duplicate legacy broker record; repair before cutover'; END IF;
  END $$`);
  await client.query(`INSERT INTO broker_account_states(owner_id,payload,working_set)
    SELECT w.owner_id, jsonb_build_object('connection',NULL,'paused',true)||
      (w.payload-ARRAY['tools','snapshots','actions','events']),
      jsonb_build_object(${collections.map((kind) => `'${kind}',COALESCE((SELECT jsonb_agg(r.id ORDER BY r.ordinality) FROM broker_cutover_records r WHERE r.owner_id=w.owner_id AND r.kind='${kind}'),'[]'::jsonb)`).join(",")})
    FROM broker_workspaces w
    ON CONFLICT(owner_id) DO UPDATE SET payload=EXCLUDED.payload,working_set=EXCLUDED.working_set,updated_at=now()`);
  for (const kind of collections) {
    // In reverse array order, sequence order reflects oldest to newest on initial backfill.
    await client.query(`INSERT INTO broker_${kind}(owner_id,id,payload)
      SELECT owner_id,id,payload FROM broker_cutover_records WHERE kind=$1 ORDER BY owner_id,ordinality DESC
      ON CONFLICT(owner_id,id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()
      WHERE broker_${kind}.payload IS DISTINCT FROM EXCLUDED.payload`, [kind]);
    if (["tools", "snapshots"].includes(kind)) await client.query(`DELETE FROM broker_${kind} r
      WHERE EXISTS(SELECT 1 FROM broker_workspaces w WHERE w.owner_id=r.owner_id)
      AND NOT EXISTS(SELECT 1 FROM broker_cutover_records s WHERE s.owner_id=r.owner_id AND s.kind=$1 AND s.id=r.id)`, [kind]);
  }
}

async function rebuildLegacy(client) {
  // The guard sees this transaction's mode change. Other writers cannot enter
  // until the exclusive legacy-table lock is released at commit.
  await client.query("UPDATE broker_storage_control SET mode='legacy',updated_at=now() WHERE singleton=true");
  await client.query(`INSERT INTO broker_workspaces(owner_id,payload)
    SELECT s.owner_id,s.payload||jsonb_build_object(${collections.map((kind) => `'${kind}',COALESCE((SELECT jsonb_agg(r.payload ORDER BY wanted.ordinality)
      FROM jsonb_array_elements_text(s.working_set->'${kind}') WITH ORDINALITY wanted(id,ordinality)
      JOIN broker_${kind} r ON r.owner_id=s.owner_id AND r.id=wanted.id),'[]'::jsonb)`).join(",")})
    FROM broker_account_states s
    ON CONFLICT(owner_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`);
}

export async function setBrokerStorageMode(pool, mode) {
  if (!["legacy", "normalized"].includes(mode)) throw new Error("Choose legacy or normalized broker storage");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("LOCK TABLE broker_workspaces IN ACCESS EXCLUSIVE MODE");
    const { rows: [control] } = await client.query("SELECT mode FROM broker_storage_control WHERE singleton=true FOR UPDATE");
    if (!control) throw new Error("Run broker migration 007 before changing storage mode");
    if (control.mode !== mode) {
      if (mode === "normalized") {
        await backfillNormalized(client);
        await client.query("UPDATE broker_storage_control SET mode='normalized',updated_at=now() WHERE singleton=true");
      } else await rebuildLegacy(client);
    }
    await client.query("COMMIT");
    return { mode, changed: control.mode !== mode };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertMigrationAllowed();
    const config = readDatabaseConfig({ nodeEnvironment: "production" });
    const pool = new pg.Pool({ connectionString: config.connectionString,
      ssl: config.ssl ? { rejectUnauthorized: true } : undefined, max: 1, connectionTimeoutMillis: 5000,
      application_name: "synergy-module-broker-cutover" });
    try { console.log(JSON.stringify(await setBrokerStorageMode(pool, process.argv[2]))); }
    finally { await pool.end(); }
  } catch (error) { console.error(`Broker storage mode failed: ${error.message}`); process.exitCode = 1; }
}
