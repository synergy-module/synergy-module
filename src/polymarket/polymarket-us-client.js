import { createPrivateKey, sign } from "node:crypto";

const ORIGIN = "https://api.polymarket.us";
const SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
export const usError = (code, message, status = 422) => Object.assign(new Error(message), { code, status });
const invalid = () => usError("POLY_US_INPUT", "Enter the Key ID and Secret Key from the Polymarket US developer portal.");
export function validateUsCredentials(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["keyId", "secretKey"].includes(key))) throw invalid();
  const keyId = typeof body.keyId === "string" ? body.keyId.trim() : "";
  const secretKey = typeof body.secretKey === "string" ? body.secretKey.trim() : "";
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(keyId) || !/^[A-Za-z0-9+/]+={0,2}$/.test(secretKey) || secretKey.length > 88) throw invalid();
  const bytes = Buffer.from(secretKey, "base64");
  if (![32, 64].includes(bytes.length) || bytes.toString("base64").replace(/=+$/, "") !== secretKey.replace(/=+$/, "")) throw invalid();
  return { keyId, secretKey };
}
const text = value => typeof value === "string" ? value.slice(0, 300) : "";
const number = value => (typeof value === "number" || typeof value === "string" && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
const money = value => ({ value: number(value?.value), currency: text(value?.currency) });
const invalidData = () => usError("POLY_US_DATA", "Polymarket US returned an unexpected account response. Try syncing again.", 502);

// Only authenticated reads are exposed. Paths and upstream hosts are fixed.
export function createPolymarketUsClient({ fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 8000 } = {}) {
  async function read(path, credentials) {
    const { keyId, secretKey } = validateUsCredentials(credentials);
    const privateKey = createPrivateKey({ key: Buffer.concat([SEED_PREFIX, Buffer.from(secretKey, "base64").subarray(0, 32)]), format: "der", type: "pkcs8" });
    const timestamp = String(now());
    try {
      const response = await fetchImpl(ORIGIN + path, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/json", "X-PM-Access-Key": keyId, "X-PM-Timestamp": timestamp,
          "X-PM-Signature": sign(null, Buffer.from(timestamp + "GET" + path), privateKey).toString("base64") } });
      if ([401, 403].includes(response.status)) throw usError("POLY_US_AUTH", "Polymarket US rejected this key. Check the credentials and your account's API access and identity verification.", 401);
      if (!response.ok) throw usError("POLY_US_UPSTREAM", response.status === 429 ? "Polymarket US is rate limiting requests. Wait before syncing again." : "Polymarket US is temporarily unavailable. Try again shortly.", 503);
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 2_000_000) throw invalidData();
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error.code?.startsWith("POLY_US_")) throw error;
      throw usError("POLY_US_UPSTREAM", "Could not retrieve Polymarket US account data. Try again shortly.", 503);
    }
  }
  return {
    async balances(credentials) {
      const data = await read("/v1/account/balances", credentials);
      if (!Array.isArray(data?.balances)) throw invalidData();
      return { items: data.balances.slice(0, 20).map(row => ({ currency: text(row.currency), currentBalance: number(row.currentBalance),
        buyingPower: number(row.buyingPower), assetNotional: number(row.assetNotional), pendingCredit: number(row.pendingCredit), lastUpdated: text(row.lastUpdated) })),
        partial: data.balances.length > 20 };
    },
    async positions(credentials) {
      const data = await read("/v1/portfolio/positions", credentials);
      if (!data?.positions || typeof data.positions !== "object" || Array.isArray(data.positions)) throw invalidData();
      const entries = Object.entries(data.positions);
      return { items: entries.slice(0, 100).map(([slug, row]) => ({ marketSlug: text(slug), title: text(row.marketMetadata?.title) || text(slug),
        netPosition: number(row.netPositionDecimal), cost: money(row.cost), cashValue: money(row.cashValue), realized: money(row.realized), expired: row.expired === true })),
        partial: entries.length > 100 || data.eof === false || Boolean(data.nextCursor) };
    },
    async orders(credentials) {
      const data = await read("/v1/orders/open", credentials);
      if (!Array.isArray(data?.orders)) throw invalidData();
      return { items: data.orders.slice(0, 100).map(row => ({ id: text(row.id), marketSlug: text(row.marketSlug), side: text(row.side),
        outcomeSide: text(row.outcomeSide), price: money(row.price), quantity: number(row.quantity), filled: number(row.cumQuantity), status: text(row.status) })),
        partial: data.orders.length > 100 };
    },
  };
}
