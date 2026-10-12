import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryWorkspaceRepository, createSqliteWorkspaceRepository } from "../../src/settings/workspace-repository.js";
import { createPracticeService, normalizePracticeQuote } from "../../src/practice/practice-service.js";

const initialTime = Date.parse("2026-10-12T12:00:00Z");
const spec = { name: "Forward manual account", strategyId: "manual", initialCapital: 500, risk: { positionUsd: 100, feeBps: 10, slippageBps: 10 }, feed: { source: "binance", instrument: "BINANCE:BTCUSDT" } };
function fixture(options = {}) {
  let clock = initialTime, price = 100;
  const calls = [], repository = options.repository ?? createMemoryWorkspaceRepository();
  const marketData = { async quote(feed) { calls.push(feed); clock += 1000; return { instrument: feed.instrument, timestamp: new Date(clock).toISOString(), observedAt: new Date(clock).toISOString(), price, bid: price - 0.1, ask: price + 0.1, liquidity: 10000, signals: {} }; } };
  const service = createPracticeService({ repository, marketData, now: () => new Date(clock), ...options });
  return { repository, service, calls, now: () => new Date(clock).toISOString(), advance: () => { clock += 1000; }, setPrice: value => { price = value; } };
}

test("paper orders fetch live quotes, reconcile fees and preserve every real account field", async t => {
  const f = fixture(); t.after(() => f.service.close());
  await f.repository.update("alice", s => { s.broker = { cash: 9999 }; s.polymarket = { live: "untouched" }; });
  const before = await f.repository.read("alice"), book = await f.service.createBook("alice", spec);
  const bought = await f.service.placeOrder("alice", book.id, { side: "BUY", budgetUsd: 50, requestId: "buy-request-1" });
  assert.equal(f.calls.length, 1); assert.equal(bought.trades.length, 1); assert.equal(bought.positions.length, 1);
  assert.ok(Math.abs(bought.cash - 450) < 1e-6); assert.ok(bought.feesPaid > 0); assert.equal(bought.qa.cashReconciles, true);
  assert.equal(bought.mode, "PAPER"); assert.deepEqual(await f.repository.read("alice"), before);
  const repeated = await f.service.placeOrder("alice", book.id, { side: "BUY", budgetUsd: 50, requestId: "buy-request-1" });
  assert.equal(repeated.trades.length, 1); assert.equal(f.calls.length, 1);
  f.setPrice(110);
  const sold = await f.service.placeOrder("alice", book.id, { side: "SELL", positionId: bought.positions[0].id, requestId: "sell-request-1" });
  assert.equal(sold.positions.length, 0); assert.equal(sold.trades.length, 2); assert.ok(sold.realizedPnl > 0);
  assert.equal(sold.qa.cashReconciles, true); assert.equal(sold.readiness.liveExecutionEnabled, false);
});

test("paper accounts and orders are owner isolated and reject live execution or supplied price overrides", async t => {
  const f = fixture(); t.after(() => f.service.close());
  const book = await f.service.createBook("alice", spec);
  assert.equal((await f.service.state("bob")).books.length, 0);
  await assert.rejects(f.service.book("bob", book.id), { status: 404 });
  await assert.rejects(f.service.placeOrder("bob", book.id, { side: "BUY", budgetUsd: 25 }), { status: 404 });
  await assert.rejects(f.service.createBook("alice", { ...spec, mode: "live" }), { status: 422 });
  await assert.rejects(f.service.placeOrder("alice", book.id, { side: "BUY", budgetUsd: 25, price: 1 }), { status: 422 });
  await assert.rejects(f.service.start("alice", book.id, { mode: "LIVE" }), { status: 422 });
  assert.equal(f.calls.length, 0);
});

test("concurrent paper orders are transactional and exposure limits cannot spend virtual cash twice", async t => {
  const f = fixture(); t.after(() => f.service.close());
  const book = await f.service.createBook("alice", { ...spec, initialCapital: 100, risk: { positionUsd: 100, maxExposurePercent: 100 } });
  const results = await Promise.allSettled([f.service.placeOrder("alice", book.id, { side: "BUY", budgetUsd: 80 }), f.service.placeOrder("alice", book.id, { side: "BUY", budgetUsd: 80 })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const state = await f.service.book("alice", book.id); assert.ok(state.cash >= 0); assert.equal(state.trades.length, 1);
});

test("market observations reject stale/future data, duplicate events and invalid fee math", async t => {
  const f = fixture(); t.after(() => f.service.close()); const book = await f.service.createBook("alice", spec);
  const quote = { instrument: "BINANCE:BTCUSDT", timestamp: f.now(), price: 100, bid: 99, ask: 101, liquidity: 1000 };
  await f.service.observe("alice", book.id, { quote });
  await assert.rejects(f.service.observe("alice", book.id, { quote }), { status: 409 });
  await assert.rejects(f.service.observe("alice", book.id, { quote: { ...quote, timestamp: "2026-10-13T00:00:00Z" } }), { status: 422 });
  await assert.rejects(f.service.observe("alice", book.id, { quote: { ...quote, observedAt: "2026-10-11T00:00:00Z" } }), { status: 422 });
  for (const signals of [{ feeExponent: "oops", feeRate: 0.1 }, { feeExponent: -1, feeRate: 1 }, { feeRate: Infinity }]) assert.throws(() => normalizePracticeQuote({ ...quote, signals }), { status: 422 });
});

test("atomic paired paper entries buy equal shares and reject insufficient depth on either side", async t => {
  let depth = 1;
  const evaluator = () => ({ action: "BUY", reason: "Pair evidence", equalShares: true, legs: [
    { instrument: "A", price: 0.3, ask: 0.3, bid: 0.29, liquidity: 100 }, { instrument: "B", price: 0.6, ask: 0.6, bid: 0.59, liquidity: depth },
  ] });
  const f = fixture({ evaluator }); t.after(() => f.service.close());
  const book = await f.service.createBook("alice", { ...spec, strategyId: "paired-outcomes", feed: { source: "polymarket", instrument: "POLY:1", marketId: "1" } });
  const quote = () => ({ instrument: "A", timestamp: f.now(), price: 0.3, bid: 0.29, ask: 0.3, liquidity: 100, signals: { feeRate: 0 } });
  let result = await f.service.observe("alice", book.id, { quote: quote() }); assert.equal(result.trades.length, 0); assert.equal(result.cash, 500); assert.equal(result.decisions.at(-1).action, "HOLD");
  depth = 100; f.advance(); result = await f.service.observe("alice", book.id, { quote: quote() });
  assert.equal(result.positions.length, 2); assert.equal(result.positions[0].quantity, result.positions[1].quantity); assert.equal(result.positions[0].groupId, result.positions[1].groupId); assert.equal(result.qa.cashReconciles, true);
});

test("refresh marks current positions without new trades and old closing evidence is rejected", async t => {
  const f = fixture(); t.after(() => f.service.close()); const book = await f.service.createBook("alice", spec);
  const bought = await f.service.placeOrder("alice", book.id, { side: "BUY", budgetUsd: 25 }); const oldTime = f.now();
  f.setPrice(90); const refreshed = await f.service.refreshBook("alice", book.id);
  assert.equal(refreshed.trades.length, 1); assert.ok(refreshed.equity < bought.equity); assert.ok(refreshed.maxDrawdownPercent > 0);
  await assert.rejects(f.service.closePosition("alice", book.id, bought.positions[0].id, { quote: { instrument: "BINANCE:BTCUSDT", timestamp: oldTime, price: 110, bid: 110, ask: 111, liquidity: 1000 } }), { status: 409 });
  await assert.rejects(f.service.removeBook("alice", book.id), { status: 409 });
});

test("paper balances survive SQLite restart and saved workers do not falsely report running", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "synergy-practice-"));
  const filename = path.join(directory, "test.sqlite"); let repository = createSqliteWorkspaceRepository(filename);
  let f = fixture({ repository }); const book = await f.service.createBook("alice", spec);
  await f.service.placeOrder("alice", book.id, { side: "BUY", budgetUsd: 25 });
  await f.service.start("alice", book.id, { intervalSeconds: 300 }); await f.service.close(); await repository.close();
  repository = createSqliteWorkspaceRepository(filename); f = fixture({ repository }); t.after(async () => { await f.service.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const state = await f.service.state("alice"); assert.equal(state.books[0].trades.length, 1); assert.equal(state.books[0].worker.enabled, false); assert.match(state.books[0].worker.lastError, /restart/);
});

test("shutdown and a pause/restart invalidate quote work already in flight", async t => {
  for (const operation of ["close", "restart"]) await t.test(operation, async () => {
    let release, entered; const quotesStarted = new Promise(resolve => { entered = resolve; });
    const queue = [], service = createPracticeService({ repository: createMemoryWorkspaceRepository(), now: () => new Date(initialTime),
      marketData: { async quote() { entered(); await new Promise(resolve => { release = resolve; }); return { instrument: "BINANCE:BTCUSDT", timestamp: new Date(initialTime + 1000).toISOString(), bid: 99, ask: 100, liquidity: 10000 }; } },
      evaluator: () => ({ action: "BUY", reason: "Lifecycle fixture" }), setTimer: callback => { const timer = { callback }; queue.push(timer); return timer; }, clearTimer: timer => { if (timer) timer.cancelled = true; } });
    const book = await service.createBook("alice", spec); await service.start("alice", book.id);
    const work = queue[0].callback(); await quotesStarted;
    let closing;
    if (operation === "close") closing = service.close();
    else { await service.pause("alice", book.id); await service.start("alice", book.id); }
    release(); await work; await closing;
    assert.equal((await service.book("alice", book.id)).trades.length, 0);
    await service.close();
  });
});

test("a failed deletion index write is retryable and does not break the workspace", async t => {
  const backing = createMemoryWorkspaceRepository(); let failIndex = false;
  const repository = { ...backing, async update(owner, change) { if (failIndex && owner.endsWith(":index:")) { failIndex = false; throw new Error("Storage interrupted"); } return backing.update(owner, change); } };
  const f = fixture({ repository }); t.after(() => f.service.close()); const book = await f.service.createBook("alice", spec);
  failIndex = true; await assert.rejects(f.service.removeBook("alice", book.id), /Storage interrupted/);
  assert.deepEqual((await f.service.state("alice")).books, []);
  await assert.rejects(f.service.placeOrder("alice", book.id, { side: "BUY", budgetUsd: 20 }), { status: 404 });
  assert.deepEqual(await f.service.removeBook("alice", book.id), { ok: true });
});

test("closing a resolved position uses verified payout with no book-depth or exit-fee fiction", async t => {
  let clock = initialTime, settled = false;
  const service = createPracticeService({ repository: createMemoryWorkspaceRepository(), now: () => new Date(clock), marketData: { async quote() { clock += 1000; return { instrument: "POLY:1", timestamp: new Date(clock).toISOString(), bid: settled ? 1 : 0.49, ask: settled ? 1 : 0.5, liquidity: settled ? 0 : 10000, ...(settled ? { settlement: { payout: 1, source: "Verified fixture resolution" }, signals: { resolution: { ruleChanged: true, payoutsMicro: [1000000, 0] } } } : {}) }; } } });
  t.after(() => service.close()); const book = await service.createBook("alice", { ...spec, feed: { source: "polymarket", instrument: "POLY:1", marketId: "1" } });
  const entry = await service.placeOrder("alice", book.id, { side: "BUY", budgetUsd: 20 }); settled = true;
  const result = await service.placeOrder("alice", book.id, { side: "SELL", positionId: entry.positions[0].id });
  assert.equal(result.positions.length, 0); assert.equal(result.trades.at(-1).side, "SETTLE"); assert.equal(result.trades.at(-1).fee, 0); assert.equal(result.qa.cashReconciles, true);
  assert.equal(result.trades.at(-1).ruleChanged, true); assert.deepEqual(result.trades.at(-1).resolution.payoutsMicro, [1000000, 0]);
  assert.equal(result.readiness.settledGroups, 0); assert.equal(result.readiness.excludedOrOpenGroups, 1);
});

test("whole-wallet cycles mark existing markets and close each position against its own market", async t => {
  let clock = initialTime; const calls = [], queue = [], endDate = new Date(initialTime + 600000).toISOString();
  const quote = (instrument, marketId, bid = 0.49) => ({ instrument, timestamp: new Date(clock += 1000).toISOString(), bid, ask: bid + 0.01, liquidity: 10000,
    signals: { marketId, conditionId: `condition-${marketId}`, endDate, feeRate: 0 } });
  const service = createPracticeService({ repository: createMemoryWorkspaceRepository(), now: () => new Date(clock),
    evaluator: () => ({ action: "BUY", reason: "Verified copy fixture" }), setTimer: callback => { const timer = { callback }; queue.push(timer); return timer; }, clearTimer() {},
    marketData: {
      async quote(feed) { calls.push({ ...feed }); return quote(feed.instrument, feed.marketId, feed.instrument === "POLY:1" ? 0.55 : 0.49); },
      async wallet({ address }) { return { address, eligible: true, checkedAt: new Date(clock).toISOString(), trades: [{ tokenId: "2", conditionId: "condition-2", transaction: "new-buy-2", side: "BUY", price: 0.5, outcome: "Yes", timestamp: new Date(initialTime - 1000).toISOString() }] }; },
      async marketForOutcome() { return { source: "polymarket", instrument: "POLY:2", marketId: "2", conditionId: "condition-2", endDate, outcome: "Yes", slug: "fixture-market" }; },
    } });
  t.after(() => service.close());
  const book = await service.createBook("alice", { ...spec, strategyId: "wallet-copy", feed: { source: "polymarket", instrument: "POLY:1", marketId: "1", walletAddress: `0x${"a".repeat(40)}`, followAllMarkets: true } });
  const first = await service.observe("alice", book.id, { quote: quote("POLY:1", "1") });
  await service.start("alice", book.id); await queue[0].callback(); await service.pause("alice", book.id);
  const state = await service.book("alice", book.id);
  assert.equal(state.positions.length, 2); assert.equal(state.feed.instrument, "POLY:2");
  assert.equal(state.positions.find(p => p.instrument === "POLY:1").markPrice, 0.55);
  assert.equal(state.positions.find(p => p.instrument === "POLY:2").marketId, "2");
  await service.placeOrder("alice", book.id, { side: "SELL", positionId: first.positions[0].id });
  assert.equal(calls.at(-1).instrument, "POLY:1"); assert.equal(calls.at(-1).marketId, "1");
  const remaining = await service.book("alice", book.id); assert.equal(remaining.positions.length, 1); assert.equal(remaining.qa.cashReconciles, true);
});
