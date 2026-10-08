import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryBrainRepository, createSqliteBrainRepository, createPostgresBrainRepository } from "../../src/agent-brain/brain-repository.js";

const run = (id = "run-1", status = "awaiting_approval") => ({ id, status, steps: [{ text: "Observe" }] });
const document = (id = "doc-1") => ({ id, title: "Trading plan", text: "Wait for the setup.", kind: "knowledge" });
const conflict = (error) => error.code === "BRAIN_CONFLICT" && error.status === 409;

for (const [name, create] of [
  ["memory", (options) => createMemoryBrainRepository(options)],
  ["sqlite", (options) => createSqliteBrainRepository({ filename: ":memory:", ...options })],
]) {
  test(`${name}: owner isolation and detached reads apply to runs, documents, and cache`, async (t) => {
    const repository = create();
    t.after(() => repository.close());
    const saved = await repository.saveRun("owner-a", run());
    saved.steps[0].text = "mutated";
    await repository.saveRun("owner-b", { ...run(), status: "completed" });
    assert.equal((await repository.getRun("owner-a", "run-1")).steps[0].text, "Observe");
    assert.equal((await repository.getRun("owner-b", "run-1")).status, "completed");
    assert.equal(await repository.getRun("owner-c", "run-1"), null);
    assert.deepEqual(await repository.listRuns("owner-c"), []);
    await repository.putDocument("owner-a", document());
    await repository.deleteDocument("owner-b", "doc-1");
    assert.equal((await repository.listDocuments("owner-a")).length, 1);
    assert.deepEqual(await repository.listDocuments("owner-b"), []);
    await repository.putCache("owner-a", "same-key", { value: { result: 1 }, expiresAt: Date.now() + 60_000 });
    assert.equal(await repository.getCache("owner-b", "same-key"), null);
    const cached = await repository.getCache("owner-a", "same-key");
    cached.value.result = 9;
    assert.equal((await repository.getCache("owner-a", "same-key")).value.result, 1);
  });

  test(`${name}: atomic revisions allow only one concurrent approval claim`, async (t) => {
    const repository = create();
    t.after(() => repository.close());
    const first = await repository.saveRun("owner", { ...run(), version: 999 });
    assert.equal(first.version, 1);
    await assert.rejects(repository.saveRun("owner", run()), conflict);
    await assert.rejects(repository.saveRun("owner", run("missing"), { expectedVersion: 1 }), conflict);
    const results = await Promise.allSettled([
      repository.saveRun("owner", { ...first, status: "approving" }, { expectedVersion: 1 }),
      repository.saveRun("owner", { ...first, status: "approving" }, { expectedVersion: 1 }),
    ]);
    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(results.filter((entry) => entry.status === "rejected" && conflict(entry.reason)).length, 1);
    const claimed = await repository.getRun("owner", first.id);
    assert.equal(claimed.version, 2);
    assert.equal(claimed.status, "approving");
    await assert.rejects(repository.saveRun("owner", { ...first, status: "completed" }, { expectedVersion: 1 }), conflict);
  });

  test(`${name}: fixed memory IDs are idempotent and document bounds never evict memory`, async (t) => {
    let time = new Date("2026-09-01T00:00:00Z");
    const repository = create({ now: () => time });
    t.after(() => repository.close());
    const first = await repository.putDocument("owner", { ...document("run:approved"), kind: "memory" });
    time = new Date("2026-09-02T00:00:00Z");
    const repeated = await repository.putDocument("owner", { ...document("run:approved"), kind: "memory" });
    assert.equal(first.createdAt, repeated.createdAt);
    assert.notEqual(first.updatedAt, repeated.updatedAt);
    for (let index = 1; index < 100; index += 1) await repository.putDocument("owner", document(`doc-${index}`));
    await assert.rejects(repository.putDocument("owner", document("overflow")), { code: "BRAIN_CAPACITY" });
    assert.equal((await repository.listDocuments("owner")).length, 100);
    assert.equal((await repository.listDocuments("owner")).filter((entry) => entry.id === "run:approved").length, 1);
    await assert.rejects(repository.putDocument("owner", { ...document(), text: "x".repeat(50_001) }), { code: "BRAIN_INVALID_INPUT" });
    await assert.rejects(repository.putDocument("owner", { ...document(), title: "x".repeat(201) }), { code: "BRAIN_INVALID_INPUT" });
  });

  test(`${name}: new running work is admitted atomically once per owner through approval`, async (t) => {
    const repository = create();
    t.after(() => repository.close());
    const results = await Promise.allSettled([
      repository.saveRun("owner", run("first", "running")),
      repository.saveRun("owner", run("second", "running")),
    ]);
    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(results.filter((entry) => entry.status === "rejected" && entry.reason.code === "BRAIN_RUN_IN_PROGRESS").length, 1);
    let current = (await repository.listRuns("owner"))[0];
    current = await repository.saveRun("owner", { ...current, marker: "still running" }, { expectedVersion: current.version });
    await repository.saveRun("other-owner", run("parallel", "running"));
    for (const status of ["awaiting_approval", "approving"]) {
      current = await repository.saveRun("owner", { ...current, status }, { expectedVersion: current.version });
      await assert.rejects(repository.saveRun("owner", run("new-run", "running")), { code: "BRAIN_RUN_IN_PROGRESS", status: 409 });
    }
    await repository.saveRun("owner", { ...current, status: "completed" }, { expectedVersion: current.version });
    const admitted = await repository.saveRun("owner", run("new-run", "running"));
    assert.equal(admitted.version, 1);
  });

  test(`${name}: run capacity preserves every active or approving run`, async (t) => {
    const repository = create();
    t.after(() => repository.close());
    for (let index = 0; index < 100; index += 1) {
      await repository.saveRun("owner", run(`run-${index}`, index === 0 ? "running" : index % 2 === 0 ? "approving" : "awaiting_approval"));
    }
    await assert.rejects(repository.saveRun("owner", run("overflow")), { code: "BRAIN_CAPACITY" });
    const terminal = await repository.getRun("owner", "run-0");
    await repository.saveRun("owner", { ...terminal, status: "completed" }, { expectedVersion: terminal.version });
    await repository.saveRun("owner", run("replacement"));
    assert.equal(await repository.getRun("owner", "run-0"), null);
    assert.equal((await repository.listRuns("owner", { limit: 200 })).length, 100);
    assert.equal((await repository.getRun("owner", "run-2")).status, "approving");
  });

  test(`${name}: expired cache entries are removed and cache capacity is bounded`, async (t) => {
    let time = new Date("2026-09-01T00:00:00Z");
    const repository = create({ now: () => time });
    t.after(() => repository.close());
    await repository.putCache("owner", "expiring", { value: 42, expiresAt: time.valueOf() + 1000 });
    assert.equal((await repository.getCache("owner", "expiring")).value, 42);
    time = new Date(time.valueOf() + 1000);
    assert.equal(await repository.getCache("owner", "expiring"), null);
    await assert.rejects(repository.putCache("owner", "bad", { value: 1, expiresAt: "invalid" }), { code: "BRAIN_INVALID_INPUT" });
    for (let index = 0; index < 101; index += 1) {
      time = new Date(time.valueOf() + 1);
      await repository.putCache("owner", `cache-${index}`, { value: index, expiresAt: time.valueOf() + 60_000 });
    }
    assert.equal(await repository.getCache("owner", "cache-0"), null);
    assert.equal((await repository.getCache("owner", "cache-100")).value, 100);
    await repository.putCache("owner", "already-expired", { value: 0, expiresAt: time.valueOf() - 1 });
    assert.equal((await repository.getCache("owner", "cache-1")).value, 1, "an expired insertion must not evict a fresh cache entry");
    time = new Date(time.valueOf() + 60_000);
    assert.equal(await repository.getCache("owner", "cache-100"), null);
  });

  test(`${name}: keyset pages preserve timestamp ties and tenant boundaries`, async (t) => {
    const repository = create({ now: () => new Date("2026-09-01T00:00:00Z") });
    t.after(() => repository.close());
    for (const id of ["c", "a", "b"]) {
      await repository.saveRun("owner", run(id, "completed"));
      await repository.putDocument("owner", document(id));
    }
    await repository.putDocument("other", document("secret"));
    for (const method of ["listRuns", "listDocuments"]) {
      const first = await repository[method]("owner", { limit: 2 });
      assert.deepEqual(first.map((row) => row.id), ["a", "b"]);
      const last = first.at(-1);
      const second = await repository[method]("owner", { limit: 2, before: { id: last.id, updatedAt: last.updatedAt } });
      assert.deepEqual(second.map((row) => row.id), ["c"]);
      await assert.rejects(repository[method]("owner", { before: { id: "b" } }), { code: "BRAIN_INVALID_INPUT" });
    }
  });
}

test("sqlite persists after reopening and independent connections cannot both claim a revision", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "synergy-module-brain-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("synergy-module-brain-"));
    return rm(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, "nested", "brain.sqlite");
  const first = createSqliteBrainRepository({ filename });
  await first.saveRun("owner", run());
  await first.putDocument("owner", document());
  await first.putCache("owner", "persisted", { value: "cached", expiresAt: Date.now() + 60_000 });
  await first.close();
  const second = createSqliteBrainRepository({ filename });
  const third = createSqliteBrainRepository({ filename });
  try {
    const restored = await second.getRun("owner", "run-1");
    assert.equal(restored.version, 1);
    assert.equal((await second.listDocuments("owner"))[0].text, "Wait for the setup.");
    assert.equal((await second.getCache("owner", "persisted")).value, "cached");
    const outcomes = await Promise.allSettled([second, third].map((repository) =>
      repository.saveRun("owner", { ...restored, status: "approving" }, { expectedVersion: 1 })));
    assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((entry) => entry.status === "rejected" && conflict(entry.reason)).length, 1);
    const admissions = await Promise.allSettled([
      second.saveRun("concurrent-owner", run("connection-a", "running")),
      third.saveRun("concurrent-owner", run("connection-b", "running")),
    ]);
    assert.equal(admissions.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(admissions.filter((entry) => entry.status === "rejected" && entry.reason.code === "BRAIN_RUN_IN_PROGRESS").length, 1);
    assert.equal((await second.listRuns("concurrent-owner")).length, 1);
  } finally { await second.close(); await third.close(); }
});

test("postgres uses owner-bound parameters, a transaction lock, and releases its shared connection", async () => {
  const queries = [];
  let releases = 0;
  let ends = 0;
  const repository = createPostgresBrainRepository({
    async connect() {
      return { async query(sql, values) { queries.push({ sql, values }); return { rows: [] }; }, release() { releases += 1; } };
    },
    async end() { ends += 1; },
  });
  const owner = "owner'; DROP TABLE agent_brain_runs; --";
  await repository.saveRun(owner, run());
  assert.equal(queries[0].sql, "BEGIN");
  assert.match(queries[1].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(queries[1].values, [owner]);
  for (const query of queries.filter((entry) => entry.sql.includes("FROM agent_brain"))) {
    assert.match(query.sql, /WHERE owner_id = \$1/);
    assert.equal(query.values[0], owner);
  }
  const write = queries.find((entry) => entry.sql.startsWith("INSERT"));
  assert.equal(write.values[0], owner);
  assert.ok(queries.every((query) => !query.sql.includes(owner)));
  assert.equal(queries.at(-1).sql, "COMMIT");
  assert.equal(releases, 1);
  await repository.close();
  assert.equal(ends, 0);
});

test("postgres rolls back a failed transaction and releases its connection", async () => {
  const commands = [];
  let released = false;
  const repository = createPostgresBrainRepository({ async connect() {
    return { async query(sql) {
      commands.push(sql);
      if (sql.startsWith("SELECT id")) throw new Error("Database unavailable");
      return { rows: [] };
    }, release() { released = true; } };
  } });
  await assert.rejects(repository.saveRun("owner", run("id")), /Database unavailable/);
  assert.equal(commands.at(-1), "ROLLBACK");
  assert.equal(released, true);
  await repository.close();
});

test("postgres reads are bounded and do not take owner write locks or transactions", async (t) => {
  const queries = [];
  let releases = 0;
  const repository = createPostgresBrainRepository({ async connect() {
    return { async query(sql, values) { queries.push({ sql, values }); return { rows: [] }; }, release() { releases += 1; } };
  } }, { now: () => new Date("2026-09-01T00:00:00Z") });
  t.after(() => repository.close());
  await repository.getRun("owner", "id");
  await repository.listRuns("owner", { limit: 7 });
  await repository.listDocuments("owner", { limit: 3, before: { id: "last", updatedAt: "2026-09-01T00:00:00Z" } });
  await repository.getCache("owner", "cache-key");
  assert.equal(queries.length, 4);
  assert.equal(releases, 4);
  assert.ok(queries.every(({ sql }) => sql.startsWith("SELECT") && !sql.includes("pg_advisory")));
  assert.match(queries[1].sql, /ORDER BY updated_at DESC, id ASC LIMIT \$2/);
  assert.deepEqual(queries[1].values, ["owner", 7]);
  assert.match(queries[2].sql, /updated_at < \$2.*id > \$3/);
  assert.deepEqual(queries[2].values, ["owner", "2026-09-01T00:00:00.000Z", "last", 3]);
  assert.match(queries[3].sql, /expires_at > \$3/);
});

test("postgres cache maintenance deletes expired/old IDs without reading cached payloads", async (t) => {
  const queries = [];
  const repository = createPostgresBrainRepository({ async connect() {
    return { async query(sql, values) { queries.push({ sql, values }); return { rows: [] }; }, release() {} };
  } });
  t.after(() => repository.close());
  await repository.putCache("owner", "key", { value: { answer: 42 }, expiresAt: Date.now() + 60_000 });
  assert.ok(!queries.some(({ sql }) => sql.startsWith("SELECT id, payload")));
  const deletion = queries.filter(({ sql }) => sql.startsWith("DELETE"));
  assert.equal(deletion.length, 2);
  assert.match(deletion[0].sql, /owner_id = \$1 AND expires_at <= \$2/);
  assert.match(deletion[1].sql, /SELECT id .* ORDER BY updated_at DESC, id ASC OFFSET \$4/);
  assert.deepEqual(deletion[1].values, ["owner", "owner", "key", 99]);
});

test("postgres candidate retrieval binds owner, terms, kind and candidate bound", async (t) => {
  const queries = [];
  const repository = createPostgresBrainRepository({ async connect() {
    return { async query(sql, values) { queries.push({ sql, values }); return { rows: [] }; }, release() {} };
  } });
  t.after(() => repository.close());
  assert.deepEqual(await repository.searchDocuments("owner", ["équité", "risk"], { kind: "memory", limit: 1000 }), []);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /WHERE owner_id = \$1/);
  assert.match(queries[0].sql, /@@ to_tsquery\('simple', \$2\)/);
  assert.match(queries[0].sql, /payload->>'kind' = \$4/);
  assert.deepEqual(queries[0].values, ["owner", "équité | risk", 64, "memory"]);
  await assert.rejects(repository.searchDocuments("owner", ["risk' | secret"]), { code: "BRAIN_INVALID_INPUT" });
});
