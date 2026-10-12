import { PLATFORM_SCOPES } from "./token-service.js";

const read = "workspace:read", write = "workspace:write";
const knownRoots = new Set(["platform", "settings", "admin", "indicators", "indicator-access", "brain", "trader", "journal", "market-news", "polymarket", "robinhood", "robinhood-brain", "testing", "practice"]);
const empty = { type: "object", additionalProperties: false };
const str = { type: "string" }, num = { type: "number" }, bool = { type: "boolean" };
const object = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const choices = values => ({ type: "string", enum: values });
const provider = choices(["gemini", "openai", "claude", "grok"]);
const researchFields = { mode: choices(["demo", "analysis"]), provider, symbol: str, timeframe: choices(["1m", "5m", "15m", "1h", "4h", "1d"]),
  context: { type: "string", maxLength: 12000, description: "Actual supplied market observations. Analysis requires at least 40 characters; demo can use empty context." },
  accountSize: num, riskPercent: num, pointValue: num, minRewardRisk: num };
const researchRequired = ["symbol", "timeframe", "accountSize", "riskPercent", "pointValue", "minRewardRisk"];
const publicDataFields = { source: choices(["polymarket", "binance", "solana"]), query: str, instrument: str, marketId: str,
  outcomeIndex: { type: "integer", enum: [0, 1] }, address: str, latitude: num, longitude: num, date: { type: "string", format: "date" }, station: str, timezone: str, metric: choices(["high", "low"]),
  asset: choices(["BTC", "ETH", "SOL", "XRP"]), windowMinutes: { type: "integer", enum: [5, 15] }, outcome: choices(["Up", "Down"]), profile: choices(["strict", "smaller-pools"]), windowOpenedAt: { type: "string", format: "date-time" }, windowEndsAt: { type: "string", format: "date-time" } };
const timestamp = { anyOf: [{ type: "string", format: "date-time" }, { type: "number", description: "Unix milliseconds" }] };
const evidenceInputs = {
  twap: object({ ticks: { type: "array", maxItems: 20000, items: object({ value: num, timestamp, availableAt: timestamp, receivedAt: timestamp }, ["value", "timestamp"]) }, start: timestamp, end: timestamp, asOf: timestamp, maxGapMs: num }, ["ticks", "start", "end"]),
  volatility: object({ observations: { type: "array", maxItems: 20000, items: { type: "object" } }, asOf: timestamp, intervalSeconds: num, minimumReturns: { type: "integer" } }, ["observations", "asOf"]),
  "twap-probability": object({ openPrice: num, spotPrice: num, volatilityPerSecond: num, secondsLeft: num, observedMean: num, windowSeconds: num }, ["openPrice", "spotPrice", "volatilityPerSecond", "secondsLeft"]),
  "weather-calibration": object({ records: { type: "array", maxItems: 10000, items: object({ station: str, model: str, targetAt: timestamp, issuedAt: timestamp,
    actualObservedAt: timestamp, availableAt: timestamp, predicted: num, actual: num, tainted: bool }, ["station", "model", "targetAt", "issuedAt", "actualObservedAt", "predicted", "actual"]) }, asOf: timestamp, leadHours: num, minimumSamples: { type: "integer" } }, ["records", "asOf"]),
  "weather-blend": object({ forecasts: { type: "array", maxItems: 1000, items: { type: "object" } }, calibration: { type: "object", description: "Result from weather-calibration" }, station: str, targetAt: timestamp, asOf: timestamp, leadHours: num }, ["forecasts", "calibration", "station", "targetAt", "asOf"]),
  "weather-ensemble": object({ members: { type: "array", minItems: 10, maxItems: 100, items: num }, bucketLower: { type: ["number", "null"] }, bucketUpper: { type: ["number", "null"] }, gaussianProbability: num }, ["members", "bucketLower", "bucketUpper", "gaussianProbability"]),
  sizing: object({ model: choices(["fixed-1", "fixed-2", "half-kelly", "quarter-kelly", "fixed-cash"]), equity: num, probability: num, price: num, clipUsd: num, maximumUsd: num }, ["model", "equity"]),
};
const schemas = {
  "POST /api/platform/tokens": object({ name: { type: "string", minLength: 1, maxLength: 80 }, scopes: { type: "array", minItems: 1, items: choices(PLATFORM_SCOPES.map(scope => scope.id)) }, expiresInDays: { type: "integer", minimum: 1, maximum: 90, default: 30 } }, ["name", "scopes"]),
  "POST /api/robinhood/connect": empty,
  "PATCH /api/settings/profile": object({ displayName: { type: "string", minLength: 1, maxLength: 80 } }, ["displayName"]),
  "PATCH /api/settings/preferences": object({ provider, symbol: str, timeframe: str, accountSize: num, riskPercent: num, pointValue: num, minRewardRisk: num,
    theme: choices(["system", "light", "dark"]), density: choices(["comfortable", "compact"]), reducedMotion: bool, timezone: str,
    defaultLanding: choices(["/home", "/research", "/practice", "/live"]), currency: choices(["USD", "EUR", "GBP", "CAD", "AUD", "JPY"]),
    notifications: object({ researchCompleted: bool, orderUpdates: bool, practiceResults: bool }),
    routes: { type: "object", additionalProperties: provider }, limits: object({ maxSteps: num, maxModelCalls: num, maxTokens: num, maxDurationMs: num, maxCostUsd: { type: ["number", "null"] } }) }),
  "PUT /api/settings/providers/:provider": object({ apiKey: { type: "string", format: "password", minLength: 8, maxLength: 8192 } }, ["apiKey"]),
  "PUT /api/settings/drafts/:name": object({ fields: { type: "object", description: "Allowed draft fields depend on name: research, journal, or knowledge." } }, ["fields"]),
  "PATCH /api/settings/onboarding": object({ step: choices(["welcome", "connections", "preferences", "review"]), interests: { type: "array", maxItems: 5, items: choices(["research", "prediction-markets", "stocks", "practice", "automation"]) }, acknowledgedPracticeIsolation: bool }),
  "POST /api/settings/onboarding/complete": object({ acknowledgedPracticeIsolation: { type: "boolean", const: true } }, ["acknowledgedPracticeIsolation"]),
  "POST /api/platform/connections/robinhood/complete": object({ code: str, state: str }, ["code", "state"]),
  "POST /api/brain/documents": object({ title: str, text: str, kind: choices(["knowledge"]) }, ["title", "text"]),
  "POST /api/brain/evals": empty,
  "POST /api/brain/runs": object({ ...researchFields, objective: { type: "string", minLength: 10, maxLength: 1200 },
    routes: object({ planner: provider, researcher: provider, strategist: provider, critic: provider }),
    limits: object({ maxSteps: { type: "integer", minimum: 1, maximum: 24 }, maxModelCalls: { type: "integer", minimum: 1, maximum: 16 }, maxTokens: { type: "integer", minimum: 1, maximum: 128000 }, maxDurationMs: { type: "integer", minimum: 10, maximum: 180000 }, maxCostUsd: { type: ["number", "null"], minimum: 0, maximum: 10 } }) }, researchRequired),
  "POST /api/trader/runs": object(researchFields, researchRequired),
  "PUT /api/brain/tools/:section": object({ version: { type: "integer", minimum: 0 }, tools: { type: "array", uniqueItems: true, items: str, description: "Select tool IDs returned by GET /brain/tools for this section." } }, ["version", "tools"]),
  "POST /api/brain/runs/:id/decision": object({ version: { type: "integer", minimum: 1 }, decision: choices(["approve", "reject"]), note: str }, ["version", "decision"]),
  "POST /api/journal": object({ direction: choices(["long", "short"]), entryTime: str, entryPrice: str, exitPrice: str, notes: str, confluences: { type: "array", items: str }, screenshotCount: { type: "integer" } }, ["direction"]),
  "POST /api/robinhood/read": object({ tool: str, arguments: { type: "object" } }, ["tool"]),
  "POST /api/robinhood/actions": object({ tool: str, arguments: { type: "object" }, reason: str, requestId: str }, ["tool", "arguments", "reason", "requestId"]),
  "POST /api/robinhood/actions/:id/decision": object({ version: { type: "integer" }, decision: choices(["approve", "reject"]) }, ["version", "decision"]),
  "POST /api/robinhood/pause": object({ paused: bool }, ["paused"]),
  "POST /api/admin/users/:id/ban": object({ reason: str }),
  "POST /api/admin/indicator-requests/:userId/decision": object({ status: choices(["GRANTED", "DENIED"]) }, ["status"]),
  "POST /api/indicator-access/requests": object({ tradingViewUsername: str, consent: { type: "boolean", const: true } }, ["tradingViewUsername", "consent"]),
  "PUT /api/polymarket/paper/settings": object({ positionUsd: num, maxExposureUsd: num, maxPositions: { type: "integer" }, dailyLossUsd: num, maxDrawdownPercent: num, slippageBps: num, cycleSeconds: { type: "integer" } }),
  "POST /api/polymarket/research": object({ marketId: str }, ["marketId"]),
  "POST /api/polymarket/notes": object({ text: str, marketId: str }, ["text"]),
  "PUT /api/polymarket/watchlist": object({ marketId: str, watching: bool }, ["marketId", "watching"]),
  "PUT /api/polymarket/radar": object({ address: str, following: bool }, ["address", "following"]),
  "POST /api/polymarket/paper/start": empty,
  "POST /api/polymarket/paper/positions/:id/close": empty,
  "POST /api/polymarket/us/connect": object({ keyId: { type: "string", format: "uuid" }, secretKey: { type: "string", format: "password", description: "Base64 Ed25519 secret (32 or 64 bytes) from the Polymarket US developer portal." } }, ["keyId", "secretKey"]),
  "POST /api/robinhood/discover": empty,
  "PUT /api/robinhood-brain/policy": object({ version: { type: "integer" }, policy: object({ accountNumber: str, symbols: { type: "array", items: str, minItems: 1, maxItems: 10 }, provider, criticProvider: provider,
    orderBudgetUsd: num, maxPositionPercent: num, maxPositions: { type: "integer" }, cashBufferPercent: num, dailyLossPercent: num, weeklyLossPercent: num,
    stopLossPercent: num, maxSpreadPercent: num, maxEntryGapPercent: num, maxExtensionPercent: num, earningsBlackoutDays: { type: "integer" }, cycleSeconds: { type: "integer" } }),
    bindings: { type: "array", maxItems: 12, items: object({ kind: choices(["account", "positions", "markets", "orders", "preview"]), tool: str, arguments: { type: "object" }, root: str,
      fields: { type: "object", description: "Map supported financial fields to JSON pointers in actual broker responses. Read current policy and catalog before editing." } }, ["kind", "tool", "arguments", "root", "fields"]) } }, ["version", "policy"]),
  "POST /api/robinhood-brain/start": object({ version: { type: "integer" }, mode: choices(["review", "autonomous"]), authorizeAutonomous: bool }, ["version", "mode"]),
  "POST /api/robinhood-brain/cycles": object({ mode: { type: "string", const: "cycle" } }, ["mode"]),
  "POST /api/robinhood-brain/notes": object({ text: { type: "string", maxLength: 1500 } }, ["text"]),
  "POST /api/practice/books": object({ name: { type: "string", minLength: 1, maxLength: 80 }, strategyId: { type: "string", description: "Select an ID from GET /practice strategies and use its fields for config." }, initialCapital: { type: "number", minimum: 10, maximum: 1000000, default: 500 }, config: { type: "object", description: "Strategy-specific options returned in the strategy catalog." },
    risk: object({ positionUsd: { type: "number", minimum: 1, maximum: 100000 }, maxExposurePercent: { type: "number", minimum: 1, maximum: 100 }, maxPositions: { type: "integer", minimum: 1, maximum: 30 }, maxDrawdownPercent: { type: "number", minimum: 1, maximum: 100 }, feeBps: { type: "number", minimum: 0, maximum: 500 }, slippageBps: { type: "number", minimum: 0, maximum: 1000 } }),
    feed: object({ source: choices(["binance", "polymarket", "solana"]), instrument: { type: "string", maxLength: 160 }, marketId: { type: "string", description: "Required for prediction market quotes; select an ID from discover." }, outcomeIndex: { type: "integer", enum: [0, 1] }, asset: choices(["BTC", "ETH", "SOL", "XRP"]),
      windowOpenedAt: { type: "string", format: "date-time" }, windowEndsAt: { type: "string", format: "date-time" }, referenceMode: choices(["proxy", "recorded"]), autoAdvance: bool, direction: choices(["Up", "Down"]), slug: str, walletAddress: str, followAllMarkets: bool,
      weather: object({ station: str, settlementStation: str, latitude: num, longitude: num, date: { type: "string", format: "date" }, timezone: str, metric: choices(["high", "low"]), bucketLower: { type: ["number", "null"] }, bucketUpper: { type: ["number", "null"] }, leadHours: num,
        calibrationRecords: { ...evidenceInputs["weather-calibration"].properties.records, minItems: 7, maxItems: 200, description: "Dated prior calibration observations. Freezes model evidence, not replay trades." } }) }, ["source", "instrument"]) }, ["name", "strategyId", "feed"]),
  "POST /api/practice/books/:id/start": object({ intervalSeconds: { type: "integer", minimum: 30, maximum: 3600, default: 60 } }),
  "POST /api/practice/books/:id/orders": object({ side: choices(["BUY", "SELL"]), budgetUsd: num, positionId: str, requestId: { type: "string", pattern: "^[a-zA-Z0-9_-]{8,100}$", description: "Unique idempotency identifier; reuse on retry of the same intent." } }, ["side"]),
  "POST /api/practice/books/:id/positions/:positionId/close": empty,
  "POST /api/practice/data/:method": { ...object(publicDataFields), description: "Read current public data: discover(source,query); quote(source,instrument or marketId,outcomeIndex); weather(latitude,longitude,date,station,timezone); weatherEnsemble(same fields,metric); solana(address); wallet(address); tokenEvidence(address); scanSolana(address,profile); cryptoWindow(asset,windowMinutes,outcome); cryptoModel(asset,windowOpenedAt,windowEndsAt). Public crypto model is a spot proxy; recorded data is fetched only by the worker." },
  "PUT /api/practice/feeds/polybolt": object({ apiKey: { type: "string", format: "password" }, secret: { type: "string", format: "password" }, passphrase: { type: "string", format: "password" } }, ["apiKey", "secret", "passphrase"]),
  "POST /api/practice/feeds/polybolt/start": object({ symbols: { type: "array", items: choices(["btcusd", "ethusd", "solusd", "xrpusd"]), minItems: 1, maxItems: 4 },
    channels: { type: "array", items: choices(["price.crypto", "price.crypto.twap"]), minItems: 1, maxItems: 2 }, durationSeconds: { type: "integer", minimum: 10, maximum: 3600 } }),
  "POST /api/practice/feeds/polybolt/stop": empty,
  "POST /api/practice/evidence/:method": { anyOf: Object.entries(evidenceInputs).map(([method, schema]) => ({ ...schema, description: `Request for /practice/evidence/${method}` })) },
};

for (const method of ["PUT", "POST"]) for (const operation of ["policy", "start", "cycles", "notes"]) {
  const schema = schemas[`${method} /api/robinhood-brain/${operation}`];
  if (schema) schemas[`${method} /api/practice/equities/${operation}`] = operation === "start"
    ? object({ version: { type: "integer" }, mode: { type: "string", const: "paper" } }, ["version", "mode"]) : schema;
}

const queryFields = {
  "/api/brain/runs": { limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: str },
  "/api/brain/documents": { limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: str },
  "/api/brain/synergy/search": { query: { type: "string", minLength: 2, maxLength: 300 } },
  "/api/brain/synergy/read": { kind: str, id: str, offset: { type: "integer", minimum: 0 } },
  "/api/market-news/events": { refresh: choices(["1"]) },
  "/api/practice/data/:method": publicDataFields,
  "/api/practice/feeds/polybolt/snapshot": { symbol: choices(["btcusd", "ethusd", "solusd", "xrpusd"]), channel: choices(["price.crypto", "price.crypto.twap"]), limit: { type: "integer", minimum: 1, maximum: 1000 } },
};

/** Scope checks supplement, never replace, the normal controller's capability checks. */
export function policyForOperation(method, path) {
  const root = path.split("/")[2];
  if (!path.startsWith("/api/") || !knownRoots.has(root)) return null;
  if (path.startsWith("/api/platform/tokens")) return { sessionOnly: true, scopes: [], capability: "base" };
  if (path === "/api/robinhood/connect") return { sessionOnly: true, scopes: [], capability: "base", alternative: "/api/v1/platform/connections/robinhood/begin" };
  const isRead = method === "GET" || method === "HEAD";
  const admin = root === "admin" || path.startsWith("/api/brain/tools") || path.startsWith("/api/brain/synergy/");
  if (admin) return { scopes: [isRead ? "admin:read" : "admin:write"], capability: "admin" };
  const capability = root === "journal" ? "journal" : ["indicators", "indicator-access"].includes(root) ? "indicators" : "base";
  if (isRead) return { scopes: [read], capability };
  if (path === "/api/practice/feeds/polybolt" && ["PUT", "DELETE"].includes(method)) return { scopes: ["connections:write"], capability };
  if (path.startsWith("/api/settings/providers/") || path.startsWith("/api/platform/connections/")
    || /^\/api\/polymarket\/us\/(connect|disconnect|sync)$/.test(path)
    || /^\/api\/robinhood\/(disconnect|discover)$/.test(path) || path === "/api/robinhood-brain/catalog/sync") {
    return { scopes: ["connections:write"], capability };
  }
  if (path === "/api/robinhood/read") return { scopes: [read], capability };
  if (/^\/api\/robinhood\/(actions|pause)(\/|$)/.test(path)
    || /^\/api\/robinhood-brain\/(policy|verify|cycles|start|pause|reconcile)(\/|$)/.test(path)) {
    return { scopes: ["live:trade"], capability, live: true };
  }
  if (path.startsWith("/api/practice/data/")) return { scopes: [read], capability };
  if (root === "testing" || root === "practice" || path.startsWith("/api/polymarket/paper/")) return { scopes: ["testing:write"], capability, simulated: true };
  if (root === "brain" || root === "trader" || path === "/api/polymarket/research") return { scopes: ["research:write"], capability };
  // New endpoints within a known non-trading domain inherit workspace editing.
  // Unclassified broker actions fail closed until their execution policy is explicit.
  if (root === "robinhood" || (root === "robinhood-brain" && !path.startsWith("/api/robinhood-brain/notes"))
    || path.startsWith("/api/polymarket/us/")) return null;
  return { scopes: [write], capability };
}

function routeEntries(router) {
  const result = [];
  function visit(stack) {
    for (const layer of stack ?? []) {
      if (layer.route) {
        for (const route of Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path]) {
          if (typeof route !== "string" || !route.startsWith("/api/")) continue;
          for (const method of Object.keys(layer.route.methods)) if (layer.route.methods[method]) result.push({ method: method.toUpperCase(), route });
        }
      } else if (layer.handle?.stack) visit(layer.handle.stack);
    }
  }
  visit(router.stack);
  return result;
}

export function operationCatalog(router) {
  return [...new Map(routeEntries(router).map(({ method, route }) => {
    const policy = policyForOperation(method, route);
    const id = `${method.toLowerCase()}_${route.replace(/^\/api\//, "").replace(/[^A-Za-z0-9]+/g, "_")}`;
    return [`${method} ${route}`, { id, method, path: route.replace(/^\/api/, "/api/v1"), browserPath: route,
      scopes: policy?.scopes ?? [], capability: policy?.capability ?? null,
      access: policy?.sessionOnly ? "browser-session" : policy ? "bearer" : "unavailable",
      ...(policy?.alternative ? { alternative: policy.alternative } : {}),
      liveTrading: policy?.live === true, simulation: policy?.simulated === true,
      querySchema: method === "GET" ? object(queryFields[route] ?? {}) : null,
      inputSchema: schemas[`${method} ${route}`] ?? (method === "DELETE" || /\/(pause|stop|cancel|disconnect|sync|refresh|verify|reconcile|sign-out|unban|begin)$/.test(route) ? empty : { type: "object" }),
    }];
  })).values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export function matchesOperation(operation, method, pathname) {
  if (operation.method !== (method === "HEAD" ? "GET" : method)) return false;
  const pattern = operation.path.split("/").map(segment => segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
  return new RegExp(`^${pattern}/?$`, "i").test(pathname);
}

export function createOpenApiDocument(router) {
  const paths = {};
  for (const operation of operationCatalog(router).filter(item => item.access === "bearer")) {
    const path = operation.path.replace(/^\/api\/v1/, "").replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    paths[path] ??= {};
    paths[path][operation.method.toLowerCase()] = {
      operationId: operation.id,
      summary: `${operation.method} ${path}`,
      description: `Acts as the authenticated token owner. Required scope: ${operation.scopes.join(", ")}. Required account capability: ${operation.capability}.${operation.liveTrading ? " This action may affect live trading." : ""}${operation.simulation ? " Simulation only; no live broker execution." : ""}`,
      tags: [path.split("/")[1]], security: [{ bearerAuth: [] }],
      "x-required-scopes": operation.scopes, "x-account-capability": operation.capability,
      "x-live-trading": operation.liveTrading, "x-simulation": operation.simulation,
      parameters: [...[...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1], in: "path", required: true, schema: { type: "string" } })),
        ...Object.entries(operation.querySchema?.properties ?? {}).map(([name, schema]) => ({ name, in: "query", required: false, schema }))],
      ...(!["GET", "HEAD", "DELETE"].includes(operation.method) ? { requestBody: { required: false, content: { "application/json": { schema: operation.inputSchema } } } } : {}),
      responses: Object.fromEntries([["200", "Operation completed"], ["201", "Resource created"], ["202", "Operation queued"], ["400", "Invalid request"], ["401", "Invalid token or account admission"], ["403", "Missing token scope or account capability"], ["404", "Resource absent or belongs to another account"], ["409", "State changed or action requires review"], ["422", "Invalid input"], ["429", "Rate limited"], ["503", "Dependency unavailable"]].map(([status, description]) => [status, { description, content: { "application/json": { schema: { type: "object" } } } }])),
    };
  }
  return { openapi: "3.1.0", info: { title: "Synergy Module Agent API", version: "1.0.0", description: "Authenticated user actions for Codex, Claude Code, Grok Build and other clients. Create a scoped token in Settings. Interactive provider consent is still required for OAuth accounts." },
    servers: [{ url: "/api/v1" }], paths,
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "Synergy API token" } } },
    "x-scopes": PLATFORM_SCOPES };
}
