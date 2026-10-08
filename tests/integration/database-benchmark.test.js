import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../scripts/migrate.js";
import { createPostgresBrokerRepository } from "../../src/brokers/broker-repository.js";
import { readBenchmarkConfig, summarizeMeasurements, measureStage, runDatabaseBenchmark } from "../../scripts/benchmark-database.js";

const fixtureUrl = "postgresql://fixture:never-printed@127.0.0.1:5433/synergy_module_benchmark";

test("database benchmark refuses application, remote, unnamed, and override targets", () => {
  assert.throws(() => readBenchmarkConfig({ DATABASE_URL: fixtureUrl }), /DATABASE_URL is not accepted/);
  assert.throws(() => readBenchmarkConfig({ BENCHMARK_DATABASE_URL: fixtureUrl, DATABASE_URL: fixtureUrl.replace("127.0.0.1", "localhost").replace("never-printed", "other") }), /matches the application's/);
  assert.throws(() => readBenchmarkConfig({ TEST_DATABASE_URL: fixtureUrl.replace("127.0.0.1", "database.example.com") }), /loopback/);
  assert.throws(() => readBenchmarkConfig({ TEST_DATABASE_URL: fixtureUrl.replace("synergy_module_benchmark", "synergy-module") }), /dedicated database name/);
  assert.throws(() => readBenchmarkConfig({ TEST_DATABASE_URL: `${fixtureUrl}?host=database.example.com` }), /override parameters/);
  const config = readBenchmarkConfig({ TEST_DATABASE_URL: fixtureUrl });
  assert.equal(config.target.database, "synergy_module_benchmark");
  assert.equal(JSON.stringify(config.target).includes("never-printed"), false);
});

test("database benchmark bounds fixture volume, concurrency, and sample count", () => {
  const env = { TEST_DATABASE_URL: fixtureUrl };
  assert.throws(() => readBenchmarkConfig(env, { runsPerOwner: 101 }), /runsPerOwner/);
  assert.throws(() => readBenchmarkConfig(env, { concurrency: 33 }), /concurrency/);
  assert.throws(() => readBenchmarkConfig(env, { iterations: 0 }), /iterations/);
  assert.throws(() => readBenchmarkConfig(env, { brokerSnapshots: 13 }), /brokerSnapshots/);
  assert.throws(() => readBenchmarkConfig(env, { brokerSnapshotBytes: 65_537 }), /brokerSnapshotBytes/);
  assert.throws(() => readBenchmarkConfig(env, { brokerActions: 101 }), /brokerActions/);
  assert.throws(() => readBenchmarkConfig(env, { brokerEvents: 201 }), /brokerEvents/);
  assert.throws(() => readBenchmarkConfig(env, { owners: 64, runsPerOwner: 100, payloadBytes: 131_072 }), /64 MiB/);
  assert.throws(() => readBenchmarkConfig(env, { connectionString: fixtureUrl }), /Unsupported/);
});

test("benchmark percentiles and counts include errors without disclosing error messages", async () => {
  assert.deepEqual(summarizeMeasurements(Array.from({ length: 100 }, (_, index) => ({ ms: index + 1 })), 1000), {
    attempted: 100, completed: 100, errors: 0, errorCodes: {}, elapsedMs: 1000, throughputPerSecond: 100,
    latencyMs: { p50: 50, p95: 95, p99: 99, max: 100 },
  });
  let running = 0, peak = 0;
  const measured = await measureStage("fixture", 8, 3, async (index) => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((resolve) => setImmediate(resolve));
    running -= 1;
    if (index === 2) throw Object.assign(new Error("postgresql://private:credential@host/db"), { code: "40001" });
  });
  assert.equal(peak, 3);
  assert.equal(measured.attempted, 8);
  assert.equal(measured.completed, 7);
  assert.deepEqual(measured.errorCodes, { "40001": 1 });
  assert.equal(JSON.stringify(measured).includes("credential"), false);
});

test("isolated PostgreSQL benchmark exercises repositories and removes only its fixtures", {
  skip: !(process.env.BENCHMARK_DATABASE_URL || process.env.TEST_DATABASE_URL), timeout: 120_000,
}, async (t) => {
  const config = readBenchmarkConfig(process.env, { owners: 3, runsPerOwner: 12, payloadBytes: 2048, iterations: 24, concurrency: 4, historyLimit: 5,
    brokerSnapshots: 2, brokerSnapshotBytes: 1024, brokerActions: 10, brokerActionBytes: 256, brokerEvents: 20 });
  const pool = new pg.Pool({ connectionString: config.connectionString, ssl: false, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  const broker = createPostgresBrokerRepository(pool);
  const sentinel = `benchmark-sentinel:${randomUUID()}`;
  let migrated = false;
  t.after(async () => {
    try { if (migrated) {
      await pool.query("DELETE FROM broker_account_states WHERE owner_id=$1", [sentinel]);
      await pool.query("DELETE FROM broker_workspaces WHERE owner_id=$1", [sentinel]);
    } }
    finally { await pool.end(); }
  });
  await migrate({ DATABASE_URL: config.connectionString, APP_ENVIRONMENT: "production", APP_ALLOW_MIGRATIONS: "true" });
  migrated = true;
  await broker.update(sentinel, (state) => { state.marker = "unrelated fixture retained"; });
  const report = await runDatabaseBenchmark({ env: process.env, options: config.settings });
  assert.equal(report.totalErrors, 0);
  assert.equal(report.stages.length, 6);
  assert.ok(report.stages.every((stage) => stage.attempted === 24 && stage.completed === 24 && stage.errors === 0));
  assert.ok(report.stages.every((stage) => stage.latencyMs.p99 >= stage.latencyMs.p50));
  assert.deepEqual(report.integrity, { tenantIsolation: true, brokerAtomicUpdates: true, brokerRollback: true, historyPageBound: true });
  assert.ok(report.historyQueryPlan.nodes.length > 0);
  assert.ok(report.brokerReadQueryPlan.nodes.length > 0);
  assert.equal(report.cleanup.remainingRows, 0);
  assert.equal(report.cleanup.ownersRemoved, 3);
  assert.equal(report.fixture.brokerActionsPerOwner, 10);
  assert.equal(report.fixture.brokerSnapshotsPerOwner, 2);
  assert.ok(report.fixture.observedBrokerWorkspaceBytes > 4608);
  assert.equal((await broker.read(sentinel)).marker, "unrelated fixture retained");
  assert.equal(JSON.stringify(report).includes(config.connectionString), false);
});
