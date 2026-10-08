import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { readDatabaseConfig } from "../src/config/database-config.js";

// Read-only deployment diagnostics. Never emits URLs, SQL parameters, or stored account data.
export async function inspectDatabase(env = process.env) {
  const config = readDatabaseConfig({ env, nodeEnvironment: "production" });
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 1,
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    application_name: "synergy-module-diagnostics", connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    const settings = (await pool.query(`SELECT current_setting('server_version') AS version,
      current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit,
      current_setting('shared_buffers') AS shared_buffers, current_setting('max_connections') AS max_connections,
      pg_database_size(current_database())::text AS database_bytes`)).rows[0];
    const tables = (await pool.query(`SELECT relname AS name, n_live_tup::text AS estimated_rows,
      pg_total_relation_size(relid)::text AS bytes FROM pg_stat_user_tables
      WHERE schemaname='public' ORDER BY relname`)).rows;
    const connections = (await pool.query(`SELECT application_name, state, count(*)::int AS connections
      FROM pg_stat_activity WHERE datname=current_database() GROUP BY application_name,state ORDER BY application_name,state`)).rows;
    const timings = [];
    // Warm pooled round trips only. This is a connectivity baseline, not a load benchmark.
    for (let index = 0; index < 10; index++) {
      const start = performance.now();
      await pool.query("SELECT 1");
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const schema = tables.some((table) => table.name === "app_schema_migrations")
      ? (await pool.query("SELECT filename,applied_at FROM app_schema_migrations ORDER BY filename")).rows : [];
    return { checkedAt: new Date().toISOString(), settings, tables, connections, schema,
      pooledRoundTripMs: { samples: timings.length, p50: +timings[4].toFixed(3), maximum: +timings.at(-1).toFixed(3) },
      measurementScope: "Ten sequential SELECT 1 queries from this process; no trade or throughput claim." };
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  inspectDatabase().then((report) => console.log(JSON.stringify(report, null, 2)), () => {
    console.error("Database diagnostics failed. Check connectivity, credentials, TLS and PostgreSQL logs."); process.exitCode = 1;
  });
}
