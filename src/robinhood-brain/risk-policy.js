// Two-phase risk patterns adapted from FriesTrader, Copyright (c) 2026 Yizhi Song.
// MIT notice: docs/third-party/friestrader-LICENSE.txt.
export const brainError = (code, message, status = 422) => Object.assign(new Error(message), { code: `RH_BRAIN_${code}`, status });
export const PROVIDERS = ["claude", "gemini", "grok", "openai"];
export const DEFAULT_POLICY = Object.freeze({ accountNumber: "", symbols: ["SPY"], provider: "gemini", criticProvider: "claude",
  orderBudgetUsd: 100, maxPositionPercent: 5, maxPositions: 4, cashBufferPercent: 20,
  dailyLossPercent: 3, weeklyLossPercent: 8, stopLossPercent: 7, maxSpreadPercent: 0.5,
  maxEntryGapPercent: 3, maxExtensionPercent: 10, earningsBlackoutDays: 5, cycleSeconds: 900 });
export const round = value => Math.round(value * 1000000) / 1000000;
const positive = value => typeof value === "number" && Number.isFinite(value) && value > 0;
export const fresh = (value, now, maxAge = 90_000) => {
  const age = now.valueOf() - Date.parse(value);
  return Number.isFinite(age) && age >= -5000 && age <= maxAge;
};
export function validatePolicy(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !Object.hasOwn(DEFAULT_POLICY, key))) throw brainError("INPUT", "Check the policy fields.");
  const policy = { ...structuredClone(DEFAULT_POLICY), ...body };
  if (typeof policy.accountNumber !== "string" || !/^[a-zA-Z0-9_-]{0,80}$/.test(policy.accountNumber)
    || !PROVIDERS.includes(policy.provider) || !PROVIDERS.includes(policy.criticProvider)
    || !Array.isArray(policy.symbols) || !policy.symbols.length || policy.symbols.length > 10
    || policy.symbols.some(symbol => typeof symbol !== "string" || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))) throw brainError("INPUT", "Choose providers, a valid account identifier, and up to ten equity symbols.");
  const ranges = { orderBudgetUsd: [1, 10000], maxPositionPercent: [0.1, 20], maxPositions: [1, 10], cashBufferPercent: [10, 90],
    dailyLossPercent: [0.1, 5], weeklyLossPercent: [0.1, 10], stopLossPercent: [1, 15], maxSpreadPercent: [0.01, 1],
    maxEntryGapPercent: [0.1, 5], maxExtensionPercent: [1, 15], earningsBlackoutDays: [1, 10], cycleSeconds: [300, 3600] };
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) if (!positive(policy[key]) || policy[key] < minimum || policy[key] > maximum
    || (["maxPositions", "cycleSeconds", "earningsBlackoutDays"].includes(key) && !Number.isInteger(policy[key]))) throw brainError("INPUT", "Risk values are outside the supported limits.");
  policy.symbols = [...new Set(policy.symbols)]; return policy;
}

export function screenMarket(market, held = false) {
  if (held) return { pass: true, signal: true, reasons: ["Held positions are always researched and risk checked."] };
  const reasons = [];
  if (!market || market.tradable !== true || market.isLeveraged !== false || market.isInverse !== false) reasons.push("Tradability or product type is unverified");
  if (!(market?.ask >= 5 && market.avgVolume >= 1_000_000 && market.marketCap >= 2_000_000_000)) reasons.push("Price, volume, or capitalization filter");
  const closes = market?.closes;
  if (!Array.isArray(closes) || closes.length < 200 || closes.some(value => !positive(value))) reasons.push("Missing verified 200-day price history");
  else if (market.ask < closes.slice(-200).reduce((sum, value) => sum + value, 0) / 200) reasons.push("Below the 200-day moving average");
  const change = closes?.length >= 61 ? Math.abs(closes.at(-1) / closes.at(-61) - 1) : 0;
  const signal = change >= 0.1 || (market?.volume > 0 && market.volume / market.avgVolume >= 2)
    || (market?.high52 > 0 && Math.abs(market.ask / market.high52 - 1) <= 0.03)
    || (market?.low52 > 0 && Math.abs(market.ask / market.low52 - 1) <= 0.03);
  return { pass: reasons.length === 0, signal, reasons, priceMove60d: round(change) };
}

export function planTrades({ snapshot, theses, policy, ledger = [], now = new Date() }) {
  const account = snapshot.account, positions = snapshot.positions, markets = snapshot.markets;
  const rejects = [], orders = [];
  const accountIssues = [];
  if (account?.number !== policy.accountNumber || account?.isAgentic !== true) accountIssues.push("Dedicated Agentic account is unverified");
  if (!fresh(account?.observedAt, now) || !positive(account?.equity) || typeof account?.cash !== "number" || !Number.isFinite(account.cash) || account.cash < 0) accountIssues.push("Fresh account valuation is missing");
  if (account?.marketOpen !== true) accountIssues.push("Regular trading session is not verified open");
  if (account?.ordersClear !== true) accountIssues.push("Pending orders or reconciliation are not cleared");
  if (!Array.isArray(positions) || positions.some(pos => !/^[A-Z][A-Z0-9.-]{0,9}$/.test(pos.symbol ?? "") || !positive(pos.quantity) || !positive(pos.averageCost) || !positive(pos.value)
    || typeof pos.holdingId !== "string" || !pos.holdingId || !Number.isFinite(Date.parse(pos.openedAt)))
    || new Set(positions.map(pos => pos.symbol)).size !== positions.length) accountIssues.push("Holdings snapshot is incomplete");
  if (accountIssues.length) return { orders, rejects, blocked: accountIssues, entriesHalted: true };
  let cash = account.cash, count = positions.length;
  const daily = typeof account.dailyPnl === "number" && Number.isFinite(account.dailyPnl) ? account.dailyPnl / account.equity * 100 : null;
  const weekly = typeof account.weeklyPnl === "number" && Number.isFinite(account.weeklyPnl) ? account.weeklyPnl / account.equity * 100 : null;
  let entriesHalted = daily === null || weekly === null || daily <= -policy.dailyLossPercent || weekly <= -policy.weeklyLossPercent;
  const sold = new Set();
  for (const pos of positions) {
    const market = markets.find(row => row.symbol === pos.symbol);
    if (!market || !positive(market.bid) || !positive(market.ask) || market.bid > market.ask || !fresh(market.quoteAt, now)) { entriesHalted = true; rejects.push({ symbol: pos.symbol, reason: "Stop check lacks a fresh executable quote" }); continue; }
    const gain = market.bid / pos.averageCost - 1;
    const thesis = theses.find(row => row.symbol === pos.symbol);
    let quantity = 0, reason, tiers = [];
    if (gain <= -policy.stopLossPercent / 100) { quantity = pos.quantity; reason = "stop_loss"; }
    else {
      const fired = ledger.filter(row => row.symbol === pos.symbol && row.holdingId === pos.holdingId && row.status === "filled").flatMap(row => row.tiers ?? []);
      let remaining = pos.quantity;
      for (const [index, threshold] of [0.15, 0.30, 0.50].entries()) if (gain >= threshold && !fired.includes(index)) {
        const part = remaining * 0.25; quantity += part; remaining -= part; tiers.push(index);
      }
      if (quantity > 0) reason = "take_profit";
      else if (thesis?.direction === "exit_existing" && thesis.critic === "pass" && Date.parse(thesis.newFactAt) > Date.parse(pos.openedAt)
        && Date.parse(thesis.newFactAt) <= now.valueOf()) { quantity = pos.quantity; reason = "new_fact_exit"; }
    }
    if (quantity > 0) { sold.add(pos.symbol); orders.push({ symbol: pos.symbol, side: "sell", quantity: Math.floor(quantity * 1e6) / 1e6,
      limitPrice: market.bid, notional: round(quantity * market.bid), holdingId: pos.holdingId, tiers, reason, quoteAt: market.quoteAt }); }
  }
  // Cash from proposed sells is never credited before a confirmed fill.
  const rank = { high: 0, medium: 1, low: 2 };
  const candidates = theses.filter(row => row.direction === "long").sort((a, b) => rank[a.conviction] - rank[b.conviction]
    || a.riskFlags.length - b.riskFlags.length || a.symbol.localeCompare(b.symbol));
  for (const thesis of candidates) {
    const market = markets.find(row => row.symbol === thesis.symbol), reasons = [];
    if (entriesHalted) reasons.push("Daily/weekly loss limit or risk evidence halt");
    if (!policy.symbols.includes(thesis.symbol) || thesis.critic !== "pass") reasons.push("Allowlist or independent review");
    if (positions.some(pos => pos.symbol === thesis.symbol) || sold.has(thesis.symbol)) reasons.push("Already held or sold this cycle");
    if (!market || !screenMarket(market).pass || !fresh(market?.quoteAt, now)) reasons.push("Market quality or quote freshness");
    if (!positive(market?.bid) || !positive(market?.ask) || market.bid > market.ask || (market.ask - market.bid) / market.ask * 100 > policy.maxSpreadPercent) reasons.push("Executable spread");
    if (!positive(thesis.thesisPrice) || (market?.ask / thesis.thesisPrice - 1) * 100 > policy.maxEntryGapPercent) reasons.push("Entry price gap");
    const average = market?.closes?.slice(-20).reduce((sum, value) => sum + value, 0) / 20;
    if (!positive(average) || (market?.ask / average - 1) * 100 > policy.maxExtensionPercent) reasons.push("Extension above 20-day average");
    if (market?.earningsKnown !== true || (market.earningsDays !== null && (!Number.isInteger(market.earningsDays) || market.earningsDays <= policy.earningsBlackoutDays))) reasons.push("Earnings blackout or unknown calendar");
    if (market?.lossHistoryComplete !== true || (market.lossSaleDays !== null && (!Number.isInteger(market.lossSaleDays) || market.lossSaleDays <= 30))) reasons.push("Recent loss sale or incomplete linked-account history");
    const lastSell = ledger.find(row => row.symbol === thesis.symbol && row.side === "sell" && row.status === "filled");
    if (lastSell && (now.valueOf() - Date.parse(lastSell.at) < 30 * 86_400_000 || market?.ask >= lastSell.limitPrice)) reasons.push("Sell re-entry lock");
    if (count >= policy.maxPositions) reasons.push("Position count");
    const fraction = { high: 1, medium: 0.6, low: 0.3 }[thesis.conviction] ?? 0;
    const budget = Math.min(policy.orderBudgetUsd * fraction, account.equity * policy.maxPositionPercent / 100);
    if (cash - budget < account.equity * policy.cashBufferPercent / 100) reasons.push("Cash buffer");
    if (reasons.length) { rejects.push({ symbol: thesis.symbol, reason: reasons.join("; ") }); continue; }
    const quantity = Math.floor(budget / market.ask * 1e6) / 1e6;
    if (!(quantity > 0)) continue;
    orders.push({ symbol: thesis.symbol, side: "buy", quantity, limitPrice: market.ask, notional: round(quantity * market.ask),
      reason: `thesis_${thesis.conviction}`, tiers: [], quoteAt: market.quoteAt }); cash -= budget; count++;
  }
  return { orders, rejects, blocked: [], entriesHalted, cashReservedAfter: round(cash), dailyPercent: daily, weeklyPercent: weekly };
}
