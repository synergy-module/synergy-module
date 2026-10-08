import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assertMigrationAllowed, migrate, migrationStatus, MIGRATION_FILES } from "../../scripts/migrate.js";

const allowed = { APP_ENVIRONMENT: "production", APP_ALLOW_MIGRATIONS: "true", DATABASE_URL: "postgres://fixture/app" };

async function sourceRecords() {
  return Promise.all(MIGRATION_FILES.map(async (filename) => ({ filename,
    checksum: createHash("sha256").update((await readFile(new URL(`../../migrations/${filename}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n")).digest("hex"),
    applied_at: new Date("2026-09-24T00:00:00Z"),
  })));
}

test("migrations require the production-only two-key guard", () => {
  assert.throws(() => assertMigrationAllowed({ APP_ENVIRONMENT: "beta", APP_ALLOW_MIGRATIONS: "true", DATABASE_URL: "postgres://db/app" }), /production/);
  assert.throws(() => assertMigrationAllowed({ APP_ENVIRONMENT: "production", APP_ALLOW_MIGRATIONS: "false", DATABASE_URL: "postgres://db/app" }), /APP_ALLOW_MIGRATIONS/);
  assert.throws(() => assertMigrationAllowed({ APP_ENVIRONMENT: "production", APP_ALLOW_MIGRATIONS: "true" }), /DATABASE_URL/);
  assert.doesNotThrow(() => assertMigrationAllowed({ APP_ENVIRONMENT: "production", APP_ALLOW_MIGRATIONS: "true", DATABASE_URL: "postgres://db/app" }));
});

test("the supported migration command installs workspace storage within the schema transaction", async () => {
  const statements = [];
  let ended = false;
  await migrate({ APP_ENVIRONMENT: "production", APP_ALLOW_MIGRATIONS: "true", DATABASE_URL: "postgres://fixture/app" }, {
    createPool: () => ({ async query(sql) { statements.push(sql); }, async end() { ended = true; } }),
  });
  assert.equal(statements[0], "BEGIN");
  assert.ok(statements.some((sql) => /CREATE TABLE IF NOT EXISTS user_workspaces/.test(sql)));
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(ended, true);
});

test("failure while creating workspace storage rolls back and closes the migration connection", async () => {
  const statements = [];
  let ended = false;
  await assert.rejects(migrate({ APP_ENVIRONMENT: "production", APP_ALLOW_MIGRATIONS: "true", DATABASE_URL: "postgres://fixture/app" }, {
    createPool: () => ({ async query(sql) { statements.push(sql); if (/CREATE TABLE IF NOT EXISTS user_workspaces/.test(sql)) throw new Error("fixture migration failure"); }, async end() { ended = true; } }),
  }), /fixture migration failure/);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(ended, true);
});

test("applied checksums skip migration SQL while preserving serialized transaction boundaries", async () => {
  const records = await sourceRecords();
  const statements = [];
  let options;
  let ended = false;
  const result = await migrate(allowed, { createPool: (configuration) => {
    options = configuration;
    return { async query(sql, values) { statements.push({ sql, values }); return { rows: sql.startsWith("SELECT filename") ? records : [] }; }, async end() { ended = true; } };
  } });
  assert.deepEqual(result, { applied: [], skipped: MIGRATION_FILES });
  assert.equal(options.max, 1, "transaction statements must share one pooled connection");
  assert.equal(options.application_name, "synergy-module-migration");
  assert.equal(statements[0].sql, "BEGIN");
  assert.equal(statements[1].sql, "SET LOCAL lock_timeout = '5s'");
  assert.match(statements[2].sql, /pg_advisory_xact_lock/);
  assert.equal(statements.at(-1).sql, "COMMIT");
  assert.ok(!statements.some(({ sql }) => sql.includes("CREATE TABLE IF NOT EXISTS user_sessions")));
  assert.ok(!statements.some(({ sql }) => sql.startsWith("INSERT INTO app_schema_migrations")));
  assert.equal(ended, true);
});

test("checksum drift rejects before applying pending migrations and closes the connection", async () => {
  const statements = [];
  let ended = false;
  await assert.rejects(migrate(allowed, { createPool: () => ({
    async query(sql) {
      statements.push(sql);
      return { rows: sql.startsWith("SELECT filename") ? [{ filename: MIGRATION_FILES[0], checksum: "0".repeat(64) }] : [] };
    },
    async end() { ended = true; },
  }) }), /Applied migration changed: 001_initial.sql/);
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(!statements.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS user_workspaces")));
  assert.ok(!statements.includes("COMMIT"));
  assert.equal(ended, true);
});

test("read-only migration status reports pending, applied, and changed files without migration authorization", async () => {
  const records = await sourceRecords();
  records[1].checksum = "f".repeat(64);
  const statements = [];
  let ended = false;
  const status = await migrationStatus({ DATABASE_URL: allowed.DATABASE_URL }, { createPool: () => ({
    async query(sql) {
      statements.push(sql);
      return { rows: sql.includes("to_regclass") ? [{ present: true }] : records.slice(0, 2) };
    },
    async end() { ended = true; },
  }) });
  assert.equal(status[0].state, "applied");
  assert.equal(status[1].state, "checksum_mismatch");
  assert.equal(status[2].state, "pending");
  assert.equal(status[2].appliedAt, null);
  assert.ok(statements.every((sql) => sql.startsWith("SELECT")));
  assert.equal(ended, true);
});

test("migration status on an untracked database does not create a ledger", async () => {
  const statements = [];
  const status = await migrationStatus({ DATABASE_URL: allowed.DATABASE_URL }, { createPool: () => ({
    async query(sql) { statements.push(sql); return { rows: [{ present: false }] }; }, async end() {},
  }) });
  assert.deepEqual(status.map(({ state }) => state), MIGRATION_FILES.map(() => "pending"));
  assert.equal(statements.length, 1);
  assert.ok(statements[0].startsWith("SELECT"));
});

test("migration lock failure rolls back without retrying writes or creating a ledger", async () => {
  const statements = [];
  let ended = false;
  await assert.rejects(migrate(allowed, { createPool: () => ({
    async query(sql) {
      statements.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) throw Object.assign(new Error("fixture lock timeout"), { code: "55P03" });
      return { rows: [] };
    }, async end() { ended = true; },
  }) }), { code: "55P03" });
  assert.equal(statements.filter((sql) => sql.includes("pg_advisory_xact_lock")).length, 1);
  assert.ok(!statements.some((sql) => sql.startsWith("CREATE")));
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(ended, true);
});

test("migration connections trim configuration and require trusted TLS certificates", async () => {
  let options;
  await migrationStatus({ DATABASE_URL: `  ${allowed.DATABASE_URL}  `, DATABASE_SSL: " require " }, { createPool: (config) => {
    options = config;
    return { async query() { return { rows: [{ present: false }] }; }, async end() {} };
  } });
  assert.equal(options.connectionString, allowed.DATABASE_URL);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
});
test("migration commands reject invalid TLS configuration before connecting", async () => {
  let connected = false;
  const createPool = () => { connected = true; throw new Error("unexpected connection"); };
  await assert.rejects(migrate({ APP_ENVIRONMENT: "production", APP_ALLOW_MIGRATIONS: "true", DATABASE_URL: "postgres://fixture/app", DATABASE_SSL: "requre" }, { createPool }), /DATABASE_SSL/);
  await assert.rejects(migrationStatus({ DATABASE_URL: "postgres://fixture/app", DATABASE_SSL: "requre" }, { createPool }), /DATABASE_SSL/);
  assert.equal(connected, false);
});
