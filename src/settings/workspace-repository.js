import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const empty = () => ({ providers: {}, preferences: {}, drafts: {}, updatedAt: null });
const ownerKey = (owner) => {
  if (typeof owner !== "string" || !owner.trim() || owner.length > 200) throw new Error("Workspace owner is required");
  return owner;
};
const encode = (state) => {
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json) > 250_000) throw new Error("Workspace storage limit reached");
  return json;
};
const changeState = (state, change) => {
  const result = change(state);
  if (result?.then) throw new Error("Workspace transactions must be synchronous");
  return result;
};

export function createMemoryWorkspaceRepository() {
  const owners = new Map();
  return {
    getStorageStatus: () => ({ kind: "memory", persistent: false }),
    async read(owner) { return structuredClone(owners.get(ownerKey(owner)) ?? empty()); },
    async update(owner, change) {
      const state = structuredClone(owners.get(ownerKey(owner)) ?? empty());
      const result = changeState(state, change);
      owners.set(owner, JSON.parse(encode(state)));
      return structuredClone(result);
    },
    async close() {},
  };
}

export function createSqliteWorkspaceRepository(filename) {
  mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS user_workspaces(owner_id TEXT PRIMARY KEY,payload TEXT NOT NULL)");
  const read = (owner) => JSON.parse(db.prepare("SELECT payload FROM user_workspaces WHERE owner_id=?").get(ownerKey(owner))?.payload ?? JSON.stringify(empty()));
  return {
    getStorageStatus: () => ({ kind: "sqlite", persistent: filename !== ":memory:" }),
    async read(owner) { return read(owner); },
    async update(owner, change) {
      ownerKey(owner);
      db.exec("BEGIN IMMEDIATE");
      try {
        const state = read(owner);
        const result = changeState(state, change);
        db.prepare("INSERT INTO user_workspaces(owner_id,payload) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET payload=excluded.payload").run(owner, encode(state));
        db.exec("COMMIT");
        return structuredClone(result);
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async close() { db.close(); },
  };
}

export function createPostgresWorkspaceRepository(pool) {
  return {
    getStorageStatus: () => ({ kind: "postgres", persistent: true }),
    async read(owner) { return (await pool.query("SELECT payload FROM user_workspaces WHERE owner_id=$1", [ownerKey(owner)])).rows[0]?.payload ?? empty(); },
    async update(owner, change) {
      ownerKey(owner);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout='5s'");
        await client.query("INSERT INTO user_workspaces(owner_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING", [owner, JSON.stringify(empty())]);
        const state = (await client.query("SELECT payload FROM user_workspaces WHERE owner_id=$1 FOR UPDATE", [owner])).rows[0].payload;
        const result = changeState(state, change);
        await client.query("UPDATE user_workspaces SET payload=$2,updated_at=now() WHERE owner_id=$1", [owner, encode(state)]);
        await client.query("COMMIT");
        return structuredClone(result);
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async close() {},
  };
}
