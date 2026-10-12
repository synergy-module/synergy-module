import { ROBINHOOD_READ_TOOLS } from "../brokers/robinhood-catalog.js";
import { brainError } from "./risk-policy.js";

const FIELDS = {
  account: ["number", "cash", "equity", "dailyPnl", "weeklyPnl", "isAgentic", "observedAt", "marketOpen", "ordersClear"],
  positions: ["symbol", "quantity", "averageCost", "value", "openedAt", "holdingId"],
  markets: ["symbol", "bid", "ask", "quoteAt", "tradable", "isLeveraged", "isInverse", "avgVolume", "marketCap", "closes", "volume", "high52", "low52", "earningsDays", "earningsKnown", "lossSaleDays", "lossHistoryComplete"],
  orders: ["requestId", "status", "filledQuantity", "averagePrice", "symbol", "side", "number"],
  preview: ["valid", "warnings", "cost"],
};
export function pointer(value, path) {
  if (typeof path !== "string" || (path !== "" && !path.startsWith("/")) || path.length > 200) throw brainError("ADAPTER", "Use bounded JSON pointers for broker field mappings.");
  let result = value;
  for (const segment of path === "" ? [] : path.slice(1).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (["__proto__", "prototype", "constructor"].includes(key) || !result || typeof result !== "object" || !Object.hasOwn(result, key)) return undefined;
    result = result[key];
  }
  return result;
}
export function validateBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length > 12) throw brainError("ADAPTER", "Configure up to twelve broker read bindings.");
  for (const binding of bindings) {
    if (!binding || !Object.hasOwn(FIELDS, binding.kind) || !ROBINHOOD_READ_TOOLS.has(binding.tool)
      || (binding.kind === "preview" ? binding.tool !== "review_equity_order" : /review_|preview_/.test(binding.tool)) || !binding.arguments || typeof binding.arguments !== "object" || Array.isArray(binding.arguments)
      || !binding.fields || typeof binding.fields !== "object" || Array.isArray(binding.fields)
      || Object.keys(binding).some(key => !["kind", "tool", "arguments", "root", "fields"].includes(key))
      || Object.keys(binding.fields).some(key => !FIELDS[binding.kind].includes(key))) throw brainError("ADAPTER", "Bindings must use discovered read tools and supported financial fields.");
    pointer({}, binding.root);
    for (const value of Object.values(binding.fields)) {
      if (typeof value === "string") pointer({}, value);
      else if (value && Object.keys(value).length === 2 && typeof value.path === "string" && typeof value.column === "string") { pointer({}, value.path); pointer({}, value.column); }
      else throw brainError("ADAPTER", "Each field requires a JSON pointer, or a path and column for an array.");
    }
  }
  if (Buffer.byteLength(JSON.stringify(bindings)) > 12000) throw brainError("ADAPTER", "Broker bindings exceed the size limit.");
  return structuredClone(bindings);
}
export function substitute(value, context) {
  if (typeof value === "string" && ["{account}", "{symbols}"].includes(value)) return value === "{account}" ? context.accountNumber : context.symbols;
  if (Array.isArray(value)) return value.map(item => substitute(item, context));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, context)]));
  return value;
}
function body(result) {
  if (result?.structuredContent) return result.structuredContent;
  const blocks = result?.content?.filter(block => block.type === "text" && typeof block.text === "string") ?? [];
  if (blocks.length === 1) { try { return JSON.parse(blocks[0].text); } catch {} }
  throw brainError("ADAPTER", "The broker did not return readable structured data. Verify its response mapping.");
}
export async function fetchBrokerEvidence(broker, owner, policy, bindings, signal) {
  if (!bindings.length) throw brainError("ADAPTER", "Connect Robinhood and configure verified broker response bindings first.", 409);
  const account = {}, positions = [], orders = [], markets = new Map(), sources = [];
  let holdingsRead = false, ordersRead = false;
  const sorted = [...bindings].sort((a, b) => ["account", "positions", "orders", "markets"].indexOf(a.kind) - ["account", "positions", "orders", "markets"].indexOf(b.kind));
  for (const binding of sorted) {
    if (binding.kind === "preview") continue;
    const context = { ...policy, symbols: [...new Set([...policy.symbols, ...positions.map(row => row.symbol)])] };
    const snapshot = await broker.read(owner, binding.tool, substitute(binding.arguments, context), { signal });
    const payload = body(snapshot.result), root = pointer(payload, binding.root);
    const rows = binding.kind === "account" ? [root] : root;
    if (!Array.isArray(rows) || rows.length > 100) throw brainError("ADAPTER", "A broker response does not match its saved mapping.");
    if (binding.kind === "positions") holdingsRead = true;
    if (binding.kind === "orders") ordersRead = true;
    const sourceRows = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") throw brainError("ADAPTER", "A mapped broker row is invalid.");
      const normalized = Object.fromEntries(Object.entries(binding.fields).map(([key, path]) => {
        const value = typeof path === "string" ? pointer(row, path) : pointer(row, path.path)?.map?.(item => pointer(item, path.column));
        // Numeric strings are explicit broker values, never model estimates.
        const numeric = !["number", "symbol", "observedAt", "quoteAt", "openedAt", "holdingId", "requestId", "status", "side"].includes(key) && typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
        return [key, key === "closes" && Array.isArray(value) ? value.map(item => typeof item === "string" && /^\d+(?:\.\d+)?$/.test(item) ? Number(item) : item) : numeric];
      }));
      if (binding.kind === "account") Object.assign(account, normalized);
      else if (binding.kind === "positions") positions.push(normalized);
      else if (binding.kind === "orders") orders.push(normalized);
      else { if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(normalized.symbol ?? "")) throw brainError("ADAPTER", "Market rows need verified symbols."); markets.set(normalized.symbol, { ...markets.get(normalized.symbol), ...normalized }); }
      sourceRows.push(normalized);
    }
    sources.push({ id: snapshot.id, kind: binding.kind, tool: snapshot.tool, fetchedAt: snapshot.fetchedAt,
      excerpt: JSON.stringify(sourceRows).slice(0, 18000) });
  }
  if (!holdingsRead) throw brainError("ADAPTER", "A complete holdings read is required before execution.");
  return { source: "robinhood", account, positions, orders, ordersRead, markets: [...markets.values()], sources };
}

export function verifyOrderPreview(result, binding, order, account, policy) {
  if (!binding || binding.kind !== "preview") throw brainError("ADAPTER", "Autonomous execution requires a verified broker preview mapping.", 409);
  const row = pointer(body(result), binding.root), values = Object.fromEntries(Object.entries(binding.fields).map(([key, path]) => [key, typeof path === "string" ? pointer(row, path) : undefined]));
  const cost = typeof values.cost === "string" && /^\d+(?:\.\d+)?$/.test(values.cost) ? Number(values.cost) : values.cost;
  if (values.valid !== true || !Array.isArray(values.warnings) || values.warnings.length !== 0) throw brainError("RISK", "Broker preview contains warnings or lacks explicit approval. Review it in Accounts.", 409);
  if (order.side === "buy" && (!(typeof cost === "number" && Number.isFinite(cost) && cost >= order.notional)
    || cost > Math.min(policy.orderBudgetUsd, account.equity * policy.maxPositionPercent / 100)
    || account.cash - cost < account.equity * policy.cashBufferPercent / 100)) throw brainError("RISK", "Verified broker cost exceeds the order, position, or cash-buffer budget.", 409);
}

export function buildEquityOrder(tool, order, accountNumber, requestId) {
  if (tool?.name !== "place_equity_order" || !tool.inputSchema?.properties) throw brainError("ADAPTER", "Discover Robinhood's equity order contract first.", 409);
  const fields = tool.inputSchema.properties, values = { account_number: accountNumber, account_id: accountNumber,
    symbol: order.symbol, side: order.side, quantity: order.quantity, limit_price: order.limitPrice,
    type: "limit", order_type: "limit", time_in_force: "gfd", extended_hours: false,
    ref_id: requestId, client_order_id: requestId, idempotency_key: requestId };
  const required = tool.inputSchema.required ?? [];
  if (!Object.hasOwn(fields, "symbol") || !Object.hasOwn(fields, "side") || !Object.hasOwn(fields, "quantity")
    || !Object.hasOwn(fields, "limit_price") || !(Object.hasOwn(fields, "account_number") || Object.hasOwn(fields, "account_id"))
    || !(Object.hasOwn(fields, "type") || Object.hasOwn(fields, "order_type")) || !Object.hasOwn(fields, "time_in_force")
    || required.some(key => !Object.hasOwn(values, key))) throw brainError("ADAPTER", "Equity order fields need a reviewed adapter update. Automated orders are blocked.", 409);
  return Object.fromEntries(Object.keys(values).filter(key => Object.hasOwn(fields, key)).map(key => {
    const value = values[key], field = fields[key];
    if (field.enum && !field.enum.includes(value)) throw brainError("ADAPTER", "Broker order enums need a reviewed adapter update.", 409);
    return [key, field.type === "string" && typeof value === "number" ? String(value) : value];
  }));
}
