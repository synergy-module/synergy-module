import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import session from "express-session";

export const DEFAULT_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const storage = () => ({ kind: "sqlite", persistent: true });
const failure = (code, message) => Object.assign(new Error(message), { code });
const iso = (value) => new Date(value).toISOString();
const unpack = (row) => row ? JSON.parse(row.payload) : null;

// Keep identity snapshots separate from the OAuth credentials in the session store.
function safeIdentity(input) {
  const fields = ["username", "displayName", "avatarUrl", "authMode", "rolesSyncedAt", "lastSignedInAt"];
  return {
    ...Object.fromEntries(fields.filter((name) => input[name] !== undefined).map((name) => [name, input[name]])),
    id: String(input.id), roles: [...(input.roles ?? [])], capabilities: [...(input.capabilities ?? [])],
  };
}

class SqliteSessionStore extends session.Store {
  constructor(database, { now, lifetimeMs }) {
    super();
    this.database = database;
    this.now = now;
    this.lifetimeMs = lifetimeMs;
  }

  perform(callback, work) {
    let error;
    let result;
    try { result = work(); } catch (caught) { error = caught; }
    // express-session expects Node-style callbacks, including for synchronous stores.
    queueMicrotask(() => {
      if (callback) callback(error, result);
      else if (error) this.emit("error", error);
    });
  }

  expiration(value) {
    const expires = value.cookie?.expires;
    const timestamp = expires ? new Date(expires).valueOf() : NaN;
    return Number.isFinite(timestamp) ? timestamp : this.now().valueOf() + this.lifetimeMs;
  }

  prune() {
    this.database.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").run(this.now().valueOf());
  }

  get(sid, callback) {
    this.perform(callback, () => {
      this.prune();
      const row = this.database.prepare(`SELECT s.payload FROM user_sessions s WHERE s.sid = ?
        AND NOT EXISTS (SELECT 1 FROM revoked_user_sessions r WHERE r.sid = s.sid)`).get(String(sid));
      return unpack(row);
    });
  }

  set(sid, value, callback) {
    this.perform(callback, () => {
      this.prune();
      // An in-flight request must never restore a session an administrator revoked.
      this.database.prepare(`INSERT INTO user_sessions (sid, owner_id, payload, expires_at)
        SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM revoked_user_sessions WHERE sid = ?)
        ON CONFLICT(sid) DO UPDATE SET owner_id = excluded.owner_id,
        payload = excluded.payload, expires_at = excluded.expires_at`).run(
        String(sid), value.operator?.id == null ? null : String(value.operator.id),
        JSON.stringify(value), this.expiration(value), String(sid),
      );
    });
  }

  touch(sid, value, callback) {
    this.perform(callback, () => {
      this.prune();
      // Touch only the cookie; saving a stale request's operator would undo a role refresh.
      this.database.prepare(`UPDATE user_sessions SET expires_at = ?,
        payload = json_set(payload, '$.cookie', json(?)) WHERE sid = ?
        AND NOT EXISTS (SELECT 1 FROM revoked_user_sessions WHERE sid = ?)`).run(
        this.expiration(value), JSON.stringify(value.cookie ?? {}), String(sid), String(sid),
      );
    });
  }

  destroy(sid, callback) {
    this.perform(callback, () => { this.database.prepare("DELETE FROM user_sessions WHERE sid = ?").run(String(sid)); });
  }

  clear(callback) {
    this.perform(callback, () => { this.database.exec("DELETE FROM user_sessions"); });
  }

  length(callback) {
    this.perform(callback, () => {
      this.prune();
      return Number(this.database.prepare(`SELECT count(*) AS count FROM user_sessions s
        WHERE NOT EXISTS (SELECT 1 FROM revoked_user_sessions r WHERE r.sid = s.sid)`).get().count);
    });
  }

  all(callback) {
    this.perform(callback, () => {
      this.prune();
      return this.database.prepare(`SELECT sid, payload FROM user_sessions s
        WHERE NOT EXISTS (SELECT 1 FROM revoked_user_sessions r WHERE r.sid = s.sid) ORDER BY sid`)
        .all().map((row) => ({ ...unpack(row), id: row.sid }));
    });
  }
}

/** Durable development/local runtime. Production continues to use PostgreSQL. */
export function createSqliteRuntime({
  filename = "data/workspace.sqlite",
  now = () => new Date(),
  sessionLifetimeMs = DEFAULT_SESSION_LIFETIME_MS,
} = {}) {
  if (!Number.isFinite(sessionLifetimeMs) || sessionLifetimeMs <= 0) throw new Error("Session lifetime must be positive");
  if (filename !== ":memory:") mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  try {
    database.exec(`PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS user_sessions (
        sid TEXT PRIMARY KEY, owner_id TEXT, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_session_owner ON user_sessions(owner_id, expires_at);
      CREATE INDEX IF NOT EXISTS local_session_expiry ON user_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS revoked_user_sessions (sid TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS app_users (
        user_id TEXT PRIMARY KEY, payload TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_bans (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL, banned_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS indicator_requests (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_entries (
        owner_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id, id)
      );
      CREATE INDEX IF NOT EXISTS local_journal_owner ON journal_entries(owner_id, created_at DESC, id DESC);`);
  } catch (error) { database.close(); throw error; }

  const sessionStore = new SqliteSessionStore(database, { now, lifetimeMs: sessionLifetimeMs });
  const userRepository = {
    getStorageStatus: storage,
    async upsert(input) {
      const timestamp = iso(now());
      const existing = await this.findById(input.id);
      const record = {
        ...existing, ...safeIdentity(input),
        firstSeenAt: existing?.firstSeenAt ?? input.firstSeenAt ?? timestamp, lastSeenAt: timestamp,
      };
      database.prepare(`INSERT INTO app_users(user_id, payload, first_seen_at, last_seen_at) VALUES(?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, last_seen_at = excluded.last_seen_at`)
        .run(record.id, JSON.stringify(record), record.firstSeenAt, timestamp);
      return structuredClone(record);
    },
    async findById(id) { return unpack(database.prepare("SELECT payload FROM app_users WHERE user_id = ?").get(String(id))); },
    async list() { return database.prepare("SELECT payload FROM app_users ORDER BY last_seen_at DESC, user_id").all().map(unpack); },
  };
  const banRepository = {
    getStorageStatus: storage,
    async ban(input) {
      const record = { userId: String(input.userId), actorId: String(input.actorId), reason: input.reason ?? "", bannedAt: iso(now()) };
      database.prepare(`INSERT INTO app_bans(user_id, payload, banned_at) VALUES(?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, banned_at = excluded.banned_at`)
        .run(record.userId, JSON.stringify(record), record.bannedAt);
      return record;
    },
    async unban(input) {
      const id = String(typeof input === "object" && input !== null ? input.userId : input);
      const record = unpack(database.prepare("DELETE FROM app_bans WHERE user_id = ? RETURNING payload").get(id));
      if (!record) throw failure("BAN_NOT_FOUND", "Ban record not found");
      return record;
    },
    async findByUserId(id) { return unpack(database.prepare("SELECT payload FROM app_bans WHERE user_id = ?").get(String(id))); },
    async isBanned(id) { return Boolean(database.prepare("SELECT 1 FROM app_bans WHERE user_id = ?").get(String(id))); },
    async list() { return database.prepare("SELECT payload FROM app_bans ORDER BY banned_at DESC, user_id").all().map(unpack); },
  };
  const indicatorRequestRepository = {
    getStorageStatus: storage,
    async upsertPending(input) {
      const record = {
        userId: String(input.userId), discordUsername: input.discordUsername,
        tradingViewUsername: input.tradingViewUsername, indicatorIds: [...(input.indicatorIds ?? [])],
        status: "PENDING", requestedAt: iso(now()), decidedBy: null, decidedAt: null,
      };
      database.prepare(`INSERT INTO indicator_requests(user_id, payload, updated_at) VALUES(?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
        .run(record.userId, JSON.stringify(record), record.requestedAt);
      return record;
    },
    async findByUserId(id) { return unpack(database.prepare("SELECT payload FROM indicator_requests WHERE user_id = ?").get(String(id))); },
    async list() { return database.prepare("SELECT payload FROM indicator_requests ORDER BY updated_at DESC, user_id").all().map(unpack); },
    async decide({ userId, status, actorId }) {
      if (!["GRANTED", "DENIED"].includes(status)) throw failure("INVALID_DECISION", "Invalid indicator request decision");
      const timestamp = iso(now());
      const result = database.prepare(`UPDATE indicator_requests
        SET payload = json_set(payload, '$.status', ?, '$.decidedBy', ?, '$.decidedAt', ?), updated_at = ?
        WHERE user_id = ? AND json_extract(payload, '$.status') = 'PENDING' RETURNING payload`)
        .get(status, String(actorId), timestamp, timestamp, String(userId));
      if (result) return unpack(result);
      if (await this.findByUserId(userId)) throw failure("INDICATOR_REQUEST_NOT_PENDING", "Indicator request is not pending");
      throw failure("INDICATOR_REQUEST_NOT_FOUND", "Indicator request not found");
    },
  };
  const sessionRegistry = {
    getStorageStatus: storage,
    // The session store is the index, so existing sessions are covered after restart.
    async register() {},
    async unregister() {},
    async markRevoked(id) { database.prepare("INSERT INTO revoked_user_sessions(sid) VALUES(?) ON CONFLICT DO NOTHING").run(String(id)); },
    async isRevoked(id) { return Boolean(database.prepare("SELECT 1 FROM revoked_user_sessions WHERE sid = ?").get(String(id))); },
    async listSessionIds(id) {
      return database.prepare("SELECT sid FROM user_sessions WHERE owner_id = ? AND expires_at > ? ORDER BY sid")
        .all(String(id), now().valueOf()).map((row) => row.sid);
    },
    async activeCount(id) {
      return Number(database.prepare(`SELECT count(*) AS count FROM user_sessions s WHERE owner_id = ? AND expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM revoked_user_sessions r WHERE r.sid = s.sid)`).get(String(id), now().valueOf()).count);
    },
    async clearUser(id) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const ids = database.prepare("DELETE FROM user_sessions WHERE owner_id = ? RETURNING sid").all(String(id)).map((row) => row.sid);
        const revoke = database.prepare("INSERT INTO revoked_user_sessions(sid) VALUES(?) ON CONFLICT DO NOTHING");
        for (const sid of ids) revoke.run(sid);
        database.exec("COMMIT");
        return ids;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
  const journalRepository = {
    getStorageStatus: storage,
    async list(ownerId) {
      return database.prepare("SELECT payload FROM journal_entries WHERE owner_id = ? ORDER BY created_at DESC, id DESC")
        .all(String(ownerId)).map(unpack);
    },
    async find(ownerId, id) {
      return unpack(database.prepare("SELECT payload FROM journal_entries WHERE owner_id = ? AND id = ?").get(String(ownerId), String(id))) ?? undefined;
    },
    async create(ownerId, entry) {
      database.prepare("INSERT INTO journal_entries(owner_id, id, payload, created_at) VALUES(?, ?, ?, ?)")
        .run(String(ownerId), String(entry.id), JSON.stringify(entry), iso(entry.createdAt));
      return structuredClone(entry);
    },
  };
  let closed = false;
  return {
    database, sessionStore, userRepository, banRepository, indicatorRequestRepository, sessionRegistry, journalRepository,
    readinessCheck: async () => {
      if (closed) return false;
      return database.prepare("PRAGMA quick_check").get().quick_check === "ok";
    },
    async close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}
