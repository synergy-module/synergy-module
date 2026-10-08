import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSqliteRuntime } from "../../src/runtime/sqlite-runtime.js";

const storeCall = (store, method, ...args) => new Promise((resolve, reject) => {
  store[method](...args, (error, value) => error ? reject(error) : resolve(value));
});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synergy-module-session-test-"));
  const filename = path.join(directory, "workspace.sqlite");
  const runtimes = [];
  const open = () => {
    const runtime = createSqliteRuntime({ filename, ...options });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { open };
}

test("SQLite sessions survive reopening and retain owner separation", async (t) => {
  const { open } = await fixture(t);
  let runtime = open();
  const cookie = { expires: new Date(Date.now() + 120_000).toISOString(), httpOnly: true };
  await storeCall(runtime.sessionStore, "set", "one", { cookie, operator: { id: "owner-a", discordAuth: { refreshToken: "test-credential" } } });
  await storeCall(runtime.sessionStore, "set", "two", { cookie, operator: { id: "owner-b" } });
  await runtime.close();
  runtime = open();
  assert.equal((await storeCall(runtime.sessionStore, "get", "one")).operator.id, "owner-a");
  assert.equal((await storeCall(runtime.sessionStore, "get", "one")).operator.discordAuth.refreshToken, "test-credential");
  assert.deepEqual(await runtime.sessionRegistry.listSessionIds("owner-a"), ["one"]);
  assert.deepEqual(await runtime.sessionRegistry.listSessionIds("owner-b"), ["two"]);
  assert.equal(await runtime.sessionRegistry.activeCount("owner-a"), 1);
  assert.equal(await runtime.readinessCheck(), true);
});

test("expired sessions stay expired while touches extend valid sessions without overwriting identity", async (t) => {
  let time = Date.parse("2026-09-24T12:00:00Z");
  const { open } = await fixture(t, { now: () => new Date(time) });
  const runtime = open();
  const initial = { cookie: { expires: new Date(time + 1000).toISOString() }, operator: { id: "a", roles: ["OS"] } };
  await storeCall(runtime.sessionStore, "set", "expired", initial);
  await storeCall(runtime.sessionStore, "set", "valid", initial);
  time += 500;
  await storeCall(runtime.sessionStore, "touch", "valid", {
    cookie: { expires: new Date(time + 5000).toISOString() }, operator: { id: "a", roles: ["Admin"] },
  });
  time += 700;
  assert.equal(await storeCall(runtime.sessionStore, "get", "expired"), null);
  const valid = await storeCall(runtime.sessionStore, "get", "valid");
  assert.deepEqual(valid.operator.roles, ["OS"]);
  assert.equal(valid.cookie.expires, new Date(time + 4300).toISOString());
  assert.equal(await storeCall(runtime.sessionStore, "length"), 1);
  await storeCall(runtime.sessionStore, "touch", "expired", { cookie: { expires: new Date(time + 5000).toISOString() } });
  assert.equal(await storeCall(runtime.sessionStore, "get", "expired"), null);
});

test("revoked sessions cannot return after restart or a stale request saves again", async (t) => {
  const { open } = await fixture(t);
  let runtime = open();
  const saved = { cookie: { expires: new Date(Date.now() + 60_000).toISOString() }, operator: { id: "blocked" } };
  await storeCall(runtime.sessionStore, "set", "revoked", saved);
  await runtime.sessionRegistry.markRevoked("revoked");
  await storeCall(runtime.sessionStore, "destroy", "revoked");
  await runtime.sessionRegistry.unregister("blocked", "revoked");
  await runtime.close();
  runtime = open();
  await storeCall(runtime.sessionStore, "set", "revoked", saved);
  assert.equal(await runtime.sessionRegistry.isRevoked("revoked"), true);
  assert.equal(await runtime.sessionRegistry.activeCount("blocked"), 0);
  assert.equal(await storeCall(runtime.sessionStore, "get", "revoked"), null);
});

test("clearing one user's sessions is durable and does not sign out another user", async (t) => {
  const { open } = await fixture(t);
  let runtime = open();
  for (const [sid, id] of [["a-1", "a"], ["a-2", "a"], ["b-1", "b"]]) {
    await storeCall(runtime.sessionStore, "set", sid, { operator: { id }, cookie: {} });
  }
  assert.deepEqual((await runtime.sessionRegistry.clearUser("a")).sort(), ["a-1", "a-2"]);
  await runtime.close();
  runtime = open();
  assert.equal(await runtime.sessionRegistry.activeCount("a"), 0);
  assert.equal(await runtime.sessionRegistry.activeCount("b"), 1);
  assert.equal(await runtime.sessionRegistry.isRevoked("a-1"), true);
});

test("journal entries and identity snapshots persist with account isolation and no duplicated OAuth secrets", async (t) => {
  let time = Date.parse("2026-09-24T12:00:00Z");
  const { open } = await fixture(t, { now: () => new Date(time) });
  let runtime = open();
  await runtime.userRepository.upsert({ id: "a", username: "trader", roles: ["OS"], requiredRoleGrant: "guild:role:beta-role", discordAuth: { accessToken: "must-not-copy" } });
  time += 1000;
  const identity = await runtime.userRepository.upsert({ id: "a", displayName: "Trader", roles: ["OS", "Journal"] });
  const entry = { id: "entry-1", direction: "long", entryPrice: "100", exitPrice: "102", notes: "Saved note", createdAt: new Date(time).toISOString() };
  await runtime.journalRepository.create("a", entry);
  await runtime.journalRepository.create("b", { ...entry, notes: "Other account" });
  await runtime.close();
  runtime = open();
  assert.equal((await runtime.userRepository.findById("a")).username, "trader");
  assert.equal((await runtime.userRepository.findById("a")).requiredRoleGrant, "guild:role:beta-role");
  assert.equal((await runtime.userRepository.findById("a")).firstSeenAt, "2026-09-24T12:00:00.000Z");
  assert.equal(identity.lastSeenAt, "2026-09-24T12:00:01.000Z");
  assert.doesNotMatch(JSON.stringify(await runtime.userRepository.list()), /must-not-copy|discordAuth/);
  assert.equal((await runtime.journalRepository.find("a", "entry-1")).notes, "Saved note");
  assert.equal((await runtime.journalRepository.find("b", "entry-1")).notes, "Other account");
  assert.equal(await runtime.journalRepository.find("c", "entry-1"), undefined);
  assert.deepEqual(await runtime.journalRepository.list("c"), []);
});

test("bans and previous indicator request audit records persist without reopening decided requests", async (t) => {
  const { open } = await fixture(t);
  let runtime = open();
  await runtime.banRepository.ban({ userId: "a", actorId: "admin", reason: "Review" });
  await runtime.indicatorRequestRepository.upsertPending({ userId: "a", discordUsername: "trader", tradingViewUsername: "trader", indicatorIds: ["saved-history"] });
  await runtime.indicatorRequestRepository.decide({ userId: "a", actorId: "admin", status: "GRANTED" });
  await runtime.close();
  runtime = open();
  assert.equal(await runtime.banRepository.isBanned("a"), true);
  assert.equal((await runtime.banRepository.list())[0].reason, "Review");
  assert.equal((await runtime.indicatorRequestRepository.findByUserId("a")).status, "GRANTED");
  await assert.rejects(runtime.indicatorRequestRepository.decide({ userId: "a", actorId: "admin", status: "DENIED" }), { code: "INDICATOR_REQUEST_NOT_PENDING" });
  await runtime.banRepository.unban("a");
  assert.equal(await runtime.banRepository.isBanned("a"), false);
});
