import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createPostgresBrokerRepository, emptyBrokerWorkspace } from "../../src/brokers/broker-repository.js";
import { setBrokerStorageMode } from "../../scripts/broker-storage-mode.js";
import { robinhoodHarness, sampleOrder } from "../helpers/robinhood-test-helpers.js";

// These tests require an explicitly supplied disposable PostgreSQL instance.
// Isolated schemas allow other integration suites to run without mode conflicts.
async function fixture(t) {
  const schema = `broker_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  for (const name of ["004_robinhood.sql", "007_broker_records.sql"]) {
    await pool.query(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  }
  return { pool, repository: createPostgresBrokerRepository(pool) };
}
const options = { skip: !process.env.TEST_DATABASE_URL };

test("broker cutover preserves legacy workspaces and is reversible without discarding archives", options, async (t) => {
  const { pool, repository } = await fixture(t);
  const legacy = { ...emptyBrokerWorkspace(), connection: { id: "connected", sealed: { data: "encrypted-fixture" } }, paused: false,
    tools: [{ name: "get_accounts", inputSchema: { type: "object" } }], snapshots: [{ id: "snapshot", result: { amount: 12 } }],
    actions: [{ id: "approval", requestId: "request-001", status: "awaiting_approval", version: 1 }],
    events: [{ id: "event-2", event: "latest" }, { id: "event-1", event: "earliest" }] };
  await pool.query("INSERT INTO broker_workspaces(owner_id,payload) VALUES($1,$2)", ["alice", legacy]);
  assert.deepEqual(await repository.read("alice"), legacy);
  await repository.update("alice", (state) => { state.marker = "legacy-write"; });
  legacy.marker = "legacy-write";
  assert.equal((await pool.query("SELECT mode FROM broker_storage_control")).rows[0].mode, "legacy");
  assert.deepEqual(await setBrokerStorageMode(pool, "normalized"), { mode: "normalized", changed: true });
  assert.deepEqual(await repository.read("alice"), legacy);
  assert.deepEqual(await repository.read("bob"), emptyBrokerWorkspace());
  await assert.rejects(pool.query("UPDATE broker_workspaces SET updated_at=now() WHERE owner_id='alice'"), { code: "55000" });
  // Re-running the additive migration does not silently downgrade a live cutover.
  await pool.query(await readFile(new URL("../../migrations/007_broker_records.sql", import.meta.url), "utf8"));
  assert.deepEqual(await setBrokerStorageMode(pool, "normalized"), { mode: "normalized", changed: false });
  await repository.update("alice", (state) => { state.marker = "normalized-write"; state.events = [{ id: "event-3", event: "new" }]; });
  const normalized = await repository.read("alice");
  assert.equal((await pool.query("SELECT count(*) FROM broker_events WHERE owner_id='alice'")).rows[0].count, "3");
  await setBrokerStorageMode(pool, "legacy");
  assert.deepEqual((await pool.query("SELECT payload FROM broker_workspaces WHERE owner_id='alice'")).rows[0].payload, normalized);
  await repository.update("alice", (state) => { state.paused = true; });
  await setBrokerStorageMode(pool, "normalized");
  assert.equal((await repository.read("alice")).paused, true);
  assert.equal((await pool.query("SELECT count(*) FROM broker_events WHERE owner_id='alice'")).rows[0].count, "3");
});

test("normalized broker writes retain history, avoid unchanged payload writes and serialize owners", options, async (t) => {
  const { pool, repository } = await fixture(t);
  await setBrokerStorageMode(pool, "normalized");
  await repository.update("alice", (state) => {
    state.counter = 0;
    state.actions = Array.from({ length: 100 }, (_, index) => ({ id: `a-${index}`, requestId: `r-${index}`, status: "submitted", version: 2 }));
    state.events = Array.from({ length: 200 }, (_, index) => ({ id: `e-${index}`, event: "fixture" }));
    state.snapshots = [{ id: "old-snapshot" }];
  });
  const originalVersion = (await pool.query("SELECT xmin::text AS version FROM broker_actions WHERE owner_id='alice' AND id='a-0'")).rows[0].version;
  await repository.update("alice", (state) => {
    state.actions = [{ id: "a-new", status: "submitted", requestId: "r-new" }, ...state.actions].slice(0, 100);
    state.events = [{ id: "e-new", event: "fixture" }, ...state.events].slice(0, 200);
    state.snapshots = [{ id: "new-snapshot" }];
  });
  assert.equal((await pool.query("SELECT xmin::text AS version FROM broker_actions WHERE owner_id='alice' AND id='a-0'")).rows[0].version, originalVersion);
  assert.equal((await pool.query("SELECT count(*) FROM broker_actions WHERE owner_id='alice'")).rows[0].count, "101");
  assert.equal((await pool.query("SELECT count(*) FROM broker_events WHERE owner_id='alice'")).rows[0].count, "201");
  assert.deepEqual((await pool.query("SELECT id FROM broker_snapshots WHERE owner_id='alice'")).rows, [{ id: "new-snapshot" }]);
  assert.equal((await repository.read("alice")).actions.length, 100);
  await assert.rejects(repository.update("alice", (state) => {
    state.actions = [{ id: "duplicate-request", requestId: "r-99", status: "awaiting_approval" }, ...state.actions].slice(0, 100);
  }), { code: "ROBINHOOD_CONFLICT" });
  await Promise.all(Array.from({ length: 8 }, () => repository.update("alice", (state) => { state.counter++; })));
  assert.equal((await repository.read("alice")).counter, 8);
  await assert.rejects(repository.update("alice", (state) => { state.counter = 999; throw new Error("abort"); }), /abort/);
  await assert.rejects(repository.update("alice", async (state) => { state.counter = 999; }), /cannot contain asynchronous work/);
  assert.equal((await repository.read("alice")).counter, 8);
  await repository.update("alice", (state) => { state.actions[0].status = "unknown"; });
  await assert.rejects(repository.update("alice", (state) => { state.actions.shift(); }), /Unresolved broker actions/);
});

test("PostgreSQL normalized broker claims allow one approval dispatch across repository instances", options, async (t) => {
  const { pool, repository } = await fixture(t);
  await setBrokerStorageMode(pool, "normalized");
  const first = robinhoodHarness({ repository, liveEnabled: true });
  const second = robinhoodHarness({ repository: createPostgresBrokerRepository(pool), liveEnabled: true });
  await first.connect();
  await first.service.pause("owner", false);
  const action = await first.service.propose("owner", sampleOrder());
  const decisions = await Promise.allSettled([first, second].map((h) => h.service.decide("owner", action.id, { decision: "approve", version: 1 })));
  assert.equal(decisions.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal([...first.invocations, ...second.invocations].filter((item) => item.name === "place_equity_order").length, 1);
  assert.equal((await repository.read("owner")).actions[0].status, "submitted");
  await assert.rejects(second.service.decide("owner", action.id, { decision: "approve", version: 1 }), { code: "ROBINHOOD_CONFLICT" });
});

test("malformed legacy records roll back cutover and leave old applications writable", options, async (t) => {
  const { pool } = await fixture(t);
  await pool.query("INSERT INTO broker_workspaces(owner_id,payload) VALUES($1,$2)", ["malformed", { ...emptyBrokerWorkspace(), actions: [{ status: "unknown" }] }]);
  await assert.rejects(setBrokerStorageMode(pool, "normalized"), /Invalid or duplicate/);
  assert.equal((await pool.query("SELECT mode FROM broker_storage_control")).rows[0].mode, "legacy");
  assert.equal((await pool.query("SELECT count(*) FROM broker_account_states")).rows[0].count, "0");
  await pool.query("UPDATE broker_workspaces SET updated_at=now() WHERE owner_id='malformed'");
});

test("cutover waits for an in-flight old writer and copies its final committed state", options, async (t) => {
  const { pool, repository } = await fixture(t);
  const oldWriter = await pool.connect();
  let reachedLock;
  const lockAttempted = new Promise((resolve) => { reachedLock = resolve; });
  const cutoverPool = { async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), async query(sql, values) {
      const pending = client.query(sql, values);
      if (sql === "LOCK TABLE broker_workspaces IN ACCESS EXCLUSIVE MODE") reachedLock();
      return pending;
    } };
  } };
  try {
    await oldWriter.query("BEGIN");
    await oldWriter.query("INSERT INTO broker_workspaces(owner_id,payload) VALUES($1,$2)", ["writer", { ...emptyBrokerWorkspace(), marker: "before" }]);
    const transition = setBrokerStorageMode(cutoverPool, "normalized");
    await lockAttempted;
    await oldWriter.query("UPDATE broker_workspaces SET payload=jsonb_set(payload,'{marker}','\"committed-late\"') WHERE owner_id='writer'");
    await oldWriter.query("COMMIT");
    await transition;
    assert.equal((await repository.read("writer")).marker, "committed-late");
    await assert.rejects(oldWriter.query("UPDATE broker_workspaces SET updated_at=now() WHERE owner_id='writer'"), { code: "55000" });
  } finally { await oldWriter.query("ROLLBACK").catch(() => {}); oldWriter.release(); }
});

test("normalized concurrent first writes create one owner state without losing updates", options, async (t) => {
  const { pool, repository } = await fixture(t);
  await setBrokerStorageMode(pool, "normalized");
  const second = createPostgresBrokerRepository(pool);
  await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? repository : second).update("first-owner", (state) => {
    state.counter = (state.counter ?? 0) + 1;
    state.events.unshift({ id: `event-${index}`, event: "concurrent-first-write" });
  })));
  const state = await repository.read("first-owner");
  assert.equal(state.counter, 8);
  assert.equal(new Set(state.events.map((event) => event.id)).size, 8);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM broker_account_states WHERE owner_id=$1", ["first-owner"])).rows[0].count, 1);
});

test("a waiting normalized writer reads collection changes committed before it acquires the owner lock", options, async (t) => {
  const { pool, repository } = await fixture(t);
  await setBrokerStorageMode(pool, "normalized");
  await repository.update("owner", (state) => {
    state.actions = [{ id: "action", requestId: "request", status: "awaiting_approval", version: 1 }];
  });
  let reachedLock;
  const attempted = new Promise((resolve) => { reachedLock = resolve; });
  const waiting = createPostgresBrokerRepository({ query: (...args) => pool.query(...args), async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), query(statement, values) {
      const pending = client.query(statement, values);
      const sql = typeof statement === "string" ? statement : statement.text;
      if (sql.startsWith("SELECT owner_id FROM broker_account_states")) reachedLock();
      return pending;
    } };
  } });
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    await writer.query("SELECT owner_id FROM broker_account_states WHERE owner_id=$1 FOR UPDATE", ["owner"]);
    await writer.query("UPDATE broker_actions SET payload=jsonb_set(payload,'{version}','2') WHERE owner_id=$1 AND id=$2", ["owner", "action"]);
    const change = waiting.update("owner", (state) => {
      assert.equal(state.actions[0].version, 2, "collection reads must happen after the awaited owner lock");
      state.actions[0].version = 3;
    });
    await attempted;
    await writer.query("COMMIT");
    await change;
    assert.equal((await repository.read("owner")).actions[0].version, 3);
  } finally { await writer.query("ROLLBACK").catch(() => {}); writer.release(); }
});
