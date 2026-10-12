// Independently implemented from the documented paper rules in synergy-poly.
// No strategy has access to credentials, network clients, or live order methods.
const finite = value => typeof value === "number" && Number.isFinite(value);
const prob = value => finite(value) && value > 0 && value < 1;
const stamp = value => typeof value === "string" ? Date.parse(value) : NaN;
const field = (label, minimum, maximum, step = 0.01, help = "") => ({ label, type: "number", minimum, maximum, step, help });
const bool = (label, help = "") => ({ label, type: "boolean", help });
const definitions = [
  { id: "manual", label: "Manual paper trading", marketType: "any", description: "Choose your own entries and exits using a current server-fetched quote. The automatic evaluator never places a trade.", requiredSignals: [], defaults: {}, fields: {} },
  { id: "convergence", label: "Prediction convergence", marketType: "prediction", description: "Follow a liquid leading outcome with a tight spread and observed buying, then exit at a fixed gain or loss.",
    requiredSignals: ["endDate", "change24h", "netFlowUsd", "feeRate"],
    defaults: { minPrice: 0.65, maxPrice: 0.96, minLiquidity: 10000, maxSpread: 0.02, minFlow: 500, maxDays: 14, takeProfit: 0.02, stopLoss: 0.03 },
    fields: { minPrice: field("Minimum outcome price", 0.01, 0.99), maxPrice: field("Maximum outcome price", 0.01, 0.99), minLiquidity: field("Minimum liquidity ($)", 100, 1e8, 100), maxSpread: field("Maximum spread", 0.001, 0.1, 0.001), minFlow: field("Minimum net buying ($)", 0, 1e7, 100), maxDays: field("Days until scheduled end", 1, 90, 1), takeProfit: field("Take profit per share ($)", 0.001, 0.5, 0.001), stopLoss: field("Stop loss per share ($)", 0.001, 0.5, 0.001) } },
  { id: "crypto-directional", label: "Crypto window edge", marketType: "prediction", description: "Compare a point-in-time crypto probability model with outcome asks after fees. Supports 5 and 15 minute windows and an Ethereum exclusion variant.",
    requiredSignals: ["fairProbability or spotPrice + openPrice + volatilityPerSecond", "modelObservedAt", "windowOpenedAt", "windowEndsAt", "asset", "feeRate"],
    defaults: { minEdge: 0.03, minPrice: 0.35, maxPrice: 0.8, entryAfterSeconds: 20, entryBeforeSeconds: 150, excludeEthereum: false, kellyFraction: 0.5,
      allowAdds: true, maxFills: 6, addSpacingSeconds: 15, lastAddSeconds: 240, dynamicHedge: true, hedgeAfterSeconds: 18, hedgePairCost: 0.99 },
    fields: { minEdge: field("Minimum edge after fees", 0.005, 0.5, 0.005), minPrice: field("Minimum ask", 0.01, 0.99), maxPrice: field("Maximum ask", 0.01, 0.99), entryAfterSeconds: field("Wait after window opens (seconds)", 0, 300, 1), entryBeforeSeconds: field("Last entry after open (seconds)", 1, 900, 1), excludeEthereum: bool("Exclude Ethereum", "Create a separate book for this variant."), kellyFraction: field("Fraction of Kelly sizing", 0.05, 1, 0.05),
      allowAdds: bool("Allow additional entries while the edge holds"), maxFills: field("Maximum fills in a window", 1, 10, 1), addSpacingSeconds: field("Minimum seconds between entries", 5, 120, 1), lastAddSeconds: field("Stop adding after (seconds)", 30, 600, 1), dynamicHedge: bool("Allow a bounded opposite outcome hedge"), hedgeAfterSeconds: field("Wait before a hedge (seconds)", 5, 120, 1), hedgePairCost: field("Maximum held pair cost ($)", 0.5, 1, 0.001) } },
  { id: "paired-outcomes", label: "Two outcome pair", marketType: "prediction", description: "Buy equal shares of complementary outcomes together when their combined cost after fees is below the configured threshold.",
    requiredSignals: ["pair: two complementary outcomes with same conditionId, snapshotId and timestamp", "feeRate"],
    defaults: { maxPairCost: 0.98, minLiquidity: 100, maxSnapshotSkewMs: 1000 },
    fields: { maxPairCost: field("Maximum pair cost ($)", 0.5, 0.999, 0.001), minLiquidity: field("Minimum depth on each side ($)", 10, 1e7, 10), maxSnapshotSkewMs: field("Maximum age of pair evidence (ms)", 0, 5000, 100) } },
  { id: "wallet-copy", label: "Verified wallet copy", marketType: "prediction", description: "Paper copy a recent public buy only after positive wallet performance is evidenced. Simulate delayed execution and reject a large price chase.",
    requiredSignals: ["copy: address, side, price, timestamp, transaction, allTimePnl, recentClosedPnl, recentClosedCount, checkedAt", "feeRate"],
    defaults: { minPrice: 0.15, maxDelaySeconds: 120, latencyMs: 500, maxChasePercent: 3, minSecondsLeft: 60, skipFiveMinute: false, skipUp: false },
    fields: { minPrice: field("Minimum copied price", 0.01, 0.95), maxDelaySeconds: field("Maximum signal age (seconds)", 1, 300, 1), latencyMs: field("Execution delay (ms)", 500, 10000, 100), maxChasePercent: field("Maximum price chase (%)", 0.1, 10, 0.1), minSecondsLeft: field("Minimum seconds before end", 10, 600, 1), skipFiveMinute: bool("Skip 5 minute markets"), skipUp: bool("Skip Up outcome") } },
  { id: "weather-forecast", label: "Weather forecast change", marketType: "prediction", description: "Use a station-matched, dated forecast change and measured forecast error to estimate a temperature bucket probability.",
    requiredSignals: ["weather: station, settlementStation, forecast, previousForecast, error, bucketLower, bucketUpper, observedAt, previousObservedAt, leadDays", "feeRate"],
    defaults: { minEdge: 0.08, minForecastMove: 0.5, sigmaMultiplier: 1.25, sigmaFloor: 0.7, minPrice: 0.05, maxPrice: 0.6, kellyFraction: 0.25, sameDay: false, makerMode: false },
    fields: { minEdge: field("Minimum edge after fees", 0.01, 0.5), minForecastMove: field("Minimum forecast change (°C)", 0.1, 5, 0.1), sigmaMultiplier: field("Forecast uncertainty multiplier", 1, 3, 0.05), sigmaFloor: field("Minimum uncertainty (°C)", 0.5, 5, 0.1), minPrice: field("Minimum ask", 0.01, 0.99), maxPrice: field("Maximum ask", 0.01, 0.99), kellyFraction: field("Fraction of Kelly sizing", 0.05, 1, 0.05), sameDay: bool("Same day variant", "Use a separate book; same-day forecasts contain some observed weather."), makerMode: bool("Require a resting bid and later trade evidence", "The maker variant also needs recorded ensemble members.") } },
  { id: "maker-resting", label: "Resting prediction bid", marketType: "prediction", description: "A passive bid must first rest below the ask. A later observed sell strictly through the bid is required to simulate a fill.",
    requiredSignals: ["maker: bidPrice, placedAt, observedAsk, tradePrice, tradeAt, tradeSide, tradeId, tradeSize", "feeRate"],
    defaults: { bidPrice: 0.99, minimumRestMs: 1000, minSecondsLeft: 10 },
    fields: { bidPrice: field("Resting bid price", 0.01, 0.999, 0.001), minimumRestMs: field("Minimum resting time (ms)", 500, 60000, 100), minSecondsLeft: field("Minimum seconds before end", 0, 300, 1) } },
  { id: "solana-momentum", label: "Solana screened scalp", marketType: "spot", description: "Test short momentum scalps only with recorded token authority, concentration and deployer checks. Risk evidence that is missing blocks an entry.",
    requiredSignals: ["security: mintAuthorityRevoked, freezeAuthorityRevoked, serialDeployer, topHolderPercent, checkedAt", "priceChange5m", "buys5m", "sells5m", "poolCreatedAt"],
    defaults: { minLiquidity: 20000, minChangePercent: 2, maxChangePercent: 30, minBuySellRatio: 1.2, minTransactions: 20, maxHolderPercent: 20, minAgeMinutes: 5, maxAgeMinutes: 1440, takeProfitPercent: 15, stopLossPercent: 8, timeStopMinutes: 15 },
    fields: { minLiquidity: field("Minimum pool liquidity ($)", 15000, 1e8, 1000), minChangePercent: field("Minimum 5 minute gain (%)", 0, 100, 0.5), maxChangePercent: field("Maximum 5 minute gain (%)", 1, 500, 1), minBuySellRatio: field("Minimum buy/sell count ratio", 1, 10, 0.1), minTransactions: field("Minimum recent transactions", 1, 10000, 1), maxHolderPercent: field("Maximum top holder share (%)", 1, 50, 1), minAgeMinutes: field("Minimum pool age (minutes)", 0, 1440, 1), maxAgeMinutes: field("Maximum pool age (minutes)", 1, 525600, 1), takeProfitPercent: field("Take profit (%)", 1, 200, 1), stopLossPercent: field("Stop loss (%)", 1, 50, 1), timeStopMinutes: field("Close after (minutes)", 1, 240, 1) } },
  { id: "trend-following", label: "Price trend baseline", marketType: "any", description: "Follow a moving-average crossover as new public market observations arrive. Decisions use only earlier observations of the same instrument.",
    requiredSignals: [], defaults: { fastPeriod: 5, slowPeriod: 20, takeProfitPercent: 10, stopLossPercent: 5 },
    fields: { fastPeriod: field("Fast average observations", 2, 100, 1), slowPeriod: field("Slow average observations", 3, 500, 1), takeProfitPercent: field("Take profit (%)", 0.1, 200, 0.1), stopLossPercent: field("Stop loss (%)", 0.1, 50, 0.1) } },
];
function freeze(value) { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); return Object.freeze(value); }
export const strategyDefinitions = freeze(definitions);
export const STRATEGY_DEFINITIONS = strategyDefinitions;
export const strategyPresets = freeze([
  { id: "crypto-15m", label: "Crypto 15 minute directional", strategyId: "crypto-directional", config: {}, initialCapital: 500, windowMinutes: 15 },
  { id: "crypto-15m-noeth", label: "Crypto 15 minute · exclude Ethereum", strategyId: "crypto-directional", config: { excludeEthereum: true }, initialCapital: 500, windowMinutes: 15 },
  { id: "crypto-5m", label: "Crypto 5 minute directional", strategyId: "crypto-directional", config: {}, initialCapital: 500, windowMinutes: 5 },
  { id: "pair-98", label: "Two outcome pair at 98 cents", strategyId: "paired-outcomes", config: { maxPairCost: 0.98 }, initialCapital: 500 },
  ...[0.05, 0.15, 0.3, 0.5, 0.7].map(minPrice => ({ id: `copy-floor-${Math.round(minPrice * 100)}`, label: `Copy buys above ${Math.round(minPrice * 100)} cents`, strategyId: "wallet-copy", config: { minPrice }, initialCapital: 500 })),
  { id: "copy-longer", label: "Copy longer windows", strategyId: "wallet-copy", config: { skipFiveMinute: true }, initialCapital: 500 },
  { id: "weather-dayahead", label: "Day-ahead forecast change", strategyId: "weather-forecast", config: {}, initialCapital: 500 },
  { id: "weather-sameday", label: "Same-day forecast book", strategyId: "weather-forecast", config: { sameDay: true }, initialCapital: 500 },
  { id: "weather-ensemble-maker", label: "Weather ensemble resting bid", strategyId: "weather-forecast", config: { makerMode: true, minEdge: 0.1 }, initialCapital: 500 },
  { id: "maker-99", label: "Resting 99 cent bid", strategyId: "maker-resting", config: { bidPrice: 0.99 }, initialCapital: 500 },
  { id: "solana-strict", label: "Solana strict liquidity scalp", strategyId: "solana-momentum", config: { minLiquidity: 20000 }, initialCapital: 500 },
  { id: "solana-loose", label: "Solana smaller pool scalp", strategyId: "solana-momentum", config: { minLiquidity: 15000 }, initialCapital: 500 },
]);
export function getStrategyDefinition(id) { return strategyDefinitions.find(row => row.id === id) ?? null; }

export function validateStrategyConfig(id, supplied = {}) {
  const definition = getStrategyDefinition(id);
  const invalid = message => { throw Object.assign(new Error(message), { code: "PRACTICE_INVALID", status: 422 }); };
  if (!definition) invalid("Choose a strategy from the practice catalog.");
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) invalid("Strategy settings must be an object.");
  for (const [key, value] of Object.entries(supplied)) {
    const rule = Object.hasOwn(definition.fields, key) ? definition.fields[key] : null;
    if (!rule || (rule.type === "boolean" ? typeof value !== "boolean" : !finite(value) || value < rule.minimum || value > rule.maximum || (rule.step === 1 && !Number.isInteger(value)))) invalid(`Check the ${rule?.label ?? key} setting.`);
  }
  const config = { ...definition.defaults, ...supplied };
  if ((config.minPrice !== undefined && config.minPrice >= config.maxPrice) || (config.fastPeriod !== undefined && config.fastPeriod >= config.slowPeriod)
    || (config.entryAfterSeconds !== undefined && config.entryAfterSeconds >= config.entryBeforeSeconds)
    || (config.minAgeMinutes !== undefined && config.minAgeMinutes >= config.maxAgeMinutes)
    || (config.minChangePercent !== undefined && config.minChangePercent >= config.maxChangePercent)) invalid("The minimum setting must be smaller than its maximum.");
  return config;
}

const hold = (reason, metadata = {}) => ({ action: "HOLD", reason, confidence: null, targetFraction: 0, metadata });
const buy = (reason, confidence = null, extra = {}) => ({ action: "BUY", reason, confidence, targetFraction: 1, metadata: {}, ...extra });
const sell = reason => ({ action: "SELL", reason, confidence: null, targetFraction: 1, metadata: {} });
const observed = (value, current, maxAgeMs) => Number.isFinite(stamp(value)) && stamp(value) <= current && current - stamp(value) <= maxAgeMs;
const feePerShare = (price, signals) => finite(signals.feeRate) && signals.feeRate >= 0 && signals.feeRate <= 1
  && (signals.feeExponent === undefined || finite(signals.feeExponent) && signals.feeExponent >= 0 && signals.feeExponent <= 5)
  ? signals.feeRate * (price * (1 - price)) ** (signals.feeExponent ?? 1) : null;

export function normalCdf(value) {
  if (value === Infinity) return 1; if (value === -Infinity) return 0;
  if (!finite(value)) return null;
  const x = Math.abs(value), t = 1 / (1 + 0.2316419 * x);
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return value < 0 ? tail : 1 - tail;
}
export function cryptoProbability({ spotPrice, openPrice, volatilityPerSecond, secondsLeft }) {
  if (![spotPrice, openPrice, volatilityPerSecond, secondsLeft].every(value => finite(value) && value > 0)) return null;
  return normalCdf(Math.log(spotPrice / openPrice) / (volatilityPerSecond * Math.sqrt(secondsLeft)));
}
export function fractionalKelly(probability, allInPrice, fraction = 0.5) {
  if (!finite(probability) || probability < 0 || probability > 1 || !prob(allInPrice) || !finite(fraction)) return 0;
  return Math.max(0, Math.min(1, fraction * (probability - allInPrice) / (1 - allInPrice)));
}
export function weatherProbability({ forecast, error, spread = 0, bucketLower, bucketUpper }, config = {}) {
  if (![forecast, error, spread].every(finite) || error <= 0 || spread < 0
    || !(bucketLower === null || finite(bucketLower)) || !(bucketUpper === null || finite(bucketUpper))
    || (bucketLower === null && bucketUpper === null) || (bucketLower !== null && bucketUpper !== null && bucketLower >= bucketUpper)) return null;
  const sigma = Math.max(config.sigmaFloor ?? 0.7, (config.sigmaMultiplier ?? 1.25) * Math.sqrt(error ** 2 + spread ** 2));
  return normalCdf(bucketUpper === null ? Infinity : (bucketUpper - forecast) / sigma)
    - normalCdf(bucketLower === null ? -Infinity : (bucketLower - forecast) / sigma);
}

/** quote.timestamp is the observation clock; no strategy uses wall time or future rows. */
export function evaluateStrategy(id, { history = [], quote, position = null, positions = [], config: supplied = {} } = {}) {
  const config = validateStrategyConfig(id, supplied), definition = getStrategyDefinition(id);
  if (id === "manual") return hold("Manual paper trading waits for your order using a current market quote.");
  if (!quote || typeof quote.instrument !== "string" || !Number.isFinite(stamp(quote.timestamp)) || !finite(quote.price) || quote.price <= 0) return hold("A dated, positive price observation is required.");
  const now = stamp(quote.timestamp), signals = quote.signals ?? {}, ask = quote.ask, bid = quote.bid;
  if (!finite(ask) || !finite(bid) || ask <= 0 || bid < 0 || bid > ask) return hold("Observed bid and ask prices are required; crossed books cannot be traded.");
  if (quote.observedAt && !observed(quote.observedAt, now, 120000)) return hold("The quote evidence is stale or from the future.");
  if (definition.marketType === "prediction" && (!prob(ask) || bid >= 1)) return hold("Prediction outcome prices must be between zero and one.");
  const fee = definition.marketType === "prediction" ? feePerShare(ask, signals) : 0;
  if (fee === null) return hold("A recorded fee schedule is required.");
  const secondsLeft = (stamp(signals.windowEndsAt ?? signals.endDate) - now) / 1000;
  if (position) {
    if (position.instrument && position.instrument !== quote.instrument && !position.groupId) return hold("This quote belongs to another position.");
    const entry = position.entryPrice ?? position.price;
    if (!finite(entry) || entry <= 0) return hold("The position entry price is unavailable.");
    if (id === "convergence") return bid - entry >= config.takeProfit ? sell("The convergence profit target was reached.") : entry - bid >= config.stopLoss ? sell("The convergence stop loss was reached.") : hold("Keep the existing convergence position.");
    if (id === "solana-momentum" || id === "trend-following") {
      const change = (bid / entry - 1) * 100;
      if (change >= config.takeProfitPercent) return sell("The profit target was reached.");
      if (change <= -config.stopLossPercent) return sell("The stop loss was reached.");
      if (id === "solana-momentum" && now - stamp(position.openedAt) >= config.timeStopMinutes * 60000) return sell("The scalp time limit was reached.");
    } else if (id !== "crypto-directional") return hold("Hold this book's outcome position for a verified settlement or an explicit paper close.");
  }
  if (definition.marketType === "prediction" && finite(secondsLeft) && secondsLeft <= 0) return hold("The market has ended; no new entry is allowed.");
  if (id === "convergence") {
    if (!finite(secondsLeft) || secondsLeft > config.maxDays * 86400) return hold("A scheduled end within the configured period is required.");
    if (ask < config.minPrice || ask > config.maxPrice || ask - bid > config.maxSpread) return hold("The outcome price or spread is outside your limits.");
    const marketLiquidity = signals.marketLiquidity ?? quote.liquidity;
    if (!finite(marketLiquidity) || marketLiquidity < config.minLiquidity || !finite(signals.netFlowUsd) || signals.netFlowUsd < config.minFlow) return hold("Liquidity and sampled buying flow must pass their limits.");
    if (!finite(signals.change24h) || Math.abs(signals.change24h) >= 0.08) return hold("The 24 hour price move is missing or too large.");
    return buy("The convergence entry checks passed.");
  }
  if (id === "crypto-directional") {
    if (config.excludeEthereum && /^(ETH|ETHEREUM)$/i.test(signals.asset ?? "")) return hold("Ethereum is excluded in this strategy variant.");
    if (!/^(BTC|BITCOIN|ETH|ETHEREUM|SOL|SOLANA|XRP)$/i.test(signals.asset ?? "")) return hold("A supported crypto asset is required.");
    const elapsed = (now - stamp(signals.windowOpenedAt)) / 1000;
    if (!finite(secondsLeft) || secondsLeft <= 0 || !finite(elapsed) || elapsed < config.entryAfterSeconds || (!position && elapsed > config.entryBeforeSeconds)) return hold("The quote is outside the entry window.");
    if (!observed(signals.modelObservedAt, now, 10000)) return hold("The probability evidence must have been observed within ten seconds.");
    const up = finite(signals.fairProbability) ? signals.fairProbability : cryptoProbability({ ...signals, secondsLeft });
    const probability = signals.outcome === "Down" ? 1 - up : up;
    if (up === null || !finite(probability) || probability <= 0 || probability >= 1) return hold("A valid independent probability estimate is required.");
    const edge = probability - ask - fee;
    if (position) {
      const pair = signals.pair, same = pair?.find(row => row.instrument === quote.instrument), other = pair?.find(row => row.instrument !== quote.instrument);
      const firstAt = stamp(position.openedAt), lastAt = stamp(position.lastFillAt ?? position.openedAt), fills = position.fillCount ?? 1;
      if (!finite(firstAt) || firstAt > now || !finite(lastAt) || lastAt > now) return hold("The position's entry history cannot be verified.");
      if (config.dynamicHedge && position.intent !== "HEDGE" && now - firstAt >= config.hedgeAfterSeconds * 1000 && pair?.length === 2 && same && other
        && same.conditionId && same.conditionId === other.conditionId && same.snapshotId && same.snapshotId === other.snapshotId
        && same.timestamp === other.timestamp && observed(other.timestamp, now, 1000) && prob(other.ask) && finite(other.bid) && other.bid >= 0 && other.bid <= other.ask
        && finite(other.liquidity) && other.liquidity > 0 && ["Up", "Down"].includes(other.outcome) && other.outcome !== signals.outcome
        && (!other.observedAt || observed(other.observedAt, now, 10000))) {
        const opposite = positions.find(row => row.instrument === other.instrument), remaining = (position.quantity ?? position.shares ?? 0) - (opposite?.quantity ?? opposite?.shares ?? 0);
        const oppositeProbability = 1 - probability, oppositeFee = feePerShare(other.ask, signals);
        const allInEntry = position.cost > 0 && position.quantity > 0 ? position.cost / position.quantity : position.entryPrice;
        const pairCost = allInEntry + other.ask + oppositeFee;
        if (remaining > 0 && (oppositeProbability - other.ask - oppositeFee >= config.minEdge || pairCost <= config.hedgePairCost)) {
          return buy("The opposite outcome now offers an edge or an affordable held pair.", oppositeProbability, { intent: "HEDGE", groupId: position.groupId,
            maxShares: remaining, legs: [{ ...other, price: other.ask }], metadata: { conditionId: same.conditionId, leanInstrument: position.instrument, pairCost, holdToSettlement: true } });
        }
      }
      if (!config.allowAdds || position.intent === "HEDGE" || fills >= config.maxFills || elapsed > config.lastAddSeconds || now - lastAt < config.addSpacingSeconds * 1000) return hold("The accumulation timing or fill-count limit blocks another entry.");
      if (ask < config.minPrice || ask > config.maxPrice || edge < config.minEdge) return hold("Keep the existing position; its edge is too small for another entry.");
      return buy("The edge still passes after the configured wait; add within the account's risk caps.", probability, { intent: "ADD", groupId: position.groupId,
        targetFraction: fractionalKelly(probability, ask + fee, config.kellyFraction), metadata: { edge, probability, conditionId: signals.conditionId, holdToSettlement: true } });
    }
    if (ask < config.minPrice || ask > config.maxPrice || edge < config.minEdge) return hold("The crypto edge after fees or entry price did not pass.", { probability, edge });
    return buy("The dated crypto probability exceeds the ask and fee by the required edge.", probability, { intent: "LEAN", targetFraction: fractionalKelly(probability, ask + fee, config.kellyFraction), metadata: { edge, probability, conditionId: signals.conditionId, outcome: signals.outcome ?? "Up", model: signals.fairProbability === undefined ? "lognormal-price-model" : "supplied-probability" } });
  }
  if (id === "paired-outcomes") {
    const pair = signals.pair;
    if (!Array.isArray(pair) || pair.length !== 2) return hold("Both complementary outcome books are required for an atomic pair.");
    const [a, b] = pair;
    if (!a.conditionId || a.conditionId !== b.conditionId || !a.snapshotId || a.snapshotId !== b.snapshotId || a.timestamp !== b.timestamp
      || !observed(a.timestamp, now, config.maxSnapshotSkewMs) || !a.instrument || !b.instrument || a.instrument === b.instrument
      || (a.observedAt && (!observed(a.observedAt, now, 120000) || !observed(b.observedAt, now, 120000) || Math.abs(stamp(a.observedAt) - stamp(b.observedAt)) > config.maxSnapshotSkewMs))
      || !((a.outcome === "Yes" && b.outcome === "No") || (a.outcome === "No" && b.outcome === "Yes") || (a.outcome === "Up" && b.outcome === "Down") || (a.outcome === "Down" && b.outcome === "Up"))) return hold("Both outcomes must belong to one condition and one dated book snapshot.");
    if (pair.some(row => !prob(row.ask) || !finite(row.bid) || row.bid < 0 || row.bid > row.ask || !finite(row.liquidity) || row.liquidity < config.minLiquidity)) return hold("Each outcome needs executable prices and sufficient recorded depth.");
    const total = a.ask + b.ask, totalWithFees = total + feePerShare(a.ask, signals) + feePerShare(b.ask, signals);
    if (totalWithFees > config.maxPairCost) return hold("The pair cost after fees exceeds the threshold.", { pairCost: totalWithFees });
    return buy("The complementary pair passed its combined cost and evidence checks.", null, { equalShares: true, atomic: true,
      legs: pair.map(row => ({ ...row, price: row.ask, weight: 0.5, quantityWeight: 1, allocationFraction: row.ask / total })), metadata: { pairCost: totalWithFees, grossPayoutPerPair: 1, conditionId: a.conditionId } });
  }
  if (id === "wallet-copy") {
    const copy = signals.copy;
    if (!copy || !/^0x[\da-f]{40}$/i.test(copy.address ?? "") || copy.side !== "BUY" || typeof copy.transaction !== "string" || !copy.transaction || !prob(copy.price)) return hold("A dated public wallet buy and transaction identifier are required.");
    if (!finite(copy.allTimePnl) || copy.allTimePnl <= 0 || !finite(copy.recentClosedPnl) || copy.recentClosedPnl <= 0 || !Number.isInteger(copy.recentClosedCount) || copy.recentClosedCount < 50 || !observed(copy.checkedAt, now, 86400000)
      || copy.highFrequency === true && (!finite(copy.observedSpanHours) || copy.observedSpanHours < 24)) return hold("The wallet needs positive dated closed results; fast-trading wallets need a full day of results.");
    const age = now - stamp(copy.timestamp);
    if (!finite(age) || age < config.latencyMs || age > config.maxDelaySeconds * 1000) return hold("The copy signal is too new for the delay model or too old to copy.");
    if (config.skipFiveMinute && signals.windowMinutes === 5 || config.skipUp && signals.outcome === "Up") return hold("The copied outcome is excluded by this variant.");
    if (!finite(secondsLeft) || secondsLeft < config.minSecondsLeft || ask < config.minPrice || (ask / copy.price - 1) * 100 > config.maxChasePercent) return hold("The copy price, remaining time or price chase did not pass.");
    return buy("A qualified public wallet buy passed delay, price and expiry checks.", null, { metadata: { sourceTransaction: copy.transaction, sourceWallet: copy.address, delayMs: age, holdToSettlement: true } });
  }
  if (id === "weather-forecast") {
    const weather = signals.weather;
    if (!weather || !weather.station || weather.station !== weather.settlementStation || !observed(weather.observedAt, now, 21600000)
      || !observed(weather.previousObservedAt, stamp(weather.observedAt) - 1, 172800000) || !finite(weather.previousForecast)) return hold("Two dated forecasts for the contract's exact settlement station are required.");
    if (!Number.isInteger(weather.leadDays) || (config.sameDay ? weather.leadDays !== 0 : weather.leadDays < 1 || weather.leadDays > 2)) return hold("The forecast lead does not match this book's day-ahead or same-day rule.");
    let probability = weatherProbability(weather, config);
    if (probability === null || !finite(weather.errorSampleCount) || weather.errorSampleCount < 7) return hold("A measured forecast error from at least seven prior observations is required.");
    if (signals.outcome === "No") probability = 1 - probability;
    if (config.makerMode) {
      const members = weather.ensembleMembers, maker = signals.maker;
      if (!Array.isArray(members) || members.length < 10 || members.length > 100 || members.some(value => !finite(value)) || !observed(weather.ensembleObservedAt, now, 21600000)) return hold("The ensemble maker needs at least ten dated model members.");
      const bucketProbability = members.filter(value => (weather.bucketLower === null || value >= weather.bucketLower) && (weather.bucketUpper === null || value < weather.bucketUpper)).length / members.length;
      const empirical = signals.outcome === "No" ? 1 - bucketProbability : bucketProbability;
      probability = (probability + empirical) / 2;
      const desiredBid = Math.min((bid + ask) / 2 - 0.01, probability - config.minEdge);
      if (!maker || !prob(maker.bidPrice) || maker.bidPrice > desiredBid + 0.000001 || maker.bidPrice < config.minPrice || maker.bidPrice > config.maxPrice
        || !finite(maker.observedAsk) || maker.observedAsk <= maker.bidPrice || !observed(maker.placedAt, now, 86400000)
        || !observed(maker.tradeAt, now, 120000) || stamp(maker.tradeAt) <= stamp(maker.placedAt) || maker.tradeSide !== "SELL"
        || typeof maker.tradeId !== "string" || !maker.tradeId || !prob(maker.tradePrice) || maker.tradePrice >= maker.bidPrice || !finite(maker.tradeSize) || maker.tradeSize <= 0) return hold("The ensemble maker requires a nonmarketable bid followed by a recorded sell through that bid.");
      if (Math.abs(weather.forecast - weather.previousForecast) < config.minForecastMove) return hold("The forecast must move before posting this ensemble bid.");
      return buy("The station ensemble supports the bid and a later trade supplied fill evidence.", probability, { limitPrice: maker.bidPrice, maxShares: maker.tradeSize,
        targetFraction: fractionalKelly(probability, maker.bidPrice + feePerShare(maker.bidPrice, signals), config.kellyFraction), metadata: { probability, empirical, station: weather.station, evidenceTrade: maker.tradeId, fillModel: "observed-trade-through", queuePriorityKnown: false } });
    }
    const edge = probability - ask - fee;
    if ((!config.sameDay && Math.abs(weather.forecast - weather.previousForecast) < config.minForecastMove) || ask < config.minPrice || ask > config.maxPrice || edge < config.minEdge) return hold("The forecast change, entry price or edge after fees did not pass.", { probability, edge });
    return buy("The station forecast changed and its bucket probability passed the edge check.", probability, { targetFraction: fractionalKelly(probability, ask + fee, config.kellyFraction), metadata: { probability, edge, station: weather.station, leadDays: weather.leadDays } });
  }
  if (id === "maker-resting") {
    const maker = signals.maker;
    if (!maker || maker.bidPrice !== config.bidPrice || !prob(maker.observedAsk) || maker.observedAsk <= maker.bidPrice
      || !observed(maker.placedAt, now, 86400000) || now - stamp(maker.placedAt) < config.minimumRestMs) return hold("The configured bid must first rest strictly below an observed ask.");
    if (!observed(maker.tradeAt, now, 120000) || stamp(maker.tradeAt) <= stamp(maker.placedAt) || maker.tradeSide !== "SELL"
      || typeof maker.tradeId !== "string" || !maker.tradeId || !prob(maker.tradePrice) || maker.tradePrice >= maker.bidPrice || !finite(maker.tradeSize) || maker.tradeSize <= 0) return hold("A later public sell strictly through the resting bid is required.");
    if (!finite(secondsLeft) || secondsLeft < config.minSecondsLeft) return hold("The market end must leave enough time for this maker test.");
    return buy("A later public sell traded through the resting paper bid.", null, { limitPrice: maker.bidPrice, maxShares: maker.tradeSize,
      metadata: { fillModel: "observed-trade-through", evidenceTrade: maker.tradeId, placedAt: maker.placedAt, queuePriorityKnown: false } });
  }
  if (id === "solana-momentum") {
    const security = signals.security;
    if (!security || security.mintAuthorityRevoked !== true || security.freezeAuthorityRevoked !== true || security.serialDeployer !== false
      || !finite(security.topHolderPercent) || security.topHolderPercent < 0 || security.topHolderPercent > config.maxHolderPercent || !observed(security.checkedAt, now, 3600000)) return hold("Fresh token authority, deployer and holder checks must pass before a scalp.");
    const age = (now - stamp(signals.poolCreatedAt)) / 60000;
    const poolLiquidity = signals.poolLiquidity ?? quote.liquidity;
    if (!finite(poolLiquidity) || poolLiquidity < config.minLiquidity || !finite(age) || age < config.minAgeMinutes || age > config.maxAgeMinutes) return hold("Pool liquidity or age is outside the book's limits.");
    if (![signals.priceChange5m, signals.buys5m, signals.sells5m].every(finite) || signals.buys5m < 0 || signals.sells5m < 0
      || signals.priceChange5m < config.minChangePercent || signals.priceChange5m > config.maxChangePercent || signals.buys5m + signals.sells5m < config.minTransactions
      || signals.buys5m / Math.max(1, signals.sells5m) < config.minBuySellRatio) return hold("Momentum and recent transaction activity did not pass.");
    return buy("The token safety evidence, liquidity and momentum checks passed.", null, { maxNotionalUsd: Math.min(100, poolLiquidity * 0.01), metadata: { liquidityCapPercent: 1 } });
  }
  const prior = history.filter(row => row?.instrument === quote.instrument && stamp(row.timestamp) < now && finite(row.price) && row.price > 0).sort((a, b) => stamp(a.timestamp) - stamp(b.timestamp));
  if (prior.length < config.slowPeriod) return hold("More earlier observations are needed for both moving averages.");
  const mean = (rows, length) => rows.slice(-length).reduce((sum, row) => sum + row.price, 0) / length;
  const current = [...prior, quote], previousFast = mean(prior, config.fastPeriod), previousSlow = mean(prior, config.slowPeriod);
  const fast = mean(current, config.fastPeriod), slow = mean(current, config.slowPeriod);
  if (position) return fast < slow ? sell("The fast average moved below the slow average.") : hold("The existing trend remains above the slow average.");
  return fast > slow && previousFast <= previousSlow ? buy("The fast average crossed above the slow average.", null, { metadata: { fast, slow } }) : hold("Wait for a new upward moving-average crossover.");
}
