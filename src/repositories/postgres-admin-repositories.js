const storage = () => ({ kind: "postgres", persistent: true });
const failure = (code, message) => Object.assign(new Error(message), { code });
const iso = (value) => new Date(value).toISOString();

// Identity snapshots never duplicate the OAuth credentials held in the session store.
function safeIdentity(input) {
  const fields = ["username", "displayName", "avatarUrl", "authMode", "rolesSyncedAt", "lastSignedInAt"];
  return {
    ...Object.fromEntries(fields.filter((name) => input[name] !== undefined).map((name) => [name, input[name]])),
    id: String(input.id), roles: [...(input.roles ?? [])], capabilities: [...(input.capabilities ?? [])],
  };
}

export function createPostgresUserRepository(pool, { now = () => new Date() } = {}) {
  const unpack = (row) => row ? { ...row.payload, id: row.user_id, firstSeenAt: iso(row.first_seen_at), lastSeenAt: iso(row.last_seen_at) } : null;
  return {
    getStorageStatus: storage,
    async upsert(input) {
      const timestamp = iso(now());
      const result = await pool.query(`INSERT INTO app_users(user_id,payload,first_seen_at,last_seen_at)
        VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET
        payload=app_users.payload || EXCLUDED.payload,last_seen_at=EXCLUDED.last_seen_at RETURNING *`,
      [String(input.id), JSON.stringify(safeIdentity(input)), input.firstSeenAt ?? timestamp, timestamp]);
      return unpack(result.rows[0]);
    },
    async findById(id) { return unpack((await pool.query("SELECT * FROM app_users WHERE user_id=$1", [String(id)])).rows[0]); },
    async list() { return (await pool.query("SELECT * FROM app_users ORDER BY last_seen_at DESC,user_id")).rows.map(unpack); },
  };
}

export function createPostgresBanRepository(pool, { now = () => new Date() } = {}) {
  const unpack = (row) => row ? { userId: row.user_id, actorId: row.actor_id, reason: row.reason, bannedAt: iso(row.banned_at) } : null;
  return {
    getStorageStatus: storage,
    async ban(input) {
      return unpack((await pool.query(`INSERT INTO app_bans(user_id,actor_id,reason,banned_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id) DO UPDATE SET actor_id=EXCLUDED.actor_id,reason=EXCLUDED.reason,banned_at=EXCLUDED.banned_at RETURNING *`,
      [String(input.userId), String(input.actorId), input.reason ?? "", iso(now())])).rows[0]);
    },
    async unban(input) {
      const id = typeof input === "object" && input !== null ? input.userId : input;
      const row = (await pool.query("DELETE FROM app_bans WHERE user_id=$1 RETURNING *", [String(id)])).rows[0];
      if (!row) throw failure("BAN_NOT_FOUND", "Ban record not found");
      return unpack(row);
    },
    async findByUserId(id) { return unpack((await pool.query("SELECT * FROM app_bans WHERE user_id=$1", [String(id)])).rows[0]); },
    async isBanned(id) { return (await pool.query("SELECT 1 FROM app_bans WHERE user_id=$1", [String(id)])).rowCount > 0; },
    async list() { return (await pool.query("SELECT * FROM app_bans ORDER BY banned_at DESC,user_id")).rows.map(unpack); },
  };
}

export function createPostgresIndicatorRequestRepository(pool, { now = () => new Date() } = {}) {
  return {
    getStorageStatus: storage,
    async upsertPending(input) {
      const record = {
        userId: String(input.userId), discordUsername: input.discordUsername,
        tradingViewUsername: input.tradingViewUsername, indicatorIds: [...(input.indicatorIds ?? [])],
        status: "PENDING", requestedAt: iso(now()), decidedBy: null, decidedAt: null,
      };
      return (await pool.query(`INSERT INTO indicator_requests(user_id,payload,updated_at) VALUES($1,$2,$3)
        ON CONFLICT(user_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at RETURNING payload`,
      [record.userId, JSON.stringify(record), record.requestedAt])).rows[0].payload;
    },
    async findByUserId(id) { return (await pool.query("SELECT payload FROM indicator_requests WHERE user_id=$1", [String(id)])).rows[0]?.payload ?? null; },
    async list() { return (await pool.query("SELECT payload FROM indicator_requests ORDER BY updated_at DESC,user_id")).rows.map((row) => row.payload); },
    async decide({ userId, status, actorId }) {
      if (!["GRANTED", "DENIED"].includes(status)) throw failure("INVALID_DECISION", "Invalid indicator request decision");
      const patch = { status, decidedBy: String(actorId), decidedAt: iso(now()) };
      const result = await pool.query(`UPDATE indicator_requests SET payload=payload || $2::jsonb,updated_at=$3
        WHERE user_id=$1 AND payload->>'status'='PENDING' RETURNING payload`, [String(userId), JSON.stringify(patch), patch.decidedAt]);
      if (result.rows[0]) return result.rows[0].payload;
      if (await this.findByUserId(userId)) throw failure("INDICATOR_REQUEST_NOT_PENDING", "Indicator request is not pending");
      throw failure("INDICATOR_REQUEST_NOT_FOUND", "Indicator request not found");
    },
  };
}

export function createPostgresSessionRegistry(pool) {
  return {
    getStorageStatus: storage,
    // The session store itself is the durable index, including sessions from before this migration.
    async register() {},
    async unregister() {},
    async markRevoked(id) { await pool.query("INSERT INTO revoked_user_sessions(sid) VALUES($1) ON CONFLICT DO NOTHING", [String(id)]); },
    async isRevoked(id) { return (await pool.query("SELECT 1 FROM revoked_user_sessions WHERE sid=$1", [String(id)])).rowCount > 0; },
    async listSessionIds(id) {
      return (await pool.query("SELECT sid FROM user_sessions WHERE sess->'operator'->>'id'=$1 AND expire>now() ORDER BY sid", [String(id)])).rows.map((row) => row.sid);
    },
    async activeCount(id) {
      return Number((await pool.query(`SELECT count(*) AS count FROM user_sessions s
        WHERE sess->'operator'->>'id'=$1 AND expire>now()
        AND NOT EXISTS(SELECT 1 FROM revoked_user_sessions r WHERE r.sid=s.sid)`, [String(id)])).rows[0].count);
    },
    async clearUser(id) {
      const result = await pool.query(`WITH removed AS (
        DELETE FROM user_sessions WHERE sess->'operator'->>'id'=$1 RETURNING sid)
        INSERT INTO revoked_user_sessions(sid) SELECT sid FROM removed ON CONFLICT DO NOTHING RETURNING sid`, [String(id)]);
      return result.rows.map((row) => row.sid);
    },
  };
}
