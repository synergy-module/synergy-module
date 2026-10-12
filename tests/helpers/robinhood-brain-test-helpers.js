import { createRobinhoodService } from "../../src/brokers/robinhood-service.js";
import { createMemoryBrokerRepository } from "../../src/brokers/broker-repository.js";
import { createRobinhoodBrainService, authorizeRobinhoodBrain } from "../../src/robinhood-brain/brain-service.js";
import { DEFAULT_POLICY } from "../../src/robinhood-brain/risk-policy.js";

export const RH_BRAIN_NOW = new Date("2026-10-12T15:30:00Z");
export const RH_POLICY = { ...DEFAULT_POLICY, accountNumber: "fixture-agentic", symbols: ["DEMO"], provider: "grok", criticProvider: "claude" };
export const equitySchema = { type: "object", additionalProperties: false,
  required: ["account_number", "symbol", "side", "quantity", "limit_price", "type", "time_in_force"], properties: {
    account_number: { type: "string" }, symbol: { type: "string" }, side: { type: "string", enum: ["buy", "sell"] },
    quantity: { type: "number", minimum: 0.000001 }, limit_price: { type: "number", minimum: 0.01 },
    type: { type: "string", enum: ["limit"] }, time_in_force: { type: "string", enum: ["gfd"] },
    ref_id: { type: "string" }, extended_hours: { type: "boolean" },
  } };
const input = { type: "object", properties: {}, additionalProperties: false };
export const RH_BINDINGS = [
  { kind: "account", tool: "get_portfolio", arguments: {}, root: "", fields: Object.fromEntries(["number", "cash", "equity", "dailyPnl", "weeklyPnl", "isAgentic", "observedAt", "marketOpen", "ordersClear"].map(key => [key, `/${key}`])) },
  { kind: "positions", tool: "get_equity_positions", arguments: {}, root: "/positions", fields: Object.fromEntries(["symbol", "quantity", "averageCost", "value", "openedAt", "holdingId"].map(key => [key, `/${key}`])) },
  { kind: "markets", tool: "get_equity_quotes", arguments: {}, root: "/markets", fields: Object.fromEntries(["symbol", "bid", "ask", "quoteAt", "tradable", "isLeveraged", "isInverse", "avgVolume", "marketCap", "closes", "volume", "high52", "low52", "earningsDays", "earningsKnown", "lossSaleDays", "lossHistoryComplete"].map(key => [key, `/${key}`])) },
  { kind: "orders", tool: "get_equity_orders", arguments: {}, root: "/orders", fields: Object.fromEntries(["requestId", "status", "filledQuantity", "averagePrice", "symbol", "side", "number"].map(key => [key, `/${key}`])) },
  { kind: "preview", tool: "review_equity_order", arguments: {}, root: "", fields: { valid: "/valid", warnings: "/warnings", cost: "/cost" } },
];
export function rhSnapshot(date = RH_BRAIN_NOW) {
  return { source: "robinhood", account: { number: "fixture-agentic", cash: 10000, equity: 10000, dailyPnl: 0, weeklyPnl: 0,
    isAgentic: true, observedAt: date.toISOString(), marketOpen: true, ordersClear: true }, positions: [], orders: [],
    markets: [{ symbol: "DEMO", bid: 49.95, ask: 50, quoteAt: date.toISOString(), tradable: true, isLeveraged: false, isInverse: false,
      avgVolume: 2000000, volume: 5000000, marketCap: 10000000000, closes: Array.from({ length: 220 }, (_, i) => 40 + i / 22),
      high52: 51, low52: 30, earningsKnown: true, earningsDays: 20, lossHistoryComplete: true, lossSaleDays: null }] };
}
export function rhBrainHarness({ now = () => RH_BRAIN_NOW, liveEnabled = false, autonomousEnabled = false, repository = createMemoryBrokerRepository(),
  beforeRead, beforeModel, beforeOrder, critic = "pass", canOperate = async () => true } = {}) {
  const calls = [], modelCalls = [], snapshot = rhSnapshot(now());
  if (repository.getStorageStatus().kind === "memory") repository.getStorageStatus = () => ({ kind: "fixture", persistent: true });
  const tools = ["get_accounts", "get_portfolio", "get_equity_positions", "get_equity_quotes", "get_equity_orders"].map(name => ({ name, inputSchema: input }));
  tools.push({ name: "place_equity_order", inputSchema: equitySchema }, { name: "review_equity_order", inputSchema: equitySchema });
  const client = { async begin() { return { pending: { createdAt: now().valueOf() } }; }, async complete() { return { accessToken: "fixture-never-expose-token", refreshToken: "fixture-refresh", expiresAt: now().valueOf() + 3600000 }; },
    async withSession(_credentials, operation) { return operation({ listTools: async () => tools, call: async (name, args) => {
      calls.push({ name, args });
      if (name === "place_equity_order") { await beforeOrder?.(args); return { structuredContent: { acknowledged: true }, content: [] }; }
      if (name === "review_equity_order") return { structuredContent: { valid: true, warnings: [], cost: args.quantity * args.limit_price }, content: [] };
      await beforeRead?.(name);
      const payload = name === "get_portfolio" ? snapshot.account : name === "get_equity_positions" ? { positions: snapshot.positions }
        : name === "get_equity_quotes" ? { markets: snapshot.markets } : name === "get_equity_orders" ? { orders: snapshot.orders } : { accounts: [] };
      return { structuredContent: structuredClone(payload), content: [] };
    } }); } };
  const broker = createRobinhoodService({ repository, client, now: () => now().valueOf(), config: {
    configured: true, encryptionKey: "ab".repeat(32), liveEnabled, missing: [], redirectUri: "http://localhost/callback" },
    agenticEnabled: autonomousEnabled, agenticAuthorizer: (state, action, at) => authorizeRobinhoodBrain(state, action, at, autonomousEnabled) });
  const ai = {
    async getOwnerStatus() { return { paidCallsEnabled: true, providers: ["claude", "gemini", "grok", "openai"].map(id => ({ id, configured: true, model: `${id}-fixture` })) }; },
    async generateDetailed(request) {
      modelCalls.push(request.provider); await beforeModel?.(request);
      const data = JSON.parse(request.prompt);
      if (request.schema.properties.theses) return { provider: request.provider, model: "fixture", usage: null, data: { theses: data.candidates.map(market => ({ symbol: market.symbol,
        direction: "long", conviction: "medium", summary: "Synthetic thesis supported by fixture market observations", invalidation: "The fixture trend reverses", newFactAt: null,
        riskFlags: [], sourceIds: [data.observations[0].id] })) } };
      return { provider: request.provider, model: "fixture", usage: null, data: { reviews: data.theses.map(thesis => ({ symbol: thesis.symbol, verdict: critic, reason: "Synthetic review" })) } };
    },
  };
  const timers = [], service = createRobinhoodBrainService({ broker, ai, now, autonomousEnabled, canOperate,
    setTimer: callback => { const timer = { callback, cleared: false, unref() {} }; timers.push(timer); return timer; }, clearTimer: timer => { if (timer) timer.cleared = true; } });
  return { service, broker, repository, calls, modelCalls, snapshot, ai,
    async connect(owner = "alice") { const pending = (await broker.begin(owner)).pending; await broker.complete(owner, { ...pending, ownerId: owner }, "fixture-code");
      await service.configure(owner, { version: 1, policy: RH_POLICY, bindings: RH_BINDINGS }); await service.verify(owner); },
    async tick() { const timer = timers.find(row => !row.cleared && !row.used); if (!timer) throw new Error("No scheduled work"); timer.used = true; await timer.callback(); },
  };
}
