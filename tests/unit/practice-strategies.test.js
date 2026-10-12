import test from "node:test";
import assert from "node:assert/strict";
import { strategyDefinitions, evaluateStrategy, validateStrategyConfig, cryptoProbability, weatherProbability, fractionalKelly } from "../../src/practice/strategies.js";

const NOW = "2026-10-12T12:01:00.000Z", before = seconds => new Date(Date.parse(NOW) - seconds * 1000).toISOString(), after = seconds => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
const quote = (signals = {}, extra = {}) => ({ instrument: "POLY:111", timestamp: NOW, price: 0.7, bid: 0.69, ask: 0.7, liquidity: 500,
  signals: { feeRate: 0.01, windowEndsAt: after(840), ...signals }, ...extra });
const evaluate = (id, q, options = {}) => evaluateStrategy(id, { quote: q, ...options });

test("strategy catalog exposes editable bounded configuration and a manual paper mode", () => {
  assert.equal(strategyDefinitions.length, 9);
  for (const strategy of strategyDefinitions) assert.deepEqual(validateStrategyConfig(strategy.id), strategy.defaults);
  assert.throws(() => validateStrategyConfig("wallet-copy", { live: true }), { code: "PRACTICE_INVALID" });
  assert.throws(() => validateStrategyConfig("trend-following", { fastPeriod: 30, slowPeriod: 20 }), { code: "PRACTICE_INVALID" });
  assert.throws(() => validateStrategyConfig("wallet-copy", { latencyMs: -1 }), { code: "PRACTICE_INVALID" });
  assert.equal(evaluateStrategy("manual", {}).action, "HOLD");
});

test("crypto uses independent observed probabilities, fees, entry timing and optional Ethereum exclusion", () => {
  const q = quote({ asset: "BTC", fairProbability: 0.82, modelObservedAt: before(1), windowOpenedAt: before(60), outcome: "Up" });
  const decision = evaluate("crypto-directional", q);
  assert.equal(decision.action, "BUY"); assert.ok(decision.targetFraction > 0 && decision.targetFraction < 0.5);
  assert.equal(evaluate("crypto-directional", { ...q, signals: { ...q.signals, modelObservedAt: after(1) } }).action, "HOLD");
  assert.equal(evaluate("crypto-directional", { ...q, signals: { ...q.signals, modelObservedAt: before(11) } }).action, "HOLD");
  assert.equal(evaluate("crypto-directional", { ...q, signals: { ...q.signals, asset: "ETH" } }, { config: { excludeEthereum: true } }).action, "HOLD");
  assert.equal(evaluate("crypto-directional", { ...q, signals: { ...q.signals, fairProbability: 0.72 } }).action, "HOLD");
  assert.ok(Math.abs(cryptoProbability({ spotPrice: 100, openPrice: 100, volatilityPerSecond: 0.0001, secondsLeft: 300 }) - 0.5) < 1e-6);
  assert.equal(cryptoProbability({ spotPrice: 100, openPrice: 100, volatilityPerSecond: 0, secondsLeft: 300 }), null);
  assert.equal(fractionalKelly(0.5, 0.6), 0);
});

test("complementary pair emits two atomic equal-share legs and rejects mismatched or stale evidence", () => {
  const pair = [{ instrument: "POLY:111", price: 0.6, ask: 0.6, bid: 0.59, liquidity: 200, outcome: "Up" },
    { instrument: "POLY:222", price: 0.35, ask: 0.35, bid: 0.34, liquidity: 200, outcome: "Down" }]
    .map(row => ({ ...row, timestamp: NOW, observedAt: before(1), conditionId: "market-one", snapshotId: "snapshot-one" }));
  const q = quote({ pair });
  const decision = evaluate("paired-outcomes", q);
  assert.equal(decision.action, "BUY"); assert.equal(decision.atomic, true); assert.equal(decision.equalShares, true);
  assert.equal(decision.legs.length, 2); assert.ok(decision.legs[0].allocationFraction > decision.legs[1].allocationFraction);
  const mismatch = structuredClone(q); mismatch.signals.pair[1].conditionId = "another-market";
  assert.equal(evaluate("paired-outcomes", mismatch).action, "HOLD");
  const stale = structuredClone(q); stale.signals.pair[1].observedAt = before(10);
  assert.equal(evaluate("paired-outcomes", stale).action, "HOLD");
  const costly = structuredClone(q); costly.signals.feeRate = 0.2;
  assert.equal(evaluate("paired-outcomes", costly).action, "HOLD");
});

test("copy entries require a point-in-time profitable wallet gate, delay and price discipline", () => {
  const copy = { address: `0x${"a".repeat(40)}`, side: "BUY", price: 0.69, timestamp: before(1), transaction: "0x-public-buy", allTimePnl: 1000, recentClosedPnl: 20, recentClosedCount: 50, checkedAt: before(30) };
  const q = quote({ copy }); assert.equal(evaluate("wallet-copy", q).action, "BUY");
  for (const patch of [{ checkedAt: after(30) }, { timestamp: NOW }, { timestamp: before(121) }, { recentClosedCount: 49 }, { recentClosedPnl: -1 }, { price: 0.1 }]) {
    assert.equal(evaluate("wallet-copy", { ...q, signals: { ...q.signals, copy: { ...copy, ...patch } } }).action, "HOLD");
  }
  assert.equal(evaluate("wallet-copy", quote({ copy, windowMinutes: 5 }), { config: { skipFiveMinute: true } }).action, "HOLD");
});

test("weather requires prior forecasts, station alignment and empirical error; future evidence cannot trigger buys", () => {
  const weather = { station: "EGLC", settlementStation: "EGLC", forecast: 20, previousForecast: 19, error: 1,
    bucketLower: 18, bucketUpper: 22, observedAt: before(20), previousObservedAt: before(3600), leadDays: 1, errorSampleCount: 10 };
  const q = quote({ weather }, { ask: 0.5, bid: 0.49, price: 0.5 });
  assert.equal(evaluate("weather-forecast", q).action, "BUY");
  for (const patch of [{ observedAt: after(1) }, { previousObservedAt: NOW }, { settlementStation: "EGLL" }, { errorSampleCount: 3 }, { leadDays: 0 }]) {
    assert.equal(evaluate("weather-forecast", { ...q, signals: { ...q.signals, weather: { ...weather, ...patch } } }).action, "HOLD");
  }
  assert.equal(weatherProbability({ forecast: 20, error: 1, bucketLower: null, bucketUpper: null }), null);
  assert.ok(weatherProbability({ forecast: 20, error: 1, bucketLower: 18, bucketUpper: 22 }) > 0.8);
});

test("maker fills require a prior nonmarketable bid and a later sell strictly through it", () => {
  const maker = { bidPrice: 0.99, observedAsk: 0.995, placedAt: before(3), tradeAt: before(1), tradePrice: 0.985, tradeSide: "SELL", tradeId: "print-1", tradeSize: 10 };
  const q = quote({ maker }); const result = evaluate("maker-resting", q);
  assert.equal(result.action, "BUY"); assert.equal(result.limitPrice, 0.99); assert.equal(result.maxShares, 10);
  for (const patch of [{ observedAsk: 0.99 }, { tradeAt: before(5) }, { tradeAt: after(1) }, { tradePrice: 0.99 }, { tradeSide: "BUY" }, { tradeId: "" }]) {
    assert.equal(evaluate("maker-resting", { ...q, signals: { ...q.signals, maker: { ...maker, ...patch } } }).action, "HOLD");
  }
});

test("Solana blocks unknown authority/deployer readings and caps entry independently from pool liquidity", () => {
  const security = { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, serialDeployer: false, topHolderPercent: 10, checkedAt: before(20) };
  const q = quote({ security, poolLiquidity: 25000, priceChange5m: 10, buys5m: 30, sells5m: 10, poolCreatedAt: before(600) }, { instrument: "DEX:mint", price: 2, ask: 2.01, bid: 1.99, liquidity: 100 });
  const result = evaluate("solana-momentum", q); assert.equal(result.action, "BUY"); assert.equal(result.maxNotionalUsd, 100);
  for (const patch of [{ mintAuthorityRevoked: null }, { serialDeployer: true }, { topHolderPercent: 25 }, { checkedAt: after(10) }]) {
    assert.equal(evaluate("solana-momentum", { ...q, signals: { ...q.signals, security: { ...security, ...patch } } }).action, "HOLD");
  }
  assert.equal(evaluate("solana-momentum", q, { position: { instrument: q.instrument, entryPrice: 1.5, openedAt: before(60) } }).action, "SELL");
});

test("moving average baseline ignores future data and observations for other instruments", () => {
  const prices = [3, 2, 1], history = prices.map((price, index) => ({ instrument: "TEST", timestamp: before((3 - index) * 60), price }));
  const q = quote({}, { instrument: "TEST", bid: 10, ask: 10, price: 10 });
  const base = evaluate("trend-following", q, { history, config: { fastPeriod: 2, slowPeriod: 3 } });
  assert.equal(base.action, "BUY");
  const polluted = [...history, { instrument: "OTHER", timestamp: before(1), price: 10000 }, { instrument: "TEST", timestamp: after(1), price: 0.01 }];
  assert.deepEqual(evaluate("trend-following", q, { history: polluted, config: { fastPeriod: 2, slowPeriod: 3 } }), base);
});
