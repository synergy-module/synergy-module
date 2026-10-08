import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createPostgresBrainRepository } from "../../src/agent-brain/brain-repository.js";
import { createBrainKnowledge } from "../../src/agent-brain/brain-knowledge.js";

// Explicitly opt into a disposable database. Never use the app's DATABASE_URL.
test("PostgreSQL Brain keeps durable history and supports bounded concurrent reads", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6,
    options: "-c statement_timeout=3000 -c lock_timeout=2000" });
  const owner = `brain-performance:${randomUUID()}`;
  const other = `${owner}:other`;
  let time = new Date("2026-09-01T00:00:00Z");
  const repository = createPostgresBrainRepository(pool, { now: () => time });
  const knowledge = createBrainKnowledge({ repository });
  t.after(async () => {
    for (const table of ["agent_brain_runs", "agent_brain_documents", "agent_brain_cache"]) {
      await pool.query(`DELETE FROM ${table} WHERE owner_id = ANY($1::text[])`, [[owner, other]]);
    }
    await repository.close();
    await pool.end();
  });

  // Exercise an upgrade from the supported prior schema with an existing row.
  await pool.query(await readFile(new URL("../../migrations/002_agent_brain.sql", import.meta.url), "utf8"));
  const legacy = await repository.saveRun(owner, { id: "legacy", status: "completed", marker: "preserve me" });
  const migration = await readFile(new URL("../../migrations/006_brain_query_indexes.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  assert.deepEqual(await repository.getRun(owner, legacy.id), legacy);

  await t.test("history grows past a UI page without deleting audit records", async () => {
    for (let index = 0; index < 105; index += 1) {
      time = new Date(time.valueOf() + 1);
      await repository.saveRun(owner, { id: `run-${index.toString().padStart(3, "0")}`, status: "completed" });
    }
    assert.equal((await repository.getRun(owner, "legacy")).marker, "preserve me");
    const first = await repository.listRuns(owner, { limit: 1000 });
    assert.equal(first.length, 100);
    const last = first.at(-1);
    const older = await repository.listRuns(owner, { limit: 100, before: { id: last.id, updatedAt: last.updatedAt } });
    assert.equal(older.length, 6);
    assert.equal(new Set([...first, ...older].map((row) => row.id)).size, 106);
    assert.equal(older.at(-1).id, "legacy");
    assert.deepEqual(await repository.listRuns(other), []);
  });

  await t.test("competing writers retain run admission and revision invariants", async () => {
    const admissions = await Promise.allSettled(["one", "two"].map((id) =>
      repository.saveRun(owner, { id, status: "running" })));
    assert.equal(admissions.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(admissions.find((result) => result.status === "rejected").reason.code, "BRAIN_RUN_IN_PROGRESS");
    const active = admissions.find((result) => result.status === "fulfilled").value;
    const approvals = await Promise.allSettled([1, 2].map(() =>
      repository.saveRun(owner, { ...active, status: "approving" }, { expectedVersion: active.version })));
    assert.equal(approvals.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(approvals.find((result) => result.status === "rejected").reason.code, "BRAIN_CONFLICT");
    await assert.rejects(repository.saveRun(owner, { id: "blocked-during-approval", status: "running" }), { code: "BRAIN_RUN_IN_PROGRESS" });
    const approving = approvals.find((result) => result.status === "fulfilled").value;
    await repository.saveRun(owner, { ...approving, status: "completed" }, { expectedVersion: approving.version });
  });

  await t.test("reads complete while another transaction holds the owner write lock", async () => {
    await repository.putCache(owner, "current", { value: "fresh", expiresAt: time.valueOf() + 60_000 });
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT pg_advisory_xact_lock(hashtext('agent_brain'), hashtext($1))", [owner]);
      const [run, page, cache, documents] = await Promise.all([
        repository.getRun(owner, "legacy"), repository.listRuns(owner, { limit: 2 }),
        repository.getCache(owner, "current"), repository.listDocuments(owner, { limit: 2 }),
      ]);
      assert.equal(run.marker, "preserve me");
      assert.equal(page.length, 2);
      assert.equal(cache.value, "fresh");
      assert.deepEqual(documents, []);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
  });

  await t.test("cache expiration and eviction stay bounded and tenant scoped", async () => {
    await repository.putCache(other, "cache-0", { value: "other", expiresAt: time.valueOf() + 60_000 });
    for (let index = 0; index < 101; index += 1) {
      time = new Date(time.valueOf() + 1);
      await repository.putCache(owner, `cache-${index}`, { value: index, expiresAt: time.valueOf() + 60_000 });
    }
    assert.equal(await repository.getCache(owner, "cache-0"), null);
    assert.equal((await repository.getCache(owner, "cache-1")).value, 1);
    assert.equal((await repository.getCache(other, "cache-0")).value, "other");
    const count = await pool.query("SELECT count(*)::int AS count FROM agent_brain_cache WHERE owner_id=$1", [owner]);
    assert.equal(count.rows[0].count, 100);
    await repository.putCache(owner, "already-expired", { value: 0, expiresAt: time.valueOf() - 1 });
    assert.equal((await repository.getCache(owner, "cache-1")).value, 1);
    time = new Date(time.valueOf() + 60_000);
    assert.equal(await repository.getCache(owner, "cache-100"), null);
    await repository.putCache(owner, "replacement", { value: "new", expiresAt: time.valueOf() + 60_000 });
    const remaining = await pool.query("SELECT id FROM agent_brain_cache WHERE owner_id=$1", [owner]);
    assert.deepEqual(remaining.rows, [{ id: "replacement" }]);
  });

  await t.test("indexed retrieval reaches older knowledge and preserves citation and kind boundaries", async () => {
    const rare = await repository.putDocument(owner, { id: "rare-older-document", title: "Risk playbook", kind: "knowledge",
      text: "The uncommonquasar check reviews Équité before acting." });
    for (let index = 0; index < 110; index += 1) {
      time = new Date(time.valueOf() + 1);
      await repository.putDocument(owner, { id: `doc-${index.toString().padStart(3, "0")}`, title: "Execution", kind: "knowledge", text: "Ordinary execution and risk observations." });
    }
    await repository.putDocument(owner, { id: "reviewed-memory", title: "Lesson", kind: "memory", text: "The uncommonquasar check improved patience." });
    await repository.putDocument(other, { id: rare.id, title: "Private", kind: "knowledge", text: "uncommonquasar private owner record" });
    const page = await knowledge.listDocuments(owner, { limit: 100 });
    assert.equal(page.length, 100);
    assert.ok(!page.some((row) => row.id === rare.id));
    const last = page.at(-1);
    const older = await knowledge.listDocuments(owner, { limit: 100, before: { updatedAt: last.updatedAt, id: last.id } });
    assert.equal(older.length, 12);
    assert.equal(new Set([...page, ...older].map((row) => row.id)).size, 112);
    const result = await knowledge.search(owner, "uncommonquasar ÉQUITÉ", { kind: "knowledge" });
    assert.equal(result.length, 1);
    assert.equal(result[0].documentId, rare.id);
    assert.equal(result[0].excerpt, rare.text);
    assert.ok(result[0].score > 0);
    assert.equal((await knowledge.search(owner, "uncommonquasar", { kind: "memory" }))[0].documentId, "reviewed-memory");
    assert.equal((await repository.searchDocuments(owner, ["execution"], { limit: 1000 })).length, 64);
    await repository.deleteDocument(owner, rare.id);
    assert.deepEqual(await knowledge.search(owner, "uncommonquasar", { kind: "knowledge" }), []);
    assert.equal((await knowledge.search(other, "uncommonquasar")).length, 1);
    const index = await pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid='idx_agent_brain_documents_search'::regclass");
    assert.equal(index.rows[0].indisvalid, true);
  });
});
