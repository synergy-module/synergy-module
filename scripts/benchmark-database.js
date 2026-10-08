import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { migrate } from "./migrate.js";
import { createPostgresBrainRepository } from "../src/agent-brain/brain-repository.js";
import { createPostgresBrokerRepository } from "../src/brokers/broker-repository.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULTS = Object.freeze({ owners: 8, runsPerOwner: 60, payloadBytes: 16_384, iterations: 200, concurrency: 8, historyLimit: 20,
  brokerSnapshots: 4, brokerSnapshotBytes: 16_384, brokerActions: 100, brokerActionBytes: 2048, brokerEvents: 200 });
const LIMITS = Object.freeze({ owners: [2, 64], runsPerOwner: [1, 100], payloadBytes: [128, 131_072], iterations: [4, 5_000], concurrency: [1, 32], historyLimit: [1, 100],
  brokerSnapshots: [0, 12], brokerSnapshotBytes: [128, 65_536], brokerActions: [0, 100], brokerActionBytes: [128, 8192], brokerEvents: [0, 200] });
const FLAGS = Object.freeze({ owners: "owners", "runs-per-owner": "runsPerOwner", "payload-bytes": "payloadBytes", iterations: "iterations", concurrency: "concurrency", "history-limit": "historyLimit",
  "broker-snapshots": "brokerSnapshots", "broker-snapshot-bytes": "brokerSnapshotBytes", "broker-actions": "brokerActions", "broker-action-bytes": "brokerActionBytes", "broker-events": "brokerEvents" });
const OWNED_TABLES = ["agent_brain_runs", "broker_tools", "broker_snapshots", "broker_actions", "broker_events", "broker_account_states", "broker_workspaces"];

function configError(message) { return Object.assign(new Error(message), { code: "BENCHMARK_CONFIG" }); }

function parseDatabaseUrl(value) {
  try {
    const parsed = new URL(value);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error();
    return parsed;
  } catch { throw configError("Provide a valid PostgreSQL benchmark URL; credentials are never printed."); }
}

function targetIdentity(url) {
  const host = LOCAL_HOSTS.has(url.hostname.toLowerCase()) ? "loopback" : url.hostname.toLowerCase();
  return `${host}:${url.port || "5432"}/${decodeURIComponent(url.pathname.slice(1))}`;
}

/** Intentionally does not load .env or fall back to the application's database. */
export function readBenchmarkConfig(env = process.env, options = {}) {
  const connectionString = env.BENCHMARK_DATABASE_URL?.trim() || env.TEST_DATABASE_URL?.trim();
  if (!connectionString) throw configError("BENCHMARK_DATABASE_URL or TEST_DATABASE_URL must explicitly identify a disposable local test database. DATABASE_URL is not accepted.");
  const url = parseDatabaseUrl(connectionString);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) throw configError("Database benchmarks are restricted to a loopback PostgreSQL host.");
  if (url.search || url.hash) throw configError("Benchmark URLs cannot contain connection override parameters or fragments.");
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(database) || !/(^|[_-])(test|bench|benchmark)([_-]|$)/i.test(database)) {
    throw configError("Use a dedicated database name containing a test, bench, or benchmark segment.");
  }
  if (env.DATABASE_URL?.trim()) {
    const applicationUrl = parseDatabaseUrl(env.DATABASE_URL.trim());
    if (targetIdentity(url) === targetIdentity(applicationUrl)) throw configError("The benchmark target matches the application's DATABASE_URL and is refused.");
  }
  for (const key of Object.keys(options)) if (!Object.hasOwn(DEFAULTS, key)) throw configError(`Unsupported benchmark option: ${key}`);
  const settings = { ...DEFAULTS, ...options };
  for (const [key, [minimum, maximum]] of Object.entries(LIMITS)) {
    if (!Number.isInteger(settings[key]) || settings[key] < minimum || settings[key] > maximum) {
      throw configError(`${key} must be an integer from ${minimum} through ${maximum}.`);
    }
  }
  const fixtureBytes = settings.owners * (settings.runsPerOwner * settings.payloadBytes + settings.brokerSnapshots * settings.brokerSnapshotBytes + settings.brokerActions * settings.brokerActionBytes + settings.brokerEvents * 256);
  if (settings.owners * settings.runsPerOwner > 5_000 || fixtureBytes > 64 * 1024 * 1024) {
    throw configError("Seed fixtures are limited to 5,000 runs and 64 MiB of synthetic trace content.");
  }
  return { connectionString, target: { host: url.hostname, port: Number(url.port || 5432), database }, settings };
}

export function summarizeMeasurements(samples, elapsedMs) {
  const sorted = samples.map((item) => item.ms).sort((left, right) => left - right);
  const percentile = (p) => sorted.length ? Number(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(3)) : null;
  const completed = samples.filter((item) => !item.error).length;
  const errorCodes = {};
  for (const item of samples.filter((sample) => sample.error)) errorCodes[item.error] = (errorCodes[item.error] ?? 0) + 1;
  return { attempted: samples.length, completed, errors: samples.length - completed, errorCodes,
    elapsedMs: Number(elapsedMs.toFixed(3)), throughputPerSecond: elapsedMs > 0 ? Number((completed / elapsedMs * 1000).toFixed(2)) : 0,
    latencyMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) === undefined ? null : Number(sorted.at(-1).toFixed(3)) } };
}

function safeCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,48}$/.test(error.code) ? error.code : "BENCHMARK_OPERATION_FAILED";
}

/** Closed-loop workload: at most concurrency repository operations are in flight. */
export async function measureStage(name, iterations, concurrency, operation) {
  const samples = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, iterations) }, async () => {
    while (next < iterations) {
      const index = next++;
      const before = performance.now();
      let error;
      try { await operation(index); } catch (caught) { error = safeCode(caught); }
      samples.push({ ms: performance.now() - before, error });
    }
  }));
  return { name, ...summarizeMeasurements(samples, performance.now() - started) };
}

function captureReadQuery(pool, record, kind = "brain") {
  const capture = (statement, parameters) => {
    const sql = typeof statement === "string" ? statement : statement?.text;
    const values = typeof statement === "string" ? parameters : statement?.values;
    const historyRead = /FROM\s+agent_brain_runs\b/i.test(sql ?? "") && !/\bid\s*=\s*\$2\b/i.test(sql ?? "");
    const brokerRead = /FROM\s+broker_workspaces\b/i.test(sql ?? "") || (/FROM\s+broker_storage_control\b/i.test(sql ?? "") && /\bAS workspace\b/i.test(sql ?? ""));
    if (!record.sql && typeof sql === "string" && /^(?:SELECT|WITH)\b/i.test(sql) && (kind === "brain" ? historyRead : brokerRead)) {
      record.sql = sql; record.values = values;
    }
  };
  return {
    query(sql, values) { capture(sql, values); return pool.query(sql, values); },
    async connect() {
      const client = await pool.connect();
      return { release: () => client.release(), async query(sql, values) {
        capture(sql, values);
        return client.query(sql, values);
      } };
    },
  };
}

const syntheticContent = (bytes) => randomBytes(Math.ceil(bytes * .75)).toString("base64").slice(0, bytes);

function syntheticRun(id, owner, bytes) {
  const content = syntheticContent(bytes);
  return { id, status: "completed", benchmarkOwner: owner, input: { symbol: "SPY", mode: "demo", provider: "gemini", objective: "Synthetic database benchmark; no market claim or model call." },
    trace: [{ at: "2026-01-01T00:00:00.000Z", type: "benchmark_fixture", agent: "researcher", summary: "Synthetic low-compressibility fixture.", details: { content } }],
    metrics: { modelCalls: 0, totalTokens: 0 } };
}

function seedBrokerWorkspace(state, owner, settings) {
  state.benchmarkCounter = 0;
  state.benchmarkOwner = owner;
  state.snapshots = Array.from({ length: settings.brokerSnapshots }, (_, index) => ({ id: `snapshot-${index}`, tool: "get_equity_quotes",
    at: "2026-01-01T00:00:00.000Z", result: { fixture: true, content: syntheticContent(settings.brokerSnapshotBytes) } }));
  state.actions = Array.from({ length: settings.brokerActions }, (_, index) => ({ id: `action-${index}`, requestId: `fixture-${index}`, version: 1,
    status: "rejected", tool: "place_equity_order", reason: "Synthetic rejected request; no order submitted.",
    arguments: { benchmarkFixture: true }, preview: { content: syntheticContent(settings.brokerActionBytes) } }));
  state.events = Array.from({ length: settings.brokerEvents }, (_, index) => ({ id: `fixture-${index}`, type: "benchmark_fixture",
    at: "2026-01-01T00:00:00.000Z", summary: "Synthetic broker audit; no order submitted. Exact task-owned fixture for database benchmarking." }));
}

function compactPlan(value) {
  const nodes = [];
  const visit = (node) => {
    nodes.push({ type: node["Node Type"], relation: node["Relation Name"] ?? null, index: node["Index Name"] ?? null, rows: node["Actual Rows"], loops: node["Actual Loops"],
      estimatedRows: node["Plan Rows"], actualTotalMs: node["Actual Total Time"],
      sharedHitBlocks: node["Shared Hit Blocks"] ?? 0, sharedReadBlocks: node["Shared Read Blocks"] ?? 0 });
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(value.Plan);
  return { planningMs: value["Planning Time"], executionMs: value["Execution Time"], nodes };
}

// Optional factories allow a like-for-like comparison with immutable historical
// repository source. Target validation still runs before any factory is called.
export async function runDatabaseBenchmark({ env = process.env, options = {},
  repositoryFactories = { brain: createPostgresBrainRepository, broker: createPostgresBrokerRepository }, implementationLabel = "working-tree" } = {}) {
  const { connectionString, target, settings } = readBenchmarkConfig(env, options);
  const benchmarkId = randomUUID();
  const owners = Array.from({ length: settings.owners }, (_, index) => `benchmark:${benchmarkId}:${index}`);
  const prefix = `benchmark:${benchmarkId}:`;
  assert.ok(owners.every((owner) => owner.startsWith(prefix)), "Cleanup must only target this run's exact owners");
  const pool = new pg.Pool({ connectionString, ssl: false, max: Math.min(settings.concurrency, 16),
    connectionTimeoutMillis: 5_000, idleTimeoutMillis: 5_000, statement_timeout: 10_000, lock_timeout: 5_000,
    application_name: "synergy-module-database-benchmark" });
  const poolErrors = [];
  pool.on("error", (error) => { poolErrors.push(safeCode(error)); });
  const historyQuery = {}, brokerQuery = {};
  const brain = repositoryFactories.brain(captureReadQuery(pool, historyQuery));
  const broker = repositoryFactories.broker(captureReadQuery(pool, brokerQuery, "broker"));
  const started = performance.now();
  const deadline = Date.now() + 180_000;
  let seeded = false, report;
  const checkDeadline = () => {
    if (Date.now() > deadline) throw Object.assign(new Error("Benchmark exceeded its three-minute runtime limit."), { code: "BENCHMARK_DEADLINE" });
  };
  try {
    const metadata = await pool.query("SELECT current_database() AS name, current_setting('server_version') AS version");
    assert.equal(metadata.rows[0].name, target.database, "Connected database must match the validated disposable target");
    await migrate({ DATABASE_URL: connectionString, APP_ENVIRONMENT: "production", APP_ALLOW_MIGRATIONS: "true" }, {
      createPool: (config) => new pg.Pool({ ...config, connectionTimeoutMillis: 5_000, statement_timeout: 15_000, lock_timeout: 5_000, application_name: "synergy-module-benchmark-migration" }),
    });
    seeded = true;
    const brokerStorageMode = (await pool.query("SELECT mode FROM broker_storage_control WHERE singleton=true")).rows[0].mode;
    const seedStarted = performance.now();
    const seed = await measureStage("seed", owners.length, Math.min(settings.concurrency, owners.length), async (ownerIndex) => {
      const owner = owners[ownerIndex];
      for (let index = 0; index < settings.runsPerOwner; index += 1) {
        checkDeadline();
        await brain.saveRun(owner, syntheticRun(`seed-${String(index).padStart(4, "0")}`, owner, settings.payloadBytes));
      }
      await broker.update(owner, (state) => seedBrokerWorkspace(state, owner, settings));
    });
    if (seed.errors) throw Object.assign(new Error("Unable to seed benchmark fixtures."), { code: "BENCHMARK_SEED_FAILED" });
    const seedElapsedMs = Number((performance.now() - seedStarted).toFixed(3));
    // Planner statistics and warmup occur only on the validated disposable database.
    for (const table of OWNED_TABLES) await pool.query(`ANALYZE ${table}`);
    delete historyQuery.sql; delete historyQuery.values;
    delete brokerQuery.sql; delete brokerQuery.values;
    for (let index = 0; index < Math.min(20, settings.iterations); index += 1) {
      await brain.listRuns(owners[index % owners.length], { limit: settings.historyLimit });
      await broker.read(owners[index % owners.length]);
    }
    const stages = [];
    const stage = async (name, operation) => {
      checkDeadline();
      stages.push(await measureStage(name, settings.iterations, settings.concurrency, async (index) => { checkDeadline(); await operation(index); }));
    };
    await stage("brain_history_read", async (index) => {
      const owner = owners[index % owners.length];
      const runs = await brain.listRuns(owner, { limit: settings.historyLimit });
      assert.equal(runs.length, Math.min(settings.historyLimit, settings.runsPerOwner));
      assert.ok(runs.every((run) => run.benchmarkOwner === owner));
    });
    const planResult = historyQuery.sql ? await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${historyQuery.sql}`, historyQuery.values) : null;
    await stage("brain_write_multiple_owners", async (index) => {
      const owner = owners[index % owners.length];
      const run = await brain.saveRun(owner, syntheticRun(`mixed-${index}`, owner, settings.payloadBytes));
      assert.equal(run.version, 1);
    });
    await stage("brain_write_same_owner", async (index) => {
      const run = await brain.saveRun(owners[0], syntheticRun(`hot-${index}`, owners[0], settings.payloadBytes));
      assert.equal(run.version, 1);
    });
    await stage("broker_workspace_read", async (index) => {
      const owner = owners[index % owners.length];
      const state = await broker.read(owner);
      assert.equal(state.benchmarkOwner, owner);
      assert.equal(state.snapshots.length, settings.brokerSnapshots);
      assert.equal(state.actions.length, settings.brokerActions);
      assert.equal(state.events.length, settings.brokerEvents);
    });
    const brokerPlanResult = brokerQuery.sql ? await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${brokerQuery.sql}`, brokerQuery.values) : null;
    const expectedCounters = new Map(owners.map((owner) => [owner, 0]));
    const increment = async (owner) => {
      await broker.update(owner, (state) => { state.benchmarkCounter += 1; });
      expectedCounters.set(owner, expectedCounters.get(owner) + 1);
    };
    await stage("broker_update_multiple_owners", (index) => increment(owners[index % owners.length]));
    await stage("broker_update_same_owner", () => increment(owners[0]));
    for (const owner of owners) assert.equal((await broker.read(owner)).benchmarkCounter, expectedCounters.get(owner), "Concurrent broker updates must not be lost");
    const original = await broker.read(owners[0]);
    await assert.rejects(broker.update(owners[0], (state) => { state.benchmarkCounter = -1; throw new Error("benchmark rollback fixture"); }), /benchmark rollback fixture/);
    assert.deepEqual(await broker.read(owners[0]), original, "Rejected broker mutations must roll back");
    assert.equal(await brain.getRun(owners[1], "hot-0"), null, "Runs must remain tenant scoped");
    const rows = await pool.query("SELECT count(*)::integer AS count FROM agent_brain_runs WHERE owner_id=ANY($1::text[])", [owners]);
    assert.ok((await brain.listRuns(owners[0], { limit: settings.historyLimit })).length <= settings.historyLimit, "History pages must remain bounded without pruning audit records");
    report = { benchmarkId, implementation: String(implementationLabel).slice(0, 160), brokerStorageMode, target, postgresVersion: metadata.rows[0].version, settings,
      fixture: { owners: owners.length, seededRuns: owners.length * settings.runsPerOwner, retainedRunsAfterWrites: rows.rows[0].count, traceBytesPerRun: settings.payloadBytes,
        brokerEventsPerOwner: settings.brokerEvents, brokerSnapshotsPerOwner: settings.brokerSnapshots, brokerActionsPerOwner: settings.brokerActions,
        brokerSnapshotBytes: settings.brokerSnapshotBytes, brokerActionBytes: settings.brokerActionBytes,
        observedBrokerWorkspaceBytes: Buffer.byteLength(JSON.stringify(original)), seedElapsedMs,
        distribution: "Synthetic low-compressibility trace payloads; completed runs only; real repository retention and locks." },
      stages, historyQueryPlan: planResult ? compactPlan(planResult.rows[0]["QUERY PLAN"][0]) : null,
      brokerReadQueryPlan: brokerPlanResult ? compactPlan(brokerPlanResult.rows[0]["QUERY PLAN"][0]) : null,
      integrity: { tenantIsolation: true, brokerAtomicUpdates: true, brokerRollback: true, historyPageBound: true },
      totalErrors: stages.reduce((total, current) => total + current.errors, 0) + poolErrors.length, poolErrors,
      latencyDefinition: "End-to-end fixture operation latency, including payload generation and validation, repository work, client-pool wait and transaction lock wait; all attempts included; warmup and seeding excluded.",
      limitations: ["Local synthetic closed-loop workload, not production capacity or a latency guarantee.", "Hot-owner contention is measured separately from multiple-owner throughput.", "Broker mutations change compact owner metadata while retaining configured snapshots, rejected actions, and audit events; archived-history and tool-catalog growth are not measured.", "No model, market-data, or broker network calls; no application user records are used.", "No cold-cache, multi-host, outage, or sustained saturation claim."], cleanup: null };
  } finally {
    try {
      if (seeded) {
        let deletedRows = 0;
        // Table identifiers are fixed here; owner values are bound, never prefix deletes.
        for (const table of OWNED_TABLES) deletedRows += (await pool.query(`DELETE FROM ${table} WHERE owner_id=ANY($1::text[])`, [owners])).rowCount;
        let remainingRows = 0;
        for (const table of OWNED_TABLES) remainingRows += Number((await pool.query(`SELECT count(*) AS count FROM ${table} WHERE owner_id=ANY($1::text[])`, [owners])).rows[0].count);
        assert.equal(remainingRows, 0, "Only this run's owned fixtures must be removed");
        if (report) report.cleanup = { deletedRows, remainingRows, ownersRemoved: owners.length };
      }
    } finally { await Promise.allSettled([brain.close(), broker.close()]); await pool.end(); }
  }
  report.elapsedMs = Number((performance.now() - started).toFixed(3));
  return report;
}

function cliOptions(args) {
  const options = {};
  for (const argument of args) {
    const match = /^--([a-z-]+)=([0-9]+)$/.exec(argument);
    if (!match || !FLAGS[match[1]]) throw configError(`Options use ${Object.keys(FLAGS).map((flag) => `--${flag}=N`).join(", ")}.`);
    options[FLAGS[match[1]]] = Number(match[2]);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) {
    console.log(`Set BENCHMARK_DATABASE_URL (or TEST_DATABASE_URL) to an isolated loopback database such as synergy_module_benchmark, then run node scripts/benchmark-database.js. Optional arguments: ${Object.keys(FLAGS).map((flag) => `--${flag}=${DEFAULTS[FLAGS[flag]]}`).join(" ")}. Never use the application's database. The existing broker storage mode is reported and remains unchanged. A JSON report is printed; fixtures are cleaned up automatically.`);
  } else {
    Promise.resolve().then(() => runDatabaseBenchmark({ options: cliOptions(process.argv.slice(2)) })).then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.totalErrors) process.exitCode = 1;
    }, (error) => {
      console.error(JSON.stringify({ error: safeCode(error), message: error.code === "BENCHMARK_CONFIG" ? error.message : "Benchmark failed. Check the isolated database and migration setup; credentials and raw database errors are omitted." }));
      process.exitCode = 1;
    });
  }
}
