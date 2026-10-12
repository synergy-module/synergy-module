import { createPolymarketClient } from "../../src/polymarket/polymarket-client.js";

export const POLY_NOW = new Date("2026-10-12T15:30:00Z");
export const POLY_ADDRESS = "0x" + "a".repeat(40);
export const POLY_CONDITION = "0x" + "b".repeat(64);
export function rawPolyMarket(overrides = {}) {
  return { id: "123", question: "Will the test event conclude before October 20?", slug: "test-event", active: true, closed: false,
    acceptingOrders: true, enableOrderBook: true, conditionId: POLY_CONDITION, description: "Resolves Alpha only after an official result.",
    outcomes: '["Alpha","Beta"]', outcomePrices: '["0.8","0.2"]', clobTokenIds: '["111","222"]', feesEnabled: false,
    volume24hr: 150000, liquidityNum: 50000, endDate: "2026-10-20T15:30:00Z", oneDayPriceChange: 0.01,
    bestBid: 0.795, bestAsk: 0.805, ...overrides };
}
export function rawPolyBook(tokenId = "111", overrides = {}) {
  const leader = tokenId === "111";
  return { asset_id: tokenId, timestamp: String(POLY_NOW.valueOf()), min_order_size: "5",
    bids: [{ price: leader ? "0.795" : "0.195", size: "1000" }], asks: [{ price: leader ? "0.805" : "0.205", size: "1000" }], ...overrides };
}
export function rawPolyTrade(overrides = {}) {
  return { proxy_wallet: POLY_ADDRESS, side: "BUY", token_id: "111", condition_id: POLY_CONDITION,
    size: 1000, price: 0.8, timestamp: POLY_NOW.valueOf() / 1000, outcome: "Alpha", title: "Test event", ...overrides };
}
export function polyFixture({ now = () => POLY_NOW, market = rawPolyMarket(), book = token => rawPolyBook(token), trades = [rawPolyTrade()], beforeFetch } = {}) {
  const calls = [];
  const client = createPolymarketClient({ now, fetchImpl: async (input, options) => {
    const url = new URL(input); calls.push({ url, options }); await beforeFetch?.(url);
    if (url.pathname === "/markets") return Response.json([market]);
    if (url.pathname.startsWith("/markets/")) return Response.json(market);
    if (url.pathname === "/book") return Response.json(book(url.searchParams.get("token_id")));
    if (url.pathname === "/v2/trades") return Response.json({ data: trades, pagination: { next_cursor: null } });
    if (url.pathname === "/v2/leaderboard") return Response.json({ data: [{ user_id: POLY_ADDRESS, user_name: "Fixture trader", rank: 1, pnl: 200, volume: 1200 }] });
    throw new Error("Unexpected fixture URL");
  } });
  return { client, calls };
}
export function manualPolyTimers() {
  const tasks = [];
  return { tasks, setTimer: (callback, delay) => { const task = { callback, delay, cleared: false, unref() {} }; tasks.push(task); return task; },
    clearTimer: task => { if (task) task.cleared = true; }, tick: async () => { const task = tasks.find(task => !task.cleared && !task.used); if (!task) throw new Error("No scheduled cycle"); task.used = true; await task.callback(); } };
}
