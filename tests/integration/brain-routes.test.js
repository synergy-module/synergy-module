import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";
import { createMemoryBrainRepository, createSqliteBrainRepository } from "../../src/agent-brain/brain-repository.js";
import { CAPABILITIES, MAX_ROLE_SNAPSHOT_AGE_MS } from "../../src/models/access.js";

const noKeys = {
  getStatus: () => ({ defaultProvider: "gemini", paidCallsEnabled: true, providers: ["gemini", "openai", "claude"].map((id) => ({
    id, label: id, model: "test-model", configured: false,
  })) }),
  generate: () => { throw new Error("An unconfigured provider must not be invoked"); },
};
const demo = {
  provider: "gemini", mode: "demo", symbol: "ES", timeframe: "5m", context: "",
  objective: "Research this setup with citations and independent risk checks.",
  accountSize: 50000, riskPercent: 0.5, pointValue: 50, minRewardRisk: 2,
};

function makeApp(t, options = {}) {
  const app = createTestApp({ traderAIProvider: noKeys, logger: { error() {} }, ...options });
  t.after(async () => {
    await app.locals.brainService.close?.();
    await app.locals.brainRepository.close();
  });
  return app;
}

async function startDemo(app, client, csrf, username = "operator") {
  const response = await client.post("/api/brain/runs").set("X-CSRF-Token", csrf)
    .send({ ...demo, ownerId: "discord:another-owner" }).expect(202).expect("Cache-Control", "no-store");
  const completed = await app.locals.brainService.waitForRun(`discord:${username}`, response.body.run.id);
  assert.equal(completed.status, "awaiting_approval", JSON.stringify(completed.error));
  return completed;
}

test("brain page and every API require authentication and disable caching", async (t) => {
  const app = makeApp(t);
  await request(app).get("/brain").expect(302).expect("Location", "/login").expect("Cache-Control", "no-store");
  for (const endpoint of ["/api/brain/state", "/api/brain/runs", "/api/brain/runs/id", "/api/brain/documents"]) {
    await request(app).get(endpoint).expect(401).expect("Cache-Control", "no-store");
  }
  for (const endpoint of ["/api/brain/runs", "/api/brain/runs/id/decision", "/api/brain/runs/id/cancel", "/api/brain/documents", "/api/brain/evals"]) {
    await request(app).post(endpoint).send(demo).expect(401).expect("Cache-Control", "no-store");
  }
  await request(app).delete("/api/brain/documents/id").expect(401).expect("Cache-Control", "no-store");
});

test("history and source pagination traverse timestamp ties with bounded owner-scoped cursors", async (t) => {
  const app = makeApp(t, { brainRepository: createMemoryBrainRepository({ now: () => new Date("2026-09-24T12:00:00.000Z") }) });
  const client = await loginTestOperator(app, { username: "pagination" });
  const other = await loginTestOperator(app, { username: "pagination-other" });
  for (let index = 0; index < 55; index++) {
    const id = `item-${String(index).padStart(3, "0")}`;
    await app.locals.brainRepository.saveRun("discord:pagination", { id, status: "completed", input: { symbol: "EXAMPLE" } });
    await app.locals.brainRepository.putDocument("discord:pagination", { id, title: `Source ${index}`, text: "Dated fixture source", kind: "knowledge" });
  }
  const state = (await client.get("/api/brain/state").expect(200)).body;
  assert.equal(state.runs.length, 20);
  assert.equal(state.documents.length, 25);
  assert.equal(typeof state.runsNextCursor, "string");
  assert.equal(typeof state.documentsNextCursor, "string");
  for (const kind of ["runs", "documents"]) {
    let cursor, ids = [];
    do {
      const result = (await client.get(`/api/brain/${kind}`).query({ limit: 7, ...(cursor ? { cursor } : {}) }).expect(200).expect("Cache-Control", "no-store")).body;
      assert.ok(result[kind].length <= 7);
      ids.push(...result[kind].map((item) => item.id));
      cursor = result.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 55);
    assert.equal(new Set(ids).size, 55);
    const foreign = (await other.get(`/api/brain/${kind}`).query({ cursor: state[`${kind}NextCursor`] }).expect(200)).body;
    assert.deepEqual(foreign[kind], []);
    assert.equal(foreign.nextCursor, null);
  }
  for (const query of [{ limit: 0 }, { limit: 51 }, { limit: "2.5" }, { limit: [1, 2] }, { cursor: "not-json" }, { cursor: state.documentsNextCursor }]) {
    await client.get("/api/brain/runs").query(query).expect(400);
  }
});

test("base members receive full and fragment brain pages and sanitized provider state", async (t) => {
  const app = makeApp(t, { roles: ["OS"] });
  const client = await loginTestOperator(app);
  const page = await client.get("/brain").expect(200).expect("Cache-Control", "no-store");
  assert.match(page.text, /data-app-shell/);
  assert.match(page.text, /data-brain/);
  const fragment = await client.get("/brain").set("X-Synergy-Module-Fragment", "1")
    .expect(200).expect("X-Synergy-Module-Key", "brain").expect("X-Synergy-Module-Path", "/brain");
  assert.doesNotMatch(fragment.text, /data-app-shell/);
  const state = await client.get("/api/brain/state").expect(200).expect("Cache-Control", "no-store");
  assert.equal(state.body.defaultProvider, "gemini");
  assert.deepEqual(state.body.providers.map((provider) => provider.id), ["gemini", "openai", "claude"]);
  assert.deepEqual(state.body.runs, []);
  assert.deepEqual(state.body.documents, []);
  assert.ok(state.body.toolDefinitions.some((definition) => definition.name === "risk.check"));
});

test("all brain mutations require the session CSRF token", async (t) => {
  const client = await loginTestOperator(makeApp(t));
  for (const endpoint of ["/api/brain/runs", "/api/brain/runs/id/decision", "/api/brain/runs/id/cancel", "/api/brain/documents", "/api/brain/evals"]) {
    const response = await client.post(endpoint).send(demo).expect(403).expect("Cache-Control", "no-store");
    assert.equal(response.body.error, "CSRF_INVALID");
  }
  await client.delete("/api/brain/documents/id").expect(403).expect("Cache-Control", "no-store");
});

test("Cortex broker summary is owner-scoped and excludes credentials, account data and action history", async (t) => {
  const owners = [], secret = "credential-must-stay-server-side";
  const app = makeApp(t, { robinhoodService: { async state(owner) {
    owners.push(owner);
    return { configured: true, connected: true, liveEnabled: false, paused: true,
      storage: { kind: "postgres", persistent: true, databaseUrl: secret },
      connection: { sealed: secret }, access_token: secret,
      snapshots: [{ tool: "get_accounts", result: { accountNumber: secret } }],
      actions: [{ arguments: { account: secret } }], events: [{ detail: secret }],
    };
  } } });
  const client = await loginTestOperator(app, { username: "broker-summary" });
  const state = await client.get("/api/brain/state?ownerId=discord:another-owner").expect(200);
  assert.deepEqual(owners, ["discord:broker-summary"]);
  assert.deepEqual(state.body.robinhoodState, { configured: true, connected: true, liveEnabled: false, paused: true, storage: { kind: "postgres", persistent: true } });
  assert.doesNotMatch(state.text, /credential-must-stay-server-side|accountNumber|access_token|databaseUrl/);
  assert.equal(Object.hasOwn(state.body, "snapshots"), false);
  assert.equal(Object.hasOwn(state.body, "actions"), false);
});

test("run review is owner isolated, version checked, and saves approved research memory once", async (t) => {
  const app = makeApp(t);
  const first = await loginTestOperator(app, { username: "brain-first" });
  const second = await loginTestOperator(app, { username: "brain-second" });
  const firstCsrf = await readCsrfToken(first, "/brain");
  const secondCsrf = await readCsrfToken(second, "/brain");
  const run = await startDemo(app, first, firstCsrf, "brain-first");
  await first.get(`/api/brain/runs/${run.id}`).expect(200);
  await second.get(`/api/brain/runs/${run.id}`).expect(404);
  await second.post(`/api/brain/runs/${run.id}/decision`).set("X-CSRF-Token", secondCsrf)
    .send({ version: run.version, decision: "approve", ownerId: "discord:brain-first" }).expect(404);
  await second.post(`/api/brain/runs/${run.id}/cancel`).set("X-CSRF-Token", secondCsrf).send({}).expect(404);
  await first.post(`/api/brain/runs/${run.id}/decision`).set("X-CSRF-Token", firstCsrf)
    .send({ version: run.version - 1, decision: "approve" }).expect(409);
  const approved = await first.post(`/api/brain/runs/${run.id}/decision`).set("X-CSRF-Token", firstCsrf)
    .send({ version: run.version, decision: "approve", note: "Reviewed this research." }).expect(200);
  assert.equal(approved.body.run.status, "completed");
  assert.equal(approved.body.run.approval.tradeExecutionAuthorized, false);
  await first.post(`/api/brain/runs/${run.id}/decision`).set("X-CSRF-Token", firstCsrf)
    .send({ version: run.version, decision: "approve" }).expect(200);
  const own = await first.get("/api/brain/state").expect(200);
  const other = await second.get("/api/brain/state").expect(200);
  assert.equal(own.body.runs.length, 1);
  assert.equal(own.body.documents.filter((document) => document.kind === "memory").length, 1);
  assert.equal(Object.hasOwn(own.body.documents[0], "text"), false);
  assert.deepEqual(other.body.runs, []);
  assert.deepEqual(other.body.documents, []);
});

test("knowledge CRUD is owner isolated and cannot directly create approved memory", async (t) => {
  const app = makeApp(t);
  const first = await loginTestOperator(app, { username: "knowledge-first" });
  const second = await loginTestOperator(app, { username: "knowledge-second" });
  const firstCsrf = await readCsrfToken(first, "/brain");
  const secondCsrf = await readCsrfToken(second, "/brain");
  const added = await first.post("/api/brain/documents").set("X-CSRF-Token", firstCsrf)
    .send({ title: "Review checklist", text: "Wait for confirmation.", ownerId: "discord:knowledge-second" }).expect(201);
  assert.equal(added.body.document.kind, "knowledge");
  assert.equal(Object.hasOwn(added.body.document, "text"), false);
  const id = added.body.document.id;
  await second.delete(`/api/brain/documents/${id}`).set("X-CSRF-Token", secondCsrf).expect(200);
  assert.equal((await first.get("/api/brain/documents").expect(200)).body.documents.length, 1);
  assert.deepEqual((await second.get("/api/brain/documents").expect(200)).body.documents, []);
  await first.post("/api/brain/documents").set("X-CSRF-Token", firstCsrf)
    .send({ title: "Forged approval", text: "This was never approved.", kind: "memory" }).expect(422);
  await first.delete(`/api/brain/documents/${id}`).set("X-CSRF-Token", firstCsrf).expect(200);
  assert.deepEqual((await first.get("/api/brain/documents").expect(200)).body.documents, []);
});

test("cancelling a research checkpoint persists its terminal state", async (t) => {
  const app = makeApp(t);
  const client = await loginTestOperator(app);
  const csrf = await readCsrfToken(client, "/brain");
  const run = await startDemo(app, client, csrf);
  const cancelled = await client.post(`/api/brain/runs/${run.id}/cancel`).set("X-CSRF-Token", csrf).send({}).expect(200);
  assert.equal(cancelled.body.run.status, "cancelled");
  const loaded = await client.get(`/api/brain/runs/${run.id}`).expect(200);
  assert.equal(loaded.body.run.status, "cancelled");
  assert.deepEqual((await client.get("/api/brain/documents").expect(200)).body.documents, []);
});

test("a durable run remains reviewable after app and repository recreation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "synergy-module-brain-http-"));
  const filename = path.join(directory, "brain.sqlite");
  const firstRepository = createSqliteBrainRepository({ filename });
  const firstApp = createTestApp({ traderAIProvider: noKeys, brainRepository: firstRepository });
  let secondApp;
  let secondRepository;
  t.after(async () => {
    await firstApp.locals.brainService.close();
    await firstRepository.close();
    await secondApp?.locals.brainService.close();
    await secondRepository?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("synergy-module-brain-http-"));
    await rm(directory, { recursive: true, force: true });
  });
  const first = await loginTestOperator(firstApp);
  const csrf = await readCsrfToken(first, "/brain");
  const checkpoint = await startDemo(firstApp, first, csrf);
  await firstApp.locals.brainService.close();
  await firstRepository.close();
  secondRepository = createSqliteBrainRepository({ filename });
  secondApp = createTestApp({ traderAIProvider: noKeys, brainRepository: secondRepository });
  const second = await loginTestOperator(secondApp);
  const restored = await second.get(`/api/brain/runs/${checkpoint.id}`).expect(200);
  assert.equal(restored.body.run.version, checkpoint.version);
  assert.equal(restored.body.run.status, "awaiting_approval");
  const secondCsrf = await readCsrfToken(second, "/brain");
  const approval = await second.post(`/api/brain/runs/${checkpoint.id}/decision`).set("X-CSRF-Token", secondCsrf)
    .send({ version: checkpoint.version, decision: "approve" }).expect(200);
  assert.equal(approval.body.run.status, "completed");
});

test("unconfigured analysis, malformed input, and upstream errors have safe JSON responses", async (t) => {
  const app = makeApp(t);
  const client = await loginTestOperator(app);
  const csrf = await readCsrfToken(client, "/brain");
  const missing = await client.post("/api/brain/runs").set("X-CSRF-Token", csrf)
    .send({ ...demo, mode: "analysis", context: "Operator supplied market context without a verified live price feed." }).expect(503);
  assert.equal(missing.body.error, "BRAIN_PROVIDER_NOT_CONFIGURED");
  await client.post("/api/brain/runs").set("X-CSRF-Token", csrf)
    .set("Content-Type", "application/json").send("{bad-json").expect(400).expect("Content-Type", /json/);
  const logs = [];
  const failing = makeApp(t, { brainService: {
    async getState() { throw Object.assign(new Error("Bearer private-credential raw-upstream-response"), { code: "BRAIN_CONFLICT" }); },
    async start() { throw new Error("Bearer private-credential raw-upstream-response"); },
  }, logger: { error: (message) => logs.push(message) } });
  const failedClient = await loginTestOperator(failing);
  const failedCsrf = await readCsrfToken(failedClient, "/brain");
  const known = await failedClient.get("/api/brain/state").expect(409);
  assert.deepEqual(known.body, { error: "BRAIN_CONFLICT", message: "This run changed. Refresh it before continuing." });
  const unknown = await failedClient.post("/api/brain/runs").set("X-CSRF-Token", failedCsrf).send(demo).expect(500);
  assert.equal(unknown.body.error, "BRAIN_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify({ known: known.body, unknown: unknown.body, logs }), /private-credential|raw-upstream-response/);
});

test("evaluations accept only one active request across app instances and release after errors", async (t) => {
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const results = { passed: 1, total: 1, failed: 0, durationMs: 1, cases: [{ id: "fixture", name: "Fixture", passed: true, detail: "Passed" }] };
  let fail = false;
  const firstApp = makeApp(t, { brainEvaluator: async () => {
    started.resolve();
    await gate.promise;
    if (fail) throw new Error("private-provider-response");
    return results;
  } });
  const secondApp = makeApp(t, { brainEvaluator: async () => results });
  const first = await loginTestOperator(firstApp);
  const second = await loginTestOperator(secondApp);
  const firstCsrf = await readCsrfToken(first, "/brain");
  const secondCsrf = await readCsrfToken(second, "/brain");
  const pending = first.post("/api/brain/evals").set("X-CSRF-Token", firstCsrf).send({}).then((response) => response);
  await started.promise;
  const busy = await second.post("/api/brain/evals").set("X-CSRF-Token", secondCsrf).send({})
    .expect(429).expect("Cache-Control", "no-store");
  assert.equal(busy.body.error, "BRAIN_EVAL_BUSY");
  gate.resolve();
  assert.equal((await pending).status, 200);
  fail = true;
  const failure = await first.post("/api/brain/evals").set("X-CSRF-Token", firstCsrf).send({}).expect(500);
  assert.doesNotMatch(JSON.stringify(failure.body), /private-provider-response/);
  const recovered = await second.post("/api/brain/evals").set("X-CSRF-Token", secondCsrf).send({}).expect(200);
  assert.deepEqual(recovered.body, results);
});

test("BASE-only brain members cannot read journals through a tool or retained run context", async (t) => {
  let journalReads = 0;
  const app = makeApp(t, { roles: ["OS"], journalRepository: { async list() {
    journalReads += 1;
    return [{ id: "old-record", direction: "long", entryTime: "2026-09-10", notes: "ES journal restrictedhistoricalrecord", confluences: [] }];
  } } });
  const client = await loginTestOperator(app);
  const csrf = await readCsrfToken(client, "/brain");
  await client.get("/api/journal").expect(403);
  const run = await startDemo(app, client, csrf);
  assert.equal(journalReads, 0);
  assert.doesNotMatch(JSON.stringify(run), /restrictedhistoricalrecord/);
  assert.ok(run.trace.some((item) => item.type === "tool_result" && item.details?.tool === "journal.search" && item.details.ok === false));
});

test("journal tool checks current server capabilities and bans for every invocation", async (t) => {
  let journalReads = 0;
  const app = makeApp(t, { journalRepository: { async list() { journalReads += 1; return []; } } });
  await loginTestOperator(app);
  const ownerId = "discord:operator";
  const execute = () => app.locals.brainTools.execute({ name: "journal.search", arguments: { query: "ES" }, ownerId,
    role: "researcher", input: demo });
  await execute();
  assert.equal(journalReads, 1);
  const original = app.locals.userRepository.findById(ownerId);
  app.locals.userRepository.upsert({ ...original, capabilities: [CAPABILITIES.BASE] });
  await assert.rejects(execute(), { code: "BRAIN_TOOL_DENIED" });
  assert.equal(journalReads, 1);
  app.locals.userRepository.upsert(original);
  app.locals.banRepository.ban({ userId: ownerId, actorId: "admin" });
  await assert.rejects(execute(), { code: "BRAIN_TOOL_DENIED" });
  assert.equal(journalReads, 1);
});

test("journal tools deny stale Discord snapshots before accessing stored entries", async (t) => {
  let journalReads = 0;
  const app = makeApp(t, { authMode: "discord", journalRepository: { async list() { journalReads += 1; return []; } } });
  const ownerId = "discord-owner";
  const operator = { id: ownerId, authMode: "discord", capabilities: [CAPABILITIES.BASE, CAPABILITIES.JOURNAL], roles: ["OS", "Journal"],
    rolesSyncedAt: new Date(Date.now() - MAX_ROLE_SNAPSHOT_AGE_MS - 1000).toISOString() };
  app.locals.userRepository.upsert(operator);
  const execute = () => app.locals.brainTools.execute({ name: "journal.search", arguments: { query: "ES" }, ownerId,
    role: "researcher", input: demo });
  await assert.rejects(execute(), { code: "BRAIN_TOOL_DENIED" });
  assert.equal(journalReads, 0);
  app.locals.userRepository.upsert({ ...operator, rolesSyncedAt: new Date().toISOString() });
  await execute();
  assert.equal(journalReads, 1);
});
