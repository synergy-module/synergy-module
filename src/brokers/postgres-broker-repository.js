import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const collections = Object.freeze({
  tools: { table: "broker_tools", key: "name", limit: 128, retain: false },
  snapshots: { table: "broker_snapshots", key: "id", limit: 12, retain: false },
  actions: { table: "broker_actions", key: "id", limit: 120, retain: true },
  events: { table: "broker_events", key: "id", limit: 200, retain: true },
});
const names = Object.keys(collections);
const emptyWorkingSet = Object.fromEntries(names.map((name) => [name, []]));

// One statement gives readers a consistent snapshot without taking a write lock.
// Only IDs in the bounded working set are joined; archived actions/events are not loaded.
const normalizedWorkspaceSql = `SELECT s.payload AS metadata, ${names.map((name) => {
  const { table } = collections[name];
  return `COALESCE((SELECT json_agg(r.payload ORDER BY wanted.ordinality)
    FROM jsonb_array_elements_text(s.working_set->'${name}') WITH ORDINALITY wanted(id, ordinality)
    JOIN ${table} r ON r.owner_id=s.owner_id AND r.id=wanted.id), '[]'::json) AS ${name}`;
}).join(",")}, NULL::jsonb AS legacy FROM broker_account_states s WHERE s.owner_id=$1`;
const readWorkspaceSql = `WITH storage_mode AS MATERIALIZED (
    SELECT mode FROM broker_storage_control WHERE singleton=true
  ) ${normalizedWorkspaceSql} AND (SELECT mode FROM storage_mode)='normalized'
  UNION ALL SELECT NULL::jsonb AS metadata, ${names.map((name) => `NULL::json AS ${name}`).join(",")}, payload AS legacy
  FROM broker_workspaces WHERE owner_id=$1 AND (SELECT mode FROM storage_mode)='legacy'`;

function workspaceFromRow(row, empty) {
  if (!row) return empty();
  if (row.legacy !== null) return row.legacy;
  // Separate JSON columns avoid repeatedly copying a large binary JSON object
  // inside PostgreSQL. Each array retains its exact working-set order.
  return { ...row.metadata, ...Object.fromEntries(names.map((name) => [name, row[name]])) };
}

// Reuse parsing/plans on each pooled connection without caching mutable broker
// state or its storage mode. Every execution still gets a fresh MVCC snapshot.
const prepared = (client, name, text, values) => client.query({ name: `synergy-module-broker-${name}-v2`, text, values });

function splitWorkspace(state) {
  const metadata = { ...state }, workingSet = {}, records = {};
  for (const [name, config] of Object.entries(collections)) {
    const rows = state[name];
    if (!Array.isArray(rows) || rows.length > config.limit) throw new Error(`Broker ${name} working set exceeds its limit`);
    records[name] = new Map();
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Invalid broker ${name} record`);
      // Older fixtures/events did not carry an ID. Give them one once, before persistence.
      if (name === "events" && !row.id) row.id = randomUUID();
      const id = row[config.key];
      if (typeof id !== "string" || !id || id.length > 256 || records[name].has(id)) throw new Error(`Invalid or duplicate broker ${name} identity`);
      records[name].set(id, row);
    }
    workingSet[name] = [...records[name].keys()];
    delete metadata[name];
  }
  return { metadata, workingSet, records };
}

async function persistChanges(client, owner, before, after) {
  for (const [name, { table, retain }] of Object.entries(collections)) {
    const changed = [...after.records[name]].filter(([id, payload]) => !isDeepStrictEqual(before.records[name].get(id), payload))
      .map(([id, payload]) => ({ id, payload }));
    if (changed.length) {
      await prepared(client, `write-${name}`, `INSERT INTO ${table}(owner_id,id,payload)
        SELECT $1, item.id, item.payload FROM jsonb_to_recordset($2::jsonb) item(id text,payload jsonb)
        ON CONFLICT(owner_id,id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()
        WHERE ${table}.payload IS DISTINCT FROM EXCLUDED.payload`, [owner, JSON.stringify(changed)]);
    }
    // Tools and snapshots are replaceable. Action and event records remain durable
    // after leaving the UI's working set, including their request-id uniqueness.
    if (!retain) {
      const removed = [...before.records[name].keys()].filter((id) => !after.records[name].has(id));
      if (removed.length) await prepared(client, `delete-${name}`, `DELETE FROM ${table} WHERE owner_id=$1 AND id=ANY($2::text[])`, [owner, removed]);
    }
  }
  if (!isDeepStrictEqual(before.metadata, after.metadata) || !isDeepStrictEqual(before.workingSet, after.workingSet)) {
    await prepared(client, "write-state", "UPDATE broker_account_states SET payload=$2,working_set=$3,updated_at=now() WHERE owner_id=$1",
      [owner, JSON.stringify(after.metadata), JSON.stringify(after.workingSet)]);
  }
}

export function createNormalizedPostgresBrokerRepository(pool, { empty, validOwner, encode }) {
  const read = async (client, owner) => workspaceFromRow((await prepared(client, "read-workspace", readWorkspaceSql, [owner])).rows[0], empty);
  return {
    getStorageStatus: () => ({ kind: "postgres", persistent: true }),
    async read(owner) { return read(pool, validOwner(owner)); },
    async update(owner, change) {
      validOwner(owner);
      const client = await pool.connect();
      try {
        // Use the same lock order as cutover: legacy relation, then mode row.
        // It prevents an in-flight writer from choosing a stale storage mode.
        // These fixed, non-parameterized setup statements share one round trip.
        const setup = await client.query("BEGIN; SET LOCAL statement_timeout='5s'; LOCK TABLE broker_workspaces IN ROW EXCLUSIVE MODE; SELECT mode FROM broker_storage_control WHERE singleton=true FOR SHARE");
        const control = setup.at(-1).rows[0];
        if (!control) throw new Error("Broker storage migration is incomplete");
        if (control.mode === "legacy") {
          await client.query("INSERT INTO broker_workspaces(owner_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING", [owner, JSON.stringify(empty())]);
          const state = (await client.query("SELECT payload FROM broker_workspaces WHERE owner_id=$1 FOR UPDATE", [owner])).rows[0].payload;
          const result = change(state);
          if (result?.then) throw new Error("Broker transactions cannot contain asynchronous work");
          await client.query("UPDATE broker_workspaces SET payload=$2,updated_at=now() WHERE owner_id=$1", [owner, encode(state)]);
          await client.query("COMMIT");
          return structuredClone(result);
        }
        // Lock only the compact owner row. This also serializes creation across processes.
        const lockSql = "SELECT owner_id FROM broker_account_states WHERE owner_id=$1 FOR UPDATE";
        const locked = await prepared(client, "lock-owner", lockSql, [owner]);
        if (!locked.rows.length) {
          const initial = splitWorkspace(empty());
          await prepared(client, "create-state", "INSERT INTO broker_account_states(owner_id,payload,working_set) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [owner, JSON.stringify(initial.metadata), JSON.stringify(emptyWorkingSet)]);
          await prepared(client, "lock-owner", lockSql, [owner]);
        }
        // Read in a new statement AFTER acquiring the owner lock, so a writer
        // that we waited on cannot leave us with an older collection snapshot.
        const state = workspaceFromRow((await prepared(client, "read-normalized", normalizedWorkspaceSql, [owner])).rows[0], empty);
        const before = splitWorkspace(structuredClone(state));
        const result = change(state);
        if (result?.then) throw new Error("Broker transactions cannot contain asynchronous work");
        const after = splitWorkspace(state);
        encode(state); // Preserve the existing bounded public workspace contract.
        for (const [id, action] of before.records.actions) {
          if (["submitting", "unknown"].includes(action.status) && !after.records.actions.has(id)) {
            throw new Error("Unresolved broker actions cannot leave the working set");
          }
        }
        await persistChanges(client, owner, before, after);
        await client.query("COMMIT");
        return structuredClone(result);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (error.code === "23505" && error.constraint === "idx_broker_actions_owner_request") {
          throw Object.assign(new Error("This broker request identifier was already used. Check its saved action before submitting again."), { code: "ROBINHOOD_CONFLICT", status: 409, statusCode: 409 });
        }
        throw error;
      } finally { client.release(); }
    },
    async close() {},
  };
}
