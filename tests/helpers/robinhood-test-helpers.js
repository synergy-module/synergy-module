import { createRobinhoodService } from "../../src/brokers/robinhood-service.js";
import { createMemoryBrokerRepository } from "../../src/brokers/broker-repository.js";

// Deliberately synthetic protocol fixtures. Actual Robinhood schemas require account authorization.
export const emptyInput = { type: "object", properties: {}, additionalProperties: false };
export const orderInput = { type: "object", required: ["account_id", "symbol", "quantity", "limit_price"], additionalProperties: false,
  properties: { account_id: { type: "string" }, symbol: { type: "string" }, quantity: { type: "number", minimum: 0.01 }, limit_price: { type: "number", minimum: 0.01 } } };
export function robinhoodHarness({ repository, liveEnabled = false, now = () => Date.now(), call, tools } = {}) {
  repository ??= createMemoryBrokerRepository();
  // The fixture opts into auth with an isolated store; runtime memory repositories do not.
  if (repository.getStorageStatus().kind === "memory") repository.getStorageStatus = () => ({ kind: "fixture", persistent: true });
  const invocations = [], config = { configured: true, encryptionKey: "ab".repeat(32), redirectUri: "https://synergy-module.test/auth/robinhood/callback", liveEnabled, missing: [] };
  let catalog = tools ?? [
    { name: "get_accounts", inputSchema: emptyInput },
    { name: "get_equity_quotes", inputSchema: { type: "object", required: ["symbols"], properties: { symbols: { type: "array", items: { type: "string" } } }, additionalProperties: false } },
    ...["equity", "option", "crypto"].flatMap((asset) => [{ name: asset === "crypto" ? "preview_crypto_order" : `review_${asset}_order`, inputSchema: orderInput }, { name: `place_${asset}_order`, inputSchema: orderInput }]),
    { name: "send_money", annotations: { readOnlyHint: true }, inputSchema: emptyInput },
  ];
  const client = {
    async begin(redirectUri) { return { pending: { state: "fixture-state", verifier: "fixture-verifier", clientId: "fixture-client", redirectUri, createdAt: now() }, authorizationUrl: "https://robinhood.com/oauth?state=fixture-state" }; },
    async complete() { return { accessToken: "fixture-token-must-not-render", refreshToken: "fixture-refresh-must-not-render", expiresAt: now() + 3600000, clientId: "fixture-client" }; },
    async refresh(value) { return { ...value, expiresAt: now() + 3600000 }; },
    async withSession(credentials, work) {
      return work({ listTools: async () => structuredClone(catalog), call: async (name, args) => {
        invocations.push({ name, args: structuredClone(args) });
        return call ? call(name, args) : { structuredContent: { message: "fixture result", name, args }, content: [] };
      } });
    },
  };
  const service = createRobinhoodService({ repository, config, client, now });
  return { service, repository, config, client, invocations, setCatalog(value) { catalog = value; },
    async connect(owner = "owner") { const { pending } = await service.begin(owner); await service.complete(owner, { ...pending, ownerId: owner }, "fixture-code"); return owner; } };
}
export const sampleOrder = (tool = "place_equity_order") => ({ tool, arguments: { account_id: "fixture-agentic", symbol: "EXAMPLE", quantity: 1, limit_price: 10 }, reason: "Synthetic execution test", requestId: "fixture-request-001" });
