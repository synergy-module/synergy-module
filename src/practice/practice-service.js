import { createHash, randomUUID } from "node:crypto";
import { strategyDefinitions, strategyPresets, evaluateStrategy, validateStrategyConfig } from "./strategies.js";
import { createForwardQuoteReader, validateForwardFeed } from "./forward-quotes.js";
import { assessPracticeReadiness, timeWeightedAverage, realizedVolatility, twapProbability, calibrateWeather, blendWeatherForecasts, ensembleBucketProbability, paperSize } from "./evidence.js";

export const practiceError = (message, status = 422) => Object.assign(new Error(message), { code: "PRACTICE_INPUT", status });
const round = n => Math.round(n * 1e8) / 1e8;
const finite = n => typeof n === "number" && Number.isFinite(n);
const plain = x => x && typeof x === "object" && !Array.isArray(x);
const identity = owner => {
  if (typeof owner !== "string" || !owner.trim() || owner.length > 200) throw practiceError("Sign in to open your practice workspace.", 401);
  return createHash("sha256").update(owner).digest("hex");
};
const key = (owner, type = "index", id = "") => `practice:${identity(owner)}:${type}:${id}`;
const idValid = id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
const defaults = { positionUsd: 25, maxExposurePercent: 50, maxPositions: 5, maxDrawdownPercent: 20, feeBps: 10, slippageBps: 10 };
const ranges = { positionUsd: [1, 100000], maxExposurePercent: [1, 100], maxPositions: [1, 30], maxDrawdownPercent: [1, 100], feeBps: [0, 500], slippageBps: [0, 1000] };
function text(value, label, maximum = 100) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\x00-\x1f]/.test(value)) throw practiceError(`Enter a valid ${label} (up to ${maximum} characters).`);
  return value.trim();
}
function rules(input = {}) {
  if (!plain(input) || Object.keys(input).some(k => !Object.hasOwn(defaults, k))) throw practiceError("Choose the supported simulation risk settings.");
  const result = { ...defaults, ...input };
  for (const [name, [min, max]] of Object.entries(ranges)) if (!finite(result[name]) || result[name] < min || result[name] > max) throw practiceError(`${name} must be between ${min} and ${max}.`);
  if (!Number.isInteger(result.maxPositions)) throw practiceError("Maximum positions must be a whole number.");
  return result;
}
function canonicalFeed(input) {
  if (!input) return null;
  const feed = structuredClone(input);
  if (feed.source === "binance") feed.instrument = `BINANCE:${feed.instrument.replace(/^BINANCE:/i, "").toUpperCase()}`;
  if (feed.source === "polymarket") feed.instrument = `POLY:${feed.instrument.replace(/^POLY:/i, "")}`;
  return feed;
}
function specification(body) {
  if (!plain(body) || Object.keys(body).some(k => !["name", "strategyId", "config", "initialCapital", "risk", "feed"].includes(k))) throw practiceError("Check the strategy account fields. Only simulated trading is supported here.");
  if (!strategyDefinitions.some(s => s.id === body.strategyId)) throw practiceError("Choose a strategy from the practice catalog.");
  if (!plain(body.config ?? {}) || JSON.stringify(body.config ?? {}).length > 6000) throw practiceError("Strategy options are too large or invalid.");
  const capital = body.initialCapital ?? 500;
  if (!finite(capital) || capital < 10 || capital > 1000000) throw practiceError("Starting virtual cash must be between $10 and $1,000,000.");
  if (!plain(body.feed) || typeof body.feed.instrument !== "string" || !body.feed.instrument.trim()) throw practiceError("Choose a current public market feed for this paper account.");
  validateForwardFeed(body.feed, body.strategyId, body.config ?? {});
  if (strategyDefinitions.find(s => s.id === body.strategyId).marketType === "prediction" && body.feed.source !== "polymarket") throw practiceError("Choose a Polymarket outcome for this prediction strategy.");
  return { name: text(body.name, "account name", 80), strategyId: body.strategyId, config: validateStrategyConfig(body.strategyId, body.config ?? {}), initialCapital: capital, risk: rules(body.risk), feed: canonicalFeed(body.feed) };
}
export function normalizePracticeQuote(input, { assumptions, maximumTime = Infinity } = {}) {
  if (!plain(input)) throw practiceError("Each observation must be a JSON object.");
  const timestamp = typeof input.timestamp === "number" ? input.timestamp : Date.parse(input.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > maximumTime) throw practiceError("Observations need valid timestamps and cannot come from the future.");
  const instrument = text(input.instrument, "instrument", 160);
  let bid = input.bid, ask = input.ask, liquidity = input.liquidity;
  const modeled = !finite(bid) || !finite(ask) || !finite(liquidity);
  if (modeled) {
    if (assumptions?.accepted !== true || !finite(input.price) || input.price <= 0 || !finite(assumptions.spreadBps) || assumptions.spreadBps < 0 || assumptions.spreadBps > 1000 || !finite(assumptions.depthUsd) || assumptions.depthUsd <= 0 || assumptions.depthUsd > 1000000) throw practiceError("The market observation needs a bid, ask and available dollar depth.");
    bid = input.price * (1 - assumptions.spreadBps / 20000); ask = input.price * (1 + assumptions.spreadBps / 20000); liquidity = assumptions.depthUsd;
  }
  if (!finite(bid) || !finite(ask) || bid < 0 || ask <= 0 || bid > ask || !finite(liquidity) || liquidity < 0) throw practiceError("Quotes need a nonnegative bid, positive ask, bid ≤ ask, and nonnegative available dollar depth.");
  const signals = input.signals ?? {};
  if (!plain(signals) || JSON.stringify(signals).length > 6000) throw practiceError("Observation signals are invalid or too large.");
  if (signals.feeRate != null && (!finite(signals.feeRate) || signals.feeRate < 0 || signals.feeRate > 1)
    || signals.feeExponent != null && (!finite(signals.feeExponent) || signals.feeExponent < 0 || signals.feeExponent > 5)) throw practiceError("Recorded fee rate and exponent must be valid nonnegative numbers.");
  if (input.observedAt != null && (!Number.isFinite(Date.parse(input.observedAt)) || Date.parse(input.observedAt) > timestamp)) throw practiceError("Order-book evidence cannot come from after the observation.");
  for (const name of ["observedAt", "availableAt", "forecastAt"]) if (signals[name] != null && (!Number.isFinite(Date.parse(signals[name])) || Date.parse(signals[name]) > timestamp)) throw practiceError("Evidence must have been available at the time of the observation.");
  let settlement = null;
  if (input.settlement != null) {
    if (!plain(input.settlement) || !finite(input.settlement.payout) || input.settlement.payout < 0 || input.settlement.payout > 1 || typeof input.settlement.source !== "string" || !input.settlement.source.trim()) throw practiceError("Settlement needs a payout from 0 to 1 and a source.");
    settlement = { payout: input.settlement.payout, source: input.settlement.source.slice(0, 300) };
  }
  return { instrument, timestamp: new Date(timestamp).toISOString(), price: finite(input.price) && input.price >= 0 ? input.price : (bid + ask) / 2,
    bid, ask, liquidity, observedAt: input.observedAt ?? signals.observedAt ?? new Date(timestamp).toISOString(), signals: structuredClone(signals), executionModel: modeled ? "modeled-spread-and-depth" : "supplied-bid-ask-depth", settlement };
}
function newBook(spec, now, mode = "PAPER") {
  return { id: randomUUID(), ...spec, mode, cash: spec.initialCapital, positions: [], trades: [], equityCurve: [], decisions: [], seen: {}, history: [],
    peakEquity: spec.initialCapital, maxDrawdownPercent: 0, feesPaid: 0, realizedPnl: 0, consumedSignals: [], orderRequests: [], createdAt: now, updatedAt: now, worker: { enabled: false, lastError: null }, observationCount: 0 };
}
const equity = b => round(b.cash + b.positions.reduce((sum, p) => sum + p.quantity * p.markPrice, 0));
const scheduledFee = (quote, price) => finite(quote.signals?.feeRate) && quote.signals.feeRate >= 0 && quote.signals.feeRate <= 1 && price > 0 && price < 1
  ? quote.signals.feeRate * (price * (1 - price)) ** (quote.signals.feeExponent ?? 1) : 0;
function fillSell(book, position, quote, reason, settlement = false) {
  const feeRate = settlement ? 0 : book.risk.feeBps / 10000;
  const price = settlement ? quote.settlement.payout : quote.bid * (1 - book.risk.slippageBps / 10000);
  const notional = position.quantity * price;
  if (!settlement && (quote.liquidity < notional || !finite(price))) return false;
  const fee = notional * feeRate + (settlement ? 0 : position.quantity * scheduledFee(quote, price)), pnl = notional - fee - position.cost;
  if (![notional, fee, pnl, book.cash + notional - fee].every(finite)) throw practiceError("This fill exceeds the supported numeric limits.");
  book.cash = round(book.cash + notional - fee); book.realizedPnl = round(book.realizedPnl + pnl); book.feesPaid = round(book.feesPaid + fee);
  book.trades.push({ id: randomUUID(), groupId: position.groupId, instrument: position.instrument, side: settlement ? "SETTLE" : "SELL", quantity: position.quantity,
    price: round(price), notional: round(notional), fee: round(fee), pnl: round(pnl), timestamp: quote.timestamp, reason, executionModel: quote.executionModel,
    ...(settlement && quote.signals.resolution ? { resolution: structuredClone(quote.signals.resolution), ruleChanged: quote.signals.resolution.ruleChanged === true } : {}) });
  book.positions = book.positions.filter(p => p.id !== position.id); return true;
}
function buy(book, quote, decision) {
  const currentEquity = equity(book), exposure = book.positions.reduce((s, p) => s + p.cost, 0);
  if (currentEquity <= book.peakEquity * (1 - book.risk.maxDrawdownPercent / 100)) return "Drawdown limit reached; entries paused.";
  if (book.trades.length >= 1950) return "Ledger capacity reached. Start a new strategy account.";
  let legs = Array.isArray(decision.legs) && decision.legs.length ? decision.legs : [{ instrument: quote.instrument, bid: quote.bid, ask: quote.ask, price: quote.ask, liquidity: quote.liquidity }];
  if (legs.length > 2 || legs.some(l => typeof l.instrument !== "string" || !finite(l.ask ?? l.price) || (l.ask ?? l.price) <= 0 || !finite(l.bid) || l.bid < 0 || l.bid > (l.ask ?? l.price) || !finite(l.liquidity) || l.liquidity <= 0)) return "Executable evidence is incomplete; no simulated fill.";
  const newLegs = legs.filter(l => !book.positions.some(p => p.instrument === l.instrument));
  if (book.positions.length + newLegs.length > book.risk.maxPositions || legs.some(l => book.positions.some(p => p.instrument === l.instrument
    && decision.intent !== "ADD" && !(decision.intent === "HEDGE" && p.intent === "HEDGE" && p.groupId === decision.groupId)))) return "Position limit or an existing position blocks this entry.";
  const budget = Math.min(book.risk.positionUsd, book.cash, currentEquity * (decision.targetFraction ?? 1), decision.maxNotionalUsd ?? Infinity, currentEquity * book.risk.maxExposurePercent / 100 - exposure);
  if (budget < 1) return "Cash or exposure limit blocks this entry.";
  const feeRate = book.risk.feeBps / 10000, slip = book.risk.slippageBps / 10000;
  const prices = legs.map(l => finite(decision.limitPrice) ? decision.limitPrice : (l.ask ?? l.price) * (1 + slip));
  const shares = Math.min(decision.maxShares ?? Infinity, budget / prices.reduce((s, p) => s + p * (1 + feeRate) + scheduledFee(quote, p), 0));
  const fills = legs.map((l, i) => { const quantity = decision.equalShares || legs.length === 1 ? shares : budget * (l.allocationFraction ?? 1 / legs.length) / (prices[i] * (1 + feeRate)); return { ...l, price: prices[i], quantity, notional: quantity * prices[i] }; });
  if (fills.some(f => ![f.price, f.quantity, f.notional].every(finite) || round(f.quantity) <= 0)) return "This fill exceeds the supported numeric limits.";
  if (fills.some(f => f.notional > f.liquidity)) return "Available depth is too small; the entire simulated order was rejected.";
  const groupId = decision.groupId ?? (decision.intent === "ADD" ? book.positions.find(p => p.instrument === quote.instrument)?.groupId : null) ?? randomUUID();
  for (const f of fills) {
    const fee = f.notional * feeRate + f.quantity * scheduledFee(quote, f.price), cost = f.notional + fee;
    if (![fee, cost, book.cash - cost].every(finite)) throw practiceError("This fill exceeds the supported numeric limits.");
    book.cash = round(book.cash - cost); book.feesPaid = round(book.feesPaid + fee);
    const existing = ["ADD", "HEDGE"].includes(decision.intent) ? book.positions.find(p => p.instrument === f.instrument) : null;
    if (existing) { existing.entryPrice = (existing.entryPrice * existing.quantity + f.price * f.quantity) / (existing.quantity + f.quantity); existing.quantity = round(existing.quantity + f.quantity); existing.cost = round(existing.cost + cost); existing.markPrice = f.bid; existing.markedAt = quote.timestamp; existing.lastFillAt = quote.timestamp; existing.fillCount = (existing.fillCount ?? 1) + 1; }
    else book.positions.push({ id: randomUUID(), groupId, intent: decision.intent ?? "ENTRY", instrument: f.instrument, marketId: quote.signals.marketId, quantity: round(f.quantity), entryPrice: f.price, entryTimestamp: quote.timestamp, openedAt: quote.timestamp, lastFillAt: quote.timestamp, fillCount: 1, cost: round(cost), markPrice: f.bid, markedAt: quote.timestamp });
    book.trades.push({ id: randomUUID(), groupId, instrument: f.instrument, side: "BUY", quantity: round(f.quantity), price: f.price, notional: round(f.notional), fee: round(fee), pnl: 0,
      timestamp: quote.timestamp, reason: decision.reason, executionModel: quote.executionModel });
  }
  return decision.reason;
}
export function applyPracticeObservation(book, quote, evaluator = evaluateStrategy) {
  const previous = book.seen[quote.instrument];
  if (previous && Date.parse(quote.timestamp) <= Date.parse(previous)) throw practiceError("This observation is duplicate or older than the last observation for that instrument.", 409);
  if (book.updatedAt && book.observationCount > 0 && Date.parse(quote.timestamp) < Date.parse(book.updatedAt)) throw practiceError("Observations must arrive in chronological order.", 409);
  book.seen[quote.instrument] = quote.timestamp;
  const position = book.positions.find(p => p.instrument === quote.instrument);
  if (position) { position.markPrice = quote.bid; position.markedAt = quote.timestamp; }
  let decision = { action: "HOLD", reason: "No qualifying evidence." };
  if (quote.settlement && position) {
    fillSell(book, position, quote, `Settlement: ${quote.settlement.source}`, true);
    decision = { action: "SETTLE", reason: "Resolved at the verified provider settlement payout." };
  } else {
    decision = evaluator(book.strategyId, { history: book.history.filter(q => q.instrument === quote.instrument), quote, position, positions: book.positions, config: book.config });
    if (!plain(decision) || !["BUY", "SELL", "HOLD"].includes(decision.action)) throw practiceError("The strategy returned an unsupported decision.");
    if (decision.action === "BUY") {
      const evidenceId = quote.signals.copy?.transaction ?? quote.signals.maker?.tradeId;
      if (evidenceId && book.consumedSignals.includes(evidenceId)) decision = { action: "HOLD", reason: "This signal has already been used by this strategy account." };
      else { const count = book.trades.length, reason = buy(book, quote, decision); decision = { ...decision, action: book.trades.length > count ? "BUY" : "HOLD", reason }; if (book.trades.length > count && evidenceId) { book.consumedSignals.push(evidenceId); book.consumedSignals = book.consumedSignals.slice(-400); } }
    }
    if (decision.action === "SELL" && position && !fillSell(book, position, quote, decision.reason)) decision = { action: "HOLD", reason: "Exit depth unavailable. Position remains open." };
  }
  book.history.push({ instrument: quote.instrument, timestamp: quote.timestamp, price: quote.price }); book.history = book.history.slice(-501);
  book.decisions.push({ instrument: quote.instrument, timestamp: quote.timestamp, action: decision.action, reason: String(decision.reason).slice(0, 400) }); book.decisions = book.decisions.slice(-30);
  book.updatedAt = quote.timestamp; book.observationCount++;
  const value = equity(book); book.peakEquity = Math.max(book.peakEquity, value);
  book.maxDrawdownPercent = Math.max(book.maxDrawdownPercent, book.peakEquity > 0 ? (book.peakEquity - value) / book.peakEquity * 100 : 0);
  book.equityCurve.push({ timestamp: quote.timestamp, equity: value });
  if (book.equityCurve.length > 250) book.equityCurve = book.equityCurve.filter((_, i) => i % 2 === 0 || i === book.equityCurve.length - 1);
  return decision;
}
export function practiceSummary(book) {
  const exits = book.trades.filter(t => t.side !== "BUY"), wins = exits.filter(t => t.pnl > 0), grossProfit = wins.reduce((s, t) => s + t.pnl, 0), grossLoss = -exits.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  const expectedCash = book.initialCapital + book.trades.reduce((sum, t) => sum + (t.side === "BUY" ? -t.notional - t.fee : t.notional - t.fee), 0);
  return { ...book, history: undefined, seen: undefined, consumedSignals: undefined, orderRequests: undefined, equity: equity(book), returnPercent: round((equity(book) / book.initialCapital - 1) * 100),
    winRate: exits.length ? round(wins.length / exits.length * 100) : null, closedTrades: exits.length, profitFactor: grossLoss ? round(grossProfit / grossLoss) : null,
    readiness: assessPracticeReadiness(book, { now: book.updatedAt, auditedAt: book.updatedAt, violations: Math.abs(expectedCash - book.cash) >= 0.0001 ? [{ timestamp: book.updatedAt, reason: "Cash ledger mismatch" }] : [] }),
    qa: { cashReconciles: Math.abs(expectedCash - book.cash) < 0.0001, noNegativeCash: book.cash >= -0.0001, openPositions: book.positions.length,
      settled: book.positions.length === 0, sampleSufficient: exits.length >= 30, eligibleForLive: false,
      message: "Simulation results never enable live execution. Open positions are marked, not counted as closed profits." } };
}

export function createPracticeService({ repository, marketData, referenceFeeds, now = () => new Date(), evaluator = evaluateStrategy, canOperate = async () => true,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const timers = new Map(), running = new Set(), pending = new Set(), workerId = randomUUID(); let closed = false;
  const at = () => now().toISOString();
  const forwardQuote = createForwardQuoteReader({ marketData, referenceFeeds, now });
  const readIndex = async owner => (await repository.read(key(owner))).practice ?? { books: [] };
  const changeIndex = (owner, fn) => repository.update(key(owner), state => { state.practice ??= { books: [] }; return fn(state.practice); });
  async function record(owner, type, id) { if (!idValid(id)) throw practiceError("This practice record was not found.", 404); const value = (await repository.read(key(owner, type, id))).record; if (!value || value.deletedAt) throw practiceError("This practice record was not found for your account.", 404); value.feed = canonicalFeed(value.feed); return value; }
  const save = (owner, type, value) => repository.update(key(owner, type, value.id), state => { state.record = value; });
  const mutateBook = (owner, id, change) => {
    if (!idValid(id)) throw practiceError("Strategy account not found.", 404);
    return repository.update(key(owner, "book", id), state => { if (!state.record || state.record.deletedAt) throw practiceError("Strategy account not found.", 404); const result = change(state.record); return result ?? summary(state.record); });
  };
  const summary = book => {
    const value = practiceSummary(book);
    value.worker = { ...book.worker, enabled: !closed && book.worker.enabled && book.worker.workerId === workerId, workerId: undefined, generation: undefined,
      ...(book.worker.enabled && book.worker.workerId !== workerId ? { lastError: "Paused after a server restart. Start this account to resume." } : {}) };
    return value;
  };
  async function freshQuote(book, instrument = book.feed?.instrument) {
    if (!book.feed) throw practiceError("Connect a public market feed to this paper account first.");
    const feed = { ...book.feed, instrument }, position = book.positions.find(p => p.instrument === instrument);
    if (instrument !== book.feed.instrument) delete feed.outcomeIndex;
    if (position?.marketId) feed.marketId = position.marketId;
    const value = await marketData.quote(feed), quote = normalizePracticeQuote(value.quote ?? value, { maximumTime: now().valueOf() + 5000 });
    if (now().valueOf() - Date.parse(quote.observedAt) > 90000) throw practiceError("The market quote is stale. No simulated order was placed.");
    return quote;
  }
  function schedule(owner, id, seconds) {
    const timerKey = `${identity(owner)}:${id}`; clearTimer(timers.get(timerKey));
    if (closed) return;
    const timer = setTimer(() => { const task = cycle(owner, id).finally(() => pending.delete(task)); pending.add(task); return task; }, seconds * 1000);
    timer?.unref?.(); timers.set(timerKey, timer);
  }
  async function cycle(owner, id) {
    const timerKey = `${identity(owner)}:${id}`;
    if (closed) return;
    if (running.has(timerKey)) { schedule(owner, id, 1); return; }
    running.add(timerKey); let generation;
    try {
      const book = await record(owner, "book", id); if (!book.worker.enabled || book.worker.workerId !== workerId) return;
      generation = book.worker.generation;
      if (!await canOperate(owner)) { await api.pause(owner, id); return; }
      const held = await Promise.all(book.positions.filter(p => book.feed.followAllMarkets === true || p.instrument !== book.feed.instrument).map(p => freshQuote(book, p.instrument)));
      const prepared = await forwardQuote(owner, book);
      const quote = normalizePracticeQuote(prepared.quote, { maximumTime: now().valueOf() + 5000 });
      if (now().valueOf() - Date.parse(quote.observedAt) > 90000) throw practiceError("Public quote is stale; no fill was recorded.");
      if (!await canOperate(owner)) { await api.pause(owner, id); return; }
      const observations = [...held, quote].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      await mutateBook(owner, id, b => {
        if (closed || !b.worker.enabled || b.worker.workerId !== workerId || b.worker.generation !== generation) return;
        for (const observed of observations) {
          if (Date.parse(observed.timestamp) <= Date.parse(b.seen[observed.instrument] ?? 0) || Date.parse(observed.timestamp) < Date.parse(b.updatedAt)) continue;
          applyPracticeObservation(b, observed, observed === quote ? evaluator : () => ({ action: "HOLD", reason: "Marked the held virtual position using current market evidence." }));
        }
        b.forwardEvidence = prepared.forwardEvidence; b.feed = prepared.feed ?? b.feed; b.worker.lastError = null; b.worker.lastCycleAt = at();
      });
    } catch (error) { await mutateBook(owner, id, b => { if (!closed && b.worker.enabled && b.worker.workerId === workerId && b.worker.generation === generation) b.worker.lastError = error.code ? error.message : "The public market feed is unavailable. No fill was recorded."; }).catch(() => {}); }
    finally { running.delete(timerKey); if (!closed) { const book = await record(owner, "book", id).catch(() => null); if (book?.worker.enabled && book.worker.workerId === workerId && book.worker.generation === generation) schedule(owner, id, book.worker.intervalSeconds ?? 60); } }
  }
  const api = {
    async state(owner) {
      const index = await readIndex(owner), retired = [];
      const books = (await Promise.all(index.books.map(async id => {
        const value = (await repository.read(key(owner, "book", id))).record;
        if (value?.deletedAt) { retired.push(id); return null; }
        if (!value) return null;
        value.feed = canonicalFeed(value.feed); return summary(value);
      }))).filter(Boolean);
      if (retired.length) await changeIndex(owner, current => { current.books = current.books.filter(id => !retired.includes(id)); }).catch(() => {});
      return { mode: "PRACTICE", liveExecution: false, storage: repository.getStorageStatus(), strategies: strategyDefinitions, presets: strategyPresets, books };
    },
    async createBook(owner, body) { const book = newBook(specification(body), at()); await changeIndex(owner, index => { if (index.books.length >= 12) throw practiceError("Archive a strategy account before creating another (maximum 12).", 409); index.books.push(book.id); }); try { await save(owner, "book", book); } catch (e) { await changeIndex(owner, i => { i.books = i.books.filter(id => id !== book.id); }); throw e; } return practiceSummary(book); },
    book: async (owner, id) => summary(await record(owner, "book", id)),
    async observe(owner, id, body) { if (!plain(body) || Object.keys(body).some(k => k !== "quote")) throw practiceError("Submit a quote for simulated observation."); const quote = normalizePracticeQuote(body.quote, { maximumTime: now().valueOf() + 5000 }); if (now().valueOf() - Date.parse(quote.observedAt) > 90000) throw practiceError("Paper observations must be fresh. Refresh the public feed before continuing."); return mutateBook(owner, id, b => { applyPracticeObservation(b, quote, evaluator); }); },
    async start(owner, id, body = {}) { if (closed) throw practiceError("The paper service is restarting.", 503); if (!plain(body) || Object.keys(body).some(k => k !== "intervalSeconds")) throw practiceError("Only paper polling can be started here."); const seconds = body.intervalSeconds ?? 60; if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) throw practiceError("Choose an update interval between 30 and 3,600 seconds."); const b = await mutateBook(owner, id, b => { if (!b.feed) throw practiceError("Create an account with a public market feed before starting paper observation."); if (b.strategyId === "solana-momentum") throw practiceError("Use Solana research screening until an executable swap feed and deployer evidence are connected."); b.worker = { enabled: true, workerId, generation: randomUUID(), intervalSeconds: seconds, lastError: null }; }); schedule(owner, id, 0); return b; },
    async pause(owner, id) { clearTimer(timers.get(`${identity(owner)}:${id}`)); timers.delete(`${identity(owner)}:${id}`); return mutateBook(owner, id, b => { b.worker.enabled = false; b.worker.generation = randomUUID(); }); },
    async removeBook(owner, id) {
      if (!idValid(id)) throw practiceError("Strategy account not found.", 404);
      // Keep a small tombstone so deletion can be retried after an index write
      // failure and in-flight quote work cannot recreate a deleted account.
      await repository.update(key(owner, "book", id), s => {
        if (!s.record) throw practiceError("Strategy account not found.", 404);
        if (s.record.positions?.length) throw practiceError("An account with open simulated positions cannot be deleted. Settle or close them first.", 409);
        s.record = { id, deletedAt: at() };
      });
      clearTimer(timers.get(`${identity(owner)}:${id}`)); timers.delete(`${identity(owner)}:${id}`);
      await changeIndex(owner, i => { i.books = i.books.filter(x => x !== id); }); return { ok: true };
    },
    async closePosition(owner, id, positionId, body) { const quote = normalizePracticeQuote(body?.quote, { maximumTime: now().valueOf() + 5000 }); if (now().valueOf() - Date.parse(quote.observedAt) > 90000) throw practiceError("A fresh bid and depth are required to close a paper position."); return mutateBook(owner, id, b => { const p = b.positions.find(p => p.id === positionId && p.instrument === quote.instrument); if (!p) throw practiceError("Paper position not found.", 404); if (Date.parse(quote.timestamp) <= Date.parse(b.seen[quote.instrument]) || Date.parse(quote.timestamp) < Date.parse(b.updatedAt)) throw practiceError("The closing observation must come after the most recent observation.", 409); if (!fillSell(b, p, quote, "Manual paper close")) throw practiceError("Available bid depth cannot fill this exit."); applyPracticeObservation(b, quote, () => ({ action: "HOLD", reason: "Manually closed the simulated position." })); }); },
    async placeOrder(owner, id, body) {
      if (!plain(body) || Object.keys(body).some(k => !["side", "budgetUsd", "positionId", "requestId"].includes(k)) || !["BUY", "SELL"].includes(body.side)) throw practiceError("Choose Buy or Sell. Prices are fetched from your account's live market feed.");
      if (body.requestId != null && (typeof body.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId))) throw practiceError("Use a unique order request identifier of 8 to 100 letters, numbers or dashes.");
      const saved = await record(owner, "book", id);
      if (body.requestId && saved.orderRequests?.includes(body.requestId)) return practiceSummary(saved);
      const position = body.side === "SELL" ? saved.positions.find(p => p.id === body.positionId) : null;
      if (body.side === "SELL" && !position) throw practiceError("Choose an open position in this paper account.", 404);
      if (body.side === "BUY" && (!finite(body.budgetUsd) || body.budgetUsd < 1 || body.budgetUsd > saved.risk.positionUsd)) throw practiceError(`Choose a paper order budget between $1 and this account's $${saved.risk.positionUsd} entry limit.`);
      const quote = await freshQuote(saved, position?.instrument ?? saved.feed?.instrument);
      return mutateBook(owner, id, book => {
        book.orderRequests ??= [];
        if (body.requestId && book.orderRequests.includes(body.requestId)) return;
        if (body.side === "BUY") {
          if (book.strategyId !== "manual") throw practiceError("Manual orders need a Manual paper trading account so strategy results stay independent.", 409);
          if (body.budgetUsd > book.cash || body.budgetUsd > equity(book) * book.risk.maxExposurePercent / 100 - book.positions.reduce((sum, p) => sum + p.cost, 0)) throw practiceError("This order exceeds available virtual cash or the account's exposure limit.");
          const count = book.trades.length;
          applyPracticeObservation(book, quote, () => ({ action: "BUY", intent: "ADD", targetFraction: 1, maxNotionalUsd: body.budgetUsd, reason: "Manual paper buy at the current market ask, including simulation costs." }));
          if (book.trades.length === count) throw practiceError(book.decisions.at(-1).reason);
        } else {
          const held = book.positions.find(p => p.id === body.positionId && p.instrument === quote.instrument); if (!held) throw practiceError("This paper position is no longer open.", 409);
          if (Date.parse(quote.timestamp) <= Date.parse(book.seen[quote.instrument]) || Date.parse(quote.timestamp) < Date.parse(book.updatedAt)) throw practiceError("A newer quote is needed. Refresh and try again.", 409);
          if (!fillSell(book, held, quote, quote.settlement ? `Settlement: ${quote.settlement.source}` : "Manual paper sale at current market bid", Boolean(quote.settlement))) throw practiceError("Available market depth cannot fill this simulated exit.");
          applyPracticeObservation(book, quote, () => ({ action: "HOLD", reason: "Paper position closed using a live market quote." }));
        }
        if (body.requestId) book.orderRequests.push(body.requestId); book.orderRequests = book.orderRequests.slice(-200);
      });
    },
    async refreshBook(owner, id) {
      const saved = await record(owner, "book", id), instruments = [...new Set([saved.feed?.instrument, ...saved.positions.map(p => p.instrument)].filter(Boolean))];
      if (!instruments.length) throw practiceError("This account needs a public market feed to refresh prices.");
      const quotes = await Promise.all(instruments.map(instrument => freshQuote(saved, instrument)));
      quotes.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      return mutateBook(owner, id, book => {
        for (const quote of quotes) {
          if (Date.parse(quote.timestamp) <= Date.parse(book.seen[quote.instrument] ?? 0) || Date.parse(quote.timestamp) < Date.parse(book.updatedAt)) continue;
          applyPracticeObservation(book, quote, () => ({ action: "HOLD", reason: "Updated virtual holdings from a current public market quote." }));
        }
      });
    },
    async publicData(method, input) { if (!["discover", "quote", "weather", "weatherEnsemble", "solana", "scanSolana", "wallet", "cryptoModel", "cryptoWindow", "tokenEvidence"].includes(method) || typeof marketData?.[method] !== "function") throw practiceError("Choose a supported public data source."); if (method === "cryptoModel" && input?.referenceTicks !== undefined) throw practiceError("Public crypto model calls use the documented spot proxy. Recorded reference prices are read from your recorder by the paper worker."); return marketData[method](input); },
    evidence(method, input) { const methods = { twap: timeWeightedAverage, volatility: realizedVolatility, "twap-probability": twapProbability, "weather-calibration": calibrateWeather, "weather-blend": blendWeatherForecasts, "weather-ensemble": ensembleBucketProbability, sizing: paperSize }; if (!Object.hasOwn(methods, method)) throw practiceError("Choose a supported evidence calculation."); return { method, result: methods[method](input) }; },
    async close() { closed = true; for (const timer of timers.values()) clearTimer(timer); timers.clear(); await Promise.allSettled([...pending]); },
  };
  return api;
}
