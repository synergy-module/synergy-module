import { normalCdf, fractionalKelly } from "./strategies.js";

const finite = value => typeof value === "number" && Number.isFinite(value);
const time = value => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" ? Date.parse(value) : NaN;
const fail = message => Object.assign(new Error(message), { code: "PRACTICE_INVALID", status: 422 });
const round = value => Math.round(value * 1e8) / 1e8;

/** Step-weighted historical price; ticks unavailable at asOf are never admitted. */
export function timeWeightedAverage({ ticks, start, end, asOf = end, maxGapMs = 10000 } = {}) {
  const first = time(start), last = time(end), cutoff = time(asOf);
  if (!Array.isArray(ticks) || ticks.length > 20000 || ![first, last, cutoff, maxGapMs].every(finite) || last <= first || last > cutoff || maxGapMs < 1 || maxGapMs > 3600000) throw fail("Provide dated ticks and a past TWAP interval with a bounded gap allowance.");
  const points = ticks.filter(row => row && finite(row.value) && row.value > 0 && finite(time(row.timestamp)) && time(row.timestamp) <= last
    && finite(time(row.availableAt ?? row.receivedAt ?? row.timestamp)) && time(row.availableAt ?? row.receivedAt ?? row.timestamp) <= cutoff)
    .sort((a, b) => time(a.timestamp) - time(b.timestamp));
  const initial = points.filter(row => time(row.timestamp) <= first).at(-1);
  const missing = reason => ({ available: false, value: null, reason, start: new Date(first).toISOString(), end: new Date(last).toISOString() });
  if (!initial || first - time(initial.timestamp) > maxGapMs) return missing("The opening interval has no recent observed tick.");
  let previous = initial, cursor = first, sum = 0, observations = 1;
  for (const row of points) {
    const timestamp = time(row.timestamp);
    if (timestamp <= first) continue;
    if (timestamp - time(previous.timestamp) > maxGapMs) return missing("A price gap exceeds the allowed interval.");
    sum += previous.value * (Math.min(timestamp, last) - cursor); cursor = Math.min(timestamp, last); previous = row; observations++;
    if (timestamp >= last) break;
  }
  if (last - time(previous.timestamp) > maxGapMs) return missing("The end of the interval has no recent observed tick.");
  sum += previous.value * (last - cursor);
  return { available: true, value: sum / (last - first), start: new Date(first).toISOString(), end: new Date(last).toISOString(), observations, coverage: 1, maxGapMs };
}

export function realizedVolatility({ observations, asOf, intervalSeconds = 60, minimumReturns = 20 } = {}) {
  if (!Array.isArray(observations) || observations.length > 20000 || !finite(time(asOf)) || !finite(intervalSeconds) || intervalSeconds <= 0 || !Number.isInteger(minimumReturns) || minimumReturns < 2) throw fail("Provide historical closes, an observation cutoff and a positive interval.");
  const rows = observations.filter(row => row && finite(row.price) && row.price > 0 && time(row.timestamp) <= time(asOf)
    && time(row.availableAt ?? row.timestamp) <= time(asOf)).sort((a, b) => time(a.timestamp) - time(b.timestamp));
  const returns = [];
  for (let index = 1; index < rows.length; index++) {
    const elapsed = (time(rows[index].timestamp) - time(rows[index - 1].timestamp)) / 1000;
    if (Math.abs(elapsed - intervalSeconds) <= 1) returns.push(Math.log(rows[index].price / rows[index - 1].price));
  }
  if (returns.length < minimumReturns) return { available: false, volatilityPerSecond: null, count: returns.length };
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  return { available: true, volatilityPerSecond: Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1) / intervalSeconds), count: returns.length };
}

/** Independent Gaussian approximation for the final fixed-window TWAP. */
export function twapProbability({ openPrice, spotPrice, volatilityPerSecond, secondsLeft, observedMean, windowSeconds = 60 } = {}) {
  if (![openPrice, spotPrice, volatilityPerSecond, secondsLeft, windowSeconds].every(value => finite(value) && value > 0)) return null;
  if (secondsLeft < windowSeconds && (!finite(observedMean) || observedMean <= 0)) return null;
  const expected = secondsLeft >= windowSeconds ? spotPrice : ((windowSeconds - secondsLeft) * observedMean + secondsLeft * spotPrice) / windowSeconds;
  const varianceSeconds = secondsLeft >= windowSeconds ? secondsLeft - windowSeconds + windowSeconds / 3 : secondsLeft ** 3 / (3 * windowSeconds ** 2);
  return normalCdf(Math.log(expected / openPrice) / (volatilityPerSecond * Math.sqrt(varianceSeconds)));
}

/** One actual per station/model/target, using only forecasts issued before the configured lead. */
export function calibrateWeather({ records, asOf, leadHours = 24, minimumSamples = 7 } = {}) {
  const cutoff = time(asOf);
  if (!Array.isArray(records) || records.length > 10000 || !finite(cutoff) || !finite(leadHours) || leadHours < 0 || leadHours > 168 || !Number.isInteger(minimumSamples) || minimumSamples < 2 || minimumSamples > 200) throw fail("Provide dated forecast/actual records and a lead from 0 to 168 hours.");
  const latest = new Map(); let excluded = 0;
  for (const row of records) {
    const target = time(row?.targetAt), issued = time(row?.issuedAt), actualAt = time(row?.actualObservedAt), available = time(row?.availableAt ?? row?.issuedAt);
    if (!row || typeof row.station !== "string" || !row.station || typeof row.model !== "string" || !row.model || !finite(row.predicted) || !finite(row.actual)
      || ![target, issued, actualAt, available].every(finite) || issued > target - leadHours * 3600000 || available > target - leadHours * 3600000
      || available < issued || actualAt < target || actualAt > cutoff || row.tainted === true) { excluded++; continue; }
    const id = `${row.station}:${row.model}:${target}`, previous = latest.get(id);
    if (!previous || time(previous.issuedAt) < issued) latest.set(id, row);
  }
  const groups = new Map();
  for (const row of latest.values()) { const id = `${row.station}:${row.model}`; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(row); }
  const models = [...groups.values()].map(rows => {
    const errors = rows.map(row => row.predicted - row.actual), count = errors.length;
    return { station: rows[0].station, model: rows[0].model, leadHours, count, ready: count >= minimumSamples,
      mae: errors.reduce((s, x) => s + Math.abs(x), 0) / count, bias: errors.reduce((s, x) => s + x, 0) / count,
      rmse: Math.sqrt(errors.reduce((s, x) => s + x * x, 0) / count), latestActualAt: new Date(Math.max(...rows.map(row => time(row.actualObservedAt)))).toISOString() };
  });
  return { asOf: new Date(cutoff).toISOString(), leadHours, minimumSamples, included: latest.size, excluded, models };
}

export function blendWeatherForecasts({ forecasts, calibration, station, targetAt, asOf, leadHours = 24 } = {}) {
  const cutoff = time(asOf), target = time(targetAt);
  if (!Array.isArray(forecasts) || forecasts.length > 1000 || !Array.isArray(calibration?.models) || !finite(cutoff) || !finite(target) || target <= cutoff || time(calibration.asOf) > cutoff || !finite(time(calibration.asOf))) throw fail("Provide calibrated forecasts issued before a future target and a valid observation cutoff.");
  const latest = new Map();
  for (const row of forecasts) {
    if (row?.station !== station || time(row.targetAt) !== target || !finite(row.predicted) || !finite(time(row.issuedAt))
      || time(row.issuedAt) > cutoff || !finite(time(row.availableAt ?? row.issuedAt)) || time(row.availableAt ?? row.issuedAt) < time(row.issuedAt) || time(row.availableAt ?? row.issuedAt) > cutoff) continue;
    const measure = calibration.models.find(model => model.station === station && model.model === row.model && model.leadHours === leadHours && model.ready === true && model.count >= calibration.minimumSamples && finite(model.mae) && model.mae >= 0 && finite(model.bias));
    if (!measure) continue;
    if (!latest.has(row.model) || time(latest.get(row.model).issuedAt) < time(row.issuedAt)) latest.set(row.model, { ...row, measure });
  }
  const rows = [...latest.values()].sort((a, b) => a.measure.mae - b.measure.mae).slice(0, 4);
  if (!rows.length) return { available: false, reason: "No forecast has enough matching station and lead calibration." };
  const weights = rows.map(row => 1 / Math.max(0.1, row.measure.mae) ** 2), sum = weights.reduce((s, x) => s + x, 0);
  const corrected = rows.map(row => row.predicted - row.measure.bias), forecast = corrected.reduce((s, x, i) => s + x * weights[i], 0) / sum;
  return { available: true, station, targetAt, observedAt: asOf, forecast, error: Math.min(...rows.map(row => row.measure.mae)) || 0.1,
    spread: Math.sqrt(corrected.reduce((s, x, i) => s + (x - forecast) ** 2 * weights[i], 0) / sum), errorSampleCount: Math.min(...rows.map(row => row.measure.count)),
    models: rows.map((row, i) => ({ model: row.model, issuedAt: row.issuedAt, corrected: corrected[i], weight: weights[i] / sum, mae: row.measure.mae, count: row.measure.count })) };
}

export function ensembleBucketProbability({ members, bucketLower, bucketUpper, gaussianProbability } = {}) {
  if (!Array.isArray(members) || members.length < 10 || members.length > 100 || members.some(value => !finite(value)) || !finite(gaussianProbability) || gaussianProbability < 0 || gaussianProbability > 1
    || !(bucketLower === null || finite(bucketLower)) || !(bucketUpper === null || finite(bucketUpper)) || bucketLower === null && bucketUpper === null) return null;
  const empirical = members.filter(value => (bucketLower === null || value >= bucketLower) && (bucketUpper === null || value < bucketUpper)).length / members.length;
  return { empirical, probability: (empirical + gaussianProbability) / 2, members: members.length };
}

export const sizingModels = Object.freeze([
  { id: "fixed-1", label: "1% of account", fraction: 0.01 }, { id: "fixed-2", label: "2% of account", fraction: 0.02 },
  { id: "half-kelly", label: "Half Kelly", kelly: 0.5 }, { id: "quarter-kelly", label: "Quarter Kelly", kelly: 0.25 }, { id: "fixed-cash", label: "Fixed dollar amount" },
]);
export function paperSize({ model, equity, probability, price, clipUsd = 5, maximumUsd = 100 } = {}) {
  const rule = sizingModels.find(row => row.id === model);
  if (!rule || !finite(equity) || equity <= 0 || !finite(clipUsd) || clipUsd <= 0 || !finite(maximumUsd) || maximumUsd <= 0) throw fail("Choose a paper sizing model and positive account values.");
  return Math.min(maximumUsd, equity, rule.fraction ? equity * rule.fraction : rule.kelly ? equity * fractionalKelly(probability, price, rule.kelly) : clipUsd);
}

export function qualifyWalletHistory({ allTimePnl, closed, asOf, minimumCount = 50, highFrequencyPerHour = 20, minimumSpanHours = 24 } = {}) {
  if (!Array.isArray(closed) || closed.length > 5000 || !finite(time(asOf)) || !Number.isInteger(minimumCount) || minimumCount < 10 || minimumCount > 500 || !finite(highFrequencyPerHour) || highFrequencyPerHour <= 0 || !finite(minimumSpanHours) || minimumSpanHours <= 0 || minimumSpanHours > 168) throw fail("Provide a bounded, dated public wallet history.");
  const rows = closed.filter(row => finite(row?.pnl) && finite(time(row.timestamp)) && time(row.timestamp) <= time(asOf)).sort((a, b) => time(b.timestamp) - time(a.timestamp));
  const sample = rows.slice(0, minimumCount), span = values => values.length > 1 ? (time(values[0].timestamp) - time(values.at(-1).timestamp)) / 3600000 : 0;
  const sampleSpan = span(sample), highFrequency = sample.length >= minimumCount && (sampleSpan <= 0 || sample.length / sampleSpan > highFrequencyPerHour);
  let used = sample;
  if (highFrequency) { used = []; for (const row of rows) { used.push(row); if (used.length >= minimumCount && span(used) >= minimumSpanHours) break; } }
  const observedSpan = span(used), pnl = used.reduce((s, row) => s + row.pnl, 0), eligible = finite(allTimePnl) && allTimePnl > 0 && used.length >= minimumCount && pnl > 0 && (!highFrequency || observedSpan >= minimumSpanHours);
  return { eligible, allTimePnl: finite(allTimePnl) ? allTimePnl : null, recentClosedPnl: pnl, recentClosedCount: used.length, highFrequency, observedSpanHours: observedSpan,
    reasons: eligible ? [] : [highFrequency && observedSpan < minimumSpanHours ? "This fast-trading wallet needs at least 24 hours of closed results." : "Positive all-time and recent closed results with enough trades are required."] };
}

/** Readiness is informational. This function cannot enable a broker or move funds. */
export function assessPracticeReadiness(book, { now = new Date().toISOString(), violations = [], auditedAt = null, lastPromotionSettles = 0 } = {}) {
  const clock = time(now), initial = book?.initialCapital, trades = Array.isArray(book?.trades) ? book.trades : [], positions = Array.isArray(book?.positions) ? book.positions : [];
  if (!finite(clock) || !finite(initial) || initial <= 0 || !Array.isArray(violations)) throw fail("A valid paper account and dated QA record are required.");
  const groups = new Map(), open = new Set(positions.map(row => row.groupId ?? row.id));
  for (const row of trades) {
    const id = row.groupId ?? row.positionId ?? row.id;
    if (!id || !finite(time(row.timestamp)) || time(row.timestamp) > clock) continue;
    if (!groups.has(id)) groups.set(id, []); groups.get(id).push(row);
  }
  const completed = [];
  for (const [id, rows] of groups) {
    const exits = rows.filter(row => ["SELL", "SETTLE"].includes(row.side) && finite(row.pnl));
    if (open.has(id) || !exits.length || rows.some(row => row.tainted === true || row.ruleChanged === true)) continue;
    const buyInstruments = new Set(rows.filter(row => row.side === "BUY").map(row => row.instrument));
    if (buyInstruments.size && [...buyInstruments].some(instrument => !exits.some(row => row.instrument === instrument))) continue;
    completed.push({ id, pnl: exits.reduce((s, row) => s + row.pnl, 0), resolved: exits.every(row => row.side === "SETTLE"), timestamp: Math.max(...exits.map(row => time(row.timestamp))) });
  }
  completed.sort((a, b) => a.timestamp - b.timestamp);
  const spot = book.feed?.source === "binance" || book.strategyId === "solana-momentum" || book.strategyId === "trend-following";
  const settled = spot ? completed : completed.filter(row => row.resolved);
  const wins = settled.filter(row => row.pnl > 0), losses = settled.filter(row => row.pnl < 0), positive = wins.reduce((s, row) => s + row.pnl, 0), negative = -losses.reduce((s, row) => s + row.pnl, 0), net = positive - negative;
  const winRate = settled.length ? wins.length / settled.length : null, averageWin = wins.length ? positive / wins.length : null, averageLoss = losses.length ? negative / losses.length : null;
  const breakEven = averageWin !== null && averageLoss !== null ? averageLoss / (averageWin + averageLoss) : null;
  const profitFactor = negative > 0 ? positive / negative : null;
  const recentViolations = violations.filter(row => !finite(time(row?.timestamp)) || time(row.timestamp) > clock - 86400000);
  const auditFresh = finite(time(auditedAt)) && time(auditedAt) <= clock && clock - time(auditedAt) <= 86400000;
  const drawdown = finite(book.maxDrawdownPercent) ? book.maxDrawdownPercent : null;
  const hours = settled.length ? (settled.at(-1).timestamp - time(book.createdAt)) / 3600000 : 0;
  const checks = [
    { id: "sample", label: spot ? "200 clean closed trades" : "200 clean settled trades", pass: settled.length >= 200, value: settled.length },
    { id: "duration", label: "At least 48 hours observed", pass: hours >= 48, value: Math.max(0, hours) },
    { id: "net", label: "Positive net after fees", pass: net > 0, value: net },
    { id: "win-rate", label: "Win rate above measured break-even", pass: winRate !== null && breakEven !== null && winRate > breakEven, value: winRate, breakEven },
    { id: "drawdown", label: "Drawdown below 10%", pass: drawdown !== null && drawdown < 10, value: drawdown },
    { id: "qa", label: "Current QA check and no violations in 24 hours", pass: auditFresh && recentViolations.length === 0, value: recentViolations.length },
  ];
  const first40Net = settled.slice(0, 40).reduce((s, row) => s + row.pnl, 0);
  const edgeCandidate = settled.length >= 100 && profitFactor !== null && profitFactor >= 1.2 && winRate >= 0.4 && averageWin > averageLoss;
  return { completedGroups: completed.length, settledGroups: settled.length, excludedOrOpenGroups: groups.size - settled.length,
    netAfterFees: round(net), winRate, averageWin, averageLoss, profitFactor, breakEvenWinRate: breakEven,
    ruleChangeEligible: settled.length >= 20, retirementReview: settled.length >= 40 && first40Net <= 0, first40Net: round(first40Net), edgeCandidate,
    paperPromotionEligible: settled.length - lastPromotionSettles >= 30 && net > 0 && breakEven !== null && winRate > breakEven && drawdown !== null && drawdown < 10,
    checks, researchReviewEligible: checks.every(row => row.pass), liveExecutionEnabled: false,
    message: "These are paper research milestones. Each book is assessed separately; a passing report never enables live orders." };
}
