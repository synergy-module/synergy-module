import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { migrate, migrationStatus, MIGRATION_FILES } from "../../scripts/migrate.js";
import { createPostgresRuntime } from "../../src/runtime/postgres-runtime.js";

// Requires a disposable PostgreSQL test account with CREATEDB. Every mutation
// occurs in this test's fresh database, including migration rollback fixtures.
test("PostgreSQL migration ledger adopts old schemas, serializes upgrades, and rejects drift", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const name = `synergy_module_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const databaseUrl = url.href;
  const control = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const env = { DATABASE_URL: databaseUrl, APP_ENVIRONMENT: "production", APP_ALLOW_MIGRATIONS: "true" };
  t.after(async () => {
    await control.end();
    assert.match(name, /^synergy_module_migration_[a-f0-9]{32}$/);
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  });
  const tables = async () => (await control.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;

  await t.test("status on an empty database creates nothing", async () => {
    assert.deepEqual((await migrationStatus({ DATABASE_URL: databaseUrl })).map((row) => row.state), MIGRATION_FILES.map(() => "pending"));
    assert.deepEqual(await tables(), []);
  });

  await t.test("late failure rolls back every pending schema and ledger write", async () => {
    await assert.rejects(migrate(env, { createPool: (options) => {
      const pool = new pg.Pool(options);
      return { async query(sql, values) {
        if (sql.includes("CREATE TABLE IF NOT EXISTS broker_storage_control")) throw new Error("fixture final migration failed");
        return pool.query(sql, values);
      }, end: () => pool.end() };
    } }), /fixture final migration failed/);
    assert.deepEqual(await tables(), [], "DDL and migration records must roll back together");
  });

  await t.test("untracked migrations 001-004 adopt safely and concurrent runners apply once", async () => {
    for (const file of MIGRATION_FILES.slice(0, 4)) {
      await control.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
    }
    await control.query("INSERT INTO broker_workspaces(owner_id,payload) VALUES($1,$2)", ["legacy-owner", { marker: "retain existing broker state", events: [] }]);
    let releaseFirst;
    const release = new Promise((resolve) => { releaseFirst = resolve; });
    let firstLocked;
    const locked = new Promise((resolve) => { firstLocked = resolve; });
    let secondSubmitted;
    const submitted = new Promise((resolve) => { secondSubmitted = resolve; });
    const first = migrate(env, { createPool: (options) => {
      const pool = new pg.Pool(options);
      return { async query(sql, values) {
        const result = await pool.query(sql, values);
        if (sql.includes("pg_advisory_xact_lock")) { firstLocked(); await release; }
        return result;
      }, end: () => pool.end() };
    } });
    await locked;
    let secondFinished = false;
    const second = migrate(env, { createPool: (options) => {
      const pool = new pg.Pool(options);
      return { query(sql, values) {
        if (sql.includes("pg_advisory_xact_lock")) secondSubmitted();
        return pool.query(sql, values);
      }, end: () => pool.end() };
    } }).finally(() => { secondFinished = true; });
    try {
      await submitted;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(secondFinished, false, "second runner must wait for the migration lock");
    } finally { releaseFirst(); }
    const results = await Promise.all([first, second]);
    assert.deepEqual(results[0], { applied: MIGRATION_FILES, skipped: [] });
    assert.deepEqual(results[1], { applied: [], skipped: MIGRATION_FILES });
    assert.deepEqual((await control.query("SELECT payload FROM broker_workspaces WHERE owner_id=$1", ["legacy-owner"])).rows[0].payload,
      { marker: "retain existing broker state", events: [] });
    assert.equal((await control.query("SELECT count(*)::int AS count FROM app_schema_migrations")).rows[0].count, MIGRATION_FILES.length);
    assert.deepEqual((await migrationStatus(env)).map((row) => row.state), MIGRATION_FILES.map(() => "applied"));
  });

  await t.test("changed checksum is visible in status and prevents writes; restore permits repeat", async () => {
    const before = (await control.query("SELECT filename,checksum,applied_at FROM app_schema_migrations ORDER BY filename")).rows;
    await control.query("UPDATE app_schema_migrations SET checksum=$1 WHERE filename=$2", ["0".repeat(64), MIGRATION_FILES[0]]);
    const status = await migrationStatus(env);
    assert.equal(status[0].state, "checksum_mismatch");
    await assert.rejects(migrate(env), /Applied migration changed: 001_initial.sql/);
    await control.query("UPDATE app_schema_migrations SET checksum=$1 WHERE filename=$2", [before[0].checksum, MIGRATION_FILES[0]]);
    assert.deepEqual(await migrate(env), { applied: [], skipped: MIGRATION_FILES });
    assert.deepEqual((await control.query("SELECT filename,checksum,applied_at FROM app_schema_migrations ORDER BY filename")).rows, before);
  });

  await t.test("runtime readiness requires broker storage control along with normalized records", async () => {
    const runtime = createPostgresRuntime({ configured: true, connectionString: databaseUrl, ssl: false });
    try {
      assert.equal(await runtime.readinessCheck(), true);
      await control.query("ALTER TABLE broker_storage_control RENAME TO broker_storage_control_fixture_missing");
      try { assert.equal(await runtime.readinessCheck(), false); }
      finally { await control.query("ALTER TABLE broker_storage_control_fixture_missing RENAME TO broker_storage_control"); }
      assert.equal(await runtime.readinessCheck(), true);
    } finally { await runtime.close(); }
  });
});
