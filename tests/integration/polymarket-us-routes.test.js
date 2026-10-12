import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";
import { createSqliteWorkspaceRepository, createMemoryWorkspaceRepository } from "../../src/settings/workspace-repository.js";
import { createPolymarketUsService } from "../../src/polymarket/polymarket-us-service.js";
import { usFixture } from "../helpers/polymarket-us-test-helpers.js";
import { polyFixture } from "../helpers/polymarket-test-helpers.js";

const encryptionSecret = "integration-test-encryption-key-for-us";
function persistentRepository(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "synergy-poly-us-test-")), filename = path.join(directory, "workspace.sqlite");
  const repository = createSqliteWorkspaceRepository(filename);
  t.after(async () => {
    await repository.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    for (const file of readdirSync(directory)) unlinkSync(path.join(directory, file));
    rmdirSync(directory);
  });
  return { repository, filename };
}
function appWith(t, repository, client) {
  const app = createTestApp({ workspaceRepository: repository, integrationsEncryptionKey: encryptionSecret, polymarketUsClient: client, polymarketClient: polyFixture().client });
  t.after(() => app.locals.polymarketService.close()); return app;
}

test("US connection verifies access, persists encrypted credentials, isolates owners and disconnects", async t => {
  const { repository, filename } = persistentRepository(t), fixture = usFixture(), app = appWith(t, repository, fixture.client);
  await request(app).get("/api/polymarket/us/state").expect(401);
  await request(app).post("/api/polymarket/us/connect").send(fixture.credentials).expect(401);
  const alice = await loginTestOperator(app, { username: "us-alice" }), bob = await loginTestOperator(app, { username: "us-bob" });
  const csrf = await readCsrfToken(alice, "/polymarket");
  for (const operation of ["connect", "sync", "disconnect"]) await alice.post(`/api/polymarket/us/${operation}`).send({}).expect(403);
  await alice.post("/api/polymarket/us/connect").set("X-CSRF-Token", csrf).send({ ...fixture.credentials, live: true }).expect(422);
  const linked = await alice.post("/api/polymarket/us/connect").set("X-CSRF-Token", csrf).send(fixture.credentials).expect(200).expect("Cache-Control", "no-store");
  assert.equal(linked.body.connected, true); assert.equal(linked.body.liveTradingAvailable, false);
  assert.equal(linked.body.snapshot.positions.items[0].netPosition, 2.5);
  const saved = await repository.read("discord:us-alice");
  assert.equal(saved.polymarketUs.connection.sealed.version, 1);
  for (const secret of [fixture.credentials.keyId, fixture.credentials.secretKey, "private-bank-id"]) {
    assert.ok(!JSON.stringify(saved).includes(secret)); assert.ok(!JSON.stringify(linked.body).includes(secret));
  }
  assert.equal((await bob.get("/api/polymarket/us/state").expect(200)).body.connected, false);
  // A new service and SQL connection can decrypt persisted credentials after restart.
  const reopened = createSqliteWorkspaceRepository(filename);
  try {
    const restarted = createPolymarketUsService({ repository: reopened, encryptionSecret, client: fixture.client });
    assert.equal((await restarted.sync("discord:us-alice")).connected, true);
  } finally { await reopened.close(); }
  const changedKey = createPolymarketUsService({ repository, encryptionSecret: encryptionSecret + "changed", client: fixture.client });
  assert.equal((await changedKey.state("discord:us-alice")).needsReplacement, true);
  await alice.post("/api/polymarket/us/sync").set("X-CSRF-Token", csrf).send({ owner: "us-bob" }).expect(422);
  await alice.post("/api/polymarket/us/disconnect").set("X-CSRF-Token", csrf).send({}).expect(200);
  assert.equal((await repository.read("discord:us-alice")).polymarketUs.connection, undefined);
  await alice.post("/api/polymarket/us/sync").set("X-CSRF-Token", csrf).send({}).expect(409);
  assert.ok(fixture.calls.every(call => call.options.method === "GET"));
});

test("failed credential replacement preserves the existing verified account and partial sync dates", async t => {
  const { repository } = persistentRepository(t), fixture = usFixture();
  const service = createPolymarketUsService({ repository, encryptionSecret, client: fixture.client });
  const linked = await service.connect("alice", fixture.credentials), original = await repository.read("alice");
  const rejected = createPolymarketUsService({ repository, encryptionSecret, client: usFixture({ status: 401 }).client });
  await assert.rejects(rejected.connect("alice", fixture.credentials), { code: "POLY_US_AUTH" });
  assert.equal((await repository.read("alice")).polymarketUs.connection.id, original.polymarketUs.connection.id);
  const partial = createPolymarketUsService({ repository, encryptionSecret, client: { ...fixture.client, positions: async () => { throw new Error("offline"); } } });
  const synced = await partial.sync("alice"); assert.equal(synced.snapshot.positions.observedAt, linked.snapshot.positions.observedAt);
  assert.equal(synced.snapshot.warnings.length, 1);
});

test("disconnect invalidates connection verification and in-flight sync across service instances", async t => {
  const { repository } = persistentRepository(t), fixture = usFixture();
  let release, started; const waiting = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const service = createPolymarketUsService({ repository, encryptionSecret, client: fixture.client });
  await service.connect("alice", fixture.credentials);
  const slow = createPolymarketUsService({ repository, encryptionSecret, client: { ...fixture.client, balances: async credentials => { started(); await gate; return fixture.client.balances(credentials); } } });
  const operation = slow.sync("alice"); await waiting; await service.disconnect("alice"); release();
  await assert.rejects(operation, { code: "POLY_US_CONFLICT" }); assert.equal((await service.state("alice")).connected, false);
  let releaseConnect; const connectGate = new Promise(resolve => { releaseConnect = resolve; });
  let connectStarted; const connectWaiting = new Promise(resolve => { connectStarted = resolve; });
  const connecting = createPolymarketUsService({ repository, encryptionSecret, client: { ...fixture.client, balances: async credentials => { connectStarted(); await connectGate; return fixture.client.balances(credentials); } } });
  const connectOperation = connecting.connect("alice", fixture.credentials); await connectWaiting; await service.disconnect("alice"); releaseConnect();
  await assert.rejects(connectOperation, { code: "POLY_US_CONFLICT" }); assert.equal((await service.state("alice")).connected, false);
});

test("temporary storage and missing encryption disable credential saving before any upstream calls", async t => {
  const fixture = usFixture(), service = createPolymarketUsService({ repository: createMemoryWorkspaceRepository(), encryptionSecret, client: fixture.client });
  assert.equal((await service.state("alice")).configured, false);
  await assert.rejects(service.connect("alice", fixture.credentials), { code: "POLY_US_CONFIG" }); assert.equal(fixture.calls.length, 0);
  const { repository } = persistentRepository(t);
  const noKey = createPolymarketUsService({ repository, client: fixture.client });
  await assert.rejects(noKey.connect("alice", fixture.credentials), { code: "POLY_US_CONFIG" });
  assert.equal(fixture.calls.length, 0);
});
