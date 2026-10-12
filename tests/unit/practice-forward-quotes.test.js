import test from "node:test";
import assert from "node:assert/strict";
import { createPracticeService } from "../../src/practice/practice-service.js";
import { createMemoryWorkspaceRepository } from "../../src/settings/workspace-repository.js";
import { parseWeatherCalibrationCsv } from "../../public/js/practice-feed-fields.js";

const start = Date.parse("2026-10-12T12:00:30Z"), iso = value => new Date(value).toISOString();
function fixture({ strategyId, feed = {}, config = {}, methods = {}, referenceFeeds } = {}) {
  let clock = start, prints = [], forecastHigh = 20;
  const queue = [], calls = [], repository = createMemoryWorkspaceRepository();
  const data = {
    async quote(input) { calls.push("quote"); clock += 1000; return { instrument: "POLY:111", timestamp: iso(clock), observedAt: iso(clock), price: 0.2, bid: 0.19, ask: 0.21, liquidity: 1000,
      publicTrades: prints, signals: { feeRate: 0, feeExponent: 1, outcome: "Up", endDate: feed.windowEndsAt ?? "2026-10-13T23:00:00Z", marketSlug: "btc-updown-5m-1791806400", conditionId: "condition" } }; },
    async cryptoModel(input) { calls.push("model"); clock += 1000; return { ...input, modelObservedAt: iso(clock), fairProbability: 0.9 }; },
    async wallet() { calls.push("wallet"); clock += 1000; return { address: `0x${"a".repeat(40)}`, checkedAt: iso(clock), eligible: true, allTimePnl: 100, recentClosedPnl: 20, recentClosedCount: 50,
      highFrequency: false, trades: [{ tokenId: "111", side: "BUY", price: 0.21, timestamp: iso(clock - 3000), transaction: "transaction-1" }] }; },
    async weather() { calls.push("weather"); clock += 1000; return { observedAt: iso(clock), models: [{ model: "gfs_seamless", high: forecastHigh }] }; },
    async weatherEnsemble() { calls.push("ensemble"); clock += 1000; return { observedAt: iso(clock), model: "ecmwf_ifs025", members: Array(51).fill(21) }; },
    ...methods,
  };
  const service = createPracticeService({ repository, marketData: data, referenceFeeds, now: () => new Date(clock), setTimer: callback => { const timer = { callback }; queue.push(timer); return timer; }, clearTimer: timer => { if (timer) timer.cancelled = true; } });
  return { service, calls, create: () => service.createBook("alice", { name: "Current evidence", strategyId, config, feed: { source: "polymarket", instrument: "POLY:111", marketId: "1", ...feed } }),
    async tick() { const timer = queue.shift(); assert.ok(timer); if (!timer.cancelled) await timer.callback(); }, advance: ms => { clock += ms; }, now: () => iso(clock), setPrints: value => { prints = value; }, setForecast: value => { forecastHigh = value; } };
}

test("automatic crypto gathers evidence before quote, fills forward and stops on pause", async t => {
  const f = fixture({ strategyId: "crypto-directional", config: { minPrice: 0.1 }, feed: { asset: "BTC", referenceMode: "proxy", windowOpenedAt: "2026-10-12T12:00:00Z", windowEndsAt: "2026-10-12T12:05:00Z" } }); t.after(() => f.service.close());
  const book = await f.create(); await f.service.start("alice", book.id); await f.tick();
  const result = await f.service.book("alice", book.id); assert.deepEqual(f.calls, ["model", "quote"]); assert.equal(result.trades.length, 1); assert.equal(result.worker.lastError, null);
  await f.service.pause("alice", book.id); await f.tick(); assert.equal(f.calls.length, 2);
  await assert.rejects(f.service.publicData("cryptoModel", { referenceTicks: [] }), /Public crypto model/);
});

test("recorded crypto uses only owner's recorder and refuses an absent opening sample", async t => {
  const owners = [], f = fixture({ strategyId: "crypto-directional", feed: { asset: "BTC", referenceMode: "recorded", windowOpenedAt: "2026-10-12T12:00:00Z", windowEndsAt: "2026-10-12T12:05:00Z" },
    referenceFeeds: { async snapshot(owner) { owners.push(owner); return { samples: [] }; } } }); t.after(() => f.service.close());
  const book = await f.create(); await f.service.start("alice", book.id); await f.tick(); const result = await f.service.book("alice", book.id);
  assert.deepEqual(owners, ["alice"]); assert.equal(result.trades.length, 0); assert.match(result.worker.lastError, /Record reference prices/); assert.equal(f.calls.length, 0);
});

test("automatic wallet copy matches the selected outcome and screens current closed results", async t => {
  const f = fixture({ strategyId: "wallet-copy", feed: { walletAddress: `0x${"a".repeat(40)}` } }); t.after(() => f.service.close());
  const book = await f.create(); await f.service.start("alice", book.id); await f.tick(); const result = await f.service.book("alice", book.id);
  assert.deepEqual(f.calls, ["wallet", "quote"]); assert.equal(result.trades.length, 1); assert.match(result.trades[0].reason, /qualified public wallet/);
});

test("maker worker saves an actual resting observation before accepting a later sell print", async t => {
  const f = fixture({ strategyId: "maker-resting", config: { bidPrice: 0.2 } }); t.after(() => f.service.close());
  const book = await f.create(); await f.service.start("alice", book.id); await f.tick(); let result = await f.service.book("alice", book.id);
  assert.equal(result.trades.length, 0); assert.ok(result.forwardEvidence.maker.placedAt);
  f.advance(60000); f.setPrints([{ side: "SELL", price: 0.19, shares: 100, timestamp: f.now(), transaction: "maker-print" }]); await f.tick(); result = await f.service.book("alice", book.id);
  assert.equal(result.trades.length, 1); assert.equal(result.trades[0].price, 0.2); assert.ok(result.trades[0].quantity <= 100);
});

function weatherFeed() {
  return { weather: { station: "KNYC", settlementStation: "KNYC", latitude: 40.78, longitude: -73.97, date: "2026-10-13", timezone: "America/New_York", metric: "high", bucketLower: 20, bucketUpper: 22, leadHours: 24,
    calibrationRecords: Array.from({ length: 7 }, (_, i) => { const target = Date.parse(`2026-10-0${i + 2}T23:00:00Z`); return { station: "KNYC", model: "gfs_seamless", targetAt: iso(target), issuedAt: iso(target - 86400000), availableAt: iso(target - 86400000), predicted: 21, actual: 20, actualObservedAt: iso(target + 3600000) }; }) } };
}
test("weather forecast worker records a baseline then trades a later calibrated change", async t => {
  const f = fixture({ strategyId: "weather-forecast", feed: weatherFeed() }); t.after(() => f.service.close());
  const book = await f.create(); await f.service.start("alice", book.id); await f.tick(); assert.equal((await f.service.book("alice", book.id)).trades.length, 0);
  f.advance(1800000); f.setForecast(22); await f.tick(); const result = await f.service.book("alice", book.id);
  assert.equal(result.worker.lastError, null); assert.equal(result.trades.length, 1); assert.match(result.trades[0].reason, /station forecast/);
});

test("weather ensemble maker observes models then a nonmarketable bid then a later sell", async t => {
  const feed = weatherFeed(); feed.weather.calibrationRecords.push(...feed.weather.calibrationRecords.map(row => ({ ...row, model: "ecmwf_ifs025" })));
  const f = fixture({ strategyId: "weather-forecast", config: { makerMode: true }, feed }); t.after(() => f.service.close());
  const book = await f.create(); await f.service.start("alice", book.id); await f.tick();
  f.advance(1800000); f.setForecast(22); await f.tick(); let result = await f.service.book("alice", book.id);
  assert.equal(result.trades.length, 0); assert.ok(result.forwardEvidence.weatherMaker);
  f.advance(60000); f.setPrints([{ side: "SELL", price: 0.18, shares: 50, timestamp: f.now(), transaction: "weather-print" }]); await f.tick(); result = await f.service.book("alice", book.id);
  assert.equal(result.worker.lastError, null); assert.equal(result.trades.length, 1); assert.ok(result.trades[0].quantity <= 50);
});

test("weather calibration CSV parser validates shape and preserves dated numeric measurements", () => {
  const values = weatherFeed().weather.calibrationRecords, headers = Object.keys(values[0]), csv = [headers.join(","), ...values.map(row => headers.map(key => row[key]).join(","))].join("\n");
  assert.deepEqual(parseWeatherCalibrationCsv(csv), values);
  assert.throws(() => parseWeatherCalibrationCsv(csv.replace("21,20", "oops,20")), /Celsius temperature/);
  assert.throws(() => parseWeatherCalibrationCsv("station,model\nKNYC,gfs"), /template columns/);
});

test("expired crypto positions check provider settlement before attempting an unavailable model", async t => {
  let resolved = false;
  const f = fixture({ strategyId: "crypto-directional", config: { minPrice: 0.1 }, feed: { asset: "BTC", referenceMode: "proxy", windowOpenedAt: "2026-10-12T12:00:00Z", windowEndsAt: "2026-10-12T12:05:00Z" },
    methods: { async settlement() { return resolved ? { instrument: "POLY:111", timestamp: f.now(), observedAt: f.now(), price: 1, bid: 1, ask: 1, liquidity: 0, signals: { endDate: "2026-10-12T12:05:00Z" }, settlement: { payout: 1, source: "https://clob.polymarket.com/markets/verified-condition" } } : null; } } }); t.after(() => f.service.close());
  const book = await f.create(); await f.service.start("alice", book.id); await f.tick(); assert.equal((await f.service.book("alice", book.id)).positions.length, 1);
  f.advance(300000); resolved = true; await f.tick(); const result = await f.service.book("alice", book.id);
  assert.equal(result.positions.length, 0); assert.equal(result.trades.at(-1).side, "SETTLE"); assert.equal(f.calls.filter(call => call === "model").length, 1);
});

test("opt-in crypto advance discovers a new current window only after old positions are absent", async t => {
  let discoveryCalls = 0;
  const f = fixture({ strategyId: "crypto-directional", config: { minPrice: 0.1 }, feed: { asset: "BTC", referenceMode: "proxy", autoAdvance: true, direction: "Down", windowOpenedAt: "2026-10-12T11:55:00Z", windowEndsAt: "2026-10-12T12:00:00Z" },
    methods: { async cryptoWindow(input) { discoveryCalls++; assert.equal(input.outcome, "Down"); return { source: "polymarket", marketId: "2", instrument: "POLY:222", outcomeIndex: 1, direction: "Down", asset: "BTC", windowOpenedAt: "2026-10-12T12:00:00Z", windowEndsAt: "2026-10-12T12:05:00Z" }; },
      async quote(input) { return { instrument: input.instrument, timestamp: f.now(), observedAt: f.now(), price: 0.2, bid: 0.19, ask: 0.21, liquidity: 1000, signals: { outcome: "Down", marketSlug: "btc-updown-5m-1791806400", endDate: input.windowEndsAt, feeRate: 0, feeExponent: 1 } }; } } }); t.after(() => f.service.close());
  const book = await f.create(); await f.service.start("alice", book.id); await f.tick(); const result = await f.service.book("alice", book.id);
  assert.equal(discoveryCalls, 1); assert.equal(result.feed.marketId, "2"); assert.equal(result.feed.direction, "Down"); assert.equal(result.worker.lastError, null);
});

test("whole-wallet following binds a new market, preserves qualification and never replays a consumed buy", async t => {
  const conditionId = `0x${"b".repeat(64)}`; let lookupCount = 0, eligible = true;
  const f = fixture({ strategyId: "wallet-copy", feed: { walletAddress: `0x${"a".repeat(40)}`, followAllMarkets: true }, methods: {
    async wallet() { f.advance(1000); return { address: `0x${"a".repeat(40)}`, checkedAt: f.now(), eligible, allTimePnl: eligible ? 100 : -1, recentClosedPnl: 20, recentClosedCount: 50, highFrequency: false,
      trades: [{ tokenId: "222", conditionId, outcome: "No", side: "BUY", price: 0.21, timestamp: iso(Date.parse(f.now()) - 3000), transaction: "cross-market-buy" }] }; },
    async marketForOutcome(input) { lookupCount++; assert.equal(input.conditionId, conditionId); assert.equal(input.instrument, "POLY:222"); return { source: "polymarket", marketId: "9", instrument: "POLY:222", outcomeIndex: 1, conditionId, outcome: "No", endDate: "2026-10-13T23:00:00Z", slug: "other-market" }; },
    async quote(input) { return { instrument: input.instrument, timestamp: f.now(), observedAt: f.now(), price: 0.2, bid: 0.19, ask: 0.21, liquidity: 1000, signals: { marketId: input.marketId, conditionId, outcome: "No", feeRate: 0, feeExponent: 1, endDate: "2026-10-13T23:00:00Z" } }; },
  } }); t.after(() => f.service.close());
  const book = await f.create(); await f.service.start("alice", book.id); eligible = false; await f.tick(); assert.equal(lookupCount, 0); assert.equal((await f.service.book("alice", book.id)).trades.length, 0);
  eligible = true; await f.tick(); let result = await f.service.book("alice", book.id); assert.equal(result.trades.length, 1); assert.equal(result.feed.marketId, "9"); assert.equal(result.positions[0].instrument, "POLY:222");
  f.advance(60000); await f.tick(); result = await f.service.book("alice", book.id); assert.equal(result.trades.length, 1); assert.equal(lookupCount, 1);
});

test("whole-wallet following rejects a provider quote for another condition before any paper fill", async t => {
  const conditionId = `0x${"b".repeat(64)}`;
  const f = fixture({ strategyId: "wallet-copy", feed: { walletAddress: `0x${"a".repeat(40)}`, followAllMarkets: true }, methods: {
    async wallet() { return { address: `0x${"a".repeat(40)}`, checkedAt: f.now(), eligible: true, allTimePnl: 100, recentClosedPnl: 20, recentClosedCount: 50,
      trades: [{ tokenId: "222", conditionId, side: "BUY", price: 0.21, timestamp: iso(start - 3000), transaction: "mismatched-buy" }] }; },
    async marketForOutcome() { return { source: "polymarket", marketId: "9", instrument: "POLY:222", conditionId, endDate: "2026-10-13T00:00:00Z" }; },
    async quote() { return { instrument: "POLY:222", timestamp: f.now(), price: 0.2, bid: 0.19, ask: 0.21, liquidity: 1000, signals: { conditionId: "wrong-condition" } }; },
  } }); t.after(() => f.service.close()); const book = await f.create(); await f.service.start("alice", book.id); await f.tick();
  const result = await f.service.book("alice", book.id); assert.equal(result.trades.length, 0); assert.match(result.worker.lastError, /verified wallet market/);
});
