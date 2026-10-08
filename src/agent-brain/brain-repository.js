import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const CAPACITY = 100;
const SEARCH_CANDIDATES = 64;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "canceled", "rejected", "stopped"]);
const ACTIVE_STATES = new Set(["running", "awaiting_approval", "approving"]);
const TABLES = Object.freeze({ runs: "agent_brain_runs", documents: "agent_brain_documents", cache: "agent_brain_cache" });
const sqliteQueues = new Map();

function problem(message, code = "BRAIN_INVALID_INPUT", status = 400) {
  return Object.assign(new Error(message), { code, status, statusCode: status });
}

function identifier(value, label = "Identifier") {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw problem(`${label} must contain 1 to 256 characters`);
  }
  return value;
}

function jsonCopy(value, maximum = 1_000_000) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw problem("Value must be JSON serializable"); }
  if (encoded === undefined || encoded.length > maximum) throw problem("Stored value exceeds the size limit");
  return JSON.parse(encoded);
}

function timestamp(value, fallback) {
  const date = new Date(value ?? fallback);
  if (!Number.isFinite(date.valueOf())) throw problem("Timestamp is invalid");
  return date.toISOString();
}

function boundedLimit(limit, fallback, maximum = CAPACITY) {
  return Number.isInteger(limit) ? Math.max(1, Math.min(maximum, limit)) : fallback;
}

function newestFirst(left, right) {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function pageOptions({ limit = 100, before } = {}, fallback = 100) {
  if (before !== undefined && (!before || typeof before !== "object" || Array.isArray(before))) {
    throw problem("Pagination cursor must include updatedAt and id");
  }
  return { limit: boundedLimit(limit, fallback), before: before === undefined ? undefined : {
    id: identifier(before.id, "Cursor ID"), updatedAt: timestamp(before.updatedAt),
  } };
}

function orderedRows(rows, { limit, before } = {}) {
  const filtered = before ? rows.filter((row) => row.updatedAt < before.updatedAt
    || (row.updatedAt === before.updatedAt && row.id.localeCompare(before.id) > 0)) : rows;
  const sorted = filtered.sort(newestFirst);
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

function makeQueue() {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}

function createRepository(storage, { now = () => new Date(), storageKind = "memory", persistent = false } = {}) {
  let closed = false;
  const perform = (ownerId, work, readOnly = false) => {
    identifier(ownerId, "Owner");
    if (closed) throw problem("Brain repository is closed", "BRAIN_CLOSED", 503);
    return (readOnly && storage.read ? storage.read : storage.transaction)(ownerId, work);
  };
  return {
    getStorageStatus() { return { kind: storageKind, persistent, available: !closed }; },
    async getRun(ownerId, id) {
      identifier(id);
      return perform(ownerId, async (tx) => (await tx.get("runs", id))?.payload ?? null, true);
    },
    async listRuns(ownerId, { limit = 20, before } = {}) {
      const page = pageOptions({ limit, before }, 20);
      return perform(ownerId, async (tx) => (await tx.list("runs", page)).map((row) => row.payload), true);
    },
    async saveRun(ownerId, run, { expectedVersion } = {}) {
      if (!run || typeof run !== "object" || Array.isArray(run)) throw problem("Run must be an object");
      identifier(run.id, "Run ID");
      const input = jsonCopy(run);
      if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
        throw problem("Expected version must be a positive integer");
      }
      return perform(ownerId, async (tx) => {
        const existing = await tx.get("runs", input.id);
        if ((existing && expectedVersion !== existing.version) || (!existing && expectedVersion !== undefined)) {
          throw problem("Run changed; reload it before continuing", "BRAIN_CONFLICT", 409);
        }
        const time = now().toISOString();
        const saved = jsonCopy({ ...input, version: (existing?.version ?? 0) + 1,
          createdAt: existing?.payload.createdAt ?? timestamp(input.createdAt, time), updatedAt: time });
        if (!existing) {
          if (saved.status === "running" && await tx.hasActiveRun()) {
            throw problem("A run is already active for this account", "BRAIN_RUN_IN_PROGRESS", 409);
          }
          // Hosted audit history is durable; a page-size bound must never erase it.
          if (storageKind !== "postgres") {
            const rows = await tx.list("runs");
            if (rows.length >= CAPACITY) {
              const removable = rows.filter((row) => TERMINAL_STATES.has(row.payload.status))
                .sort(newestFirst).reverse();
              const count = rows.length - CAPACITY + 1;
              if (removable.length < count) throw problem("Too many active runs; finish or cancel a run first", "BRAIN_CAPACITY", 409);
              for (const row of removable.slice(0, count)) await tx.remove("runs", row.id);
            }
          }
        }
        await tx.put("runs", { id: saved.id, payload: saved, version: saved.version, updatedAt: time });
        return jsonCopy(saved);
      });
    },
    async listDocuments(ownerId, options) {
      const page = pageOptions(options);
      return perform(ownerId, async (tx) => (await tx.list("documents", page)).map((row) => row.payload), true);
    },
    ...(storageKind === "postgres" ? {
      async searchDocuments(ownerId, terms, { kind, limit = SEARCH_CANDIDATES } = {}) {
        if (!Array.isArray(terms) || terms.length > 64 || terms.some((term) => typeof term !== "string"
          || !/^[\p{L}\p{N}]+$/u.test(term) || term.length > 4000)
          || (kind !== undefined && !["knowledge", "memory"].includes(kind))) {
          throw problem("Search terms or document kind are invalid");
        }
        return perform(ownerId, async (tx) => terms.length ? tx.searchDocuments(terms, {
          kind, limit: boundedLimit(limit, SEARCH_CANDIDATES, SEARCH_CANDIDATES),
        }) : [], true);
      },
    } : {}),
    async putDocument(ownerId, document) {
      if (!document || typeof document !== "object") throw problem("Document must be an object");
      identifier(document.id, "Document ID");
      if (typeof document.title !== "string" || !document.title.trim() || document.title.length > 200) {
        throw problem("Document title must contain 1 to 200 characters");
      }
      if (typeof document.text !== "string" || !document.text.trim() || document.text.length > 50_000) {
        throw problem("Document text must contain 1 to 50,000 characters");
      }
      if (!["knowledge", "memory"].includes(document.kind)) throw problem("Document kind must be knowledge or memory");
      const input = jsonCopy(document);
      return perform(ownerId, async (tx) => {
        const existing = await tx.get("documents", input.id);
        if (storageKind !== "postgres" && !existing && await tx.count("documents") >= CAPACITY) {
          throw problem("Knowledge storage is full; remove a document first", "BRAIN_CAPACITY", 409);
        }
        const time = now().toISOString();
        const saved = { id: input.id, title: input.title.trim(), text: input.text, kind: input.kind,
          createdAt: existing?.payload.createdAt ?? timestamp(input.createdAt, time), updatedAt: time };
        await tx.put("documents", { id: saved.id, payload: saved, updatedAt: time });
        return jsonCopy(saved);
      });
    },
    async deleteDocument(ownerId, id) {
      identifier(id);
      return perform(ownerId, async (tx) => { await tx.remove("documents", id); });
    },
    async getCache(ownerId, key) {
      identifier(key, "Cache key");
      if (storage.read) {
        return perform(ownerId, async (tx) => (await tx.getCached(key, now().toISOString()))?.payload ?? null, true);
      }
      return perform(ownerId, async (tx) => {
        const row = await tx.get("cache", key);
        if (!row) return null;
        const expiry = Date.parse(row.payload.expiresAt);
        if (!Number.isFinite(expiry) || expiry <= now().valueOf()) {
          await tx.remove("cache", key);
          return null;
        }
        return row.payload;
      });
    },
    async putCache(ownerId, key, entry) {
      identifier(key, "Cache key");
      if (!entry || typeof entry !== "object" || !Object.hasOwn(entry, "value") || entry.expiresAt == null) {
        throw problem("Cache entry requires a value and expiry");
      }
      const saved = { value: jsonCopy(entry.value, 250_000), expiresAt: timestamp(entry.expiresAt) };
      return perform(ownerId, async (tx) => {
        const time = now();
        if (tx.maintainCache) {
          const expired = Date.parse(saved.expiresAt) <= time.valueOf();
          await tx.maintainCache(key, time.toISOString(), expired ? CAPACITY : CAPACITY - 1);
          if (expired) { await tx.remove("cache", key); return; }
          await tx.put("cache", { id: key, payload: saved, updatedAt: time.toISOString() });
          return;
        }
        const rows = await tx.list("cache");
        const retained = [];
        for (const row of rows) {
          const expiry = Date.parse(row.payload.expiresAt);
          if (!Number.isFinite(expiry) || expiry <= time.valueOf()) await tx.remove("cache", row.id);
          else if (row.id !== key) retained.push(row);
        }
        if (Date.parse(saved.expiresAt) <= time.valueOf()) { await tx.remove("cache", key); return; }
        for (const row of retained.sort(newestFirst).slice(CAPACITY - 1)) await tx.remove("cache", row.id);
        await tx.put("cache", { id: key, payload: saved, updatedAt: time.toISOString() });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await storage.close();
    },
  };
}

export function createMemoryBrainRepository(options = {}) {
  const owners = new Map();
  const enqueue = makeQueue();
  return createRepository({
    transaction(ownerId, work) {
      return enqueue(async () => {
        const original = owners.get(ownerId) ?? { runs: new Map(), documents: new Map(), cache: new Map() };
        const staged = Object.fromEntries(Object.entries(original).map(([name, rows]) => [name, new Map(rows)]));
        const result = await work({
          get: (entity, id) => { const row = staged[entity].get(id); return row ? jsonCopy(row) : null; },
          list: (entity, options) => orderedRows([...staged[entity].values()].map((row) => jsonCopy(row)), options),
          count: (entity) => staged[entity].size,
          hasActiveRun: () => [...staged.runs.values()].some((row) => ACTIVE_STATES.has(row.payload.status)),
          put: (entity, row) => staged[entity].set(row.id, jsonCopy(row)),
          remove: (entity, id) => staged[entity].delete(id),
        });
        owners.set(ownerId, staged);
        return result;
      });
    },
    close: () => enqueue(() => owners.clear()),
  }, { ...options, storageKind: "memory", persistent: false });
}

function decodeRow(row) {
  if (!row) return null;
  return { id: row.id, version: row.version,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : jsonCopy(row.payload),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at };
}

function sqlTransaction(query, ownerId, postgres = false) {
  const param = (number) => postgres ? `$${number}` : "?";
  return {
    async get(entity, id) {
      const rows = await query(`SELECT id, payload, updated_at${entity === "runs" ? ", version" : ""} FROM ${TABLES[entity]} WHERE owner_id = ${param(1)} AND id = ${param(2)}`, [ownerId, id]);
      return decodeRow(rows[0]);
    },
    async list(entity, { limit, before } = {}) {
      const values = [ownerId];
      let cursor = "";
      if (before) {
        values.push(before.updatedAt, before.id);
        // The outer timestamp bound lets the ordered index start at the cursor
        // instead of scanning every newer row on deep pages.
        cursor = ` AND updated_at <= ${param(2)} AND (updated_at < ${param(2)} OR id > ${param(3)})`;
        // SQLite uses positional anonymous parameters, including repeated values.
        if (!postgres) values.splice(2, 0, before.updatedAt);
      }
      if (limit !== undefined) values.push(limit);
      const rows = await query(`SELECT id, payload, updated_at${entity === "runs" ? ", version" : ""} FROM ${TABLES[entity]} WHERE owner_id = ${param(1)}${cursor} ORDER BY updated_at DESC, id ASC${limit === undefined ? "" : ` LIMIT ${param(values.length)}`}`, values);
      return rows.map(decodeRow);
    },
    async count(entity) {
      const rows = await query(`SELECT count(*) AS count FROM ${TABLES[entity]} WHERE owner_id = ${param(1)}`, [ownerId]);
      return Number(rows[0].count);
    },
    async hasActiveRun() {
      const status = postgres ? "payload->>'status'" : "json_extract(payload, '$.status')";
      const rows = await query(`SELECT 1 FROM agent_brain_runs WHERE owner_id = ${param(1)} AND ${status} IN ('running', 'awaiting_approval', 'approving') LIMIT 1`, [ownerId]);
      return rows.length > 0;
    },
    async getCached(id, time) {
      const rows = await query(`SELECT id, payload, updated_at FROM agent_brain_cache WHERE owner_id = ${param(1)} AND id = ${param(2)} AND expires_at > ${param(3)}`, [ownerId, id, time]);
      return decodeRow(rows[0]);
    },
    async maintainCache(id, time, keep) {
      await query(`DELETE FROM agent_brain_cache WHERE owner_id = ${param(1)} AND expires_at <= ${param(2)}`, [ownerId, time]);
      const offset = postgres ? `OFFSET ${param(4)}` : `LIMIT -1 OFFSET ${param(4)}`;
      await query(`DELETE FROM agent_brain_cache WHERE owner_id = ${param(1)} AND id IN (SELECT id FROM agent_brain_cache WHERE owner_id = ${param(2)} AND id <> ${param(3)} ORDER BY updated_at DESC, id ASC ${offset})`, [ownerId, ownerId, id, keep]);
    },
    async searchDocuments(terms, { kind, limit }) {
      // The simple dictionary keeps lexical matches without stemming. Candidate
      // ranks and the later BM25 scores are not comparable to a full-corpus scan.
      const vector = "to_tsvector('simple', coalesce(payload->>'title', '') || ' ' || coalesce(payload->>'text', ''))";
      const values = [ownerId, terms.join(" | "), limit];
      if (kind !== undefined) values.push(kind);
      const rows = await query(`SELECT id, payload, updated_at FROM agent_brain_documents
        WHERE owner_id = $1 AND ${vector} @@ to_tsquery('simple', $2)${kind === undefined ? "" : " AND payload->>'kind' = $4"}
        ORDER BY ts_rank_cd(${vector}, to_tsquery('simple', $2)) DESC, updated_at DESC, id ASC LIMIT $3`, values);
      return rows.map((row) => decodeRow(row).payload);
    },
    async put(entity, row) {
      const columns = ["owner_id", "id", "payload", "updated_at"];
      const values = [ownerId, row.id, JSON.stringify(row.payload), row.updatedAt];
      if (entity === "runs") { columns.push("version"); values.push(row.version); }
      if (entity === "cache") { columns.push("expires_at"); values.push(row.payload.expiresAt); }
      const updates = columns.slice(2).map((column) => `${column} = excluded.${column}`).join(", ");
      await query(`INSERT INTO ${TABLES[entity]} (${columns.join(", ")}) VALUES (${values.map((_, index) => param(index + 1)).join(", ")}) ON CONFLICT (owner_id, id) DO UPDATE SET ${updates}`, values);
    },
    async remove(entity, id) {
      await query(`DELETE FROM ${TABLES[entity]} WHERE owner_id = ${param(1)} AND id = ${param(2)}`, [ownerId, id]);
    },
  };
}

export function createSqliteBrainRepository({ filename, now } = {}) {
  if (process.env.NODE_ENV === "production" || process.env.APP_ENVIRONMENT === "production") {
    throw problem("Production brain persistence requires PostgreSQL", "BRAIN_STORAGE_CONFIG", 503);
  }
  if (typeof filename !== "string" || !filename.trim()) throw problem("SQLite filename is required");
  const resolvedFilename = filename === ":memory:" ? filename : path.resolve(filename);
  if (resolvedFilename !== ":memory:") mkdirSync(path.dirname(resolvedFilename), { recursive: true });
  const database = new DatabaseSync(resolvedFilename, { timeout: 5000 });
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agent_brain_runs (
        owner_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0),
        payload TEXT NOT NULL CHECK (json_valid(payload)), updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_brain_documents (
        owner_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)),
        updated_at TEXT NOT NULL, PRIMARY KEY (owner_id, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_brain_cache (
        owner_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload)),
        expires_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (owner_id, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_agent_brain_runs_owner_updated ON agent_brain_runs (owner_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_brain_runs_one_running_per_owner
        ON agent_brain_runs (owner_id) WHERE json_extract(payload, '$.status') = 'running';
      CREATE INDEX IF NOT EXISTS idx_agent_brain_cache_owner_expiry ON agent_brain_cache (owner_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_agent_brain_runs_owner_page ON agent_brain_runs (owner_id, updated_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_brain_documents_owner_page ON agent_brain_documents (owner_id, updated_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_brain_cache_owner_page ON agent_brain_cache (owner_id, updated_at DESC, id ASC);
    `);
  } catch (error) { database.close(); throw error; }
  // Share a queue between connections to the same file so synchronous BEGIN does
  // not block the event loop while another local connection awaits its callback.
  const queueKey = resolvedFilename === ":memory:" ? Symbol() : (process.platform === "win32" ? resolvedFilename.toLowerCase() : resolvedFilename);
  const shared = sqliteQueues.get(queueKey) ?? { enqueue: makeQueue(), references: 0 };
  shared.references += 1;
  sqliteQueues.set(queueKey, shared);
  const query = (sql, values) => {
    const statement = database.prepare(sql);
    return sql.startsWith("SELECT") ? statement.all(...values) : (statement.run(...values), []);
  };
  return createRepository({
    read: (ownerId, work) => shared.enqueue(() => work(sqlTransaction(query, ownerId))),
    transaction(ownerId, work) {
      return shared.enqueue(async () => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = await work(sqlTransaction(query, ownerId));
          database.exec("COMMIT");
          return result;
        } catch (error) { database.exec("ROLLBACK"); throw error; }
      });
    },
    close: () => shared.enqueue(() => {
      database.close();
      shared.references -= 1;
      if (shared.references === 0) sqliteQueues.delete(queueKey);
    }),
  }, { now, storageKind: "sqlite", persistent: resolvedFilename !== ":memory:" });
}

export function createPostgresBrainRepository(pool, { now } = {}) {
  if (!pool || typeof pool.connect !== "function") throw problem("PostgreSQL pool is required");
  return createRepository({
    async read(ownerId, work) {
      // Single SELECT statements use MVCC and do not wait for an owner's write
      // transaction or require BEGIN/COMMIT round trips.
      const client = await pool.connect();
      try {
        return await work(sqlTransaction(async (sql, values) => (await client.query(sql, values)).rows, ownerId, true));
      } finally { client.release(); }
    },
    async transaction(ownerId, work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // The transaction lock makes revisions, run admission, and cache bounds
        // atomic across processes, including creation of the first row.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('agent_brain'), hashtext($1))", [ownerId]);
        const query = async (sql, values) => (await client.query(sql, values)).rows;
        const result = await work(sqlTransaction(query, ownerId, true));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (error.code === "23505" && error.constraint === "idx_agent_brain_runs_one_running_per_owner") {
          throw problem("A run is already active for this account", "BRAIN_RUN_IN_PROGRESS", 409);
        }
        throw error;
      } finally { client.release(); }
    },
    // The application owns the shared pool and closes it during shutdown.
    async close() {},
  }, { now, storageKind: "postgres", persistent: true });
}
