import { generateKeyPairSync } from "node:crypto";
import { createPolymarketUsClient } from "../../src/polymarket/polymarket-us-client.js";

export function usFixture({ beforeFetch, status = 200 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const credentials = { keyId: "b2dff1cf-52a8-4ccf-93b3-f403ac0c370a", secretKey: privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64") };
  const calls = [], data = {
    "/v1/account/balances": { balances: [{ currency: "USD", currentBalance: 125, buyingPower: 100, assetNotional: 25, lastUpdated: "2026-10-12T15:30:00Z", pendingWithdrawals: [{ bankId: "private-bank-id" }] }] },
    "/v1/portfolio/positions": { positions: { "test-us-market": { marketMetadata: { title: "US fixture market" }, netPositionDecimal: "2.5", netPosition: "3", cost: { value: "1.25", currency: "USD" }, cashValue: { value: "1.5", currency: "USD" }, realized: { value: "0", currency: "USD" } } }, eof: true },
    "/v1/orders/open": { orders: [{ id: "test-order", marketSlug: "test-us-market", side: "ORDER_SIDE_BUY", outcomeSide: "OUTCOME_SIDE_YES", quantity: 3, cumQuantity: 1, price: { value: "0.5", currency: "USD" }, status: "ORDER_STATUS_NEW" }] },
  };
  const client = createPolymarketUsClient({ now: () => 1791819000000, fetchImpl: async (input, options) => {
    const url = new URL(input); calls.push({ url, options }); await beforeFetch?.(url);
    return Response.json(status === 200 ? data[url.pathname] : { message: credentials.secretKey }, { status });
  } });
  return { credentials, publicKey, client, calls, data };
}
