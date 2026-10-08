import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import pg from "pg";
import { readDatabaseConfig } from "../src/config/database-config.js";

export const MIGRATION_FILES = Object.freeze([
  "001_initial.sql", "002_agent_brain.sql", "003_admin_persistence.sql", "004_robinhood.sql",
  "005_user_workspaces.sql", "006_brain_query_indexes.sql", "007_broker_records.sql",
]);

async function migrationSources() {
  return Promise.all(MIGRATION_FILES.map(async (filename) => {
    const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8");
    // Git checkouts can use CRLF or LF; line-ending conversion is not a schema change.
    const checksum = createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
    return { filename, sql, checksum };
  }));
}

function poolOptions(env) {
  const config = readDatabaseConfig({ env, nodeEnvironment: "production" });
  return { connectionString: config.connectionString,
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    max: 1, application_name: "synergy-module-migration", connectionTimeoutMillis: 5000,
    statement_timeout: 120000, idle_in_transaction_session_timeout: 120000 };
}

export function assertMigrationAllowed(env = process.env) {
  if (env.APP_ENVIRONMENT !== "production") throw new Error("Migrations are allowed only in production");
  if (env.APP_ALLOW_MIGRATIONS !== "true") throw new Error("APP_ALLOW_MIGRATIONS must be true");
  if (!env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required");
}

export async function migrate(env = process.env, { createPool = (options) => new pg.Pool(options) } = {}) {
  assertMigrationAllowed(env);
  const sources = await migrationSources();
  const pool = createPool(poolOptions(env));
  const applied = [], skipped = [];
  try {
    await pool.query("BEGIN");
    await pool.query("SET LOCAL lock_timeout = '5s'");
    await pool.query("SELECT pg_advisory_xact_lock(1869440357, 1)");
    await pool.query(`CREATE TABLE IF NOT EXISTS app_schema_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL CHECK(length(checksum)=64),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const records = new Map(((await pool.query("SELECT filename, checksum FROM app_schema_migrations"))?.rows ?? [])
      .map((row) => [row.filename, row.checksum]));
    for (const { filename, sql, checksum } of sources) {
      if (records.has(filename)) {
        if (records.get(filename) !== checksum) throw new Error(`Applied migration changed: ${filename}. Restore the original file and add a new migration.`);
        skipped.push(filename);
        continue;
      }
      await pool.query(sql);
      await pool.query("INSERT INTO app_schema_migrations(filename,checksum) VALUES($1,$2)", [filename, checksum]);
      applied.push(filename);
    }
    await pool.query("COMMIT");
    return { applied, skipped };
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await pool.end();
  }
}

export async function migrationStatus(env = process.env, { createPool = (options) => new pg.Pool(options) } = {}) {
  if (!env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required");
  const sources = await migrationSources();
  const pool = createPool(poolOptions(env));
  try {
    const exists = (await pool.query("SELECT to_regclass('public.app_schema_migrations') IS NOT NULL AS present")).rows[0].present;
    const records = exists ? (await pool.query("SELECT filename,checksum,applied_at FROM app_schema_migrations ORDER BY filename")).rows : [];
    return sources.map(({ filename, checksum }) => {
      const record = records.find((row) => row.filename === filename);
      return { filename, state: !record ? "pending" : record.checksum === checksum ? "applied" : "checksum_mismatch", appliedAt: record?.applied_at ?? null };
    });
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (process.argv.includes("--status") ? migrationStatus() : migrate()).then(
    (result) => console.log(JSON.stringify({ message: process.argv.includes("--status") ? "SYNERGY MODULE migration status" : "SYNERGY MODULE database migration completed", result })),
    (error) => { console.error(`SYNERGY MODULE database migration failed: ${error.message}`); process.exitCode = 1; },
  );
}
