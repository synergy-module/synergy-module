import test from "node:test";
import assert from "node:assert/strict";
import { createPolymarketClient, normalizeMarket, normalizeBook } from "../../src/polymarket/polymarket-client.js";
import { POLY_NOW, POLY_ADDRESS, rawPolyMarket, rawPolyBook, polyFixture } from "../helpers/polymarket-test-helpers.js";

test("Gamma keeps named outcomes aligned and selects V2 position identifiers", () => {
  const result = normalizeMarket(rawPolyMarket({ version: "v2", positionIds: ["333", "444"], clobTokenIds: null }), POLY_NOW.toISOString());
  assert.equal(result.outcomes[0].label, "Alpha"); assert.equal(result.outcomes[0].tokenId, "333");
  assert.equal(result.fee.rate, 0); assert.equal(result.active, true);
  assert.equal(normalizeMarket(rawPolyMarket({ outcomePrices: '[null,"0.2"]' }), POLY_NOW.toISOString()), null);
  assert.equal(normalizeMarket(rawPolyMarket({ clobTokenIds: '[111,222]' }), POLY_NOW.toISOString()), null);
  assert.equal(normalizeMarket(rawPolyMarket({ closed: true }), POLY_NOW.toISOString()).active, false);
  assert.equal(normalizeMarket(rawPolyMarket({ feesEnabled: true }), POLY_NOW.toISOString()).fee, null);
});

test("books sort executable levels and reject a response for a different outcome", () => {
  const result = normalizeBook(rawPolyBook("111", { bids: [{ price: "0.1", size: "500" }, { price: "0.8", size: "30" }],
    asks: [{ price: "0.99", size: "200" }, { price: "0.81", size: "15" }] }), "111", POLY_NOW.toISOString());
  assert.equal(result.bids[0].price, 0.8); assert.equal(result.asks[0].price, 0.81);
  assert.throws(() => normalizeBook(rawPolyBook("222"), "111", POLY_NOW.toISOString()), { code: "POLY_DATA_INVALID" });
});

test("data reads use V2 envelopes and distinguish shares from dollar notional", async () => {
  const { client, calls } = polyFixture();
  const activity = await client.trades({ address: POLY_ADDRESS });
  assert.equal(activity.trades[0].notional, 800); assert.equal(activity.trades[0].shares, 1000);
  const board = await client.leaderboard(); assert.equal(board.traders[0].volumeShares, 1200);
  assert.equal(calls[0].url.pathname, "/v2/trades");
  await assert.rejects(client.trades({ address: "https://untrusted.test" }), { code: "POLY_INPUT" });
});

test("market refresh uses bounded caching and shares concurrent requests", async () => {
  const { client, calls } = polyFixture();
  const results = await Promise.all([client.markets(), client.markets()]);
  assert.equal(calls.length, 1); results[0].markets[0].question = "mutated";
  assert.notEqual((await client.markets()).markets[0].question, "mutated");
  assert.equal(calls[0].url.searchParams.get("limit"), "100");
});

test("HTTP failures and malformed feeds are explicit errors without exposing upstream content", async () => {
  const client = createPolymarketClient({ fetchImpl: async () => new Response("upstream-private-detail", { status: 429 }) });
  await assert.rejects(client.markets(), error => error.code === "POLY_UPSTREAM" && !error.message.includes("private-detail"));
  const bad = createPolymarketClient({ fetchImpl: async () => Response.json({ markets: [] }) });
  await assert.rejects(bad.markets(), { code: "POLY_DATA_INVALID" });
});
