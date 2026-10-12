import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryWorkspaceRepository } from "../../src/settings/workspace-repository.js";
import { createPracticeFeedService } from "../../src/practice/feed-service.js";

const credentials = { apiKey: "international-key", secret: "international-secret", passphrase: "international-passphrase" };
function fixture() {
  const sockets = [], timers = new Set(), banned = new Set(), repository = createMemoryWorkspaceRepository();
  const clock = new Date("2026-10-12T16:00:00.000Z");
  class FakeSocket {
    constructor(url) { this.url = url; this.events = new Map(); this.sent = []; this.closed = false; sockets.push(this); }
    addEventListener(name, listener) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(listener); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.closed = true; this.emit("close", { code: 1000 }); }
    emit(name, event = {}) { for (const callback of this.events.get(name) ?? []) callback(event); }
    message(value) { this.emit("message", { data: JSON.stringify(value) }); }
  }
  const service = createPracticeFeedService({ repository, encryptionSecret: "practice-feed-test-stable-secret-32", WebSocketImpl: FakeSocket,
    now: () => clock, canOperate: async owner => !banned.has(owner),
    setTimer: (work, duration) => { const timer = { work, duration, unref() {} }; timers.add(timer); return timer; }, clearTimer: timer => timers.delete(timer) });
  const sample = (sequence = 1) => ({ v: 1, channel: "price.crypto", seq: sequence,
    payload: { symbol: "btcusd", value: "60000.123456789", timestamp: clock.valueOf() } });
  return { service, sockets, timers, banned, repository, sample };
}

test("international data credentials are encrypted, owner bound and absent from all responses", async () => {
  const f = fixture();
  const state = await f.service.connect("alice", credentials);
  assert.equal(state.polybolt.configured, true);
  assert.equal(f.sockets.length, 0, "saving credentials must not contact a provider");
  assert.equal(JSON.stringify(state).includes(credentials.secret), false);
  const stored = await f.repository.read("alice");
  assert.equal(JSON.stringify(stored).includes(credentials.secret), false);
  await f.repository.update("bob", state => { state.practiceFeeds = stored.practiceFeeds; });
  assert.equal((await f.service.state("bob")).polybolt.configured, false);
  await assert.rejects(() => f.service.start("bob", {}), error => error.status === 503);
  await f.service.close();
});

test("recorder uses fixed data-only websocket, persists bounded owner samples and stops cleanly", async () => {
  const f = fixture();
  await f.service.connect("alice", credentials);
  await f.service.start("alice", { symbols: ["btcusd"], channels: ["price.crypto"], durationSeconds: 60 });
  const socket = f.sockets[0];
  assert.equal(socket.url, "wss://ws-live-v2.polymarket.com/ws");
  socket.emit("open"); socket.message({ op: "authed" }); socket.message({ op: "subscribed" }); socket.message(f.sample());
  assert.deepEqual(socket.sent.map(frame => frame.op), ["auth", "subscribe"]);
  assert.equal((await f.service.snapshot("alice", {})).samples[0].exactValue, "60000.123456789");
  assert.equal((await f.service.snapshot("bob", {})).samples.length, 0);
  await f.service.stop("alice");
  assert.equal(socket.closed, true);
  assert.equal(f.timers.size, 0);
  const saved = await f.service.snapshot("alice", {});
  assert.equal(saved.status, "stopped");
  assert.equal(saved.samples.length, 1, "recorded observations survive recorder shutdown");
  assert.equal(JSON.stringify(saved).includes(credentials.secret), false);
  await f.service.disconnect("alice");
  assert.equal((await f.service.state("alice")).polybolt.configured, false);
  assert.equal((await f.repository.read("alice")).practiceFeeds.polybolt, undefined);
  await f.service.close();
});

test("banned and expired-admission accounts cannot start or continue reference collection", async () => {
  const f = fixture();
  await f.service.connect("alice", credentials);
  f.banned.add("alice");
  await assert.rejects(() => f.service.start("alice", {}), error => error.status === 401);
  assert.equal(f.sockets.length, 0);
  f.banned.delete("alice");
  await f.service.start("alice", {});
  f.banned.add("alice");
  const guard = [...f.timers].find(timer => timer.duration === 30_000);
  await guard.work();
  assert.equal(f.sockets[0].closed, true);
  assert.equal((await f.service.state("alice")).polybolt.recorder.status, "stopped");
  await f.service.close();
});

test("invalid credentials, destinations, sample filters and duration fail without a connection", async () => {
  const f = fixture();
  await assert.rejects(() => f.service.connect("alice", { ...credentials, url: "wss://attacker.example" }), error => error.status === 422);
  await assert.rejects(() => f.service.connect("alice", { ...credentials, secret: "has whitespace" }), error => error.status === 422);
  await f.service.connect("alice", credentials);
  await assert.rejects(() => f.service.start("alice", { durationSeconds: 3601 }), error => error.status === 422);
  await assert.rejects(() => f.service.start("alice", { symbols: ["unsupported"] }), error => error.status === 422);
  await assert.rejects(() => f.service.start("alice", { url: "wss://attacker.example" }), error => error.status === 422);
  await assert.rejects(() => f.service.snapshot("alice", { limit: 1001 }), error => error.status === 422);
  assert.equal(f.sockets.length, 0);
  await f.service.close();
});

test("service refuses credential writes without stable encryption and bounds active recorders", async () => {
  const repository = createMemoryWorkspaceRepository();
  const locked = createPracticeFeedService({ repository });
  await assert.rejects(() => locked.connect("alice", credentials), error => error.status === 503);
  assert.equal((await locked.state("alice")).polybolt.credentialStorageAvailable, false);
  await locked.close();
  const f = fixture();
  for (let index = 0; index < 20; index++) { await f.service.connect(`owner${index}`, credentials); await f.service.start(`owner${index}`, {}); }
  await f.service.connect("overflow", credentials);
  await assert.rejects(() => f.service.start("overflow", {}), error => error.status === 429);
  await f.service.close();
  assert.equal(f.timers.size, 0);
  assert.ok(f.sockets.every(socket => socket.closed));
});
