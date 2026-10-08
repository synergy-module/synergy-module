// Names are published by Robinhood. Input schemas are always discovered from the authenticated server.
export const ROBINHOOD_MCP_URL = "https://agent.robinhood.com/mcp/trading";
export const ROBINHOOD_GROUPS = {
  Account: ["get_accounts", "get_portfolio", "get_realized_pnl", "get_pnl_trade_history", "search"],
  Equities: ["get_equity_positions", "get_equity_tax_lots", "get_equity_quotes", "get_equity_orders", "get_equity_tradability", "review_equity_order"],
  Options: ["get_option_level_upgrade_info", "get_option_historicals", "get_option_chains", "get_option_instruments", "get_option_quotes", "get_option_positions", "get_option_orders", "review_option_order"],
  Crypto: ["get_currency_pairs", "get_crypto_quotes", "get_crypto_positions", "get_crypto_orders", "preview_crypto_order"],
  Research: ["get_equity_historicals", "get_equity_fundamentals", "get_financials", "get_equity_price_book", "get_equity_technical_indicators", "get_earnings_results", "get_earnings_calendar", "get_indexes", "get_index_quotes"],
  Watchlists: ["get_watchlists", "get_watchlist_items", "get_option_watchlist", "get_popular_watchlists"],
  Scanners: ["get_scans", "get_scanner_filter_specs", "run_scan"],
};
export const ROBINHOOD_READ_TOOLS = new Set(Object.values(ROBINHOOD_GROUPS).flat());
export const ROBINHOOD_PREVIEWS = { place_equity_order: "review_equity_order", place_option_order: "review_option_order", place_crypto_order: "preview_crypto_order" };
export const ROBINHOOD_WRITES = new Set([
  ...Object.keys(ROBINHOOD_PREVIEWS), "cancel_equity_order", "cancel_option_order", "cancel_crypto_order",
  "create_watchlist", "update_watchlist", "follow_watchlist", "unfollow_watchlist", "add_to_watchlist", "remove_from_watchlist", "add_option_to_watchlist", "remove_option_from_watchlist",
  "create_scan", "update_scan_filters", "update_scan_config",
]);
export function robinhoodToolKind(name) {
  if (ROBINHOOD_READ_TOOLS.has(name)) return "read";
  if (Object.hasOwn(ROBINHOOD_PREVIEWS, name)) return "order";
  if (ROBINHOOD_WRITES.has(name)) return name.startsWith("cancel_") ? "cancel" : "change";
  return "blocked";
}
export const brokerError = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
