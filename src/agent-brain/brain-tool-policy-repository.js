import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const encode = value => {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 200000) throw new Error("Tool policy storage limit exceeded");
  return json;
};
export function createMemoryBrainToolPolicyRepository() {
  let state = null;
  return { async read() { return structuredClone(state); }, async update(change) {
    state = JSON.parse(encode(change(structuredClone(state)))); return structuredClone(state);
  }, async close() {} };
}
export function createSqliteBrainToolPolicyRepository(filename) {
  mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS brain_tool_policy(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)");
  const read = () => { const row = db.prepare("SELECT payload FROM brain_tool_policy WHERE id=1").get(); return row ? JSON.parse(row.payload) : null; };
  return { async read() { return read(); }, async update(change) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const next = change(read());
      db.prepare("INSERT INTO brain_tool_policy(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(encode(next));
      db.exec("COMMIT"); return structuredClone(next);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }, async close() { db.close(); } };
}
export function createPostgresBrainToolPolicyRepository(pool) {
  return { async read() { return (await pool.query("SELECT payload FROM brain_tool_policy WHERE id=1")).rows[0]?.payload ?? null; },
    async update(change) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(1869440357, 8)");
        const previous = (await client.query("SELECT payload FROM brain_tool_policy WHERE id=1 FOR UPDATE")).rows[0]?.payload ?? null;
        const next = change(previous);
        await client.query("INSERT INTO brain_tool_policy(id,payload) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload", [encode(next)]);
        await client.query("COMMIT"); return structuredClone(next);
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
    }, async close() {} };
}
