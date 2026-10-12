import test from "node:test";
import assert from "node:assert/strict";
import { createPracticeMarketData } from "../../src/practice/market-data.js";

const NOW = new Date("2026-10-12T12:00:00Z");
const client = handler => createPracticeMarketData({ now: () => NOW, fetchImpl: async (url, options) => {
  assert.equal(options.method, "GET"); assert.equal(options.redirect, "error"); assert.equal(options.headers.Authorization, undefined);
  return Response.json(await handler(new URL(url), options));
} });

test("market adapters refuse arbitrary destinations and malformed symbols", async () => {
  let calls = 0; const api = client(() => { calls++; return {}; });
  await assert.rejects(api.quote({ source: "binance", instrument: "https://private.internal" }), { code: "PRACTICE_INVALID" });
  assert.equal(api.history, undefined);
  await assert.rejects(api.solana({ address: "../../private" }), { code: "PRACTICE_INVALID" });
  assert.equal(calls, 0);
});

test("DexScreener indicative prices never fabricate bid, ask or token safety evidence", async () => {
  const mint = "So11111111111111111111111111111111111111112";
  const api = client(() => [{ chainId: "solana", baseToken: { address: mint }, priceUsd: "2", liquidity: { usd: 100000 },
    pairCreatedAt: NOW.valueOf() - 3600000, priceChange: { m5: 10 }, txns: { m5: { buys: 30, sells: 10 } } }]);
  const result = await api.solana({ address: mint });
  assert.equal(result.price, 2); assert.equal(result.bid, null); assert.equal(result.ask, null); assert.equal(result.liquidity, null);
  assert.equal(result.signals.poolLiquidity, 100000); assert.equal(result.signals.security, null);
});

test("Polymarket quotes cap simulated depth at executable top levels and retain market liquidity separately", async () => {
  const api = createPracticeMarketData({ now: () => NOW, polymarketClient: {
    async market() { return { id: "1", conditionId: "condition", outcomes: [{ tokenId: "111", label: "Up", price: 0.6 }, { tokenId: "222", label: "Down", price: 0.35 }], liquidity: 20000, fee: { rate: 0, exponent: 1 }, endDate: "2026-10-13T00:00:00Z", fetchedAt: NOW.toISOString() }; },
    async book(id) { const ask = id === "111" ? 0.6 : 0.35; return { tokenId: id, timestamp: NOW.toISOString(), fetchedAt: NOW.toISOString(), asks: [{ price: ask, size: 100 }], bids: [{ price: ask - 0.01, size: 100 }], minOrderSize: 5 }; },
    async trades() { return { trades: [] }; },
  } });
  const result = await api.quote({ source: "polymarket", marketId: "1" });
  assert.equal(result.liquidity, 59); assert.equal(result.signals.marketLiquidity, 20000);
  assert.equal(result.signals.pair[0].liquidity, 60);
  assert.equal(result.signals.pair[0].snapshotId, result.signals.pair[1].snapshotId);
});

test("public response failures never expose upstream response content", async () => {
  const api = createPracticeMarketData({ fetchImpl: async () => new Response("upstream-private-detail", { status: 429 }) });
  await assert.rejects(api.quote({ source: "binance", instrument: "BTCUSDT" }), error => error.status === 503 && !error.message.includes("private-detail"));
});

test("closed prediction markets settle each matched outcome only from an explicit provider winner", async () => {
  const condition = `0x${"a".repeat(64)}`; let winner = true, closed = true;
  const api = createPracticeMarketData({ now: () => NOW, polymarketClient: { async market() { return { id: "1", conditionId: condition, active: false, endDate: "2026-10-11T00:00:00Z", outcomes: [{ tokenId: "111", label: "Up" }, { tokenId: "222", label: "Down" }] }; }, async book() { throw new Error("Closed books must not be read for a settlement"); } },
    fetchImpl: async url => { if (String(url) === `https://data-api.polymarket.com/v2/resolutions?condition=${condition}`) return Response.json({ data: [] }); assert.equal(String(url), `https://clob.polymarket.com/markets/${condition}`); return Response.json({ condition_id: condition, closed, accepting_orders: false,
      tokens: [{ token_id: "111", outcome: "Up", winner, price: 1 }, { token_id: "222", outcome: "Down", winner: false, price: 0 }] }); } });
  const up = await api.quote({ source: "polymarket", marketId: "1", instrument: "POLY:111" });
  const down = await api.quote({ source: "polymarket", marketId: "1", instrument: "POLY:222", outcomeIndex: 0 });
  assert.equal(up.settlement.payout, 1); assert.equal(down.settlement.payout, 0); assert.equal(down.instrument, "POLY:222"); assert.equal(down.liquidity, 0);
  winner = false; assert.equal(await api.settlement({ marketId: "1", instrument: "POLY:111" }), null);
  winner = true; closed = false; assert.equal(await api.settlement({ marketId: "1", instrument: "POLY:111" }), null);
  await assert.rejects(api.quote({ source: "polymarket", marketId: "1", instrument: "POLY:999" }), /does not belong/);
});

test("crypto model uses closed returns, labels its proxy and refuses final-window spot extrapolation", async () => {
  const api = client(url => {
    if (url.pathname.endsWith("bookTicker")) return { symbol: "BTCUSDT", bidPrice: "100", askPrice: "100.1", bidQty: "100", askQty: "100" };
    if (url.searchParams.get("limit") === "1") return [[Number(url.searchParams.get("startTime")), "100", "101", "99", "100.1", "10", NOW.valueOf() + 1000]];
    return Array.from({ length: 30 }, (_, i) => [NOW.valueOf() - (30 - i) * 60000, "100", "101", "99", String(100 + Math.sin(i) / 10), "10", NOW.valueOf() - (29 - i) * 60000 - 1]);
  });
  const result = await api.cryptoModel({ asset: "BTC", windowOpenedAt: "2026-10-12T11:59:00Z", windowEndsAt: "2026-10-12T12:04:00Z" });
  assert.equal(result.referenceIsProxy, true); assert.ok(result.fairProbability > 0 && result.fairProbability < 1); assert.equal(result.sourceCount, 30);
  await assert.rejects(api.cryptoModel({ asset: "BTC", windowOpenedAt: "2026-10-12T11:55:30Z", windowEndsAt: "2026-10-12T12:00:30Z" }), /recorded oracle ticks/);
  const referenceTicks = [{ symbol: "btcusd", channel: "price.crypto", timestamp: NOW.toISOString(), availableAt: NOW.toISOString(), value: 100.05 },
    { symbol: "btcusd", channel: "price.crypto.twap", windowSeconds: 60, timestamp: "2026-10-12T11:59:00Z", availableAt: "2026-10-12T11:59:00Z", value: 100.01 }];
  const recorded = await api.cryptoModel({ asset: "BTC", windowOpenedAt: "2026-10-12T11:59:00Z", windowEndsAt: "2026-10-12T12:04:00Z", referenceTicks });
  assert.equal(recorded.openPrice, 100.01); assert.equal(recorded.referenceIsProxy, false);
  await assert.rejects(api.cryptoModel({ asset: "BTC", windowOpenedAt: "2026-10-12T11:59:00Z", windowEndsAt: "2026-10-12T12:04:00Z", referenceTicks: referenceTicks.slice(0, 1) }), /exact opening 60-second TWAP/);
});

test("weather ensemble reads a fixed provider and retains distinct dated members", async () => {
  const api = client(url => {
    assert.equal(url.origin, "https://ensemble-api.open-meteo.com"); assert.equal(url.pathname, "/v1/ensemble"); assert.equal(url.searchParams.get("models"), "ecmwf_ifs025");
    return { daily: { time: ["2026-10-13"], temperature_2m_max: [21], ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`temperature_2m_max_member${String(i + 1).padStart(2, "0")}`, [20 + i / 20]])) } };
  });
  const result = await api.weatherEnsemble({ latitude: 40.78, longitude: -73.97, station: "KNYC", date: "2026-10-13", timezone: "America/New_York" });
  assert.equal(result.members.length, 51); assert.equal(result.observedAt, NOW.toISOString()); assert.equal(result.units, "celsius");
});

test("crypto rolling discovery requires exact active provider slug, time and outcome", async () => {
  let valid = true;
  const api = client(url => { assert.equal(url.origin, "https://gamma-api.polymarket.com"); assert.equal(url.searchParams.get("slug"), "btc-updown-5m-1791806400");
    return [{ id: "123", slug: valid ? url.searchParams.get("slug") : "unrelated", question: "Bitcoin Up or Down", outcomes: '["Up","Down"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: '["111","222"]',
      endDate: "2026-10-12T12:05:00Z", active: true, closed: false, acceptingOrders: true, enableOrderBook: true }]; });
  const result = await api.cryptoWindow({ asset: "BTC", windowMinutes: 5, outcome: "Down" }); assert.equal(result.instrument, "POLY:222"); assert.equal(result.outcomeIndex, 1);
  valid = false; await assert.rejects(api.cryptoWindow({ asset: "BTC", windowMinutes: 5, outcome: "Down" }), /not open at the provider/);
});

test("Solana scanner exposes provider gaps as unavailable checks and never enables execution", async () => {
  const mint = "So11111111111111111111111111111111111111112";
  const api = createPracticeMarketData({ now: () => NOW, fetchImpl: async (url, options) => {
    if (options.method === "POST") throw new Error("public RPC rate limited");
    return Response.json([{ chainId: "solana", baseToken: { address: mint }, priceUsd: "2", liquidity: { usd: 30000 }, pairCreatedAt: NOW.valueOf() - 3600000, priceChange: { m5: 10 }, txns: { m5: { buys: 30, sells: 10 } } }]);
  } });
  const result = await api.scanSolana({ address: mint }); assert.equal(result.executionReady, false);
  assert.equal(result.checks.find(row => row.id === "liquidity").status, "pass"); assert.equal(result.checks.find(row => row.id === "mint").status, "unavailable"); assert.equal(result.checks.find(row => row.id === "execution").status, "unavailable");
});

test("wallet market lookup binds both the public condition and exact token at a fixed provider", async () => {
  const conditionId = `0x${"b".repeat(64)}`;
  const api = client(url => { assert.equal(url.origin, "https://gamma-api.polymarket.com"); assert.equal(url.searchParams.get("condition_ids"), conditionId);
    return [{ id: "9", conditionId, question: "A current binary market", outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: '["111","222"]',
      endDate: "2026-10-13T12:00:00Z", active: true, closed: false, acceptingOrders: true, enableOrderBook: true }]; });
  const result = await api.marketForOutcome({ conditionId, instrument: "POLY:222" }); assert.equal(result.outcomeIndex, 1); assert.equal(result.marketId, "9");
  await assert.rejects(api.marketForOutcome({ conditionId, instrument: "POLY:999" }), { status: 404 });
  await assert.rejects(api.marketForOutcome({ conditionId: "https://private.example", instrument: "POLY:222" }), { status: 422 });
});

test("official resolution payout vectors settle both sides including fractional payouts without stale CLOB prices", async () => {
  const condition = `0x${"c".repeat(64)}`; let payouts = [0, 1000000], status = "resolved", resolvedAt = "2026-10-12T11:59:00Z", selectedCondition = condition;
  const api = createPracticeMarketData({ now: () => NOW, polymarketClient: { async market() { return { id: "1", conditionId: condition, active: false, endDate: "2026-10-12T11:55:00Z", outcomes: [{ tokenId: "111", label: "Yes" }, { tokenId: "222", label: "No" }] }; } },
    fetchImpl: async url => { assert.equal(String(url), `https://data-api.polymarket.com/v2/resolutions?condition=${condition}`); return Response.json({ data: [{ condition_id: selectedCondition, status, extended_review: false, resolved_at: resolvedAt, payouts }] }); } });
  assert.equal((await api.settlement({ marketId: "1", outcomeIndex: 0 })).settlement.payout, 0);
  assert.equal((await api.settlement({ marketId: "1", outcomeIndex: 1 })).settlement.payout, 1);
  payouts = [500000, 500000]; assert.equal((await api.settlement({ marketId: "1", outcomeIndex: 0 })).settlement.payout, 0.5);
  payouts = [1, 1]; assert.equal(await api.settlement({ marketId: "1" }), null);
  payouts = [0, 1000000]; status = "proposed"; assert.equal(await api.settlement({ marketId: "1" }), null);
  status = "resolved"; resolvedAt = "2026-10-13T00:00:00Z"; assert.equal(await api.settlement({ marketId: "1" }), null);
});
