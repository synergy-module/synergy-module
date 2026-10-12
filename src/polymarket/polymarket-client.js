const ORIGINS = Object.freeze({ gamma: "https://gamma-api.polymarket.com", clob: "https://clob.polymarket.com", data: "https://data-api.polymarket.com" });
export const polyError = (code, message, status = 422) => Object.assign(new Error(message), { code, status });
export const decimal = (value) => (typeof value === "number" || (typeof value === "string" && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))) && Number.isFinite(Number(value)) ? Number(value) : null;
const list = (value) => { try { const result = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(result) ? result : []; } catch { return []; } };
const text = (value, max = 300) => typeof value === "string" ? value.slice(0, max) : "";
const price = (value) => { const n = decimal(value); return n !== null && n >= 0 && n <= 1 ? n : null; };
export const validMarketId = (id) => typeof id === "string" && /^\d{1,20}$/.test(id);
export const validAddress = (address) => typeof address === "string" && /^0x[\da-f]{40}$/i.test(address);

export function normalizeMarket(raw, fetchedAt) {
  if (!validMarketId(String(raw?.id)) || !raw.question) return null;
  const outcomes = list(raw.outcomes), prices = list(raw.outcomePrices);
  const ids = list(raw.version === "v2" ? raw.positionIds : raw.clobTokenIds);
  if (outcomes.length !== 2 || ids.length !== 2 || prices.length !== 2
    || ids.some(id => typeof id !== "string" || !/^\d{1,100}$/.test(id))
    || prices.some(p => price(p) === null)) return null;
  const schedule = raw.feeSchedule;
  const feeRate = raw.feesEnabled === false ? 0 : decimal(schedule?.rate);
  const feeExponent = raw.feesEnabled === false ? 1 : decimal(schedule?.exponent);
  return {
    id: String(raw.id), conditionId: text(raw.conditionId, 100), question: text(raw.question),
    slug: text(raw.slug), eventId: String(raw.events?.[0]?.id ?? raw.id),
    url: `https://polymarket.com/event/${encodeURIComponent(raw.events?.[0]?.slug || raw.slug || "")}`,
    image: /^https:\/\/(polymarket-upload\.s3\.us-east-2\.amazonaws\.com|images\.polymarket\.com)\//.test(raw.image ?? "") ? raw.image : null,
    description: text(raw.description, 6000), resolutionSource: text(raw.resolutionSource, 500),
    active: raw.active === true && raw.closed === false && raw.acceptingOrders === true && raw.enableOrderBook === true,
    outcomes: outcomes.map((label, i) => ({ label: text(label, 100), price: price(prices[i]), tokenId: ids[i] })),
    volume24h: Math.max(0, decimal(raw.volume24hr) ?? 0), liquidity: Math.max(0, decimal(raw.liquidityNum ?? raw.liquidity) ?? 0),
    endDate: Number.isFinite(Date.parse(raw.endDate)) ? new Date(raw.endDate).toISOString() : null,
    change24h: decimal(raw.oneDayPriceChange), bestBid: price(raw.bestBid), bestAsk: price(raw.bestAsk),
    fee: feeRate !== null && feeRate >= 0 && feeRate <= 1 && feeExponent !== null && feeExponent >= 0 && feeExponent <= 5
      ? { rate: feeRate, exponent: feeExponent } : null,
    version: raw.version === "v2" ? "v2" : "v1", fetchedAt,
  };
}

export function normalizeBook(raw, tokenId, fetchedAt) {
  if (raw?.asset_id !== tokenId || !Array.isArray(raw.bids) || !Array.isArray(raw.asks)) {
    throw polyError("POLY_DATA_INVALID", "The outcome order book could not be verified.", 502);
  }
  const levels = (rows, descending) => rows.map(row => ({ price: price(row.price), size: decimal(row.size) }))
    .filter(row => row.price > 0 && row.price < 1 && row.size > 0).sort((a, b) => descending ? b.price - a.price : a.price - b.price).slice(0, 300);
  const timestamp = decimal(raw.timestamp);
  return { tokenId, bids: levels(raw.bids, true), asks: levels(raw.asks, false),
    minOrderSize: decimal(raw.min_order_size), fetchedAt,
    timestamp: timestamp !== null && Number.isFinite(new Date(timestamp).valueOf()) ? new Date(timestamp).toISOString() : null };
}

export function createPolymarketClient({ fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 8000, cacheMs = 60_000 } = {}) {
  const cache = new Map(), pending = new Map();
  async function read(origin, pathname, params = {}) {
    const url = new URL(pathname, ORIGINS[origin]);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(url, { signal, headers: { Accept: "application/json" }, redirect: "error" });
      if (!response.ok) throw polyError("POLY_UPSTREAM", response.status === 429
        ? "Polymarket is rate limiting requests. Wait a minute before retrying."
        : "Polymarket data is temporarily unavailable.", 503);
      const reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 2_000_000) { await reader.cancel(); throw polyError("POLY_DATA_INVALID", "Polymarket returned an oversized response.", 502); }
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error.code?.startsWith("POLY_")) throw error;
      throw polyError("POLY_UPSTREAM", "Polymarket data could not be fetched. Retry shortly.", 503);
    }
  }
  async function cached(key, fetchValue) {
    const previous = cache.get(key);
    if (previous && now().valueOf() - previous.time < cacheMs) return structuredClone(previous.value);
    if (!pending.has(key)) {
      const task = fetchValue().then(value => {
        cache.set(key, { time: now().valueOf(), value });
        if (cache.size > 40) cache.delete(cache.keys().next().value);
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, task);
    }
    return structuredClone(await pending.get(key));
  }
  const api = {
    markets: () => cached("markets", async () => {
      const raw = await read("gamma", "/markets", { active: true, closed: false, limit: 100, order: "volume24hr", ascending: false });
      if (!Array.isArray(raw)) throw polyError("POLY_DATA_INVALID", "The market feed has an unexpected format.", 502);
      const fetchedAt = now().toISOString();
      return { markets: raw.map(row => normalizeMarket(row, fetchedAt)).filter(row => row?.active), fetchedAt, source: ORIGINS.gamma };
    }),
    async market(id) {
      if (!validMarketId(id)) throw polyError("POLY_INPUT", "Choose a valid market.");
      const raw = await read("gamma", `/markets/${id}`);
      const market = normalizeMarket(raw, now().toISOString());
      if (!market || market.id !== id) throw polyError("POLY_NOT_FOUND", "This binary market is unavailable.", 404);
      return market;
    },
    async book(tokenId) {
      if (typeof tokenId !== "string" || !/^\d{1,100}$/.test(tokenId)) throw polyError("POLY_INPUT", "Invalid outcome identifier.");
      return normalizeBook(await read("clob", "/book", { token_id: tokenId }), tokenId, now().toISOString());
    },
    trades: ({ conditionId, address } = {}) => cached(`trades:${conditionId ?? address ?? "global"}`, async () => {
      if (conditionId && !/^0x[\da-f]{64}$/i.test(conditionId)) throw polyError("POLY_INPUT", "Invalid market condition.");
      if (address && !validAddress(address)) throw polyError("POLY_INPUT", "Enter a public wallet address.");
      const response = await read("data", "/v2/trades", { limit: 100, taker_only: true,
        ...(conditionId ? { condition: conditionId } : {}), ...(address ? { user: address } : {}) });
      if (!Array.isArray(response?.data)) throw polyError("POLY_DATA_INVALID", "The activity feed has an unexpected format.", 502);
      return { fetchedAt: now().toISOString(), source: `${ORIGINS.data}/v2/trades`, sampled: true,
        trades: response.data.filter(row => validAddress(row.proxy_wallet) && ["BUY", "SELL"].includes(row.side)
          && (!address || row.proxy_wallet.toLowerCase() === address.toLowerCase()) && (!conditionId || row.condition_id === conditionId)
          && price(row.price) !== null && decimal(row.size) > 0 && Number.isFinite(new Date(Number(row.timestamp) * 1000).valueOf()))
          .map(row => ({ address: row.proxy_wallet.toLowerCase(), name: text(row.name || row.pseudonym, 80), side: row.side,
            tokenId: text(row.token_id, 100), conditionId: text(row.condition_id, 100), outcome: text(row.outcome, 100),
            title: text(row.title), price: Number(row.price), shares: Number(row.size), notional: Number(row.price) * Number(row.size),
            timestamp: new Date(Number(row.timestamp) * 1000).toISOString(), transaction: text(row.transaction_hash, 100) })) };
    }),
    leaderboard: () => cached("leaderboard", async () => {
      const response = await read("data", "/v2/leaderboard", { time_period: "month", category: "overall", sort_by: "PNL", limit: 15 });
      if (!Array.isArray(response?.data)) throw polyError("POLY_DATA_INVALID", "The leaderboard has an unexpected format.", 502);
      return { fetchedAt: now().toISOString(), period: "month", source: `${ORIGINS.data}/v2/leaderboard`,
        traders: response.data.filter(row => validAddress(row.user_id) && decimal(row.pnl) !== null && decimal(row.volume) !== null)
          .map(row => ({ address: row.user_id.toLowerCase(), name: text(row.user_name, 80), rank: decimal(row.rank),
            pnl: Number(row.pnl), volumeShares: Number(row.volume) })) };
    }),
  };
  return api;
}
