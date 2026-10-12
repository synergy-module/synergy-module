import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceRecorder, normalizeReferenceFrame } from "../../src/practice/reference-recorder.js";
import { createSolanaEvidenceClient } from "../../src/practice/solana-evidence.js";

const NOW = new Date("2026-10-12T12:00:00Z");
class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.events = {}; this.sent = []; FakeSocket.instances.push(this); }
  addEventListener(name, handler) { this.events[name] = handler; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code) { this.closed = code; }
  event(name, value = {}) { this.events[name]?.(value); }
  message(frame) { this.event("message", { data: JSON.stringify(frame) }); }
}
const frame = (seq = 1) => ({ v: 1, channel: "price.crypto", seq, payload: { symbol: "btcusd", timestamp: NOW.valueOf() - 1000, value: 100, full_accuracy_value: "100.123456789", source: "chainlink" } });
const credentials = { apiKey: "test-key", secret: "test-secret", passphrase: "test-phrase" };

test("PolyBolt recorder authenticates before subscribing and never includes credentials in its result", async () => {
  const recorded = [], recorder = createReferenceRecorder({ WebSocketImpl: FakeSocket, now: () => NOW, onSamples: rows => recorded.push(...rows) });
  const state = recorder.start({ credentials, symbols: ["btcusd"], durationSeconds: 60 });
  const socket = FakeSocket.instances.at(-1); assert.equal(socket.url, "wss://ws-live-v2.polymarket.com/ws");
  socket.event("open"); assert.equal(socket.sent.length, 1); assert.equal(socket.sent[0].op, "auth");
  socket.message({ op: "authed" }); assert.equal(socket.sent[1].op, "subscribe"); assert.equal(socket.sent[1].subscriptions.length, 2);
  socket.message(frame());
  assert.equal(recorder.status().status, "recording"); assert.equal(recorder.snapshot().samples[0].exactValue, "100.123456789");
  assert.doesNotMatch(JSON.stringify([state, recorder.snapshot()]), /test-key|test-secret|test-phrase/);
  await recorder.close(); assert.equal(recorded.length, 1); assert.equal(socket.closed, 1000);
});

test("reference sequence gaps and dropped observations stop recording", async () => {
  const recorder = createReferenceRecorder({ WebSocketImpl: FakeSocket, now: () => NOW }); recorder.start({ credentials });
  const socket = FakeSocket.instances.at(-1); socket.event("open"); socket.message({ op: "authed" }); socket.message(frame(1)); socket.message(frame(3));
  assert.equal(recorder.status().status, "error"); assert.match(recorder.status().lastError, /sequence gap/); await recorder.close();
});

test("reference lease expires and malformed subscription credentials never open a socket", async () => {
  const timers = [], recorder = createReferenceRecorder({ WebSocketImpl: FakeSocket, now: () => NOW,
    setTimer: (fn, delay) => { const entry = { fn, delay }; timers.push(entry); return entry; }, clearTimer: () => {} });
  const previous = FakeSocket.instances.length;
  assert.throws(() => recorder.start({ credentials: { apiKey: "missing-secret" } }), { code: "PRACTICE_REFERENCE_INVALID" }); assert.equal(FakeSocket.instances.length, previous);
  recorder.start({ credentials, durationSeconds: 60 }); timers.find(row => row.delay === 60000).fn(); assert.equal(recorder.status().status, "stopped"); await recorder.close();
});

test("reference normalization rejects carried prices and future messages; snapshots retain their receipt clock", () => {
  assert.deepEqual(normalizeReferenceFrame({ ...frame(), payload: { ...frame().payload, is_carried_forward: true } }, { receivedAt: NOW.toISOString() }), []);
  const snapshot = { ...frame(), snapshot: true, payload: { symbol: "btcusd", data: [{ timestamp: NOW.valueOf() - 60000, value: "99" }] } };
  const rows = normalizeReferenceFrame(snapshot, { receivedAt: NOW.toISOString() });
  assert.equal(rows[0].availableAt, NOW.toISOString()); assert.equal(rows[0].timestamp, "2026-10-12T11:59:00.000Z");
});

test("Solana read-only enrichment validates mint authorities and never invents deployer safety", async () => {
  const mint = "So11111111111111111111111111111111111111112", owner = "11111111111111111111111111111111", holder = "11111111111111111111111111111112";
  const calls = [], api = createSolanaEvidenceClient({ now: () => NOW, fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.mainnet-beta.solana.com"); const body = JSON.parse(options.body); calls.push(body.method);
    if (body.method === "getAccountInfo") return Response.json({ result: { context: { slot: 1 }, value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: "1000" } } } } } });
    if (body.method === "getTokenLargestAccounts") return Response.json({ result: { context: { slot: 1 }, value: [{ address: holder, amount: "100" }] } });
    return Response.json({ result: { value: [{ data: { parsed: { info: { mint, owner } } } }] } });
  } });
  const result = await api.inspect({ address: mint }); assert.equal(result.security.mintAuthorityRevoked, true); assert.equal(result.security.topHolderPercent, 10);
  assert.equal(result.security.serialDeployer, null); assert.equal(result.security.concentrationIsLowerBound, true);
  assert.deepEqual(calls, ["getAccountInfo", "getTokenLargestAccounts", "getMultipleAccounts"]);
});
