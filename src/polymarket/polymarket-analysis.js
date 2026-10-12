export const round = (value) => Math.round((value + Number.EPSILON) * 100000) / 100000;
export function isFresh(book, now) {
  const ages = [book?.timestamp, book?.fetchedAt].map(value => now.valueOf() - Date.parse(value));
  return ages.every(age => Number.isFinite(age) && age >= -5000 && age <= 120_000);
}

export function analyzeMarket(market, books, activity, notes, now = new Date()) {
  const leader = market.outcomes[1].price > market.outcomes[0].price ? 1 : 0;
  const book = books[leader], outcome = market.outcomes[leader];
  const bid = book?.bids[0]?.price ?? null, ask = book?.asks[0]?.price ?? null;
  const spread = bid !== null && ask !== null ? ask - bid : null;
  const depth = book?.asks.filter(row => row.price <= (ask ?? 0) + 0.01).reduce((sum, row) => sum + row.price * row.size, 0) ?? 0;
  const recent = activity?.trades?.filter(trade => trade.tokenId === outcome.tokenId
    && now.valueOf() - Date.parse(trade.timestamp) >= 0 && now.valueOf() - Date.parse(trade.timestamp) <= 3_600_000) ?? [];
  const netFlow = recent.reduce((sum, trade) => sum + (trade.side === "BUY" ? 1 : -1) * trade.notional, 0);
  const days = (Date.parse(market.endDate) - now.valueOf()) / 86_400_000;
  const gates = [
    { name: "Open market", pass: market.active, detail: "Active, accepting orders, with an order book" },
    { name: "Fresh book", pass: isFresh(book, now), detail: "Order book and retrieval no older than two minutes" },
    { name: "Probability band", pass: outcome.price >= 0.65 && outcome.price <= 0.96, detail: "Leading outcome between 65% and 96%" },
    { name: "Liquidity", pass: market.liquidity >= 10000 && depth >= 100, detail: "$10,000 liquidity and $100 ask depth within 1 cent" },
    { name: "Spread", pass: spread !== null && spread >= 0 && spread <= 0.02, detail: "Executable spread no wider than 2 cents" },
    { name: "Scheduled end", pass: days > 0 && days <= 14, detail: "Scheduled end within 14 days; actual resolution can differ" },
    { name: "Anti-chasing", pass: market.change24h !== null && Math.abs(market.change24h) < 0.08, detail: "24-hour price change below 8 percentage points" },
    { name: "Observed flow", pass: netFlow >= 500, detail: "$500 net buying in the sampled last-hour taker activity" },
    { name: "Known fees", pass: market.fee !== null, detail: "Published fee schedule or explicitly fee-free market" },
  ];
  const wallets = new Map();
  for (const trade of recent) wallets.set(trade.address, (wallets.get(trade.address) ?? 0) + (trade.side === "BUY" ? 1 : -1) * trade.notional);
  const buyers = [...wallets].filter(([, value]) => value >= 1000).map(([address, netUsd]) => ({ address, netUsd: round(netUsd) }));
  const common = new Set(["the", "and", "for", "with", "will", "before", "after", "this", "that", "from", "have", "does", "not", "are", "was"]);
  const tokens = new Set((market.question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(word => !common.has(word)));
  const related = notes.filter(note => note.marketId === market.id || (note.text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).some(word => tokens.has(word))).slice(0, 5);
  const eligible = gates.every(gate => gate.pass);
  return { marketId: market.id, outcomeIndex: leader, outcome: outcome.label, eligible, score: Math.round(gates.filter(gate => gate.pass).length / gates.length * 100),
    gates, spread: spread === null ? null : round(spread), depthUsd: round(depth), netFlowUsd: round(netFlow), buyers, relatedNotes: related,
    summary: eligible ? "All screening checks passed. A paper entry still requires fresh depth and portfolio risk checks."
      : `Watch only: ${gates.filter(gate => !gate.pass).map(gate => gate.name.toLowerCase()).join(", ")}.`,
    caveats: ["Market prices are implied probabilities, not an independent forecast.", "Flow is a sample of up to 100 taker fills, not complete market activity.",
      "Multiple buyers show shared activity; they do not establish coordination or an edge.", "Read resolution rules before relying on the scheduled end."],
    fetchedAt: now.toISOString() };
}

// Walk executable levels. Fees are reserved as cash costs for this paper model.
export function simulateFill({ book, fee, side, budget, shares, slippageBps, now = new Date() }) {
  if (!isFresh(book, now) || !fee) throw new Error("Fresh depth and a verified fee schedule are required.");
  const levels = side === "BUY" ? book.asks : book.bids;
  if (!levels.length || (book.bids.length && book.asks.length && book.bids[0].price > book.asks[0].price)) throw new Error("Executable order-book depth is unavailable.");
  const best = levels[0].price;
  let remaining = side === "BUY" ? budget : shares, quantity = 0, notional = 0, fees = 0;
  for (const level of levels) {
    const slip = Math.abs(level.price - best) / best * 10000;
    if (slip > slippageBps) break;
    const perShareFee = fee.rate * (level.price * (1 - level.price)) ** fee.exponent;
    const take = Math.min(level.size, side === "BUY" ? remaining / (level.price + perShareFee) : remaining);
    quantity += take; notional += take * level.price; fees += take * perShareFee;
    remaining -= side === "BUY" ? take * (level.price + perShareFee) : take;
    if (remaining <= 0.000001) break;
  }
  if (quantity <= 0 || quantity < (book.minOrderSize ?? Infinity)) throw new Error("Depth within the slippage limit is below the market minimum size.");
  if (side === "SELL" && remaining > 0.00001) throw new Error("Not enough bid depth to close this paper position within the slippage limit.");
  return { shares: round(quantity), notional: round(notional), fee: round(fees), price: round(notional / quantity),
    cashChange: round(side === "BUY" ? -(notional + fees) : notional - fees), partial: side === "BUY" && remaining > 0.01 };
}
