import test from "node:test";
import assert from "node:assert/strict";
import { timeWeightedAverage, calibrateWeather, blendWeatherForecasts, assessPracticeReadiness, qualifyWalletHistory, realizedVolatility, twapProbability, ensembleBucketProbability } from "../../src/practice/evidence.js";
import { evaluateStrategy } from "../../src/practice/strategies.js";

const NOW = Date.parse("2026-10-12T12:00:00Z"), at = delta => new Date(NOW + delta).toISOString();

test("TWAP requires complete past coverage and excludes ticks received after the observation cutoff", () => {
  const ticks = [{ timestamp: at(-10000), value: 100, receivedAt: at(-10000) }, { timestamp: at(-5000), value: 110, receivedAt: at(-5000) }];
  const result = timeWeightedAverage({ ticks, start: at(-10000), end: at(0), maxGapMs: 10000 });
  assert.equal(result.value, 105);
  assert.equal(timeWeightedAverage({ ticks: [{ timestamp: at(-10000), value: 999, receivedAt: at(1000) }], start: at(-10000), end: at(0) }).available, false);
  assert.equal(timeWeightedAverage({ ticks, start: at(-20000), end: at(0) }).available, false);
  assert.equal(timeWeightedAverage({ ticks, start: at(-10000), end: at(0), maxGapMs: 1000 }).available, false);
});

test("weather calibration excludes future actuals and late forecasts, de-duplicates targets and corrects bias", () => {
  const records = Array.from({ length: 8 }, (_, i) => {
    const target = NOW - (i + 1) * 86400000;
    return { station: "EGLC", model: "gfs", targetAt: new Date(target).toISOString(), issuedAt: new Date(target - 86400000).toISOString(), actualObservedAt: new Date(target + 3600000).toISOString(), predicted: 22, actual: 20 };
  });
  const calibration = calibrateWeather({ records: [...records, records[0], { ...records[0], model: "future", actualObservedAt: at(1000) }, { ...records[0], model: "late", issuedAt: records[0].targetAt }], asOf: at(0) });
  assert.equal(calibration.included, 8); assert.equal(calibration.models.length, 1); assert.equal(calibration.models[0].bias, 2); assert.equal(calibration.models[0].mae, 2);
  const blend = blendWeatherForecasts({ forecasts: [{ station: "EGLC", model: "gfs", targetAt: at(86400000), issuedAt: at(-1000), predicted: 25 },
    { station: "EGLC", model: "gfs", targetAt: at(86400000), issuedAt: at(1000), predicted: 100 }], calibration, station: "EGLC", targetAt: at(86400000), asOf: at(0) });
  assert.equal(blend.forecast, 23); assert.equal(blend.errorSampleCount, 8);
  assert.equal(ensembleBucketProbability({ members: Array(10).fill(20), bucketLower: 19, bucketUpper: 21, gaussianProbability: 0.8 }).probability, 0.9);
});

test("readiness counts complete settled groups once and excludes open, tainted and merely marked results", () => {
  const book = { strategyId: "paired-outcomes", initialCapital: 500, createdAt: at(-86400000), maxDrawdownPercent: 2, positions: [{ groupId: "open" }], trades: [
    { id: "1", groupId: "pair", instrument: "YES", side: "BUY", timestamp: at(-50000) }, { id: "2", groupId: "pair", instrument: "NO", side: "BUY", timestamp: at(-50000) },
    { id: "3", groupId: "pair", instrument: "YES", side: "SETTLE", pnl: 10, timestamp: at(-1000) }, { id: "4", groupId: "pair", instrument: "NO", side: "SETTLE", pnl: -8, timestamp: at(-1000) },
    { id: "5", groupId: "open", side: "SETTLE", pnl: 100, timestamp: at(-1000) }, { id: "6", groupId: "taint", side: "SETTLE", pnl: 100, tainted: true, timestamp: at(-1000) },
    { id: "7", groupId: "sold", side: "SELL", pnl: 20, timestamp: at(-1000) },
  ] };
  const result = assessPracticeReadiness(book, { now: at(0), auditedAt: at(0) });
  assert.equal(result.settledGroups, 1); assert.equal(result.netAfterFees, 2); assert.equal(result.completedGroups, 2);
  assert.equal(result.researchReviewEligible, false); assert.equal(result.liveExecutionEnabled, false);
  assert.equal(result.checks.find(row => row.id === "qa").pass, true);
});

test("fast-trading wallet gates need 24 hours of actual closed observations", () => {
  const closed = Array.from({ length: 100 }, (_, i) => ({ pnl: 1, timestamp: at(-i * 60000) }));
  const short = qualifyWalletHistory({ allTimePnl: 1000, closed, asOf: at(0) });
  assert.equal(short.highFrequency, true); assert.equal(short.eligible, false);
  const sufficient = qualifyWalletHistory({ allTimePnl: 1000, closed: [...closed, { pnl: 1, timestamp: at(-25 * 3600000) }], asOf: at(0) });
  assert.equal(sufficient.eligible, true); assert.ok(sufficient.observedSpanHours >= 24);
});

test("volatility excludes an unfinished candle and TWAP probability needs its observed partial window", () => {
  const observations = Array.from({ length: 25 }, (_, i) => ({ timestamp: at(-(25 - i) * 60000), price: 100 + Math.sin(i) }));
  const a = realizedVolatility({ observations, asOf: at(0) }), b = realizedVolatility({ observations: [...observations, { timestamp: at(60000), price: 10000 }], asOf: at(0) });
  assert.deepEqual(a, b); assert.ok(a.volatilityPerSecond > 0);
  assert.equal(twapProbability({ openPrice: 100, spotPrice: 101, volatilityPerSecond: 0.001, secondsLeft: 30 }), null);
  assert.ok(twapProbability({ openPrice: 100, spotPrice: 101, volatilityPerSecond: 0.001, secondsLeft: 30, observedMean: 101 }) > 0.5);
});

test("crypto accumulation and dynamic hedges preserve spacing, bounds and the original trade group", () => {
  const position = { instrument: "POLY:1", quantity: 20, cost: 10, entryPrice: 0.5, openedAt: at(-30000), lastFillAt: at(-20000), fillCount: 1, groupId: "original", intent: "LEAN" };
  const quote = { instrument: "POLY:1", timestamp: at(0), price: 0.6, bid: 0.59, ask: 0.6, liquidity: 100,
    signals: { asset: "BTC", outcome: "Up", feeRate: 0, fairProbability: 0.8, modelObservedAt: at(-1000), windowOpenedAt: at(-60000), windowEndsAt: at(240000), conditionId: "condition" } };
  const add = evaluateStrategy("crypto-directional", { quote, position, positions: [position] });
  assert.equal(add.intent, "ADD"); assert.equal(add.groupId, "original");
  assert.equal(evaluateStrategy("crypto-directional", { quote, position: { ...position, lastFillAt: at(-1000) } }).action, "HOLD");
  quote.signals.pair = [{ instrument: "POLY:1", outcome: "Up", bid: 0.59, ask: 0.6 }, { instrument: "POLY:2", outcome: "Down", bid: 0.39, ask: 0.4 }]
    .map(row => ({ ...row, timestamp: at(0), conditionId: "condition", snapshotId: "same", liquidity: 100 }));
  const hedge = evaluateStrategy("crypto-directional", { quote, position, positions: [position, { instrument: "POLY:2", quantity: 5 }] });
  assert.equal(hedge.intent, "HEDGE"); assert.equal(hedge.maxShares, 15); assert.equal(hedge.legs[0].instrument, "POLY:2");
});
